import './isolate.mjs';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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

test('POST /api/flush from the machine itself saves and answers ok', async () => {
  const res = await fetch(url('/api/flush'), { method: 'POST' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const main = JSON.parse(readFileSync(path.join(dataDir, 'tasks.json'), 'utf8'));
  assert.equal(main[5].persistSplit, 1, 'the board wrote its files');
});

test('POST /api/flush is refused when a proxy sits in front (forwarded headers)', async () => {
  for (const headers of [{ 'x-forwarded-for': '100.64.0.9' }, { forwarded: 'for=100.64.0.9' }, { 'tailscale-user-login': 'x@y' }]) {
    const res = await fetch(url('/api/flush'), { method: 'POST', headers });
    assert.ok([401, 403].includes(res.status), `refused (got ${res.status}): ${JSON.stringify(headers)}`);
  }
});

test('stop.ps1 asks the board to save before it closes it', () => {
  const stop = readFileSync(path.join(ROOT, 'stop.ps1'), 'utf8');
  assert.ok(stop.indexOf('/api/flush') > 0 && stop.indexOf('/api/flush') < stop.indexOf('taskkill /PID'), 'the flush call comes before taskkill');
  assert.match(readFileSync(path.join(ROOT, 'restart.ps1'), 'utf8'), /'-BoardPort', \$Port/);
  assert.doesNotMatch(stop, /[^\x00-\x7f]/, 'ASCII only: Windows PowerShell reads a BOM-less .ps1 as Windows-1252');
});
