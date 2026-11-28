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
 * Safe to repeat: an existing checkout is checked and fetched, not cloned
 * again; a board restart that cuts a run off just leaves the next run to finish
 * it.
 */

/** Refusal with the HTTP status it deserves. */
export class PrepareError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const prepareHooks = {
  installTimeoutMs: 20 * 60_000,
};

/** The install command for each lockfile, in order of preference. Fixed text, never built from input. */
const INSTALLERS = [
  {
    file: 'pnpm-lock.yaml',
    label: 'pnpm',
    // corepack ships with Node and reads `packageManager`; the user-level dir needs no sudo.
    command: 'command -v pnpm >/dev/null 2>&1 || corepack enable --install-directory "$HOME/.local/bin"; '
      + 'export PATH="$HOME/.local/bin:$PATH"; pnpm install --frozen-lockfile',
  },
  { file: 'package-lock.json', label: 'npm', command: 'npm ci --no-audit --no-fund' },
];

/**
 * What the checkout job of this project on this machine looks like, whoever
 * started it. `status`: idle, queued, running, done, failed.
 */
export function prepareStatus(machineName, projectId) {
  return checkoutStatus(machineName, projectId);
}

/**
 * Starts a run. One already going for this project here is joined (a clone a
 * chat or a task started gets the install chained to it); its clone and its
 * install wait for those of other projects on the same machine.
 *
 * @returns {Promise<object>} the state right after starting; the run goes on in the background.
 * @throws {PrepareError} not a runner, unknown project, no GitHub repo, no known path yet, board updating.
 */
export async function startPrepare(machineName, projectId) {
  const base = machines()[machineName];
  if (!base) throw new PrepareError(`There is no machine "${machineName}" in config.machines`, 404);
  if (base.kind !== 'runner') throw new PrepareError(`${machineName} is this board's own machine: there is nothing to prepare`);

  if (!projectOf(projectId)) throw new PrepareError(`There is no project "${projectId}"`, 404);
  if (!projectRepo(projectId)) throw new PrepareError(`The project "${projectId}" has no GitHub repository (owner/name) to clone`);

  // The runner's `~` is only known once it has answered (`projectsRoot`). An
  // unreachable one only matters here if the path depends on it.
  await ensureHome(machineName).catch(() => {});
  try {
    machineFor(machineName, projectId);
  } catch (e) {
    throw new PrepareError(e.message);
  }

  const inFlight = checkoutsBusy().some((j) => j.machine === machineName && j.project === projectId);
  if (!inFlight && checkoutHooks.holdsNewWork()) {
    throw new PrepareError('The board is updating: retry when the update has finished', 409);
  }

  // The job is registered before the promise comes back; how it ends is read
  // from its status.
  ensureCheckout(machineName, projectId, { install }).catch(() => {});
  return prepareStatus(machineName, projectId);
}

/** What Prepare does once the checkout is ready, in its turn on the machine's queue. */
async function install(machine, { push, setStep }) {
  const { repoPath, worktreeRoot } = machine;

  // 1. Where the task worktrees will go.
  setStep('worktrees');
  await machine.fs.mkdir(worktreeRoot);
  push(`worktrees go in ${worktreeRoot}`);

  // 2. Dependencies.
  setStep('install');
  let installer = null;
  for (const candidate of INSTALLERS) {
    if (await machine.fs.exists(machine.path.join(repoPath, candidate.file))) { installer = candidate; break; }
  }
  if (!installer) {
    push('no pnpm-lock.yaml or package-lock.json: nothing to install');
    return;
  }
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
