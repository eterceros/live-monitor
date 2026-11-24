import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The pure half of the snapshots (`snapshots.js` is the board's half): which files
 * a snapshot takes, how snapshots are named and found, and which ones retention
 * keeps. Only `node:*`, so `tools/restore-snapshot` can use it without booting
 * anything of the board.
 *
 * A snapshot is a folder `<root>/<YYYYMMDD-HHMMSS>-<reason>/` with the data files
 * under `data/` (hard links of the live ones, at their relative paths) and a
 * `manifest.json` written once every file has been checked. No manifest: not
 * checked yet (or the board stopped while checking) — it is never counted as good
 * and never deleted by retention.
 */

export const MANIFEST = 'manifest.json';
export const DATA_SUBDIR = 'data';

/** Pieces of a name that mark a copy, a quarantine or a temp file: never snapshotted. */
const EXCLUDED_MARKS = ['.bak', '.bad-', '.bad', '.corrupt-', '.unadopted-', '.tmp', '.from-', '.legacy'];
const excluded = (name) => EXCLUDED_MARKS.some((m) => name.includes(m));

/**
 * The live data files: `*.json` at the top of `dataDir` and `taskdata/**\/*.json`,
 * minus backups, quarantined and temp files (and anything under a folder named
 * like one), minus `upgrade/`. Relative paths with forward slashes, sorted.
 */
export function liveFiles(dataDir) {
  const out = [];
  let top = [];
  try { top = readdirSync(dataDir, { withFileTypes: true }); } catch { return out; }
  for (const e of top) {
    if (e.isFile() && e.name.endsWith('.json') && !excluded(e.name)) out.push(e.name);
  }
  const walk = (rel) => {
    let entries = [];
    try { entries = readdirSync(path.join(dataDir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (excluded(e.name)) continue;
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (e.isFile() && e.name.endsWith('.json')) out.push(child);
    }
  };
  if (existsSync(path.join(dataDir, 'taskdata'))) walk('taskdata');
  return out.sort();
}

const pad = (n) => String(n).padStart(2, '0');

/** `20261123-145100` in local time: the folder name sorts by time. */
export function stampOf(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

const NAME_RE = /^(\d{8})-(\d{6})-([a-z]+)(?:-(\d+))?$/;

/** The time a snapshot name says (local time), or null when it is not one. */
export function timeOfName(name) {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [d, t] = [m[1], m[2]];
  return new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6));
}

/**
 * Every snapshot under `root`, newest first:
 * `{name, dir, at, reason, status: 'valid'|'invalid'|'unchecked', manifest}`.
 */
export function listSnapshots(root) {
  let names = [];
  try { names = readdirSync(root); } catch { return []; }
  const out = [];
  for (const name of names) {
    const m = NAME_RE.exec(name);
    const at = timeOfName(name);
    if (!m || !at) continue;
    const dir = path.join(root, name);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    let manifest = null;
    try { manifest = JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8')); } catch { /* unchecked */ }
    const status = !manifest ? 'unchecked' : manifest.valid ? 'valid' : 'invalid';
    out.push({ name, dir, at, reason: m[3], status, manifest });
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

/** ISO week key (`2026-W48`) of a date, local time. */
function weekKey(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = (d.getDay() + 6) % 7;          // Monday = 0
  d.setDate(d.getDate() - day + 3);          // the Thursday of that week
  const firstThursday = new Date(d.getFullYear(), 0, 4);
  const week = 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${pad(week)}`;
}

export const DEFAULT_KEEP = { hourly: 24, daily: 14, weekly: 8, invalid: 10 };

/**
 * Which snapshots to delete. Only valid ones count: the newest valid one of each
 * of the last `hourly` hours, `daily` days and `weekly` weeks (that have one) is
 * kept, and the newest valid one is always kept. An invalid or unchecked snapshot
 * never pushes a valid one out. Invalid ones beyond the newest `invalid` go; an
 * unchecked one is never deleted (it may still be being checked).
 *
 * @param {ReturnType<typeof listSnapshots>} list newest first.
 * @returns {string[]} names to delete.
 */
export function retentionPlan(list, keep = DEFAULT_KEEP) {
  const k = { ...DEFAULT_KEEP, ...(keep ?? {}) };
  const valid = list.filter((s) => s.status === 'valid');
  const kept = new Set(valid.length ? [valid[0].name] : []);
  const tiers = [
    [k.hourly, (d) => `${stampOf(d).slice(0, 11)}`],
    [k.daily, (d) => stampOf(d).slice(0, 8)],
    [k.weekly, weekKey],
  ];
  for (const [count, keyOf] of tiers) {
    const seen = new Set();
    for (const s of valid) {
      const key = keyOf(s.at);
      if (seen.has(key)) continue;
      if (seen.size >= count) break;
      seen.add(key);
      kept.add(s.name);
    }
  }
  const drop = valid.filter((s) => !kept.has(s.name)).map((s) => s.name);
  const invalid = list.filter((s) => s.status === 'invalid');
  for (const s of invalid.slice(Math.max(0, k.invalid))) drop.push(s.name);
  return drop;
}

/**
 * Where snapshots go when nothing says otherwise: `%LOCALAPPDATA%\hfs-monitor\snapshots`
 * on Windows, `~/.local/share/hfs-monitor/snapshots` elsewhere. Outside the repository
 * and the data folder, so neither a `git clean` nor a damaged data folder takes them.
 */
export function defaultSnapshotRoot(env = process.env) {
  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'hfs-monitor', 'snapshots');
  }
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'hfs-monitor', 'snapshots');
}
