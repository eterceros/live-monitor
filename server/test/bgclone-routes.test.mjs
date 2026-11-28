import './isolate.mjs';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { removeTree, tempDir } from './teardown.mjs';

/**
 * The background-clone wiring of `index.js`, against the real board in its own
 * process (same scaffold as `git-refresh-route.test.mjs`) and a fake runner
 * that answers over HTTP. `gh repo clone` there is held until the test lets it
 * fail, so «the import does not wait for the clone» is observed, not timed.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..');
let dir;
let dataDir;
let port;
let child;
let runner;
let socket;
const log = [];
const messages = [];

/** Every `gh repo clone` the board asked the runner for. */
const clones = [];
/** Responses of clones still held. */
const held = [];

const url = (p) => `http://127.0.0.1:${port}${p}`;

async function call(method, p, body) {
  const res = await fetch(url(p), {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port: p } = srv.address();
    srv.close(() => resolve(p));
  });
});

async function until(ok, what) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await ok();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}:\n${log.join('')}`);
    await new Promise((r) => { setTimeout(r, 25); });
  }
}

const failClone = (res) => res.end(`${JSON.stringify({
  result: { ok: false, code: 1, stdout: '', stderr: 'gh: not logged in' },
})}\n`);
const releaseClones = () => { for (const res of held.splice(0)) failClone(res); };

function fakeRunner() {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (b) => { raw += b; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const json = (data, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.url === '/info') return json({ home: '/home/zoe' });
      if (req.url === '/fs/exists') return json({ value: false });
      if (req.url === '/fs/mkdir' || req.url === '/fs/rm') return json({});
      if (req.url === '/exec' && body.file === 'gh' && body.args[1] === 'clone') {
        clones.push(body.args[2]);
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.flushHeaders();
        held.push(res);
        return undefined;
      }
      return json({ error: `the fake runner has no ${req.url}` }, 404);
    });
  });
}

const row = async (project, machine) => {
  const res = await call('GET', `/api/projects/${project}/machines`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.machines.find((m) => m.machine === machine);
};
const jobIs = (project, status) => until(
  async () => (await row(project, 'devbox')).job.status === status,
  `the ${project} job on devbox to be ${status}`,
);

before(async () => {
  dir = tempDir('hfsmon-bgclone-routes-');
  dataDir = path.join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const one = path.join(dir, 'one');
  mkdirSync(one, { recursive: true });
  // The checkout to import: a GitHub remote, and dependencies already there.
  const widget = path.join(dir, 'widget');
  mkdirSync(path.join(widget, 'node_modules'), { recursive: true });
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: [dir, tmpdir()].join(path.delimiter) };
  execFileSync('git', ['init', '-q'], { cwd: widget, env });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/nobody/widget.git'], { cwd: widget, env });

  writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([{
    id: 'hfs', name: 'hfs', repoPath: one, worktreeRoot: `${one}-wt`, repo: null, assignee: 'nobody', overrides: {},
  }]));

  runner = fakeRunner();
  await new Promise((r) => { runner.listen(0, '127.0.0.1', r); });

  port = await freePort();
  const configFile = path.join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({
    port,
    github: { repo: 'nobody/nothing-at-all', assignee: 'nobody' },
    poll: { intervalSeconds: 36000 },
    project: { repoPath: one, worktreeRoot: `${one}-wt` },
    machines: {
      devbox: {
        kind: 'runner', url: `http://127.0.0.1:${runner.address().port}`, token: 't', repoPath: '/x', worktreeRoot: '/y',
      },
    },
    stack: { command: 'npm start' },
    limits: { defaultMaxActiveTasks: 1, maxActiveTasksCeiling: 2, maxFixIterations: 1, completedShown: 5 },
    claude: {
      chatModel: 'sonnet', advisorModel: 'opus', fixModel: 'sonnet',
      available: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }],
    },
  }));

  child = spawn(process.execPath, [path.join('server', 'src', 'index.js')], {
    cwd: ROOT,
    env: { ...env, HFSMON_CONFIG: configFile, HFSMON_DATA_DIR: dataDir, HFSMON_NO_AUTOSTART: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (b) => log.push(String(b)));
  child.stderr.on('data', (b) => log.push(String(b)));
  child.once('exit', (code) => log.push(`[exit ${code}]`));

  await until(async () => {
    try { return (await call('GET', '/api/tasks')).status === 200; } catch { return false; }
  }, 'the board to listen');

  socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  socket.on('message', (raw) => messages.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });

});

after(async () => {
  socket?.terminate();
  releaseClones();
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  }
  runner?.closeAllConnections();
  runner?.close();
  await removeTree(dir);
});

const checkoutMessages = () => messages.filter((m) => m.type === 'checkout');

test('importing clones on the runner without waiting for the clone, and announces it', async () => {
  const res = await call('POST', '/api/projects', { repoPath: path.join(dir, 'widget'), assignee: 'nobody' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.repo, 'nobody/widget');

  // Answered while the clone is still held on the runner.
  await until(() => held.length === 1, 'the runner to be asked to clone');
  assert.deepEqual(clones, ['nobody/widget']);
  await jobIs('widget', 'running');
  const running = await until(() => checkoutMessages().find((m) => m.status === 'running'), 'the running message');
  assert.deepEqual(
    [running.project, running.machine, running.step, running.error],
    ['widget', 'devbox', 'clone', null],
  );

  releaseClones();
  await jobIs('widget', 'failed');
  const failed = await until(() => checkoutMessages().find((m) => m.status === 'failed'), 'the failed message');
  assert.equal(failed.code, 'no_access');
  assert.match(failed.error, /nobody\/widget/);
});

test('GET machines: one row per machine, the board\'s own included', async () => {
  const res = await call('GET', '/api/projects/widget/machines');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const local = res.body.machines.find((m) => m.kind === 'local');
  assert.deepEqual([local.eligible, local.reason, local.present, local.nodeModules], [false, 'local', true, true]);
  const devbox = res.body.machines.find((m) => m.machine === 'devbox');
  assert.deepEqual([devbox.kind, devbox.eligible, devbox.autoClone, devbox.present, devbox.install], ['runner', true, true, false, null]);
  assert.equal(devbox.job.code, 'no_access');

  const ghost = await call('GET', '/api/projects/ghost/machines');
  assert.equal(ghost.status, 404);
  assert.equal(ghost.body.code, 'unknown_project');
});

test('POST clone retries by hand, even on an excluded runner', async () => {
  const off = await call('POST', '/api/projects/widget/machines/devbox/options', { autoClone: false });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.deepEqual([off.body.autoClone, off.body.eligible, off.body.reason], [false, false, 'excluded']);

  const asked = clones.length;
  const res = await call('POST', '/api/projects/widget/machines/devbox/clone');
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.equal(res.body.status, 'running');
  await until(() => clones.length === asked + 1 && held.length === 1, 'the retry to reach the runner');
  releaseClones();
  await jobIs('widget', 'failed');

  const localName = (await call('GET', '/api/projects/widget/machines')).body.machines.find((m) => m.kind === 'local').machine;
  const local = await call('POST', `/api/projects/widget/machines/${localName}/clone`);
  assert.deepEqual([local.status, local.body.code], [400, 'local']);
  assert.equal((await call('POST', '/api/projects/widget/machines/nowhere/clone')).status, 404);
});

test('POST options: taking a runner back in clones at once, and the choices are saved', async () => {
  const asked = clones.length;
  const on = await call('POST', '/api/projects/widget/machines/devbox/options', { autoClone: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.autoClone, true);
  await until(() => clones.length === asked + 1 && held.length === 1, 'the clone after re-including');
  releaseClones();
  await jobIs('widget', 'failed');

  const no = await call('POST', '/api/projects/widget/machines/devbox/options', { autoClone: false, install: 'no' });
  assert.deepEqual([no.status, no.body.install, no.body.autoClone], [200, 'no', false]);
  const saved = JSON.parse(readFileSync(path.join(dataDir, 'projects.json'), 'utf8')).find((p) => p.id === 'widget');
  assert.deepEqual(saved.machines, { devbox: { autoClone: false, install: 'no' } });
});

test('POST options refuses bad input and saves none of it', async () => {
  const route = '/api/projects/widget/machines/devbox/options';
  for (const body of [{}, { autoClone: 'yes' }, { install: 'maybe' }, { autoClone: true, install: 'maybe' }]) {
    const res = await call('POST', route, body);
    assert.deepEqual([res.status, res.body.code], [400, 'invalid_options'], JSON.stringify(body));
  }
  assert.equal((await row('widget', 'devbox')).autoClone, false);
  assert.equal((await call('POST', '/api/projects/ghost/machines/devbox/options', { install: 'no' })).status, 404);
  assert.equal((await call('POST', '/api/projects/widget/machines/nowhere/options', { install: 'no' })).status, 404);
});

test('POST prepare answers a local refusal with its code', async () => {
  const localName = (await call('GET', '/api/projects/widget/machines')).body.machines.find((m) => m.kind === 'local').machine;
  const res = await call('POST', `/api/projects/widget/machines/${localName}/prepare`);
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, 'node_modules_exists');
});

// The board above runs with HFSMON_NO_AUTOSTART=1, so the boot wiring is read.
test('index.js starts background cloning unless autostart is off, before it first asks the runners', () => {
  const src = readFileSync(path.join(ROOT, 'server', 'src', 'index.js'), 'utf8');
  const start = src.search(/if \(process\.env\.HFSMON_NO_AUTOSTART !== '1'\) startBgClone\(\);/);
  assert.ok(start > src.indexOf('server.listen('), 'started once the port is open');
  assert.ok(start < src.indexOf('void m.info()'), 'listening before the first answer');
});
