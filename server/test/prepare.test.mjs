import './isolate.mjs';   // primero: aisla el directorio de datos
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

import { config } from '../src/config.js';
import { saveProjects, listProjects } from '../src/projects.js';
import { machines, registerRunnerClient } from '../src/machine.js';
import { startPrepare, prepareStatus, resetPrepare, PrepareError } from '../src/prepare.js';
import { checkoutHooks, ensureCheckout } from '../src/checkout.js';
import { tempDir } from './teardown.mjs';

// Checkouts on the board's own machine, with real files.
const here = tempDir('hfsmon-prepare-');

const saved = config.machines;
after(() => {
  if (saved === undefined) delete config.machines; else config.machines = saved;
  registerRunnerClient((name) => { throw new Error(`machines.${name}: el cliente del runner no está cargado`); });
});

const who = { assignee: 'a', reviewer: 'r' };
saveProjects([
  { id: 'hfs', name: 'hfs', ...who, repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot },
  { id: 'ehr', name: 'EHR', ...who, repo: 'eterceros/EHR', repoPath: 'C:/Users/edson/src/EHR', worktreeRoot: 'C:/Users/edson/src/EHR-wt' },
  { id: 'notes', name: 'notes', ...who, repo: 'eterceros/notes', repoPath: 'C:/Users/edson/src/notes', worktreeRoot: 'C:/Users/edson/src/notes-wt' },
  { id: 'norepo', name: 'norepo', ...who, repo: null, repoPath: 'C:/Users/edson/src/norepo', worktreeRoot: 'C:/Users/edson/src/norepo-wt' },
  { id: 'gone', name: 'gone', ...who, repo: null, repoPath: path.join(here, 'gone'), worktreeRoot: path.join(here, 'gone-wt') },
]);

/**
 * A runner whose box is a plain object: `files` is what exists, `calls` what was
 * run. A clone creates `.git` and the `cloned` files; `mv` moves them.
 */
function fakeBox({ files = [], origin = 'git@github.com:eterceros/EHR.git', cloned = [], failClone = false, hold = null } = {}) {
  const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' });
  const under = (p) => [...box.files].filter((f) => f === p || f.startsWith(`${p}/`));
  const box = {
    kind: 'runner', name: 'devbox', home: '/home/zoe', repoPath: '/x', worktreeRoot: '/y',
    path: path.posix, calls: [], made: [], files: new Set(files),
    info: async () => ({ home: '/home/zoe' }),
    fs: {
      exists: async (p) => box.files.has(p),
      mkdir: async (p) => { box.made.push(p); },
      rm: async (p) => { for (const f of under(p)) box.files.delete(f); },
    },
    exec: async (file, args, opts = {}) => {
      box.calls.push([file, ...args]);
      if (hold && file === 'gh' && args[1] === 'clone') await hold;
      opts.onLine?.(`${file} ${args[0]}`);
      if (file === 'gh' && args[1] === 'clone') {
        if (failClone) return { ok: false, code: 1, stdout: '', stderr: 'gh: not logged in' };
        const to = args[3];
        for (const f of ['', '/.git', ...cloned.map((c) => `/${c}`)]) box.files.add(to + f);
        return ok();
      }
      if (file === 'mv') {
        const [from, to] = args.slice(-2);
        for (const f of under(from)) { box.files.delete(f); box.files.add(to + f.slice(from.length)); }
        return ok();
      }
      if (file === 'git' && args.includes('get-url')) {
        // A clone answers with the repository it was cloned from.
        const clonedFrom = box.calls.findLast((c) => c[0] === 'gh' && c[2] === 'clone' && args[1].includes(c[4].split('/').pop()));
        return ok(`${clonedFrom ? `git@github.com:${clonedFrom[3]}.git` : origin}\n`);
      }
      return ok();
    },
    shell: async (command, opts = {}) => {
      box.calls.push(['shell', command, opts.cwd]);
      return ok();
    },
  };
  return box;
}

const clones = (box) => box.calls.filter((c) => c[0] === 'gh' && c[2] === 'clone');

function useBox(box) {
  config.machines = { devbox: { kind: 'runner', url: 'http://127.0.0.1:9', token: 't', repoPath: '/x', worktreeRoot: '/y' } };
  registerRunnerClient(() => box);
}

async function finished(machine, project) {
  for (let i = 0; i < 200; i += 1) {
    const s = prepareStatus(machine, project);
    if (s.status !== 'running' && s.status !== 'queued') return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('the run never finished');
}

const live = (s) => s.status === 'queued' || s.status === 'running';

beforeEach(() => resetPrepare());

test('clones the registry repo under ~/src of the runner, makes the worktree root and installs with pnpm', async () => {
  const box = fakeBox({ cloned: ['pnpm-lock.yaml'] });
  useBox(box);
  const started = await startPrepare('devbox', 'ehr');
  assert.ok(live(started), started.status);

  const end = await finished('devbox', 'ehr');
  assert.equal(end.status, 'done', end.error);
  assert.deepEqual(box.calls[0], ['gh', 'repo', 'clone', 'eterceros/EHR', '/home/zoe/src/.EHR.hfsmon-clone']);
  assert.ok(box.files.has('/home/zoe/src/EHR/.git'), 'renamed into place');
  assert.ok(box.made.includes('/home/zoe/src'), 'the parent of the checkout');
  assert.ok(box.made.includes('/home/zoe/src/EHR-wt'), 'the worktree root');
  const install = box.calls.find((c) => c[0] === 'shell');
  assert.match(install[1], /pnpm install --frozen-lockfile/);
  assert.equal(install[2], '/home/zoe/src/EHR');
  assert.ok(end.lines.length > 0);
});

test('an existing checkout is fetched, not cloned again; npm is used for a package-lock', async () => {
  const box = fakeBox({ files: ['/home/zoe/src/notes', '/home/zoe/src/notes/.git', '/home/zoe/src/notes/package-lock.json'], origin: 'https://github.com/eterceros/notes.git' });
  useBox(box);
  await startPrepare('devbox', 'notes');
  const end = await finished('devbox', 'notes');
  assert.equal(end.status, 'done', end.error);
  assert.ok(box.calls.some((c) => c.includes('fetch')));
  assert.equal(clones(box).length, 0);
  assert.match(box.calls.find((c) => c[0] === 'shell')[1], /npm ci/);
});

test('a checkout whose origin is another repository is refused, and a missing lockfile installs nothing', async () => {
  const wrong = fakeBox({ files: ['/home/zoe/src/EHR', '/home/zoe/src/EHR/.git'], origin: 'git@github.com:someone/else.git' });
  useBox(wrong);
  await startPrepare('devbox', 'ehr');
  const bad = await finished('devbox', 'ehr');
  assert.equal(bad.status, 'failed');
  assert.match(bad.error, /someone\/else, not eterceros\/EHR/);
  assert.ok(!wrong.made.includes('/home/zoe/src/EHR-wt'), 'nothing past the check');

  resetPrepare();
  const bare = fakeBox({});
  useBox(bare);
  await startPrepare('devbox', 'ehr');
  const ok = await finished('devbox', 'ehr');
  assert.equal(ok.status, 'done', ok.error);
  assert.ok(!bare.calls.some((c) => c[0] === 'shell'));
});

test('a failed clone says why, makes no worktree root and can be run again', async () => {
  const box = fakeBox({ failClone: true });
  useBox(box);
  await startPrepare('devbox', 'ehr');
  const end = await finished('devbox', 'ehr');
  assert.equal(end.status, 'failed');
  assert.match(end.error, /cannot read the GitHub repository eterceros\/EHR.*gh: not logged in/);
  assert.equal(end.step, 'clone');
  assert.ok(!box.made.includes('/home/zoe/src/EHR-wt'));

  const again = await startPrepare('devbox', 'ehr');
  assert.ok(live(again), again.status);
  await finished('devbox', 'ehr');
  assert.equal(clones(box).length, 2);
});

test('one queue per machine: the same project joins the run in flight, another one waits instead of being refused', async () => {
  let release;
  const hold = new Promise((r) => { release = r; });
  const box = fakeBox({ hold });
  useBox(box);
  await startPrepare('devbox', 'ehr');

  const same = await startPrepare('devbox', 'ehr');
  assert.ok(live(same), same.status);

  assert.ok(live(await startPrepare('devbox', 'notes')));
  for (let i = 0; i < 200 && prepareStatus('devbox', 'notes').status !== 'queued'; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(prepareStatus('devbox', 'notes').status, 'queued');
  assert.equal(prepareStatus('devbox', 'notes').step, 'queued');
  assert.ok(!box.made.includes('/home/zoe/src/EHR-wt'), 'no worktree root before the checkout is ready');

  release();
  assert.equal((await finished('devbox', 'ehr')).status, 'done');
  const end = await finished('devbox', 'notes');
  assert.equal(end.status, 'done', end.error);
  assert.deepEqual(clones(box).map((c) => c[3]), ['eterceros/EHR', 'eterceros/notes']);
});

test('Prepare during a clone that a chat or task started chains the install to it', async () => {
  let release;
  const hold = new Promise((r) => { release = r; });
  const box = fakeBox({ hold, cloned: ['package-lock.json'] });
  useBox(box);
  const clone = ensureCheckout('devbox', 'ehr');
  await startPrepare('devbox', 'ehr');
  release();
  await clone;
  const end = await finished('devbox', 'ehr');
  assert.equal(end.status, 'done', end.error);
  assert.equal(clones(box).length, 1, 'cloned once');
  assert.match(box.calls.find((c) => c[0] === 'shell')[1], /npm ci/);
});

test('a failed install fails the run with its last lines', async () => {
  const box = fakeBox({ cloned: ['package-lock.json'] });
  box.shell = async () => ({ ok: false, code: 7, stdout: '', stderr: 'npm ERR! boom' });
  useBox(box);
  await startPrepare('devbox', 'ehr');
  const end = await finished('devbox', 'ehr');
  assert.equal(end.status, 'failed');
  assert.equal(end.step, 'install');
  assert.match(end.error, /npm install failed \(exit 7\): npm ERR! boom/);
});

test('Prepare is refused while the board is updating', async () => {
  const box = fakeBox();
  useBox(box);
  const saved = checkoutHooks.holdsNewWork;
  checkoutHooks.holdsNewWork = () => true;
  try {
    await assert.rejects(() => startPrepare('devbox', 'ehr'), (e) => e instanceof PrepareError && e.status === 409);
    assert.equal(box.calls.length, 0);
    assert.equal(prepareStatus('devbox', 'ehr').status, 'idle');
  } finally {
    checkoutHooks.holdsNewWork = saved;
  }
});

test('refusals: an unknown machine or project, and a runner project without a GitHub repo', async () => {
  useBox(fakeBox());
  await assert.rejects(() => startPrepare('nowhere', 'ehr'), (e) => e.status === 404);
  await assert.rejects(() => startPrepare('devbox', 'ghost'), (e) => e.status === 404);
  await assert.rejects(() => startPrepare('devbox', 'norepo'), (e) => e.status === 400 && /no GitHub repository/.test(e.message));
  assert.deepEqual(prepareStatus('devbox', 'ehr'), { status: 'idle', step: null, lines: [], error: null });
});

/**
 * The board's own machine over a fresh checkout in `here`, with the shell and
 * `where` replaced: nothing is really installed.
 */
function useLocal({ lockfile = 'package-lock.json', platform = process.platform, pnpm = true } = {}) {
  const repo = tempDir('hfsmon-prepare-repo-');
  if (lockfile) writeFileSync(path.join(repo, lockfile), '');
  saveProjects([...listProjects().filter((p) => p.id !== 'here'),
    { id: 'here', name: 'here', ...who, repo: null, repoPath: repo, worktreeRoot: `${repo}-wt` }]);
  config.machines = {};
  registerRunnerClient(() => { throw new Error('no runner here'); });   // also drops the cached machines
  const calls = [];
  const ok = { ok: true, code: 0, stdout: '', stderr: '' };
  Object.assign(machines().local, {
    platform,
    shell: async (command, opts) => { calls.push(['shell', command, opts.cwd]); return ok; },
    exec: async (file, args) => { calls.push([file, ...args]); return pnpm ? ok : { ...ok, ok: false, code: 1 }; },
  });
  return { repo, calls };
}

test('the machine of the board only installs: no clone, no worktree root, no repository needed', async () => {
  const { repo, calls } = useLocal();
  assert.ok(live(await startPrepare('local', 'here')));
  const end = await finished('local', 'here');
  assert.equal(end.status, 'done', end.error);
  assert.deepEqual(calls, [['shell', 'npm ci --no-audit --no-fund', repo]]);
  assert.ok(!existsSync(`${repo}-wt`));
});

test('a local install is refused when node_modules exists, or there is no checkout', async () => {
  const { repo, calls } = useLocal();
  mkdirSync(path.join(repo, 'node_modules'));
  await assert.rejects(() => startPrepare('local', 'here'),
    (e) => e instanceof PrepareError && e.status === 409 && e.code === 'node_modules_exists');
  await assert.rejects(() => startPrepare('local', 'gone'), (e) => e.status === 400 && e.code === 'repo_path_missing');
  assert.equal(calls.length, 0);
  assert.equal(prepareStatus('local', 'here').status, 'idle');
});

test('node_modules that appears after the request fails the run before installing', async () => {
  const { repo, calls } = useLocal();
  const local = machines().local;
  // It appears while the job is looking for the lockfile, before its second look.
  const real = local.fs;
  local.fs = {
    exists: async (p) => {
      if (p.endsWith('package-lock.json')) mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
      return real.exists(p);
    },
  };
  await startPrepare('local', 'here');
  const end = await finished('local', 'here');
  assert.equal(end.status, 'failed');
  assert.equal(end.code, 'node_modules_exists');
  assert.equal(calls.length, 0);
});

test('a second request during a local install joins it, although node_modules is there by then', async () => {
  const { repo, calls } = useLocal();
  let release;
  const hold = new Promise((r) => { release = r; });
  machines().local.shell = async (command) => {
    calls.push(['shell', command]);
    mkdirSync(path.join(repo, 'node_modules'));
    await hold;
    return { ok: true, code: 0, stdout: '', stderr: '' };
  };
  await startPrepare('local', 'here');
  for (let i = 0; i < 200 && !calls.length; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.ok(live(await startPrepare('local', 'here')));
  release();
  assert.equal((await finished('local', 'here')).status, 'done');
  assert.equal(calls.length, 1);
});

test('a local install is refused while the board is updating', async () => {
  const { calls } = useLocal();
  const holds = checkoutHooks.holdsNewWork;
  checkoutHooks.holdsNewWork = () => true;
  try {
    await assert.rejects(() => startPrepare('local', 'here'), (e) => e.status === 409 && e.code === 'upgrading');
    assert.equal(calls.length, 0);
  } finally {
    checkoutHooks.holdsNewWork = holds;
  }
});

test('on Windows pnpm is looked up with where and run without POSIX syntax', async () => {
  const { repo, calls } = useLocal({ lockfile: 'pnpm-lock.yaml', platform: 'win32' });
  await startPrepare('local', 'here');
  const end = await finished('local', 'here');
  assert.equal(end.status, 'done', end.error);
  assert.deepEqual(calls, [['where', 'pnpm'], ['shell', 'pnpm install --frozen-lockfile', repo]]);
});

test('on Windows a missing pnpm fails the run saying so, and installs nothing', async () => {
  const { calls } = useLocal({ lockfile: 'pnpm-lock.yaml', platform: 'win32', pnpm: false });
  await startPrepare('local', 'here');
  const end = await finished('local', 'here');
  assert.equal(end.status, 'failed');
  assert.equal(end.code, 'installer_missing');
  assert.match(end.error, /pnpm, which is not installed/);
  assert.deepEqual(calls, [['where', 'pnpm']]);
});

test('on Windows npm needs no lookup; elsewhere pnpm keeps the corepack fallback', async () => {
  const npm = useLocal({ platform: 'win32' });
  await startPrepare('local', 'here');
  assert.equal((await finished('local', 'here')).status, 'done');
  assert.deepEqual(npm.calls.map((c) => c[1]), ['npm ci --no-audit --no-fund']);

  resetPrepare();
  const posix = useLocal({ lockfile: 'pnpm-lock.yaml', platform: 'linux' });
  await startPrepare('local', 'here');
  assert.equal((await finished('local', 'here')).status, 'done');
  assert.equal(posix.calls.length, 1);
  assert.match(posix.calls[0][1], /corepack enable.*pnpm install --frozen-lockfile$/);
});
