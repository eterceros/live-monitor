import { machines, machineFor, ensureHome } from './machine.js';
import { projectOf, baseBranchOf } from './projects.js';
import { config } from './config.js';
import { DEFAULT_PROJECT_ID } from './keys.js';
import { parseGitHubRemote, detectRepo } from './repo-identity.js';
import { classifyRepoState } from './worktree.js';

/**
 * "The checkout of this project is on this machine": the one step that runs
 * before anything cuts a worktree on a runner.
 *
 * One job per project and machine: a second request for the same project joins
 * the job in flight (and its log). Clones and installs go through one queue per
 * machine, one at a time; looking at a checkout that is already there does not,
 * so a usable one never waits for another project. A missing checkout is cloned
 * with the runner's own `gh` credentials (no token ever leaves the board) into a
 * reserved sibling directory, checked there, and only then renamed into place.
 * Whatever already sits at the final path is never deleted or overwritten: it is checked, and
 * what is wrong with it is reported.
 *
 * On the board's own machine this does nothing.
 *
 * Keep this module a leaf: `pipeline.js` imports it, so it must not import
 * `pipeline.js` or `upgrade.js` (the upgrade guard comes in as a hook).
 */

/** A refusal or failure of the checkout step; `code` says which. */
export class CheckoutError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'CheckoutError';
    this.code = code;
    this.status = status;
  }
}

export const checkoutHooks = {
  cloneTimeoutMs: 15 * 60_000,
  fetchTimeoutMs: 10 * 60_000,
  probeTimeoutMs: 30_000,
  /** True while a board upgrade is pending or running: nothing new is cloned or installed. */
  holdsNewWork: () => false,
  /** Swappable by tests whose origins are not GitHub URLs. */
  readiness: checkoutReadiness,
};

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const KEEP_LINES = 30;

/** git/gh words for "these credentials cannot read that repository". */
const NO_ACCESS_RE = /could not resolve to a repository|repository not found|not logged in|gh auth login|authentication failed|permission denied \(publickey\)|could not read (username|password)|terminal prompts disabled|HTTP 40[134]|correct access rights|write access to repository not granted/i;

/** `${machine}\n${project}` -> the last (or current) job. */
const jobs = new Map();
/** machine -> promise that settles when its last queued clone or install does. */
const queues = new Map();

const keyOf = (machine, project) => `${machine}\n${project}`;
const tail = (r) => String(r?.stderr || r?.stdout || '').trim().split('\n').slice(-3).join(' | ');

/**
 * The GitHub `owner/name` of a project, or null. A project may leave it unset
 * and have it read from the `origin` of the board's own checkout, as
 * `github.js` does.
 */
export function projectRepo(projectId) {
  const project = projectOf(projectId);
  const declared = typeof project?.repo === 'string' ? project.repo.trim() : '';
  if (declared) return REPO_RE.test(declared) ? declared : null;
  if (projectId === DEFAULT_PROJECT_ID) return config.github.repo ?? detectRepo(config.project.repoPath);
  return detectRepo(project?.repoPath);
}

/** `owner/name` of an origin URL, also with a login in HTTPS or in `ssh://` form. */
function originRepo(url) {
  return parseGitHubRemote(String(url ?? '').trim()
    .replace(/^https:\/\/[^@/]+@/, 'https://')
    .replace(/^ssh:\/\/git@github\.com(?::22)?\//, 'git@github.com:'));
}

function noAccess(repo, machineName, detail) {
  return new CheckoutError(
    `Runner "${machineName}" cannot read the GitHub repository ${repo}. `
    + `On ${machineName}, run \`gh auth login\` (then \`gh auth setup-git\`) with an account that can read ${repo}, and retry. (${detail})`,
    'no_access',
  );
}

/**
 * Is the checkout at `repoPath` (default `machine.repoPath`) usable for `repo`?
 * In order: it is a git checkout, its `origin` is `repo`, a fetch works and
 * `origin/<baseBranch>` resolves. Changes nothing but remote-tracking refs.
 *
 * @returns {Promise<{ready: true} | {ready: false, code: string, reason: string, error: Error}>}
 *   `code`: `missing` (nothing at the path), `incomplete`, `no_repo`,
 *   `no_remote`, `wrong_origin`, `no_access`, `fetch_failed`, `empty_repo`,
 *   `remote_empty`, `base_missing`. `error` is what to throw (a
 *   `RepoStateError` for the repository states).
 * @throws if the runner cannot be reached.
 */
export async function checkoutReadiness(machine, {
  repo, baseBranch = 'main', repoPath = machine.repoPath, onLine, fetchTimeoutMs = checkoutHooks.fetchTimeoutMs,
} = {}) {
  const where = `${repoPath} on ${machine.name}`;
  const not = (code, reason, error = new CheckoutError(reason, code)) => ({ ready: false, code, reason, error });
  const git = (args, timeoutMs = checkoutHooks.probeTimeoutMs, extra = {}) => machine.exec('git', ['-C', repoPath, ...args], { timeoutMs, ...extra });

  if (!repo) return not('no_repo', 'the project has no GitHub repository (owner/name) set: set it in the project settings');
  if (!await machine.fs.exists(repoPath)) return not('missing', `there is no checkout at ${where}`);
  const incomplete = () => not('incomplete',
    `${where} exists but is not a complete git checkout (an interrupted clone, or something else): it was left untouched. Move it away or fix it, then retry.`);
  if (!await machine.fs.exists(machine.path.join(repoPath, '.git'))) return incomplete();
  // A non-empty `--show-cdup` means git skipped a broken `.git` and found a parent repository.
  const top = await git(['rev-parse', '--show-cdup']);
  if (!top.ok || top.stdout.trim()) return incomplete();

  // Every git call below runs inside `repoPath`.
  const view = { repoPath, exec: (...args) => machine.exec(...args) };
  const state = async () => classifyRepoState(view, baseBranch);

  const origin = await git(['remote', 'get-url', 'origin']);
  if (!origin.ok) {
    const error = await state();
    if (error?.code === 'no_remote') return not(error.code, error.message, error);
    return not('no_remote', `the checkout at ${where} has no origin remote: ${tail(origin)}`);
  }
  const found = originRepo(origin.stdout);
  if (!found || found.toLowerCase() !== repo.toLowerCase()) {
    return not('wrong_origin', `the checkout at ${where} has origin ${found ?? (origin.stdout.trim() || '(none)')}, not ${repo}: it was left untouched`);
  }

  const fetched = await git(['fetch', '--prune', 'origin'], fetchTimeoutMs, { onLine });
  if (!fetched.ok) {
    if (NO_ACCESS_RE.test(tail(fetched))) {
      const error = noAccess(repo, machine.name, tail(fetched));
      return not(error.code, error.message, error);
    }
    return not('fetch_failed', `git fetch failed in ${where} (exit ${fetched.code}): ${tail(fetched)}`);
  }

  const base = await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${baseBranch}`]);
  if (!base.ok) {
    const error = await state();
    if (error) return not(error.code, error.message, error);
    return not('base_missing', `origin/${baseBranch} does not resolve in ${where}: check the project's base branch`);
  }
  return { ready: true };
}

const view = (job) => ({ status: job.status, step: job.step, lines: [...job.lines], error: job.error });

/** The last (or current) job of this project on this machine. `status`: idle, queued, running, done, failed. */
export function checkoutStatus(machineName, projectId) {
  const job = jobs.get(keyOf(machineName, projectId));
  return job ? view(job) : { status: 'idle', step: null, lines: [], error: null };
}

const unfinished = (job) => job.status === 'queued' || job.status === 'running';

/** Every job running or waiting its turn. */
export function checkoutsBusy() {
  return [...jobs.values()].filter(unfinished)
    .map((j) => ({ machine: j.machine, project: j.project, repo: j.repo, status: j.status, step: j.step }));
}

function push(job, line) {
  const text = String(line).slice(0, 400);
  job.lines.push(text);
  if (job.lines.length > KEEP_LINES) job.lines.splice(0, job.lines.length - KEEP_LINES);
  for (const listener of job.listeners) deliver(listener, text);
}

function deliver(listener, line) {
  // A caller's log that fails must not fail everybody's clone.
  try { listener(line); } catch (e) { console.error(`[checkout] log listener failed: ${e.message}`); }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  promise.catch(() => {});   // nobody has to be waiting on it
  return { promise, resolve, reject };
}

/**
 * Makes sure the checkout of a project is on a machine, cloning it if missing.
 * Does not create the worktree root. The job is registered before this returns
 * its promise, so {@link checkoutStatus} sees it at once.
 *
 * A checkout is cloned only where the runner's `projectsRoot` convention put
 * it. A path written in the config (`machines.<name>.projects.<id>`, and the
 * default project's own) is only checked, unless `install` is given: that is
 * the explicit Prepare action.
 *
 * @param {string} machineName
 * @param {string} projectId
 * @param {object} [options]
 * @param {(line: string) => void} [options.onLine] progress, including what the job already said.
 * @param {(machine, tools: {push: Function, setStep: Function}) => Promise<void>} [options.install]
 *   runs on the queue once the checkout is ready. Only the callers that pass one
 *   wait for it (and see it fail); the others are answered at "ready".
 * @returns {Promise<{cloned: boolean, warnings: string[]}>}
 */
export async function ensureCheckout(machineName, projectId, { onLine, install } = {}) {
  const base = machines()[machineName];
  if (!base) throw new CheckoutError(`There is no machine "${machineName}" in config.machines`, 'unknown_machine', 404);
  if (base.kind === 'local') return { cloned: false, warnings: [] };
  if (!projectOf(projectId)) throw new CheckoutError(`There is no project "${projectId}"`, 'unknown_project', 404);
  const repo = projectRepo(projectId);
  if (!repo) {
    throw new CheckoutError(
      `The project "${projectId}" has no GitHub repository (owner/name) to clone on ${machineName}: `
      + 'set its repo in the project settings, or give its checkout on the board a GitHub origin',
      'no_repo',
    );
  }

  const key = keyOf(machineName, projectId);
  let job = jobs.get(key);
  const fresh = !job || !unfinished(job);
  if (fresh) {
    job = {
      machine: machineName, project: projectId, repo,
      status: 'running', step: 'clone', lines: [], error: null,
      listeners: new Set(), install: null, ready: deferred(), done: deferred(),
    };
    jobs.set(key, job);
  }
  if (install) job.install ??= install;

  if (onLine) {
    for (const line of job.lines) deliver(onLine, line);
    job.listeners.add(onLine);
  }
  if (fresh) void runJob(job);
  try {
    return await (install ? job.done : job.ready).promise;
  } finally {
    job.listeners.delete(onLine);
  }
}

/** Runs `work` once the clones and installs queued before it on the job's machine are done. */
async function inMachineTurn(job, work) {
  const previous = queues.get(job.machine);
  if (previous) {
    job.status = 'queued';
    job.step = 'queued';
    push(job, `waiting for another checkout on ${job.machine} to finish`);
  }
  let release;
  const mine = new Promise((resolve) => { release = resolve; });
  const turn = (previous ?? Promise.resolve()).then(() => mine);
  queues.set(job.machine, turn);
  try {
    await previous;
    job.status = 'running';
    return await work();
  } finally {
    release();
    if (queues.get(job.machine) === turn) queues.delete(job.machine);
  }
}

/** Never rejects: the outcome goes to the job. */
async function runJob(job) {
  try {
    const { machine, result } = await bringCheckout(job);
    job.ready.resolve(result);
    // Read only now: a caller that wants an install may have joined meanwhile.
    if (job.install) {
      await inMachineTurn(job, async () => {
        assertNotUpgrading();
        await job.install(machine, {
          push: (line) => push(job, line),
          setStep: (step) => { job.step = step; },
        });
      });
    }
    // No `await` between reading `job.install` and this, or between the install's turn and this.
    job.status = 'done';
    job.step = null;
    job.done.resolve(result);
  } catch (raw) {
    const e = raw?.code === 'RUNNER_OFFLINE'
      ? new CheckoutError(`Runner "${job.machine}" is unreachable: ${raw.message}`, 'runner_unreachable', 502)
      : raw;
    job.status = 'failed';
    job.error = e.message;
    job.ready.reject(e);   // a no-op when only the install failed
    job.done.reject(e);
  }
}

function assertNotUpgrading() {
  if (checkoutHooks.holdsNewWork()) {
    throw new CheckoutError('The board is updating: retry when the update has finished', 'upgrading', 409);
  }
}

/** True for a path the `projectsRoot` convention chose, which is the only kind cloned unasked. */
function isConventionPath(machineName, projectId) {
  if (projectId === DEFAULT_PROJECT_ID) return false;
  const explicit = config.machines?.[machineName]?.projects?.[projectId];
  return !(explicit?.repoPath && explicit?.worktreeRoot);
}

async function bringCheckout(job) {
  await ensureHome(job.machine);
  const machine = machineFor(job.machine, job.project);
  const { repoPath } = machine;
  const options = { repo: job.repo, baseBranch: baseBranchOf(job.project), onLine: (line) => push(job, line) };
  const check = async () => {
    const state = await checkoutHooks.readiness(machine, options);
    if (!state.ready) throw state.error;
  };

  let cloned = false;
  // Outside the queue: looking at what is there never waits for another project.
  if (await machine.fs.exists(repoPath)) {
    await check();
  } else {
    if (!job.install && !isConventionPath(job.machine, job.project)) {
      throw new CheckoutError(
        `There is no checkout at ${repoPath} on ${job.machine}. That path is set in the board's config, so it is not cloned automatically: `
        + `clone ${job.repo} there (or use Prepare) and retry.`,
        'missing',
      );
    }
    cloned = await inMachineTurn(job, async () => {
      job.step = 'clone';
      // Looked at again: it may have appeared while this waited.
      if (await machine.fs.exists(repoPath)) {
        await check();
        return false;
      }
      assertNotUpgrading();
      await clone(job, machine, options);
      return true;
    });
  }
  return { machine, result: { cloned, warnings: await pushWarnings(job, machine) } };
}

async function clone(job, machine, options) {
  const { repoPath, path } = machine;
  const parent = path.dirname(repoPath);
  // A name only this step creates, so a leftover of an interrupted run is ours to remove.
  const temp = path.join(parent, `.${path.basename(repoPath)}.hfsmon-clone`);
  await machine.fs.mkdir(parent);
  await machine.fs.rm(temp);
  try {
    push(job, `cloning ${job.repo} into ${repoPath} on ${job.machine}`);
    const r = await machine.exec('gh', ['repo', 'clone', job.repo, temp], {
      onLine: options.onLine, timeoutMs: checkoutHooks.cloneTimeoutMs,
    });
    if (!r.ok) {
      const detail = tail(r);
      if (/spawn gh ENOENT/.test(detail)) {
        throw new CheckoutError(`The GitHub CLI (gh) is not installed on ${job.machine}: install it, run \`gh auth login\` there, and retry`, 'no_gh');
      }
      if (NO_ACCESS_RE.test(detail)) throw noAccess(job.repo, job.machine, detail);
      throw new CheckoutError(`Cloning ${job.repo} on ${job.machine} failed: gh repo clone exit ${r.code}: ${detail}`, 'clone_failed');
    }
    const state = await checkoutHooks.readiness(machine, { ...options, repoPath: temp });
    if (!state.ready) throw state.error;

    // `-n` and `-T`: never over, nor inside, something that appeared meanwhile.
    // `mv -n` may exit 0 without moving, so the outcome is read from the disk.
    const moved = await machine.exec('mv', ['-T', '-n', temp, repoPath], { timeoutMs: checkoutHooks.probeTimeoutMs });
    if (await machine.fs.exists(temp) || !await machine.fs.exists(path.join(repoPath, '.git'))) {
      throw new CheckoutError(
        `Could not move the new clone into ${repoPath} on ${job.machine} (something else may have appeared there; it was left untouched): ${tail(moved)}`,
        'rename_failed',
      );
    }
    push(job, `cloned ${job.repo} into ${repoPath}`);
  } catch (e) {
    // Best effort: the next attempt removes it anyway.
    await machine.fs.rm(temp).catch(() => {});
    throw e;
  }
}

/** A warning when the runner's account can read but not push. Silent when `gh` cannot tell. */
async function pushWarnings(job, machine) {
  try {
    const r = await machine.exec('gh', ['api', `repos/${job.repo}`, '--jq', '.permissions.push'], { timeoutMs: checkoutHooks.probeTimeoutMs });
    if (r.ok && r.stdout.trim() === 'false') {
      return [`⚠️ The GitHub account on ${job.machine} can read ${job.repo} but not push to it: branches cannot be pushed from ${job.machine}.`];
    }
  } catch { /* only a warning: never a reason to fail */ }
  return [];
}

/** For tests: forget every job and queue. */
export function resetCheckouts() {
  jobs.clear();
  queues.clear();
}
