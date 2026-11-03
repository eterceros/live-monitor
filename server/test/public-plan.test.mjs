import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicWorkPlan } from '../src/publicplan.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const step = (id, status) => ({
  id, what: `hacer ${id}`, files: ['a.rs'], dependsOn: [], check: 'cargo test', status, attempts: 2, extraRetries: 1,
  startedAt: '2026-11-01T00:00:00Z', endedAt: '2026-11-01T00:05:00Z',
  lastFailure: { kind: 'test', output: 'x\n'.repeat(50) }, summary: 's'.repeat(900),
});
const plan = (status) => ({
  id: 'p1', version: 2, feedback: 'más corto', status, text: '## Plan\n'.repeat(500), waves: [['t1'], ['t2']], selected: ['t1', 't2'],
  tasks: [step('t1', 'done'), step('t2', status === 'done' ? 'done' : 'running')],
});

test('un plan terminado sale con ids y estados: lo que cuenta la tarjeta, sin textos ni detalles', () => {
  const out = publicWorkPlan(plan('done'));
  assert.deepEqual(out, { id: 'p1', version: 2, feedback: null, status: 'done', slim: true, tasks: [{ id: 't1', status: 'done' }, { id: 't2', status: 'done' }] });
  assert.ok(JSON.stringify(out).length < 300, 'pesa unos cientos de bytes, no kilobytes');
});

test('un plan que se revisa, corre, para o falla sale entero como siempre', () => {
  for (const status of ['running', 'asking', 'stopped', 'failed', 'approved', 'pending']) {
    const src = plan(status);
    const out = publicWorkPlan(src);
    assert.equal(out.slim, undefined, status);
    assert.equal(out.text, src.text, `${status}: texto`);
    assert.deepEqual(out.waves, src.waves);
    assert.deepEqual(out.selected, src.selected);
    assert.equal(out.feedback, 'más corto');
    assert.equal(out.tasks[0].what, 'hacer t1');
    assert.equal(out.tasks[0].summary.length, 400, 'el resumen sigue cortado a 400');
    assert.equal(out.tasks[0].lastFailure.output.split('\n').length, 20, 'y la salida de un fallo a 20 líneas');
  }
});

test('index.js usa publicWorkPlan, y solo el diálogo del plan lee el texto, las olas y la selección', () => {
  assert.match(readFileSync(path.join(ROOT, 'server', 'src', 'index.js'), 'utf8'), /workPlan: t\.workPlan\?\.status \? publicWorkPlan\(t\.workPlan\) : null,/);
  const readers = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (statSync(file).isDirectory()) { walk(file); continue; }
      if (!/\.jsx?$/.test(name)) continue;
      const text = readFileSync(file, 'utf8');
      if (/workPlan\??\.(text|waves|selected)\b/.test(text)) readers.push(path.relative(ROOT, file).replaceAll('\\', '/'));
    }
  };
  walk(path.join(ROOT, 'web', 'src'));
  assert.deepEqual(readers, [], 'el diálogo recibe el plan entero por `plan={...}`; nada más lee esos campos');
  const app = readFileSync(path.join(ROOT, 'web', 'src', 'App.jsx'), 'utf8');
  assert.match(app, /kind === 'plan' && dialogTask\.workPlan && !dialogTask\.workPlan\.slim/, 'un plan recortado no abre el diálogo');
});
