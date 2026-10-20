#!/usr/bin/env node
/**
 * Subagent share per phase, read-only: of the tool calls the board's sessions
 * made, how many were subagents?
 *
 * Usage
 * -----
 *   node tools/metrics/subagents.mjs <data-dir> [--json]
 *   npm run metrics:subagents -- <data-dir> [--json]
 *
 * `<data-dir>` is the board's `server/data` (or any copy), read with plain
 * `JSON.parse` (`tasks.json` plus every `tasks.<project>.json`); the board's
 * store module is never loaded, because loading it rewrites the live
 * `tasks.json`. The numbers are `aggregate().subagents` of `server/src/metrics.js`,
 * the same as the metrics dialog shows. Exit 1 on a bad argument or an unreadable
 * directory or file.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
// Pure (only node:*): puts a task's log back when the board has split it into taskdata/.
import { readTasksFileMerged } from '../../server/src/splitfmt.js';
import { aggregate } from '../../server/src/metrics.js';

const TASKS_FILE_RE = /^tasks(\.[a-z0-9][a-z0-9-]*)?\.json$/;
// The store ignores this old file of the default project; reading it would count its tasks twice.
const IGNORED_FILE = 'tasks.hfs.json';
const USAGE = 'Usage: node tools/metrics/subagents.mjs <data-dir> [--json]';

const die = (message) => {
  console.error(message);
  process.exit(1);
};

const pct = (share) => (share == null ? '—' : `${Math.round(share * 1000) / 10} %`);

function table(title, map) {
  const rows = Object.entries(map).sort((a, b) => b[1].calls - a[1].calls || a[0].localeCompare(b[0]));
  const lines = [`${title}`, `${'name'.padEnd(18)}${'sessions'.padStart(9)}${'calls'.padStart(8)}${'subagents'.padStart(11)}${'share'.padStart(9)}${'nudges'.padStart(8)}${'nudge ms'.padStart(10)}`];
  for (const [name, e] of rows) {
    lines.push(`${name.padEnd(18)}${String(e.sessions).padStart(9)}${String(e.calls).padStart(8)}${String(e.subagents).padStart(11)}${pct(e.share).padStart(9)}${String(e.nudges).padStart(8)}${String(e.nudgeMs).padStart(10)}`);
  }
  return lines.join('\n');
}

let dir = null;
let asJson = false;
for (const a of process.argv.slice(2)) {
  if (a === '--json') asJson = true;
  else if (a.startsWith('--') || dir !== null) die(USAGE);
  else dir = a;
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
    const data = readTasksFileMerged(path.join(dir, f));
    return (Array.isArray(data) ? data : Object.values(data ?? {})).filter((t) => t && typeof t === 'object' && Array.isArray(t.timings));
  } catch (e) {
    if (e instanceof SyntaxError) die(`${f} changed while reading (the board may be writing it): ${e.message}. Retry.`);
    return die(`Cannot read ${f}: ${e.message}`);
  }
};
const { subagents } = aggregate(files.flatMap(load));

if (asJson) {
  process.stdout.write(`${JSON.stringify(subagents, null, 2)}\n`);
} else {
  process.stdout.write(`${[
    table('Total', { all: subagents.total }),
    table('Per phase', subagents.phases),
    table('Per stage', subagents.stages),
    table('Chat turns', { chat: subagents.chat }),
  ].join('\n\n')}\n`);
}
