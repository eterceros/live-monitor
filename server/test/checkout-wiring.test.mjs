// The checkout step as chats and tasks reach it: the real pipeline on a runner
// that has no checkout yet. The runner is a plain object and the session is
// stubbed, so nothing is cloned or spawned.
import './isolate.mjs';   // first: isolates the data directory
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { config } from '../src/config.js';
import { saveProjects } from '../src/projects.js';
import { registerRunnerClient } from '../src/machine.js';
import { expectedClaudeVersion } from '../src/claude.js';
import { resetCheckouts } from '../src/checkout.js';
import { keyOf } from '../src/keys.js';

process.env.HFSMON_NO_AUTOSTART = '1';

const who = { assignee: 'a', reviewer: 'r' };
const entry = (id) => ({ id, name: id, ...who, repo: `o/${id}`, repoPath: `/board/${id}`, worktreeRoot: `/board/${id}-wt` });
saveProjects([entry('hfs'), entry('ehr')]);

const REPO = '/home/zoe/src/ehr';
const WT_ROOT = '/home/zoe/src/ehr-wt';
const yes = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' });
const no = (stderr = '') => ({ ok: false, code: 1, stdout: '', stderr });

/** A runner with nothing on disk. `events` records what was made and run, in order. */
function fakeBox() {
  const box = {
    kind: 'runner', name: 'devbox', home: null, repoPath: '/x', worktreeRoot: '/y', path: path.posix,
    events: [], dirs: new Set(), worktrees: new Set(), cloneError: null, push: 'true',
    cloneGate: null, headGate: null, headHeld: false,
    samePath: (a, b) => a === b,
    info: async () => { box.home = '/home/zoe'; return { home: '/home/zoe', claude: expectedClaudeVersion() ?? '999.0.0' }; },
    fs: {
      exists: async (p) => box.dirs.has(p) || box.worktrees.has(p) || (p.endsWith('/.git') && box.dirs.has(p.slice(0, -5))),
      mkdir: async (p) => { box.events.push(`mkdir ${p}`); },
      rm: async (p) => { box.dirs.delete(p); },
    },
    exec: async (file, args, opts = {}) => {
      if (file === 'gh' && args[0] === 'api') return yes(`${box.push}\n`);
      if (file === 'gh') {
        box.events.push('clone');
        if (box.cloneGate) await box.cloneGate;
        if (box.cloneError) return no(box.cloneError);
        box.dirs.add(args[3]);
        return yes();
      }
      if (file === 'mv') {
        box.dirs.delete(args[2]);
        box.dirs.add(args[3]);
        return yes();
      }
      const cmd = args.filter((a) => !a.startsWith('--no-optional'));
      const [verb, ...rest] = cmd[0] === '-C' ? cmd.slice(2) : cmd;
      if (verb === 'rev-parse' && rest.join() === 'HEAD' && box.headGate) {
        box.headHeld = true;
        await box.headGate;
      }
      if (verb === 'remote' && rest[0] === 'get-url') return yes('https://github.com/o/ehr.git\n');
      if (verb === 'rev-parse' && rest.includes('--git-common-dir')) return box.worktrees.has(opts.cwd) ? yes(`${REPO}/.git\n`) : no();
      if (verb === 'worktree' && rest[0] === 'add') {
        const to = rest.find((a) => a.startsWith(`${WT_ROOT}/`));
        box.events.push('worktree add');
        box.worktrees.add(to);
      }
      return yes();
    },
    shell: async () => yes(),
  };
  return box;
}

let box;
let pipeline;
let store;
let projectchats;
let chats;
let ChatSession;
const real = {};
const sent = [];
const saved = config.machines;

before(async () => {
  pipeline = await import('../src/pipeline.js');
  ({ store } = await import('../src/store.js'));
  projectchats = await import('../src/projectchats.js');
  chats = await import('../src/chats.js');
  ({ ChatSession } = await import('../src/session.js'));
  real.send = ChatSession.prototype.send;
  real.retune = ChatSession.prototype.retune;
  ChatSession.prototype.retune = async () => ({ reopened: false });
  ChatSession.prototype.send = async function send(prompt) {
    sent.push({ cwd: this.cwd, prompt });
    return { ok: true, sessionId: `sess-${sent.length}`, toolCounts: {}, resultText: '' };
  };
});

after(() => {
  ChatSession.prototype.send = real.send;
  ChatSession.prototype.retune = real.retune;
  if (saved === undefined) delete config.machines; else config.machines = saved;
  registerRunnerClient((name) => { throw new Error(`machines.${name}: runner client not loaded`); });
});

beforeEach(() => {
  resetCheckouts();
  sent.length = 0;
  box = fakeBox();
  config.machines = { devbox: { kind: 'runner', url: 'http://127.0.0.1:9', token: 't', repoPath: '/x', worktreeRoot: '/y' } };
  registerRunnerClient(() => box);
});

async function until(ok, ms = 3000) {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for the turn');
    await new Promise((r) => setTimeout(r, 5));
  }
}

let n = 6200;
function taskOnRunner() {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'ehr');
  task.machine = 'devbox';
  task.branch = `feat/${n}-x`;   // a known branch: nothing is asked of GitHub
  return task;
}

const logOf = (owner, phase) => (owner.log ?? []).filter((l) => l.phase === phase).map((l) => l.line);

test('a task worktree on a runner without the project: cloned first, no -wt folder before that', async () => {
  const task = taskOnRunner();
  box.push = 'false';
  const wt = await pipeline.ensureWorktree(keyOf(task));
  assert.ok(wt.startsWith(`${WT_ROOT}/`), wt);
  const cloneAt = box.events.indexOf('clone');
  assert.ok(cloneAt >= 0);
  assert.ok(box.events.indexOf(`mkdir ${WT_ROOT}`) > cloneAt, box.events.join(', '));
  assert.ok(box.events.indexOf('worktree add') > cloneAt);
  const log = logOf(task, 'worktree');
  assert.ok(log.some((l) => /^cloning o\/ehr into /.test(l)), log.join('\n'));
  assert.ok(log.some((l) => /cannot be pushed from devbox/.test(l)), log.join('\n'));
  assert.equal(task.creatingWorktree, false);
});

test('a failed clone leaves the task free and no -wt folder, and a retry works', async () => {
  const task = taskOnRunner();
  box.cloneError = 'GraphQL: Could not resolve to a Repository with the name o/ehr';
  await assert.rejects(() => pipeline.ensureWorktree(keyOf(task)), /devbox.*cannot read.*o\/ehr/);
  assert.equal(task.creatingWorktree, false);
  assert.ok(!box.events.includes(`mkdir ${WT_ROOT}`), box.events.join(', '));
  box.cloneError = null;
  assert.ok(await pipeline.ensureWorktree(keyOf(task)));
});

test('the first chat message on a runner clones the project and is answered; a failure frees the chat', async () => {
  await box.info();   // as the header's machine poll does: a runner's chat is listed once its home is known
  const holder = projectchats.getHolder('ehr', 'devbox');
  const key = projectchats.holderKey('ehr', 'devbox');
  const chat = chats.addChatTo(holder, {});

  box.cloneError = 'network is down';
  pipeline.sendChat(key, chat.id, 'hola');
  await until(() => !chat.busy && chat.messages.some((m) => /network is down/.test(m.text ?? '')));
  assert.equal(sent.length, 0);
  assert.ok(!box.events.includes(`mkdir ${WT_ROOT}`), box.events.join(', '));

  box.cloneError = null;
  box.push = 'false';
  pipeline.sendChat(key, chat.id, 'hola otra vez');
  await until(() => !chat.busy && sent.length === 1);
  assert.equal(holder.worktreePath, `${WT_ROOT}/_proyecto`);
  assert.equal(sent[0].cwd, holder.worktreePath);
  assert.ok(logOf(holder, 'chat').some((l) => /^cloning o\/ehr into /.test(l)));
  assert.ok(chat.messages.some((m) => /cannot be pushed from devbox/.test(m.text ?? '')));

  // A usable worktree is not checked again on the next turn.
  const clones = box.events.filter((e) => e === 'clone').length;
  pipeline.sendChat(key, chat.id, 'tercera');
  await until(() => !chat.busy && sent.length === 2);
  assert.equal(box.events.filter((e) => e === 'clone').length, clones);
});

function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}
const settle = () => new Promise((r) => setTimeout(r, 100));
const times = (text, part) => text.split(part).length - 1;

async function runnerChat() {
  await box.info();
  const holder = projectchats.getHolder('ehr', 'devbox');
  // The holder outlives a test: this one starts without a worktree again.
  holder.worktreePath = null;
  const chat = chats.addChatTo(holder, {});
  return { holder, chat, key: projectchats.holderKey('ehr', 'devbox') };
}

const said = (chat, re) => chat.messages.filter((m) => m.role === 'assistant' && re.test(m.text ?? ''));

test('Stop during a clone: nothing is sent, and what was typed meanwhile goes once with the next message', async () => {
  const { holder, chat, key } = await runnerChat();
  const clone = gate();
  box.cloneGate = clone.promise;
  pipeline.sendChat(key, chat.id, 'mensaje-detenido');
  await until(() => box.events.includes('clone'));
  pipeline.sendChat(key, chat.id, 'nota-pendiente');

  await pipeline.interruptChat(key, chat.id);
  assert.equal(chat.busy, false);
  assert.equal(chat.activity, null);
  assert.equal(said(chat, /message was not sent.*goes on in the background.*next message/).length, 1);

  clone.open();
  await until(() => holder.worktreePath);   // the shared clone is not cancelled
  await settle();
  assert.equal(sent.length, 0);
  assert.equal(chat.busy, false);
  assert.equal(chat.activity, null);
  assert.equal(chat.notes.length, 1);

  pipeline.sendChat(key, chat.id, 'siguiente');
  await until(() => !chat.busy && sent.length === 1);
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(times(sent[0].prompt, 'nota-pendiente'), 1);
  assert.equal(times(sent[0].prompt, 'siguiente'), 1);
  assert.equal(times(sent[0].prompt, 'mensaje-detenido'), 0);
  assert.equal(chat.notes.length, 0);
});

test('a message sent after Stop, with the clone still running, joins it and is the only one sent', async () => {
  const { chat, key } = await runnerChat();
  const clone = gate();
  box.cloneGate = clone.promise;
  pipeline.sendChat(key, chat.id, 'mensaje-detenido');
  await until(() => box.events.includes('clone'));
  await pipeline.interruptChat(key, chat.id);
  pipeline.sendChat(key, chat.id, 'reenvio');
  assert.equal(chat.busy, true);

  clone.open();
  await until(() => !chat.busy && sent.length === 1);
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(times(sent[0].prompt, 'reenvio'), 1);
  assert.equal(times(sent[0].prompt, 'mensaje-detenido'), 0);
  assert.equal(box.events.filter((e) => e === 'clone').length, 1);
});

test('a clone that fails after Stop says nothing in the chat and retries nothing', async () => {
  const { holder, chat, key } = await runnerChat();
  const clone = gate();
  box.cloneGate = clone.promise;
  box.cloneError = 'network is down';
  pipeline.sendChat(key, chat.id, 'mensaje-detenido');
  await until(() => box.events.includes('clone'));
  pipeline.sendChat(key, chat.id, 'nota-pendiente');
  await pipeline.interruptChat(key, chat.id);

  clone.open();
  await until(() => logOf(holder, 'chat').some((l) => /stopped turn .*network is down/.test(l)));
  await settle();
  assert.equal(said(chat, /Could not prepare/).length, 0);
  assert.equal(box.events.filter((e) => e === 'clone').length, 1);
  assert.equal(sent.length, 0);
  assert.equal(chat.busy, false);
  assert.equal(chat.notes.length, 1);
});

test('Stop after the notes were taken for the prompt, just before the send: they are put back', async () => {
  const { chat, key } = await runnerChat();
  const clone = gate();
  box.cloneGate = clone.promise;
  pipeline.sendChat(key, chat.id, 'primero');
  await until(() => box.events.includes('clone'));
  pipeline.sendChat(key, chat.id, 'nota-pendiente');
  await pipeline.interruptChat(key, chat.id);
  clone.open();
  await settle();

  // A conversation with a session already: no refresh runs, so the first read
  // of HEAD is the one right before the send.
  chat.sessionId = 'sess-previa';
  const head = gate();
  box.headGate = head.promise;
  pipeline.sendChat(key, chat.id, 'mensaje-detenido');
  await until(() => box.headHeld);
  assert.equal(chat.notes.length, 0, 'the turn has taken the note');
  await pipeline.interruptChat(key, chat.id);
  assert.equal(chat.notes.length, 1);
  box.headGate = null;
  head.open();
  await settle();
  assert.equal(sent.length, 0);
  assert.equal(chat.busy, false);

  pipeline.sendChat(key, chat.id, 'siguiente');
  await until(() => !chat.busy && sent.length === 1);
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(times(sent[0].prompt, 'nota-pendiente'), 1);
  assert.equal(times(sent[0].prompt, 'mensaje-detenido'), 0);
});

test('the shared worktree is refreshed once at a time: a second call joins the one in flight', async () => {
  const { holder, chat, key } = await runnerChat();
  pipeline.sendChat(key, chat.id, 'hola');
  await until(() => !chat.busy && sent.length === 1);
  const [first, second] = await Promise.all([
    projectchats.refreshHolderWorktree(holder),
    projectchats.refreshHolderWorktree(holder),
  ]);
  assert.equal(second, first);
  assert.notEqual(await projectchats.refreshHolderWorktree(holder), first);
});
