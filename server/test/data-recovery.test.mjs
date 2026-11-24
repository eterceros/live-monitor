// What the board does at start-up with data files a power cut damaged — the
// cases of 2026-11-23, when Windows went down hard and `settings.json`,
// `projectchats.json` and five task data files came back full of zero bytes, the
// board refused to start, and starting it again over a restored old copy
// overwrote project chat files that were fine.
//
// Each case boots a fresh process (data-boot-child.mjs) on its own temp data dir:
// settings, the store and the project chats read their files once, at import.
import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, utimesSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './teardown.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const zeros = (n) => Buffer.alloc(n, 0);
const isZeros = (buf) => buf.length > 0 && buf.every((b) => b === 0);

function boot(dir, env = {}) {
  const r = spawnSync(process.execPath, [path.join(HERE, 'data-boot-child.mjs')], {
    env: { ...process.env, HFSMON_DATA_DIR: dir, HFSMON_PERSIST_DELAY_MS: '60000', HFSMON_SWEEP_INTERVAL_MS: '0', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const line = r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).at(-1);
  return { code: r.status, stderr: r.stderr, out: line ? JSON.parse(line) : null };
}

const filesIn = (dir) => (existsSync(dir) ? readdirSync(dir) : []);
const task = (issue, over = {}) => ({ issue, title: `t${issue}`, labels: [], url: 'x', state: 'pr_draft', log: [], chats: [], ...over });
const lines = (n, tag) => Array.from({ length: n }, (_, i) => ({ ts: '2026-11-23T00:00:00.000Z', phase: 'tool', line: `${tag} ${i}` }));
const msgs = (n, tag) => Array.from({ length: n }, (_, i) => ({ id: `${tag}-${i}`, role: 'user', text: `${tag} ${i}`, ts: '2026-11-23T00:00:00.000Z' }));

test('settings.json full of zeros: the board starts on its defaults, keeps the damaged file and says so', () => {
  const dir = tempDir('hfsmon-rec-');
  writeFileSync(path.join(dir, 'settings.json'), zeros(2157));
  const r = boot(dir, { CHILD_SET_MAX: '2' });
  assert.equal(r.code, 0, r.stderr);
  const kept = filesIn(dir).filter((n) => n.startsWith('settings.json.corrupt-'));
  assert.equal(kept.length, 1, filesIn(dir).join(', '));
  assert.ok(isZeros(readFileSync(path.join(dir, kept[0]))), 'the damaged file is kept as it was');
  assert.equal(readFileSync(path.join(dir, kept[0])).length, 2157);
  const item = r.out.health.find((h) => h.file === 'settings.json');
  assert.match(item.problem, /2157 zero bytes/);
  // And the next save is a new file, not a write over the damaged one.
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8')).maxActiveTasks, 2);
});

test('settings.json full of zeros with a backup: the backup is read', () => {
  const dir = tempDir('hfsmon-rec-');
  writeFileSync(path.join(dir, 'settings.json'), zeros(2157));
  writeFileSync(path.join(dir, 'settings.json.bak'), JSON.stringify({ maxActiveTasks: 3 }));
  const r = boot(dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.maxActiveTasks, 3);
  assert.match(r.out.health.find((h) => h.file === 'settings.json').action, /settings\.json\.bak/);
});

test('settings are saved with fsync and generations: three saves leave .bak and .bak.1', () => {
  const dir = tempDir('hfsmon-rec-');
  for (const n of [1, 2, 3]) {
    const r = boot(dir, { CHILD_SET_MAX: String(n) });
    assert.equal(r.code, 0, r.stderr);
  }
  const read = (name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8')).maxActiveTasks;
  assert.equal(read('settings.json'), 3);
  assert.equal(read('settings.json.bak'), 2);
  assert.equal(read('settings.json.bak.1'), 1);
});

test('projectchats.json full of zeros: a healthy chat data file is NOT overwritten when the chat is opened again', () => {
  const dir = tempDir('hfsmon-rec-');
  writeFileSync(path.join(dir, 'projectchats.json'), zeros(937200));
  const sideDir = path.join(dir, 'taskdata', 'projectchats');
  mkdirSync(sideDir, { recursive: true });
  const side = path.join(sideDir, 'hfs@local.json');
  const healthy = JSON.stringify({ v: 1, key: 'hfs@local', log: lines(30, 'real'), messages: { c1: msgs(200, 'real') } });
  writeFileSync(side, healthy);

  const r = boot(dir, { CHILD_OPEN_HOLDER: 'hfs@local' });
  assert.equal(r.code, 0, r.stderr);
  const keptMain = filesIn(dir).filter((n) => n.startsWith('projectchats.json.corrupt-'));
  assert.equal(keptMain.length, 1, 'the damaged main file is kept under a name of its own');
  assert.ok(isZeros(readFileSync(path.join(dir, keptMain[0]))));
  const aside = filesIn(sideDir).filter((n) => n.startsWith('hfs@local.json.unadopted-'));
  assert.equal(aside.length, 1, filesIn(sideDir).join(', '));
  assert.equal(readFileSync(path.join(sideDir, aside[0]), 'utf8'), healthy, 'the healthy history survives byte for byte');
  assert.ok(r.out.health.some((h) => h.file === 'projectchats.json'));
  assert.ok(r.out.health.some((h) => h.file === 'hfs@local.json' && h.severity === 'warning'));
});

test('an old one-file copy restored over newer data files is not converted, and the data files stay as they were', () => {
  const dir = tempDir('hfsmon-rec-');
  // The restored copy: old format, short history.
  const main = path.join(dir, 'tasks.json');
  writeFileSync(main, JSON.stringify({ 1: task(1, { log: lines(2, 'old') }), 2: task(2, { log: lines(1, 'old') }) }));
  const old = new Date('2026-10-14T16:26:00Z');
  utimesSync(main, old, old);
  // The data file written after the split, with the newer, longer history.
  const sideDir = path.join(dir, 'taskdata', 'tasks');
  mkdirSync(sideDir, { recursive: true });
  const newer = JSON.stringify({ v: 1, key: '1', log: lines(500, 'new'), messages: {} });
  writeFileSync(path.join(sideDir, '1.json'), newer);

  const r = boot(dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(path.join(sideDir, '1.json'), 'utf8'), newer, 'not overwritten by the older history');
  assert.deepEqual(filesIn(sideDir), ['1.json'], 'no other data file was written');
  const onDisk = JSON.parse(readFileSync(main, 'utf8'));
  assert.equal(onDisk['1'].persistSplit, undefined, 'still in the old format');
  assert.equal(onDisk['1'].log.length, 2);
  assert.match(r.out.health.find((h) => h.file === 'tasks.json').problem, /newer than it/);
});

test('an old copy of the project chats restored over newer data files is not converted either', () => {
  const dir = tempDir('hfsmon-rec-');
  const holder = { kind: 'project', project: 'hfs', machine: 'local', title: 'Proyecto', worktreePath: null, head: null,
    log: lines(1, 'old'), chats: [{ id: 'c1', title: 'Main', messages: msgs(3, 'old') }] };
  const main = path.join(dir, 'projectchats.json');
  writeFileSync(main, JSON.stringify({ version: 1, holders: { 'hfs@local': holder } }));
  const old = new Date('2026-10-14T16:26:00Z');
  utimesSync(main, old, old);
  const sideDir = path.join(dir, 'taskdata', 'projectchats');
  mkdirSync(sideDir, { recursive: true });
  const newer = JSON.stringify({ v: 1, key: 'hfs@local', log: lines(40, 'new'), messages: { c1: msgs(300, 'new') } });
  writeFileSync(path.join(sideDir, 'hfs@local.json'), newer);

  const r = boot(dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(path.join(sideDir, 'hfs@local.json'), 'utf8'), newer);
  assert.ok(r.out.health.some((h) => h.file === 'projectchats.json' && /newer than it/.test(h.problem)));
});

test('a tasks file full of zeros with a previous version: read from it, the damaged one kept', () => {
  const dir = tempDir('hfsmon-rec-');
  const main = path.join(dir, 'tasks.json');
  writeFileSync(main, zeros(5000));
  writeFileSync(`${main}.bak`, JSON.stringify({ 7: task(7, { title: 'from the backup' }) }));
  const r = boot(dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.tasks['hfs#7'].title, 'from the backup');
  assert.equal(filesIn(dir).filter((n) => n.startsWith('tasks.json.corrupt-')).length, 1);
  assert.ok(r.out.health.some((h) => h.file === 'tasks.json'));
});

test('a tasks file full of zeros and no previous version: the board does not start, says why, and touches nothing', () => {
  const dir = tempDir('hfsmon-rec-');
  const main = path.join(dir, 'tasks.json');
  writeFileSync(main, zeros(5000));
  const r = boot(dir);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no usable previous version/);
  assert.match(r.stderr, /5000 zero bytes/);
  assert.ok(isZeros(readFileSync(main)) && statSync(main).size === 5000, 'left exactly where it was');
});

test('a task data file full of zeros: its previous version is read, the damaged one kept', () => {
  const dir = tempDir('hfsmon-rec-');
  writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({ 3: task(3, { persistSplit: 1 }) }));
  const sideDir = path.join(dir, 'taskdata', 'tasks');
  mkdirSync(sideDir, { recursive: true });
  writeFileSync(path.join(sideDir, '3.json'), zeros(140711));
  writeFileSync(path.join(sideDir, '3.json.bak'), JSON.stringify({ v: 1, key: '3', log: lines(25, 'bak'), messages: {} }));
  const r = boot(dir);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.out.tasks['hfs#3'].log >= 25, JSON.stringify(r.out.tasks));
  const kept = filesIn(sideDir).filter((n) => n.startsWith('3.json.corrupt-'));
  assert.equal(kept.length, 1, filesIn(sideDir).join(', '));
  assert.ok(isZeros(readFileSync(path.join(sideDir, kept[0]))));
  assert.ok(r.out.health.some((h) => h.file === '3.json'));
});

test('end to end: two boots leave a previous version; a cut that zeroes the tasks file loses nothing', () => {
  const dir = tempDir('hfsmon-rec-');
  writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({ 1: task(1, { log: lines(40, 'a') }), 2: task(2, { log: lines(60, 'b') }) }));
  for (const step of ['converts to the split format', 'rewrites it: the first version becomes tasks.json.bak']) {
    const b = boot(dir);
    assert.equal(b.code, 0, `${step}: ${b.stderr}`);
  }
  const main = path.join(dir, 'tasks.json');
  assert.ok(existsSync(`${main}.bak`));
  writeFileSync(main, zeros(statSync(main).size));
  const r = boot(dir);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.out.tasks['hfs#1'].log >= 40 && r.out.tasks['hfs#2'].log >= 60, JSON.stringify(r.out.tasks));
  assert.ok(r.out.health.some((h) => h.file === 'tasks.json'));
});
