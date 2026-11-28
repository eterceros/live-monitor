import './isolate.mjs';   // first: isolates the data directory
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempDir } from './teardown.mjs';

import { config } from '../src/config.js';
import { saveProjects, listProjects } from '../src/projects.js';
import { registerRunnerClient } from '../src/machine.js';
import { RepoStateError } from '../src/worktree.js';
import {
  ensureCheckout, projectRepo, checkoutReadiness, checkoutStatus, checkoutsBusy, checkoutHooks, resetCheckouts,
} from '../src/checkout.js';

const saved = config.machines;
after(() => {
  if (saved === undefined) delete config.machines; else config.machines = saved;
  registerRunnerClient((name) => { throw new Error(`machines.${name}: runner client not loaded`); });
});

const who = { assignee: 'a', reviewer: 'r' };
const entry = (id, repo) => ({ id, name: id, ...who, repo, repoPath: `/board/${id}`, worktreeRoot: `/board/${id}-wt` });
saveProjects([entry('hfs', 'o/hfs'), entry('ehr', 'o/ehr'), entry('notes', 'o/notes'), entry('norepo', null)]);

const FINAL = '/home/zoe/src/ehr';
const TEMP = '/home/zoe/src/.ehr.hfsmon-clone';
const yes = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' });
const no = (stderr = '') => ({ ok: false, code: 1, stdout: '', stderr });

/**
 * A runner as a plain object. `dirs` maps a checkout path to what its git says;
 * a path in `files` exists without being a checkout.
 */
function fakeBox({ dirs = {}, files = [], cloneError = null, cloned = {}, push = 'true', hold = null } = {}) {
  const box = {
    kind: 'runner', name: 'devbox', home: '/home/zoe', repoPath: '/x', worktreeRoot: '/y',
    path: path.posix, calls: [], made: [], removed: [], dirs: new Map(Object.entries(dirs)), files: new Set(files),
    cloneError,
    info: async () => ({ home: '/home/zoe' }),
    fs: {
      exists: async (p) => box.files.has(p) || box.dirs.has(p) || (p.endsWith('/.git') && box.dirs.has(p.slice(0, -5))),
      mkdir: async (p) => { box.made.push(p); },
      rm: async (p) => { box.removed.push(p); box.dirs.delete(p); box.files.delete(p); },
    },
    exec: async (file, args, opts = {}) => {
      box.calls.push([file, ...args]);
      if (file === 'gh' && args[0] === 'api') return yes(`${push}\n`);
      if (file === 'gh') {
        if (hold) await hold;
        const [, , repo, to] = args;
        opts.onLine?.(`Cloning into '${to}'...`);
        if (box.cloneError) { box.files.add(to); return no(box.cloneError); }
        box.dirs.set(to, { origin: `https://github.com/${repo}.git`, refs: ['main'], ...cloned });
        return yes();
      }
      if (file === 'mv') {
        const [, , from, to] = args;
        if (!box.dirs.has(to) && !box.files.has(to)) { box.dirs.set(to, box.dirs.get(from)); box.dirs.delete(from); }
        return yes();
      }
      const repo = box.dirs.get(args[0] === '-C' ? args[1] : opts.cwd);
      if (!repo) return no('not a git repository');
      const cmd = args[0] === '-C' ? args.slice(2) : args;
      if (cmd[0] === 'remote' && cmd[1] === 'get-url') return repo.origin ? yes(`${repo.origin}\n`) : no('No such remote');
      if (cmd[0] === 'remote') return yes(repo.origin ? 'origin\n' : '');
      if (cmd[0] === 'fetch') return repo.fetchError ? no(repo.fetchError) : yes();
      if (cmd[0] === 'rev-parse' && cmd.includes('--verify')) return repo.refs.some((r) => cmd.at(-1) === `refs/remotes/origin/${r}`) ? yes('abc\n') : no();
      if (cmd[0] === 'for-each-ref' && cmd.at(-1) === 'refs/heads') return yes(repo.local ? 'refs/heads/x\n' : '');
      if (cmd[0] === 'for-each-ref') return yes(repo.refs.map((r) => `refs/remotes/origin/${r}\n`).join(''));
      return yes();
    },
  };
  return box;
}

const SPEC = { kind: 'runner', url: 'http://127.0.0.1:9', token: 't', repoPath: '/x', worktreeRoot: '/y' };
function useBox(box, spec = {}) {
  config.machines = { devbox: { ...SPEC, ...spec } };
  registerRunnerClient(() => box);
  return box;
}

async function until(ok, ms = 3000) {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const clones = (box) => box.calls.filter((c) => c[0] === 'gh' && c[1] === 'repo');
const ready = (extra = {}) => ({ origin: 'git@github.com:o/ehr.git', refs: ['main'], ...extra });

beforeEach(() => { resetCheckouts(); checkoutHooks.holdsNewWork = () => false; });

test('a missing checkout is cloned into the reserved sibling, then renamed into place', async () => {
  const box = useBox(fakeBox({ files: [TEMP] }));
  const lines = [];
  const result = await ensureCheckout('devbox', 'ehr', { onLine: (l) => lines.push(l) });
  assert.deepEqual(result, { cloned: true, warnings: [] });
  assert.deepEqual(clones(box), [['gh', 'repo', 'clone', 'o/ehr', TEMP]]);
  assert.equal(box.removed[0], TEMP, 'the leftover of an interrupted run goes first');
  assert.ok(box.calls.some((c) => c.join(' ') === `mv -T -n ${TEMP} ${FINAL}`));
  assert.ok(box.dirs.has(FINAL));
  assert.ok(!box.made.some((p) => p.endsWith('-wt')), 'no worktree directory');
  assert.ok(lines.some((l) => l.startsWith('cloning o/ehr')));
  assert.equal(checkoutStatus('devbox', 'ehr').status, 'done');
});

test('the local machine is left alone', async () => {
  assert.deepEqual(await ensureCheckout('local', 'ehr'), { cloned: false, warnings: [] });
  assert.equal(checkoutStatus('local', 'ehr').status, 'idle');
});

test('a ready checkout is only checked; HTTPS with a login and ssh:// origins match', async () => {
  for (const origin of ['git@github.com:O/EHR.git', 'https://zoe@github.com/o/ehr', 'ssh://git@github.com/o/ehr.git']) {
    resetCheckouts();
    const box = useBox(fakeBox({ dirs: { [FINAL]: ready({ origin }) } }));
    assert.equal((await ensureCheckout('devbox', 'ehr')).cloned, false);
    assert.equal(clones(box).length, 0);
    assert.deepEqual(box.removed, []);
  }
});

test('an unusable directory at the final path is reported and left untouched', async () => {
  const cases = [
    [fakeBox({ files: [FINAL] }), /not a complete git checkout/],
    [fakeBox({ dirs: { [FINAL]: ready({ origin: 'git@github.com:other/repo.git' }) } }), /origin other\/repo, not o\/ehr/],
    [fakeBox({ dirs: { [FINAL]: ready({ origin: null }) } }), /remoto origin/],
    [fakeBox({ dirs: { [FINAL]: ready({ refs: [] }) } }), /repositorio está vacío/],
    [fakeBox({ dirs: { [FINAL]: ready({ refs: [], local: true }) } }), /remoto origin está vacío/],
    [fakeBox({ dirs: { [FINAL]: ready({ refs: ['dev'] }) } }), /rama base «main» no existe/],
    [fakeBox({ dirs: { [FINAL]: ready({ fetchError: 'could not resolve host' }) } }), /git fetch failed/],
  ];
  for (const [box, message] of cases) {
    resetCheckouts();
    useBox(box);
    await assert.rejects(() => ensureCheckout('devbox', 'ehr'), message);
    assert.deepEqual(box.removed, []);
    assert.equal(clones(box).length, 0);
    assert.ok(!box.calls.some((c) => c[0] === 'mv'));
  }
  const state = await checkoutReadiness(useBox(fakeBox()), { repo: 'o/ehr', repoPath: FINAL });
  assert.equal(state.code, 'missing');
  const empty = await checkoutReadiness(fakeBox({ dirs: { [FINAL]: ready({ refs: [] }) } }), { repo: 'o/ehr', repoPath: FINAL });
  assert.ok(empty.error instanceof RepoStateError);
  assert.equal(empty.code, 'empty_repo');
});

test('a failed clone is actionable, leaves nothing behind, and a retry works', async () => {
  const box = useBox(fakeBox({ cloneError: 'GraphQL: Could not resolve to a Repository' }));
  await assert.rejects(() => ensureCheckout('devbox', 'ehr'),
    (e) => e.code === 'no_access' && /"devbox".*o\/ehr.*gh auth login/s.test(e.message));
  assert.equal(box.files.has(TEMP), false);
  assert.equal(box.dirs.has(FINAL), false);
  assert.equal(checkoutStatus('devbox', 'ehr').status, 'failed');
  assert.deepEqual(checkoutsBusy(), []);

  box.cloneError = 'connection reset';
  await assert.rejects(() => ensureCheckout('devbox', 'ehr'), (e) => e.code === 'clone_failed');
  box.cloneError = null;
  assert.equal((await ensureCheckout('devbox', 'ehr')).cloned, true);
});

test('a clone that is not ready, or whose final path appeared meanwhile, never lands', async () => {
  const empty = useBox(fakeBox({ cloned: { refs: [] } }));
  await assert.rejects(() => ensureCheckout('devbox', 'ehr'), (e) => e.code === 'empty_repo');
  assert.equal(empty.dirs.size, 0);

  resetCheckouts();
  const raced = useBox(fakeBox());
  const exec = raced.exec;
  raced.exec = async (file, args, opts) => {
    if (file === 'mv') raced.files.add(FINAL);
    return exec(file, args, opts);
  };
  await assert.rejects(() => ensureCheckout('devbox', 'ehr'), (e) => e.code === 'rename_failed');
  assert.ok(raced.files.has(FINAL));
  assert.ok(!raced.removed.includes(FINAL));
});

test('one clone per project with both logs; another project waits its turn', async () => {
  let release;
  const box = useBox(fakeBox({ hold: new Promise((r) => { release = r; }) }));
  const a = [];
  const b = [];
  const first = ensureCheckout('devbox', 'ehr', { onLine: (l) => a.push(l) });
  const same = ensureCheckout('devbox', 'ehr', { onLine: (l) => b.push(l) });
  const other = ensureCheckout('devbox', 'notes');
  await until(() => checkoutStatus('devbox', 'notes').status === 'queued');
  assert.equal(checkoutStatus('devbox', 'notes').step, 'queued');
  assert.equal(checkoutsBusy().length, 2);
  release();
  const results = await Promise.all([first, same, other]);
  assert.ok(results.every((r) => r.cloned));
  assert.deepEqual(clones(box).map((c) => c[3]), ['o/ehr', 'o/notes']);
  assert.deepEqual(a, b);
  assert.deepEqual(checkoutsBusy(), []);
});

test('install: joins a clone in flight; only its caller waits for it and sees it fail', async () => {
  let release;
  const box = useBox(fakeBox({ hold: new Promise((r) => { release = r; }) }));
  const chat = ensureCheckout('devbox', 'ehr');
  let failInstall;
  const prepare = ensureCheckout('devbox', 'ehr', {
    install: async (machine, { setStep }) => {
      assert.equal(machine.repoPath, FINAL);
      setStep('install');
      await new Promise((_, reject) => { failInstall = () => reject(new Error('install failed')); });
    },
  });
  prepare.catch(() => {});
  release();
  assert.equal((await chat).cloned, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(checkoutStatus('devbox', 'ehr').step, 'install');
  failInstall();
  await assert.rejects(() => prepare, /install failed/);
  assert.equal(checkoutStatus('devbox', 'ehr').status, 'failed');
  assert.equal(clones(box).length, 1);
});

test('opt-outs: an explicit path is only checked, unless Prepare asks', async () => {
  const projects = { ehr: { repoPath: '/srv/ehr', worktreeRoot: '/srv/ehr-wt' } };
  const box = useBox(fakeBox(), { projectsRoot: false, projects });
  await assert.rejects(() => ensureCheckout('devbox', 'ehr'), (e) => e.code === 'missing' && /\/srv\/ehr/.test(e.message));
  await assert.rejects(() => ensureCheckout('devbox', 'notes'), /not declared/);
  await assert.rejects(() => ensureCheckout('devbox', 'hfs'), (e) => e.code === 'missing');
  assert.equal(clones(box).length, 0);
  assert.equal((await ensureCheckout('devbox', 'ehr', { install: async () => {} })).cloned, true);
  assert.ok(box.dirs.has('/srv/ehr'));
});

test('an unknown home is asked for; an unreachable runner and a missing repo are clear errors', async () => {
  const box = useBox(fakeBox());
  box.home = null;
  box.info = async () => { box.home = '/home/zoe'; return { home: box.home }; };
  assert.equal((await ensureCheckout('devbox', 'ehr')).cloned, true);

  const down = useBox(fakeBox());
  down.home = null;
  down.info = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(() => ensureCheckout('devbox', 'notes'), (e) => e.code === 'runner_unreachable' && /"devbox" is unreachable/.test(e.message));

  const dropped = useBox(fakeBox());
  dropped.fs.exists = async () => { throw Object.assign(new Error('no answer'), { code: 'RUNNER_OFFLINE' }); };
  await assert.rejects(() => ensureCheckout('devbox', 'ehr'), (e) => e.code === 'runner_unreachable');

  await assert.rejects(() => ensureCheckout('devbox', 'norepo'), (e) => e.code === 'no_repo' && /"norepo".*devbox/.test(e.message));
});

test('read-only access clones and warns', async () => {
  useBox(fakeBox({ push: 'false' }));
  const result = await ensureCheckout('devbox', 'ehr');
  assert.equal(result.cloned, true);
  assert.match(result.warnings[0], /devbox can read o\/ehr but not push/);
});

test('during a board upgrade nothing new is cloned; a ready checkout still passes', async () => {
  checkoutHooks.holdsNewWork = () => true;
  const box = useBox(fakeBox());
  await assert.rejects(() => ensureCheckout('devbox', 'ehr'), (e) => e.code === 'upgrading' && e.status === 409);
  assert.equal(clones(box).length, 0);
  useBox(fakeBox({ dirs: { [FINAL]: ready() } }));
  assert.equal((await ensureCheckout('devbox', 'ehr')).cloned, false);
});

test('a project with no repo takes it from the board checkout\'s origin, as github.js does', async (t) => {
  const board = tempDir('hfsmon-board-');
  execFileSync('git', ['init', '-q', board]);
  execFileSync('git', ['-C', board, 'remote', 'add', 'origin', 'git@github.com:o/ehr.git']);
  const registered = listProjects();
  t.after(() => saveProjects(registered));
  saveProjects(registered.map((p) => (p.id === 'norepo' ? { ...p, repo: null, repoPath: board } : p)));
  assert.equal(projectRepo('norepo'), 'o/ehr');

  // Already on the runner: checked and used, nothing cloned.
  const there = useBox(fakeBox());
  const at = `/home/zoe/src/${path.basename(board)}`;
  there.dirs.set(at, ready());
  assert.equal((await ensureCheckout('devbox', 'norepo')).cloned, false);
  assert.equal(clones(there).length, 0);

  // Missing: the detected repository is what gets cloned.
  resetCheckouts();
  const empty = useBox(fakeBox());
  assert.equal((await ensureCheckout('devbox', 'norepo')).cloned, true);
  assert.equal(clones(empty)[0][3], 'o/ehr');
});

test('the readiness check gives its fetch the limit the caller asks for', async () => {
  const box = useBox(fakeBox({ dirs: { [FINAL]: ready() } }));
  const limits = [];
  const exec = box.exec;
  box.exec = (file, args, opts = {}) => {
    if (args.includes('fetch')) limits.push(opts.timeoutMs);
    return exec(file, args, opts);
  };
  const at = { ...box, repoPath: FINAL };
  await checkoutReadiness(at, { repo: 'o/ehr', fetchTimeoutMs: 1234 });
  await checkoutReadiness(at, { repo: 'o/ehr' });
  assert.deepEqual(limits, [1234, checkoutHooks.fetchTimeoutMs]);
});

test('a ready checkout does not wait for another project\'s clone', async () => {
  let release;
  const box = useBox(fakeBox({ dirs: { '/home/zoe/src/notes': { origin: 'https://github.com/o/notes.git', refs: ['main'] } }, hold: new Promise((r) => { release = r; }) }));
  const cloning = ensureCheckout('devbox', 'ehr');
  await until(() => clones(box).length === 1);
  assert.deepEqual(await ensureCheckout('devbox', 'notes'), { cloned: false, warnings: [] });
  assert.equal(checkoutStatus('devbox', 'ehr').status, 'running', 'the clone is still under way');
  release();
  await cloning;
});

test('a ready checkout does not wait for another project\'s install; installs still take turns', async () => {
  const ready2 = (repo) => ({ origin: `https://github.com/${repo}.git`, refs: ['main'] });
  useBox(fakeBox({ dirs: { [FINAL]: ready2('o/ehr'), '/home/zoe/src/notes': ready2('o/notes') } }));
  let finishFirst;
  const order = [];
  const first = ensureCheckout('devbox', 'ehr', {
    install: async () => {
      order.push('ehr starts');
      await new Promise((r) => { finishFirst = r; });
      order.push('ehr ends');
    },
  });
  await until(() => finishFirst);
  // A chat or a task of the other project is answered at once...
  await ensureCheckout('devbox', 'notes');
  await until(() => checkoutStatus('devbox', 'notes').status === 'done');
  // ...and its Prepare waits its turn, while later callers still do not.
  const second = ensureCheckout('devbox', 'notes', { install: async () => { order.push('notes installs'); } });
  await until(() => checkoutStatus('devbox', 'notes').status === 'queued');
  assert.deepEqual(await ensureCheckout('devbox', 'notes'), { cloned: false, warnings: [] });
  assert.deepEqual(order, ['ehr starts']);
  finishFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['ehr starts', 'ehr ends', 'notes installs']);
});
