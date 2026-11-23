// Spans of the board's own long operations (restart, upgrade, move) that have no
// task to hang on. Kept in DATA_DIR/boardtimings.json, written tmp + rename.
//
// A restart cannot record its own end: the script that stops the board kills this
// process. It writes the start before that, and the next boot closes it with
// `closeOpenBoardSpans`. Like metrics.js, nothing here ever throws.
import './bootsnapshot.js';   // first: the start-up snapshot comes before any write
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeDurableSync } from './durable.js';
import path from 'node:path';
import { DATA_DIR } from './config.js';

/** Spans kept; the oldest go first. */
export const MAX_BOARD_SPANS = 200;

export const boardTimingsFile = () => path.join(DATA_DIR, 'boardtimings.json');

function load() {
  try {
    const file = boardTimingsFile();
    if (!existsSync(file)) return [];
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function save(list) {
  try {
    const file = boardTimingsFile();
    writeDurableSync(file, JSON.stringify(list.slice(-MAX_BOARD_SPANS), null, 2), { tmp: `${file}.tmp` });
  } catch { /* a lost measurement is not worth a failed restart */ }
}

/** Opens a span { name, ...meta } and returns its id. */
export function beginBoardSpan({ name, ...meta } = {}) {
  try {
    if (!name) return null;
    const id = randomUUID();
    const list = load();
    list.push({ id, kind: 'op', name, startedAt: new Date().toISOString(), endedAt: null, ms: null, outcome: null, meta });
    save(list);
    return id;
  } catch {
    return null;
  }
}

/** Closes the span `id`; `outcome` defaults to 'ok' and the rest merges into `meta`. */
export function endBoardSpan(id, { outcome = 'ok', ...meta } = {}) {
  try {
    const list = load();
    const s = list.find((x) => x.id === id && x.endedAt == null);
    if (!s) return false;
    const at = Date.now();
    s.endedAt = new Date(at).toISOString();
    s.ms = Math.max(0, at - Date.parse(s.startedAt));
    s.outcome = outcome;
    Object.assign(s.meta, meta);
    save(list);
    return true;
  } catch {
    return false;
  }
}

/**
 * Closes spans left open by a process that is gone, as `outcome` (default
 * 'interrupted'), optionally only those called `name`. A restart passes
 * { name: 'restart', outcome: 'ok' }: the board that comes up is its end.
 * `job` narrows it to spans whose `meta.job` matches, `meta` merges into each
 * span it closes, and `except` (a job id) closes every open span of that name
 * that belongs to some OTHER job, with zero length (it ended unseen).
 * Returns how many it closed.
 */
export function closeOpenBoardSpans(at = new Date().toISOString(), { outcome = 'interrupted', name = null, job = null, meta = null, except = null } = {}) {
  try {
    const list = load();
    const to = Date.parse(at);
    let n = 0;
    for (const s of list) {
      if (s.endedAt != null || (name && s.name !== name)) continue;
      if (job && s.meta?.job !== job) continue;
      if (except && s.meta?.job === except) continue;
      const from = Date.parse(s.startedAt);
      const stop = except || Number.isNaN(to) ? from : Math.max(from, to);
      s.endedAt = new Date(stop).toISOString();
      s.ms = stop - from;
      s.outcome = outcome;
      if (meta) s.meta = { ...(s.meta ?? {}), ...meta };
      n += 1;
    }
    if (n) save(list);
    return n;
  } catch {
    return 0;
  }
}

/** The recorded spans, oldest first. */
export function boardSpans() {
  return load();
}
