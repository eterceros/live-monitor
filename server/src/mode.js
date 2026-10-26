/**
 * Who drives a task: the board or you.
 *
 * This used to be told twice — a `manual` boolean and a `'manual'` flow state —
 * and every bug came from the two disagreeing. Marking a task manual *started*
 * it (worktree and a full triage) before parking; the switch was read once, so
 * flipping it mid-flight changed nothing; and the state was terminal, with the
 * switch as the only way out of it.
 *
 * Now there is one field and one rule: **the board only starts work on a task
 * whose mode is `auto`**. The mode says nothing about what you can do by hand —
 * the chat, the worktree button and the servers work in every mode.
 *
 * Kept free of every other module of the board on purpose: these are the
 * decisions worth testing, and `pipeline.js` drags in the whole machine.
 *
 * One exception, and it is worth stating: `usage-limit.js`, whose only content
 * is the SDK's list of usage-limit prefixes and a check against it. The
 * migration below has to recognise a limit notice that was saved as demo
 * steps, and copying those strings here is exactly how a new prefix would be
 * missed. So this file does load the SDK — indirectly, through a module that
 * imports nothing else. What it still does not load is any state of the board.
 */

import { normalizePhase } from './phases.js';
import { looksLikeUsageLimit } from './usage-limit.js';
import { closeOrphans, migrateCycles } from './metrics.js';

export const MODES = ['auto', 'unconfirmed', 'manual'];

/** Modes a client may ask for. `unconfirmed` is only ever set by detection. */
export const SETTABLE_MODES = ['auto', 'manual'];

export const modeOf = (task) => task?.mode ?? 'auto';

/** The single gate: nothing starts on its own unless the task is automatic. */
export const canAutoStart = (task) => modeOf(task) === 'auto';

const MANUAL_KEYWORD = /\bmanual/i;

/**
 * Where the word "manual" shows up in a GitHub issue, and the phrase it showed
 * up in — the quote is what makes the question answerable at a glance. Prefix
 * matching is deliberate: "manualmente" counts, "semimanual" does not.
 */
export function findManualKeyword(issue) {
  const hit = (text, where) => {
    const m = MANUAL_KEYWORD.exec(text ?? '');
    if (!m) return null;
    const from = Math.max(0, m.index - 45);
    const quote = (text ?? '').slice(from, m.index + 45).replace(/\s+/g, ' ').trim();
    return { where, quote: `${from > 0 ? '…' : ''}${quote}${m.index + 45 < text.length ? '…' : ''}` };
  };

  const label = (issue?.labels ?? []).find((l) => MANUAL_KEYWORD.test(l));
  return hit(issue?.title, 'título')
    ?? (label ? { where: 'etiqueta', quote: label } : null)
    ?? hit(issue?.body, 'cuerpo');
}

/**
 * Whether the keyword may still raise the question for this task.
 *
 * Detection proposes; it never decides, and it never interrupts. It only speaks
 * about work the board has not begun: a task already branched, already in
 * flight or already carrying a PR is past the point where the question means
 * anything, and stopping it there would strand real work.
 */
export function shouldAskAboutMode(task, issue, { running = false } = {}) {
  if (!task || modeOf(task) !== 'auto') return false;   // already decided or already asking
  if (task.modeDecidedByUser) return false;             // your call is not up for debate
  if (issue?.closed || task.issueClosed) return false;
  if (running || task.state !== 'assigned') return false;
  // A task back in the queue for a second cycle — reopened, or with PRs from
  // an earlier one — has had its mode settled long ago: the word in the issue
  // was there the first time too.
  if (task.reopenedAt || task.prs?.length) return false;
  return !task.branch && !task.prNumber;
}

/**
 * Whether `task.forced` still means something. It is the say-so to start
 * despite the work found on GitHub, and it only speaks for the run it was
 * given for: once that run is over the task is classified again like any
 * other. Left on, it froze the classification for ever (#787 sat in
 * `pr_draft` over a merged PR because of it).
 *
 * Three places where the run it speaks for has not happened yet: `assigned`
 * (queued, or reopened and waiting for auto-start), `error` (a Retry resumes
 * that very run, and must not be stopped by the guard it was allowed past),
 * and a click parked on the account's quota, which rests on `started` until
 * the window reopens.
 */
export function keepsForced(task) {
  // One exception to all three: a reopened issue that was closed again before
  // its new cycle ran. The reopen was the say-so; with the issue closed, it
  // no longer speaks, and the task goes back to what GitHub shows.
  if (task?.reopenedAt && task?.issueClosed) return false;
  return task?.state === 'assigned' || task?.state === 'error' || Boolean(task?.quotaPark);
}

const PR_STATES = ['DRAFT', 'OPEN', 'MERGED', 'CLOSED'];

/**
 * The one order every PR list of a task is kept in: newest first. PR numbers
 * are handed out at creation and only grow, so the number orders them exactly
 * as `createdAt` would — and it is the one field every source (the branch
 * listing, the issue's links, `gh pr create`) always carries. Here, and not in
 * `pipeline.js`, because this file must stay importable on its own.
 */
export const newestFirst = (a, b) => b.number - a.number;

/**
 * Where a task goes when it becomes automatic again. `started` is the queue's
 * doorstep — it has a branch and nothing running — so it goes back to
 * `assigned` and the gate picks it up. A task with an open PR is left alone:
 * re-running the flow over it would fight with the review it is waiting for.
 */
export function resumeStateFor(task) {
  return ['started', 'assigned'].includes(task?.state) ? 'assigned' : null;
}

/**
 * Brings a stored task up to the current shape. Runs on every boot, so it must
 * be idempotent — and it must survive tasks written before any of these fields
 * existed, where `manual` is plain `undefined`.
 */
export function migrateTask(task) {
  if (!MODES.includes(task.mode)) task.mode = task.manual === true ? 'manual' : 'auto';
  if (task.modeDecidedByUser === undefined) task.modeDecidedByUser = task.manualOverride === true;
  if (task.bodyCheckedForMode === undefined) task.bodyCheckedForMode = task.manualChecked === true;
  if (task.suspect === undefined) task.suspect = null;

  // `'manual'` was a state as well as a flag. The flag survives as the mode;
  // the card goes back to the flow state its work actually justifies.
  if (task.state === 'manual') {
    task.mode = 'manual';
    task.state = task.branch ? 'started' : 'assigned';
  }

  // A branch whose tests passed had a fix: seed the new gate from the old
  // evidence so a retry does not redo work that already landed.
  if (task.fixedAt === undefined) task.fixedAt = task.e2ePassedAt ?? null;

  // Where the run was when it stopped. `pr_draft` was a state before it was a
  // phase, and anything this vocabulary does not know names nothing.
  task.phase = normalizePhase(task.phase);
  if (task.prPark === undefined) task.prPark = null;
  if (task.prTitle === undefined) task.prTitle = null;

  // Every PR the task has had, newest first, and when the issue was last seen
  // reopened. Seeded from what the last classification recorded; a PR whose
  // state was never recorded is left out rather than guessed — the next poll
  // fills the list from GitHub anyway. PR numbers grow with creation time, so
  // sorting by number is sorting by age.
  if (!Array.isArray(task.prs)) {
    const seen = new Map();
    for (const pr of task.existingWork?.prs ?? []) {
      if (pr?.number && PR_STATES.includes(pr.state) && !seen.has(pr.number)) {
        seen.set(pr.number, {
          number: pr.number, url: pr.url ?? null, title: pr.title ?? '', state: pr.state,
          createdAt: pr.createdAt ?? null, mergedAt: pr.mergedAt ?? null, closedAt: pr.closedAt ?? null,
        });
      }
    }
    task.prs = [...seen.values()].sort(newestFirst);
  }
  if (task.reopenedAt === undefined) task.reopenedAt = null;
  // When the current cycle began, if it is not the first: PRs finished before
  // it are history and must not classify the task as done (see `classifyPrs`).
  if (task.cycleStartedAt === undefined) task.cycleStartedAt = null;

  // Every task from before ran on the machine hosting the board.
  if (!task.machine) task.machine = 'local';

  // Browser QA arrived later: earlier tasks follow triage like new ones do.
  if (!['auto', 'on', 'off'].includes(task.browserQa)) task.browserQa = 'auto';
  if (task.qa === undefined) task.qa = null;
  if (task.qaBusy === undefined) task.qaBusy = false;

  // Demo became `auto`/`on`/`off`: once, every stored value goes to `auto`.
  if (task.demoMigrated !== true) { task.demo = 'auto'; task.demoMigrated = true; }
  if (!['auto', 'on', 'off'].includes(task.demo)) task.demo = 'auto';
  // The PR body an agent writes. A body left over from a run that never
  // opened its PR is still this cycle's, so it is kept, not cleared.
  if (task.prBody === undefined) task.prBody = null;

  // Plan approval before the fix: new tasks are born `on`/`off` with the
  // project's value; `auto` (older tasks) follows the setting live.
  if (!['auto', 'on', 'off'].includes(task.approvePlan)) task.approvePlan = 'auto';
  // Same for the close-the-gaps round after the fix.
  if (!['auto', 'on', 'off'].includes(task.fixGaps)) task.fixGaps = 'auto';
  // Full suite in the test phase: older tasks never had it, so they stay scoped.
  if (!['auto', 'on', 'off'].includes(task.fullTests)) task.fullTests = 'off';
  // Resolving conflicts on its own arrived later: older tasks follow the project.
  if (!['auto', 'on', 'off'].includes(task.resolveConflicts)) task.resolveConflicts = 'auto';
  if (task.conflictRun === undefined) task.conflictRun = null;
  // Design mark: a person's switch, off unless it is exactly true.
  if (task.design !== true) task.design = false;
  // A question a pipeline session asked, or a plan waiting for approval.
  // Nothing can answer it after a restart: the session is gone.
  task.pending = null;
  // What the repair rounds already tried, so the next one does not repeat it.
  if (!Array.isArray(task.fixAttempts)) task.fixAttempts = [];
  // Timings: old tasks have none. A span left open by a dead process closes at
  // the task's last update, not now, so it does not swallow the time the board was off.
  if (!Array.isArray(task.timings)) task.timings = [];
  // Sessions the parallelism nudge already asked once; old tasks have none.
  if (!Array.isArray(task.nudged)) task.nudged = [];
  closeOrphans(task, task.updatedAt);
  // Old spans carry the cycle as an ISO start or null; number them once.
  migrateCycles(task);
  // A plan the board was running is stopped by a restart; Reintentar continues it.
  if (task.workPlan?.tasks && task.workPlan.status) {
    for (const t of task.workPlan.tasks) {
      if (['running', 'checking', 'asking'].includes(t.status)) t.status = 'stopped';
    }
    if (['running', 'asking'].includes(task.workPlan.status)) task.workPlan.status = 'stopped';
  }
  // A task parked on plan approval whose plan is gone goes back to the queue.
  if (task.state === 'plan_ready' && !task.workPlan) task.state = 'assigned';

  // Moving between machines. `places` is every machine the task has lived on,
  // with the sessions it left there; `moving` a move in flight or failed;
  // `prewarm` the build started on arrival.
  if (!task.places || typeof task.places !== 'object') task.places = {};
  if (task.moving === undefined) task.moving = null;
  if (task.prewarm === undefined) task.prewarm = null;
  // Evidence from before this field was written was made where the task runs.
  if (task.qa?.dir && !task.qa.machine) task.qa.machine = task.machine;

  // Waiting for the account's quota to come back. Nothing in memory survives a
  // restart, so the marker is read from `quota.json` and the tasks are
  // relaunched from there; the field itself only has to exist.
  if (task.quotaPark === undefined) task.quotaPark = null;

  // Demo steps that are the usage-limit notice itself. They were written
  // because nothing checked the result of the turn that produced them, and
  // they sit in the panel as instructions nobody can follow. There is at least
  // one on disk; this is the line that cleans it.
  if (looksLikeUsageLimit(task.demoSteps)) task.demoSteps = null;

  // Last, once the state is final (`manual` and `plan_ready` above may move
  // it): a leftover `forced` froze the classification for good (#787).
  if (task.forced && !keepsForced(task)) task.forced = false;

  delete task.manual;
  delete task.manualOverride;
  delete task.manualChecked;
  return task;
}
