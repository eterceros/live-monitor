import { machines, machineFor, ensureHome } from './machine.js';
import { listProjects, projectOf, machineOptionsOf } from './projects.js';
import { config, configEvents } from './config.js';
import { runnerEvents, runnerHealth } from './runner-client.js';
import {
  ensureCheckout, checkoutStatus, checkoutHooks, backgroundEligible, projectRepo, CheckoutError,
} from './checkout.js';
import { startPrepare, dependenciesMissing } from './prepare.js';

/**
 * Background cloning: gets each project onto every runner that hosts it by
 * convention before a chat or a task needs it there.
 *
 * This only decides *what* to clone and *when*. The clone itself is
 * `ensureCheckout` (or `startPrepare` where installing dependencies was
 * accepted), so it shares the job and the per-machine queue with everything
 * else. A checkout folder that is already there is left alone: not even
 * fetched, since a fetch job would hold back a board upgrade.
 *
 * Jobs live in memory, so after a board restart an accepted install is still
 * owed when the checkout has a lockfile and no `node_modules`.
 *
 * A failed clone is tried again when its runner becomes reachable, when a sweep
 * is asked for (an import) or by hand; never by the timer, except one that only
 * failed because the board was updating.
 */

export const bgCloneHooks = {
  /** How often runners that are down, or still owed a sweep, are looked at again. */
  intervalMs: 5 * 60_000,
};

/** Runners whose last look at every project got through with nothing put off. */
const swept = new Set();

const unfinished = (job) => job.status === 'queued' || job.status === 'running';
const runnerNames = () => Object.entries(machines()).filter(([, m]) => m.kind === 'runner').map(([name]) => name);
const complain = (what, e) => console.error(`[bgclone] ${what}: ${e.message}`);

/** Starts the job and does not wait for it; how it ends is read from its status. */
function launch(machine, project) {
  if (machineOptionsOf(project, machine).install === 'yes') {
    startPrepare(machine, project).catch((e) => {
      // Refused before there was a job (409: the board started updating): owed.
      if (e.status === 409) swept.delete(machine);
      else complain(`${project} on ${machine}`, e);
    });
    return;
  }
  // The job records its own failure.
  ensureCheckout(machine, project).catch(() => {});
}

/** Whether this pair is to be started now, leaving aside what is on the runner's disk. */
function wanted(machine, project, retryFailed) {
  if (!backgroundEligible(machine, project).eligible) return false;
  const job = checkoutStatus(machine, project);
  if (unfinished(job)) return false;
  return retryFailed || job.status !== 'failed' || job.code === 'upgrading';
}

/**
 * Whether a checkout that is already there still waits for its accepted
 * install: the board's update put it off, or a restart forgot the job.
 */
async function installOwed(name, project, machine) {
  if (machineOptionsOf(project, name).install !== 'yes') return false;
  const job = checkoutStatus(name, project);
  if (job.code === 'upgrading') return true;
  return job.status === 'idle' && dependenciesMissing(machine);
}

async function sweepRunner(name, projects, { retryFailed, complete }) {
  const started = [];
  let putOff = false;
  try {
    if (checkoutHooks.holdsNewWork()) {
      swept.delete(name);
      return started;
    }
    await ensureHome(name);
    for (const project of projects) {
      if (!wanted(name, project, retryFailed)) continue;
      const base = machines()[name];
      const machine = machineFor(name, project);
      const present = await base.fs.exists(machine.repoPath);
      if (present && !await installOwed(name, project, machine)) continue;
      // All of this may have changed while the runner was being asked.
      if (checkoutHooks.holdsNewWork()) {
        putOff = true;
        break;
      }
      if (!wanted(name, project, retryFailed)) continue;
      launch(name, project);
      started.push({ machine: name, project });
    }
  } catch (e) {
    putOff = true;
    // An unreachable runner is expected, and already reported by the client.
    if (e.code !== 'runner_unreachable' && e.code !== 'RUNNER_OFFLINE') complain(`sweep of ${name}`, e);
  }
  if (putOff) swept.delete(name);
  else if (complete) swept.add(name);
  return started;
}

/**
 * Starts the missing clones. Resolves once they are started, not finished, and
 * never rejects.
 *
 * @param {string} [machine] only this runner; every runner when omitted.
 * @param {string} [project] only this project; every project when omitted.
 * @param {{retryFailed?: boolean}} [options] false leaves failed clones alone,
 *   other than those the board's own update put off.
 * @returns {Promise<{machine: string, project: string}[]>} what was started.
 */
export async function sweep(machine, project, { retryFailed = true } = {}) {
  try {
    const names = runnerNames().filter((name) => !machine || name === machine);
    const projects = project ? [project] : listProjects().map((p) => p.id);
    const results = await Promise.all(names.map((name) => sweepRunner(name, projects, { retryFailed, complete: !project })));
    return results.flat();
  } catch (e) {
    complain('sweep', e);
    return [];
  }
}

/** Asks a runner for `/info` (which is also what notices it is back), then sweeps it. */
async function probeAndSweep(name, { retryFailed }) {
  try {
    await machines()[name]?.info();
  } catch {
    swept.delete(name);
    return;
  }
  await sweep(name, undefined, { retryFailed });
}

const owesUpgradeRetry = (name) => listProjects()
  .some((p) => checkoutStatus(name, p.id).code === 'upgrading' && backgroundEligible(name, p.id).eligible);

/**
 * One turn of the fallback timer, for a board with no browser open: nothing
 * else would notice a runner coming back. Never rejects.
 */
export async function retryTick() {
  try {
    const due = runnerNames().filter((name) => !swept.has(name)
      || runnerHealth(name)?.online === false || owesUpgradeRetry(name));
    await Promise.all(due.map((name) => probeAndSweep(name, { retryFailed: false })));
  } catch (e) {
    complain('retry', e);
  }
}

/** Each runner's config as last seen, to tell a new or edited one after a reload. */
let specs = new Map();
const currentSpecs = () => new Map(runnerNames().map((name) => [name, JSON.stringify(config.machines?.[name])]));

const onReachable = ({ machine }) => { void sweep(machine); };

async function onConfigChange() {
  try {
    const before = specs;
    specs = currentSpecs();
    for (const name of [...swept]) if (!specs.has(name)) swept.delete(name);
    await Promise.all([...specs].map(async ([name, spec]) => {
      const changed = before.get(name) !== spec;
      // A reload that rebuilds the runners also forgets their `home`.
      if (!changed && machines()[name].home) return;
      swept.delete(name);
      // A new runner has no health yet, but a removed and re-added one does:
      // `reachable` alone would miss it.
      await probeAndSweep(name, { retryFailed: changed });
    }));
  } catch (e) {
    complain('config change', e);
  }
}

let timer = null;

/**
 * Starts reacting to runners that appear, to config reloads and to the fallback
 * timer. Call it before the first `info()` of each runner, whose answer is what
 * triggers the first sweep. Calling it again does nothing.
 */
export function startBgClone() {
  if (timer) return;
  specs = currentSpecs();
  runnerEvents.on('reachable', onReachable);
  configEvents.on('change', onConfigChange);
  timer = setInterval(() => { void retryTick(); }, bgCloneHooks.intervalMs);
  timer.unref?.();
}

export function stopBgClone() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  runnerEvents.off('reachable', onReachable);
  configEvents.off('change', onConfigChange);
}

/** For tests: stop, and forget which runners were swept. */
export function resetBgClone() {
  stopBgClone();
  swept.clear();
  specs = new Map();
}

function requireKnown(projectId, machineName) {
  if (!projectOf(projectId)) throw new CheckoutError(`There is no project "${projectId}"`, 'unknown_project', 404);
  if (machineName !== undefined && !Object.hasOwn(machines(), machineName)) {
    throw new CheckoutError(`There is no machine "${machineName}" in config.machines`, 'unknown_machine', 404);
  }
}

async function rowOf(projectId, name) {
  const local = machines()[name].kind === 'local';
  // A runner known to be down is not asked: the answer would only be a wait.
  const reachable = local || runnerHealth(name)?.online !== false;
  if (!local && reachable) await ensureHome(name).catch(() => {});

  let present = null;
  let nodeModules = false;
  if (reachable) {
    try {
      const machine = machineFor(name, projectId);
      present = await machine.fs.exists(machine.repoPath);
      if (local) nodeModules = await machine.fs.exists(machine.path.join(machine.repoPath, 'node_modules'));
    } catch { /* no path there, or it stopped answering: unknown */ }
  }

  const { eligible, reason } = backgroundEligible(name, projectId);
  const { autoClone, install } = machineOptionsOf(projectId, name);
  const job = checkoutStatus(name, projectId);
  return {
    machine: name,
    kind: local ? 'local' : 'runner',
    eligible,
    reason,
    autoClone,
    present,
    job: { status: job.status, step: job.step, error: job.error, code: job.code ?? null },
    install,
    ...(local ? { nodeModules } : {}),
  };
}

/**
 * One project on one machine, as the API shows it. `present` is null when it
 * cannot be known (no path there, or the runner does not answer).
 *
 * @throws {CheckoutError} 404 on an unknown project or machine.
 */
export async function machineRow(projectId, machineName) {
  requireKnown(projectId, machineName);
  return rowOf(projectId, machineName);
}

/**
 * One row per configured machine, the board's own included.
 *
 * @throws {CheckoutError} 404 on an unknown project.
 */
export async function machineRows(projectId) {
  requireKnown(projectId);
  return Promise.all(Object.keys(machines()).map((name) => rowOf(projectId, name)));
}

/**
 * The retry asked for by hand, which also works on an excluded runner. A path
 * written in the config is still only checked, unless installing was accepted.
 *
 * @returns {Promise<object>} the job's state right after starting.
 * @throws {CheckoutError|import('./prepare.js').PrepareError} with the HTTP `status` it deserves.
 */
export async function retryClone(machineName, projectId) {
  requireKnown(projectId, machineName);
  if (machines()[machineName].kind === 'local') {
    throw new CheckoutError(`${machineName} is this board's own machine: there is nothing to clone`, 'local', 400);
  }
  if (!projectRepo(projectId)) {
    throw new CheckoutError(`The project "${projectId}" has no GitHub repository (owner/name) to clone`, 'no_repo', 400);
  }
  if (machineOptionsOf(projectId, machineName).install === 'yes') return startPrepare(machineName, projectId);
  if (!unfinished(checkoutStatus(machineName, projectId)) && checkoutHooks.holdsNewWork()) {
    throw new CheckoutError('The board is updating: retry when the update has finished', 'upgrading', 409);
  }
  // The job is registered before the promise comes back.
  ensureCheckout(machineName, projectId).catch(() => {});
  return checkoutStatus(machineName, projectId);
}
