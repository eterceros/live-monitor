import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { promises as fsp, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { run, runShell, runPosixShell, stripAnsi } from './exec.js';
import { config } from './config.js';
import { DEFAULT_PROJECT_ID } from './keys.js';
import { projectOf } from './projects.js';
import { RunnerMachine } from './runner-client.js';
import { createZenProxy } from './zen-proxy.js';

/** The process starter behind `handle.kill`'s taskkill; a seam so a test can observe it. */
export const procTools = { spawn: (...args) => spawn(...args) };

// One Zen proxy per process, shared by every local task (see `zenProxyPort`).
let zenProxy = null;
let zenProxyStart = null;
const defaultZenProxyFactory = (options) => createZenProxy(options);
let makeZenProxy = defaultZenProxyFactory;

/** The real proxy by default; tests swap in one whose `listen()` fails. */
export function registerZenProxyFactory(factory = defaultZenProxyFactory) { makeZenProxy = factory; }

/**
 * Where a task's work happens.
 *
 * A task used to run, by construction, on the machine hosting the board: every
 * `git`, every `cargo`, every `fs` call and every Claude process assumed the
 * local disk and the local network. `Machine` is that assumption made
 * explicit, so a task can say "this one runs on the dev box" and the pipeline
 * does not have to know the difference.
 *
 * The shape that keeps it small: `LocalMachine` is the real implementation of
 * each operation on whatever machine the code runs on — Windows here, POSIX on
 * the dev box — and the runner (`server/runner.js`) is nothing more than a
 * `LocalMachine` served over the network. The board-side client that talks to
 * it is `RunnerMachine`. Both satisfy the same interface:
 *
 *   exec(file, args, opts) / shell(cmd, opts)       -> { ok, code, stdout, stderr }
 *   posixShell(cmd, opts)                            -> same; bash, as the sessions' Bash tool
 *   fs.exists/readFile/readBinary/realpath/writeFile/mkdir/rm/readdir/copy/tail
 *   daemon.spawn(bin, opts) -> handle ; daemon.find(prefix) ; daemon.kill(pid)
 *   portFree(port)
 *   spawnClaude                                      -> null (SDK default) or a spawner
 *   zenProxyPort()                                   -> loopback port of the OpenCode Zen proxy
 *   putAttachment(scope, localPath, name)            -> the path Claude will see
 *                                                       (scope: an issue number, or `_proyecto` for a project chat)
 *   info()                                           -> { platform, node, claude, home }
 *   host, path, repoPath, worktreeRoot, binSuffix, samePath(a, b)
 *
 * What is deliberately *not* here: `gh`. It talks to GitHub, and GitHub does
 * not care where the worktree is.
 */

/** The operations, on the machine this code is running on. */
export class LocalMachine {
  kind = 'local';

  constructor(name, { repoPath, worktreeRoot, binSuffix, platform = process.platform } = {}) {
    this.name = name;
    this.platform = platform;
    this.path = platform === 'win32' ? path.win32 : path.posix;
    this.repoPath = repoPath;
    this.worktreeRoot = worktreeRoot;
    this.binSuffix = binSuffix ?? (platform === 'win32' ? '.exe' : '');
    // Where the board reaches services this machine runs. For the local
    // machine that is loopback; a browser builds its own links from the host
    // it is talking to (see web/src/serviceUrl.js).
    this.host = '127.0.0.1';
    this.fs = new LocalFs();
    this.daemon = new LocalDaemons(this);
  }

  exec(file, args, opts) { return run(file, args, opts); }
  shell(command, opts) { return runShell(command, opts); }
  /** A model-written command line (a plan `check`): bash, never cmd. See runPosixShell. */
  posixShell(command, opts) { return runPosixShell(command, opts); }

  /** Windows paths are case-insensitive; the others are not. */
  samePath(a, b) {
    const norm = (p) => this.path.resolve(String(p ?? ''));
    return this.platform === 'win32'
      ? norm(a).toLowerCase() === norm(b).toLowerCase()
      : norm(a) === norm(b);
  }

  /** Authoritative: actually try to bind it. */
  portFree(port) {
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(port, '0.0.0.0');
    });
  }

  /** null: let the SDK spawn its own CLI, right here. */
  get spawnClaude() { return null; }

  /**
   * The loopback port of the Zen proxy on this machine, started on first ask.
   * One per process, not one per task: it holds no per-task state, and the
   * `claude` processes that use it all run here.
   */
  async zenProxyPort() {
    zenProxy ??= makeZenProxy();
    // A failed `listen()` must not be cached: a port busy for one moment would
    // otherwise leave every task of this process without a proxy for good.
    zenProxyStart ??= zenProxy.listen().catch((e) => {
      zenProxy = null;
      zenProxyStart = null;
      throw e;
    });
    return zenProxyStart;
  }

  /** The file is already where Claude will read it. */
  async putAttachment(_issue, localPath) { return localPath; }

  async info() {
    const claude = await run('claude', ['--version'], { timeoutMs: 20_000 });
    return {
      platform: this.platform,
      node: process.version,
      claude: claude.ok ? claude.stdout.trim().split(/\s+/)[0] : null,
      // Where this machine keeps `~/.claude/projects`, so the board can check a
      // session's transcript is still there before resuming it.
      home: os.homedir(),
    };
  }
}

class LocalFs {
  exists(p) { return Promise.resolve(existsSync(p)); }
  readFile(p, encoding = 'utf8') { return fsp.readFile(p, encoding); }
  /** Bytes, for the screenshots and videos the panel serves. */
  readBinary(p) { return fsp.readFile(p); }
  /**
   * Where a path really lands, symlinks and junctions resolved, with what is
   * there: the file viewer checks the real place, refuses anything that is not
   * a regular file (a FIFO would hang the read) and the size before reading.
   * `uid` says who owns a file in a shared `/tmp` (null on Windows, where the
   * number means nothing); `mtimeMs` lets a live reload skip the read; `nlink`
   * is how many names the file has (a hard link hides its real name).
   */
  async realpath(p) {
    const real = await fsp.realpath(p);
    const st = await fsp.stat(real);
    return {
      path: real, size: st.size, isFile: st.isFile(),
      uid: process.platform === 'win32' ? null : st.uid, mtimeMs: st.mtimeMs, nlink: st.nlink,
    };
  }
  /** Every file under `p`, as paths relative to it with forward slashes. */
  async readdirDeep(p) {
    const out = [];
    const walk = async (dir, rel) => {
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        const next = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), next);
        else out.push(next);
      }
    };
    if (existsSync(p)) await walk(p, '');
    return out.sort();
  }
  writeFile(p, data) { return fsp.writeFile(p, data); }
  mkdir(p) { return fsp.mkdir(p, { recursive: true }); }
  rm(p, { retries = 0 } = {}) {
    return fsp.rm(p, { recursive: true, force: true, maxRetries: retries, retryDelay: 400 });
  }
  readdir(p) { return fsp.readdir(p); }
  copy(from, to) { return fsp.copyFile(from, to); }
  /** The end of a file, for following a command's output as it grows. */
  async tail(p, bytes) {
    const handle = await fsp.open(p, 'r');
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - bytes);
      const buf = Buffer.alloc(size - start);
      await handle.read(buf, 0, buf.length, start);
      return (start > 0 ? '…' : '') + buf.toString('utf8');
    } finally {
      await handle.close();
    }
  }
}

/**
 * Long-lived processes — the task's own `hfs`/`hts` — that outlive the call
 * that started them, and that a board restart must still be able to find.
 */
class LocalDaemons {
  constructor(machine) { this.machine = machine; }

  /**
   * Starts one and hands back a handle: `pid`, `on('line')`, `on('exit')`,
   * `kill()`. On POSIX it gets its own process group so `kill` reaches the
   * whole tree, which is what `taskkill /T` does on Windows.
   */
  spawn(bin, { cwd, env, args = [] }) {
    const posix = this.machine.platform !== 'win32';
    // A command service is `cmd.exe /d /s /c "<command>"`: the wrapping quotes are
    // the command's own, so Node must not re-quote the argument. Decided here, on
    // the machine that spawns, so the runner protocol needs no new field.
    const verbatim = !posix && /(^|[\\/])cmd(\.exe)?$/i.test(String(bin));
    const child = spawn(bin, args, {
      cwd, env: env ? { ...process.env, ...env } : process.env, windowsHide: true, detached: posix,
      ...(verbatim ? { windowsVerbatimArguments: true } : {}),
    });
    const handle = new EventEmitter();
    handle.pid = child.pid;
    const feed = (buf) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        const clean = stripAnsi(line).trimEnd();
        if (clean) handle.emit('line', clean);
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('exit', (code) => handle.emit('exit', code));
    child.on('error', (e) => handle.emit('exit', null, e));
    /**
     * Ends the tree and resolves once it is gone (taskkill finished / the child
     * exited, with a ceiling). An already-exited child is left alone: its pid may
     * have been reused, and the house rule is to kill only a verified own pid.
     */
    handle.kill = () => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(resolve, 10_000);
      timer.unref?.();
      const done = () => { clearTimeout(timer); resolve(); };
      try {
        if (posix && child.pid) {
          child.once('exit', done);
          process.kill(-child.pid, 'SIGTERM');
        } else if (!posix && child.pid) {
          // `child.kill()` ends only the direct child: for a shell-wrapped command
          // that is cmd.exe, and the node it started would live on. Same as `daemon.kill`.
          const tk = procTools.spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          tk.on('exit', done);
          tk.on('error', () => { try { child.kill(); } catch { /* already gone */ } done(); });
        } else { child.kill(); done(); }
      } catch { done(); }
    });
    return handle;
  }

  /**
   * Running executables that live under `prefix` — the task's worktree —
   * whoever started them. The board only ever holds handles to what *it*
   * spawned; after a restart the servers are still there and still hold the
   * binaries cargo needs to replace.
   */
  async find(prefix, binNames = []) {
    if (!prefix) return [];
    if (this.machine.platform === 'win32') return this.#findWindows(prefix, binNames);
    return this.#findPosix(prefix);
  }

  async #findWindows(prefix, binNames) {
    const names = binNames.map((n) => n + this.machine.binSuffix);
    if (!names.length) return [];
    const filter = names.map((n) => `Name='${n}'`).join(' or ');
    const r = await run('powershell', [
      '-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress`,
    ], { timeoutMs: 30_000 });
    if (!r.ok || !r.stdout.trim()) return [];
    let rows;
    try { rows = JSON.parse(r.stdout); } catch { return []; }
    const wanted = path.resolve(prefix).toLowerCase();
    return (Array.isArray(rows) ? rows : [rows])
      .filter((p) => p?.ExecutablePath && path.resolve(p.ExecutablePath).toLowerCase().startsWith(wanted))
      .map((p) => ({ pid: p.ProcessId, path: p.ExecutablePath }));
  }

  async #findPosix(prefix) {
    // `ps` over `pgrep -f`: the command line is what says which worktree a
    // binary belongs to, and pgrep only gives pids.
    const r = await run('ps', ['-eo', 'pid=,args='], { timeoutMs: 30_000 });
    if (!r.ok) return [];
    const wanted = path.posix.resolve(prefix) + '/';
    const found = [];
    for (const line of r.stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\S+)/.exec(line);
      if (m && m[2].startsWith(wanted)) found.push({ pid: Number(m[1]), path: m[2] });
    }
    return found;
  }

  /** Ends a process tree by pid — the only way to reach one we did not spawn. */
  async kill(pid) {
    if (this.machine.platform === 'win32') {
      await run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 30_000 });
      return;
    }
    // The group first (a daemon we spawned has its own), then the pid itself.
    try { process.kill(-pid, 'SIGTERM'); } catch { /* not a group leader */ }
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------

let cache = null;
let cacheKey = null;

/**
 * The machines this board can run tasks on, from `config.machines`. Without
 * that section there is exactly one, `local`, shaped from `config.project` —
 * which is every board that existed before this.
 */
export function machines() {
  const declared = config.machines ?? {};
  const key = JSON.stringify([declared, config.project]);
  if (cache && cacheKey === key) return cache;

  const built = {};
  const localSpec = declared.local ?? { kind: 'local' };
  built.local = new LocalMachine('local', {
    repoPath: localSpec.repoPath ?? config.project.repoPath,
    worktreeRoot: localSpec.worktreeRoot ?? config.project.worktreeRoot,
    binSuffix: localSpec.binSuffix,
  });
  for (const [name, spec] of Object.entries(declared)) {
    if (name === 'local') continue;
    if (spec.kind !== 'runner') throw new Error(`machines.${name}: kind desconocido "${spec.kind}"`);
    built[name] = makeRunner(name, spec);
  }
  cache = built;
  cacheKey = key;
  return built;
}

/** The real client by default; tests swap in a stand-in. */
let makeRunner = (name, spec) => new RunnerMachine(name, spec);
export function registerRunnerClient(factory) { makeRunner = factory; cache = null; }

/**
 * Guard for every function that acts on one project: omitting the project is a
 * bug in the caller, never a silent fall back to the default project.
 *
 * @param {unknown} projectId
 * @param {string} fn the calling function, for the message.
 * @returns {string} the project id.
 * @throws {Error} `falta el proyecto en <fn>` when it is not a non-empty string.
 */
export function requireProject(projectId, fn) {
  if (typeof projectId !== 'string' || !projectId) throw new Error(`missing project in ${fn}`);
  return projectId;
}

/**
 * The checkout a runner holds for a project, or null: `{repoPath, worktreeRoot}`.
 *
 * An entry in `config.machines[name].projects[projectId]` wins (both paths
 * required). Otherwise, when the runner declares `projectsRoot`, the paths
 * follow a convention: `<projectsRoot>/<folder>` and `<projectsRoot>/<folder>-wt`,
 * where `<folder>` is the last segment of the project's own `repoPath` on the
 * board — not the GitHub repo name, which does not always match the folder
 * (`EHR`, `MPSIA-TPOS-ACADEMIASYS`). Whether the checkout is actually there is
 * a different question, answered by the move preflight.
 */
export function declaredProject(name, projectId) {
  const spec = config.machines?.[name];
  const explicit = spec?.projects?.[projectId];
  if (explicit?.repoPath && explicit?.worktreeRoot) {
    return { repoPath: explicit.repoPath, worktreeRoot: explicit.worktreeRoot };
  }
  if (spec?.kind !== 'runner' || typeof spec.projectsRoot !== 'string' || !spec.projectsRoot.trim()) return null;
  const project = projectOf(projectId);
  const folder = String(project?.repoPath ?? '').split(/[\\/]+/).filter(Boolean).pop();
  if (!folder) return null;
  const root = spec.projectsRoot.trim().replace(/\/+$/, '');
  return { repoPath: `${root}/${folder}`, worktreeRoot: `${root}/${folder}-wt` };
}

/** Can this machine hold a task of this project? Local always; a runner only if it declares it. */
export function machineHostsProject(name, projectId) {
  if (projectId === DEFAULT_PROJECT_ID) return true;
  const kind = name === 'local' ? 'local' : config.machines?.[name]?.kind;
  return kind === 'local' || !!declaredProject(name, projectId);
}

/**
 * A machine as one project sees it.
 *
 * With two projects, "local" is no longer one thing: the same disk holds two
 * checkouts and two worktree roots, and a task of the second project that
 * asked for `machines().local` would cut its worktrees inside the first
 * project's `worktreeRoot`. Everything else about the machine — how it runs a
 * command, where it writes, which platform it is — is shared, so the second
 * project gets a *view* over the same machine, not a second machine.
 *
 * The default project deliberately does NOT go through the registry: it
 * returns `machines()[name]` exactly as before. The registry freezes its seed
 * on first load (`projects.js`, `load()`), while `machines()` follows the live
 * `config.project` — and several tests, plus the worktree fixtures, point
 * `config.project` at a temporary checkout and expect the machine to follow.
 * Reading the frozen seed instead would aim them at the real repository.
 *
 * No cache: the view is two property writes over a prototype, and caching it
 * would freeze `repoPath` the same way.
 *
 * @param {string} name a machine in `config.machines` (`'local'` when absent).
 * @param {string} projectId the project asking; required, absent throws.
 * @returns {LocalMachine|RunnerMachine} the machine, or a view over it.
 * @throws {Error} if the machine is unknown, the project is not registered, or
 *   a non-default project asks for a runner.
 */
export function machineFor(name, projectId) {
  requireProject(projectId, 'machineFor');
  const base = machines()[name];
  if (!base) throw new Error(`Machine "${name}" is not in config.machines`);
  if (projectId === DEFAULT_PROJECT_ID) return base;

  // A runner serves a non-default project only when its entry in
  // `config.machines` declares one (`projects: { <id>: { repoPath, worktreeRoot } }`):
  // guessing a path on another machine is how a session ends up cloning a
  // repository to get its bearings.
  if (base.kind !== 'local') {
    const declared = declaredProject(name, projectId);
    if (!declared) {
      throw new Error(
        `Project "${projectId}" is not declared on machine "${name}": `
        + 'declare it under machines.<name>.projects or set machines.<name>.projectsRoot, or only the default project runs there',
      );
    }
    // Not `Object.create(base)`: RunnerMachine keeps its plumbing in #private
    // methods, and those throw "Receiver must be an instance of class
    // RunnerMachine" when `this` is a derived object. Every member is read
    // from the real machine and every method runs on it; only the two paths
    // differ (nothing in the client reads them back through `this`).
    const paths = { repoPath: declared.repoPath, worktreeRoot: declared.worktreeRoot };
    return new Proxy(base, {
      get(target, prop) {
        if (Object.hasOwn(paths, prop)) return paths[prop];
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  const project = projectOf(projectId);
  if (!project) throw new Error(`machineFor: no project is registered as "${projectId}"`);

  const view = Object.create(base);
  view.repoPath = project.repoPath;
  view.worktreeRoot = project.worktreeRoot;
  return view;
}

/**
 * A machine as one task's project sees it, by NAME — {@link machineOf} for a
 * machine the task is not standing on: the one it is moving to, the one that
 * still holds a place, the one that recorded its Browser QA evidence.
 *
 * Never throws, and that is the whole point of it existing. `machines()[name]`
 * answered `undefined` for a machine that is not declared, so every caller grew
 * a road for «no machine»; {@link machineFor} answers with an exception instead,
 * and for one more reason — a non-default project on a runner, refused on
 * purpose. This hands back that refusal as `{ machine: null, error }` so those
 * callers can keep the road they have. Two of them must: `movePreflight` and
 * `moveBlockers` inspect both machines BEFORE `blockersFrom` gets to say
 * `project_not_movable`, so a throw there would be a 500 instead of a blocker.
 *
 * ⚠️ `name ?? 'local'` is deliberate and it is a change of behaviour from
 * `machines()[name]`: an old task with no `machine` used to read as `undefined`
 * (falsy, «no such machine») and now reads as local, which is what such a task
 * always was. The one caller where that matters is `pipeline.js`'s
 * `setTaskMachine`, and there it is unreachable: its own
 * `if (!machines()[name])` runs first and refuses the empty name.
 *
 * @param {object} task the task whose project decides the paths.
 * @param {string} [name] a machine in `config.machines`; absent means local.
 * @returns {{machine: LocalMachine|RunnerMachine|null, error: string|null}}
 */
export function machineViewFor(task, name) {
  try {
    return { machine: machineFor(name ?? 'local', task?.project), error: null };
  } catch (e) {
    return { machine: null, error: e.message };
  }
}

/**
 * The machine a task runs on, as that task's project sees it. A task without a
 * machine is a task from before: local. A task without a project cannot
 * happen (the store adopts one at load): `machineFor` throws.
 */
export function machineOf(task) {
  const name = task?.machine ?? 'local';
  // The same check `machineFor` makes, only to name the task in the message:
  // this one reaches a person reading a card.
  if (!machines()[name]) {
    throw new Error(`Task #${task?.issue} is on machine "${name}", which is not in config.machines`);
  }
  return machineFor(name, task?.project);
}

export const localMachine = () => machines().local;

/** Ends the process-wide Zen proxy. For tests: nothing else outlives the process. */
export async function closeZenProxy() {
  const proxy = zenProxy;
  zenProxy = null;
  zenProxyStart = null;
  if (proxy) await proxy.close();
}
