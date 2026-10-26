/**
 * Which conflicts the board may resolve by itself, and in what order.
 *
 * A task that opened its PR waits for review, and while it waits `main` keeps
 * moving: the branch drifts into a conflict that nobody sees until somebody
 * moves the card. Resolving it is mechanical for a session that knows the
 * change, so the board does it when the task is idle (`pr_draft`, `ready`,
 * `waiting_approval`), verifies the result, runs the tests the conflict
 * touched, and pushes.
 *
 * What stays with a person: a conflict in a file whose merge cannot be judged
 * by reading it (a lockfile, a migration, a schema, generated output), a task
 * marked manual, and a conflict the board already tried to resolve twice
 * against the same `origin/<base>`.
 *
 * Pure: tasks and file names in, a decision out. The pipeline does the git.
 */

import { globToRegExp } from './testscope.js';

/** The states a task rests in while it waits for review: the only ones this may start from. */
export const IDLE_PR_STATES = ['pr_draft', 'ready', 'waiting_approval'];

/** Resolutions at once per project when `limits.maxConflictResolutions` says nothing. */
export const DEFAULT_MAX_PARALLEL = 5;

/** Attempts against the same `origin/<base>` before the board stops and tells you. */
export const DEFAULT_MAX_ATTEMPTS = 2;

/**
 * Files a merge cannot be judged on by reading it: both sides are right in
 * their own way and the result is derived, ordered, or applied to a database.
 */
const UNSAFE_GLOBS = [
  '**/package-lock.json', '**/npm-shrinkwrap.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/bun.lock', '**/bun.lockb',
  '**/Cargo.lock', '**/poetry.lock', '**/Pipfile.lock', '**/Gemfile.lock', '**/composer.lock', '**/go.sum',
  '**/*.lock',
  '**/migrations/**', '**/migrate/**', '**/db/migrate/**', '**/alembic/versions/**', '**/prisma/migrations/**',
  '**/*.generated.*', '**/*.gen.*', '**/generated/**', '**/__generated__/**', '**/*.min.js', '**/*.min.css',
  '**/dist/**', '**/__snapshots__/**', '**/*.snap',
];

const UNSAFE = UNSAFE_GLOBS.map(globToRegExp);

/** The conflicting files a person has to look at, in the order given. */
export const unsafeConflicts = (files) => files.filter((f) => UNSAFE.some((re) => re.test(f)));

/** The number the project allows at once, 5 when absent or not a positive integer. */
export const maxParallelOf = (limits) => {
  const n = Number(limits?.maxConflictResolutions);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_PARALLEL;
};

/** The attempts the project allows per `origin/<base>`, 2 when absent. */
export const maxAttemptsOf = (limits) => {
  const n = Number(limits?.maxConflictAttempts);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_ATTEMPTS;
};

/**
 * What the board does about this task's conflict now.
 *
 * `{ act: 'resolve' }` starts a resolution; `{ act: 'skip', reason, say }`
 * is a conflict it will not touch (`say` is true the first time per
 * `origin/<base>`, so the card is told once and not every poll); `{ act:
 * 'wait' }` is "not now, ask again later" and says nothing.
 *
 * `facts` is what the caller already knows: `{ wanted, canAuto, held, busy,
 * mainSha, files, limits }`.
 */
export function decide(task, facts) {
  if (!IDLE_PR_STATES.includes(task.state)) return { act: 'wait' };
  if (!(task.branchStatus?.conflicts > 0)) return { act: 'wait' };
  if (!facts.wanted) return { act: 'wait' };
  if (facts.held || facts.busy) return { act: 'wait' };

  const run = task.conflictRun ?? null;
  const sameMain = Boolean(run && facts.mainSha && run.mainSha === facts.mainSha);
  const told = sameMain && Boolean(run.said);
  const skip = (reason) => ({ act: 'skip', reason, say: !told });

  if (!facts.canAuto) return skip('the task is manual: resolve it yourself or start it from its card');
  if (facts.dirty) return skip('there is uncommitted work in the worktree that a merge could overwrite');
  if (sameMain && run.attempts >= maxAttemptsOf(facts.limits)) {
    return skip(`already tried ${run.attempts} time(s) against this origin/${task.base ?? 'main'}: ${run.reason ?? 'it did not resolve'}`);
  }
  const unsafe = unsafeConflicts(facts.files ?? []);
  if (unsafe.length) return skip(`the conflict touches files that need a person: ${unsafe.slice(0, 3).join(', ')}`);
  return { act: 'resolve' };
}

/**
 * The tasks to start now, oldest first, so that no project has more than
 * `limit` resolutions in flight. `inFlight` counts what already runs; the rest
 * wait their turn and are picked up by the next call.
 *
 * @param {object[]} candidates tasks `decide` said to resolve, each with `project`
 * @param {Map<string, number>} inFlight resolutions running now, per project
 */
export function pickToStart(candidates, inFlight, limit) {
  const taken = new Map(inFlight);
  const picked = [];
  const oldestFirst = [...candidates].sort((a, b) => String(a.updatedAt ?? '').localeCompare(String(b.updatedAt ?? '')) || a.issue - b.issue);
  for (const task of oldestFirst) {
    const n = taken.get(task.project) ?? 0;
    if (n >= limit) continue;
    taken.set(task.project, n + 1);
    picked.push(task);
  }
  return picked;
}
