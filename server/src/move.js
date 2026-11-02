import os from 'node:os';
import { config } from './config.js';
import { begin, end } from './metrics.js';
import { store, MOVE_STEPS } from './store.js';
import { coerceKey, keyOf } from './keys.js';
import { machines, machineViewFor, machineHostsProject } from './machine.js';
import { runClaude } from './claude.js';
import { renderPrompt } from './prompts.js';
import { chatsOf, openChats, chatById, chatRunning } from './chats.js';
import { isServerLike } from './activity.js';
import { projectSlug } from './subagents.js';
import { stopStack, pendingStops } from './stack.js';
import {
  createWorktree, removeWorktree, isProjectWorktree, pendingWork, mergeInProgress, resolveRef, pushBranch,
  worktreePathFor, localBranchExists, dirtyPaths, fetchBranch, aheadBehind, fastForwardTo, wipCommit,
  foreignWorktreeFor, dirSize,
} from './worktree.js';
import { baseBranchOf } from './projects.js';
import {
  assertMachineReady, gitBusyReason, closeTaskSessions, closeLiveSession, continuationContext,
  refreshBranchStatus, withInfraRetries, gitMutex, markRunning, tick, assertNotMoving,
} from './pipeline.js';

/**
 * Moving a task to another machine, as many times as it takes.
 *
 * Each machine has its own clone, so the work travels through origin: what is
 * left uncommitted becomes a WIP commit and is pushed, the target fetches and
 * fast-forwards. What does not travel is the conversation — a transcript lives
 * in `~/.claude/projects` of the machine that wrote it — so before leaving,
 * each chat writes a handoff, and `task.places` remembers the sessions left on
 * every machine, so coming back resumes them instead of starting over.
 *
 * The order is what makes a failure cheap: the target is built before the
 * source is let go of, and a task that could not arrive is still whole where it
 * was. A move never goes through `state = 'error'` either — Retry would resume
 * the pipeline from `prevState`, which is not what failed. `task.moving` is the
 * move's own record, and «Reintentar mudanza» runs it again step by step.
 *
 * Circular with pipeline.js on purpose: nothing here runs at load time, and the
 * hooks below reach its functions through closures, not captured bindings.
 */

/** What a remote probe may take before the target counts as unreachable. */
const PROBE_MS = 20_000;
const HANDOFF_TIMEOUT_MS = 5 * 60_000;
const PREWARM_TIMEOUT_MS = 90 * 60_000;
const SIZE_TTL_MS = 10 * 60_000;
const FETCH_TTL_MS = 30_000;

const HOME_TTL_MS = 10 * 60_000;

// The steps, in order; `task.moving.step` is the one running, or the one that
// failed. Defined in store.js, whose boot block needs to know which of them
// come before the task has arrived.
export { MOVE_STEPS };

const homeCache = new Map();   // machine name -> { at, promise }

/**
 * A machine's home directory, asked at most every ten minutes: the dialog
 * polls every five seconds, and on a runner each ask is a request. `info()` on
 * the local machine also runs `claude --version`, so there it is this
 * process's own home. A failure is not remembered.
 */
function cachedHome(machine) {
  const hit = homeCache.get(machine.name);
  if (hit && Date.now() - hit.at < HOME_TTL_MS) return hit.promise;
  const promise = machine.kind === 'local'
    ? Promise.resolve(os.homedir())
    : Promise.resolve().then(() => machine.info()).then((info) => info.home);
  homeCache.set(machine.name, { at: Date.now(), promise });
  promise.catch(() => { if (homeCache.get(machine.name)?.promise === promise) homeCache.delete(machine.name); });
  return promise;
}

/**
 * Seams for tests. `assertMachineReady` compares the machine's `claude` with
 * the SDK's, which an in-process runner answers with whatever the host has;
 * `homeOf` decides where transcripts are looked for, so a test never writes
 * into the user's real `~/.claude/projects`; `probeMs` is how long a remote
 * probe may take before the target counts as unreachable.
 */
export const moveHooks = {
  runClaude: (options) => runClaude(options),
  assertMachineReady: (machine) => assertMachineReady(machine),
  homeOf: (machine) => cachedHome(machine),
  probeMs: PROBE_MS,
};

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

/**
 * The task an entry point was asked about. Every exported function here is
 * reached from a route or from the web, and both still speak in issue numbers
 * — the composite key never travels in a URL — so the argument may be a bare
 * number, a numeric string, or a canonical key. It is read once, here; past
 * this line the code holds a task and asks it for `keyOf(task)`.
 */
function taskOf(issue) {
  const key = coerceKey(issue);
  const task = key ? store.get(key) : null;
  // `#12` for a number, `app-b#4242` for a key: prefixing a key with a
  // hash of its own reads as `#app-b#4242`, which is nobody's spelling.
  if (!task) throw httpError(404, `Unknown task ${String(issue).includes('#') ? issue : `#${issue}`}`);
  return task;
}

function withTimeout(promise, ms, what) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no response in ${Math.round(ms / 1000)} s`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

const log = (task, line) => store.addLog(task, 'mudanza', line);

// ---------------------------------------------------------------------------
// Sessions and places.

/**
 * Where a session's own transcript may be on a machine. `transcriptCandidates`
 * in subagents.js builds a subagent's path; a session's sits one level up, with
 * the same three spellings of the slug (the drive letter comes either way).
 */
export function sessionTranscriptCandidates({ home, cwd, sessionId, join }) {
  const slug = projectSlug(cwd);
  const slugs = [...new Set([slug, slug.charAt(0).toLowerCase() + slug.slice(1), slug.charAt(0).toUpperCase() + slug.slice(1)])];
  return slugs.map((s) => join(home, '.claude', 'projects', s, `${sessionId}.jsonl`));
}

async function transcriptExists(machine, { home, cwd, sessionId }) {
  if (!home || !cwd || !sessionId) return false;
  const candidates = sessionTranscriptCandidates({ home, cwd, sessionId, join: (...p) => machine.path.join(...p) });
  for (const file of candidates) {
    if (await machine.fs.exists(file).catch(() => false)) return true;
  }
  return false;
}

/** The machine's home, or null when it does not answer in time. */
async function homeFor(task, machine) {
  try {
    return await withTimeout(Promise.resolve(moveHooks.homeOf(machine)), moveHooks.probeMs, machine.name);
  } catch (e) {
    log(task, `⚠️ could not tell where ${machine.name} keeps its transcripts (${e.message}); its sessions will not resume`);
    return null;
  }
}

/** Where a machine's sessions of this task ran: the place's worktree, or where one would be. */
function placeCwd(task, machineName) {
  if (machineName === task.machine && task.worktreePath) return task.worktreePath;
  const known = task.places?.[machineName]?.worktreePath;
  if (known) return known;
  const { machine } = machineViewFor(task, machineName);
  return machine && task.branch ? worktreePathFor(machine, task.branch) : null;
}

/**
 * Writes down what the task leaves on a machine: its worktree and, for the
 * machine it is running on, each chat's session. A chat still waiting to fork
 * is written as `{ forkFrom }` — its id is its parent's, and resuming it plain
 * would append to the parent's thread. Entries already there for chats with no
 * session now are kept: a transcript check decides later whether they are dead.
 */
export function recordPlace(task, machineName, { worktreePath } = {}) {
  if (!task.places || typeof task.places !== 'object') task.places = {};
  const previous = task.places[machineName] ?? null;
  const sessions = { ...(previous?.sessions ?? {}) };
  if (machineName === task.machine) {
    for (const chat of chatsOf(task)) {
      if (!chat.sessionId) continue;
      sessions[chat.id] = chat.forkPending ? { forkFrom: chat.sessionId } : chat.sessionId;
    }
  }
  for (const id of Object.keys(sessions)) if (!chatById(task, id)) delete sessions[id];

  const place = {
    worktreePath: worktreePath !== undefined
      ? worktreePath
      : machineName === task.machine ? task.worktreePath ?? null : previous?.worktreePath ?? null,
    sessions,
    at: new Date().toISOString(),
  };
  task.places[machineName] = place;
  return place;
}

/**
 * Gives each chat back the session it had on `machineName`, when that session's
 * transcript is still there (the CLI deletes them after 30 days, and a resume
 * of a missing one fails every turn for ever). Session ids only: what the chat
 * is told on arrival is `arrive`'s.
 *
 * `onlyMissing` leaves chats that already have a session alone — for a worktree
 * re-created on the same machine. Returns the ids of the chats restored.
 */
export async function restoreSessions(task, machineName, { onlyMissing = false } = {}) {
  const { machine } = machineViewFor(task, machineName);
  const restored = new Set();
  if (!machine) return restored;
  const sessions = task.places?.[machineName]?.sessions ?? {};
  const targets = chatsOf(task).filter((c) => !onlyMissing || !c.sessionId);
  if (!targets.length) return restored;

  const cwd = placeCwd(task, machineName);
  const needsHome = targets.some((c) => sessions[c.id]);
  const home = needsHome ? await homeFor(task, machine) : null;
  // Not knowing where the transcripts are is not the same as their being gone:
  // carrying on would drop every resumable session, and say they had no
  // transcript. Failing is cheap — a move retries from this very step.
  if (needsHome && !home) throw new Error(`${machineName}: could not read its home; sessions will not be restored`);
  const exists = (sessionId) => transcriptExists(machine, { home, cwd, sessionId });
  const restore = (chat, sessionId, forkPending) => {
    chat.sessionId = sessionId;
    chat.forkPending = forkPending;
    restored.add(chat.id);
  };

  // Chats with a thread of their own first; forks after, so a fork's parent
  // has always been decided before the fork asks about it.
  const forks = [];
  for (const chat of targets) {
    const entry = sessions[chat.id];
    const wasFork = (entry && typeof entry === 'object') || chat.forkPending === true;
    if (wasFork) {
      forks.push({ chat, entry });
      continue;
    }
    if (typeof entry === 'string' && await exists(entry)) {
      restore(chat, entry, false);
      continue;
    }
    if (entry) log(task, `«${chat.title}»: its session on ${machineName} no longer has a transcript; starting from scratch`);
    chat.sessionId = null;
    chat.forkPending = false;
  }

  let waiting = [];
  for (const item of forks) {
    const { chat, entry } = item;
    if (typeof entry === 'string' && await exists(entry)) restore(chat, entry, false);
    else if (entry?.forkFrom && await exists(entry.forkFrom)) restore(chat, entry.forkFrom, true);
    else waiting.push(item);
  }
  // A fork that never had a turn of its own: its parent's session here is as
  // good a starting point as the one it forked from elsewhere. Repeated until
  // nothing changes, for a fork of a fork listed before its parent.
  const settled = (parent) => parent?.sessionId
    && (restored.has(parent.id) || (onlyMissing && !targets.includes(parent)));
  for (let progress = true; progress && waiting.length;) {
    progress = false;
    const next = [];
    for (const item of waiting) {
      const parent = item.chat.forkedFrom ? chatById(task, item.chat.forkedFrom) : null;
      if (settled(parent)) {
        restore(item.chat, parent.sessionId, true);
        progress = true;
      } else {
        next.push(item);
      }
    }
    waiting = next;
  }
  for (const { chat, entry } of waiting) {
    if (entry) log(task, `«${chat.title}»: neither its session nor its source chat's is on ${machineName}; starting from scratch`);
    chat.sessionId = null;
    chat.forkPending = false;
  }
  return restored;
}

/**
 * The bookkeeping of arriving: each open chat gets the block its first turn
 * will carry, and everything that pointed at a session on the other machine
 * lets go of it.
 */
export function arrive(task, moving, brief, restored = new Set()) {
  const at = new Date().toISOString();
  for (const chat of chatsOf(task)) {
    if (!chat.closedAt) {
      chat.handoff = {
        from: moving.from,
        to: moving.to,
        at,
        text: chat.handoffDraft?.text ?? null,
        brief: brief || null,
        resumed: restored.has(chat.id),
        wip: Boolean(moving.wip),
      };
    }
    delete chat.handoffDraft;
    for (const t of chat.plan?.tasks ?? []) t.sessionId = null;
  }
  // The plan's sessions forked from a planning session that stayed behind.
  task.planSessionId = null;
  if (task.workPlan) {
    task.workPlan.forkFrom = null;
    for (const t of task.workPlan.tasks ?? []) t.sessionId = null;
    // A plan waiting for approval was made reading the other machine's tree:
    // approving it here plans again, from it.
    if (moving.saved?.state === 'plan_ready') task.workPlan.replan = { from: moving.from, at };
  }
  // The servers stayed behind, stopped; and the numbers were the other clone's.
  // A stop that failed there keeps its saved commands (each knows its machine),
  // so «Stop stack» or the next start still runs them.
  const owed = pendingStops(task.stack);
  task.stack = owed.length
    ? { status: 'error', services: {}, leftover: owed, error: 'The stack could not be stopped on the previous machine. Press «Stop stack» to try again.' }
    : null;
  task.branchStatus = null;
}

// ---------------------------------------------------------------------------
// What stands in the way.

const fetchCache = new Map();   // `${machine}\0${branch}` -> { at, promise }

/** `fetchBranch` at most every 30 s per machine and branch: the dialog asks every 5. */
function cachedFetch(machine, cwd, branch) {
  const key = `${machine.name}\0${branch}`;
  const hit = fetchCache.get(key);
  if (hit && Date.now() - hit.at < FETCH_TTL_MS) return hit.promise;
  const promise = fetchBranch(machine, cwd, branch);
  fetchCache.set(key, { at: Date.now(), promise });
  promise.catch(() => { if (fetchCache.get(key)?.promise === promise) fetchCache.delete(key); });
  return promise;
}

const sizeCache = new Map();    // `${machine}\0${path}` -> { at, promise }

/**
 * A worktree's size, measured at most every ten minutes and never twice at
 * once: the dialog asks every five seconds, and a 40 GB tree can take longer
 * than that to walk. A scan that ran out of time is remembered too, for the
 * same reason.
 */
function cachedSize(machine, dir) {
  if (!dir) return Promise.resolve(null);
  const key = `${machine.name}\0${dir}`;
  const hit = sizeCache.get(key);
  if (hit && Date.now() - hit.at < SIZE_TTL_MS) return hit.promise;
  const promise = dirSize(machine, dir, { timeoutMs: 15_000 }).catch(() => null);
  sizeCache.set(key, { at: Date.now(), promise });
  return promise;
}

/** Background commands, subagents and servers still running in the task's chats. */
function runningItems(task, now = Date.now()) {
  const servers = [];
  const background = [];
  for (const chat of chatsOf(task)) {
    if (!chatRunning(chat, now)) continue;
    const walk = (items) => {
      for (const item of items ?? []) {
        const running = ['running', 'stopping'].includes(item.status);
        if (item.kind === 'bash' && item.background && running) {
          const entry = {
            chatId: chat.id, itemId: item.id, name: item.summary || item.command,
            port: item.port ?? null, taskId: item.taskId ?? null,
          };
          (isServerLike(item, now) ? servers : background).push(entry);
        } else if (item.kind === 'agent' && item.status === 'running') {
          background.push({ chatId: chat.id, itemId: item.id, name: item.summary || item.subagentType || 'subagente', taskId: item.taskId ?? null });
        }
        walk(item.children);
      }
    };
    for (const message of chat.messages ?? []) if (message.role === 'activity') walk(message.items);
  }
  return { servers, background };
}

/**
 * The source side, as the dialog shows it. `fetchBranch` first, so `unpushed`
 * compares with what origin has now rather than at the last poll.
 */
async function inspectSource(task, { fetchFn = cachedFetch } = {}) {
  const { machine } = machineViewFor(task, task.machine);
  const wt = task.worktreePath;
  const out = { machine: task.machine, worktreePath: wt ?? null, valid: false, dirty: [], otherDirty: 0, unpushed: null, mergeStuck: false };
  if (!machine || !wt || !task.branch) return out;
  if (!(await isProjectWorktree(machine, wt).catch(() => false))) return out;
  out.valid = true;
  await fetchFn(machine, wt, task.branch).catch(() => null);
  const [pw, stuck] = await Promise.all([
    pendingWork(machine, wt, task.branch).catch(() => null),
    mergeInProgress(machine, wt).catch(() => false),
  ]);
  if (pw) {
    out.dirty = dirtyPaths(pw.dirty);
    out.otherDirty = pw.otherDirty;
    out.unpushed = pw.unpushed;
  }
  out.mergeStuck = stuck;
  return out;
}

/**
 * The target side: can it take the task, and what is already there. Every
 * probe has a short leash — an unreachable box is one blocker, not a dialog
 * that hangs.
 */
async function inspectTarget(task, to, { fetchFn = cachedFetch, fresh = false } = {}) {
  const { machine, error: noView } = machineViewFor(task, to);
  const out = { machine: to, ready: false, error: null, fetchError: null, worktree: 'none', path: null, ahead: null, behind: null, dirty: [], foreign: null, unreachable: false };
  // The reason travels as `error`, but for the two machines that can produce it
  // `blockersFrom` returns earlier with a better one — `project_not_movable` or
  // `unknown_machine` — so nobody reads it out of a dialog.
  if (!machine) { out.error = noView; return out; }
  if (!task.branch) return out;
  const branch = task.branch;
  out.path = worktreePathFor(machine, branch);

  const probe = (promise, what) => withTimeout(Promise.resolve(promise), moveHooks.probeMs, `${to}: ${what}`);
  try {
    await probe(moveHooks.assertMachineReady(machine), 'checking the machine');
    out.ready = true;
  } catch (e) {
    out.error = e.message;
    out.unreachable = true;
    return out;
  }

  try {
    out.foreign = await probe(foreignWorktreeFor(machine, branch), 'git worktree list');
    if (out.foreign) out.worktree = 'foreign';
  } catch (e) {
    out.error = e.message;
    out.unreachable = /sin respuesta|no response/.test(e.message);
    return out;
  }

  try {
    const exists = await probe(isProjectWorktree(machine, out.path), 'looking at the worktree');
    if (exists && out.worktree === 'none') out.worktree = 'exists';
    // With a worktree, measure there; with only a stale local branch left by
    // a deleted worktree, from the checkout — its commits would be adopted.
    const cwd = exists ? out.path : machine.repoPath;
    const hasBranch = exists || await probe(localBranchExists(machine, branch), 'looking for the branch');
    if (hasBranch) {
      // Not on the probe's leash: a fetch over a slow tailnet is not an
      // unreachable machine, and one cut short keeps running into a ref lock.
      // `fetchBranch` has a two-minute limit of its own.
      try {
        await fetchFn(machine, cwd, branch);
      } catch (e) {
        // Right before a move, origin must be read as it is. For the dialog,
        // the last fetched `origin/<branch>` still says something — marked stale.
        if (fresh) throw e;
        out.fetchError = e.message;
      }
      const ab = await probe(aheadBehind(machine, cwd, branch), 'comparing with origin');
      if (ab) { out.ahead = ab.ahead; out.behind = ab.behind; }
    }
    if (exists) {
      const pw = await probe(pendingWork(machine, out.path, branch), 'git status');
      out.dirty = pw.dirty;
    }
  } catch (e) {
    out.error = e.message;
    out.unreachable = /sin respuesta|no response/.test(e.message);
  }
  return out;
}

function blockersFrom(task, to, source, target, { discardTargetLocal = false, resuming = false } = {}) {
  const blockers = [];
  const add = (code, text, items) => blockers.push(items ? { code, text, items } : { code, text });

  // A non-default project travels only between machines that hold a checkout
  // of it: local always, a runner only if `machines.<name>.projects` declares
  // it. Otherwise a move would build a worktree from a repository that is not
  // on that box. Listed alone, and returning here, because nothing else in
  // this function has anything to add.
  const from = task.machine ?? 'local';
  if (!machineHostsProject(from, task.project) || !machineHostsProject(to, task.project)) {
    add('project_not_movable',
      `The project "${task.project}" is not declared on both machines: add it under machines.<name>.projects in config.json`);
    return blockers;
  }

  const busy = gitBusyReason(task);
  if (busy) add('busy', `Cannot move: ${busy}`);
  if (task.pending) add('task_pending', 'A board session is waiting for your answer');
  if (task.qaBusy) add('qa', 'Browser QA is running');
  if (task.creatingWorktree) add('creating_worktree', 'The worktree is being created');
  if (task.moving && !task.moving.error) add('moving', 'The task is already being moved');

  const waiting = openChats(task).filter((c) => c.pending || ['running', 'asking'].includes(c.plan?.status));
  if (waiting.length) {
    add('chat_pending', 'Chats are waiting for an answer or running a plan',
      waiting.map((c) => ({ chatId: c.id, title: c.title })));
  }
  const { servers, background } = runningItems(task);
  if (background.length) add('background', 'Subagents or commands are running in the background', background);
  if (servers.length) add('servers', 'Servers started from the chat are running: stop them first', servers);

  if (!task.branch) add('no_branch', 'The task has no branch');
  if (!machines()[to]) {
    add('unknown_machine', `There is no machine "${to}" in config.machines`);
    return blockers;
  }
  if (to === task.machine && !resuming) add('same_machine', `The task is already on ${to}`);
  if (!task.branch) return blockers;

  // The source only matters while the task is still there; a retry that
  // already arrived has nothing left to read on it.
  if (task.machine !== to) {
    if (!source.valid) add('no_worktree', `The task has no valid worktree on ${task.machine}: without a worktree, the machine is switched without a move`);
    if (source.mergeStuck) add('merge_in_progress', `There is a half-done merge in the worktree on ${task.machine}`);
  }

  if (!target.ready) {
    add(target.unreachable ? 'target_unreachable' : 'target_not_ready', target.error ?? `${to} is not ready`);
    return blockers;
  }
  if (target.error) {
    add(target.unreachable ? 'target_unreachable' : 'target_git', `${to}: ${target.error}`);
    return blockers;
  }
  if (target.foreign) add('target_foreign', `On ${to} the branch ${task.branch} is already in another worktree: ${target.foreign}`);

  const liftable = [];
  if (target.ahead > 0) {
    liftable.push({
      code: 'target_ahead',
      text: `On ${to} the branch has ${target.ahead} unpushed commit(s); discarding them leaves the branch as origin`,
    });
  }
  if (target.dirty.length) {
    liftable.push({
      code: 'target_dirty',
      text: `On ${to} there are ${target.dirty.length} uncommitted file(s) of the branch; discarding them leaves the branch as origin`,
      items: target.dirty,
    });
  }
  for (const b of liftable) blockers.push(discardTargetLocal ? { ...b, lifted: true } : b);
  return blockers;
}

/**
 * Every reason the task cannot move to `to` right now — all of them, so the
 * dialog lists what to stop in one go. `target_ahead` and `target_dirty` are
 * still listed with `discardTargetLocal`, marked `lifted: true`: they are what
 * that option throws away.
 *
 * `resuming` is a retry of a failed move to this same machine: the task may
 * already be there, and its own failed record is not "already moving".
 * `fresh` skips the 30-second fetch cache the dialog's polling relies on:
 * the check right before a move must read origin as it is.
 */
export async function moveBlockers(task, to, { discardTargetLocal = false, resuming, fresh = false } = {}) {
  const isRetry = Boolean(task.moving?.error && task.moving.to === to) && resuming !== false;
  const fetchFn = fresh ? (m, cwd, b) => fetchBranch(m, cwd, b) : cachedFetch;
  const [source, target] = await Promise.all([inspectSource(task, { fetchFn }), inspectTarget(task, to, { fetchFn, fresh })]);
  return blockersFrom(task, to, source, target, { discardTargetLocal, resuming: isRetry });
}

const gating = (blockers) => blockers.filter((b) => !b.lifted);

/** What the move dialog shows: what blocks it, and what it would do. */
export async function movePreflight(issue, to, { discardTargetLocal = false } = {}) {
  const task = taskOf(issue);
  if (!to) throw httpError(400, 'Missing target machine');
  const resuming = Boolean(task.moving?.error && task.moving.to === to);

  const { machine: sourceMachine } = machineViewFor(task, task.machine);
  const [source, target] = await Promise.all([inspectSource(task), inspectTarget(task, to)]);
  const blockers = blockersFrom(task, to, source, target, { discardTargetLocal, resuming });

  const { machine: targetMachine } = machineViewFor(task, to);
  const [sizeBytes, sourceHome, targetHome] = await Promise.all([
    source.valid ? cachedSize(sourceMachine, source.worktreePath) : null,
    sourceMachine ? withTimeout(Promise.resolve(moveHooks.homeOf(sourceMachine)), moveHooks.probeMs, task.machine).catch(() => null) : null,
    targetMachine && target.ready ? withTimeout(Promise.resolve(moveHooks.homeOf(targetMachine)), moveHooks.probeMs, to).catch(() => null) : null,
  ]);
  const targetCwd = target.worktree === 'exists' ? target.path : task.places?.[to]?.worktreePath ?? target.path;
  const sessionsThere = task.places?.[to]?.sessions ?? {};

  const chats = await Promise.all(openChats(task).map(async (chat) => {
    const entry = sessionsThere[chat.id];
    const id = typeof entry === 'string' ? entry : entry?.forkFrom;
    if (id && targetMachine && await transcriptExists(targetMachine, { home: targetHome, cwd: targetCwd, sessionId: id })) {
      return { id: chat.id, title: chat.title, plan: 'resume' };
    }
    if (chat.sessionId && !chat.forkPending && sourceMachine
      && await transcriptExists(sourceMachine, { home: sourceHome, cwd: source.worktreePath, sessionId: chat.sessionId })) {
      return { id: chat.id, title: chat.title, plan: 'handoff' };
    }
    return { id: chat.id, title: chat.title, plan: 'fresh' };
  }));

  return {
    blockers,
    source: {
      machine: source.machine,
      worktreePath: source.worktreePath,
      dirty: source.dirty,
      otherDirty: source.otherDirty,
      unpushed: source.unpushed,
      sizeBytes,
    },
    target: {
      machine: to,
      ready: target.ready,
      worktree: target.worktree,
      path: target.path,
      ahead: target.ahead,
      behind: target.behind,
      dirty: target.dirty,
      // Set when this poll could not fetch: `ahead`/`behind` are from the last fetch.
      fetchError: target.fetchError,
    },
    chats,
    pr: task.prNumber ?? null,
    stack: Boolean(task.stack),
  };
}

// ---------------------------------------------------------------------------
// The move.

/**
 * Validates, marks the task as moving and returns; the work carries on in the
 * background, reported to the task log. Calling it again for the machine a
 * failed move was headed to is a retry of that move.
 */
export async function moveTask(issue, { to, oldWorktree, prewarm, discardTargetLocal } = {}) {
  const task = taskOf(issue);
  if (!to || typeof to !== 'string') throw httpError(400, 'Missing target machine');
  if (oldWorktree !== undefined && !['keep', 'remove'].includes(oldWorktree)) {
    throw httpError(400, `oldWorktree must be keep or remove, not "${oldWorktree}"`);
  }
  const retrying = Boolean(task.moving?.error && task.moving.to === to);
  const previous = retrying ? task.moving : null;
  // A failed move that already arrived holds the task half-way: a new one
  // would overwrite that record, and only a retry finishes it.
  if (!retrying && task.moving?.error && task.machine === task.moving.to) {
    const blocker = { code: 'moving_unfinished', text: `The previous move reached ${task.moving.to} but was left half-done: retry it` };
    throw httpError(409, blocker.text, { blockers: [blocker] });
  }
  const options = {
    oldWorktree: oldWorktree ?? previous?.oldWorktree ?? 'keep',
    prewarm: prewarm ?? previous?.prewarm ?? true,
    discardTargetLocal: discardTargetLocal ?? previous?.discardTargetLocal ?? false,
  };

  const blockers = gating(await moveBlockers(task, to, { discardTargetLocal: options.discardTargetLocal, fresh: true }));
  if (blockers.length) throw httpError(409, blockers.map((b) => b.text).join('; '), { blockers });
  // Checked again: the probes above took time, and something may have started.
  const late = gitBusyReason(task) ?? (task.moving && !task.moving.error ? 'la tarea ya se está mudando' : null);
  if (late) {
    const blocker = { code: 'busy', text: `Cannot move: ${late}` };
    throw httpError(409, blocker.text, { blockers: [blocker] });
  }

  // The state to come back to, read now: after a failure it was restored, and
  // anything that happened since (a Retry that finished) is the truth.
  // `phase` and `prPark` are deliberately not saved here: they say where this
  // task's own run stopped and what title is waiting for you, and both travel
  // with the task to the other machine.
  const saved = { state: task.state, prevState: task.prevState ?? null, error: task.error ?? null };
  if (previous && task.moving === previous) {
    Object.assign(previous, options, { saved, error: null });
    log(task, `retrying the move to ${to} from «${previous.step}»`);
  } else {
    // A fresh move: drafts from an earlier one would be taken for this one's.
    for (const chat of chatsOf(task)) delete chat.handoffDraft;
    task.moving = {
      from: task.machine,
      to,
      sourceWt: task.worktreePath,
      saved,
      startedAt: new Date().toISOString(),
      step: 'blockers',
      ...options,
      wip: false,
      brief: null,
      error: null,
    };
    log(task, `moving the task from ${task.machine} to ${to}`);
  }
  // Busy for the server and the web alike, set directly: `setState` would
  // overwrite `error` and `prevState`, and a task in error must keep its Retry.
  task.state = 'worktree';
  markRunning(keyOf(task), true);
  store.touch(task);

  setImmediate(() => { runMove(task).catch(() => {}); });
  return task.moving;
}

/** «Reintentar mudanza»: the failed move again, with its own options. */
export async function retryMove(issue) {
  const task = taskOf(issue);
  if (!task.moving?.error) throw httpError(400, 'There is no failed move to retry');
  return moveTask(keyOf(task), { to: task.moving.to });
}

async function runMove(task) {
  const moving = task.moving;
  const { from, to, sourceWt } = moving;
  const branch = task.branch;
  const { machine: source, error: noSource } = machineViewFor(task, from);
  const { machine: target, error: noTarget } = machineViewFor(task, to);
  const onLine = (l) => log(task, l);
  let ok = false;

  // Up to arrival every step is safe to run again, and the user may have used
  // the task where it still was since the last attempt; after it, pick up
  // where it stopped.
  let start = MOVE_STEPS.indexOf(moving.step);
  if (start < 1 || task.machine !== to) start = 1;
  const reached = (step) => MOVE_STEPS.indexOf(step) >= start;
  // One `op` span per step, hung on the task; 'done' is the end, not a step.
  let stepSpan = null;
  const endStep = (outcome) => {
    if (stepSpan) end(task, stepSpan, { outcome });
    stepSpan = null;
  };
  const enter = (step, line) => {
    endStep('ok');
    moving.step = step;
    if (step !== 'done') stepSpan = begin(task, { kind: 'op', name: `move:${step}`, from, to });
    if (line) log(task, line);
    store.touch(task);
  };

  try {
    if (!source || !target) throw new Error(source ? noTarget : noSource);

    if (reached('source_git')) {
      enter('source_git', `${from}: saving and pushing the work of ${branch}…`);
      await gitMutex.runExclusive(sourceWt, () => sourceGit(task, moving, source, onLine));
    }

    if (reached('handoff')) {
      enter('handoff');
      await handoffs(task, moving, source);
    }

    if (reached('park_source')) {
      enter('park_source', `${from}: stopping the task's processes`);
      if (task.stack) {
        await stopStack(keyOf(task)).then(
          () => log(task, `the stack was stopped on ${from}: on ${to} press «Start app» again (the links change host)`),
          (e) => log(task, `⚠️ could not stop the stack on ${from}: ${e.message}`),
        );
      }
      await closeTaskSessions(task);
      killPrewarm(task, from);
      if (source.platform !== 'win32') {
        const left = await withTimeout(source.daemon.find(sourceWt, []), moveHooks.probeMs, from).catch(() => []);
        if (left.length) log(task, `⚠️ processes are still running in the worktree on ${from}: ${left.map((p) => `${p.pid} ${p.path}`).join(', ')}`);
      }
      recordPlace(task, from, { worktreePath: sourceWt });
    }

    if (reached('build_target')) {
      enter('build_target', `${to}: preparing the worktree…`);
      await buildTarget(task, moving, target, onLine);
    }

    if (reached('chats')) {
      enter('chats');
      const restored = await restoreSessions(task, to);
      arrive(task, moving, moving.brief, restored);
      if (restored.size) log(task, `${restored.size} chat(s) resume the session they had on ${to}`);
    }

    if (reached('remove_source') && moving.oldWorktree === 'remove') {
      enter('remove_source', `${from}: deleting the worktree left there`);
      // Never fatal: the task already lives on the target, and a place that
      // could not be removed is still listed, with its path, to try again.
      await removePlaceNow(task, from).catch((e) => log(task, `⚠️ could not delete the worktree on ${from}: ${e.message}`));
    }

    if (reached('prewarm') && moving.prewarm) {
      enter('prewarm');
      startPrewarm(task, to, task.worktreePath);
    }

    enter('done');
    ok = true;
  } catch (e) {
    moving.error = e.message;
    endStep('error');
    log(task, `⚠️ the move to ${to} failed at «${moving.step}»: ${e.message}`);
  } finally {
    endStep('ok');
    // Whatever happened, the card goes back to where it was and the issue is
    // free again: no throw may leave it held as running.
    task.state = moving.saved.state;
    task.prevState = moving.saved.prevState;
    task.error = moving.saved.error;
    markRunning(keyOf(task), false);
    if (ok) task.moving = null;
    store.touch(task);
  }

  if (ok) {
    await refreshBranchStatus(task).catch(() => {});
    log(task, `moved from ${from} to ${to}`);
    store.touch(task);
  }
  // Either way a slot was freed.
  tick();
}

/** Step 2: the branch's own unfinished work committed, and everything pushed. */
async function sourceGit(task, moving, source, onLine) {
  const { sourceWt } = moving;
  const branch = task.branch;
  await fetchBranch(source, sourceWt, branch, { onLine });
  const pw = await pendingWork(source, sourceWt, branch);
  let sha = null;
  if (pw.dirty.length) {
    const headBefore = await resolveRef(source, sourceWt, 'HEAD');
    const paths = dirtyPaths(pw.dirty);
    sha = await wipCommit(source, sourceWt, paths, { onLine });
    if (sha) {
      moving.wip = true;
      // The chats had seen the tree up to here; the WIP is their own work,
      // not a commit to report to them as someone else's.
      for (const chat of chatsOf(task)) if (headBefore && chat.lastSeenSha === headBefore) chat.lastSeenSha = sha;
      log(task, `commit WIP ${sha.slice(0, 8)} with ${paths.length} path(s): ${paths.slice(0, 5).join(', ')}${paths.length > 5 ? '…' : ''}`);
      if (task.fixedAt || task.e2ePassedAt || task.qa?.passedAt) {
        log(task, 'the recorded fix, e2e tests and Browser QA no longer belong to the new HEAD; Retry goes through the continuation fix');
      }
    }
  }
  if (pw.otherDirty) log(task, `(${pw.otherDirty} dirty file(s) the branch does not touch stay on ${moving.from})`);
  if (pw.unpushed !== 0 || sha) {
    // Never forced: a push origin refuses stops the move with git's reason.
    await withInfraRetries(task, 'mudanza', 'the push', () => pushBranch(source, sourceWt, branch, { onLine }));
    log(task, `branch ${branch} pushed to origin`);
  }
}

/**
 * Step 3: before a chat leaves, its own session writes what the next one needs.
 * The turn appends to the transcript, which is right: if the task comes back
 * here, the session resumes knowing it already said goodbye.
 */
async function handoffs(task, moving, source) {
  if (moving.brief == null) {
    moving.brief = await continuationContext(task).catch((e) => {
      log(task, `⚠️ could not summarize the branch for the handoff: ${e.message}`);
      return '';
    });
  }
  // A draft is this step's mark of done: a retry does not ask twice.
  const candidates = openChats(task).filter((c) => c.sessionId && !c.forkPending && !c.handoffDraft);
  if (!candidates.length) return;
  const home = await homeFor(task, source);

  await Promise.all(candidates.map(async (chat) => {
    if (!(await transcriptExists(source, { home, cwd: moving.sourceWt, sessionId: chat.sessionId }))) return;
    if (closeLiveSession(keyOf(task), chat.id)) await new Promise((r) => setTimeout(r, 1000));
    log(task, `handoff for «${chat.title}»…`);
    try {
      chat.handoffDraft = { text: await handoffFor(task, chat, { machine: source, cwd: moving.sourceWt }) };
      log(task, chat.handoffDraft.text ? `«${chat.title}» left its handoff` : `«${chat.title}» wrote nothing; the branch summary travels instead`);
    } catch (e) {
      chat.handoffDraft = { text: null };
      log(task, `⚠️ the handoff for «${chat.title}» failed (${e.message}); the branch summary travels instead`);
    }
    store.touch(task);
  }));
}

/** One handoff turn, from memory, with a five-minute leash. */
export async function handoffFor(task, chat, { machine, cwd }) {
  let query = null;
  let timer;
  const turn = moveHooks.runClaude({
    machine,
    cwd,
    model: chat.model ?? config.claude.chatModel,
    resume: chat.sessionId,
    maxTurns: 6,
    permissionMode: 'plan',
    // No built-in tools at all: in plan mode read-only and allow-listed tools
    // run without asking, so the deny below alone would not stop them.
    tools: [],
    canUseTool: async () => ({ behavior: 'deny', message: 'Answer from memory; no tools in this turn.' }),
    prompt: renderPrompt('handoff', {}),
    onQuery: (q) => { query = q; },
  });
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), HANDOFF_TIMEOUT_MS);
    timer.unref?.();
  });
  const result = await Promise.race([turn, expired]).finally(() => clearTimeout(timer));
  if (result?.timedOut) {
    try { query?.close?.(); } catch { /* already gone */ }
    throw new Error('no response in 5 minutes');
  }
  if (!result?.ok && !result?.resultText) throw new Error(result?.error ?? 'no result');
  return String(result.resultText ?? '').trim() || null;
}

/**
 * Step 5: the worktree on the target, at origin's tip. When this fails the
 * source is intact — the WIP is committed and pushed, the handoffs are in the
 * transcripts, the stack is stopped — and the task still points at it: the
 * machine, the path and the place change together, only once the target is
 * ready. Set apart, every log line in between would persist a task on one
 * machine with the other's path.
 */
async function buildTarget(task, moving, target, onLine) {
  const { from, to } = moving;
  const branch = task.branch;
  try {
    const known = task.places?.[to]?.worktreePath;
    let wt;
    if (known && await isProjectWorktree(target, known)) {
      wt = known;
      log(task, `${to}: reusing the worktree ${wt}`);
    } else {
      await moveHooks.assertMachineReady(target);
      wt = await withInfraRetries(task, 'mudanza', `creating the worktree on ${to}`, () => createWorktree(target, branch, { adopt: true, base: baseBranchOf(task.project), onLine }));
    }
    await fetchBranch(target, wt, branch, { onLine });
    const ff = await fastForwardTo(target, wt, branch, { discardLocal: Boolean(moving.discardTargetLocal), onLine });
    log(task, ff.moved
      ? `${to}: ${branch} advanced to ${String(ff.after).slice(0, 8)}${moving.discardTargetLocal ? ' (local work discarded)' : ''}`
      : `${to}: ${branch} was already up to date`);
    if (!task.places || typeof task.places !== 'object') task.places = {};
    const place = task.places[to];
    task.machine = to;
    task.worktreePath = wt;
    task.places[to] = { worktreePath: wt, sessions: place?.sessions ?? {}, at: new Date().toISOString() };
  } catch (e) {
    log(task, `the task stays on ${from} with its worktree intact (the WIP is already pushed; the stack was stopped, press «Start app» again)`);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// The build started on arrival.

const prewarms = new Map();   // task key -> { handle, machine, ended, limit }

/**
 * Ends a prewarm now and says so at once. `handle.kill()` alone is not enough:
 * on Windows it ends `cargo.exe` and leaves its rustc children holding the
 * target directory, and on a runner whose socket is gone it sends nothing and
 * `exit` never comes. `daemon.kill` ends the tree by pid — `taskkill /T /F`
 * here, the process group on POSIX — and the handle's own kill stays as the
 * fallback. The record is closed without waiting for an `exit` that may not
 * arrive.
 */
function stopPrewarm(task, entry, why) {
  if (entry.ended) return;
  entry.ended = true;
  clearTimeout(entry.limit);
  if (prewarms.get(keyOf(task)) === entry) prewarms.delete(keyOf(task));
  const { machine } = machineViewFor(task, entry.machine);
  if (machine && entry.handle.pid != null) {
    Promise.resolve().then(() => machine.daemon.kill(entry.handle.pid)).catch(() => {});
  }
  try { entry.handle.kill(); } catch { /* already gone */ }
  task.prewarm = { ...(task.prewarm ?? { machine: entry.machine }), endedAt: new Date().toISOString(), ok: null };
  log(task, `${entry.machine}: cargo build stopped (${why})`);
  store.touch(task);
}

/**
 * `cargo build` in the new worktree, so the first test run there does not pay
 * for a cold build. Debug, like CI and the chat sessions. Not awaited: the
 * task is usable while it runs, and cargo's directory lock turns any overlap
 * with another build into a wait.
 */
export function startPrewarm(task, machineName, wt) {
  if (prewarms.has(keyOf(task))) {
    log(task, 'a prewarm cargo build is already running for this task; leaving it');
    return null;
  }
  const { machine } = machineViewFor(task, machineName);
  if (!machine || !wt) return null;
  const startedAt = new Date().toISOString();
  let handle;
  try {
    handle = machine.daemon.spawn('cargo', { cwd: wt, args: ['build'] });
  } catch (e) {
    task.prewarm = { machine: machineName, startedAt, endedAt: startedAt, ok: false };
    log(task, `⚠️ could not start cargo build on ${machineName}: ${e.message}`);
    return null;
  }
  const entry = { handle, machine: machineName, ended: false, limit: null };
  prewarms.set(keyOf(task), entry);
  task.prewarm = { machine: machineName, startedAt, endedAt: null, ok: null };
  log(task, `${machineName}: prewarming with cargo build`);
  store.touch(task);

  // One line per crate would bury the log: every 50th, and the tail on failure.
  let count = 0;
  const recent = [];
  handle.on('line', (line) => {
    count += 1;
    recent.push(line);
    if (recent.length > 20) recent.shift();
    if (count % 50 === 0) log(task, `cargo build: ${line}`);
  });
  entry.limit = setTimeout(() => stopPrewarm(task, entry, 'more than 90 minutes'), PREWARM_TIMEOUT_MS);
  entry.limit.unref?.();
  handle.on('exit', (code, error) => {
    // A stopped one was already closed; its late exit changes nothing.
    if (entry.ended) return;
    entry.ended = true;
    clearTimeout(entry.limit);
    if (prewarms.get(keyOf(task)) === entry) prewarms.delete(keyOf(task));
    const ok = code === 0;
    task.prewarm = { ...(task.prewarm ?? { machine: machineName, startedAt }), endedAt: new Date().toISOString(), ok };
    if (ok) log(task, `${machineName}: cargo build finished`);
    else {
      log(task, `⚠️ ${machineName}: cargo build failed (${error?.message ?? `code ${code}`})`);
      for (const line of recent) log(task, line);
    }
    store.touch(task);
  });
  return handle;
}

/** Stops this task's prewarm, if it runs on `machineName` (or anywhere, with none). */
export function killPrewarm(task, machineName = null, why = 'the task is leaving that machine') {
  const entry = prewarms.get(keyOf(task));
  if (!entry || (machineName && entry.machine !== machineName)) return false;
  stopPrewarm(task, entry, why);
  return true;
}

/**
 * Forgets a failed move that never arrived: the task simply stays where it
 * is. Once it has arrived there is no «not moving» to go back to — the
 * machine and the path already changed — so only a retry finishes it.
 */
export function discardMove(issue) {
  const task = taskOf(issue);
  const moving = task.moving;
  if (!moving) throw httpError(409, 'There is no move to discard');
  if (!moving.error) throw httpError(409, 'The move is still running: it cannot be discarded');
  if (task.machine !== moving.from) {
    throw httpError(409, `The task has already reached ${moving.to}: that move can only be finished with "Retry move"`);
  }
  for (const chat of chatsOf(task)) delete chat.handoffDraft;
  task.moving = null;
  log(task, `move to ${moving.to} discarded; the task stays on ${moving.from}${moving.wip ? ' (the WIP commit is already pushed)' : ''}`);
  store.touch(task);
  return true;
}

// ---------------------------------------------------------------------------
// Removing a place.

/**
 * Deletes the task's worktree on one machine, keeping its sessions in
 * `task.places`: a worktree created there again — by a return, or by the
 * worktree button — resumes the same conversations, since the transcripts
 * live outside the worktree. Refused while the task is busy.
 */
export async function removePlace(task, machineName = task.machine) {
  const busy = gitBusyReason(task);
  if (busy) throw httpError(409, `The worktree cannot be removed right now: ${busy}`);
  // Also after a move that failed once arrived: the chats may still hold the
  // source's session ids, and `recordPlace` would file them under this machine.
  assertNotMoving(task);
  return removePlaceNow(task, machineName);
}

async function removePlaceNow(task, machineName) {
  const { machine, error } = machineViewFor(task, machineName);
  if (!machine) throw httpError(400, error);
  const active = machineName === task.machine;
  const wt = active ? task.worktreePath : task.places?.[machineName]?.worktreePath ?? null;
  if (!wt) throw httpError(400, active ? 'The task has no worktree' : `The task has no worktree on ${machineName}`);

  // Only the directory the board itself would have created for this branch,
  // and only when no other task claims it: a path in `places` is a memory, and
  // deleting on its word alone is how somebody else's checkout goes.
  if (!task.branch || !machine.samePath(wt, worktreePathFor(machine, task.branch))) {
    throw httpError(409, `${wt} is not where the board puts the worktree of ${task.branch ?? 'this task'} on ${machineName}; delete it by hand if it really is surplus`);
  }
  const claims = (t) => ((t.machine ?? 'local') === machineName && t.worktreePath && machine.samePath(t.worktreePath, wt))
    || Boolean(t.places?.[machineName]?.worktreePath && machine.samePath(t.places[machineName].worktreePath, wt));
  const other = store.all().find((t) => t !== task && claims(t));
  if (other) throw httpError(409, `The worktree ${wt} also belongs to task #${other.issue}; it is not deleted`);

  if (active) {
    // The compose file lives inside the worktree; and Windows refuses to delete
    // a directory a live session is standing in.
    if (task.stack) {
      await stopStack(keyOf(task)).catch((e) => store.addLog(task, 'stack', `⚠️ could not stop the stack: ${e.message}`));
    }
    await closeTaskSessions(task);
  }
  killPrewarm(task, machineName);
  recordPlace(task, machineName, { worktreePath: wt });

  store.addLog(task, 'worktree', `deleting the worktree ${wt} on ${machineName} to free disk`);
  await removeWorktree(machine, wt, { onLine: (l) => store.addLog(task, 'worktree', l) });

  // The evidence sits next to the worktree of the machine that recorded it.
  if (task.qa?.dir && (task.qa.machine ?? task.machine) === machineName) {
    await machine.fs.rm(task.qa.dir, { retries: 3 }).catch((e) => store.addLog(task, 'qa', `⚠️ could not delete the evidence: ${e.message}`));
    // The carry cites files under `dir`, which just got deleted.
    task.qa = { ...task.qa, dir: null, evidence: [], videos: {}, carry: null };
  }
  task.places[machineName].worktreePath = null;
  if (active) task.worktreePath = null;
  store.addLog(task, 'worktree', `worktree on ${machineName} deleted; the branch and the sessions are kept`);
  store.touch(task);
}
