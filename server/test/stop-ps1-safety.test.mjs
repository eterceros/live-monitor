import './isolate.mjs';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTreeReported } from './teardown.mjs';

/**
 * stop.ps1 in a throwaway copy of the repo, against stub processes this test starts
 * on free ports. Nothing here can reach the live board: the sandbox's config.json
 * names a closed decoy port (never 7420), the sweep range is a single port that this
 * test's own process holds, and the environment has no HFSMON_* variable.
 */

const WIN = process.platform === 'win32';
const SKIP = WIN ? false : 'solo Windows';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function waitFor(fn, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await delay(150);
  }
}

// A «board»: records every request, answers /api/flush with the status in behavior.json.
const FAKE_BOARD = `
const http = require('http'); const fs = require('fs'); const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'behavior.json'), 'utf8'));
setTimeout(() => process.exit(0), 3 * 60 * 1000);
http.createServer((req, res) => {
  fs.appendFileSync(path.join(root, 'requests.log'), req.method + ' ' + req.url + '\\n');
  if (req.method === 'POST' && req.url === '/api/flush') {
    res.writeHead(cfg.flushStatus, { 'content-type': 'application/json' });
    res.end(cfg.flushStatus === 200 ? '{"ok":true}' : '{"ok":false,"error":"could not save: disk full"}');
    return;
  }
  res.writeHead(404); res.end();
}).listen(cfg.port, '127.0.0.1');
`;

const LISTENER = `
require('net').createServer().listen(Number(process.argv[2]), '127.0.0.1');
setTimeout(() => process.exit(0), 3 * 60 * 1000);
`;

function makeSandbox(name, { config = {}, local = null, flushStatus = 200 } = {}) {
  const dir = path.join(os.tmpdir(), `hfsmon-stopsafe-${Date.now().toString(36)}-${name}`);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'server', 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'helper'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'stop.ps1'), path.join(repo, 'stop.ps1'));
  fs.writeFileSync(path.join(repo, 'config.json'), JSON.stringify(config));
  if (local) fs.writeFileSync(path.join(repo, 'config.local.json'), JSON.stringify(local));
  fs.writeFileSync(path.join(repo, 'server', 'src', 'index.js'), FAKE_BOARD);
  fs.writeFileSync(path.join(repo, 'helper', 'listen.js'), LISTENER);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(npm_|GIT_|CLAUDE|ANTHROPIC_|HFSMON_)/i.test(k) || /^INIT_CWD$/i.test(k)) continue;
    env[k] = v;
  }
  void flushStatus;
  return { dir, repo, env, children: [] };
}

async function startBoard(ctx, port, flushStatus) {
  fs.writeFileSync(path.join(ctx.repo, 'behavior.json'), JSON.stringify({ port, flushStatus }));
  const child = spawn(process.execPath, [path.join(ctx.repo, 'server', 'src', 'index.js')],
    { cwd: path.join(ctx.repo, 'server'), stdio: 'ignore', windowsHide: true });
  ctx.children.push(child);
  fs.writeFileSync(path.join(ctx.repo, '.hfs-monitor.pid'), String(child.pid));   // after the spawn: «started before the file»
  assert.ok(await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/x`, { signal: AbortSignal.timeout(1500) })).status === 404; } catch { return false; }
  }, 15_000), 'the stub board answers');
  fs.rmSync(path.join(ctx.repo, 'requests.log'), { force: true });   // forget our own probe
  return child;
}

function startListener(ctx, script, cwd, port) {
  const child = spawn(process.execPath, [script, String(port)], { cwd, stdio: 'ignore', windowsHide: true });
  ctx.children.push(child);
  return child;
}

const requests = (ctx) => {
  try { return fs.readFileSync(path.join(ctx.repo, 'requests.log'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; }
};

function runStop(ctx, args, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ctx.repo, 'stop.ps1'), ...args],
      { cwd: ctx.repo, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`stop.ps1 did not finish:\n${output}`)); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

async function cleanup(ctx, ...extra) {
  for (const c of [...ctx.children, ...extra]) { try { c.kill(); } catch { /* gone */ } }
  await delay(300);
  await removeTreeReported('stop-ps1-safety', ctx.dir, { tolerate: true, timeoutMs: 3000 });
}

const NO_SWEEP = ['-PortFrom', '1', '-PortTo', '0'];

describe('stop.ps1 (sandbox, stub processes on free ports)', { skip: SKIP }, () => {
  test('-BoardPort is the port the flush request goes to, whatever config.json says', async () => {
    const decoy = await freePort();
    const port = await freePort();
    assert.notEqual(port, 7420);
    assert.notEqual(decoy, 7420);
    const ctx = makeSandbox('boardport', { config: { port: decoy } });
    try {
      const board = await startBoard(ctx, port, 200);
      const r = await runStop(ctx, ['-BoardPort', String(port), ...NO_SWEEP]);
      assert.equal(r.code, 0, r.output);
      assert.deepEqual(requests(ctx), ['POST /api/flush'], `the request reached the port that was passed:\n${r.output}`);
      assert.match(r.output, /guardo sus datos/);
      assert.ok(await waitFor(() => !alive(board.pid), 5000), 'and then the board was closed');
    } finally { await cleanup(ctx); }
  });

  test('without -BoardPort the port is config.json\'s, overridden by config.local.json', async () => {
    const decoy = await freePort();
    const port = await freePort();
    const ctx = makeSandbox('localcfg', { config: { port: decoy }, local: { port } });
    try {
      const board = await startBoard(ctx, port, 200);
      const r = await runStop(ctx, NO_SWEEP);
      assert.equal(r.code, 0, r.output);
      assert.deepEqual(requests(ctx), ['POST /api/flush']);
      assert.ok(await waitFor(() => !alive(board.pid), 5000));
    } finally { await cleanup(ctx); }
  });

  test('a board that answers 500 (could not save) is left running, loudly; -IgnoreSaveFailure closes it anyway', async () => {
    const decoy = await freePort();
    const port = await freePort();
    const ctx = makeSandbox('refused', { config: { port: decoy } });
    try {
      const board = await startBoard(ctx, port, 500);
      const r = await runStop(ctx, ['-BoardPort', String(port), ...NO_SWEEP]);
      assert.equal(r.code, 3, r.output);
      assert.match(r.output, /NO PUDO GUARDAR/);
      assert.match(r.output, /disk full/);
      assert.deepEqual(requests(ctx), ['POST /api/flush', 'POST /api/flush'], 'it tried twice');
      assert.ok(alive(board.pid), 'the board is still running');
      assert.ok(fs.existsSync(path.join(ctx.repo, '.hfs-monitor.pid')), 'and its pid file is kept');
      const forced = await runStop(ctx, ['-BoardPort', String(port), '-IgnoreSaveFailure', ...NO_SWEEP]);
      assert.equal(forced.code, 0, forced.output);
      assert.ok(await waitFor(() => !alive(board.pid), 5000), 'closed when told to ignore the failure');
    } finally { await cleanup(ctx); }
  });

  test('the sweep leaves a listener that is not the board\'s alone and closes one that is', async () => {
    const decoy = await freePort();
    const ctx = makeSandbox('sweep', { config: { port: decoy } });
    const otherDir = path.join(ctx.dir, 'elsewhere');          // a folder outside the board's
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, 'listen.js'), LISTENER);
    try {
      // 1. A node process from ANOTHER folder listening inside the range: listed, not touched.
      const foreignPort = await freePort();
      const foreign = startListener(ctx, path.join(otherDir, 'listen.js'), otherDir, foreignPort);
      assert.ok(await waitFor(async () => new Promise((res) => { const s = net.connect(foreignPort, '127.0.0.1', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); }), 10_000));
      const kept = await runStop(ctx, ['-PortFrom', String(foreignPort), '-PortTo', String(foreignPort)]);
      assert.equal(kept.code, 0, kept.output);
      assert.match(kept.output, /NO se toca/);
      assert.ok(alive(foreign.pid), `the foreign process survived:\n${kept.output}`);
      // 2. One whose command line is under the board's folder: closed.
      const ownPort = await freePort();
      const own = startListener(ctx, path.join(ctx.repo, 'helper', 'listen.js'), ctx.repo, ownPort);
      assert.ok(await waitFor(async () => new Promise((res) => { const s = net.connect(ownPort, '127.0.0.1', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); }), 10_000));
      const swept = await runStop(ctx, ['-PortFrom', String(ownPort), '-PortTo', String(ownPort)]);
      assert.equal(swept.code, 0, swept.output);
      assert.match(swept.output, /cerrando/);
      assert.ok(await waitFor(() => !alive(own.pid), 5000), `the board's own listener was closed:\n${swept.output}`);
    } finally { await cleanup(ctx); }
  });
});

describe('upgrade.ps1 (content)', () => {
  const src = fs.readFileSync(path.join(REPO, 'upgrade.ps1'), 'utf8');
  test('asks the board to save before it forces it to stop, and does not force a board that answered 500', () => {
    const ask = src.indexOf('Request-BoardFlush)');
    const force = src.indexOf('Stop-Process -Id $BoardPid -Force');
    assert.ok(ask > 0 && force > ask, 'the flush request comes before the forced stop');
    assert.match(src, /-eq 'refused'\) \{[\s\S]{0,400}NOT stopping the board/);
    assert.match(src, /127\.0\.0\.1:\$Port\/api\/flush/, 'it uses the script\'s own resolved port');
    assert.doesNotMatch(src, /[^\x00-\x7f]/, 'ASCII only');
  });
});
