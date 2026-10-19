import './isolate.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './isolate.mjs';

process.env.HFSMON_PERSIST_DELAY_MS = '60000';
process.env.HFSMON_SWEEP_INTERVAL_MS = '0';
const { store } = await import('../src/store.js');
const pc = await import('../src/projectchats.js');

const FILE = path.join(DATA_DIR, 'projectchats.json');
const onDisk = () => JSON.parse(readFileSync(FILE, 'utf8'));
const inMemory = () => ({ version: 1, holders: JSON.parse(JSON.stringify(Object.fromEntries(
  pc.allHolders().map((h) => [pc.holderKey(h.project, h.machine), h])))) });
after(() => store.flush());

test('project chats: burst of addLog/addChat during an async write ends equal on disk', async () => {
  const holder = pc.getHolder('hfs', 'local');
  for (let i = 0; i < 300; i++) store.addChat(holder, null, 'user', `mensaje ${i} ${'z'.repeat(500)}`);
  await pc._flushProjectChatsAsyncForTests();
  assert.deepEqual(onDisk(), inMemory());

  store.touch(holder);
  const writing = pc._flushProjectChatsAsyncForTests();
  for (let i = 0; i < 1000; i++) {
    store.addLog(holder, 'tool', `ráfaga ${i}`);
    store.touch(holder);
    if (i % 50 === 0) await new Promise((r) => setImmediate(r));
  }
  await writing;
  await pc._flushProjectChatsAsyncForTests();
  assert.deepEqual(onDisk(), inMemory(), 'sin flush síncrono de rescate');
});

test('project chats: a change that skips persistHolder is found by the sweep and saved', async () => {
  const holder = pc.getHolder('hfs', 'local');
  await pc._flushProjectChatsAsyncForTests();
  holder.worktreePath = 'C:\\sin\\avisar';           // nobody calls persistHolder
  store.touch(holder);                                // ... until something else does (cache says: unchanged)
  assert.deepEqual(await pc.sweepProjectChats(), [], 'touch invalidates it: nothing hidden');

  await pc._flushProjectChatsAsyncForTests();         // the cache now holds the holder's text
  holder.head = 'abc123';                             // now truly silent
  const moved = await pc.sweepProjectChats();
  assert.deepEqual(moved, ['hfs@local']);
  await pc._flushProjectChatsAsyncForTests();
  assert.equal(onDisk().holders['hfs@local'].head, 'abc123');

  holder.head = 'def456';                             // silent again: the exit flush catches it
  pc.flushProjectChats();
  assert.equal(onDisk().holders['hfs@local'].head, 'def456');
  assert.deepEqual(onDisk(), inMemory());
});
