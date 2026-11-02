import './isolate.mjs';   // primero: aisla el directorio de datos
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { LocalMachine, machines, machineOf, registerRunnerClient, closeZenProxy, registerZenProxyFactory } from '../src/machine.js';
import { config } from '../src/config.js';
import { run } from '../src/exec.js';

/**
 * `LocalMachine` is where the board's assumptions about "here" now live, in
 * two flavours. The Windows one is what ran before; the POSIX one is what the
 * runner serves on the dev box. Both are built here on purpose, whatever this
 * test runs on: the path arithmetic and the comparisons must not depend on the
 * host, only on the machine they describe.
 */

test('cada máquina hace las cuentas de rutas a su manera, no a la del proceso', () => {
  const win = new LocalMachine('w', { platform: 'win32', repoPath: 'C:\\src\\hfs', worktreeRoot: 'C:\\src\\hfs-wt' });
  const nix = new LocalMachine('n', { platform: 'linux', repoPath: '/home/user/src/hfs', worktreeRoot: '/home/user/src/hfs-wt' });

  assert.equal(win.path.join(win.worktreeRoot, 'feat-1'), 'C:\\src\\hfs-wt\\feat-1');
  assert.equal(nix.path.join(nix.worktreeRoot, 'feat-1'), '/home/user/src/hfs-wt/feat-1');
  assert.equal(win.binSuffix, '.exe');
  assert.equal(nix.binSuffix, '');
  assert.equal(new LocalMachine('x', { platform: 'linux', binSuffix: '.bin' }).binSuffix, '.bin', 'configurable');
});

test('Windows compara rutas sin mayúsculas; POSIX no', () => {
  const win = new LocalMachine('w', { platform: 'win32' });
  const nix = new LocalMachine('n', { platform: 'linux' });
  assert.equal(win.samePath('C:\\Src\\Hfs\\.git', 'c:\\src\\hfs\\.git'), true);
  assert.equal(win.samePath('C:/src/hfs/.git', 'C:\\src\\hfs\\.git'), true, 'y da igual el separador');
  assert.equal(nix.samePath('/home/User/hfs/.git', '/home/user/hfs/.git'), false);
  assert.equal(nix.samePath('/home/user/hfs/.git', '/home/user/hfs/.git'), true);
});

test('exec y shell son los de exec.js: salida, código y líneas', async () => {
  const m = new LocalMachine('here');
  const r = await m.exec('git', ['--version']);
  assert.equal(r.ok, true);
  assert.match(r.stdout, /git version/);
  const lines = [];
  const sh = await m.shell('echo uno && echo dos', { onLine: (l) => lines.push(l) });
  assert.equal(sh.ok, true);
  assert.deepEqual(lines, ['uno', 'dos']);
  const bad = await m.exec('git', ['no-existe-este-comando']);
  assert.equal(bad.ok, false);
});

test('el env que se pasa se suma al de la máquina, nunca lo sustituye', async () => {
  // A command that only sees the passed env would have no PATH and no git.
  const m = new LocalMachine('here');
  const r = await m.exec('git', ['--version'], { env: { HFSMON_PROBE: '1' } });
  assert.equal(r.ok, true, 'git sigue encontrándose con un env parcial');
});

/** Resolves true once `pid` no longer exists, false if it outlives `ms`. */
async function goneWithin(pid, ms) {
  const until = Date.now() + ms;
  for (;;) {
    try { process.kill(pid, 0); } catch { return true; }
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('abortar la señal mata el comando y resuelve con -3, sin rechazar', async () => {
  const ac = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ac.abort(), 100);
  const r = await run(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { signal: ac.signal });
  assert.equal(r.ok, false);
  assert.equal(r.code, -3);
  assert.match(r.stderr, /aborted/);
  assert.ok(Date.now() - t0 < 2000, 'muy por debajo de 2 s');
});

test('una señal ya abortada resuelve con -3 enseguida', async () => {
  const t0 = Date.now();
  const r = await run(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { signal: AbortSignal.abort() });
  assert.equal(r.ok, false);
  assert.equal(r.code, -3);
  assert.ok(Date.now() - t0 < 2000);
});

// The background `sleep` is a grandchild: only a process-group kill reaches it.
test('abortar mata también lo que el comando lanzó', { skip: process.platform === 'win32' }, async () => {
  const ac = new AbortController();
  let pid = null;
  const r = await run('sh', ['-c', 'sleep 30 & echo $!; wait'], {
    signal: ac.signal,
    onLine: (l) => { if (pid === null) { pid = Number(l); ac.abort(); } },
  });
  assert.equal(r.code, -3);
  assert.ok(pid > 0);
  assert.equal(await goneWithin(pid, 2000), true, 'el sleep nieto ha muerto');
});

test('el timeout mata también lo que el comando lanzó', { skip: process.platform === 'win32' }, async () => {
  let pid = null;
  const r = await run('sh', ['-c', 'sleep 30 & echo $!; wait'], {
    timeoutMs: 300,
    onLine: (l) => { if (pid === null) pid = Number(l); },
  });
  assert.equal(r.code, -2);
  assert.match(r.stderr, /timeout after 300ms/);
  assert.ok(pid > 0);
  assert.equal(await goneWithin(pid, 2000), true, 'el sleep nieto ha muerto');
});

test('fs: existe, lee, escribe, lista, copia, borra, y tail devuelve el final', async () => {
  const m = new LocalMachine('here');
  const dir = mkdtempSync(path.join(tmpdir(), 'hfsmon-machine-'));
  try {
    const f = path.join(dir, 'a.txt');
    assert.equal(await m.fs.exists(f), false);
    await m.fs.writeFile(f, 'hola\n');
    assert.equal(await m.fs.exists(f), true);
    assert.equal(await m.fs.readFile(f), 'hola\n');
    await m.fs.mkdir(path.join(dir, 'sub', 'deep'));
    await m.fs.copy(f, path.join(dir, 'sub', 'b.txt'));
    assert.deepEqual((await m.fs.readdir(path.join(dir, 'sub'))).sort(), ['b.txt', 'deep']);

    writeFileSync(f, `${'x'.repeat(100)}FINAL`);
    const t = await m.fs.tail(f, 10);
    assert.equal(t, '…xxxxxFINAL', 'los últimos bytes, marcados como cola');
    assert.equal(await m.fs.tail(f, 1000), `${'x'.repeat(100)}FINAL`, 'entero si cabe');

    await m.fs.rm(path.join(dir, 'sub'));
    assert.equal(await m.fs.exists(path.join(dir, 'sub')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('un demonio: pid, líneas, salida y kill', async () => {
  const m = new LocalMachine('here');
  const lines = [];
  const exited = new Promise((resolve) => {
    const h = m.daemon.spawn(process.execPath, {
      cwd: tmpdir(),
      env: { HFSMON_DAEMON_PROBE: 'ping' },
    });
    // No args: node reads the script from stdin, and with none it exits 0
    // after printing nothing. Enough to prove the handle's shape.
    h.on('line', (l) => lines.push(l));
    h.on('exit', (code) => resolve({ pid: h.pid, code }));
    assert.equal(typeof h.pid, 'number');
    assert.equal(typeof h.kill, 'function');
    setTimeout(() => h.kill(), 300);
  });
  const { pid, code } = await exited;
  assert.ok(pid > 0);
  assert.ok(code === null || typeof code === 'number');
});

test('info dice dónde está el home, que es donde viven los transcripts de Claude', async () => {
  const info = await new LocalMachine('here').info();
  assert.equal(typeof info.home, 'string');
  assert.ok(info.home.length > 0);
});

test('un puerto ocupado no está libre; uno al azar sí', async () => {
  const m = new LocalMachine('here');
  const net = await import('node:net');
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '0.0.0.0', r));
  const { port } = srv.address();
  try {
    assert.equal(await m.portFree(port), false);
  } finally {
    await new Promise((r) => srv.close(r));
  }
  assert.equal(await m.portFree(port), true, 'liberado');
});

test('sin config.machines hay exactamente local, hecha de config.project', () => {
  const before = { machines: config.machines, project: { ...config.project } };
  try {
    delete config.machines;
    config.project = { ...config.project, repoPath: '/r', worktreeRoot: '/w' };
    const all = machines();
    assert.deepEqual(Object.keys(all), ['local']);
    assert.equal(all.local.repoPath, '/r');
    assert.equal(all.local.worktreeRoot, '/w');
    assert.equal(machineOf({ issue: 1, project: 'hfs' }).name, 'local', 'una tarea sin máquina es de antes: local');
    assert.equal(machineOf({ issue: 1, project: 'hfs', machine: 'local' }).name, 'local');
    assert.throws(() => machineOf({ issue: 7, project: 'hfs', machine: 'marte' }), /marte/);
    assert.throws(() => machineOf({ issue: 1 }), /missing project/, 'una tarea sin proyecto no cae a hfs');
  } finally {
    if (before.machines !== undefined) config.machines = before.machines;
    config.project = before.project;
  }
});

test('una máquina runner declarada pasa por el cliente registrado', () => {
  const before = { machines: config.machines, project: { ...config.project } };
  try {
    config.machines = { devbox: { kind: 'runner', url: 'http://devbox:7421', token: 't', repoPath: '/x', worktreeRoot: '/y' } };
    registerRunnerClient((name, spec) => ({ name, kind: 'runner', spec }));
    const all = machines();
    assert.deepEqual(Object.keys(all).sort(), ['devbox', 'local']);
    assert.equal(all.devbox.spec.url, 'http://devbox:7421');
    assert.equal(machineOf({ issue: 1, project: 'hfs', machine: 'devbox' }).kind, 'runner');
    config.machines = { raro: { kind: 'ssh' } };
    assert.throws(() => machines(), /kind desconocido/);
  } finally {
    if (before.machines !== undefined) config.machines = before.machines; else delete config.machines;
    config.project = before.project;
    registerRunnerClient((name) => { throw new Error(`machines.${name}: el cliente del runner no está cargado`); });
  }
});

after(() => closeZenProxy());

test('el proxy de Zen es uno por proceso: el mismo puerto siempre, y está escuchando', async () => {
  // Two instances on purpose: the proxy belongs to the process, not to a
  // `LocalMachine`. (`localMachine()` is not usable here: an earlier test
  // leaves a runner factory that throws for the declared machines.)
  const first = await new LocalMachine('here').zenProxyPort();
  const second = await new LocalMachine('otra').zenProxyPort();
  assert.equal(typeof first, 'number');
  assert.ok(first > 0);
  assert.equal(second, first, 'no se arranca uno por llamada');
  // The CLI probes this on startup; a 404 from the proxy proves it is up.
  const res = await fetch(`http://127.0.0.1:${first}/api/hello`);
  assert.equal(res.status, 404);
});

test('un listen fallido no se cachea: la siguiente llamada vuelve a intentarlo', async () => {
  await closeZenProxy();
  const { createZenProxy } = await import('../src/zen-proxy.js');
  let calls = 0;
  registerZenProxyFactory(() => {
    calls += 1;
    // The first process-wide attempt fails (a busy port, say); without the
    // retry the board would keep every task proxy-less until it restarted.
    if (calls === 1) return { listen: () => Promise.reject(new Error('EADDRINUSE')), close: async () => {} };
    return createZenProxy();
  });
  try {
    await assert.rejects(new LocalMachine('here').zenProxyPort(), /EADDRINUSE/);
    const port = await new LocalMachine('here').zenProxyPort();
    assert.ok(port > 0, 'el segundo intento sí arranca');
    assert.equal(calls, 2);
  } finally {
    registerZenProxyFactory();
    await closeZenProxy();
  }
});

test('la versión de claude que espera el tablero sale del SDK instalado', async () => {
  const { expectedClaudeVersion } = await import('../src/claude.js');
  const { createRequire } = await import('node:module');
  const { readFileSync } = await import('node:fs');
  const entry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
  const sdk = JSON.parse(readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8')).version;
  // 0.3.N pairs with 2.1.N; anything else means the mapping needs a look.
  const patch = /^0\.3\.(\d+)$/.exec(sdk)?.[1];
  assert.equal(expectedClaudeVersion(), patch ? `2.1.${patch}` : null);
});

test('un runner sirve un proyecto no predeterminado solo si lo declara en projects', async () => {
  const { machineFor, machineHostsProject } = await import('../src/machine.js');
  const before = { machines: config.machines, project: { ...config.project } };
  try {
    config.machines = {
      devbox: {
        kind: 'runner', url: 'http://devbox:7421', token: 't', repoPath: '/x', worktreeRoot: '/y',
        projects: { ehr: { repoPath: '/home/u/src/EHR', worktreeRoot: '/home/u/src/EHR-wt' } },
      },
    };
    registerRunnerClient((name, spec) => ({ name, kind: 'runner', spec, repoPath: spec.repoPath, worktreeRoot: spec.worktreeRoot }));
    const view = machineFor('devbox', 'ehr');
    assert.equal(view.repoPath, '/home/u/src/EHR');
    assert.equal(view.worktreeRoot, '/home/u/src/EHR-wt');
    assert.equal(machineFor('devbox', 'hfs').repoPath, '/x');
    assert.throws(() => machineFor('devbox', 'otro'), /not declared on machine "devbox"/);
    assert.equal(machineHostsProject('devbox', 'ehr'), true);
    assert.equal(machineHostsProject('devbox', 'otro'), false);
    assert.equal(machineHostsProject('local', 'otro'), true);
  } finally {
    if (before.machines !== undefined) config.machines = before.machines; else delete config.machines;
    config.project = before.project;
    registerRunnerClient((name) => { throw new Error(`machines.${name}: el cliente del runner no está cargado`); });
  }
});

test('la vista de un proyecto en un runner real conserva los métodos privados del cliente', async () => {
  const { machineFor, registerRunnerClient: reg } = await import('../src/machine.js');
  const { RunnerMachine } = await import('../src/runner-client.js');
  const before = { machines: config.machines, project: { ...config.project } };
  try {
    config.machines = {
      devbox: {
        kind: 'runner', url: 'http://127.0.0.1:9', token: 't', repoPath: '/x', worktreeRoot: '/y',
        projects: { ehr: { repoPath: '/home/u/src/EHR', worktreeRoot: '/home/u/src/EHR-wt' } },
      },
    };
    reg((name, spec) => new RunnerMachine(name, spec));
    const view = machineFor('devbox', 'ehr');
    assert.equal(view.repoPath, '/home/u/src/EHR');
    assert.equal(view.kind, 'runner');
    // Reaches #fetch/#json: the failure must be a connection error, never a receiver error.
    await assert.rejects(() => view.info(), (e) => !/Receiver must be an instance/.test(e.message));
    assert.equal(view.samePath('/a/b', '/a/b/'), true);
  } finally {
    if (before.machines !== undefined) config.machines = before.machines; else delete config.machines;
    config.project = before.project;
    reg((name) => { throw new Error(`machines.${name}: el cliente del runner no está cargado`); });
  }
});
