import { readFileSync, existsSync, mkdirSync, copyFileSync, statSync, constants, renameSync } from 'node:fs';
import path from 'node:path';
import { ChunkBuilder } from './persistcache.js';

/**
 * The split on-disk format of `tasks*.json` and `projectchats.json`.
 *
 * Why: the two things that grow without bound in a task are its `log` (up to
 * 3000 lines) and the `messages` of its chats (up to 600 each, with activity
 * trees: a single chat is 10 MB in the board that motivated this). Together they
 * were 90% of a 93 MB file that was rewritten whole on every change. Now:
 *
 * - the main file keeps every entry as it was, except that `log` is `[]`, each
 *   chat's `messages` is `[]` and the entry carries `persistSplit: 1`;
 * - `taskdata/<file-without-.json>/<id>.json` holds that entry's heavy part:
 *   `{ "v": 1, "log": [...], "messages": { "<chatId>": [...] } }`.
 *
 * In memory nothing changes: `task.log` and `chat.messages` are the arrays
 * they always were. The old format (no marker) is still read, as is. This module
 * is pure (only `node:*` and the chunk builder), so the tools under `tools/`
 * can import `readTasksFileMerged` and keep reading complete tasks.
 */

export const SPLIT_MARK = 'persistSplit';
export const HEAVY_DIR = 'taskdata';
const HEAVY_VERSION = 1;

const isObj = (v) => v !== null && typeof v === 'object';

/** A chat whose messages can travel by id: it has a unique string id and an array. */
function strippable(chat, chats) {
  return isObj(chat) && typeof chat.id === 'string' && Array.isArray(chat.messages)
    && chats.filter((c) => isObj(c) && c.id === chat.id).length === 1;
}

/** The file name an id gets inside a scope's folder: no separators, no surprises. */
const safeName = (id) => String(id).replace(/[^A-Za-z0-9._@-]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

/**
 * Where an entry's heavy part lives.
 *
 * @param {string} dataDir
 * @param {string} scope the main file's name without `.json` (`tasks`, `tasks.ehr`, `projectchats`).
 * @param {string|number} id the entry's key in that file.
 */
export const heavyPath = (dataDir, scope, id) => path.join(dataDir, HEAVY_DIR, scope, `${safeName(id)}.json`);

/** The main file's scope: `/x/tasks.ehr.json` → `tasks.ehr`. */
export const scopeOf = (file) => path.basename(file).replace(/\.json$/, '');

/** What goes in the main file for `entry`: everything but the heavy part, plus the marker. */
export function coreOf(entry) {
  const core = { ...entry };
  if (Array.isArray(entry.log)) core.log = [];
  if (Array.isArray(entry.chats)) {
    core.chats = entry.chats.map((c) => (strippable(c, entry.chats) ? { ...c, messages: [] } : c));
  }
  core[SPLIT_MARK] = 1;
  return core;
}

/** The text of `entry`'s core, as the main file carries it. */
export const coreText = (entry) => JSON.stringify(coreOf(entry));

/**
 * The text of `entry`'s heavy part, as pieces. `itemText` supplies each log
 * line / message (cached by the caller); the pieces join to valid JSON.
 *
 * @param {object} entry
 * @param {(item: object) => string} itemText
 */
export function heavyChunks(entry, itemText) {
  const out = new ChunkBuilder();
  const arr = (a) => {
    out.add('[');
    for (let i = 0; i < a.length; i++) out.add(`${i ? ',' : ''}${itemText(a[i])}`);
    out.add(']');
  };
  out.add(`{"v":${HEAVY_VERSION},"log":`);
  if (Array.isArray(entry.log)) arr(entry.log); else out.add('[]');
  out.add(',"messages":{');
  let first = true;
  const chats = Array.isArray(entry.chats) ? entry.chats : [];
  for (const chat of chats) {
    if (!strippable(chat, chats)) continue;
    out.add(`${first ? '' : ','}${JSON.stringify(chat.id)}:`);
    first = false;
    arr(chat.messages);
  }
  out.add('}}');
  return out.done();
}

/** Every log line and message of `entry`, the items `heavyChunks` caches. */
export function* heavyItems(entry) {
  if (Array.isArray(entry.log)) yield* entry.log;
  if (Array.isArray(entry.chats)) {
    for (const c of entry.chats) if (isObj(c) && Array.isArray(c.messages)) yield* c.messages;
  }
}

/**
 * Puts a sidecar's content back into an entry read from the main file.
 * Returns what could not be placed (a chat the sidecar has no messages for).
 */
export function mergeHeavy(entry, heavy) {
  const lost = { log: false, chats: [] };
  if (Array.isArray(heavy?.log) && Array.isArray(entry.log)) entry.log = heavy.log;
  else if (Array.isArray(entry.log) && entry.log.length === 0) lost.log = true;
  for (const chat of Array.isArray(entry.chats) ? entry.chats : []) {
    if (!isObj(chat) || !Array.isArray(chat.messages) || chat.messages.length) continue;
    const m = heavy?.messages?.[chat.id];
    if (Array.isArray(m)) chat.messages = m;
    else if (typeof chat.id === 'string') lost.chats.push(chat.id);
  }
  delete entry[SPLIT_MARK];
  return lost;
}

/**
 * Reads an entry's sidecar.
 * @returns {{ok: true, heavy: object} | {ok: false, reason: 'missing'|'corrupt', file: string, error?: string}}
 */
export function readHeavy(dataDir, scope, id) {
  const file = heavyPath(dataDir, scope, id);
  if (!existsSync(file)) return { ok: false, reason: 'missing', file };
  try {
    const heavy = JSON.parse(readFileSync(file, 'utf8'));
    if (!isObj(heavy)) throw new Error('not an object');
    return { ok: true, heavy };
  } catch (e) {
    return { ok: false, reason: 'corrupt', file, error: e.message };
  }
}

/** Moves a sidecar that cannot be read aside, so a fresh write never overwrites it. */
export function quarantine(file) {
  const dest = `${file}.bad-${Date.now()}`;
  try { renameSync(file, dest); return dest; } catch { return null; }
}

/** `mkdir -p` of a sidecar's folder. */
export const ensureHeavyDir = (file) => mkdirSync(path.dirname(file), { recursive: true });

/**
 * Copies `file` to `<file>.pre-split.bak` (`.1.bak`, `.2.bak`… if that exists):
 * a backup is never overwritten. Verifies the size. Returns the backup's path.
 * Throws when it cannot make one — the caller then must not migrate.
 */
export function backupOnce(file, suffix = 'pre-split') {
  for (let n = 0; ; n++) {
    const bak = `${file}.${suffix}${n ? `.${n}` : ''}.bak`;
    try {
      copyFileSync(file, bak, constants.COPYFILE_EXCL);
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw e;
    }
    if (statSync(bak).size !== statSync(file).size) throw new Error(`backup ${bak} is not the size of ${file}`);
    return bak;
  }
}

/**
 * Reads a main file the way the board does and returns complete entries, in
 * either format (sidecars merged in). For tools that parse the data files
 * without booting the store. A sidecar that cannot be read throws: a report
 * built on a task with no history would be wrong without saying so.
 *
 * @param {string} file e.g. `.../tasks.json`, `.../tasks.ehr.json`, `.../projectchats.json`.
 * @param {{key?: (raw: object) => object}} [opts] `key` picks the map of entries from the parsed file (`raw => raw.holders` for project chats).
 */
export function readTasksFileMerged(file, { key = (raw) => raw } = {}) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const dir = path.dirname(file);
  const scope = scopeOf(file);
  for (const [id, entry] of Object.entries(key(raw) ?? {})) {
    if (!isObj(entry) || !entry[SPLIT_MARK]) continue;
    const r = readHeavy(dir, scope, id);
    if (!r.ok) throw new Error(`${file}: entry ${id} is split but its data ${r.file} is ${r.reason}${r.error ? ` (${r.error})` : ''}`);
    mergeHeavy(entry, r.heavy);
  }
  return raw;
}
