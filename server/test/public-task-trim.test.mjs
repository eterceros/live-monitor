import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The state the board sends to every open page (`publicTask` in index.js) leaves
 * out the plans only the pipeline reads: with hundreds of finished tasks they
 * were a fifth of a 14 MB payload that blocks the server while it is built.
 * The guard is two-sided: they stay out of `publicTask`, and nothing in the web
 * reads them — the day a page needs one, this test says to send it again
 * (or better, to fetch it on demand) instead of the page silently showing nothing.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TRIMMED = ['advisorPlan', 'triagePlan', 'triageSummary'];

function* sources(dir) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) yield* sources(file);
    else if (/\.(jsx?|mjs)$/.test(name)) yield file;
  }
}

test('publicTask no envía los planes que solo lee el pipeline', () => {
  const src = readFileSync(path.join(ROOT, 'server', 'src', 'index.js'), 'utf8');
  for (const key of TRIMMED) assert.match(src, new RegExp(`\\n\\s+${key}: undefined,`), `${key} sale del estado`);
});

test('ninguna pantalla de la web lee los planes recortados', () => {
  const readers = [];
  for (const file of sources(path.join(ROOT, 'web', 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const key of TRIMMED) if (new RegExp(`\\b${key}\\b`).test(text)) readers.push(`${path.relative(ROOT, file)}: ${key}`);
  }
  assert.deepEqual(readers, [], 'si una pantalla los necesita, hay que enviarlos (o pedirlos al abrir) y quitarlos de TRIMMED');
});
