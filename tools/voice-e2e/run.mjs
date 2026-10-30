#!/usr/bin/env node
/**
 * The chat's voice, tried in a real Chromium against a throwaway board.
 *
 * Usage
 * -----
 *   node tools/voice-e2e/run.mjs [--playwright <path>] [--out <dir>] [--keep] [--mobile]
 *
 *   --playwright  the `@playwright/test` package to drive the browser with
 *                 (default: `$E2E_PLAYWRIGHT`, this repo's own if it has one, or
 *                 the one the hfs checkout carries under `crates/ui/e2e`).
 *   --out         where the screenshots and `results.json` go (default:
 *                 `hfsmon-voice-e2e-last` in the temp directory, printed at the end).
 *   --keep        leave the throwaway data and config folder in place.
 *   --mobile      the size and touch of a phone, and only the checks that matter there.
 *
 * What it does: a data folder and a config of its own in the temp directory, one
 * seeded task with a chat, this checkout's board on a free port (never the live
 * one: the port and the data are its own), and then `voice.e2e.mjs`, which opens
 * the task's chat and checks the speaker, the voice mark of what is sent, what
 * is read aloud and what is not, Escape, the per-chat memory and the settings.
 * The board is stopped at the end, whatever happened.
 *
 * What it cannot check: a headless browser has neither voices nor a
 * microphone, so the speech engine is a recorder. It proves the wiring, not how
 * the voice sounds nor what the real recogniser hears — that is by ear.
 *
 * Needs `web/dist` built (`npm run build`): the board serves it.
 * Exit code: 0 when every check passed, 1 otherwise, 2 when it could not run.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

const die = (message) => { console.error(`voice-e2e: ${message}`); process.exit(2); };

/** The Playwright package to drive the browser with, or null. */
function findPlaywright() {
  const candidates = [
    option('--playwright'),
    process.env.E2E_PLAYWRIGHT,
    path.join(ROOT, 'node_modules', '@playwright', 'test'),
    path.join(os.homedir(), 'src', 'heliossoftware', 'hfs', 'crates', 'ui', 'e2e', 'node_modules', '@playwright', 'test'),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(path.join(p, 'package.json'))) ?? null;
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const run = (file, argv, options) => new Promise((resolve) => {
  const child = spawn(process.execPath, [file, ...argv], { stdio: ['ignore', 'pipe', 'inherit'], ...options });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.on('close', (code) => resolve({ code, out }));
});

async function waitFor(url, ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const playwright = findPlaywright();
if (!playwright) die('no @playwright/test found: pass --playwright <path> or set E2E_PLAYWRIGHT (the hfs checkout has one under crates/ui/e2e).');
if (!existsSync(path.join(ROOT, 'web', 'dist', 'index.html'))) die('web/dist is not built: run `npm run build` first.');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'hfsmon-voice-e2e-'));
// Not inside `tmp`: that folder is removed at the end, and the screenshots are what one wants to look at.
const out = option('--out') ?? path.join(os.tmpdir(), 'hfsmon-voice-e2e-last');
mkdirSync(out, { recursive: true });
const dirs = { data: path.join(tmp, 'data'), repo: path.join(tmp, 'repo'), wt: path.join(tmp, 'wt') };
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

const port = await freePort();
const config = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
config.port = port;
const configFile = path.join(tmp, 'config.json');
writeFileSync(configFile, JSON.stringify(config, null, 2));

const env = {
  ...process.env,
  HFSMON_DATA_DIR: dirs.data,
  HFSMON_CONFIG: configFile,
  HFSMON_NO_AUTOSTART: '1',
  E2E_REPO: dirs.repo,
  E2E_WT: dirs.wt,
};

let board = null;
let code = 2;
try {
  const seed = await run(path.join(HERE, 'seed.mjs'), [], { cwd: ROOT, env });
  if (seed.code !== 0) die('could not seed the throwaway board.');
  const { chatId } = JSON.parse(seed.out.trim().split('\n').pop());

  board = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'index.js')], { cwd: ROOT, env, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  if (!await waitFor(`${url}/api/settings`)) die(`the board did not come up on port ${port}.`);
  console.log(`throwaway board on ${url} (data in ${tmp})`);

  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, 'voice.e2e.mjs')], {
      cwd: HERE, stdio: 'inherit',
      env: { ...env, E2E_PLAYWRIGHT: playwright, E2E_URL: url, E2E_CHAT_ID: chatId, E2E_OUT: out, E2E_MOBILE: flag('--mobile') ? '1' : '0' },
    });
    child.on('close', resolve);
  });
  code = result === 0 ? 0 : 1;
  console.log(`screenshots and results.json in ${out}`);
} finally {
  if (board) board.kill();
  if (!flag('--keep')) rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
process.exit(code);
