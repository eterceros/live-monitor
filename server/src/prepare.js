import { machines, machineFor, ensureHome } from './machine.js';
import { projectOf } from './projects.js';
import { ensureCheckout, checkoutStatus, checkoutsBusy, checkoutHooks, projectRepo, resetCheckouts } from './checkout.js';

/**
 * «Prepare»: puts a registered project on a runner so tasks of that project can
 * run there — clone it under the runner's `projectsRoot`, make its worktree
 * root, install its dependencies — using only the runner's own `exec`.
 *
 * The checkout itself, the job (one per project, shared with the ones chats and
 * tasks start) and the per-machine queue for clones and installs are
 * `checkout.js`; this adds the worktree root and the dependencies.
 *
 * What this deliberately does NOT take from the caller: a URL, a path or a
 * command. The runner's token is root-equivalent, so everything that reaches it
 * is built here and in `checkout.js` from the registry: the repository is the
 * project's `repo` (`owner/name`, validated), the paths come from `machineFor`
 * (the runner's `~/src` convention or an explicit declaration), the install
 * command is one of a few fixed strings picked by which lockfile the checkout
 * has, and the arguments go through `exec`, never through a shell string.
 *
 * Safe to repeat on a runner: an existing checkout is checked and fetched, not
 * cloned again, so after a board restart cuts a run off the next run finishes
 * it. Not so for a local install cut off once `node_modules` is there: the next
 * run is refused (see below) until that folder is removed.
 *
 * On the board's own machine there is nothing to clone and no worktree root to
 * make: it only installs the dependencies of the project's checkout, and only
 * where there is no `node_modules` yet, so an install the person made is never
 * touched.
 */

/** Refusal with the HTTP status it deserves, and a `code` where a caller has to tell it apart. */
export class PrepareError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.name = 'PrepareError';
    this.status = status;
    this.code = code;
  }
}

export const prepareHooks = {
  installTimeoutMs: 20 * 60_000,
};

const NPM = { file: 'package-lock.json', label: 'npm', command: 'npm ci --no-audit --no-fund' };

/** The install command for each lockfile, in order of preference. Fixed text, never built from input. */
const POSIX_INSTALLERS = [
  {
    file: 'pnpm-lock.yaml',
    label: 'pnpm',
    // Where pnpm is missing this relies on corepack, which newer Node releases no
    // longer ship; it reads `packageManager`, and the user-level dir needs no sudo.
    command: 'command -v pnpm >/dev/null 2>&1 || corepack enable --install-directory "$HOME/.local/bin"; '
      + 'export PATH="$HOME/.local/bin:$PATH"; pnpm install --frozen-lockfile',
  },
  NPM,
];

/**
 * The same on Windows, where the shell is cmd.exe. pnpm has to be installed
 * already (`needs`): newer Node releases no longer ship corepack.
 */
const WINDOWS_INSTALLERS = [
  { file: 'pnpm-lock.yaml', label: 'pnpm', needs: 'pnpm', command: 'pnpm install --frozen-lockfile' },
  NPM,
];

const installersFor = (platform) => (platform === 'win32' ? WINDOWS_INSTALLERS : POSIX_INSTALLERS);

/** The installer of the first lockfile at the checkout's root, or null. */
async function installerOf(machine) {
  for (const candidate of installersFor(machine.platform)) {
    if (await machine.fs.exists(machine.path.join(machine.repoPath, candidate.file))) return candidate;
  }
  return null;
}

/**
 * What the checkout job of this project on this machine looks like, whoever
 * started it. `status`: idle, queued, running, done, failed.
 */
export function prepareStatus(machineName, projectId) {
  return checkoutStatus(machineName, projectId);
}

function nodeModulesExists(machine) {
  const dir = machine.path.join(machine.repoPath, 'node_modules');
  return new PrepareError(
    `${dir} already exists on ${machine.name}: dependencies are only installed where there is no node_modules. `
    + 'It was left untouched.',
    409,
    'node_modules_exists',
  );
}

const hasNodeModules = (machine) => machine.fs.exists(machine.path.join(machine.repoPath, 'node_modules'));

/** True when this checkout has something to install and no `node_modules` yet. */
export async function dependenciesMissing(machine) {
  return !await hasNodeModules(machine) && !!await installerOf(machine);
}

const inFlight = (machineName, projectId) => checkoutsBusy().some((j) => j.machine === machineName && j.project === projectId);

/**
 * Starts a run. One already going for this project here is joined (a clone a
 * chat or a task started gets the install chained to it); its clone and its
 * install wait for those of other projects on the same machine.
 *
 * @param {object} [options]
 * @param {object} [options.stillWanted] see `ensureCheckout`; only background cloning passes it.
 * @returns {Promise<object>} the state right after starting; the run goes on in the background.
 * @throws {PrepareError} unknown machine or project, board updating; on a runner, no GitHub repo
 *   or no known path yet; on the board's machine, no checkout (`repo_path_missing`) or a
 *   `node_modules` already there (`node_modules_exists`).
 */
export async function startPrepare(machineName, projectId, { stillWanted } = {}) {
  const base = machines()[machineName];
  if (!base) throw new PrepareError(`There is no machine "${machineName}" in config.machines`, 404);
  const local = base.kind === 'local';

  if (!projectOf(projectId)) throw new PrepareError(`There is no project "${projectId}"`, 404);
  // Nothing is cloned on the board's machine, so it needs no repository.
  if (!local && !projectRepo(projectId)) throw new PrepareError(`The project "${projectId}" has no GitHub repository (owner/name) to clone`);

  // The runner's `~` is only known once it has answered (`projectsRoot`). An
  // unreachable one only matters here if the path depends on it.
  if (!local) await ensureHome(machineName).catch(() => {});
  let machine;
  try {
    machine = machineFor(machineName, projectId);
  } catch (e) {
    throw new PrepareError(e.message);
  }

  // A run in flight is joined as it is: its own install is what creates `node_modules`.
  if (local && !inFlight(machineName, projectId)) {
    if (!await machine.fs.exists(machine.repoPath)) {
      throw new PrepareError(`There is no checkout at ${machine.repoPath} on ${machineName}`, 400, 'repo_path_missing');
    }
    if (await hasNodeModules(machine) && !inFlight(machineName, projectId)) throw nodeModulesExists(machine);
  }

  if (!inFlight(machineName, projectId) && checkoutHooks.holdsNewWork()) {
    throw new PrepareError('The board is updating: retry when the update has finished', 409, 'upgrading');
  }

  // The job is registered before the promise comes back; how it ends is read
  // from its status.
  ensureCheckout(machineName, projectId, { install, stillWanted }).catch(() => {});
  return prepareStatus(machineName, projectId);
}

/** What Prepare does once the checkout is ready, in its turn on the machine's queue. */
async function install(machine, { push, setStep }) {
  const { repoPath, worktreeRoot } = machine;
  const local = machine.kind === 'local';

  // 1. Where the task worktrees will go (the board's machine needs nothing here).
  if (!local) {
    setStep('worktrees');
    await machine.fs.mkdir(worktreeRoot);
    push(`worktrees go in ${worktreeRoot}`);
  }

  // 2. Dependencies.
  setStep('install');
  const installer = await installerOf(machine);
  if (!installer) {
    push('no pnpm-lock.yaml or package-lock.json: nothing to install');
    return;
  }
  if (installer.needs && !(await machine.exec('where', [installer.needs], { timeoutMs: checkoutHooks.probeTimeoutMs })).ok) {
    throw new PrepareError(
      `This project installs with ${installer.needs}, which is not installed on ${machine.name}: install it (npm install -g ${installer.needs}) and retry`,
      400,
      'installer_missing',
    );
  }
  // Looked at again, in this job's turn: it may have appeared since the request.
  if (local && await hasNodeModules(machine)) throw nodeModulesExists(machine);
  push(`installing with ${installer.label}`);
  const r = await machine.shell(installer.command, { cwd: repoPath, onLine: push, timeoutMs: prepareHooks.installTimeoutMs });
  if (!r?.ok) {
    const tail = String(r?.stderr || r?.stdout || '').trim().split('\n').slice(-3).join(' | ');
    throw new Error(`${installer.label} install failed (exit ${r?.code ?? '?'}): ${tail}`);
  }
}

/** For tests: forget every run. */
export function resetPrepare() {
  resetCheckouts();
}
