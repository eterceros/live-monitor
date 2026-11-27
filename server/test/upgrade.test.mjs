// Upgrading the SDK, the CLI and the runner from the board. Real git (a bare
// origin, the board's clone and the box's clone), a runner served in this very
// process, and fake `claude`, `systemd-run`, `systemctl` and `npm` on PATH run
// by a real `sh`. The registry, the laptop's tools, the PowerShell handover
// and `process.exit` go through `upgradeHooks`: nothing here reaches npm,
// spawns upgrade.ps1 or ends the process.
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = mkdtempSync(path.join(tmpdir(), 'hfsmon-upgrade-'));
const dataDir = path.join(ROOT, 'data');
mkdirSync(dataDir, { recursive: true });
process.env.HFSMON_DATA_DIR = dataDir;
process.env.HFSMON_NO_AUTOSTART = '1';
delete process.env.HFSMON_UPGRADE_FORCE;

const fwd = (p) => p.replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (args, cwd) => execFileSync(
  'git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' },
);
const write = (dir, name, data) => {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  writeFileSync(path.join(dir, name), data);
};
const head = (repo) => git(['rev-parse', 'HEAD'], repo).trim();
const commitIn = (repo, files, message) => {
  for (const [name, text] of Object.entries(files)) write(repo, name, text);
  git(['add', '--', ...Object.keys(files)], repo);
  git(['commit', '-m', message], repo);
  return head(repo);
};

// --- a POSIX shell with coreutils, and the fakes -----------------------------
const FAKE_BIN = path.join(ROOT, 'bin');
const FAKE_DIR = fwd(path.join(ROOT, 'fake'));
const FAKE_HOME = fwd(path.join(ROOT, 'box-home'));
mkdirSync(FAKE_BIN, { recursive: true });
mkdirSync(FAKE_DIR, { recursive: true });
mkdirSync(FAKE_HOME, { recursive: true });
process.env.FAKE_DIR = FAKE_DIR;

const script = (name, body) => writeFileSync(path.join(FAKE_BIN, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
script('claude', [
  'case "$1" in',
  '  install)',
  '    if [ -f "$FAKE_DIR/claude-fail" ]; then echo "install exploded"; exit 3; fi',
  '    if [ -f "$FAKE_DIR/holdinstall" ]; then i=0; while [ ! -f "$FAKE_DIR/release" ] && [ $i -lt 1800 ]; do sleep 0.1; i=$((i+1)); done; fi',
  '    echo "$2" > "$FAKE_DIR/claude-version"; echo "installed $2"; exit 0 ;;',
  '  --version) echo "$(cat "$FAKE_DIR/claude-version") (Claude Code)" ;;',
  'esac',
].join('\n'));
script('systemd-run', [
  'echo "systemd-run $*" >> "$FAKE_DIR/calls.log"',
  'if [ -f "$FAKE_DIR/nobus" ]; then echo "Failed to connect to bus" >&2; exit 1; fi',
  'delay=""',
  'while [ $# -gt 0 ]; do',
  '  case "$1" in',
  '    --on-active=*) delay=1; shift ;;',
  '    --*) shift ;;',
  '    *) break ;;',
  '  esac',
  'done',
  'if [ -n "$delay" ]; then : > "$FAKE_DIR/restart-pending"; ( sleep 1; "$@"; rm -f "$FAKE_DIR/restart-pending" ) > /dev/null 2>&1 & exit 0; fi',
  '"$@" > /dev/null 2>&1 &',
  'exit 0',
].join('\n'));
script('systemctl', [
  'echo "systemctl $*" >> "$FAKE_DIR/calls.log"',
  // The unit that exists on the fake box: `unit-name` (default hfsmon-runner),
  // with or without the .service suffix; any other name is not-found.
  'want="$(cat "$FAKE_DIR/unit-name" 2>/dev/null || echo hfsmon-runner)"',
  'asked=""; skip=""; for a in "$@"; do if [ -n "$skip" ]; then skip=""; continue; fi; case "$a" in -p) skip=1 ;; -*|show|restart) ;; *) asked="${a%.service}" ;; esac; done',
  'case "$*" in',
  '  *restart*) if [ "$asked" = "$want" ]; then : > "$FAKE_DIR/restart-requested"; else echo "Unit $asked.service not found." >&2; exit 5; fi ;;',
  '  *WorkingDirectory*) cat "$FAKE_DIR/workdir" 2>/dev/null ;;',
  '  *MainPID*) if [ "$asked" != "$want" ]; then echo LoadState=not-found; else printf "LoadState=loaded\\nActiveState=active\\nMainPID=%s\\n" "$(cat "$FAKE_DIR/unit-mainpid" 2>/dev/null || cat "$FAKE_DIR/box-pid" 2>/dev/null)"; fi ;;',
  'esac',
  'exit 0',
].join('\n'));
script('npm', 'echo "npm $*" >> "$FAKE_DIR/calls.log"');
// The checkout step asks `gh` about push access: never the real one.
script('gh', 'exit 1');

function findShellDir() {
  if (spawnSync('sh', ['-c', 'timeout 1 true'], { stdio: 'ignore' }).status === 0) return null;
  const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim();
  if (!exec) return undefined;
  // <Git>/mingw64/libexec/git-core → <Git>/usr/bin
  const dir = path.join(exec, '..', '..', '..', 'usr', 'bin');
  return existsSync(path.join(dir, process.platform === 'win32' ? 'sh.exe' : 'sh')) ? dir : undefined;
}
const shellDir = findShellDir();
const SHELL_SKIP = shellDir === undefined && 'no hay sh con coreutils en esta máquina';
process.env.PATH = [FAKE_BIN, ...(shellDir ? [shellDir] : []), process.env.PATH].join(path.delimiter);

const calls = () => (existsSync(path.join(FAKE_DIR, 'calls.log')) ? readFileSync(path.join(FAKE_DIR, 'calls.log'), 'utf8') : '');
const fakeClaude = (v) => writeFileSync(path.join(FAKE_DIR, 'claude-version'), `${v}\n`);
const flag = (name, on) => {
  const file = path.join(FAKE_DIR, name);
  if (on) writeFileSync(file, '');
  else rmSync(file, { force: true });
};

// --- modules -------------------------------------------------------------------
let config;
let store;
let settings;
let machines;
let registerRunnerClient;
let RunnerMachine;
let createRunner;
let pipeline;
let upgrade;
let claude;

let CURRENT;
let LATEST;
let WANTED;
let CLI_LATEST;
const registryState = { latest: null, notInstallable: false, gate: null };
const tools = { missing: new Set() };
const spawnCalls = [];
const exits = [];

const TOKEN = 'secreto-de-prueba';
const repos = {};
const box = { runningCommit: null, down: false, pid: 1000, legacy: false, unit: undefined };

const RESTART_MARKER = () => path.join(FAKE_DIR, 'restart-requested');

/**
 * The fake box idle: up, with no restart requested or still delayed by the
 * fake `systemd-run --on-active`. A test that reads the runner starts here, so
 * what an earlier test left in flight cannot land in the middle of it.
 */
async function settleBox() {
  await waitFor(() => !box.down && !existsSync(RESTART_MARKER()) && !pendingRestarts(), 'el runner falso queda quieto', 180_000);
}
/** A delayed restart the fake systemd-run launched and has not fired yet. */
const pendingRestarts = () => existsSync(path.join(FAKE_DIR, 'restart-pending'));

/** Waits for an outcome, with room for a machine running the whole suite at once. */
async function waitFor(condition, what, timeoutMs = 60_000) {
  const limit = Date.now() + timeoutMs;
  while (Date.now() < limit) {
    if (await condition()) return;
    await sleep(50);
  }
  assert.fail(`no llegó a pasar: ${what}`);
}
let runner = null;
let runnerPort = 0;
let restartWatch = null;
let appServer;
let appPort;

async function startRunner() {
  runner = createRunner({
    token: TOKEN, repoPath: repos.box, worktreeRoot: path.join(ROOT, 'box-wt'),
    attachmentsDir: path.join(ROOT, 'attachments'), monitorDir: repos.box,
  });
  const addr = await runner.listen(runnerPort, '127.0.0.1');
  runnerPort = addr.port;
}

function useMachines({ boxUrl } = {}) {
  config.machines = {
    local: { kind: 'local', repoPath: path.join(ROOT, 'hfs'), worktreeRoot: path.join(ROOT, 'hfs-wt') },
    box: {
      kind: 'runner', url: boxUrl ?? `http://127.0.0.1:${runnerPort}`, token: TOKEN,
      repoPath: repos.box, worktreeRoot: path.join(ROOT, 'box-wt'),
    },
  };
  // The laptop's own `claude --version` is not what is being tested.
  machines().local.info = async () => ({ platform: process.platform, claude: WANTED, home: ROOT });
}

let savedMachines;
before(async () => {
  ({ config } = await import('../src/config.js'));
  ({ store } = await import('../src/store.js'));
  ({ settings } = await import('../src/settings.js'));
  ({ machines, registerRunnerClient } = await import('../src/machine.js'));
  ({ RunnerMachine } = await import('../src/runner-client.js'));
  ({ createRunner } = await import('../src/runner/app.js'));
  pipeline = await import('../src/pipeline.js');
  upgrade = await import('../src/upgrade.js');
  claude = await import('../src/claude.js');

  CURRENT = claude.sdkVersion();
  const patch = Number(/^0\.3\.(\d+)$/.exec(CURRENT)[1]);
  LATEST = `0.3.${patch + 1}`;
  CLI_LATEST = `2.1.${patch + 1}`;
  WANTED = claude.expectedClaudeVersion();
  registryState.latest = LATEST;
  fakeClaude(WANTED);

  // origin, the board's checkout and the box's checkout, all at the seed.
  const configure = (repo) => {
    git(['config', 'user.email', 'test@example.com'], repo);
    git(['config', 'user.name', 'Test'], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);
    git(['config', 'core.autocrlf', 'false'], repo);
  };
  repos.origin = path.join(ROOT, 'origin.git');
  mkdirSync(repos.origin);
  git(['init', '--bare', '-b', 'main', '.'], repos.origin);
  const seed = path.join(ROOT, 'seed');
  git(['clone', repos.origin, seed], ROOT);
  configure(seed);
  commitIn(seed, {
    'README.md': '# hfs-monitor\n',
    'server/runner.js': '// runner\n',
    'server/src/machine.js': '// machine v0\n',
    'server/src/exec.js': '// exec v0\n',
    'server/package.json': '{}\n',
    'server/package-lock.json': '{"v":0}\n',
    'remote/bootstrap.sh': 'CLAUDE_VERSION_WANTED="${CLAUDE_VERSION_WANTED:-2.1.1}"\n',
  }, 'seed');
  git(['push', '-u', 'origin', 'main'], seed);
  for (const name of ['board', 'box']) {
    repos[name] = path.join(ROOT, name);
    git(['clone', repos.origin, repos[name]], ROOT);
    configure(repos[name]);
  }
  repos.c0 = head(repos.box);

  await startRunner();
  // A runner client that sees this box as a POSIX box would: `claude` is the
  // fake's version and home is a scratch directory, not this user's.
  // `commit` and `diskCommit` are the box's as U3 defines them — the HEAD the
  // process started with, and the HEAD on disk now — but read here, without
  // the runner's 5 s git timeout: a loaded machine running the whole suite
  // must not turn a slow `git rev-parse` into a restart that never shows up.
  class FakeBox extends RunnerMachine {
    async info() {
      if (box.down) throw new Error(`${this.name}: se está reiniciando`);
      const info = await super.info();
      const out = {
        ...info,
        claude: readFileSync(path.join(FAKE_DIR, 'claude-version'), 'utf8').trim(),
        home: FAKE_HOME,
        pid: box.pid,
        commit: box.runningCommit,
        diskCommit: head(repos.box),
      };
      // A runner from before U3 (2ed2c6c): no commit, no diskCommit, no monitorDir.
      writeFileSync(path.join(FAKE_DIR, 'box-pid'), String(box.pid));
      // Never the unit this test process itself runs under (a suite run from a runner).
      delete out.unit;
      if (box.unit !== undefined) out.unit = box.unit;
      if (box.legacy) {
        delete out.commit;
        delete out.diskCommit;
        delete out.monitorDir;
      }
      return out;
    }
  }
  box.runningCommit = head(repos.box);
  savedMachines = config.machines;
  registerRunnerClient((name, spec) => new FakeBox(name, spec));
  useMachines();

  // `systemctl --user restart hfsmon-runner`, as the box would do it: the
  // runner is down for a moment and comes back running what is on disk. The
  // HTTP server itself is not closed: the board polls `/info` over keep-alive
  // sockets, and `server.close()` waits for those — on a loaded machine it
  // never finished, and the "restart" never came.
  restartWatch = setInterval(() => {
    const marker = RESTART_MARKER();
    if (box.down || !existsSync(marker)) return;
    rmSync(marker, { force: true });
    // `norestart` swallows one restart, the forward one; the rollback's comes.
    const skip = path.join(FAKE_DIR, 'norestart');
    if (existsSync(skip)) {
      rmSync(skip, { force: true });
      return;
    }
    box.down = true;
    setTimeout(() => {
      try {
        box.runningCommit = head(repos.box);
      } catch { /* git briefly unreachable: the process still comes back */ }
      box.pid += 1;
      box.down = false;
    }, 300);
  }, 100);

  Object.assign(upgrade.upgradeHooks, {
    root: repos.board,
    sdkVersion: () => CURRENT,
    laptopVersions: async () => ({ sdk: CURRENT, cli: WANTED, laptopCli: WANTED }),
    resolveTool: async (name) => !tools.missing.has(name),
    spawnScript: async (opts) => { spawnCalls.push(opts); return 4242; },
    exit: (code) => { exits.push(code); },
    fetchRegistry: async (url) => {
      if (registryState.gate) await registryState.gate;
      const p = url.replace('https://registry.npmjs.org/', '');
      if (p === '@anthropic-ai/claude-agent-sdk/latest') return { status: 200, body: { version: registryState.latest } };
      let m = /^@anthropic-ai\/claude-agent-sdk\/(0\.3\.(\d+))$/.exec(p);
      if (m) return { status: 200, body: { version: m[1], claudeCodeVersion: `2.1.${m[2]}` } };
      m = /^@anthropic-ai\/claude-agent-sdk-win32-x64\/0\.3\.\d+$/.exec(p);
      if (m) return { status: registryState.notInstallable ? 404 : 200, body: {} };
      if (/^@anthropic-ai\/claude-code\/2\.1\.\d+$/.test(p)) return { status: 200, body: {} };
      return { status: 404, body: null };
    },
  });
  // Short polls, long ceilings: the tests wait for outcomes, and a loaded
  // machine only makes them slower, never red.
  Object.assign(upgrade.upgradeHooks.timing, {
    infoTimeoutMs: 30_000, donePollMs: 100, doneTimeoutMs: 180_000, restartPollMs: 150,
    restartTimeoutMs: 180_000, exitDelayMs: 10, laptopWatchMs: 100, staleGraceMs: 1500, missingLooks: 5,
  });

  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use(upgrade.upgradeGuard);
  app.use(upgrade.upgradeRouter());
  app.post('/api/projects/:project/tasks/:issue/retry', (_req, res) => res.json({ ok: true }));
  // The Stop routes, at the paths index.js serves them on.
  for (const route of [
    '/api/projects/:project/tasks/:issue/chat/stop',
    '/api/projects/:project/tasks/:issue/chats/:chatId/plan/stop',
    '/api/projects/:project/tasks/:issue/chats/:chatId/background/:itemId/stop',
    '/api/projects/:project/tasks/:issue/stack/stop',
    '/api/projects/:project/project-chats/:machine/chat/stop',
    '/api/projects/:project/project-chats/:machine/chats/:chatId/plan/stop',
    '/api/projects/:project/project-chats/:machine/chats/:chatId/background/:itemId/stop',
    // Not Stops: they must stay guarded (the guard answers before routing).
    '/api/projects/:project/project-chats/:machine/chats',
    '/api/projects/:project/project-chats/:machine/attachments',
    '/api/projects/:project/project-chats/:machine/model',
    '/api/projects/:project/project-chats/:machine/chats/:chatId/rename',
  ]) app.post(route, (_req, res) => res.json({ ok: true }));
  app.post('/api/settings', (_req, res) => res.json({ ok: true }));
  appServer = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  appPort = appServer.address().port;
});

after(async () => {
  clearInterval(restartWatch);
  if (savedMachines !== undefined) config.machines = savedMachines; else delete config.machines;
  registerRunnerClient((name) => { throw new Error(`machines.${name}: el cliente del runner no está cargado`); });
  await new Promise((r) => appServer.close(r));
  await runner?.close();
  store.flush();
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
});

async function call(method, route, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${appPort}${route}`, {
    method, headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** No job at all, as on a board that never upgraded. */
async function noJob() {
  await upgrade.upgradeRun();
  rmSync(upgrade.jobFile(), { force: true });
  await upgrade.resumeOnBoot();
  assert.equal(upgrade.getUpgradeJob(), null);
}

let n = 500;
const created = [];
function newTask(over = {}) {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  Object.assign(task, over);
  created.push(task.issue);
  return task;
}
function dropTasks() {
  for (const issue of created.splice(0)) delete store.tasks[store.keyFor(issue, 'hfs')];
}
/** A chat mid-turn somewhere: a waiting job stays waiting. */
const holdBoard = () => { newTask().chats[0].busy = true; };

async function jobWith(state, over = {}) {
  const base = {
    id: `u-${state}${n}`, state, target: { sdk: LATEST, cli: CLI_LATEST }, previous: { sdk: CURRENT, cli: WANTED, laptopCli: WANTED },
    onlyLaptop: false, force: false, requestedAt: new Date().toISOString(), startedAt: null, endedAt: null,
    step: null, steps: [], failedStep: null, error: null, runners: {},
    laptop: { commit: null, pushed: null, pushError: null, rolledBack: false },
    scriptPid: null, boardPid: null, logTail: [], acknowledged: false,
  };
  n += 1;
  const value = { ...base, ...over };
  writeFileSync(upgrade.jobFile(), JSON.stringify(value));
  return upgrade.resumeOnBoot();
}

// -----------------------------------------------------------------------------

test('isNewerVersion es estricto: una beta ni se ofrece ni cuenta como instalada', () => {
  assert.equal(claude.isNewerVersion('0.3.273', '0.3.272'), true);
  assert.equal(claude.isNewerVersion('0.3.273-beta.1', '0.3.272'), false, 'una beta no se ofrece');
  assert.equal(claude.isNewerVersion('0.3.273', '0.3.272-beta.1'), false, 'ni se compara contra una');
  assert.equal(claude.isNewerVersion('0.3.273 ', '0.3.272'), false);
  assert.equal(claude.isNewerVersion('v0.3.273', '0.3.272'), false);
  assert.equal(claude.isNewerVersion('0.3', '0.2.9'), false);
  assert.equal(claude.versionAtLeast('2.1.273', '2.1.272'), true);
  assert.equal(claude.versionAtLeast('2.1.272', '2.1.272'), true);
  assert.equal(claude.versionAtLeast('2.1.271', '2.1.272'), false);
  assert.equal(claude.versionAtLeast(null, '2.1.272'), false);
  assert.equal(claude.pairedCliVersion('0.3.273', { claudeCodeVersion: '2.1.280' }), '2.1.280', 'manda el metadato del registry');
  assert.equal(claude.pairedCliVersion('0.3.273', { claudeCodeVersion: '2.1.280-rc' }), '2.1.273', 'un metadato raro cae a la regla');
  assert.equal(claude.pairedCliVersion('0.3.273'), '2.1.273');
  assert.equal(claude.pairedCliVersion('0.4.1'), null);
});

test('latestSdkVersion recuerda un fallo 10 minutos y un acierto un día', async () => {
  const realFetch = globalThis.fetch;
  let hits = 0;
  let answer = 'offline';
  globalThis.fetch = async () => {
    hits += 1;
    if (answer === 'offline') throw new Error('offline');
    return { ok: true, json: async () => ({ version: answer }) };
  };
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  try {
    claude.resetLatestSdkProbe();
    assert.equal(await claude.latestSdkVersion(), null);
    assert.equal(await claude.latestSdkVersion(), null);
    assert.equal(hits, 1, 'el fallo se recuerda');
    mock.timers.tick(9 * 60_000);
    await claude.latestSdkVersion();
    assert.equal(hits, 1, 'a los 9 minutos todavía');
    answer = '0.3.300';
    mock.timers.tick(60_001);
    assert.equal(await claude.latestSdkVersion(), '0.3.300', 'a los 10 se pregunta otra vez');
    assert.equal(hits, 2);
    mock.timers.tick(23 * 60 * 60_000);
    assert.equal(await claude.latestSdkVersion(), '0.3.300');
    assert.equal(hits, 2, 'un acierto dura el día');
    answer = '0.3.301-beta.1';
    mock.timers.tick(60 * 60_000 + 1);
    assert.equal(await claude.latestSdkVersion(), null, 'una beta en latest no es una versión');
    assert.equal(hits, 3);
  } finally {
    mock.timers.reset();
    globalThis.fetch = realFetch;
    claude.resetLatestSdkProbe();
  }
});

test('ajustes: skipped, snoozedUntil y seen se guardan, se validan y se borran con null', () => {
  const before = settings.snapshot().upgrade;
  assert.deepEqual(before, { skipped: null, snoozedUntil: null, seen: null, acknowledgedJob: null });
  const after = settings.update({ upgrade: { skipped: LATEST, snoozedUntil: '2026-09-16T10:00:00Z', seen: LATEST } }).upgrade;
  assert.equal(after.skipped, LATEST);
  assert.equal(after.snoozedUntil, '2026-09-16T10:00:00.000Z');
  assert.equal(after.seen, LATEST);
  assert.equal(JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).upgrade.seen, LATEST, 'va a settings.json');
  assert.throws(() => settings.update({ upgrade: { skipped: '0.3.273-beta.1' } }), /0\.3\.N/);
  assert.throws(() => settings.update({ upgrade: { snoozedUntil: 'mañana' } }), /ISO/);
  assert.throws(() => settings.update({ upgrade: { otra: 1 } }), /does not exist/);
  assert.throws(() => settings.update({ upgrade: 'omitir' }), /must be an object/);
  assert.equal(settings.upgrade.skipped, LATEST, 'un parche inválido no toca nada');
  const cleared = settings.update({ upgrade: { skipped: null, snoozedUntil: null } }).upgrade;
  assert.deepEqual(cleared, { skipped: null, snoozedUntil: null, seen: LATEST, acknowledgedJob: null });
  settings.update({ upgrade: { seen: null } });
});

test('runner atrasado, al día, divergido y desconocido, contra origin/main tras el fetch', async () => {
  // origin moves on with runner code; the box stays at the seed.
  const c1 = commitIn(repos.board, { 'server/src/machine.js': '// machine v1\n', 'server/package-lock.json': '{"v":1}\n' }, 'runner code v1');
  git(['push', 'origin', 'main'], repos.board);
  repos.c1 = c1;
  const tree = git(['rev-parse', `${c1}^{tree}`], repos.board).trim();
  const readmeOnly = git(['commit-tree', tree, '-p', c1, '-m', 'same tree'], repos.board).trim();
  const sibling = git(['commit-tree', tree, '-p', repos.c0, '-m', 'sibling'], repos.board).trim();

  assert.equal(await upgrade.compareRunnerCommit(repos.c0, c1), 'behind');
  assert.equal(await upgrade.compareRunnerCommit(c1, c1), 'current');
  assert.equal(await upgrade.compareRunnerCommit(c1, readmeOnly), 'current', 'nada del runner cambió entre los dos');
  assert.equal(await upgrade.compareRunnerCommit(sibling, c1), 'diverged', 'no es ancestro: nunca se hace pull');
  assert.equal(await upgrade.compareRunnerCommit('f'.repeat(40), c1), 'unknown', 'un sha que aquí no existe');
  assert.equal((await upgrade.runnerCodeStatus({}, c1)).status, 'unknown', 'un runner viejo sin campos');
  assert.equal((await upgrade.runnerCodeStatus({ commit: null, diskCommit: repos.c0 }, c1)).status, 'unknown', 'null es desconocido');
  assert.equal((await upgrade.runnerCodeStatus({ commit: '--help', diskCommit: null }, c1)).status, 'unknown');

  // Detection fetches first: origin/main is the target, not the board's HEAD.
  git(['reset', '--hard', repos.c0], repos.board);
  git(['update-ref', 'refs/remotes/origin/main', repos.c0], repos.board);
  const state = await upgrade.upgradeState({ fresh: true });
  git(['reset', '--hard', c1], repos.board);
  assert.equal(state.git.originMain, c1, 'tras el fetch, origin/main es el de verdad');
  assert.equal(state.machines.box.runner.status, 'behind');
  assert.equal(state.machines.box.runner.commit, repos.c0, 'lo que corre');
  assert.equal(state.machines.box.runner.target, c1);
  assert.equal(state.sdk.latest, LATEST);
  assert.equal(state.sdk.behind, true);
  assert.equal(state.sdk.cli, CLI_LATEST, 'el CLI sale del claudeCodeVersion del registry');
  assert.equal(state.sdk.installable, true);
  assert.equal(state.machines.local.ok, true);
});

test('a commit that only touches plugins/ leaves the runner behind', async () => {
  // Dangling commits built with plumbing: the shared repo HEAD never moves.
  const gitIn = (args, input) => execFileSync('git', args, { cwd: repos.board, input, stdio: 'pipe', encoding: 'utf8' }).trim();
  const base = repos.c1 ?? head(repos.board);
  const blob = gitIn(['hash-object', '-w', '--stdin'], '{"name":"hfs-ux"}\n');
  const sub = gitIn(['mktree'], `100644 blob ${blob}\tplugin.json\n`);
  const plugins = gitIn(['mktree'], `040000 tree ${sub}\thfs-ux\n`);
  const rootEntries = gitIn(['ls-tree', `${base}^{tree}`]);
  const tree = gitIn(['mktree'], `${rootEntries}\n040000 tree ${plugins}\tplugins\n`);
  const pluginsOnly = gitIn(['commit-tree', tree, '-p', base, '-m', 'plugins only']);

  assert.equal(await upgrade.compareRunnerCommit(base, pluginsOnly), 'behind');
  assert.ok(upgrade.RUNNER_PATHS.includes('plugins/'));
});

test('target: solo 0.3.N y solo la última; nada de inyecciones, betas ni versiones viejas', async () => {
  await noJob();
  for (const target of ['0.3.273; rm -rf /', `${LATEST}-beta.1`, '0.3.1234567', 273, null, "0.3.1' -JobId x"]) {
    const r = await call('POST', '/api/upgrade', { target });
    assert.equal(r.status, 400, `rechaza ${JSON.stringify(target)}`);
  }
  const old = await call('POST', '/api/upgrade', { target: '0.3.1' });
  assert.equal(old.status, 400);
  assert.match(old.body.error, /not the latest/);
  assert.equal(upgrade.getUpgradeJob(), null, 'y no deja job');
});

test('force: solo con HFSMON_UPGRADE_FORCE=1 y desde loopback directo, y reinstala la versión actual', async () => {
  await noJob();
  holdBoard();
  try {
    let r = await call('POST', '/api/upgrade', { target: CURRENT, force: true });
    assert.equal(r.status, 403, 'sin la variable');
    process.env.HFSMON_UPGRADE_FORCE = '1';
    r = await call('POST', '/api/upgrade', { target: CURRENT, force: true }, { 'x-forwarded-for': '100.64.0.9' });
    assert.equal(r.status, 403, 'por un proxy no vale');
    r = await call('POST', '/api/upgrade', { target: CURRENT, force: true }, { 'tailscale-user-login': 'user@example.com' });
    assert.equal(r.status, 403);
    r = await call('POST', '/api/upgrade', { target: LATEST, force: true });
    assert.equal(r.status, 400, 'con force el objetivo es la versión instalada');
    r = await call('POST', '/api/upgrade', { target: CURRENT, force: true });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.job.force, true);
    assert.deepEqual(r.body.job.target, { sdk: CURRENT, cli: WANTED });
    assert.equal(r.body.job.state, 'waiting', 'un chat ocupado la deja esperando');
    const cancel = await call('POST', '/api/upgrade/cancel');
    assert.deepEqual(cancel, { status: 200, body: { job: null } });
  } finally {
    delete process.env.HFSMON_UPGRADE_FORCE;
    dropTasks();
  }
});

test('las comprobaciones previas devuelven 409 con cada bloqueo', async () => {
  await noJob();
  const codes = (r) => (r.body.blockers ?? []).map((b) => b.code);

  write(repos.board, 'server/package.json', '{"sucio":true}\n');
  let r = await call('POST', '/api/upgrade', { target: LATEST });
  git(['checkout', '--', 'server/package.json'], repos.board);
  assert.equal(r.status, 409);
  assert.deepEqual(codes(r), ['dirty_files']);
  assert.deepEqual(r.body.blockers[0].files, ['server/package.json']);

  git(['checkout', '-b', 'otra'], repos.board);
  r = await call('POST', '/api/upgrade', { target: LATEST });
  git(['checkout', 'main'], repos.board);
  assert.deepEqual(codes(r), ['wrong_branch']);

  tools.missing.add('claude');
  r = await call('POST', '/api/upgrade', { target: LATEST });
  tools.missing.clear();
  assert.deepEqual(codes(r), ['missing_tool']);
  assert.equal(r.body.blockers[0].tool, 'claude');

  registryState.notInstallable = true;
  r = await call('POST', '/api/upgrade', { target: LATEST });
  registryState.notInstallable = false;
  assert.deepEqual(codes(r), ['not_installable']);

  const net = await import('node:net');
  const probe = net.createServer();
  await new Promise((res) => probe.listen(0, '127.0.0.1', res));
  const deadPort = probe.address().port;
  await new Promise((res) => probe.close(res));
  useMachines({ boxUrl: `http://127.0.0.1:${deadPort}` });
  holdBoard();
  try {
    r = await call('POST', '/api/upgrade', { target: LATEST });
    assert.equal(r.status, 409);
    assert.deepEqual(codes(r), ['runner_offline']);
    assert.equal(r.body.blockers[0].machine, 'box');
    assert.equal(upgrade.getUpgradeJob(), null);
    r = await call('POST', '/api/upgrade', { target: LATEST, onlyLaptop: true });
    assert.equal(r.status, 202, '«Solo la portátil» pasa');
    assert.equal(r.body.job.onlyLaptop, true);
    assert.deepEqual(r.body.job.runners, {});
    await call('POST', '/api/upgrade/cancel');
  } finally {
    useMachines();
    dropTasks();
  }
});

test('idleReasons: cada cosa en marcha es un motivo, y un stack arriba solo un aviso', () => {
  dropTasks();
  const now = new Date().toISOString();
  const cases = [
    [{ state: 'fixing' }, /working/],
    [{}, /chat turn/, (t) => { t.chats[0].busy = true; }],
    [{}, /ejecutando un plan/, (t) => { t.chats[0].plan = { status: 'running', tasks: [] }; }],
    [{}, /1 comando/, (t) => { t.chats[0].messages.push({ id: 'a1', role: 'activity', items: [{ kind: 'bash', background: true, status: 'running', command: 'cargo test', startedAt: now }] }); }],
    [{ demoBusy: true }, /demo/],
    [{ qaBusy: true }, /Browser QA/],
    [{ creatingWorktree: true }, /creando el worktree/],
    [{ moving: { from: 'local', to: 'box', step: 'build_target', error: null } }, /moving to another machine/],
    [{ prewarm: { machine: 'box', startedAt: now, endedAt: null } }, /precompilando en box/],
    [{ workPlan: { status: 'running', tasks: [] } }, /plan de trabajo/],
    [{ stack: { status: 'starting', services: {} } }, /stack is being built/],
  ];
  for (const [over, pattern, tweak] of cases) {
    const task = newTask(over);
    tweak?.(task);
    const { reasons, warnings } = upgrade.idleReasons();
    assert.equal(reasons.length, 1, `${pattern}: ${JSON.stringify(reasons)}`);
    assert.equal(reasons[0].issue, task.issue);
    assert.match(reasons[0].text, pattern);
    assert.deepEqual(warnings, []);
    dropTasks();
  }

  newTask({ moving: { from: 'local', to: 'box', step: 'source_git', error: 'push rechazado' } });
  newTask({ prewarm: { machine: 'box', startedAt: now, endedAt: now, ok: true } });
  const stack = newTask({ stack: { status: 'running', services: {} } });
  const { reasons, warnings } = upgrade.idleReasons();
  assert.deepEqual(reasons, [], 'una mudanza fallida y un prewarm terminado no esperan');
  assert.deepEqual(warnings, [{ issue: stack.issue, text: 'el stack de HFS se parará' }]);
  dropTasks();
});

test('login: idleReasons marca la máquina de cada motivo; una mudanza cuenta en las dos', () => {
  dropTasks();
  const t = newTask({ machine: 'box', qaBusy: true });
  const m = newTask({ moving: { from: 'local', to: 'box', step: 'build_target', error: null } });
  const { reasons, warnings } = upgrade.idleReasons();
  assert.equal(reasons.find((r) => r.issue === t.issue).machine, 'box');
  const moving = reasons.find((r) => r.issue === m.issue);
  assert.equal(moving.machine, m.machine ?? 'local');
  assert.deepEqual(moving.machines, ['local', 'box']);
  assert.deepEqual(warnings, []);
  dropTasks();
});

test('idleReasons: a clone running or queued on a machine is a reason; a waiting upgrade refuses new work', async () => {
  dropTasks();
  await noJob();
  const { checkoutHooks, ensureCheckout, resetCheckouts } = await import('../src/checkout.js');
  assert.equal(checkoutHooks.holdsNewWork, upgrade.upgradeHoldsNewWork, 'upgrade.js hands over its guard');
  const savedReadiness = checkoutHooks.readiness;
  let release;
  const hold = new Promise((r) => { release = r; });
  // The box's checkout is there already: only its check is held, and nothing is cloned.
  checkoutHooks.readiness = async () => { await hold; return { ready: true }; };
  try {
    resetCheckouts();
    const job = ensureCheckout('box', 'hfs');
    let { reasons } = upgrade.idleReasons();
    assert.equal(reasons.length, 1, JSON.stringify(reasons));
    assert.equal(reasons[0].machine, 'box');
    assert.equal(reasons[0].project, 'hfs');
    assert.equal(reasons[0].issue, null);
    assert.match(reasons[0].text, /waiting for its checkout on box/);
    await waitFor(() => /cloning or checking .+ on box/.test(upgrade.idleReasons().reasons[0]?.text), 'the job starts');
    release();
    await job;
    ({ reasons } = upgrade.idleReasons());
    assert.deepEqual(reasons, [], 'a finished job holds nothing');

    holdBoard();
    await upgrade.requestUpgrade({ target: LATEST });
    let installed = false;
    await assert.rejects(
      () => ensureCheckout('box', 'hfs', { install: async () => { installed = true; } }),
      /The board is updating/,
    );
    assert.equal(installed, false);
    upgrade.cancelUpgrade();
  } finally {
    release();
    checkoutHooks.readiness = savedReadiness;
    resetCheckouts();
    dropTasks();
  }
});

test('login: bundledCliPath se exporta y apunta al binario del SDK (o a null)', () => {
  const p = upgrade.bundledCliPath();
  assert.ok(p === null || /claude(\.exe)?$/.test(p), String(p));
});

test('login: un login en marcha da 409 a crear, a empezar y a «Actualizar ya»', async () => {
  await noJob();
  holdBoard();
  const saved = upgrade.upgradeHooks.loginRunning;
  try {
    upgrade.upgradeHooks.loginRunning = () => true;
    await assert.rejects(() => upgrade.requestUpgrade({ target: LATEST }), (e) => e.status === 409 && /login/.test(e.message));
    assert.equal(upgrade.getUpgradeJob(), null, 'no se creó ningún job');

    upgrade.upgradeHooks.loginRunning = () => false;
    const job = await upgrade.requestUpgrade({ target: LATEST });
    assert.equal(job.state, 'waiting');

    upgrade.upgradeHooks.loginRunning = () => true;
    assert.equal(await upgrade.startRunning({ now: true }), null, '«ya» tampoco se salta el login');
    await assert.rejects(() => upgrade.upgradeNow(), (e) => e.status === 409 && /login/.test(e.message));
    assert.equal(upgrade.getUpgradeJob().state, 'waiting', 'el job sigue esperando');
  } finally {
    upgrade.upgradeHooks.loginRunning = saved;
    await call('POST', '/api/upgrade/cancel');
    dropTasks();
  }
});

test('dos POST a la vez crean un solo job; el segundo recibe 409 con él', async () => {
  await noJob();
  holdBoard();
  try {
    const [a, b] = await Promise.allSettled([
      upgrade.requestUpgrade({ target: LATEST }, { loopback: true }),
      upgrade.requestUpgrade({ target: LATEST }, { loopback: true }),
    ]);
    assert.equal(a.status, 'fulfilled');
    assert.equal(b.status, 'rejected');
    assert.equal(b.reason.status, 409);
    assert.equal(b.reason.job.id, a.value.id);
    assert.equal(a.value.state, 'waiting');
    assert.deepEqual(a.value.runners.box, { commitBefore: repos.c0, commitAfter: null, cliBefore: WANTED, cliAfter: null });
    assert.deepEqual(a.value.previous, { sdk: CURRENT, cli: WANTED, laptopCli: WANTED });
    const onDisk = JSON.parse(readFileSync(upgrade.jobFile(), 'utf8'));
    assert.equal(onDisk.id, a.value.id);
    assert.equal((await upgrade.startRunning()), null, 'sin «ya», un chat ocupado sigue esperando');
  } finally {
    await call('POST', '/api/upgrade/cancel');
    dropTasks();
  }
});

test('mientras espera, tick y startChangeRequest no empiezan nada nuevo', async () => {
  await noJob();
  holdBoard();
  const queued = newTask({ classified: true });
  const cr = newTask({ state: 'waiting_approval', changeRequests: [{ reviewId: 77, status: 'pending' }], activeChangeRequest: 77 });
  await upgrade.requestUpgrade({ target: LATEST });
  const savedPath = process.env.PATH;
  const empty = path.join(ROOT, 'empty-bin');
  mkdirSync(empty, { recursive: true });
  try {
    assert.equal(upgrade.upgradeHoldsNewWork(), true);
    delete process.env.HFSMON_NO_AUTOSTART;
    // Nothing reachable on PATH: if a gate leaks, the pipeline dies at its
    // first `gh`, and never touches a network or a repo.
    process.env.PATH = empty;
    pipeline.tick();
    assert.equal(pipeline.isRunning(queued.issue), false, 'tick no arranca la tarea en cola');
    assert.equal(pipeline.startChangeRequest(cr.issue), false);
    assert.equal(pipeline.isRunning(cr.issue), false, 'ni el change request');

    upgrade.cancelUpgrade();
    pipeline.tick();
    assert.equal(pipeline.isRunning(queued.issue), true, 'cancelada, la misma tarea sí arranca');
  } finally {
    process.env.PATH = savedPath;
    process.env.HFSMON_NO_AUTOSTART = '1';
  }
  await waitFor(() => !pipeline.isRunning(queued.issue), 'la tarea arrancada muere en su primer gh');
  dropTasks();
});

test('mientras corre: sendChat contesta sin enviar, las acciones dan 409 y las rutas también', async () => {
  await noJob();
  const task = newTask();
  const chat = task.chats[0];
  const cr = newTask({ changeRequests: [{ reviewId: 78, status: 'pending' }], activeChangeRequest: 78 });
  writeFileSync(upgrade.lockFile(), JSON.stringify({ pid: process.pid }));
  try {
    await jobWith('laptop', { scriptPid: process.pid, step: 'laptop_install' });
    assert.equal(upgrade.upgradeRunning(), true);

    pipeline.sendChat(task.issue, chat.id, 'hola');
    const [asked, answer] = chat.messages.slice(-2);
    assert.equal(asked.role, 'user');
    assert.equal(answer.role, 'assistant');
    assert.match(answer.text, /updating: this message was not sent/);
    assert.equal(chat.busy, false);

    assert.throws(() => pipeline.createChat(task.issue), (e) => e.status === 409 && e.message === 'The board is updating');
    assert.throws(() => pipeline.retry(task.issue), (e) => e.status === 409);
    assert.throws(() => pipeline.startChangeRequest(cr.issue, { force: true }), (e) => e.status === 409);
    assert.equal(pipeline.isRunning(cr.issue), false);

    const blocked = await call('POST', '/api/projects/hfs/tasks/1/retry');
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'The board is updating');
    assert.equal((await call('POST', '/api/settings', {})).status, 200, 'los ajustes siguen');
    assert.equal((await call('GET', '/api/upgrade')).status, 200);
    assert.equal((await call('POST', '/api/upgrade/cancel')).status, 409, 'ya no se cancela');
    assert.equal((await call('POST', '/api/upgrade/now')).status, 409);
    assert.equal((await call('POST', '/api/upgrade', { target: LATEST })).status, 409, 'ni se pide otra');
  } finally {
    rmSync(upgrade.lockFile(), { force: true });
    await noJob();
    dropTasks();
  }
  assert.equal((await call('POST', '/api/projects/hfs/tasks/1/retry')).status, 200, 'sin job, la ruta vuelve a pasar');
});

test('pasos del runner con un runner en proceso: CLI por systemd-run y .done, pull, npm ci, reinicio y relevo', { skip: SHELL_SKIP }, async () => {
  await noJob();
  await settleBox();
  rmSync(path.join(FAKE_DIR, 'calls.log'), { force: true });
  fakeClaude(WANTED);
  const r = await call('POST', '/api/upgrade', { target: LATEST });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const id = r.body.job.id;
  await upgrade.upgradeRun();
  const job = upgrade.getUpgradeJob();
  assert.equal(job.error, null, job.error);
  assert.equal(job.state, 'laptop');
  assert.deepEqual(job.steps.map((s) => `${s.name}:${s.state}`), [
    'runner_check:ok', 'runner_cli:ok', 'runner_code:ok', 'runner_restart:ok', 'laptop_launch:ok',
  ]);
  assert.equal(job.scriptPid, 4242);
  assert.equal(job.boardPid, process.pid);
  assert.deepEqual(spawnCalls, [{ root: repos.board, boardPid: process.pid, jobId: id }]);
  await waitFor(() => exits.length > 0, 'el tablero sale');
  assert.deepEqual(exits, [0], 'y el tablero sale');

  assert.equal(head(repos.box), repos.c1, 'el runner quedó en origin/main');
  const info = await machines().box.info();
  assert.equal(info.commit, repos.c1, 'y corre ese código tras el reinicio');
  assert.equal(info.diskCommit, repos.c1);
  assert.equal(info.claude, CLI_LATEST);
  assert.deepEqual(job.runners.box, { commitBefore: repos.c0, commitAfter: repos.c1, cliBefore: WANTED, cliAfter: CLI_LATEST });

  const log = calls();
  assert.match(log, new RegExp(`--unit=hfsmon-upgrade-${id}-cli --setenv=PATH=.+ --setenv=HOME=\\S+ --working-directory=\\S+ sh -c timeout 900 claude install ${CLI_LATEST} `), 'el CLI se instala fuera del cgroup, con PATH');
  assert.match(log, new RegExp(`--unit=hfsmon-upgrade-${id}-restart .*--on-active=2s systemctl --user restart hfsmon-runner`));
  assert.match(log, /npm ci --omit=dev/, 'el lock cambió: npm ci');
  const done = path.join(FAKE_HOME, '.hfs-monitor', 'upgrade', `${id}-cli.done`);
  assert.equal(readFileSync(done, 'utf8').trim(), '0');

  const onDisk = JSON.parse(readFileSync(upgrade.jobFile(), 'utf8'));
  assert.equal(onDisk.state, 'laptop');
  assert.equal(onDisk.scriptPid, 4242, 'la última escritura lleva el PID del script');
  assert.equal(onDisk.steps.at(-1).state, 'ok');
  const laptopLog = readFileSync(upgrade.logFile(id), 'utf8');
  assert.match(laptopLog, /box\$ .*git pull --ff-only/);
  assert.ok(onDisk.logTail.length > 0 && onDisk.logTail.length <= 40);
  assert.equal(onDisk.logTail.at(-1), laptopLog.trim().split(/\r?\n/).at(-1));
  assert.equal(upgrade.upgradeHoldsNewWork(), true);
});

test('resumeOnBoot: waiting sigue, running falla en su paso, laptop espera al script, done/failed se quedan', { skip: SHELL_SKIP }, async () => {
  await settleBox();
  // waiting
  holdBoard();
  let job = await jobWith('waiting');
  assert.equal(job.state, 'waiting');
  assert.equal(upgrade.upgradeHoldsNewWork(), true);
  upgrade.cancelUpgrade();
  dropTasks();

  // running: cut in the runner steps
  job = await jobWith('running', {
    step: 'runner_code',
    steps: [{ name: 'runner_check', state: 'ok', detail: 'box', at: 'x' }, { name: 'runner_code', state: 'running', detail: 'box', at: 'x' }],
    runners: { box: { commitBefore: repos.c0, commitAfter: null, cliBefore: WANTED, cliAfter: null } },
  });
  assert.equal(job.state, 'failed');
  assert.equal(job.failedStep, 'runner_code');
  assert.equal(job.steps[1].state, 'failed');
  assert.match(job.error, /se reinició durante los pasos del runner/);
  assert.equal(job.runners.box.commitAfter, head(repos.box), 'con el diskCommit del runner');
  assert.equal(job.runners.box.cliAfter, CLI_LATEST, 'y su claude');
  assert.equal(upgrade.upgradeHoldsNewWork(), false, 'la puerta se libera');

  // laptop, script alive: a half-written file is retried, never a failure
  writeFileSync(upgrade.lockFile(), JSON.stringify({ pid: process.pid }));
  job = await jobWith('laptop', { scriptPid: process.pid, step: 'laptop_install' });
  assert.equal(job.state, 'laptop');
  writeFileSync(upgrade.jobFile(), '{"state": "lap');
  await sleep(300);
  assert.equal(upgrade.getUpgradeJob().state, 'laptop', 'un JSON a medias no es un fallo');
  // PowerShell 5.1's Move-Item -Force: for a moment there is no file at all.
  rmSync(upgrade.jobFile(), { force: true });
  await sleep(300);
  assert.equal(upgrade.getUpgradeJob()?.state, 'laptop', 'sin archivo tampoco: el job se conserva');
  assert.equal(upgrade.upgradeRunning(), true, 'y la puerta sigue cerrada');
  rmSync(upgrade.lockFile(), { force: true });
  const id = `u-laptop${n}`;
  writeFileSync(upgrade.jobFile(), `﻿${JSON.stringify({ ...job, id, state: 'done', step: 'laptop_start', endedAt: new Date().toISOString() })}`);
  await waitFor(() => upgrade.getUpgradeJob()?.state !== 'laptop', 'el tablero relee el resultado');
  assert.equal(upgrade.getUpgradeJob().state, 'done', 'el resultado del script llega, BOM incluido');
  assert.equal(upgrade.upgradeHoldsNewWork(), false);

  // laptop, script gone without a result
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const deadId = `u-dead${n}`;
  mkdirSync(path.dirname(upgrade.logFile(deadId)), { recursive: true });
  writeFileSync(upgrade.logFile(deadId), `${Array.from({ length: 50 }, (_, i) => `2026-09-15T10:00:00Z línea ${i}`).join('\n')}\n`);
  job = await jobWith('laptop', { id: deadId, scriptPid: dead, step: 'laptop_install' });
  assert.equal(job.state, 'failed');
  assert.equal(job.failedStep, 'laptop_install');
  assert.match(job.error, /sin dejar resultado/);
  assert.equal(job.logTail.length, 40);
  assert.equal(job.logTail.at(-1).split(' ').slice(1).join(' '), 'falló en laptop_install: El script de actualización terminó sin dejar resultado');

  // done and failed stay until acknowledged
  job = await jobWith('done', { id: 'u-hecho1', endedAt: new Date().toISOString() });
  assert.equal(job.state, 'done');
  assert.equal(job.acknowledged, false);
  assert.equal((await call('POST', '/api/upgrade/ack', { id: 'u-otro' })).status, 404);
  const acked = await call('POST', '/api/upgrade/ack', { id: 'u-hecho1' });
  assert.equal(acked.status, 200);
  assert.equal(acked.body.job.acknowledged, true);
  assert.equal(settings.upgrade.acknowledgedJob, 'u-hecho1');
  job = await jobWith('failed', { id: 'u-fallo1', failedStep: 'laptop_verify', error: 'x' });
  assert.equal(job.state, 'failed');
  assert.equal(job.failedStep, 'laptop_verify');
  settings.update({ upgrade: { acknowledgedJob: null } });
});

test('vuelta atrás del runner con --keep cuando no vuelve tras el reinicio; la portátil no se toca', { skip: SHELL_SKIP }, async () => {
  await noJob();
  await settleBox();
  const pidBefore = box.pid;
  const c3 = commitIn(repos.board, { 'server/src/exec.js': '// exec v3\n', 'server/package-lock.json': '{"v":3}\n' }, 'runner code v3');
  git(['push', 'origin', 'main'], repos.board);
  repos.c3 = c3;
  write(repos.box, 'notas-locales.txt', 'sin seguimiento\n');
  rmSync(path.join(FAKE_DIR, 'calls.log'), { force: true });
  flag('norestart', true);
  const saved = upgrade.upgradeHooks.timing.restartTimeoutMs;
  // The forward restart never comes (norestart), whatever the ceiling; the
  // rollback's own wait matches on its first look, so 10 s is room enough.
  upgrade.upgradeHooks.timing.restartTimeoutMs = 10_000;
  const spawnsBefore = spawnCalls.length;
  try {
    const job = await upgrade.requestUpgrade({ target: LATEST });
    await upgrade.upgradeRun();
    assert.equal(job.state, 'failed');
    assert.equal(job.failedStep, 'runner_restart');
    assert.match(job.error, /did not come back/);
    assert.deepEqual(job.steps.map((s) => `${s.name}:${s.state}`), [
      'runner_check:ok', 'runner_cli:skipped', 'runner_code:ok', 'runner_restart:failed', 'runner_rollback:ok',
    ]);
    assert.equal(head(repos.box), repos.c1, 'de vuelta en el commit de antes');
    // The rollback waits for its own restart: done means the box already came
    // back, not that a restart is still on its way to the next test.
    assert.ok(box.pid > pidBefore, 'la vuelta atrás espera a que el runner se reinicie de verdad');
    assert.equal(box.down, false);
    assert.equal(existsSync(RESTART_MARKER()), false, 'sin reinicio pendiente al terminar');
    assert.equal(existsSync(path.join(repos.box, 'notas-locales.txt')), true);
    assert.match(readFileSync(upgrade.logFile(job.id), 'utf8'), new RegExp(`git reset --keep ${repos.c1}`));
    assert.equal(calls().match(/npm ci --omit=dev/g).length, 2, 'npm ci al subir y al volver');
    assert.match(calls(), new RegExp(`--unit=hfsmon-upgrade-${job.id}-rollback`));
    assert.equal(spawnCalls.length, spawnsBefore, 'sin relevo a la portátil');
    assert.equal(upgrade.upgradeHoldsNewWork(), false);
  } finally {
    flag('norestart', false);
    upgrade.upgradeHooks.timing.restartTimeoutMs = saved;
    rmSync(path.join(repos.box, 'notas-locales.txt'), { force: true });
  }
});

test('pre-check: la unidad hfsmon-runner con otro MainPID que el /info falla en runner_check, sin tocar nada', { skip: SHELL_SKIP }, async () => {
  await noJob();
  await settleBox();
  const c4 = commitIn(repos.board, { 'server/src/exec.js': '// exec v4\n' }, 'runner code v4');
  git(['push', 'origin', 'main'], repos.board);
  repos.c4 = c4;
  const other = box.pid + 1000;
  writeFileSync(path.join(FAKE_DIR, 'unit-mainpid'), String(other));
  rmSync(path.join(FAKE_DIR, 'calls.log'), { force: true });
  try {
    const job = await upgrade.requestUpgrade({ target: LATEST });
    await upgrade.upgradeRun();
    assert.equal(job.state, 'failed');
    assert.equal(job.failedStep, 'runner_check');
    assert.match(job.error, new RegExp(`pid ${other}`));
    assert.match(job.error, new RegExp(`pid ${box.pid}`));
    assert.match(job.error, /systemctl --user restart hfsmon-runner/);
    assert.doesNotMatch(calls(), /--on-active/, 'sin reinicio programado');
    assert.equal(head(repos.box), repos.c1, 'el runner no se tocó');
  } finally {
    rmSync(path.join(FAKE_DIR, 'unit-mainpid'), { force: true });
  }
});

test('solo los runners: SDK al día con un runner atrasado, termina en done sin tocar la portátil', { skip: SHELL_SKIP }, async () => {
  await noJob();
  await settleBox();
  const c5 = commitIn(repos.board, { 'server/src/runner-client.js': '// runner client v5' }, 'runner code v5');
  git(['push', 'origin', 'main'], repos.board);
  assert.notEqual(box.runningCommit, c5, 'el runner va por detrás de origin/main');
  registryState.latest = CURRENT;
  const spawnsBefore = spawnCalls.length;
  const exitsBefore = exits.length;
  try {
    let r = await call('POST', '/api/upgrade', { target: CURRENT });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.job.runnerOnly, true);
    await upgrade.upgradeRun();
    let job = upgrade.getUpgradeJob();
    assert.equal(job.state, 'done', job.error);
    assert.deepEqual(job.steps.map((s) => `${s.name}:${s.state}`), [
      'runner_check:ok', 'runner_cli:skipped', 'runner_code:ok', 'runner_restart:ok',
    ]);
    assert.equal(head(repos.box), c5);
    assert.equal(spawnCalls.length, spawnsBefore, 'sin upgrade.ps1');
    assert.equal(exits.length, exitsBefore, 'y el tablero sigue');

    // A CLI below the pair of the installed SDK is reason enough on its own.
    fakeClaude('2.1.1');
    r = await call('POST', '/api/upgrade', { target: CURRENT });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await upgrade.upgradeRun();
    job = upgrade.getUpgradeJob();
    assert.equal(job.state, 'done', job.error);
    assert.deepEqual(job.steps.map((s) => `${s.name}:${s.state}`), [
      'runner_check:ok', 'runner_cli:ok', 'runner_code:skipped', 'runner_restart:skipped',
    ]);
    assert.equal(readFileSync(path.join(FAKE_DIR, 'claude-version'), 'utf8').trim(), WANTED);

    r = await call('POST', '/api/upgrade', { target: CURRENT });
    assert.deepEqual(r, { status: 400, body: { error: 'nothing to update' } });
  } finally {
    registryState.latest = LATEST;
    fakeClaude(CLI_LATEST);
  }
});

// --- the runner's unit name comes from /info -----------------------------

const unitCase = async (name, { reported, existing, rollback = false }, check) => {
  await noJob();
  await settleBox();
  const n = (repos.unitN = (repos.unitN ?? 0) + 1);
  commitIn(repos.board, { 'server/src/runner-client.js': `// unit case ${name} ${n}` }, `runner code unit ${n}`);
  git(['push', 'origin', 'main'], repos.board);
  box.unit = reported;
  writeFileSync(path.join(FAKE_DIR, 'unit-name'), existing);
  if (rollback) flag('norestart', true);
  const saved = upgrade.upgradeHooks.timing.restartTimeoutMs;
  if (rollback) upgrade.upgradeHooks.timing.restartTimeoutMs = 10_000;
  const before = head(repos.box);
  rmSync(path.join(FAKE_DIR, 'calls.log'), { force: true });
  registryState.latest = CURRENT;
  try {
    await call('POST', '/api/upgrade', { target: CURRENT });
    await upgrade.upgradeRun();
    await check(upgrade.getUpgradeJob(), before);
  } finally {
    registryState.latest = LATEST;
    box.unit = undefined;
    rmSync(path.join(FAKE_DIR, 'unit-name'), { force: true });
    flag('norestart', false);
    upgrade.upgradeHooks.timing.restartTimeoutMs = saved;
    await settleBox();
  }
};

test('unit from /info: the pre-check, the restart and the pid wait all use livemon-runner.service', { skip: SHELL_SKIP }, async () => {
  await unitCase('reported', { reported: 'livemon-runner.service', existing: 'livemon-runner' }, async (job) => {
    assert.equal(job.state, 'done', job.error);
    const log = calls();
    assert.match(log, /systemctl --user show livemon-runner\.service -p LoadState/);
    assert.match(log, /--on-active=2s systemctl --user restart livemon-runner\.service/);
    assert.doesNotMatch(log, /restart hfsmon-runner/);
    assert.doesNotMatch(log, /show hfsmon-runner/);
  });
});

test('unit from /info: a unit that does not exist fails runner_check early, schedules no restart, touches nothing', { skip: SHELL_SKIP }, async () => {
  await unitCase('missing', { reported: 'livemon-runner.service', existing: 'something-else' }, async (job, before) => {
    assert.equal(job.state, 'failed');
    assert.equal(job.failedStep, 'runner_check');
    assert.match(job.error, /the runner process \(pid \d+\) is not managed by a systemd user unit named livemon-runner\.service: the board cannot restart it; start it under a user unit or restart it by hand/);
    assert.doesNotMatch(job.error, /older version/);
    assert.doesNotMatch(calls(), /--on-active/);
    assert.equal(head(repos.box), before, 'ni un git reset');
  });
});

test('old runner (no unit in /info) whose unit has another name: fails early and says to restart it once by hand', { skip: SHELL_SKIP }, async () => {
  await unitCase('old-other', { reported: undefined, existing: 'livemon-runner' }, async (job, before) => {
    assert.equal(job.state, 'failed');
    assert.equal(job.failedStep, 'runner_check');
    assert.match(job.error, /named hfsmon-runner\.service/);
    assert.match(job.error, /older version/);
    assert.match(job.error, /restart it once by hand/);
    assert.doesNotMatch(calls(), /--on-active/);
    assert.equal(head(repos.box), before);
  });
});

test('old runner (no unit in /info) whose unit is hfsmon-runner still upgrades, and an injected unit name is ignored', { skip: SHELL_SKIP }, async () => {
  for (const reported of [undefined, 'x; rm -rf ~']) {
    await unitCase('fallback', { reported, existing: 'hfsmon-runner' }, async (job) => {
      assert.equal(job.state, 'done', job.error);
      assert.match(calls(), /--on-active=2s systemctl --user restart hfsmon-runner\.service/);
      assert.doesNotMatch(calls(), /rm -rf/);
    });
  }
});

test('unit from /info: the rollback restarts the same unit', { skip: SHELL_SKIP }, async () => {
  await unitCase('rollback', { reported: 'livemon-runner.service', existing: 'livemon-runner', rollback: true }, async (job, before) => {
    assert.equal(job.state, 'failed');
    assert.equal(job.failedStep, 'runner_restart');
    assert.equal(head(repos.box), before, 'de vuelta en el commit de antes');
    const log = calls();
    assert.match(log, new RegExp(`--unit=hfsmon-upgrade-${job.id}-rollback .*--on-active=2s systemctl --user restart livemon-runner\.service`));
    assert.doesNotMatch(log, /restart hfsmon-runner/);
    assert.match(job.error, /livemon-runner\.service/);
  });
});

test('al día, la detección describe la versión instalada en vez de un marcador de nulos', async () => {
  await noJob();
  await settleBox();
  registryState.latest = CURRENT;
  // The box on origin/main and running it: its code is up to date, so the CLI
  // is the only thing that can be behind.
  git(['pull', '--ff-only', '--quiet', 'origin', 'main'], repos.box);
  box.runningCommit = head(repos.box);
  try {
    let state = await upgrade.upgradeState({ fresh: true });
    assert.equal(state.sdk.behind, false);
    assert.equal(state.sdk.latest, CURRENT);
    assert.equal(state.sdk.cli, WANTED, 'el CLI de la versión instalada, no null');
    assert.equal(state.sdk.installable, true, 'y lo que diga el registry, no un false de relleno');
    assert.equal(state.sdk.manual, false);
    assert.equal(state.machines.box.runner.status, 'current');
    assert.deepEqual(upgrade.runnersNeedingUpdate(state), [], 'con todo al día no hay runner que tocar');

    // A runner whose CLI fell behind while its code is current: exactly what a
    // runner-only job fixes. With `sdk.cli` null the dialog read this as
    // «todo está al día», because that is what it compares the CLI against.
    fakeClaude('2.1.1');
    state = await upgrade.upgradeState({ fresh: true });
    assert.equal(state.machines.box.claude, '2.1.1');
    assert.equal(state.machines.box.wanted, WANTED, 'la columna «Objetivo» de cada máquina');
    assert.equal(state.machines.box.ok, false);
    assert.equal(state.machines.box.runner.status, 'current', 'el código no es lo que falla');
    assert.equal(state.sdk.cli, WANTED, 'contra qué se compara el CLI de la box');
    assert.deepEqual(upgrade.runnersNeedingUpdate(state), ['box']);

    // What npm serves of the installed version is told as it is, too.
    registryState.notInstallable = true;
    state = await upgrade.upgradeState({ fresh: true });
    assert.equal(state.sdk.cli, WANTED);
    assert.equal(state.sdk.installable, false);
  } finally {
    registryState.notInstallable = false;
    registryState.latest = LATEST;
    fakeClaude(CLI_LATEST);
    await upgrade.upgradeState({ fresh: true });
  }
});

test('npm inalcanzable: el trabajo solo-runner sale igual; el nativo de Windows no es asunto suyo', async () => {
  await noJob();
  await settleBox();
  git(['pull', '--ff-only', '--quiet', 'origin', 'main'], repos.box);
  box.runningCommit = head(repos.box);
  // Code up to date, CLI behind: the runner-only job has something to do.
  fakeClaude('2.1.1');
  const registryHook = upgrade.upgradeHooks.fetchRegistry;
  // Not «npm has not published it»: this laptop cannot reach the registry at
  // all, which is what `registry()` turns into `status: 0`.
  upgrade.upgradeHooks.fetchRegistry = async () => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org'); };
  holdBoard();
  try {
    const state = await upgrade.upgradeState({ fresh: true });
    assert.equal(state.sdk.latest, null);
    assert.equal(state.sdk.behind, false);
    assert.equal(state.sdk.cli, WANTED, 'el emparejamiento en lockstep, sin registry que lo diga');
    assert.equal(state.sdk.installable, false);
    assert.equal(state.sdk.manual, false);
    assert.deepEqual(upgrade.runnersNeedingUpdate(state), ['box']);

    const r = await call('POST', '/api/upgrade', { target: CURRENT });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.job.runnerOnly, true);
    assert.deepEqual(r.body.job.target, { sdk: CURRENT, cli: WANTED });
    assert.equal(r.body.job.state, 'waiting', 'un chat ocupado la deja esperando');
    const cancel = await call('POST', '/api/upgrade/cancel');
    assert.deepEqual(cancel, { status: 200, body: { job: null } });

    // Con «Solo la portátil» no queda trabajo: es lo que el diálogo ya no ofrece.
    const laptop = await call('POST', '/api/upgrade', { target: CURRENT, onlyLaptop: true });
    assert.deepEqual(laptop, { status: 400, body: { error: 'nothing to update' } });
  } finally {
    upgrade.upgradeHooks.fetchRegistry = registryHook;
    fakeClaude(CLI_LATEST);
    dropTasks();
    await upgrade.upgradeState({ fresh: true });
  }
});

test('solo los runners: un divergido se queda fuera como uno apagado y no frena al sano', async () => {
  await noJob();
  await settleBox();
  // origin moves on with runner code the box has not pulled: box va atrás.
  const c6 = commitIn(repos.board, { 'server/src/exec.js': '// exec v6\n' }, 'runner code v6');
  git(['push', 'origin', 'main'], repos.board);
  // A second box on a commit that is not an ancestor of origin/main: divergido.
  const tree = git(['rev-parse', `${c6}^{tree}`], repos.board).trim();
  const sibling = git(['commit-tree', tree, '-p', repos.c0, '-m', 'box2 se fue por su cuenta'], repos.board).trim();
  config.machines = { ...config.machines, box2: { ...config.machines.box } };
  // The rebuild drops the stubs of `useMachines`: both go back on.
  machines().local.info = async () => ({ platform: process.platform, claude: WANTED, home: ROOT });
  machines().box2.info = async () => ({
    platform: 'linux', node: process.version, claude: '2.1.1', home: FAKE_HOME,
    pid: 4242, commit: sibling, diskCommit: sibling, monitorDir: repos.box,
  });
  registryState.latest = CURRENT;
  holdBoard();
  try {
    const state = await upgrade.upgradeState({ fresh: true });
    assert.equal(state.machines.box.runner.status, 'behind');
    assert.equal(state.machines.box2.runner.status, 'diverged');
    assert.deepEqual(upgrade.runnersNeedingUpdate(state), ['box'], 'un divergido no es trabajo de un solo-runner');

    const r = await call('POST', '/api/upgrade', { target: CURRENT });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.job.runnerOnly, true);
    assert.deepEqual(Object.keys(r.body.job.runners), ['box'], 'y no entra en el trabajo');
    assert.equal(r.body.job.state, 'waiting', 'un chat ocupado la deja esperando');
    const cancel = await call('POST', '/api/upgrade/cancel');
    assert.deepEqual(cancel, { status: 200, body: { job: null } });

    // Un trabajo completo sí se para: la portátil se actualiza para todos.
    registryState.latest = LATEST;
    const full = await call('POST', '/api/upgrade', { target: LATEST });
    assert.equal(full.status, 409, JSON.stringify(full.body));
    assert.deepEqual(full.body.blockers.map((b) => b.code), ['runner_diverged']);
    assert.equal(full.body.blockers[0].machine, 'box2');
    assert.equal(upgrade.getUpgradeJob(), null, 'y no deja job');
  } finally {
    registryState.latest = LATEST;
    useMachines();
    dropTasks();
    await noJob();
  }
});

test('updatePathCli: apagada por defecto, se pide a propósito, y un solo-runner no la promete', async () => {
  await noJob();
  await settleBox();
  // The last «pedida:» line of a job's log, whatever else the log holds.
  const pedida = (id) => readFileSync(upgrade.logFile(id), 'utf8')
    .split(/\r?\n/).filter((l) => l.includes('pedida:')).at(-1);
  holdBoard();
  try {
    // Sin el campo, el claude del PATH de la portátil no se toca.
    let r = await call('POST', '/api/upgrade', { target: LATEST });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.job.updatePathCli, false);
    assert.doesNotMatch(pedida(r.body.job.id), /claude del PATH/, 'ni el log lo anuncia');
    await call('POST', '/api/upgrade/cancel');

    // Solo `true` cuenta, como en onlyLaptop: un valor cualquiera no la enciende.
    r = await call('POST', '/api/upgrade', { target: LATEST, updatePathCli: 'sí' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.job.updatePathCli, false);
    await call('POST', '/api/upgrade/cancel');

    r = await call('POST', '/api/upgrade', { target: LATEST, updatePathCli: true });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.job.updatePathCli, true);
    assert.equal(JSON.parse(readFileSync(upgrade.jobFile(), 'utf8')).updatePathCli, true, 'y va al archivo que lee upgrade.ps1');
    assert.match(pedida(r.body.job.id), /pedida: SDK .*, con el claude del PATH;/);
    await call('POST', '/api/upgrade/cancel');

    // «Solo la portátil» sí arranca upgrade.ps1: ahí la bandera manda de verdad
    // y tiene que sobrevivir — es el complemento del caso solo-runner de abajo.
    r = await call('POST', '/api/upgrade', { target: LATEST, onlyLaptop: true, updatePathCli: true });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.job.onlyLaptop, true);
    assert.equal(r.body.job.runnerOnly, false);
    assert.equal(r.body.job.updatePathCli, true);
    assert.match(pedida(r.body.job.id), /, solo la portátil, con el claude del PATH;/);
    await call('POST', '/api/upgrade/cancel');

    // Un trabajo solo-runner no arranca upgrade.ps1: la bandera se queda en
    // falso aunque se pida, para que no prometa un paso que no va a existir.
    registryState.latest = CURRENT;
    fakeClaude('2.1.1');
    r = await call('POST', '/api/upgrade', { target: CURRENT, updatePathCli: true });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.job.runnerOnly, true);
    assert.equal(r.body.job.updatePathCli, false);
    assert.doesNotMatch(pedida(r.body.job.id), /claude del PATH/);
    await call('POST', '/api/upgrade/cancel');
  } finally {
    registryState.latest = LATEST;
    fakeClaude(CLI_LATEST);
    dropTasks();
    await noJob();
  }
});

test('GET /api/upgrade no espera a la red salvo con ?fresh=1, y el snapshot lleva el estado', async () => {
  await noJob();
  await upgrade.upgradeState({ fresh: true });
  const checkedAt = upgrade.currentUpgradeState().checkedAt;
  assert.ok(checkedAt);
  // The registry is held until the test lets it go: whatever answers before
  // that did not wait on it.
  let release;
  registryState.gate = new Promise((r) => { release = r; });
  try {
    const quick = await call('GET', '/api/upgrade');
    assert.equal(quick.status, 200, 'responde con el registry parado');
    assert.equal(quick.body.checkedAt, checkedAt);
    assert.deepEqual(Object.keys(quick.body).sort(), ['checkedAt', 'git', 'idle', 'job', 'machines', 'sdk', 'settings']);
    assert.deepEqual(quick.body.settings, { skipped: null, snoozedUntil: null, seen: null, acknowledgedJob: null });
    let settled = false;
    const pending = call('GET', '/api/upgrade?fresh=1').then((r) => { settled = true; return r; });
    const again = await call('GET', '/api/upgrade');
    assert.equal(again.body.checkedAt, checkedAt, 'otra lectura normal tampoco espera');
    assert.equal(settled, false, '?fresh=1 sí espera al registry');
    release();
    const fresh = await pending;
    assert.equal(fresh.status, 200);
    assert.ok(fresh.body.checkedAt, 'y trae una detección nueva');
    assert.notEqual(fresh.body.checkedAt, checkedAt);
  } finally {
    release?.();
    registryState.gate = null;
  }

  holdBoard();
  const job = await upgrade.requestUpgrade({ target: LATEST });
  const state = upgrade.currentUpgradeState();
  assert.equal(state instanceof Promise, false, 'síncrono');
  assert.equal(state.job.id, job.id, 'el job va al momento, no cacheado');
  assert.equal(state.idle.reasons.length, 1);
  const seen = [];
  const listener = (s) => seen.push(s);
  upgrade.upgradeEvents.on('state', listener);
  upgrade.cancelUpgrade();
  upgrade.upgradeEvents.off('state', listener);
  assert.equal(seen.at(-1).job, null, 'cada cambio se difunde');
  dropTasks();

  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(index, /upgrade: currentUpgradeState\(\)/, 'snapshot() lleva upgrade');
  assert.match(index, /upgradeEvents\.on\('state', \(state\) => broadcast\(\{ type: 'upgrade', state \}\)\)/);
  assert.match(index, /app\.use\(upgradeGuard\)/);
});

test('el lanzamiento de upgrade.ps1 valida lo que interpola y limpia el entorno', () => {
  const cmd = upgrade.upgradeScriptCommand({ root: "C:\\src\\it's", boardPid: 5678, jobId: 'u-abc123', pidFile: 'C:\\d\\u-abc123.pid' });
  assert.match(cmd, /-File','"C:\\src\\it''s\\upgrade\.ps1"','-BoardPid',5678,'-JobId','u-abc123'/);
  const spaced = upgrade.upgradeScriptCommand({ root: 'C:\\Program Files\\hfs monitor', boardPid: 5678, jobId: 'u-abc123', pidFile: 'p' });
  assert.match(spaced, /'"C:\\Program Files\\hfs monitor\\upgrade\.ps1"'/, 'una raíz con espacios va entre comillas dobles');
  assert.match(cmd, /WriteAllText\('C:\\d\\u-abc123\.pid', \[string\]\$p\.Id\)/);
  assert.throws(() => upgrade.upgradeScriptCommand({ root: 'C:\\x', boardPid: 1, jobId: "u-1'; rm", pidFile: 'p' }), /invalid update id/);
  assert.throws(() => upgrade.upgradeScriptCommand({ root: 'C:\\x', boardPid: '1; x', jobId: 'u-1', pidFile: 'p' }), /invalid boardPid/);
  const env = upgrade.scriptEnv({
    PATH: 'x', npm_config_prefix: 'y', INIT_CWD: 'z', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: 'keep', HOME: 'h',
  });
  assert.deepEqual(env, { PATH: 'x', CLAUDE_CONFIG_DIR: 'keep', HOME: 'h' });
});

test('un runner viejo sin monitorDir: /proc del padre, y si no, systemd', async () => {
  const exists = new Set(['/home/e/hfs-monitor/server/runner.js', '/opt/mon/server/runner.js']);
  const fake = (answers) => ({
    path: path.posix,
    fs: { exists: async (p) => exists.has(p) },
  });
  const shell = (answers) => async (cmd) => {
    const hit = Object.entries(answers).find(([k]) => cmd.includes(k));
    return hit ? { ok: true, stdout: `${hit[1]}\n` } : { ok: false, stdout: '' };
  };
  const m = fake();
  assert.equal(await upgrade.locateMonitorDir(m, { monitorDir: '/opt/mon' }, shell({})), '/opt/mon');
  assert.equal(await upgrade.locateMonitorDir(m, { monitorDir: '/x/y' }, shell({ WorkingDirectory: '/opt/mon/server' })), '/opt/mon', 'sin server/runner.js no se cree');
  assert.equal(await upgrade.locateMonitorDir(m, { monitorDir: 'opt/mon' }, shell({})), null, 'una ruta relativa tampoco');
  assert.equal(await upgrade.locateMonitorDir(m, {}, shell({ '/proc/$PPID/cwd': '/home/e/hfs-monitor' })), '/home/e/hfs-monitor');
  assert.equal(await upgrade.locateMonitorDir(m, { monitorDir: null }, shell({ '/proc/$PPID/cwd': '.', WorkingDirectory: '/opt/mon/server' })), '/opt/mon');
  assert.equal(await upgrade.locateMonitorDir(m, {}, shell({ '/proc/$PPID/cwd': '/tmp', WorkingDirectory: '/nada/server' })), null);
});

test('si PowerShell no lanza el script, laptop_launch queda fallido y el tablero sigue arriba', async () => {
  await noJob();
  const saved = upgrade.upgradeHooks.spawnScript;
  const exitsBefore = exits.length;
  upgrade.upgradeHooks.spawnScript = async () => { throw new Error('powershell no está'); };
  try {
    const r = await call('POST', '/api/upgrade', { target: LATEST, onlyLaptop: true });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await upgrade.upgradeRun();
    const job = upgrade.getUpgradeJob();
    assert.equal(job.state, 'failed');
    assert.equal(job.failedStep, 'laptop_launch');
    assert.deepEqual(job.steps.at(-1), { ...job.steps.at(-1), name: 'laptop_launch', state: 'failed', detail: 'powershell no está' });
    assert.equal(job.scriptPid, null);
    assert.equal(JSON.parse(readFileSync(upgrade.jobFile(), 'utf8')).steps.at(-1).state, 'failed', 'y así queda escrito');
    await sleep(50);
    assert.equal(exits.length, exitsBefore, 'el tablero no sale');
    assert.equal(upgrade.upgradeHoldsNewWork(), false, 'y la puerta se abre');
  } finally {
    upgrade.upgradeHooks.spawnScript = saved;
  }
});

test('un lock rancio no bloquea el tablero: pid muerto → failed, y un scriptPid vivo sin lock solo tiene gracia', async () => {
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  writeFileSync(upgrade.lockFile(), JSON.stringify({ pid: dead, startedAt: new Date().toISOString() }));
  try {
    let job = await jobWith('laptop', { scriptPid: dead, step: 'laptop_install' });
    assert.equal(job.state, 'failed', 'lock con pid muerto y script muerto');
    assert.equal(upgrade.upgradeRunning(), false);

    // After a reboot the old scriptPid may be someone else's: believed only for a while.
    job = await jobWith('laptop', { scriptPid: process.pid, step: 'laptop_install' });
    assert.equal(job.state, 'laptop', 'dentro de la gracia se espera');
    await waitFor(() => upgrade.getUpgradeJob()?.state === 'failed', 'pasada la gracia, failed');
    assert.equal(upgrade.upgradeRunning(), false);

    // Dead, and no file to read: a few looks, then failed.
    job = await jobWith('laptop', { scriptPid: dead, step: 'laptop_install' });
    assert.equal(job.state, 'failed');
  } finally {
    rmSync(upgrade.lockFile(), { force: true });
    await noJob();
  }
});

test('antes de escribir failed se relee el archivo: un done del script no se pisa', async () => {
  const saved = upgrade.upgradeHooks.isAlive;
  const sentinel = 999_999;
  let wroteDone = false;
  upgrade.upgradeHooks.isAlive = (pid) => {
    // The script finishes right between the board's first read and its write.
    if (pid === sentinel && !wroteDone) {
      wroteDone = true;
      const onDisk = JSON.parse(readFileSync(upgrade.jobFile(), 'utf8'));
      writeFileSync(upgrade.jobFile(), JSON.stringify({ ...onDisk, state: 'done', step: 'laptop_start', endedAt: new Date().toISOString() }));
    }
    return false;
  };
  try {
    const job = await jobWith('laptop', { scriptPid: sentinel, step: 'laptop_start' });
    assert.equal(wroteDone, true);
    assert.equal(job.id, upgrade.getUpgradeJob().id);
    assert.equal(upgrade.getUpgradeJob().state, 'done', 'el resultado del script gana');
    assert.equal(JSON.parse(readFileSync(upgrade.jobFile(), 'utf8')).state, 'done', 'y en disco sigue done');
  } finally {
    upgrade.upgradeHooks.isAlive = saved;
    await noJob();
  }
});

test('mientras corre, la guarda no se salta con mayúsculas y los Stop siguen permitidos', async () => {
  await noJob();
  writeFileSync(upgrade.lockFile(), JSON.stringify({ pid: process.pid }));
  try {
    await jobWith('laptop', { scriptPid: process.pid, step: 'laptop_install' });
    for (const route of ['/API/projects/hfs/tasks/1/retry', '/api/Projects/HFS/Tasks/1/RETRY', '/Api/projects/hfs/tasks/1/retry/']) {
      const r = await call('POST', route);
      assert.equal(r.status, 409, `${route} sigue guardada`);
    }
    for (const route of [
      '/api/projects/hfs/tasks/1/chat/stop',
      '/api/projects/app-b/tasks/1/chat/stop',
      '/api/projects/hfs/tasks/1/chats/c-2/plan/stop',
      '/api/projects/hfs/tasks/1/chats/c-2/background/b7/stop',
      '/api/projects/hfs/tasks/1/stack/stop',
      '/API/projects/HFS/tasks/1/chat/STOP',
      '/api/projects/hfs/project-chats/local/chat/stop',
      '/api/projects/hfs/project-chats/runner-1/chats/c-2/plan/stop',
      '/api/projects/hfs/project-chats/local/chats/c-2/background/b7/stop',
    ]) {
      const r = await call('POST', route, {});
      assert.equal(r.status, 200, `${route} se permite`);
    }
    // Only the project chat's Stops are exempt; everything else of it stays guarded.
    for (const route of [
      '/api/projects/hfs/project-chats/local/chats',
      '/api/projects/hfs/project-chats/local/attachments',
      '/api/projects/hfs/project-chats/local/model',
      '/api/projects/hfs/project-chats/local/chat/stop/extra',
      '/api/projects/hfs/project-chats/local/chats/c-2/rename',
      '/api/projects/hfs/project-chats/local/chat/stopx',
    ]) {
      const r = await call('POST', route, {});
      assert.equal(r.status, 409, `${route} sigue guardada`);
    }
  } finally {
    rmSync(upgrade.lockFile(), { force: true });
    await noJob();
  }
});

test('sin bus de usuario el claude install va con nohup y la petición no se queda colgada', { skip: SHELL_SKIP }, async () => {
  await noJob();
  await settleBox();
  git(['pull', '--ff-only', '--quiet', 'origin', 'main'], repos.box);
  box.runningCommit = head(repos.box);
  registryState.latest = CURRENT;
  fakeClaude('2.1.1');
  flag('nobus', true);
  flag('holdinstall', true);
  flag('release', false);
  try {
    const job = await upgrade.requestUpgrade({ target: CURRENT });
    assert.equal(job.runnerOnly, true);
    // The install is held until the test lets it go: the launch line shows
    // up only if the command came back while the install still runs.
    // Outcome, not wall clock: the launch line must appear while the install is
    // still held, however slow the machine; a job that fails stops the wait.
    await waitFor(() => {
      if (job.state !== 'running') assert.fail(`el job terminó antes de lanzar la instalación: ${job.state} ${job.error}`);
      return existsSync(upgrade.logFile(job.id)) && /claude install \S+ lanzado \(nohup\)/.test(readFileSync(upgrade.logFile(job.id), 'utf8'));
    }, 'la orden vuelve con la instalación en marcha', 240_000);
    assert.equal(job.steps.at(-1).name, 'runner_cli');
    assert.equal(job.steps.at(-1).state, 'running');
    assert.equal(existsSync(path.join(FAKE_HOME, '.hfs-monitor', 'upgrade', `${job.id}-cli.done`)), false, 'la instalación sigue');
    flag('release', true);
    await upgrade.upgradeRun();
    assert.equal(job.state, 'done', job.error);
    assert.deepEqual(job.steps.map((s) => `${s.name}:${s.state}`), [
      'runner_check:ok', 'runner_cli:ok', 'runner_code:skipped', 'runner_restart:skipped',
    ]);
    assert.doesNotMatch(calls(), new RegExp(`--unit=hfsmon-upgrade-${job.id}-cli`), 'sin systemd-run para el CLI');
  } finally {
    flag('nobus', false);
    flag('holdinstall', false);
    flag('release', false);
    registryState.latest = LATEST;
    fakeClaude(CLI_LATEST);
  }
});

test('vuelta atrás en un runner de antes de U3 (sin commit): basta con que cambie el pid', { skip: SHELL_SKIP }, async () => {
  await noJob();
  await settleBox();
  const c4 = commitIn(repos.board, { 'server/src/config.js': '// config v4\n' }, 'runner code v4');
  git(['push', 'origin', 'main'], repos.board);
  const before = head(repos.box);
  assert.notEqual(before, c4);
  writeFileSync(path.join(FAKE_DIR, 'workdir'), `${fwd(repos.box)}/server\n`);
  box.legacy = true;
  flag('norestart', true);
  const saved = upgrade.upgradeHooks.timing.restartTimeoutMs;
  upgrade.upgradeHooks.timing.restartTimeoutMs = 10_000;
  try {
    const job = await upgrade.requestUpgrade({ target: LATEST });
    await upgrade.upgradeRun();
    assert.equal(job.state, 'failed');
    assert.equal(job.failedStep, 'runner_restart');
    assert.deepEqual(job.steps.map((s) => `${s.name}:${s.state}`), [
      'runner_check:ok', 'runner_cli:skipped', 'runner_code:ok', 'runner_restart:failed', 'runner_rollback:ok',
    ]);
    assert.ok(job.steps[0].detail.includes(fwd(repos.box)), `la carpeta sale de systemd: ${job.steps[0].detail}`);
    assert.doesNotMatch(job.error, /vuelta atrás falló/);
    assert.equal(head(repos.box), before, 'de vuelta en el commit de antes');
  } finally {
    box.legacy = false;
    flag('norestart', false);
    upgrade.upgradeHooks.timing.restartTimeoutMs = saved;
    rmSync(path.join(FAKE_DIR, 'workdir'), { force: true });
    await noJob();
  }
});
 

test('el lanzamiento real: PowerShell arranca upgrade.ps1 y devuelve su PID, con raíz con espacios', { skip: process.platform !== 'win32' && 'solo en Windows' }, async () => {
  // A stub upgrade.ps1 that only records who it is and what it was given.
  const root = path.join(ROOT, 'raiz con espacios');
  mkdirSync(root, { recursive: true });
  const marker = path.join(root, 'marker.json');
  writeFileSync(path.join(root, 'upgrade.ps1'), [
    'param([int]$BoardPid, [string]$JobId)',
    '$m = @{ pid = $PID; boardPid = $BoardPid; jobId = $JobId } | ConvertTo-Json -Compress',
    "[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'marker.json'), $m)",
  ].join('\r\n'));
  const jobId = `u-spawn${Date.now().toString(36)}`;
  const pid = await upgrade.spawnUpgradeScript({ root, boardPid: process.pid, jobId });
  assert.ok(Number.isInteger(pid) && pid > 0, `PID: ${pid}`);
  await waitFor(() => existsSync(marker), 'el script escribe su marca', 60_000);
  let seen = null;
  await waitFor(() => {
    try { seen = JSON.parse(readFileSync(marker, 'utf8').trimStart()); return true; } catch { return false; }
  }, 'la marca se lee entera', 60_000);
  assert.deepEqual(seen, { pid, boardPid: process.pid, jobId }, 'el mismo proceso, con los argumentos recibidos');
});

// -----------------------------------------------------------------------------
// The `.done` wait, against a box that blinks (job u-mufyrg56).
//
// `awaitCliInstall` is driven directly rather than through `runner_cli`: the
// step around it needs a POSIX shell on the box and these do not, so they run
// on this laptop too, where `SHELL_SKIP` may hide everything else.

const CLI_DIR = () => path.join(FAKE_HOME, '.hfs-monitor', 'upgrade');

/** The install's markers on the fake box, and the paths the board uses. */
function installMarkers(id, { code = '0', output = 'installed\n' } = {}) {
  mkdirSync(CLI_DIR(), { recursive: true });
  writeFileSync(path.join(CLI_DIR(), `${id}-cli.done`), `${code}\n`);
  writeFileSync(path.join(CLI_DIR(), `${id}-cli.log`), output);
  return {
    cli: CLI_LATEST,
    done: `${FAKE_HOME}/.hfs-monitor/upgrade/${id}-cli.done`,
    log: `${FAKE_HOME}/.hfs-monitor/upgrade/${id}-cli.log`,
  };
}

/** What the runner client throws when the request never reached the box. */
const offline = (what) => Object.assign(
  new Error(`box: ${what} → UND_ERR_CONNECT_TIMEOUT (el runner no responde)`),
  { code: 'RUNNER_OFFLINE', machine: 'box', reason: 'UND_ERR_CONNECT_TIMEOUT' },
);

/**
 * Swaps a method on the cached instance — so the runner underneath is still
 * the real one over HTTP. `make` receives the real method, bound; the returned
 * function puts the prototype's back.
 */
function swap(obj, name, make) {
  const real = obj[name].bind(obj);
  const own = Object.prototype.hasOwnProperty.call(obj, name);
  const prev = obj[name];
  obj[name] = make(real);
  return () => { if (own) obj[name] = prev; else delete obj[name]; };
}

/** `fails` calls of `obj[name]` that never get there, then the real thing. */
function flaky(obj, name, fails, make = offline, seq = null) {
  const spy = { calls: 0 };
  spy.restore = swap(obj, name, (real) => async (...args) => {
    spy.calls += 1;
    const failed = spy.calls <= fails;
    seq?.push(`${name}:${failed ? 'corte' : 'ok'}`);
    if (failed) throw make(name);
    return real(...args);
  });
  return spy;
}

test('la espera del .done aguanta un corte: reintenta, lo deja en el log y el veredicto es el bueno', async () => {
  await settleBox();
  const id = 'u-blip1';
  const paths = installMarkers(id);
  rmSync(upgrade.logFile(id), { force: true });
  const m = machines().box;
  const ex = flaky(m.fs, 'exists', 2);
  const rd = flaky(m.fs, 'readFile', 1);
  try {
    const after = await upgrade.awaitCliInstall({ id }, m, paths);
    assert.equal(after.claude, readFileSync(path.join(FAKE_DIR, 'claude-version'), 'utf8').trim(), 'el /info de después llega');
    assert.equal(ex.calls, 4, 'dos cortes, la vuelta que ve el archivo y la que lo vuelve a mirar');
    assert.equal(rd.calls, 3, 'el .done dos veces y el log una');
  } finally {
    ex.restore();
    rd.restore();
  }
  const log = readFileSync(upgrade.logFile(id), 'utf8');
  assert.match(log, /box: no responde \(.*UND_ERR_CONNECT_TIMEOUT.*\); se sigue esperando/, 'el parpadeo se ve en el diálogo');
  assert.match(log, /box: vuelve a responder tras \d+ intento\(s\) sin conexión/);
});

test('un corte al leer el .done no da el archivo por leído: se vuelve a mirar y el código llega entero', async () => {
  await settleBox();
  const id = 'u-blip3';
  const paths = installMarkers(id);
  const m = machines().box;
  const seq = [];
  const ex = flaky(m.fs, 'exists', 0, offline, seq);
  const rd = flaky(m.fs, 'readFile', 2, offline, seq);
  try {
    const after = await upgrade.awaitCliInstall({ id }, m, paths);
    assert.ok(after, 'la espera sigue viva tras los dos cortes');
    assert.deepEqual(seq.slice(0, 6), [
      'exists:ok', 'readFile:corte', 'exists:ok', 'readFile:corte', 'exists:ok', 'readFile:ok',
    ], 'cada corte vuelve al principio del bucle, nunca a un código inventado');
  } finally {
    ex.restore();
    rd.restore();
  }
});

test('si los cortes no paran, la espera falla por plazo y says the box was unreachable', async () => {
  await settleBox();
  const id = 'u-blip2';
  const paths = installMarkers(id);
  rmSync(upgrade.logFile(id), { force: true });
  const m = machines().box;
  const saved = { ...upgrade.upgradeHooks.timing };
  const ex = flaky(m.fs, 'exists', Infinity);
  try {
    Object.assign(upgrade.upgradeHooks.timing, { donePollMs: 50, doneTimeoutMs: 400 });
    await assert.rejects(() => upgrade.awaitCliInstall({ id }, m, paths), (e) => {
      assert.match(e.message, /no terminó en/, e.message);
      assert.match(e.message, /unreachable/, e.message);
      assert.match(e.message, /UND_ERR_CONNECT_TIMEOUT/, e.message);
      return true;
    });
    assert.ok(ex.calls >= 2, `se reintentó hasta el plazo: ${ex.calls}`);
  } finally {
    ex.restore();
    Object.assign(upgrade.upgradeHooks.timing, saved);
  }
  // One line per streak, not per poll: el `logTail` son 40 líneas y una espera
  // de 16 min a 5 s el sondeo cabría casi cinco veces en él.
  const log = readFileSync(upgrade.logFile(id), 'utf8');
  assert.equal((log.match(/box: no responde \(/g) ?? []).length, 1, `una sola línea por racha: ${log}`);
  assert.ok(ex.calls > 1, 'aunque los sondeos hayan sido muchos');
});

test('un error que no es de conexión no se traga: la espera falla en el acto', async () => {
  await settleBox();
  const id = 'u-blip4';
  const paths = installMarkers(id);
  const m = machines().box;
  const rd = flaky(m.fs, 'readFile', Infinity, () => new Error('box: /fs/read → 500'));
  try {
    await assert.rejects(() => upgrade.awaitCliInstall({ id }, m, paths), /\/fs\/read → 500/);
    assert.equal(rd.calls, 1, 'un 500 no se reintenta');
  } finally {
    rd.restore();
  }
  const ex = flaky(m.fs, 'exists', Infinity, () => new Error('box: /fs/exists → 500'));
  try {
    await assert.rejects(() => upgrade.awaitCliInstall({ id }, m, paths), /\/fs\/exists → 500/);
    assert.equal(ex.calls, 1);
  } finally {
    ex.restore();
  }
});

test('el /info de después también se reintenta, y solo el plazo lo da por perdido', async () => {
  await settleBox();
  const id = 'u-blip5';
  const paths = installMarkers(id);
  const m = machines().box;
  const saved = { ...upgrade.upgradeHooks.timing };
  try {
    Object.assign(upgrade.upgradeHooks.timing, {
      donePollMs: 50, doneTimeoutMs: 1000, restartPollMs: 50, restartTimeoutMs: 800,
    });
    const info = flaky(m, 'info', 3);
    try {
      const after = await upgrade.awaitCliInstall({ id }, m, paths);
      assert.ok(after.claude, 'tras tres cortes /info contesta y el veredicto se da');
      assert.equal(info.calls, 4);
    } finally {
      info.restore();
    }
    const dead = flaky(m, 'info', Infinity);
    try {
      await assert.rejects(() => upgrade.awaitCliInstall({ id }, m, paths), /did not answer \/info/);
      assert.ok(dead.calls >= 2, `se sondeó hasta el plazo: ${dead.calls}`);
    } finally {
      dead.restore();
    }
  } finally {
    Object.assign(upgrade.upgradeHooks.timing, saved);
  }
});

test('la detección espera al runner más de lo que el cliente tarda en reintentar', () => {
  const src = readFileSync(new URL('../src/upgrade.js', import.meta.url), 'utf8');
  assert.match(src, /infoTimeoutMs: 20_000/, 'con 8 s el withTimeout abortaría los reintentos del cliente');
});

test('un /info que contesta 500 no se sondea: la espera falla en el acto', async () => {
  await settleBox();
  const id = 'u-blip6';
  const paths = installMarkers(id);
  const m = machines().box;
  const info = flaky(m, 'info', Infinity, () => new Error('box: /info → 500'));
  try {
    await assert.rejects(() => upgrade.awaitCliInstall({ id }, m, paths), /\/info → 500/);
    assert.equal(info.calls, 1, 'aceptar la conexión y contestar mal no es estar inalcanzable');
  } finally {
    info.restore();
  }
});

test('un código distinto de 0 falla la espera con la cola de lo que imprimió', async () => {
  await settleBox();
  const id = 'u-blip7';
  const paths = installMarkers(id, { code: '3', output: 'install exploded\n' });
  await assert.rejects(
    () => upgrade.awaitCliInstall({ id }, machines().box, paths),
    /claude install exited with 3: install exploded/,
  );
});

test('si la cola del log no se puede leer, el job lo dice en vez de callárselo', async () => {
  await settleBox();
  const id = 'u-blip8';
  const paths = installMarkers(id, { code: '3', output: 'install exploded\n' });
  rmSync(upgrade.logFile(id), { force: true });
  const m = machines().box;
  const restore = swap(m.fs, 'readFile', (real) => async (p, ...rest) => {
    if (p === paths.log) throw new Error('box: /fs/read → 500');
    return real(p, ...rest);
  });
  try {
    await assert.rejects(() => upgrade.awaitCliInstall({ id }, m, paths), /claude install exited with 3/);
  } finally {
    restore();
  }
  assert.match(
    readFileSync(upgrade.logFile(id), 'utf8'),
    /box: no se pudo leer \S+-cli\.log: box: \/fs\/read → 500/,
    'un «salió con 3: » sin cola es ilegible sin esta línea',
  );
});

test('un .done a medias no es un código: se vuelve a mirar en la siguiente vuelta', async () => {
  await settleBox();
  const id = 'u-blip9';
  const paths = installMarkers(id);
  const m = machines().box;
  let truncated = true;
  const restore = swap(m.fs, 'readFile', (real) => async (p, ...rest) => {
    // `> done` empties the file before `echo $?` fills it: there, and blank.
    if (p === paths.done && truncated) { truncated = false; return ''; }
    return real(p, ...rest);
  });
  try {
    const after = await upgrade.awaitCliInstall({ id }, m, paths);
    assert.ok(after.claude, 'la vuelta siguiente lee el 0 entero, sin «salió con »');
    assert.equal(truncated, false, 'el .done vacío se leyó de verdad');
  } finally {
    restore();
  }
});
