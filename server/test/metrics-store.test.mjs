// task.timings in the store: default on new tasks, backfill and orphan closing
// for old ones, and persistence without a broadcast.
import './isolate.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './isolate.mjs';
import { store } from '../src/store.js';
import { migrateTask } from '../src/mode.js';
import { parkForQuota, clearQuotaPark } from '../src/quota.js';
import { begin, end, record, summarize, metricsHooks } from '../src/metrics.js';

const mk = (n) =>
  store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const onDisk = () => JSON.parse(readFileSync(path.join(DATA_DIR, 'tasks.json'), 'utf8'));

test('a new task starts with an empty timings array', () => {
  assert.deepEqual(mk(920001).timings, []);
});

test('an old task without timings is backfilled and renders a summary', () => {
  const old = { issue: 1, state: 'done', log: [], updatedAt: new Date().toISOString() };
  migrateTask(old);
  assert.deepEqual(old.timings, []);
  const sm = summarize(old);
  assert.equal(sm.cycle, 1);
  assert.equal(sm.runMs, 0);
  assert.equal(old.metricsCycle, 1);
});

test('migrateTask numbers the cycles of an old reopened task once', () => {
  const sp = (name, start, cycle) => ({ kind: 'phase', name, startedAt: start, endedAt: start, ms: 0, attempt: 1, outcome: 'ok', meta: { cycle } });
  const t = {
    issue: 3, state: 'done', log: [], updatedAt: '2026-01-03T00:00:00.000Z', cycleStartedAt: null,
    timings: [sp('fixing', '2026-01-01T00:00:00.000Z', null), sp('fixing', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'), sp('demo', '2026-01-02T06:00:00.000Z', null)],
  };
  migrateTask(t);
  assert.deepEqual(t.timings.map((s) => s.meta.cycle), [1, 2, 2]);
  migrateTask(t);
  assert.equal(t.metricsCycle, 2);
});

test('migrateTask closes an open span at the task last update, as interrupted', () => {
  const t = {
    issue: 2,
    state: 'fixing',
    log: [],
    updatedAt: '2026-01-01T00:10:00.000Z',
    timings: [{ kind: 'phase', name: 'fixing', startedAt: '2026-01-01T00:00:00.000Z', endedAt: null, ms: null, attempt: 1, outcome: null, meta: {} }],
  };
  migrateTask(t);
  assert.equal(t.timings[0].outcome, 'interrupted');
  assert.equal(t.timings[0].endedAt, '2026-01-01T00:10:00.000Z');
  assert.equal(t.timings[0].ms, 600000);
  migrateTask(t);
  assert.equal(t.timings.length, 1, 'idempotent');
});

test('spans are written to disk without a task broadcast or an updatedAt bump', async () => {
  const t = mk(920003);
  const before = t.updatedAt;
  let pushed = 0;
  const on = () => { pushed += 1; };
  store.on('task', on);
  try {
    const s = begin(t, { kind: 'phase', name: 'triage' });
    end(t, s);
    record(t, { kind: 'wait', name: 'quota_park', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:01:00.000Z' });
    await store.flushAsync();   // the 3 s write window, driven by hand
  } finally {
    store.off('task', on);
  }
  assert.equal(pushed, 0);
  assert.equal(t.updatedAt, before);
  const saved = onDisk()['920003'].timings;
  assert.deepEqual(saved.map((x) => x.name), ['triage', 'quota_park']);
  assert.equal(saved[1].ms, 60000);
});

test('an open span written to disk is closed as interrupted on the next load', async () => {
  const t = mk(920004);
  begin(t, { kind: 'phase', name: 'fixing' });
  await store.flushAsync();   // the 3 s write window, driven by hand
  const reloaded = onDisk()['920004'];
  assert.equal(reloaded.timings[0].endedAt, null);
  migrateTask(reloaded);
  assert.equal(reloaded.timings[0].outcome, 'interrupted');
});

test('a task parked by quota keeps its park across a reload and records the wait on resume', async () => {
  const t = mk(920005);
  parkForQuota(t, { resumeFrom: 'fixing' });
  t.quotaPark.since = '2026-10-05T10:00:00.000Z';
  store.touch(t);
  await store.flushAsync();   // the 3 s write window, driven by hand
  const reloaded = onDisk()['920005'];
  migrateTask(reloaded);
  assert.equal(reloaded.quotaPark.since, '2026-10-05T10:00:00.000Z');
  const prev = metricsHooks.now;
  metricsHooks.now = () => Date.parse('2026-10-05T10:05:00.000Z');
  try {
    assert.equal(clearQuotaPark(reloaded), true);
  } finally {
    metricsHooks.now = prev;
  }
  const w = reloaded.timings.find((s) => s.name === 'quota_park');
  assert.equal(w.ms, 300_000);
  assert.equal(w.startedAt, '2026-10-05T10:00:00.000Z');
  assert.equal(w.meta.cycle, reloaded.metricsCycle);
  assert.equal(w.meta.resumeFrom, 'fixing');
  clearQuotaPark(t);
});
