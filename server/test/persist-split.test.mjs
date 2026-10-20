import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync, cpSync, rmSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { tempDir } from './teardown.mjs';
import { readTasksFileMerged, coreOf, heavyChunks, mergeHeavy, SPLIT_MARK, heavyPath, readHeavy, backupOnce } from '../src/splitfmt.js';
import { migrateChats, resetChatsOnBoot } from '../src/chats.js';

/**
 * The move from one fat `tasks.json` to a main file plus one data file per task
 * (see `splitfmt.js`). Everything here runs a real store in a child process on a
 * COPY of the data, in a temp directory that is removed at exit. The originals of
 * the real board are never opened.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const FROZEN = '2030-01-01T00:00:00.000Z';

/** What the board's own boot fix-ups (a turn cut by the restart…) make of a task's chats, under the child's frozen clock. */
function bootNormalized(task) {
  const RealDate = Date;
  const T = new RealDate(FROZEN).getTime();
  globalThis.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [T])); }
    static now() { return T; }
  };
  try {
    const t = structuredClone(task);
    migrateChats(t);
    resetChatsOnBoot(t);
    return t;
  } finally {
    globalThis.Date = RealDate;
  }
}

function child(dir, ...args) {
  const proc = spawn(process.execPath, [path.join(HERE, 'persist-child.mjs'), ...args], {
    env: { ...process.env, HFSMON_DATA_DIR: dir, HFSMON_PERSIST_DELAY_MS: '5', HFSMON_SWEEP_INTERVAL_MS: '0', HFSMON_FROZEN_NOW: FROZEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { err += d; });
  return new Promise((resolve) => proc.on('exit', (code) => resolve({ code, out, err })));
}

/** An old-format (single file) task, the way the board wrote them before the split. */
function legacyTask(project, issue, { lines = 30, msgs = 10, chatIds = ['c1', 'c2'] } = {}) {
  return {
    issue, project, title: `tarea ${issue} ñandú 🔧 "comillas"`, labels: ['bug'], url: 'x', state: 'done',
    machine: 'local', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    log: Array.from({ length: lines }, (_, i) => ({ ts: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`, phase: 'tool', line: `línea ${i} \\ \n tab\t` })),
    chats: chatIds.map((id) => ({
      id, title: id, messages: Array.from({ length: msgs }, (_, i) => ({
        id: `${id}-m${i}`, role: i % 2 ? 'assistant' : 'user', text: `msg ${i} ${'é'.repeat(50)}`, ts: '2026-01-01T00:00:00.000Z',
        ...(i === 3 ? { items: [{ id: 't1', kind: 'tool', name: 'Read', children: [{ id: 't2' }] }] } : {}),
      })),
    })),
  };
}

function legacyDir() {
  const dir = tempDir('hfsmon-split-');
  const tasks = { 1: legacyTask('hfs', 1), 2: legacyTask('hfs', 2, { chatIds: ['dup', 'dup'] }), 3: legacyTask('hfs', 3, { lines: 0, msgs: 0 }) };
  delete tasks[3].log;                                  // a task with no log at all
  tasks.huérfano = { sin: 'issue', log: [{ ts: 'x', phase: 'p', line: 'no sé de quién soy' }] };   // nothing can key it
  tasks.nulo = null;
  writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify(tasks, null, 2));
  writeFileSync(path.join(dir, 'tasks.beta.json'), JSON.stringify({ 7: legacyTask('beta', 7, { lines: 5, msgs: 2 }) }, null, 2));
  const holder = (project) => ({
    kind: 'project', project, machine: 'local', title: 'Proyecto', worktreePath: null, head: null,
    log: [{ ts: 'x', phase: 'p', line: 'holder' }], chats: [{ id: 'h1', title: 'Main', messages: [{ id: 'hm', role: 'user', text: 'hola', ts: 'x' }] }],
  });
  writeFileSync(path.join(dir, 'projectchats.json'), JSON.stringify({ version: 1, holders: { 'hfs@local': holder('hfs'), 'beta@local': holder('beta') } }, null, 2));
  return dir;
}

test('splitfmt: coreOf + heavyChunks + mergeHeavy round trip is exact, even with duplicate chat ids', () => {
  const t = legacyTask('hfs', 2, { chatIds: ['dup', 'dup', 'solo'] });
  const original = JSON.parse(JSON.stringify(t));
  const core = JSON.parse(JSON.stringify(coreOf(t)));
  const heavy = JSON.parse(heavyChunks(t, (x) => JSON.stringify(x)).join(''));
  assert.equal(core[SPLIT_MARK], 1);
  assert.deepEqual(core.log, []);
  assert.equal(core.chats[2].messages.length, 0, 'the unique chat travels in the data file');
  assert.equal(core.chats[0].messages.length, 10, 'a chat whose id is not unique stays whole in the main file');
  assert.deepEqual(t, original, 'coreOf does not touch its argument');
  mergeHeavy(core, heavy);
  assert.deepEqual(core, original);
});

test('migration: first write backs up the old file, splits it and loses nothing', async () => {
  const dir = legacyDir();
  const before = { tasks: sha(path.join(dir, 'tasks.json')), beta: sha(path.join(dir, 'tasks.beta.json')), pc: sha(path.join(dir, 'projectchats.json')) };
  const original = {
    hfs: JSON.parse(readFileSync(path.join(dir, 'tasks.json'), 'utf8')),
    beta: JSON.parse(readFileSync(path.join(dir, 'tasks.beta.json'), 'utf8')),
    holders: JSON.parse(readFileSync(path.join(dir, 'projectchats.json'), 'utf8')).holders,
  };
  const out = path.join(dir, '_dump');
  const r = await child(dir, 'dump', out);
  assert.equal(r.code, 0, r.err);

  // 1. Backups: byte-identical to what was there, and they stay.
  assert.equal(sha(path.join(dir, 'tasks.json.pre-split.bak')), before.tasks);
  assert.equal(sha(path.join(dir, 'tasks.beta.json.pre-split.bak')), before.beta);
  assert.equal(sha(path.join(dir, 'projectchats.json.pre-split.bak')), before.pc);

  // 2. The main files are split and small; the data lives beside them.
  const raw = JSON.parse(readFileSync(path.join(dir, 'tasks.json'), 'utf8'));
  assert.equal(raw[1][SPLIT_MARK], 1);
  assert.deepEqual(raw[1].log, []);
  assert.ok(existsSync(path.join(dir, 'taskdata', 'tasks', '1.json')));
  assert.ok(existsSync(path.join(dir, 'taskdata', 'tasks.beta', '7.json')));
  assert.ok(existsSync(path.join(dir, 'taskdata', 'projectchats', 'hfs@local.json')));
  assert.deepEqual(raw['huérfano'], { ...original.hfs['huérfano'], project: 'hfs' }, 'an entry nothing can key is written back whole (the store has always stamped its project)');
  assert.equal(raw.nulo, null);

  // 3. SEMANTIC: every heavy part of every task is exactly what the old file had.
  const merged = readTasksFileMerged(path.join(dir, 'tasks.json'));
  for (const issue of ['1', '2', '3']) {
    assert.deepEqual(merged[issue].log, original.hfs[issue].log, `log of ${issue}`);
    assert.deepEqual(merged[issue].chats.map((c) => c.messages), original.hfs[issue].chats.map((c) => c.messages), `messages of ${issue}`);
  }
  assert.equal(Object.hasOwn(merged[3], 'log'), Object.hasOwn(original.hfs[3], 'log'), 'a task with no log still has none');
  const mergedBeta = readTasksFileMerged(path.join(dir, 'tasks.beta.json'));
  assert.deepEqual(mergedBeta[7].log, original.beta[7].log);
  assert.deepEqual(mergedBeta[7].chats.map((c) => c.messages), original.beta[7].chats.map((c) => c.messages));
  const mergedHolders = readTasksFileMerged(path.join(dir, 'projectchats.json'), { key: (x) => x.holders }).holders;
  for (const k of ['hfs@local', 'beta@local']) {
    assert.deepEqual(mergedHolders[k].log, original.holders[k].log);
    assert.deepEqual(mergedHolders[k].chats.map((c) => c.messages), original.holders[k].chats.map((c) => c.messages));
  }

  // 4. SEMANTIC, whole entries: what the disk holds now is what the board held in memory.
  const mem = (name) => JSON.parse(readFileSync(path.join(out, name), 'utf8'));
  assert.deepEqual(Object.fromEntries(Object.entries(merged).filter(([, v]) => v && v.issue)), mem('mem.hfs.json'));
  assert.deepEqual(mergedBeta, mem('mem.beta.json'));
  assert.deepEqual(mergedHolders, mem('mem.holders.json'));

  // 5. A second boot changes nothing: same files, no second backup, no migration.
  const files = (d) => Object.fromEntries(readdirSync(d, { recursive: true }).filter((n) => /\.json$|\.bak$/.test(n) && !n.startsWith('_dump')).map((n) => [n, sha(path.join(d, n))]));
  const first = files(dir);
  const r2 = await child(dir, 'dump', path.join(dir, '_dump2'));
  assert.equal(r2.code, 0, r2.err);
  assert.deepEqual(files(dir), first, 'second boot: not one file changed, none added (no second .bak)');
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, '_dump2', 'mem.hfs.json'), 'utf8')), mem('mem.hfs.json'), 'memory after the second boot equals memory after the first');
});

test('boot converts the project chats too, without waiting for the first chat message', async () => {
  const dir = legacyDir();
  const before = sha(path.join(dir, 'projectchats.json'));
  assert.equal((await child(dir, 'boot')).code, 0);
  assert.equal(sha(path.join(dir, 'projectchats.json.pre-split.bak')), before);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'projectchats.json'), 'utf8')).holders['hfs@local'][SPLIT_MARK], 1);
  const holders = readTasksFileMerged(path.join(dir, 'projectchats.json'), { key: (x) => x.holders }).holders;
  assert.equal(holders['hfs@local'].chats[0].messages[0].text, 'hola');
});

test('a data file that is unreadable or missing is reported, moved aside, and the backup still has it all', async () => {
  const dir = legacyDir();
  const original = JSON.parse(readFileSync(path.join(dir, 'tasks.json'), 'utf8'));
  assert.equal((await child(dir, 'boot')).code, 0);       // migrate
  writeFileSync(path.join(dir, 'taskdata', 'tasks', '1.json'), '{"v":1,"log":[{"ts":');   // torn
  rmSync(path.join(dir, 'taskdata', 'tasks', '2.json'));                               // gone
  const r = await child(dir, 'dump', path.join(dir, '_dump'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /ilegible/);
  assert.match(r.err, /ausente/);
  assert.ok(readdirSync(path.join(dir, 'taskdata', 'tasks')).some((n) => n.startsWith('1.json.bad-')), 'the torn file was kept aside, not overwritten');
  assert.ok(existsSync(path.join(dir, 'tasks.json.pre-split.bak')));
  const bak = JSON.parse(readFileSync(path.join(dir, 'tasks.json.pre-split.bak'), 'utf8'));
  assert.deepEqual(bak[1].log, original[1].log, 'the history of the damaged task is still in the backup');
  const mem = JSON.parse(readFileSync(path.join(dir, '_dump', 'mem.hfs.json'), 'utf8'));
  assert.equal(mem[3].title, original[3].title, 'the other tasks load as usual');
});

test('if the split cannot be written the old format keeps saving and the backup is made', async () => {
  const dir = legacyDir();
  writeFileSync(path.join(dir, 'taskdata'), 'in the way');     // a file where the folder must go
  const original = JSON.parse(readFileSync(path.join(dir, 'tasks.json'), 'utf8'));
  const before = sha(path.join(dir, 'tasks.json'));
  const r = await child(dir, 'boot');
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /no se pudo migrar/);
  assert.ok(existsSync(path.join(dir, 'tasks.json.pre-split.bak')), 'the backup was made first');
  const saved = JSON.parse(readFileSync(path.join(dir, 'tasks.json'), 'utf8'));
  assert.deepEqual(saved[1].log, original[1].log, 'the single file still holds everything');
  assert.equal(saved[1][SPLIT_MARK], undefined);
  // A migration that fails on every boot does not pile up a ~100 MB backup per boot.
  for (let i = 0; i < 3; i++) assert.equal((await child(dir, 'boot')).code, 0);
  const baks = readdirSync(dir).filter((n) => n.startsWith('tasks.json.pre-split'));
  assert.ok(baks.length <= 2, `at most the original and its rewritten form, got ${baks.join(', ')}`);
  assert.equal(sha(path.join(dir, 'tasks.json.pre-split.bak')), before, 'the first backup is still the original, byte for byte');
});

test('backupOnce reuses an identical backup and never overwrites a different one', () => {
  const dir = tempDir('hfsmon-bak-');
  const f = path.join(dir, 'x.json');
  writeFileSync(f, '{"a":1}');
  const first = backupOnce(f);
  assert.equal(backupOnce(f), first, 'same bytes: no second copy');
  assert.equal(readdirSync(dir).filter((n) => n.endsWith('.bak')).length, 1);
  writeFileSync(f, '{"a":2}');
  const second = backupOnce(f);
  assert.notEqual(second, first);
  assert.equal(readFileSync(first, 'utf8'), '{"a":1}', 'the first backup was not touched');
});

// The same comparison on a COPY of the real data, when the owner points at one.
// It never opens the originals: HFSMON_REAL_DATA_COPY must be a copy, and this copies it again.
const REAL = process.env.HFSMON_REAL_DATA_COPY;
test('REAL DATA COPY: migrating loses nothing (every task, log and chat, original vs migrated)', { skip: !REAL && 'set HFSMON_REAL_DATA_COPY to a copy of the data directory', timeout: 900_000 }, async () => {
  const dir = tempDir('hfsmon-split-real-');
  for (const n of readdirSync(REAL)) {
    if (/^(tasks.*|projectchats|projects|settings|quota|boardtimings)\.json$/.test(n)) cpSync(path.join(REAL, n), path.join(dir, n));
  }
  const names = readdirSync(dir).filter((n) => /^tasks.*\.json$/.test(n));
  const originals = Object.fromEntries(names.map((n) => [n, JSON.parse(readFileSync(path.join(dir, n), 'utf8'))]));
  const originalHolders = JSON.parse(readFileSync(path.join(dir, 'projectchats.json'), 'utf8')).holders;
  const hashes = Object.fromEntries([...names, 'projectchats.json'].map((n) => [n, sha(path.join(dir, n))]));
  const out = path.join(dir, '_dump');
  const r = await child(dir, 'dump', out);
  assert.equal(r.code, 0, r.err);
  const summary = JSON.parse(r.out.trim().split('\n').at(-1));

  let tasks = 0;
  const changedByBoot = new Set();
  let logLines = 0;
  let messages = 0;
  for (const n of names) {
    assert.equal(sha(path.join(dir, `${n}.pre-split.bak`)), hashes[n], `${n}: backup is byte-identical to the original`);
    const merged = readTasksFileMerged(path.join(dir, n));
    assert.deepEqual(Object.keys(merged), Object.keys(originals[n]), `${n}: same entries, same order`);
    for (const [k, o] of Object.entries(originals[n])) {
      if (!o || typeof o !== 'object') { assert.deepEqual(merged[k], o); continue; }
      tasks += 1;
      assert.deepEqual(merged[k].log, o.log, `${n}#${k}: log`);
      const normalized = bootNormalized(o);
      assert.deepEqual((merged[k].chats ?? []).map((c) => c.messages), (normalized.chats ?? []).map((c) => c.messages), `${n}#${k}: chat messages (as the boot's own fix-ups leave them)`);
      logLines += (o.log ?? []).length;
      messages += (o.chats ?? []).reduce((a, c) => a + (c.messages?.length ?? 0), 0);
      // The rest of the entry may differ from the old file only by what the boot's own
      // fix-ups do (close open timing spans, park a run that was cut...): that is not the
      // split's doing, and "disk == memory" below pins the result exactly. What the split
      // must never do is drop a field.
      for (const f of Object.keys(o)) {
        assert.ok(Object.hasOwn(merged[k], f), `${n}#${k}: field ${f} disappeared`);
        if (JSON.stringify(merged[k][f]) !== JSON.stringify(o[f])) changedByBoot.add(f);
      }
    }
    // And the disk equals memory as the board had it when it wrote.
    const project = n === 'tasks.json' ? 'hfs' : n.replace(/^tasks\.|\.json$/g, '');
    assert.deepEqual(merged, JSON.parse(readFileSync(path.join(out, `mem.${project}.json`), 'utf8')), `${n}: disk == memory`);
  }
  const mergedHolders = readTasksFileMerged(path.join(dir, 'projectchats.json'), { key: (x) => x.holders }).holders;
  assert.equal(sha(path.join(dir, 'projectchats.json.pre-split.bak')), hashes['projectchats.json']);
  for (const [k, o] of Object.entries(originalHolders)) {
    assert.deepEqual(mergedHolders[k].log, o.log, `holder ${k}: log`);
    assert.deepEqual(mergedHolders[k].chats.map((c) => c.messages), bootNormalized(o).chats.map((c) => c.messages), `holder ${k}: messages (as the boot's own fix-ups leave them)`);
    messages += o.chats.reduce((a, c) => a + c.messages.length, 0);
  }
  assert.deepEqual(mergedHolders, JSON.parse(readFileSync(path.join(out, 'mem.holders.json'), 'utf8')), 'holders: disk == memory');

  // A second boot on the migrated copy sees the same board.
  const r2 = await child(dir, 'dump', path.join(dir, '_dump2'));
  assert.equal(r2.code, 0, r2.err);
  for (const n of names) {
    const project = n === 'tasks.json' ? 'hfs' : n.replace(/^tasks\.|\.json$/g, '');
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, '_dump2', `mem.${project}.json`), 'utf8')), JSON.parse(readFileSync(path.join(out, `mem.${project}.json`), 'utf8')), `${n}: reload == first boot`);
  }
  process.stderr.write(`[persist-split] fields the boot's own fix-ups changed: ${[...changedByBoot].sort().join(', ')}
`);
  process.stderr.write(`[persist-split] real copy: ${summary.tasks} tasks, ${tasks} entries compared, ${logLines} log lines, ${messages} messages, ${summary.holders} holders: identical\n`);
});

test('going back to an older build and returning: what the old build wrote into the main file is united with the data file, nothing dropped', async () => {
  const dir = legacyDir();
  const original = JSON.parse(readFileSync(path.join(dir, 'tasks.json'), 'utf8'));
  assert.equal((await child(dir, 'boot')).code, 0);                   // migrated
  // An old build knows nothing of the split: it loads the main file (empty log and messages,
  // marker kept as an unknown field), appends, and writes the whole thing back.
  const main = JSON.parse(readFileSync(path.join(dir, 'tasks.json'), 'utf8'));
  main[1].log.push({ ts: 'z', phase: 'viejo', line: 'escrita por un build antiguo' });
  main[1].chats[0].messages.push({ id: 'old-msg', role: 'user', text: 'mensaje de un build antiguo', ts: 'z' });
  assert.equal(main[1][SPLIT_MARK], 1);
  writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify(main, null, 2));
  const r = await child(dir, 'dump', path.join(dir, '_dump'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /older build/);
  const merged = readTasksFileMerged(path.join(dir, 'tasks.json'));
  assert.deepEqual(merged[1].log.slice(0, original[1].log.length), original[1].log, 'the whole history first');
  assert.ok(merged[1].log.some((e) => e.line === 'escrita por un build antiguo'), 'and what the old build wrote');
  assert.ok(merged[1].log.some((e) => /older build/.test(e.line)), 'the task log says it happened');
  const msgs = merged[1].chats[0].messages;
  assert.deepEqual(msgs.slice(0, 10), original[1].chats[0].messages, 'the chat history first');
  assert.equal(msgs.at(-1).id, 'old-msg');
  assert.ok(readdirSync(path.join(dir, 'taskdata', 'tasks')).some((n) => n.startsWith('1.json.pre-merge')), 'the data file as it was is kept: ' + r.err);
  // Once united the main file is split again: a further boot changes nothing.
  const snapshot = sha(path.join(dir, 'tasks.json'));
  assert.equal((await child(dir, 'boot')).code, 0);
  assert.equal(sha(path.join(dir, 'tasks.json')), snapshot);
  assert.deepEqual(readTasksFileMerged(path.join(dir, 'tasks.json'))[1].log, merged[1].log);
});

test('a data file with messages of a chat the main file does not list is reported and kept, not ignored', async () => {
  const dir = legacyDir();
  assert.equal((await child(dir, 'boot')).code, 0);
  const sidecar = path.join(dir, 'taskdata', 'tasks', '1.json');
  const heavy = JSON.parse(readFileSync(sidecar, 'utf8'));
  heavy.messages.ghost = [{ id: 'g1', role: 'user', text: 'de un chat creado justo antes de un corte', ts: 'z' }];
  writeFileSync(sidecar, JSON.stringify(heavy));
  const r = await child(dir, 'boot');
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /does not list \(ghost\)/);
  const bak = readdirSync(path.join(dir, 'taskdata', 'tasks')).find((n) => n.startsWith('1.json.orphan-chats'));
  assert.ok(bak, 'a copy of the data file with those messages is kept');
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'taskdata', 'tasks', bak), 'utf8')).messages.ghost[0].id, 'g1');
  assert.ok(readTasksFileMerged(path.join(dir, 'tasks.json'))[1].log.some((e) => /does not list/.test(e.line)));
});

test('sidecar names are case-proof: ids that differ only in case get different files, old names are still read', () => {
  const dir = tempDir('hfsmon-case-');
  const a = heavyPath(dir, 'projectchats', 'proj@PC');
  const b = heavyPath(dir, 'projectchats', 'proj@pc');
  assert.notEqual(a.toLowerCase(), b.toLowerCase(), 'would be one file on Windows otherwise');
  assert.equal(path.basename(b), 'proj@pc.json', 'a lowercase id keeps the name it always had');
  assert.equal(path.basename(heavyPath(dir, 'tasks', 1473)), '1473.json');
  // A file written with the previous scheme (case kept) is found.
  mkdirSync(path.join(dir, 'taskdata', 'projectchats'), { recursive: true });
  writeFileSync(path.join(dir, 'taskdata', 'projectchats', 'Proj@PC.json'), '{"v":1,"log":[],"messages":{}}');
  assert.equal(readHeavy(dir, 'projectchats', 'Proj@PC').ok, true);
  assert.equal(readHeavy(dir, 'projectchats', 'Proj@PD').reason, 'missing');
});
