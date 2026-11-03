import { store } from './store.js';
import { machineOf, machineViewFor } from './machine.js';
import { isRunnerOffline } from './runner-client.js';
import { serviceEnv } from './stack-env.js';
import { configSectionFor } from './projects.js';
import { keyOf } from './keys.js';
import path from 'node:path';
import { createHash } from 'node:crypto';

const DEFAULT_PORT_RANGE = { from: 18080, to: 18200 };
/** Lockfiles whose content decides whether `installCommand` must run again. */
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'requirements.txt'];
/** The install marker: a name inside the worktree's git dir (never in the tree). */
const INSTALL_MARKER = 'board-stack-installed';
/** How long a service's `stopCommand` may run when it declares no `stopTimeoutSeconds`. */
const DEFAULT_STOP_SECONDS = 120;

/** Ports handed out this run, per machine, so two concurrent allocations can't pick the same one. */
const reserved = new Map();   // machine name -> Set<port>
/**
 * Composite task key (`<project>#<issue>`, see `keys.js`) -> { name -> daemon handle }.
 *
 * Keyed by the key and never by the bare issue number. It used to be indexed by
 * `task.issue` while every caller — `index.js`, `move.js`, `pipeline.js` —
 * handed in a key, so the two halves never met: `stopStack` looked up a key in
 * a map full of numbers, found nothing, and killed none of its own handles
 * (only `freeWorktree`, which searches by path, masked it), the map leaked one
 * entry per stack started, and two projects with the same issue number would
 * have shared an entry.
 */
const children = new Map();
/** Task keys whose stack is being built right now. */
const starting = new Set();
/** Task keys whose stack is being stopped right now: two stops must not run at once. */
const stopping = new Set();

const reservedOn = (machine) => {
  if (!reserved.has(machine.name)) reserved.set(machine.name, new Set());
  return reserved.get(machine.name);
};

/**
 * The stack definition in force **for one project**: the servers to build and
 * run, or `null` when there are none.
 *
 * **Every read of the stack in this module goes through here**, and that is the
 * whole point. The board watches a second project (app-b: Python + Vite,
 * no server binary at all) whose stack is nothing like hfs's, so the definition
 * is the project's, not the board's — and `configFor` replaces the `stack`
 * section outright rather than merging it, so a project that declares one
 * inherits nothing of hfs's.
 *
 * **A fresh clone on every call, never a cached one.** `configFor` deep-clones
 * `config`, and `config` is a singleton reloaded in place when `config.json`
 * changes; a value cached here would go on serving what the file no longer
 * says. It is also what keeps `stack-health.test.mjs` honest: it swaps
 * `config.stack.buildCommand` between calls and expects the next one to obey.
 *
 * Note what changed with the clone: this no longer returns the live object, so
 * mutating what it hands back changes nothing anywhere.
 *
 * @param {string} projectId
 * @returns {Object|null}
 * @throws {Error} if no project is registered under `projectId` — a task whose
 *   project vanished from the registry must not silently run on hfs's stack.
 */
export function stackConfig(projectId) {
  return configSectionFor(projectId, 'stack') ?? null;
}

/** What to say when a project has no servers to run. Clear beats a `TypeError`. */
const NO_STACK = 'Este proyecto no define config.stack: no hay servidores que levantar';

/** The stack definition, or a refusal that says why there is none. */
function requireStack(projectId) {
  const stack = stackConfig(projectId);
  if (!stack) throw Object.assign(new Error(NO_STACK), { status: 409 });
  const problem = stackProblem(stack);
  if (problem) throw Object.assign(new Error(`invalid config.stack: ${problem}`), { status: 409 });
  // A command service may omit its label: the name stands in.
  for (const [name, spec] of Object.entries(stack.services)) spec.label ??= name;
  return stack;
}

/** Why a value is not a relative, in-tree folder, or null: no absolute path, drive letter, UNC or `..`. */
function badRelativeDir(value) {
  if (typeof value !== 'string' || !value.trim()) return 'debe ser una ruta relativa no vacía';
  if (path.win32.isAbsolute(value) || path.posix.isAbsolute(value)
    || /^[A-Za-z]:/.test(value) || value.startsWith('\\\\')) return 'no puede ser absoluta';
  if (value.split(/[\\/]/).includes('..')) return 'no puede contener «..»';
  return null;
}

/**
 * Why a stack definition cannot be run, or null. Checked when a stack is about
 * to start, and not at registry load: a throw there would break `load()` for
 * every project. Accepts the hfs shape (binName services, no cwd) as is.
 */
export function stackProblem(stack) {
  const str = (v) => typeof v === 'string' && v.trim() !== '';
  const services = stack.services;
  if (!services || typeof services !== 'object' || Array.isArray(services) || !Object.keys(services).length) {
    return 'services debe declarar al menos un servicio';
  }
  if (stack.cwd !== undefined && badRelativeDir(stack.cwd)) return `cwd ${badRelativeDir(stack.cwd)}`;
  for (const key of ['installCommand', 'buildCommand']) {
    if (stack[key] !== undefined && !str(stack[key])) return `${key} debe ser un texto no vacío`;
  }
  for (const key of ['installTimeoutMinutes', 'buildTimeoutMinutes', 'healthTimeoutMinutes']) {
    if (stack[key] !== undefined && !(Number.isFinite(stack[key]) && stack[key] > 0)) return `${key} debe ser un número positivo`;
  }
  const r = stack.portRange;
  if (r !== undefined && !(Number.isInteger(r?.from) && Number.isInteger(r?.to) && r.from > 0 && r.to >= r.from && r.to < 65536)) {
    return 'portRange debe ser { from, to } con puertos válidos';
  }
  for (const [name, spec] of Object.entries(services)) {
    // Integer-like keys are reordered by JS objects, which would defeat `primary`.
    if (/^\d+$/.test(name)) return `el servicio «${name}» no puede llamarse solo con dígitos`;
    if (!spec || typeof spec !== 'object') return `el servicio «${name}» debe ser un objeto`;
    const bin = spec.binName !== undefined;
    const cmd = spec.command !== undefined;
    if (bin === cmd) return `el servicio «${name}» debe tener exactamente uno de binName o command`;
    if (cmd && !str(spec.command)) return `el servicio «${name}»: command debe ser un texto no vacío`;
    if (bin && !str(spec.binName)) return `el servicio «${name}»: binName debe ser un texto no vacío`;
    if (spec.cwd !== undefined && badRelativeDir(spec.cwd)) return `el servicio «${name}»: cwd ${badRelativeDir(spec.cwd)}`;
    if (spec.stopCommand !== undefined) {
      if (!cmd) return `el servicio «${name}»: stopCommand solo vale en un servicio con command`;
      if (!str(spec.stopCommand)) return `el servicio «${name}»: stopCommand debe ser un texto no vacío`;
    }
    if (spec.stopTimeoutSeconds !== undefined && !(Number.isFinite(spec.stopTimeoutSeconds) && spec.stopTimeoutSeconds > 0)) {
      return `el servicio «${name}»: stopTimeoutSeconds debe ser un número positivo`;
    }
    if (spec.healthPath !== undefined && !str(spec.healthPath)) return `el servicio «${name}»: healthPath debe ser un texto`;
    if (spec.healthPath !== undefined && !spec.healthPath.startsWith('/')) {
      return `el servicio «${name}»: healthPath debe empezar por «/» (por defecto «/»), no «${spec.healthPath}»`;
    }
    if (spec.env !== undefined && (typeof spec.env !== 'object' || spec.env === null || Array.isArray(spec.env))) {
      return `el servicio «${name}»: env debe ser un objeto`;
    }
  }
  if (stack.primary !== undefined && !Object.hasOwn(services, stack.primary)) {
    return `primary «${stack.primary}» no es ninguno de los servicios (${Object.keys(services).join(', ')})`;
  }
  return null;
}

/** The service names in launch order: `primary` first, then the declared order. */
function serviceOrder(stack) {
  const names = Object.keys(stack.services);
  if (!stack.primary) return names;
  return [stack.primary, ...names.filter((n) => n !== stack.primary)];
}

/** `<worktree>/<rel>` on the machine, refusing anything that leaves the worktree. */
function underWorktree(machine, worktree, ...rel) {
  const full = machine.path.join(worktree, ...rel.filter(Boolean));
  const back = machine.path.relative(worktree, full);
  if (back.startsWith('..') || machine.path.isAbsolute(back)) {
    throw new Error(`path ${rel.join('/')} is outside the worktree`);
  }
  return full;
}

/**
 * The stack of a project that may no longer be registered, for the paths whose
 * whole job is to clean up: stopping a stack and asking whether one is healthy
 * must not blow up over a registry entry someone deleted.
 */
function stackOrNull(projectId) {
  try {
    return stackConfig(projectId);
  } catch {
    return null;
  }
}

/**
 * Scans the stack's port range for a port no other process on that machine
 * holds. The stack comes in already resolved: this is called from the middle of
 * `startStack`, which has it, and looking it up again would mean knowing which
 * project a bare `machine` belongs to — which it does not.
 */
export async function findFreePort(machine, stack) {
  const { from, to } = stack.portRange ?? DEFAULT_PORT_RANGE;
  const taken = reservedOn(machine);
  for (let p = from; p <= to; p++) {
    if (taken.has(p)) continue;
    if (await machine.portFree(p)) {
      taken.add(p);
      return p;
    }
  }
  throw new Error(`No free ports in range ${from}-${to} on ${machine.name}`);
}

/**
 * Finds a base port where every `base + offset` is free, for suites that derive
 * a whole block from one number. Ports stay reserved until `releasePorts`, so a
 * second lane can't pick the same block.
 */
export async function findFreePortBase(machine, offsets, range) {
  // The range is always the caller's. There used to be a fallback to the
  // stack's, which cannot survive per-project configuration: which stack is a
  // question about a project, and this function is handed a machine. Its one
  // caller is the e2e phase, and it only gets here when the project declared
  // `e2e.portRange` — a project without one runs its suite with no port block
  // at all rather than borrowing hfs's.
  if (!range) throw new Error('findFreePortBase: a port range {from, to} is required');
  const { from, to } = range;
  const taken = reservedOn(machine);
  const span = Math.max(...offsets);
  for (let base = from; base + span <= to; base++) {
    if (offsets.some((o) => taken.has(base + o))) continue;
    let free = true;
    for (const o of offsets) {
      if (!(await machine.portFree(base + o))) { free = false; break; }
    }
    if (free) {
      for (const o of offsets) taken.add(base + o);
      return base;
    }
  }
  throw new Error(`No free port block (offsets ${offsets.join(',')}) in ${from}-${to} on ${machine.name}`);
}

export function releasePorts(machine, ports) {
  const taken = reservedOn(machine);
  for (const p of ports) taken.delete(p);
}

/**
 * Starts this worktree's app (what the project's stack declares) on free
 * ports, on the task's machine. For hfs that is `hfs` plus `hts`.
 *
 * hfs specifics: release profile. Debug is right for compiling and testing code (it is what CI
 * does), but a debug `hfs` given an explicit `HFS_DATABASE_URL` overflows the
 * 1 MB main-thread stack Windows gives it — reproduced 2026-09-03 with that one
 * variable and nothing else. Release also shares artifacts with the e2e phase,
 * which must use it for the same reason.
 */
export function startStack(issue) {
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  // Everything in flight is indexed by the task's key, never by the number the
  // caller happened to pass — routes and `move.js` pass keys, tests pass bare
  // numbers, and both have to land on the same entry.
  const key = keyOf(task);
  // Before anything is touched: a project with no servers has nothing to start,
  // and saying so is not a failed stack — `task.stack` stays as it was.
  const stack = requireStack(task.project);
  // The same rule as `assertNotMoving` in pipeline.js, inlined: importing it
  // from there would close an import cycle through this module.
  const m = task.moving;
  if (m && (!m.error || m.step === 'chats')) {
    throw Object.assign(new Error(m.error ? 'The move was left half-done: try again' : 'The task is moving to another machine'), { status: 409 });
  }
  if (!task.worktreePath) throw new Error('The task has no worktree');
  if (stopping.has(key)) throw Object.assign(new Error('The stack is being stopped'), { status: 409 });
  if (starting.has(key) || task.stack?.status === 'starting') {
    throw new Error('The stack is already starting');
  }
  if (task.stack?.status === 'running') throw new Error('The stack is already running');
  // The e2e suite runs its own servers out of this same worktree; clearing the
  // way for a build would pull them out from under a run in progress.
  if (task.state === 'testing') {
    throw new Error('The e2e suite is using this worktree right now; wait for it to finish');
  }

  const machine = machineOf(task);
  starting.add(key);
  // What the stack being replaced still owes the machine (its stop commands) is
  // carried over: the new stack runs it before building anything.
  const owed = pendingStops(task.stack);
  task.stack = { status: 'starting', services: {}, error: null, host: machine.host, ...(owed.length ? { leftover: owed } : {}) };
  store.touch(task);

  // Nobody awaits this: the card follows it through `task.stack`. Which is
  // why it ends in a `catch` of its own — the handler below runs on a machine
  // that may vanish mid-build, and a rejection escaping here would reach Node
  // as an unhandled one and end the board with every other task in it.
  void (async () => {
    const log = (l) => store.addLog(task, 'stack', l);
    let cleanupFailed = false;
    try {
      if (owed.length) {
        const failures = await runPendingStops(task, log);
        if (failures.length) {
          cleanupFailed = true;
          throw new Error(`the previous stack could not be cleaned up: ${failures.join('; ')}`);
        }
      }
      const profile = stack.profile ?? 'debug';
      const buildCommand = stack.buildCommand && profile === 'release' && !/--release/.test(stack.buildCommand)
        ? `${stack.buildCommand} --release`
        : stack.buildCommand;
      // Windows will not let cargo replace a binary that is running, and the
      // error it gives says nothing about why. Clear the way first.
      await freeWorktree(task, machine, log, stack);
      // Where install, build and services run: the worktree, or a folder in it.
      const stackCwd = stack.cwd ? underWorktree(machine, task.worktreePath, stack.cwd) : task.worktreePath;
      await installDependencies(task, machine, log, stack, stackCwd);
      if (buildCommand) {
        log(`building (${profile}) on ${machine.name}: ${buildCommand}`);
        const build = await machine.shell(buildCommand, {
          cwd: stackCwd,
          timeoutMs: (stack.buildTimeoutMinutes ?? 90) * 60 * 1000,
          onLine: (l) => log(l),
        });
        if (!build.ok) {
          const locked = /failed to remove file[\s\S]*?Access is denied/i.test(build.stderr);
          throw new Error(locked
            ? 'the build could not replace the binary because something has it open (another server, a debugger or the antivirus). Press "Stop stack" and try again.'
            : `the build failed: ${build.stderr.slice(-600)}`);
        }
      }

      const extraEnv = await seedHtsDatabase(task, machine, log, stack);

      for (const name of serviceOrder(stack)) {
        const spec = stack.services[name];
        const port = await findFreePort(machine, stack);
        log(`${spec.label}: free port ${port}`);
        task.stack.services[name] = {
          // `url` is how this board reaches the server for health checks —
          // loopback for a local task, the machine's tailnet name otherwise.
          // `localUrl` is how a process *on that machine* (a Claude session)
          // reaches it. The browser builds its own link from `task.stack.host`.
          label: spec.label,
          port,
          host: machine.host,
          url: `http://${machine.host}:${port}`,
          localUrl: `http://127.0.0.1:${port}`,
          healthy: false,
        };
        store.touch(task);
        await launch(task, machine, name, spec, port, log, extraEnv[name], stack, stackCwd);
      }

      await waitHealthy(task, log, stack);
      task.stack.status = 'running';
      store.touch(task);
      log('stack ready ✅');
    } catch (e) {
      // Whatever this start already launched may own things outside its tree:
      // run the saved stop commands (never throwing) before the kill. A failed
      // cleanup keeps its records for the next Stop or Start.
      if (!cleanupFailed && task.stack) await runPendingStops(task, log).catch(() => {});
      await stopProcesses(key);
      task.stack = { ...(task.stack ?? {}), status: 'error', error: e.message };
      store.addLog(task, 'stack', `⚠️ ${e.message}`);
      store.touch(task);
    } finally {
      starting.delete(key);
    }
  })().catch((e) => console.error(`[stack] ${key}: ${e.stack ?? e.message}`));
}

/**
 * Copies the main checkout's already-seeded HTS store into the worktree — both
 * on the task's machine. Without it, HTS either starts empty (every page lists
 * zero rows) or spends many minutes importing the bootstrap set. Copied, never
 * shared: startup runs migrations against it.
 */
async function seedHtsDatabase(task, machine, log, stack) {
  const rel = stack?.seedHtsFromMain;
  if (!rel) return {};
  const source = machine.path.join(machine.repoPath, rel);
  const target = machine.path.join(task.worktreePath, rel);
  if (!(await machine.fs.exists(source))) {
    log(`no seeded HTS store at ${source}; HTS will start empty`);
    return {};
  }
  if (await machine.fs.exists(target)) {
    log('the worktree already has an HTS store; reusing it');
  } else {
    await machine.fs.mkdir(machine.path.dirname(target));
    log('copying the seeded HTS store (may take a while, it is large)');
    await machine.fs.copy(source, target);
  }
  // Returned rather than written into `config`: a global mutation leaked
  // between tasks, was lost on a config reload, and skipped the store entirely
  // when the worktree already had one.
  return { hts: { HTS_DATABASE_URL: `./${rel}` } };
}

/**
 * Runs `installCommand` once per worktree. The marker lives in the worktree's
 * git dir (invisible to git, to `wipCommit` and to machine moves) and stores a
 * hash of the lockfile in `cwd`, so a changed lockfile installs again.
 */
async function installDependencies(task, machine, log, stack, stackCwd) {
  if (!stack.installCommand) return;
  let lock = '';
  for (const name of LOCKFILES) {
    const file = machine.path.join(stackCwd, name);
    if (await machine.fs.exists(file)) {
      lock = createHash('sha256').update(await machine.fs.readFile(file, 'utf8')).digest('hex');
      break;
    }
  }
  const stamp = `lock:${lock}`;
  let marker = null;
  const git = await machine.exec('git', ['rev-parse', '--git-path', INSTALL_MARKER], { cwd: task.worktreePath, timeoutMs: 30_000 });
  if (git.ok && git.stdout.trim()) {
    marker = machine.path.resolve(task.worktreePath, git.stdout.trim());
    if (await machine.fs.exists(marker) && (await machine.fs.readFile(marker, 'utf8')).trim() === stamp) {
      log('dependencies already installed in this worktree; skipping the install');
      return;
    }
  } else {
    log('⚠️ could not locate the install marker; installing anyway');
  }
  log(`installing dependencies on ${machine.name}: ${stack.installCommand}`);
  const install = await machine.shell(stack.installCommand, {
    cwd: stackCwd,
    timeoutMs: (stack.installTimeoutMinutes ?? 10) * 60 * 1000,
    onLine: (l) => log(l),
  });
  if (!install.ok) throw new Error(`dependency install failed: ${`${install.stdout ?? ''}\n${install.stderr ?? ''}`.trim().slice(-600)}`);
  if (marker) await machine.fs.writeFile(marker, stamp);
}

async function launch(task, machine, name, spec, port, log, extra, stack, stackCwd = task.worktreePath) {
  const env = serviceEnv(name, spec, port, extra);
  const tag = (spec.label ?? name).toLowerCase();
  const cwd = spec.cwd ? underWorktree(machine, stackCwd, spec.cwd) : stackCwd;
  let bin;
  let args = [];
  if (spec.command !== undefined) {
    // A command service goes through the machine's own shell: `npm` is
    // `npm.cmd` on Windows. The wrapping quotes are cmd's `/s` convention
    // (see `windowsVerbatimArguments` in `LocalDaemons.spawn`).
    const command = String(spec.command).replaceAll('{port}', String(port));
    if (machine.platform === 'win32') { bin = 'cmd.exe'; args = ['/d', '/s', '/c', `"${command}"`]; }
    else { bin = 'sh'; args = ['-c', command]; }
  } else {
    // `binName` is the bare name; the machine says whether it ends in `.exe`.
    // A config written when the board only knew Windows still carries the
    // suffix, and on the dev box that named a binary that could not exist.
    const bare = String(spec.binName).replace(/\.exe$/i, '');
    const rel = machine.path.join('target', stack?.profile ?? 'debug', bare + machine.binSuffix);
    bin = machine.path.join(task.worktreePath, rel);
    if (!(await machine.fs.exists(bin))) throw new Error(`binary ${rel} not found after building`);
  }

  // Saved resolved, at launch: editing the config later must not change what
  // stopping this running stack does. Persisted with `task.stack`, so it also
  // survives a board restart.
  if (spec.stopCommand !== undefined) {
    task.stack.services[name].stop = {
      command: String(spec.stopCommand).replaceAll('{port}', String(port)),
      cwd,
      env,
      timeoutMs: (spec.stopTimeoutSeconds ?? DEFAULT_STOP_SECONDS) * 1000,
      machine: machine.name,
    };
  }
  const handle = await machine.daemon.spawn(bin, { cwd, env, args });
  handle.on('line', (line) => log(`[${tag}] ${line}`));
  handle.on('exit', (code) => {
    log(`[${tag}] process exited (code ${code})`);
    const svc = task.stack?.services?.[name];
    if (svc) { svc.healthy = false; svc.exited = true; }
    if (task.stack?.status === 'running') {
      task.stack.status = 'error';
      task.stack.error = `${spec.label} stopped (code ${code})`;
    }
    store.touch(task);
  });

  const key = keyOf(task);
  if (!children.has(key)) children.set(key, {});
  children.get(key)[name] = handle;
}

/** Test seam: how long the health and start loops sleep between looks. */
export const stackHooks = { pollMs: 3000, stopGraceMs: 5000 };

async function waitHealthy(task, log, stack) {
  const deadline = Date.now() + (stack.healthTimeoutMinutes ?? 5) * 60 * 1000;
  const pending = new Map(Object.entries(stack.services));

  while (pending.size && Date.now() < deadline) {
    for (const [name, spec] of [...pending]) {
      const svc = task.stack.services[name];
      if (await answers(svc, spec)) {
        svc.healthy = true;
        store.touch(task);
        log(`${spec.label} responds at ${svc.url}`);
        pending.delete(name);
      }
    }
    if (pending.size) await new Promise((r) => setTimeout(r, stackHooks.pollMs));
  }
  if (pending.size) {
    log(`⚠️ no response from: ${[...pending.keys()].join(', ')} (the links stay anyway)`);
  }
}

/** One service answering its health path right now, within a few seconds. */
async function answers(svc, spec) {
  try {
    const res = await fetch(`${svc.url}${spec.healthPath ?? '/'}`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Asks a `running` stack whether it still is.
 *
 * The status only ever learned about a server dying from its exit event, and
 * there are ways to stop answering without one reaching the board — a hung
 * process, a runner that lost its socket. The card then showed green links to
 * nothing, and Browser QA was handed servers that were not there. Marks each
 * service as found; a stack with none answering is an error. Returns true
 * only when every service answers.
 */
export async function refreshStackHealth(task) {
  if (task.stack?.status !== 'running') return false;
  // A project with no stack has nothing that can be unhealthy. This one answers
  // `false` instead of throwing because its contract is a boolean and it is
  // called from sweeps that must not blow up over a project that defines none —
  // nor over one that is no longer in the registry, hence `stackOrNull`.
  const stack = stackOrNull(task.project);
  if (!stack) return false;
  const entries = Object.entries(stack.services).filter(([name]) => task.stack.services?.[name]);
  let up = 0;
  let changed = false;
  for (const [name, spec] of entries) {
    const svc = task.stack.services[name];
    const ok = await answers(svc, spec);
    if (ok) up += 1;
    if (svc.healthy !== ok) { svc.healthy = ok; changed = true; }
  }
  if (entries.length && up === 0) {
    task.stack.status = 'error';
    task.stack.error = 'the task servers stopped responding';
    store.addLog(task, 'stack', `⚠️ ${task.stack.error}`);
    changed = true;
  }
  if (changed) store.touch(task);
  return entries.length > 0 && up === entries.length;
}

/**
 * Leaves the worktree free of running servers, whoever started them.
 *
 * `children` only holds what *this* process spawned, so a board restart turns
 * every running server into an orphan it can neither see nor stop — and on
 * Windows a running executable cannot be replaced, so the next build dies with
 * "Access is denied" and a page of cargo output that says nothing about the
 * real cause. Scoped to the task's own worktree on purpose: binaries under
 * `hfs-wt/<task>` can only be this board's doing.
 */
async function freeWorktree(task, machine, log, stack) {
  const names = Object.values(stack?.services ?? {}).map((s) => String(s.binName ?? '').replace(/\.exe$/i, '')).filter(Boolean);
  if (!names.length) return 0;
  let found;
  try {
    found = await machine.daemon.find(task.worktreePath, names);
  } catch (e) {
    // A machine that cannot be reached is not holding a binary open: whatever
    // ran there went with it. Saying so beats refusing to stop a stack — or
    // failing a build — over a box that is not there.
    if (!isRunnerOffline(e)) throw e;
    log(`⚠️ ${e.message}; nothing to stop there`);
    return 0;
  }
  if (!found.length) return 0;
  log(`${found.length} server(s) of this task were already running; stopping them so the build can proceed`);
  for (const p of found) {
    log(`  stopping ${machine.path.basename(p.path)} (PID ${p.pid})`);
    await machine.daemon.kill(p.pid);
  }
  return found.length;
}

/** @param {string} key a composite task key, never a bare issue number. */
async function stopProcesses(key) {
  const procs = children.get(key) ?? {};
  children.delete(key);
  // Waits for every tree to die: a port or a file is not free until it has.
  // `kill` may be sync (a runner handle) or async; a throw is a gone process.
  await Promise.allSettled(Object.values(procs).map((handle) => Promise.resolve().then(() => handle.kill())));
}

/**
 * The stop commands a stack still owes, as `{ name, command, cwd, env,
 * timeoutMs, machine }`: the ones saved on its services plus the `leftover`
 * of stacks it replaced. Safe on `null`.
 */
export function pendingStops(stack) {
  return [
    ...Object.entries(stack?.services ?? {}).filter(([, svc]) => svc.stop).map(([name, svc]) => ({ name, ...svc.stop })),
    ...(stack?.leftover ?? []),
  ];
}

/** What the browser may see of a stack: the saved stop commands carry resolved `env` values (secrets). */
export function publicStack(stack) {
  if (!stack) return stack;
  const { leftover, services, ...rest } = stack;
  if (!services) return rest;
  return { ...rest, services: Object.fromEntries(Object.entries(services).map(([name, { stop, ...svc }]) => [name, svc])) };
}

/**
 * Runs the stop commands one after another, each from its own machine, with its
 * own timeout. Answers one entry per record: `null` when it succeeded, else why
 * not. Never throws. `timeoutMs` makes the machine kill the command, but on
 * Windows that reaches only the direct child and `close` may then never come, so
 * a hard deadline of its own (plus `stackHooks.stopGraceMs`) cuts the wait; a
 * process that outlived it is left alone and its record is kept.
 */
async function runStopRecords(task, records, log) {
  const reasons = [];
  for (const rec of records) {
    const { machine, error } = machineViewFor(task, rec.machine);
    if (!machine) { reasons.push(`${rec.name}: ${error}`); continue; }
    const ctl = new AbortController();
    let timer;
    try {
      // The folder may be gone (the worktree was deleted): the repo is always there.
      const cwd = (await machine.fs.exists(rec.cwd)) ? rec.cwd : machine.repoPath;
      log(`running the stop command of ${rec.name} on ${machine.name}: ${rec.command}`);
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => { ctl.abort(); resolve({ ok: false, code: -2 }); }, rec.timeoutMs + stackHooks.stopGraceMs);
        timer.unref?.();
      });
      const res = await Promise.race([
        machine.shell(rec.command, { cwd, env: rec.env, timeoutMs: rec.timeoutMs, signal: ctl.signal, onLine: (l) => log(`[stop ${rec.name}] ${l}`) }),
        deadline,
      ]);
      if (res.ok) { reasons.push(null); continue; }
      const how = res.code === -2 ? 'timed out' : `exit code ${res.code}`;
      reasons.push(`${rec.name}: the stop command failed (${how})${res.stderr ? `: ${String(res.stderr).trim().slice(-300)}` : ''}`);
    } catch (e) {
      reasons.push(`${rec.name}: the stop command could not run: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return reasons;
}

/**
 * Runs everything `pendingStops` lists for the task's stack and drops the
 * records that succeeded; the failed ones stay, so a second try repeats only
 * those. Answers the failure messages (empty when all went well).
 */
async function runPendingStops(task, log) {
  const stack = task.stack;
  const names = Object.keys(stack.services ?? {}).filter((name) => stack.services[name].stop);
  const left = stack.leftover ?? [];
  const reasons = await runStopRecords(task, pendingStops(stack), log);
  names.forEach((name, i) => { if (!reasons[i]) delete stack.services[name].stop; });
  const kept = left.filter((_, i) => reasons[names.length + i]);
  if (kept.length) stack.leftover = kept; else delete stack.leftover;
  store.touch(task);
  return reasons.filter(Boolean);
}

export async function stopStack(issue) {
  const task = store.get(issue);
  if (!task?.stack) throw new Error('The task has no stack');
  const key = keyOf(task);
  if (stopping.has(key)) throw Object.assign(new Error('The stack is already stopping'), { status: 409 });
  const machine = machineOf(task);
  const log = (l) => store.addLog(task, 'stack', l);
  stopping.add(key);
  try {
    // Set first, so the exit handler of a killed server does not report a crash.
    task.stack.status = 'stopping';
    task.stack.error = null;
    store.touch(task);
    log('stopping the servers');
    // A server may own things outside its own process tree (containers), and a
    // kill gives it no chance to clean them: each service's saved stop command
    // runs first, and also after a restart, when `children` is empty.
    const failures = await runPendingStops(task, log);
    await stopProcesses(key);
    // And anything left from before a restart, which `children` cannot know about.
    // `stackOrNull`: stopping is cleanup, and it has to work for a task whose
    // project is no longer registered just as much as for one whose is.
    await freeWorktree(task, machine, log, stackOrNull(task.project));
    releasePorts(machine, Object.values(task.stack.services ?? {}).map((svc) => svc.port));
    if (failures.length) {
      const error = `could not stop everything: ${failures.join('; ')}. Press «Stop stack» to try again.`;
      task.stack.status = 'error';
      task.stack.error = error;
      log(`⚠️ ${error}`);
      store.touch(task);
      throw new Error(error);
    }
    task.stack = null;
    store.touch(task);
  } catch (e) {
    if (task.stack && task.stack.status === 'stopping') {
      task.stack.status = 'error';
      task.stack.error = e.message;
      store.touch(task);
    }
    throw e;
  } finally {
    stopping.delete(key);
  }
}

/** Called before deleting a worktree — the binaries live inside it. */
export function stackRunning(issue) {
  const task = store.get(issue);
  return Boolean(task) && children.has(keyOf(task));
}

/**
 * The stack up and answering, starting it when it is not. `startStack` returns
 * at once and works in the background; this waits for it to reach `running`,
 * or explains why it did not. Browser QA needs the app in front of it.
 */
export async function ensureStackRunning(issue, { timeoutMs } = {}) {
  const task = store.get(issue);
  if (!task) throw new Error(`Unknown task #${issue}`);
  // Asked for servers a project does not define: say that, rather than dying on
  // `stack.services` three calls deeper with a `TypeError`. The 409 is what
  // `runQaOnce` is written to never provoke — it checks for a stack first — so
  // reaching it means a button, not the pipeline.
  const stack = requireStack(task.project);
  const key = keyOf(task);
  // `running` is what the board last knew, not what is true. Ask; and when
  // anything does not answer — or a stack sits in error — clear it out (its
  // processes and its ports) and start from scratch. Compiling is incremental.
  if (task.stack?.status === 'running' && !(await refreshStackHealth(task))) {
    store.addLog(task, 'stack', 'the stack was marked as running but does not fully respond; restarting it');
    await stopStack(key);
  } else if (task.stack && task.stack.status !== 'running' && task.stack.status !== 'starting') {
    await stopStack(key);
  }
  if (!task.stack) startStack(key);
  const limit = Date.now() + (timeoutMs ?? ((stack.buildCommand ? (stack.buildTimeoutMinutes ?? 90) : 0)
    + (stack.installCommand ? (stack.installTimeoutMinutes ?? 10) : 0)
    + (stack.healthTimeoutMinutes ?? 5) + 2) * 60_000);
  while (Date.now() < limit) {
    if (task.stack?.status === 'running') return task.stack;
    if (task.stack?.status === 'error') throw new Error(`the stack did not start: ${task.stack.error}`);
    await new Promise((r) => setTimeout(r, stackHooks.pollMs));
  }
  throw new Error('the stack was not ready in time');
}
