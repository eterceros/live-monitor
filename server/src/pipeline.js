import path from 'node:path';
import { existsSync } from 'node:fs';
import { config, DATA_DIR } from './config.js';
import { store } from './store.js';
import { settings } from './settings.js';
import { Mutex, Semaphore } from './exec.js';
import { machineOf, machineFor, machineViewFor, machines, requireProject } from './machine.js';
import {
  runClaude, parseTriageResult, parseTaggedJson, stripTaggedLine, expectedClaudeVersion,
  sdkVersion, latestSdkVersion, isNewerVersion, versionAtLeast,
} from './claude.js';
import { upgradeHoldsNewWork, upgradeRunning, assertNoUpgradeRunning } from './upgrade.js';
import {
  quotaHoldsNewWork, markQuotaCanary, quotaHold, quotaHooks, parkForQuota, clearQuotaPark, parkedIssues, pruneParked,
  assertNoQuotaHold, quotaRefusalMessage, quotaWaitLine, describeResume, looksLikeUsageLimit,
} from './quota.js';
import { renderPrompt } from './prompts.js';
import { processRuleFor, shellRuleFor, tmpRuleFor } from './rules.js';
import { idleWaitProblem } from './waitgate.js';
import { machineNoteFor, arrivalBlock } from './handoff.js';
import { removePlace, restoreSessions } from './move.js';
import {
  WORK_PLAN_TAG, readWorkPlan, workPlanComplaint, workPlanContract,
  renderWorkPlan, parallelismLine, planIgnored, planStats, subagentsUsed,
} from './workplan.js';
import { withNudge } from './nudge.js';
import {
  deriveBranchName, createWorktree, hasCommits, pushBranch, findBranchesForIssue, listAllBranches,
  isProjectWorktree, pendingWork, analyzeMerge, mergeBlockers, mergeMain, mergeInProgress, resolveRef,
  statusPaths, worktreePathFor, commitSubject, deleteLocalBranch,
  RepoStateError, classifyRepoState, isSafeBranchName,
} from './worktree.js';
import {
  getIssue, createDraftPr, linkedPullRequests, findPrForBranch,
  prsForBranch, prView, issueReopenInfo, readyPr, addReviewer,
  getChangeRequests, requestReviewForChangeRequest, replyToReviewThread, commentOnPr,
  checksForOpenPrs, GhUnavailableError,
  closeIssue, publishIssueComment, addIssueLabels, issueComments, repoLabels, issueOrPrRef,
  CLOSE_COMMENT_MAX,
} from './github.js';
import { publishProblems, assertPublishable } from './language.js';
import { PLAN_BRIEF_HEADING, readBrief, briefProblems, briefComplaint, planText } from './planbrief.js';
import { answerOf } from './sealedanswer.js';
import { prBodyProblems, prBodyComplaint, ensureClosesLine } from './prbody.js';
import { ADVISOR_PLAN_HEADING, advisorPlanProblems, advisorPlanText, advisorPlanComplaint } from './advisorplan.js';
import { subagentGateHooks } from './subagentgate.js';
import { installProblem, INSTALL_GATED_PHASES } from './installgate.js';
import { artifactVerdict, artifactQuestion, isArtifactTool, CONFIRM_LABEL } from './artifactgate.js';
import { COLLECT_RULE } from './parallel.js';
import { ghPublishProblems, ghGateMessage, callsGh, stateChangeProblem } from './ghgate.js';
import { PHASE_LABEL, normalizePhase, planOfRun } from './phases.js';
import { hasScopes, planScopes, describePlan } from './testscope.js';
import { choosePrTitle, prTypeFor, PR_TITLE_MAX } from './prtitle.js';
import { canAutoStart, modeOf, resumeStateFor, keepsForced, newestFirst, SETTABLE_MODES } from './mode.js';
import {
  principalChat, chatById, isChatBusy, addChatTo, removeChat, titleFromPrompt, chatsOf,
  busySiblings, openChats, chatRunning, renderSiblings, tellSiblings, drainNews, leaveNote, drainNotes,
  closeChatOf, reopenChatOf,
} from './chats.js';
import { ChatSession } from './session.js';
import { chatStopHooks } from './pushguard.js';
import { newActivity, applyEvent, setOutput, closeAll, activityLabel, findItem, treeFor, mergeAgentCalls, markStopping, MAX_OUTPUT } from './activity.js';
import { transcriptCandidates, parseAgentTranscript } from './subagents.js';
import { homedir as osHomedir } from 'node:os';
import { findFreePortBase, releasePorts, ensureStackRunning, stopStack } from './stack.js';
import {
  QA_PLAN_TAG, QA_RESULTS_TAG, readQaPlan, readQaResults, qaComplaint, qaPlanContract,
  playwrightConfig, qaHelpers, mcpServers as qaMcpServers, listEvidence, describeCut, qaMarks,
  splitPlan, usableCarry, mergeQaResults, nextCarry, previousAttemptSection, scenariosOf, SUGGESTED_SCENARIOS,
} from './qa.js';
import { opencodeMcpServers } from './opencode.js';
import { condenseVideo } from './video.js';
import { continuationBrief } from './fixbrief.js';
import { resolveModel } from './models.js';
import { normalizeQuestions, validateAnswers, describeAnswers, boardQuestion, readBoardDecision } from './questions.js';
import { PLANS_DIR, planDirFor, pickPlanFile, skipMessage, reviseMessage, approveMessage, timeoutMessage } from './plans.js';
import {
  newPlanRecord, applySelection, runPlan, stopPlan, continuePlan, planSummaryLine, parallelismReportLine,
} from './planexec.js';
import {
  validatePlanChange, applyPlanChange, planChangeQuestion, readPlanChangeDecision, planChangeMcpServers,
} from './planchange.js';
import { migrateChat, expirePendingMessages } from './chats.js';
import {
  holderKey, isHolderKey, getHolderByKey, ensureHolderWorktree, refreshHolderWorktree, PROJECT_WORKTREE_DIR,
} from './projectchats.js';
import { withRetries, isTransient, lastLines, BACKOFF_MS } from './retry.js';
import { begin as beginSpan, end as endSpan, span, record as recordSpan, openPhaseOf, metricsHooks } from './metrics.js';
import { DEFAULT_PROJECT_ID, coerceKey, keyOf, makeKey } from './keys.js';
import { configFor, projectOf, baseBranchOf, projectDesignOf, rememberReviewer, setReviewer, setNoReviewer, setBaseBranch, LOGIN_RE } from './projects.js';
import { identityProblems } from './gh-account.js';
import { projectContextFor } from './project-context.js';
import { tuningFor } from './tuning.js';
import { normalizeEffort, clampEffort, thinkingModesFor, THINKING_BUDGET } from './effort.js';
import { GAPS_TAG, gapsContract, readGaps, gapsToFixBrief, chatSummary, shouldIterate, resolvableGaps } from './gaps.js';

// The label a person clicked, in the current wording or in the Spanish one a
// question parked before the switch to English still carries.
const LEGACY_CONFIRM_LABEL = 'Sí, publicar';
const isConfirmAnswer = (answer) => answer === CONFIRM_LABEL || answer === LEGACY_CONFIRM_LABEL;

const ACTIVE_STATES = ['worktree', 'triage', 'fixing', 'testing', 'browser_qa', 'fix_gaps'];

/**
 * The configuration **this task's project** runs under: the global `config`
 * with the project's overrides applied.
 *
 * Every phase reads its models, its limits, its `e2e` and its `qa` from here
 * and not from `config`, because the two projects on this board disagree about
 * all four. Left on the global config: `ask`, `retry`, `plan`,
 * `opencode` and `claude.available` — board-wide things a project has no
 * business moving, and `pending.test.mjs` mutates `config.ask.timeoutMinutes`.
 * `identity.prSignature` is read per project in `draftPrPhase`.
 *
 * ## One call per phase, at the top
 *
 * Not one per read. The cost is nil either way; what matters is coherence:
 * `config.json` is reloaded in place while the board runs, and a phase that
 * read `cfg.e2e.testCommand` before an edit and `cfg.e2e.env` after it would
 * run half of one configuration and half of another.
 *
 * ## Never cached at module level
 *
 * `configFor` clones on every call for two reasons that both apply here: the
 * live `config` is reloaded when the file changes, and the tests mutate it
 * between calls and expect to be obeyed. A clone kept in a module constant
 * would defeat both.
 *
 * **It throws** when the task's project is not in the registry, and that is
 * deliberate: a task whose project was deleted ends in `error` saying so,
 * rather than quietly running hfs's commands inside somebody else's repository.
 *
 * @param {{project: string}} task
 * @returns {Object} a fresh deep clone of the merged configuration.
 */
const cfgOf = (task) => configFor(task?.project);

/** The branch this task's project is based on (`origin/<base>`): `main` unless the registry says otherwise. */
const baseOf = (task) => baseBranchOf(task?.project);

// Every in-memory index in this module is keyed by the composite task key,
// `<project>#<issue>` (`keys.js`), and never by the bare issue number: with a
// second project on the same board, #12 of one repository and #12 of the other
// are two tasks, and a `Set` on the number alone would silently make them one.
//
// The rule that keeps the conversion safe: **the entry points accept both
// forms, the inside passes only `keyOf(task)`**. Every exported function that
// takes an `issue` coerces it at the door (`keyIn`, or the task it looks up),
// so a route, a timer or a test that still hands over a number keeps working
// while the packages around this one land in whatever order they land.
const running = new Set();          // task keys with an in-flight pipeline
// Manual tasks you started by hand, for the life of that one run. Kept apart
// from the mode on purpose: the task stays manual — the board still starts
// nothing on its own for it — but the run you ordered is not parked at the
// first phase boundary for being manual, which is what made the click useless.
const userRuns = new Set();

/**
 * The key a caller meant: a canonical key as it is, a bare issue number as the
 * default project's. `null` for anything unreadable, which every `Set`/`Map`
 * here answers with a miss — the right answer for "is this unknown thing
 * running?".
 */
const keyIn = (issue) => coerceKey(issue);

/** Whether this issue is a manual task on a run you started by hand. */
export const isUserRun = (issue) => userRuns.has(keyIn(issue));

/**
 * The pipeline body, behind a seam so a test can start a task without gh, git
 * or a Claude session.
 */
export const pipelineHooks = {
  run: (task, resumeFrom) => runPipeline(task, resumeFrom),
  runChangeRequest: (task, cr) => runChangeRequest(task, cr),
};
// One live process per chat, opened on first use and recycled when idle. Two
// chats of one task run side by side; one chat is a sequence of turns.
const liveChats = new Map();     // `${taskKey}:${chatId}` -> { session, activity, tails }
const crDrafting = new Set();    // reviewIds whose replies are being written
// e2e phases run as wide as the dashboard's parallelism allows. They used to be
// serialized because the suite defaulted to the fixed 8080 block; now each run
// gets its own verified-free port block, so the only cost of overlapping is
// machine load — which is exactly what that setting is for.
// …and per machine: two suites on two boxes do not compete for one CPU.
const e2eGates = new Map();
const e2eGateFor = (machine) => {
  if (!e2eGates.has(machine.name)) e2eGates.set(machine.name, new Semaphore(() => settings.maxActiveTasks));
  return e2eGates.get(machine.name);
};

/** Whether a pipeline is in flight for this issue right now. */
export const isRunning = (issue) => running.has(keyIn(issue));

/** The same question, by the name `move.js` asks it. */
export const isPipelineRunning = (issue) => running.has(keyIn(issue));

/**
 * Holds an issue as if a pipeline were in flight. A move does: every guard that
 * already refuses a running task (git writes, retry, auto-start, removing the
 * worktree) then refuses it too, without each one learning about moves.
 */
export function markRunning(issue, on) {
  const key = keyIn(issue);
  // A key that cannot be read is not a task: holding `null` in the set would
  // block nothing and never come out.
  if (!key) return;
  if (on) running.add(key);
  else running.delete(key);
}

/**
 * Why nothing may touch the task's sessions or worktree because of a move, or
 * null. While a move runs, obviously. And after one that failed at its `chats`
 * step: `task.machine` is already the target, but the chats may still hold the
 * source's session ids, and a turn would resume a conversation that lives on
 * the other machine. Only the retry finishes that. A move that failed before
 * arriving left the task whole; one that failed after `chats` (removing the
 * old worktree, the prewarm) left the chats already rewired.
 */
export function movingReason(task) {
  const moving = task?.moving;
  if (!moving) return null;
  if (!moving.error) return 'The task is moving to another machine';
  if (moving.step === 'chats') return 'The move was left half-done: retry it';
  return null;
}

/** Refuses with 409 while a move holds the task (see `movingReason`). */
export function assertNotMoving(task) {
  const reason = movingReason(task);
  if (reason) throw Object.assign(new Error(reason), { status: 409 });
}

/**
 * Why a task reassigned away from the board's user in GitHub must not start
 * anything, or null. The poller marks it (`task.unassigned`, see
 * `settleUnassigned`); until the assignment comes back, no entry point that
 * spends a session or a `gh` call on it should fire.
 */
export function unassignedReason(task) {
  const mark = task?.unassigned;
  if (!mark) return null;
  const to = Array.isArray(mark.to) ? mark.to : [];
  return to.length
    ? `The task is reassigned to ${to.join(', ')} on GitHub`
    : 'The task is unassigned on GitHub';
}

export function activeCount() {
  return store.all().filter((t) => ACTIVE_STATES.includes(t.state) || running.has(keyOf(t))).length;
}

/** Starts pipelines for queued tasks while there are free slots (limit set from the dashboard). */
export function tick() {
  // An upgrade scheduled or under way: nothing new starts, so the board can
  // become idle and the upgrade can take it.
  if (upgradeHoldsNewWork()) return;
  // The account's limit: every session would hit the same wall in seconds.
  // Read only — the hold's life cycle belongs to `quota.js`'s clock, and this
  // is called from a dozen places.
  if (quotaHoldsNewWork()) return;
  if (process.env.HFSMON_NO_AUTOSTART === '1') return;
  // `classified` gates auto-start: a task the poller has just seen has not been
  // checked against GitHub yet, and starting it could duplicate existing work.
  const startable = store.all()
    .filter((t) => t.state === 'assigned' && canAutoStart(t) && (t.classified || t.forced) && !movingReason(t) && !t.unassigned
      // A reopen whose issue was closed again before it started: the poll is
      // about to reclassify it. Not a plain `issueClosed` — a 🚀 you queued on
      // a closed task is still your order.
      && !(t.reopenedAt && t.issueClosed))
    .sort((a, b) => a.issue - b.issue);
  for (const [i, task] of startable.entries()) {
    if (activeCount() >= settings.maxActiveTasks) {
      // Every task left in the queue waits for a slot from now on. Stamped once,
      // with no touch: `startPipeline` turns it into a `wait` span.
      for (const queued of startable.slice(i)) {
        if (settings.autoStartFor(queued.project)) queued.slotWaitSince ??= new Date().toISOString();
      }
      break;
    }
    // Inside the loop, not before it: auto-start is per project now, so a board
    // driving hfs on its own while a new project is watched by hand is one
    // switch, not a reason to stop looking at the queue. The task cap above
    // stays board-wide — it is about this machine, not about a repository.
    if (!settings.autoStartFor(task.project)) continue;
    if (!running.has(keyOf(task))) startPipeline(task);
  }

  // A change request is found once and only once, so one that could not start
  // when it appeared — no free slot, or auto-start was off — has no second
  // chance unless this gate picks it up when it opens.
  for (const task of store.all()) {
    if (activeCount() >= settings.maxActiveTasks) break;
    if (canAutoStart(task) && activeChangeRequest(task)?.status === 'pending' && !movingReason(task) && !task.unassigned) startChangeRequest(keyOf(task));
  }
}

// Raising the limit (or re-enabling auto-start) from the dashboard releases
// queued tasks immediately, and lets waiting test runs start too.
settings.on('change', () => {
  for (const gate of e2eGates.values()) gate.refresh();
  tick();
});

/**
 * Everything the classification asks GitHub and git, behind a seam so a test
 * can drive a reopened issue or a merged PR without `gh`. Exported and mutable
 * on purpose: the poller calls these functions with no steps of its own, and a
 * test swaps a property here to reach that same path.
 */
export const CLASSIFY_STEPS = { issueReopenInfo, findBranchesForIssue, linkedPullRequests, prsForBranch, prView };

/** A PR the current cycle can still use: open, draft or not. */
export const isOpenPr = (pr) => pr?.state === 'OPEN' || pr?.state === 'DRAFT';

const isFinishedPr = (pr) => pr?.state === 'MERGED' || pr?.state === 'CLOSED';

/**
 * One list per task, newest first (`newestFirst`), each PR once. When two
 * sources know the same PR, the later list wins field by field, empty fields
 * aside — so callers pass the freshest source last.
 */
function mergePrLists(...lists) {
  const byNumber = new Map();
  for (const pr of lists.flat()) {
    if (!pr?.number) continue;
    const known = byNumber.get(pr.number);
    byNumber.set(pr.number, known ? { ...known, ...Object.fromEntries(Object.entries(pr).filter(([, v]) => v != null && v !== '')) } : { ...pr });
  }
  return [...byNumber.values()].sort(newestFirst);
}

/**
 * The fetched list plus every PR the task already knows was merged. A merged
 * PR stays merged: when its head branch is deleted, the task has no branch of
 * its own and the issue does not link the PR (#787's did not), GitHub's
 * answer comes back empty — and an empty answer on an open issue reads as
 * «nobody has touched this», which would start it all over again.
 */
function withStoredMerged(task, prs) {
  const merged = (task?.prs ?? []).filter((p) => p.state === 'MERGED');
  return merged.length ? mergePrLists(merged, prs) : prs;
}

/**
 * Work that already exists for an issue: a branch claiming its number, or a PR
 * GitHub links to it. Either means someone (or an earlier run of this board)
 * already started it, so the pipeline must not create a second branch.
 *
 * PRs are asked for branch by branch (`gh pr list --head`), never picked out of
 * the repository's latest 200: an old PR fell off that window and the task
 * walked back to «Ya iniciada» (#787). The task's own branch is asked about
 * too, because hfs deletes a head branch on merge — git no longer lists it,
 * but GitHub still knows its PRs.
 *
 * `project` says whose branches and whose PRs: a bare issue number means
 * nothing without it once the board watches more than one repository. It is
 * required: omitting it throws `falta el proyecto`, never falls back to hfs.
 */
export async function detectExistingWork(issueNumber, { branch = null, cache = true, steps = CLASSIFY_STEPS, project } = {}) {
  requireProject(project, 'detectExistingWork');
  const branches = await steps.findBranchesForIssue(issueNumber, { project });
  const heads = [...new Set([...branches, ...(branch ? [branch] : [])].map((b) => b.replace(/^origin\//, '')))];
  const [linked, ...byBranch] = await Promise.all([
    steps.linkedPullRequests(issueNumber, project),
    ...heads.map((head) => steps.prsForBranch(head, { cache, project })),
  ]);
  const prs = mergePrLists(linked ?? [], ...byBranch);

  const reasons = [];
  if (branches.length) reasons.push(`branch ${branches.join(', ')} already exists`);
  if (prs.length) reasons.push(`a PR already exists: ${prs.map((p) => `#${p.number}`).join(', ')}`);

  return { blocked: reasons.length > 0, branches, prs, reasons };
}

/**
 * The rule, on a list already newest first.
 *
 * Any open or draft PR means the work is waiting for approval, whatever came
 * before it. Otherwise the newest finished PR decides: merged is done, closed
 * without merging is a branch somebody started. And once anything was merged,
 * never `assigned`: merged work on an open issue is not an untouched issue,
 * and `assigned` is what auto-start picks up — only a reopen (or your 🚀)
 * starts that again.
 *
 * `since` is when the task's current cycle began (`task.cycleStartedAt`):
 * PRs finished before it belong to earlier cycles and are left out, so a new
 * cycle resting on «Ya iniciada» before it has a PR does not fall back to
 * done over the very merge it was started after. A PR whose finish time is
 * unknown still counts.
 *
 * A PR is the cycle's (`pr`) only while it is open — a merged one is history,
 * and pointing «Listo para revisión» at it is the #787 bug.
 */
export function classifyPrs(prs, branches = [], { since = null } = {}) {
  const open = prs.find(isOpenPr);
  if (open) return { state: 'waiting_approval', pr: open };
  const from = Date.parse(since ?? '');
  const finished = prs.filter(isFinishedPr).filter((p) => {
    if (!Number.isFinite(from)) return true;
    const at = Date.parse(p.mergedAt ?? p.closedAt ?? '');
    return !Number.isFinite(at) || at >= from;
  });
  const newest = finished[0];
  if (newest?.state === 'MERGED') return { state: 'done', pr: null };
  // The whole list, not the filtered one: `since` only chooses between done
  // and started. A merge from an earlier cycle still means the issue is not
  // untouched.
  if (branches.length || prs.some((p) => p.state === 'MERGED')) return { state: 'started', pr: null };
  return { state: 'assigned', pr: null };
}

/**
 * Where an issue stands, judged by the work that exists for it on GitHub:
 * see `classifyPrs`. With `task`, what it already knows is merged is kept
 * (`withStoredMerged`) and its current cycle is honoured.
 */
export async function classifyIssue(issueNumber, { task = null, ...options } = {}) {
  // The task knows its project; an explicit `project` in the options still wins.
  const existing = await detectExistingWork(issueNumber, { project: task?.project, ...options });
  const prs = task ? withStoredMerged(task, existing.prs) : existing.prs;
  return { ...classifyPrs(prs, existing.branches, { since: task?.cycleStartedAt }), ...existing, prs };
}

/**
 * The task's own PR, kept in the list even when GitHub's listing does not
 * show it yet: right after `gh pr create`, `gh pr list --head` can lag, and
 * dropping the PR there would walk a task that has just opened one back to
 * «Ya iniciada». Its state is asked for, once, rather than assumed: a PR the
 * listing misses may just as well have been merged since. Only for the
 * states in which the board holds that PR open.
 */
async function withOwnPr(task, prs, steps) {
  if (!task.prNumber || !['pr_draft', 'ready'].includes(task.state)) return prs;
  if (prs.some((p) => p.number === task.prNumber)) return prs;
  const live = await steps.prView(task.prNumber, task.project);
  const known = (task.prs ?? []).find((p) => p.number === task.prNumber);
  return mergePrLists(prs, [{
    number: task.prNumber, url: task.prUrl ?? known?.url ?? null, title: known?.title ?? task.prTitle ?? '',
    createdAt: known?.createdAt ?? null, mergedAt: null, closedAt: null,
    state: live?.isDraft ? 'DRAFT' : live?.state,
  }]);
}

const CLASSIFIABLE = ['assigned', 'started', 'waiting_approval', 'done', 'pr_draft', 'ready'];

// Finished work on a closed issue does not change on its own. Asked about once
// an hour instead of every cycle: the backlog of completed cards was most of
// the `gh` calls of a poll.
const QUIET_RECHECK_MS = 60 * 60_000;
const classifyFailLogged = new Set();   // task keys already logged for a gh failure; cleared on success
const quietChecks = new Map();   // task key -> ms of the last classification
// «Finished» is `classified`, never the shape of the PR list. Both PR-shaped
// terms this used to carry answered false for ever on a real card, and a card
// that never goes quiet pays a full `detectExistingWork` every single cycle:
// `!some(isOpenPr)` on a task completed by a closed issue that still holds an
// open or draft PR (see `completeOnIssueClosed`), and `length > 0` on an issue
// closed with no PR at all. Classified once, asked again hourly.
// A completed card whose issue is still open (work merged and the issue left
// open) is quiet too: it is asked about at most once an hour, not every poll.
const isQuiet = (task) => task.state === 'done' && Boolean(task.classified);

/**
 * When this task was last classified: the persisted `classifiedAt` (survives a
 * restart) or the in-memory map, whichever is newer.
 */
export function lastClassifiedAt(task) {
  return Math.max(Number(task.classifiedAt) || 0, quietChecks.get(keyOf(task)) ?? 0);
}
/** Whether a quiet task was classified recently enough not to be asked about. */
export const quietRecently = (task, now = Date.now()) => isQuiet(task) && now - lastClassifiedAt(task) < QUIET_RECHECK_MS;
/**
 * A completed task the full cycle need not walk: done, its issue closed, already
 * classified, with no pending forced start, no reopen marker and no open/draft PR.
 * For it classification cannot change the state.
 */
export const settledDone = (t) => t.state === 'done' && t.issueClosed === true && Boolean(t.classified)
  && !t.forced && !t.reopenedAt && !(t.prs ?? []).some(isOpenPr);

/**
 * The states a closed issue settles by itself, and deliberately NOT
 * `CLASSIFIABLE`: `error` and `plan_ready` are here precisely because they are
 * not classifiable — a classification would hand them `verdict.state` on every
 * poll while their issue is still open, taking the error message and the
 * 🔁 Reintentar (which needs `state === 'error'`) with it. A closed issue is
 * the one fact that settles them without anybody pressing anything.
 */
const CLOSED_OUT_STATES = ['assigned', 'started', 'waiting_approval', 'pr_draft', 'ready', 'error', 'plan_ready'];

/** Seam for tests: the stack stop `completeOnIssueClosed` fires without awaiting. */
export const issueClosedHooks = { stopStack: (key) => stopStack(key) };

/**
 * Completes a task whose issue is closed on GitHub, wherever it is standing.
 *
 * One decision, one function, called by the classification here and by the
 * poller: two copies of it would drift, and the tempting shortcut — adding
 * `error` and `plan_ready` to `CLASSIFIABLE` — is a regression, see
 * `CLOSED_OUT_STATES`.
 *
 * A run in flight is never interrupted: the answer is `'running'` and the
 * caller says so in one line, for a person to decide. `plan_ready` is exactly
 * why the `running` set is asked as well as `ACTIVE_STATES` — a pipeline parked
 * on a plan holds its key there (`startPipeline`) while its state is not active.
 *
 * A stack the board started for this task does not outlive it either — the
 * same ending `closeIssueWithoutPr` reaches by hand, here reached by GitHub
 * closing the issue instead. This function is synchronous — `refreshClassification`
 * below and the poller's two `complete(task)` seams all call it that way — so the
 * stop is fired without being awaited: fire-and-forget inside a sync function, as
 * `stopPrewarm` does in `move.js`, but with `closeIssueWithoutPr`'s logging catch
 * rather than that one's silent `.catch(() => {})`. A cleanup must not be able to
 * fail the completion that triggered it, and must not go unsaid either.
 *
 * @param {object} task
 * @returns {'done'|'running'|'skip'} `'done'`: moved to «Completada».
 *   `'running'`: there is a live run and nothing was written. `'skip'`: this
 *   task is not the rule's business (open issue, already done, moving, a busy
 *   chat, an order that has not run yet, or a state nothing settles).
 */
export function completeOnIssueClosed(task) {
  if (!task?.issueClosed) return 'skip';
  // Never interrupt a run. Both terms: a pipeline parked on `plan_ready` holds
  // the key in `running` although its state is not in `ACTIVE_STATES`, and that
  // is what keeps a live plan approval from being yanked out from under it.
  if (running.has(keyOf(task)) || ACTIVE_STATES.includes(task.state)) return 'running';
  if (task.state === 'done') return 'skip';
  // A move snapshots `{state, prevState, error}` to restore, and `setState`
  // would overwrite them: a task in error must keep its Retry (see `move.js`).
  if (task.moving) return 'skip';
  if (isChatBusy(task)) return 'skip';
  // A 🚀 you queued, or a click parked on the quota, is an order that has not
  // run yet (`keepsForced` already withdraws a reopen killed by a re-close).
  // Narrower than `keepsForced` on purpose: it also holds `error`, so that a
  // Retry resumes the very run it was allowed past — but there the run DID
  // happen and failed, and the Retry it protects would start a fix on an issue
  // that is already closed. A task force-started over prior work, then failed,
  // then closed on GitHub, would otherwise stay red for ever.
  if (task.forced && keepsForced(task) && (task.state === 'assigned' || task.quotaPark)) return 'skip';
  if (!CLOSED_OUT_STATES.includes(task.state)) return 'skip';

  const was = task.state;
  // `setState` nulls `task.error`, so the message is read before it.
  const failure = task.error;
  const open = (task.prs ?? []).find(isOpenPr);
  // For every state this moves, not only `error`: a `phase` left behind makes
  // `reopenBlocker` answer «la tarea tiene un ciclo en curso» for ever, and no
  // later reopen of this issue could be taken. `plan_ready` carries one too.
  task.phase = null;
  // The parked question goes with the run. `settleTaskPending` answers a wait
  // that is really there; after a restart there is none and only the persisted
  // `task.pending` is left, which would keep a ❓ on a «Completada» card that
  // nobody can ever clear (`expireTaskPending` falls back the same way).
  if (!settleTaskPending(task, { action: 'stop' }) && task.pending) task.pending = null;
  store.setState(task, 'done');
  const notes = [];
  if (open) notes.push(`PR #${open.number}${open.state === 'DRAFT' ? ' (draft)' : ''} is still open`);
  if (was === 'error') notes.push(`the error it had: ${failure ?? 'no message'}`);
  if (was === 'plan_ready') notes.push('the plan that was waiting for approval will not run');
  store.addLog(task, 'guard', `the issue was closed on GitHub: the task is completed${notes.length ? ` — ${notes.join('; ')}` : ''}`);
  // Not awaited: this function is synchronous. A stack left running would
  // otherwise hold ports and a container for work nobody is going to look at
  // again, but the completion above must not wait on — or be able to fail
  // because of — stopping it.
  if (task.stack) {
    issueClosedHooks.stopStack(keyOf(task))
      .catch((e) => store.addLog(task, 'stack', `⚠️ could not stop the stack: ${reasonOf(e)}`));
  }
  return 'done';
}

/**
 * Settles a task whose issue was reassigned away from the board's user: the
 * card is about to be hidden, so what the board holds for it is let go.
 *
 * Same guard order as `completeOnIssueClosed`, and the same rule: a run in
 * flight is never interrupted (`'running'`, nothing written; the mark stays
 * unsettled and the poller retries). What it does, once quiet: answers the
 * parked question, drops `forced`, stops the stack and runs
 * `cleanupAfterClose` (which keeps anything with unpushed or dirty work and
 * never touches origin). Open PRs are only reported — closing them is a
 * person's call. `task.state` is NEVER changed, so reassigning the issue back
 * restores the card exactly where it was. Never throws.
 *
 * @param {object} task
 * @returns {Promise<'settled'|'running'|'skip'>}
 */
export async function settleUnassigned(task) {
  if (!task?.unassigned) return 'skip';
  if (running.has(keyOf(task)) || ACTIVE_STATES.includes(task.state)) return 'running';
  if (task.moving) return 'skip';
  if (isChatBusy(task)) return 'skip';
  try {
    if (!settleTaskPending(task, { action: 'stop' }) && task.pending) task.pending = null;
    if (task.forced) {
      task.forced = false;
      store.addLog(task, 'guard', 'the task was reassigned on GitHub: the forced start is dropped');
    }
    if (task.stack) {
      await issueClosedHooks.stopStack(keyOf(task))
        .catch((e) => store.addLog(task, 'stack', `⚠️ could not stop the stack: ${reasonOf(e)}`));
    }
    try {
      await cleanupAfterClose(task);
    } catch (e) {
      store.addLog(task, 'close', `⚠️ cleanup of the reassigned task failed: ${reasonOf(e)}`);
    }
    const open = (task.prs ?? []).filter(isOpenPr);
    if (open.length) {
      store.addLog(task, 'guard', `PRs ${open.map((p) => `#${p.number}${p.state === 'DRAFT' ? ' (draft)' : ''}`).join(', ')} are still open: the board does not close them`);
    }
    task.unassigned.settled = true;
    store.touch(task);
    return 'settled';
  } catch (e) {
    store.addLog(task, 'guard', `⚠️ could not settle the reassigned task: ${reasonOf(e)}`);
    return 'skip';
  }
}

/**
 * Whether the classifier has never looked at this task: the only kind of task
 * the light poll spends `gh` on. Anything already classified is left to the
 * full poll (no quiet re-check, no hourly re-ask here).
 */
export function needsClassification(task) {
  return Boolean(task)
    && !task.classified && task.state !== 'done'
    && !task.unassigned && !task.issueClosed && !task.moving;
}

/** `refreshClassification` for a task that is new to the classifier; a no-op otherwise. */
export async function classifyNewTask(task, steps = CLASSIFY_STEPS) {
  if (!needsClassification(task)) return;
  await refreshClassification(task, steps);
}

/**
 * Re-reads GitHub for a task the board is not actively working on.
 *
 * All of GitHub is read before anything is written: a `gh` that fails halfway
 * leaves the task exactly as it was (the poller logs the error), rather than
 * with a PR list from one call and a state from none. And what was true before
 * the reads is checked again after them: a run, a click or a reopen may have
 * taken the task while `gh` was answering, and this must not overwrite it.
 */
export async function refreshClassification(task, steps = CLASSIFY_STEPS) {
  const key = keyOf(task);
  // Reassigned away in GitHub: nothing here may spend `gh` on it.
  if (task.unassigned) return;
  if (ACTIVE_STATES.includes(task.state) || running.has(key)) return;
  if (!CLASSIFIABLE.includes(task.state)) return;
  // The say-so to start covers one run; honoured while that run is pending,
  // dropped below once it is over (see `keepsForced`).
  if (task.forced && keepsForced(task)) return;
  if (quietRecently(task)) return;
  const stateBefore = task.state;

  // A PR the board holds open is asked about live: it is what «Listo para
  // revisión» is about to act on. Everything else can take the minute-old list.
  const boardOwned = ['pr_draft', 'ready'].includes(task.state);
  let existing;
  let prs;
  try {
    existing = await detectExistingWork(task.issue, { branch: task.branch, cache: !boardOwned, steps, project: task.project });
    prs = withStoredMerged(task, await withOwnPr(task, existing.prs, steps));
  } catch (e) {
    // GitHub did not answer: that is not «nothing exists». The task keeps its
    // state, PRs and classification, and is asked again next cycle.
    if (!(e instanceof GhUnavailableError)) throw e;
    const k = keyOf(task);
    if (!classifyFailLogged.has(k)) {
      classifyFailLogged.add(k);
      store.addLog(task, 'guard', `⚠️ GitHub did not answer, the classification is kept as it was (${reasonOf(e)})`);
    }
    return;
  }
  classifyFailLogged.delete(key);
  if (ACTIVE_STATES.includes(task.state) || running.has(key)
    || (task.forced && keepsForced(task)) || task.state !== stateBefore) return;

  // A reopen whose issue was closed again before its cycle ran: that cycle
  // never happened, so its start no longer hides the earlier merges, and the
  // pill has nothing left to say (see `keepsForced`).
  const withdrawn = Boolean(task.reopenedAt && task.issueClosed);
  const verdict = classifyPrs(prs, existing.branches, { since: withdrawn ? null : task.cycleStartedAt });
  task.classified = true;
  // Persisted on the task (it is saved by the touches below, never touched on
  // its own) so a restart does not re-ask about every finished card.
  const classifiedNow = Date.now();
  task.classifiedAt = classifiedNow;
  quietChecks.set(key, classifiedNow);

  const before = JSON.stringify([task.prs ?? [], task.prNumber ?? null, task.prUrl ?? null, task.existingWork ?? null, Boolean(task.forced), task.reopenedAt ?? null]);
  task.forced = false;
  if (withdrawn) {
    task.reopenedAt = null;
    task.cycleStartedAt = null;
  }
  task.prs = prs;
  // The cycle's PR is an open one or none: a merged PR is history, and the
  // `??=` that used to keep the first one ever seen is how #787 pointed at #826.
  // A PR the board already holds open wins over any other open one.
  const current = boardOwned && isOpenPr(prs.find((p) => p.number === task.prNumber))
    ? prs.find((p) => p.number === task.prNumber)
    : verdict.pr;
  task.prNumber = current?.number ?? null;
  task.prUrl = current?.url ?? null;
  // The PR exists — opened by hand, or by a run whose record was lost. No
  // title is waiting for anyone to edit, and the card cannot clear this.
  if (current) task.prPark = null;
  task.existingWork = { branches: existing.branches, prs, reasons: existing.reasons };
  const changed = before !== JSON.stringify([task.prs, task.prNumber, task.prUrl, task.existingWork, false, task.reopenedAt ?? null]);

  // A closed issue never goes back to the queue, even with no PR to point at.
  //
  // `started` as well as `assigned`, and that is the whole fix for the issue
  // closed with no PR: `classifyPrs` answers `started` the moment a branch
  // exists, and `findBranchesForIssue` reads `refs/remotes/origin` too, so
  // deleting the local branch does not make the branch go away. Without this
  // the card bounced back to «started» on the next poll, every poll. The same
  // stumble hit an issue somebody closed by hand on GitHub.
  //
  // And it is not about the verdict any more: somebody closed the issue, and
  // that is GitHub's word about the work whatever the pull request says — a
  // task still holding an open or a draft PR is completed too, with the PR
  // named on the card. `completeOnIssueClosed` owns the whole decision (and
  // the states it reaches, wider than `CLASSIFIABLE`, for the poller to share).
  if (task.issueClosed) {
    completeOnIssueClosed(task);
    store.touch(task);
    return;
  }
  // Tasks the board itself drove keep their own richer state (draft, or ready
  // for review) while their PR is open; a merge or a close is GitHub's word.
  const next = boardOwned && verdict.state === 'waiting_approval' ? task.state : verdict.state;
  if (next !== task.state) {
    store.setState(task, next);
    store.addLog(task, 'guard', existing.reasons.join('; ') || 'no prior work on GitHub');
  } else if (changed) {
    store.touch(task);
  }
}

/**
 * What stops a reopened issue from being taken back right now. Each one only
 * defers: the check runs on every cycle, and the reopen event is still there
 * next time.
 *
 * Only a task at rest may be reopened — finished (`done`), or parked on
 * `started`/`waiting_approval` — with no run pending (`forced`, a `phase` to
 * resume from). Anything else is a cycle in progress: a plan waiting for
 * approval, an error waiting for Retry, a queued start. Starting a new cycle
 * there would wipe the work it is in the middle of.
 */
function reopenBlocker(task) {
  if (running.has(keyOf(task)) || ACTIVE_STATES.includes(task.state)) return 'the task is working';
  if (!['done', 'started', 'waiting_approval'].includes(task.state) || task.forced || task.phase) {
    return 'the task has a cycle in progress';
  }
  if (isChatBusy(task)) return 'a chat turn is in progress';
  if (task.moving) return 'the task is moving to another machine';
  if (task.quotaPark) return 'the task is waiting for the quota to come back';
  return null;
}

/**
 * Whether an open issue whose work was merged has been reopened since, so a
 * new cycle must start. Pure: every input is an argument.
 *
 * Deliberately not «closed before, open now». The check is idempotent — the
 * newest PR merged, a REOPENED event on GitHub later than that merge and later
 * than the last reopen this board acted on — so a cycle that missed the edge
 * (the board was down, `gh` failed) still sees it on the next one, and one
 * that already acted never acts twice. `wasClosed` is only what the poller saw
 * before this cycle, carried in the decision.
 *
 * An open issue with merged PRs and no such event is left alone: that is a
 * PR that did not close its issue, or one branch serving several issues
 * (fix/765-790-791). Starting it again on its own would open a PR nobody asked
 * for; the 🚀 on the card is how you ask.
 */
export function detectReopen(task, wasClosed, reopenInfo, { prs = task?.prs ?? [], blocker = null } = {}) {
  const open = prs.find(isOpenPr);
  if (open) return { reopen: false, why: 'open-pr', pr: open };
  const newest = prs.find(isFinishedPr);
  if (newest?.state !== 'MERGED') return { reopen: false, why: 'not-merged' };
  const at = Date.parse(reopenInfo ?? '');
  if (!Number.isFinite(at)) return { reopen: false, why: 'no-reopen-event' };
  const mergedAt = Date.parse(newest.mergedAt ?? '');
  // Without the merge's time there is nothing to compare with: guessing
  // «after» would restart finished work.
  if (!Number.isFinite(mergedAt) || at <= mergedAt) return { reopen: false, why: 'reopen-before-merge' };
  const acted = Date.parse(task?.reopenedAt ?? '');
  if (Number.isFinite(acted) && at <= acted) return { reopen: false, why: 'already-handled' };
  if (blocker) return { reopen: false, why: 'deferred', defer: true, blocker };
  return { reopen: true, why: 'reopened', reopenedAt: reopenInfo, pr: newest, wasClosed: Boolean(wasClosed) };
}

/**
 * Takes a reopened issue back, called by the poller for every open issue
 * before it records that the issue is open. Throws when GitHub cannot be
 * read, and the poller then changes nothing — not even `issueClosed`.
 *
 * Cheap for everything else: a task that is not at rest, or has no merged PR
 * on record (and no closing seen by the last cycle), asks nothing at all. The
 * live PR list it does fetch lands in `prsForBranch`'s cache, so the
 * classification of the same cycle reuses it.
 */
export async function reopenIfNeeded(task, wasClosed, steps = CLASSIFY_STEPS) {
  if (reopenBlocker(task)) return null;
  const stored = task.prs ?? [];
  if (!wasClosed && stored.find(isFinishedPr)?.state !== 'MERGED') return null;
  if (stored.some(isOpenPr)) return null;

  // An issue the last cycle already saw open asks the one cheap question
  // first: a reopen later than the newest merge on record and than the last
  // reopen acted on. Without one — the common case, merged work on an issue
  // that simply stayed open — that is the only call this poll makes for it.
  let info;
  if (!wasClosed) {
    info = await steps.issueReopenInfo(task.issue, task.project);
    const at = Date.parse(info ?? '');
    const mergedAt = Date.parse(stored.find(isFinishedPr)?.mergedAt ?? '');
    const acted = Date.parse(task.reopenedAt ?? '');
    if (!Number.isFinite(at)) return null;
    if (Number.isFinite(mergedAt) && at <= mergedAt) return null;
    if (Number.isFinite(acted) && at <= acted) return null;
  }

  // Live, before the guards that read it: a PR opened since the last cycle
  // means the work is under review, not reopened.
  const existing = await detectExistingWork(task.issue, { branch: task.branch, cache: false, steps, project: task.project });
  const prs = withStoredMerged(task, existing.prs);
  if (prs.some(isOpenPr) || prs.find(isFinishedPr)?.state !== 'MERGED') return null;
  info ??= await steps.issueReopenInfo(task.issue, task.project);
  const decision = detectReopen(task, wasClosed, info, { prs, blocker: reopenBlocker(task) });
  if (!decision.reopen) return decision;

  task.prs = prs;
  beginNewCycle(task, `the issue was reopened on GitHub (${info}) after the merge of PR #${decision.pr.number}`);
  task.reopenedAt = new Date().toISOString();
  // Queued, and allowed past the guard: the branch and the merged PR it will
  // find are this task's own history, not someone else's work.
  task.forced = true;
  task.classified = true;
  store.setState(task, 'assigned');
  store.touch(task);
  return decision;
}

/**
 * Starts a new cycle on a task whose work was already merged or closed: the
 * issue came back (reopened), or you pressed 🚀 on it. Same branch, brought up
 * to date by the run; a new PR, like the first time.
 *
 * Everything that described the previous cycle goes, or the run would skip
 * work on its evidence: `fixedAt`/`e2ePassedAt`/`qa` would pass the fix, the
 * tests and the QA off as done, and a stale `workPlan` would be executed
 * again. The PRs themselves stay in `task.prs`: that is the history the card
 * shows. The caller sets the state.
 */
export function beginNewCycle(task, why) {
  const previous = (task.prs ?? []).find((p) => p.state === 'MERGED' || p.state === 'CLOSED');
  task.prNumber = null;
  task.prUrl = null;
  task.prTitle = null;
  task.prPark = null;
  // The body described the change of the previous cycle; this one will write
  // its own. Left on, the new PR would open with the old PR's prose.
  task.prBody = null;
  task.fixedAt = null;
  task.e2ePassedAt = null;
  task.qa = null;
  task.workPlan = null;
  task.planFeedback = null;
  task.planRejectedText = null;
  task.fixAttempts = [];
  task.demoSteps = null;
  task.demoAt = null;
  task.checks = null;
  task.error = null;
  task.phase = null;
  task.existingWork = null;
  // A cycle that starts is a cycle that expects to change something, so the
  // previous «closed with no change» no longer describes this task — and the
  // comment id goes with it, or this cycle's closing would edit the last
  // cycle's comment instead of leaving a new one.
  clearClosedWithoutPr(task);
  // PRs finished before this moment belong to earlier cycles (`classifyPrs`).
  task.cycleStartedAt = new Date().toISOString();
  // The metrics' own cycle id: durable, unlike `cycleStartedAt`, which is nulled
  // once the draft PR exists. A task from before it counts as cycle 1.
  task.metricsCycle = (Number.isInteger(task.metricsCycle) ? task.metricsCycle : 1) + 1;
  task.metricsCycleStartedAt = task.cycleStartedAt;
  // A stale stamp would book the weeks in between as one slot wait.
  task.slotWaitSince = null;
  // The previous completion no longer dates this task; it completes again later.
  task.doneAt = null;
  for (const cr of task.changeRequests ?? []) {
    if (!['resolved', 'superseded'].includes(cr.status)) cr.status = 'superseded';
  }
  task.activeChangeRequest = null;
  store.addLog(task, 'ciclo', [
    `new cycle: ${why}`,
    previous ? `PR #${previous.number} (${previous.state === 'MERGED' ? 'merged' : 'closed'}) stays in the history` : null,
    'the fix, the tests and the QA are redone, and a new PR will be opened on the same branch',
  ].filter(Boolean).join('; '));
}

/**
 * Sets who drives the task. Going automatic resumes the flow — a mode that
 * only relabelled the card would leave it parked with no way forward, which is
 * exactly the trap the old `'manual'` state was. Going manual never starts
 * anything: that is the whole point of saying manual.
 */
export function setMode(issue, mode) {
  assertNoUpgradeRunning();
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  if (!SETTABLE_MODES.includes(mode)) {
    throw new Error(`Unknown mode: ${mode}. You can only choose ${SETTABLE_MODES.join(' or ')}.`);
  }

  const asking = task.mode === 'unconfirmed';
  // Touching the switch ends a one-shot run's exemption: going manual mid-run
  // parks it at the next phase boundary, exactly as it did before one-shots.
  userRuns.delete(keyOf(task));
  task.mode = mode;
  task.modeDecidedByUser = true;
  task.suspect = null;
  store.addLog(task, 'modo', mode === 'manual'
    ? 'manual: the board will not do anything on its own; the work goes through the chat'
    : `automatic: ${asking ? 'confirmed, ' : ''}the full flow will apply`);

  if (mode === 'auto') {
    const resume = resumeStateFor(task);
    if (resume && task.state !== resume) store.setState(task, resume);
    store.touch(task);
    tick();
  } else {
    store.touch(task);
  }
  return task.mode;
}

/**
 * Not a failure: the user turned the switch while the board was working. It
 * travels as an exception only because the e2e repair loop is buried a couple
 * of frames deep; every catch that sees it parks instead of erroring.
 */
class PausedForMode extends Error {
  constructor() {
    super('la tarea pasó a manual mientras se trabajaba');
    this.name = 'PausedForMode';
  }
}

/**
 * The account ran out of usage mid-phase. Not a failure of the task either:
 * it travels as an exception so a phase buried a couple of frames deep can
 * stop at its next boundary, and `startPipeline`'s catch parks the card
 * instead of letting it reach `error` — which is what used to demand a click
 * hours later.
 *
 * `resumeFrom` is the phase the run must come back to, decided where the wall
 * was hit rather than guessed afterwards.
 */
export class QuotaExhausted extends Error {
  constructor(resumeFrom = null) {
    super(quotaRefusalMessage());
    this.name = 'QuotaExhausted';
    this.resumeFrom = resumeFrom;
    // A click that reaches one of these gets a 409 and the hour, rather than
    // a 400 that reads like «you asked for something wrong».
    this.status = 409;
  }
}

/** Where a paused task rests: somewhere it can be resumed from. */
const restingState = (task) => (task.branch ? 'started' : 'assigned');

/**
 * What a thrown thing says. Not every rejection is an `Error` — a string, or an
 * object from a library, reaches a catch just the same — and `e.message` on one
 * of those writes «undefined» into the log line that was supposed to explain it.
 */
const reasonOf = (e) => String(e?.message ?? e ?? 'no reason');

/**
 * Where a task parked by the quota rests. Like `restingState`, except that a
 * task whose PR is already open keeps the state that says so: walking it back
 * to `started` would lose that on a wait that passes.
 */
const quotaRestingState = (task) =>
  (['pr_draft', 'ready', 'waiting_approval', 'done'].includes(task.state) ? task.state : restingState(task));

/**
 * Parks one task on the hold, at the phase it has to come back to. No new
 * state: the card keeps a state it can be resumed from and wears
 * `task.quotaPark` — the marker the board and the web both read.
 */
function parkTaskForQuota(task, resumeFrom, { previousError = null } = {}) {
  const phase = normalizePhase(resumeFrom) ?? normalizePhase(task.phase) ?? 'assigned';
  const hold = parkForQuota(task, {
    resumeFrom: phase,
    // A manual task you started by hand keeps that: re-establishing it before
    // relaunching is what stops the mode check parking it again at the first
    // boundary. `userRuns` is cleared by `startPipeline`'s `finally`, so it is
    // read here, before that runs.
    wasUserRun: userRuns.has(keyOf(task)),
    previousError: previousError ?? task.error ?? null,
  });
  task.phase = phase;
  if (task.state !== quotaRestingState(task)) store.setState(task, quotaRestingState(task));
  task.error = null;
  // A fresh park is a fresh wait: forget what the last one was told, or a task
  // blocked for the very same reason under a second hold would say nothing.
  quotaSaid.delete(keyOf(task));
  // A question the dying session asked cannot be answered any more — its
  // session is gone — and leaving it on the task would light the header
  // counter, the chat tab's dot and a «Responder» button for nobody. Same
  // treatment the end of a phase already gives it. A plan is the exception:
  // it waits as long as it takes, and the run comes back to it.
  if (task.pending && task.pending.kind !== 'plan') {
    expireTaskPending(task, 'the account quota ran out and the session closed');
  }
  store.addLog(task, 'cuota', quotaWaitLine(hold, PHASE_LABEL[phase] ?? null));
  store.touch(task);
  return hold;
}

/** Test seam: the real parking, with whatever `userRuns` and the hold hold. */
export const parkTaskForQuotaOf = (task, resumeFrom, options) => parkTaskForQuota(task, resumeFrom, options);

/** The same, for a click that would have started a run right now. */
function parkClickForQuota(task, resumeFrom) {
  const hold = parkTaskForQuota(task, resumeFrom);
  return { started: false, parked: true, resumeFrom: task.phase, quota: { until: hold.until ?? null, state: hold.state } };
}

/**
 * Parks a task the board must not carry further, on a state it can come back
 * from. Called at the phase boundaries: flipping the switch mid-flight stops
 * the work when the current phase ends, rather than being ignored until the
 * task has already opened a PR.
 */
function pausedForMode(task, phase) {
  if (mayCarryOn(task)) return false;
  store.addLog(task, 'modo', `stopped before ${phase}: the task is manual`);
  // Nothing is in flight any more: the next run is started by you, from the
  // queue, not resumed from the phase this one stopped at.
  task.phase = null;
  store.setState(task, restingState(task));
  return true;
}

/** Test seam: the real phase-boundary check, with whatever `userRuns` holds. */
export const pausedForModeOf = (task, phase) => pausedForMode(task, phase);

/**
 * Whether a run in flight may go on to its next phase or repair round: an
 * automatic task, or a manual one on the run you started by hand.
 */
export const mayCarryOn = (task) => canAutoStart(task) || userRuns.has(keyOf(task));

/** States a task can be started from by hand. */
const STARTABLE_STATES = ['assigned', 'started', 'waiting_approval', 'done'];
const HELD_BACK = ['started', 'waiting_approval', 'done'];
const conflict = (message) => Object.assign(new Error(message), { status: 409 });

/**
 * Starts one task now, on the user's explicit order. Never through `tick()`:
 * that gate answers to the header's auto-start and to the parallelism limit,
 * and a click that silently waited on either was the bug. The limit is still
 * reported, measured before starting, so the board can say it went over.
 *
 * A manual task runs once and stays manual (see `userRuns`); an unconfirmed
 * one is refused, because starting it would answer the question for you.
 */
export function startTask(issue) {
  const task = store.get(issue);
  if (!task) throw Object.assign(new Error(`Unknown task #${issue}`), { status: 404 });
  assertNoUpgradeRunning();
  // A scheduled upgrade waits for the board to go idle; starting work now
  // would keep pushing it back.
  if (upgradeHoldsNewWork()) {
    throw conflict('A board update is waiting for the board to be idle: no new work starts until it finishes');
  }
  // Before anything changes: a pipeline started now would fail on the move's
  // 409 and overwrite the task's error with that.
  assertNotMoving(task);
  const reassigned = unassignedReason(task);
  if (reassigned) throw conflict(reassigned);
  if (running.has(keyOf(task)) || ACTIVE_STATES.includes(task.state)) throw conflict('The task is already working');
  if (modeOf(task) === 'unconfirmed') {
    throw conflict('The task is waiting for you to confirm its mode: choose automatic or manual before starting it');
  }
  if (!STARTABLE_STATES.includes(task.state)) {
    throw conflict(`A task in «${task.state}» cannot be started from here`);
  }
  const oneShot = !canAutoStart(task);

  // Before the first log line or state change: each one broadcasts the card,
  // and the very first broadcast should already say `userRun`. Out of quota
  // too: the parked click keeps the fact that you ordered it through
  // `wasUserRun`, which is read from this set.
  if (oneShot) userRuns.add(keyOf(task));
  const markForced = () => {
    // The guard found work already there; this click is the say-so to go on.
    task.forced = true;
    store.setState(task, 'assigned');
    store.addLog(task, 'guard', 'start forced by the user despite the prior work detected');
  };
  let forcedNow = false;
  if (HELD_BACK.includes(task.state)) {
    // Work whose last PR is merged or closed is not work to adopt: this click
    // opens a new cycle on the same branch (#787, whose PR merged without
    // closing the issue). Decided before the quota can park the click, so the
    // run that starts when the window reopens is already the new cycle. Any
    // other held-back task keeps its state if the quota parks it: a 🚀 on a
    // PR waiting for approval must still rest on «waiting_approval».
    const prs = task.prs ?? [];
    const last = prs.find(isFinishedPr);
    if (last && !prs.some(isOpenPr)) {
      beginNewCycle(task, `🚀 by hand on a task whose last PR (#${last.number}) is ${last.state === 'MERGED' ? 'merged' : 'closed'}`);
      markForced();
      forcedNow = true;
    }
  }

  // Out of quota: the click is not refused, it is kept. The run you ordered
  // starts by itself when the window reopens — including the fact that you
  // ordered it, which is what `wasUserRun` carries for a manual task.
  if (quotaHoldsNewWork(task)) {
    store.addLog(task, 'inicio', `started by hand, but the account has no quota: it will start on its own ${describeResume(quotaHold())}`);
    return { ...parkClickForQuota(task, 'assigned'), mode: modeOf(task), oneShot };
  }

  if (HELD_BACK.includes(task.state) && !forcedNow) markForced();

  const active = activeCount();
  const limit = settings.maxActiveTasks;
  const overLimit = active >= limit;
  store.addLog(task, 'inicio', [
    'started by hand',
    oneShot ? 'manual task: a single pass, and it stays manual' : null,
    overLimit ? `over the limit (${active} active of ${limit})` : null,
  ].filter(Boolean).join('; '));
  if (overLimit) {
    // Going over the limit starts the run, not every phase of it: the e2e
    // gates are sized to the same limit, so the tests may still queue.
    store.addLog(task, 'inicio', `it may still wait its turn in the e2e test queue, which admits ${limit} at a time per machine`);
  }
  startPipeline(task);
  return { started: true, mode: modeOf(task), oneShot, active, limit, overLimit };
}

/**
 * The old «Iniciar workflow» click, kept for its callers. It now goes through
 * `startTask`, so it works with auto-start off and no longer flips a manual
 * task to automatic.
 */
export function forceStart(issue) {
  return startTask(issue).started;
}

/**
 * Where a task will run. Only while nothing is there yet: once a worktree
 * exists on a machine, that is where the task lives, and moving it would mean
 * moving a checkout, a build and a Claude transcript — which is the move's job.
 */
export async function setTaskMachine(issue, name) {
  assertNoUpgradeRunning();
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  if (task.moving) {
    throw Object.assign(new Error('The task has a move in progress or failed: finish or discard it first'), { status: 409 });
  }
  // Conversations left on a machine are resumed by the move, which checks
  // their transcripts; relabelling the task would resume them where they are not.
  const withSessions = Object.entries(task.places ?? {})
    .filter(([, place]) => Object.keys(place?.sessions ?? {}).length)
    .map(([machine]) => machine);
  if (withSessions.length) {
    throw Object.assign(new Error(`The task has conversations on ${withSessions.join(', ')}: create the worktree and use «Move to…» so they travel with it`), { status: 409 });
  }
  if (!machines()[name]) throw new Error(`There is no machine "${name}" in config.machines`);
  if (task.worktreePath || running.has(keyOf(task)) || ACTIVE_STATES.includes(task.state) || isChatBusy(task)) {
    throw new Error('The task already has a worktree or is working: the machine is chosen before it starts');
  }
  // Not `machines()[name]`: the machine has to be the one THIS task's project
  // has on that box. A non-default project on a runner is refused here rather
  // than later by a worktree cut from a path nothing declares.
  //
  // Load bearing: the `if (!machines()[name])` above. `machineViewFor` reads a
  // missing name as `'local'` — right for an old task with no machine, wrong
  // for an empty argument to THIS door, which is choosing a machine by name.
  // That check is what keeps the empty name from arriving here as local.
  const { machine, error } = machineViewFor(task, name);
  if (!machine) throw Object.assign(new Error(error), { status: 409 });
  await assertMachineReady(machine);
  task.machine = name;
  store.addLog(task, 'máquina', `this task will run on ${name}`);
  store.touch(task);
  return name;
}

/**
 * A remote machine has to be there and speak this SDK's CLI version before a
 * single command goes its way. Checked when the machine is chosen and again
 * before a worktree is created there: the box can be updated in between.
 */
export async function assertMachineReady(machine) {
  if (machine.kind === 'local') return;
  let info;
  try {
    info = await machine.info();
  } catch (e) {
    throw new Error(`${machine.name} is not responding (${e.message}); is the runner up and the machine on the tailnet?`);
  }
  const wanted = expectedClaudeVersion();
  if (!info.claude) throw new Error(`${machine.name} has no \`claude\` on the runner PATH`);
  // At or above: a runner whose CLI was upgraded ahead of a laptop that then
  // rolled back must not strand every remote task.
  if (wanted && !versionAtLeast(info.claude, wanted)) {
    throw new Error(`${machine.name} has claude ${info.claude} and the board expects ${wanted}: update whichever is behind`);
  }
}

/** What the header shows: each machine, reachable or not, and its CLI. */
export async function machineStatus() {
  const wanted = expectedClaudeVersion();
  // The SDK is where the model aliases get resolved; a board that never
  // updates it is the one way left to fall behind on models.
  const [sdk, sdkLatest] = [sdkVersion(), await latestSdkVersion()];
  return Promise.all(Object.values(machines()).map(async (m) => {
    try {
      const info = await m.info();
      return {
        name: m.name, kind: m.kind, host: m.host, online: true,
        // At or above on every machine: the PATH `claude` on the laptop is the
        // interactive one and may run ahead, and a runner may be upgraded
        // before the laptop is.
        claude: info.claude, expected: wanted, ok: !wanted || versionAtLeast(info.claude, wanted),
        ...(m.kind === 'local' ? { sdk, sdkLatest, sdkBehind: isNewerVersion(sdkLatest, sdk) } : {}),
      };
    } catch (e) {
      return { name: m.name, kind: m.kind, host: m.host, online: false, error: e.message, expected: wanted, ok: false };
    }
  }));
}

/**
 * Guarantees the task has a usable worktree, creating one on demand — adopting
 * the branch the issue already has, or cutting a fresh one from the project's base branch (`origin/<base>`).
 * The chat needs this: a task started elsewhere (or whose worktree was deleted
 * to reclaim disk) has nowhere to run a session until this rebuilds it.
 */
export async function ensureWorktree(issue) {
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  assertNotMoving(task);
  if (await isProjectWorktree(machineOf(task), task.worktreePath)) return task.worktreePath;
  await assertMachineReady(machineOf(task));
  if (task.worktreePath) {
    store.addLog(task, 'worktree', `${task.worktreePath} is no longer a worktree of this project; it is recreated`);
    task.worktreePath = null;
  }
  if (task.creatingWorktree) throw new Error('The worktree is already being created');

  task.creatingWorktree = true;
  const previousState = task.state;
  task.errorCode = null;
  task.errorInfo = null;
  store.setState(task, 'worktree');
  try {
    let branch = task.branch;
    let adopt = Boolean(branch);
    if (!branch) {
      const existing = await detectExistingWork(task.issue, { project: task.project });
      if (existing.branches.length) {
        branch = existing.branches[0].replace(/^origin\//, '');
        adopt = true;
        store.addLog(task, 'worktree', `using the ticket's existing branch: ${branch}`);
      } else {
        branch = deriveBranchName(await getIssue(task.issue, task.project));
        store.addLog(task, 'worktree', `no previous branch; ${branch} will be created from origin/${baseOf(task)}`);
      }
    }
    task.branch = branch;
    task.worktreePath = await createWorktree(machineOf(task), branch, {
      adopt,
      base: baseOf(task),
      onLine: (l) => store.addLog(task, 'worktree', l),
    });
    store.addLog(task, 'worktree', `worktree listo en ${task.worktreePath}`);
    // A worktree deleted and made again on the same machine: its chats'
    // conversations are still in `~/.claude/projects`, keyed by this same
    // path, and `places` remembers which ones they were.
    const here = machineOf(task).name;
    if (!task.places || typeof task.places !== 'object') task.places = {};
    task.places[here] = {
      ...(task.places[here] ?? { sessions: {} }),
      worktreePath: task.worktreePath,
      at: new Date().toISOString(),
    };
    try {
      const restored = await restoreSessions(task, here, { onlyMissing: true });
      if (restored.size) store.addLog(task, 'worktree', `${restored.size} chat(s) resume the conversation they had here`);
    } catch (e) {
      store.addLog(task, 'worktree', `⚠️ could not recover the earlier conversations: ${e.message}`);
    }
    return task.worktreePath;
  } catch (e) {
    // An empty repository, a missing base or remote: the card explains it and
    // (for an empty one) offers the fix, so it needs the code, not git's text.
    if (e instanceof RepoStateError) {
      task.errorCode = e.code;
      task.errorInfo = e.info ?? null;
    }
    throw e;
  } finally {
    task.creatingWorktree = false;
    // Creating a worktree is a side errand: the card goes back exactly where it
    // was. Leaving a queued task parked in `worktree` — as this did for
    // `assigned` — stranded it for good: that state counts as active, so it ate
    // a slot, while `tick()` only ever starts tasks sitting in `assigned`.
    store.setState(task, previousState);
  }
}

/** A refusal of `bootstrapRepo`, with the HTTP status the route answers. */
function bootstrapError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/** Credentials in a remote URL must not reach a response body or a log. */
const redactUrls = (s) => String(s ?? '').replace(/:\/\/[^@/\s]+@/g, '://***@');

/** One bootstrap at a time per project: `{ key, promise }` of the one in flight. */
const bootstrapping = new Map();
/** One base-branch change at a time per project: the tail promise of the chain. */
const baseChanging = new Map();

/**
 * Creates the initial commit of an empty repository on the project's base
 * branch, pushes it, and retries THIS task — the only write the board makes to
 * a person's GitHub on its own account, so it needs `confirm: true` (the card's
 * dialog) and is never done silently. Goes through the machine layer, not an
 * agent session: ghgate does not apply.
 *
 * Throws errors with `status`/`code`: 400 `confirm_required`, 409
 * `runner_not_supported` | `no_longer_empty` | `index_not_clean`, 502 `git_failed`.
 * A failed push rolls the local commit back, so nothing is left changed.
 *
 * @returns {Promise<{ok: true, base: string, retried: boolean}>}
 */
export async function bootstrapRepo(issue, { confirm } = {}) {
  const task = store.get(issue);
  if (!task) throw bootstrapError(404, 'not_found', `Unknown task #${issue}`);
  if (confirm !== true) {
    throw bootstrapError(400, 'confirm_required', 'Confirmation missing: this writes to GitHub and is not done without it');
  }
  // Before `machineOf`: a project that is not on that runner makes it throw.
  if ((task.machine ?? 'local') !== 'local') {
    throw bootstrapError(409, 'runner_not_supported', 'The initial commit can only be created on the local machine: move the task here or do it by hand');
  }
  // `base` is read just below, before this call's own guard exists: a base
  // change in flight could be swapped under it, so it is refused instead.
  if (baseChanging.has(task.project)) {
    throw bootstrapError(409, 'base_change_in_progress', 'The project base branch is being changed: wait for it to finish and try again');
  }
  const machine = machineOf(task);
  const base = baseOf(task);
  if (!isSafeBranchName(base)) throw bootstrapError(400, 'bad_base', `Invalid base branch name: ${JSON.stringify(base)}`);
  // The refusals `retry` would make, asked before any write: a 409 must never
  // come AFTER the push.
  assertNoUpgradeRunning();
  assertNotMoving(task);

  // A double click is the same click: join it. Another task of the project
  // waits its turn, and finds the repository no longer empty.
  const key = keyOf(task);
  const inflight = bootstrapping.get(task.project);
  if (inflight?.key === key) return inflight.promise;
  const run = () => bootstrapOnce(task, machine, base);
  const promise = (inflight ? inflight.promise.catch(() => {}) : Promise.resolve()).then(run);
  const entry = { key, promise };
  bootstrapping.set(task.project, entry);
  try {
    return await promise;
  } finally {
    if (bootstrapping.get(task.project) === entry) bootstrapping.delete(task.project);
  }
}

async function bootstrapOnce(task, machine, base) {
  const repo = machine.repoPath;
  const git = (args, opts = {}) => machine.exec('git', args, { cwd: repo, ...opts });
  const failure = (what, r) => bootstrapError(502, 'git_failed',
    `${what}: ${redactUrls(r.stderr.trim().split('\n').pop() || r.stdout.trim() || `git exited with ${r.code}`)}`);
  const noPrompt = { timeoutMs: 3 * 60 * 1000, env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } };

  // The re-check, inside the guard: it is the authority, not the card's text.
  const state = await classifyRepoState(machine, base);
  if (state?.code !== 'empty_repo') {
    throw bootstrapError(409, 'no_longer_empty', state ? state.message : 'The repository is no longer empty: the initial commit is not needed');
  }
  // The remote as it is now, not as of the last fetch.
  const heads = await git(['ls-remote', '--heads', 'origin'], { timeoutMs: 15_000, env: noPrompt.env });
  if (!heads.ok) throw failure('Could not query origin', heads);
  if (heads.stdout.trim()) throw bootstrapError(409, 'no_longer_empty', 'The origin remote already has branches: the initial commit is not needed');

  // An empty commit would commit whatever is staged.
  const tracked = await git(['ls-files']);
  if (!tracked.ok) throw failure('Could not read the index', tracked);
  if (tracked.stdout.trim()) {
    throw bootstrapError(409, 'index_not_clean', 'The repository index has staged files: the initial commit would include them. Make the initial commit by hand.');
  }
  // Committed and pushed as the project's GitHub account, or not at all
  // (`gh-account.js`). Only a local checkout can be asked.
  if (machine.kind === 'local') {
    const problems = await identityProblems(repo);
    if (problems.length) {
      throw bootstrapError(409, 'identity_mismatch', `The initial commit would not go out as the project's GitHub account: ${problems.join('; ')}`);
    }
  }

  const ref = `refs/heads/${base}`;
  // A branch of that name already there is somebody's work: never ours to roll back.
  if ((await git(['rev-parse', '--verify', '-q', ref])).ok) {
    throw bootstrapError(409, 'no_longer_empty', `The local branch ${base} already exists: the initial commit is not needed`);
  }
  const head = await git(['symbolic-ref', '-q', 'HEAD']);
  const before = head.ok ? head.stdout.trim() : null;
  const moved = before !== ref;
  if (moved) {
    const sym = await git(['symbolic-ref', 'HEAD', ref]);
    if (!sym.ok) throw failure(`Could not point HEAD at ${base}`, sym);
  }
  let sha = null;
  const rollback = async () => {
    // Only deletes the ref while it still points at OUR commit.
    if (sha) await git(['update-ref', '-d', ref, sha]);
    if (moved && before) await git(['symbolic-ref', 'HEAD', before]);
  };

  const commit = await git([
    'commit', '--allow-empty',
    '-m', 'Initial commit',
    '-m', 'Created by hfs-monitor so the repository has a base branch for worktrees and pull requests.',
  ], { timeoutMs: 2 * 60 * 1000, env: noPrompt.env });
  if (!commit.ok) {
    if (moved && before) await git(['symbolic-ref', 'HEAD', before]);
    throw failure('Could not create the initial commit', commit);
  }

  const rev = await git(['rev-parse', 'HEAD']);
  sha = rev.ok ? rev.stdout.trim() : null;
  // An explicit refspec: a bare name that starts with `+` would force-push.
  const push = await git(['push', '-u', 'origin', `${ref}:${ref}`], noPrompt);
  if (!push.ok) {
    await rollback();
    throw failure(`Could not push the initial commit to origin (${base})`, push);
  }

  store.addLog(task, 'worktree', `initial commit created on ${base} and pushed to origin (empty repository)`);
  task.errorCode = null;
  task.errorInfo = null;
  // The push is done and cannot be undone: a refusal of the retry is reported, not thrown.
  let retried = false;
  try {
    retried = retry(keyOf(task));
  } catch (e) {
    store.addLog(task, 'worktree', `initial commit pushed, but it could not be retried: ${e.message}`);
    return { ok: true, base, retried: false, retryError: e.message };
  }
  // What retry keeps for the fix session is this very message: not a hint for it.
  if (retried) task.lastError = null;
  return { ok: true, base, retried };
}

/** The error codes of a failed worktree that a different base branch can cure. */
const BASE_FIXABLE = ['empty_repo', 'base_missing'];

/**
 * Changes a project's base branch from the board, live, and retries the one
 * task whose worktree failed because of the old one (`empty_repo` /
 * `base_missing`). Only NEW worktrees and the PR base follow the new branch:
 * the registry is read at use (`baseOf`), nothing stores the base on a task,
 * and the worktrees that already exist keep what they branched from.
 *
 * The remote decides, not the card: `errorInfo.remoteHeads` may be stale (the
 * last fetch), so a local checkout asks `git ls-remote` now. A remote with
 * branches but not this one is refused (409 `base_not_on_remote`); an EMPTY
 * remote accepts the name, because the bootstrap will create it. A runner task
 * skips the check (no checkout here to ask).
 *
 * Throws errors with `status`/`code`: 400 `bad_base` | `bad_issue`, 404
 * `unknown_project` | `not_found`, 409 `bootstrap_in_progress` |
 * `base_not_on_remote` (with `remoteHeads`), 502 `remote_unreachable`; plus the
 * upgrade's own 409. A refusal changes nothing.
 *
 * @returns {Promise<{ok: true, project: {id: string, baseBranch: string}, retried: boolean, note: string}>}
 */
export async function changeBaseBranch(project, base, issue) {
  if (!projectOf(project)) throw bootstrapError(404, 'unknown_project', `Proyecto desconocido: ${project}`);
  if (typeof base !== 'string' || !isSafeBranchName(base)) {
    throw bootstrapError(400, 'bad_base', `Invalid base branch name: ${JSON.stringify(base ?? null)}`);
  }
  // Before the guard and before any ls-remote: a refusal here changes nothing.
  assertNoUpgradeRunning();
  // `store.get(12)` means the DEFAULT project: the key names the project.
  let task = null;
  if (issue !== undefined && issue !== null) {
    let key;
    try {
      key = makeKey(project, issue);
    } catch (e) {
      throw bootstrapError(400, 'bad_issue', e.message);
    }
    task = store.get(key);
    if (!task || task.project !== project) throw bootstrapError(404, 'not_found', `Unknown task #${issue} in ${project}`);
  }
  // `bootstrapRepo` reads the base before its own guard; the two must not overlap.
  if (bootstrapping.has(project)) {
    throw bootstrapError(409, 'bootstrap_in_progress', 'This project\'s initial commit is being created: wait for it to finish');
  }

  // Two quick changes queue instead of interleaving. Set synchronously, before
  // any await, so `bootstrapRepo` sees it from the very next tick.
  const prev = baseChanging.get(project);
  const promise = (prev ?? Promise.resolve()).catch(() => {}).then(() => changeBaseOnce(project, base, task));
  baseChanging.set(project, promise);
  try {
    return await promise;
  } finally {
    if (baseChanging.get(project) === promise) baseChanging.delete(project);
  }
}

async function changeBaseOnce(project, base, task) {
  assertNoUpgradeRunning();
  // `machineFor` throws for a non-default project on a runner: skip only when the
  // task itself is not local. No task: the project's own checkout.
  if (!task || (task.machine ?? 'local') === 'local') {
    const machine = task ? machineOf(task) : machineFor('local', project);
    const r = await machine.exec('git', ['ls-remote', '--heads', 'origin'], {
      cwd: machine.repoPath,
      timeoutMs: 15_000,
      env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    if (!r.ok) {
      const why = redactUrls(r.stderr.trim() || r.stdout.trim() || `git exited with ${r.code}`).slice(0, 500);
      throw bootstrapError(502, 'remote_unreachable', `Could not query origin: ${why}`);
    }
    const remoteHeads = r.stdout.split('\n')
      .map((l) => /\trefs\/heads\/(.+?)\s*$/.exec(l)?.[1])
      .filter(Boolean);
    // No heads at all is an empty repository: the bootstrap creates the branch.
    if (remoteHeads.length && !remoteHeads.includes(base)) {
      throw Object.assign(
        bootstrapError(409, 'base_not_on_remote', `Branch «${base}» does not exist on origin.`),
        { remoteHeads },
      );
    }
  }

  // Before the write: the first `saveProjects` of a board with no file freezes the seed.
  const seeded = !existsSync(path.join(DATA_DIR, 'projects.json'));
  let saved;
  try {
    saved = setBaseBranch(project, base);
  } catch (e) {
    throw bootstrapError(400, 'bad_base', e.message);
  }

  let retried = false;
  let retryError = null;
  if (task && task.state === 'error' && BASE_FIXABLE.includes(task.errorCode)) {
    try {
      // `retry` -> `startPipeline` clears `errorCode`/`errorInfo` itself.
      retried = retry(keyOf(task));
    } catch (e) {
      retryError = e.message;
      store.addLog(task, 'worktree', `base branch changed to ${base}, but it could not be retried: ${e.message}`);
    }
    // What retry keeps for the fix session is this very message: not a hint for it.
    if (retried) task.lastError = null;
    else {
      // The card and the bootstrap button show the live base, not the old one.
      task.errorInfo = { ...(task.errorInfo ?? {}), base };
      store.touch(task);
    }
  }

  let note = 'New tasks will create their worktree from the new base and tasks in progress will merge and open their PR against it; existing worktrees keep their branch.';
  if (seeded) note += ' This machine had no project registry: it is now saved in server/data/projects.json.';
  return {
    ok: true,
    project: { id: saved.id, baseBranch: saved.baseBranch },
    retried,
    ...(retryError ? { retryError } : {}),
    note,
  };
}

/**
 * Take what the branch holds as the fix, and carry on from the tests.
 *
 * The pipeline refuses on purpose to read "the branch has commits" as "the
 * fix landed": work done by hand in the chat has commits too, and treating it
 * as finished is how half-done work once reached a PR. So the decision is
 * yours, and this is where you make it — for the session that did the work
 * but ended without committing, and you committed from the chat.
 */
export async function acceptFix(issue) {
  assertNoUpgradeRunning();
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  assertNotMoving(task);
  const reassigned = unassignedReason(task);
  if (reassigned) throw conflict(reassigned);
  if (running.has(keyOf(task)) || ACTIVE_STATES.includes(task.state)) throw new Error('The task is working');
  if (isChatBusy(task)) throw new Error('A chat turn is in progress; wait for it to finish');
  const machine = machineOf(task);
  if (!task.branch || !(await isProjectWorktree(machine, task.worktreePath))) {
    throw new Error('The task has no worktree');
  }
  if (!(await hasCommits(machine, task.worktreePath, { base: baseOf(task) }))) {
    throw new Error(`Branch ${task.branch} has no commit on top of origin/${baseOf(task)}: there is no fix to mark as done`);
  }
  const head = await headCommit(machine, task.worktreePath);
  task.fixedAt = head;
  // The fix is taken as done: changes asked on its plan are moot, and a later
  // repair round would otherwise replan with them.
  task.planFeedback = null;
  task.planRejectedText = null;
  task.error = null;
  // Note the order: this runs *before* the quota check below, so a manual task
  // accepted under a hold comes back automatic and with `wasUserRun: false` —
  // the same thing this click does with no hold on, which is the point.
  if (!canAutoStart(task)) setMode(issue, 'auto');
  store.addLog(task, 'fix', `taking the fix as done at ${head.slice(0, 8)}; continuing from the tests`);
  // Out of quota the decision still lands — `fixedAt` is written above — and
  // the tests run by themselves when the window reopens.
  if (quotaHoldsNewWork(task)) {
    parkTaskForQuota(task, 'testing');
    return head;
  }
  startPipeline(task, 'testing');
  return head;
}

/**
 * Publishes the PR with the title you wrote on the card, and carries on from
 * there.
 *
 * The counterpart of `parkPr`: the run that failed had already paid for the
 * fix, the tests and the Browser QA on this commit, so this resumes at the PR
 * and no earlier — no main brought in, nothing re-run.
 */
export async function publishPr(issue, title) {
  assertNoUpgradeRunning();
  // Same reason as `startTask`: a scheduled upgrade is waiting for the board to
  // go idle, and this starts a run.
  if (upgradeHoldsNewWork()) {
    throw conflict('A board update is waiting for the board to be idle: no new work starts until it finishes');
  }
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  assertNotMoving(task);
  const reassigned = unassignedReason(task);
  if (reassigned) throw conflict(reassigned);
  if (running.has(keyOf(task)) || ACTIVE_STATES.includes(task.state)) throw new Error('The task is working');
  if (isChatBusy(task)) throw new Error('A chat turn is in progress; wait for it to finish');
  if (task.prNumber) throw new Error(`The task already has PR #${task.prNumber}`);
  // This resumes a run at the PR, which assumes everything before it is done.
  // On a task with nothing parked it would create a worktree, run the triage
  // and claim in the log that a fix and a test run it never saw are already
  // paid for. Only a parked proposal on a branch may be published.
  if (!task.prPark || !task.branch) {
    throw Object.assign(new Error('This task has no parked PR to publish'), { status: 409 });
  }

  const text = String(title ?? '').trim();
  const problems = publishProblems(text, { maxChars: PR_TITLE_MAX });
  if (problems.length) {
    throw Object.assign(new Error(`The PR title is not published: ${problems.join('; ')}`), { status: 400, problems });
  }

  task.prTitle = text;
  task.error = null;
  // A manual task publishes on your say-so and stays manual: this one run is
  // yours, exactly as «Iniciar» gives it.
  if (!canAutoStart(task)) userRuns.add(keyOf(task));
  store.addLog(task, 'pr', `you publish the PR with the title: ${text}`);
  // The title is kept whatever happens; out of quota, so is the run, which
  // starts by itself at the PR — nothing before it is paid for twice.
  if (quotaHoldsNewWork(task)) {
    parkTaskForQuota(task, 'pr');
    return { title: text, parked: true };
  }
  startPipeline(task, 'pr');
  return { title: text };
}

export function retry(issue) {
  assertNoUpgradeRunning();
  const task = store.get(issue);
  if (!task || task.state !== 'error' || running.has(keyOf(task))) return false;
  if (task.unassigned) return false;
  // Before `lastError`/`error` move: the pipeline would only fail on the move's 409.
  assertNotMoving(task);
  // Same reasoning as forceStart: the click means "run it", so it decides the
  // mode instead of clearing the error and stalling.
  if (!canAutoStart(task)) setMode(issue, 'auto');
  // Kept for the fix session: what stopped the last attempt is part of what
  // it has to review.
  task.lastError = task.error;
  task.error = null;
  // The phase the run was in when it failed, which is the only thing that knows
  // about the steps with no state of their own. `prevState` is the fallback for
  // tasks that failed before this field existed; `assigned` for the rest.
  const resumeFrom = normalizePhase(task.phase) ?? normalizePhase(task.prevState) ?? 'assigned';
  // Out of quota: the retry is kept, not refused. It runs by itself at the
  // hour the window reopens, from this very phase.
  if (quotaHoldsNewWork(task)) {
    store.addLog(task, 'retry', `retry accepted from ${PHASE_LABEL[resumeFrom]} ("${resumeFrom}"), but the account has no quota`);
    parkTaskForQuota(task, resumeFrom, { previousError: task.lastError });
    return true;
  }
  store.addLog(task, 'retry', `retrying from ${PHASE_LABEL[resumeFrom]} ("${resumeFrom}")`);
  startPipeline(task, resumeFrom);
  return true;
}

/**
 * Why a parked task cannot be relaunched this second, or null.
 *
 * These are the guards `tick()` does not do. A resumption fired by a timer has
 * to repeat them: `gitBusyReason` covers a run in flight, a chat mid-turn,
 * demo steps being written and a stack compiling — and the chat one is the one
 * that matters, because nothing else looks at it.
 */
function quotaResumeBlocker(task) {
  const reassigned = unassignedReason(task);
  if (reassigned) return reassigned;
  if (running.has(keyOf(task))) return 'a run is already in progress';
  const moving = movingReason(task);
  if (moving) return moving;
  const busy = gitBusyReason(task);
  if (busy) return busy;
  if (upgradeHoldsNewWork()) return 'a board update is waiting';
  return null;
}

/**
 * The relaunch, when the window is open again.
 *
 * Deliberately **not** `retry()`: that one demands `state === 'error'` — which
 * a parked task is not, and must not be — and calls `setMode(issue, 'auto')`,
 * which would quietly turn a manual task automatic. The opposite of what
 * `userRuns` protects.
 *
 * One at a time under `maxActiveTasks`, and only what this hold parked: a task
 * that was already in `error` before the wall has no `quotaPark` and is not on
 * the list, so it is never touched. Whatever cannot go yet keeps its marker
 * and is tried again on the next tick of the clock.
 */
/**
 * The last thing each parked task was told, so a wait of hours does not become
 * one log line — and one full rewrite of `tasks.json` — per task per 30 s.
 * Only a *change* of reason is worth saying out loud.
 */
const quotaSaid = new Map();   // task key -> the last reason logged
function sayOnce(task, reason) {
  const key = keyOf(task);
  if (quotaSaid.get(key) === reason) return;
  quotaSaid.set(key, reason);
  store.addLog(task, 'cuota', reason);
}

/** The tasks a hold still speaks for, with anything stale pruned off the list. */
function parkedTasks(hold) {
  if (!hold) return [];
  const has = (issue) => store.get(issue)?.quotaPark?.holdId === hold.id;
  // A task deleted from the board while it waited would otherwise keep the
  // hold alive for ever, with the clock resuming nobody every 30 s.
  pruneParked(hold, has);
  return parkedIssues(hold).filter(has).map((issue) => store.get(issue));
}

export async function resumeAfterQuota(hold, { limit = Infinity } = {}) {
  if (!hold) return 0;
  let started = 0;
  for (const task of parkedTasks(hold)) {
    if (started >= limit) break;
    if (activeCount() >= settings.maxActiveTasks) {
      sayOnce(task, `the account is back, but the board is at its limit (${settings.maxActiveTasks}): waiting for a turn`);
      break;
    }
    const blocked = quotaResumeBlocker(task);
    if (blocked) {
      sayOnce(task, `the account is back, but it does not resume yet: ${blocked}`);
      continue;
    }
    const park = task.quotaPark;
    const resumeFrom = normalizePhase(park?.resumeFrom) ?? 'assigned';
    // Before `startPipeline`, and before the marker goes: a manual task you
    // had started by hand gets that run back, or the very first phase boundary
    // would park it again for being manual.
    if (park?.wasUserRun) userRuns.add(keyOf(task));
    // A finite `limit` is the canary: the one task that tests the window.
    if (Number.isFinite(limit)) markQuotaCanary(task);
    clearQuotaPark(task);
    quotaSaid.delete(keyOf(task));
    task.error = null;
    store.addLog(task, 'cuota', `the account is back: the task resumes on its own from ${PHASE_LABEL[resumeFrom] ?? resumeFrom}`);
    startPipeline(task, resumeFrom);
    started += 1;
  }
  return started;
}

// `quota.js` cannot import this file — `claude.js` imports it, and the circle
// would close — so the pipeline registers itself, exactly as `pipelineHooks`
// and `fixHooks` already do.
quotaHooks.resume = (hold, options) => resumeAfterQuota(hold, options);
// And the one question the hold's clock has to ask about the store: is this
// issue still a task waiting on me? Without it the list — and the count the
// chip draws — keeps naming tasks that were deleted hours ago.
quotaHooks.stillParked = (issue) => Boolean(store.get(issue)?.quotaPark);

// ---------------------------------------------------------------------------
// Bringing origin/<base> into a task's branch.

export const gitMutex = new Mutex();   // one git write at a time per worktree

/**
 * Why the board must not touch this worktree with git right now, or null.
 *
 * The list is the one `deleteWorktree` already uses (`:732`) plus the things
 * that also hold files open. `chatBusy` is the one that matters most and the
 * one the card's own `busy` misses: a chat turn is precisely when Claude is
 * editing, and swapping files under it is how you get a session reasoning about
 * a file that no longer says what it read.
 */
export function gitBusyReason(task) {
  if (ACTIVE_STATES.includes(task.state) || running.has(keyOf(task))) return 'the task is working';
  if (isChatBusy(task)) return 'a chat turn is in progress';
  if (task.demoBusy) return 'the demo steps are being generated';
  if (crDrafting.size && (task.changeRequests ?? []).some((c) => crDrafting.has(c.reviewId))) {
    return 'review replies are being drafted';
  }
  // Misma razón que la línea de arriba, para la otra fase que redacta: la
  // propuesta de cierre corre DENTRO del worktree, que es lo que le deja citar
  // rutas. Sin esto, un «⬇ Pull», una mudanza o un «🗑️ Worktree» pueden
  // quitárselo de debajo a media frase.
  if (task.closing?.status === 'drafting') return 'the closing proposal is being drafted';
  if (task.stack?.status === 'starting') return 'the stack is being built in this worktree';
  return null;
}

/**
 * Brings origin/<base> into the task's branch, or explains why it did not.
 *
 * Returns `{ merged, behind, conflicts, blocked }` and never throws for the
 * ordinary refusals — a conflict is not a failure of the board, it is work that
 * needs you. The caller decides whether that stops it.
 */
export async function bringMain(task, { reason = 'on request' } = {}) {
  // Thrown, not returned as `blocked`: with `force` a review would go on
  // pushing from a worktree the move is about to leave.
  assertNotMoving(task);
  if (!task.branch || !(await isProjectWorktree(machineOf(task), task.worktreePath))) {
    return { merged: false, behind: null, conflicts: [], blocked: 'this task has no valid worktree' };
  }
  const busy = gitBusyReason(task);
  if (busy) return { merged: false, behind: null, conflicts: [], blocked: busy };

  return gitMutex.runExclusive(task.worktreePath, async () => {
    if (await mergeInProgress(machineOf(task), task.worktreePath)) {
      return { merged: false, behind: null, conflicts: [], blocked: 'hay un merge a medias en el worktree' };
    }
    // Everything from here on talks about this exact commit: the poll refreshes
    // origin/<base> on its own cadence and could move it under us.
    const mainSha = await resolveRef(machineOf(task), task.worktreePath, `origin/${baseOf(task)}`);
    if (!mainSha) return { merged: false, behind: null, conflicts: [], blocked: `could not read origin/${baseOf(task)}` };

    const verdict = await analyzeMerge(machineOf(task), task.worktreePath, mainSha);
    if (verdict.behind === 0) return { merged: false, behind: 0, conflicts: [], blocked: null };

    if (!verdict.clean) {
      const list = verdict.conflicts.slice(0, 5).join(', ');
      store.addLog(task, 'merge', `⚠️ origin/${baseOf(task)} cannot be merged cleanly (${verdict.behind} commit(s) behind): conflicts in ${verdict.conflicts.length} file(s): ${list}`);
      store.addChat(task, null, 'assistant', `⚠️ **origin/${baseOf(task)} cannot be merged cleanly.** The branch is ${verdict.behind} commit(s) behind and conflicts in:\n\n${verdict.conflicts.map((f) => `- \`${f}\``).join('\n')}\n\nAsk me here and I will resolve it with you, or do it by hand in the worktree.`);
      store.touch(task);
      return { merged: false, behind: verdict.behind, conflicts: verdict.conflicts, blocked: null };
    }

    const blockers = await mergeBlockers(machineOf(task), task.worktreePath, mainSha);
    if (blockers.blocked) {
      const what = [
        ...blockers.overlapping.map((f) => `${f} (modified, uncommitted)`),
        ...blockers.staged.map((f) => `${f} (staged)`),
        ...blockers.inTheWay.map((f) => `${f} (in the way of what main creates)`),
      ];
      store.addLog(task, 'merge', `⚠️ main cannot be merged: ${what.slice(0, 3).join('; ')}`);
      return {
        merged: false, behind: verdict.behind, conflicts: [],
        blocked: `there is uncommitted work the merge would overwrite: ${what.slice(0, 3).join('; ')}`,
      };
    }

    const headBefore = await headCommit(machineOf(task), task.worktreePath);
    const { head } = await mergeMain(machineOf(task), task.worktreePath, {
      mainSha, branch: task.branch, base: baseOf(task), onLine: (l) => store.addLog(task, 'merge', l),
    });
    // The fix is still done — carry its marker to the new HEAD, or the next run
    // would redo it just because main was integrated. The e2e marker is left
    // behind on purpose: those tests ran on code that had not met main yet.
    if (task.fixedAt && task.fixedAt === headBefore) task.fixedAt = head;
    task.e2ePassedAt = null;
    store.addLog(task, 'merge', `origin/${baseOf(task)} merged (${verdict.behind} commit(s), ${reason}); the e2e tests are needed again`);
    store.touch(task);
    return { merged: true, behind: verdict.behind, conflicts: [], blocked: null };
  });
}

/** The merge button, and the push button. */
export async function bringMainNow(issue) {
  assertNoUpgradeRunning();
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  const result = await bringMain(task, { reason: 'on your request' });
  // «Pull ·N» / «Push ·N» come from the poll; without this they keep the
  // numbers from before the merge until the next cycle, minutes later.
  await refreshBranchStatus(task).catch(() => {});
  if (result.blocked) throw new Error(result.blocked);
  if (result.conflicts.length) {
    const e = new Error(`origin/${baseOf(task)} does not merge cleanly: conflict in ${result.conflicts.length} file(s)`);
    e.code = 'MERGE_CONFLICT';
    e.conflicts = result.conflicts;
    throw e;
  }
  return result;
}

/**
 * Hands the conflict to the task's own session, as a real turn.
 *
 * Writing the conflict into the chat only paints the panel: the session is
 * resumed from the SDK's own history and never sees a message the board
 * inserted. Without this the promise of "it tells you in the chat" would end
 * with you retyping the file list yourself.
 */
export async function askMergeHelp(issue) {
  assertNoUpgradeRunning();
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  const conflicts = task.branchStatus?.conflicts ?? 0;
  if (!conflicts) throw new Error('This branch has no conflicts to resolve');
  if (!(await isProjectWorktree(machineOf(task), task.worktreePath))) {
    throw new Error('This task has no valid worktree');
  }

  const mainSha = await resolveRef(machineOf(task), task.worktreePath, `origin/${baseOf(task)}`);
  const verdict = await analyzeMerge(machineOf(task), task.worktreePath, mainSha);
  if (verdict.clean) {
    store.addLog(task, 'merge', `the conflict is gone: origin/${baseOf(task)} merges cleanly`);
    return { asked: false };
  }

  const files = verdict.conflicts.map((f) => `- \`${f}\``).join('\n');
  sendChat(keyOf(task), principalChat(task)?.id ?? null, [
    `Integra \`origin/${baseOf(task)}\` en esta rama (\`${task.branch}\`). Está ${verdict.behind} commit(s) por detrás y el merge no se resuelve solo: hay conflicto en ${verdict.conflicts.length} archivo(s).`,
    '',
    files,
    '',
    `Haz \`git merge origin/${baseOf(task)}\`, resuelve cada conflicto conservando lo que hace esta rama **y** lo que traiga la rama base —ninguna de las dos partes se descarta sin decirlo—, comprueba que compila y commitea el merge. Si algún conflicto no tiene una resolución evidente, para y explícame las dos versiones en vez de elegir por tu cuenta.`,
  ].join('\n'));
  store.addLog(task, 'merge', `the session was asked to resolve ${verdict.conflicts.length} conflict(s)`);
  return { asked: true, conflicts: verdict.conflicts };
}

export async function pushNow(issue) {
  assertNoUpgradeRunning();
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  assertNotMoving(task);
  if (!task.branch || !(await isProjectWorktree(machineOf(task), task.worktreePath))) {
    throw new Error('This task has no valid worktree');
  }
  const busy = gitBusyReason(task);
  if (busy) throw new Error(`Cannot push now: ${busy}`);
  const pushed = await gitMutex.runExclusive(task.worktreePath, async () => {
    await withInfraRetries(task, 'pr', 'the push', () => pushBranch(machineOf(task), task.worktreePath, task.branch, { onLine: (l) => store.addLog(task, 'pr', l) }));
    store.addLog(task, 'pr', `branch ${task.branch} pushed to origin`);
    store.touch(task);
    return { pushed: true };
  });
  // Outside the mutex: the count is read, not written. Without it the card
  // kept showing the commits it had just pushed until the next poll.
  await refreshBranchStatus(task).catch(() => {});
  return pushed;
}

/** Test seam for `refreshChecks`. */
export const refreshChecksDeps = { checksForOpenPrs: ({ project }) => checksForOpenPrs({ project }) };

const projectOfRow = (t) => t.project ?? DEFAULT_PROJECT_ID; // allowlisted: legacy row without project

/**
 * The CI state of every open PR, spread over the tasks that own them.
 *
 * Deliberately silent about finished work: a merged or closed PR, or a task in
 * `done`, gets no light at all. Its CI describes something that is over, and a
 * strip of completed cards glowing green forever teaches you to ignore the
 * colour everywhere else.
 *
 * `projects` (project ids) limits the sweep to those projects, and only the ones
 * with a task that can have a light; the others keep what they had.
 */
export async function refreshChecks({ projects } = {}) {
  // One sweep per project, not one for the board. `checksForOpenPrs` lists the
  // open PRs of ONE repository and keys them by number — and numbers are per
  // repository, so #12 of `app-b` and #12 of `hfs` are different pull
  // requests. A single map would light a card with a stranger's CI.
  const tasks = store.all();
  const byProject = new Map();
  const only = Array.isArray(projects) ? new Set(projects) : null;
  // With a project list, a project is only asked when a task there can have a
  // light: not unassigned, not done, with a PR.
  const wanted = (project) => !only || (only.has(project) && tasks.some((t) =>
    projectOfRow(t) === project && !t.unassigned && t.state !== 'done' && t.prNumber)); // allowlisted: legacy row without project
  for (const project of new Set(tasks.map(projectOfRow))) {
    if (!wanted(project)) continue;
    // A project whose repository cannot be resolved must not blank out the
    // others: it gets an empty answer and the remaining sweeps still run.
    byProject.set(project, await prefetchChecks(project));
  }
  for (const task of tasks) {
    // Not swept this time: leave its light as it was.
    if (only && !byProject.has(projectOfRow(task))) continue;
    applyChecksForTask(task, byProject);
  }
}

/**
 * One `checksForOpenPrs` call for a project: its open PRs by number, an empty
 * Map when it has none, or null when GitHub could not be asked (or the
 * repository cannot be resolved). null is "unknown", not "no CI": the
 * consumer keeps the lights it had.
 */
export async function prefetchChecks(projectId) {
  try {
    const byNumber = await refreshChecksDeps.checksForOpenPrs({ project: projectId });
    return byNumber instanceof Map ? byNumber : null;
  } catch {
    return null;
  }
}

/**
 * Sets one task's light from `byProject` (project id -> {@link prefetchChecks}
 * answer). A project missing from the map, or whose answer is null, leaves the
 * light as it was. Returns whether the task changed.
 */
export function applyChecksForTask(task, byProject) {
  {
    // Reassigned away: its card is on the way out, and its CI is not worth a read.
    if (task.unassigned) return false;
    const swept = byProject.get(projectOfRow(task));
    if (swept == null) return false;
    // The cycle's PR only. The newest PR on record used to stand in for a
    // missing one, and a merged PR from an earlier cycle is not what the card
    // is waiting on.
    const number = task.prNumber ?? null;
    const found = task.state === 'done' || !number
      ? null
      : swept.get(number) ?? null;
    // The rollup belongs to the last pushed commit; with work still local, a
    // green light would be talking about somebody else's code.
    const checks = found
      ? { ...found, stale: Boolean(task.branchStatus?.unpushed) }
      : null;
    const before = JSON.stringify(task.checks ?? null);
    if (JSON.stringify(checks ?? null) !== before) {
      task.checks = checks;
      store.touch(task);
      return true;
    }
    return false;
  }
}

/** Measures the branch once a chat turn has ended (no fetch); never throws. */
export function refreshAfterChat(task) {
  Promise.resolve()
    .then(() => refreshGitDeps.refreshBranchStatus(task, { includeBusy: true }))
    .catch((e) => store.addLog(task, 'git', `⚠️ could not measure the branch after the chat turn (${reasonOf(e)})`));
}

/** Re-stamping `branchStatus.at` alone wakes every open board; at most this often. */
export const BRANCH_AT_TOUCH_MS = 30 * 1000;

/**
 * What the poll records so the card can show its two numbers.
 *
 * `includeBusy` measures even while the task is working or a chat is mid-turn:
 * everything run here only reads (status, rev-list, diff, merge-tree), so the
 * worst a moving target costs is a number one check stale. A task that is
 * moving between machines is still skipped.
 */
export async function refreshBranchStatus(task, { includeBusy = false, force = false } = {}) {
  if (task.moving) return;
  // Finished work does not move: keep whatever was measured last.
  if (task.state === 'done' && !includeBusy && !force) return;
  if (!task.branch || !(await isProjectWorktree(machineOf(task), task.worktreePath))) {
    if (task.branchStatus) { task.branchStatus = null; store.touch(task); }
    return;
  }
  const busy = gitBusyReason(task);
  if (busy && !includeBusy) return;   // measuring a moving target says nothing

  const { dirty, unpushed, behind } = await pendingWork(machineOf(task), task.worktreePath, task.branch, { base: baseOf(task) });
  const mergeStuck = await mergeInProgress(machineOf(task), task.worktreePath);
  let conflicts = [];
  // A merge already under way owns the index: leave it alone while busy.
  if (behind > 0 && !(busy && mergeStuck)) {
    const mainSha = await resolveRef(machineOf(task), task.worktreePath, `origin/${baseOf(task)}`);
    // Analysing touches nothing, so it is safe even here; only the merge waits.
    if (mainSha) conflicts = (await analyzeMerge(machineOf(task), task.worktreePath, mainSha)).conflicts;
  }
  const now = new Date();
  const next = {
    behind: behind ?? 0,
    unpushed,
    dirty: dirty.length,
    conflicts: conflicts.length,
    mergeStuck,
    at: now.toISOString(),
  };
  const prev = task.branchStatus;
  // Only touch the store when something actually changed: every touch rewrites
  // tasks.json whole and wakes every open board.
  if (!prev || ['behind', 'unpushed', 'dirty', 'conflicts', 'mergeStuck'].some((k) => prev[k] !== next[k])) {
    task.branchStatus = next;
    store.touch(task);
    return;
  }
  // Same numbers: still record that they were just checked, so the card can
  // say "checked N min ago", but wake the boards only now and then.
  const lastAt = Date.parse(prev.at ?? '') || 0;
  prev.at = next.at;
  if (now.getTime() - lastAt >= BRANCH_AT_TOUCH_MS) store.touch(task);
}

/** Test seam for `refreshGitNow`. */
export const refreshGitDeps = {
  listAllBranches: (opts) => listAllBranches(opts),
  refreshBranchStatus: (task, opts) => refreshBranchStatus(task, opts),
  tasks: () => store.all(),
};
const REFRESH_CONCURRENCY = 4;
const gitRefreshing = new Map();   // project -> in-flight promise

/**
 * Fetches each project's origin once and re-measures every task's branch, busy
 * or not. Never throws: failures are logged and counted out.
 *
 * @returns {Promise<{tasks: number, fetched: number}>}
 */
export function refreshGitNow({ project = null, projects = null, force = true } = {}) {
  // `projects` wins over `project`; an empty list is "nothing to refresh", not
  // "everything" (the caller's visible set may legitimately be empty).
  const only = Array.isArray(projects) ? new Set(projects) : null;
  if (only && only.size === 0) return Promise.resolve({ tasks: 0, fetched: 0 });
  const key = only ? [...only].sort().join(' ') : (project ?? '*');
  // The all-projects sweep and a single project's one are different jobs.
  const running = gitRefreshing.get(key);
  if (running) return running;
  const job = (async () => {
    const result = { tasks: 0, fetched: 0 };
    try {
      const byProject = new Map();
      for (const task of refreshGitDeps.tasks()) {
        if (!task.branch || !task.worktreePath || task.unassigned || task.state === 'done' || task.moving) continue;
        const pid = task.project;
        if (!pid) continue;
        if (only ? !only.has(pid) : (project && pid !== project)) continue;
        if (!byProject.has(pid)) byProject.set(pid, []);
        byProject.get(pid).push(task);
      }
      const gate = new Semaphore(() => REFRESH_CONCURRENCY);
      await Promise.all([...byProject].map(async ([pid, tasks]) => {
        try {
          await refreshGitDeps.listAllBranches({ project: pid, force });
          result.fetched++;
        } catch (e) {
          console.error(`refreshGitNow: fetch failed for ${pid}: ${reasonOf(e)}`);
        }
        await Promise.all(tasks.map((task) => gate.run(async () => {
          try {
            await refreshGitDeps.refreshBranchStatus(task, { includeBusy: true });
            result.tasks++;
          } catch (e) {
            console.error(`refreshGitNow: ${task.id ?? '?'} failed: ${reasonOf(e)}`);
          }
        })));
      }));
    } catch (e) {
      console.error(`refreshGitNow: ${reasonOf(e)}`);
    }
    return result;
  })().finally(() => gitRefreshing.delete(key));
  gitRefreshing.set(key, job);
  return job;
}

/**
 * Sends everything the reviewer should be looking at, before telling them to
 * look. Both "ready for review" buttons come through here: asking someone for
 * their time against a stale branch wastes it.
 *
 * Uncommitted work is not the board's call. It stops the action and says what
 * is in the way, unless you answer that you want to go ahead without it — a
 * commit written by nobody, sweeping in whatever the worktree happens to hold,
 * is worse than a clear question.
 */
/**
 * Everything that must be true before a reviewer is called. One check, one
 * question: two separate `force` prompts would let a "yes" to one authorise the
 * other without the user ever being asked.
 */
async function mergeBeforeReview(task, { force = false } = {}) {
  const result = await bringMain(task, { reason: 'before asking for review' });
  if (result.conflicts.length && !force) {
    const e = new Error(`The branch cannot be merged with main: conflict in ${result.conflicts.length} file(s)`);
    e.code = 'MERGE_CONFLICT';
    e.conflicts = result.conflicts;
    throw e;
  }
  if (result.blocked && !force) {
    const e = new Error(`Could not merge main: ${result.blocked}`);
    e.code = 'MERGE_BLOCKED';
    throw e;
  }
  return result;
}

async function pushBeforeReview(task, { force = false } = {}) {
  if (!task.branch || !(await isProjectWorktree(machineOf(task), task.worktreePath))) {
    store.addLog(task, 'pr', 'no local worktree: the reviewer is notified with what is already on GitHub');
    return 0;
  }

  const { dirty, otherDirty, unpushed } = await pendingWork(machineOf(task), task.worktreePath, task.branch, { base: baseOf(task) });
  if (dirty.length && !force) {
    const e = new Error(`${dirty.length} file(s) of this branch are uncommitted; the reviewer would not see them`);
    e.code = 'DIRTY_WORKTREE';
    e.dirty = dirty;
    throw e;
  }
  if (dirty.length) {
    store.addLog(task, 'pr', `⚠️ ${dirty.length} uncommitted file(s) stay out of the review: ${dirty.slice(0, 3).join(', ')}`);
  }
  if (otherDirty) {
    store.addLog(task, 'pr', `(${otherDirty} dirty file(s) this branch does not touch: regenerated test output or specs; ignored)`);
  }

  if (unpushed === 0) {
    store.addLog(task, 'pr', 'nothing left to push: the remote branch is already up to date');
    return 0;
  }
  await withInfraRetries(task, 'pr', 'the push', () => pushBranch(machineOf(task), task.worktreePath, task.branch, { onLine: (l) => store.addLog(task, 'pr', l) }));
  store.addLog(task, 'pr', unpushed
    ? `${unpushed} commit(s) pushed to origin/${task.branch} before notifying the reviewer`
    : `branch ${task.branch} pushed before notifying the reviewer`);
  return unpushed ?? 0;
}

/** What `markReady` reaches for outside itself; injectable as `PR_STEPS` is. */
export const READY_STEPS = {
  prView, readyPr, addReviewer, mergeBeforeReview, pushBeforeReview,
  // After PR_GONE: the card should stop pointing at that PR on its own, not
  // at the next poll.
  reclassify: (task) => refreshClassification(task),
};

/**
 * «Listo para revisión». The PR is asked about live first — before main is
 * merged in or anything is pushed: a branch whose PR is already merged must
 * not get a merge commit and a push on its way to an error. What GitHub says
 * decides the rest:
 *
 * - DRAFT: main in, push, `gh pr ready`, reviewer — the full action.
 * - OPEN and not a draft: someone already marked it ready by hand. Main and
 *   the push still go first — the reviewer should see the same code either
 *   way — and only `gh pr ready` is skipped.
 * - MERGED or CLOSED: there is nothing to mark. `PR_GONE`, and the card is
 *   told this cycle has no PR yet (#787 pointed this button at #826, merged).
 *
 * **Whom to ask is known before anything is written.** The reviewer is the
 * registry's (`project.reviewer`), or the one picked in the dialog
 * (`opts.reviewer`), or nobody on purpose (`opts.noReviewer`). With none of the
 * three the call answers `{ needsReviewer: true, suggested, excludeLogin }` after
 * reading the PR and before the merge, the push or `gh pr ready`: a PR must not
 * be left ready with nobody to review it. `suggested` is the last reviewer used
 * here, `excludeLogin` the PR's author (the dialog marks them; GitHub decides whether they
 * can be asked). A project with `noReviewer` in the registry skips the question
 * (the registry's `reviewer` still wins). A reviewer
 * picked in the dialog is remembered once the request went through
 * (`lastReviewer`) and, with `opts.always`, becomes the project's reviewer.
 *
 * A reviewer that cannot be added does not undo a PR that is already ready:
 * the task goes to `ready` and the log says what is missing. Every failure is
 * written to the task's log as well — it used to reach only the toast.
 *
 * @param {number|string} issue
 * @param {{force?: boolean, reviewer?: string, noReviewer?: boolean, always?: boolean}} [opts]
 * @returns {Promise<undefined|{needsReviewer: true, suggested: string|null, excludeLogin: string|null}>}
 */
export async function markReady(issue, opts = {}, steps = READY_STEPS) {
  assertNoUpgradeRunning();
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  // One at a time per task: a repeat that arrives while the first is still
  // running waits here and then sees `ready`, instead of redoing the work.
  return readyMutex.runExclusive(keyOf(task), () => markReadyLocked(task, opts, steps));
}

/** Serialises «Listo para revisión» and the change-request publish, per task. */
const readyMutex = new Mutex();

async function markReadyLocked(task, { force = false, reviewer: picked, noReviewer = false, always = false }, steps) {
  try {
    if (!task.prNumber) throw new Error('The task has no PR');
    if (task.state === 'ready') {
      // A repeated request: the first one already did the work.
      store.addLog(task, 'pr', `PR #${task.prNumber} was already ready for review; the action is not repeated`);
      return;
    }
    if (task.state !== 'pr_draft') {
      throw new Error(`PR #${task.prNumber} cannot be marked ready: the task is in state «${task.state}», not pr_draft`);
    }
    const number = task.prNumber;
    const live = await steps.prView(number, task.project);
    if (live?.state === 'MERGED' || live?.state === 'CLOSED') {
      const e = new Error(`PR #${number} is already ${live.state === 'MERGED' ? 'merged' : 'closed'}; this cycle has no PR yet`);
      e.code = 'PR_GONE';
      Promise.resolve().then(() => steps.reclassify(task)).catch(() => {});
      throw e;
    }
    // Whom to ask, decided before the first write (see above).
    const pickedLogin = typeof picked === 'string' ? picked.trim() : '';
    if (pickedLogin && !LOGIN_RE.test(pickedLogin)) {
      throw new Error(`Invalid GitHub login for the reviewer: ${JSON.stringify(pickedLogin)}`);
    }
    const registryReviewer = projectOf(task.project)?.reviewer ?? null;
    // «Sin revisor» remembered for this project: no dialog. A registry reviewer
    // still wins over it (the two never coexist when written by the route).
    const registryNoReviewer = projectOf(task.project)?.noReviewer === true;
    if (!pickedLogin && !registryReviewer && !noReviewer && !registryNoReviewer) {
      return {
        needsReviewer: true,
        suggested: projectOf(task.project)?.lastReviewer ?? null,
        excludeLogin: live?.author ?? null,
      };
    }
    // Main first, then the push: the reviewer should be looking at code that
    // can actually be merged, and the merge commit has to travel with the rest.
    await steps.mergeBeforeReview(task, { force });
    await steps.pushBeforeReview(task, { force });
    if (live?.state === 'DRAFT' || live?.isDraft) {
      await steps.readyPr(number, task.project);
    } else {
      store.addLog(task, 'pr', `PR #${number} was no longer a draft on GitHub: no need to mark it ready, only to request the review`);
    }
    const own = (task.prs ?? []).find((p) => p.number === number);
    if (own) own.state = 'OPEN';

    // Whose review this asks for is the project's business: each repository
    // has its own reviewer in the registry, and `config.github.reviewer` is
    // only ever hfs's. Someone picked in the dialog wins over it.
    const reviewerLogin = pickedLogin || registryReviewer;
    let reviewer = null;
    if (reviewerLogin) {
      try {
        await steps.addReviewer(number, task.project, pickedLogin || undefined);
      } catch (e) {
        reviewer = e;
      }
    }
    store.setState(task, 'ready');
    if (!reviewerLogin) {
      store.addLog(task, 'pr', noReviewer
        ? `PR #${number} ready for review; no reviewer: chose not to ask anyone for the review`
        : `PR #${number} ready for review; no reviewer (configured for this project)`);
    } else {
      store.addLog(task, 'pr', reviewer
        ? `⚠️ PR #${number} ready for review, but the review could not be requested from ${reviewerLogin}: ${reviewer.message}. Request it by hand on GitHub`
        : `PR #${number} ready for review; reviewer: ${reviewerLogin}`);
    }
    // What the dialog chose is kept only once GitHub accepted it, so a typo
    // never becomes the suggestion (or, worse, the project's reviewer).
    if (pickedLogin && !reviewer) {
      try {
        rememberReviewer(task.project, pickedLogin);
        if (always) setReviewer(task.project, pickedLogin);
      } catch (e) {
        store.addLog(task, 'pr', `⚠️ could not remember the reviewer ${pickedLogin} in the project registry: ${e.message}`);
      }
    } else if (!pickedLogin && !registryReviewer && noReviewer && always) {
      // Same rule: saved only after the PR step went through.
      try {
        setNoReviewer(task.project, true);
      } catch (e) {
        store.addLog(task, 'pr', `⚠️ could not remember «no reviewer» in the project registry: ${e.message}`);
      }
    }
  } catch (e) {
    store.addLog(task, 'pr', `⚠️ «Ready for review» failed: ${e.message}`);
    throw e;
  }
}

function startPipeline(task, resumeFrom = 'assigned') {
  const key = keyOf(task);
  // The one central guard: whatever path got here, a task reassigned away in
  // GitHub does not run. The explicit entry points refuse louder before this.
  if (task.unassigned) {
    store.addLog(task, 'guard', `${unassignedReason(task)}: not starting`);
    return;
  }
  running.add(key);
  // The time spent in `assigned` waiting for a free slot (see `tick`).
  if (task.slotWaitSince) {
    recordSpan(task, { kind: 'wait', name: 'slot', startedAt: task.slotWaitSince, endedAt: new Date().toISOString(), meta: { within: null } });
    task.slotWaitSince = null;
  }
  // Where the run starts, before anything of it has run: a failure of the very
  // first step is then remembered as that step too, not as the state the card
  // happened to be showing.
  task.phase = normalizePhase(resumeFrom) ?? 'assigned';
  // A new run starts without the last run's explained failure.
  task.errorCode = null;
  task.errorInfo = null;
  authFailed.delete(task);
  // The card is told at once: the phase is what it shows while a run that
  // changes no state — one resumed at the PR — is in flight.
  store.touch(task);
  // Called from inside a promise so a body that throws synchronously still
  // reaches the catch and the finally, instead of leaving the issue held.
  Promise.resolve()
    .then(() => pipelineHooks.run(task, resumeFrom))
    .catch((e) => {
      if (e instanceof PausedForMode) {
        task.phase = null;
        store.setState(task, restingState(task));
      }
      // The account's limit, not this task's problem: it keeps its phase, its
      // commits and its place, and the clock starts it again by itself. It
      // must never reach `error` — that is the click nobody was there to make.
      else if (e instanceof QuotaExhausted) parkTaskForQuota(task, e.resumeFrom ?? task.phase);
      else {
        store.setState(task, 'error', { error: e.message });
        markAuthFailure(task);
      }
      // A replanning opened by «Pedir cambios» that the run never reached.
      failPlanning(task, e.message);
      store.touch(task);
    })
    .finally(() => {
      running.delete(key);
      // Nothing plans once the run is over: a planning still open was left
      // behind by a run that stopped before the fix (paused for the mode).
      if (task.planning) failPlanning(task, 'the run ended before planning');
      // A one-shot is one run: the next one is the board's call again, and
      // for a manual task that means none. Touched so the card hears it: the
      // store only broadcasts on a write, and `userRun` is not one.
      if (userRuns.delete(key)) store.touch(task);
      // A question parked by a session of this run cannot be answered now.
      if (task.pending && task.pending.kind !== 'plan') expireTaskPending(task, 'the phase ended');
      tick();
    });
}

/**
 * Test seam: the real launcher, with its catch and its `finally`. A test that
 * calls `runPipeline` directly never sees them — and the quota's whole promise
 * is what that catch does, so it has to be reachable.
 */
export const startPipelineOf = (task, resumeFrom) => startPipeline(task, resumeFrom);

/**
 * Everything `runPipeline` reaches for outside itself: gh, git, and the phases
 * that open a Claude session.
 *
 * Injectable for one reason: the gates *are* this function. A test that
 * replaces `pipelineHooks.run` watches the body from outside and cannot see
 * them, so the whole of #1125 could come back with the suite green. With the
 * steps as a parameter, the real body runs and the test counts what it called.
 */
/**
 * The phases, behind the same seam as {@link CLASSIFY_STEPS} and
 * {@link READY_STEPS}: a test drives the real body of one phase without the
 * fourteen others. Exported for that, and read-only — swap entries into a copy,
 * never into this object.
 */
export const PIPELINE_STEPS = {
  getIssue,
  classifyIssue,
  isProjectWorktree,
  ensureWorktree,
  bringMain,
  headCommit,
  hasCommits,
  continuationContext,
  triagePhase,
  prepareDependencies,
  fixPhase,
  testPhase,
  browserQaPhase,
  gapsPhase,
  composePrBody,
  draftPrPhase,
  generateDemoSteps,
};

/**
 * The phase spans of one run: contiguous, so they add up to the time the run
 * took. It opens on the phase the run resumes at (the guard and the lookups
 * before the first `enter` belong to it) and `enter` rotates it. Entering the
 * phase already open keeps it, so a run resumed at `fixing` has one span.
 */
function phaseRecorder(task, first) {
  let name = null;
  let open = null;
  const start = (next) => {
    name = next;
    open = beginSpan(task, { kind: 'phase', name: next });
  };
  start(first);
  return {
    enter(next) {
      if (next === name) return;
      endSpan(task, open);
      start(next);
    },
    close(outcome) {
      endSpan(task, open, { outcome });
      open = null;
    },
  };
}

/**
 * Whether a step of the run may overlap the one next to it: `install` runs
 * during the triage, `demo` next to the PR. On unless the project (or the
 * config) sets `pipeline.overlapInstall` / `pipeline.overlapDemo` to `false`.
 */
const overlapWanted = (task, which) => cfgOf(task).pipeline?.[which === 'install' ? 'overlapInstall' : 'overlapDemo'] !== false;

/**
 * Starts `make()` now and hands back a box that is never rejected: the outcome
 * is read from `value` / `error` once `done`, and `promise` resolves when it
 * is. A step that runs next to another one is joined through this, so its
 * failure can never be an unhandled rejection, whichever way the run leaves.
 */
function startSettled(make) {
  const box = { done: false, value: undefined, error: null, promise: null };
  box.promise = (async () => make())().then(
    (value) => { box.value = value; box.done = true; return box; },
    (error) => { box.error = error; box.done = true; return box; },
  );
  return box;
}

/** How a run ended, as the phase span says it. */
const outcomeOf = (e) => (e instanceof QuotaExhausted ? 'parked' : e instanceof PausedForMode ? 'paused' : 'error');
// Steps and waits close the same way the phase around them does.
metricsHooks.outcomeOfError = outcomeOf;

export async function runPipeline(task, resumeFrom, steps = PIPELINE_STEPS) {
  const phases = phaseRecorder(task, normalizePhase(resumeFrom) ?? 'assigned');
  try {
    const left = await runPipelineBody(task, resumeFrom, steps, phases);
    phases.close(left === 'paused' ? 'paused' : 'ok');
  } catch (e) {
    phases.close(outcomeOf(e));
    throw e;
  }
}

async function runPipelineBody(task, resumeFrom, steps, phases) {
  // What this run still has to do, and what it must leave alone: a run resumed
  // at the PR does not redo the fix, the tests or the QA that were paid for on
  // this very commit — nor bring main in, which would invalidate all three.
  const todo = planOfRun(resumeFrom);
  const resumeLabel = PHASE_LABEL[normalizePhase(resumeFrom) ?? 'assigned'];
  // Written before each phase starts, so a failure inside it is remembered as
  // that phase. The state cannot do this job: it only learns about the PR once
  // the PR exists, so a failure opening it looked like a failure of the Browser
  // QA, and Retry paid for the QA again (#1125).
  const enter = (phase) => {
    task.phase = phase;
    phases.enter(phase);
    store.touch(task);
  };

  const issue = await steps.getIssue(task.issue, task.project);
  task.title = issue.title;
  task.labels = issue.labels;

  // 0. Guard: never start an issue someone (or an earlier run) already started.
  // Only for tasks this board has not branched yet — our own branch would
  // otherwise look like third-party work on every restart.
  if (!task.branch && !task.forced) {
    store.addLog(task, 'guard', 'checking whether the issue already has a branch or PR');
    // With the task: a merged PR it already knows about stays merged even when
    // GitHub's answer comes back empty (see `withStoredMerged`).
    const verdict = await steps.classifyIssue(task.issue, { task });
    if (verdict.state !== 'assigned') {
      task.existingWork = { branches: verdict.branches, prs: verdict.prs, reasons: verdict.reasons };
      task.prs = verdict.prs ?? [];
      // Only an open PR is this task's; a merged one is history (see `classifyPrs`).
      task.prNumber = verdict.pr?.number ?? null;
      task.prUrl = verdict.pr?.url ?? null;
      // A PR exists: no title is waiting for anyone to edit it.
      if (verdict.pr) task.prPark = null;
      store.setState(task, verdict.state);
      store.addLog(task, 'guard', `not starting: ${verdict.reasons.join('; ')}`);
      return;
    }
    store.addLog(task, 'guard', 'no prior work; continuing');
  }

  // 1. Worktree + branch off origin/<base> (or adopting the issue's branch)
  if (todo.worktree || !(await steps.isProjectWorktree(machineOf(task), task.worktreePath))) {
    enter('worktree');
    store.setState(task, 'worktree');
    await steps.ensureWorktree(keyOf(task));
    store.setState(task, 'worktree');
  }

  // A conflict here never stops the task: it is reported and the branch stays
  // as it is, exactly as it would today. Stopping would strand the card in an
  // error that Retry can only walk back into.
  if (todo.mergeMain) {
    await steps.bringMain(task, { reason: 'at task start' });
  } else {
    store.addLog(task, 'merge', `resuming from ${resumeLabel}: main is not merged, which would invalidate the tests and QA already passed on this commit; use «⬇ Pull» if you want to bring it in`);
  }

  // 2. Triage (Opus) + advisor for complex work
  if (pausedForMode(task, 'el triage')) return 'paused';
  // The install that runs during the triage, if any (see 3a).
  let earlyInstall = null;
  if (todo.triage || !task.complexity) {
    enter('triage');
    store.setState(task, 'triage');
    try {
      // Read before the triage starts: `cfgOf` throws when the project is gone,
      // and a session already launched would be left with no one awaiting it.
      // After `bringMain` (it can change the manifest or the lockfile) and only
      // when the fix is still ahead: nothing here reads what the triage decides.
      const earlyWanted = todo.fix && overlapWanted(task, 'install');
      const triaging = steps.triagePhase(task, issue);
      if (earlyWanted) {
        earlyInstall = startSettled(() => steps.prepareDependencies(task, undefined, 'during_triage'));
      }
      await triaging;
    } finally {
      // Every way out of the triage (done, paused, quota, error) waits for the
      // install: it is not killed, because on Windows only the direct child
      // would die and a cut `npm` would leave `node_modules` looking installed.
      try {
        if (earlyInstall && !earlyInstall.done) {
          store.addLog(task, 'deps', 'triage finished with the install still running: waiting for it to finish');
          // The card shows `triage` for as long as this takes (up to the install
          // timeout), so it also says what it is waiting for.
          task.waitingOn = 'install';
          store.touch(task);
        }
      } catch { /* the note is a courtesy: a store that fails here must not skip the wait or mask the triage error */ }
      try {
        await earlyInstall?.promise;
      } finally {
        if (task.waitingOn) {
          task.waitingOn = null;
          store.touch(task);
        }
      }
    }
  }

  // 3. Fix (Opus, parallel subagents). Gated on the sha the board's own fix
  // produced, not on "are there commits": a branch carrying work you did by
  // hand in the chat has commits too, and reading those as "the fix already
  // landed" is how half-finished work reached a PR.
  if (pausedForMode(task, 'el fix')) return 'paused';
  if (!todo.fix) {
    store.addLog(task, 'fix', `resuming from ${resumeLabel}: the fix on this branch is already done`);
  } else {
    // 3a. Dependencies, BEFORE the session that needs them. They used to be
    // installed by the test phase, three phases later, so the first project
    // command the board ran came after the fix — and a fix subagent installed
    // them by hand while another one started the same install ("Another session
    // has started installing them in the meantime"). Not hooked into
    // `ensureWorktree`: that is also the chat's «Crear worktree» button, whose
    // HTTP call this would block, and its early `return` when the worktree
    // already exists is the very symptom to avoid.
    // Nothing depends on the triage's result to install, so the install starts
    // next to it (`during_triage`) and has already ended here — the fix never
    // starts before it. A failed early install gets one sequential `pre_fix`
    // try, so the failure path is the one it always was; a run that skipped the
    // triage (or has the overlap off) only has that `pre_fix`.
    let deps = earlyInstall && !earlyInstall.error ? earlyInstall.value : null;
    if (!deps?.ok) {
      if (earlyInstall) store.addLog(task, 'deps', 'the install run in parallel with the triage did not finish cleanly: retried before the fix');
      deps = await steps.prepareDependencies(task, undefined, 'pre_fix');
    }
    if (!deps.ok) throw dependencyError(infrastructureFailure(deps));
    enter('fixing');
    const beforeFix = await steps.headCommit(machineOf(task), task.worktreePath);
    if (beforeFix && task.fixedAt === beforeFix) {
      store.addLog(task, 'fix', 'the fix commit already exists on the branch; skipping to the tests');
    } else if (await steps.hasCommits(machineOf(task), task.worktreePath, { base: baseOf(task) })) {
      // Commits the board did not make: a session that died after committing,
      // or work from the chat. Not "done" — half-made work has commits too —
      // but not "start over" either: the session reviews what is there and
      // finishes what is missing.
      store.setState(task, 'fixing');
      store.addLog(task, 'fix', 'the branch already has commits: the session reviews what is there and finishes what is missing, instead of starting from scratch');
      await steps.fixPhase(task, issue, await steps.continuationContext(task), { continuing: true });
    } else {
      store.setState(task, 'fixing');
      await steps.fixPhase(task, issue);
    }
    // 3b. Dependencies again, AFTER the fix: in a blank repository the manifest
    // is the fix's own, so the pre-fix step had nothing to install. For a
    // project with `e2e: null` this is the only install after the fix. A failed
    // install gets ONE repair round (the exception to `dependencyError`).
    let postDeps = await steps.prepareDependencies(task, undefined, 'post_fix');
    // Only for the blank-repo case (`e2e: null`): the manifest is the fix's own.
    // With an explicit install command the failure is the environment's.
    if (!postDeps.ok && cfgOf(task).e2e == null) {
      store.addLog(task, 'deps', 'the install failed after the fix: one repair round');
      await steps.fixPhase(
        task,
        issue,
        `${await steps.continuationContext(task)}\n\nLa instalación de dependencias falló tras tu fix:\n\n${postDeps.tail ?? ''}\n\nCorrige package.json / el lockfile para que \`npm install\` pase, y commitea el arreglo.`,
        { continuing: true },
      );
      postDeps = await steps.prepareDependencies(task, undefined, 'repair');
    }
    if (!postDeps.ok) throw dependencyError(infrastructureFailure(postDeps));
  }

  // 4. Playwright e2e (globally serialized), with repair loop. Skipped when the
  // suite already went green on this exact commit — a retry that failed later
  // (opening the PR, say) must not pay for the whole suite again.
  //
  // Main goes in first so the suite runs on the code that will actually be
  // merged; that is what turns "green here, red in CI" into a rarity. The gate
  // below is read afterwards on purpose: a merge clears `e2ePassedAt`.
  if (todo.e2e) {
    if (todo.mergeMain) await steps.bringMain(task, { reason: 'before the e2e tests' });
    const head = await steps.headCommit(machineOf(task), task.worktreePath);
    if (head && task.e2ePassedAt === head) {
      store.addLog(task, 'e2e', `the tests already passed on this commit (${head.slice(0, 8)}); skipped`);
    } else {
      enter('testing');
      store.setState(task, 'testing');
      await steps.testPhase(task);
      task.e2ePassedAt = await steps.headCommit(machineOf(task), task.worktreePath);
      store.touch(task);
    }
  } else {
    store.addLog(task, 'e2e', `resuming from ${resumeLabel}: the e2e tests on this branch already passed; not repeated`);
  }

  // 4b. Browser QA: the issue checked in a browser the way a tester would,
  // with the app running. Only for issues with a UI side (triage's call, or
  // yours), and skipped when it already passed on this exact commit.
  if (qaWanted(task)) {
    if (pausedForMode(task, 'el Browser QA')) return 'paused';
    const headQa = await steps.headCommit(machineOf(task), task.worktreePath);
    if (headQa && task.qa?.passedAt === headQa) {
      store.addLog(task, 'qa', `Browser QA already passed on this commit (${headQa.slice(0, 8)}); skipped`);
    } else if (!todo.qa && headQa && task.qa?.ranAtHead === headQa) {
      // It already ran on this exact commit and did not pass — incomplete, or
      // with a step failing. Those minutes were paid for once; a failure of a
      // later step must not charge for them again. The card says what the
      // verdict was, and «Browser QA» repeats it when you want it repeated.
      store.addLog(task, 'qa', `Browser QA already ran on this commit (${headQa.slice(0, 8)}, verdict ${task.qa?.results?.verdict ?? 'no results'}); resuming from ${resumeLabel} and not repeated`);
    } else {
      if (!todo.qa) {
        // A late resume that still has to pay for the QA: say so before the 25
        // minutes start, or a «Publicar PR» click looks like it hung.
        store.addLog(task, 'qa', `resuming from ${resumeLabel}, but the Browser QA on record is not from this commit (${task.qa?.ranAtHead ? `ran at ${task.qa.ranAtHead.slice(0, 8)}` : 'has never run'}, and HEAD is ${headQa ? headQa.slice(0, 8) : 'unknown'}): it runs anyway and takes a while`);
      }
      enter('browser_qa');
      store.setState(task, 'browser_qa');
      await steps.browserQaPhase(task, issue);
    }
  } else if (task.qa?.ui === false) {
    store.addLog(task, 'qa', 'no UI component according to the triage; Browser QA does not apply');
  }

  // 4c. Cerrar huecos: the fix session reviews its own work for evidence and
  // gaps, and closes what it can. Off by default; `planOfRun` skips it on a
  // resume at the PR, which is where a run that already went through it lands.
  if (todo.gaps && fixGapsWanted(task)) {
    if (pausedForMode(task, 'el cierre de huecos')) return 'paused';
    enter('fix_gaps');
    store.setState(task, 'fix_gaps');
    await steps.gapsPhase(task, issue);
  }

  // 5. Draft PR, then the manual-validation steps for the Demo panel
  if (pausedForMode(task, 'abrir el PR')) return 'paused';
  // The demo does not need the PR (its prompt has no PR data), so it is written
  // next to the PR step. The head it is written for gates it on a resume: a demo
  // already done on this commit is not paid for twice after a PR failure.
  //
  // The phase is entered before that read: `headCommit` can reject (a runner
  // call over the network), and a failure is recorded against `task.phase`, so
  // Retry must resume at the PR and not repeat a QA or a fix already paid for.
  if (todo.pr) enter('pr');
  const demoOn = demoWanted(task);
  const demoHead = demoOn ? await steps.headCommit(machineOf(task), task.worktreePath) : null;
  const demoDone = demoOn && todo.pr && Boolean(demoHead) && task.demoAt === demoHead;
  // A step span, not a phase: phases stay contiguous and only they add up to
  // `runMs`, so the overlap is never counted twice. The demo resumes the
  // principal session and releases it; `composePrBody` opens a new one, so the
  // two sessions do not clash.
  const runDemo = (overlap) => startSettled(async () => {
    await span(task, { kind: 'step', name: 'demo_steps', ...(overlap ? { overlap: true } : {}) }, () => steps.generateDemoSteps(task, issue));
    task.demoAt = demoHead;
    store.touch(task);
  });
  let demo = null;
  if (todo.pr) {
    if (demoOn && !demoDone && overlapWanted(task, 'demo')) demo = runDemo(true);
    // The PR step settles first; whatever the demo did is kept either way.
    let prError = null;
    try {
      // Before the PR exists, and after the fix, the tests and the QA have
      // converged: the diff is final, `task.qa.results` is there, and nothing is
      // published yet — so the body goes out right the first time and nobody has
      // to edit it afterwards.
      // Same shape as the `e2ePassedAt` and `qa.passedAt` gates above: a session
      // already paid for is not paid for twice. «Publicar PR» after a parked
      // title and «Reintentar» after a failed push both come back through here
      // with the body already written — and a PR that exists, or one adopted
      // from the branch, is never given a new body by `draftPrPhase`, so writing
      // one would burn a session on text nobody would ever publish.
      if (task.prNumber) {
        store.addLog(task, 'pr', `PR #${task.prNumber} is already open: its body is not rewritten from here`);
      } else if (task.prBody) {
        store.addLog(task, 'pr', 'the PR body was already written in this cycle; reused');
      } else {
        await span(task, { kind: 'step', name: 'compose_pr_body' }, () => steps.composePrBody(task, issue)).catch((e) => {
          // The quota is the run's business and parks the task on `pr`; anything
          // else is only prose, and prose must never be what stops a PR.
          if (e instanceof QuotaExhausted) throw e;
          task.prBody = null;
          store.addLog(task, 'pr', `⚠️ could not write the PR body (${reasonOf(e)}); it is opened with the usual body`);
        });
      }
      await span(task, { kind: 'step', name: 'draft_pr' }, () => steps.draftPrPhase(task, issue));
      store.setState(task, 'pr_draft');
    } catch (e) {
      prError = e;
    }
    if (prError) {
      // The demo that finished (or is finishing) keeps its result; the PR's own
      // error wins, quota included, and `task.phase` stays on `pr`.
      await demo?.promise;
      throw prError;
    }
    // Only the demo is left: say so, and keep the card on a PR draft.
    if (demo && !demo.done) enter('demo');
  } else {
    store.addLog(task, 'pr', `resuming from ${resumeLabel}: the PR${task.prNumber ? ` #${task.prNumber}` : ''} is already open`);
    // This branch sets no state of its own, so a run resumed at the demo steps
    // would finish leaving the card in `error` with no error to show and a
    // Retry that does nothing.
    if (task.state === 'error') store.setState(task, task.prNumber ? 'pr_draft' : restingState(task));
  }
  if (demoDone) {
    store.addLog(task, 'demo', `the demo steps were already done on this commit (${demoHead.slice(0, 8)}); not repeated`);
  } else if (demoOn) {
    if (!demo) {
      enter('demo');
      demo = runDemo(false);
    }
    await demo.promise;
    // Demo failures are swallowed on purpose — they are not work to retry — but
    // the quota must get through, or the run would end here «successfully» with
    // `task.phase` cleared and the resume point lost. The PR is open by now, so
    // the task parks on `demo`.
    if (demo.error instanceof QuotaExhausted) {
      enter('demo');
      throw demo.error;
    }
    if (demo.error) store.addLog(task, 'demo', `⚠️ could not generate the demo steps: ${demo.error.message}`);
  } else {
    store.addLog(task, 'demo', 'demo disabled on this task: no manual validation steps are generated');
  }
  // The run is over, so there is no phase to resume from. Outside the catch
  // above on purpose: demo steps that failed are not work to retry — and
  // outside the gate too, or a task with the demo off would end holding
  // `phase: 'pr'` and offer a Retry that reopens a PR it already has.
  task.phase = null;
  store.touch(task);
}

// ---------------------------------------------------------------------------

/**
 * The log line each guard of `answerOf` leaves when it hands a validator the
 * sealed text (#31): the CLI's reaction turn had replaced a good answer. The
 * words are what `grep` counts when the guard is measured.
 */
const sealedAnswerNote = (task, stage, result = null) => {
  const say = (origin) => store.addLog(task, stage, origin === 'fallback'
    ? '⚠️ the parallelism claim answer was unusable and the first one was fine; using the first answer'
    : '⚠️ the adopted answer was unusable and the sealed one was fine; using the sealed text (CLI reaction turn)');
  if (!result || typeof result !== 'object') return say;
  // One result is read by several readers (verdict, plan, QA plan) and again
  // by each retry loop; that is still one event, so one line. Keyed on the
  // result object itself, so a different result (a re-ask) notes on its own.
  return (origin) => {
    let seen = notedSealed.get(result);
    if (!seen) notedSealed.set(result, seen = new Set());
    const key = `${task.issue}|${stage}|${origin}`;
    if (seen.has(key)) return;
    seen.add(key);
    say(origin);
  };
};
const notedSealed = new WeakMap();

/**
 * The plan a finished turn was supposed to leave behind, asking once more when
 * it didn't.
 *
 * The retry *resumes that same session* instead of re-running the phase: the
 * analysis is already done and paid for, and what's missing is one line at the
 * end of it. Re-running the phase would buy the same answer at the price of a
 * whole Opus session — and, for anything that writes, would repeat work on a
 * tree that already changed.
 *
 * Returning null is a real outcome: a phase without a usable plan still runs,
 * unplanned and logged as such. A missing line is not worth parking a task for.
 */
async function workPlanFrom(task, stage, result, options) {
  return (await readWorkPlanFrom(task, stage, result, options)).plan;
}

/**
 * `workPlanFrom`, also saying why there is no plan: `{ plan, brief, problem }`.
 * A replanning that ends without one stops the task, and the card says why.
 * `run` is the Claude call to ask again with; `giveUp` ends the last log line.
 *
 * With `brief`, the prose the plan has to open with is checked in the same
 * pass. Both complaints ride the same retry, on purpose: a plan whose table is
 * fine and whose brief is missing would otherwise buy a second round of
 * sessions to fix one paragraph, and the phases that ask for a plan are the
 * expensive ones. Only the templates that carry `planBriefContract()` ask for
 * it — the triage and the demo leave `brief` off and are unchanged.
 */
export async function readWorkPlanFrom(task, stage, result, { machine, cwd, model, tuning, onEvent, run = runClaude, giveUp = 'continuing without a plan', brief: wantsBrief = false }) {
  const look = (text) => {
    const read = readWorkPlan(text);
    const problems = wantsBrief ? briefProblems(text) : [];
    return { read, problems, ok: read.ok && !problems.length };
  };
  // Best so far, kept across rounds: a later turn that fixes the prose and
  // drops the tagged line must not cost the plan it already produced, and the
  // other way around.
  //
  // A round that brings both replaces both, as a pair. Kept apart, a plan from
  // round 0 and a brief from round 1 would ship together — prose describing
  // the split that was asked for over the table of the one that was not.
  let plan = null;
  let brief = null;
  const keep = (seen, text) => {
    if (seen.ok) {
      plan = seen.read.plan;
      brief = wantsBrief ? readBrief(text) : null;
      return;
    }
    if (seen.read.ok && !plan) plan = seen.read.plan;
    if (wantsBrief && !seen.problems.length && !brief) brief = readBrief(text);
  };
  // What is left to complain about once the best-so-far is taken into account.
  const pending = (seen) => ({
    plan: plan ? null : seen.read.problem,
    brief: !wantsBrief || brief ? [] : seen.problems,
  });

  const answerText = (r) => answerOf(r, (t) => look(t).ok, sealedAnswerNote(task, stage, r));
  let text = answerText(result);
  let seen = look(text);
  keep(seen, text);
  if (seen.ok) return { plan, brief, problem: null };
  // Same as `taggedFrom`: complaining to a session that died against the
  // account's limit buys three more sessions against the same wall.
  if (result.quota) throw new QuotaExhausted();

  // Up to three complaints, each naming what was wrong the last time.
  const max = config.retry?.max ?? 3;
  for (let n = 1; result.sessionId && n <= max; n += 1) {
    const left = pending(seen);
    if (!left.plan && !left.brief.length) break;
    const why = [
      left.plan ? `without a usable ${WORK_PLAN_TAG} (${left.plan})` : null,
      left.brief.length ? `without the \`${PLAN_BRIEF_HEADING}\` summary (${left.brief.join('; ')})` : null,
    ].filter(Boolean).join(' and ');
    store.addLog(task, stage, `⚠️ the turn ended ${why}; asking again (${n} of ${max})`);
    const again = await run({
      machine,
      cwd,
      model,
      ...tuning,
      maxTurns: 3,
      resume: result.sessionId,
      onEvent,
      hooks: ghGateHooks(task, stage),
      prompt: [
        left.plan ? workPlanComplaint(left.plan) : '',
        left.brief.length ? briefComplaint(left.brief) : '',
      ].join('').trim(),
    });
    text = answerText(again);
    seen = look(text);
    keep(seen, text);
  }

  const left = pending(seen);
  if (left.plan) {
    store.addLog(task, stage, `⚠️ still no usable ${WORK_PLAN_TAG} (${left.plan}); ${giveUp}`);
    return { plan: null, brief: null, problem: left.plan };
  }
  if (left.brief.length) {
    // The prose is what makes a plan readable; the table is what makes it
    // executable. A plan is never lost over the paragraph in front of it.
    store.addLog(task, stage, `⚠️ the plan still has no \`${PLAN_BRIEF_HEADING}\` summary (${left.brief.join('; ')}); it goes to approval with the bare table`);
  }
  return { plan, brief, problem: null };
}

/**
 * Any tagged line a finished turn should have left — the same one-more-ask as
 * `workPlanFrom`, for QA plans and results. `read(text)` returns
 * `{ ok, problem, ...value }`; the value comes back whole, or null.
 */
export async function taggedFrom(task, stage, result, { read, tag, machine, cwd, model, tuning, onEvent, mcpServers, max: maxAsks, run = runClaude }) {
  const value = (r) => Object.values(r).find((v) => v && typeof v === 'object');
  const answerText = (r) => answerOf(r, (t) => read(t).ok, sealedAnswerNote(task, stage, r));
  let got = read(answerText(result));
  if (got.ok) return value(got);
  // The turn died against the account's limit, so there is nothing to complain
  // about: asking three more times just hammers a closed window — which is
  // literally what happened. The phase stops and the run is parked instead.
  if (result.quota) throw new QuotaExhausted();
  if (!result.sessionId) return null;

  // `max` caps the asks (fix-gaps asks once); without it the retry budget applies.
  const max = maxAsks ?? config.retry?.max ?? 3;
  for (let n = 1; n <= max && !got.ok; n += 1) {
    store.addLog(task, stage, `⚠️ the turn left no usable ${tag} (${got.problem}); asking again (${n} of ${max})`);
    const again = await run({
      machine, cwd, model, ...tuning, maxTurns: 3, resume: result.sessionId, onEvent, mcpServers,
      hooks: ghGateHooks(task, stage),
      prompt: qaComplaint(tag, got.problem).trim(),
    });
    got = read(answerText(again));
  }
  if (got.ok) return value(got);
  store.addLog(task, stage, `⚠️ still no usable ${tag} (${got.problem})`);
  return null;
}

/**
 * Infrastructure that may just need a moment: a port still closing, a box
 * that did not answer, a push the network dropped. Tried again with a
 * growing wait; anything that is not transient fails at once.
 */
export async function withInfraRetries(task, stage, what, fn) {
  let retry = 0;
  return withRetries(async () => ({ ok: true, value: await fn() }), {
    max: config.retry?.max ?? 3,
    backoff: retryHooks.backoff,
    shouldRetry: (failure) => isTransient(failure.error),
    onRetry: (n, failure) => {
      retry = n;
      store.addLog(task, stage, `⚠️ ${what} failed (${lastLines(failure.output, 1)}); retry ${n} of ${config.retry?.max ?? 3} after a wait`);
    },
    // The wait itself, as a span: it is time the run is not working.
    wait: (ms) => span(task, { kind: 'wait', name: 'infra_backoff', attempt: retry, within: openPhaseOf(task), stage, what },
      () => new Promise((resolve) => setTimeout(resolve, ms))),
  }).then((r) => r.value);
}

/** Test seam: the waits between infrastructure retries (`BACKOFF_MS`). */
export const retryHooks = { backoff: BACKOFF_MS };

/**
 * `runClaude` for a phase that may be asked once to fan out (nudge.js).
 *
 * `name` is the prompt template (the key of `PARALLEL_SCOPE`), which is what
 * decides whether the phase can be nudged at all; `pipeline.nudge` in the config
 * tunes or turns it off. The follow-up resumes the same session, so a phase that
 * released the principal chat passes the same release as `before`. `run` is the
 * test seam; `enabled: false` is a plain run (the second attempt of a retry loop).
 */
export async function nudgedSession(task, name, options, { run = runClaude, before, enabled = true } = {}) {
  if (!enabled) return run(options);
  const stage = options?.metrics?.stage ?? options?.metrics?.role ?? name;
  return withNudge({
    task,
    name,
    cfg: cfgOf(task).pipeline?.nudge,
    options,
    run,
    before,
    held: () => quotaHoldsNewWork(),
    log: (line) => store.addLog(task, stage, line),
    persist: () => store.touch(task),
  });
}

/** What a chat turn's span keeps of its tool counts: the total and the subagents. */
const chatCallMeta = (toolCounts) => (toolCounts
  ? { toolCalls: Object.values(toolCounts).reduce((a, b) => a + b, 0), subagents: subagentsUsed(toolCounts) }
  : {});

/**
 * Writes the line that makes "parallelise" checkable: what the phase said it
 * would split, against how many subagents it actually launched.
 *
 * The warning is deliberately not a failure. For a read-only phase we could
 * retry, but for the fix we cannot: by the time we know it went single file the
 * commit exists, and relaunching would redo work over a changed tree. So it is
 * recorded where you will see it, and the task moves on.
 */
function reportParallelism(task, stage, plan, toolCounts, elapsedMs) {
  if (!plan) return;
  store.addLog(task, stage, parallelismLine(plan, toolCounts, elapsedMs));
  if (planIgnored(plan, toolCounts)) {
    const n = subagentsUsed(toolCounts);
    store.addLog(task, stage, `⚠️ the plan declared ${planStats(plan).independent} independent tasks`
      + ` and the session launched ${n} subagent${n === 1 ? '' : 's'}: it ran in a row`);
  }
}

/**
 * The three variables every `renderPrompt` of this module passes, and nothing
 * else (`keys.js`, "How the project reaches the modules that do not take a
 * task", point 4).
 *
 * `projectId` picks the project's load-bearing phrases.
 *
 * `projectContext` picks its descriptor. `prompts.js` may not import
 * `projects.js` (that module writes in the data directory, and the import
 * guard would then count `prompt-baseline`, `parallel`, `workplan`, `handoff`
 * and `qa` as offenders), so the dependency runs the other way: `projects.js`
 * registers `setProjectResolver((id) => projectOf(id))` into `prompts.js` at
 * load, and `renderPrompt` resolves `repoPath` through it from `projectId`.
 * The `projectContext` passed here for a registered project is the same
 * descriptor, computed once; a caller-supplied value always wins over the
 * resolver, which is what lets `tools/prompt-baseline` render with a sentinel.
 *
 * **An unregistered project throws in `renderPrompt`**, on purpose: the
 * resolver answers no `repoPath`, and `prompts.js` raises «Proyecto
 * desconocido para {{projectContext}}» rather than brief the phase with hfs's
 * descriptor (another repository's). Here an unregistered project simply
 * passes no `projectContext`, so the render is what throws, and the phase
 * ends in `error` saying which project is missing. Only templates that carry
 * `{{projectContext}}` (triage, fix, plan-task) can throw; the rest never
 * resolve a project.
 *
 * `onInvariantInjected` is the only way the backstop can reach a card:
 * `renderPrompt` returns a string and has no task, so a load-bearing phrase
 * the board had to put back would otherwise be repaired in silence. This is
 * the one place that holds both a task and a stage, so this is where the line
 * gets written. Nothing in here may throw — it runs inside the render of a
 * prompt that is about to start a session, and a log line is not worth a phase.
 */
function promptVarsFor(task, stage) {
  // The registry is read, never written, and `load()` caches; a first read
  // that fails takes the same road as an unregistered project rather than
  // taking the phase down.
  let project;
  try {
    project = projectOf(task?.project);
  } catch { project = undefined; }
  return {
    projectId: task?.project,
    ...(project ? { projectContext: projectContextFor({ repoPath: project.repoPath }) } : {}),
    onInvariantInjected: (injected) => {
      try {
        const { id, phrase, source } = injected ?? {};
        const said = String(phrase ?? '').replace(/\s+/g, ' ').trim();
        store.addLog(task, stage, `🧩 the template${source ? ` from ${source}` : ''} lacked «${id ?? 'a load-bearing sentence'}»: the board put it back${said ? `: ${said.slice(0, 200)}` : ''}`);
      } catch { /* the line is never worth the phase */ }
    },
  };
}

/**
 * What `tuningFor(role)` adds to one session's options: its model, and effort,
 * fast mode and context window **only when someone chose them** — «auto» means
 * the key is absent, not `undefined`, so a session with nothing chosen is built
 * exactly as it was before tuning existed. `available` and `onWarning` always go
 * (the effort helpers need the first, the second puts a dropped option in the
 * task log), and so does the project's `settingSources` when it declares them.
 *
 * Also records `task.phaseModels[stage] = { model, effort }` — the card's «modelo
 * · esfuerzo» chip. The key is moved to the end each time, so the last key is
 * always the latest session.
 *
 * @param {object} task
 * @param {string} role one of `TUNING_ROLES`.
 * @param {{stage?: string, cfg?: object, record?: boolean}} [opts]
 */
export function tunedSession(task, role, { stage = role, cfg = cfgOf(task), record = true } = {}) {
  const t = tuningFor(role, cfg);
  // The plan has always fallen back to the advisor's model when `planModel` is
  // not configured; `tuningFor` does not know that.
  if (role === 'plan' && !t.model) t.model = tuningFor('advisor', cfg).model;
  // Likewise the review replies, which fall back to the demo's model.
  if (role === 'reply' && !t.model) t.model = tuningFor('demo', cfg).model;
  const out = { model: t.model };
  if (t.effort) out.effort = t.effort;
  if (t.thinking) out.thinking = t.thinking;
  if (t.fastMode) out.fastMode = true;
  out.available = t.available;
  out.onWarning = (m) => store.addLog(task, stage, `⚠️ ${m}`);
  // Who is asking, so `runClaude` can record the session's span on this task.
  out.metrics = { task, role, stage };
  let sources;
  try {
    sources = projectOf(task?.project)?.settingSources;
  } catch { sources = undefined; }
  if (sources) out.settingSources = sources;
  // The board's UX plugin rides along only where a person is in front of the
  // session, and only if the project has not turned it off.
  let designOn = true;
  try { designOn = projectDesignOf(task?.project); } catch { designOn = true; }
  if (attended(stage) && designOn) out.boardPlugins = ['hfs-ux'];
  // Only when it applies: the key is absent from every other session.
  if (designSessionFor(task, stage)) out.design = true;
  if (record) {
    const seen = { ...(task.phaseModels ?? {}) };
    delete seen[stage];
    seen[stage] = { model: t.model, effort: t.effort ?? null };
    task.phaseModels = seen;
    store.touch(task);
  }
  return out;
}

/**
 * Turn caps for the sessions that used to run with none. Generous on purpose:
 * they exist to end a runaway session and to say so, not to change how a normal
 * one ends. Tuned later from the timings. Override per role (and per project)
 * with `limits.maxTurns.<role>` in the configuration.
 */
export const MAX_TURNS_DEFAULT = { fix: 500, qa: 500, chatPlan: 500 };

/** The turn cap of a role: the configured positive integer, else the default. */
export function maxTurnsFor(role, cfg) {
  const configured = cfg?.limits?.maxTurns?.[role];
  return Number.isInteger(configured) && configured > 0 ? configured : MAX_TURNS_DEFAULT[role];
}

/** Says so in the log when a session stopped because it hit its turn cap. */
function noteMaxTurns(task, stage, result, cap) {
  if (result?.stats?.subtype !== 'error_max_turns') return;
  store.addLog(task, stage, `⚠️ the session reached the cap of ${cap} turns and stopped (limits.maxTurns in the configuration)`);
}

/** What triage is told when its answer had no readable `TRIAGE_RESULT:` line. */
export const TRIAGE_REASK = 'Tu última respuesta no traía la línea `TRIAGE_RESULT:` en el formato pedido, y el tablero la necesita. Responde ahora SOLO con esa línea: `TRIAGE_RESULT:` en mayúsculas al principio, sin viñeta ni negritas ni bloque de código, y el JSON {"complexity":"simple|complex","reason":"...","summary":"..."} en la misma línea.';

/**
 * The triage verdict, asking ONCE more in the same session when the answer had
 * no parseable `TRIAGE_RESULT:` line, before falling back to «complejo». Which of
 * the three paths ran (`first` / `reasked` / `fallback`) goes to the task log, so a
 * phase that was silently assumed complex is visible on the card.
 *
 * `run` is injectable (default `runClaude`); `stage` only labels the log.
 *
 * @returns {Promise<{verdict: Object, path: 'first'|'reasked'|'fallback', result: Object}>}
 */
export async function triageVerdictFor(task, triage, { cfg = cfgOf(task), onEvent, fallbackSummary = null, run = runClaude } = {}) {
  const triageText = (r) => answerOf(r, (t) => Boolean(parseTriageResult(t)), sealedAnswerNote(task, 'triage', r));
  const first = parseTriageResult(triageText(triage));
  if (first) {
    store.addLog(task, 'triage', 'verdict read on the first try');
    return { verdict: first, path: 'first', result: triage };
  }
  store.addLog(task, 'triage', '⚠️ the answer had no readable TRIAGE_RESULT:; asking once more in the same session');
  let again = null;
  if (triage.sessionId) {
    again = await run({
      machine: machineOf(task),
      cwd: task.worktreePath,
      ...tunedSession(task, 'triage', { cfg, record: false }),
      maxTurns: 3,
      resume: triage.sessionId,
      onEvent,
      canUseTool: taskCanUseTool(task, 'triage'),
      hooks: ghGateHooks(task, 'triage'),
      prompt: TRIAGE_REASK,
    }).catch((e) => ({ ok: false, error: reasonOf(e), resultText: '' }));
    if (again.quota) throw new QuotaExhausted('triage');
  }
  const second = again?.ok ? parseTriageResult(triageText(again)) : null;
  if (second) {
    store.addLog(task, 'triage', 'verdict read after the second question');
    return { verdict: second, path: 'reasked', result: again };
  }
  store.addLog(task, 'triage', 'no parseable verdict after the second question: assumed complex to be safe');
  return {
    verdict: {
      complexity: 'complex',
      reason: 'triage without a parseable verdict; assumed complex to be safe',
      // The first answer when a nudge reply replaced it: a one-sentence reply is no summary.
      summary: fallbackSummary ?? String(triage.fallbackTexts?.[0] ?? triage.resultText ?? '').slice(0, 500),
    },
    path: 'fallback',
    result: triage,
  };
}

async function triagePhase(task, issue) {
  const cfg = cfgOf(task);
  // A new triage cycle starts with no advisor plan: one left from an earlier
  // cycle describes other work, and a `simple` verdict never reaches the advisor
  // to replace it.
  task.advisorPlan = null;
  const onEvent = claudeLogger(task, 'triage');
  const startedAt = Date.now();
  const tune = tunedSession(task, 'triage', { cfg });
  const triage = await nudgedSession(task, 'triage', {
    machine: machineOf(task),
    cwd: task.worktreePath,
    ...tune,
    maxTurns: 15,
    onEvent,
    canUseTool: taskCanUseTool(task, 'triage'),
    hooks: ghGateHooks(task, 'triage'),
    prompt: renderPrompt('triage', {
      ...promptVarsFor(task, 'triage'),
      issueNumber: issue.number,
      issueTitle: issue.title,
      issueLabels: issue.labels.join(', ') || '(ninguno)',
      issueBody: issue.body || '(vacío)',
      // Triage plans the work that comes after it, not its own reading.
      workPlan: workPlanContract('el trabajo que hará falta para resolver este issue, tal y como lo ves ahora'),
      // No stack or no QA config: nothing to drive in a browser, and triage must not propose it.
      qaAvailable: !(cfg.stack == null || cfg.qa == null),
    }),
  });
  if (!triage.ok) throw triage.quota ? new QuotaExhausted('triage') : new Error(`Triage failed: ${triage.error ?? 'no result'}`);

  const { verdict } = await triageVerdictFor(task, triage, { cfg, onEvent });
  task.complexity = verdict.complexity;
  task.triageSummary = verdict.summary;
  store.addLog(task, 'triage', `veredicto: ${verdict.complexity} — ${verdict.reason}`);
  store.touch(task);

  // The split triage saw is the fix planner's starting point, so the two
  // readings of the issue are compared instead of made twice from scratch.
  const plan = await workPlanFrom(task, 'triage', triage, {
    machine: machineOf(task), cwd: task.worktreePath, model: tune.model, tuning: tune, onEvent,
  });
  reportParallelism(task, 'triage', plan, triage.toolCounts, Date.now() - startedAt);
  task.triagePlan = plan;
  store.touch(task);

  // What a tester would do in the browser, decided before any code exists.
  // Refined later, at the phase, with the fix and the e2e run in hand.
  const qaPlan = await taggedFrom(task, 'triage', triage, {
    read: readQaPlan, tag: QA_PLAN_TAG, machine: machineOf(task), cwd: task.worktreePath, model: tune.model, tuning: tune, onEvent,
  });
  if (qaPlan) {
    // A fresh triage plan is a new starting point: whatever an earlier cycle
    // of this same task's Browser QA had carried belongs to code that no
    // longer describes this task.
    task.qa = { ...(task.qa ?? {}), ui: qaPlan.ui, initial: qaPlan, carry: null };
    store.addLog(task, 'qa', qaPlan.ui
      ? `the issue has UI: ${scenariosOf(qaPlan.steps).length} scenario(s), ${qaPlan.steps.length} Browser QA step(s) proposed`
      : 'the issue has no UI: Browser QA will not apply');
    if (qaPlan.ui) warnScenarioCap(task, qaPlan.steps);
    store.touch(task);
  }

  if (verdict.complexity === 'complex') {
    const advise = tunedSession(task, 'advisor', { cfg });
    store.addLog(task, 'advisor', `complex task: consulting ${advise.model} as advisor`);
    await advisorPlanFor(task, {
      advise,
      prompt: renderPrompt('advisor', {
        ...promptVarsFor(task, 'advisor'),
        issueNumber: issue.number,
        issueTitle: issue.title,
        triageSummary: verdict.summary,
        issueBody: issue.body || '(vacío)',
      }),
    });
  }
}

/**
 * Asks the advisor for its plan and stores it as `task.advisorPlan` only if it
 * is one. The advisor fans out like every phase, and a turn that ends on «the
 * subagents are still running, I continue when they report» used to be stored
 * as the plan and handed to the fix as its own. So the answer is checked
 * (`advisorPlanProblems`) and, when it fails, asked for again in the same
 * session, up to `config.retry.max` times — the shape of `readWorkPlanFrom`.
 *
 * Both advisor sites (the triage and the change request) go through here. When
 * no plan arrives `advisorPlan` is cleared, not left: a plan from an earlier
 * cycle describes other work.
 */
export async function advisorPlanFor(task, { advise, prompt, onEvent = claudeLogger(task, 'advisor') }) {
  const options = {
    machine: machineOf(task),
    cwd: task.worktreePath,
    ...advise,
    onEvent,
    hooks: ghGateHooks(task, 'advisor'),
  };
  let result = await runClaude({ ...options, maxTurns: 30, prompt });
  const textOf = (r) => (r.ok ? answerOf(r, (t) => !advisorPlanProblems(t).length, sealedAnswerNote(task, 'advisor', r)) : '');
  let text = textOf(result);
  let problems = advisorPlanProblems(text);
  const max = config.retry?.max ?? 3;
  // A session that died against the account's limit gains nothing from more
  // asks; the same goes for one with no id to resume.
  for (let n = 1; problems.length && result.sessionId && !result.quota && n <= max; n += 1) {
    store.addLog(task, 'advisor', `⚠️ the advisor's answer is not a plan (${problems.join('; ')}); asking again (${n} of ${max})`);
    const again = await runClaude({
      ...options,
      maxTurns: 3,
      resume: result.sessionId,
      prompt: advisorPlanComplaint(problems).trim(),
    });
    result = again.sessionId ? again : { ...again, sessionId: result.sessionId };
    text = textOf(again);
    problems = advisorPlanProblems(text);
  }
  if (problems.length) {
    task.advisorPlan = null;
    store.addLog(task, 'advisor', `the advisor returned no usable plan (${problems.join('; ')}); continuing without it`);
  } else {
    task.advisorPlan = advisorPlanText(text);
    store.addLog(task, 'advisor', 'advisor plan received');
  }
  store.touch(task);
  return task.advisorPlan;
}

/** The advisor's prompt for a change request: the template is for the issue, this is for the review. */
export function changeRequestAdvisorPrompt(issue, brief) {
  return `Actúa como ADVISOR para atender esta petición de cambios en el PR de la tarea #${issue.number}. El requisito original ya está implementado; aquí solo se resuelve lo que pide el revisor.

${brief}

Produce un PLAN DE IMPLEMENTACIÓN conciso: enfoque, archivos a tocar y en qué orden, qué puede hacerse en paralelo con subagentes, y qué riesgos de regresión vigilar. Abre tu respuesta final con \`${ADVISOR_PLAN_HEADING}\`. NO implementes nada.
${COLLECT_RULE}`;
}

/**
 * The planning half of the fix: analyse, split the work, decide what can run
 * at once — read-only, on the cheaper model, before a single file is edited.
 *
 * This is what turns the fix's parallelism from a hope into a decision the
 * board has read and checked. It is also the only place the retry-once rule can
 * live for the fix: this call leaves no trace, so asking again is free of
 * consequences, while the execution call commits.
 */
async function planFix(task, issue, planSection, extraContext, { resume = null, feedback = null, rejectedText = null } = {}) {
  const stage = 'plan';
  const feed = planningFeed(task, claudeLogger(task, stage));
  const { onEvent } = feed;
  const cfg = cfgOf(task);
  const tune = tunedSession(task, 'plan', { cfg });
  const { model } = tune;
  const machine = machineOf(task);
  const startedAt = Date.now();
  const revising = Boolean(feedback);
  try {
    store.addLog(task, stage, revising
      ? `redoing the plan with the changes you asked for, with ${model}, without editing anything`
      : `analyzing and splitting the work with ${model}, without editing anything`);

    const seed = task.triagePlan
      ? `\n\nEl triage propuso este reparto de partida; confírmalo o cámbialo con lo que encuentres:\n${renderWorkPlan(task.triagePlan)}\n`
      : '';
    // A fresh session has none of the first plan's conversation: it gets the
    // plan that was turned down and what was asked, in full.
    const changes = revising
      ? `${rejectedText ? `\n\nThis is the plan proposed earlier, which the person turned down:\n${rejectedText}\n` : ''}\n\nThe person reviewed the previous plan and asks for changes:\n${feedback}\n`
      : '';
    const common = {
      machine, cwd: task.worktreePath, ...tune, maxTurns: 30, onEvent,
      canUseTool: taskCanUseTool(task, stage), hooks: ghGateHooks(task, stage),
    };

    let result = null;
    if (revising && resume) {
      // The session that wrote the plan already read the code and knows why
      // the split was what it was: it redoes the plan instead of starting over.
      store.addLog(task, stage, 'resuming the session that wrote the previous plan');
      const resumeOnce = () => fixHooks.runClaude({
        ...common,
        resume,
        prompt: renderPrompt('plan-revise', { ...promptVarsFor(task, stage), feedback, processRule: processRuleFor(machine) }),
      });
      const failed = (r) => !r.ok && !r.resultText;
      result = await resumeOnce();
      // Only a session that is gone sends the work to a fresh one at once;
      // anything else may be a hiccup, and that session is worth one more try.
      if (failed(result) && !MISSING_SESSION.test(result.error ?? '')) {
        store.addLog(task, stage, `⚠️ the plan session did not answer (${result.error ?? 'no result'}); resuming it again`);
        result = await resumeOnce();
      }
      if (failed(result)) {
        store.addLog(task, stage, `⚠️ could not resume the plan session (${result.error ?? 'no result'}); planning in a new session with the rejected plan and the changes`);
        result = null;
      }
    }
    if (!result) {
      result = await fixHooks.runClaude({
        ...common,
        prompt: renderPrompt('fix-plan', {
          ...promptVarsFor(task, stage),
          issueNumber: issue.number,
          issueTitle: issue.title,
          branch: task.branch,
          issueBody: issue.body || '(vacío)',
          planSection: planSection + seed,
          extraContext: `${extraContext}${changes}`,
          processRule: processRuleFor(machine),
        }),
      });
    }
    // Out of quota there is no plan to be had and no point asking again: the
    // run stops here and the planning happens when the window reopens. Falling
    // through to «el fix sigue sin plan» would open an unplanned fix session
    // against the same wall.
    if (result.quota) {
      store.addLog(task, stage, `⏳ quota exhausted while planning: it replans on its own ${describeResume(quotaHold())}`);
      throw new QuotaExhausted('fixing');
    }
    if (!result.ok && !result.resultText) {
      const problem = `the plan call failed (${result.error ?? 'no result'})`;
      store.addLog(task, stage, `⚠️ ${problem}${revising ? '' : '; the fix still has no plan'}`);
      return { plan: null, brief: null, problem };
    }
    // The task sessions of the executor fork from here: this session has read
    // the code and knows why the split is what it is.
    task.planSessionId = result.sessionId ?? null;

    // `brief: true`: what this phase produces is what a person reads to
    // approve it, so the prose that opens it is part of the deliverable and is
    // asked for in the same retry as the tagged line.
    const { plan, brief, problem } = await readWorkPlanFrom(task, stage, result, {
      machine, cwd: task.worktreePath, model, tuning: tune, onEvent, run: fixHooks.runClaude,
      giveUp: revising ? 'not continuing without the plan you asked for' : 'continuing without a plan',
      brief: true,
    });
    reportParallelism(task, stage, plan, result.toolCounts, Date.now() - startedAt);
    if (plan) {
      const { total, rounds, independent } = planStats(plan);
      store.addLog(task, stage, `plan ready: ${total} task${total === 1 ? '' : 's'} in ${rounds} round${rounds === 1 ? '' : 's'}, ${independent} can start at once`);
    }
    return { plan, brief, problem };
  } finally {
    feed.stop();
  }
}

// ---------------------------------------------------------------------------
// The fix plan, told in the principal chat. These bubbles are the board's own
// and display-only, like `bringMain`'s notes: no `chat.pending`, never part of
// a prompt. One message per plan version, patched through its life:
// planning → pending → revise | approved | failed.

/** The shortest gap between two progress lines on a planning bubble. */
export const PLAN_PROGRESS_MS = 2000;

/** Past this a change request is clipped: the prompt and the bubbles only grow. */
export const MAX_PLAN_FEEDBACK = 4000;

/** How the CLI says a resumed session does not exist (moved, or cleaned up). */
const MISSING_SESSION = /no conversation found|conversation not found|session not found|no such session/i;

/** Patches the task-scope plan bubble `messageId`, if it is still in the chat. */
function patchPlanBubble(task, messageId, patch) {
  if (!messageId) return null;
  const chat = principalChat(task);
  const message = chat?.messages.find((m) => m.id === messageId) ?? null;
  if (message) store.updateChat(task, chat, message, { patch });
  return message;
}

/** «📋 3 tareas · 2 ⚡ → 1»: how a plan runs, in one line. */
function planWavesSummary(record) {
  const n = record.tasks.length;
  // ⚡ marks the widest wave(s) — ties all get it — and nothing when no wave
  // runs more than one task. The web's `laneSummary` draws the same line.
  const widest = Math.max(0, ...record.waves.map((w) => w.length));
  const waves = record.waves.map((w) => (widest > 1 && w.length === widest ? `${w.length} ⚡` : String(w.length))).join(' → ');
  return `${n} tarea${n === 1 ? '' : 's'} · ${waves}`;
}

/**
 * Opens the next plan version: `task.planning` and its bubble. Before the
 * planning call, so the card and the chat say so while it runs.
 */
function beginPlanning(task, { kind, feedback = null }) {
  const version = (task.planVersion ?? 0) + 1;
  const startedAt = new Date().toISOString();
  const chat = principalChat(task);
  const message = chat
    ? store.pushChat(task, chat, { role: 'plan', source: 'board', scope: 'task', version, kind, status: 'planning', progress: null, ts: startedAt })
    : null;
  task.planning = { version, kind, startedAt, feedback, messageId: message?.id ?? null };
  store.touch(task);
  return task.planning;
}

/** The planning in flight ended without a plan: cleared, and its bubble says why. */
function failPlanning(task, reason) {
  const planning = task.planning;
  if (!planning) return;
  task.planning = null;
  patchPlanBubble(task, planning.messageId, { status: 'failed', error: reason, progress: null, decidedAt: new Date().toISOString() });
  store.touch(task);
}

/** The last useful line of a planning session, for its bubble. */
function planProgressLine(ev) {
  const clip = (s) => (s.length > 200 ? `${s.slice(0, 199)}…` : s);
  if (ev.kind === 'text') {
    const line = String(ev.text ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    return line ? clip(line) : null;
  }
  if (ev.kind === 'tool') return clip(`🔧 ${ev.name}: ${ev.input ?? ''}`);
  return null;
}

/**
 * The planning session's events: logged as always, and the latest useful
 * line put on the bubble at most every `PLAN_PROGRESS_MS` — a burst of tool
 * calls is one patch, and the last line of the burst still lands.
 */
function planningFeed(task, logger) {
  const messageId = task.planning?.messageId ?? null;
  let last = 0;
  let line = null;
  let timer = null;
  const flush = () => {
    timer = null;
    if (line === null || task.planning?.messageId !== messageId) return;
    last = Date.now();
    patchPlanBubble(task, messageId, { progress: line });
    line = null;
  };
  return {
    onEvent: (ev) => {
      logger(ev);
      if (!messageId) return;
      const next = planProgressLine(ev);
      if (!next) return;
      line = next;
      const wait = PLAN_PROGRESS_MS - (Date.now() - last);
      if (wait <= 0) flush();
      else if (!timer) { timer = setTimeout(flush, wait); timer.unref?.(); }
    },
    stop: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      line = null;
    },
  };
}

/** What the branch already holds, for a fix session that continues rather than starts. */
export async function continuationContext(task) {
  const machine = machineOf(task);
  const cwd = task.worktreePath;
  const base = baseOf(task);
  const [log, files, status] = await Promise.all([
    machine.exec('git', ['log', '--oneline', '--no-decorate', `origin/${base}..HEAD`], { cwd }),
    machine.exec('git', ['-c', 'core.quotePath=false', 'diff', '--name-only', `origin/${base}...HEAD`], { cwd }),
    machine.exec('git', ['-c', 'core.quotePath=false', 'status', '--porcelain'], { cwd }),
  ]);
  const lines = (r) => (r.ok ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []);
  const branchFiles = lines(files);
  // Build debris (the R6 spec fixtures) is not the session's unfinished work;
  // count only dirt in files this branch touches, as `pendingWork` does.
  // `statusPaths` copes with the trimmed lines, which a `slice(3)` does not.
  const dirty = lines(status).filter((l) => statusPaths(l).some((p) => branchFiles.includes(p))).length;
  return continuationBrief({ branch: task.branch, commits: lines(log), files: branchFiles, dirty, lastError: task.lastError, base });
}

/** Seams for tests: the Claude calls of the fix phase, without starting sessions. */
export const fixHooks = { runClaude: (options) => runClaude(options) };

/** The fix phase, for tests that drive it directly. */
export const fixPhaseOf = (task, issue, extraContext, options) => fixPhase(task, issue, extraContext, options);

async function fixPhase(task, issue, extraContext = '', { continuing = false } = {}) {
  const cfg = cfgOf(task);
  // The baseline for "did this session do anything": a branch that already
  // carries commits would otherwise report success for a session that changed
  // nothing at all.
  const headBefore = await headCommit(machineOf(task), task.worktreePath);
  const planSection = task.advisorPlan
    ? `\n\nPLAN DEL ADVISOR (${cfg.claude.advisorModel}) — síguelo salvo que encuentres una razón concreta para desviarte, y dila:\n${task.advisorPlan}\n`
    : '';

  // Plan first, then execute with the plan in hand. The plan is a graph the
  // board validates, and the board runs it: one session per task, every
  // ready task at once. A continuation reviews work that exists; planning a
  // split for that is the wrong tool, so it goes straight to one session.
  let plan = null;
  // A plan that moved here with the task was made reading the other machine's
  // tree, and its sessions forked from a planning session left behind there:
  // it is planned again, from it. Also for a continuation — arriving with
  // commits on the branch sends the approved plan down that path, and
  // skipping the planning there would throw the plan away unseen.
  const moved = task.workPlan?.replan ? task.workPlan : null;
  // Changes you asked for on a plan are planning work too, also on a branch
  // that already carries commits: skipping here would drop them unseen.
  if (!continuing || moved || task.planFeedback) {
    // A record from before — approved and waiting, stopped, or failed —
    // is where a retry or a restart picks the plan up, not from scratch.
    let record = task.workPlan?.status && !moved ? task.workPlan : null;
    if (record) {
      task.planFeedback = null;
      task.planRejectedText = null;
    }
    // Both stay on the task until a new plan takes their place: a replanning
    // that fails, or a restart in the middle of it, leaves them for Retry.
    let feedback = task.planFeedback ?? null;
    let rejectedText = feedback ? task.planRejectedText ?? null : null;
    let seed = '';
    if (moved) {
      // `extraContext` already carries what the branch holds when it has commits.
      seed = `\n\nEste es el plan que se hizo cuando la tarea estaba en ${moved.replan.from}, leyendo el árbol de allí. Parte de él: confírmalo o cámbialo con lo que encuentres aquí.\n${moved.text || renderWorkPlan(moved)}\n`;
      store.addLog(task, 'plan', `the plan was made on ${moved.replan.from}: replanning on ${machineOf(task).name} starting from it`);
    }
    // The moved record stays, mark and all, until a new one takes its place:
    // a planning call that throws or finds no plan leaves it for Retry.
    let replaced = false;
    while (!record) {
      const revising = Boolean(feedback);
      // «Pedir cambios» opens the next version itself, in the same tick the
      // card turns busy; every other way in opens it here.
      if (!task.planning) beginPlanning(task, { kind: revising ? 'revise' : 'initial', feedback });
      let got;
      try {
        got = await planFix(task, issue, planSection, `${extraContext}${seed}`, {
          resume: revising ? task.planSessionId ?? null : null, feedback, rejectedText,
        });
      } catch (e) {
        // Never rewrapped: a quota stop is not a planning failure, and turning
        // it into a plain Error here would park the card in `error`.
        if (e instanceof QuotaExhausted) {
          failPlanning(task, 'no quota: planning resumes by itself when the account comes back');
          throw e;
        }
        const reason = revising ? `could not replan: ${e.message}` : e.message;
        failPlanning(task, reason);
        throw revising ? new Error(reason) : e;
      }
      plan = got.plan;
      const brief = got.brief ?? null;
      if (!plan && moved && !replaced) {
        // Not one unplanned session instead: that would drop a plan you
        // approved, unseen. Failing keeps it, and Retry plans from it again.
        task.workPlan = moved;
        const reason = `Could not replan on ${machineOf(task).name} the plan that came from ${moved.replan.from}; «Retry» tries again`;
        failPlanning(task, reason);
        store.touch(task);
        throw new Error(reason);
      }
      if (!plan && revising) {
        // Never the unplanned fix here: it would throw away the changes you
        // asked for. The task stops in error with them kept, and Retry
        // replans with the same request.
        const reason = `could not replan: ${got.problem ?? 'no usable plan'}`;
        failPlanning(task, reason);
        throw new Error(reason);
      }
      if (!plan) {                                       // no usable plan: one session, as before
        failPlanning(task, `no usable plan (${got.problem ?? 'no result'}): the fix goes on without a plan`);
        break;
      }
      const planning = task.planning;
      // The prose first, the table after: what the approval dialog shows is
      // `record.text`, and a manifest of file paths is not something anyone
      // can say yes to. Without a brief this is exactly the old text.
      record = newPlanRecord({ id: `fix-${Date.now().toString(36)}`, text: planText(brief, plan), ...plan });
      record.forkFrom = task.planSessionId ?? null;
      record.version = planning?.version ?? (task.planVersion ?? 0) + 1;
      record.messageId = planning?.messageId ?? null;
      // What was asked for to get this version, for «Cambios que pediste».
      record.feedback = planning?.feedback ?? (revising ? feedback : null);
      task.planVersion = record.version;
      task.workPlan = record;
      task.planning = null;
      task.planFeedback = null;
      task.planRejectedText = null;
      replaced = true;
      const wanted = approvePlanWanted(task);
      patchPlanBubble(task, record.messageId, {
        status: wanted ? 'pending' : 'approved',
        progress: null,
        tasks: structuredClone(record.tasks),
        waves: structuredClone(record.waves),
        plan: record.text,
        summary: planWavesSummary(record),
        ...(wanted ? {} : { selected: [...record.selected], decidedAt: new Date().toISOString() }),
      });
      store.touch(task);
      if (!wanted) break;
      const decision = await awaitPlanApproval(task, record);
      if (decision.action === 'approve') break;
      // Decided while the account had no quota: the record keeps the decision
      // (approved with its selection, or the changes asked for on the task),
      // and this run stops here rather than opening a session against a wall.
      if (decision.action === 'quota') throw new QuotaExhausted('fixing');
      if (decision.action !== 'revise') {
        // Only «Aprobar» and «Pedir cambios» answer a plan. Anything else is
        // not a request to replan with nothing asked: stop, keeping the plan.
        throw new Error(`Waiting on plan v${record.version} ended without approving it or asking for changes (${decision.action ?? 'no decision'})`);
      }
      feedback = decision.feedback ?? task.planFeedback ?? null;
      rejectedText = record.text;
      record = null;
      task.workPlan = null;
      if (task.state !== 'fixing') store.setState(task, 'fixing');
    }
    if (record) {
      await runFixPlan(task, issue, record);
      plan = null;                                        // the executor already reported
      extraContext = `${extraContext}\n${closingContext(record)}`;
    }
  }
  if (!task.workPlan?.status) task.workPlan = plan;
  store.touch(task);

  const startedAt = Date.now();
  releasePrincipal(task);
  const result = await fixHooks.runClaude({
    machine: machineOf(task),
    cwd: task.worktreePath,
    ...tunedSession(task, 'fix', { cfg }),
    maxTurns: maxTurnsFor('fix', cfg),
    resume: principalChat(task)?.sessionId ?? undefined,
    onEvent: claudeLogger(task, 'fix'),
    canUseTool: taskCanUseTool(task, 'fix'),
    hooks: ghGateHooks(task, 'fix'),
    prompt: renderPrompt('fix', {
      ...promptVarsFor(task, 'fix'),
      issueNumber: issue.number,
      issueTitle: issue.title,
      branch: task.branch,
      issueBody: issue.body || '(vacío)',
      planSection,
      extraContext,
      workPlanSection: plan ? renderWorkPlan(plan) : '',
      // `?? ''`: `renderPrompt` refuses a variable whose value is `undefined`,
      // and a project with no `e2e` section has no port variable to name. The
      // prompt then says less; the phase still runs.
      e2ePortEnv: cfg.e2e?.portEnv ?? '',
      processRule: processRuleFor(machineOf(task)),
      shellRule: shellRuleFor(machineOf(task)),
      tmpRule: tmpRuleFor(machineOf(task)),
    }),
  });
  noteMaxTurns(task, 'fix', result, maxTurnsFor('fix', cfg));
  // Before judging the commit: a session that died halfway still says how it
  // was working, and that is the part being measured here.
  if (plan) reportParallelism(task, 'fix', plan, result.toolCounts, Date.now() - startedAt);

  if (result.sessionId) {
    principalChat(task).sessionId = result.sessionId;
    store.touch(task);
  }
  // Judge the fix by what it left behind, not by how the session ended: a
  // committed change is a done fix even if the CLI exited badly afterwards.
  const headAfter = await headCommit(machineOf(task), task.worktreePath);
  const committed = Boolean(headAfter) && headAfter !== headBefore
    && await hasCommits(machineOf(task), task.worktreePath, { base: baseOf(task) });
  if (committed) {
    task.fixedAt = headAfter;
    store.touch(task);
  }
  // The account ran out mid-fix. Whatever the session committed is banked
  // above and stays on the branch; the run stops here rather than reporting a
  // fix that never happened, and comes back to this same phase — which skips
  // the work already committed.
  if (result.quota) {
    store.addLog(task, 'fix', committed
      ? `⏳ quota exhausted after committing at ${headAfter.slice(0, 8)}: the work stays on the branch and the task resumes on its own ${describeResume(quotaHold())}`
      : `⏳ quota exhausted during the fix: what the session left in the worktree is kept and the task resumes on its own ${describeResume(quotaHold())}`);
    throw new QuotaExhausted('fixing');
  }
  // A continuation that added nothing and ended well is the session saying
  // "it was already complete" — the one case where no new commit is success.
  if (!committed && continuing && result.ok && headAfter) {
    task.fixedAt = headAfter;
    task.lastError = null;
    store.addLog(task, 'fix', `the session reviewed the branch and added nothing: the fix is taken as complete at ${headAfter.slice(0, 8)}`);
    store.touch(task);
    return;
  }
  if (!committed) {
    // Say what actually happened: the session ended and the branch has no
    // commit of its own. "sin commits sobre origin/<base>" read as if the task
    // had been on the base branch, or pushing to it — it never was.
    throw new Error(result.ok
      ? `The fix session ended without committing: branch ${task.branch} is the same as origin/${baseOf(task)}. If the work is in the worktree, commit it from the chat and press «Continue from tests».`
      : `The fix phase failed: ${result.error ?? 'the session ended with an error'}`);
  }
  if (!result.ok) {
    store.addLog(task, 'fix', `the session ended with an error (${result.error}) but the commit exists; continuing`);
  }
}

/**
 * The board running the fix's plan: one session per task, forked from the
 * planning session, every ready task at once. Ends with the record `done`,
 * or throws with what stopped it — which is what «Reintentar» continues.
 */
async function runFixPlan(task, issue, record) {
  store.setState(task, 'fixing');
  const host = fixPlanHost(task, record);
  const plan = ['stopped', 'failed'].includes(record.status)
    ? await continuePlan(record, host)
    : await runPlan(record, host);
  store.touch(task);
  if (plan.status !== 'done') {
    // The executor stopped because the account ran out, not because the work
    // failed: the record is `stopped` with every commit it made on disk, and
    // `continuePlan` — which is what the fix phase does on the way back — is
    // exactly the resumption. It must not reach `error`.
    // `quotaStopped` is this plan's own session hitting the wall. The hold is
    // the other way in: a hold opened by *another* task makes `parkTaskPending`
    // answer the board's question with «stop», which stops the plan without
    // that flag — and the plain error below would park the card in `error`,
    // which is exactly the click nobody is there to make.
    if (plan.quotaStopped || quotaHoldsNewWork(task)) {
      store.addLog(task, 'plan', `⏳ quota exhausted: the plan is stopped at ${planSummaryLine(plan)} and continues on its own ${describeResume(quotaHold())}`);
      throw new QuotaExhausted('fixing');
    }
    const failed = plan.tasks.filter((t) => t.status === 'failed').map((t) => `${t.id} (${t.attempts} intentos)`);
    throw new Error(`The plan stopped at ${plan.status}: ${planSummaryLine(plan)}${failed.length ? ` — failed: ${failed.join(', ')}` : ''}. «Retry» continues from there.`);
  }
}

/** What the closing session is told about what the executor did. */
function closingContext(record) {
  const done = record.tasks.filter((t) => t.status === 'done');
  const lines = done.map((t) => `- **${t.id}** ${t.what}${t.attempts > 1 ? ` (${t.attempts} intentos)` : ''}${t.filesChanged?.length ? ` — ${t.filesChanged.map((f) => f.path).join(', ')}` : ''}: ${(t.summary ?? '').slice(0, 600)}`);
  return `\nEL TABLERO YA EJECUTÓ EL PLAN: cada tarea corrió en una sesión propia y dejó sus cambios en el worktree, SIN commit. Esto hizo cada una:\n${lines.join('\n')}\n\nTu trabajo ahora es cerrar: revisa \`git status\` y el diff completo de la rama, pasa las verificaciones de lo tocado, corrige lo que haga falta, y haz el commit único. No rehagas lo que ya está hecho.\n`;
}

/** Makes each `worktreeFingerprint` temp index name unique within this process. */
let fingerprintSeq = 0;

/**
 * The content of a worktree as one git tree id: tracked and untracked
 * (non-ignored) files, content only. The plan executor compares it across two
 * failed checks to tell «the session changed nothing» (see `isUnrecoverable`
 * in planexec.js).
 *
 * Built in a throwaway copy of the index, never the real one: sibling sessions
 * of the same wave are using the worktree, and a `git add` on the real index
 * would stage their work and fight them for `index.lock`. The copy keeps the
 * stat cache, so `add -A` only rehashes what changed — and the stat-only noise
 * a build leaves behind (thousands of files in hfs) does not change the tree.
 * The temp name is per call because two tasks of one wave can fail at once.
 * Any failure returns null, which turns detection off: never a false positive.
 */
async function worktreeFingerprint(machine, cwd, tag) {
  const git = (args, env) => machine.exec('git', args, { cwd, env, timeoutMs: 120_000 });
  const gitPath = async (name) => {
    const r = await git(['rev-parse', '--git-path', name]);
    const p = r.ok ? r.stdout.trim() : '';
    return p ? machine.path.resolve(cwd, p) : null;
  };
  let tmp = null;
  try {
    const idx = await gitPath('index');
    tmp = await gitPath(`hfsmon-fingerprint-${String(tag).replace(/[^\w.-]/g, '_')}-${process.pid}-${fingerprintSeq++}.index`);
    if (!idx || !tmp) return null;
    // Git replaces the index by lock + rename, so the copy is always whole.
    await machine.fs.copy(idx, tmp);
    const env = { GIT_INDEX_FILE: tmp };
    if (!(await git(['add', '-A'], env)).ok) return null;
    const tree = await git(['write-tree'], env);
    const id = tree.ok ? tree.stdout.trim() : '';
    return /^[0-9a-f]{40,64}$/.test(id) ? id : null;
  } catch {
    return null;
  } finally {
    if (tmp) {
      await machine.fs.rm(tmp).catch(() => {});
      await machine.fs.rm(`${tmp}.lock`).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Repairing the plan from inside a task's own session (planchange.js). Shared
// by both plan hosts: what differs is only where the person is asked.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Unique per question: the executor may re-ask without bumping `attempts`, and an id that repeats would answer the wrong wait. */
const askSuffix = () => Date.now().toString(36);

/** The ids of a task's plan-change questions all start with this. */
const proposalPrefix = (record, t) => `planchange:${record.id}:${t.id}:`;

/** What a proposal's wait resolves to when nobody answered (timeout, skip, expiry, no quota). */
const NO_ANSWER = Object.freeze({ approve: false, note: null, none: true });

const withStop = (problem) => `${problem}${/[.!?]$/.test(problem) ? '' : '.'}`;

/**
 * One `propose_change` call: validate, ask the person, apply. Nothing changes
 * without a yes, and the yes is re-checked against the plan as it is by then (a
 * sibling task may have added an id meanwhile, or the plan may have stopped).
 * `busy()` says whether the slot for a question is taken — a proposal never
 * overwrites another question; `ask(question)` resolves the decision.
 */
async function proposePlanChange({ task, record, t, args, busy, ask, changedFor, onChange }) {
  const first = validatePlanChange(record, t.id, args);
  if (!first.ok) return { ok: false, text: `${withStop(first.problem)} Corrígelo y vuelve a proponerlo, o sigue sin cambiar el plan.` };
  if (busy()) return { ok: false, text: 'Hay otra pregunta pendiente en esta tarea; vuelve a proponerlo en un momento.' };

  // Through the same normalization as the board's ask (header length, preview kept apart).
  const pq = planChangeQuestion(record, first.change);
  const norm = normalizeQuestions(pq);
  if (!norm.ok) return { ok: false, text: `No se pudo preguntar a la persona: ${withStop(norm.problem)}` };
  const decision = await ask({ questions: norm.questions, preview: pq.questions[0].preview });
  if (decision?.none) return { ok: false, text: 'Nadie respondió a la propuesta; sigue sin cambiar el plan.' };
  if (!decision?.approve) return { ok: false, text: `La persona no aplicó el cambio${decision?.note ? `: ${decision.note}` : '.'}` };

  if (record.status !== 'running') return { ok: false, text: 'El plan ya no está en ejecución; el cambio no se aplicó.' };
  const again = validatePlanChange(record, t.id, args);
  if (!again.ok) return { ok: false, text: withStop(again.problem) };
  const line = applyPlanChange(record, again.change);
  store.addLog(task, 'plan', line);
  onChange();
  changedFor.add(t.id);
  return { ok: true, text: 'Aplicado. El tablero vuelve a ejecutar la comprobación al terminar tu turno.' };
}

/** The repair turn's prompt: the failure, the check, and the way out through the plan. */
function repairPromptFor(task, machine, stage, t) {
  return renderPrompt('plan-repair', {
    ...promptVarsFor(task, stage),
    taskId: t.id, what: t.what, check: t.check ?? '(sin comprobación)',
    output: lastLines(t.lastFailure?.output, 60),
    files: t.files.map((f) => `\`${f}\``).join(', ') || '(los que haga falta)',
    hint: t.hint ? `\nIndicación de la persona: ${t.hint}\n` : '',
    processRule: processRuleFor(machine),
    shellRule: shellRuleFor(machine),
    tmpRule: tmpRuleFor(machine),
  });
}

/** The executor's host for the fix phase: forks from the plan session, logs, asks with a deadline. */
function fixPlanHost(task, record) {
  const cfg = cfgOf(task);
  const machine = machineOf(task);
  const cwd = task.worktreePath;
  const runs = new Map();
  let lastProgress = null;
  // Tasks whose plan change the person approved since the last repair turn began.
  const changedFor = new Set();
  const onChange = () => {
    // The approved plan's bubble follows the run, one line per change.
    const progress = planSummaryLine(record);
    if (record.messageId && progress !== lastProgress) {
      lastProgress = progress;
      patchPlanBubble(task, record.messageId, { progress });
    }
    store.touch(task);
  };
  const propose = (t) => (args) => proposePlanChange({
    task, record, t, args, changedFor, onChange,
    busy: () => Boolean(task.pending),
    ask: (question) => new Promise((resolve) => parkTaskPending(task, {
      id: `${proposalPrefix(record, t)}${askSuffix()}`, kind: 'question', source: 'board', phase: 'plan',
      questions: question.questions, preview: question.preview, resolve, timeoutMs: askTimeoutMs(),
      decode: (answers) => readPlanChangeDecision(Object.values(answers)[0]), none: NO_ANSWER,
    })),
  });
  const mcpServers = (t) => planChangeMcpServers({ onPropose: propose(t), timeoutMs: askTimeoutMs() });
  // A session cut mid-proposal leaves the question parked: nobody can answer it any more.
  const expireProposal = (t) => {
    if (String(task.pending?.id ?? '').startsWith(proposalPrefix(record, t))) expireTaskPending(task, 'the session ended');
  };
  return {
    forkFrom: record.forkFrom ?? null,
    maxRetries: config.plan?.maxRetries ?? 3,
    log: (line) => store.addLog(task, 'plan', line),
    onChange,
    runSession: async ({ task: t, attempt, resume, fork }) => {
      const upstream = t.dependsOn.map((d) => record.tasks.find((x) => x.id === d)).filter((d) => d?.summary);
      const prompt = attempt === 1 || !t.lastFailure
        ? renderPrompt('plan-task', {
          ...promptVarsFor(task, `fix:${t.id}`),
          taskId: t.id, what: t.what, files: t.files.map((f) => `\`${f}\``).join(', ') || '(los que haga falta)',
          checkLine: t.check ? `- **Comprobación del tablero**: \`${t.check}\`\n` : '',
          upstream: upstream.length ? `\n\nLo que hicieron las tareas de las que dependes:\n${upstream.map((d) => `- **${d.id}** (${d.filesChanged.map((f) => `${f.path} +${f.added} −${f.removed}`).join(', ') || 'sin diff'}): ${d.summary.slice(0, 1500)}`).join('\n')}\n` : '',
          hint: t.hint ? `\n\nIndicación de la persona: ${t.hint}\n` : '',
          // See `fixPhase`: `renderPrompt` refuses a variable that is `undefined`.
          e2ePortEnv: cfg.e2e?.portEnv ?? '',
          processRule: processRuleFor(machine),
          shellRule: shellRuleFor(machine),
          tmpRule: tmpRuleFor(machine),
        })
        : renderPrompt('plan-retry', {
          ...promptVarsFor(task, `fix:${t.id}`),
          taskId: t.id, attempt, where: t.lastFailure.kind === 'check' ? `falló la comprobación \`${t.check}\`` : 'la sesión terminó con error',
          output: lastLines(t.lastFailure.output, 60),
          hint: t.hint ? `\nIndicación de la persona: ${t.hint}\n` : '',
        });
      const result = await fixHooks.runClaude({
        machine, cwd, ...tunedSession(task, 'fix', { stage: `fix:${t.id}`, cfg }),
        maxTurns: maxTurnsFor('fix', cfg),
        resume: resume ?? undefined, forkSession: fork,
        onQuery: (q) => runs.set(t.id, q),
        onEvent: claudeLogger(task, `fix:${t.id}`),
        canUseTool: taskCanUseTool(task, `fix:${t.id}`),
        hooks: ghGateHooks(task, `fix:${t.id}`),
        mcpServers: mcpServers(t),
        prompt,
      });
      noteMaxTurns(task, `fix:${t.id}`, result, maxTurnsFor('fix', cfg));
      runs.delete(t.id);
      expireProposal(t);
      return result;
    },
    // One more turn of the task's own session (resumed, never forked) over an
    // unrecoverable failure: it may fix code, or propose a plan change.
    repair: async (t) => {
      changedFor.delete(t.id);
      if (!t.sessionId) return { changed: false, quota: false };
      const result = await fixHooks.runClaude({
        machine, cwd, ...tunedSession(task, 'fix', { stage: `fix:${t.id}`, cfg }),
        maxTurns: maxTurnsFor('fix', cfg),
        resume: t.sessionId,
        onQuery: (q) => runs.set(t.id, q),
        onEvent: claudeLogger(task, `fix:${t.id}`),
        canUseTool: taskCanUseTool(task, `fix:${t.id}`),
        hooks: ghGateHooks(task, `fix:${t.id}`),
        mcpServers: mcpServers(t),
        prompt: repairPromptFor(task, machine, `fix:${t.id}`, t),
      });
      noteMaxTurns(task, `fix:${t.id}`, result, maxTurnsFor('fix', cfg));
      runs.delete(t.id);
      expireProposal(t);
      if (result?.sessionId) t.sessionId = result.sessionId;
      if (result?.quota) store.addLog(task, 'plan', `${t.id}: quota exhausted during the repair`);
      return { changed: changedFor.has(t.id), quota: Boolean(result?.quota) };
    },
    check: async (t) => {
      const r = await machine.posixShell(t.check, { cwd, timeoutMs: 20 * 60_000 }).catch((e) => ({ ok: false, stdout: '', stderr: e.message }));
      const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
      store.addLog(task, 'plan', `${t.id}: check \`${t.check}\` ${r.ok ? '✓' : `✗\n${lastLines(output, 8)}`}`);
      return { ok: Boolean(r.ok), output: lastLines(output, 80) };
    },
    fingerprint: (t) => worktreeFingerprint(machine, cwd, `fix-${t.id}`),
    filesChanged: async (t) => {
      if (!t.files.length) return [];
      const r = await machine.exec('git', ['diff', '--numstat', '--', ...t.files], { cwd });
      if (!r.ok) return [];
      return r.stdout.split(/\r?\n/).filter(Boolean).map((l) => {
        const [added, removed, ...rest] = l.split('\t');
        return { path: rest.join('\t'), added: Number(added) || 0, removed: Number(removed) || 0 };
      });
    },
    // Out of retries, or unrecoverable: the board asks, and waits as long as a question may —
    // then the safe answer is to stop, and «Reintentar» continues the plan.
    // It waits for a free slot and never overwrites another question.
    ask: async (t) => {
      while (task.pending) {
        if (record.status !== 'running') return { action: 'stop' };
        await sleep(1000);
      }
      return new Promise((resolve) => {
        const bq = boardQuestion({ taskId: t.id, what: t.what, attempts: t.attempts, failure: t.lastFailure });
        const norm = normalizeQuestions(bq);
        parkTaskPending(task, {
          id: `board:${record.id}:${t.id}:${t.attempts}:${askSuffix()}`, kind: 'question', source: 'board', phase: 'plan',
          questions: norm.questions, preview: bq.questions[0].preview, resolve, timeoutMs: askTimeoutMs(),
        });
      });
    },
    interrupt: (t) => { runs.get(t.id)?.interrupt?.().catch(() => {}); },
    close: async () => {},
  };
}

/**
 * How long a suite may run when the project does not say. Long, on purpose: a
 * suite cut short looks exactly like a suite that failed, and the only project
 * whose number is known (hfs, 60) is not a basis for guessing anyone else's.
 */
const E2E_TIMEOUT_DEFAULT_MINUTES = 60;

/**
 * One dependency install at a time per worktree — the same shape as
 * {@link gitMutex}, and keyed the same way. In-process is enough: every install
 * the board runs goes through {@link prepareDependencies}, and what removes the
 * race at its root is that the fix session no longer has a reason to install
 * anything itself — except in a blank repository, where there is no manifest
 * before the fix and the session's orchestrator installs once (fix.md says so);
 * the pipeline then re-runs the step after the fix.
 */
export const depsMutex = new Mutex();

/** What the board tells the project's dependency install is ready. */
const installedMarkerOf = (machine, task, cfg) =>
  machine.path.join(task.worktreePath, cfg.e2e.installedMarker ?? machine.path.join(cfg.e2e.relativeCwd ?? '.', 'node_modules'));

/**
 * The project's dependencies, installed in this worktree at most once.
 *
 * ## The mark of "already installed" is the artifact on disk
 *
 * Not a field on the task: dependencies belong to the MACHINE, and the task
 * travels. `move.js` nulls what is local to a machine, and `ensureWorktree`
 * re-creates a deleted worktree, both of which would leave such a field
 * true-but-false. Not a file of our own either: a move commits whatever is
 * dirty as WIP, so it would end up in the repository. With the probe on disk,
 * a restart and a move both just re-evaluate it — and on the destination
 * machine there are no dependencies, so it installs there.
 *
 * ## Why the probe is a key of its own (`e2e.installedMarker`)
 *
 * It used to be derived: `<worktree>/<relativeCwd>/node_modules`. For a project
 * whose `relativeCwd` is `'.'` while the command installs into a subdirectory
 * (`web/`), that probe can never be true, so the install ran again on every
 * attempt and every repair round; and the day a `node_modules` appeared at the
 * root for any other reason, the subdirectory's install would stop running for
 * ever. So the probe is declared, and defaults to what it used to derive —
 * which leaves hfs (`crates/ui/e2e`) exactly as it was.
 *
 * The right line for a project that installs into `web/` is
 * `"installedMarker": "web/node_modules/.package-lock.json"`: npm writes that
 * file at the END of a complete install, so an install cut halfway through does
 * not fool the probe.
 *
 * ## Three shapes of project
 *
 * - **`e2e.installCommand` declared** -> the explicit path above. Inside the
 *   mutex: the marker probe first, and only when the marker is missing, a guard
 *   that the install `cwd` exists (a wrong `relativeCwd` is a config error, and
 *   running a shell in a missing directory says nothing useful).
 * - **`e2e` exists without `installCommand`** -> `{ ok: true }`, no probe at
 *   all: the project said there is nothing to install.
 * - **`e2e` null or absent** (a project born without a suite) -> the manifests
 *   are autodetected: npm (root and `web/`, `client/`, `frontend/`), pip into a
 *   `.venv`, and cargo; see {@link autodetectDependencies}. No manifest means
 *   nothing to install (a blank repository).
 *
 * Returns `{ ok: true }`, or `{ ok: false, stage: 'install', tail }` — the
 * stage is what {@link infrastructureFailure} decides on.
 */
export function prepareDependencies(task, machine = machineOf(task), when = null) {
  // `when` says which call this is (during_triage, pre_fix, post_fix, repair, test), so the spans of one run can be told apart.
  return span(task, { kind: 'step', name: 'prepare_dependencies', when }, async (s) => {
    const deps = await installDependencies(task, machine);
    if (s) s.meta.ok = Boolean(deps?.ok);
    return deps;
  });
}

async function installDependencies(task, machine) {
  const cfg = cfgOf(task);
  if (cfg.e2e == null) return autodetectDependencies(task, machine);
  // A suite without an install command: there is no dependency step at all.
  if (!cfg.e2e.installCommand) return { ok: true };
  const cwd = machine.path.join(task.worktreePath, cfg.e2e.relativeCwd ?? '.');
  const marker = installedMarkerOf(machine, task, cfg);
  const timeoutMs = (cfg.e2e.timeoutMinutes ?? E2E_TIMEOUT_DEFAULT_MINUTES) * 60 * 1000;
  // Exclusive per worktree, and the probe INSIDE the critical section: the two
  // callers can reach here at once (a repair round and a change request share a
  // worktree), and a probe read outside would have both of them install over
  // the same tree — which is exactly what happened by hand in the fix session.
  return depsMutex.runExclusive(task.worktreePath, async () => {
    if (await machine.fs.exists(marker)) {
      store.addLog(task, 'deps', `dependencies already installed (${marker}); not reinstalled`);
      return { ok: true };
    }
    if (!(await machine.fs.exists(cwd))) {
      const tail = `the install directory ${cwd} does not exist (check the project's e2e.relativeCwd)`;
      store.addLog(task, 'deps', tail);
      return { ok: false, stage: 'install', tail };
    }
    store.addLog(task, 'deps', `installing dependencies: ${cfg.e2e.installCommand}`);
    const install = await machine.shell(cfg.e2e.installCommand, {
      cwd, timeoutMs, env: { ...(cfg.e2e.env ?? {}) }, onLine: (l) => store.addLog(task, 'deps', l),
    });
    if (!install.ok) {
      return { ok: false, stage: 'install', tail: [install.stdout, install.stderr].filter(Boolean).join('\n').slice(-4000) };
    }
    store.addLog(task, 'deps', 'dependencies ready ✅');
    return { ok: true };
  });
}

/** Where a worktree's own Python lives, and the file that says its install finished. */
const VENV_DIR = '.venv';
const VENV_MARKER = '.venv/.board-installed';
/** Cargo's marker lives in `target/`, which every Rust project already ignores. */
const CARGO_MARKER = 'target/.board-fetched';
/** The one-level subfolders a front end usually lives in; nothing else is scanned. */
const SUBFOLDERS = ['web', 'client', 'frontend'];
const AUTODETECT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * {@link prepareDependencies} for a project with no `config.e2e`: detect the
 * manifests instead of reading a command. Each ecosystem has its own marker, so
 * a finished install is never repeated and a half-finished one is:
 *
 * - `package.json` at the root, and in `web/` / `client/` / `frontend/` -> `npm install`
 *   (marker `node_modules/.package-lock.json`, npm writes it at the END).
 * - `requirements.txt` or `pyproject.toml` -> a `.venv` in the worktree (created
 *   when missing), then that venv's `python -m pip install -r requirements.txt`
 *   (`-e .` for a pyproject alone). Marker `.venv/.board-installed`, written by
 *   the board once pip succeeded.
 * - `Cargo.toml` -> `cargo fetch` (marker `target/.board-fetched`).
 *
 * No manifest at all means nothing to install, as before. The first failure
 * stops the rest and its last 20 lines of output go to the task log. The marker
 * is built directly, not with {@link installedMarkerOf}, which reads `cfg.e2e`
 * and has none here.
 */
async function autodetectDependencies(task, machine) {
  return depsMutex.runExclusive(task.worktreePath, async () => {
    const join = (...parts) => machine.path.join(task.worktreePath, ...parts);
    const has = (p) => machine.fs.exists(p);
    const steps = [];

    for (const dir of ['.', ...SUBFOLDERS]) {
      if (!(await has(join(dir, 'package.json')))) continue;
      steps.push({
        label: dir === '.' ? 'npm' : `npm (${dir}/)`,
        cwd: join(dir),
        marker: join(dir, 'node_modules/.package-lock.json'),
        commands: ['npm install'],
      });
    }

    const hasRequirements = await has(join('requirements.txt'));
    if (hasRequirements || await has(join('pyproject.toml'))) {
      // The command runs through the machine's shell (cmd.exe on Windows), where
      // forward slashes do not resolve a relative executable: join with the
      // machine's own separator and quote the result.
      const venvPython = `"${machine.platform === 'win32'
        ? machine.path.join(VENV_DIR, 'Scripts', 'python.exe')
        : machine.path.join(VENV_DIR, 'bin', 'python')}"`;
      const basePython = machine.platform === 'win32' ? 'python' : 'python3';
      const commands = [];
      if (!(await has(join(VENV_DIR)))) commands.push(`${basePython} -m venv ${VENV_DIR}`);
      commands.push(hasRequirements
        ? `${venvPython} -m pip install -r requirements.txt`
        : `${venvPython} -m pip install -e .`);
      steps.push({ label: 'pip', cwd: join('.'), marker: join(VENV_MARKER), commands, writeMarker: true });
    }

    if (await has(join('Cargo.toml'))) {
      steps.push({ label: 'cargo', cwd: join('.'), marker: join(CARGO_MARKER), commands: ['cargo fetch'], writeMarker: true });
    }

    if (!steps.length) {
      store.addLog(task, 'deps', 'no dependency manifest; nothing to install');
      return { ok: true };
    }

    for (const step of steps) {
      if (await has(step.marker)) {
        store.addLog(task, 'deps', `dependencies (${step.label}) already installed (${step.marker}); not reinstalled`);
        continue;
      }
      for (const command of step.commands) {
        store.addLog(task, 'deps', `installing dependencies (${step.label}): ${command}`);
        const install = await machine.shell(command, {
          cwd: step.cwd, timeoutMs: AUTODETECT_TIMEOUT_MS, env: {}, onLine: (l) => store.addLog(task, 'deps', l),
        });
        if (!install.ok) {
          const tail = [install.stdout, install.stderr].filter(Boolean).join('\n').slice(-4000);
          store.addLog(task, 'deps', `❌ ${command} failed (${step.label}); last lines:\n${lastLines(tail, 20)}`);
          return { ok: false, stage: 'install', tail };
        }
      }
      if (step.writeMarker) {
        try {
          await machine.fs.mkdir?.(machine.path.dirname(step.marker));
          await machine.fs.writeFile?.(step.marker, `${new Date().toISOString()}\n`);
        } catch (e) {
          store.addLog(task, 'deps', `⚠️ could not write the marker ${step.marker}: ${reasonOf(e)}; it reinstalls next time`);
        }
      }
      store.addLog(task, 'deps', `dependencias (${step.label}) listas ✅`);
    }
    return { ok: true };
  });
}

/**
 * The error an install failure becomes, wherever it is noticed. Never a round
 * of the fix — with ONE exception: `runPipeline`, right after the fix, gives a
 * failed install a single repair round, because there the manifest is the fix's
 * own (a scaffold it just created). Everywhere else no session can repair a
 * machine's dependencies from inside a prompt, and handing it this failure as
 * "the tests are red" burns one of its two iterations.
 */
const dependencyError = (reason) =>
  new Error(`Could not prepare the project dependencies (${reason}). This is not a fix failure: check the environment.`);

/**
 * ## The contract of `config.e2e`, and which of its keys are optional
 *
 * - **`e2e` absent or `null` -> the phase is skipped.** A project without a
 *   suite is not a project with a broken one.
 * - **No `testCommand` -> the phase is skipped too**, with the same note. There is
 *   nothing to run without it, and no default worth guessing: it would be
 *   hfs's. A profile may declare an `installCommand` and leave the tests for the
 *   person to add. Either way `task.verification` says `'none'`.
 * - `relativeCwd` defaults to `'.'` — the repository root, which is where a
 *   project whose tests are not in a subdirectory keeps them.
 * - `installCommand` is optional: no command, no dependency step, and the
 *   `installedMarker` probe that goes with it is not even made.
 * - `installedMarker` is optional, relative to the worktree, and defaults to
 *   `join(relativeCwd, 'node_modules')` — see {@link prepareDependencies} for
 *   why it is a key of its own and not derived from `relativeCwd`.
 * - `prepareCommand` is optional (`prepareTimeoutMinutes` defaults to 90).
 * - **`portEnv` + `portOffsets` + `portRange` are optional TOGETHER.** Either
 *   the project wants a verified-free port block named in an env var, or it
 *   wants none and the suite gets `e2e.env` and nothing else. Half of them is
 *   not a configuration: without a range there is nothing to scan, and
 *   `findFreePortBase` is not called at all.
 * - `timeoutMinutes` defaults to {@link E2E_TIMEOUT_DEFAULT_MINUTES}.
 * - `workers` defaults to 1, `env` to `{}`.
 * - `label` is optional: it names the project's verification in the text the fix
 *   agent receives when `testCommand` fails ({@link fixFailureBrief}). Absent,
 *   the historic Playwright wording is sent, unchanged.
 *
 * The skip lives HERE rather than in the callers because `testPhase` has three
 * of them — `runPipeline`, the Browser QA repair loop and the change request —
 * and all three stamp `e2ePassedAt = headCommit` immediately afterwards. One
 * early `return` covers all three, the change request included, which would
 * otherwise die reading `config.e2e.relativeCwd`. And the mark they stamp is
 * right: "there is nothing to run on this commit" is the same thing, to every
 * later gate, as "it passed".
 */
async function testPhase(task, { machine = machineOf(task) } = {}) {
  const cfg = cfgOf(task);
  if (!cfg.e2e) {
    store.addLog(task, 'e2e', 'this project defines no config.e2e: there is no suite to run, the phase is skipped');
  }
  if (!cfg.e2e?.testCommand) {
    task.verification = 'none';
    store.addLog(task, 'e2e', 'no verification configured: there is no test command');
    store.touch(task);
    return;
  }
  task.verification = 'e2e';
  // Only what the diff touched, unless the person asked for the whole suite (or
  // the project lists no scopes). The full suite is CI's job; a failure there
  // comes back through the same repair loop.
  const scoped = !fullTestsWanted(task) && hasScopes(cfg.e2e) ? await scopedPlanOf(task, machine, cfg.e2e) : null;
  task.testScope = scoped ? describePlan(scoped) : 'full suite';
  if (scoped) {
    task.verification = 'scoped';
    store.addLog(task, 'e2e', `${task.testScope}${scoped.ignored.length ? `; ${scoped.ignored.length} files need no test` : ''}${scoped.unmatched.length ? `; no scope for ${scoped.unmatched.length} files (left to CI)` : ''}`);
    if (!scoped.runs.length) {
      store.touch(task);
      return;
    }
  }
  const e2eCwd = machine.path.join(task.worktreePath, cfg.e2e.relativeCwd ?? '.');
  const runs = scoped ? scoped.runs : [{ name: 'full', browser: true, prepareCommand: cfg.e2e.prepareCommand, cwd: e2eCwd, command: null }];
  const needsBrowser = runs.some((r) => r.browser);
  // Dependencies before anything else, and outside the e2e gate: waiting for a
  // suite's turn to find out an install is broken wastes the turn. It is the
  // same step the pipeline already ran before the fix, so here it normally only
  // reads the marker — and the repair loop and the change request, which both
  // come in through this door, inherit it too. A scoped run with no browser
  // test has no use for them.
  if (needsBrowser) {
    const deps = await prepareDependencies(task, machine, 'test');
    if (!deps.ok) throw dependencyError(infrastructureFailure(deps));
  }
  const timeoutMs = (cfg.e2e.timeoutMinutes ?? E2E_TIMEOUT_DEFAULT_MINUTES) * 60 * 1000;
  const { portEnv, portOffsets, portRange } = cfg.e2e;
  // All three or none: see the contract above.
  const wantsPorts = needsBrowser && Boolean(portEnv && portOffsets?.length && portRange);

  for (let attempt = 1; ; attempt++) {
    // Only runs with a browser take a turn on the machine's e2e gate.
    const e2eGate = needsBrowser ? e2eGateFor(machine) : { active: 0, limit: 1, waiting: 0, run: (fn) => fn() };
    if (e2eGate.active >= e2eGate.limit) {
      store.addLog(task, 'e2e', `waiting for a turn on ${machine.name} (${e2eGate.active}/${e2eGate.limit} suites running, ${e2eGate.waiting} queued)`);
    }
    // Queue time for the machine's turn: opened here, closed by the first line
    // of the callback (and by the `finally`, should the gate fail before it).
    const turnWait = beginSpan(task, { kind: 'wait', name: 'e2e_gate', attempt, within: openPhaseOf(task), machine: machine.name });
    const testResult = await e2eGate.run(async () => {
      endSpan(task, turnWait);
      // The suite derives its whole server block from one base port and
      // defaults to 8080 — which is where the user's own hfs/hts live. Hand it
      // a verified-free block instead, and set CI so Playwright refuses to
      // adopt a listener it did not start rather than testing someone else's
      // server.
      const base = wantsPorts ? await findFreePortBase(machine, portOffsets, portRange) : null;
      const ports = wantsPorts ? portOffsets.map((o) => base + o) : [];
      const env = { ...(cfg.e2e.env ?? {}), ...(wantsPorts ? { [portEnv]: String(base) } : {}) };
      if (wantsPorts) store.addLog(task, 'e2e', `${portEnv}=${base} (ports ${ports.join(', ')}), without reusing foreign servers`);

      try {
        // boot.mjs refuses to start without an hfs binary and picks whichever
        // profile was built most recently, so build the one we want last. It
        // must be release: boot.mjs always sets HFS_DATABASE_URL, and that
        // alone makes the debug binary overflow its stack at startup.
        for (const run of runs) {
          const full = run.name === 'full';
          if (run.prepareCommand) {
            store.addLog(task, 'e2e', `preparing${full ? ' the binary' : ` [${run.name}]`}: ${run.prepareCommand}`);
            const prep = await machine.shell(run.prepareCommand, {
              cwd: task.worktreePath,
              timeoutMs: (cfg.e2e.prepareTimeoutMinutes ?? 90) * 60 * 1000,
              env,
              onLine: (l) => store.addLog(task, 'e2e', l),
            });
            if (!prep.ok) return { ok: false, tail: prep.stderr.slice(-4000) };
          }
          // The suite's own `workers: 1` is deliberate — one shared HFS serves the
          // whole run, and more browsers against one database means flaky tests,
          // not fast ones. So the knob only reaches Playwright when it is raised
          // on purpose, and the default leaves the suite as its authors set it.
          const workers = Number(cfg.e2e.workers) || 1;
          const base = run.command ?? cfg.e2e.testCommand;
          const testCommand = full && workers > 1 ? `${base} --workers=${workers}` : base;
          const cwd = full ? e2eCwd : run.cwd ? machine.path.join(task.worktreePath, run.cwd) : task.worktreePath;
          store.addLog(task, 'e2e', `running${full ? '' : ` [${run.name}]`}: ${testCommand} (attempt ${attempt})`);
          const r = await machine.shell(testCommand, {
            cwd, timeoutMs, env, onLine: (l) => store.addLog(task, 'e2e', l),
          });
          if (!r.ok) return { ok: false, tail: `${full ? '' : `[${run.name}]\n`}${(r.stdout + '\n' + r.stderr).slice(-6000)}` };
        }
        return { ok: true, tail: '' };
      } finally {
        if (ports.length) releasePorts(machine, ports);
      }
    }).finally(() => endSpan(task, turnWait, { outcome: 'error' }));

    if (testResult.ok) {
      store.addLog(task, 'e2e', 'tests e2e en verde ✅');
      return;
    }

    // A suite that never got a server up says nothing about the fix. Sending
    // that to the fix agent just burns a turn on "this isn't my change".
    const infra = infrastructureFailure(testResult);
    if (infra) {
      throw new Error(`The e2e suite could not start (${infra}). This is not a fix failure: check the environment.`);
    }
    if (attempt > cfg.limits.maxFixIterations) {
      throw new Error(`The e2e tests still fail after ${attempt} attempts`);
    }

    // The switch has to be honoured here above all: this loop is compile plus
    // Playwright plus rounds of Opus, the longest stretch in the system, and
    // "it stops when the current phase ends" would otherwise mean hours. A
    // one-shot run you ordered is the exception, until you touch the switch.
    // The account's limit is honoured in exactly this place, and for the same
    // reason. The suite, the build and the install are never cut: they cost no
    // quota, and a green suite reaches `e2ePassedAt` before it meets the wall.
    // A repair round is a session, so that is where the run stops.
    if (quotaHoldsNewWork(task)) {
      store.addLog(task, 'e2e', `⏳ quota exhausted: no other repair round is launched; it resumes on its own ${describeResume(quotaHold())}`);
      throw new QuotaExhausted('testing');
    }
    if (!mayCarryOn(task)) {
      store.addLog(task, 'modo', 'you marked it manual: no other repair round is launched');
      throw new PausedForMode();
    }

    task.fixIterations = attempt;
    store.addLog(task, 'e2e', `tests failed; handing the failure back to the fix session (iteration ${attempt} of ${cfg.limits.maxFixIterations})`);
    store.setState(task, 'fixing');
    const issue = await getIssue(task.issue, task.project);
    // What the earlier rounds already tried, so this one does not repeat the
    // same repair and is told to change strategy instead.
    task.fixAttempts = [...(task.fixAttempts ?? []), { round: attempt, tail: lastLines(testResult.tail, 12), at: new Date().toISOString() }];
    // Carry the change request through every repair round. Sending only the
    // failure would replace the reviewer's brief with "the tests broke", and
    // the session would fix the test having forgotten what it was asked for.
    const failure = fixFailureBrief(cfg, testResult.tail, task.fixAttempts);
    const cr = activeChangeRequest(task);
    await fixPhase(task, issue, cr ? `${changeRequestSection(cr)}\n${failure}` : failure);
    store.setState(task, 'testing');
  }
}

/** Whether the test phase runs the project's whole suite for this task. */
export function fullTestsWanted(task) {
  if (task.fullTests === 'on') return true;
  if (task.fullTests === 'off') return false;
  return settings.fullTestsFor(task.project);
}

export function setFullTests(issue, mode) {
  assertNoUpgradeRunning();
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  if (!['auto', 'on', 'off'].includes(mode)) throw new Error('mode must be auto, on or off');
  task.fullTests = mode;
  store.addLog(task, 'e2e', `full suite in the test phase: ${mode === 'auto' ? `per the board (${settings.fullTestsFor(task.project) ? 'yes' : 'no'})` : mode === 'on' ? 'yes' : 'no'}`);
  store.touch(task);
  return mode;
}

/**
 * The scoped plan for this task: the branch's changed files against the base,
 * through the project's `e2e.scopes`. A diff that cannot be read plans nothing
 * (and says so): the full suite is never the fallback.
 */
async function scopedPlanOf(task, machine, e2e) {
  const base = baseOf(task);
  const r = await machine.exec('git', ['-c', 'core.quotePath=false', 'diff', '--name-only', `origin/${base}...HEAD`], { cwd: task.worktreePath });
  if (!r.ok) {
    store.addLog(task, 'e2e', `could not read the diff against origin/${base}: nothing to run, CI will test it`);
    return { runs: [], covered: [], ignored: [], unmatched: [] };
  }
  const files = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return planScopes(e2e, files, { base });
}

/**
 * What the fix agent is told when the project's verification command fails: the
 * output tail, the rounds that already failed, and the instruction to repair the
 * cause without weakening the check.
 *
 * `e2e.testCommand` is any command (a docs gate is not Playwright), so the
 * wording that names Playwright is only true for a project that did not say
 * what its check is. A project that declares `e2e.label` gets the neutral text;
 * without it (hfs and every project so far) the text is the historic one,
 * byte for byte.
 *
 * @param {Object} cfg The task's merged configuration.
 * @param {string} tail Last output of the failed command.
 * @param {Array<{round: number, tail: string}>} attempts `task.fixAttempts`,
 *   the current round last.
 */
export function fixFailureBrief(cfg, tail, attempts) {
  const earlier = attempts.length > 1
    ? `\nRondas anteriores que NO bastaron (analiza por qué, y si la estrategia no sirve cámbiala en vez de repetirla):\n${attempts.slice(0, -1).map((a) => `- ronda ${a.round}:\n\`\`\`\n${a.tail}\n\`\`\``).join('\n')}\n`
    : '';
  const label = typeof cfg.e2e?.label === 'string' ? cfg.e2e.label.trim() : '';
  const head = label
    ? `LA VERIFICACIÓN DEL PROYECTO (${label}) FALLÓ. Analiza esta salida, repara la causa (puede ser tu cambio o una comprobación que deba actualizarse legítimamente — nunca debilites la verificación solo para ponerla en verde) y commitea la corrección:`
    : 'LOS TESTS E2E DE PLAYWRIGHT FALLARON. Analiza esta salida, repara la causa (puede ser tu cambio o un test que deba actualizarse legítimamente — nunca debilites un test solo para ponerlo en verde) y commitea la corrección:';
  return `\n${head}\n\`\`\`\n${tail}\n\`\`\`\n${earlier}`;
}

// ---------------------------------------------------------------------------
// Browser QA: the issue verified in a browser, the way a tester would.

/**
 * Whether the run ends by writing the demo steps.
 *
 * The task's own `on`/`off` decides; `auto` (or no value) follows the
 * project's setting, which is on unless turned off.
 */
export const demoWanted = (task) => {
  if (task.demo === 'on') return true;
  if (task.demo === 'off') return false;
  return settings.demoFor(task.project);
};

/** Whether this task runs the phase: the board-wide switch, then the task's. */
export function qaWanted(task) {
  if (!settings.browserQaFor(task.project)) return false;
  if (task.browserQa === 'off') return false;
  if (task.browserQa === 'on') return true;
  return task.qa?.ui === true;
}

// A project chat has no issue: its per-owner directories are named after its worktree.
const ownerDirName = (task) => (task.kind === 'project' ? PROJECT_WORKTREE_DIR : String(task.issue));

const qaDirOf = (machine, task) => machine.path.join(machine.worktreeRoot, '.qa', ownerDirName(task));

// Where the `delegate` tool's OpenCode permission preset is written for a
// chat's session — a sibling of the worktree, per task, never inside it.
const opencodeConfigDirOf = (machine, task) => machine.path.join(machine.worktreeRoot, '.opencode', ownerDirName(task));

/**
 * The phase inside the pipeline: plan, run, judge — and when a step fails
 * because of the fix, back to the fix with the evidence, through the e2e
 * suite, and here again, as many rounds as e2e itself gets.
 */
async function browserQaPhase(task, issue) {
  const cfg = cfgOf(task);
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await runQaOnce(task, issue);
    if (!outcome) return;                                // no UI after all, or no usable plan
    if (outcome.verdict !== 'fail') return;

    if (attempt > cfg.limits.maxFixIterations) {
      throw new Error(`Browser QA sigue fallando tras ${attempt} intento(s): ${outcome.failing.join('; ')}`);
    }
    if (quotaHoldsNewWork(task)) {
      store.addLog(task, 'qa', `⏳ quota exhausted: no other repair round is launched; it resumes on its own ${describeResume(quotaHold())}`);
      throw new QuotaExhausted('browser_qa');
    }
    if (!mayCarryOn(task)) {
      store.addLog(task, 'modo', 'you marked it manual: no other repair round is launched');
      throw new PausedForMode();
    }
    store.addLog(task, 'qa', `Browser QA failed; handing the evidence back to the fix session (iteration ${attempt})`);
    store.setState(task, 'fixing');
    await fixPhase(task, issue, qaFailureBrief(task, outcome));
    // The fix changed the code: the suite runs again before the browser does.
    store.setState(task, 'testing');
    await testPhase(task);
    task.e2ePassedAt = await headCommit(machineOf(task), task.worktreePath);
    store.setState(task, 'browser_qa');
  }
}

// ---------------------------------------------------------------------------
// Cerrar huecos: after the tests and the Browser QA, before the PR. The fix
// session is resumed (never forked) and asked whether the change has evidence
// and what it left open; what it can close, it closes, and the rest goes to a
// person in the task chat. Everything about the verdict is pure and lives in
// gaps.js; this is the wiring.

/** Rounds of «cerrar huecos» a task may run; `limits.maxGapRounds`, 3 when absent. */
export const maxGapRoundsOf = (cfg) => {
  const n = Number(cfg?.limits?.maxGapRounds);
  return Number.isInteger(n) && n >= 1 ? n : 3;
};

/** Seams for tests: the two phases a gap round reuses, without a worktree. */
export const gapsHooks = {
  fixPhase: (...args) => fixPhase(...args),
  testPhase: (...args) => testPhase(...args),
  headCommit: (...args) => headCommit(...args),
};

/**
 * The gap-closing loop. Never blocks the PR over the verdict itself: a session
 * whose answer cannot be read after one re-ask is logged, said in the chat, and
 * the run goes on to the PR. What does stop the run is the same as in the rest
 * of the pipeline — the account's quota, a task turned manual, and a fix or a
 * suite that fails after a closing round (a regression is not «a gap»).
 */
export async function gapsPhase(task, issue) {
  const cfg = cfgOf(task);
  const machine = machineOf(task);
  const maxRounds = maxGapRoundsOf(cfg);
  const say = (md) => store.addChat(task, null, 'assistant', md);
  task.gaps = { rounds: 0, lastVerdict: null, pending: [] };

  if (!principalChat(task)?.sessionId) {
    store.addLog(task, 'gaps', 'no fix session to resume: gap closing is skipped');
    store.touch(task);
    return task.gaps;
  }

  let previous = null;
  for (let round = 1; ; round += 1) {
    if (quotaHoldsNewWork(task)) {
      store.addLog(task, 'gaps', `⏳ quota exhausted: round ${round} is not launched; it resumes on its own ${describeResume(quotaHold())}`);
      throw new QuotaExhausted('fix_gaps');
    }
    if (!mayCarryOn(task)) {
      store.addLog(task, 'modo', 'you marked it manual: no other gap-closing round is launched');
      throw new PausedForMode();
    }

    const tune = tunedSession(task, 'fix', { stage: 'gaps', cfg });
    const onEvent = claudeLogger(task, 'gaps');
    store.addLog(task, 'gaps', `round ${round} of ${maxRounds}: the fix session reviews its own work`);
    releasePrincipal(task);
    const run = await nudgedSession(task, 'fix-gaps', {
      machine,
      cwd: task.worktreePath,
      ...tune,
      resume: principalChat(task).sessionId,
      maxTurns: 30,
      onEvent,
      canUseTool: taskCanUseTool(task, 'gaps'),
      hooks: ghGateHooks(task, 'gaps'),
      prompt: renderPrompt('fix-gaps', {
        ...promptVarsFor(task, 'gaps'),
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueBody: issue.body || '(vacío)',
        baseBranch: baseOf(task),
        round,
        maxRounds,
        gapsContract: gapsContract(),
        processRule: processRuleFor(machine),
        shellRule: shellRuleFor(machine),
      }),
    }, { run: (o) => fixHooks.runClaude(o), before: () => releasePrincipalForNudge(task) });
    if (run.quota) throw new QuotaExhausted('fix_gaps');
    // Resuming appends to the same transcript, so the id is the one it had.
    if (run.sessionId) principalChat(task).sessionId = run.sessionId;
    store.touch(task);

    // One re-ask, in the same session, then give up on the verdict.
    const verdict = await taggedFrom(task, 'gaps', run, {
      read: readGaps, tag: GAPS_TAG, machine, cwd: task.worktreePath, model: tune.model, tuning: tune,
      onEvent, max: 1, run: fixHooks.runClaude,
    });
    if (!verdict) {
      store.addLog(task, 'gaps', '⚠️ the gaps verdict could not be read even after asking again; moving on to the PR without it');
      say(`**Cerrar huecos, ronda ${round}**\n\nNo pude leer el veredicto de la revisión de huecos: sigo hacia el PR sin él. Conviene que una persona revise a mano qué evidencia tiene el cambio.`);
      task.gaps = { ...task.gaps, rounds: round, unreadable: true };
      store.touch(task);
      return task.gaps;
    }

    const todo = resolvableGaps(verdict);
    const again = shouldIterate(verdict, round, maxRounds, previous);
    // Left for a person once this round is over: the gaps that need one, and —
    // when no further round will run — whatever resolvable gap is still open.
    const pending = again ? verdict.gaps.filter((g) => g.needsHuman) : verdict.gaps;
    task.gaps = { rounds: round, lastVerdict: verdict, pending };
    store.addLog(task, 'gaps', `round ${round}: evidence ${verdict.evidence}, ${verdict.gaps.length} gap(s), ${todo.length} the session can close${again ? '' : '; there will be no other round'}`);
    say(chatSummary({ round, verdict, fixed: again ? todo.map((g) => g.id) : [], pending }));
    store.touch(task);
    if (!again) return task.gaps;

    // Close what can be closed, then the suite again: a closing change is code.
    previous = verdict;
    store.setState(task, 'fixing');
    await gapsHooks.fixPhase(task, issue, gapsToFixBrief(verdict, round), { continuing: true });
    store.setState(task, 'testing');
    await gapsHooks.testPhase(task);
    task.e2ePassedAt = await gapsHooks.headCommit(machine, task.worktreePath);
    store.setState(task, 'fix_gaps');
  }
}

/** What the fix session is told when QA found the issue not fixed. */
function qaFailureBrief(task, outcome) {
  const lines = outcome.failing.map((f) => `- ${f}`).join('\n');
  return `\nEL BROWSER QA FALLÓ: un tester recorrió la app en el navegador y estos pasos no se cumplen. Arregla la causa en el código (nunca el test ni el paso) y commitea:\n${lines}\n\nLa evidencia (capturas y vídeo) está en ${task.qa?.dir ?? 'el directorio de QA'}: mírala con Read antes de tocar nada.\n`;
}

// Each titled scenario gets a `### title` header over its steps; an untitled
// step prints bare, exactly as a flat plan always did. One helper for both
// prompts so they cannot drift apart.
function renderScenarios(steps, line) {
  return scenariosOf(steps)
    .map((g) => {
      const body = g.steps.map(line).join('\n');
      return g.title ? `### ${g.title}\n${body}` : body;
    })
    .join('\n');
}

// The cap is soft: a plan is never rejected for exceeding it. It also fires on
// a flat plan with no labels, since N one-step groups are N recorded tests —
// which is precisely the case the owner wants to notice.
function warnScenarioCap(task, steps) {
  const n = scenariosOf(steps).length;
  if (n > SUGGESTED_SCENARIOS) {
    store.addLog(task, 'qa', `⚠️ the plan has ${n} scenarios and ${SUGGESTED_SCENARIOS} are suggested: each scenario is a walkthrough recorded in full`);
  }
}

// Whole carried scenarios are named by title as well as by ids (splitPlan only
// carries a scenario whole); loose steps stay as bare ids.
function carriedNames(carried) {
  return scenariosOf(carried.map((c) => c.step))
    .map((g) => {
      const ids = g.steps.map((s) => s.id).join(', ');
      return g.title ? `escenario «${g.title}»: ${ids}` : ids;
    })
    .join('; ');
}

/**
 * One full QA pass: stack up, refined plan, live exploration plus spec, videos
 * condensed, results stored. Returns `{ verdict, failing }`, or null when the
 * issue turns out to have no UI side or no plan could be had.
 */
async function runQaOnce(task, issue) {
  const cfg = cfgOf(task);
  // Browser QA needs an app in front of it, and the app is `config.stack`. A
  // project that declares none has nothing to look at, so the phase does not
  // apply — and this is the STRUCTURAL place to say it, not the task's
  // `browserQa` switch: that switch can be forced `'on'` from the card, and
  // forcing it would walk straight into `ensureStackRunning`'s 409, which
  // `retry.js` does not read as transient, so the task would land in `error`.
  // Answering `null` is what `browserQaPhase` already treats as "no UI".
  //
  // Deliberately without stamping `qa.ranAtHead`: every resume re-enters here
  // and skips again, which costs one log line and keeps the mark meaning what
  // it says — that a QA was paid for on this commit.
  if (!cfg.stack) {
    store.addLog(task, 'qa', 'this project defines no config.stack: Browser QA does not apply');
    return null;
  }
  const machine = machineOf(task);
  const qaDir = qaDirOf(machine, task);
  const onEvent = claudeLogger(task, 'qa');
  const startedAt = Date.now();

  // The commit this QA is about to look at, read now rather than at the end: a
  // chat turn or the «Browser QA» button can commit during the twenty-five
  // minutes it takes, and a mark read afterwards would name a commit this run
  // never saw — which would then skip a QA that was never done on it.
  const headAtStart = await headCommit(machine, task.worktreePath);

  store.addLog(task, 'qa', 'starting the task stack for Browser QA');
  const stack = await withInfraRetries(task, 'qa', 'the stack', () => ensureStackRunning(keyOf(task)));
  const services = Object.values(stack.services ?? {});
  const hfs = services.find((s) => /hfs/i.test(s.label)) ?? services[0];
  if (!hfs) throw new Error('the stack has no service to test');
  const serversText = services.map((s) => `- ${s.label}: ${s.localUrl ?? s.url}`).join('\n');

  // 1. The refined plan, read-only, on the cheaper model — told what an
  // earlier attempt of this same phase already proved, if any, so it can
  // carry those steps forward instead of restating them.
  const initial = task.qa?.initial;
  const carry = usableCarry(task.qa?.carry, { dir: qaDir, machine: machine.name });
  const diff = await machine.exec('git', ['diff', '--stat', `origin/${baseOf(task)}...HEAD`], { cwd: task.worktreePath });
  const e2eTail = task.log.filter((l) => l.phase === 'e2e').slice(-40).map((l) => l.line).join('\n');
  const planTune = tunedSession(task, 'qaPlan', { stage: 'qa', cfg });
  const planModel = planTune.model;
  store.addLog(task, 'qa', `refining the Browser QA plan with ${planModel}`);
  const planRun = await nudgedSession(task, 'qa-plan', {
    machine, cwd: task.worktreePath, ...planTune, maxTurns: 25, onEvent,
    hooks: ghGateHooks(task, 'qa'),
    prompt: renderPrompt('qa-plan', {
      ...promptVarsFor(task, 'qa'),
      issueNumber: issue.number,
      issueTitle: issue.title,
      branch: task.branch,
      issueBody: issue.body || '(vacío)',
      initialPlan: initial?.steps?.length
        ? renderScenarios(initial.steps, (s) => `- ${s.id}: ${s.what} → ${s.expect}${s.longWait ? ' (espera larga)' : ''}`)
        : '(el triage no dejó plan; pártelo del issue)',
      previousAttempt: previousAttemptSection(carry),
      diffStat: diff.ok ? diff.stdout.trim().slice(-2500) : '(sin diff)',
      e2eTail: e2eTail.slice(-3000) || '(sin salida de e2e)',
      stackSection: `LOS SERVIDORES DE ESTA TAREA ESTÁN LEVANTADOS:\n${serversText}`,
      processRule: processRuleFor(machine),
      qaPlan: qaPlanContract(undefined, { continuity: Boolean(carry) }),
      baseBranch: baseOf(task),
    }),
  });
  const plan = await taggedFrom(task, 'qa', planRun, {
    read: readQaPlan, tag: QA_PLAN_TAG, machine, cwd: task.worktreePath, model: planModel, tuning: planTune, onEvent,
  });
  if (!plan) {
    store.addLog(task, 'qa', '⚠️ no usable Browser QA plan; the phase is skipped');
    return null;
  }
  if (!plan.ui) {
    task.qa = { ...(task.qa ?? {}), ui: false, plan, carry: null };
    store.addLog(task, 'qa', 'the refined plan says there is no UI to test; Browser QA does not apply');
    store.touch(task);
    return null;
  }
  // Evidence recorded on another machine before a move is replaced by this
  // run's; nothing would point at it any more. Best effort and not awaited:
  // that machine may well be unreachable now.
  const previousQa = task.qa;
  if (previousQa?.dir && previousQa.machine && previousQa.machine !== machine.name) {
    const { machine: there } = machineViewFor(task, previousQa.machine);
    if (there) {
      Promise.resolve()
        .then(() => there.fs.rm(previousQa.dir, { retries: 3 }))
        .catch((e) => store.addLog(task, 'qa', `⚠️ could not delete the previous evidence on ${previousQa.machine}: ${e.message}`));
    }
  }

  // Cut the plan into what an earlier attempt already proved and what this
  // one has to run, then clear the directory down to exactly the evidence the
  // carried steps still cite. A stale `*.spec.ts` left over from a previous
  // attempt would otherwise be picked up by `npx playwright test` and
  // re-record the very steps this attempt is skipping.
  const before = await machine.fs.readdirDeep(qaDir).catch(() => []);
  const { carried, fresh, keep, dropped } = splitPlan(plan, carry, { files: before });
  warnScenarioCap(task, plan.steps);
  for (const d of dropped) store.addLog(task, 'qa', `step ${d.id}: ${d.why}`);
  if (!keep.length) {
    await machine.fs.rm(qaDir, { retries: 3 }).catch(() => {});
  } else {
    const spared = new Set(keep);
    for (const rel of before.filter((f) => !spared.has(f))) {
      await machine.fs.rm(machine.path.join(qaDir, ...rel.split('/'))).catch(() => {});
    }
  }

  task.qa = {
    ...(task.qa ?? {}), ui: true, plan, dir: qaDir, machine: machine.name, results: null,
    evidence: listEvidence(keep, { steps: plan.steps }),
    videos: Object.fromEntries(Object.entries(task.qa?.videos ?? {}).filter(([p]) => keep.includes(p))),
    carry,
  };
  store.touch(task);

  // 2. The harness, then the run: explore live, write the spec, execute it —
  // only the steps this attempt has to prove; the carried ones are neither
  // shown to the session nor re-run.
  const maxWaitMinutes = cfg.qa?.maxWaitMinutes ?? 45;
  // Playwright's timeout is per test() and a scenario is one test, so it has to
  // fit the scenario with the most long waits, not just one wait.
  const longWaitsPerTest = Math.max(1, ...scenariosOf(fresh).map((g) => g.steps.filter((s) => s.longWait).length));
  const resultsDir = machine.path.join(qaDir, 'results');
  await machine.fs.mkdir(resultsDir);
  await machine.fs.mkdir(machine.path.join(qaDir, 'explore'));
  await machine.fs.writeFile(machine.path.join(qaDir, 'playwright.config.ts'), playwrightConfig({ baseURL: hfs.localUrl ?? hfs.url, maxWaitMinutes, longWaitsPerTest }));
  await machine.fs.writeFile(machine.path.join(qaDir, 'qa-helpers.ts'), qaHelpers({ maxWaitMinutes, resultsDir }));

  const qaTune = tunedSession(task, 'qa', { cfg });
  const qaModel = qaTune.model;
  const mcp = qaMcpServers({ version: cfg.qa?.mcpVersion ?? '0.0.80', outputDir: machine.path.join(qaDir, 'explore') });
  const runPlan = { ui: true, steps: fresh };
  store.addLog(task, 'qa', `Browser QA with ${qaModel}: ${scenariosOf(fresh).length} scenario(s), ${fresh.length} step(s)${carried.length ? `, ${carried.length} reused` : ''}, live browser and then the spec`);
  const run = await runClaude({
    machine, cwd: task.worktreePath, ...qaTune, maxTurns: maxTurnsFor('qa', cfg), mcpServers: mcp, onEvent,
    canUseTool: taskCanUseTool(task, 'qa'),
    hooks: ghGateHooks(task, 'qa'),
    prompt: renderPrompt('qa-run', {
      ...promptVarsFor(task, 'qa'),
      issueNumber: issue.number,
      issueTitle: issue.title,
      branch: task.branch,
      servers: serversText,
      qaDir,
      // Same default as `testPhase`: the repository root when the project keeps
      // its suite there, and `'.'` too when it has no suite at all — the
      // template needs a directory, not a promise that tests live in it.
      e2eDir: machine.path.join(task.worktreePath, cfg.e2e?.relativeCwd ?? '.'),
      plan: renderScenarios(fresh, (s) => `- **${s.id}** — ${s.what}\n  · debe verse: ${s.expect}${s.longWait ? '\n  · espera larga: usa los helpers y el dato más pequeño' : ''}`),
      carriedNote: carried.length
        ? `\n> Otros ${carried.length} paso(s) de este plan (${carriedNames(carried)}) ya quedaron probados en un intento anterior y su evidencia está grabada: **no son cosa tuya**. No los ejecutes, no escribas tests para ellos y no los reportes — el tablero los añade a los resultados por su cuenta.\n`
        : '',
      processRule: processRuleFor(machine),
      shellRule: shellRuleFor(machine),
      tmpRule: tmpRuleFor(machine),
    }),
  });
  noteMaxTurns(task, 'qa', run, maxTurnsFor('qa', cfg));
  // Out of quota the session verified nothing, so there are no results to read
  // and nothing to complain about — but the videos and screenshots it did
  // record were paid for, so they are condensed and listed below all the same.
  const results = run.quota ? null : await taggedFrom(task, 'qa', run, {
    read: (t) => readQaResults(t, runPlan), tag: QA_RESULTS_TAG, machine, cwd: task.worktreePath, model: qaModel, tuning: qaTune, onEvent, mcpServers: mcp,
  });
  const merged = mergeQaResults(results, carried, plan);
  {
    const calls = Object.values(run.toolCounts ?? {}).reduce((a, b) => a + b, 0);
    const browser = Object.entries(run.toolCounts ?? {}).filter(([n]) => /browser_/.test(n)).reduce((a, [, b]) => a + b, 0);
    store.addLog(task, 'qa', `QA session: ${calls} tools, ${browser} in the browser, ${subagentsUsed(run.toolCounts)} subagents`);
  }

  // 3. The evidence: every screenshot and video, with the stillness cut out.
  // Only the ones this attempt actually recorded are condensed — the carried
  // ones were condensed the attempt that made them, and `condenseVideo` both
  // re-encodes and deletes its input, so running it twice on the same file
  // would destroy evidence a carried step still points at.
  const files = await machine.fs.readdirDeep(qaDir).catch(() => []);
  const spared = new Set(keep);
  const videos = { ...(task.qa.videos ?? {}) };
  for (const rel of files.filter((f) => /\.webm$/i.test(f) && !spared.has(f))) {
    const full = machine.path.join(qaDir, rel);
    const tmp = `${full}.condensed.webm`;
    const r = await condenseVideo(machine, { input: full, output: tmp });
    if (r.condensed) {
      await machine.fs.copy(tmp, full);
      await machine.fs.rm(tmp);
    }
    videos[rel] = { condensed: r.condensed, reason: r.reason ?? null, cuts: r.cuts };
    if (r.cuts.length) store.addLog(task, 'qa', `${rel}: ${r.cuts.map(describeCut).join('; ')}`);
  }
  const evidence = listEvidence(files, { steps: plan.steps });

  task.qa = {
    ...task.qa,
    results: merged,
    evidence,
    videos,
    ranAt: new Date().toISOString(),
    // `passedAt` still means green; `ranAtHead` means paid for. See `qaMarks`.
    // Both against the commit the session actually verified, not against HEAD
    // as it stands now — and neither is written when the quota killed the
    // session, or the next run would skip a QA that never happened.
    ...qaMarks(merged?.verdict ?? null, headAtStart, { ran: !run.quota }),
    carry: nextCarry(merged, plan, carry, { attempt: (carry?.attempt ?? 0) + 1, at: headAtStart, dir: qaDir, machine: machine.name }),
  };
  store.touch(task);

  if (run.quota) {
    store.addLog(task, 'qa', '⏳ quota exhausted during Browser QA: the recorded evidence is kept, but the phase is NOT marked as run and repeats in full on resume');
    throw new QuotaExhausted('browser_qa');
  }

  if (!merged) {
    store.addLog(task, 'qa', '⚠️ the QA ended without readable results; the evidence stays in the panel');
    return { verdict: 'unverified', failing: [] };
  }
  const failing = merged.steps.filter((s) => s.status === 'fail').map((s) => {
    const step = plan.steps.find((p) => p.id === s.id);
    return `${s.id} (${step?.what ?? ''}): ${s.note || 'sin nota'} — esperado: ${step?.expect ?? ''}`;
  });
  const { passed, failed, unverified } = merged.counts;
  store.addLog(task, 'qa', `Browser QA: ${merged.verdict} · ${passed} pass, ${failed} fail, ${unverified} unverified · ${evidence.length} evidence item(s) · ${Math.max(1, Math.round((Date.now() - startedAt) / 60000))} min`);
  return { verdict: merged.verdict, failing };
}

/**
 * The button: one QA pass on demand, outside the pipeline. Reports and stops;
 * the repair loop is the pipeline's, not a click's.
 */
export async function runBrowserQa(issue) {
  assertNoUpgradeRunning();
  // Refused, not parked: 25 minutes of browser session is not something the
  // board should start by itself hours from now on a click you made today.
  assertNoQuotaHold();
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  assertNotMoving(task);
  if (task.qaBusy) throw new Error('A Browser QA run is already in progress');
  if (ACTIVE_STATES.includes(task.state) || running.has(keyOf(task))) throw new Error('The task is working; wait for it to finish');
  if (!(await isProjectWorktree(machineOf(task), task.worktreePath))) {
    throw new Error('This task has no worktree. Create it first with «🌳 Create worktree».');
  }
  task.qaBusy = true;
  store.touch(task);
  try {
    const meta = await getIssue(task.issue, task.project);
    await runQaOnce(task, meta);
  } finally {
    task.qaBusy = false;
    store.touch(task);
  }
  return task.qa;
}

/** The card's switch: follow triage, force it on, or skip it. */
export function setBrowserQa(issue, mode) {
  assertNoUpgradeRunning();
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  if (!['auto', 'on', 'off'].includes(mode)) throw new Error(`Unknown Browser QA mode: ${mode}`);
  task.browserQa = mode;
  store.addLog(task, 'qa', `Browser QA: ${mode === 'auto' ? 'per the triage' : mode === 'on' ? 'forced' : 'disabled'}`);
  store.touch(task);
  return mode;
}

/**
 * The card's other switch: whether the run writes the demo steps at the end.
 *
 * Only the pipeline's own last step obeys it. The «Generar pasos» button does
 * not: a click is explicit, and a switch meant to save a session on every run
 * has no business refusing the one you asked for by hand.
 */
export function setDemo(issue, mode) {
  assertNoUpgradeRunning();
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  if (!['auto', 'on', 'off'].includes(mode)) throw new Error('mode must be auto, on or off');
  task.demo = mode;
  const text = mode === 'auto'
    ? `per the project (${settings.demoFor(task.project) ? 'generated when the run ends' : 'disabled'})`
    : mode === 'on' ? 'generated when the run ends' : 'disabled (the button still generates them)';
  store.addLog(task, 'demo', `demo steps: ${text}`);
  store.touch(task);
  return mode;
}

/** What the panel shows. */
export function qaInfo(task) {
  return {
    browserQa: task.browserQa ?? 'auto',
    wanted: qaWanted(task),
    globalOn: settings.browserQaFor(task.project),
    busy: Boolean(task.qaBusy) || task.state === 'browser_qa',
    qa: task.qa,
  };
}

/** A piece of evidence, as bytes, from wherever the task ran. */
export async function qaEvidence(task, rel) {
  const dir = task.qa?.dir;
  if (!dir) throw new Error('This task has no Browser QA evidence');
  const clean = String(rel ?? '').replace(/\\/g, '/');
  if (!clean || clean.includes('..') || clean.startsWith('/')) throw new Error('Invalid evidence path');
  // Evidence stays on the machine that recorded it, also after a move.
  const recordedOn = task.qa.machine ?? task.machine ?? 'local';
  const { machine, error } = machineViewFor(task, recordedOn);
  if (!machine) throw new Error(`Cannot read the evidence on ${recordedOn}: ${error}`);
  return machine.fs.readBinary(machine.path.join(dir, ...clean.split('/')));
}

async function headCommit(machine, wtPath) {
  const r = await machine.exec('git', ['rev-parse', 'HEAD'], { cwd: wtPath });
  return r.ok ? r.stdout.trim() : null;
}

/**
 * Names the environment problem behind an e2e run, or null if the tests
 * themselves failed.
 *
 * ⚠️ It decides **by stage, never by a pattern over the output of a stage that
 * is allowed to fail.** The install reports `stage: 'install'` and that alone
 * answers for it. The temptation is a text signal instead — and
 * `npm error Lifecycle script "test" failed` is printed by EVERY red
 * `npm test`, so a `/npm error/` signal would file every real test failure as
 * infrastructure and the repair loop would never run once: far worse than the
 * problem it fixes.
 *
 * `prepareCommand` is deliberately not a stage: it compiles the code the fix
 * session just wrote, so its failure IS the fix's business. Its output reaches
 * the patterns below, where the suite's own output is all there is to go on.
 *
 * Takes the result of a stage — `{ ok, stage?, tail }` — not a string.
 */
export function infrastructureFailure({ stage = null, tail = '' } = {}) {
  if (stage === 'install') return 'the project dependency install failed';
  const output = tail ?? '';
  const signals = [
    [/has overflowed its stack/, 'the server overflowed its stack on startup — the binary must be built in release'],
    [/config\.webServer was not able to start/, 'Playwright could not start its server'],
    [/EADDRINUSE/, 'a port the suite needs was already in use'],
    [/hfs binary not found/, 'there is no compiled hfs binary'],
  ];
  for (const [re, reason] of signals) if (re.test(output)) return reason;
  return null;
}

/** How a chosen title is named in the log. */
const TITLE_SOURCE = {
  commit: 'subject of the fix commit',
  issue: 'issue title, clipped if needed',
  user: 'the one you wrote on the card',
};

/**
 * Parks the proposal on the card and returns the error to throw with it.
 *
 * The text is what failed here, and a Retry would recompute exactly the same
 * rejected title for ever — which is what made #1125 unrecoverable from the
 * board. So the proposal waits where you can edit it, and «Publicar PR»
 * resumes at this very phase: nothing before it is paid for again.
 */
function parkPr(task, proposal, problems) {
  task.prPark = { proposal, problems, at: new Date().toISOString() };
  store.touch(task);
  return new Error(`Could not open the PR for ${task.branch}: ${problems.join('; ')}. Edit it on the card and press «Publish PR».`);
}

/**
 * What this branch changes, as a prompt section. Shared by the demo steps and
 * the PR body: both are written about the diff, and a second copy of this
 * would be a second chance to drift from what the branch really touched.
 */
async function diffSection(task) {
  const diff = await machineOf(task).exec('git', ['diff', '--stat', `origin/${baseOf(task)}...HEAD`], { cwd: task.worktreePath });
  return diff.ok && diff.stdout.trim()
    ? `\nArchivos que cambia esta rama:\n\`\`\`\n${diff.stdout.trim().slice(-1500)}\n\`\`\`\n`
    : '';
}

/**
 * How the Browser QA went, in one line, or nothing when it never ran.
 *
 * The verdict and the counts and no more: the evidence is screenshots and
 * video, and a PR body here carries neither — naming the files would put paths
 * nobody can open into a document a reviewer reads.
 */
function qaSection(task) {
  const results = task.qa?.results;
  if (!results) return '';
  const { passed = 0, failed = 0, unverified = 0 } = results.counts ?? {};
  return `\nBrowser QA sobre esta misma rama: veredicto ${results.verdict ?? 'sin veredicto'}`
    + ` (${passed} paso(s) pasan, ${failed} fallan, ${unverified} sin verificar).`
    + ' Cuéntalo en una frase si aporta; no enlaces capturas ni vídeos.\n';
}

/**
 * The body of the PR, written by a session that has read the diff.
 *
 * It runs inside the `pr` phase, before `draftPrPhase`: the fix, the tests and
 * the Browser QA have converged, so the diff will not change under it, and the
 * PR does not exist yet, so nothing has to be edited afterwards.
 *
 * Two attempts at most, and then the board's own body. A PR that never opens is
 * worse than a PR whose body is thin, and the thin one is still a PR a person
 * can improve by hand.
 */
/** The project's PR language: English unless the registry says otherwise. */
const prLanguageOf = (task) => projectOf(task?.project)?.language ?? 'en';

/** True when this project has nothing that verifies a change on its own: no test command. */
export const hasNoVerification = (task) => !cfgOf(task).e2e?.testCommand;

/** The PR line that says so, in the project's language (English for anything but Spanish). */
export function noVerificationLine(language = 'en') {
  return /^es([-_]|$)/i.test(String(language ?? '').trim())
    ? 'Sin verificación automática configurada para este proyecto.'
    : 'No automated verification is configured for this project.';
}

/** `body` plus the no-verification line when the project has none (never twice). */
function withVerificationNote(task, body) {
  if (!hasNoVerification(task)) return body;
  const line = noVerificationLine(prLanguageOf(task));
  return String(body).includes(line) ? body : String(body).replace(/\s+$/, '') + '\n\n' + line + '\n';
}

export async function composePrBody(task, issue) {
  const stage = 'pr';
  // Like every other phase: a session opened against a closed window dies in
  // seconds and costs the run its resume point. The `pr` phase is where it
  // comes back, with the PR still unopened.
  if (quotaHoldsNewWork(task)) throw new QuotaExhausted('pr');
  const cfg = cfgOf(task);
  const tune = tunedSession(task, 'pr', { stage, cfg });
  const { model } = tune;
  const onEvent = claudeLogger(task, stage);
  store.addLog(task, stage, `writing the PR body with ${model}`);

  const base = renderPrompt('pr-body', {
    ...promptVarsFor(task, stage),
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueBody: issue.body || '(vacío)',
    branch: task.branch,
    // No default in `AUTOMATIC` for this one: a body written without having
    // seen the diff is exactly what this phase exists to prevent.
    diffSection: await diffSection(task),
    triageSummary: task.triageSummary ? `\nLo que dijo el triage del issue:\n${task.triageSummary}\n` : '',
    qaSection: qaSection(task),
  });

  let extra = '';
  let problems = ['the session returned nothing'];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await nudgedSession(task, 'pr-body', {
      machine: machineOf(task),
      cwd: task.worktreePath,
      ...tune,
      maxTurns: 20,
      onEvent,
      canUseTool: taskCanUseTool(task, stage),
      hooks: ghGateHooks(task, stage),
      prompt: base + extra,
    }, { enabled: attempt === 1 });
    // Out of quota this behaves like the rest of the phase: the PR is not open
    // yet, so the run parks on `pr` and writes the body when the window does.
    if (result.quota) throw new QuotaExhausted('pr');
    const body = answerOf(result, (t) => {
      const b = String(t).trim();
      // As strict as the acceptance below (structure AND language), plus: a body
      // opens with its first heading, so a preamble before it is never usable.
      if (b === '' || !b.startsWith('#')) return false;
      const withCloses = ensureClosesLine(b, issue.number);
      return !prBodyProblems(withCloses, issue.number).length
        && !publishProblems(withCloses, { maxChars: 60_000, language: prLanguageOf(task) }).length;
    }, sealedAnswerNote(task, stage, result)).trim();
    // A session that died on infrastructure leaves no text, and «el cuerpo
    // está vacío» is not why. Say what actually happened before asking again,
    // or the second attempt looks like a model that would not write.
    if (!result.ok && !body) {
      store.addLog(task, stage, `⚠️ the PR body session ended with an error (${result.error ?? 'no result'})`);
    }
    // The first draft already closes its issue: the line is appended when the
    // session left it out, instead of costing a round trip over three words.
    const closed = body ? ensureClosesLine(body, issue.number) : body;
    problems = [
      ...prBodyProblems(closed, issue.number),
      // The publish gate's language rule, at the project's language: a body that
      // would be refused when it is published is asked for again here instead.
      ...(closed ? publishProblems(closed, { maxChars: 60_000, language: prLanguageOf(task) }) : []),
    ];
    if (!problems.length) {
      const finalBody = withVerificationNote(task, closed);
      task.prBody = finalBody;
      store.touch(task);
      store.addLog(task, stage, `PR body written (${finalBody.length} characters)`);
      return finalBody;
    }
    store.addLog(task, stage, `⚠️ the PR body is not usable (${problems.join('; ')})${attempt < 2 ? '; asking again' : ''}`);
    extra = prBodyComplaint(problems);
  }

  task.prBody = null;
  store.addLog(task, stage, `⚠️ no usable body in two attempts (${problems.join('; ')}); the PR is opened with the usual body`);
  return null;
}

/** What `draftPrPhase` reaches for outside itself; injectable as `PIPELINE_STEPS` is. */
const PR_STEPS = { pushBranch, findPrForBranch, createDraftPr, commitSubject, prView };

/** Puts a PR at the head of the task's history, replacing an older copy of it. */
function prependPr(task, pr) {
  task.prs = [pr, ...(task.prs ?? []).filter((p) => p.number !== pr.number)];
}

export async function draftPrPhase(task, issue, steps = PR_STEPS) {
  store.addLog(task, 'pr', `pushing ${task.branch} and creating the draft PR`);
  // Whatever is parked belongs to the previous attempt. Cleared before the
  // push, so a push that fails does not leave the card offering «Publicar PR»
  // with a stale proposal and a reason that has nothing to do with what just
  // failed; this attempt parks again only if the title is what fails.
  task.prPark = null;
  // A push that fails is infrastructure, not text: it must never park a title.
  await withInfraRetries(task, 'pr', 'the push', () => steps.pushBranch(machineOf(task), task.worktreePath, task.branch, { onLine: (l) => store.addLog(task, 'pr', l) }));

  // A retry after a crash between push and here already has its PR — as long
  // as that PR is still open. One merged since belongs to an earlier cycle,
  // and returning on it is how #787 ended up «in draft» over a merged PR.
  if (task.prNumber) {
    const number = task.prNumber;
    const live = await withInfraRetries(task, 'pr', `the query of PR #${number}`, () => steps.prView(number, task.project));
    if (isOpenPr(live)) return;
    store.addLog(task, 'pr', `PR #${task.prNumber} is ${live?.state === 'MERGED' ? 'merged' : 'closed'}: this cycle needs a new one`);
    task.prNumber = null;
    task.prUrl = null;
  }

  // The branch may already carry an open PR — from an earlier run whose state
  // was lost, or one opened by hand. Adopt it instead of failing on "already
  // exists". Only an open one: a merged or closed PR is a finished cycle, and
  // GitHub happily takes a new PR from the same branch.
  const existing = await steps.findPrForBranch(task.branch, task.project);
  if (isOpenPr(existing)) {
    task.prNumber = existing.number;
    task.prUrl = existing.url;
    prependPr(task, {
      number: existing.number, url: existing.url, title: existing.title ?? '', state: existing.state,
      createdAt: existing.createdAt ?? null, mergedAt: null, closedAt: null,
    });
    task.reopenedAt = null;
    task.cycleStartedAt = null;
    // The adopted PR carries whoever's body it was opened with, and this phase
    // does not rewrite it. Keeping ours would have the card claim a body the
    // PR on GitHub does not have.
    task.prBody = null;
    store.addLog(task, 'pr', `the branch already had PR #${existing.number} (${existing.state}); adopting it instead of creating another`);
    store.touch(task);
    return;
  }

  // Yours if you wrote one; otherwise the commit's subject, and failing that
  // the issue's title clipped to what GitHub accepts.
  const chosen = task.prTitle
    ? { title: task.prTitle, source: 'user', rejected: [] }
    : choosePrTitle({
      branch: task.branch,
      issueTitle: issue.title,
      commitSubject: await steps.commitSubject(machineOf(task), task.worktreePath, { base: baseOf(task) }),
    });
  for (const r of chosen.rejected) {
    store.addLog(task, 'pr', `title discarded (${TITLE_SOURCE[r.source] ?? r.source}): ${r.problems.join('; ')}`);
  }
  if (!chosen.title) {
    const last = chosen.rejected.at(-1);
    throw parkPr(
      task,
      last?.title ?? `${prTypeFor(task.branch)}: ${issue.title}`,
      last?.problems ?? ['there is no publishable title for this branch'],
    );
  }
  store.addLog(task, 'pr', `PR title (${TITLE_SOURCE[chosen.source] ?? chosen.source}): ${chosen.title}`);

  // Read once, per project: the global text claims an e2e validation that a
  // project with another verification command never ran.
  const prSignature = cfgOf(task).identity?.prSignature;
  let pr;
  try {
    pr = await steps.createDraftPr({
      // Whose repository this PR is opened in. Without it every project's PR
      // landed in hfs, a repository the task has nothing to do with.
      project: task.project,
      branch: task.branch,
      title: chosen.title,
      // What `composePrBody` wrote, and failing that the body this phase has
      // always composed. Nothing this board publishes names the board: PRs,
      // commits and comments land in a shared repo, and the tool that drove
      // them is Edson's business. Configurable, and an empty signature drops
      // the line entirely — on both bodies alike.
      body: [
        ensureClosesLine(task.prBody
          ? task.prBody
          : withVerificationNote(task, [`Closes #${issue.number}`, '', task.triageSummary ?? ''].join('\n')), issue.number),
        // The signature claims an e2e validation: only a project that has one says so,
        // and a project may word it differently or drop it (`overrides.identity.prSignature`).
        ...(prSignature && !hasNoVerification(task) ? ['', prSignature] : []),
      ].join('\n'),
    });
  } catch (e) {
    // Whatever gh or the gate says, the task keeps everything it has done and
    // waits on the card for a title it can publish.
    const problems = publishProblems(chosen.title, { maxChars: PR_TITLE_MAX });
    throw parkPr(task, chosen.title, problems.length ? problems : [e.message]);
  }
  task.prNumber = pr.number;
  task.prUrl = pr.url;
  // `createDraftPr` answers with the number and the URL only; the rest is
  // known here, and the card's PR list wants the whole shape at once.
  prependPr(task, {
    number: pr.number, url: pr.url, title: chosen.title, state: 'DRAFT',
    createdAt: new Date().toISOString(), mergedAt: null, closedAt: null,
  });
  // The cycle has its PR: the «♻️ Reabierta» pill has said what it had to,
  // and from here on the PR list itself tells this cycle from the earlier ones.
  task.reopenedAt = null;
  task.cycleStartedAt = null;
  store.addLog(task, 'pr', `draft PR created: ${pr.url}`);
  store.touch(task);
}

/**
 * Manual validation steps for the Demo panel. Resumes the fix session, so the
 * steps describe what was actually changed rather than what the issue asked for.
 */
export async function generateDemoSteps(task, issue = null) {
  // It resumes the principal's session on the worktree a move is leaving.
  assertNotMoving(task);
  // A click gets a 409 with the hour; the pipeline's own last step gets the
  // exception that parks the task at `demo` instead of losing its resume point.
  if (quotaHoldsNewWork(task)) throw new QuotaExhausted('demo');
  if (task.demoBusy) throw new Error('The demo steps are already being generated');
  const cfg = cfgOf(task);
  if (!(await isProjectWorktree(machineOf(task), task.worktreePath))) {
    throw new Error('This task has no worktree. Create it first with «🌳 Create worktree».');
  }
  task.demoBusy = true;
  store.touch(task);
  try {
    const meta = issue ?? await getIssue(task.issue, task.project);
    const services = Object.values(task.stack?.services ?? {}).filter((s) => s.healthy);
    const live = task.stack?.status === 'running' && services.length > 0;

    // Ground the steps in what this branch actually changed.
    const diff = await diffSection(task);

    // What the board would start, and the host placeholders the Demo panel
    // substitutes (`<LABEL_URL>`, see `DemoPanel.jsx`): both derived from this
    // project's `stack.services`, never written out. The text used to name
    // hfs's services, its start-up command and one of its code systems, so a
    // second project was told to demo servers it does not have.
    const stackLabels = Object.entries(cfg.stack?.services ?? {}).map(([name, s]) => s.label ?? name).filter(Boolean);
    const stackList = stackLabels.join(' y ') || 'los servidores del proyecto';
    const placeholders = stackLabels.map((l) => `\`<${l}_URL>\``).join(' o ') || '`<SERVICIO_URL>`';

    const serversSection = live
      ? `LOS SERVIDORES DE ESTA TAREA ESTÁN LEVANTADOS AHORA MISMO:
${services.map((s) => `- ${s.label}: ${s.localUrl ?? s.url}`).join('\n')}

Úsalos: recorre tú mismo la funcionalidad con curl antes de escribir nada. Cada URL que pongas debe ser una que hayas abierto y que haya respondido, y cada identificador (código, id de recurso, sistema, ValueSet…) debe salir de una respuesta real que hayas visto, nunca inventado. Si una página necesita un recurso concreto, búscalo primero (por ejemplo listando \`${services[0].localUrl ?? services[0].url}/CodeSystem?_count=5\`) y usa un id que exista de verdad.`
      // Three branches, not two. The middle one is for a project the board CAN
      // start but that is down right now: it points at the card's start button
      // and at the host placeholders the board substitutes, both named from
      // `stack.services`. The third, for a project the board cannot start, asks
      // the session to read the repository instead of telling it what is there
      // — and it is the model the middle one now follows.
      : cfg.stack
        ? `LOS SERVIDORES NO ESTÁN LEVANTADOS.
- En «Preparación» pon exactamente esto y nada más: pulsar el botón de arranque (▶️) en la tarjeta del tablero, que compila y levanta ${stackList} en puertos libres y ya configurados entre sí. NO inventes un arranque manual: el tablero los levanta con la preparación que necesitan, y hacerlo a mano tarda muchísimo o queda a medias.
- Para las URLs usa como host el prefijo literal ${placeholders} — el tablero los sustituye por el puerto real y los vuelve clicables — pero TODO lo que va después del host debe ser real y verificado: una ruta que exista en el código y un identificador que exista de verdad en el repositorio, nunca \`<id>\`.
- Los identificadores sácalos de datos que existan de verdad en el repo (fixtures de tests, datos de semilla o de bootstrap, migraciones) y cita el archivo:línea de donde los tomaste.`
        : `ESTE PROYECTO NO SE LEVANTA DESDE EL TABLERO: no hay ningún servidor que el tablero sepa arrancar ni ninguna URL que pueda sustituir.
- En «Preparación» pon los pasos reales de este repositorio y nada más: sácalos de su propia documentación (README, Makefile, los scripts de package.json o pyproject.toml) y cita el archivo:línea de donde los tomaste. Si no encuentras cómo se arranca, dilo en esa sección en vez de inventarlo.
- No uses marcadores de host de ningún tipo. Si un paso necesita una dirección, tiene que ser la que produzcan los comandos que acabas de poner en «Preparación», tal y como los escribiste.
- Los identificadores sácalos de datos que existan de verdad en el repo (fixtures de tests, datos de semilla, migraciones) y cita el archivo:línea de donde los tomaste.`;

    const onEvent = claudeLogger(task, 'demo');
    const startedAt = Date.now();
    releasePrincipal(task);
    const demoTune = tunedSession(task, 'demo', { cfg });
    const result = await nudgedSession(task, 'demo', {
      machine: machineOf(task),
      cwd: task.worktreePath,
      ...demoTune,
      resume: principalChat(task)?.sessionId ?? undefined,
      maxTurns: 40,
      onEvent,
      hooks: ghGateHooks(task, 'demo'),
      prompt: renderPrompt('demo', {
        ...promptVarsFor(task, 'demo'),
        issueNumber: meta.number,
        issueTitle: meta.title,
        branch: task.branch,
        diffSection: diff,
        serversSection,
        workPlan: workPlanContract('las comprobaciones que hiciste para escribir estos pasos'),
        baseBranch: baseOf(task),
      }),
    }, { before: () => releasePrincipalForNudge(task) });
    if (result.sessionId) principalChat(task).sessionId = result.sessionId;
    if (result.quota) throw new QuotaExhausted('demo');
    // The plan line rides at the end of the steps and is for the board, not
    // the person reading the panel.
    const steps = demoStepsOf(task, result);
    if (!steps.trim()) throw new Error('Claude returned no steps');
    // What the turn left behind is only worth keeping if the turn worked.
    // There is a task on disk whose `demoSteps` are the usage-limit notice
    // itself, written because nothing here ever looked at the result.
    if (!result.ok) {
      throw new Error(`the demo session ended with an error (${result.error ?? 'no result'}): partial steps are not saved`);
    }
    if (looksLikeUsageLimit(steps)) {
      throw new Error('the session returned a usage-limit notice instead of validation steps: nothing is saved');
    }
    // Drop any "voy a escribir los pasos…" preamble before the first heading.
    const start = steps.indexOf('## ');
    task.demoSteps = start > 0 ? steps.slice(start) : steps;
    store.addLog(task, 'demo', 'manual validation steps generated');

    const plan = await workPlanFrom(task, 'demo', result, {
      machine: machineOf(task), cwd: task.worktreePath, model: demoTune.model, tuning: demoTune, onEvent,
    });
    reportParallelism(task, 'demo', plan, result.toolCounts, Date.now() - startedAt);
  } finally {
    task.demoBusy = false;
    store.touch(task);
  }
}

/**
 * Deletes the task's worktree on the machine it runs on, to free disk space.
 * The branch, any PR and the chats' sessions survive: the transcripts live
 * outside the worktree, so creating it again resumes the same conversations.
 * `removePlace` does the work, and refuses while anything runs on the task.
 */
export async function deleteWorktree(issue) {
  assertNoUpgradeRunning();
  const task = store.get(issue);
  if (!task || !task.worktreePath) throw new Error('The task has no worktree');
  assertNotMoving(task);
  return removePlace(task, task.machine ?? 'local');
}

// ---------------------------------------------------------------------------

/** Commits and files that landed on the branch since a given sha. */
async function changesSince(machine, wtPath, sha) {
  if (!sha) return { commits: [], files: [] };
  const [log, diff] = await Promise.all([
    machine.exec('git', ['log', '--oneline', '--no-decorate', `${sha}..HEAD`], { cwd: wtPath }),
    machine.exec('git', ['-c', 'core.quotePath=false', 'diff', '--name-only', `${sha}..HEAD`], { cwd: wtPath }),
  ]);
  const lines = (r) => (r.ok ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []);
  return { commits: lines(log), files: lines(diff) };
}

/**
 * Tells a chat what the others did while it was not looking.
 *
 * Two moments, because they are different problems. This one runs when a turn
 * starts and is computed live from `lastSeenSha` — a note written in advance
 * would be stale by the time a turn that waited its turn in the mutex finally
 * runs. The other lives in the hook below, for what happens *during* a turn.
 */
async function siblingsBriefing(task, chat) {
  const { commits, files } = await changesSince(machineOf(task), task.worktreePath, chat.lastSeenSha);
  return renderSiblings({
    me: chat.title,
    busy: busySiblings(task, chat.id),
    commits,
    files,
  });
}

/**
 * The part that was impossible until the SDK moved on: a running session cannot
 * be handed anything, but a hook fires between one tool call and the next, and
 * what it returns as `additionalContext` lands in the conversation right there.
 *
 * Two things travel this way. A chat learns what its sibling just committed
 * *before* its next edit, rather than twenty minutes later when its turn ends.
 * And what you type while the chat is working reaches the model at its next
 * step — it answers in line and carries on, instead of you waiting for the
 * turn to end to be heard.
 *
 * Only on the main thread: hooks fire inside subagents too, and a question for
 * the agent delivered to an Explore subagent would be answered to nobody.
 */
export function chatHooks(task, chat, live) {
  return {
    PreToolUse: [{
      hooks: [async (input) => {
        // The one place the delegate's tool_use_id is visible: the MCP handler
        // never sees it. Parked here so the delegated session's events can be
        // nested under the tool item that started them.
        if (input?.tool_name === 'mcp__opencode__delegate') live.opencodeCalls.push({ id: input.tool_use_id, task: input.tool_input?.task });
        if (input?.agent_id) return {};
        const parts = [];
        const news = drainNews(chat);
        if (news) parts.push(`[Aviso del tablero, mientras trabajabas]\n${news}`);
        for (const note of drainNotes(chat)) {
          parts.push(`[Mensaje del usuario, mientras trabajabas — contéstale en tu respuesta y sigue]\n${note.text}${attachmentsNote(note.attachments)}`);
          markDelivery(task, chat, note.messageId, 'inline');
        }
        if (!parts.length) return {};
        return {
          hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: parts.join('\n\n') },
        };
      }],
    }],
  };
}

/**
 * Everything a chat session is handed, in one place so a test can read it.
 *
 * Two `PreToolUse` sets side by side — the chat's own (sibling news and what
 * you typed mid-turn, main thread only) and the language gate, which wants the
 * subagents too — and the push guard's `Stop`. The guard is passed here and
 * never through a settings file: both kinds of session load `user` and
 * `project` settings, and a pipeline session must not be told to push. Git runs
 * on the task's own machine, because the hook is a callback on this side of
 * the wire.
 */
export function chatSessionHooks(task, chat, live) {
  return mergeHooks(
    chatHooks(task, chat, live),
    ghGateHooks(task, 'chat', { chat, live }),
    chatStopHooks(task, chat, {
      exec: (...args) => machineOf(task).exec(...args),
      log: (line) => store.addLog(task, 'chat', line),
      baseBranch: baseBranchOf(task.project),
    }),
  );
}

/**
 * Drops the delegate ids the hook parked, at the end of a turn.
 *
 * A call the hook saw but whose handler never ran — the arguments failed the
 * schema, the turn was interrupted — would otherwise sit there for good, and
 * the next delegate with the same task text would claim that dead id and hang
 * its events under a tool item from another turn.
 */
export function forgetOpencodeCalls(live) {
  if (live?.opencodeCalls) live.opencodeCalls.length = 0;
}

const attachmentsNote = (attachments = []) => (attachments.length
  ? `\n\nEl usuario adjuntó estos archivos; ábrelos con la herramienta Read (las imágenes se ven directamente):\n${
    attachments.map((a) => `- ${a.path}`).join('\n')}`
  : '');

/** Tells a user bubble which way it reached the model. */
function markDelivery(task, chat, messageId, delivery) {
  const message = chat.messages.find((m) => m.id === messageId);
  if (message) store.updateChat(task, chat, message, { patch: { delivery } });
}

// ---------------------------------------------------------------------------
// The live session behind each chat, and what it tells the panel.

const liveKey = (ownerKey, chatId) => `${ownerKey}:${chatId}`;

/**
 * Chats whose turn has begun but whose session may not exist yet — a project
 * chat can spend minutes in `prepareHolderTurn` (fetch, checkout, the first
 * `git worktree add`). `chat.busy` is already true there, yet `sendChat`'s
 * «busy with a live process» test is false, so a second message would start a
 * second concurrent turn. Keyed by `liveKey`, valued by a token so a nested
 * `runTurn` (heal, notes) that re-registers is not undone by the outer one.
 */
const starting = new Map();

/** A project chat's owner (a «holder») is task-shaped but is not a task: `kind` is the one discriminator. */
const isHolder = (owner) => owner?.kind === 'project';

/**
 * The identity of whoever owns a chat, for every map, log and queue on the chat
 * path: a task's `<project>#<issue>`, or a holder's `<project>@<machine>`. The
 * two shapes cannot collide, so `liveKey` is unique across owners.
 */
export const ownerKeyOf = (owner) => (isHolder(owner) ? holderKey(owner.project, owner.machine) : keyOf(owner));

/** Seams for tests: what a project chat needs from `projectchats.js`. */
export const chatOwnerHooks = {
  get: (key) => getHolderByKey(key),
  ensure: (holder, opts) => ensureHolderWorktree(holder, opts),
  refresh: (holder) => refreshHolderWorktree(holder),
};

/** The door every chat entry point goes through: a holder key unchanged, anything else as a task key. */
const chatKeyIn = (key) => (typeof key === 'string' && isHolderKey(key) ? key : keyIn(key));

/** The owner of a chat: the holder a holder key names, or the task. `undefined`/`null` when unknown. */
export function chatOwnerOf(key) {
  return typeof key === 'string' && isHolderKey(key) ? chatOwnerHooks.get(key) : store.get(key);
}

/** «unknown owner» for an error message, in the words that fit the owner's kind. */
const unknownOwner = (key) => (typeof key === 'string' && isHolderKey(key)
  ? `Chat de proyecto ${key} desconocido`
  : `Unknown task #${key}`);

/**
 * {@link tunedSession} for a session that belongs to one chat: the chat's own
 * model, effort and thinking win over the role's defaults (`tuningFor` never
 * overrides them). An explicit `auto` on the chat passes nothing at all; `null`
 * means the chat chose nothing and the role «chat» applies. A chat thinking of
 * `enabled` carries no budget of its own: it comes from the role «chat»'s, or
 * the minimum. Not recorded in `task.phaseModels`: the chat header shows the
 * chat's own pair.
 */
export function chatSessionTuning(task, chat, role, { stage = role, cfg = cfgOf(task) } = {}) {
  const t = tunedSession(task, role, { stage, cfg, record: false });
  if (chat?.model) t.model = chat.model;
  if (chat?.effort === 'auto') delete t.effort;
  else if (chat?.effort) t.effort = chat.effort;
  if (chat?.thinking === 'auto') delete t.thinking;
  else if (chat?.thinking && typeof chat.thinking === 'object') {
    // The number is never the chat's: it comes from the role «chat», or the minimum.
    const { type } = chat.thinking;
    if (type !== 'enabled') t.thinking = { type };
    else t.thinking = { type, budgetTokens: (t.thinking?.type === 'enabled' ? t.thinking.budgetTokens : undefined) ?? THINKING_BUDGET.min };
  } else if (t.thinking && typeof t.thinking === 'object'
    && !thinkingModesFor(t.model, t.available ?? []).includes(t.thinking.type)) {
    // Inherited from the role, and this chat's model does not accept it: not
    // the chat's choice, so it is left out silently instead of warning.
    delete t.thinking;
  }
  return t;
}

/**
 * What this chat's effort comes to once clamped to its model, for the panel:
 * the level the session will actually get, or null (auto, or a model with no
 * effort at all).
 */
export function chatEffectiveEffort(task, chat) {
  try {
    const t = chatSessionTuning(task, chat, 'chat');
    return t.effort ? (clampEffort(t.model, t.effort, t.available) ?? null) : null;
  } catch { return null; }
}

/** The chat's live state, creating the session on first use. */
function liveOf(task, chat) {
  const key = liveKey(ownerKeyOf(task), chat.id);
  let live = liveChats.get(key);
  if (live) return live;
  live = { activity: null, tails: new Map(), session: null, pending: new Map(), planFile: null, plansBefore: [], planRuns: new Map(), opencodeCalls: [], artifactOk: new Set() };
  migrateChat(chat);
  const machine = machineOf(task);
  const cfg = cfgOf(task);
  live.session = new ChatSession({
    machine,
    cwd: task.worktreePath,
    ...chatSessionTuning(task, chat, 'chat', { cfg }),
    resume: chat.sessionId ?? null,
    // Available in every chat regardless of which Claude model is running it:
    // a subagent to another provider, not a config the person has to opt into.
    // A missing/unlogged `opencode` on this machine fails just that one tool
    // call (see opencode.js), never the chat itself.
    mcpServers: opencodeMcpServers({
      machine, cwd: task.worktreePath, configDir: opencodeConfigDirOf(machine, task),
      bin: config.opencode?.bin, model: config.opencode?.model, variant: config.opencode?.variant,
      timeoutMs: (config.opencode?.timeoutMinutes ?? 30) * 60_000,
      engine: config.opencode?.engine, harnessModel: config.opencode?.harnessModel,
      onEvent: (ev) => onChatEvent(task, chat, live, ev),
      // The hook parks one entry per delegate call; the handler claims its own
      // by task text, falling back to the oldest so two calls with the same
      // text still consume one entry each instead of leaking them.
      parentIdFor: (t) => {
        const i = live.opencodeCalls.findIndex((c) => c.task === t);
        const hit = i >= 0 ? live.opencodeCalls.splice(i, 1)[0] : live.opencodeCalls.shift();
        return hit?.id ?? null;
      },
    }),
    // A branched chat starts from its parent's history but must write its
    // own transcript; resuming plain would append to the parent's.
    forkSession: chat.forkPending === true,
    // Chat only: the two `PreToolUse` sets and the push guard's `Stop`.
    hooks: chatSessionHooks(task, chat, live),
    idleMs: (config.claude.chatIdleMinutes ?? 15) * 60_000,
    onEvent: (ev) => onChatEvent(task, chat, live, ev),
    // Plan mode: the CLI keeps the session read-only until the plan is
    // approved. The callback is a closure over `chat` and `live`, so it sees
    // the current state even though options are computed once per process.
    permissionMode: chat.planMode ? 'plan' : 'bypassPermissions',
    canUseTool: (name, input, ctx) => chatCanUseTool(task, chat, live, name, input, ctx),
    planModeInstructions: renderPrompt('plan-mode', { ...promptVarsFor(task, 'chat'), processRule: processRuleFor(machine) }),
    settings: { plansDirectory: `${PLANS_DIR}/${chat.id}` },
  });
  liveChats.set(key, live);
  return live;
}

// ---------------------------------------------------------------------------
// The tools that need a person: a question from the model, a plan to approve,
// and the board's own question when a plan task runs out of retries.

/** Something waiting on a person, on this chat. Resolves when they answer. */
function parkPending(task, chat, live, { id, kind, source, message, resolve, signal = null }) {
  const stored = store.pushChat(task, chat, message);
  chat.pending = { id, kind, source, askedAt: new Date().toISOString(), messageId: stored.id };
  chat.activity = kind === 'plan' ? 'waiting for your decision on the plan…' : 'waiting for your answer…';
  live.pending.set(id, { resolve, kind, messageId: stored.id, source });
  store.touch(task);
  signal?.addEventListener('abort', () => expirePending(task, chat, live, 'the session cancelled the question'), { once: true });
}

/**
 * Whether a parked wait dies with the turn. The board's own questions outlive it
 * (a plan keeps asking while no turn runs); a confirmation for an `Artifact`
 * call does not, because the call it holds is part of the turn that ended.
 */
const clearsWithTurn = (pending) => pending.source !== 'board' || String(pending.id).startsWith('artifact:');

/** Nobody can answer any more: the turn ended, Detener, the process went. */
function expirePending(task, chat, live, why) {
  const entry = chat.pending ? live.pending.get(chat.pending.id) : null;
  for (const [id, e] of live.pending) {
    e.resolve({ behavior: 'deny', message: `La pregunta caducó: ${why}. Decide con tu mejor criterio y sigue.` });
    live.pending.delete(id);
  }
  const changed = expirePendingMessages(chat);
  for (const m of changed) store.updateChat(task, chat, m, { patch: { status: 'expired', decidedAt: m.decidedAt } });
  if (chat.pending || entry) {
    chat.pending = null;
    store.touch(task);
  }
}

/** Seams for tests: what an approval starts, without starting real sessions. */
export const planHooks = { runChatPlan: (task, chat) => runChatPlan(task, chat) };

/** The live entry of a chat, for tests that drive the callback directly. */
export const liveEntryOf = (task, chat) => liveOf(task, chat);

/**
 * The SDK's permission callback for a chat. Under `bypassPermissions` only
 * `AskUserQuestion` reaches it; in plan mode, `ExitPlanMode` and any tool
 * the CLI would not run without asking. The language gate is not here — a Bash
 * call never arrives under bypass, so it lives in `ghGateHooks`.
 */
export async function chatCanUseTool(task, chat, live, name, input, ctx) {
  const deny = (message) => ({ behavior: 'deny', message });
  if (name === 'AskUserQuestion' || name === 'ExitPlanMode') {
    if (ctx?.agentID) return deny('Solo el hilo principal puede preguntar al usuario o pedir aprobación del plan; decide tú y sigue.');
    if (chat.pending) return deny('Ya hay una pregunta pendiente; espera a que se responda antes de hacer otra.');
  }
  if (name === 'AskUserQuestion') {
    const norm = normalizeQuestions(input);
    if (!norm.ok) return deny(`Las preguntas no tienen el formato esperado: ${norm.problem}. Corrígelo y vuelve a preguntar, o decide tú.`);
    return new Promise((resolve) => parkPending(task, chat, live, {
      id: ctx.toolUseID, kind: 'question', source: 'claude', resolve, signal: ctx.signal,
      message: { role: 'question', status: 'pending', source: 'claude', toolUseId: ctx.toolUseID, questions: norm.questions, ts: new Date().toISOString() },
    }));
  }
  if (name === 'ExitPlanMode') {
    const found = await findPlan(task, chat, live, input);
    if (!found.text) return deny('No encuentro el archivo del plan. Escríbelo en el archivo que se te indicó y vuelve a llamar a ExitPlanMode.');
    const read = readWorkPlan(found.text);
    if (!read.ok) return deny(workPlanComplaint(read.problem).trim() + ' Va al final del archivo del plan.');
    // The same mechanism, for the paragraph the plan has to open with: you are
    // the one about to approve this, and a table of file paths does not say
    // what the change does. Denying costs the turn one more write of the file.
    const missing = briefProblems(found.text);
    if (missing.length) return deny(briefComplaint(missing).trim() + ` El archivo del plan tiene que EMPEZAR por \`${PLAN_BRIEF_HEADING}\`.`);
    const record = newPlanRecord({ id: `plan-${Date.now().toString(36)}`, filePath: found.filePath, text: found.text, ...read.plan });
    return new Promise((resolve) => parkPending(task, chat, live, {
      id: ctx.toolUseID, kind: 'plan', source: 'claude', resolve, signal: ctx.signal,
      message: {
        role: 'plan', status: 'pending', toolUseId: ctx.toolUseID, ts: new Date().toISOString(),
        plan: found.text, filePath: found.filePath, tasks: record.tasks, waves: record.waves, record,
      },
    }));
  }
  // Artifact tools in plan mode: a read passes, and a call that changes
  // something passes only when the hook already got a person's yes for this very
  // call. The hook runs first and denies or holds everything else.
  if (isArtifactTool(name)) {
    if (!chat.planMode) return { behavior: 'allow' };
    const verdict = artifactVerdict({ tool: name, input, design: true, subagent: Boolean(ctx?.agentID), planMode: true });
    if (verdict.decision === 'allow' || (ctx?.toolUseID && live?.artifactOk?.has(ctx.toolUseID))) return { behavior: 'allow' };
    return deny('El chat está en modo plan: esa acción de Artifact no se ejecuta sin que una persona la confirme.');
  }
  // Plan mode: the CLI asks before anything that writes. The answer is no.
  // This one has to stay ahead of the language gate in the hook, and does:
  // nothing runs in plan mode, so the reason on the card should be the plan.
  if (chat.planMode) return deny('El chat está en modo plan: esa acción no se ejecuta hasta que el plan esté aprobado. Inclúyela en el plan.');
  return { behavior: 'allow' };
}

/** The plan text: from the tool call when it carries it, else the file the turn wrote. */
async function findPlan(task, chat, live, input) {
  const machine = machineOf(task);
  const dir = planDirFor(machine, task.worktreePath, chat.id);
  let filePath = live.planFile ?? null;
  if (!filePath) {
    const names = await machine.fs.readdir(dir).catch(() => []);
    const pick = pickPlanFile(names.map((n) => (typeof n === 'string' ? n : n.name)), { before: live.plansBefore, hint: null });
    if (pick) filePath = machine.path.join(dir, pick);
  }
  let text = null;
  if (filePath) text = await machine.fs.readFile(filePath).catch(() => null);
  if (!text && typeof input?.plan === 'string' && input.plan.trim()) text = input.plan;
  return { text, filePath };
}

/**
 * The person answered: a question (`answers` / `skip`), or a plan
 * (`approve` + `selected` / `revise` + `feedback`). First answer wins; a
 * second one, or one for a question that is gone, is refused with 409.
 */
export async function answerChatPending(issue, chatId, body = {}) {
  assertNoUpgradeRunning();
  const task = chatOwnerOf(issue);
  const chat = task && chatById(task, chatId);
  if (!chat) throw new Error('That chat does not exist');
  assertNotMoving(task);
  const gone = () => Object.assign(new Error('That question is no longer pending'), { code: 'PENDING_GONE' });
  if (!chat.pending || chat.pending.id !== body.id) throw gone();
  const live = liveChats.get(liveKey(ownerKeyOf(task), chat.id));
  const entry = live?.pending.get(body.id);
  const message = chat.messages.find((m) => m.id === chat.pending.messageId);
  if (!entry || !message) { if (live) expirePending(task, chat, live, 'the process was gone'); else { chat.pending = null; store.touch(task); } throw gone(); }

  const settle = (result, patch) => {
    live.pending.delete(body.id);
    chat.pending = null;
    chat.activity = 'pensando…';
    store.updateChat(task, chat, message, { patch: { ...patch, decidedAt: new Date().toISOString() } });
    store.touch(task);
    entry.resolve(result);
  };

  if (entry.kind === 'question') {
    if (body.decision === 'skip') {
      settle({ behavior: 'deny', message: skipMessage() }, { status: 'skipped' });
      store.addLog(task, 'chat', `«${chat.title}»: the question was left to Claude's judgment`);
      return { ok: true };
    }
    const checked = validateAnswers(message.questions, body.answers);
    if (!checked.ok) throw new Error(checked.problem);
    if (entry.source === 'board') {
      settle({ behavior: 'allow', answers: checked.answers }, { status: 'answered', answers: checked.answers });
    } else {
      settle({ behavior: 'allow', updatedInput: { questions: message.questions, answers: checked.answers } }, { status: 'answered', answers: checked.answers });
    }
    store.addLog(task, 'chat', `«${chat.title}»: ${describeAnswers(message.questions, checked.answers)}`);
    return { ok: true };
  }

  // A plan.
  if (body.decision === 'revise') {
    const feedback = String(body.feedback ?? '').trim();
    if (!feedback) throw new Error('Say what you want to change in the plan');
    settle({ behavior: 'deny', message: reviseMessage(feedback) }, { status: 'revise', feedback });
    store.addLog(task, 'chat', `«${chat.title}»: plan returned with changes`);
    return { ok: true };
  }
  if (body.decision !== 'approve') throw new Error('Unknown decision');
  const selected = Array.isArray(body.selected) && body.selected.length ? body.selected : message.record.tasks.map((t) => t.id);
  const record = applySelection(structuredClone(message.record), selected);
  chat.plan = record;
  settle({ behavior: 'deny', message: approveMessage(), interrupt: true }, { status: 'approved', selected: record.selected });
  store.addLog(task, 'chat', `«${chat.title}»: plan approved, ${record.selected.length} of ${record.tasks.length} tasks; the board runs it`);
  // The chat's own turn ends on that deny; the board takes it from here.
  setTimeout(() => planHooks.runChatPlan(task, chat).catch((e) => store.addLog(task, 'plan', `⚠️ ${e.message}`)), 500);
  return { ok: true };
}

/** Plan mode on or off for one chat, live if the process is up. */
export function setChatPlanMode(issue, chatId, on) {
  assertNoUpgradeRunning();
  const task = chatOwnerOf(issue);
  const chat = task && chatById(task, chatId);
  if (!chat) throw new Error('That chat does not exist');
  assertNotMoving(task);
  migrateChat(chat);
  if (!on && chat.pending?.kind === 'plan') throw new Error('Answer the pending plan first');
  if (!on && ['running', 'asking'].includes(chat.plan?.status)) throw new Error('A plan is running: stop it or wait for it to finish');
  chat.planMode = Boolean(on);
  liveChats.get(liveKey(ownerKeyOf(task), chat.id))?.session
    .setPermissionMode(chat.planMode ? 'plan' : 'bypassPermissions')
    .catch((e) => store.addLog(task, 'chat', `⚠️ could not change the mode live: ${e.message}`));
  store.addLog(task, 'chat', `«${chat.title}»: plan mode ${chat.planMode ? 'on' : 'off'}`);
  store.touch(task);
  return chat.planMode;
}

function handlePlanCommand(task, chat, argument) {
  const arg = argument.toLowerCase();
  if (arg === 'on' || arg === 'off') {
    try {
      setChatPlanMode(ownerKeyOf(task), chat.id, arg === 'on');
      store.addChat(task, chat.id, 'assistant', arg === 'on'
        ? 'Plan mode on: Claude only reads and proposes; the plan will be shown to you for approval, and the board will run it.'
        : 'Modo plan desactivado.');
    } catch (e) {
      store.addChat(task, chat.id, 'assistant', `⚠️ ${e.message}`);
    }
    return;
  }
  store.addChat(task, chat.id, 'assistant', `Plan mode: ${chat.planMode ? 'on' : 'off'}. Change it with /plan on or /plan off.`);
}

// ---------------------------------------------------------------------------
// The board running a chat's approved plan.

async function runChatPlan(task, chat) {
  const plan = chat.plan;
  if (!plan) return;
  const live = liveOf(task, chat);
  const host = chatPlanHost(task, chat, live);
  // Nothing of the chat's own turn should be running now; the deny with
  // interrupt ended it. Its activity tree closes, and the plan gets one.
  if (!plan.activityId) {
    const activity = store.pushChat(task, chat, { ...newActivity(), machine: machineOf(task).name });
    plan.activityId = activity.id;
  }
  chat.busy = true;
  chat.activity = 'running the plan…';
  store.touch(task);
  try {
    await runPlan(plan, host);
  } finally {
    if (plan.status !== 'running') {
      chat.busy = false;
      chat.activity = null;
      store.touch(task);
    }
  }
}

/** What the executor needs from a chat: forks from its session, reports into it, asks through it. */
function chatPlanHost(task, chat, live) {
  const cfg = cfgOf(task);
  const machine = machineOf(task);
  const cwd = task.worktreePath;
  const activityOf = () => chat.messages.find((m) => m.id === chat.plan?.activityId) ?? null;
  const emit = (ev) => {
    const activity = activityOf();
    if (!activity) return;
    const changed = applyEvent(activity, ev);
    if (changed) store.updateChat(task, chat, activity, changed);
  };
  const itemId = (t, attempt) => `plan:${t.id}${attempt > 1 ? `#${attempt}` : ''}`;
  const planMessage = () => chat.messages.find((m) => m.role === 'plan' && m.record?.id === chat.plan?.id) ?? null;
  const onChange = () => {
    const m = planMessage();
    if (m) store.updateChat(task, chat, m, { patch: { record: chat.plan, progress: planSummaryLine(chat.plan) } });
    const running = chat.plan.tasks.filter((t) => ['running', 'checking'].includes(t.status)).map((t) => t.id);
    const done = chat.plan.tasks.filter((t) => t.status === 'done').length;
    chat.activity = `running the plan: ${done} of ${chat.plan.tasks.filter((t) => t.status !== 'skipped').length}${running.length ? ` · ${running.join(', ')} running` : ''}`;
    store.touch(task);
  };
  // Tasks whose plan change the person approved since the last repair turn began.
  const changedFor = new Set();
  const propose = (t) => (args) => proposePlanChange({
    task, record: chat.plan, t, args, changedFor, onChange,
    busy: () => Boolean(chat.pending),
    // A chat's questions have no deadline but the MCP call does: race it, and on
    // timeout take away just this entry (the others are not ours to expire).
    ask: (question) => new Promise((resolve) => {
      const id = `${proposalPrefix(chat.plan, t)}${askSuffix()}`;
      const timer = setTimeout(() => {
        const entry = live.pending.get(id);
        if (!entry) return;
        live.pending.delete(id);
        const m = chat.messages.find((x) => x.id === entry.messageId);
        if (m && m.status === 'pending') {
          m.status = 'expired';
          m.decidedAt = new Date().toISOString();
          store.updateChat(task, chat, m, { patch: { status: 'expired', decidedAt: m.decidedAt } });
        }
        if (chat.pending?.id === id) chat.pending = null;
        store.addLog(task, 'plan', `the plan change proposal went unanswered: nobody answered within ${Math.round(askTimeoutMs() / 60000)} minutes`);
        store.touch(task);
        resolve(NO_ANSWER);
      }, askTimeoutMs());
      timer.unref?.();
      parkPending(task, chat, live, {
        id, kind: 'question', source: 'board',
        resolve: (r) => {
          clearTimeout(timer);
          if (r.behavior === 'allow') { resolve(readPlanChangeDecision(Object.values(r.answers)[0])); return; }
          // Skip, Detener, an expired turn: nobody decided, and the session must not be told somebody did.
          store.addLog(task, 'plan', `the plan change proposal went unanswered: ${String(r.message ?? 'the question expired').slice(0, 160)}`);
          resolve(NO_ANSWER);
        },
        message: { role: 'question', status: 'pending', source: 'board', toolUseId: id, questions: question.questions, preview: question.preview, ts: new Date().toISOString() },
      });
    }),
  });
  const mcpServers = (t) => planChangeMcpServers({ onPropose: propose(t), timeoutMs: askTimeoutMs() });
  // A session cut mid-proposal leaves the question parked: nobody can answer it any more.
  const expireProposal = (t) => {
    if (String(chat.pending?.id ?? '').startsWith(proposalPrefix(chat.plan, t))) expirePending(task, chat, live, 'the session ended');
  };

  return {
    forkFrom: chat.sessionId,
    maxRetries: config.plan?.maxRetries ?? 3,
    log: (line) => store.addLog(task, 'plan', line),
    onChange,
    runSession: async ({ task: t, attempt, resume, fork }) => {
      const id = itemId(t, attempt);
      emit({ kind: 'tool', id, name: 'Agent', parentId: null, input: `plan-task: ${t.id} ${t.what}`, args: { subagent_type: 'plan-task', description: `${t.id}: ${t.what}` } });
      const upstream = t.dependsOn.map((d) => chat.plan.tasks.find((x) => x.id === d)).filter((d) => d?.summary);
      const prompt = attempt === 1 || !t.lastFailure
        ? renderPrompt('plan-task', {
          ...promptVarsFor(task, `plan:${t.id}`),
          taskId: t.id, what: t.what, files: t.files.map((f) => `\`${f}\``).join(', ') || '(los que haga falta)',
          checkLine: t.check ? `- **Comprobación del tablero**: \`${t.check}\`\n` : '',
          upstream: upstream.length ? `\n\nLo que hicieron las tareas de las que dependes:\n${upstream.map((d) => `- **${d.id}** (${d.filesChanged.map((f) => `${f.path} +${f.added} −${f.removed}`).join(', ') || 'sin diff'}): ${d.summary.slice(0, 1500)}`).join('\n')}\n` : '',
          hint: t.hint ? `\n\nIndicación de la persona: ${t.hint}\n` : '',
          // See `fixPhase`: `renderPrompt` refuses a variable that is `undefined`.
          e2ePortEnv: cfg.e2e?.portEnv ?? '',
          processRule: processRuleFor(machine),
          shellRule: shellRuleFor(machine),
          tmpRule: tmpRuleFor(machine),
        })
        : renderPrompt('plan-retry', {
          ...promptVarsFor(task, `plan:${t.id}`),
          taskId: t.id, attempt, where: t.lastFailure.kind === 'check' ? `falló la comprobación \`${t.check}\`` : 'la sesión terminó con error',
          output: String(t.lastFailure.output ?? '').split(/\r?\n/).slice(-60).join('\n'),
          hint: t.hint ? `\nIndicación de la persona: ${t.hint}\n` : '',
        });
      const result = await fixHooks.runClaude({
        machine, cwd, ...chatSessionTuning(task, chat, 'fix', { stage: `plan:${t.id}`, cfg }),
        maxTurns: maxTurnsFor('chatPlan', cfg),
        resume: resume ?? undefined, forkSession: fork,
        hooks: ghGateHooks(task, `plan:${t.id}`, { chat, live }),
        mcpServers: mcpServers(t),
        onQuery: (q) => live.planRuns.set(t.id, q),
        onEvent: (ev) => {
          if (ev.kind === 'text' && !ev.parentId) emit({ kind: 'text', text: ev.text, parentId: id });
          else if (['tool', 'tool_end', 'progress', 'text'].includes(ev.kind)) emit({ ...ev, parentId: ev.parentId ?? id });
        },
        prompt,
      });
      live.planRuns.delete(t.id);
      noteMaxTurns(task, `plan:${t.id}`, result, maxTurnsFor('chatPlan', cfg));
      expireProposal(t);
      emit({ kind: 'tool_end', id, ok: result.ok, output: result.resultText ?? result.error ?? '', structured: null });
      return result;
    },
    // One more turn of the task's own session (resumed, never forked) over an
    // unrecoverable failure: it may fix code, or propose a plan change.
    repair: async (t) => {
      changedFor.delete(t.id);
      if (!t.sessionId) return { changed: false, quota: false };
      const id = `plan:${t.id}:repair#${t.attempts}`;
      emit({ kind: 'tool', id, name: 'Agent', parentId: null, input: `plan-repair: ${t.id} ${t.what}`, args: { subagent_type: 'plan-repair', description: `${t.id}: reparación` } });
      const result = await fixHooks.runClaude({
        machine, cwd, ...chatSessionTuning(task, chat, 'fix', { stage: `plan:${t.id}`, cfg }),
        maxTurns: maxTurnsFor('chatPlan', cfg),
        resume: t.sessionId,
        hooks: ghGateHooks(task, `plan:${t.id}`, { chat, live }),
        mcpServers: mcpServers(t),
        onQuery: (q) => live.planRuns.set(t.id, q),
        onEvent: (ev) => {
          if (ev.kind === 'text' && !ev.parentId) emit({ kind: 'text', text: ev.text, parentId: id });
          else if (['tool', 'tool_end', 'progress', 'text'].includes(ev.kind)) emit({ ...ev, parentId: ev.parentId ?? id });
        },
        prompt: repairPromptFor(task, machine, `plan:${t.id}`, t),
      });
      live.planRuns.delete(t.id);
      noteMaxTurns(task, `plan:${t.id}`, result, maxTurnsFor('chatPlan', cfg));
      expireProposal(t);
      emit({ kind: 'tool_end', id, ok: result.ok, output: result.resultText ?? result.error ?? '', structured: null });
      if (result?.sessionId) t.sessionId = result.sessionId;
      if (result?.quota) store.addLog(task, 'plan', `${t.id}: quota exhausted during the repair`);
      return { changed: changedFor.has(t.id), quota: Boolean(result?.quota) };
    },
    check: async (t) => {
      const r = await machine.posixShell(t.check, { cwd, timeoutMs: 20 * 60_000 }).catch((e) => ({ ok: false, stdout: '', stderr: e.message }));
      const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
      emit({ kind: 'tool', id: `plan:${t.id}:check`, name: 'Bash', parentId: itemId(t, t.attempts), input: `check: ${t.check}`, args: { command: t.check } });
      emit({ kind: 'tool_end', id: `plan:${t.id}:check`, ok: r.ok, output, structured: { stdout: r.stdout ?? '', stderr: r.stderr ?? '' } });
      return { ok: Boolean(r.ok), output: output.split(/\r?\n/).slice(-80).join('\n') };
    },
    fingerprint: (t) => worktreeFingerprint(machine, cwd, `plan-${t.id}`),
    filesChanged: async (t) => {
      if (!t.files.length) return [];
      const r = await machine.exec('git', ['diff', '--numstat', '--', ...t.files], { cwd });
      if (!r.ok) return [];
      return r.stdout.split(/\r?\n/).filter(Boolean).map((l) => {
        const [added, removed, ...rest] = l.split('\t');
        return { path: rest.join('\t'), added: Number(added) || 0, removed: Number(removed) || 0 };
      });
    },
    // It waits for a free slot and never overwrites another question.
    ask: async (t) => {
      while (chat.pending) {
        if (chat.plan.status !== 'running') return { action: 'stop' };
        await sleep(1000);
      }
      return new Promise((resolve) => {
        const bq = boardQuestion({ taskId: t.id, what: t.what, attempts: t.attempts, failure: t.lastFailure });
        const norm = normalizeQuestions(bq);
        const id = `board:${chat.plan.id}:${t.id}:${t.attempts}:${askSuffix()}`;
        parkPending(task, chat, live, {
          id, kind: 'question', source: 'board',
          resolve: (r) => resolve(r.behavior === 'allow' ? readBoardDecision(Object.values(r.answers)[0]) : { action: 'stop' }),
          message: { role: 'question', status: 'pending', source: 'board', toolUseId: id, questions: norm.questions, preview: bq.questions[0].preview, ts: new Date().toISOString() },
        });
      });
    },
    interrupt: (t) => { live.planRuns.get(t.id)?.interrupt?.().catch(() => {}); },
    close: async (plan) => {
      chat.planMode = false;
      await live.session.setPermissionMode('bypassPermissions').catch(() => {});
      store.addLog(task, 'plan', `plan finished: ${planSummaryLine(plan)}`);
      const summary = plan.tasks.filter((t) => t.status === 'done').map((t) =>
        `- **${t.id}** ${t.what}${t.attempts > 1 ? ` (${t.attempts} intentos)` : ''}: ${(t.summary ?? '').slice(0, 800)}`).join('\n');
      chat.busy = false;
      chat.activity = null;
      store.touch(task);
      runTurn(task, chat, `El tablero ejecutó el plan aprobado, cada tarea en una sesión propia que nació como rama de esta conversación. Resumen de lo que hizo cada una:\n${summary}\n\nAhora cierra tú: revisa \`git status\` y el diff completo de la rama, pasa las comprobaciones de este repositorio sobre lo tocado (formato, lint y los tests relevantes, con las herramientas que el repositorio use), corrige lo que haga falta, y commitea con un mensaje en inglés. Termina con un resumen corto.`);
    },
  };
}

/** Test seam: the two plan hosts, to drive their repair and proposal wiring with a fake `runClaude`. */
export const planHostsForTest = { fixPlanHost, chatPlanHost };

export function stopChatPlan(issue, chatId) {
  const task = chatOwnerOf(issue);
  const chat = task && chatById(task, chatId);
  if (!chat?.plan) throw new Error('That chat has no running plan');
  const live = liveOf(task, chat);
  if (chat.pending?.source === 'board') expirePending(task, chat, live, 'el plan se detuvo');
  stopPlan(chat.plan, chatPlanHost(task, chat, live));
  chat.busy = false;
  chat.activity = null;
  store.touch(task);
  return chat.plan.status;
}

// ---------------------------------------------------------------------------
// The same, at task level: a pipeline session asking, or the board waiting
// for a plan to be approved. Unlike a chat, the pipeline cannot wait for
// ever on a question — after `ask.timeoutMinutes` the model decides.

const taskPending = new Map();   // task key -> { resolve, timer, kind }

const askTimeoutMs = () => (config.ask?.timeoutMinutes ?? 20) * 60_000;

/**
 * `decode(answers)` turns the person's answers into what `resolve` takes, in
 * place of the board's retry/skip/stop reading. `none` is what `resolve` gets
 * when nobody answers (skip, timeout, expiry, no quota): with it, the entry is
 * a proposal the session made, and «no answer» must not stop the task — only a
 * board question can. The caller's `resolve` treats anything without
 * `approve === true` as not approved.
 */
function parkTaskPending(task, { id, kind, source, phase, questions = null, preview = null, resolve, timeoutMs = null, decode = null, none = undefined }) {
  // The board's own question, asked while the account has no quota: nobody can
  // answer it usefully — the answer is «retry» and the retry would hit the
  // same wall — and twenty minutes later it would stop the plan anyway. That
  // is exactly what happened. It is answered at once with the safe decision,
  // and the quota's own resumption brings the plan back.
  if (source === 'board' && kind !== 'plan' && quotaHoldsNewWork()) {
    store.addLog(task, phase, none !== undefined
      ? `⏳ quota exhausted: the plan change proposal went unanswered: no board question is parked`
      : `⏳ quota exhausted: no board question is parked; the plan stops and continues on its own ${describeResume(quotaHold())}`);
    resolve(none !== undefined ? none : { action: 'stop' });
    return;
  }
  task.pending = { id, kind, source, phase, askedAt: new Date().toISOString(), questions, preview };
  const timer = timeoutMs ? setTimeout(() => expireTaskPending(task, `nobody answered in ${Math.round(timeoutMs / 60000)} minutes`, 'timeout'), timeoutMs) : null;
  timer?.unref?.();
  taskPending.set(ownerKeyOf(task), { resolve, timer, kind, source, decode, none });
  store.addLog(task, phase, kind === 'plan' ? '📝 plan ready: waiting for your approval' : `❓ the session asks: waiting for your answer${timeoutMs ? ` (${Math.round(timeoutMs / 60000)} min)` : ''}`);
  store.touch(task);
}

/** Takes the parked wait off the task without answering it or broadcasting. */
function takeTaskPending(task) {
  const entry = taskPending.get(ownerKeyOf(task)) ?? null;
  if (entry?.timer) clearTimeout(entry.timer);
  taskPending.delete(ownerKeyOf(task));
  task.pending = null;
  return entry;
}

function settleTaskPending(task, result) {
  if (!taskPending.has(ownerKeyOf(task))) return false;
  const entry = takeTaskPending(task);
  store.touch(task);
  entry.resolve(result);
  return true;
}

/** The question can no longer be answered, or the time ran out. */
function expireTaskPending(task, why, how = 'gone') {
  const entry = taskPending.get(ownerKeyOf(task));
  if (!entry) { if (task.pending) { task.pending = null; store.touch(task); } return; }
  if (entry.kind === 'plan') return;                       // a plan waits as long as it takes
  const proposal = entry.none !== undefined;
  store.addLog(task, task.pending?.phase ?? 'chat', proposal
    ? `the plan-change proposal went unanswered: ${why}`
    : how === 'timeout'
      ? `⏱ no answer: ${why}; ${entry.source === 'board' ? 'the task stops' : 'Claude decides and goes on'}`
      : `the question expired: ${why}`);
  settleTaskPending(task, proposal
    ? entry.none
    : entry.source === 'board'
    ? { action: 'stop' }
    : { behavior: 'deny', message: how === 'timeout' ? timeoutMessage(config.ask?.timeoutMinutes ?? 20) : `La pregunta caducó: ${why}. Decide con tu mejor criterio y sigue.` });
}

/**
 * Whether there is a person in this turn.
 *
 * That is the whole criterion the state gate turns on, and it is worth having
 * as one predicate instead of a phase name compared in place: a chat is Edson
 * with the board open, watching every call as it happens, and a session the
 * board forked off that same chat to run a plan he wrote and approved is the
 * same turn one step later — he typed the request, he read the plan, he
 * pressed the button, and he is watching it run in the chat it came out of.
 * Asking there IS the confirmation, and a gate in the way is friction over a
 * decision already made by the only person entitled to make it.
 *
 * Everything else runs alone: nobody sees the call, no prompt asks for it, and
 * the board closes issues from its own window with a person in front of it.
 *
 * The plan's own tasks are named `plan:<id>` and the fix's are named
 * `fix:<id>`, so no unattended phase answers true here by accident — checked,
 * not assumed.
 */
const attended = (phase) => phase === 'chat' || String(phase ?? '').startsWith('plan:');

/** Work phases that may be a design session when a person marked the task. */
const DESIGN_MARKED_PHASES = ['plan', 'fix', 'gaps'];

/**
 * Whether this session is a design session: the one launched with the entrypoint
 * that carries the `Artifact` tools. A chat with a person in front is; an
 * unattended work phase is only when a person switched the task's mark on.
 *
 * The mark is `task.design === true`, written only by `setDesign`. It is never
 * read off the issue, its labels or the plan: an issue body can come from anyone.
 */
export function designSessionFor(task, stage) {
  if (attended(stage)) return true;
  if (task?.design !== true) return false;
  const s = String(stage ?? '');
  return DESIGN_MARKED_PHASES.includes(s) || s.startsWith('fix:');
}

/**
 * Asks a person whether one `Artifact` call may go ahead. Resolves `{ ok, why }`;
 * it never rejects. A chat (or a `plan:<id>` session, which lives in a chat)
 * parks a question on the chat; a marked task phase parks it on the task, with
 * the usual timeout. Both deny when it runs out. Only the exact «Sí, publicar»
 * lets the call through: «Otro» and any other answer are a no.
 */
function confirmArtifact(task, phase, ctx, { tool, input, toolUseId, signal }) {
  const norm = normalizeQuestions(artifactQuestion(tool, input));
  if (!norm.ok) return Promise.resolve({ ok: false, why: `No se pudo preguntar: ${norm.problem}` });
  const wait = { ok: false, why: 'Ya hay una pregunta pendiente; espera a que se responda y vuelve a intentarlo.' };
  const id = `artifact:${toolUseId ?? Date.now().toString(36)}`;
  const no = { ok: false, why: 'Una persona no confirmó esta acción de Artifact; no se ejecuta.' };
  if (attended(phase)) {
    const { chat, live } = ctx ?? {};
    if (!chat || !live) return Promise.resolve({ ok: false, why: 'No hay chat donde preguntar; la acción no se ejecuta.' });
    if (chat.pending) return Promise.resolve(wait);
    return new Promise((resolve) => {
      let timer = null;
      const done = (yes) => {
        clearTimeout(timer);
        if (yes && toolUseId) live.artifactOk?.add(toolUseId);
        resolve(yes ? { ok: true } : no);
      };
      parkPending(task, chat, live, {
        id, kind: 'question', source: 'board', signal,
        resolve: (r) => done(r?.behavior === 'allow' && isConfirmAnswer(Object.values(r.answers ?? {})[0])),
        message: { role: 'question', status: 'pending', source: 'board', toolUseId: id, questions: norm.questions, ts: new Date().toISOString() },
      });
      timer = setTimeout(() => { if (chat.pending?.id === id) expirePending(task, chat, live, 'nobody answered in time'); }, askTimeoutMs());
      timer.unref?.();
    });
  }
  if (task.pending) return Promise.resolve(wait);
  return new Promise((resolve) => parkTaskPending(task, {
    id, kind: 'question', source: 'board', phase, questions: norm.questions,
    resolve: (yes) => resolve(yes === true ? { ok: true } : no),
    timeoutMs: askTimeoutMs(),
    decode: (answers) => isConfirmAnswer(Object.values(answers ?? {})[0]),
    none: false,
  }));
}

/**
 * The `Artifact` gate as a `PreToolUse` hook: a `canUseTool` rule would never
 * run under bypass. It fails CLOSED — the opposite of the `gh` gate, because a
 * bug here would publish or delete something in a person's account.
 */
function artifactGateEntry(task, phase, ctx) {
  const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  return {
    matcher: 'Artifact|ArtifactComments|ArtifactData',
    // Seconds, a minute longer than the board's own timer, which denies first.
    timeout: Math.ceil(askTimeoutMs() / 1000) + 60,
    hooks: [async (input, toolUseId, options) => {
      try {
        const tool = input?.tool_name;
        if (!isArtifactTool(tool)) return {};
        const verdict = artifactVerdict({
          tool, input: input.tool_input, design: designSessionFor(task, phase), subagent: Boolean(input.agent_id),
          // Read now, not when the hook is built: plan mode can be toggled mid-session.
          // Only the chat's own session runs under the CLI's plan mode; `plan:<id>` runs
          // share the chat object (planMode true) but run under bypass.
          planMode: phase === 'chat' && ctx?.chat?.planMode === true,
        });
        if (verdict.decision === 'allow') return {};
        if (verdict.decision === 'deny') {
          store.addLog(task, phase, `⛔ denied: ${tool} — ${verdict.reason}`);
          return deny(verdict.reason);
        }
        const answer = await confirmArtifact(task, phase, ctx, {
          tool, input: input.tool_input, toolUseId: input.tool_use_id ?? toolUseId, signal: options?.signal,
        });
        if (answer.ok) return {};
        store.addLog(task, phase, `⛔ ${tool}: ${answer.why}`);
        return deny(answer.why);
      } catch (e) {
        try { store.addLog(task, phase, `⛔ the Artifact gate failed (${reasonOf(e)}); denied`); } catch { /* the denial stands */ }
        return deny('La compuerta de Artifact falló; la acción no se ejecuta.');
      }
    }],
  };
}

/**
 * Why this Bash line must not run, or null.
 *
 * `assertPublishable` guards everything the board publishes through its own
 * helpers, but a session with a Bash tool does not need them: #1445 left as a
 * `gh pr comment --body "…"` in Spanish, on a repository whose language is
 * English, and was public before anyone read the log. So the same check moves
 * to where the command is decided.
 *
 * This sits on the path of EVERY Bash call of every phase and every chat, so a
 * bug of its own must not be able to take a phase down: anything unexpected
 * lets the command through and says so on the card, which is the failure that
 * costs a comment rather than twenty minutes of work.
 */
async function ghGateDenial(task, phase, name, input) {
  if (name !== 'Bash') return null;
  const command = input?.command;
  if (typeof command !== 'string' || !command.trim()) return null;
  try {
    // What the line does, before what it says: closing an issue publishes no
    // prose, so the language gate below has nothing to look at and waves it
    // through.
    //
    // For the unattended turns only, and the exception is the point rather
    // than a hole: the question is not which verb it is, it is whether there
    // is a person in this turn. `attended` says where that person is.
    if (!attended(phase)) {
      const changed = stateChangeProblem(command);
      if (changed) {
        store.addLog(task, phase, `⛔ denied: a phase only reads from GitHub and publishes prose — ${command.slice(0, 160)}`);
        return changed;
      }
    }

    const machine = machineOf(task);
    const problems = await ghPublishProblems(command, {
      // On the machine the task runs on, not on the board's: a body written in
      // a worktree of the Linux runner is nowhere on this laptop's disk.
      //
      // And relative to the worktree, not to the board's process: the session's
      // cwd is the worktree, so `--body-file notes.md` means a file there.
      // Resolving it against the board's own cwd finds nothing, and «no he
      // podido leerlo» is a denial — for the very escape hatch `ghGateMessage`
      // recommends, which put the agent in a loop until it ran out of turns.
      readFile: (p) => machine.fs.readFile(worktreeRelative(machine, task, p)).catch(() => null),
    });
    if (!problems.length) return null;
    store.addLog(task, phase, `⛔ publishing with \`gh\` is not allowed: ${problems.join('; ')}`);
    return ghGateMessage(problems);
  } catch (e) {
    store.addLog(task, phase, `⚠️ could not check the \`gh\` of this command (${reasonOf(e)}); letting it through`);
    return null;
  }
}

/**
 * The language gate as a `PreToolUse` hook, which is the only place it can
 * actually stop a command.
 *
 * It lived in `canUseTool` first, and that was a gate nobody ever passed
 * through: every working session runs under `bypassPermissions`, and there the
 * CLI approves the call before the callback is consulted — the SDK says so
 * itself, once per session, as `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`, and its own
 * advice is this hook. A prompt asks and does not guarantee; a callback the
 * SDK never calls does not even ask.
 *
 * Hooks fire inside subagents too, and here that is the point rather than the
 * price: a subagent posting a comment publishes exactly as much as the main
 * thread does, and it goes through the same filter. (The chat's own hook wants
 * the opposite — see `chatHooks` — which is why the two stay separate and are
 * composed, not merged into one callback.)
 *
 * `matcher` narrows the CLI's side to Bash; `ghGateDenial` narrows ours again,
 * because a matcher is a loose pattern and `BashOutput` is not a command line.
 */
export function ghGateHooks(task, phase, ctx = null) {
  // Always for the triage and the advisor, not only while an install is in
  // flight: the gate stays pure (no config read that can throw) and there is no
  // window between launching the triage and starting the install.
  const installDenial = (t, stage, name, input) => {
    if (name !== 'Bash' || !INSTALL_GATED_PHASES.includes(stage)) return null;
    const problem = installProblem(input?.command);
    if (!problem) return null;
    try {
      store.addLog(t, stage, `⛔ denied: the board installs the dependencies — ${String(input?.command).slice(0, 160)}`);
    } catch { /* the denial stands even if the log does not */ }
    return problem;
  };
  const gate = {
    PreToolUse: [{
      matcher: 'Bash',
      hooks: [async (input) => {
        // This sits in front of every Bash call of every phase, so a bug of its
        // own must not be able to take a phase down. `ghGateDenial` already
        // catches what it can reach; this catches the rest — a tool_input that
        // is not the shape anyone expected, a store that is mid-move — and
        // lets the command through rather than killing the turn.
        try {
          // Two refusals, one hook, because both answer the same question about
          // the same Bash call and a second matcher would only cost a walk.
          const denied = (input?.tool_name === 'Bash' ? idleWaitProblem(input?.tool_input) : null)
            ?? installDenial(task, phase, input?.tool_name, input?.tool_input)
            ?? await ghGateDenial(task, phase, input?.tool_name, input?.tool_input);
          if (!denied) return {};
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: denied,
            },
          };
        } catch (e) {
          try {
            store.addLog(task, phase, `⚠️ the gate failed on this command (${reasonOf(e)}); letting it through`);
          } catch { /* the log is not worth the turn either */ }
          return {};
        }
      }],
    }, artifactGateEntry(task, phase, ctx)],
  };
  // The subagent gate is composed here, not in `runClaude`: `runClaude` would
  // need an exception for the chat, and nothing observable changes — `draft` and
  // `close` have no subagent tool, and a `plan:<id>` chat task goes through here
  // because the board consumes its answer.
  // Behind the Bash entry, which tests (and `ghgate.test.mjs`) address as
  // `PreToolUse[0]`; the Artifact entry is `[1]`. A chat has a person in front of it who reads the subagents
  // live and can wait for them, so it keeps them as the model launches them;
  // every phase runs alone, and a phase that ends its turn with a subagent still
  // out hands the board "they are still working" as its answer.
  return phase === 'chat' ? gate : mergeHooks(gate, subagentGateHooks());
}

/**
 * Denies every `gh` to a phase that is not allowed to write to GitHub at all.
 *
 * `ghGateHooks` judges the prose a command would publish, so a bare
 * `gh issue close 1274` — no `--comment`, no prose — walked straight through
 * it. This one asks the other question: for a phase whose whole contract is
 * «you draft, a person publishes», what matters is not *what* it would say but
 * whether it calls `gh` at all. `callsGh` errs on the cheap side by design: a
 * denied `echo gh` costs one turn, a missed `gh issue close` costs a public
 * write nobody confirmed.
 *
 * **It is the second belt, and since 2026-09-25 that is true rather than
 * aspirational.** `draftIssueClosing` now hands `runClaude` a tool list without
 * Bash (`tools: ['Read', 'Grep']`, which is what `close-issue.md` asks for), so
 * the drafting session has no shell to run `gh` in at all. That is the
 * structural answer; this hook stays for the phases that do get a shell, and
 * for the day somebody gives this one back its Bash without reading why it was
 * taken away.
 *
 * Defensive in the same shape as `ghGateHooks`, and for the same reason: a bug
 * of its own must cost a command that goes through and a line on the card,
 * never a phase that dies twenty minutes in.
 */
export function noGitHubWriteHooks(task, phase) {
  return {
    PreToolUse: [{
      matcher: 'Bash',
      hooks: [async (input) => {
        try {
          if (input?.tool_name !== 'Bash') return {};
          const command = input?.tool_input?.command;
          if (!callsGh(command)) return {};
          try {
            store.addLog(task, phase, `⛔ denied: this phase does not write to GitHub — ${String(command).slice(0, 160)}`);
          } catch { /* the log is not worth the turn */ }
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason:
                'Esta fase no puede llamar a `gh`: tú redactas y una persona publica desde el tablero. '
                + 'Todo lo que necesitas del issue, sus comentarios y la rama ya está en el prompt.',
            },
          };
        } catch (e) {
          try {
            store.addLog(task, phase, `⚠️ the «no gh» gate failed on this command (${reasonOf(e)}); letting it through`);
          } catch { /* idem */ }
          return {};
        }
      }],
    }],
  };
}

/**
 * Several hook sets as one. A chat has its own `PreToolUse` — the sibling news
 * and what you typed mid-turn — and the language gate has to join it without
 * taking its place: the SDK runs every callback under an event, so composing
 * is as simple as concatenating the matchers.
 */
export function mergeHooks(...sets) {
  const out = {};
  for (const set of sets) {
    for (const [event, matchers] of Object.entries(set ?? {})) {
      if (!matchers?.length) continue;
      out[event] = [...(out[event] ?? []), ...matchers];
    }
  }
  return out;
}

/**
 * A path as the session means it: absolute paths (and `~`, which the shell
 * expands and we must not touch) as they are, everything else under the
 * worktree the session runs in.
 */
function worktreeRelative(machine, task, p) {
  const raw = String(p ?? '');
  if (!task.worktreePath || !raw || raw.startsWith('~') || machine.path.isAbsolute(raw)) return raw;
  return machine.path.join(task.worktreePath, raw);
}

/**
 * The permission callback for a pipeline session: `AskUserQuestion`, and
 * nothing else.
 *
 * The language gate used to be here as well and no longer is: under
 * `bypassPermissions` the CLI approves a tool call before this runs, so the
 * only calls that arrive are the ones it would have had to ask about anyway.
 * `AskUserQuestion` is one of them — measured on CLI 2.1.281, whatever the
 * SDK's blanket warning says — and a Bash line is not, which is why the gate
 * moved to `ghGateHooks`.
 */
export function taskCanUseTool(task, phase) {
  return async (name, input, ctx) => {
    if (name !== 'AskUserQuestion') return { behavior: 'allow' };
    const deny = (message) => ({ behavior: 'deny', message });
    if (ctx?.agentID) return deny('Solo el hilo principal puede preguntar al usuario; decide tú y sigue.');
    if (task.pending) return deny('Ya hay una pregunta pendiente en esta tarea; decide tú y sigue.');
    const norm = normalizeQuestions(input);
    if (!norm.ok) return deny(`Las preguntas no tienen el formato esperado: ${norm.problem}. Decide tú y sigue.`);
    return new Promise((resolve) => parkTaskPending(task, {
      id: ctx.toolUseID, kind: 'question', source: 'claude', phase, questions: norm.questions, resolve, timeoutMs: askTimeoutMs(),
    }));
  };
}

/** A person answering what a task waits on: a question. Plans go through `decideTaskPlan`. */
export function answerTaskPending(issue, body = {}) {
  assertNoUpgradeRunning();
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  const gone = () => Object.assign(new Error('That question is no longer pending'), { code: 'PENDING_GONE' });
  if (!task.pending || task.pending.id !== body.id || task.pending.kind !== 'question') throw gone();
  const entry = taskPending.get(ownerKeyOf(task));
  if (!entry) { task.pending = null; store.touch(task); throw gone(); }
  const phase = task.pending.phase ?? 'chat';
  if (body.decision === 'skip') {
    store.addLog(task, phase, 'the question was left to Claude\'s judgment');
    settleTaskPending(task, entry.none !== undefined ? entry.none : entry.source === 'board' ? { action: 'stop' } : { behavior: 'deny', message: skipMessage() });
    return { ok: true };
  }
  const checked = validateAnswers(task.pending.questions, body.answers);
  if (!checked.ok) throw new Error(checked.problem);
  store.addLog(task, phase, describeAnswers(task.pending.questions, checked.answers));
  settleTaskPending(task, entry.decode
    ? entry.decode(checked.answers)
    : entry.source === 'board'
    ? readBoardDecision(Object.values(checked.answers)[0])
    : { behavior: 'allow', updatedInput: { questions: task.pending.questions, answers: checked.answers } });
  return { ok: true };
}

/** Whether this task waits for a person to approve its plan before the fix. */
export function approvePlanWanted(task) {
  if (task.approvePlan === 'on') return true;
  if (task.approvePlan === 'off') return false;
  return settings.approvePlanFor(task.project);
}

export function setApprovePlan(issue, mode) {
  assertNoUpgradeRunning();
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  if (!['auto', 'on', 'off'].includes(mode)) throw new Error('mode must be auto, on or off');
  task.approvePlan = mode;
  store.addLog(task, 'plan', `approve the plan before the fix: ${mode === 'auto' ? `per the board (${settings.approvePlanFor(task.project) ? 'yes' : 'no'})` : mode === 'on' ? 'yes' : 'no'}`);
  store.touch(task);
  return mode;
}

/** Whether this task closes its gaps before the PR: the task's own setting, else the board's. */
export function fixGapsWanted(task) {
  if (task.fixGaps === 'on') return true;
  if (task.fixGaps === 'off') return false;
  return settings.fixGapsFor(task.project);
}

export function setFixGaps(issue, mode) {
  assertNoUpgradeRunning();
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  if (!['auto', 'on', 'off'].includes(mode)) throw new Error('mode must be auto, on or off');
  task.fixGaps = mode;
  store.addLog(task, 'gaps', `close gaps before the PR: ${mode === 'auto' ? `per the board (${settings.fixGapsFor(task.project) ? 'yes' : 'no'})` : mode === 'on' ? 'yes' : 'no'}`);
  store.touch(task);
  return mode;
}

/** The per-task design mark. Only a person's action writes it; a strict boolean. */
export function setDesign(issue, on) {
  assertNoUpgradeRunning();
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  if (typeof on !== 'boolean') throw new Error(`on must be true or false, not ${JSON.stringify(on)}`);
  task.design = on;
  store.addLog(task, 'chat', `design session (Artifact) in the work phases: ${on ? 'yes' : 'no'}`);
  store.touch(task);
  return on;
}

/** Parks the pipeline on «Plan listo» until someone approves or asks for changes. */
function awaitPlanApproval(task, record) {
  store.setState(task, 'plan_ready');
  return new Promise((resolve) => parkTaskPending(task, {
    id: record.id, kind: 'plan', source: 'board', phase: 'plan', resolve,
  }));
}

/**
 * The plan a task is waiting on gets its answer. After a restart there is no
 * parked pipeline: the decision is stored and the pipeline is started again
 * from the fix, which finds the record and knows what to do with it.
 */
export function decideTaskPlan(issue, body = {}) {
  assertNoUpgradeRunning();
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  // Before the decision is taken: a pipeline that fails on the move would use it up.
  assertNotMoving(task);
  const record = task.workPlan;
  if (!record?.status || task.state !== 'plan_ready') throw Object.assign(new Error('This task has no plan waiting'), { code: 'PENDING_GONE' });
  // Only when the decision would have to start a pipeline (none parked on the
  // plan): a live run keeps going and its decision just wakes it.
  if (!taskPending.has(ownerKeyOf(task))) {
    const reassigned = unassignedReason(task);
    if (reassigned) throw conflict(reassigned);
  }
  if (body.decision === 'revise') {
    const said = String(body.feedback ?? '').trim();
    if (!said) throw new Error('Say what you want to change in the plan');
    const feedback = said.length > MAX_PLAN_FEEDBACK ? `${said.slice(0, MAX_PLAN_FEEDBACK - 1)}…` : said;
    // Without a pipeline parked on the plan (a restart) the run starts again,
    // and a manual task gets the one pass the click means, as `startTask`
    // gives it — or it would stop at the first phase boundary.
    const parked = taskPending.has(ownerKeyOf(task));
    if (!parked && !canAutoStart(task)) userRuns.add(ownerKeyOf(task));
    store.addLog(task, 'plan', `plan returned with changes: ${feedback.slice(0, 200)}`);
    const version = record.version ?? task.planVersion ?? 1;
    task.planVersion = Math.max(task.planVersion ?? 0, version);
    // The chat keeps the trail: this version turned down, what you asked for
    // in full, and the next version already planning.
    patchPlanBubble(task, record.messageId, { status: 'revise', feedback, decidedAt: new Date().toISOString() });
    const chat = principalChat(task);
    if (chat) store.pushChat(task, chat, { role: 'user', boardOnly: true, text: `✏️ Cambios al plan v${version}:\n${feedback}`, ts: new Date().toISOString() });
    // Kept on the task until a new plan replaces this one: a replanning that
    // fails, or a restart in the middle of it, leaves them for Retry.
    task.planFeedback = feedback;
    task.planRejectedText = record.text || renderWorkPlan(record);
    task.workPlan = null;
    // In this order, so no broadcast in between says «fixing» with a plan
    // still waiting or with nothing planning: the wait goes (silently), the
    // next version opens, and the card turns busy — all before the pipeline
    // wakes up.
    const entry = takeTaskPending(task);
    // Out of quota the changes are kept on the task (`planFeedback` above) and
    // the replanning happens by itself. A pipeline parked on the plan is told,
    // so it stops at this very boundary instead of burning a session against
    // the wall; one that is not parked is simply marked and waits.
    if (quotaHoldsNewWork(task)) {
      store.addLog(task, 'plan', `no quota: the replan will start on its own ${describeResume(quotaHold())}`);
      if (entry) entry.resolve({ action: 'quota' });
      else parkTaskForQuota(task, 'fixing');
      return { ok: true, parked: true };
    }
    beginPlanning(task, { kind: 'revise', feedback });
    store.setState(task, 'fixing');
    if (entry) entry.resolve({ action: 'revise', feedback });
    else startPipeline(task, 'fixing');
    return { ok: true };
  }
  if (body.decision !== 'approve') throw new Error('Unknown decision');
  const selected = Array.isArray(body.selected) && body.selected.length ? body.selected : record.tasks.map((t) => t.id);
  if (!taskPending.has(ownerKeyOf(task)) && !canAutoStart(task)) userRuns.add(ownerKeyOf(task));
  applySelection(record, selected);
  patchPlanBubble(task, record.messageId, { status: 'approved', selected: [...record.selected], decidedAt: new Date().toISOString() });
  store.addLog(task, 'plan', `plan approved: ${record.selected.length} of ${record.tasks.length} tasks`);
  // The approval and the selection are already on the record: out of quota the
  // executor runs it by itself when the window reopens, from the fix.
  if (quotaHoldsNewWork(task)) {
    store.addLog(task, 'plan', `no quota: the approved plan will run on its own ${describeResume(quotaHold())}`);
    if (!settleTaskPending(task, { action: 'quota' })) {
      task.pending = null;
      parkTaskForQuota(task, 'fixing');
    }
    return { ok: true, parked: true };
  }
  if (!settleTaskPending(task, { action: 'approve' })) {
    task.pending = null;
    store.touch(task);
    startPipeline(task, 'fixing');
  }
  return { ok: true };
}

export async function continueChatPlan(issue, chatId) {
  assertNoUpgradeRunning();
  const task = chatOwnerOf(issue);
  const chat = task && chatById(task, chatId);
  if (!chat?.plan) throw new Error('That chat has no plan to continue');
  assertNotMoving(task);
  if (chat.plan.status === 'running') throw new Error('The plan is already running');
  const live = liveOf(task, chat);
  chat.busy = true;
  chat.activity = 'resuming the plan…';
  store.touch(task);
  continuePlan(chat.plan, chatPlanHost(task, chat, live))
    .catch((e) => store.addLog(task, 'plan', `⚠️ ${e.message}`))
    .finally(() => { if (chat.plan.status !== 'running') { chat.busy = false; chat.activity = null; store.touch(task); } });
  return chat.plan.status;
}

/** Ends a chat's process. The next prompt resumes the transcript. */
export function closeLiveSession(issue, chatId) {
  // No task to ask here — `move.js` calls this while the store is being
  // rewritten — so the door coerces whatever it is given.
  const key = liveKey(chatKeyIn(issue), chatId);
  const live = liveChats.get(key);
  if (!live) return false;
  liveChats.delete(key);
  for (const stop of live.tails.values()) stop();
  live.tails.clear();
  const wasAlive = live.session.alive;
  live.session.close();
  return wasAlive;
}

/**
 * The board's phases resume the principal's transcript in a process of their
 * own; a live chat process appending to the same file at the same time would
 * fork it. So the chat lets go first, and picks the thread up again after.
 */
function releasePrincipal(task) {
  const principal = principalChat(task);
  if (principal) closeLiveSession(ownerKeyOf(task), principal.id);
}

/**
 * The `before` of a nudge that resumes the principal's session. The phase's own
 * first run released the chat, but `sendChat` does not look at what the phases
 * are doing: if the owner opened a turn in that chat meanwhile, closing it again
 * would kill the turn. Refusing makes `withNudge` keep the first answer.
 */
export function releasePrincipalForNudge(task, { startingTurns = starting, live = liveChats } = {}) {
  const principal = principalChat(task);
  const lk = principal && liveKey(ownerKeyOf(task), principal.id);
  // `starting` covers the window where `runTurn` set `busy` but the process is not alive yet.
  // The second argument only exists so a test can stand in for the two module-private maps.
  if (principal && (startingTurns.has(lk) || ['running', 'asking'].includes(principal.plan?.status)
    || (principal.busy && live.get(lk)?.session.alive))) {
    throw new Error('the main chat has a turn in progress');
  }
  releasePrincipal(task);
}

/** Closes every session of a task, and gives the processes a moment to leave. */
export async function closeTaskSessions(task) {
  let any = false;
  for (const chat of chatsOf(task)) any = closeLiveSession(ownerKeyOf(task), chat.id) || any;
  if (any) await new Promise((r) => setTimeout(r, 1000));
}

// The board is stopped with Ctrl+C; the processes it spawned should not outlive it.
process.on('exit', () => { for (const live of liveChats.values()) live.session.close(); });

/**
 * A turn that used no tool leaves nothing worth a tree. Kept, those would be
 * a third of a chat of short questions, against the 600-message cap.
 */
function dropIfEmpty(task, chat, activity) {
  if (!activity || activity.items.length) return;
  const at = chat.messages.indexOf(activity);
  if (at >= 0) chat.messages.splice(at, 1);
  store.updateChat(task, chat, activity, { patch: { removed: true } });
}

/**
 * The activity tree a late event belongs to. A subagent or a background
 * command outlives the turn that launched it, and its report has to land on
 * the tree that shows it, not on whatever turn is running now.
 */
function activityFor(chat, live, ev) {
  return treeFor(live.activity, chat.messages.filter((m) => m.role === 'activity'), ev);
}

// ---------------------------------------------------------------------------
// A subagent's calls, recovered from its own transcript.

/** The agent item with this call id, and the tree that holds it. */
function findAgent(chat, toolUseId) {
  for (const m of chat.messages) {
    if (m.role !== 'activity') continue;
    const agent = findItem(m.items ?? [], (i) => i.id === toolUseId && i.kind === 'agent');
    if (agent) return { tree: m, agent };
  }
  return null;
}

/**
 * Reads the subagent's transcript from the machine its turn ran on. A tree
 * is stamped with that machine when it is created; after a move the task runs
 * somewhere else, and the transcript is still where it was written, under the
 * slug of that machine's worktree path and that machine's session id.
 *
 * A tree from before the stamp could be from any machine the task lived on:
 * the active one is tried first, then every place.
 */
async function readAgentTranscript(task, chat, tree, agent) {
  if (!agent.taskId) throw new Error('That agent has no task id: there is no transcript to read');
  const active = task.machine ?? 'local';
  if (tree?.machine && !machines()[tree.machine]) {
    throw new Error(`That agent ran on ${tree.machine}, which is no longer in config.machines`);
  }
  const names = tree?.machine ? [tree.machine] : [...new Set([active, ...Object.keys(task.places ?? {})])];
  for (const name of names) {
    // With several to try, one that does not answer is just not the one.
    const lookup = agentTranscriptOn(task, chat, agent, name, active);
    const found = names.length > 1 ? await lookup.catch(() => null) : await lookup;
    if (found) return found;
  }
  throw new Error('Cannot find that agent\'s transcript');
}

/** The subagent's transcript on one machine, or null. */
async function agentTranscriptOn(task, chat, agent, name, active) {
  const { machine } = machineViewFor(task, name);
  if (!machine) return null;
  const place = task.places?.[name];
  const cwd = (name === active && task.worktreePath)
    || place?.worktreePath
    || (task.branch ? worktreePathFor(machine, task.branch) : null);
  if (!cwd) return null;
  const home = machine.kind === 'local' ? osHomedir() : (await machine.info()).home;
  const sessionIds = [chat.sessionId, place?.sessions?.[chat.id]].filter((s) => typeof s === 'string');
  const candidates = transcriptCandidates({
    home, cwd, sessionIds: [...new Set(sessionIds)], agentId: agent.taskId, join: (...p) => machine.path.join(...p),
  });
  for (const file of candidates) {
    if (await machine.fs.exists(file).catch(() => false)) {
      return { file, text: await machine.fs.readFile(file) };
    }
  }
  return null;
}

/**
 * Fills an agent's tree from its transcript: calls the stream never delivered
 * are added, and the ones that landed in other turns' trees — as if the main
 * thread had made them — are taken out of there.
 */
export async function backfillAgent(issue, chatId, toolUseId) {
  const task = chatOwnerOf(issue);
  const chat = task && chatById(task, chatId);
  if (!chat) throw new Error('That chat does not exist');
  const found = findAgent(chat, toolUseId);
  if (!found) throw new Error('That agent is not in this chat');
  const { tree, agent } = found;
  const { text } = await readAgentTranscript(task, chat, tree, agent);
  const calls = parseAgentTranscript(text, { agentRunning: agent.status === 'running' });
  const merged = mergeAgentCalls(agent, calls);
  const ids = new Set(calls.map((c) => c.id));

  let removed = 0;
  for (const m of chat.messages) {
    if (m.role !== 'activity' || m === tree) continue;
    const before = (m.items ?? []).length;
    const kept = (m.items ?? []).filter((i) => !ids.has(i.id));
    if (kept.length !== before) {
      removed += before - kept.length;
      store.updateChat(task, chat, m, { patch: { items: kept } });
    }
  }
  const parentId = findItem(tree.items ?? [], (i) => i.children?.includes(agent))?.id ?? null;
  store.updateChat(task, chat, tree, { item: agent, parentId });
  if (merged.added || removed) {
    store.addLog(task, 'chat', `«${chat.title}»: ${merged.added} agent call(s) recovered from its transcript${removed ? `, ${removed} removed from other turns` : ''}`);
  }
  return { ...merged, removed };
}

/** The agent's calls that scrolled out of the history, read from its transcript. */
export async function agentCalls(issue, chatId, toolUseId, { limit = 500 } = {}) {
  const task = chatOwnerOf(issue);
  const chat = task && chatById(task, chatId);
  if (!chat) throw new Error('That chat does not exist');
  const found = findAgent(chat, toolUseId);
  if (!found) throw new Error('That agent is not in this chat');
  const { tree, agent } = found;
  const { text } = await readAgentTranscript(task, chat, tree, agent);
  const kept = new Set((agent.children ?? []).map((c) => c.id));
  const earlier = parseAgentTranscript(text, { agentRunning: agent.status === 'running' }).filter((c) => !kept.has(c.id));
  return { total: earlier.length, calls: earlier.slice(-limit) };
}

// ---------------------------------------------------------------------------
// A background task only the session can stop.

/** A refusal the route turns into a 400 rather than a 500. */
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

/** The item with this id, and the tree that holds it, anywhere in the chat. */
function findActivityItem(chat, itemId) {
  for (const m of chat.messages) {
    if (m.role !== 'activity') continue;
    const item = findItem(m.items ?? [], (i) => i.id === itemId);
    if (item) return { tree: m, item };
  }
  return null;
}

/**
 * Asks the session to stop one of its background tasks — most often a server
 * it started to measure something and never brought down.
 *
 * The board cannot do it itself: the process belongs to Claude's CLI and only
 * Claude holds its background task id, so «stop» here means asking for a
 * `TaskStop` in the chat. The item goes `stopping` at once so the strip shows
 * the ask in flight; when the task really ends, the usual task-done path
 * closes it like any other.
 */
export async function stopBackground(issue, chatId, itemId) {
  const task = chatOwnerOf(issue);
  const chat = task && chatById(task, chatId);
  if (!chat) throw badRequest('That chat does not exist');
  // Before the item is marked: the ask goes through `sendChat`, which a move
  // answers without a turn, and the item would stay `stopping` for good.
  assertNotMoving(task);
  // The live turn's tree is one of the chat's messages too, so this finds it
  // whether the turn is still running or ended long ago.
  const found = findActivityItem(chat, itemId);
  if (!found) throw badRequest('That is no longer in this chat');
  const { tree, item } = found;
  if (!item.taskId) throw badRequest('That has no background task id: the session would not know what to stop');

  const { taskId } = item;
  const description = String(item.summary || item.command || '').trim().slice(0, 80);
  const stopping = markStopping(tree, itemId);
  if (stopping) {
    const parentId = findItem(tree.items ?? [], (i) => i.children?.includes(stopping))?.id ?? null;
    store.updateChat(task, chat, tree, { item: stopping, parentId });
  }
  // Mid-turn this is parked as a note and reaches the model at its next tool
  // call; `sendChat` already tells the two cases apart.
  sendChat(issue, chat.id, `[Board request] Stop the background task \`${taskId}\` (${description}) with the TaskStop tool and confirm in one line.`);
  store.addLog(task, 'chat', `«${chat.title}»: the session was asked to stop the background task ${taskId}`);
  return { taskId, status: 'stopping' };
}

/** What the session says, turned into what the panel shows. */
function onChatEvent(task, chat, live, ev) {
  switch (ev.kind) {
    case 'turn_start':
      chat.busy = true;
      live.authCard = false;
      // A turn the process started by itself — reacting to a background
      // command that finished — gets a tree of its own, like any other.
      if (!live.activity) live.activity = store.pushChat(task, chat, { ...newActivity(), machine: machineOf(task).name });
      chat.activity = chat.activity ?? 'pensando…';
      store.touch(task);
      return;

    case 'turn_end':
      chat.lastTurnAt = new Date().toISOString();
      if (!live.session.busy) {
        forgetOpencodeCalls(live);
        dropIfEmpty(task, chat, live.activity);
        live.activity = null;
        chat.busy = false;
        chat.activity = null;
        store.touch(task);
        refreshAfterChat(task);
      }
      return;

    case 'text': {
      if (ev.parentId) break;   // a subagent's narrative: part of its item
      // The `CLOSABLE:` line is addressed to the board, not to you:
      // `noteClosableOf` reads it when the turn ends and the card offers the
      // button. Left in, the bubble would show raw JSON — which is exactly
      // what the day the line shipped without a reader looked like.
      const said = stripTaggedLine(ev.text, 'CLOSABLE');
      if (!said.trim()) return;   // the line was the whole message
      // A turn the process started by itself (a background command finished)
      // tends to re-announce the same pending question, word for word, after
      // every notification. Saying it once is enough.
      if (!live.ownTurn && chat.messages.filter((m) => m.role === 'assistant').slice(-5).some((m) => m.text === said)) return;
      store.addChat(task, chat.id, 'assistant', said);
      chat.activity = 'drafting the reply…';
      return;
    }

    case 'error':
      store.addChat(task, chat.id, 'assistant', `⚠️ Error: ${ev.error}`);
      return;

    case 'auth':
      // Machine name and nothing else: messages are stored and broadcast to
      // every client, and the login URL never goes through here.
      if (!live.authCard) {
        live.authCard = true;
        store.pushChat(task, chat, { role: 'auth', machine: ev.machine, ts: new Date().toISOString() });
      }
      return;

    case 'init': case 'result': case 'warn':
      return;

    case 'session_closed': {
      // The process is gone — idled out, or died. A subagent or a background
      // command it was still running can never report now; left `running`,
      // its tree would spin in the panel for good (seen on #1069).
      for (const stop of live.tails.values()) stop();
      live.tails.clear();
      // A question parked in that process can never be answered either.
      if (chat.pending && clearsWithTurn(chat.pending)) expirePending(task, chat, live, 'the session closed');
      let cut = 0;
      for (const m of chat.messages) {
        if (m.role !== 'activity') continue;
        for (const item of closeAll(m, 'stopped')) { cut += 1; store.updateChat(task, chat, m, { item, parentId: null }); }
      }
      // A turn the process had started on its own ends with no `turn_end`
      // and no error of ours: without this the chat stayed «working» for
      // good, with Stop refusing and every message parked (seen on #937).
      // A turn of ours is settled by `runTurn` itself.
      if (chat.busy && !live.ownTurn) {
        chat.busy = false;
        chat.activity = null;
        live.activity = null;
        store.addChat(task, chat.id, 'assistant',
          `⚠️ The session closed with work in progress${cut ? ` (${cut} unfinished item${cut === 1 ? '' : 's'})` : ''}. `
          + 'The next message resumes it from where the transcript left off.');
        store.touch(task);
        // What was typed for it waits no longer.
        if ((chat.notes ?? []).length && liveChats.get(liveKey(ownerKeyOf(task), chat.id)) === live) runTurn(task, chat, '');
      }
      return;
    }

    default:
      break;
  }

  // In plan mode the only thing the CLI lets the model write is the plan
  // file: the path of that Write is the surest way to find the plan back.
  if (ev.kind === 'tool' && chat.planMode && !ev.parentId && (ev.name === 'Write' || ev.name === 'Edit') && ev.args?.file_path) {
    live.planFile = ev.args.file_path;
  }

  const activity = activityFor(chat, live, ev);
  if (!activity) return;
  const changed = applyEvent(activity, ev);
  if (!changed) return;
  store.updateChat(task, chat, activity, changed);

  const { item } = changed;
  if (item.background && item.kind !== 'agent' && item.outputFile) {
    if (item.status === 'running') followOutput(task, chat, live, activity, item);
    else stopFollowing(live, item.id);
  }
  if (activity === live.activity) {
    chat.activity = activityLabel(activity) || 'pensando…';
    store.touch(task);
  }
}

/**
 * A background command writes to a file as it goes; the panel shows that
 * file's tail while it runs. Read every second rather than watched: on
 * Windows a watcher on a file another process appends to is unreliable, and
 * one small read a second costs nothing.
 */
function followOutput(task, chat, live, activity, item) {
  if (live.tails.has(item.id)) return;
  let last = null;
  const read = async () => {
    try {
      const text = await machineOf(task).fs.tail(item.outputFile, MAX_OUTPUT);
      if (text === last) return;
      last = text;
      const changed = setOutput(activity, item.id, text);
      if (changed) store.updateChat(task, chat, activity, changed);
    } catch { /* not written yet, or gone */ }
  };
  const timer = setInterval(read, 1000);
  timer.unref?.();
  live.tails.set(item.id, () => { clearInterval(timer); read(); });
}

function stopFollowing(live, itemId) {
  const stop = live.tails.get(itemId);
  if (!stop) return;
  live.tails.delete(itemId);
  stop();   // one last read: the end of the output is what matters
}

/**
 * Chat: continues the task's Claude session inside its worktree, building the
 * worktree first when the task doesn't have one yet (started elsewhere, or
 * reclaimed for disk).
 */
export function sendChat(issue, chatId, text, attachments = []) {
  const task = chatOwnerOf(issue);
  if (!task) throw new Error(unknownOwner(issue));
  const chat = chatById(task, chatId);
  if (!chat) throw new Error((isHolder(task) ? `The project chat has no such chat` : `Task #${issue} has no such chat`));

  const message = store.addChat(task, chat.id, 'user', text, attachments.map((a) => a.name));
  // Answered, not thrown: what was typed stays in the panel with the reason it
  // went nowhere. Queuing it would deliver it to a session that is about to
  // be left behind on the other machine.
  const moving = movingReason(task);
  if (moving) {
    store.addChat(task, chat.id, 'assistant', `🚚 ${moving}: this message was not sent. Send it again when it finishes.`);
    store.touch(task);
    return;
  }
  // The same while the board upgrades itself: its sessions are about to close.
  if (upgradeRunning()) {
    store.addChat(task, chat.id, 'assistant', '⬆ updating: this message was not sent. Send it again when the board is back.');
    store.touch(task);
    return;
  }
  // And the same out of quota. Deliberately *not* queued: a message you typed
  // now must not reach a model by itself three hours from now, when what you
  // were asking about has moved on. It stays in the panel with the reason.
  if (quotaHoldsNewWork()) {
    store.addChat(task, chat.id, 'assistant',
      `⏳ Quota exhausted: this message was not sent. The account comes back ${describeResume(quotaHold())}; send it again then.`);
    store.touch(task);
    return;
  }
  // The first thing you ask is what the conversation is about, and it reads
  // better on a tab than "Chat 2".
  // Unless a person named it already: a title they typed is never overwritten.
  if (['Untitled', 'Sin título'].includes(chat.title) && !chat.titleManual) chat.title = titleFromPrompt(text, chat.title);

  // `/model …` is handled here rather than sent to Claude: the CLI's own slash
  // commands do not reach a session driven through the SDK, so typing one just
  // asked the model to do something it cannot do to itself.
  const command = text.match(/^\/model\b\s*(.*)$/i);
  if (command) {
    handleModelCommand(task, chat, command[1].trim());
    return;
  }
  const planCommand = text.match(/^\/plan\b\s*(.*)$/i);
  if (planCommand) {
    handlePlanCommand(task, chat, planCommand[1].trim());
    return;
  }

  // Typed while a turn runs: it does not wait behind the turn, it reaches the
  // model at its next tool call and gets answered in line. If the turn ends
  // before that, it becomes the next turn — nothing is dropped either way.
  // `busy` with no live process is a leftover, not a turn: that goes ahead.
  // While the board runs this chat's plan, the message waits for the closing
  // turn, which is where the conversation picks up.
  const planRunning = ['running', 'asking'].includes(chat.plan?.status);
  const lk = liveKey(ownerKeyOf(task), chat.id);
  if (planRunning || starting.has(lk) || (chat.busy && liveChats.get(lk)?.session.alive)) {
    leaveNote(chat, text, message.id, attachments);
    store.updateChat(task, chat, message, { patch: { delivery: 'pending' } });
    return;
  }
  runTurn(task, chat, text, attachments);
}

/**
 * Notes that found no opening — the turn ended, or the process went away —
 * ride at the front of the next prompt. `text` may be empty: then the notes
 * are the whole prompt.
 */
function withNotes(task, chat, text, attachments) {
  const notes = drainNotes(chat);
  for (const note of notes) markDelivery(task, chat, note.messageId, 'next');
  return {
    text: [...notes.map((n) => n.text), text].filter(Boolean).join('\n\n'),
    attachments: [...notes.flatMap((n) => n.attachments ?? []), ...attachments],
  };
}

/**
 * One turn of a chat, on its live session. `busy` is set here and cleared
 * here, inside the turn — it used to be set when the prompt was queued and
 * cleared when the *first* turn ended, so a second turn ran with the chat
 * looking idle: no spinner, no Stop button, and Pull/Push enabled under it.
 */
async function runTurn(task, chat, text, attachments = [], opts = {}) {
  // Not only `sendChat` gets here: a closed session with notes waiting, and
  // the end of the previous turn, do too — and the move's own handoff step
  // closes live sessions. The notes stay for the first turn after arriving.
  if (movingReason(task)) return;
  if (!text && !(chat.notes ?? []).length) return;
  const holder = isHolder(task);
  const startKey = liveKey(ownerKeyOf(task), chat.id);
  const startToken = {};
  starting.set(startKey, startToken);
  const doneStarting = () => { if (starting.get(startKey) === startToken) starting.delete(startKey); };
  chat.busy = true;
  chat.activity = 'starting the session…';
  store.touch(task);
  // The busy time of the turn, from here to wherever `busy` is cleared.
  const turnSpan = beginSpan(task, { kind: 'chat', name: 'turn', chatId: chat.id });
  let turnOutcome = 'ok';
  let turnStats = null;
  let turnCounts = null;
  // A project chat builds its own worktree on demand, and that has to happen
  // before anything reads `worktreePath`: `liveOf` hands it to the session as
  // its `cwd`, and the plans directory hangs off it.
  if (holder) {
    try {
      await prepareHolderTurn(task, chat);
    } catch (e) {
      store.addChat(task, chat.id, 'assistant', `⚠️ Could not prepare the project worktree: ${e.message}`);
      chat.busy = false;
      chat.activity = null;
      endSpan(task, turnSpan, { outcome: 'error' });
      doneStarting();
      store.touch(task);
      // What was typed while this was starting is not lost: it gets one more
      // try as its own turn, and if that fails too it rides the next prompt.
      if ((chat.notes ?? []).length && !opts.prepRetried) runTurn(task, chat, '', [], { ...opts, prepRetried: true });
      return;
    }
  }
  // Everything up to the `try` below can throw (a machine gone from the config,
  // the session's constructor, the plan-mode template): the turn must not be
  // left `busy` and «starting» for good, parking every later message as a note.
  let live;
  try {
    live = liveOf(task, chat);
    live.ownTurn = true;
    live.planFile = null;
    if (chat.planMode) {
      // What the plans directory holds before the turn: the file that appears
      // during it is the plan.
      const dir = planDirFor(machineOf(task), task.worktreePath, chat.id);
      live.plansBefore = (await machineOf(task).fs.readdir(dir).catch(() => [])).map((n) => (typeof n === 'string' ? n : n.name));
    }
  } catch (e) {
    if (live) live.ownTurn = false;
    store.addChat(task, chat.id, 'assistant', `⚠️ Could not open the session: ${e.message}`);
    chat.busy = false;
    chat.activity = null;
    endSpan(task, turnSpan, { outcome: 'error' });
    doneStarting();
    store.touch(task);
    return;
  }
  let headBefore = null;
  let heal = null;   // what to send again, on a fresh session, when this one was gone
  try {
    // Never build a worktree as a side effect of typing: it is a 17k-file
    // checkout, and a question *about* the worktree would silently recreate
    // one the user had just deleted. Creating it is its own explicit action.
    if (!holder && !(await isProjectWorktree(machineOf(task), task.worktreePath))) {
      store.addChat(task, chat.id, 'assistant',
        'This task has no worktree, so there is no session to run the prompt in. '
        + 'Press «🌳 Create worktree» to prepare it and send it again.');
      return;
    }
    ({ text, attachments } = withNotes(task, chat, text, attachments));
    // What the siblings did while this chat was away, worked out now rather
    // than pre-cooked.
    const siblings = await siblingsBriefing(task, chat);
    headBefore = await headCommit(machineOf(task), task.worktreePath);
    drainNews(chat);   // the briefing above already covers everything until now

    // Uploads land on this machine; Claude reads them on the task's. For a
    // local task that is the same place and `putAttachment` hands the path back.
    const machine = machineOf(task);
    // A project chat has no issue: its uploads go to the `_proyecto` directory.
    let placed;
    try {
      placed = await Promise.all(attachments.map(async (a) => ({
        ...a, path: await machine.putAttachment(ownerDirName(task), a.path, a.name),
      })));
    } catch (e) {
      // Said as what it is, not as a session that would not open; the `catch`
      // below shows it and the `finally` releases the chat as for any throw.
      e.attachmentFailed = true;
      throw e;
    }

    // The turn's tree goes right after the prompt that started it, stamped
    // with the machine whose transcripts it will point at.
    live.activity = store.pushChat(task, chat, { ...newActivity(), machine: machine.name });
    // Other systems the task lived on: earlier messages may quote their paths.
    const otherPlatforms = Object.keys(task.places ?? {})
      .filter((name) => name !== machine.name)
      .map((name) => machineViewFor(task, name).machine?.platform)
      .filter(Boolean);
    // A session closed while idle reopens on this send: hand it the tuning the
    // chat resolves to now, so a change of the role «chat» reaches chats that
    // inherit it when they reopen (they do not follow it live).
    if (!live.session.alive) {
      const t = chatSessionTuning(task, chat, 'chat');
      await live.session.retune({ model: t.model, effort: t.effort ?? null, thinking: t.thinking ?? null });
    }
    const rules = holder
      ? renderPrompt('chat-project-rules', {
        ...promptVarsFor(task, 'chat'),
        text,
        siblings,
        attachments: attachmentsNote(placed),
        processRule: processRuleFor(machine),
        shellRule: shellRuleFor(machine),
        tmpRule: tmpRuleFor(machine),
        machineNote: machineNoteFor({ machine, worktreePath: task.worktreePath, otherPlatforms }),
        project: task.project,
        repo: repoOf(task),
        baseBranch: baseOf(task),
        worktreePath: task.worktreePath,
        machine: machine.name,
      })
      : renderPrompt('chat-rules', {
        ...promptVarsFor(task, 'chat'),
        text,
        siblings,
        // See `fixPhase`: `renderPrompt` refuses a variable that is `undefined`.
        e2ePortEnv: cfgOf(task).e2e?.portEnv ?? '',
        attachments: attachmentsNote(placed),
        processRule: processRuleFor(machine),
        shellRule: shellRuleFor(machine),
        tmpRule: tmpRuleFor(machine),
        machineNote: machineNoteFor({ machine, worktreePath: task.worktreePath, otherPlatforms }),
        handoff: arrivalBlock(chat.handoff, {
          machineName: machine.name, platform: machine.platform, worktreePath: task.worktreePath, wip: chat.handoff?.wip,
        }),
      });
    const result = await live.session.send(rules);
    turnStats = result.stats ?? null;
    turnCounts = result.toolCounts ?? null;
    if (!result.ok && /No conversation found/i.test(result.error ?? '')) {
      // The session this chat resumes is gone from this machine — the CLI
      // deletes transcripts after 30 days — and every later turn would fail
      // the same way. Let it go, and the process with it: the next one starts
      // a conversation of its own. The handoff, if any, is kept for that turn.
      // The prompt is sent again once, there: the notes were already drained
      // into it, and dropping it would lose them with the message.
      // TODO: on a runner `RemoteProcess` (runner-client.js) forwards no
      // stderr, so the error there is only "exited with code 1" and this never
      // matches; the transcript check before a move restores an id is what
      // protects runners.
      chat.sessionId = null;
      chat.forkPending = false;
      closeLiveSession(ownerKeyOf(task), chat.id);
      if (!opts.healed) heal = { text, attachments };
      store.addChat(task, chat.id, 'assistant', opts.healed
        ? '⚠️ The previous conversation no longer exists on this machine and the new session did not start either. Send the message again.'
        : '⚠️ The previous conversation no longer exists on this machine: the chat starts from scratch and the message is resent to a new session.');
      store.addLog(task, 'chat', `«${chat.title}»: its session no longer has a transcript; starting from scratch`);
    } else if (result.sessionId) {
      chat.sessionId = result.sessionId;
      chat.forkPending = false;   // it has its own transcript from here on
    }
    // A turn that concluded «this issue needs no change» says so on its last
    // line. Picked up here and nowhere else — and `noteClosableOf` never
    // throws, because a throw inside this `try` would reach the person as
    // «No se pudo abrir la sesión», which is not what happened.
    noteClosableOf(task, chat, result.resultText);
    // The account ran out mid-turn. The turn ends here — it is not retried and
    // nothing is queued — and the live process is closed rather than left
    // holding the worktree for hours. `chat.busy` goes false in the `finally`
    // below, which matters: a chat left busy would be skipped by the
    // resumption for ever.
    if (result.quota) {
      store.addChat(task, chat.id, 'assistant',
        `⏳ Quota exhausted mid-turn: the conversation stops here and its session is closed so it does not hold the worktree.`
        + ` The account comes back ${describeResume(quotaHold())}; send the message again then.`);
      store.addLog(task, 'chat', `«${chat.title}»: turn cut short by exhausted quota`);
      closeLiveSession(ownerKeyOf(task), chat.id);
    }
    // Told once: a failed turn keeps it for the next one.
    if (result.ok && chat.handoff) chat.handoff = null;
    // No plan to hold a chat to — the prompt is the user's — but the count
    // still goes in the log, so a turn that fanned out is visible as such.
    const calls = Object.values(result.toolCounts ?? {}).reduce((a, b) => a + b, 0);
    if (calls) {
      store.addLog(task, 'chat', `«${chat.title}»: ${calls} herramienta${calls === 1 ? '' : 's'}, ${subagentsUsed(result.toolCounts)} subagentes`);
    }
  } catch (e) {
    turnOutcome = 'error';
    store.addChat(task, chat.id, 'assistant', e.attachmentFailed
      ? `⚠️ Could not carry the attachment: ${e.message}`
      : `⚠️ Could not open the session: ${e.message}`);
  } finally {
    // Not `closeAll`: a subagent or a background build launched by this turn
    // is still legitimately running, and reports to its tree when it ends.
    dropIfEmpty(task, chat, live.activity);
    live.activity = null;
    live.ownTurn = false;
    chat.lastTurnAt = new Date().toISOString();
    // A question the turn asked and never got answered cannot be answered now.
    if (chat.pending && clearsWithTurn(chat.pending)) expirePending(task, chat, live, 'the turn ended');
    chat.busy = false;
    chat.activity = null;
    endSpan(task, turnSpan, turnStats
      ? { outcome: turnOutcome, model: chat.model ?? cfgOf(task).claude.chatModel ?? null, costUsd: turnStats.costUsd ?? null, turns: turnStats.turns ?? null, tokens: turnStats.tokens ?? null, ...chatCallMeta(turnCounts) }
      : { outcome: turnOutcome, ...chatCallMeta(turnCounts) });
    // Right away, so the chat never looks idle between the two sends. Once:
    // a second "no conversation" on a session with no id is not this problem.
    if (heal) runTurn(task, chat, heal.text, heal.attachments, { healed: true });
    // What this turn left behind, told to the others and remembered as this
    // chat's own high-water mark.
    //
    // Both of these talk to the task's machine, and a `finally` is the one
    // place a throw has nowhere to go: `runTurn` is called fire-and-forget,
    // so a dev box that stopped answering turned this into an unhandled
    // rejection and Node killed the board — with every task on it. The turn
    // is already over by here; losing its bookkeeping costs a note to the
    // sibling chats and a stale `lastSeenSha`, and that is the whole price.
    try {
      const headAfter = await headCommit(machineOf(task), task.worktreePath);
      if (headAfter) chat.lastSeenSha = headAfter;
      // The project card shows where the shared worktree is standing now.
      if (holder) await observeHolderHead(task, headAfter);
      if (headBefore && headAfter && headAfter !== headBefore) {
        const { commits, files } = await changesSince(machineOf(task), task.worktreePath, headBefore);
        tellSiblings(task, chat.id, `La conversación «${chat.title}» acaba de commitear ${commits.length} cambio(s) en esta rama`
          + (files.length ? `, tocando:\n${files.slice(0, 15).map((f) => `- \`${f}\``).join('\n')}`
            + (files.length > 15 ? `\n- …y ${files.length - 15} más` : '')
            + '\n\nRelee con Read cualquiera de esos archivos antes de editarlo.' : '.'));
      }
    } catch (e) {
      store.addLog(task, 'chat', `⚠️ could not read what the turn of «${chat.title}» left (${reasonOf(e)})`);
    }
    // Outside the catch: the card has to stop looking busy even when the
    // machine that ran the turn is gone.
    store.touch(task);
    // The turn's commits are the card's "unpushed": measure now, not at the poll.
    refreshAfterChat(task);

    // What was typed mid-turn and found no opening becomes the next turn —
    // unless the board itself just closed this session to run a phase on the
    // transcript; then the notes wait for the next prompt.
    doneStarting();
    if ((chat.notes ?? []).length && liveChats.get(liveKey(ownerKeyOf(task), chat.id)) === live) runTurn(task, chat, '');
  }
}

/**
 * What a project chat needs before its turn: the worktree, and — on the first
 * turn of a conversation that has no session yet — the checkout brought up to
 * date, so a new conversation starts from where `origin/<base>` is now.
 *
 * All the chats of a project share one worktree, so it is never moved under a
 * sibling that is working: that turn goes ahead with a note instead. A failed
 * refresh is a log line, not a failed turn; a failed ensure throws.
 */
async function prepareHolderTurn(holder, chat) {
  const created = !holder.worktreePath;
  await chatOwnerHooks.ensure(holder);
  if (created || chat.sessionId) return;
  // Working, or holding something in the background (a build, a dev server, a
  // subagent): moving the checkout under either breaks it.
  const occupied = busySiblings(holder, chat.id).length > 0 || openChats(holder).some((c) => {
    if (c.id === chat.id) return false;
    const moving = chatRunning(c);
    return Boolean(moving && (moving.agents.running || moving.commands || moving.servers));
  });
  if (occupied) {
    store.addChat(holder, chat.id, 'assistant',
      `Hay otra conversación trabajando en este worktree: no lo he actualizado a origin/${baseOf(holder)}.`);
    return;
  }
  let result = null;
  try {
    result = await chatOwnerHooks.refresh(holder);
  } catch (e) {
    store.addLog(holder, 'chat', `⚠️ could not update the project worktree (${reasonOf(e)})`);
    return;
  }
  if (result?.head) holder.head = result.head;
  if (result?.note) store.addChat(holder, chat.id, 'assistant', result.note);
}

/** Records the branch (or detached) and short sha the project worktree is on. */
async function observeHolderHead(holder, sha) {
  if (!sha) return;
  const machine = machineOf(holder);
  const r = await machine.exec('git', ['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: holder.worktreePath });
  holder.head = { branch: r.ok ? (r.stdout.trim() || null) : null, sha: String(sha).slice(0, 7) };
}

/** The GitHub `owner/name` of the owner's project, or '' when the registry cannot say. */
function repoOf(owner) {
  try { return projectOf(owner?.project)?.repo ?? ''; } catch { return ''; }
}

/**
 * Names a conversation by hand. The title is kept as typed (trimmed, one line,
 * 80 characters at most) and `titleManual` stops the first prompt from
 * overwriting it. The owner's own emit carries the change to the panel.
 */
export function renameChat(key, chatId, title) {
  const owner = chatOwnerOf(key);
  if (!owner) throw new Error(unknownOwner(key));
  const chat = chatById(owner, chatId);
  if (!chat) throw new Error('That chat does not exist');
  const clean = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
  if (!clean) throw new Error('The title cannot be empty');
  chat.title = clean;
  chat.titleManual = true;
  store.touch(owner);
  return { id: chat.id, title: chat.title };
}

/**
 * A conversation as plain text — «role: text» per message, user and assistant
 * only — for whatever has to read it as input (the draft of an issue). When it
 * is longer than `maxChars` the newest part is kept, behind a marker saying so,
 * and the result is never longer than `maxChars`.
 */
export function chatTranscriptOf(key, chatId, { maxChars = 30000 } = {}) {
  const owner = chatOwnerOf(key);
  if (!owner) throw new Error(unknownOwner(key));
  const chat = chatById(owner, chatId);
  if (!chat) throw new Error('That chat does not exist');
  const full = (chat.messages ?? [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && String(m.text ?? '').trim())
    .map((m) => `${m.role}: ${String(m.text).trim()}`)
    .join('\n\n');
  if (full.length <= maxChars) return full;
  const marker = '[…earlier messages omitted]\n\n';
  if (maxChars <= marker.length) return full.slice(-Math.max(0, maxChars));
  return marker + full.slice(-(maxChars - marker.length));
}

/** Answers `/model` in the chat: no argument lists, an argument switches. */
function handleModelCommand(task, chat, argument) {
  const available = config.claude.available ?? [];
  const current = chat.model ?? cfgOf(task).claude.chatModel;

  if (!argument) {
    const list = available
      .map((m) => {
        const short = String(m.label).split(/\s+/)[0].toLowerCase();
        return `- ${short}${m.id === current ? ' (actual)' : ''} — ${m.label}${m.hint ? `: ${m.hint}` : ''}`;
      })
      .join('\n');
    store.addChat(task, chat.id, 'assistant', `Current model: ${current}\n\n${list}\n\nChange it with /model <short name>, for example /model opus.`);
    return;
  }

  const { match, ambiguous } = resolveModel(available, argument);
  if (ambiguous) {
    store.addChat(task, chat.id, 'assistant', `"${argument}" matches several: ${ambiguous.map((m) => m.label).join(', ')}. Be a little more specific.`);
    return;
  }
  if (!match) {
    const shorts = available.map((m) => String(m.label).split(/\s+/)[0].toLowerCase());
    store.addChat(task, chat.id, 'assistant', `I do not know "${argument}". Try: ${shorts.join(', ')}.`);
    return;
  }
  // Same flow as the picker (`setChatModel`); a thinking of the chat's own that the
  // new model does not accept is cleared, and the reply says so.
  const own = chat.thinking && typeof chat.thinking === 'object' ? chat.thinking : null;
  const clears = own && !thinkingModesFor(match.id, available).includes(own.type);
  setChatModel(ownerKeyOf(task), chat.id, match.id, undefined, clears ? null : undefined);
  store.addChat(task, chat.id, 'assistant',
    `Done: the next messages in this chat will use ${match.label} (${match.id}).`
    + (clears ? `\n\nThe «${own.type}» thinking of this chat is not valid on ${match.label}: I removed it and it inherits from the «chat» role again.` : ''));
}

/**
 * Picks the model, effort and thinking for this task's chat. Only ids the
 * config offers are accepted: the value is passed straight to the CLI, so an
 * unknown one would fail a turn later instead of here.
 *
 * An `undefined` argument keeps the chat's current value; `null` clears it
 * (the model falls back to the config's, effort and thinking to the role
 * «chat»'s). An effort is stored as chosen (the session clamps it to the model);
 * a thinking the resulting model does not accept is refused — also when only the
 * model changes and the chat's stored thinking stops fitting.
 *
 * A live session is retuned in place; when its thinking no longer fits it is
 * reopened (right away if idle, at the end of the turn if busy) and the chat
 * is told.
 */
export function setChatModel(issue, chatId, model, effort, thinking) {
  assertNoUpgradeRunning();
  const task = chatOwnerOf(issue);
  if (!task) throw new Error(unknownOwner(issue));
  const chat = chatById(task, chatId);
  if (!chat) throw new Error((isHolder(task) ? `The project chat has no such chat` : `Task #${issue} has no such chat`));
  const cfg = cfgOf(task);
  const available = cfg.claude.available ?? [];
  const allowed = available.map((m) => m.id);
  if (model && !allowed.includes(model)) {
    throw new Error(`Modelo desconocido: ${model}. Disponibles: ${allowed.join(', ')}`);
  }
  // The effort is per chat, like the model. `undefined` leaves it as it is; `null`
  // and `auto` both mean «pass nothing» / «the role's». It is not refused for
  // a level the model lacks: the panel shows the clamped level and the session
  // opens with it.
  let nextEffort;
  if (effort !== undefined) {
    if (effort === null || effort === '') nextEffort = null;
    else if (String(effort).trim().toLowerCase() === 'auto') nextEffort = 'auto';
    else nextEffort = normalizeEffort(effort);       // throws on a value that is not a level
  }
  // Thinking: null (or '') inherits the role «chat», 'auto' passes nothing,
  // otherwise `{ type, budgetTokens? }` (an `enabled` one may leave the budget to the role).
  let nextThinking;
  if (thinking !== undefined) {
    if (thinking === null || thinking === '') nextThinking = null;
    else if (typeof thinking === 'string' && thinking.trim().toLowerCase() === 'auto') nextThinking = 'auto';
    else if (thinking && typeof thinking === 'object' && !Array.isArray(thinking) && ['adaptive', 'enabled', 'disabled'].includes(thinking.type)) {
      // A budget sent for a chat is ignored: the number comes from the role «chat».
      nextThinking = { type: thinking.type };
    } else throw new Error('Thinking must be auto, null or { type: adaptive|enabled|disabled }');
  }
  const resultingModel = (model !== undefined ? (model || null) : chat.model) ?? cfg.claude.chatModel;
  const resultingThinking = nextThinking !== undefined ? nextThinking : chat.thinking;
  if (resultingThinking && typeof resultingThinking === 'object') {
    const modes = thinkingModesFor(resultingModel, available);
    if (!modes.includes(resultingThinking.type)) {
      throw new Error(`Model ${resultingModel} does not support ${resultingThinking.type} thinking (supports: ${modes.join(', ') || 'none'})`);
    }
  }
  if (model !== undefined) chat.model = model || null;
  if (nextEffort !== undefined) chat.effort = nextEffort;
  if (nextThinking !== undefined) chat.thinking = nextThinking;
  const live = liveChats.get(liveKey(ownerKeyOf(task), chat.id));
  // A live process switches in place; the next reply already uses it. The session
  // decides what that takes (the effort level re-applied, or a reopen when the
  // thinking it was opened with no longer fits).
  if (live?.session) {
    const t = chatSessionTuning(task, chat, 'chat', { cfg, stage: 'chat' });
    live.session
      .retune({ model: t.model, effort: t.effort ?? null, thinking: t.thinking ?? null })
      .then((r) => {
        if (!r?.reopened) return;
        const label = available.find((m) => m.id === t.model)?.label ?? t.model;
        store.addChat(task, chat.id, 'assistant', r.reason === 'thinking'
          ? 'I changed the thinking; I will reopen the session to apply it.'
          : `I switched to ${label}; I will reopen the session because its thinking is not compatible`);
        store.touch(task);
      })
      .catch((e) => store.addLog(task, 'chat', `⚠️ could not change the model live: ${e.message}`));
  }
  store.addLog(task, 'chat', `model of «${chat.title}»: ${chat.model ?? `${cfg.claude.chatModel} (default)`}${chat.effort ? `, effort ${chat.effort}` : ''}${chat.thinking ? `, thinking ${chat.thinking === 'auto' ? 'auto' : chat.thinking.type}` : ''}`);
  store.touch(task);
  return chat.model ?? cfg.claude.chatModel;
}

/** Opens another conversation on the same task. */
export function createChat(issue, { forkFrom = null } = {}) {
  assertNoUpgradeRunning();
  const task = chatOwnerOf(issue);
  if (!task) throw new Error(unknownOwner(issue));
  assertNotMoving(task);

  const parent = forkFrom ? chatById(task, forkFrom) : null;
  if (forkFrom && !parent) throw new Error('The chat you want to branch from does not exist');
  if (parent && !parent.sessionId) {
    throw new Error('That chat has not talked to anyone yet: there is nothing to branch');
  }

  const chat = addChatTo(task, {
    title: parent ? `branch of ${parent.title}` : 'Untitled',
    // It starts from the parent's history; `forkPending` makes the first turn
    // fork instead of appending to the parent's own transcript.
    sessionId: parent?.sessionId ?? null,
    model: parent?.model ?? null,
    effort: parent?.effort ?? null,
    thinking: parent?.thinking && typeof parent.thinking === 'object' ? { ...parent.thinking } : (parent?.thinking ?? null),
    forkedFrom: parent?.id ?? null,
  });
  if (parent) chat.forkPending = true;
  chat.lastSeenSha = parent?.lastSeenSha ?? null;

  store.addLog(task, 'chat', parent
    ? `new chat branched from «${parent.title}»`
    : 'new chat');
  store.touch(task);
  return chat;
}

/**
 * Takes a conversation's tab away. Nothing is lost: it keeps its messages and
 * its session, and comes back from the history. The process behind it goes,
 * as it would after fifteen idle minutes anyway.
 */
export function closeChat(issue, chatId) {
  assertNoUpgradeRunning();
  const task = chatOwnerOf(issue);
  if (!task) throw new Error(unknownOwner(issue));
  const refused = closeChatOf(task, chatId);
  if (refused) throw new Error(refused);
  const chat = chatById(task, chatId);
  closeLiveSession(issue, chat.id);
  store.addLog(task, 'chat', `chat «${chat.title}» closed`);
  store.touch(task);
  return true;
}

/** Brings a closed conversation back to the tabs, thread and all. */
export function reopenChat(issue, chatId) {
  assertNoUpgradeRunning();
  const task = chatOwnerOf(issue);
  if (!task) throw new Error(unknownOwner(issue));
  const refused = reopenChatOf(task, chatId);
  if (refused) throw new Error(refused);
  const chat = chatById(task, chatId);
  store.addLog(task, 'chat', `chat «${chat.title}» reopened`);
  store.touch(task);
  return chat;
}

/** The irreversible one: only from the history, only a chat already closed. */
export function deleteChat(issue, chatId) {
  assertNoUpgradeRunning();
  const task = chatOwnerOf(issue);
  if (!task) throw new Error(unknownOwner(issue));
  const chat = chatById(task, chatId);
  if (!chat) throw new Error('That chat does not exist');
  if (!chat.closedAt) throw new Error('Close it before deleting it');
  if (!removeChat(task, chatId)) {
    throw new Error('The main chat cannot be deleted: it is where the board talks');
  }
  closeLiveSession(issue, chat.id);
  store.addLog(task, 'chat', `chat «${chat.title}» deleted (${chat.messages.length} messages)`);
  store.touch(task);
  return true;
}

/** Stops the chat turn in flight — a tool call can run for many minutes. */
export async function interruptChat(issue, chatId) {
  const task = chatOwnerOf(issue);
  const chat = task && chatById(task, chatId);
  if (!chat) throw new Error('That chat does not exist');
  // Not refused during a move: stopping is always safe.
  const live = liveChats.get(liveKey(ownerKeyOf(task), chat.id));
  if (!chat.busy) throw new Error('That chat has no turn in progress');
  if (!live?.session.alive) {
    // «Working» with no process behind it: a leftover. Stop means stop —
    // the chat is put back in order rather than told there is nothing to do.
    for (const m of chat.messages) {
      if (m.role !== 'activity') continue;
      for (const item of closeAll(m, 'stopped')) store.updateChat(task, chat, m, { item, parentId: null });
    }
    chat.busy = false;
    chat.activity = null;
    if (live) live.activity = null;
    store.addChat(task, chat.id, 'assistant', '⏹️ That session was no longer alive; the chat is free.');
    store.touch(task);
    return;
  }
  // A parked question goes first: the model must not be left waiting on an
  // answer that the interrupt makes moot.
  if (chat.pending && clearsWithTurn(chat.pending)) expirePending(task, chat, live, 'el usuario detuvo el turno');
  await live.session.interrupt();
  store.addChat(task, chat.id, 'assistant', '⏹️ Turn stopped by the user.');
  // The process is still up, so the turn's own end clears `busy`; what the
  // tree had running is marked now rather than left spinning.
  if (live.activity) {
    for (const item of closeAll(live.activity, 'stopped')) store.updateChat(task, chat, live.activity, { item, parentId: null });
  }
  chat.activity = null;
  store.touch(task);
}

// ---------------------------------------------------------------------------
// Change requests: a reviewer asking for changes on the task's PR.

export const activeChangeRequest = (task) =>
  (task.changeRequests ?? []).find((c) => c.reviewId === task.activeChangeRequest) ?? null;

/**
 * The reviewer's brief, composed once and handed to both triage and fix.
 * Building it in one place is the point: if each phase assembled its own, the
 * triage could judge one thing and the fix implement another.
 */
export function changeRequestSection(cr) {
  const inline = cr.comments ?? [];
  const comments = inline.length
    ? inline.map((c, i) => `${i + 1}. **${c.path}${c.line ? `:${c.line}` : ''}**\n${c.body}`).join('\n\n')
    : '(la review no dejó comentarios en línea)';

  return [
    `## Petición de cambios de @${cr.author}`,
    `Review: ${cr.url}`,
    '',
    '### Cuerpo de la review',
    cr.body || '(sin cuerpo)',
    '',
    `### Comentarios en línea (${inline.length})`,
    comments,
  ].join('\n');
}

/** Sets the one change request the board works on; activating one clears the rest. */
export function setActiveChangeRequest(issue, reviewId) {
  assertNoUpgradeRunning();
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  const cr = (task.changeRequests ?? []).find((c) => c.reviewId === reviewId);
  if (reviewId && !cr) throw new Error(`The task has no change request ${reviewId}`);
  if (cr && ['triaging', 'fixing', 'testing', 'drafting'].includes(cr.status)) {
    throw new Error('That change request is being worked on right now');
  }
  task.activeChangeRequest = reviewId || null;
  store.addLog(task, 'cr', reviewId ? `active change request: the one from @${cr.author}` : 'no active change request');
  store.touch(task);
  // Picking one is the go-ahead: if it is still pending it starts now, subject
  // to the same auto-start and parallelism gate as everything else.
  if (cr?.status === 'pending') startChangeRequest(issue);
  return task.activeChangeRequest;
}

/** True while some change request of this task is mid-flight. */
const changeRequestBusy = (task) =>
  (task.changeRequests ?? []).some((c) => ['triaging', 'fixing', 'testing', 'drafting'].includes(c.status));

/**
 * Registers a change request found on GitHub. It becomes the active one only
 * when nothing else is in flight — a new review must not steal the turn from
 * the one being fixed.
 */
export function registerChangeRequest(task, found, headRefOid) {
  const cr = {
    ...found,
    status: 'pending',
    reviewedAt: headRefOid,   // the commit the reviewer was looking at
    headBefore: null,         // taken from the local HEAD right before fixing
    triageSummary: null,
    draftReplies: [],         // written by the agent, published only on your click
    draftSummary: null,
    draftedAt: null,
    resolvedAt: null,
  };
  task.changeRequests = [...(task.changeRequests ?? []), cr];
  task.handledReviews = [...(task.handledReviews ?? []), found.reviewId];
  if (!task.activeChangeRequest && !changeRequestBusy(task)) task.activeChangeRequest = cr.reviewId;
  store.addLog(task, 'cr', `@${found.author} requested changes: ${(found.comments ?? []).length} inline comment(s)`);
  store.touch(task);
  return cr;
}

/**
 * Starts work on the active change request through the same gate as any other
 * task: auto-start off means off, and it counts against the parallelism limit.
 */
export function startChangeRequest(issue, { force = false } = {}) {
  const task = store.get(issue);
  const cr = task && activeChangeRequest(task);
  if (!cr || cr.status !== 'pending') return false;
  if (task.unassigned) return false;
  const key = keyOf(task);
  // Left pending, not failed: `tick` picks it up once the move is over.
  if (movingReason(task)) return false;
  // Left pending too: `tick` picks it up once the upgrade is over. Forced from
  // the card it may start while one waits, never while one runs.
  if (force) assertNoUpgradeRunning();
  else if (upgradeHoldsNewWork()) return false;
  // The same for the account's limit, forced or not: the change request stays
  // `pending`, which is precisely what `tick()` picks up when the window
  // reopens — no new code, and no session burnt against the wall.
  if (quotaHoldsNewWork(task)) {
    store.addLog(task, 'cr', `⏳ quota exhausted: the change request stays pending and will start on its own ${describeResume(quotaHold())}`);
    return false;
  }
  if (!canAutoStart(task) && !force) {
    store.addLog(task, 'cr', 'manual task: the change request is recorded; start it yourself from its card');
    return false;
  }
  if (!force) {
    if (process.env.HFSMON_NO_AUTOSTART === '1' || !settings.autoStartFor(task.project)) return false;
    if (activeCount() >= settings.maxActiveTasks) return false;
  }
  if (running.has(key)) return false;

  running.add(key);
  authFailed.delete(task);
  Promise.resolve()
    .then(() => pipelineHooks.runChangeRequest(task, cr))
    .catch((e) => {
      cr.status = 'needs_attention';
      if (e instanceof PausedForMode) {
        // Parked, not failed: nothing is in flight to resume from, exactly as
        // `pausedForMode` leaves the main flow.
        task.phase = null;
        store.setState(task, 'waiting_approval');
      } else {
        store.setState(task, 'error', { error: `Change request: ${e.message}` });
        markAuthFailure(task);
      }
      store.touch(task);
    })
    .finally(() => {
      running.delete(key);
      tick();
    });
  return true;
}

async function runChangeRequest(task, cr) {
  // Same phase spans as a run of the pipeline: it writes `task.phase` by hand.
  const phases = phaseRecorder(task, 'worktree');
  try {
    await runChangeRequestBody(task, cr, phases);
    phases.close('ok');
  } catch (e) {
    phases.close(outcomeOf(e));
    throw e;
  }
}

/**
 * The triage of a change request's review and, when it comes out complex, the
 * advisor's plan for it. Split out of `runChangeRequestBody` so a test can drive
 * it without git or `gh`. The state lines (`cr.status`, `task.phase`) stay with
 * the caller. Like `triagePhase`, it starts by clearing `task.advisorPlan`: a
 * review judged simple must not hand the fix the plan of an earlier cycle.
 */
export async function changeRequestTriage(task, cr, issue, { brief = changeRequestSection(cr), cfg = cfgOf(task) } = {}) {
  task.advisorPlan = null;
  const triage = await nudgedSession(task, 'change-request', {
    machine: machineOf(task),
    cwd: task.worktreePath,
    ...tunedSession(task, 'triage', { cfg }),
    maxTurns: 15,
    onEvent: claudeLogger(task, 'triage'),
    hooks: ghGateHooks(task, 'triage'),
    prompt: renderPrompt('change-request', {
      ...promptVarsFor(task, 'triage'),
      issueNumber: issue.number,
      issueTitle: issue.title,
      branch: task.branch,
      changeRequestSection: brief,
    }),
  });
  const { verdict } = await triageVerdictFor(task, triage, { cfg, onEvent: claudeLogger(task, 'triage'), fallbackSummary: '' });
  cr.triageSummary = verdict.summary;
  store.addLog(task, 'triage', `change request: ${verdict.complexity} — ${verdict.reason}`);
  store.touch(task);

  if (verdict.complexity === 'complex') {
    await advisorPlanFor(task, {
      advise: tunedSession(task, 'advisor', { cfg }),
      prompt: changeRequestAdvisorPrompt(issue, brief),
    });
  }
  return verdict;
}

async function runChangeRequestBody(task, cr, phases) {
  const cfg = cfgOf(task);
  await ensureWorktree(keyOf(task));
  const issue = await getIssue(task.issue, task.project);
  const brief = changeRequestSection(cr);

  // Triage of the review, never of the original issue: that work is done and
  // approved, and re-litigating it is how a change request becomes a rewrite.
  cr.status = 'triaging';
  task.phase = 'triage';
  phases.enter('triage');
  store.setState(task, 'triage');
  await changeRequestTriage(task, cr, issue, { brief, cfg });

  // Baseline from the local HEAD, not the PR's head sha: a worktree with
  // unpushed commits differs from the remote, and the gate below would read
  // that difference as "the fix already landed".
  cr.headBefore = await headCommit(machineOf(task), task.worktreePath);
  cr.status = 'fixing';
  task.phase = 'fixing';
  phases.enter('fixing');
  store.setState(task, 'fixing');
  await fixPhase(task, issue, brief);

  if ((await headCommit(machineOf(task), task.worktreePath)) === cr.headBefore) {
    cr.status = 'needs_attention';
    task.phase = null;
    store.setState(task, 'waiting_approval');
    store.addLog(task, 'cr', 'the session ended without new commits: the change request is left for you to look at (check the chat)');
    store.touch(task);
    return;
  }

  cr.status = 'testing';
  task.phase = 'testing';
  phases.enter('testing');
  store.setState(task, 'testing');
  await testPhase(task);
  task.e2ePassedAt = await headCommit(machineOf(task), task.worktreePath);

  // Push, but no PR: it already exists, and its state is not ours to change.
  await withInfraRetries(task, 'pr', 'the push', () => pushBranch(machineOf(task), task.worktreePath, task.branch, { onLine: (l) => store.addLog(task, 'pr', l) }));

  cr.status = 'fixed';
  // The change request is done: nothing of it is in flight to resume from.
  task.phase = null;
  store.setState(task, 'waiting_approval');
  store.addLog(task, 'cr', `fix pushed to PR #${task.prNumber}. Press «Ready for review» when you want to hand it back to @${cr.author}`);
  store.touch(task);

  await generateDemoSteps(task, issue).catch((e) =>
    store.addLog(task, 'demo', `⚠️ could not regenerate the demo steps: ${e.message}`));
}

/**
 * The steps a finished demo session wrote, without the plan line. The demo
 * prompt carries the fan-out block, so a CLI reaction turn can replace the good
 * steps with a one-line acknowledgement; `answerOf` falls back to the sealed
 * text when only that one reads as steps (a `## ` heading, no usage-limit notice).
 */
export function demoStepsOf(task, result) {
  const stepsIn = (t) => stripTaggedLine(t, WORK_PLAN_TAG);
  const usable = (t) => {
    const steps = stepsIn(t);
    return steps.includes('## ') && !looksLikeUsageLimit(steps);
  };
  return stepsIn(answerOf(result, usable, sealedAnswerNote(task, 'demo', result)));
}

/**
 * The `REVIEW_REPLIES` of a finished drafting session, or null. The prompt carries
 * the fan-out block, so the sealed text can be the good one and the adopted text
 * a reaction turn's acknowledgement (`answerOf`). `ISSUE_CLOSING` does not get
 * this: that session runs with `tools: ['Read', 'Grep']`, no subagent tool, so
 * the seal net has nothing to wait for.
 */
export function reviewRepliesOf(task, result) {
  const text = answerOf(result, (t) => Boolean(parseTaggedJson(t, 'REVIEW_REPLIES')), sealedAnswerNote(task, 'cr', result));
  return parseTaggedJson(text, 'REVIEW_REPLIES');
}

/**
 * Drafts the answers to a change request: one per review thread, written by the
 * agent that did the work, in English, after reading the diff it produced.
 *
 * Nothing is published here. The drafts land on the board so you read them
 * before they reach the reviewer — the agent writes, you decide, the board
 * sends.
 */
export async function draftReviewReplies(issue, reviewId) {
  assertNoUpgradeRunning();
  // Refused too: the replies are yours to publish, so writing them by surprise
  // hours later is not what the click asked for.
  assertNoQuotaHold();
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  // It resumes the principal's session, which the move's handoff resumes too:
  // two writers on one transcript fork it.
  assertNotMoving(task);
  const cr = (task.changeRequests ?? []).find((c) => c.reviewId === reviewId);
  if (!cr) throw new Error('Change request desconocido');
  if (!['fixed', 'needs_attention'].includes(cr.status)) {
    throw new Error('There is no fix to report yet: draft the replies once the fix is pushed');
  }
  if (crDrafting.has(reviewId)) throw new Error('The replies are already being drafted');
  if (!(await isProjectWorktree(machineOf(task), task.worktreePath))) {
    throw new Error('This task has no worktree. Create it first with «🌳 Create worktree».');
  }

  const known = new Map((cr.comments ?? []).filter((c) => c.threadId).map((c) => [c.threadId, c]));
  // The commit the reviewer read, or the sha from just before the fix: either
  // way, the diff the answers have to describe.
  const baseline = cr.commitId ?? cr.headBefore ?? `origin/${baseOf(task)}`;
  const threadList = known.size
    ? [...known.entries()].map(([id, c]) => `- \`${id}\` → ${c.path}${c.line ? `:${c.line}` : ''}`).join('\n')
    : '(esta review no dejó comentarios en línea: solo produce `summary`, que se publicará como un comentario del PR)';

  const cfg = cfgOf(task);
  const previous = cr.status;
  crDrafting.add(reviewId);
  cr.status = 'drafting';
  store.touch(task);
  try {
    let extra = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      releasePrincipal(task);
      const result = await nudgedSession(task, 'review-replies', {
        machine: machineOf(task),
        cwd: task.worktreePath,
        ...tunedSession(task, 'reply', { stage: 'cr', cfg }),
        resume: principalChat(task)?.sessionId ?? undefined,
        maxTurns: 30,
        onEvent: claudeLogger(task, 'cr'),
        hooks: ghGateHooks(task, 'cr'),
        prompt: renderPrompt('review-replies', {
          ...promptVarsFor(task, 'cr'),
          issueNumber: task.issue,
          issueTitle: task.title,
          prNumber: task.prNumber,
          branch: task.branch,
          author: cr.author,
          baseline,
          changeRequestSection: changeRequestSection(cr),
          threadList,
        }) + extra,
      }, { before: () => releasePrincipalForNudge(task) });
      if (result.sessionId) principalChat(task).sessionId = result.sessionId;

      const parsed = reviewRepliesOf(task, result);
      if (!parsed) {
        extra = '\n\nTu turno anterior no terminó con la línea `REVIEW_REPLIES: {...}`. Devuélvela ahora, en una sola línea y en inglés.';
        store.addLog(task, 'cr', '⚠️ the agent returned no REVIEW_REPLIES; asking again');
        continue;
      }

      // Only threads this review actually has, and only text that may be
      // published. The gate runs here too so a rejected draft can be redrafted
      // with the reason, instead of failing at the wire with nothing to show.
      const replies = [];
      const rejected = [];
      for (const r of parsed.replies ?? []) {
        const comment = known.get(r.threadId);
        if (!comment) continue;
        const problems = publishProblems(r.body);
        if (problems.length) rejected.push(`${comment.path}: ${problems.join('; ')}`);
        else replies.push({ threadId: r.threadId, path: comment.path, line: comment.line, body: r.body.trim() });
      }
      const summary = String(parsed.summary ?? '').trim();
      const summaryProblems = summary ? publishProblems(summary) : ['falta el resumen'];
      if (summary && summaryProblems.length) rejected.push(`resumen: ${summaryProblems.join('; ')}`);

      if (rejected.length) {
        store.addLog(task, 'cr', `⚠️ ${rejected.length} reply(ies) rejected by the filter: ${rejected[0]}`);
        extra = `\n\nEl filtro de publicación rechazó parte de tu salida anterior:\n${rejected.map((r) => `- ${r}`).join('\n')}\n\nReescribe TODAS las respuestas en inglés, sin acentos ni palabras en español fuera de los bloques de código, y devuelve la línea REVIEW_REPLIES completa otra vez.`;
        continue;
      }

      const missing = [...known.keys()].filter((id) => !replies.some((r) => r.threadId === id));
      if (missing.length) {
        store.addLog(task, 'cr', `⚠️ ${missing.length} thread(s) were left without a reply; only the ${replies.length} written will be published`);
      }

      cr.draftReplies = replies;
      cr.draftSummary = summary && !summaryProblems.length ? summary : null;
      cr.draftedAt = new Date().toISOString();
      cr.status = previous;
      store.addLog(task, 'cr', `${replies.length} reply(ies) written in English; review them before publishing`);
      store.touch(task);
      return cr;
    }

    throw new Error('The agent produced no publishable replies in two attempts; look at it in the task chat');
  } finally {
    crDrafting.delete(reviewId);
    if (cr.status === 'drafting') cr.status = previous;
    store.touch(task);
  }
}

/** Throws away the drafts, so the next click writes them from scratch. */
export function discardReviewReplies(issue, reviewId) {
  assertNoUpgradeRunning();
  const task = store.get(issue);
  const cr = task && (task.changeRequests ?? []).find((c) => c.reviewId === reviewId);
  if (!cr) throw new Error('Change request desconocido');
  cr.draftReplies = [];
  cr.draftSummary = null;
  cr.draftedAt = null;
  store.touch(task);
  return cr;
}

/**
 * Publishes the drafted answers, marks the threads resolved and re-requests
 * review — only on your click, and only with text you have seen.
 */
export async function resolveChangeRequest(issue, reviewId, { force = false } = {}) {
  assertNoUpgradeRunning();
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  // Same per-task queue as `markReady`: a second click waits, then finds the
  // change request already resolved instead of publishing the answers twice.
  return readyMutex.runExclusive(keyOf(task), () => resolveChangeRequestLocked(task, reviewId, { force }));
}

async function resolveChangeRequestLocked(task, reviewId, { force }) {
  const cr = (task.changeRequests ?? []).find((c) => c.reviewId === reviewId);
  if (!cr) throw new Error('Change request desconocido');
  if (cr.status === 'resolved') {
    store.addLog(task, 'cr', `change request ${reviewId} was already published; not repeated`);
    return cr;
  }
  if (cr.status !== 'fixed') throw new Error('The fix is not pushed yet');

  // Before anything is said: the answers claim work landed, so it had better be
  // up there, and on a branch that still merges. Anything committed by hand in
  // the chat after the fix goes now.
  await mergeBeforeReview(task, { force });
  await pushBeforeReview(task, { force });

  // Answers first: a resolved thread with no reply tells the reviewer nothing.
  const drafts = cr.draftReplies ?? [];
  const posted = [];
  for (const reply of drafts) {
    try {
      await replyToReviewThread(reply.threadId, reply.body, task.project);
      posted.push(reply.threadId);
    } catch (e) {
      store.addLog(task, 'cr', `⚠️ could not reply on ${reply.path}: ${e.message}`);
    }
  }
  // The summary only goes out on its own when there were no threads to carry
  // it; otherwise it would be a ninth notification saying what the eight said.
  if (cr.draftSummary && !drafts.length) {
    try {
      await commentOnPr(task.prNumber, cr.draftSummary, task.project);
      posted.push('summary');
    } catch (e) {
      store.addLog(task, 'cr', `⚠️ could not publish the summary: ${e.message}`);
    }
  }
  if (posted.length) store.addLog(task, 'cr', `${posted.length} reply(ies) posted on PR #${task.prNumber}`);

  const result = await requestReviewForChangeRequest(task.prNumber, cr, task.project);
  cr.status = 'resolved';
  cr.resolvedAt = new Date().toISOString();
  if (task.activeChangeRequest === reviewId) task.activeChangeRequest = null;
  store.addLog(task, 'cr', `${result.resolved} thread(s) resolved and review requested again from @${result.reviewer}`);
  if (result.failures.length) {
    store.addLog(task, 'cr', `⚠️ could not resolve ${result.failures.length} thread(s): ${result.failures[0]}`);
  }
  store.touch(task);
  return cr;
}

/**
 * Looks for new change requests on a task's PR. Called from the poll cycle.
 * Returns how many it registered.
 */
export async function checkChangeRequests(task) {
  if (!task.prNumber) return 0;
  if (!['waiting_approval', 'ready'].includes(task.state)) return 0;

  const { changeRequests, headRefOid, reviewDecision } = await getChangeRequests(task.prNumber, task.project);

  // The reviewer approved after all: nothing here needs attention any more.
  if (reviewDecision === 'APPROVED') {
    for (const cr of task.changeRequests ?? []) {
      if (['fixed', 'needs_attention', 'pending'].includes(cr.status)) cr.status = 'superseded';
    }
    if (task.activeChangeRequest) task.activeChangeRequest = null;
    store.touch(task);
  }

  const handled = new Set(task.handledReviews ?? []);
  const fresh = changeRequests.filter((c) => !handled.has(c.reviewId));
  for (const found of fresh) registerChangeRequest(task, found, headRefOid);
  if (fresh.length) startChangeRequest(keyOf(task));
  return fresh.length;
}

// ---------------------------------------------------------------------------
// Closing an issue with no PR.
//
// The shape is the same one `draftReviewReplies` / `resolveChangeRequest`
// already have, and for the same reason: **the model writes, you read, the
// board publishes**. Nothing here reaches GitHub without a click on text a
// person has seen — the drafting phase cannot even call `gh`
// (`noGitHubWriteHooks`), and `closeIssueWithoutPr` publishes the text of the
// request, never the parked draft, because that is the text you edited.

/** The three reasons GitHub accepts, and the only three this board proposes. */
const CLOSE_REASONS = ['completed', 'not_planned', 'duplicate'];

const closingDrafts = new Set();      // task keys whose closing proposal is being written
const closingPublishes = new Set();   // task keys with a publish in flight

/** The draft half of `task.closing`, emptied. The published half is not here. */
const emptyDraft = () => ({
  draftBody: null,
  draftReason: null,
  draftWhy: null,
  draftDuplicateOf: null,
  draftLabels: [],
  draftVerdict: null,
  draftMissing: null,
  draftedAt: null,
});

/**
 * Everything stored is older than this feature, so every read goes through
 * `task.closing?.…` and this returns a whole record rather than assuming one.
 * There is no migration on purpose: a field that appears the first time it is
 * written cannot be half-migrated.
 */
const closingOf = (task) => (task.closing ??= { status: 'idle', ...emptyDraft(), cleanup: null, error: null });

/**
 * Forgets that this task was closed without a PR, so a new cycle starts clean.
 *
 * The `commentId` goes too, and that is the point rather than tidiness: the
 * id is what makes a retry *edit* instead of publishing twice, so keeping it
 * across cycles would make the next closing edit the previous cycle's comment
 * — a comment about work that has since happened.
 */
export function clearClosedWithoutPr(task) {
  if (!task) return;
  task.closedWithoutPr = false;
  task.closable = null;
  if (!task.closing) return;
  task.closing = {
    ...task.closing,
    ...emptyDraft(),
    status: 'idle',
    commentId: null,
    commentUrl: null,
    error: null,
  };
}

/**
 * A `CLOSABLE: {...}` line from a chat turn, parked on the card as a
 * suggestion.
 *
 * **It closes nothing and changes no state.** All it does is put a reason and
 * a sentence where the «Cerrar issue» button can offer them, and where
 * `draftIssueClosing` can hand them to the drafting phase as a starting point
 * to contradict. That is why this never touches `issueClosed` or `state`.
 *
 * It **never throws**: it is called from inside `runTurn`'s `try`, where a
 * throw would reach the person as «No se pudo abrir la sesión». A turn with no
 * line, or with a line this cannot read, simply leaves an earlier suggestion
 * alone — one bad turn must not erase a good one.
 *
 * Exported for the test that proves exactly that.
 */
export function noteClosableOf(task, chat, text) {
  // A project chat has no issue to close.
  if (isHolder(task)) return null;
  try {
    // Only when the tag STARTS a line, because that is the only shape
    // `stripTaggedLine` removes from the bubble. `parseTaggedJson` matches the
    // tag anywhere, so a turn ending «…listo. CLOSABLE: {…}» would be parked
    // here and still shown raw to the person — the exact defect that took the
    // block out of `chat-rules.md` once already. Parse what the reader can
    // hide, and nothing else.
    if (!/^[ \t]*CLOSABLE:/m.test(String(text ?? ''))) return null;
    const parsed = parseTaggedJson(text, 'CLOSABLE');
    if (!parsed) return null;
    const reason = String(parsed.reason ?? '');
    if (!CLOSE_REASONS.includes(reason)) return null;
    const why = String(parsed.why ?? '').trim();
    if (!why) return null;
    let duplicateOf = null;
    if (parsed.duplicateOf != null) {
      const n = Number(parsed.duplicateOf);
      if (!Number.isInteger(n) || n <= 0) return null;
      duplicateOf = n;
    }
    // A duplicate with no number is the guess this must not carry: the prompt
    // says that case is `unclear`, not a number picked by eye.
    if (reason === 'duplicate' && !duplicateOf) return null;

    task.closable = { at: new Date().toISOString(), chatId: chat?.id ?? null, reason, why, duplicateOf };
    store.addLog(task, 'chat', `💡 «${chat?.title ?? 'a conversation'}» thinks this issue closes without changes (${reason}): ${why.slice(0, 160)}`);
    store.touch(task);
    return task.closable;
  } catch {
    // Unreachable in practice — everything above is string work — and kept
    // anyway: see the contract in the doc-comment.
    return null;
  }
}

/**
 * Whether a closing proposal may be shown to a person, and what of it survives.
 *
 * Pure: every input is an argument, no clock, no network, no store. That is
 * deliberate, because this is where the draft either becomes a comment on
 * somebody else's issue or gets sent back for a rewrite.
 *
 * Two kinds of verdict, and **`unclear` is not a failure**: a phase that found
 * no clear conclusion says so, `missing` says what it would need, and the
 * window shows that instead of a comment nobody can stand behind.
 *
 * Unknown labels are **dropped, not rejected**: the catalogue is a detail of
 * the repository, and sending a whole draft back over one bad label would
 * waste the analysis. They come back in `dropped` so the caller can say so in
 * one line of log. That the duplicate **exists** is not checked here — it
 * needs the network, and it is checked at publish time.
 *
 * @returns {{ok: boolean, draft: Object|null, rejected: string[], dropped: string[]}}
 */
export function validateClosingDraft(parsed, { labels = [] } = {}) {
  const rejected = [];
  const dropped = [];
  const verdict = parsed?.verdict === 'closable' || parsed?.verdict === 'unclear' ? parsed.verdict : null;
  if (!verdict) {
    return { ok: false, draft: null, dropped, rejected: [`veredicto desconocido: ${JSON.stringify(parsed?.verdict ?? null)} (esperaba "closable" o "unclear")`] };
  }

  if (verdict === 'unclear') {
    const missing = String(parsed?.missing ?? '').trim();
    if (!missing) return { ok: false, draft: null, dropped, rejected: ['el veredicto es «unclear» pero no dice en `missing` qué le falta saber'] };
    return {
      ok: true,
      dropped,
      rejected: [],
      draft: { verdict: 'unclear', comment: '', reason: null, why: '', duplicateOf: null, labels: [], missing },
    };
  }

  const comment = String(parsed?.comment ?? '').trim();
  const problems = publishProblems(comment, { maxChars: CLOSE_COMMENT_MAX });
  if (problems.length) rejected.push(`el comentario: ${problems.join('; ')}`);

  const reason = String(parsed?.reason ?? '');
  if (!CLOSE_REASONS.includes(reason)) {
    rejected.push(`motivo desconocido: «${reason || 'ninguno'}» (esperaba ${CLOSE_REASONS.join(', ')})`);
  }

  // Not run through `publishProblems`: `why` is for the window next to the
  // reason selector, it never reaches GitHub. Empty, though, leaves the person
  // choosing a reason with nothing to justify it.
  const why = String(parsed?.why ?? '').trim();
  if (!why) rejected.push('falta `why`: la frase que justifica ese motivo y no otro');

  let duplicateOf = null;
  if (reason === 'duplicate') {
    const n = Number(parsed?.duplicateOf);
    if (!Number.isInteger(n) || n <= 0) {
      rejected.push(`«duplicate» sin número: ${JSON.stringify(parsed?.duplicateOf ?? null)}`);
    } else {
      duplicateOf = n;
    }
  }

  // Case-insensitive against the catalogue, and what is kept is the
  // repository's own spelling — the same rule `addIssueLabels` applies, so a
  // draft that passes here cannot be rejected at the wire over casing.
  const bySpelling = new Map((labels ?? []).map((l) => {
    const name = String(l?.name ?? l ?? '').trim();
    return [name.toLowerCase(), name];
  }).filter(([k]) => k));
  const kept = [];
  for (const raw of parsed?.labels ?? []) {
    const name = String(raw ?? '').trim();
    if (!name) continue;
    const known = bySpelling.get(name.toLowerCase());
    if (!known) dropped.push(name);
    else if (!kept.includes(known)) kept.push(known);
  }

  if (rejected.length) return { ok: false, draft: null, rejected, dropped };
  return {
    ok: true,
    rejected: [],
    dropped,
    draft: { verdict: 'closable', comment, reason, why, duplicateOf, labels: kept, missing: null },
  };
}

/**
 * What may be deleted once the issue is closed. Pure.
 *
 * **Any commit keeps everything**, pushed or not. That is stricter than it
 * looks and it is the rule on purpose: a branch whose commits are all on
 * `origin` is still work somebody wrote, the issue closed without a PR means
 * nothing merged it, and the worktree is the only place that work is checked
 * out. Disk is cheap; the `unpushed === 0` case is precisely the one where
 * «it's all pushed, delete it» sounds reasonable and is wrong.
 *
 * `unpushed === null` is worktree.js's way of saying the branch has no remote
 * at all, which reads as «there is something to push», never as zero.
 *
 * It answers only `removed`/`kept` and `deleted`/`kept`; `absent` and
 * `missing` describe what the caller found on disk, not what it decided.
 */
export function cleanupVerdict({ dirty = false, unpushed = null, commits = false } = {}) {
  const blockers = [];
  if (dirty) blockers.push('the worktree has uncommitted changes');
  if (commits) blockers.push('the branch has its own commits');
  if (typeof unpushed === 'number' && unpushed > 0) blockers.push(`${unpushed} commit(s) not pushed`);
  if (blockers.length) return { worktree: 'kept', branch: 'kept', why: blockers.join('; ') };
  return { worktree: 'removed', branch: 'deleted', why: 'nothing was left to lose: no loose changes and no commits of its own' };
}

/** The issue's comments, as the drafting phase reads them. */
function issueCommentsSection(comments) {
  if (!comments.length) return '(este issue no tiene comentarios)';
  return comments
    .map((c) => `### @${c.author ?? 'alguien'} — ${c.createdAt ?? 'sin fecha'}\n\n${String(c.body ?? '').trim() || '(vacío)'}`)
    .join('\n\n---\n\n');
}

/** What git says about the branch, in the prose the prompt asks for. */
function branchStateSection({ branch, work, commits, base = 'main' }) {
  if (!branch) return 'Esta tarea no tiene rama.';
  if (!work) return `La rama \`${branch}\` no tiene worktree aquí, así que no se ha podido mirar su estado.`;
  const lines = [
    commits ? `- **Tiene commits propios sobre \`origin/${base}\`.** Eso contradice «no hace falta ningún cambio»: alguien ya tocó código.`
      : `- No tiene ningún commit propio sobre \`origin/${base}\`.`,
    // `work.dirty` es la LISTA de archivos sucios, y `[]` es truthy: preguntar
    // por el array le diría a la sesión «hay cambios sin commitear» en un
    // worktree limpio, que es una afirmación falsa metida justo en la fase que
    // tiene prohibido inventar. Se cuenta.
    work.dirty.length ? `- Hay ${work.dirty.length} archivo(s) sin commitear en el worktree.` : '- El worktree está limpio.',
    work.unpushed === null ? '- La rama no existe en `origin`.'
      : `- ${work.unpushed} commit(s) sin subir.`,
  ];
  return lines.join('\n');
}

/** The chat's own suggestion, as the starting point the prompt contrasts. */
function closableHintSection(task) {
  const c = task.closable;
  if (!c) return '(el chat no dejó ninguna línea `CLOSABLE:`: llegas aquí porque alguien pulsó el botón. Saca la conclusión de la conversación misma.)';
  return `- Motivo propuesto: \`${c.reason}\`\n- Por qué: ${c.why}\n${c.duplicateOf ? `- Duplicado de: #${c.duplicateOf}\n` : ''}- Dicho el ${c.at}`;
}

/**
 * Writes the proposal to close this issue with no PR, by resuming the very
 * conversation that reached that conclusion.
 *
 * Nothing is published. The draft lands on the card so a person reads it,
 * edits it and decides — and the session that writes it cannot call `gh` at
 * all (`noGitHubWriteHooks` on top of the usual language gate).
 *
 * ## Why a busy chat is refused instead of cut short
 *
 * `draftReviewReplies` releases the principal's session and takes the
 * transcript over, because there the conversation is only context around a
 * diff that already exists. Here the conversation **is** the raw material:
 * the reasons, the file paths, the analysis. Cutting a turn short would mean
 * drafting from a transcript that is still being written. So a busy chat is a
 * refusal, not a takeover.
 *
 * And it is *this* chat's session that is released, not the principal's: the
 * conclusion may well have been reached in a side conversation.
 */
export async function draftIssueClosing(issue, { chatId = null } = {}) {
  assertNoUpgradeRunning();
  // Same reason as `draftReviewReplies`: this is a click, and a click that
  // silently runs a model three hours later is not what was asked for.
  assertNoQuotaHold();
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  assertNotMoving(task);
  if (task.issueClosed) throw conflict('The issue is already closed: there is nothing to propose');
  const key = keyOf(task);
  if (closingDrafts.has(key)) throw conflict('The closing proposal is already being drafted');
  if (task.closing?.status === 'publishing') throw conflict('This issue\'s closing is being published: wait for it to finish');
  if (!(await isProjectWorktree(machineOf(task), task.worktreePath))) {
    throw new Error('This task has no worktree. Create it first with «🌳 Create worktree».');
  }

  const chat = (chatId ? chatById(task, chatId) : null)
    ?? (task.closable?.chatId ? chatById(task, task.closable.chatId) : null)
    ?? principalChat(task);
  if (!chat) throw new Error('This task has no conversation to take the closing reasons from');
  if (chat.busy) {
    throw conflict(`«${chat.title}» has a turn in progress, and that turn is exactly the raw material of this proposal: wait for it to finish`);
  }
  // No invented starting point: with no transcript there is nothing to reread,
  // and rereading is the whole method of this phase.
  if (!chat.sessionId) {
    throw conflict(`«${chat.title}» has no conversation yet: there is nothing to take the closing reasons from. Talk to it first.`);
  }

  const cfg = cfgOf(task);
  const machine = machineOf(task);
  const [live, comments, labels] = await Promise.all([
    getIssue(task.issue, task.project),
    issueComments(task.issue, task.project),
    repoLabels(task.project),
  ]);
  const work = task.branch ? await pendingWork(machine, task.worktreePath, task.branch).catch(() => null) : null;
  const commits = await hasCommits(machine, task.worktreePath, { base: baseOf(task) }).catch(() => false);

  const previous = task.closing?.status === 'closed' ? 'closed' : (task.closing?.draftedAt ? 'drafted' : 'idle');
  closingDrafts.add(key);
  const closing = closingOf(task);
  closing.status = 'drafting';
  closing.error = null;
  store.touch(task);
  try {
    let extra = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      // This chat's own session, not the principal's: two processes appending
      // to one transcript fork it.
      closeLiveSession(keyOf(task), chat.id);
      const result = await runClaude({
        machine,
        cwd: task.worktreePath,
        ...tunedSession(task, 'reply', { stage: 'close', cfg }),
        resume: chat.sessionId,
        maxTurns: 30,
        onEvent: claudeLogger(task, 'close'),
        // The structural half of «you draft, a person publishes»: with no Bash
        // there is no `gh`, no `git push` and no shell at all, so the hooks
        // below stop being the only thing between this session and a public
        // write. `close-issue.md` asks for `Read` and `Grep` and says in the
        // same breath that this phase can run without Bash — this is that
        // sentence made true. Unlike a `canUseTool` deny, it also holds in the
        // modes where read-only tools run without asking.
        //
        // And it is why this is the one phase whose prompt does not carry
        // `{{parallel}}`: that block orders the session to fan its questions
        // out to subagents with `Agent`, and a list of two tools has no such
        // tool in it, so every drafting turn would open by reaching for one
        // that is not there. `close-issue.md` verifies the paths it cites with
        // `Read` and `Grep` in one thread instead. The other way round — hand
        // the tool back so the fan-out works — reopens the door this list just
        // shut, because a subagent runs with the tools of the session that
        // spawned it. Checking a dozen paths in series is the cheap half of
        // that trade.
        tools: ['Read', 'Grep'],
        // Two gates, composed: the language one everybody gets, and the flat
        // «no `gh` at all» this phase needs.
        hooks: mergeHooks(ghGateHooks(task, 'close'), noGitHubWriteHooks(task, 'close')),
        prompt: renderPrompt('close-issue', {
          ...promptVarsFor(task, 'close'),
          issueNumber: task.issue,
          issueTitle: live.title ?? task.title ?? '',
          issueBody: String(live.body ?? '').trim() || '(vacío)',
          commentsSection: issueCommentsSection(comments),
          branch: task.branch ?? '(sin rama)',
          branchState: branchStateSection({ branch: task.branch, work, commits, base: baseOf(task) }),
          labelList: labels.map((l) => `\`${l.name}\``).join(', ') || '(el repositorio no tiene etiquetas)',
          closableHint: closableHintSection(task),
          commentMax: CLOSE_COMMENT_MAX,
        }) + extra,
      });
      if (result.sessionId) chat.sessionId = result.sessionId;

      const parsed = parseTaggedJson(result.resultText, 'ISSUE_CLOSING');
      if (!parsed) {
        extra = '\n\nTu turno anterior no terminó con la línea `ISSUE_CLOSING: {...}`. Devuélvela ahora, en una sola línea y en inglés.';
        store.addLog(task, 'close', '⚠️ the agent returned no ISSUE_CLOSING; asking again');
        continue;
      }

      const { ok, draft, rejected, dropped } = validateClosingDraft(parsed, { labels });
      if (dropped.length) {
        store.addLog(task, 'close', `labels dropped because they do not exist in the repository: ${dropped.join(', ')}`);
      }
      if (!ok) {
        store.addLog(task, 'close', `⚠️ proposal rejected by the filter: ${rejected.join('; ')}`);
        extra = `\n\nEl tablero rechazó tu salida anterior:\n${rejected.map((r) => `- ${r}`).join('\n')}\n\nDevuelve la línea ISSUE_CLOSING entera otra vez, corregida. Si el problema es que no tienes una conclusión clara, la respuesta honesta es \`"verdict":"unclear"\` con su \`missing\`.`;
        continue;
      }

      closing.draftVerdict = draft.verdict;
      closing.draftBody = draft.comment;
      closing.draftReason = draft.reason;
      closing.draftWhy = draft.why;
      closing.draftDuplicateOf = draft.duplicateOf;
      closing.draftLabels = draft.labels;
      closing.draftMissing = draft.missing;
      closing.draftedAt = new Date().toISOString();
      closing.status = 'drafted';
      closing.error = null;
      store.addLog(task, 'close', draft.verdict === 'unclear'
        // Parked exactly like a proposal, and shown as what it is: the window
        // says what the analysis would need, instead of a comment nobody wrote.
        ? `the re-read found no clear conclusion: missing ${draft.missing}`
        : `closing proposal written (${draft.reason}${draft.duplicateOf ? `, duplicate of #${draft.duplicateOf}` : ''}); review it before publishing`);
      store.touch(task);
      return closing;
    }

    throw new Error('The agent produced no usable closing proposal in two attempts; look at it in the task chat');
  } catch (e) {
    // El motivo se guarda en la tarea, no solo se lanza. Quien pulsó tiene la
    // ventana delante, y un toast detrás de una modal no lo lee nadie: sin
    // esto, un borrador fallido deja un formulario vacío sin explicación.
    closing.error = reasonOf(e);
    throw e;
  } finally {
    closingDrafts.delete(key);
    if (closing.status === 'drafting') closing.status = previous;
    store.touch(task);
  }
}

/**
 * Throws away the draft half, so the next click writes it from scratch.
 *
 * What was already published stays: the comment id is what makes a retry edit
 * instead of leaving a second closing comment, and discarding a draft is not a
 * reason to lose that. The chat's suggestion goes too — you looked at it and
 * said no.
 */
export function discardIssueClosing(issue) {
  assertNoUpgradeRunning();
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  const closing = closingOf(task);
  if (closing.status === 'publishing') throw conflict('The closing is being published: wait for it to finish');
  Object.assign(closing, emptyDraft());
  closing.status = closing.closedAt ? 'closed' : 'idle';
  closing.error = null;
  task.closable = null;
  store.addLog(task, 'close', 'closing proposal discarded');
  store.touch(task);
  return closing;
}

/**
 * What may still be deleted now that the issue is closed, measured **now**.
 *
 * Deliberately not the numbers the guards read a moment ago: publishing a
 * comment and closing an issue take seconds during which a chat may have
 * committed. Reading again costs two `git` calls and is the difference between
 * deleting a worktree and deleting somebody's work.
 *
 * Never fatal, and never touches the remote branch.
 */
async function cleanupAfterClose(task) {
  const machine = machineOf(task);
  const branch = task.branch ?? null;
  // No worktree is the ordinary state of a retry: `removePlace` nulls
  // `worktreePath`, and calling it again would throw «La tarea no tiene worktree».
  const hasWt = Boolean(task.worktreePath) && await isProjectWorktree(machine, task.worktreePath).catch(() => false);

  let dirty = false;
  let unpushed = null;
  let commits = false;
  if (hasWt) {
    const work = branch ? await pendingWork(machine, task.worktreePath, branch).catch(() => null) : null;
    // Las dos medidas fallan CERRADO, hacia conservar. `hasCommits` ya lo hacía
    // (`catch(() => true)`); `pendingWork` no: un `null` daba `dirty = false` y,
    // con una rama sin commits propios, el veredicto salía «borrar» y se
    // llevaba por delante un worktree con cambios dentro. No poder mirar no es
    // lo mismo que estar limpio, y aquí la diferencia es el trabajo de alguien.
    dirty = work ? work.dirty.length > 0 : true;
    unpushed = work ? work.unpushed : null;
    commits = await hasCommits(machine, task.worktreePath, { base: baseOf(task) }).catch(() => true);
  }

  const verdict = cleanupVerdict({ dirty, unpushed, commits });
  const why = hasWt ? verdict.why : 'the task no longer had a worktree here';

  let worktree = 'absent';
  if (hasWt) {
    if (verdict.worktree === 'kept') {
      worktree = 'kept';
      store.addLog(task, 'close', `the worktree is kept: ${verdict.why}`);
    } else {
      try {
        await removePlace(task, task.machine);
        worktree = 'removed';
      } catch (e) {
        worktree = 'kept';
        store.addLog(task, 'close', `⚠️ could not delete the worktree (${reasonOf(e)}); kept`);
      }
    }
  }

  let branchOutcome = 'missing';
  if (branch) {
    if (verdict.branch === 'kept') {
      branchOutcome = 'kept';
      store.addLog(task, 'close', `the local branch ${branch} is kept: ${verdict.why}. The origin branch is never touched.`);
    } else {
      // Its own guard — commits this branch has and `origin/<base>` does not —
      // lives inside `deleteLocalBranch`, and it is the one that decides.
      const r = await deleteLocalBranch(machine, branch, { base: baseOf(task) }).catch((e) => ({ deleted: false, reason: 'error', message: reasonOf(e) }));
      branchOutcome = r.deleted ? 'deleted' : (r.reason === 'missing' ? 'missing' : 'kept');
      store.addLog(task, 'close', r.message);
    }
  }

  return { worktree, branch: branchOutcome, why };
}

/**
 * Publishes the closing comment, labels the issue, closes it and tidies up —
 * the only function here that writes to GitHub, and only on your click.
 *
 * ## It publishes the text of the request
 *
 * Never `draftBody`. You edited it in the window, and what you read is what
 * goes out; the parked draft is only what the model proposed.
 *
 * ## Everything local is checked before the first `gh`
 *
 * So the window gets its 400 or its 409 without a round trip, and so that a
 * refusal never lands half-written: an unknown label after the comment is
 * already public is an edit somebody has to undo by hand.
 *
 * `force` authorises **publishing anyway** over unpublished work. It never
 * authorises deleting anything: the cleanup below re-reads git and refuses on
 * its own terms.
 *
 * ## Why the comment id is persisted before the close
 *
 * A crash between the two leaves the id parked, and the retry **edits** that
 * comment instead of leaving a second one. That single ordering is the whole
 * idempotency story, together with skipping a close on an issue GitHub already
 * reports as closed and with `cleanupAfterClose` finding no worktree to remove.
 */
export async function closeIssueWithoutPr(issue, { comment, reason, duplicateOf = null, labels = [], force = false } = {}) {
  assertNoUpgradeRunning();
  // No `assertNoQuotaHold` on purpose: nothing here runs a model, and a
  // decision you already made must not wait three hours for an account.
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  assertNotMoving(task);
  const busy = gitBusyReason(task);
  if (busy) throw conflict(`Cannot close the issue now: ${busy}`);

  const key = keyOf(task);
  // Two clicks must not leave two comments. The `finally` is what makes the
  // guard honest across a failure.
  if (closingPublishes.has(key)) throw conflict('This issue\'s closing is already being published');
  closingPublishes.add(key);
  try {
    const text = String(comment ?? '').trim();
    // The same gate `publishIssueComment` runs at the wire, run here first so
    // the refusal arrives as a 400 with its reasons listed — and recaptured
    // the way `publishPr` does it, so the window shows them instead of a 500.
    try {
      assertPublishable(text, `el comentario de cierre del issue #${task.issue}`, { maxChars: CLOSE_COMMENT_MAX });
    } catch (e) {
      throw Object.assign(new Error(e.message), {
        status: 400,
        problems: publishProblems(text, { maxChars: CLOSE_COMMENT_MAX }),
      });
    }

    if (!CLOSE_REASONS.includes(reason)) {
      throw Object.assign(
        new Error(`Unknown closing reason: «${reason ?? 'none'}» (expected ${CLOSE_REASONS.join(', ')})`),
        { status: 400, code: 'REASON_UNKNOWN' },
      );
    }

    // Intersected here and not left to `addIssueLabels`, which runs after the
    // comment is already public: the catalogue is a read, and a read is cheap.
    let names = [];
    const wanted = [...new Set((labels ?? []).map((l) => String(l).trim()).filter(Boolean))];
    if (wanted.length) {
      const catalogue = await repoLabels(task.project);
      const bySpelling = new Map(catalogue.map((l) => [l.name.toLowerCase(), l.name]));
      const unknown = wanted.filter((l) => !bySpelling.has(l.toLowerCase()));
      if (unknown.length) {
        throw Object.assign(
          new Error(`The repository does not have these labels: ${unknown.join(', ')} (the board does not create labels)`),
          { status: 400, code: 'LABELS_UNKNOWN', unknown },
        );
      }
      names = wanted.map((l) => bySpelling.get(l.toLowerCase()));
    }

    let dup = null;
    let targetIsPr = false;
    if (reason === 'duplicate') {
      const n = Number(duplicateOf);
      if (!Number.isInteger(n) || n <= 0) {
        throw Object.assign(
          new Error('«duplicate» needs the number of the issue or PR that already covers it'),
          { status: 400, code: 'DUPLICATE_UNKNOWN', ref: duplicateOf ?? null },
        );
      }
      // `null` from here means a real 404 and nothing else (`issueOrPrRef`), so
      // a network hiccup never reads as «ese issue no existe».
      const ref = await issueOrPrRef(n, task.project);
      if (!ref) {
        throw Object.assign(
          new Error(`This repository has no issue or PR #${n}`),
          { status: 400, code: 'DUPLICATE_UNKNOWN', ref: n },
        );
      }
      dup = n;
      // A PR closes as `--reason duplicate` without `--duplicate-of`, because
      // that flag resolves against the repository's issues. `closeIssue` knows.
      targetIsPr = ref.isPr;
    }

    const machine = machineOf(task);
    if (task.worktreePath && task.branch && await isProjectWorktree(machine, task.worktreePath)) {
      const work = await pendingWork(machine, task.worktreePath, task.branch);
      const commits = await hasCommits(machine, task.worktreePath, { base: baseOf(task) });
      // `unpushed === null` = no remote branch; worktree.js says to read that
      // as «there is something to push», never as zero.
      const unpublished = work.unpushed === null ? commits : work.unpushed > 0;
      // `.length`, no el array: `[]` es truthy, y con el array pelado esto
      // saltaría en TODA tarea con worktree, limpia incluida — la ventana
      // pediría confirmar un peligro que no existe y la persona aprendería a
      // ignorarla. `pending.dirty` viaja como RECUENTO, la misma forma que
      // manda `GET …/close/options`: un aviso que se pinta en dos sitios no
      // puede llegar con dos tipos distintos.
      if ((work.dirty.length > 0 || unpublished) && !force) {
        throw Object.assign(
          new Error('This branch has unpublished work: closing the issue without a PR would leave it out of GitHub'),
          { status: 409, code: 'PENDING_WORK', pending: { dirty: work.dirty.length, unpushed: work.unpushed, commits } },
        );
      }
    }

    // --- from here on, GitHub ------------------------------------------------
    const closing = closingOf(task);
    closing.status = 'publishing';
    closing.error = null;
    store.touch(task);

    try {
      // 1. The comment. Its id is persisted BEFORE the close, so a crash in
      //    between leaves a retry editing instead of publishing twice.
      const published = await publishIssueComment(task.issue, text, {
        commentId: closing.commentId ?? null,
        project: task.project,
      });
      closing.commentId = published.id;
      closing.commentUrl = published.url;
      closing.publishedAt = new Date().toISOString();
      store.addLog(task, 'close', `closing comment ${published.how === 'edited' ? 'edited' : 'published'}: ${published.url}`);
      store.touch(task);

      // 2. Labels.
      if (names.length) {
        const added = await addIssueLabels(task.issue, names, task.project);
        closing.labels = added;
        store.addLog(task, 'close', `labels added: ${added.join(', ')}`);
        store.touch(task);
      }

      // 3. The close itself, skipped when GitHub already reports it closed —
      //    a retry, or somebody who got there first.
      const live = await getIssue(task.issue, task.project);
      if (String(live.state ?? '').toUpperCase() === 'CLOSED') {
        store.addLog(task, 'close', 'the issue was already closed on GitHub: not closed again');
      } else {
        await closeIssue(task.issue, { reason, duplicateOf: dup, targetIsPr, project: task.project });
        store.addLog(task, 'close', `issue closed without a PR (${reason}${dup ? `, duplicate of #${dup}` : ''})`);
      }
      task.issueClosed = true;
      task.closedWithoutPr = true;
      task.closable = null;
      closing.reason = reason;
      closing.duplicateOf = dup;
      closing.closedAt = new Date().toISOString();
      // A pipeline parked on a question has nothing left to ask about.
      settleTaskPending(task, { action: 'stop' });
      store.setState(task, 'done');
      store.touch(task);

      // 4. The stack. The guard is not optional: `stopStack` throws when the
      //    task has none, and a retry always finds none.
      if (task.stack) {
        await stopStack(keyOf(task)).catch((e) => store.addLog(task, 'close', `⚠️ could not stop the stack: ${reasonOf(e)}`));
      }

      // 5. Disk, measured again right now — never with the numbers step 8 read.
      closing.cleanup = { ...(await cleanupAfterClose(task)), at: new Date().toISOString() };

      closing.status = 'closed';
      closing.error = null;
      store.touch(task);
      return closing;
    } catch (e) {
      closing.error = reasonOf(e);
      // Back to whatever it was, so the window offers the retry that edits.
      closing.status = closing.closedAt ? 'closed' : (closing.draftedAt ? 'drafted' : 'idle');
      store.addLog(task, 'close', `⚠️ the closing stopped halfway: ${closing.error}`);
      store.touch(task);
      throw e;
    }
  } finally {
    closingPublishes.delete(key);
  }
}

// Tasks whose last session died on the Claude login. In memory on purpose: a
// task field would be stored and broadcast to every client.
const authFailed = new WeakMap();

/** Called where a run's failure is recorded: an auth death gets the renew card. */
function markAuthFailure(task) {
  const machine = authFailed.get(task);
  if (!machine) return;
  task.errorCode = 'auth_failed';
  task.errorInfo = { machine };
}

export const onChatEventOf = (task, chat, live, ev) => onChatEvent(task, chat, live, ev);
export const claudeLoggerOf = (task, phase) => claudeLogger(task, phase);
export const markAuthFailureOf = (task) => markAuthFailure(task);

function claudeLogger(task, phase) {
  return (ev) => {
    switch (ev.kind) {
      case 'auth': authFailed.set(task, ev.machine ?? task.machine ?? 'local'); break;
      case 'init':
        // The effort is what the board asked for (`tunedSession`); the CLI does not report it.
        store.addLog(task, phase, `Claude session started (${ev.model}${task.phaseModels?.[phase]?.effort ? `, effort ${task.phaseModels[phase].effort}` : ''})`);
        // A version bump reaches the board through the alias, on its own; the
        // first session to get the new one is where that becomes visible.
        if (ev.changed) store.addLog(task, phase, `ℹ️ «${ev.requested}» now resolves to ${ev.model} (was ${ev.previous})`);
        break;
      case 'text': store.addLog(task, phase, ev.text.length > 400 ? `${ev.text.slice(0, 400)}…` : ev.text); break;
      case 'tool': store.addLog(task, phase, `🔧 ${ev.name}: ${ev.input}`); break;
      case 'result': store.addLog(task, phase, `turn finished (${ev.turns} turns)`); break;
      case 'warn': store.addLog(task, phase, `⚠️ ${ev.warning}`); break;
      case 'error': store.addLog(task, phase, `⚠️ ${ev.error}`); break;
      default: break;
    }
  };
}
