import './isolate.mjs';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { removeTreeReported } from './teardown.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

import { MAX_TABS, normalizeTabs, openTab, closeTab, pruneTabs } from '../src/chattabs.js';

/**
 * Project chat: the tab strip with `p:` entries (pure), and the routes, the
 * snapshot and the WebSocket against the real board. `index.js` listens as soon
 * as it is imported, so the routes are tested the way `routes.test.mjs` does:
 * in a process of its own, with its own config and data directory. Nothing here
 * starts a Claude session: only what answers without one.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const TAB = 'p:hfs@local';

/* ---------------------------------------------------------------- tabs */

const T = (issue, project = 'hfs') => ({ project, issue });

test('tabs: a project chat tab is a string entry, kept as such', () => {
  const tabs = openTab(openTab([], T(12), 1), TAB, 2);
  assert.deepEqual(tabs, [{ project: 'hfs', issue: 12, usedAt: 1 }, { issue: TAB, usedAt: 2 }]);
  assert.deepEqual(normalizeTabs([{ issue: TAB, usedAt: 5 }, { issue: TAB, usedAt: 6 }]), [{ issue: TAB, usedAt: 5 }], 'duplicates collapse');
});

test('tabs: reopening keeps its place; closing takes only that one', () => {
  let tabs = openTab(openTab(openTab([], TAB, 1), T(7), 2), T(8), 3);
  tabs = openTab(tabs, TAB, 9);
  assert.deepEqual(tabs.map((t) => t.issue), [TAB, 7, 8]);
  assert.equal(tabs[0].usedAt, 9);
  assert.deepEqual(closeTab(tabs, TAB).map((t) => t.issue), [7, 8]);
  assert.deepEqual(closeTab(tabs, 'p:hfs@otra').map((t) => t.issue), [TAB, 7, 8]);
});

test('tabs: the cap evicts the oldest and never the tab being opened', () => {
  let tabs = openTab([], TAB, 0);
  for (let i = 1; i < MAX_TABS; i += 1) tabs = openTab(tabs, T(i), 100 + i);
  tabs = openTab(tabs, T(99), 500);
  assert.equal(tabs.length, MAX_TABS);
  assert.ok(!tabs.some((t) => t.issue === TAB), 'the unused project tab is the oldest');
});

test('tabs: pruning keeps a project tab only while its holder is allowed', () => {
  const tabs = [{ issue: TAB, usedAt: 1 }, { issue: 'p:hfs@gone', usedAt: 2 }, { project: 'hfs', issue: 5, usedAt: 3 }];
  const known = (e) => (typeof e.issue === 'string' ? e.issue === TAB : e.issue === 5);
  assert.deepEqual(pruneTabs(tabs, known).map((t) => t.issue), [TAB, 5]);
});

test('tabs: strings that are not a holder tab stay refused', () => {
  for (const bad of ['937', 'p:HFS@local', 'p:hfs@', 'p:@local', 'x:hfs@local', 'p:hfs@lo cal', '']) {
    assert.throws(() => openTab([], bad), /positive integer/, bad);
    assert.throws(() => closeTab([], bad), /positive integer/, bad);
  }
  assert.deepEqual(normalizeTabs([{ issue: 'p:HFS@local', usedAt: 1 }, { issue: '12', usedAt: 2 }]), [{ issue: 12, usedAt: 2 }], 'a numeric string is still a task, with no project until sealed');
});

/* -------------------------------------------------------------- the board */

let dir;
let port;
let child;

const url = (p) => `http://127.0.0.1:${port}${p}`;

async function call(method, p, body) {
  const res = await fetch(url(p), {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port: p } = srv.address();
    srv.close(() => resolve(p));
  });
});

const H = '/api/projects/hfs/project-chats/local';

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'hfsmon-pchat-'));
  const dataDir = path.join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const hfsRepo = path.join(dir, 'hfs');
  mkdirSync(hfsRepo, { recursive: true });

  writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify({
    12: {
      issue: 12, title: 'hfs doce', labels: [], url: 'https://example.invalid/12', state: 'assigned',
      log: [{ ts: '2026-09-24T00:00:00.000Z', phase: 'estado', line: 'x' }], chats: [],
    },
  }));
  // A second project whose issue numbers hfs does not have: its tabs are the ones
  // the old bare-number strip lost whenever any tab was opened.
  const betaRepo = path.join(dir, 'beta');
  mkdirSync(betaRepo, { recursive: true });
  writeFileSync(path.join(dataDir, 'tasks.beta.json'), JSON.stringify({
    77: {
      issue: 77, title: 'beta setenta y siete', labels: [], url: 'https://example.invalid/77', state: 'assigned',
      log: [{ ts: '2026-09-24T00:00:00.000Z', phase: 'estado', line: 'x' }], chats: [],
    },
    12: {
      issue: 12, title: 'beta doce', labels: [], url: 'https://example.invalid/b12', state: 'assigned',
      log: [{ ts: '2026-09-24T00:00:00.000Z', phase: 'estado', line: 'x' }], chats: [],
    },
  }));
  writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([{
    id: 'hfs', name: 'hfs', repoPath: hfsRepo, worktreeRoot: `${hfsRepo}-wt`,
    repo: null, assignee: 'nobody', reviewer: 'nobody', overrides: {},
  }, {
    id: 'beta', name: 'beta', repoPath: betaRepo, worktreeRoot: `${betaRepo}-wt`,
    repo: null, assignee: 'nobody', reviewer: 'nobody', overrides: {},
  }]));
  // Tabs saved before projects existed: bare numbers. Boot seals them with the
  // project the board opens on (the first of the registry: hfs).
  writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    chatTabs: [{ issue: 12, usedAt: 1 }, { issue: 999, usedAt: 2 }],
  }));

  port = await freePort();
  const configFile = path.join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({
    port,
    github: { repo: 'nobody/nothing-at-all', assignee: 'nobody', reviewer: 'nobody' },
    poll: { intervalSeconds: 36000 },
    project: { repoPath: hfsRepo, worktreeRoot: `${hfsRepo}-wt` },
    limits: { defaultMaxActiveTasks: 1, maxActiveTasksCeiling: 2, maxFixIterations: 1, completedShown: 5 },
    claude: { chatModel: 'sonnet', available: ['sonnet'] },
  }));

  child = spawn(process.execPath, [path.join('server', 'src', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, HFSMON_CONFIG: configFile, HFSMON_DATA_DIR: dataDir, HFSMON_NO_AUTOSTART: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (b) => log.push(String(b)));
  child.stderr.on('data', (b) => log.push(String(b)));
  child.once('exit', (code) => log.push(`[exit ${code}]`));

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await call('GET', '/api/tasks')).status === 200) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`el tablero no levantó:\n${log.join('')}`);
    await new Promise((r) => { setTimeout(r, 150); });
  }
});

after(async () => {
  // By its own pid and only it: this test started the process.
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  }
  // `rmSync` does not wait for a Windows lock: see teardown.mjs.
  await removeTreeReported('project-chat-routes', dir);
});

test('the holder base answers its summary; a machine or project that is not there is a 404', async () => {
  const { status, body } = await call('GET', H);
  assert.equal(status, 200);
  assert.equal(body.kind, 'project');
  assert.equal(body.key, 'hfs@local');
  assert.equal(body.issue, null);
  assert.equal(body.machine, 'local');
  assert.equal(body.busy, false);
  assert.ok(Array.isArray(body.chats) && body.chats.length >= 1, 'it is born with its Principal chat');
  assert.ok(body.chats.every((c) => c.messages === undefined), 'the summary carries no messages');

  assert.equal((await call('GET', '/api/projects/hfs/project-chats/nowhere')).status, 404);
  assert.equal((await call('GET', '/api/projects/no-existe/project-chats/local')).status, 404);
  assert.equal((await call('POST', '/api/projects/hfs/project-chats/nowhere/chats', {})).status, 404);
});

test('the attachments route stores under attachments/<project>/_proyecto and refuses bad files', async () => {
  const ok = await call('POST', `${H}/attachments`, { name: '../../captura final.png', dataBase64: Buffer.from('PNGDATA').toString('base64') });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.name, 'captura_final.png');
  assert.equal(ok.body.bytes, 7);
  const expectedDir = path.join(dir, 'data', 'attachments', 'hfs', '_proyecto');
  assert.equal(path.dirname(ok.body.path), expectedDir);
  assert.equal(readFileSync(ok.body.path, 'utf8'), 'PNGDATA');

  const empty = await call('POST', `${H}/attachments`, { name: 'a.png', dataBase64: '' });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /empty/);

  assert.equal((await call('POST', '/api/projects/hfs/project-chats/nowhere/attachments', { name: 'a', dataBase64: 'QQ==' })).status, 404);
});

test('the snapshot carries projectChats', async () => {
  const { body } = await call('GET', '/api/tasks');
  assert.ok(Array.isArray(body.projectChats));
  assert.ok(body.projectChats.some((h) => h.key === 'hfs@local' && h.kind === 'project'));
});

test('GET chat mirrors the task route body; an unknown chat is a 404', async () => {
  const summary = (await call('GET', H)).body;
  const main = summary.chats[0].id;
  const got = await call('GET', `${H}/chat?chatId=${main}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.chatId, main);
  assert.deepEqual(Object.keys(got.body).sort(), ['activity', 'busy', 'chat', 'chatId', 'pending', 'planMode']);
  assert.equal((await call('GET', `${H}/chat?chatId=nope`)).status, 404);
});

test('creating, renaming, closing, reopening and deleting a conversation, through the holder', async () => {
  const created = await call('POST', `${H}/chats`, {});
  assert.equal(created.status, 200);
  const id = created.body.id;
  assert.ok(id);

  const renamed = await call('POST', `${H}/chats/${id}/rename`, { title: '  Mi   idea  ' });
  assert.equal(renamed.status, 200);
  assert.deepEqual(renamed.body, { id, title: 'Mi idea' });
  const after = (await call('GET', H)).body.chats.find((c) => c.id === id);
  assert.equal(after.title, 'Mi idea');

  const empty = await call('POST', `${H}/chats/${id}/rename`, { title: '   ' });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /empty/);

  assert.equal((await call('POST', `${H}/chats/${id}/close`)).status, 200);
  assert.equal((await call('POST', `${H}/chats/${id}/reopen`)).status, 200);
  assert.equal((await call('POST', `${H}/chats/${id}/close`)).status, 200);
  assert.equal((await call('POST', `${H}/chats/${id}/delete`)).status, 200);
  assert.ok(!(await call('GET', H)).body.chats.some((c) => c.id === id));
});

test('the task route renames too, and a task chat is not reachable through a holder', async () => {
  const created = await call('POST', '/api/projects/hfs/tasks/12/chats', {});
  assert.equal(created.status, 200);
  const renamed = await call('POST', `/api/projects/hfs/tasks/12/chats/${created.body.id}/rename`, { title: 'Otra' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.title, 'Otra');
  assert.equal((await call('POST', `/api/projects/hfs/tasks/12/chats/${created.body.id}/rename`, { title: '' })).status, 400);
  assert.equal((await call('POST', `/api/projects/hfs/tasks/999/chats/${created.body.id}/rename`, { title: 'x' })).status, 404);
  // The same chat id under the holder does not exist: owners do not mix.
  assert.equal((await call('POST', `${H}/chats/${created.body.id}/rename`, { title: 'x' })).status, 400);
});

test('chat tabs: bare-number tabs saved before projects are sealed with the opening project at boot', async () => {
  const { body } = await call('GET', '/api/tasks');
  const expected = [
    { project: 'hfs', issue: 12, usedAt: 1 },
    { project: 'hfs', issue: 999, usedAt: 2 },
  ];
  assert.deepEqual(body.settings.chatTabs, expected);
  const onDisk = JSON.parse(readFileSync(path.join(dir, 'data', 'settings.json'), 'utf8'));
  assert.deepEqual(onDisk.chatTabs, expected, 'persisted, not just in memory');
});

test('chat tabs: a project chat opens and closes beside the tasks', async () => {
  assert.equal((await call('POST', '/api/chat-tabs/open', { project: 'hfs', issue: 12 })).status, 200);
  const opened = await call('POST', '/api/chat-tabs/open', { project: 'hfs', owner: 'project', machine: 'local' });
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.body.chatTabs.map((t) => t.issue), [12, TAB]);

  const unknown = await call('POST', '/api/chat-tabs/open', { project: 'hfs', owner: 'project', machine: 'nowhere' });
  assert.equal(unknown.status, 404);
  assert.equal((await call('POST', '/api/chat-tabs/open', { project: 'nope', owner: 'project', machine: 'local' })).status, 404);
  assert.equal((await call('POST', '/api/chat-tabs/open', { project: 'hfs', owner: 'project', machine: 'a b' })).status, 404);

  const closed = await call('POST', '/api/chat-tabs/close', { project: 'hfs', owner: 'project', machine: 'local' });
  assert.equal(closed.status, 200);
  assert.deepEqual(closed.body.chatTabs.map((t) => t.issue), [12]);
  assert.equal((await call('POST', '/api/chat-tabs/close', { project: 'hfs', owner: 'project', machine: 'a b' })).status, 400);
  assert.equal((await call('POST', '/api/chat-tabs/close', { issue: 12 })).status, 200);
});

test('chat tabs: opening the project chat keeps the tabs of tasks of another project', async () => {
  // beta#77 does not exist in hfs: the old strip resolved it there and dropped it.
  assert.equal((await call('POST', '/api/chat-tabs/open', { project: 'beta', issue: 77 })).status, 200);
  const opened = await call('POST', '/api/chat-tabs/open', { project: 'hfs', owner: 'project', machine: 'local' });
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.body.chatTabs.map((t) => `${t.project ?? ''}#${t.issue}`), [`beta#77`, `#${TAB}`]);

  assert.equal((await call('POST', '/api/chat-tabs/open', { project: 'hfs', issue: 12 })).status, 200);
  const after = await call('POST', '/api/chat-tabs/open', { project: 'hfs', owner: 'project', machine: 'local' });
  assert.deepEqual(after.body.chatTabs.map((t) => `${t.project ?? ''}#${t.issue}`), [`beta#77`, `#${TAB}`, 'hfs#12']);
});

test('chat tabs: the same issue number in two projects is two tabs, closed one at a time', async () => {
  assert.equal((await call('POST', '/api/chat-tabs/open', { project: 'beta', issue: 12 })).status, 200);
  const both = await call('GET', '/api/tasks');
  const twelves = both.body.settings.chatTabs.filter((t) => t.issue === 12).map((t) => t.project).sort();
  assert.deepEqual(twelves, ['beta', 'hfs']);

  const closed = await call('POST', '/api/chat-tabs/close', { project: 'beta', issue: 12 });
  assert.equal(closed.status, 200);
  assert.deepEqual(closed.body.chatTabs.filter((t) => t.issue === 12).map((t) => t.project), ['hfs']);
  assert.equal((await call('POST', '/api/chat-tabs/close', { project: 'hfs', issue: 12 })).status, 200);
});

test('chat tabs: a task the board does not have is a 404 and leaves the strip alone', async () => {
  assert.equal((await call('POST', '/api/chat-tabs/open', { project: 'beta', issue: 5555 })).status, 404);
  assert.equal((await call('POST', '/api/chat-tabs/open', { project: 'nope', issue: 12 })).status, 404);
  const before = (await call('GET', '/api/tasks')).body.settings.chatTabs;
  assert.ok(before.some((t) => t.project === 'beta' && t.issue === 77), 'the beta tab survived');
});

test('WebSocket: a holder change reaches the board as `project-chat`, tagged with its owner', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const seen = [];
  ws.on('message', (raw) => seen.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  try {
    const waitFor = async (pred) => {
      for (let i = 0; i < 100; i += 1) {
        const hit = seen.find(pred);
        if (hit) return hit;
        await new Promise((r) => { setTimeout(r, 50); });
      }
      throw new Error(`no llegó: ${JSON.stringify(seen.map((m) => m.type))}`);
    };
    const snap = await waitFor((m) => m.type === 'snapshot');
    assert.ok(snap.projectChats.some((h) => h.key === 'hfs@local'));

    const { body } = await call('POST', `${H}/chats`, {});
    const update = await waitFor((m) => m.type === 'project-chat' && m.holder.chats.some((c) => c.id === body.id));
    assert.equal(update.holder.key, 'hfs@local');
    assert.equal(update.holder.kind, 'project');
    assert.equal(seen.some((m) => m.type === 'task' && m.task?.kind === 'project'), false, 'a holder is never broadcast as a task');
  } finally {
    ws.close();
  }
});

test('WebSocket: a chat message for a holder that does not exist is dropped, not sent to a task', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const seen = [];
  ws.on('message', (raw) => seen.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  try {
    ws.send(JSON.stringify({ type: 'chat', project: 'hfs', owner: 'project', machine: 'nowhere', chatId: null, text: 'hola' }));
    ws.send(JSON.stringify({ type: 'chat', project: 'hfs', owner: 'project', machine: 'local', chatId: null, text: '   ' }));
    await new Promise((r) => { setTimeout(r, 400); });
    assert.equal(seen.filter((m) => m.type === 'error').length, 0);
    assert.equal(seen.filter((m) => m.type === 'chat').length, 0, 'no message was recorded anywhere');
  } finally {
    ws.close();
  }
});

test('emptying a chat: /help answered over the socket, then POST clear empties it and every board hears `chat-reset`', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const seen = [];
  ws.on('message', (raw) => seen.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  try {
    const waitFor = async (pred) => {
      for (let i = 0; i < 100; i += 1) {
        const hit = seen.find(pred);
        if (hit) return hit;
        await new Promise((r) => { setTimeout(r, 50); });
      }
      throw new Error(`no llegó: ${JSON.stringify(seen.map((m) => m.type))}`);
    };
    const created = await call('POST', `${H}/chats`, {});
    const id = created.body.id;
    // A board command needs no session and no worktree: nothing is spawned here.
    ws.send(JSON.stringify({ type: 'chat', project: 'hfs', owner: 'project', machine: 'local', chatId: id, text: '/help' }));
    await waitFor((m) => m.type === 'chat' && m.chatId === id && m.message.role === 'assistant');
    assert.equal((await call('GET', `${H}/chat?chatId=${id}`)).body.chat.length, 2);

    const cleared = await call('POST', `${H}/chats/${id}/clear`);
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.body, { cleared: true, messages: 2 });
    const reset = await waitFor((m) => m.type === 'chat-reset' && m.chatId === id);
    assert.equal(reset.owner, 'project');
    assert.equal(reset.machine, 'local');
    assert.equal(reset.project, 'hfs');
    assert.equal((await call('GET', `${H}/chat?chatId=${id}`)).body.chat.length, 0);

    assert.equal((await call('POST', `${H}/chats/nope/clear`)).status, 400);
    assert.equal((await call('POST', '/api/projects/hfs/project-chats/nowhere/chats/x/clear')).status, 404);
    // A closed chat is refused with its reason.
    await call('POST', `${H}/chats/${id}/close`);
    const closed = await call('POST', `${H}/chats/${id}/clear`);
    assert.equal(closed.status, 400);
    assert.match(closed.body.error, /closed/);
  } finally {
    ws.close();
  }
});

test('the task route empties a task chat too; an unknown task is a 404', async () => {
  const created = await call('POST', '/api/projects/hfs/tasks/12/chats', {});
  const res = await call('POST', `/api/projects/hfs/tasks/12/chats/${created.body.id}/clear`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { cleared: true, messages: 0 });
  assert.equal((await call('POST', `/api/projects/hfs/tasks/999/chats/${created.body.id}/clear`)).status, 404);
});

test('GET commands: with no worktree the board\'s own, `complete: false`, and nothing is built', async () => {
  const summary = (await call('GET', H)).body;
  const got = await call('GET', `${H}/chats/${summary.chats[0].id}/commands`);
  assert.equal(got.status, 200);
  assert.equal(got.body.complete, false);
  assert.deepEqual(got.body.commands.map((c) => [c.name, c.source]), [['clear', 'board'], ['model', 'board'], ['plan', 'board'], ['help', 'board']]);
  assert.deepEqual(Object.keys(got.body.commands[0]).sort(), ['aliases', 'argumentHint', 'description', 'name', 'source']);
  assert.equal((await call('GET', H)).body.worktreePath ?? null, null, 'asking built no worktree');

  const task = await call('POST', '/api/projects/hfs/tasks/12/chats', {});
  const forTask = await call('GET', `/api/projects/hfs/tasks/12/chats/${task.body.id}/commands`);
  assert.equal(forTask.status, 200);
  assert.equal(forTask.body.complete, false);
  assert.equal((await call('GET', `${H}/chats/nope/commands`)).status, 400);
});
