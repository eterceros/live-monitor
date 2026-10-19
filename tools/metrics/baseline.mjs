#!/usr/bin/env node
/**
 * Metrics baseline, read-only: where does the time of finished tasks go?
 *
 * Usage
 * -----
 *   node tools/metrics/baseline.mjs <data-dir> [--out <file.md>]
 *
 * `<data-dir>` is the board's `server/data` (or any copy). It is read with
 * plain `JSON.parse`: `tasks.json` plus every `tasks.<project>.json`. The board's
 * own store module is never loaded, because loading it rewrites the live
 * `tasks.json`. `tasks.hfs.json` is skipped (the store ignores it too).
 * Nothing is written except `--out`, if given.
 *
 * Through npm the directory is mandatory and needs the `--` separator:
 *   npm run metrics:baseline -- <data-dir> [--out <file.md>]
 * Exit 1 with a message on a bad argument, an unreadable directory, no task
 * file, or a task file that changed while it was being read (retry).
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { summarize, tasksOf, toMarkdown } from './lib.mjs';
// Pure (only node:*): puts a task's log back when the board has split it into taskdata/.
import { readTasksFileMerged } from '../../server/src/splitfmt.js';

const TASKS_FILE_RE = /^tasks(\.[a-z0-9][a-z0-9-]*)?\.json$/;
// The store ignores this old file of the default project (its tasks live in
// `tasks.json`), so reading it here would count them twice.
const IGNORED_FILE = 'tasks.hfs.json';

const die = (message) => {
  console.error(message);
  process.exit(1);
};

const USAGE = 'Usage: node tools/metrics/baseline.mjs <data-dir> [--out <file.md>]';

// Left to right: `--out` consumes the next argument, the first other argument
// is the directory, anything else is a usage error.
let dir = null;
let out = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--out') {
    out = args[i + 1];
    if (!out || out.startsWith('--')) die('--out needs a file');
    i += 1;
  } else if (a.startsWith('--') || dir !== null) {
    die(USAGE);
  } else {
    dir = a;
  }
}
if (dir === null) die(USAGE);

let files;
try {
  files = readdirSync(dir).filter((f) => TASKS_FILE_RE.test(f) && f !== IGNORED_FILE);
} catch (e) {
  die(`Cannot read ${dir}: ${e.message}`);
}
if (!files.length) die(`No tasks.json in ${dir}`);

const load = (f) => {
  try {
    return tasksOf(readTasksFileMerged(path.join(dir, f)));
  } catch (e) {
    if (e instanceof SyntaxError) die(`${f} changed while reading (the board may be writing it): ${e.message}. Retry.`);
    return die(`Cannot read ${f}: ${e.message}`);
  }
};
const tasks = files.flatMap(load);
const text = toMarkdown(summarize(tasks), {
  source: `${files.length} task file(s)`,
  generatedAt: new Date().toISOString().slice(0, 10),
});

if (out) {
  writeFileSync(out, text, 'utf8');
  console.error(`Wrote ${out}`);
} else {
  process.stdout.write(text);
}
