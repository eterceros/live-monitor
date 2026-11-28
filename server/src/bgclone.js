import { machines, machineFor, ensureHome } from './machine.js';
import { listProjects, projectOf, machineOptionsOf } from './projects.js';
import { config, configEvents } from './config.js';
import { runnerEvents, runnerHealth } from './runner-client.js';
import {
  ensureCheckout, checkoutStatus, checkoutHooks, backgroundEligible, projectRepo, CheckoutError,
  checkoutWasReady, forgetCheckout, installOutcome,
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
 * An accepted install is owed while none has been attempted in that checkout
 * since the board started (a restart forgets, a skipped one was not attempted)
 * and it has a lockfile and no `node_modules`.
 *
 * What it starts is checked again at its turn in the queue, and once it ends it
 * is started over if the convention has moved the path meanwhile (`stillWanted`).
 *
 * A failed clone is tried again when its runner becomes reachable or its config
 * is edited, when a sweep is asked for (an import, a runner taken back in) or by
 * hand; never by the timer, except one the board's update put off
 * (`retriesAfterUpgrade`).
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

/**
 * What is asked again when a job this started reaches its turn: the project may
 * have been removed or moved, the runner excluded, or the install answer changed.
 */
function stillWantedOf(machine, project, repoPath) {
  const rootOf = () => config.machines?.[machine]?.projectsRoot;
  const root = rootOf();
  const clone = () => {
    const { eligible, reason } = backgroundEligible(machine, project);
    // A runner that stopped answering is left for the clone itself to report,
    // unless its `projectsRoot` was edited: the path is then another one.
    if (!eligible) return reason === 'home_unknown' && rootOf() === root;
    return machineFor(machine, project).repoPath === repoPath;
  };
  // A sweep skips a job still going, so a path that moved under it is swept here.
  const sweepIfMoved = async () => {
    await ensureHome(machine).catch(() => {});
    if (backgroundEligible(machine, project).eligible && machineFor(machine, project).repoPath !== repoPath) {
      await sweep(machine, project);
    }
  };
  return {
    clone,
    install: () => clone() && machineOptionsOf(project, machine).install === 'yes',
    settled: () => { sweepIfMoved().catch((e) => complain(`${project} on ${machine}`, e)); },
  };
}

/** Starts the job and does not wait for it; how it ends is read from its status. */
function launch(machine, project, repoPath) {
  const stillWanted = stillWantedOf(machine, project, repoPath);
  if (machineOptionsOf(project, machine).install === 'yes') {
    startPrepare(machine, project, { stillWanted }).catch((e) => {
      // Refused before there was a job (409: the board started updating): owed.
      if (e.status === 409) swept.delete(machine);
      else complain(`${project} on ${machine}`, e);
    });
    return;
  }
  // The job records its own failure.
  ensureCheckout(machine, project, { stillWanted }).catch(() => {});
}

/**
 * Whether the sweep will itself run again what the board's update put off: an
 * eligible pair that still lacks its clone, or an accepted install. Anything
 * else is only retried by hand.
 */
function retriesAfterUpgrade(machine, project) {
  return checkoutStatus(machine, project).code === 'upgrading'
    && backgroundEligible(machine, project).eligible
    && (!checkoutWasReady(machine, project) || machineOptionsOf(project, machine).install === 'yes');
}

/** Whether this pair is to be started now, leaving aside what is on the runner's disk. */
function wanted(machine, project, retryFailed) {
  if (!backgroundEligible(machine, project).eligible) return false;
  const job = checkoutStatus(machine, project);
  if (unfinished(job)) return false;
  return retryFailed || job.status !== 'failed' || retriesAfterUpgrade(machine, project);
}

/**
 * Whether a checkout that is already there still waits for its accepted
 * install: the board's update put it off, or none was attempted there. A failed
 * one is only retried by hand, whatever jobs came after it.
 */
async function installOwed(name, project, machine) {
  if (machineOptionsOf(project, name).install !== 'yes') return false;
  const job = checkoutStatus(name, project);
  if (job.code === 'upgrading') return true;
  if (job.status === 'failed' || installOutcome(name, project, machine.repoPath)) return false;
  return dependenciesMissing(machine);
}

async function sweepRunner(name, projects, { retryFailed, complete }) {
  const started = [];
  let putOff = false;
  // A job still going may be another path's: this runner is looked at again.
  let busy = false;
  try {
    if (checkoutHooks.holdsNewWork()) {
      swept.delete(name);
      return started;
    }
    await ensureHome(name);
    for (const project of projects) {
      busy ||= unfinished(checkoutStatus(name, project));
      if (!wanted(name, project, retryFailed)) continue;
      const base = machines()[name];
      const machine = machineFor(name, project);
      const present = await base.fs.exists(machine.repoPath);
      if (present && !await installOwed(name, project, machine)) {
        // A clone the update put off, there by now: nothing is left to run.
        if (retriesAfterUpgrade(name, project) && !checkoutWasReady(name, project)) forgetCheckout(name, project);
        continue;
      }
      // All of this may have changed while the runner was being asked.
      if (checkoutHooks.holdsNewWork()) {
        putOff = true;
        break;
      }
      if (!wanted(name, project, retryFailed)) continue;
      launch(name, project, machine.repoPath);
      started.push({ machine: name, project });
    }
  } catch (e) {
    putOff = true;
    // An unreachable runner is expected, and already reported by the client.
    if (e.code !== 'runner_unreachable' && e.code !== 'RUNNER_OFFLINE') complain(`sweep of ${name}`, e);
  }
  if (putOff || (complete && busy)) swept.delete(name);
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

const owesUpgradeRetry = (name) => listProjects().some((p) => retriesAfterUpgrade(name, p.id));

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
  let installed = false;
  if (reachable) {
    try {
      const machine = machineFor(name, projectId);
      installed = installOutcome(name, projectId, machine.repoPath) === 'ran';
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
    // Whether what the update put off will run without anyone asking.
    deferred: retriesAfterUpgrade(name, projectId) && !(present && install !== 'yes' && !checkoutWasReady(name, projectId)),
    install,
    // An install ran to the end there since the board started.
    installed,
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
