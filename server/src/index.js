import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'node:path';
import { config, configEvents, ROOT } from './config.js';
import { store } from './store.js';
import { settings } from './settings.js';
import { startPolling, startPoll, cancelPoll, pollStatus, pollEvents } from './poller.js';
import { viewedProjects, handleViewMessage, drop as dropViewer } from './viewers.js';
import {
  tick, retry, markReady, sendChat, deleteWorktree, activeCount, generateDemoSteps,
  forceStart, detectExistingWork, ensureWorktree, interruptChat, setChatModel, chatEffectiveEffort, setMode,
  setActiveChangeRequest, resolveChangeRequest, startChangeRequest,
  draftReviewReplies, discardReviewReplies, bringMainNow, pushNow, askMergeHelp,
  createChat, closeChat, reopenChat, deleteChat, setTaskMachine, machineStatus,
  runBrowserQa, setBrowserQa, qaInfo, qaEvidence, qaWanted, acceptFix, publishPr,
  setDemo, demoWanted,
  answerChatPending, setChatPlanMode, stopChatPlan, continueChatPlan,
  answerTaskPending, setApprovePlan, decideTaskPlan, approvePlanWanted,
  fixGapsWanted, setFixGaps, fullTestsWanted, setFullTests, resolveConflictsWanted, setResolveConflicts, setDesign,
  backfillAgent, agentCalls, stopBackground, startTask, isUserRun, isRunning,
  draftIssueClosing, discardIssueClosing, closeIssueWithoutPr, renameChat, bootstrapRepo, changeBaseBranch, refreshGitNow,
} from './pipeline.js';
import { holderKey, getHolder, getHolderByKey, allHolders, holderMachines, migrateProjectChatsOnBoot } from './projectchats.js';
import { registerIssueDraftRoutes } from './issuedraft.js';
import { HOLDER_TAB } from './chattabs.js';
import { machineOf, machines } from './machine.js';
import { DEFAULT_PROJECT_ID, coerceKey, keyOf, makeKey, parseKey } from './keys.js';
import { listProjects, projectOf, saveProjects, configFor, setReviewerChoice, setProjectDesign, setProjectRestricted, removeProject, removedProjectFor, forgetRemovedProject, setGhAccount } from './projects.js';
import { ghTokenFor, identityIssues, ghAccounts, defaultGhLogin } from './gh-account.js';
import { overridesOf, detectProfile, detectDefaultBranch, isProfileId } from './profiles.js';
import { tuningSnapshot, setTuning } from './tuning.js';
import { detectRepo, detectGhUser } from './repo-identity.js';
import { movePreflight, moveTask, retryMove, discardMove, removePlace } from './move.js';
import { resolvedModels } from './models.js';
import { listAssignedIssues, repoLabels, issueOrPrRef, searchRepoUsers } from './github.js';
import { hasCommits, isProjectWorktree, pendingWork } from './worktree.js';
import { startStack, stopStack, publicStack } from './stack.js';
import { saveAttachment, acceptedAttachments } from './attachments.js';
import { validatePrompts } from './prompts.js';
import { accessGuard, socketRefusal, describeAccess, listenHost, isDirectLoopback } from './access.js';
import { chatsOf, chatById, isChatBusy, chatRunning } from './chats.js';
import { planProgress } from './planexec.js';
import { filesRouter } from './files.js';
import { browseRouter } from './browse.js';
import { sendEvidence } from './qa.js';
import {
  upgradeRouter, upgradeGuard, currentUpgradeState, upgradeEvents, resumeOnBoot, startUpgradeChecks,
  upgradeHoldsNewWork, upgradeHooks, idleReasons, bundledCliPath,
} from './upgrade.js';
import { restartRouter, restartHooks, restartPending, busyList } from './restart.js';
import { loginState, loginEvents, startLoginChecks, noteAuthFailure } from './login.js';
import { loginJobRouter, loginJobRunning, loginJobHooks } from './loginjob.js';
import { claudeHooks } from './claude.js';
import { userPluginsRouter, userPluginHooks, pluginEvents, startPluginChecks, noteInit } from './userplugins.js';
import { warmBoardPlugins } from './boardplugin.js';
import { quotaState, quotaEvents, resumeQuotaOnBoot } from './quota.js';
import { usageState, usageEvents, usageRouter, usageHooks, startUsageProbe } from './usage.js';
import { installCrashGuard } from './crashguard.js';
import { runnerEvents } from './runner-client.js';
import { summarize, aggregate } from './metrics.js';
import { boardSpans } from './boardtimings.js';

// How long after the boot the per-machine plugin check waits (see where it starts).
const PLUGIN_CHECK_DELAY_MS = 20_000;

// First of all, before a single route exists: a network error from a machine
// that is not there must not be able to end this process and everything it is
// running. `crashguard.js` says why at length. `started` is what keeps a
// failure during boot fatal — until the port is open there is no board to save.
let listening = false;
installCrashGuard({ started: () => listening });

// A runner found unreachable — or back — said once, on the change of mind and
// not once per git command. The same signal reaches the boards through the
// upgrade state, which marks the machine `online: false` with its reason.
runnerEvents.on('offline', ({ error }) => console.error(`[máquina] ${error}`));
runnerEvents.on('online', ({ machine }) => console.log(`[máquina] ${machine} vuelve a responder`));

const app = express();
// The token first, the body after. The guard reads only headers, the cookie
// and the query, so nobody without the token gets up to 25 MB parsed.
app.use(accessGuard);
// «Save everything now», for stop.ps1: it ends the board with taskkill /F, which
// skips every exit handler, and the store keeps the last few seconds in memory.
// Direct loopback only (never through a proxy), and before the upgrade guard: a
// flush is exactly what an upgrade wants too. It answers when the files are written.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const hostnameOf = (hostPort) => String(hostPort ?? '').replace(/:\d+$/, '').toLowerCase();
app.post('/api/flush', (req, res) => {
  // Direct loopback on the socket AND a loopback Host (a rebinding page talks to a
  // loopback socket under its own name) AND no foreign Origin (a browser tab).
  const origin = req.get('origin');
  let originHost = '';
  try { originHost = origin ? new URL(origin).hostname : ''; } catch { originHost = 'invalid'; }
  const local = isDirectLoopback(req)
    && LOOPBACK_HOSTS.has(hostnameOf(req.get('host')))
    && (!origin || LOOPBACK_HOSTS.has(originHost) || LOOPBACK_HOSTS.has(`[${originHost}]`));
  if (!local) return res.status(403).json({ error: 'local only' });
  try {
    // flush() does not throw for a write that failed (the board must not die of a full
    // disk); it says which ones failed. «Saved» is only said when nothing did.
    const failures = store.flush();
    if (failures.length) {
      const why = failures.map((f) => `${String(f.file).split(/[\\/]/).pop()}: ${f.error}`).join('; ');
      return res.status(500).json({ ok: false, error: `could not save: ${why}`, failures });
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});
// The file viewer: read-only, GET only, so it needs no body parser.
app.use(filesRouter);
// The folder browser for the project dialog: read-only, GET only, and it
// refuses anything that is not a direct loopback request by itself.
app.use(browseRouter);
// Attachments arrive base64-encoded inside the JSON body, so the default 100kb
// limit would reject any screenshot. 30mb because base64 is a third larger than
// the bytes: the 20 MB of `MAX_BYTES` is about 26.7 MB on the wire.
app.use(express.json({ limit: '30mb' }));
// While the SDK, the CLI or the runner are being replaced, every other
// state-changing call is refused with 409; the upgrade's own routes follow.
app.use(upgradeGuard);
app.use(upgradeRouter());
app.use(restartRouter());
// The Claude login of each machine: the state (never a token) and the renewal
// job. The job's routes are POSTs, so `upgradeGuard` above already refuses them
// while an upgrade runs; the hooks below add the other exclusions.
app.use(loginJobRouter());
app.get('/api/login', (req, res) => res.json({ login: loginState() }));
restartHooks.loginBusy = loginJobRunning;
upgradeHooks.loginRunning = loginJobRunning;
Object.assign(loginJobHooks, {
  restartPending,
  upgradeHolds: upgradeHoldsNewWork,
  // What shares the machine's credentials file: its own tasks and chats, and
  // a move that has it on either end.
  busy: (name) => busyList(idleReasons().reasons.filter((r) => r.machine === name || r.machines?.includes(name))),
  cliPath: bundledCliPath,
});
// A session that failed with `authentication_failed` marks that machine's login.
claudeHooks.onAuthFailure = noteAuthFailure;
// The required USER-level plugins of each machine: what is missing, and an
// install that only runs when a person asks (POSTs, so `upgradeGuard` above
// already refuses them during an upgrade; the hooks add the other exclusions).
app.use(userPluginsRouter());
Object.assign(userPluginHooks, {
  restartPending,
  upgradeHolds: upgradeHoldsNewWork,
  cliPath: bundledCliPath,
});
// A session's `init` frame says which plugins that machine really loaded.
claudeHooks.onInit = noteInit;
// The probe opens a Claude session, however short: never during an upgrade.
usageHooks.paused = upgradeHoldsNewWork;
app.use(usageRouter());
app.use(express.static(path.join(ROOT, 'web', 'dist')));

/**
 * What a board needs to draw a card. The histories are deliberately left out:
 * every tool call broadcasts a task, and shipping the conversations with it
 * would put hundreds of KB on the wire per event, to every open board.
 */
/**
 * A task's canonical key, tolerantly: `keyOf` throws on a task with no project,
 * and `publicTask` runs on whatever the store hands it. `null` is the right
 * answer for the `Set`s in `pipeline.js` — a miss.
 */
const refOf = (t) => coerceKey(t.issue, t.project ?? DEFAULT_PROJECT_ID); // allowlisted: a legacy row read before adoption has no project

/** The per-chat public fields of a task or a project-chat holder: no messages. */
const publicChats = (t) => chatsOf(t).map((c) => ({
    id: c.id,
    title: c.title,
    model: c.model,
    busy: c.busy,
    activity: c.activity,
    forkedFrom: c.forkedFrom,
    closedAt: c.closedAt ?? null,
    effort: c.effort ?? null,
    // What the chat chose (null: inherits the role «chat»), what its effort comes to
    // once clamped to the model, and when its last turn ended (the cache is warm
    // for about five minutes after).
    thinking: c.thinking ?? null,
    effectiveEffort: chatEffectiveEffort(t, c),
    lastTurnAt: c.lastTurnAt ?? null,
    messageCount: c.messages.length,
    planMode: c.planMode === true,
    // What is moving in this chat, in numbers: subagents, background
    // commands, servers, and how long the slowest wave still has.
    running: chatRunning(c),
    // Something waiting on a person; the payload is in the message it names.
    pending: c.pending ? { id: c.pending.id, kind: c.pending.kind, source: c.pending.source, askedAt: c.pending.askedAt, messageId: c.pending.messageId } : null,
    // The plan the board is running, in brief; the whole record rides on the plan message.
    plan: c.plan ? {
      id: c.plan.id, status: c.plan.status,
      total: c.plan.tasks.filter((x) => x.status !== 'skipped').length,
      done: c.plan.tasks.filter((x) => x.status === 'done').length,
      summary: c.plan.tasks.map((x) => `${x.id}:${x.status}${x.attempts > 1 ? `×${x.attempts}` : ''}`).join(' '),
    } : null,
  }));

/** The totals of a task's spans, without the per-phase breakdown; null for a task with no spans. */
function timingSummary(t) {
  if (!Array.isArray(t.timings) || !t.timings.length) return null;
  const { wallMs, runMs, activeMs, waitMs, dropped } = summarize(t);
  return { wallMs, runMs, activeMs, waitMs, spans: t.timings.length, open: t.timings.filter((s) => s.endedAt == null).length, dropped };
}

const publicTask = (t, known = machines()) => {
  const chats = publicChats(t);
  return {
    ...t,
    log: undefined,
    demoSteps: undefined,
    // Up to 500 spans per task would ride on every broadcast: the card gets the
    // totals, and the timeline asks for the spans (`GET …/timings`) when opened.
    timings: undefined,
    timingsDropped: undefined,
    nudged: undefined,
    timing: timingSummary(t),
    logLength: t.log.length,
    hasDemo: Boolean(t.demoSteps),
    // Whether the run ends by writing them. The panel's button ignores this.
    demo: t.demo ?? 'auto',
    // What the run will do (the task's choice, else the project's) and what the
    // project alone says, for the card's tooltip.
    demoWanted: demoWanted(t),
    demoProjectOn: settings.demoFor(t.project),
    // The PR body an agent wrote is a document: shipping it with every card,
    // on every tool call, to every open board is kilobytes nobody draws.
    prBody: undefined,
    hasPrBody: Boolean(t.prBody),
    // Same reason as `prBody` above, and the reason `GET …/close/draft`
    // exists: a closing comment is a document — four sections with file paths
    // in them — and shipping it with every card, on every tool call, to every
    // open board is exactly what `prBody: undefined` is here to avoid. The
    // window asks for the body separately when it opens, as it does for the
    // demo steps. `closable` and `closedWithoutPr` are small and ride along
    // with the `...t` above, untouched.
    closing: t.closing ? { ...t.closing, draftBody: undefined } : null,
    hasClosingDraft: Boolean(t.closing?.draftBody),
    // Browser QA at a glance: the switch, whether it applies, and the verdict.
    qa: undefined,
    browserQa: t.browserQa ?? 'auto',
    // The project's (else the board's) Browser QA switch: the card's QA toggle
    // is disabled when this is off, whatever the task's own value says.
    browserQaProjectOn: settings.browserQaFor(t.project),
    qaWanted: qaWanted(t),
    qaUi: t.qa?.ui ?? null,
    qaVerdict: t.qa?.results?.verdict ?? null,
    // How the last QA went, step by step: an `unverified` verdict means the
    // session stopped halfway, and the card says «5 de 12 comprobados».
    qaCounts: t.qa?.results?.counts ?? null,
    qaEvidenceCount: t.qa?.evidence?.length ?? 0,
    qaBusy: Boolean(t.qaBusy),
    design: Boolean(t.design),
    hasWorktree: Boolean(t.worktreePath),
    // A manual task on the one run you started by hand; it stays manual.
    // By key, not by number: issue 12 of another project is another task, and
    // a bare number would answer for the default project's #12.
    userRun: isUserRun(refOf(t)),
    // Whether a run is in flight right now. The state cannot answer this: a run
    // resumed at the PR changes no state until the PR exists, so the card would
    // keep offering «Reintentar» and «Publicar PR» on a task that is working.
    pipelineRunning: isRunning(refOf(t)),
    machine: t.machine ?? 'local',
    // After `...t` on purpose: the raw records carry worktree paths, session
    // ids and the move's saved state, none of which a board needs.
    ...whereItRuns(t, known),
    lastLine: t.log.length ? t.log[t.log.length - 1].line : null,
    // Tabs and their state, without a single message.
    chats,
    chatBusy: isChatBusy(t),
    // Everything in flight on this task, added up: numbers only, no trees.
    running: runningOf(t, chats),
    // Plan approval before the fix, and what the task itself is waiting on.
    approvePlan: t.approvePlan ?? 'auto',
    approvePlanWanted: approvePlanWanted(t),
    pending: t.pending ? { ...t.pending } : null,
    // «Cerrar huecos»: the same tri-state as the plan switch, and what the
    // card needs to draw it. `hasStack` lets the card hide «Iniciar app» for a
    // project with no stack to start. `phaseModels` is model and effort of the
    // latest session of each phase, for the chip.
    fixGaps: t.fixGaps ?? 'auto',
    fixGapsWanted: fixGapsWanted(t),
    fullTests: t.fullTests ?? 'off',
    fullTestsWanted: fullTestsWanted(t),
    testScope: t.testScope ?? null,
    resolveConflicts: t.resolveConflicts ?? 'auto',
    resolveConflictsWanted: resolveConflictsWanted(t),
    conflictRun: t.conflictRun ?? null,
    hasStack: hasStackOf(t), stack: publicStack(t.stack),
    phaseModels: t.phaseModels ?? undefined,
    // A fix plan being made or remade right now; the bubble id and the
    // turned-down text stay on the server.
    planning: t.planning ? {
      version: t.planning.version, kind: t.planning.kind, startedAt: t.planning.startedAt, feedback: t.planning.feedback ?? null,
    } : null,
    planRejectedText: undefined,
    planFeedback: undefined,
    workPlan: t.workPlan?.status ? {
      id: t.workPlan.id, version: t.workPlan.version ?? null, feedback: t.workPlan.feedback ?? null, status: t.workPlan.status, text: t.workPlan.text, waves: t.workPlan.waves, selected: t.workPlan.selected,
      tasks: t.workPlan.tasks.map((x) => ({
        id: x.id, what: x.what, files: x.files, dependsOn: x.dependsOn, check: x.check, status: x.status,
        attempts: x.attempts, extraRetries: x.extraRetries ?? 0, startedAt: x.startedAt, endedAt: x.endedAt,
        lastFailure: x.lastFailure ? { kind: x.lastFailure.kind, output: String(x.lastFailure.output ?? '').split(/\r?\n/).slice(-20).join('\n') } : null,
        summary: x.summary ? String(x.summary).slice(0, 400) : null,
      })),
    } : null,
    // Waiting for the account's quota to come back. Deliberately NOT part of
    // `awaitingYou`: nobody can act on it, so no card wears a ❓ for it.
    // `previousError` stays on the server — the card has nothing to do with it.
    quotaPark: t.quotaPark ? {
      holdId: t.quotaPark.holdId,
      since: t.quotaPark.since,
      resumeFrom: t.quotaPark.resumeFrom ?? null,
      wasUserRun: Boolean(t.quotaPark.wasUserRun),
    } : null,
    // Anything on this task waiting for a person: a question, a plan, a mode
    // to confirm, a review without replies drafted. The card wears the ❓.
    awaitingYou: awaitingYou(t),
  };
};

/**
 * Where a task has been and where it is going, in names, counts and times:
 * the machines it left a worktree or sessions on (still configured ones only),
 * a move in flight or failed, the build started on arrival, and the machine
 * «↩ volver» goes back to — the most recent place other than the active one.
 */
function whereItRuns(t, known) {
  const active = t.machine ?? 'local';
  const places = Object.entries(t.places ?? {})
    .filter(([machine]) => Boolean(known[machine]))
    .map(([machine, p]) => ({
      machine,
      hasWorktree: Boolean(p?.worktreePath),
      sessions: Object.keys(p?.sessions ?? {}).length,
      at: p?.at ?? null,
    }));
  const previous = places
    .filter((p) => p.machine !== active)
    .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))[0] ?? null;
  const m = t.moving;
  const w = t.prewarm;
  return {
    places,
    moving: m ? {
      from: m.from, to: m.to, step: m.step, startedAt: m.startedAt, error: m.error ?? null,
      // Once arrived, a failed move can only be retried, never discarded.
      arrived: active === m.to,
    } : null,
    prewarm: w ? { machine: w.machine, startedAt: w.startedAt, endedAt: w.endedAt ?? null, ok: w.ok ?? null } : null,
    previousMachine: previous?.machine ?? null,
  };
}

/**
 * What the card can say is moving, small enough to ride on every broadcast:
 * the subagents, background commands and servers of every open chat added up,
 * the longest wait among them — they run side by side, so the wait is the
 * slowest one and not the sum — and the plan the board is running. Null when
 * nothing is going on, which is the usual case.
 */
function runningOf(t, chats) {
  const agents = { total: 0, done: 0, running: 0 };
  let commands = 0;
  let servers = 0;
  let estimateMs = null;
  for (const c of chats) {
    if (c.closedAt || !c.running) continue;
    agents.total += c.running.agents.total;
    agents.done += c.running.agents.done;
    agents.running += c.running.agents.running;
    commands += c.running.commands;
    servers += c.running.servers;
    if (c.running.estimateMs != null) estimateMs = Math.max(estimateMs ?? 0, c.running.estimateMs);
  }
  // `asking` counts as running: the plan is mid-flight, waiting on an answer.
  const plan = ['running', 'asking'].includes(t.workPlan?.status) ? planProgress(t.workPlan) : null;
  if (!agents.total && !commands && !servers && !plan) return null;
  return {
    agents,
    commands,
    servers,
    estimateMs,
    ...(plan ? { plan: { done: plan.done, total: plan.total, estimateMs: plan.estimateMs } } : {}),
  };
}

/** Whether the task's project has a stack to start; an unknown project has none. */
function hasStackOf(t) {
  try {
    return (configFor(t.project ?? DEFAULT_PROJECT_ID)?.stack ?? null) !== null; // allowlisted: legacy row without project
  } catch {
    return false;
  }
}

function awaitingYou(t) {
  const reasons = [];
  if (chatsOf(t).some((c) => c.pending && !c.closedAt)) reasons.push('pregunta');
  if (t.pending) reasons.push(t.pending.kind === 'plan' ? 'plan' : 'pregunta');
  if (t.state === 'plan_ready') reasons.push('plan');
  if (t.mode === 'unconfirmed') reasons.push('modo');
  if ((t.changeRequests ?? []).some((c) => c.status === 'open' && !(c.draftReplies ?? []).length && c.reviewId === t.activeChangeRequest)) reasons.push('review');
  // A chat that concluded the issue needs no change is a suggestion, not a
  // decision: the card wears the ❓ and counts towards «N esperan tu decisión».
  //
  // The extra terms mirror `canCloseIssue` in `TaskCard.jsx`, and they are not
  // decoration: the card hides the button — and the hint that explains it —
  // once the task has any PR or has reached `done`. The #787 shape (PR merged,
  // issue still open) is the ordinary way to land there. Marking such a task as
  // waiting on a decision it offers no way to take leaves a ❓ nobody can
  // clear. A badge with nothing behind it teaches people to ignore badges.
  if (t.closable && !t.issueClosed && !t.closedWithoutPr
    && t.state !== 'done' && !t.prNumber && !(t.prs ?? []).length) reasons.push('cierre');
  return reasons;
}
/**
 * What a board receives about a project chat: shaped like a task, so the chat
 * panel can take it as `task`, and with no message in it.
 */
const holderSummary = (h) => {
  const chats = publicChats(h);
  return {
    kind: 'project',
    key: holderKey(h.project, h.machine),
    project: h.project,
    machine: h.machine,
    issue: null,
    title: h.title,
    baseBranch: h.baseBranch,
    worktreePath: h.worktreePath ?? null,
    head: h.head ?? null,
    busy: isChatBusy(h),
    chatBusy: isChatBusy(h),
    running: runningOf(h, chats),
    updatedAt: h.updatedAt,
    chats,
  };
};

/**
 * The project the board opens on: the first NON-restricted one. `null` when
 * every listed project is restricted or the registry is empty.
 */
const openingProject = (projects = listProjects()) => projects.length ? (projects.find((p) => !p.restricted) ?? null)?.id ?? null : null;

const snapshot = (known = machines(), projects = listProjects(), ids = new Set(projects.map((p) => p.id))) => ({
  // `machines()` once for the whole list, not once per task.
  // Only listed projects: a removed project's `tasks.<id>.json` stays on disk
  // (and loaded in the store) but is not on the board.
  tasks: store.all().filter((t) => ids.has(t.project ?? DEFAULT_PROJECT_ID)).map((t) => publicTask(t, known)), // allowlisted: legacy row without project
  projectChats: allHolders().map(holderSummary),
  active: activeCount(),
  settings: settings.snapshot(),
  github: config.github,
  models: config.claude.available ?? [],
  poll: pollStatus(),
  defaultChatModel: config.claude.chatModel,
  // `config.project` — this machine's repo paths. NOT a registry entry, and not
  // the same thing as `projects`/`activeProject` below: same word, two meanings,
  // and renaming this one is somebody else's change.
  project: config.project,
  // The registry, in display order, for the project selector.
  projects,
  // The project the board OPENS on, not a selection the server keeps: the same
  // board is open on a laptop and a phone, and switching in one must not switch
  // the other. The choice lives in the browser (localStorage), like `lastChat`.
  activeProject: openingProject(projects),
  // Names only: probing a box on every snapshot would make the board wait on
  // the tailnet. `GET /api/machines` answers with what is reachable.
  machines: Object.values(known).map((m) => ({ name: m.name, kind: m.kind, host: m.host })),
  // The last detection and the job as it is now, without waiting on anything:
  // a board reconnecting after the restart gets the result here.
  upgrade: currentUpgradeState(),
  // The account's quota hold, or null. One countdown for the whole board.
  quota: quotaState(),
  // How much of each plan window the account has used, for the header meter.
  usage: usageState(),
});

// Every project's tasks, as they have always been: the web holds the whole
// snapshot and filters it by the project it is showing. Splitting the initial
// state per project would mean a second round trip on every switch, and the
// account-wide numbers it carries (`active`, `quota`, `usage`) are global anyway.
app.get('/api/tasks', (_req, res) => res.json(snapshot()));

/** A trimmed non-empty string from a request field, else null. */
const pickText = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

app.get('/api/projects', (_req, res) => res.json({ projects: listProjects() }));

app.get('/api/projects/:project/tasks', (req, res) => {
  if (!projectOf(req.params.project)) return res.status(404).json({ error: `Unknown project: ${req.params.project}` });
  const known = machines();
  return res.json({ tasks: store.all().filter((t) => t.project === req.params.project).map((t) => publicTask(t, known)) });
});

/**
 * Importing a project: `{repoPath}` and as little else as possible, because
 * the checkout already knows the rest — the `origin` remote gives `repo`, the
 * convention gives `worktreeRoot` (`<checkout>-wt`), the last path segment
 * gives the id. 400 carries the registry's own refusal, word for word: it is
 * the one that knows why a forbidden override or a duplicate id is refused.
 *
 * The GitHub account (`ghUser`) is the one the remote already authenticates
 * as (`detectGhUser`), unless the request names one, and it is also the
 * default assignee. What would make that account unusable — no `gh` session
 * for it, a remote that pushes as somebody else, no local `user.email` — does
 * not refuse the import: it comes back in `warnings`, to be fixed before the
 * first push, which is where it is enforced.
 */
app.post('/api/projects', async (req, res) => {
  try {
    const raw = String(req.body?.repoPath ?? '').trim();
    if (!raw) throw new Error('repoPath is required: the checkout path on this machine');
    // A trailing separator would make `basename` answer '' and the id empty.
    const repoPath = raw.replace(/[\\/]+$/, '');
    // Checked here, not in the registry: `projects.json` only says a path is a
    // non-empty string, and a project pointing nowhere fails much later, inside
    // a git command, where nobody is reading.
    if (!existsSync(repoPath)) throw new Error(`That checkout does not exist: ${repoPath}`);
    const body = req.body ?? {};
    const requested = pickText(body.kind);
    if (requested && !isProfileId(requested)) throw new Error(`Perfil desconocido: ${requested}`);
    const kind = requested ?? detectProfile(repoPath);
    const segment = path.basename(repoPath);
    const ghUser = pickText(body.ghUser) ?? await detectGhUser(repoPath);
    const entry = {
      id: segment.toLowerCase(),
      name: segment,
      repoPath,
      worktreeRoot: `${repoPath}-wt`,
      // null when the remote is not a GitHub one the board can read; the
      // registry accepts that and `github.js` decides what to do about it.
      repo: detectRepo(repoPath),
      // The assignee comes from the request, else the project's account, else
      // the board's; the reviewer is never inherited from hfs: a new project
      // has none until a person picks one (`needsReviewer` on «Listo para revisión»).
      assignee: pickText(body.assignee) ?? ghUser ?? config.github.assignee,
      // A new project inherits neither `e2e` nor `stack`: the global ones are
      // hfs's (cargo, its port env, its stack), and a blank repository given
      // them fails in a command that makes no sense there. The profile says
      // what to start with (`null` is a whole replacement, `REPLACED_WHOLE`
      // in projects.js, so the phases that need them skip).
      overrides: overridesOf(kind),
    };
    if (ghUser) entry.ghUser = ghUser;
    const reviewer = pickText(body.reviewer);
    if (reviewer) entry.reviewer = reviewer;
    const language = pickText(body.language);
    if (language) entry.language = language;
    const baseBranch = pickText(body.baseBranch) ?? detectDefaultBranch(repoPath);
    if (baseBranch) entry.baseBranch = baseBranch;
    entry.kind = kind;
    // A project removed earlier comes back with its settings; what the request
    // states explicitly wins, and `restricted` stays cleared.
    const old = removedProjectFor({ id: entry.id, repoPath });
    let toSave = entry;
    if (old) {
      const { restricted: _r, ...rest } = old;
      toSave = { ...rest, ...entry, name: rest.name ?? entry.name, id: entry.id };
      for (const k of ['assignee', 'reviewer', 'language', 'baseBranch', 'ghUser']) {
        if (rest[k] !== undefined && pickText(body[k]) === null) toSave[k] = rest[k];
      }
      if (rest.kind && !requested) toSave.kind = rest.kind;
      if (rest.overrides && !requested) toSave.overrides = rest.overrides;
      for (const k of ['noReviewer', 'design']) if (rest[k] !== undefined) toSave[k] = rest[k];
    }
    // The poller picks issues up by assignee, so a project without one would never
    // start a task: ask for it here instead of surfacing the registry's validation.
    if (!pickText(toSave.assignee)) {
      return res.status(400).json({
        error: 'assignee is required: fill it in, or set github.assignee in config.local.json',
        missing: ['assignee'],
      });
    }
    const saved = saveProjects([...listProjects(), toSave]);
    forgetRemovedProject({ id: entry.id, repoPath });
    broadcast({ type: 'snapshot', ...snapshot() });
    const project = saved.find((p) => p.id === entry.id);
    const warnings = await accountWarnings(project);
    return res.status(201).json(warnings.length ? { ...project, warnings } : project);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

/**
 * What stands between a project and working as its GitHub account, as
 * `{ code, login, ...details, message }` (see `identityIssues`) so the UI can
 * word it in the reader's language; empty when nothing does or it declares none.
 */
async function accountWarnings(project) {
  if (!project?.ghUser) return [];
  const out = [];
  try {
    ghTokenFor(project.ghUser);
  } catch (e) {
    out.push({ code: 'no_session', login: project.ghUser, message: e.message });
  }
  return [...out, ...await identityIssues(project.repoPath, project)];
}

// The accounts a project's `ghUser` can be: the ones `gh` has a session for,
// plus `current`, the one a project without `ghUser` works as. `?repoPath=`
// (the import dialog's checkout) lets that checkout name its account's email.
app.get('/api/gh-accounts', async (req, res) => {
  const accounts = await ghAccounts(pickText(req.query.repoPath));
  res.json({ accounts, current: await defaultGhLogin(accounts) });
});

// The project's GitHub account (`ghUser: null` goes back to the active `gh`
// account) and, when given, its assignee. 404 unknown project, 400 bad login.
// Answers the saved entry plus the same `warnings` as the import.
app.post('/api/projects/:project/gh-account', async (req, res) => {
  if (!projectOf(req.params.project)) return res.status(404).json({ error: `Unknown project: ${req.params.project}` });
  const body = req.body;
  if (!body || typeof body !== 'object' || !('ghUser' in body)) {
    return res.status(400).json({ error: 'ghUser is required: a GitHub login, or null for the active gh account' });
  }
  try {
    const saved = setGhAccount(req.params.project, {
      ghUser: pickText(body.ghUser),
      assignee: pickText(body.assignee) ?? undefined,
    });
    broadcast({ type: 'snapshot', ...snapshot() });
    const warnings = await accountWarnings(saved);
    return res.json(warnings.length ? { ...saved, warnings } : saved);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

app.get('/api/settings', (_req, res) => res.json(settings.snapshot()));

// Model and effort per role. The snapshot is the default project's: a
// project's own `claude` overrides are applied where a session starts.
// The default project's config; a clone of the global one when it was removed.
const tuningConfig = () => (projectOf(DEFAULT_PROJECT_ID) ? configFor(DEFAULT_PROJECT_ID) : structuredClone(config)); // allowlisted: board-wide tuning reads the default project's config

app.get('/api/tuning', (_req, res) => {
  try {
    res.json(tuningSnapshot(tuningConfig()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tuning', (req, res) => {
  try {
    setTuning(req.body ?? {});
    res.json(tuningSnapshot(tuningConfig()));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Who can be asked to review: the picker behind the reviewer dialog. `exclude`
// (the PR's author) only annotates the entry with `isAuthor`; it never hides it.
app.get('/api/projects/:project/reviewers', async (req, res) => {
  if (!projectOf(req.params.project)) return res.status(404).json({ error: `Unknown project: ${req.params.project}` });
  try {
    const users = await searchRepoUsers(String(req.query.q ?? ''), {
      project: req.params.project,
      authorLogin: pickText(req.query.exclude),
    });
    return res.json({ users });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// The project's standing reviewer choice, changed without touching any PR (the
// dialog's settings mode). `{reviewer: null, noReviewer: false}` asks again next time.
app.post('/api/projects/:project/reviewer', (req, res) => {
  if (!projectOf(req.params.project)) return res.status(400).json({ error: `Unknown project: ${req.params.project}` });
  try {
    const body = req.body ?? {};
    const saved = setReviewerChoice(req.params.project, { reviewer: body.reviewer, noReviewer: body.noReviewer });
    return res.json({
      project: {
        id: saved.id,
        reviewer: saved.reviewer ?? null,
        noReviewer: saved.noReviewer === true,
        lastReviewer: saved.lastReviewer ?? null,
      },
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// Whether chats with a person in front load the board's UX plugin. `true` and
// `null` both go back to the default (on) and drop the field; only `false` is
// stored. Like `/base-branch`: 404 for an unknown project, 400 for a value that
// is not a boolean or null. A chat already open keeps what it started with.
app.post('/api/projects/:project/design', (req, res) => {
  if (!projectOf(req.params.project)) return res.status(404).json({ error: `Unknown project: ${req.params.project}` });
  const body = req.body;
  if (!body || typeof body !== 'object' || !('design' in body)) {
    return res.status(400).json({ error: 'design is required: true, false or null' });
  }
  try {
    const saved = setProjectDesign(req.params.project, body.design);
    return res.json({ project: { id: saved.id, design: saved.design !== false } });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// Restricted projects stay listed (the board groups them apart) and keep being
// polled; only the opening project skips them. 404 unknown, 400 bad body.
app.post('/api/projects/:project/restricted', (req, res) => {
  if (!projectOf(req.params.project)) return res.status(404).json({ error: `Unknown project: ${req.params.project}` });
  const body = req.body;
  if (!body || typeof body !== 'object' || typeof body.restricted !== 'boolean') {
    return res.status(400).json({ error: 'restricted is required: true or false' });
  }
  try {
    const saved = setProjectRestricted(req.params.project, body.restricted);
    broadcast({ type: 'snapshot', ...snapshot() });
    return res.json(saved);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// Removes the project from the board: the registry entry only. Its tasks file,
// settings overlay, attachments, chats, worktrees and repo are left alone, so
// importing the same repoPath again brings everything back.
app.delete('/api/projects/:project', (req, res) => {
  if (!projectOf(req.params.project)) return res.status(404).json({ error: `Unknown project: ${req.params.project}` });
  try {
    removeProject(req.params.project);
    broadcast({ type: 'snapshot', ...snapshot() });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// The project's base branch, changed live from the error card of a task whose
// worktree failed with `empty_repo` / `base_missing` (that task is retried).
// Explicit statuses: 404 for an unknown project (like the tasks listing, not the
// 400 of `/reviewer`), 400 `bad_base`, 409 `base_not_on_remote` (with the remote's
// heads), 502 `remote_unreachable`. A refusal changes nothing.
app.post('/api/projects/:project/base-branch', async (req, res) => {
  if (!projectOf(req.params.project)) return res.status(404).json({ error: `Unknown project: ${req.params.project}`, code: 'unknown_project' });
  const body = req.body;
  if (!body || typeof body !== 'object' || typeof body.baseBranch !== 'string') {
    return res.status(400).json({ error: 'baseBranch is required: the name of the base branch', code: 'bad_request' });
  }
  try {
    const out = await changeBaseBranch(req.params.project, body.baseBranch.trim(), body.issue);
    tick();
    return res.json(out);
  } catch (e) {
    return res.status(e.status ?? 400).json({
      error: e.message,
      code: e.code ?? null,
      ...(Array.isArray(e.remoteHeads) ? { remoteHeads: e.remoteHeads } : {}),
    });
  }
});

// One project's own switches (`null` removes an override: back to the board's
// value). 404 for an unregistered project, so no orphan overlay is persisted;
// 400 when `updateProject` refuses the patch (unknown key such as
// `maxActiveTasks`, invalid value). The `change` it emits reaches open boards.
app.post('/api/projects/:project/settings', (req, res) => {
  if (!projectOf(req.params.project)) return res.status(404).json({ error: `Unknown project: ${req.params.project}` });
  try {
    return res.json(settings.updateProject(req.params.project, req.body ?? {}));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

app.post('/api/settings', (req, res) => {
  try {
    res.json(settings.update(req.body ?? {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// The tabs over the chat panel, one per task or project chat, shared by every browser.
// Opened and closed one at a time here rather than saved as a list, so two
// devices never overwrite each other's strip. The change reaches every open
// board through the `settings` broadcast.
//
// A task's entry in the strip is `{ project, issue }`, so issue #12 of two
// projects are two tabs. A legacy client that sends no project means the
// default one, as everywhere else on the route layer.
//
// A project chat's tab is the string `p:<project>@<machine>` in the same strip:
// `{ project, owner: 'project', machine }` instead of `{ project, issue }`.
function tabEntryOf(body) {
  if (body?.owner !== 'project') {
    const key = coerceKey(body?.issue, body?.project);
    if (!key) return body?.issue; // not a task: the strip rejects it with its own message
    const { projectId, issue } = parseKey(key);
    return { project: projectId, issue };
  }
  const entry = `p:${body?.project}@${body?.machine}`;
  return HOLDER_TAB.test(entry) ? entry : null;
}

function holderExists(project, machine) {
  try {
    return Boolean(getHolderByKey(holderKey(String(project), String(machine))));
  } catch {
    return false;
  }
}

/** Whether a stored tab still points at something the board has. */
function tabIsKnown(tab) {
  if (typeof tab.issue === 'string') {
    const [project, machine] = tab.issue.slice(2).split('@');
    return holderExists(project, machine);
  }
  if (!tab.project) return true; // not sealed yet: `adoptLegacyTabs` runs at boot, so only a transient read sees this
  try {
    return Boolean(store.get(makeKey(tab.project, tab.issue)));
  } catch {
    return false;
  }
}

// Tabs saved before projects existed belong to the project the board opens on.
settings.adoptLegacyTabs(listProjects()[0]?.id ?? DEFAULT_PROJECT_ID); // allowlisted: empty registry

app.post('/api/chat-tabs/open', (req, res) => {
  if (req.body?.owner === 'project') {
    const entry = tabEntryOf(req.body);
    if (!entry || !holderExists(req.body.project, req.body.machine)) {
      return res.status(404).json({ error: `Unknown project chat: ${req.body?.project}@${req.body?.machine}` });
    }
    try {
      return res.json(settings.openChatTab(entry, tabIsKnown));
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }
  const key = coerceKey(req.body?.issue, req.body?.project ?? DEFAULT_PROJECT_ID); // allowlisted: legacy clients send a bare issue number
  if (!key || !store.get(key)) return res.status(404).json({ error: `Unknown task #${req.body?.issue}` });
  try {
    return res.json(settings.openChatTab(tabEntryOf(req.body), tabIsKnown));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

app.post('/api/chat-tabs/close', (req, res) => {
  try {
    res.json(settings.closeChatTab(tabEntryOf(req.body)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/projects/:project/tasks/:issue/log', withTask((task, _req, res) => res.json({ log: task.log })));
// The timeline of one task: every span plus the totals. An old task has none.
app.get('/api/projects/:project/tasks/:issue/timings', withTask((task, _req, res) => res.json({
  timings: Array.isArray(task.timings) ? task.timings : [],
  summary: summarize(task),
})));
// Median and p90 per phase and per wait kind, across one project's tasks, and
// across every project plus the board's own operations (restart, upgrade).
app.get('/api/projects/:project/metrics', (req, res) => {
  if (!projectOf(req.params.project)) return res.status(404).json({ error: `Unknown project: ${req.params.project}` });
  return res.json(aggregate(store.all().filter((t) => t.project === req.params.project)));
});
app.get('/api/metrics', (_req, res) => res.json({ ...aggregate(store.all()), board: boardSpans() }));
app.get('/api/projects/:project/tasks/:issue/chat', withTask((task, req, res) => {
  const chat = chatById(task, req.query.chatId ?? null);
  if (!chat) return res.status(404).json({ error: 'that chat does not exist' });
  return res.json({ chatId: chat.id, chat: chat.messages, busy: chat.busy, activity: chat.activity, pending: chat.pending ?? null, planMode: chat.planMode === true });
}));

app.post('/api/projects/:project/tasks/:issue/chats', withTask((task, req, res) => {
  try {
    res.json(createChat(keyOf(task), { forkFrom: req.body?.forkFrom ?? null }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/projects/:project/tasks/:issue/chats/:chatId/close', withTask((task, req, res) => {
  try {
    res.json({ closed: closeChat(keyOf(task), req.params.chatId) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/projects/:project/tasks/:issue/chats/:chatId/reopen', withTask((task, req, res) => {
  try {
    res.json({ id: reopenChat(keyOf(task), req.params.chatId).id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/projects/:project/tasks/:issue/chats/:chatId/delete', withTask((task, req, res) => {
  try {
    res.json({ deleted: deleteChat(keyOf(task), req.params.chatId) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// Renaming a conversation: the same body for a task's chat and a project chat's.
app.post('/api/projects/:project/tasks/:issue/chats/:chatId/rename', withTask((task, req, res) => {
  try {
    res.json(renameChat(keyOf(task), req.params.chatId, req.body?.title));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/projects/:project/tasks/:issue/chat/stop', withTask(async (task, req, res) => {
  try {
    await interruptChat(keyOf(task), req.body?.chatId ?? null);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/projects/:project/tasks/:issue/model', withTask((task, req, res) => {
  try {
    // `effort` and `thinking` ride in the body next to the model (per chat, like
    // the model). A key that is ABSENT keeps its current value; `null` clears it.
    const { model, effort, thinking } = req.body ?? {};
    res.json({ model: setChatModel(keyOf(task), req.body?.chatId ?? null, model, effort, thinking) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// A subagent's calls from its own transcript: fill its tree with what the
// stream never delivered, or load the ones that scrolled out of the history.
app.post('/api/projects/:project/tasks/:issue/chats/:chatId/agents/:toolUseId/backfill', withTask(async (task, req, res) => {
  try {
    res.json(await backfillAgent(keyOf(task), req.params.chatId, req.params.toolUseId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
app.get('/api/projects/:project/tasks/:issue/chats/:chatId/agents/:toolUseId/calls', withTask(async (task, req, res) => {
  try {
    res.json(await agentCalls(keyOf(task), req.params.chatId, req.params.toolUseId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// A background task of a chat — a server it started and never stopped. The
// board cannot kill it: the process is the CLI's, so it asks the session to
// stop it with TaskStop.
app.post('/api/projects/:project/tasks/:issue/chats/:chatId/background/:itemId/stop', withTask(async (task, req, res) => {
  try {
    res.json(await stopBackground(keyOf(task), req.params.chatId, req.params.itemId));
  } catch (e) {
    res.status(e.status ?? 400).json({ error: e.message });
  }
}));

// A person answering what a chat is waiting on: a question, or a plan.
// First answer wins; a second one, or one for a question that is gone, is
// refused with 409 so the other device learns it was already settled.
app.post('/api/projects/:project/tasks/:issue/chats/:chatId/answer', withTask(async (task, req, res) => {
  try {
    res.json(await answerChatPending(keyOf(task), req.params.chatId, req.body ?? {}));
  } catch (e) {
    res.status(e.code === 'PENDING_GONE' ? 409 : 400).json({ error: e.message, code: e.code ?? null });
  }
}));
app.post('/api/projects/:project/tasks/:issue/chats/:chatId/plan-mode', withTask((task, req, res) => {
  try {
    res.json({ planMode: setChatPlanMode(keyOf(task), req.params.chatId, Boolean(req.body?.on)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
app.post('/api/projects/:project/tasks/:issue/chats/:chatId/plan/stop', withTask((task, req, res) => {
  try {
    res.json({ status: stopChatPlan(keyOf(task), req.params.chatId) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
// The task itself waiting on a person: a pipeline session's question, or
// the plan the board wants approved before the fix.
app.post('/api/projects/:project/tasks/:issue/answer', withTask((task, req, res) => {
  try {
    res.json(answerTaskPending(keyOf(task), req.body ?? {}));
  } catch (e) {
    res.status(e.code === 'PENDING_GONE' ? 409 : 400).json({ error: e.message, code: e.code ?? null });
  }
}));
app.post('/api/projects/:project/tasks/:issue/plan/decide', withTask((task, req, res) => {
  try {
    res.json(decideTaskPlan(keyOf(task), req.body ?? {}));
  } catch (e) {
    res.status(e.code === 'PENDING_GONE' ? 409 : 400).json({ error: e.message, code: e.code ?? null });
  }
}));
app.post('/api/projects/:project/tasks/:issue/approve-plan', withTask((task, req, res) => {
  try {
    res.json({ approvePlan: setApprovePlan(keyOf(task), String(req.body?.mode ?? 'auto')) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
app.post('/api/projects/:project/tasks/:issue/resolve-conflicts', withTask((task, req, res) => {
  try {
    res.json({ resolveConflicts: setResolveConflicts(keyOf(task), String(req.body?.mode ?? 'auto')) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
app.post('/api/projects/:project/tasks/:issue/full-tests', withTask((task, req, res) => {
  try {
    res.json({ fullTests: setFullTests(keyOf(task), String(req.body?.mode ?? 'auto')) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
app.post('/api/projects/:project/tasks/:issue/fix-gaps', withTask((task, req, res) => {
  try {
    res.json({ fixGaps: setFixGaps(keyOf(task), String(req.body?.mode ?? 'auto')) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
app.post('/api/projects/:project/tasks/:issue/design', withTask((task, req, res) => {
  try {
    res.json({ design: setDesign(keyOf(task), req.body?.on) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
app.post('/api/projects/:project/tasks/:issue/chats/:chatId/plan/continue', withTask(async (task, req, res) => {
  try {
    res.json({ status: await continueChatPlan(keyOf(task), req.params.chatId) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
app.get('/api/projects/:project/tasks/:issue/demo', withTask((task, _req, res) =>
  res.json({ demoSteps: task.demoSteps, busy: task.demoBusy, demo: task.demo ?? 'auto' })));
// The card's switch for the demo phase. Only the pipeline reads it, at the
// start of its PR step (`demoWanted`), before the PR; POST /demo still
// generates the steps with it off, because a click is explicit.
app.post('/api/projects/:project/tasks/:issue/demo-mode', withTask((task, req, res) => {
  try {
    res.json({ demo: setDemo(keyOf(task), String(req.body?.mode ?? 'auto')) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// Browser QA: the plans, the verdict and the evidence list; one run on
// demand; the card's switch; and each screenshot or video, from wherever
// the task ran.
app.get('/api/projects/:project/tasks/:issue/qa', withTask((task, _req, res) => res.json(qaInfo(task))));
app.post('/api/projects/:project/tasks/:issue/qa/run', withTask(async (task, _req, res) => {
  try {
    res.json({ qa: await runBrowserQa(keyOf(task)) });
  } catch (e) {
    res.status(e.status ?? 400).json({ error: e.message });
  }
}));
app.post('/api/projects/:project/tasks/:issue/browser-qa', withTask((task, req, res) => {
  try {
    res.json({ browserQa: setBrowserQa(keyOf(task), String(req.body?.mode ?? 'auto')) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
const EVIDENCE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webm: 'video/webm', mp4: 'video/mp4' };
// Express 5 wildcards are named, and hand back the path as a list of segments.
app.get('/api/projects/:project/tasks/:issue/qa/evidence/*rel', withTask(async (task, req, res) => {
  try {
    const rel = [].concat(req.params.rel ?? []).join('/');
    const ext = rel.split('.').pop().toLowerCase();
    if (!EVIDENCE_TYPES[ext]) return res.status(400).json({ error: 'only screenshots and videos' });
    const bytes = await qaEvidence(task, rel);
    // Ranges included, so the player can jump inside a video instead of
    // downloading it from the start.
    return sendEvidence(req, res, bytes, EVIDENCE_TYPES[ext]);
  } catch (e) {
    return res.status(404).json({ error: e.message });
  }
}));

app.post('/api/projects/:project/tasks/:issue/demo', withTask(async (task, _req, res) => {
  try {
    await generateDemoSteps(task);
    res.json({ demoSteps: task.demoSteps });
  } catch (e) {
    res.status(e.status ?? 400).json({ error: e.message });
  }
}));

/**
 * Dry run: for every assigned issue, say whether the board would start it or
 * skip it because a branch/PR already exists. Starts nothing.
 */
app.get('/api/preview', async (req, res) => {
  const project = req.query.project ? String(req.query.project) : DEFAULT_PROJECT_ID; // allowlisted: api.js preview() sends no project; explicit route-layer default
  if (!projectOf(project)) return res.status(400).json({ error: `Unknown project: ${project}` });
  try {
    const issues = await listAssignedIssues(project);
    const rows = await Promise.all(issues.map(async (issue) => {
      const existing = await detectExistingWork(issue.number, { project });
      return {
        issue: issue.number,
        title: issue.title,
        labels: issue.labels,
        wouldStart: !existing.blocked,
        branches: existing.branches,
        prs: existing.prs,
        reasons: existing.reasons,
      };
    }));
    return res.json({ assigned: issues.length, wouldStart: rows.filter((r) => r.wouldStart).length, rows });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:project/tasks/:issue/attachments', withTask((task, req, res) => {
  try {
    res.json(saveAttachment(keyOf(task), req.body ?? {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// A probe of a remote box must never take the board down with it.
// Each configured family and the concrete model it resolved to in the last
// session that used it — what «opus» means today.
app.get('/api/models', (_req, res) => res.json({ models: resolvedModels(config.claude.available ?? []) }));

app.get('/api/machines', async (_req, res) => {
  try {
    res.json({ machines: await machineStatus() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:project/tasks/:issue/machine', withTask(async (task, req, res) => {
  try {
    res.json({ machine: await setTaskMachine(keyOf(task), String(req.body?.machine ?? 'local')) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/projects/:project/tasks/:issue/mode', withTask((task, req, res) => {
  try {
    res.json({ mode: setMode(keyOf(task), req.body?.mode) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

/**
 * The Fetch button: starts a cycle if none is running and answers at once —
 * a cold cycle takes minutes, so the request must not hold. Progress and the
 * result travel through the 'poll' event and `poll.last`.
 */
app.post('/api/poll', (req, res) => {
  try {
    // `{ project }`: the full cycle for that project alone (the open project's button).
    // No body: the scheduled-style cycle, viewed projects full and the rest light.
    const project = req.body?.project ?? null;
    if (project !== null && (typeof project !== 'string' || !listProjects().some((p) => p.id === project))) {
      return res.status(400).json({ error: `unknown project: ${JSON.stringify(project)}` });
    }
    const { started, promise } = startPoll(project ? { project } : { scheduled: true });
    // Nobody awaits the cycle here; its failure is already in `poll.last`.
    promise.catch(() => {});
    res.status(202).json({ ok: true, started, poll: pollStatus() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Asks the running cycle to stop starting new work; the status shows `cancelling` until it ends. */
app.post('/api/poll/cancel', (_req, res) => {
  res.json({ ok: true, poll: cancelPoll() });
});

/** Re-reads git state (fetch + branch status) now; body `{project}` limits it to one project. */
app.post('/api/git/refresh', async (req, res) => {
  const project = req.body?.project ?? null;
  if (project !== null && !listProjects().some((p) => p.id === project)) {
    return res.status(400).json({ error: `unknown project: ${JSON.stringify(project)}` });
  }
  try {
    // An explicit project is honoured; the bare call only touches what somebody is viewing.
    if (project === null) {
      const projects = [...viewedProjects()];
      if (!projects.length) return res.json({ ok: true, tasks: 0, fetched: 0 });
      return res.json({ ok: true, ...(await refreshGitNow({ projects, force: true })) });
    }
    res.json({ ok: true, ...(await refreshGitNow({ project, force: true })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:project/tasks/:issue/change-requests/:reviewId/active', withTask((task, req, res) => {
  try {
    const id = Number(req.params.reviewId);
    res.json({ active: setActiveChangeRequest(keyOf(task), req.body?.active === false ? null : id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/projects/:project/tasks/:issue/change-requests/:reviewId/draft-replies', withTask(async (task, req, res) => {
  try {
    res.json(await draftReviewReplies(keyOf(task), Number(req.params.reviewId)));
  } catch (e) {
    res.status(e.status ?? 400).json({ error: e.message });
  }
}));

app.post('/api/projects/:project/tasks/:issue/change-requests/:reviewId/discard-replies', withTask((task, req, res) => {
  try {
    res.json(discardReviewReplies(keyOf(task), Number(req.params.reviewId)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/projects/:project/tasks/:issue/change-requests/:reviewId/resolve', reviewAction((req) =>
  resolveChangeRequest(taskKey(req), Number(req.params.reviewId), {
    force: req.body?.force === true,
  })));

app.post('/api/projects/:project/tasks/:issue/change-requests/start', withTask((task, _req, res) => {
  res.json({ started: startChangeRequest(keyOf(task), { force: true }) });
}));

// Starting one task by hand, whatever auto-start and the limit say. 202: the
// pipeline carries on in the background; the body says whether it went over
// the limit and whether it is a manual task's one-shot run.
app.post('/api/projects/:project/tasks/:issue/start', (req, res) => {
  try {
    res.status(202).json(startTask(taskKey(req)));
  } catch (e) {
    res.status(e.status ?? 400).json({ error: e.message });
  }
});

// The old «Iniciar workflow»: same start, same `{ ok }` it always answered.
app.post('/api/projects/:project/tasks/:issue/force', (req, res) => {
  try {
    res.json({ ok: forceStart(taskKey(req)) });
  } catch (e) {
    res.status(e.status ?? 400).json({ error: e.message });
  }
});
/**
 * Both "ready for review" actions push first. A dirty worktree stops them with
 * 409 and the list of files, so the board can ask instead of deciding.
 */
function reviewAction(fn) {
  return async (req, res) => {
    try {
      res.json({ ok: true, ...(await fn(req) ?? {}) });
    } catch (e) {
      if (e.code === 'DIRTY_WORKTREE') res.status(409).json({ error: e.message, dirty: e.dirty });
      else if (e.code === 'MERGE_CONFLICT') res.status(409).json({ error: e.message, conflicts: e.conflicts });
      else if (e.code === 'MERGE_BLOCKED') res.status(409).json({ error: e.message, mergeBlocked: true });
      // The task points at a PR that was merged or closed: nothing to mark
      // ready until this cycle opens its own.
      else if (e.code === 'PR_GONE') res.status(409).json({ error: e.message, prGone: true });
      else res.status(400).json({ error: e.message });
    }
  };
}

app.post('/api/projects/:project/tasks/:issue/ready', reviewAction((req) =>
  markReady(taskKey(req), {
    force: req.body?.force === true,
    reviewer: pickText(req.body?.reviewer) ?? undefined,
    noReviewer: req.body?.noReviewer === true,
    always: req.body?.always === true,
  })));
app.post('/api/projects/:project/tasks/:issue/merge-main', reviewAction((req) => bringMainNow(taskKey(req))));
app.post('/api/projects/:project/tasks/:issue/push', reviewAction((req) => pushNow(taskKey(req))));
app.post('/api/projects/:project/tasks/:issue/merge-help', action((issue) => askMergeHelp(issue)));
app.post('/api/projects/:project/tasks/:issue/retry', (req, res) => res.json({ ok: retry(taskKey(req)) }));
app.post('/api/projects/:project/tasks/:issue/accept-fix', withTask(async (task, _req, res) => {
  try {
    res.json({ fixedAt: await acceptFix(keyOf(task)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
// The title you edited on the card, published: the run resumes at the PR, so
// the fix, the tests and the QA of this commit are not paid for again. 400
// carries the reasons the gate gives, for the dialog to list them.
app.post('/api/projects/:project/tasks/:issue/pr', withTask(async (task, req, res) => {
  try {
    res.json({ ok: true, ...(await publishPr(keyOf(task), req.body?.title)) });
  } catch (e) {
    res.status(e.status ?? 400).json({ error: e.message, problems: e.problems ?? [] });
  }
}));

/**
 * Closing the issue without a PR: an agent drafts the proposal, a window shows
 * it, and nothing reaches GitHub until somebody confirms. The draft, the
 * discard and the confirmation are the pipeline's; these six routes are the
 * door to them, and the two GETs below exist so the window can be drawn
 * without guessing.
 *
 * `GET …/close/draft` exists because `publicTask` strips `draftBody` from
 * every broadcast — the body is a document, not a card field. The window asks
 * for it separately when it opens, exactly as it asks `GET …/demo` for the
 * demo steps.
 */
app.get('/api/projects/:project/tasks/:issue/close/draft', withTask((task, _req, res) =>
  res.json({ closing: task.closing ?? null })));

app.post('/api/projects/:project/tasks/:issue/close/draft', closeAction(async (task, req) => ({
  closing: (await draftIssueClosing(keyOf(task), { chatId: req.body?.chatId ?? null })) ?? task.closing ?? null,
})));

app.post('/api/projects/:project/tasks/:issue/close/discard', closeAction((task) => {
  discardIssueClosing(keyOf(task));
  return { ok: true };
}));

/**
 * Everything the window needs to draw itself in one call: the repository's
 * label catalogue for the picker, and what the worktree is still holding back.
 *
 * The pending work is read HERE, before anything is confirmed, so the warning
 * is part of the window the person is reading — not a 409 thrown back at them
 * after they clicked «Cerrar». The confirmation still refuses on its own; this
 * is so that refusal is never the first news of it.
 *
 * A task with no worktree answers `pending: null` rather than failing: there
 * is nothing to hold back, and that is not an error.
 */
// `allSettled`, no `all`: los dos lados de esta respuesta se miden solos y el
// que importa no depende de GitHub. Las etiquetas son una comodidad —si `gh`
// no contesta, la ventana lo dice y se cierra sin ellas—, pero `pending` es el
// aviso de que cerrar dejaría trabajo fuera, y se lee de git, en local. Con un
// `all`, un repositorio inalcanzable se llevaba por delante la única
// advertencia que habla de perder trabajo.
app.get('/api/projects/:project/tasks/:issue/close/options', closeAction(async (task) => {
  const [labels, pending] = await Promise.allSettled([repoLabels(task.project), closePending(task)]);
  return {
    // `null` es «no se pudieron traer», que no es lo mismo que `[]`, «este
    // repositorio no tiene ninguna»: la ventana las distingue.
    labels: labels.status === 'fulfilled' ? labels.value : null,
    labelsError: labels.status === 'rejected' ? (labels.reason?.message ?? String(labels.reason)) : null,
    pending: pending.status === 'fulfilled' ? pending.value : null,
  };
}));

/**
 * The number typed into «duplicado de», resolved live. 404 means the ref is
 * really not there: `issueOrPrRef` answers `null` only on a true 404 and
 * throws on anything else, so a network hiccup never reads as "that issue does
 * not exist". `isPr` travels with it because the two are closed differently.
 */
app.get('/api/projects/:project/tasks/:issue/close/verify', closeAction(async (task, req) => {
  const n = Number(req.query.ref);
  if (!Number.isInteger(n) || n <= 0) {
    const bad = new Error(`«${req.query.ref ?? ''}» is not an issue number`);
    bad.status = 400;
    throw bad;
  }
  const ref = await issueOrPrRef(n, task.project);
  if (!ref) {
    const gone = new Error(`#${n} does not exist in this repository`);
    gone.status = 404;
    throw gone;
  }
  return ref;
}));

app.post('/api/projects/:project/tasks/:issue/close', closeAction(async (task, req) => {
  const body = req.body ?? {};
  const closing = await closeIssueWithoutPr(keyOf(task), {
    comment: body.comment,
    reason: body.reason ?? null,
    duplicateOf: body.duplicateOf ?? null,
    labels: Array.isArray(body.labels) ? body.labels : [],
    force: body.force === true,
  });
  return { closing: closing ?? store.get(keyOf(task))?.closing ?? null };
}));

/** What `GET …/close/options` reports as `pending`, or null with no worktree. */
async function closePending(task) {
  const machine = machineOf(task);
  if (!task.branch || !(await isProjectWorktree(machine, task.worktreePath))) return null;
  const [work, commits] = await Promise.all([
    pendingWork(machine, task.worktreePath, task.branch),
    hasCommits(machine, task.worktreePath),
  ]);
  return { dirty: work.dirty.length, unpushed: work.unpushed, commits };
}

/**
 * The six routes above, and only them. Deliberately NOT an extension of
 * `reviewAction`: that one belongs to the review flow and speaks its
 * vocabulary (dirty worktrees, merge conflicts, a PR that is gone), and
 * closing an issue without a PR is not that flow. Sharing the wrapper would
 * mean every new code of one showing up in the other's answers.
 *
 * Every refusal names itself in the body, so the window can paint it inline
 * instead of closing on a bare message:
 *
 * - 409 `pending`        — the worktree is still holding work back.
 * - 409 `foreignComment` — the saved comment id points at somebody else's
 *                          comment: corrupt data, to be looked at, not
 *                          written around.
 * - 409 `commentGone`    — the comment the board published is no longer there.
 * - 400 `ref`            — «duplicado de» names a number that is not there.
 * - 400 `unknownLabels`  — labels this repository does not have; the board
 *                          never creates one.
 * - 400 `problems`       — the publishing gate's own list, in the very shape
 *                          `POST …/pr` already answers with, so the window
 *                          draws them the same way.
 *
 * The task is looked up here rather than left to the pipeline: an unknown task
 * is a 404 from the door, whatever the function behind it would have said.
 */
function closeAction(fn) {
  return async (req, res) => {
    const key = taskKey(req);
    const task = key ? store.get(key) : undefined;
    if (!task) return res.status(404).json({ error: 'not found' });
    try {
      return res.json((await fn(task, req)) ?? { ok: true });
    } catch (e) {
      const error = e.message;
      if (e.code === 'PENDING_WORK') {
        return res.status(409).json({
          error,
          pending: e.pending ?? { dirty: e.dirty ?? 0, unpushed: e.unpushed ?? null, commits: e.commits ?? false },
        });
      }
      if (e.code === 'FOREIGN_COMMENT') return res.status(409).json({ error, foreignComment: true, commentUrl: e.commentUrl ?? null });
      if (e.code === 'COMMENT_GONE') return res.status(409).json({ error, commentGone: true });
      if (e.code === 'DUPLICATE_UNKNOWN') return res.status(400).json({ error, ref: e.ref ?? null });
      // `unknown` is what `github.js`/`pipeline.js` name the list; the body
      // says `unknownLabels`, because on the wire it sits next to `labels`
      // and a bare `unknown` next to it reads like a third state.
      if (e.code === 'LABELS_UNKNOWN') return res.status(400).json({ error, unknownLabels: e.unknown ?? e.unknownLabels ?? [] });
      if (e.problems?.length) return res.status(400).json({ error, problems: e.problems });
      return res.status(e.status ?? 400).json({ error });
    }
  };
}

// The card returns to the queue when the errand ends, so nudge the gate: a
// queued task should not wait for the next poll cycle to be picked up.
app.post('/api/projects/:project/tasks/:issue/worktree', action(async (issue) => {
  const path = await ensureWorktree(issue);
  tick();
  return path;
}));
// The one write the board makes to a person's GitHub for an empty repository:
// an initial commit on the base branch. Explicit statuses (`action` flattens
// everything to 400) and a body that must say `confirm: true`.
app.post('/api/projects/:project/tasks/:issue/bootstrap-repo', withTask(async (task, req, res) => {
  try {
    const out = await bootstrapRepo(keyOf(task), { confirm: req.body?.confirm });
    tick();
    return res.json(out);
  } catch (e) {
    return res.status(e.status ?? 400).json({ error: e.message, code: e.code ?? null });
  }
}));
app.post('/api/projects/:project/tasks/:issue/worktree/delete', action((issue) => deleteWorktree(issue)));

// Moving a task to another machine. The dialog polls the preflight while it
// is open; the move answers 202 once validated and carries on in the
// background, and a refusal names every blocker so the dialog can list them.
app.get('/api/projects/:project/tasks/:issue/move/preflight', withTask(async (task, req, res) => {
  try {
    res.json(await movePreflight(keyOf(task), String(req.query.to ?? ''), {
      discardTargetLocal: req.query.discardTargetLocal === '1',
    }));
  } catch (e) {
    res.status(e.status ?? 400).json({ error: e.message });
  }
}));
app.post('/api/projects/:project/tasks/:issue/move', withTask(async (task, req, res) => {
  try {
    const body = req.body ?? {};
    await moveTask(keyOf(task), {
      to: body.to,
      oldWorktree: body.oldWorktree,
      prewarm: typeof body.prewarm === 'boolean' ? body.prewarm : undefined,
      discardTargetLocal: typeof body.discardTargetLocal === 'boolean' ? body.discardTargetLocal : undefined,
    });
    res.status(202).json({ ok: true });
  } catch (e) {
    res.status(e.status ?? 400).json({ error: e.message, blockers: e.blockers ?? null });
  }
}));
app.post('/api/projects/:project/tasks/:issue/move/retry', withTask(async (task, _req, res) => {
  try {
    await retryMove(keyOf(task));
    res.status(202).json({ ok: true });
  } catch (e) {
    res.status(e.status ?? 400).json({ error: e.message, blockers: e.blockers ?? null });
  }
}));
app.post('/api/projects/:project/tasks/:issue/move/discard', withTask((task, _req, res) => {
  try {
    res.json({ ok: discardMove(keyOf(task)) });
  } catch (e) {
    res.status(e.status ?? 400).json({ error: e.message });
  }
}));
// A worktree the task left on a machine, deleted; its sessions are kept.
app.post('/api/projects/:project/tasks/:issue/places/:machine/delete', withTask(async (task, req, res) => {
  try {
    await removePlace(task, req.params.machine);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status ?? 400).json({ error: e.message });
  }
}));
app.post('/api/projects/:project/tasks/:issue/stack/start', action((issue) => startStack(issue)));
app.post('/api/projects/:project/tasks/:issue/stack/stop', action((issue) => stopStack(issue)));

/**
 * The project chat a `/api/projects/:project/project-chats/:machine/…` route is
 * about. 404 when the project is unknown or the machine is not one this
 * project's chat can live on (`holderMachines`).
 */
function withHolder(handler) {
  return (req, res) => {
    let holder = null;
    try {
      const { project, machine } = req.params;
      if (projectOf(project) && holderMachines(project).includes(machine)) holder = getHolder(project, machine);
    } catch {
      holder = null;
    }
    if (!holder) return res.status(404).json({ error: 'not found' });
    return handler(holder, req, res);
  };
}

const HB = '/api/projects/:project/project-chats/:machine';
const hkey = (h) => holderKey(h.project, h.machine);

app.get(HB, withHolder((holder, _req, res) => res.json(holderSummary(holder))));
app.get(`${HB}/chat`, withHolder((holder, req, res) => {
  const chat = chatById(holder, req.query.chatId ?? null);
  if (!chat) return res.status(404).json({ error: 'that chat does not exist' });
  return res.json({ chatId: chat.id, chat: chat.messages, busy: chat.busy, activity: chat.activity, pending: chat.pending ?? null, planMode: chat.planMode === true });
}));
app.post(`${HB}/chats`, withHolder((holder, req, res) => {
  try {
    res.json(createChat(hkey(holder), { forkFrom: req.body?.forkFrom ?? null }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
app.post(`${HB}/chats/:chatId/close`, withHolder((holder, req, res) => {
  try {
    res.json({ closed: closeChat(hkey(holder), req.params.chatId) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
app.post(`${HB}/chats/:chatId/reopen`, withHolder((holder, req, res) => {
  try {
    res.json({ id: reopenChat(hkey(holder), req.params.chatId).id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
app.post(`${HB}/chats/:chatId/delete`, withHolder((holder, req, res) => {
  try {
    res.json({ deleted: deleteChat(hkey(holder), req.params.chatId) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
app.post(`${HB}/chats/:chatId/rename`, withHolder((holder, req, res) => {
  try {
    res.json(renameChat(hkey(holder), req.params.chatId, req.body?.title));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
// A project chat takes attachments like a task chat: same body, same limit.
// They are stored under `attachments/<project>/_proyecto/` on the board;
// `putAttachment` moves them to the holder's machine when a turn sends them.
app.post(`${HB}/attachments`, withHolder((holder, req, res) => {
  try {
    res.json(saveAttachment(hkey(holder), req.body ?? {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post(`${HB}/chat/stop`, withHolder(async (holder, req, res) => {
  try {
    await interruptChat(hkey(holder), req.body?.chatId ?? null);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
app.post(`${HB}/model`, withHolder((holder, req, res) => {
  try {
    const { model, effort, thinking } = req.body ?? {};
    res.json({ model: setChatModel(hkey(holder), req.body?.chatId ?? null, model, effort, thinking) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
app.post(`${HB}/chats/:chatId/agents/:toolUseId/backfill`, withHolder(async (holder, req, res) => {
  try {
    res.json(await backfillAgent(hkey(holder), req.params.chatId, req.params.toolUseId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
app.get(`${HB}/chats/:chatId/agents/:toolUseId/calls`, withHolder(async (holder, req, res) => {
  try {
    res.json(await agentCalls(hkey(holder), req.params.chatId, req.params.toolUseId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
app.post(`${HB}/chats/:chatId/background/:itemId/stop`, withHolder(async (holder, req, res) => {
  try {
    res.json(await stopBackground(hkey(holder), req.params.chatId, req.params.itemId));
  } catch (e) {
    res.status(e.status ?? 400).json({ error: e.message });
  }
}));
app.post(`${HB}/chats/:chatId/answer`, withHolder(async (holder, req, res) => {
  try {
    res.json(await answerChatPending(hkey(holder), req.params.chatId, req.body ?? {}));
  } catch (e) {
    res.status(e.code === 'PENDING_GONE' ? 409 : 400).json({ error: e.message, code: e.code ?? null });
  }
}));
app.post(`${HB}/chats/:chatId/plan-mode`, withHolder((holder, req, res) => {
  try {
    res.json({ planMode: setChatPlanMode(hkey(holder), req.params.chatId, Boolean(req.body?.on)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
app.post(`${HB}/chats/:chatId/plan/stop`, withHolder((holder, req, res) => {
  try {
    res.json({ status: stopChatPlan(hkey(holder), req.params.chatId) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
app.post(`${HB}/chats/:chatId/plan/continue`, withHolder(async (holder, req, res) => {
  try {
    res.json({ status: await continueChatPlan(hkey(holder), req.params.chatId) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
// Create-task from a project chat (draft and create) lives in its own module.
registerIssueDraftRoutes(app, { withHolder });

/**
 * The task a `/api/projects/:project/tasks/:issue/…` route is about, as a
 * canonical key. The two halves travel as separate path segments because `#`
 * starts a fragment and would never reach the server (`keys.js`); they are put
 * back together here, at the door, and nothing downstream sees them apart.
 *
 * `makeKey` throws on a malformed half — a project id with a slash or an
 * uppercase letter, an issue with leading zeros. That is a route nobody can
 * have meant, so it answers `null` and the caller replies 404, exactly as it
 * would for a task that is not there.
 */
function taskKey(req) {
  try {
    return makeKey(req.params.project, req.params.issue);
  } catch {
    return null;
  }
}

function withTask(handler) {
  return (req, res) => {
    const key = taskKey(req);
    const task = key ? store.get(key) : undefined;
    if (!task) return res.status(404).json({ error: 'not found' });
    return handler(task, req, res);
  };
}

function action(fn) {
  return async (req, res) => {
    const key = taskKey(req);
    if (!key) return res.status(404).json({ error: 'not found' });
    try {
      await fn(key);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  };
}

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

// A task is announced at once the first time, then at most once per window: a
// chat turn touches its task per tool call, and each announcement serializes the
// whole card for every open board. The trailing send carries the latest state,
// so nothing is lost, only merged.
const TASK_BROADCAST_WINDOW_MS = 250;
const taskWindows = new Map();
store.on('task', (task) => {
  const open = taskWindows.get(task);
  if (open) { open.again = true; return; }
  broadcast({ type: 'task', task: publicTask(task) });
  const win = { again: false, timer: null };
  win.timer = setTimeout(() => {
    taskWindows.delete(task);
    if (win.again) broadcast({ type: 'task', task: publicTask(task) });
  }, TASK_BROADCAST_WINDOW_MS);
  win.timer.unref?.();
  taskWindows.set(task, win);
});
// `project` is the store's own last argument (`store.js`), forwarded, not
// guessed here: only the store knows which file the task came out of. The two
// halves stay separate on the wire, as they do in every URL — `#` never
// travels — and the browser puts them back together to find the card.
//
// A project chat's events carry a 6th argument, `{ owner: 'project', machine }`,
// that rides on the wire as-is; a task's events carry none.
store.on('log', (issue, entry, project, extra) => broadcast({ type: 'log', project, issue, entry, ...(extra ?? {}) }));
store.on('chat', (issue, chatId, message, project, extra) => broadcast({ type: 'chat', project, issue, chatId, message, ...(extra ?? {}) }));
store.on('chat-update', (issue, chatId, update, project, extra) => broadcast({ type: 'chat-update', project, issue, chatId, ...update, ...(extra ?? {}) }));
// The store hands over the raw holder; the board receives its summary.
store.on('project-chat', (holder) => broadcast({ type: 'project-chat', holder: holderSummary(holder) }));
// Cards carry `browserQaProjectOn` (and the wanted flags), which depend on the
// settings: when one of those moves, open boards get the tasks again. Only then
// (chat tabs also emit `change`), and straight to the sockets, never through
// `store.touch`, so nothing is written to disk.
let taskSettingsSig = '';
const taskSettingsSigOf = (v) => JSON.stringify([v.browserQa, v.approvePlan, v.fixGaps, v.fullTests, v.resolveConflicts, v.demo, v.projects ?? {}]);
settings.on('change', (values) => {
  broadcast({ type: 'settings', settings: values });
  const sig = taskSettingsSigOf(values);
  if (sig === taskSettingsSig) return;
  taskSettingsSig = sig;
  const known = machines();
  for (const t of store.all()) broadcast({ type: 'task', task: publicTask(t, known) });
});
taskSettingsSig = taskSettingsSigOf(settings.snapshot());
pollEvents.on('poll', (poll) => broadcast({ type: 'poll', poll }));
upgradeEvents.on('state', (state) => broadcast({ type: 'upgrade', state }));
// `state` mirrors the upgrade broadcast; `quota` mirrors the field the
// snapshot carries. The same object under both names, so the board can read it
// by whichever it already knows.
quotaEvents.on('state', (state) => broadcast({ type: 'quota', state, quota: state }));
usageEvents.on('state', (usage) => broadcast({ type: 'usage', usage }));
// States and timestamps only: the URL and the code of a renewal never leave
// the response to the client that asked for them.
loginEvents.on('state', (state) => broadcast({ type: 'login', login: state }));
// Plugin names and ids per machine; never a path or a token.
pluginEvents.on('state', (plugins) => broadcast({ type: 'plugins', plugins }));
// A runner that comes back may have pulled the board plugin in the meantime.
runnerEvents.on('online', () => { warmBoardPlugins().catch(() => null); });

wss.on('connection', (socket, request) => {
  const refusal = socketRefusal(request);
  if (refusal) {
    // 4403: wrong Host or Origin (a foreign page); 4401: the caller only lacks the token.
    if (refusal === 'token') socket.close(4401, 'token requerido');
    else socket.close(4403, 'Host u Origin no permitido');
    return;
  }
  socket.send(JSON.stringify({ type: 'snapshot', ...snapshot() }));
  socket.on('close', () => dropViewer(socket));
  socket.on('error', () => dropViewer(socket));
  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      // What this browser shows: only the visible projects get the full poll.
      if (handleViewMessage(socket, msg)) return;
      // A project chat: no issue, so the owner is the holder of project × machine.
      if (msg.type === 'chat' && msg.owner === 'project' && typeof msg.machine === 'string') {
        if (typeof msg.text !== 'string' || !msg.text.trim()) return;
        if (typeof msg.project !== 'string' || !holderExists(msg.project, msg.machine)) return;
        Promise.resolve(sendChat(holderKey(msg.project, msg.machine), msg.chatId ?? null, msg.text.trim(), acceptedAttachments(msg.attachments), { voice: msg.voice === true }))
          .catch((e) => socket.send(JSON.stringify({ type: 'error', error: e.message })));
        return;
      }
      if (msg.type === 'chat' && msg.issue && typeof msg.text === 'string' && msg.text.trim()) {
        // A board from before projects sends no `project`: it means the one
        // the board has always watched. An unreadable pair is dropped rather
        // than sent to whatever task the bare number happens to name.
        const key = coerceKey(msg.issue, msg.project ?? DEFAULT_PROJECT_ID); // allowlisted: legacy ws clients send a bare issue number
        if (!key) return;
        sendChat(key, msg.chatId ?? null, msg.text.trim(), acceptedAttachments(msg.attachments), { voice: msg.voice === true });
      }
    } catch (e) {
      socket.send(JSON.stringify({ type: 'error', error: e.message }));
    }
  });
});

// The listen address is fixed at boot; a token added or removed later changes
// what it should be but not what it is.
let bootHost;
configEvents.on('change', ({ needsRestart }) => {
  console.log('config.json recargado; se aplica a partir de la próxima fase');
  if (listenHost() !== bootHost) {
    console.log(`  (reinicia para que el tablero escuche en ${listenHost() ?? 'todas las interfaces'})`);
  }
  if (needsRestart.length) {
    console.log(`  (requiere reinicio para: ${needsRestart.join(', ')})`);
  }
});
configEvents.on('invalid', (e) => {
  console.error(`config.json no se pudo leer (${e.message}); se mantiene la configuración anterior`);
});

// Before the port opens: a template the board cannot render (one missing from
// PARALLEL_SCOPE, say) must fail the start, not leave a board that listens but
// never polls or resumes anything. `listening` is still false here, so the
// crash guard exits with 1 and the restart and upgrade scripts see a dead board.
const promptCount = validatePrompts();

// The project chats' file converts to the split format (once, with a backup) here,
// where a few seconds of work block nobody, and not on the first message of a chat.
migrateProjectChatsOnBoot();

bootHost = listenHost();
server.listen(config.port, bootHost, () => {
  // From here on the board exists and holds state: the crash guard stops
  // treating a failure as "it never started" and starts keeping the process up.
  listening = true;
  console.log(`hfs-monitor escuchando en http://localhost:${config.port}`);
  console.log(`acceso: ${describeAccess()}`);
  console.log(`proyecto: ${config.project.repoPath} (${config.github.repo})`);
  console.log(`plantillas de prompt validadas: ${promptCount}`);
  startPolling();
  startUsageProbe();
  tick();
  // The job a previous board left: kept waiting, failed where it was cut, or
  // watched until the laptop script writes its result. Then detection, now
  // and every 6 h.
  resumeOnBoot()
    .catch((e) => console.error(`[upgrade] no se pudo retomar la actualización: ${e.message}`))
    .finally(() => {
      startUpgradeChecks();
      startLoginChecks();
      // Read-only, but it spawns the CLI on every machine: leave the boot (the first
      // poll, the resumed work) its CPU and let the check come a little later.
      setTimeout(startPluginChecks, PLUGIN_CHECK_DELAY_MS).unref();
      warmBoardPlugins().catch(() => null);
      // The quota hold a previous board left, on the same hook: a past `until`
      // releases at once, a future one arms the clock again. After the
      // upgrade, so a board that comes back mid-upgrade does not relaunch work
      // the upgrade is about to cut.
      try {
        resumeQuotaOnBoot();
      } catch (e) {
        console.error(`[quota] no se pudo retomar la retención: ${e.message}`);
      }
      tick();
    })
    // The `.finally` above builds a promise nobody holds: anything it throws
    // would come back as an unhandled rejection with no context at all.
    .catch((e) => console.error(`[boot] ${e.stack ?? e.message}`));
});
