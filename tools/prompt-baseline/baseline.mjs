#!/usr/bin/env node
/**
 * The prompt baseline: freeze what `server/prompts/` produces today, and dump
 * it so a before/after can be diffed with `diff -r`.
 *
 * Usage
 * -----
 *   node tools/prompt-baseline/baseline.mjs freeze
 *       Re-reads `server/data/tasks.json` ONCE and rewrites
 *       `server/test/fixtures/prompt-baseline/`. Manual, run by the session —
 *       never by a test, and never in CI: that file is gitignored, 44 MB, and
 *       is a different file on the runner.
 *
 *   node tools/prompt-baseline/baseline.mjs freeze --from-fixture
 *       Same rewrite, but the tasks come from the existing `baseline.json`
 *       instead of `tasks.json` (which a worktree does not have). Same tasks,
 *       so the resulting diff is only the prompt text.
 *
 *   Either form takes `--fixture <dir>` to freeze into (and, with
 *   `--from-fixture`, read the tasks from) another directory, such as a
 *   temporary copy, instead of the checked-in fixture.
 *
 *   node tools/prompt-baseline/baseline.mjs dump --out <dir> [--real]
 *       Writes one file per (template, task) pair at
 *       `<dir>/<template>/<issue>.md`, rendering from the fixture, never from
 *       the store. `--out` is required and must be OUTSIDE this repository, so
 *       a dump never lands in a commit. With `--real`, `projectContext` keeps
 *       its live value instead of the sentinel, so the injected block can be
 *       read; without it the output matches the fixture exactly.
 *
 * The check it enables: dump before the change, dump after, `diff -r` the two
 * directories, and the only difference must be the inserted block.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// Pure (only node:*): puts a task's log back when the board has split it into taskdata/.
import { readTasksFileMerged } from '../../server/src/splitfmt.js';

// `config.js` is imported for `DATA_DIR` alone (it honours `HFSMON_DATA_DIR`).
// It is safe: it reads `config.json`, unrefs its watchers, and writes nothing.
// It stays in the CLI and out of `lib.mjs`, which the test imports.
import { DATA_DIR } from '../../server/src/config.js';
import {
  BASELINE_FILE,
  FIXTURE_DIR,
  LIVE_IN_DUMP,
  REPO_ROOT,
  TEMPLATES,
  fixtureEntries,
  freezeFixture,
  normalize,
  readBaseline,
  renderFor,
  sortedEntries,
  taskEntry,
} from './lib.mjs';

const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, normalize(text), 'utf8');
};

const die = (message) => {
  console.error(message);
  process.exit(1);
};

/** The tasks, read as plain JSON. `store.js` is never imported: it rewrites the board. */
function readTasks() {
  let data;
  try {
    data = readTasksFileMerged(TASKS_FILE);
  } catch (e) {
    die(`No se puede leer ${TASKS_FILE}: ${e.message}`);
  }
  const list = Array.isArray(data) ? data : Object.values(data);
  const entries = list.map(taskEntry).filter((t) => Number.isFinite(t.issue));
  if (!entries.length) die(`${TASKS_FILE} no trae ninguna tarea con número de issue`);
  return sortedEntries(entries);
}

function freeze(argv) {
  // `--from-fixture`: the task list is the one already frozen, so a worktree
  // with no `server/data/tasks.json` can re-freeze after a template change and
  // the diff shows only the text, never a different set of tasks.
  // `--fixture <dir>` freezes into another directory (a copy, in a test)
  // instead of the checked-in fixture; `--from-fixture` then reads its tasks.
  const at = argv.indexOf('--fixture');
  if (at >= 0 && !argv[at + 1]) die('--fixture necesita un directorio');
  const dir = at >= 0 ? path.resolve(argv[at + 1]) : FIXTURE_DIR;

  let entries;
  if (argv.includes('--from-fixture')) {
    try {
      entries = fixtureEntries(readBaseline(path.join(dir, path.basename(BASELINE_FILE))).tasks);
    } catch (e) {
      die(e.message);
    }
  } else {
    entries = readTasks();
  }

  // The render, the swap and its rollback live in `lib.mjs`, where a test can
  // reach them: this file runs its CLI on import.
  const { pairs, samples, contracts } = freezeFixture({ entries, dir });

  console.log(`Congelados ${pairs} pares (${TEMPLATES.length} plantillas x ${entries.length} tareas).`);
  console.log(`Muestras completas: issues ${samples.join(', ')} (${samples.length * TEMPLATES.length} archivos).`);
  console.log(`Contratos: ${contracts}.`);
  console.log(`Fixture: ${dir}`);
}

/** Refuses an output directory inside the repo: a dump must never be commitable. */
function checkOut(out) {
  const target = path.resolve(out);
  const rel = path.relative(REPO_ROOT, target);
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (inside) die(`--out ${target} está dentro del repositorio. Elige un directorio fuera de ${REPO_ROOT}.`);
  return target;
}

function dump(argv) {
  const real = argv.includes('--real');
  const at = argv.indexOf('--out');
  if (at < 0 || !argv[at + 1]) die('dump necesita --out <dir> (un directorio FUERA del repositorio)');
  const out = checkOut(argv[at + 1]);

  const baseline = readBaseline();
  const entries = sortedEntries(Object.values(baseline.tasks));
  const live = real ? LIVE_IN_DUMP : [];

  let pairs = 0;
  for (const template of baseline.templates) {
    for (const entry of entries) {
      write(path.join(out, template, `${entry.issue}.md`), renderFor(entry, template, { live }));
      pairs += 1;
    }
  }
  console.log(`Escritos ${pairs} archivos en ${out}${real ? ' (con projectContext real)' : ''}.`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'freeze') freeze(rest);
else if (command === 'dump') dump(rest);
else die('Uso: baseline.mjs freeze [--from-fixture] [--fixture <dir>] | baseline.mjs dump --out <dir fuera del repo> [--real]');
