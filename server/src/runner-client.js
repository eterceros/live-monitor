import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { WebSocket } from 'ws';

import { isLoopbackUrl } from './loopback.js';

/**
 * A runner that refuses the connection, or that the tailnet cannot reach, is
 * **offline** — not an exception about the call that happened to notice.
 *
 * `fetch` says it the other way round: a bare `TypeError: fetch failed` whose
 * real reason hides in `cause` and whose stack carries no frame of ours. On
 * 2026-09-23 one of those, from a `runner-1` that had been down for hours,
 * reached Node as an unhandled rejection and took the whole board with it.
 *
 * So every request below goes through `#fetch`, which turns a connection-level
 * failure into an error that names the machine, the route and the reason,
 * carries `code: 'RUNNER_OFFLINE'` (and the original as `cause`), and records
 * the machine as unreachable — so the board can *say* it is offline instead of
 * printing `fetch failed` at whoever is looking.
 */
const OFFLINE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EHOSTUNREACH', 'EHOSTDOWN',
  'ENETUNREACH', 'ENETDOWN', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
]);

/**
 * The reads that may be repeated, by name. On 2026-09-24 the `runner_cli` step
 * of an upgrade died of a single `/fs/read` that hit `UND_ERR_CONNECT_TIMEOUT`
 * 22 s after a `claude install` that had in fact finished: one blink of the
 * tailnet was indistinguishable from a box that is gone.
 *
 * The list is written out rather than derived from the verb: a POST that reads
 * is safe to send twice, a POST that writes is not, and only the route says
 * which is which. What is here either reads or probes without leaving a trace
 * — `/port/free` binds and closes, `/daemon/find` is a filtered process list.
 *
 * `/exec` and `/shell` are here too, and only for what happens *before the
 * response headers*: the runner flushes them before it starts anything
 * (`streamed` in `runner/app.js`), so a connection that dies first means the
 * command never started, and one that died after the runner sent them makes
 * the runner abort the command (`res.on('close')`). Nothing after the headers
 * comes through `#fetch`: a broken stream is the caller's, as before. On
 * 2026-10-20..22, 96 of 132 "runner does not answer" failures of the board
 * were `/exec` → `UND_ERR_SOCKET` — a socket cut before a byte — and each one
 * parked a task on a blink of the tailnet.
 *
 * What is deliberately *not* here, and is tried exactly once as before: every
 * write (`/fs/write`, `/fs/mkdir`, `/fs/rm`, `/fs/copy`, `/fs/upload`),
 * `/daemon/kill`, `/zen-proxy/ensure` (it starts a process) and the
 * WebSockets, which do not come through here at all.
 */
const RETRYABLE_ROUTES = new Set([
  '/info', '/fs/exists', '/fs/read', '/fs/readdir', '/fs/readdir-deep', '/fs/realpath',
  '/fs/download', '/port/free', '/daemon/find', '/exec', '/shell',
]);

/**
 * Three attempts at most, waiting these between them, and none at all once
 * `RETRY_BUDGET_MS` has passed since the first one started. So a slow connect
 * timeout (~10 s) is never retried and the worst case stays near 16 s: the
 * long patience belongs to the caller with a deadline, not to this client.
 */
const RETRY_WAITS_MS = [300, 1000];
const RETRY_BUDGET_MS = 6000;

/** Sleeps, or returns early the moment the caller hangs up. */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** The reason under a `fetch failed`, however deep its `cause` chain, or null. */
export function offlineReason(error) {
  for (let e = error, depth = 0; e && typeof e === 'object' && depth < 5; e = e.cause, depth += 1) {
    if (typeof e.code === 'string' && OFFLINE_CODES.has(e.code)) return e.code;
  }
  return null;
}

/** What `#fetch` throws when the box is not there. */
export const isRunnerOffline = (e) => e?.code === 'RUNNER_OFFLINE';

/**
 * What the last call to each runner found: `{ online, reason, error, at }`.
 * `runnerEvents` fires `online` / `offline` on a change of mind only, so a box
 * that is down does not write a line per git command.
 */
const health = new Map();
export const runnerEvents = new EventEmitter();
export const runnerHealth = (name) => (name === undefined
  ? Object.fromEntries(health)
  : health.get(name) ?? null);

/** For tests: nothing else outlives the process. */
export const forgetRunnerHealth = () => health.clear();

function noteHealth(name, online, { reason = null, error = null } = {}) {
  const was = health.get(name);
  const entry = { online, reason, error, at: new Date().toISOString() };
  health.set(name, entry);
  // Only a change of mind is news, and only in this direction for `online`:
  // the first call of the board's life answering is not a box «coming back».
  if (online ? was?.online !== false : was?.online === false) return;
  runnerEvents.emit(online ? 'online' : 'offline', { machine: name, ...entry });
}

/**
 * The board's side of a runner: the same `Machine` interface as
 * `LocalMachine`, each call turned into a request to the dev box.
 *
 * Streams are what make it feel local. A command's lines arrive as NDJSON
 * while it runs; a daemon and a Claude process each get a WebSocket, and the
 * Claude one is wrapped as the `SpawnedProcess` the SDK asks for — stdin and
 * stdout as Node streams, exit as an event — so the SDK cannot tell the CLI
 * is on another machine. Which is the point: hooks, mid-turn messages and
 * the activity tree all keep working unchanged.
 */
export class RunnerMachine {
  kind = 'runner';

  constructor(name, { url, token, repoPath, worktreeRoot, binSuffix = '' }) {
    if (!url || !token) throw new Error(`machines.${name}: url and token are required`);
    this.name = name;
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.repoPath = repoPath;
    this.worktreeRoot = worktreeRoot;
    this.binSuffix = binSuffix;
    // Runners are POSIX; a Windows runner would say so in `info()` one day.
    this.platform = 'linux';
    this.path = path.posix;
    this.host = new URL(this.url).hostname;
    // Hundreds of small git calls per task ride fetch's own keep-alive pool.
    this.fs = new RemoteFs(this);
    this.daemon = new RemoteDaemons(this);
  }

  /**
   * POSIX on the far side, so exact. Separators are normalised first: git
   * prints forward slashes whatever the host, and a runner exercised on a
   * Windows host in the tests joins with backslashes.
   */
  samePath(a, b) {
    const norm = (p) => this.path.resolve(String(p ?? '').replace(/\\/g, '/'));
    return norm(a) === norm(b);
  }

  // --- plumbing -------------------------------------------------------------
  /**
   * Every request to this runner. A response — any response, even a 500 —
   * means the box is there; a connection that cannot be made means it is not,
   * and that is reported as such instead of as `fetch failed`. A caller's own
   * abort is passed through untouched: that is this board hanging up, not the
   * runner going away.
   *
   * A connection that cannot be made on a *readable* route is given two more
   * chances first, so a blink of the network does not cost a task. Two things
   * keep that cheap. A box already known to be down gets the single attempt it
   * got before — otherwise the header chip and `waitForRunner`, which asks
   * every 2 s while a runner restarts, would pay ~1.3 s per question. And the
   * machine is only written down as offline once the attempts are spent, so a
   * blink that recovered never fires an `offline` event.
   */
  async #fetch(route, init, what = route) {
    // Decided once, before the first attempt: what this call knew when it started.
    const retryable = RETRYABLE_ROUTES.has(route) && health.get(this.name)?.online !== false;
    const startedAt = Date.now();
    for (let attempt = 1; ; attempt += 1) {
      try {
        const res = await fetch(`${this.url}${route}`, init);
        noteHealth(this.name, true);
        return res;
      } catch (e) {
        if (init?.signal?.aborted) throw e;
        const reason = offlineReason(e);
        if (!reason) throw e;
        const wait = retryable ? RETRY_WAITS_MS[attempt - 1] : undefined;
        if (wait !== undefined && Date.now() - startedAt < RETRY_BUDGET_MS) {
          await sleep(wait, init?.signal);
          // Hung up while we waited: no further attempt, and the caller's own
          // `AbortError` — never the bare `fetch failed` of the attempt before.
          if (init?.signal?.aborted) throw init.signal.reason ?? e;
          continue;
        }
        const message = `${this.name}: ${what} → ${reason} (el runner no responde en ${this.url})`;
        noteHealth(this.name, false, { reason, error: message });
        throw Object.assign(new Error(message), {
          code: 'RUNNER_OFFLINE', machine: this.name, reason, cause: e,
        });
      }
    }
  }

  async #json(route, body, { method = 'POST', signal } = {}) {
    const res = await this.#fetch(route, {
      method,
      headers: { 'x-hfsmon-token': this.token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${this.name}: ${route} → ${data.error ?? res.status}`);
    return data;
  }

  /** NDJSON of `{line}` then `{result}`, fed to `onLine` as it arrives. */
  async #streamed(route, body, onLine, signal) {
    // Same contract as LocalMachine: a caller's abort resolves, it never rejects.
    // Closing the connection is what makes the runner kill the command.
    const aborted = () => ({ ok: false, code: -3, stdout: '', stderr: `${this.name}: [aborted by the caller]` });
    let res;
    try {
      res = await this.#fetch(route, {
        method: 'POST',
        headers: { 'x-hfsmon-token': this.token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal?.aborted) return aborted();
      throw e;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (signal?.aborted) return aborted();
      throw new Error(`${this.name}: ${route} → ${data.error ?? res.status}`);
    }
    const started = Date.now();
    let result = null;
    let buffer = '';
    const decoder = new TextDecoder();
    // Past the 2xx the command exists over there: a broken body is not an unreachable
    // runner (callers rely on a throw for that) but a result this board will never see,
    // so it resolves like any other failed command instead of throwing "terminated".
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.line !== undefined) onLine?.(msg.line);
          if (msg.result) result = msg.result;
        }
      }
    } catch (e) {
      if (signal?.aborted) return aborted();
      // A malformed frame is a bug on one side or the other, not a cut.
      if (e instanceof SyntaxError) throw e;
      const cause = e?.cause?.code ?? e?.code ?? e?.message;
      const secs = Math.round((Date.now() - started) / 1000);
      // The command's result is lost either way, but a connection that died at
      // the transport level says something about the box, and the board should
      // hear it now rather than at the next probe.
      const reason = offlineReason(e);
      if (reason) noteHealth(this.name, false, { reason, error: `${this.name}: ${route} → ${reason} (la conexión con el runner se cortó a mitad del comando)` });
      return {
        ok: false, code: -3, stdout: '',
        stderr: `${this.name}: la conexión con el runner se cortó a mitad del comando tras ${secs} s (${cause}); el runner termina el comando al perder la conexión y este tablero no tiene su resultado`,
      };
    }
    return result ?? { ok: false, code: -3, stdout: '', stderr: `${this.name}: la conexión se cortó sin resultado` };
  }

  ws(route, first) {
    const socket = new WebSocket(`${this.url.replace(/^http/, 'ws')}${route}`, {
      headers: { 'x-hfsmon-token': this.token },
    });
    socket.once('open', () => socket.send(JSON.stringify(first)));
    return socket;
  }

  // --- the interface --------------------------------------------------------
  exec(file, args, { cwd, env, onLine, timeoutMs, signal } = {}) {
    return this.#streamed('/exec', { file, args, cwd, env, timeoutMs }, onLine, signal);
  }

  shell(command, { cwd, env, onLine, timeoutMs, signal } = {}) {
    return this.#streamed('/shell', { command, cwd, env, timeoutMs }, onLine, signal);
  }

  // The runner is Linux: bash there is the sessions' shell. Over `/exec`, so
  // an un-upgraded runner already serves it (and `/bin/sh` may be dash).
  posixShell(command, opts = {}) {
    return this.exec('bash', ['-c', command], opts);
  }

  async portFree(port) { return (await this.#json('/port/free', { port })).value; }

  /** The Zen proxy's port on the runner — loopback *there*, for the CLI there. */
  async zenProxyPort() { return (await this.#json('/zen-proxy/ensure', {})).port; }

  async info() { return this.#json('/info', undefined, { method: 'GET' }); }

  /**
   * Uploads a local file so a Claude session on the runner can Read it.
   * `scope` is an issue number or `_proyecto` (a project chat); the runner
   * refuses anything else.
   */
  async putAttachment(scope, localPath, name) {
    const bytes = await readFile(localPath);
    const q = new URLSearchParams({ issue: String(scope), name: name ?? path.basename(localPath) });
    const res = await this.#fetch(`/fs/upload?${q}`, {
      method: 'PUT',
      headers: { 'x-hfsmon-token': this.token, 'content-type': 'application/octet-stream' },
      body: bytes,
    }, '/fs/upload');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${this.name}: subir adjunto → ${data.error ?? res.status}`);
    return data.path;
  }

  /**
   * What the SDK calls instead of spawning its own CLI. The `command` it
   * hands over is *its* CLI, here; the runner runs the `claude` it has, with
   * the same arguments. Only the SDK's own variables travel — never this
   * machine's PATH, HOME or API keys — so the CLI there runs with its login.
   *
   * The one exception is an `ANTHROPIC_API_KEY` aimed at a loopback base URL:
   * that is the runner's own Zen proxy, the key is the placeholder it throws
   * away, and `http://127.0.0.1:…` cannot reach Anthropic — so dropping the
   * key still buys nothing, while keeping the Max login the only credential
   * that ever points at Anthropic itself. `ANTHROPIC_AUTH_TOKEN` never travels.
   */
  get spawnClaude() {
    return (options) => {
      const env = {};
      // Parsed, not prefix-matched: `http://127.0.0.1:1@evil.com/x` would pass
      // a `startsWith` and send the credential to evil.com.
      const toProxy = isLoopbackUrl(options.env?.ANTHROPIC_BASE_URL);
      for (const [k, v] of Object.entries(options.env ?? {})) {
        const secret = /API_KEY|AUTH_TOKEN/.test(k) && !(toProxy && k === 'ANTHROPIC_API_KEY');
        if (/^(CLAUDE|ANTHROPIC)_/.test(k) && !secret && v !== undefined) env[k] = v;
      }
      return new RemoteProcess(this.ws('/claude', { start: { args: options.args, cwd: options.cwd, env } }), options.signal);
    };
  }

  _json(route, body, opts) { return this.#json(route, body, opts); }

  /** The two routes below answer with bytes, not JSON, so they build their own request. */
  _fetch(route, init, what) { return this.#fetch(route, init, what); }
}

class RemoteFs {
  constructor(m) { this.m = m; }
  /** `signal`: a probe of a box that went silent must not leave a fetch pending per click. */
  async exists(p, { signal } = {}) { return (await this.m._json('/fs/exists', { path: p }, { signal })).value; }
  async readFile(p) { return (await this.m._json('/fs/read', { path: p })).value; }
  async tail(p, bytes) { return (await this.m._json('/fs/read', { path: p, tail: bytes })).value; }
  async writeFile(p, data) { await this.m._json('/fs/write', { path: p, data: String(data) }); }
  async mkdir(p) { await this.m._json('/fs/mkdir', { path: p }); }
  async rm(p, { retries = 0 } = {}) { await this.m._json('/fs/rm', { path: p, retries }); }
  async readdir(p) { return (await this.m._json('/fs/readdir', { path: p })).value; }
  async readdirDeep(p) { return (await this.m._json('/fs/readdir-deep', { path: p })).value; }
  async copy(from, to) { await this.m._json('/fs/copy', { from, to }); }

  /**
   * `{ path, size, isFile }` on the runner. Its own fetch rather than `_json`:
   * the caller needs the error's `code` (ENOENT is a missing file) and must
   * tell a missing file from a runner too old to have the route, whose 404
   * comes from express with no JSON — `code: 'NO_ROUTE'` lets the caller fall
   * back to `realpath -e` instead of reporting a file that may well exist.
   */
  async realpath(p, { signal } = {}) {
    const res = await this.m._fetch('/fs/realpath', {
      method: 'POST',
      headers: { 'x-hfsmon-token': this.m.token, 'content-type': 'application/json' },
      body: JSON.stringify({ path: p }),
      signal,
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data) return data.value;
    if (res.status === 404 && data === null) {
      throw Object.assign(new Error(`${this.m.name}: the runner has no /fs/realpath`), { code: 'NO_ROUTE' });
    }
    throw Object.assign(new Error(`${this.m.name}: /fs/realpath → ${data?.error ?? res.status}`), { code: data?.code });
  }
  /** `signal` lets the file viewer give up on a transfer that takes too long. */
  async readBinary(p, { signal } = {}) {
    const res = await this.m._fetch('/fs/download', {
      method: 'POST',
      headers: { 'x-hfsmon-token': this.m.token, 'content-type': 'application/json' },
      body: JSON.stringify({ path: p }),
      signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(`${this.m.name}: descargar ${p} → ${data.error ?? res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}

class RemoteDaemons {
  constructor(m) { this.m = m; }

  /** Same handle as the local one: `pid`, `on('line')`, `on('exit')`, `kill()`. */
  spawn(bin, { cwd, env, args = [] }) {
    const handle = new EventEmitter();
    handle.pid = null;
    const socket = this.m.ws('/daemon', { spawn: { bin, cwd, env, args } });
    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.pid !== undefined) handle.pid = msg.pid;
      if (msg.line !== undefined) handle.emit('line', msg.line);
      if (msg.exit) handle.emit('exit', msg.exit.code);
      if (msg.error) handle.emit('exit', null, new Error(msg.error));
    });
    socket.on('error', (e) => handle.emit('exit', null, e));
    handle.kill = () => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ kill: true })); };
    return handle;
  }

  async find(prefix, binNames = []) { return (await this.m._json('/daemon/find', { prefix, binNames })).value; }
  async kill(pid) { await this.m._json('/daemon/kill', { pid }); }
}

/**
 * A `claude` on the runner, shaped as the `SpawnedProcess` the SDK expects:
 * `stdin` it writes to, `stdout` it reads from, `kill`, and `exit`/`error`
 * events. Everything the SDK sends becomes a `{stdin}` frame; every
 * `{stdout}` frame is pushed into the readable, byte for byte.
 */
class RemoteProcess extends EventEmitter {
  killed = false;
  exitCode = null;
  signalCode = null;

  constructor(socket, signal) {
    super();
    this.socket = socket;
    this.stdout = new Readable({ read() {} });
    this.stdin = new Writable({
      write: (chunk, _enc, cb) => {
        const text = chunk.toString('utf8');
        if (socket.readyState === WebSocket.OPEN) { socket.send(JSON.stringify({ stdin: text }), cb); }
        else socket.once('open', () => socket.send(JSON.stringify({ stdin: text }), cb));
      },
      final: (cb) => { this.#send({ end: true }); cb(); },
    });
    let exited = false;
    const finish = (code, sig) => {
      if (exited) return;
      exited = true;
      this.exitCode = code;
      this.signalCode = sig ?? null;
      this.stdout.push(null);
      this.emit('exit', code, sig ?? null);
    };
    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.stdout !== undefined) this.stdout.push(Buffer.from(msg.stdout, 'utf8'));
      if (msg.stderr !== undefined) process.stderr.write(msg.stderr);
      if (msg.exit) finish(msg.exit.code, msg.exit.signal);
      if (msg.error) this.emit('error', new Error(msg.error));
    });
    socket.on('error', (e) => { this.emit('error', e); finish(null, null); });
    socket.on('close', () => finish(this.exitCode, this.signalCode));
    signal?.addEventListener('abort', () => this.kill('SIGTERM'), { once: true });
  }

  #send(obj) {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(obj));
  }

  kill(sig = 'SIGTERM') {
    this.killed = true;
    this.#send({ kill: sig });
    return true;
  }
}
