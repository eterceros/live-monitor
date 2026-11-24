// Snapshots of the data folder (`snapshots.js`, `snapshotlib.js`) and the restore
// tool (`tools/restore-snapshot`). Every folder is a temp one: HFSMON_SNAPSHOT_DIR
// points the board's snapshots at one, so nothing lands in the real
// %LOCALAPPDATA%, and the live data is never read.
import './isolate.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './isolate.mjs';
import { tempDir } from './teardown.mjs';
import { liveFiles, retentionPlan, listSnapshots, stampOf } from '../src/snapshotlib.js';

const SNAP = tempDir('hfsmon-snap-');
process.env.HFSMON_SNAPSHOT_DIR = SNAP;
const { config } = await import('../src/config.js');
const snaps = await import('../src/snapshots.js');
const { dataHealth } = await import('../src/datahealth.js');
const { writeDurableSync } = await import('../src/durable.js');
const restore = await import('../../tools/restore-snapshot/restore.mjs');
const HERE = path.dirname(fileURLToPath(import.meta.url));

const realNow = snaps.snapshotHooks.now;
const realArchive = snaps.snapshotHooks.archive;
after(() => { snaps.snapshotHooks.now = realNow; snaps.snapshotHooks.archive = realArchive; delete config.backup; });

/** A data folder with the shapes the board writes, plus everything a snapshot must leave out. */
function seedData(dir) {
  mkdirSync(path.join(dir, 'taskdata', 'tasks'), { recursive: true });
  mkdirSync(path.join(dir, 'taskdata', 'projectchats.from-oct14-20261123'), { recursive: true });
  mkdirSync(path.join(dir, 'upgrade'), { recursive: true });
  mkdirSync(path.join(dir, 'attachments'), { recursive: true });
  const w = (rel, text) => writeFileSync(path.join(dir, rel), text);
  w('settings.json', '{"maxActiveTasks":2}');
  w('tasks.json', '{"1":{"issue":1,"persistSplit":1}}');
  w('projectchats.json', '{"version":1,"holders":{}}');
  w('taskdata/tasks/1.json', '{"v":1,"key":"1","log":[],"messages":{}}');
  for (const rel of ['settings.json.bak', 'settings.json.bak.1', 'tasks.json.pre-split.bak', 'tasks.json.corrupt-20261123T145100Z',
    'projectchats.json.bad', 'taskdata/tasks/1.json.bad-123', 'taskdata/tasks/1.json.unadopted-x', 'taskdata/tasks/2.json.tmp',
    'tasks.json.tmp-s', 'projectchats.json.from-oct14-20261123', 'taskdata/projectchats.from-oct14-20261123/a.json',
    'upgrade/u.json', 'attachments/a.json', 'taskdata/tasks/1.json.legacy.bak']) w(rel, '{}');
}

test('liveFiles: the live JSON files only — no backups, quarantines, temp files, upgrade/ or attachments/', () => {
  const dir = tempDir('hfsmon-snapdata-');
  seedData(dir);
  assert.deepEqual(liveFiles(dir), ['projectchats.json', 'settings.json', 'taskdata/tasks/1.json', 'tasks.json']);
});

const snap = (name, status) => {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name);
  return { name, status, at: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) };
};

test('retentionPlan: 24 hourly, 14 daily, 8 weekly, the newest valid always; invalid and unchecked never push a good one out', () => {
  const list = [];
  // Hourly snapshots for 60 days, newest first.
  const start = new Date(2026, 10, 23, 12, 0, 0);
  for (let h = 0; h < 60 * 24; h++) list.push(snap(`${stampOf(new Date(start - h * 3600_000))}-hourly`, 'valid'));
  const kept = new Set(list.map((s) => s.name));
  for (const n of retentionPlan(list)) kept.delete(n);
  // 24 hours (the first day's are also its daily), +13 more days, + weeks beyond those days.
  assert.ok(kept.has(list[0].name), 'the newest');
  for (let h = 0; h < 24; h++) assert.ok(kept.has(list[h].name), `hour ${h}`);
  assert.ok(kept.size >= 24 + 13 && kept.size <= 24 + 13 + 8, `kept ${kept.size}`);
  const days = new Set([...kept].map((n) => n.slice(0, 8)));
  assert.ok(days.size >= 14);

  // Ten damaged snapshots on top: none of the good ones goes because of them.
  const bad = Array.from({ length: 30 }, (_, i) => snap(`${stampOf(new Date(+start + (i + 1) * 60_000))}-hourly`, 'invalid'));
  const unchecked = snap(`${stampOf(new Date(+start + 3600_000))}-hourly`, 'unchecked');
  const mixed = [unchecked, ...bad.reverse(), ...list];
  const drop = new Set(retentionPlan(mixed));
  for (const name of kept) assert.ok(!drop.has(name), `${name} pushed out by damaged ones`);
  assert.ok(!drop.has(unchecked.name), 'an unchecked snapshot is never deleted');
  assert.equal(mixed.filter((s) => s.status === 'invalid' && !drop.has(s.name)).length, 10, 'only the newest 10 damaged ones stay');

  // Only damaged snapshots and one old good one: the good one stays, whatever its age.
  const lone = [...bad, snap('20250101-000000-boot', 'valid')];
  assert.ok(!retentionPlan(lone).includes('20250101-000000-boot'));
});

test('takeSnapshot: hard links of the live files, checked in a worker; a later save does not change the snapshot', async () => {
  seedData(DATA_DIR);
  const r = snaps.takeSnapshot('manual');
  assert.ok(r, 'enabled by HFSMON_SNAPSHOT_DIR');
  assert.equal(r.files, 4);
  const manifest = await r.checked;
  assert.equal(manifest.valid, true);
  assert.equal(manifest.files, 4);
  const inSnap = path.join(r.dir, 'data', 'settings.json');
  assert.equal(statSync(inSnap).nlink, 2, 'a hard link, not a copy');
  // The board saves: a new file renamed over the name. The snapshot keeps the old bytes.
  writeDurableSync(path.join(DATA_DIR, 'settings.json'), '{"maxActiveTasks":3}');
  assert.equal(readFileSync(inSnap, 'utf8'), '{"maxActiveTasks":2}');
  assert.deepEqual(readdirSync(path.join(r.dir, 'data')).sort(), ['projectchats.json', 'settings.json', 'taskdata', 'tasks.json']);
  assert.equal(listSnapshots(SNAP).find((s) => s.dir === r.dir).status, 'valid');
});

test('takeSnapshotAsync (the hourly one) takes the same files without holding the loop', async () => {
  const r = await snaps.takeSnapshotAsync('hourly');
  assert.equal(r.files, 4);
  assert.equal((await r.checked).valid, true);
  assert.equal(statSync(path.join(r.dir, 'data', 'taskdata', 'tasks', '1.json')).nlink, 3, 'linked (live + the two snapshots)');
});

test('a snapshot that finds a damaged file is kept as invalid, reported, and the good ones stay', async () => {
  const good = snaps.takeSnapshot('manual');
  await good.checked;
  writeFileSync(path.join(DATA_DIR, 'tasks.json'), Buffer.alloc(300, 0));
  const r = snaps.takeSnapshot('hourly');
  const manifest = await r.checked;
  assert.equal(manifest.valid, false);
  assert.deepEqual(manifest.problems.map((p) => p.rel), ['tasks.json']);
  assert.match(manifest.problems[0].problem, /300 zero bytes/);
  const item = dataHealth().find((h) => /damaged data files/.test(h.problem));
  assert.ok(item, JSON.stringify(dataHealth()));
  assert.equal(listSnapshots(SNAP).find((s) => s.dir === good.dir).status, 'valid', 'the good one is untouched');
  writeFileSync(path.join(DATA_DIR, 'tasks.json'), '{"1":{"issue":1,"persistSplit":1}}');
});

test('prune applies retention to the snapshot folder', async () => {
  const root = SNAP;
  const before = listSnapshots(root).length;
  // 30 more valid hourly snapshots, one per hour back in time.
  const base = new Date(2026, 0, 10, 12, 0, 0);
  for (let h = 0; h < 30; h++) {
    snaps.snapshotHooks.now = () => new Date(+base - h * 3600_000);
    await snaps.takeSnapshot('hourly').checked;
  }
  snaps.snapshotHooks.now = realNow;
  await snaps.prune(root);
  const after = listSnapshots(root);
  assert.ok(after.length < before + 30, `${after.length} left of ${before + 30}`);
  assert.ok(after.some((s) => s.status === 'invalid'), 'the damaged one is kept (fewer than 10)');
  assert.ok(after.filter((s) => s.status === 'valid').length >= 24);
});

test('off-site: one archive a day of a good snapshot, written whole, the last 7 kept; off by default', async () => {
  const r = snaps.takeSnapshot('manual');
  await r.checked;
  assert.equal(await snaps.offsite(r.dir), null, 'no backup.offsiteDir: nothing');

  const off = tempDir('hfsmon-offsite-');
  config.backup = { offsiteDir: off };
  const file = await snaps.offsite(r.dir);
  assert.ok(file && statSync(file).size > 0, 'a real archive with the system tar');
  assert.equal(await snaps.offsite(r.dir), null, 'one a day');

  let n = 0;
  snaps.snapshotHooks.archive = async (tmp) => { writeFileSync(tmp, `archive ${++n}`); return 0; };
  for (let d = 1; d <= 9; d++) {
    snaps.snapshotHooks.now = () => new Date(2027, 0, d, 3, 0, 0);
    await snaps.offsite(r.dir);
  }
  const names = readdirSync(off).sort();
  assert.equal(names.length, 7, names.join(', '));
  assert.ok(names.at(-1).startsWith('hfs-monitor-data-20270109'));
  assert.ok(!names.some((x) => x.endsWith('.partial')));

  snaps.snapshotHooks.archive = async () => 2;     // the archiver fails
  snaps.snapshotHooks.now = () => new Date(2027, 0, 20, 3, 0, 0);
  assert.equal(await snaps.offsite(r.dir), null);
  assert.ok(dataHealth().some((h) => /off-site copy/.test(h.problem)));
  assert.equal(readdirSync(off).filter((x) => x.includes('20270120')).length, 0, 'no half archive left');
  snaps.snapshotHooks.archive = realArchive;
  snaps.snapshotHooks.now = realNow;
  delete config.backup;
});

test('the start-up snapshot holds the data as the last run left it, before the boot converts or moves anything', () => {
  const dir = tempDir('hfsmon-snapboot-');
  const snapDir = tempDir('hfsmon-snapboot-out-');
  const legacy = JSON.stringify({ 1: { issue: 1, title: 't1', labels: [], url: 'x', state: 'pr_draft', log: [{ ts: 'x', phase: 'p', line: 'old' }], chats: [] } });
  writeFileSync(path.join(dir, 'tasks.json'), legacy);
  writeFileSync(path.join(dir, 'settings.json'), Buffer.alloc(64, 0));   // will be moved aside at boot
  const r = spawnSync(process.execPath, [path.join(HERE, 'data-boot-child.mjs')], {
    env: { ...process.env, HFSMON_DATA_DIR: dir, HFSMON_SNAPSHOT_DIR: snapDir, HFSMON_PERSIST_DELAY_MS: '60000', HFSMON_SWEEP_INTERVAL_MS: '0' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const [boot] = listSnapshots(snapDir);
  assert.equal(boot.reason, 'boot');
  assert.equal(readFileSync(path.join(boot.dir, 'data', 'tasks.json'), 'utf8'), legacy, 'the old format, before the conversion');
  assert.ok(readFileSync(path.join(boot.dir, 'data', 'settings.json')).every((b) => b === 0), 'the damaged file as it was');
  assert.notEqual(readFileSync(path.join(dir, 'tasks.json'), 'utf8'), legacy, 'while the live one was converted');
});

/** Runs the restore tool in-process, capturing what it prints. */
async function tool(args, opts = {}) {
  const out = [];
  const code = await restore.main([...args, '--dir', SNAP], { log: (l) => out.push(l), err: (l) => out.push(l), root: tempDir('hfsmon-restore-root-'), ...opts });
  return { code, text: out.join('\n') };
}

test('restore tool: list, restore into a new folder, never over an existing one', async () => {
  const listed = await tool(['list']);
  assert.equal(listed.code, 0);
  assert.match(listed.text, /valid/);
  assert.match(listed.text, /invalid/);

  const cwd = tempDir('hfsmon-restore-cwd-');
  const r = await tool(['restore', 'latest'], { cwd });
  assert.equal(r.code, 0, r.text);
  const latest = listSnapshots(SNAP).find((s) => s.status === 'valid');
  const to = path.join(cwd, `restored-${latest.name}`);
  assert.ok(existsSync(path.join(to, 'tasks.json')));
  assert.ok(existsSync(path.join(to, 'taskdata', 'tasks', '1.json')));
  assert.equal(statSync(path.join(to, 'settings.json')).nlink, 1, 'a copy: editing it never touches the snapshot');

  const again = await tool(['restore', 'latest'], { cwd });
  assert.equal(again.code, 1);
  assert.match(again.text, /not empty/);

  const invalid = listSnapshots(SNAP).find((s) => s.status === 'invalid');
  const refused = await tool(['restore', invalid.name, '--to', path.join(cwd, 'x')]);
  assert.equal(refused.code, 1);
  assert.match(refused.text, /--allow-invalid/);
});

test('restore tool --into-data: refused while the port answers; otherwise every replaced file is moved aside first', async () => {
  const latest = listSnapshots(SNAP).find((s) => s.status === 'valid');
  const data = tempDir('hfsmon-restore-data-');
  writeFileSync(path.join(data, 'tasks.json'), '{"current":true}');
  writeFileSync(path.join(data, 'other.json'), '{"untouched":true}');

  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const busy = await tool(['restore', latest.name, '--into-data', '--data', data, '--port', String(srv.address().port)]);
  assert.equal(busy.code, 1);
  assert.match(busy.text, /stop the board/);
  assert.equal(readFileSync(path.join(data, 'tasks.json'), 'utf8'), '{"current":true}', 'nothing touched');
  const freePort = srv.address().port;
  await new Promise((r) => srv.close(r));

  const ok = await tool(['restore', latest.name, '--into-data', '--data', data, '--port', String(freePort)]);
  assert.equal(ok.code, 0, ok.text);
  const aside = readdirSync(data).find((n) => n.startsWith('.pre-restore-'));
  assert.ok(aside, readdirSync(data).join(', '));
  assert.equal(readFileSync(path.join(data, aside, 'tasks.json'), 'utf8'), '{"current":true}', 'the replaced file is kept');
  assert.equal(readFileSync(path.join(data, 'tasks.json'), 'utf8'), readFileSync(path.join(latest.dir, 'data', 'tasks.json'), 'utf8'));
  assert.equal(readFileSync(path.join(data, 'other.json'), 'utf8'), '{"untouched":true}', 'a file the snapshot lacks is left alone');
});

test('a board on another data folder takes no snapshot unless told where', async () => {
  const saved = process.env.HFSMON_SNAPSHOT_DIR;
  delete process.env.HFSMON_SNAPSHOT_DIR;
  try {
    assert.equal(snaps.snapshotRoot(), null, 'HFSMON_DATA_DIR set (a test): never the real %LOCALAPPDATA%');
    assert.equal(snaps.takeSnapshot('manual'), null);
  } finally {
    process.env.HFSMON_SNAPSHOT_DIR = saved;
  }
});
