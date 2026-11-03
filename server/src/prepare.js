import { machines, machineFor } from './machine.js';
import { projectOf } from './projects.js';
import { parseGitHubRemote } from './repo-identity.js';

/**
 * «Prepare»: puts a registered project on a runner so tasks of that project can
 * run there — clone it under the runner's `projectsRoot`, make its worktree
 * root, install its dependencies — using only the runner's own `exec`.
 *
 * What this deliberately does NOT take from the caller: a URL, a path or a
 * command. The runner's token is root-equivalent, so everything that reaches it
 * is built here from the registry: the repository is the project's `repo`
 * (`owner/name`, validated), the paths come from `machineFor` (the runner's
 * `~/src` convention or an explicit declaration), the install command is one of
 * a few fixed strings picked by which lockfile the checkout has, and the
 * arguments go through `exec`, never through a shell string.
 *
 * Safe to repeat: an existing checkout is fetched, not cloned again; a board
 * restart that cuts a run off just leaves the next run to finish it.
 */

/** Refusal with the HTTP status it deserves. */
export class PrepareError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const KEEP_LINES = 30;

export const prepareHooks = {
  cloneTimeoutMs: 15 * 60_000,
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

/** `${machine}\n${project}` -> the last run. */
const jobs = new Map();
/** machine -> key of the run in flight there: one at a time per box. */
const running = new Map();

const keyOf = (machine, project) => `${machine}\n${project}`;
const idle = () => ({ status: 'idle', step: null, lines: [], error: null });
const view = (job) => ({ status: job.status, step: job.step, lines: [...job.lines], error: job.error });

/** What the last (or current) run of this project on this machine looks like. */
export function prepareStatus(machineName, projectId) {
  const job = jobs.get(keyOf(machineName, projectId));
  return job ? view(job) : idle();
}

/**
 * Starts a run unless one is already going for this project here (then it
 * returns that one) or for another project on the same machine (409).
 *
 * @returns {Promise<object>} the state right after starting; the run goes on in the background.
 * @throws {PrepareError} not a runner, unknown project, no GitHub repo, no known path yet, box busy.
 */
export async function startPrepare(machineName, projectId) {
  const base = machines()[machineName];
  if (!base) throw new PrepareError(`There is no machine "${machineName}" in config.machines`, 404);
  if (base.kind !== 'runner') throw new PrepareError(`${machineName} is this board's own machine: there is nothing to prepare`);

  const project = projectOf(projectId);
  if (!project) throw new PrepareError(`There is no project "${projectId}"`, 404);
  const repo = typeof project.repo === 'string' ? project.repo.trim() : '';
  if (!REPO_RE.test(repo)) throw new PrepareError(`The project "${projectId}" has no GitHub repository (owner/name) to clone`);

  const key = keyOf(machineName, projectId);
  const current = jobs.get(key);
  if (current?.status === 'running') return view(current);
  const other = running.get(machineName);
  if (other && other !== key) {
    throw new PrepareError(`${machineName} is already preparing another project: wait for it to finish`, 409);
  }

  // The runner's `~` is only known once it has answered (`projectsRoot`).
  if (!base.home) await base.info().catch(() => {});
  let machine;
  try {
    machine = machineFor(machineName, projectId);
  } catch (e) {
    throw new PrepareError(e.message);
  }

  const job = { status: 'running', step: 'clone', lines: [], error: null };
  jobs.set(key, job);
  running.set(machineName, key);
  void run(job, machine, repo)
    .then(() => { job.status = 'done'; job.step = null; })
    .catch((e) => { job.status = 'failed'; job.error = e.message; })
    .finally(() => { if (running.get(machineName) === key) running.delete(machineName); });
  return view(job);
}

async function run(job, machine, repo) {
  const push = (line) => {
    job.lines.push(String(line).slice(0, 400));
    if (job.lines.length > KEEP_LINES) job.lines.splice(0, job.lines.length - KEEP_LINES);
  };
  const tail = (r) => String(r?.stderr || r?.stdout || '').trim().split('\n').slice(-3).join(' | ');
  const must = (r, what) => {
    if (!r?.ok) throw new Error(`${what} failed (exit ${r?.code ?? '?'}): ${tail(r)}`);
    return r;
  };
  const { repoPath, worktreeRoot } = machine;
  const at = (...parts) => machine.path.join(repoPath, ...parts);

  // 1. The checkout.
  job.step = 'clone';
  if (await machine.fs.exists(at('.git'))) {
    push(`${repoPath} is already there: fetching`);
    must(await machine.exec('git', ['-C', repoPath, 'fetch', '--all', '--prune'], { onLine: push, timeoutMs: prepareHooks.cloneTimeoutMs }), 'git fetch');
  } else {
    await machine.fs.mkdir(machine.path.dirname(repoPath));
    push(`cloning ${repo} into ${repoPath}`);
    must(await machine.exec('gh', ['repo', 'clone', repo, repoPath], { onLine: push, timeoutMs: prepareHooks.cloneTimeoutMs }), 'gh repo clone');
  }
  const origin = await machine.exec('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], { timeoutMs: 30_000 });
  const found = parseGitHubRemote(origin.ok ? origin.stdout : '');
  if (!found || found.toLowerCase() !== repo.toLowerCase()) {
    throw new Error(`the checkout at ${repoPath} has origin ${found ?? '(none)'}, not ${repo}: refusing to use it`);
  }

  // 2. Where the task worktrees will go.
  job.step = 'worktrees';
  await machine.fs.mkdir(worktreeRoot);
  push(`worktrees go in ${worktreeRoot}`);

  // 3. Dependencies.
  job.step = 'install';
  let installer = null;
  for (const candidate of INSTALLERS) {
    if (await machine.fs.exists(at(candidate.file))) { installer = candidate; break; }
  }
  if (!installer) {
    push('no pnpm-lock.yaml or package-lock.json: nothing to install');
    return;
  }
  push(`installing with ${installer.label}`);
  must(await machine.shell(installer.command, { cwd: repoPath, onLine: push, timeoutMs: prepareHooks.installTimeoutMs }), `${installer.label} install`);
}

/** For tests: forget every run. */
export function resetPrepare() {
  jobs.clear();
  running.clear();
}
