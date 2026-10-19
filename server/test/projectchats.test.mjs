import './isolate.mjs';
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { readTasksFileMerged } from '../src/splitfmt.js';
import { DATA_DIR } from './isolate.mjs';

const { store } = await import('../src/store.js');
const pc = await import('../src/projectchats.js');

const FILE = path.join(DATA_DIR, 'projectchats.json');
const onDisk = () => readTasksFileMerged(FILE, { key: (raw) => raw.holders });
after(() => store.flush());
beforeEach(() => pc._resetProjectChatsForTests());

/** Records every event a test cares about, and unhooks at the end. */
function listen(names) {
  const seen = [];
  const hooks = names.map((n) => {
    const fn = (...args) => seen.push([n, ...args]);
    store.on(n, fn);
    return [n, fn];
  });
  return { seen, stop: () => hooks.forEach(([n, fn]) => store.off(n, fn)) };
}

test('keys: holderKey, isHolderKey, parseHolderKey', () => {
  assert.equal(pc.holderKey('hfs', 'local'), 'hfs@local');
  assert.equal(pc.isHolderKey('hfs@local'), true);
  assert.equal(pc.isHolderKey('hfs#12'), false);
  assert.equal(pc.isHolderKey(12), false);
  assert.deepEqual(pc.parseHolderKey('hfs@runner-1'), { project: 'hfs', machine: 'runner-1' });
  assert.equal(pc.parseHolderKey('hfs#12'), null);
  assert.equal(pc.parseHolderKey('Bad@x'), null);
});

test('holderMachines: a registered project has machines, an unknown one none', () => {
  assert.ok(pc.holderMachines('hfs').includes('local'));
  assert.deepEqual(pc.holderMachines('no-such-project'), []);
  assert.deepEqual(pc.holderMachines(undefined), []);
});

test('getHolder creates a task-shaped holder with its principal chat and persists it', () => {
  const h = pc.getHolder('hfs', 'local');
  assert.equal(h.kind, 'project');
  assert.equal(h.issue, null);
  assert.equal(h.title, pc.HOLDER_TITLE);
  assert.equal(h.chats.length, 1);
  assert.equal(h.chats[0].title, 'Main');
  assert.equal(pc.getHolder('hfs', 'local'), h, 'same object on every ask');
  assert.equal(pc.getHolderByKey('hfs@local'), h);
  assert.equal(store.get('hfs@local'), undefined, 'never in the task store');

  pc.flushProjectChats();
  assert.equal(onDisk().version, 1);
  assert.equal(onDisk().holders['hfs@local'].kind, 'project');
});

test('getHolder throws for a machine or project that is not allowed; getHolderByKey says null', () => {
  assert.throws(() => pc.getHolder('hfs', 'nowhere'), /No project chat for/);
  assert.throws(() => pc.getHolder('nope', 'local'), /No project chat for/);
  assert.equal(pc.getHolderByKey('hfs@nowhere'), null);
  assert.equal(pc.getHolderByKey('hfs#3'), null);
  assert.equal(pc.getHolderByKey(null), null);
});

test('allHolders covers every registered project x machine', () => {
  const all = pc.allHolders();
  assert.ok(all.some((h) => h.project === 'hfs' && h.machine === 'local'));
  assert.ok(all.every((h) => h.kind === 'project'));
});

test('store: holder pushChat persists to projectchats, emits chat with the 6th arg, never task', () => {
  const h = pc.getHolder('hfs', 'local');
  const l = listen(['task', 'chat', 'chat-update', 'log', 'project-chat']);
  try {
    const chat = h.chats[0];
    const m = store.addChat(h, null, 'user', 'hola');
    store.updateChat(h, chat, m, { patch: { text: 'hola!' } });
    store.addLog(h, 'chat', 'una línea');

    assert.equal(l.seen.filter((e) => e[0] === 'task').length, 0, 'no task event for a holder');
    const chatEv = l.seen.find((e) => e[0] === 'chat');
    assert.deepEqual(chatEv.slice(1, 3), [null, chat.id]);
    assert.equal(chatEv[3], m);
    assert.equal(chatEv[4], 'hfs');
    assert.deepEqual(chatEv[5], { owner: 'project', machine: 'local' });
    const upd = l.seen.find((e) => e[0] === 'chat-update');
    assert.equal(upd[1], null);
    assert.deepEqual(upd[5], { owner: 'project', machine: 'local' });
    const log = l.seen.find((e) => e[0] === 'log');
    assert.equal(log[1], null);
    assert.equal(log[2].line, 'una línea');
    assert.deepEqual(log[4], { owner: 'project', machine: 'local' });
    const proj = l.seen.filter((e) => e[0] === 'project-chat');
    assert.ok(proj.length >= 1);
    assert.equal(proj[0][1], h, 'the raw holder travels');
  } finally { l.stop(); }

  store.flush(); // the registered flusher writes projectchats.json
  const saved = onDisk().holders['hfs@local'];
  assert.equal(saved.chats[0].messages.at(-1).text, 'hola!');
  assert.equal(saved.log.at(-1).line, 'una línea');
});

test('store: a task keeps its old event arity', () => {
  const l = listen(['chat', 'task']);
  try {
    const t = store.addTask({ number: 901, title: 't', labels: [], url: 'x', closed: false }, 'hfs');
    store.addChat(t, null, 'user', 'x');
    const chatEv = l.seen.find((e) => e[0] === 'chat');
    assert.equal(chatEv.length, 5, 'no sixth argument for tasks');
    assert.ok(l.seen.some((e) => e[0] === 'task'));
  } finally { l.stop(); }
});

test('loadProjectChats reads the file back, resets busy chats, and is idempotent', () => {
  const h = pc.getHolder('hfs', 'local');
  h.chats[0].busy = true;
  h.chats[0].messages.push({ id: 'mx', role: 'user', text: 'persist me', ts: new Date().toISOString() });
  pc.persistHolder(h);
  pc.flushProjectChats();
  assert.ok(existsSync(FILE));

  pc._resetProjectChatsForTests(); // as if the board had restarted
  pc.loadProjectChats();
  pc.loadProjectChats();
  const back = pc.getHolder('hfs', 'local');
  assert.notEqual(back, h);
  assert.equal(back.chats[0].busy, false, 'resetChatsOnBoot ran');
  assert.equal(back.chats[0].messages.at(-1).text, 'persist me');
  assert.equal(back.chats.length, 1);
});
