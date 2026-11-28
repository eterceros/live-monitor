import './isolate.mjs';   // primero: aisla el directorio de datos
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { config } from '../src/config.js';
import { saveProjects } from '../src/projects.js';
import { registerRunnerClient } from '../src/machine.js';
import { startPrepare, prepareStatus, resetPrepare, PrepareError } from '../src/prepare.js';
import { checkoutHooks, ensureCheckout } from '../src/checkout.js';

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

test('refusals: this board\'s own machine, an unknown machine or project, and a project without a GitHub repo', async () => {
  useBox(fakeBox());
  await assert.rejects(() => startPrepare('local', 'ehr'), (e) => e.status === 400 && /nothing to prepare/.test(e.message));
  await assert.rejects(() => startPrepare('nowhere', 'ehr'), (e) => e.status === 404);
  await assert.rejects(() => startPrepare('devbox', 'ghost'), (e) => e.status === 404);
  await assert.rejects(() => startPrepare('devbox', 'norepo'), (e) => e.status === 400 && /no GitHub repository/.test(e.message));
  assert.deepEqual(prepareStatus('devbox', 'ehr'), { status: 'idle', step: null, lines: [], error: null });
});
