import './isolate.mjs';
// Emptying a chat (`clearChat`, `/clear`) and the slash commands typed in one,
// driven through the real pipeline. The session is a stand-in (`send` and
// `commands` on the prototype), so nothing is spawned; the persistence check
// boots fresh processes on a data directory of its own.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './teardown.mjs';

process.env.HFSMON_NO_AUTOSTART = '1';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let pipeline;
let store;
let projectchats;
let chats;
let ChatSession;
const real = {};
const sent = [];   // the prompts the stand-in session was given
let reply = null;  // (prompt, session) => result; the default answers with text

const SDK_LIST = [
  { name: 'compact', description: 'Free up context', argumentHint: '', builtin: true },
  { name: 'context', description: 'Show context usage', argumentHint: '', builtin: true },
  { name: 'effort', description: 'Set effort', argumentHint: '', builtin: true },
  { name: 'review', description: 'A project command', argumentHint: '' },
];

before(async () => {
  pipeline = await import('../src/pipeline.js');
  ({ store } = await import('../src/store.js'));
  projectchats = await import('../src/projectchats.js');
  chats = await import('../src/chats.js');
  ({ ChatSession } = await import('../src/session.js'));
  for (const k of ['send', 'retune', 'commands', 'close']) real[k] = ChatSession.prototype[k];
  ChatSession.prototype.retune = async function retune() { return { reopened: false }; };
  ChatSession.prototype.commands = async function commands() { return SDK_LIST; };
  ChatSession.prototype.send = async function send(prompt) {
    sent.push(prompt);
    if (reply) return reply(prompt, this);
    return { ok: true, sessionId: `sess-${sent.length}`, toolCounts: {}, resultText: '' };
  };
});

after(() => {
  for (const [k, fn] of Object.entries(real)) ChatSession.prototype[k] = fn;
  store.flush();
});

let n = 9700;
function freshTask() {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  task.state = 'assigned';
  return task;
}
const holder = () => projectchats.getHolder('hfs', 'local');
const HK = () => projectchats.holderKey('hfs', 'local');

function gitRepo() {
  const dir = tempDir('hfsmon-clear-git-');
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(path.join(dir, 'a.txt'), 'a');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'one');
  return dir;
}

async function until(ok, ms = 3000) {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error(`timeout: ${until.debug?.() ?? ''}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A holder whose worktree exists and needs no refresh: turns run straight away. */
function withReadyHolder(fn) {
  return async () => {
    const h = holder();
    h.worktreePath = gitRepo();
    h.head = null;
    const prev = { ensure: pipeline.chatOwnerHooks.ensure, refresh: pipeline.chatOwnerHooks.refresh };
    pipeline.chatOwnerHooks.ensure = async () => h.worktreePath;
    pipeline.chatOwnerHooks.refresh = async () => ({ moved: false, note: null, head: null });
    try {
      await fn(h);
    } finally {
      Object.assign(pipeline.chatOwnerHooks, prev);
      reply = null;
    }
  };
}

/**
 * A turn is over for `sendChat` only once its bookkeeping is done (the head
 * read, then `starting` cleared), a moment after `busy` drops: a command sent
 * in between is told the chat is working.
 */
async function turnDone(h, chat, ok = () => true) {
  await until(() => !chat.busy && h.head && ok());
  await new Promise((r) => setTimeout(r, 30));
  h.head = null;
}

const texts = (chat) => chat.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => m.text);

/* -------------------------------------------------------------- clearChat */

test('clearChat empties the messages and lets the session go; keeps what the chat is', () => {
  const task = freshTask();
  const key = `hfs#${task.issue}`;
  const chat = pipeline.createChat(key);
  chat.title = 'branch of Main';
  chat.model = 'sonnet';
  chat.effort = 'high';
  chat.sessionId = 'sess-x';
  chat.forkPending = true;
  chat.forkedFrom = task.chats[0].id;
  chat.notes = [{ text: 'n', messageId: 'm' }];
  chat.news = ['x'];
  chat.planMode = true;
  chat.handoff = { from: 'a' };
  chat.lastTurnAt = '2026-01-01T00:00:00.000Z';
  chat.lastSeenSha = 'abc';
  task.closable = { chatId: chat.id, reason: 'x' };
  const messages = chat.messages;
  store.addChat(task, chat.id, 'user', 'hola');
  store.addChat(task, chat.id, 'assistant', 'qué tal');
  const { id, createdAt } = chat;
  const seen = [];
  const on = (...args) => seen.push(args);
  store.on('chat-reset', on);
  try {
    assert.deepEqual(pipeline.clearChat(key, chat.id), { cleared: true, messages: 2 });
  } finally {
    store.off('chat-reset', on);
  }
  assert.equal(chat.messages, messages, 'the same array, emptied in place');
  assert.equal(chat.messages.length, 0);
  assert.equal(chat.sessionId, null);
  assert.equal(chat.forkPending, false);
  assert.equal(chat.forkedFrom, null);
  assert.deepEqual(chat.notes, []);
  assert.deepEqual(chat.news, []);
  assert.equal(chat.planMode, false);
  assert.equal(chat.handoff, null);
  assert.equal(chat.lastTurnAt, null);
  assert.equal(task.closable, null);
  assert.equal(chat.title, 'Untitled');
  assert.equal(chat.id, id);
  assert.equal(chat.createdAt, createdAt);
  assert.equal(chat.model, 'sonnet');
  assert.equal(chat.effort, 'high');
  assert.equal(chat.lastSeenSha, 'abc');
  assert.deepEqual(seen, [[task.issue, chat.id, { messages: 0 }, 'hfs']]);
  assert.match(task.log.at(-1).line, /emptied \(2 messages\)/);
});

test('clearChat keeps the Main\'s name and a name typed by hand', () => {
  const task = freshTask();
  const key = `hfs#${task.issue}`;
  const main = task.chats[0];
  store.addChat(task, main.id, 'user', 'x');
  pipeline.clearChat(key, main.id);
  assert.equal(main.title, 'Main');
  const named = pipeline.createChat(key);
  pipeline.renameChat(key, named.id, 'Mi idea');
  pipeline.clearChat(key, named.id);
  assert.equal(named.title, 'Mi idea');
});

test('clearChat refuses a chat that is working, waiting, closed, or a task Main the pipeline uses', () => {
  const task = freshTask();
  const key = `hfs#${task.issue}`;
  const chat = pipeline.createChat(key);
  store.addChat(task, chat.id, 'user', 'x');
  chat.busy = true;
  assert.throws(() => pipeline.clearChat(key, chat.id), (e) => e.status === 400 && /working; stop it before emptying it/.test(e.message));
  chat.busy = false;
  chat.plan = { status: 'running' };
  assert.throws(() => pipeline.clearChat(key, chat.id), /working/);
  chat.plan = null;
  chat.pending = { id: 'q', kind: 'question', source: 'claude' };
  assert.throws(() => pipeline.clearChat(key, chat.id), /waiting for an answer/);
  chat.pending = null;
  pipeline.closeChat(key, chat.id);
  assert.throws(() => pipeline.clearChat(key, chat.id), /closed/);
  assert.equal(chat.messages.length, 1, 'nothing was emptied');
  assert.throws(() => pipeline.clearChat(key, 'nope'), /does not exist/);
  assert.throws(() => pipeline.clearChat('hfs#999998', chat.id), /Unknown task/);

  const main = task.chats[0];
  store.addChat(task, main.id, 'user', 'x');
  for (const [field, value] of [['state', 'fixing'], ['pending', { kind: 'plan' }], ['planning', { messageId: 'm' }]]) {
    const was = task[field];
    task[field] = value;
    assert.throws(() => pipeline.clearChat(key, main.id), /main chat/, field);
    task[field] = was;
  }
  assert.equal(main.messages.length, 1);
  // An extra chat of the same busy task is not the phases' business.
  task.state = 'fixing';
  const extra = pipeline.createChat(key);
  store.addChat(task, extra.id, 'user', 'x');
  assert.equal(pipeline.clearChat(key, extra.id).messages, 1);
  task.state = 'assigned';
});

test('a holder\'s Main can be emptied: no phase resumes it', () => {
  const h = holder();
  const main = h.chats[0];
  store.addChat(h, main.id, 'user', 'hola');
  main.sessionId = 'sess-h';
  const seen = [];
  const on = (...args) => seen.push(args);
  store.on('chat-reset', on);
  try {
    pipeline.clearChat(HK(), main.id);
  } finally {
    store.off('chat-reset', on);
  }
  assert.equal(main.messages.length, 0);
  assert.equal(main.sessionId, null);
  assert.deepEqual(seen, [[null, main.id, { messages: 0 }, 'hfs', { owner: 'project', machine: 'local' }]]);
});

/* ---------------------------------------------------------- slash commands */

test('/clear typed in a chat empties it without a session; refused while it works', withReadyHolder(async (h) => {
  const chat = chats.addChatTo(h, { title: 'Untitled' });
  store.addChat(h, chat.id, 'user', 'algo');
  sent.length = 0;
  pipeline.sendChat(HK(), chat.id, '/clear');
  assert.equal(chat.messages.length, 0);
  assert.equal(sent.length, 0);
  chat.busy = true;
  pipeline.sendChat(HK(), chat.id, '/reset');
  assert.deepEqual(texts(chat), ['/reset', '⚠️ That chat is working; stop it before emptying it']);
  chat.busy = false;
}));

test('/model, /plan and /help are the board\'s: no session and no title', withReadyHolder(async (h) => {
  const chat = chats.addChatTo(h, { title: 'Untitled' });
  sent.length = 0;
  pipeline.sendChat(HK(), chat.id, '/help');
  pipeline.sendChat(HK(), chat.id, '/plan');
  pipeline.sendChat(HK(), chat.id, '/model');
  assert.equal(sent.length, 0);
  assert.equal(chat.title, 'Untitled', 'a command does not name the chat');
  const said = texts(chat);
  assert.match(said[1], /Commands the board answers itself/);
  assert.match(said[3], /Plan mode: off/);
  assert.match(said[5], /Current model/);
}));

test('a refused command is answered without a session', withReadyHolder(async (h) => {
  const chat = chats.addChatTo(h, { title: 'Untitled' });
  sent.length = 0;
  pipeline.sendChat(HK(), chat.id, '/effort high');
  assert.equal(sent.length, 0);
  assert.match(texts(chat)[1], /\/effort is not run from the chat: use the board's control/);
}));

test('a CLI command goes as typed, alone, and says it ran when the CLI said nothing', withReadyHolder(async (h) => {
  const chat = chats.addChatTo(h, { title: 'Untitled' });
  chat.notes = [];
  sent.length = 0;
  reply = (prompt, session) => {
    session.onEvent?.({ kind: 'compact', trigger: 'manual', preTokens: 52000, postTokens: 8100 });
    return { ok: true, sessionId: 'sess-c', toolCounts: {}, resultText: '' };
  };
  pipeline.sendChat(HK(), chat.id, '/compact keep the tests');
  await turnDone(h, chat, () => sent.length === 1 && texts(chat).length === 2);
  assert.equal(sent[0], '/compact keep the tests', 'no rules template, no voice rule');
  assert.equal(texts(chat)[1], '✓ /compact done (context 52k → 8k tokens)');
  assert.equal(chat.title, 'Untitled');

  // Output in the result text (as /context gives it) becomes the bubble.
  reply = () => ({ ok: true, sessionId: 'sess-c', toolCounts: {}, resultText: '## Context Usage' });
  pipeline.sendChat(HK(), chat.id, '/context');
  await turnDone(h, chat, () => sent.length === 2 && texts(chat).length === 4);
  assert.equal(texts(chat)[3], '## Context Usage');

  // A command that answered with text of its own gets no extra line.
  reply = (prompt, session) => {
    session.onEvent?.({ kind: 'text', text: 'Reviewed.' });
    return { ok: true, sessionId: 'sess-c', toolCounts: {}, resultText: 'Reviewed.' };
  };
  pipeline.sendChat(HK(), chat.id, '/review');
  await turnDone(h, chat, () => sent.length === 3 && texts(chat).length === 6);
  assert.equal(sent[2], '/review');
  assert.deepEqual(texts(chat).slice(4), ['/review', 'Reviewed.']);
}));

test('an unknown command never reaches the model; a path is conversation', withReadyHolder(async (h) => {
  const chat = chats.addChatTo(h, { title: 'Untitled' });
  sent.length = 0;
  pipeline.sendChat(HK(), chat.id, '/nosuch thing');
  await turnDone(h, chat, () => texts(chat).length === 2);
  assert.equal(sent.length, 0);
  assert.equal(texts(chat)[1], '⚠️ Unknown command /nosuch. Type / to see the list.');

  pipeline.sendChat(HK(), chat.id, '/src/app.js no compila');
  await until(() => !chat.busy && sent.length === 1);
  assert.match(sent[0], /\/src\/app\.js no compila/);
  assert.match(sent[0], /chat del proyecto hfs/, 'conversation goes with the rules');
}));

test('a command typed while the chat works is answered, not parked as a note', withReadyHolder(async (h) => {
  const chat = chats.addChatTo(h, { title: 'Untitled' });
  sent.length = 0;
  chat.plan = { status: 'running' };
  pipeline.sendChat(HK(), chat.id, '/compact');
  assert.deepEqual(chat.notes ?? [], []);
  assert.equal(texts(chat)[1], '⚠️ Commands cannot run while the chat is working; stop it or wait.');
  pipeline.sendChat(HK(), chat.id, 'texto normal');
  assert.equal(chat.notes.length, 1, 'plain text still waits as a note');
  chat.plan = null;
  chat.notes = [];
}));

test('chatCommands: the board\'s alone without a worktree; the merged list with a session', async () => {
  const task = freshTask();
  const partial = await pipeline.chatCommands(`hfs#${task.issue}`, task.chats[0].id);
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.commands.map((c) => c.source), ['board', 'board', 'board', 'board']);
  assert.equal(task.worktreePath ?? null, null, 'no worktree was built for the list');

  const h = holder();
  h.worktreePath = gitRepo();
  const chat = chats.addChatTo(h, { title: 'Untitled' });
  const full = await pipeline.chatCommands(HK(), chat.id);
  assert.equal(full.complete, true);
  const names = full.commands.map((c) => c.name);
  assert.deepEqual(names.slice(0, 4), ['clear', 'model', 'plan', 'help']);
  assert.ok(names.includes('compact') && names.includes('review'));
  assert.ok(!names.includes('effort'), 'refused ones are not offered');
  await assert.rejects(pipeline.chatCommands(HK(), 'nope'), /does not exist/);
});

/* ------------------------------------------------------------- persistence */

test('after clearChat and a flush, a fresh boot reads the task chat and the holder chat empty', () => {
  const dir = tempDir('hfsmon-clear-data-');
  const run = (phase) => spawnSync(process.execPath, [path.join(HERE, 'chat-clear-child.mjs'), phase], {
    env: { ...process.env, HFSMON_DATA_DIR: dir, HFSMON_NO_AUTOSTART: '1', HFSMON_PERSIST_DELAY_MS: '60000' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const out = (r) => JSON.parse(r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).at(-1));
  const w = run('write');
  assert.equal(w.status, 0, w.stderr);
  const before = out(w);
  assert.deepEqual(before.beforeClear, { task: 3, holder: 3 });
  const r = run('read');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(out(r), { task: 0, holder: 0, other: 1 });
});
