import './isolate.mjs';
// The chat owner: a chat belongs to a task or to a project «holder», and every
// chat entry point resolves either from one key. The pipeline is driven for
// real; the three things a holder turn needs from outside (the worktree, the
// refresh, the session) go through seams so nothing is cloned or spawned.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tempDir } from './teardown.mjs';

process.env.HFSMON_NO_AUTOSTART = '1';

let pipeline;
let store;
let projectchats;
let ChatSession;
let chats;
const realSend = {};
const sent = [];   // what the fake session was asked: { cwd, prompt }

before(async () => {
  pipeline = await import('../src/pipeline.js');
  ({ store } = await import('../src/store.js'));
  projectchats = await import('../src/projectchats.js');
  chats = await import('../src/chats.js');
  ({ ChatSession } = await import('../src/session.js'));
  realSend.send = ChatSession.prototype.send;
  realSend.retune = ChatSession.prototype.retune;
  ChatSession.prototype.retune = async function retune() { return { reopened: false }; };
  ChatSession.prototype.send = async function send(prompt) {
    sent.push({ cwd: this.cwd, prompt });
    return { ok: true, sessionId: `sess-${sent.length}`, toolCounts: {}, resultText: '' };
  };
});

after(() => {
  ChatSession.prototype.send = realSend.send;
  ChatSession.prototype.retune = realSend.retune;
});

let n = 9500;
function freshTask() {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  task.worktreePath = tempDir(`hfsmon-co-${n}-`);
  return task;
}

const holder = () => projectchats.getHolder('hfs', 'local');
const holderKeyStr = () => projectchats.holderKey('hfs', 'local');

/** A real one-commit git repo: the holder's worktree stand-in. */
function gitRepo() {
  const dir = tempDir('hfsmon-co-git-');
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(path.join(dir, 'a.txt'), 'a');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'one');
  return dir;
}

/** Waits until `ok()` is true; a turn runs fire-and-forget. */
async function until(ok, ms = 3000) {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for the turn');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('chatOwnerOf resuelve una tarea y un holder desde su clave', () => {
  const task = freshTask();
  assert.equal(pipeline.chatOwnerOf(`hfs#${task.issue}`), task);
  assert.equal(pipeline.chatOwnerOf(task.issue), task);          // the bare number still works
  const h = holder();
  assert.equal(h.kind, 'project');
  assert.equal(pipeline.chatOwnerOf(holderKeyStr()), h);
  assert.equal(pipeline.chatOwnerOf('hfs@no-such-machine') ?? null, null);
});

test('ownerKeyOf: claves distintas para tarea y holder, así que las sesiones vivas no se cruzan', () => {
  const task = freshTask();
  const h = holder();
  assert.equal(pipeline.ownerKeyOf(task), `hfs#${task.issue}`);
  assert.equal(pipeline.ownerKeyOf(h), 'hfs@local');
  assert.notEqual(pipeline.ownerKeyOf(task), pipeline.ownerKeyOf(h));

  const a = pipeline.liveEntryOf(task, task.chats[0]);
  const b = pipeline.liveEntryOf(h, h.chats[0]);
  assert.notEqual(a, b);
  assert.equal(pipeline.liveEntryOf(h, h.chats[0]), b);          // same owner, same chat: the same entry
  // And closing the holder's session by its key touches nothing of the task's.
  pipeline.closeLiveSession(holderKeyStr(), h.chats[0].id);
  assert.equal(pipeline.liveEntryOf(task, task.chats[0]), a);
});

test('los puntos de entrada del chat aceptan la clave de un holder', () => {
  const h = holder();
  const created = pipeline.createChat(holderKeyStr());
  assert.ok(h.chats.includes(created));
  assert.equal(created.title, 'Untitled');
  pipeline.closeChat(holderKeyStr(), created.id);
  assert.ok(created.closedAt);
  pipeline.reopenChat(holderKeyStr(), created.id);
  assert.equal(created.closedAt, null);
  pipeline.closeChat(holderKeyStr(), created.id);
  pipeline.deleteChat(holderKeyStr(), created.id);
  assert.ok(!h.chats.includes(created));
  assert.throws(() => pipeline.closeChat(holderKeyStr(), h.chats[0].id), /principal/);
  assert.throws(() => pipeline.createChat('hfs@nope'), /desconocido/);
});

test('renameChat: recorta, une espacios, marca titleManual y rechaza lo vacío', () => {
  const task = freshTask();
  const chat = task.chats[0];
  assert.equal(chat.titleManual, false);
  const r = pipeline.renameChat(`hfs#${task.issue}`, chat.id, '   Mi   chat\n  de   prueba ');
  assert.deepEqual(r, { id: chat.id, title: 'Mi chat de prueba' });
  assert.equal(chat.title, 'Mi chat de prueba');
  assert.equal(chat.titleManual, true);
  assert.throws(() => pipeline.renameChat(`hfs#${task.issue}`, chat.id, '  \n '), /The title cannot be empty/);
  assert.equal(chat.title, 'Mi chat de prueba');
  assert.equal(pipeline.renameChat(`hfs#${task.issue}`, chat.id, 'x'.repeat(200)).title.length, 80);

  const h = holder();
  const other = chats.addChatTo(h, {});
  assert.deepEqual(pipeline.renameChat(holderKeyStr(), other.id, 'Investigación'), { id: other.id, title: 'Investigación' });
  assert.equal(other.titleManual, true);
});

test('titleManual: el primer prompt no pisa un título puesto a mano; sin él, sí lo pone', async () => {
  const h = holder();
  h.worktreePath = gitRepo();
  const prevEnsure = pipeline.chatOwnerHooks.ensure;
  const prevRefresh = pipeline.chatOwnerHooks.refresh;
  pipeline.chatOwnerHooks.ensure = async () => h.worktreePath;
  pipeline.chatOwnerHooks.refresh = async () => ({ moved: false, note: null, head: null });
  try {
    const named = chats.addChatTo(h, { title: 'Sin título' });
    pipeline.renameChat(holderKeyStr(), named.id, 'Mi nombre');
    pipeline.sendChat(holderKeyStr(), named.id, 'Primera pregunta larga');
    await until(() => !named.busy && named.sessionId);
    assert.equal(named.title, 'Mi nombre');

    const auto = chats.addChatTo(h, { title: 'Sin título' });
    pipeline.sendChat(holderKeyStr(), auto.id, 'Primera pregunta larga');
    await until(() => !auto.busy && auto.sessionId);
    assert.equal(auto.title, 'Primera pregunta larga');
  } finally {
    pipeline.chatOwnerHooks.ensure = prevEnsure;
    pipeline.chatOwnerHooks.refresh = prevRefresh;
  }
});

test('chatTranscriptOf: user y assistant como «rol: texto»; al pasarse de maxChars conserva lo más nuevo', () => {
  const task = freshTask();
  const chat = task.chats[0];
  const key = `hfs#${task.issue}`;
  store.addChat(task, chat.id, 'user', 'hola');
  store.addChat(task, chat.id, 'assistant', 'qué tal');
  store.pushChat(task, chat, { role: 'activity', items: [] });
  store.addChat(task, chat.id, 'user', 'FIN');
  assert.equal(pipeline.chatTranscriptOf(key, chat.id), 'user: hola\n\nassistant: qué tal\n\nuser: FIN');

  const long = 'x'.repeat(500);
  store.addChat(task, chat.id, 'assistant', `${long}FINAL`);
  const cut = pipeline.chatTranscriptOf(key, chat.id, { maxChars: 100 });
  assert.equal(cut.length, 100);
  assert.ok(cut.endsWith('xFINAL'));
  assert.match(cut, /^\[…earlier messages omitted\]/);
  assert.ok(!cut.includes('hola'));
  assert.throws(() => pipeline.chatTranscriptOf('hfs#999999', null), /Unknown task/);
});

test('un turno de holder: ensure primero, sesión con ese cwd, prompt de proyecto y head registrado', async () => {
  const h = holder();
  h.worktreePath = null;
  h.head = null;
  const repo = gitRepo();
  const order = [];
  const prevEnsure = pipeline.chatOwnerHooks.ensure;
  const prevRefresh = pipeline.chatOwnerHooks.refresh;
  pipeline.chatOwnerHooks.ensure = async (hh) => { order.push('ensure'); hh.worktreePath = repo; return repo; };
  pipeline.chatOwnerHooks.refresh = async () => { order.push('refresh'); return { moved: false, note: null, head: null }; };
  try {
    const chat = chats.addChatTo(h, {});
    sent.length = 0;
    pipeline.sendChat(holderKeyStr(), chat.id, '¿qué hay aquí?');
    // `busy` drops before the turn's bookkeeping (the head read) finishes, so wait for the head too.
    await until(() => !chat.busy && chat.sessionId && h.head);
    // First creation of the worktree: nothing to refresh yet.
    assert.deepEqual(order, ['ensure']);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].cwd, repo);                        // the session was born after ensure
    assert.match(sent[0].prompt, /¿qué hay aquí\?/);
    assert.match(sent[0].prompt, /chat del proyecto hfs/);  // chat-project-rules, not chat-rules
    assert.match(sent[0].prompt, /origin\/main|origin\/\S+/);
    assert.equal(h.head.branch !== undefined, true);
    assert.match(h.head.sha, /^[0-9a-f]{7}$/);

    // A second, brand-new conversation: the worktree exists, so it is refreshed first.
    order.length = 0;
    const second = chats.addChatTo(h, {});
    pipeline.sendChat(holderKeyStr(), second.id, 'otra');
    await until(() => !second.busy && second.sessionId);
    assert.deepEqual(order, ['ensure', 'refresh']);

    // A later turn of an existing conversation does not refresh.
    order.length = 0;
    pipeline.sendChat(holderKeyStr(), second.id, 'sigue');
    await until(() => !second.busy && sent.length === 3);
    assert.deepEqual(order, ['ensure']);
  } finally {
    pipeline.chatOwnerHooks.ensure = prevEnsure;
    pipeline.chatOwnerHooks.refresh = prevRefresh;
  }
});

test('refresh: la nota del worktree entra como mensaje del asistente antes del turno', async () => {
  const h = holder();
  h.worktreePath = gitRepo();
  const prevEnsure = pipeline.chatOwnerHooks.ensure;
  const prevRefresh = pipeline.chatOwnerHooks.refresh;
  pipeline.chatOwnerHooks.ensure = async () => h.worktreePath;
  pipeline.chatOwnerHooks.refresh = async () => ({ moved: false, note: 'Estás en la rama feat/x: no he movido nada.', head: { branch: 'feat/x', sha: 'abc1234' } });
  try {
    const chat = chats.addChatTo(h, {});
    pipeline.sendChat(holderKeyStr(), chat.id, 'hola');
    await until(() => !chat.busy && chat.sessionId);
    const note = chat.messages.find((m) => m.text === 'Estás en la rama feat/x: no he movido nada.');
    assert.ok(note);
    assert.equal(note.role, 'assistant');
    assert.ok(chat.messages.indexOf(note) > chat.messages.findIndex((m) => m.role === 'user'));
  } finally {
    pipeline.chatOwnerHooks.ensure = prevEnsure;
    pipeline.chatOwnerHooks.refresh = prevRefresh;
  }
});

test('refresh se salta con nota cuando otra conversación del holder está trabajando', async () => {
  const h = holder();
  h.worktreePath = gitRepo();
  const prevEnsure = pipeline.chatOwnerHooks.ensure;
  const prevRefresh = pipeline.chatOwnerHooks.refresh;
  let refreshed = 0;
  pipeline.chatOwnerHooks.ensure = async () => h.worktreePath;
  pipeline.chatOwnerHooks.refresh = async () => { refreshed += 1; return { moved: true, note: null, head: null }; };
  const busy = chats.addChatTo(h, {});
  busy.busy = true;
  try {
    const chat = chats.addChatTo(h, {});
    pipeline.sendChat(holderKeyStr(), chat.id, 'hola');
    await until(() => !chat.busy && chat.sessionId);
    assert.equal(refreshed, 0);
    assert.ok(chat.messages.some((m) => m.role === 'assistant' && /otra conversación trabajando/.test(m.text)));
  } finally {
    busy.busy = false;
    pipeline.chatOwnerHooks.ensure = prevEnsure;
    pipeline.chatOwnerHooks.refresh = prevRefresh;
  }
});

test('si ensure falla, el turno no arranca y el chat queda libre con el motivo', async () => {
  const h = holder();
  const prevEnsure = pipeline.chatOwnerHooks.ensure;
  pipeline.chatOwnerHooks.ensure = async () => { throw new Error('sin red'); };
  try {
    const chat = chats.addChatTo(h, {});
    sent.length = 0;
    pipeline.sendChat(holderKeyStr(), chat.id, 'hola');
    await until(() => chat.messages.some((m) => /sin red/.test(m.text ?? '')));
    assert.equal(chat.busy, false);
    assert.equal(sent.length, 0);
  } finally {
    pipeline.chatOwnerHooks.ensure = prevEnsure;
  }
});

test('the checkout step reports to the holder log, names the clone as the activity and posts the push warning', async () => {
  const h = holder();
  h.worktreePath = gitRepo();
  const prevEnsure = pipeline.chatOwnerHooks.ensure;
  const prevRefresh = pipeline.chatOwnerHooks.refresh;
  let release;
  const gate = new Promise((r) => { release = r; });
  pipeline.chatOwnerHooks.ensure = async (owner, { onLine, onWarning }) => {
    onLine('cloning o/hfs into /home/zoe/src/hfs on devbox');
    await gate;
    onWarning('⚠️ branches cannot be pushed from devbox.');
    return owner.worktreePath;
  };
  pipeline.chatOwnerHooks.refresh = async () => ({ moved: false, note: null, head: null });
  try {
    const chat = chats.addChatTo(h, {});
    sent.length = 0;
    pipeline.sendChat(holderKeyStr(), chat.id, 'hola');
    await until(() => h.log?.some((l) => l.phase === 'chat' && /^cloning o\/hfs into /.test(l.line)));
    assert.match(chat.activity, /^cloning .+ on local…$/);
    release();
    await until(() => !chat.busy && sent.length === 1);
    assert.ok(chat.messages.some((m) => /cannot be pushed from devbox/.test(m.text ?? '')));
    assert.ok(h.log.some((l) => /cannot be pushed from devbox/.test(l.line)));
  } finally {
    release();
    pipeline.chatOwnerHooks.ensure = prevEnsure;
    pipeline.chatOwnerHooks.refresh = prevRefresh;
  }
});

test('un segundo mensaje mientras el holder prepara el worktree se encola como nota, no abre otro turno', async () => {
  const h = holder();
  h.worktreePath = gitRepo();
  const prevEnsure = pipeline.chatOwnerHooks.ensure;
  const prevRefresh = pipeline.chatOwnerHooks.refresh;
  let release;
  const gate = new Promise((r) => { release = r; });
  pipeline.chatOwnerHooks.ensure = async () => { await gate; return h.worktreePath; };
  // Without this stub the turn runs about six real `git` processes inside the
  // 3 s wait below; under load (another suite running) that window is too tight.
  pipeline.chatOwnerHooks.refresh = async () => ({ moved: false, note: null, head: null });
  try {
    const chat = chats.addChatTo(h, { title: 'Sin título' });
    sent.length = 0;
    pipeline.sendChat(holderKeyStr(), chat.id, 'primera');
    await until(() => chat.busy);
    pipeline.sendChat(holderKeyStr(), chat.id, 'segunda');
    assert.equal(chat.notes.length, 1);                      // queued, not a concurrent turn
    assert.equal(chat.notes[0].text, 'segunda');
    release();
    await until(() => sent.length >= 1 && !chat.busy && chat.sessionId);
    // One turn, never two at once: the note rode at the front of the prompt the
    // first turn was about to send (`withNotes` drains it after the preparation).
    assert.equal(sent.length, 1);
    assert.match(sent[0].prompt, /segunda/);
    assert.match(sent[0].prompt, /primera/);
    assert.equal(chat.notes.length, 0);
    assert.ok(!chat.messages.some((m) => /ya está contestando|No se pudo abrir/.test(m.text ?? '')));
  } finally {
    release();
    pipeline.chatOwnerHooks.ensure = prevEnsure;
    pipeline.chatOwnerHooks.refresh = prevRefresh;
  }
});

test('refresh se salta si otra conversación tiene un comando en segundo plano', async () => {
  const h = holder();
  h.worktreePath = gitRepo();
  const prevEnsure = pipeline.chatOwnerHooks.ensure;
  const prevRefresh = pipeline.chatOwnerHooks.refresh;
  let refreshed = 0;
  pipeline.chatOwnerHooks.ensure = async () => h.worktreePath;
  pipeline.chatOwnerHooks.refresh = async () => { refreshed += 1; return { moved: true, note: null, head: null }; };
  const other = chats.addChatTo(h, {});
  other.messages.push({
    id: 'm-bg', role: 'activity',
    items: [{ id: 't1', kind: 'bash', background: true, status: 'running', command: 'cargo build', startedAt: new Date().toISOString() }],
  });
  assert.ok(chats.chatRunning(other));
  try {
    const chat = chats.addChatTo(h, {});
    pipeline.sendChat(holderKeyStr(), chat.id, 'hola');
    await until(() => !chat.busy && chat.sessionId);
    assert.equal(refreshed, 0);
    assert.ok(chat.messages.some((m) => m.role === 'assistant' && /otra conversación trabajando/.test(m.text)));
  } finally {
    other.messages.length = 0;
    pipeline.chatOwnerHooks.ensure = prevEnsure;
    pipeline.chatOwnerHooks.refresh = prevRefresh;
  }
});

test('si ensure falla con notas en cola, se reintentan una sola vez y no se pierden', async () => {
  const h = holder();
  const prevEnsure = pipeline.chatOwnerHooks.ensure;
  let calls = 0;
  pipeline.chatOwnerHooks.ensure = async () => { calls += 1; throw new Error('sin red'); };
  try {
    const chat = chats.addChatTo(h, {});
    chats.leaveNote(chat, 'una nota', 'm-x');
    pipeline.sendChat(holderKeyStr(), chat.id, 'hola');
    await until(() => calls >= 2);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls, 2);                                  // one retry, no loop
    assert.equal(chat.busy, false);
    assert.equal(chat.notes.length, 1);                      // still waiting for the next prompt
  } finally {
    pipeline.chatOwnerHooks.ensure = prevEnsure;
  }
});

test('si abrir la sesión lanza antes del try, el chat no se queda ocupado y el siguiente mensaje corre', async () => {
  const h = holder();
  h.worktreePath = gitRepo();
  const prevEnsure = pipeline.chatOwnerHooks.ensure;
  const prevRefresh = pipeline.chatOwnerHooks.refresh;
  pipeline.chatOwnerHooks.refresh = async () => ({ moved: false, note: null, head: null });
  // The machine vanishes while the worktree is being prepared: `liveOf` then throws in `machineOf`.
  pipeline.chatOwnerHooks.ensure = async () => { h.machine = 'maquina-que-ya-no-existe'; return h.worktreePath; };
  const chat = chats.addChatTo(h, { title: 'Sin título' });
  try {
    sent.length = 0;
    pipeline.sendChat(holderKeyStr(), chat.id, 'hola');
    await until(() => chat.messages.some((m) => /Could not open the session/.test(m.text ?? '')));
    h.machine = 'local';
    assert.equal(chat.busy, false);
    assert.equal(chat.activity, null);
    assert.equal(sent.length, 0);

    // Not stuck «starting»: the next message is a turn, not a parked note.
    pipeline.chatOwnerHooks.ensure = async () => h.worktreePath;
    pipeline.sendChat(holderKeyStr(), chat.id, 'otra vez');
    assert.equal(chat.notes.length, 0);
    await until(() => sent.length === 1 && !chat.busy && chat.sessionId);
    assert.match(sent[0].prompt, /otra vez/);
  } finally {
    h.machine = 'local';
    pipeline.chatOwnerHooks.ensure = prevEnsure;
    pipeline.chatOwnerHooks.refresh = prevRefresh;
  }
});

test('noteClosableOf no hace nada en un holder', () => {
  const h = holder();
  const text = 'listo\nCLOSABLE: {"reason":"completed","why":"nada que cambiar","duplicateOf":null}';
  assert.equal(pipeline.noteClosableOf(h, h.chats[0], text), null);
  assert.equal(h.closable, undefined);
});

test('makeChat y migrateChat dan titleManual: false', () => {
  assert.equal(chats.makeChat().titleManual, false);
  const old = { id: 'c1', messages: [] };
  assert.equal(chats.migrateChat(old).titleManual, false);
  const kept = { id: 'c2', titleManual: true, messages: [] };
  assert.equal(chats.migrateChat(kept).titleManual, true);
});

