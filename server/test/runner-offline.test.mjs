import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * A runner that is not there.
 *
 * On 2026-09-23 the board died of exactly this: `runner-1` had been down
 * for hours, a `fetch` to its runner rejected with `ECONNREFUSED` on a promise
 * nobody was holding, and Node ended the process with every task in flight in
 * it. What is proved here, against a real closed port:
 *
 *   1. the client calls it offline — an error that names the machine, the
 *      route and the reason, not a bare `TypeError: fetch failed`;
 *   2. the board's machines block ends at `online: false` with that reason,
 *      which is what the header chip and the upgrade dialog already draw;
 *   3. a rejection nobody handled is logged whole and the process stays up.
 */

const DIR = mkdtempSync(path.join(tmpdir(), 'hfsmon-offline-'));
process.env.HFSMON_DATA_DIR = DIR;
process.env.HFSMON_NO_AUTOSTART = '1';

const SRC = path.join(fileURLToPath(new URL('..', import.meta.url)), 'src');
const { RunnerMachine, runnerHealth, runnerEvents, forgetRunnerHealth, isRunnerOffline } = await import('../src/runner-client.js');
const { config } = await import('../src/config.js');
const { registerRunnerClient } = await import('../src/machine.js');

// A port that was free a moment ago and has nothing on it now: connecting to
// it is refused at once, which is what a runner that is down looks like.
const gone = await new Promise((resolve) => {
  const srv = createServer(() => {});
  srv.listen(0, '127.0.0.1', () => resolve(srv));
});
const DEAD_PORT = gone.address().port;
await new Promise((r) => gone.close(r));
const DEAD_URL = `http://127.0.0.1:${DEAD_PORT}`;

const machine = (name = 'devbox') => new RunnerMachine(name, {
  url: DEAD_URL, token: 'secreto', repoPath: '/home/user/src/hfs', worktreeRoot: '/home/user/src/hfs-wt',
});

after(() => {
  rmSync(DIR, { recursive: true, force: true, maxRetries: 3 });
});

// --- 1. the client -----------------------------------------------------------

test('un runner que rechaza la conexión es un error que se explica, no «fetch failed»', async () => {
  forgetRunnerHealth();
  const m = machine();
  const e = await m.info().then(() => null, (err) => err);
  assert.ok(e, 'info() sobre un runner caído tiene que fallar');
  assert.equal(e.code, 'RUNNER_OFFLINE');
  assert.equal(isRunnerOffline(e), true);
  assert.equal(e.machine, 'devbox');
  assert.equal(e.reason, 'ECONNREFUSED');
  // Lo que verá una persona: la máquina, la ruta, el motivo y dónde se buscó.
  assert.match(e.message, /devbox/);
  assert.match(e.message, /\/info/);
  assert.match(e.message, /ECONNREFUSED/);
  assert.match(e.message, new RegExp(DEAD_PORT.toString()));
  // El original no se pierde: sigue colgando de `cause`.
  assert.match(String(e.cause?.message ?? ''), /fetch failed/i);
});

test('un comando en streaming falla igual de explicado', async () => {
  forgetRunnerHealth();
  const m = machine();
  const e = await m.exec('git', ['rev-parse', 'HEAD'], { cwd: '/tmp' }).then(() => null, (err) => err);
  assert.ok(e, 'exec() sobre un runner caído tiene que fallar');
  assert.equal(e.code, 'RUNNER_OFFLINE');
  assert.match(e.message, /\/exec → ECONNREFUSED/);
});

test('la máquina queda anotada como caída, y solo se anuncia al cambiar de opinión', async () => {
  forgetRunnerHealth();
  const seen = [];
  const onOffline = (ev) => seen.push(ev);
  runnerEvents.on('offline', onOffline);
  try {
    const m = machine();
    await Promise.allSettled([m.info(), m.portFree(7420), m.fs.exists('/tmp')]);
    const health = runnerHealth('devbox');
    assert.equal(health.online, false);
    assert.equal(health.reason, 'ECONNREFUSED');
    assert.match(health.error, /ECONNREFUSED/);
    assert.equal(seen.length, 1, 'tres llamadas fallidas, un solo aviso');
    assert.equal(seen[0].machine, 'devbox');
  } finally {
    runnerEvents.off('offline', onOffline);
  }
});

test('la máquina local no aparece en el registro de runners', () => {
  forgetRunnerHealth();
  assert.equal(runnerHealth('local'), null);
});

// --- 2. what the board says --------------------------------------------------

test('la detección deja el runner en online:false con su motivo', async () => {
  forgetRunnerHealth();
  const savedMachines = config.machines;
  config.machines = {
    local: { kind: 'local', repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot },
    devbox: { kind: 'runner', url: DEAD_URL, token: 'secreto', repoPath: '/home/user/src/hfs', worktreeRoot: '/home/user/src/hfs-wt' },
  };
  registerRunnerClient((name, spec) => new RunnerMachine(name, spec));

  try {
  const { upgradeHooks, checkUpgrade } = await import('../src/upgrade.js');
  // Nada de red ni de git: lo que se mira aquí es el bloque de máquinas.
  upgradeHooks.fetchRegistry = async () => ({ status: 500, body: null });
  upgradeHooks.git = async () => ({ ok: false, stdout: '', stderr: 'sin git en esta prueba', code: 1 });
  upgradeHooks.sdkVersion = () => '0.3.281';

  const state = await checkUpgrade({ fresh: true });
  const found = state.machines.devbox;
  assert.ok(found, 'el runner tiene que aparecer en el bloque de máquinas');
  assert.equal(found.online, false);
  assert.equal(found.ok, false);
  assert.match(found.error, /ECONNREFUSED/, 'el motivo llega a la interfaz, no un «fetch failed» mudo');
  assert.equal(state.machines.local.kind, 'local');
  } finally {
    config.machines = savedMachines;
  }
});

// --- 3. the net under the process -------------------------------------------

/** Runs a script in a child node, and says how it went. */
function child(body) {
  const file = path.join(DIR, `child-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, body, 'utf8');
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
}

const GUARD = pathToFileURL(path.join(SRC, 'crashguard.js')).href;
const CLIENT = pathToFileURL(path.join(SRC, 'runner-client.js')).href;

// The floating fetch of that night, reproduced: `m.info()` with nobody
// holding it, against a runner that is not there.
const floatingCall = [
  `import { installCrashGuard } from ${JSON.stringify(GUARD)};`,
  `import { RunnerMachine, runnerHealth } from ${JSON.stringify(CLIENT)};`,
  'let logged = null;',
  'installCrashGuard({ started: () => STARTED, log: (line) => { logged = line; process.stderr.write(line + "\\n"); } });',
  `const m = new RunnerMachine('devbox', { url: ${JSON.stringify(DEAD_URL)}, token: 't', repoPath: '/r', worktreeRoot: '/w' });`,
  'm.info();',
  'let waited = 0;',
  'const look = () => {',
  '  if (logged) {',
  '    process.stdout.write("VIVO " + JSON.stringify(runnerHealth("devbox")) + "\\n");',
  '    process.exit(0);',
  '  }',
  '  waited += 50;',
  '  if (waited > 10000) { process.stdout.write("SIN RECHAZO\\n"); process.exit(3); }',
  '  setTimeout(look, 50);',
  '};',
  'look();',
].join('\n');

test('un rechazo sin manejar se registra entero y el tablero sigue vivo', () => {
  const r = child(floatingCall.replace('STARTED', 'true'));
  assert.equal(r.code, 0, `el proceso no debía morir (stderr: ${r.stderr})`);
  assert.match(r.stdout, /VIVO /);
  assert.match(r.stdout, /"online":false/, 'y la máquina queda marcada como caída');
  // Tan visible en el log como antes: el tipo de fallo, el error y su causa.
  assert.match(r.stderr, /unhandledRejection/);
  assert.match(r.stderr, /ECONNREFUSED/);
  assert.match(r.stderr, /RUNNER_OFFLINE/);
});

test('antes de escuchar en el puerto, el mismo fallo sigue siendo mortal', () => {
  const r = child(floatingCall.replace('STARTED', 'false'));
  assert.equal(r.code, 1, 'un arranque que no llega a abrir el puerto tiene que morir a la vista');
  assert.match(r.stderr, /ECONNREFUSED/);
  assert.match(r.stderr, /no llegó a arrancar/);
});

// --- 4. a blink of the network is not a box that is gone ---------------------

/**
 * On 2026-09-24 the `runner_cli` step died of one `/fs/read` that hit
 * `UND_ERR_CONNECT_TIMEOUT` 22 s after a `claude install` that had finished
 * fine: the first connection failure was the verdict. Readable routes now get
 * up to three attempts; everything else still gets exactly one. What is proved
 * below, with real servers and real sockets rather than a stubbed `fetch`:
 * which routes retry, that an answer — even a 500 — ends it, that the caller's
 * abort wins, and that the whole thing stays far inside a second and a half.
 */

/** An HTTP server on loopback; `onConnection` can cut sockets before a byte. */
async function listening(handler, onConnection) {
  const srv = createServer(handler ?? ((_req, res) => res.end('{}')));
  if (onConnection) srv.on('connection', onConnection);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${srv.address().port}`,
    stop: () => srv.close(),
    close: async () => { srv.closeAllConnections?.(); await new Promise((r) => srv.close(() => r())); },
  };
}

const machineAt = (url, name = 'devbox') => new RunnerMachine(name, {
  url, token: 'secreto', repoPath: '/home/user/src/hfs', worktreeRoot: '/home/user/src/hfs-wt',
});

/** Collects `offline` announcements while a test runs. */
function offlineWatcher() {
  const seen = [];
  const on = (ev) => seen.push(ev);
  runnerEvents.on('offline', on);
  return { seen, stop: () => runnerEvents.off('offline', on) };
}

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

test('un parpadeo: las dos primeras conexiones se cortan, la lectura sale bien y nadie anuncia nada', async () => {
  forgetRunnerHealth();
  let toCut = 2;
  let requests = 0;
  const srv = await listening((_req, res) => { requests += 1; json(res, { value: true }); },
    (socket) => { if (toCut > 0) { toCut -= 1; socket.destroy(); } });
  const w = offlineWatcher();
  try {
    const value = await machineAt(srv.url).fs.exists('/home/user');
    assert.equal(value, true, 'el tercer intento contesta y el llamante no se entera del parpadeo');
    assert.equal(toCut, 0, 'las dos primeras conexiones se cortaron de verdad');
    assert.equal(requests, 1, 'y solo una petición llegó entera');
    assert.equal(w.seen.length, 0, 'un parpadeo que se recupera no emite «offline»');
    assert.equal(runnerHealth('devbox').online, true);
  } finally { w.stop(); await srv.close(); }
});

test('un 500 es una máquina que está: una sola petición, sin reintento', async () => {
  forgetRunnerHealth();
  let requests = 0;
  const srv = await listening((_req, res) => { requests += 1; json(res, { error: 'boom' }, 500); });
  try {
    const m = machineAt(srv.url);
    const e = await m.fs.readFile('/tmp/x').then(() => null, (err) => err);
    assert.ok(e, 'un 500 sigue siendo un error');
    assert.equal(e.code, undefined, 'pero no un RUNNER_OFFLINE');
    assert.equal(requests, 1, 'una respuesta HTTP zanja la pregunta: no se repite');
    assert.equal(runnerHealth('devbox').online, true, 'y la caja consta como viva');
  } finally { await srv.close(); }
});

test('las escrituras no se reintentan nunca: un intento', async () => {
  const conns = { n: 0 };
  const srv = await listening(null, (socket) => { conns.n += 1; socket.destroy(); });
  try {
    forgetRunnerHealth();
    const write = await machineAt(srv.url).fs.writeFile('/tmp/x', 'hola').then(() => null, (e) => e);
    assert.equal(write?.code, 'RUNNER_OFFLINE');
    assert.equal(conns.n, 1, '/fs/write se intenta una sola vez');
  } finally { await srv.close(); }
});

test('/exec con la conexión cortada antes de la primera respuesta se reintenta, y el comando corre una sola vez', async () => {
  forgetRunnerHealth();
  let toCut = 2;
  let ran = 0;
  const srv = await listening((_req, res) => {
    ran += 1;
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.end(`${JSON.stringify({ line: 'ok' })}\n${JSON.stringify({ result: { ok: true, code: 0, stdout: 'ok', stderr: '' } })}\n`);
  }, (socket) => { if (toCut > 0) { toCut -= 1; socket.destroy(); } });
  const w = offlineWatcher();
  try {
    const r = await machineAt(srv.url).exec('git', ['status'], { cwd: '/tmp' });
    assert.equal(r.ok, true, 'el tercer intento contesta y el llamante no se entera del corte');
    assert.equal(toCut, 0, 'las dos primeras conexiones se cortaron de verdad');
    assert.equal(ran, 1, 'el comando llegó a correr una sola vez');
    assert.equal(w.seen.length, 0, 'un corte que se recupera no emite «offline»');
  } finally { w.stop(); await srv.close(); }
});

test('/exec sin ninguna respuesta tras los tres intentos: RUNNER_OFFLINE y tres conexiones', async () => {
  const conns = { n: 0 };
  const srv = await listening(null, (socket) => { conns.n += 1; socket.destroy(); });
  try {
    forgetRunnerHealth();
    const exec = await machineAt(srv.url).exec('git', ['status'], { cwd: '/tmp' }).then(() => null, (e) => e);
    assert.equal(exec?.code, 'RUNNER_OFFLINE');
    assert.equal(conns.n, 3, '/exec se intenta tres veces como las lecturas');
  } finally { await srv.close(); }
});

test('si el llamante aborta durante la espera, no hay más intentos y su error sale intacto', async () => {
  forgetRunnerHealth();
  let conns = 0;
  const srv = await listening(null, (socket) => { conns += 1; socket.destroy(); });
  const w = offlineWatcher();
  try {
    const ctrl = new AbortController();
    // El segundo intento cae a los ~300 ms y abre una espera de 1 s: aquí dentro.
    const timer = setTimeout(() => ctrl.abort(), 450);
    const started = Date.now();
    const e = await machineAt(srv.url).fs.exists('/tmp', { signal: ctrl.signal }).then(() => null, (err) => err);
    const elapsed = Date.now() - started;
    clearTimeout(timer);
    assert.ok(e, 'la llamada abortada falla');
    assert.equal(e.name, 'AbortError', 'sale el error del abort del llamante, no el «fetch failed» del intento anterior');
    assert.notEqual(e.code, 'RUNNER_OFFLINE', 'y desde luego no una máquina declarada caída');
    assert.equal(conns, 2, 'no se intentó una tercera vez');
    // El único testigo de que la espera despierta con el abort: si no, serían ~1300 ms.
    assert.ok(elapsed < 800, `sale en cuanto se aborta, no al acabar la espera (tardó ${elapsed} ms)`);
    assert.equal(w.seen.length, 0, 'colgar el teléfono no es declarar la máquina caída');
    assert.equal(runnerHealth('devbox')?.online ?? null, null, 'ni se anota nada de su salud');
  } finally { w.stop(); await srv.close(); }
});

test('agotados los intentos: el error de siempre, un solo aviso, y el motivo del último intento', async () => {
  forgetRunnerHealth();
  let conns = 0;
  let srv;
  srv = await listening(null, (socket) => {
    conns += 1;
    socket.destroy();
    // A la segunda, la caja desaparece: el tercer intento se encuentra el puerto cerrado.
    if (conns === 2) srv.stop();
  });
  const w = offlineWatcher();
  try {
    const m = machineAt(srv.url);
    const e = await m.fs.readFile('/tmp/x').then(() => null, (err) => err);
    assert.ok(e, 'tres intentos fallidos siguen siendo un fallo');
    assert.equal(e.code, 'RUNNER_OFFLINE', 'con la forma de error de siempre');
    assert.equal(e.machine, 'devbox');
    assert.equal(e.reason, 'ECONNREFUSED', 'el motivo es el del último intento, no el del primero');
    assert.equal(conns, 2, 'los dos primeros intentos sí llegaron a conectar');
    assert.match(e.message, /devbox/);
    assert.match(e.message, /\/fs\/read/);
    assert.match(e.message, /ECONNREFUSED/);
    assert.match(e.message, new RegExp(new URL(m.url).port));
    assert.ok(e.cause, 'y el original sigue colgando de `cause`');
    assert.equal(w.seen.length, 1, 'un solo «offline» por toda la tanda');
    assert.equal(runnerHealth('devbox').online, false);
    assert.equal(runnerHealth('devbox').reason, 'ECONNREFUSED');
  } finally { w.stop(); await srv.close(); }
});

test('una caja que ya consta caída se pregunta una sola vez', async () => {
  forgetRunnerHealth();
  let conns = 0;
  const srv = await listening(null, (socket) => { conns += 1; socket.destroy(); });
  try {
    const m = machineAt(srv.url);
    // Una escritura no se reintenta nunca: una conexión, y la máquina ya consta caída.
    await m.fs.writeFile('/tmp/x', 'hola').catch(() => {});
    assert.equal(runnerHealth('devbox').online, false);
    assert.equal(conns, 1);

    const e = await m.fs.exists('/tmp').then(() => null, (err) => err);
    assert.equal(e?.code, 'RUNNER_OFFLINE');
    assert.equal(conns, 2, 'la lectura tampoco insiste mientras la caja conste caída');
  } finally { await srv.close(); }
});

test('el peor caso con la conexión rechazada se queda muy por debajo de 4 s', async () => {
  forgetRunnerHealth();
  const m = machine();
  const started = Date.now();
  const e = await m.fs.readFile('/tmp/x').then(() => null, (err) => err);
  const elapsed = Date.now() - started;
  assert.equal(e?.code, 'RUNNER_OFFLINE');
  assert.ok(elapsed < 4000, `tres intentos y dos esperas cortas: ${elapsed} ms`);
});

test('las sondas sin efectos también aguantan un parpadeo: /port/free y /fs/download', async () => {
  forgetRunnerHealth();
  let toCut = 1;
  const srv = await listening((req, res) => {
    if (req.url === '/fs/download') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end('evidencia'); return; }
    json(res, { value: true });
  }, (socket) => { if (toCut > 0) { toCut -= 1; socket.destroy(); } });
  try {
    const m = machineAt(srv.url);
    assert.equal(await m.portFree(7420), true, 'la sonda de puerto no se rinde al primer corte');
    toCut = 1;
    assert.equal((await m.fs.readBinary('/tmp/shot.png')).toString(), 'evidencia', 'ni la descarga de una evidencia de QA');
    assert.equal(runnerHealth('devbox').online, true);
  } finally { await srv.close(); }
});
