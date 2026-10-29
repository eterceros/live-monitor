import './isolate.mjs';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { removeTree, tempDir } from './teardown.mjs';

/**
 * `POST /api/flush`: what stop.ps1 calls before it ends the board with
 * `taskkill /F` (which skips every exit handler). Against the real board in its
 * own process, on a throwaway data directory.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..');
let dir;
let dataDir;
let port;
let child;

const url = (p) => `http://127.0.0.1:${port}${p}`;

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port: p } = srv.address();
    srv.close(() => resolve(p));
  });
});

before(async () => {
  dir = tempDir('hfsmon-flushroute-');
  dataDir = path.join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const one = path.join(dir, 'one');
  mkdirSync(one, { recursive: true });
  const legacy = { issue: 5, title: 'tarea vieja', labels: [], url: 'x', state: 'done', log: [{ ts: 't', phase: 'estado', line: 'historia' }], chats: [] };
  writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify({ 5: legacy }));
  writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([{ id: 'hfs', name: 'hfs', repoPath: one, worktreeRoot: `${one}-wt`, repo: null, assignee: 'nobody', overrides: {} }]));
  port = await freePort();
  const configFile = path.join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({
    port,
    github: { repo: 'nobody/nothing-at-all', assignee: 'nobody' },
    poll: { intervalSeconds: 36000 },
    project: { repoPath: one, worktreeRoot: `${one}-wt` },
    stack: { command: 'npm start' },
    limits: { defaultMaxActiveTasks: 1, maxActiveTasksCeiling: 2, maxFixIterations: 1, completedShown: 5 },
    claude: { chatModel: 'sonnet', advisorModel: 'opus', fixModel: 'sonnet', available: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }] },
  }));
  child = spawn(process.execPath, [path.join('server', 'src', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, HFSMON_CONFIG: configFile, HFSMON_DATA_DIR: dataDir, HFSMON_NO_AUTOSTART: '1',
      GIT_CEILING_DIRECTORIES: [dir, tmpdir()].join(path.delimiter) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (b) => log.push(String(b)));
  child.stderr.on('data', (b) => log.push(String(b)));
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(url('/api/tasks'))).status === 200) break; } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`el tablero no levantó:\n${log.join('')}`);
    await new Promise((r) => { setTimeout(r, 150); });
  }
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  }
  await removeTree(dir);
});

const post = (p, body) => fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const mainFile = () => JSON.parse(readFileSync(path.join(dataDir, 'tasks.json'), 'utf8'));

/** A POST with the Host / Origin we choose (fetch will not let a script set Host). */
const rawPost = (headers) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/api/flush', method: 'POST', headers }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode));
  });
  req.on('error', reject);
  req.end();
});

test('a real change made through the API reaches the disk when /api/flush answers, not before', async () => {
  assert.equal(mainFile()[5].design, false, 'the task starts without the flag');
  assert.equal((await post('/api/projects/hfs/tasks/5/design', { on: true })).status, 200);
  assert.notEqual(mainFile()[5].design, true, 'still inside the 3 s window: only in memory');
  const res = await post('/api/flush');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(mainFile()[5].design, true, 'on disk once the route has answered');
  assert.equal(mainFile()[5].persistSplit, 1, 'in the split format');
});

test('POST /api/flush is refused when a proxy sits in front, for a foreign Host and for a foreign Origin', async () => {
  for (const headers of [{ 'x-forwarded-for': '100.64.0.9' }, { forwarded: 'for=100.64.0.9' }, { 'tailscale-user-login': 'x@y' }]) {
    const res = await fetch(url('/api/flush'), { method: 'POST', headers });
    assert.ok([401, 403].includes(res.status), `refused (got ${res.status}): ${JSON.stringify(headers)}`);
  }
  assert.ok([401, 403].includes(await rawPost({ host: 'evil.example' })), 'a rebinding page: loopback socket, foreign Host');
  assert.ok([401, 403].includes(await rawPost({ host: `127.0.0.1:${port}`, origin: 'http://evil.example' })), 'a browser tab of another site');
  assert.equal(await rawPost({ host: `localhost:${port}`, origin: `http://localhost:${port}` }), 200, 'the board\'s own page is fine');
});

test('when the disk cannot be written /api/flush answers 500 with the reason, and 200 once it can', async () => {
  // Break it for real: where the data files go there is now a regular file.
  rmSync(path.join(dataDir, 'taskdata'), { recursive: true, force: true });
  writeFileSync(path.join(dataDir, 'taskdata'), 'in the way');
  assert.equal((await post('/api/projects/hfs/tasks/5/design', { on: false })).status, 200);
  const bad = await post('/api/flush');
  assert.equal(bad.status, 500);
  const body = await bad.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /could not save/);
  assert.ok(body.failures.length >= 1 && body.failures[0].file.endsWith('tasks.json'), JSON.stringify(body.failures));
  // Fixed: the very next flush writes it (the failure kept the project dirty).
  rmSync(path.join(dataDir, 'taskdata'));
  const ok = await post('/api/flush');
  assert.equal(ok.status, 200, JSON.stringify(await ok.json().catch(() => null)));
  assert.equal(mainFile()[5].design, false);
  assert.equal(JSON.parse(readFileSync(path.join(dataDir, 'taskdata', 'tasks', '5.json'), 'utf8')).log[0].line, 'historia');
});

test('stop.ps1 asks the board to save before it closes it', () => {
  const stop = readFileSync(path.join(ROOT, 'stop.ps1'), 'utf8');
  assert.ok(stop.indexOf('/api/flush') > 0 && stop.indexOf('/api/flush') < stop.indexOf('taskkill /PID'), 'the flush call comes before taskkill');
  assert.match(readFileSync(path.join(ROOT, 'restart.ps1'), 'utf8'), /'-BoardPort', \$Port/);
  assert.doesNotMatch(stop, /[^\x00-\x7f]/, 'ASCII only: Windows PowerShell reads a BOM-less .ps1 as Windows-1252');
});
