import './isolate.mjs';   // first: isolates the data directory
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'node:http';

import { config, configEvents } from '../src/config.js';
import { saveProjects, setMachineAutoClone, setInstallChoice } from '../src/projects.js';
import { registerRunnerClient } from '../src/machine.js';
import { RunnerMachine, runnerEvents, forgetRunnerHealth } from '../src/runner-client.js';
import { ensureCheckout, checkoutStatus, checkoutsBusy, checkoutHooks, resetCheckouts } from '../src/checkout.js';
import {
  sweep, retryTick, retryClone, machineRow, machineRows, startBgClone, resetBgClone,
} from '../src/bgclone.js';

const saved = config.machines;
after(() => {
  resetBgClone();
  if (saved === undefined) delete config.machines; else config.machines = saved;
  registerRunnerClient((name) => { throw new Error(`machines.${name}: runner client not loaded`); });
});

const who = { assignee: 'a', reviewer: 'r' };
const entry = (id, repo) => ({ id, name: id, ...who, repo, repoPath: `/board/${id}`, worktreeRoot: `/board/${id}-wt` });
const register = () => saveProjects([entry('ehr', 'o/ehr'), entry('notes', 'o/notes')]);

const yes = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' });
const no = (stderr = '') => ({ ok: false, code: 1, stdout: '', stderr });

/** A runner as a plain object; `dirs` maps a checkout path to its origin. */
function fakeBox({ dirs = {}, files = [] } = {}) {
  const box = {
    kind: 'runner', name: 'devbox', home: '/home/zoe', repoPath: '/x', worktreeRoot: '/y',
    path: path.posix, calls: [], shells: [], made: [], infos: 0,
    dirs: new Map(Object.entries(dirs)), files: new Set(files),
    down: false, cloneError: null, hold: null,
    info: async () => {
      box.infos += 1;
      if (box.down) throw new Error('connection refused');
      box.home = '/home/zoe';
      return { home: box.home };
    },
    fs: {
      exists: async (p) => box.files.has(p) || box.dirs.has(p) || (p.endsWith('/.git') && box.dirs.has(p.slice(0, -5))),
      mkdir: async (p) => { box.made.push(p); },
      rm: async (p) => { box.dirs.delete(p); box.files.delete(p); },
    },
    shell: async (command) => { box.shells.push(command); return yes(); },
    exec: async (file, args, opts = {}) => {
      box.calls.push([file, ...args]);
      if (file === 'gh' && args[0] === 'api') return yes('true\n');
      if (file === 'gh') {
        if (box.hold) await box.hold;
        if (box.cloneError) return no(box.cloneError);
        const [, , repo, to] = args;
        box.dirs.set(to, `https://github.com/${repo}.git`);
        return yes();
      }
      if (file === 'mv') {
        const [, , from, to] = args;
        box.dirs.set(to, box.dirs.get(from));
        box.dirs.delete(from);
        return yes();
      }
      if (args.includes('get-url')) return yes(`${box.dirs.get(args[1])}\n`);
      if (args.includes('--show-cdup')) return yes();
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
const idle = () => until(() => checkoutsBusy().length === 0);
const clones = (box) => box.calls.filter((c) => c[0] === 'gh' && c[1] === 'repo').map((c) => c[3]);
const fetches = (box) => box.calls.filter((c) => c.includes('fetch'));
const pairs = (list) => list.map((p) => `${p.machine}/${p.project}`).sort();

beforeEach(() => {
  resetBgClone();
  resetCheckouts();
  forgetRunnerHealth();
  register();
  checkoutHooks.holdsNewWork = () => false;
});

test('a sweep clones every missing project on the runner, without waiting for the clones', async () => {
  let release;
  const box = useBox(fakeBox());
  box.hold = new Promise((r) => { release = r; });
  assert.deepEqual(pairs(await sweep()), ['devbox/ehr', 'devbox/notes']);
  assert.equal(checkoutsBusy().length, 2);
  assert.deepEqual(await sweep(), [], 'a job in flight is not started again');
  release();
  await idle();
  assert.deepEqual(clones(box).sort(), ['o/ehr', 'o/notes']);
  assert.equal(box.shells.length, 0, 'nothing is installed unless asked');
});

test('a sweep of one project touches only that one, and learns a forgotten home first', async () => {
  const box = useBox(fakeBox());
  box.home = null;
  assert.deepEqual(pairs(await sweep(undefined, 'ehr')), ['devbox/ehr']);
  await idle();
  assert.equal(box.infos, 1);
  assert.ok(box.dirs.has('/home/zoe/src/ehr'));
});

test('a folder that is already there is not touched, not even fetched', async () => {
  const box = useBox(fakeBox({ dirs: { '/home/zoe/src/ehr': 'x' }, files: ['/home/zoe/src/notes'] }));
  assert.deepEqual(await sweep(), []);
  assert.equal(box.calls.length, 0);
  assert.equal(checkoutStatus('devbox', 'ehr').status, 'idle');
});

test('excluded runners, projectsRoot:false and explicit paths are not cloned', async () => {
  setMachineAutoClone('ehr', 'devbox', false);
  const box = useBox(fakeBox(), { projects: { notes: { repoPath: '/srv/notes', worktreeRoot: '/srv/notes-wt' } } });
  assert.deepEqual(await sweep(), []);
  useBox(box, { projectsRoot: false });
  assert.deepEqual(await sweep(), []);
  assert.equal(box.calls.length, 0);
});

test('nothing starts while the board is updating; the timer catches up afterwards', async () => {
  const box = useBox(fakeBox());
  checkoutHooks.holdsNewWork = () => true;
  assert.deepEqual(await sweep(), []);
  await retryTick();
  assert.equal(checkoutsBusy().length, 0);
  checkoutHooks.holdsNewWork = () => false;
  await retryTick();
  await idle();
  assert.equal(clones(box).length, 2);
});

test('an update that begins while the runner is being asked stops the sweep', async () => {
  const box = useBox(fakeBox());
  const exists = box.fs.exists;
  box.fs.exists = async (p) => { checkoutHooks.holdsNewWork = () => true; return exists(p); };
  assert.deepEqual(await sweep(), []);
  assert.equal(checkoutsBusy().length, 0);
});

test('a failed clone is not retried by the timer, but is by a new sweep or by hand', async () => {
  const box = useBox(fakeBox());
  box.cloneError = 'boom';
  await sweep(undefined, 'ehr');
  await idle();
  assert.equal(checkoutStatus('devbox', 'ehr').status, 'failed');
  setMachineAutoClone('notes', 'devbox', false);
  await retryTick();
  await retryTick();
  assert.equal(clones(box).length, 1);

  assert.deepEqual(pairs(await sweep()), ['devbox/ehr']);
  await idle();
  box.cloneError = null;
  setMachineAutoClone('ehr', 'devbox', false);
  const state = await retryClone('devbox', 'ehr');
  assert.equal(state.status, 'running', 'by hand works even when excluded');
  await idle();
  assert.equal(checkoutStatus('devbox', 'ehr').status, 'done');
});

test('a clone queued when the update began is retried by the timer', async () => {
  let release;
  const box = useBox(fakeBox());
  box.hold = new Promise((r) => { release = r; });
  await sweep();
  await until(() => clones(box).length === 1 && checkoutsBusy().some((j) => j.status === 'queued'));
  checkoutHooks.holdsNewWork = () => true;
  release();
  await idle();
  const codes = ['ehr', 'notes'].map((p) => checkoutStatus('devbox', p).code ?? null);
  assert.ok(codes.includes('upgrading'));
  checkoutHooks.holdsNewWork = () => false;
  await retryTick();
  await idle();
  assert.equal(box.dirs.size, 2);
});

test('after a restart, an accepted install is run only where dependencies are missing', async () => {
  const dir = '/home/zoe/src/ehr';
  const lock = `${dir}/package-lock.json`;
  const origin = { [dir]: 'https://github.com/o/ehr.git' };
  setInstallChoice('ehr', 'devbox', 'yes');

  const installed = useBox(fakeBox({ dirs: origin, files: [lock, `${dir}/node_modules`] }));
  assert.deepEqual(await sweep(undefined, 'ehr'), []);

  const missing = useBox(fakeBox({ dirs: origin, files: [lock] }));
  assert.deepEqual(pairs(await sweep(undefined, 'ehr')), ['devbox/ehr']);
  await idle();
  assert.equal(installed.shells.length, 0);
  assert.equal(missing.shells.length, 1);
  assert.deepEqual(clones(missing), []);
});

const withLock = () => {
  const dir = '/home/zoe/src/ehr';
  return useBox(fakeBox({ dirs: { [dir]: 'https://github.com/o/ehr.git' }, files: [`${dir}/package-lock.json`] }));
};

test('a failed install is not retried by a sweep, even after a later clone-only job', async () => {
  setInstallChoice('ehr', 'devbox', 'yes');
  const box = withLock();
  box.shell = async (command) => { box.shells.push(command); return no('boom'); };
  await sweep(undefined, 'ehr');
  await idle();
  assert.equal(checkoutStatus('devbox', 'ehr').status, 'failed');
  await ensureCheckout('devbox', 'ehr');   // as a chat does
  await idle();
  assert.deepEqual(await sweep(undefined, 'ehr'), []);
  assert.equal(box.shells.length, 1);
  assert.equal((await machineRow('ehr', 'devbox')).installed, false, 'still offered by hand');
});

test('a new clone in the same path owes the install again', async () => {
  setInstallChoice('ehr', 'devbox', 'yes');
  const box = withLock();
  await sweep(undefined, 'ehr');
  await idle();
  assert.equal(box.shells.length, 1);
  box.dirs.delete('/home/zoe/src/ehr');
  await ensureCheckout('devbox', 'ehr');   // a chat clones it again
  await idle();
  assert.equal((await machineRow('ehr', 'devbox')).installed, false);
  assert.deepEqual(pairs(await sweep(undefined, 'ehr')), ['devbox/ehr']);
  await idle();
  assert.equal(box.shells.length, 2);
});

test('a remembered yes installs after the clone', async () => {
  setInstallChoice('ehr', 'devbox', 'yes');
  const box = useBox(fakeBox({ files: ['/home/zoe/src/ehr/package-lock.json'] }));
  await sweep(undefined, 'ehr');
  await until(() => checkoutStatus('devbox', 'ehr').status === 'done');
  assert.equal(clones(box).length, 1);
  assert.equal(box.shells.length, 1);
  assert.match(box.shells[0], /npm ci/);
});

test('an install the update put off runs later, although the checkout is already there', async () => {
  setInstallChoice('ehr', 'devbox', 'yes');
  let release;
  const box = useBox(fakeBox({ files: ['/home/zoe/src/ehr/package-lock.json'] }));
  box.hold = new Promise((r) => { release = r; });
  await sweep(undefined, 'ehr');
  await until(() => clones(box).length === 1);
  checkoutHooks.holdsNewWork = () => true;
  release();
  await idle();
  assert.equal(checkoutStatus('devbox', 'ehr').code, 'upgrading');
  assert.equal(box.shells.length, 0);
  setMachineAutoClone('notes', 'devbox', false);
  checkoutHooks.holdsNewWork = () => false;
  await retryTick();
  await until(() => checkoutStatus('devbox', 'ehr').status === 'done');
  assert.equal(clones(box).length, 1);
  assert.equal(box.shells.length, 1);
});

/** A sweep whose first clone (`ehr`) is held, so the one of `notes` waits queued. */
async function heldQueue(box = useBox(fakeBox())) {
  let release;
  box.hold = new Promise((r) => { release = r; });
  await sweep();
  await until(() => clones(box).length === 1 && checkoutStatus('devbox', 'notes').status === 'queued');
  return { box, release: async () => { release(); await idle(); } };
}

for (const [what, change] of [
  ['its runner is excluded', () => setMachineAutoClone('notes', 'devbox', false)],
  ['its project is removed', () => saveProjects([entry('ehr', 'o/ehr')])],
  ['the convention is turned off', () => { config.machines.devbox.projectsRoot = false; }],
]) {
  test(`a queued background clone is given up when ${what}`, async () => {
    const { box, release } = await heldQueue();
    change();
    await release();
    assert.deepEqual(clones(box), ['o/ehr']);
    assert.equal(checkoutStatus('devbox', 'notes').status, 'idle', 'given up, not failed');
  });
}

test('a queued clone a chat or a task joined runs although the runner is excluded meanwhile', async () => {
  const { box, release } = await heldQueue();
  const joined = ensureCheckout('devbox', 'notes');
  setMachineAutoClone('notes', 'devbox', false);
  await release();
  assert.equal((await joined).cloned, true);
  assert.deepEqual(clones(box), ['o/ehr', 'o/notes']);
});

test('a queued clone retried by hand runs although the runner is excluded', async () => {
  const { box, release } = await heldQueue();
  setMachineAutoClone('notes', 'devbox', false);
  await retryClone('devbox', 'notes');
  await release();
  assert.deepEqual(clones(box), ['o/ehr', 'o/notes']);
});

const clonedInto = (box) => [...box.dirs.keys()].sort();

test('a queued background clone survives a reload that forgets the runner home', async () => {
  const { box, release } = await heldQueue();
  box.home = null;
  await release();
  assert.deepEqual(clones(box), ['o/ehr', 'o/notes']);
});

test('a queued clone whose path the convention moves is cloned at the new path only, as is the one under way', async () => {
  const { box, release } = await heldQueue();
  config.machines.devbox.projectsRoot = '/srv/new';
  assert.deepEqual(await sweep(), [], 'the sweep of the edit skips jobs still going');
  await release();
  await until(() => box.dirs.has('/srv/new/ehr') && box.dirs.has('/srv/new/notes'));
  await idle();
  assert.deepEqual(clonedInto(box), ['/home/zoe/src/ehr', '/srv/new/ehr', '/srv/new/notes']);
});

test('after a reload the home is asked again before deciding, so a new one moves the clone', async () => {
  const { box, release } = await heldQueue();
  box.home = null;
  box.info = async () => { box.home = '/home/max'; return { home: box.home }; };
  await release();
  await until(() => box.dirs.has('/home/max/src/notes'));
  await idle();
  assert.equal(box.dirs.has('/home/zoe/src/notes'), false);
});

test('a runner whose sweep met a job still going is looked at again by the timer', async () => {
  const { box, release } = await heldQueue();
  await sweep();
  await release();
  const asked = box.infos;
  await retryTick();
  assert.equal(box.infos, asked + 1);
  await retryTick();
  assert.equal(box.infos, asked + 1);
});

for (const infoFails of [false, true]) {
  const how = infoFails ? 'and `/info` fails' : 'and `/info` answers';
  const forget = (box) => {
    box.home = null;
    if (infoFails) box.info = async () => { throw new Error('refused'); };
  };

  test(`an excluded runner is not cloned to when a reload forgot its home ${how}`, async () => {
    const { box, release } = await heldQueue();
    setMachineAutoClone('notes', 'devbox', false);
    forget(box);
    await release();
    assert.deepEqual(clones(box), ['o/ehr']);
  });

  test(`an excluded runner gets no queued install when a reload forgot its home ${how}`, async () => {
    const dir = '/home/zoe/src/notes';
    setInstallChoice('notes', 'devbox', 'yes');
    const { box, release } = await heldQueue(useBox(fakeBox({
      dirs: { [dir]: 'https://github.com/o/notes.git' }, files: [`${dir}/package-lock.json`],
    })));
    setMachineAutoClone('notes', 'devbox', false);
    forget(box);
    await release();
    assert.equal(box.shells.length, 0);
  });
}

test('an install skipped while excluded runs once the runner is taken back in', async () => {
  const lock = '/home/zoe/src/notes/package-lock.json';
  setInstallChoice('notes', 'devbox', 'yes');
  const { box, release } = await heldQueue(useBox(fakeBox({ files: [lock] })));
  // A chat needs it, so the clone runs; the install is still the board's own idea.
  const joined = ensureCheckout('devbox', 'notes');
  setMachineAutoClone('notes', 'devbox', false);
  await release();
  await joined;
  assert.equal(box.shells.length, 0);
  assert.equal(checkoutStatus('devbox', 'notes').status, 'done');
  assert.equal((await machineRow('notes', 'devbox')).installed, false);
  // A later clone-only job must not make the board forget what it owes.
  await ensureCheckout('devbox', 'notes');
  await idle();

  setMachineAutoClone('notes', 'devbox', true);
  assert.deepEqual(pairs(await sweep('devbox', 'notes')), ['devbox/notes']);
  await idle();
  assert.equal(box.shells.length, 1);
  assert.equal((await machineRow('notes', 'devbox')).installed, true);
  // This install leaves no `node_modules` (nothing to put there): not repeated.
  assert.deepEqual(await sweep('devbox', 'notes'), []);
});

test('a queued background install is skipped once the answer is no, and the clone still runs', async () => {
  setInstallChoice('notes', 'devbox', 'yes');
  const { box, release } = await heldQueue(useBox(fakeBox({ files: ['/home/zoe/src/notes/package-lock.json'] })));
  setInstallChoice('notes', 'devbox', 'no');
  await release();
  assert.deepEqual(clones(box), ['o/ehr', 'o/notes']);
  assert.equal(box.shells.length, 0);
  assert.equal(checkoutStatus('devbox', 'notes').status, 'done');
});

test('a clone the update put off is deferred only while the sweep will run it again', async () => {
  const box = useBox(fakeBox());
  const { release } = await heldQueue(box);
  checkoutHooks.holdsNewWork = () => true;
  await release();
  assert.equal(checkoutStatus('devbox', 'notes').code, 'upgrading');
  assert.equal((await machineRow('notes', 'devbox')).deferred, true);

  setMachineAutoClone('notes', 'devbox', false);
  assert.equal((await machineRow('notes', 'devbox')).deferred, false, 'excluded: only by hand');

  // There by now and no install accepted: the sweep has nothing to run.
  setMachineAutoClone('notes', 'devbox', true);
  box.dirs.set('/home/zoe/src/notes', 'https://github.com/o/notes.git');
  assert.equal((await machineRow('notes', 'devbox')).deferred, false);
  checkoutHooks.holdsNewWork = () => false;
  await retryTick();
  await idle();
  assert.equal(checkoutStatus('devbox', 'notes').status, 'idle');
});

test('an install put off with no accepted answer is not deferred, and the timer leaves the runner alone', async () => {
  const box = useBox(fakeBox({ dirs: { '/home/zoe/src/ehr': 'https://github.com/o/ehr.git', '/home/zoe/src/notes': 'https://github.com/o/notes.git' } }));
  await sweep();
  checkoutHooks.holdsNewWork = () => true;
  await assert.rejects(ensureCheckout('devbox', 'ehr', { install: async () => {} }), { code: 'upgrading' });
  checkoutHooks.holdsNewWork = () => false;
  assert.equal((await machineRow('ehr', 'devbox')).deferred, false);
  const asked = box.infos;
  await retryTick();
  assert.equal(box.infos, asked);
  assert.equal(checkoutStatus('devbox', 'ehr').code, 'upgrading', 'the failure stays to be retried by hand');
});

test('a runner that was down gets its projects from the timer once it answers', async () => {
  const box = useBox(fakeBox());
  box.home = null;
  box.down = true;
  assert.deepEqual(await sweep(), []);
  await retryTick();
  assert.equal(box.calls.length, 0);
  box.down = false;
  await retryTick();
  await idle();
  assert.equal(clones(box).length, 2);
  const asked = box.infos;
  await retryTick();
  assert.equal(box.infos, asked, 'a swept runner that is up is left alone');
});

test('`reachable` sweeps the runner, once started and not after a reset', async () => {
  const box = useBox(fakeBox());
  startBgClone();
  startBgClone();
  assert.equal(runnerEvents.listenerCount('reachable'), 1);
  runnerEvents.emit('reachable', { machine: 'devbox', online: true });
  await until(() => clones(box).length === 2);
  await idle();
  resetBgClone();
  assert.equal(runnerEvents.listenerCount('reachable'), 0);
});

test('a runner added to the config later gets the projects', async () => {
  config.machines = {};
  const box = fakeBox();
  registerRunnerClient(() => box);
  startBgClone();
  config.machines = { devbox: { ...SPEC } };
  configEvents.emit('change', { config, needsRestart: [] });
  await until(() => clones(box).length === 2);
  await idle();
});

test('a reload that changes nothing does not retry failed clones', async () => {
  const box = useBox(fakeBox());
  box.cloneError = 'boom';
  startBgClone();
  await sweep();
  await idle();
  box.home = null;   // as when the reload rebuilt the runner
  configEvents.emit('change', { config, needsRestart: [] });
  await until(() => box.home !== null);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(clones(box).length, 2);
});

test('the real client says `reachable` on the first answer and after an outage, not on every call', async () => {
  const server = createServer((req, res) => res.end(JSON.stringify({ home: '/home/zoe' })));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const runner = new RunnerMachine('real', { ...SPEC, url: `http://127.0.0.1:${port}` });
  const seen = [];
  const listeners = ['reachable', 'online', 'offline'].map((name) => [name, () => seen.push(name)]);
  for (const [name, fn] of listeners) runnerEvents.on(name, fn);
  try {
    await runner.info();
    await runner.info();
    assert.deepEqual(seen, ['reachable']);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await assert.rejects(runner.info());
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
    await runner.info();
    assert.deepEqual(seen, ['reachable', 'offline', 'reachable', 'online']);
  } finally {
    for (const [name, fn] of listeners) runnerEvents.off(name, fn);
    server.closeAllConnections();
    server.close();
  }
});

test('the rows say what each machine has of a project', async () => {
  setMachineAutoClone('ehr', 'devbox', false);
  setInstallChoice('ehr', 'devbox', 'no');
  useBox(fakeBox({ dirs: { '/home/zoe/src/ehr': 'x' } }));
  const rows = await machineRows('ehr');
  assert.deepEqual(rows.map((r) => r.machine), ['local', 'devbox']);
  assert.equal(rows[0].reason, 'local');
  assert.equal(rows[0].nodeModules, false);
  assert.deepEqual(rows[1], {
    machine: 'devbox', kind: 'runner', eligible: false, reason: 'excluded', autoClone: false, present: true,
    job: { status: 'idle', step: null, error: null, code: null }, deferred: false, install: 'no', installed: false,
  });
  assert.deepEqual(await machineRow('ehr', 'devbox'), rows[1]);
  await assert.rejects(machineRows('ghost'), { status: 404 });
  await assert.rejects(machineRow('ehr', 'nowhere'), { status: 404 });
});

test('a runner that does not answer leaves `present` unknown', async () => {
  const box = useBox(fakeBox());
  box.home = null;
  box.down = true;
  box.fs.exists = async () => { throw new Error('connection refused'); };
  const row = await machineRow('ehr', 'devbox');
  assert.equal(row.present, null);
  assert.equal(row.reason, 'home_unknown');
});

test('a retry by hand is refused where it cannot run', async () => {
  useBox(fakeBox());
  await assert.rejects(retryClone('local', 'ehr'), { status: 400 });
  await assert.rejects(retryClone('nowhere', 'ehr'), { status: 404 });
  await assert.rejects(retryClone('devbox', 'ghost'), { status: 404 });
  checkoutHooks.holdsNewWork = () => true;
  await assert.rejects(retryClone('devbox', 'ehr'), { status: 409, code: 'upgrading' });
});

test('the local machine is never swept, and a later chat joins the background clone', async () => {
  let release;
  const box = useBox(fakeBox());
  box.hold = new Promise((r) => { release = r; });
  const started = await sweep(undefined, 'ehr');
  assert.deepEqual(pairs(started), ['devbox/ehr']);
  const chat = ensureCheckout('devbox', 'ehr');
  release();
  assert.equal((await chat).cloned, true);
  assert.equal(clones(box).length, 1);
  assert.equal(fetches(box).length, 1, 'only the fetch that checks the new clone');
});
