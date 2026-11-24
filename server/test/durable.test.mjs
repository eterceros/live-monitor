import './isolate.mjs';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './teardown.mjs';
import {
  durableHooks, writeDurableSync, writeDurable, readJsonDurable, generationPath, isAllNul, quarantine,
  markGood, isKnownGood, _forgetKnownForTests,
} from '../src/durable.js';

// What a power cut leaves where the data never reached the disk: the right size, all zeros.
const zeros = (n) => Buffer.alloc(n, 0);
const realOps = { ...durableHooks.ops };
afterEach(() => { durableHooks.ops = { ...realOps }; });

/** Wraps every operation so the test sees their order. */
function recordOps() {
  const seen = [];
  const ops = {};
  for (const [name, fn] of Object.entries(realOps)) {
    ops[name] = (...a) => {
      const label = typeof a[0] === 'string' ? path.basename(a[0]) : '';
      const target = name === 'renameSync' || name === 'linkSync' ? `->${path.basename(a[1])}` : '';
      seen.push(`${name}${label ? ` ${label}` : ''}${target}`);
      return fn(...a);
    };
  }
  // The async handle's own sync/close are what count on that path.
  ops.open = async (...a) => {
    seen.push(`open ${path.basename(a[0])}`);
    const fh = await realOps.open(...a);
    return {
      writeFile: (...b) => { seen.push('fh.write'); return fh.writeFile(...b); },
      sync: () => { seen.push('fh.sync'); return fh.sync(); },
      close: () => { seen.push('fh.close'); return fh.close(); },
    };
  };
  durableHooks.ops = ops;
  return seen;
}

test('writeDurableSync: the data is fsynced before the rename makes it the file', () => {
  const f = path.join(tempDir('hfsmon-durable-'), 'settings.json');
  const seen = recordOps();
  writeDurableSync(f, '{"a":1}');
  const at = (prefix) => seen.findIndex((s) => s.startsWith(prefix));
  assert.ok(at('fsyncSync') > at('writeSync'), seen.join(' | '));
  assert.ok(at('closeSync') > at('fsyncSync'), seen.join(' | '));
  assert.ok(at('renameSync settings.json.tmp-s->settings.json') > at('closeSync'), seen.join(' | '));
  assert.equal(readFileSync(f, 'utf8'), '{"a":1}');
  assert.equal(existsSync(`${f}.tmp-s`), false);
});

test('writeDurable (async): fh.sync before close before rename; a dropped write leaves nothing', async () => {
  const f = path.join(tempDir('hfsmon-durable-'), 'tasks.json');
  const seen = recordOps();
  assert.equal(await writeDurable(f, ['{"x"', ':1}']), true);
  const order = seen.filter((s) => ['fh.sync', 'fh.close'].includes(s) || s.startsWith('renameSync tasks.json.tmp'));
  assert.deepEqual(order, ['fh.sync', 'fh.close', 'renameSync tasks.json.tmp->tasks.json']);
  assert.equal(readFileSync(f, 'utf8'), '{"x":1}');
  assert.equal(await writeDurable(f, ['{"y":2}'], { shouldCommit: () => false }), false);
  assert.equal(readFileSync(f, 'utf8'), '{"x":1}');
  assert.equal(existsSync(`${f}.tmp`), false);
});

test('a failing fsync never reaches the rename: the old file stays and no temp file is left', () => {
  const f = path.join(tempDir('hfsmon-durable-'), 'settings.json');
  writeFileSync(f, '{"old":true}');
  durableHooks.ops = { ...realOps, fsyncSync: () => { throw Object.assign(new Error('disk gone'), { code: 'EIO' }); } };
  assert.throws(() => writeDurableSync(f, '{"new":true}'), /disk gone/);
  assert.equal(readFileSync(f, 'utf8'), '{"old":true}');
  assert.equal(existsSync(`${f}.tmp-s`), false);
});

test('generations: hard links of the previous versions, newest in .bak; rotated only from a known-good file', () => {
  _forgetKnownForTests();
  const dir = tempDir('hfsmon-durable-');
  const f = path.join(dir, 'projects.json');
  writeFileSync(f, '"never read"');
  writeDurableSync(f, '1', { generations: 3 });
  assert.equal(existsSync(generationPath(f, 0)), false, 'a file this process never read is not taken for a good backup');
  writeDurableSync(f, '2', { generations: 3 });
  writeDurableSync(f, '3', { generations: 3 });
  writeDurableSync(f, '4', { generations: 3 });
  writeDurableSync(f, '5', { generations: 3 });
  assert.equal(readFileSync(f, 'utf8'), '5');
  assert.equal(readFileSync(generationPath(f, 0), 'utf8'), '4');
  assert.equal(readFileSync(generationPath(f, 1), 'utf8'), '3');
  assert.equal(readFileSync(generationPath(f, 2), 'utf8'), '2');
  assert.equal(existsSync(generationPath(f, 3)), false, 'no more than asked');
  assert.deepEqual(readdirSync(dir).filter((n) => n.includes('.tmp') || n.endsWith('.new')), []);
  // A hard link, not a copy: the backup is the previous inode, so a later write does not touch it.
  assert.equal(statSync(generationPath(f, 0)).nlink, 1, 'once renamed over, the old name no longer shares it');
});

test('isAllNul', () => {
  assert.equal(isAllNul(zeros(10)), true);
  assert.equal(isAllNul(Buffer.from('{}')), false);
  assert.equal(isAllNul(Buffer.alloc(0)), false);
});

test('readJsonDurable: a file of zeros is named as such, read from .bak, and moved aside', () => {
  const dir = tempDir('hfsmon-durable-');
  const f = path.join(dir, 'settings.json');
  writeFileSync(f, zeros(2157));
  writeFileSync(generationPath(f, 0), '{"maxActiveTasks":7}');
  const r = readJsonDurable(f, { generations: 3 });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.value, { maxActiveTasks: 7 });
  assert.equal(r.source, generationPath(f, 0));
  assert.match(r.problems[0].problem, /2157 zero bytes/);
  assert.equal(existsSync(f), false, 'the damaged file is no longer under the name the next write uses');
  assert.ok(r.keptAt && readFileSync(r.keptAt).equals(zeros(2157)), 'kept byte for byte');
});

test('readJsonDurable: skips damaged generations too, and fails without destroying anything', () => {
  const dir = tempDir('hfsmon-durable-');
  const f = path.join(dir, 'p.json');
  writeFileSync(f, '{"truncated":');
  writeFileSync(generationPath(f, 0), zeros(40));
  writeFileSync(generationPath(f, 1), '[1,2]');
  const ok = readJsonDurable(f, { generations: 3, aside: false });
  assert.equal(ok.status, 'ok');
  assert.deepEqual(ok.value, [1, 2]);
  assert.equal(ok.problems.length, 2);
  assert.equal(existsSync(f), true, 'aside: false leaves it in place');

  writeFileSync(generationPath(f, 1), '');
  const kept = readJsonDurable(f, { generations: 3, aside: 'recovered' });
  assert.equal(kept.status, 'failed');
  assert.equal(kept.keptAt, null);
  assert.equal(readFileSync(f, 'utf8'), '{"truncated":', "'recovered' does not move it when nothing was recovered");

  const failed = readJsonDurable(f, { generations: 3 });
  assert.equal(failed.status, 'failed');
  assert.equal(readFileSync(failed.keptAt, 'utf8'), '{"truncated":');
  assert.equal(readJsonDurable(path.join(dir, 'none.json')).status, 'missing');
});

test('readJsonDurable: validate rejects a shape; a good read marks the file known good', () => {
  _forgetKnownForTests();
  const f = path.join(tempDir('hfsmon-durable-'), 's.json');
  writeFileSync(f, '[]');
  const r = readJsonDurable(f, { validate: (v) => { if (Array.isArray(v)) throw new Error('not an object'); }, aside: false });
  assert.equal(r.status, 'failed');
  assert.match(r.problems[0].problem, /unexpected shape/);
  assert.equal(isKnownGood(f), false);
  writeFileSync(f, '{}');
  assert.equal(readJsonDurable(f).status, 'ok');
  assert.equal(isKnownGood(f), true);
});

test('quarantine never overwrites an earlier copy', () => {
  const dir = tempDir('hfsmon-durable-');
  const f = path.join(dir, 'x.json');
  writeFileSync(f, 'one');
  const a = quarantine(f);
  writeFileSync(f, 'two');
  const b = quarantine(f);
  assert.notEqual(a, b);
  assert.equal(readFileSync(a, 'utf8'), 'one');
  assert.equal(readFileSync(b, 'utf8'), 'two');
});

test('power cut emulated: the rename landed but the data did not; the previous generation is read', () => {
  _forgetKnownForTests();
  const f = path.join(tempDir('hfsmon-durable-'), 'tasks.json');
  writeDurableSync(f, '{"1":{"title":"first"}}', { generations: 1 });
  markGood(f);
  writeDurableSync(f, '{"1":{"title":"second"}}', { generations: 1 });
  // What NTFS can leave without the fsync: the new name, the new size, no data.
  writeFileSync(f, zeros(statSync(f).size));
  const r = readJsonDurable(f, { generations: 1 });
  assert.equal(r.status, 'ok');
  assert.equal(r.value['1'].title, 'first');
});
