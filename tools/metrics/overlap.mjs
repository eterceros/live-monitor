#!/usr/bin/env node
/**
 * Overlap report, read-only: how much did running independent steps side by
 * side save, per task and cycle?
 *
 * Usage
 * -----
 *   node tools/metrics/overlap.mjs <data-dir> [--json]
 *
 * `<data-dir>` is the board's `server/data` (or any copy). It is read with
 * plain `JSON.parse`: `tasks.json` plus every `tasks.<project>.json`. The
 * board's own store module is never loaded, because loading it rewrites the
 * live `tasks.json`; only `server/src/metrics.js` is imported, which is pure.
 * Nothing is written. Exit 1 with a message on a bad argument or an unreadable
 * directory.
 *
 * Per task and cycle it prints wallMs, runMs and activeMs (from `summarize`),
 * the time spent in the triage / pr / demo phases, every `step` span, and
 * "sum - union" of the steps: the time that ran concurrently with another step.
 * It also reports, separately, the install that ran during the triage and the
 * demo that ran during the PR, each intersected with its phase span.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
// Pure (only node:*): puts a task's log back when the board has split it into taskdata/.
import { readTasksFileMerged } from '../../server/src/splitfmt.js';
import { pathToFileURL } from 'node:url';
import { summarize } from '../../server/src/metrics.js';

const TASKS_FILE_RE = /^tasks(\.[a-z0-9][a-z0-9-]*)?\.json$/;
// The store ignores this old file of the default project, so reading it would
// count its tasks twice.
const IGNORED_FILE = 'tasks.hfs.json';
const PHASES_OF_INTEREST = ['triage', 'pr', 'demo'];

const cycleOf = (s) => (Number.isInteger(s.meta?.cycle) ? s.meta.cycle : 1);

/** [start, end] in ms of a closed span; null for an open or unparsable one. */
function intervalOf(s) {
  const a = Date.parse(s.startedAt);
  const b = Date.parse(s.endedAt ?? '');
  return Number.isNaN(a) || Number.isNaN(b) ? null : [a, b];
}

/** Total length of the union of intervals. */
function unionMs(intervals) {
  const sorted = [...intervals].sort((x, y) => x[0] - y[0]);
  let total = 0;
  let edge = -Infinity;
  for (const [a, b] of sorted) {
    const start = Math.max(a, edge);
    if (b > start) total += b - start;
    edge = Math.max(edge, b);
  }
  return total;
}

/** Length of the part of `[a, b]` covered by the union of `phases`. */
function coveredMs([a, b], phases) {
  const clipped = phases
    .map(([x, y]) => [Math.max(a, x), Math.min(b, y)])
    .filter(([x, y]) => y > x);
  return unionMs(clipped);
}

/**
 * Time the steps picked by `pick` ran inside a phase span named `phase` of the
 * same cycle: the work the overlap moved into a phase that was open anyway.
 */
function stepsInPhaseMs(mine, pick, phase) {
  const phases = mine.filter((s) => s.kind === 'phase' && s.name === phase).map(intervalOf).filter(Boolean);
  const inside = mine
    .filter((s) => s.kind === 'step' && pick(s))
    .map(intervalOf)
    .filter(Boolean)
    .map((i) => coveredMs(i, phases));
  return inside.reduce((m, n) => m + n, 0);
}

/**
 * The overlap figures of one task, one row per cycle that has spans.
 * `stepsSumMs - stepsUnionMs` is the time a step ran next to another step.
 * `installVsTriageMs` and `demoVsPrMs` are the two overlaps the board creates
 * on purpose, each measured against the phase it runs beside: the triage is a
 * phase, not a step, so the first one never shows up in the step-vs-step figure.
 */
export function overlapReport(task) {
  const spans = Array.isArray(task?.timings) ? task.timings : [];
  const current = Number.isInteger(task?.metricsCycle) ? task.metricsCycle : 1;
  const cycles = [...new Set(spans.map(cycleOf))].sort((a, b) => a - b);
  return cycles.map((cycle) => {
    const mine = spans.filter((s) => cycleOf(s) === cycle);
    // `summarize` reads one cycle: the task's current one. Ask it for this one.
    const sum = summarize({ ...task, metricsCycle: cycle });
    const all = mine.map(intervalOf).filter(Boolean);
    // Only the current cycle has a recorded start; for the others the extent of
    // their own spans is the best a read-only tool can say.
    const wallMs = cycle === current
      ? sum.wallMs
      : (all.length ? Math.max(...all.map((i) => i[1])) - Math.min(...all.map((i) => i[0])) : null);
    const steps = mine
      .filter((s) => s.kind === 'step')
      .map((s) => ({ name: s.name, when: s.meta?.when ?? null, overlap: s.meta?.overlap === true, outcome: s.outcome ?? null, ms: s.ms ?? null, interval: intervalOf(s) }));
    const closed = steps.map((s) => s.interval).filter(Boolean);
    const stepsSumMs = closed.reduce((m, [a, b]) => m + (b - a), 0);
    const stepsUnionMs = unionMs(closed);
    return {
      issue: task.issue ?? null,
      project: task.project ?? null,
      cycle,
      wallMs,
      runMs: sum.runMs,
      activeMs: sum.activeMs,
      phases: Object.fromEntries(PHASES_OF_INTEREST.map((p) => [p, sum.byPhase[p]?.ms ?? null])),
      steps: steps.map(({ interval, ...rest }) => rest),
      stepsSumMs,
      stepsUnionMs,
      overlapMs: stepsSumMs - stepsUnionMs,
      installVsTriageMs: stepsInPhaseMs(mine, (s) => s.name === 'prepare_dependencies' && s.meta?.when === 'during_triage', 'triage'),
      demoVsPrMs: stepsInPhaseMs(mine, (s) => s.name === 'demo_steps' && s.meta?.overlap === true, 'pr'),
      // Spans the board evicted at its cap: session and step spans go first
      // (`trim` in metrics.js), so a long task reads low.
      droppedSpans: sum.dropped?.n ?? 0,
    };
  });
}

const fmt = (ms) => (ms == null ? '-' : `${(ms / 1000).toFixed(1)}s`);

export function toText(rows) {
  const lines = [];
  for (const r of rows) {
    lines.push(`${r.project ?? '?'}#${r.issue ?? '?'} cycle ${r.cycle}: wall ${fmt(r.wallMs)} run ${fmt(r.runMs)} active ${fmt(r.activeMs)}`);
    lines.push(`  phases: ${PHASES_OF_INTEREST.map((p) => `${p} ${fmt(r.phases[p])}`).join(' · ')}`);
    for (const s of r.steps) {
      const tags = [s.when, s.overlap ? 'overlap' : null, s.outcome].filter(Boolean).join(', ');
      lines.push(`  step ${s.name}${tags ? ` (${tags})` : ''}: ${fmt(s.ms)}`);
    }
    lines.push(`  steps sum ${fmt(r.stepsSumMs)} - union ${fmt(r.stepsUnionMs)} = ${fmt(r.overlapMs)} concurrent`);
    lines.push(`  install vs triage ${fmt(r.installVsTriageMs)} · demo vs pr ${fmt(r.demoVsPrMs)}`);
    if (r.droppedSpans) lines.push(`  ${r.droppedSpans} spans dropped at the cap: the figures above are a lower bound`);
  }
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  const die = (message) => {
    console.error(message);
    process.exit(1);
  };
  const USAGE = 'Usage: node tools/metrics/overlap.mjs <data-dir> [--json]';
  let dir = null;
  let json = false;
  for (const a of argv) {
    if (a === '--json') json = true;
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

  const rows = [];
  for (const f of files) {
    let data;
    try {
      data = readTasksFileMerged(path.join(dir, f));
    } catch (e) {
      die(`Cannot read ${f}: ${e.message}. If the board is writing it, retry.`);
    }
    const list = Array.isArray(data) ? data : Object.values(data ?? {});
    for (const t of list) if (t && typeof t === 'object' && Array.isArray(t.timings)) rows.push(...overlapReport(t));
  }
  process.stdout.write(json ? `${JSON.stringify(rows, null, 2)}\n` : toText(rows));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2));
