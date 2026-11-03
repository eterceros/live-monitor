import './isolate.mjs';   // primero: aisla el directorio de datos
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { config } from '../src/config.js';
import { saveProjects } from '../src/projects.js';
import { registerRunnerClient } from '../src/machine.js';
import { startPrepare, prepareStatus, resetPrepare, PrepareError } from '../src/prepare.js';

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

/** A runner whose box is a plain object: `files` is what exists, `calls` what was run. */
function fakeBox({ files = [], origin = 'git@github.com:eterceros/EHR.git', failClone = false, hold = null } = {}) {
  const box = {
    kind: 'runner', name: 'devbox', home: '/home/zoe', repoPath: '/x', worktreeRoot: '/y',
    path: path.posix, calls: [], made: [], files: new Set(files),
    info: async () => ({ home: '/home/zoe' }),
    fs: {
      exists: async (p) => box.files.has(p),
      mkdir: async (p) => { box.made.push(p); },
    },
    exec: async (file, args, opts = {}) => {
      box.calls.push([file, ...args]);
      if (hold && file === 'gh') await hold;
      opts.onLine?.(`${file} ${args[0]}`);
      if (file === 'gh' && failClone) return { ok: false, code: 1, stdout: '', stderr: 'gh: not logged in' };
      if (file === 'git' && args.includes('get-url')) return { ok: true, code: 0, stdout: `${origin}\n`, stderr: '' };
      return { ok: true, code: 0, stdout: '', stderr: '' };
    },
    shell: async (command, opts = {}) => {
      box.calls.push(['shell', command, opts.cwd]);
      return { ok: true, code: 0, stdout: '', stderr: '' };
    },
  };
  return box;
}

function useBox(box) {
  config.machines = { devbox: { kind: 'runner', url: 'http://127.0.0.1:9', token: 't', repoPath: '/x', worktreeRoot: '/y' } };
  registerRunnerClient(() => box);
}

async function finished(machine, project) {
  for (let i = 0; i < 200; i += 1) {
    const s = prepareStatus(machine, project);
    if (s.status !== 'running') return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('the run never finished');
}

beforeEach(() => resetPrepare());

test('clones the registry repo under ~/src of the runner, makes the worktree root and installs with pnpm', async () => {
  const box = fakeBox({ files: ['/home/zoe/src/EHR/pnpm-lock.yaml'] });
  useBox(box);
  const started = await startPrepare('devbox', 'ehr');
  assert.equal(started.status, 'running');

  const end = await finished('devbox', 'ehr');
  assert.equal(end.status, 'done', end.error);
  assert.deepEqual(box.calls[0], ['gh', 'repo', 'clone', 'eterceros/EHR', '/home/zoe/src/EHR']);
  assert.ok(box.made.includes('/home/zoe/src'), 'the parent of the checkout');
  assert.ok(box.made.includes('/home/zoe/src/EHR-wt'), 'the worktree root');
  const install = box.calls.find((c) => c[0] === 'shell');
  assert.match(install[1], /pnpm install --frozen-lockfile/);
  assert.equal(install[2], '/home/zoe/src/EHR');
  assert.ok(end.lines.length > 0);
});

test('an existing checkout is fetched, not cloned again; npm is used for a package-lock', async () => {
  const box = fakeBox({ files: ['/home/zoe/src/notes/.git', '/home/zoe/src/notes/package-lock.json'], origin: 'https://github.com/eterceros/notes.git' });
  useBox(box);
  await startPrepare('devbox', 'notes');
  const end = await finished('devbox', 'notes');
  assert.equal(end.status, 'done', end.error);
  assert.ok(box.calls.some((c) => c.includes('fetch')));
  assert.ok(!box.calls.some((c) => c[0] === 'gh'));
  assert.match(box.calls.find((c) => c[0] === 'shell')[1], /npm ci/);
});

test('a checkout whose origin is another repository is refused, and a missing lockfile installs nothing', async () => {
  const wrong = fakeBox({ files: ['/home/zoe/src/EHR/.git'], origin: 'git@github.com:someone/else.git' });
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

test('a failed clone says why and can be run again', async () => {
  const box = fakeBox({ failClone: true });
  useBox(box);
  await startPrepare('devbox', 'ehr');
  const end = await finished('devbox', 'ehr');
  assert.equal(end.status, 'failed');
  assert.match(end.error, /gh repo clone failed \(exit 1\): gh: not logged in/);
  assert.equal(end.step, 'clone');

  const again = await startPrepare('devbox', 'ehr');
  assert.equal(again.status, 'running');
  await finished('devbox', 'ehr');
});

test('one run per machine: the same project returns the run in flight, another one is refused with 409', async () => {
  let release;
  const hold = new Promise((r) => { release = r; });
  const box = fakeBox({ hold });
  useBox(box);
  const first = await startPrepare('devbox', 'ehr');
  assert.equal(first.status, 'running');

  const same = await startPrepare('devbox', 'ehr');
  assert.equal(same.status, 'running');
  assert.equal(box.calls.filter((c) => c[0] === 'gh').length, 1, 'not started twice');

  await assert.rejects(() => startPrepare('devbox', 'notes'), (e) => e instanceof PrepareError && e.status === 409);
  release();
  await finished('devbox', 'ehr');
  const next = await startPrepare('devbox', 'notes');
  assert.equal(next.status, 'running');
  await finished('devbox', 'notes');
});

test('refusals: this board\'s own machine, an unknown machine or project, and a project without a GitHub repo', async () => {
  useBox(fakeBox());
  await assert.rejects(() => startPrepare('local', 'ehr'), (e) => e.status === 400 && /nothing to prepare/.test(e.message));
  await assert.rejects(() => startPrepare('nowhere', 'ehr'), (e) => e.status === 404);
  await assert.rejects(() => startPrepare('devbox', 'ghost'), (e) => e.status === 404);
  await assert.rejects(() => startPrepare('devbox', 'norepo'), (e) => e.status === 400 && /no GitHub repository/.test(e.message));
  assert.deepEqual(prepareStatus('devbox', 'ehr'), { status: 'idle', step: null, lines: [], error: null });
});
