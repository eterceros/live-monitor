import { readFileSync, existsSync, mkdirSync, copyFileSync, statSync, constants, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

/** The file name sidecars were first written with: no separators, no surprises, but case kept. */
const safeNameLegacy = (id) => String(id).replace(/[^A-Za-z0-9._@-]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

/**
 * The file name an id gets now. Windows folds case, so `proj@PC` and `proj@pc`
 * would be one file: a name with capitals is written lowercase plus a hash of the
 * original (`proj@pc~1a2b3c4d`), so two ids differing only in case stay apart.
 * Names that are already lowercase are unchanged, so existing files keep their name.
 */
function safeName(id) {
  const enc = safeNameLegacy(id);
  const lower = enc.toLowerCase();
  return enc === lower ? enc : `${lower}~${createHash('sha1').update(String(id)).digest('hex').slice(0, 8)}`;
}

/**
 * Where an entry's heavy part lives.
 *
 * @param {string} dataDir
 * @param {string} scope the main file's name without `.json` (`tasks`, `tasks.ehr`, `projectchats`).
 * @param {string|number} id the entry's key in that file.
 */
export const heavyPath = (dataDir, scope, id) => path.join(dataDir, HEAVY_DIR, scope, `${safeName(id)}.json`);

/** Where an id with capitals was written before names were made case-proof (read only). */
const heavyPathLegacy = (dataDir, scope, id) => path.join(dataDir, HEAVY_DIR, scope, `${safeNameLegacy(id)}.json`);

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
 * @param {string|number} [key] the entry's id in its main file; written into the data file so a
 *   reader can tell it is the right one (two ids can fold to one file name on Windows).
 */
export function heavyChunks(entry, itemText, key) {
  const out = new ChunkBuilder();
  const arr = (a) => {
    out.add('[');
    for (let i = 0; i < a.length; i++) out.add(`${i ? ',' : ''}${itemText(a[i])}`);
    out.add(']');
  };
  out.add(`{"v":${HEAVY_VERSION},${key === undefined ? '' : `"key":${JSON.stringify(String(key))},`}"log":`);
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

/** Everything of `base` (the sidecar: older) and then what only `extra` (the main file: newer) has. */
function union(base, extra) {
  const keyOf = (x) => (isObj(x) && x.id !== undefined ? `i:${x.id}` : `j:${JSON.stringify(x)}`);
  const seen = new Set(base.map(keyOf));
  return [...base, ...extra.filter((x) => !seen.has(keyOf(x)))];
}

/**
 * Puts a sidecar's content back into an entry read from the main file.
 *
 * Normally the entry's `log` and its chats' `messages` are empty stubs and the
 * sidecar fills them. If one is NOT empty, an older build (which does not know the
 * split) has been writing into the main file after the conversion: the two are
 * united, the sidecar's first, nothing dropped, and `merged` says so.
 *
 * @returns {{log: boolean, chats: string[], merged: boolean, orphans: string[]}}
 *   `log`/`chats`: what the sidecar has nothing for; `merged`: a union was needed;
 *   `orphans`: chats with messages in the sidecar that the main file does not list
 *   (a cut between the two writes).
 */
export function mergeHeavy(entry, heavy) {
  const out = { log: false, chats: [], merged: false, orphans: [] };
  if (Array.isArray(entry.log)) {
    if (Array.isArray(heavy?.log)) {
      if (entry.log.length === 0) entry.log = heavy.log;
      else { entry.log = union(heavy.log, entry.log); out.merged = true; }
    } else if (entry.log.length === 0) out.log = true;
  }
  const chats = Array.isArray(entry.chats) ? entry.chats : [];
  for (const chat of chats) {
    if (!isObj(chat) || !Array.isArray(chat.messages)) continue;
    const m = isObj(heavy?.messages) && Object.hasOwn(heavy.messages, chat.id) ? heavy.messages[chat.id] : undefined;
    if (Array.isArray(m)) {
      if (chat.messages.length === 0) chat.messages = m;
      else { chat.messages = union(m, chat.messages); out.merged = true; }
    } else if (chat.messages.length === 0 && typeof chat.id === 'string') out.chats.push(chat.id);
  }
  if (isObj(heavy?.messages)) {
    const known = new Set(chats.map((c) => (isObj(c) ? c.id : undefined)));
    for (const [id, m] of Object.entries(heavy.messages)) if (!known.has(id) && Array.isArray(m) && m.length) out.orphans.push(id);
  }
  delete entry[SPLIT_MARK];
  return out;
}

/**
 * Reads an entry's sidecar.
 * @returns {{ok: true, heavy: object, file: string} | {ok: false, reason: 'missing'|'corrupt', file: string, error?: string}}
 */
export function readHeavy(dataDir, scope, id) {
  let file = heavyPath(dataDir, scope, id);
  if (!existsSync(file)) {
    const old = heavyPathLegacy(dataDir, scope, id);   // written before names were case-proof
    if (old !== file && existsSync(old)) file = old;
    else return { ok: false, reason: 'missing', file };
  }
  try {
    const heavy = JSON.parse(readFileSync(file, 'utf8'));
    if (!isObj(heavy)) throw new Error('not an object');
    // The file under the OLD name may be another id's on a case-folding file system.
    if (heavy.key !== undefined && String(heavy.key) !== String(id)) return { ok: false, reason: 'missing', file, foreign: true };
    return { ok: true, heavy, file, legacyName: file !== heavyPath(dataDir, scope, id) };
  } catch (e) {
    return { ok: false, reason: 'corrupt', file, error: e.message };
  }
}

/**
 * After an entry's data file has been written under its current name: the file it
 * had under the pre-case-proof name is renamed to `<name>.legacy.bak` (never
 * deleted), unless it may belong to another id — its `key` says another one, or
 * another id in `siblingIds` folds to the same name and the file says nothing.
 * Returns the new path, or null when there was nothing to do.
 */
export function retireLegacyName(dataDir, scope, id, siblingIds = []) {
  const now = heavyPath(dataDir, scope, id);
  const old = heavyPathLegacy(dataDir, scope, id);
  if (old === now || !existsSync(old)) return null;
  const fold = (x) => safeNameLegacy(x).toLowerCase();
  let key;
  try { key = JSON.parse(readFileSync(old, 'utf8')).key; } catch { return null; }
  if (key !== undefined ? String(key) !== String(id) : siblingIds.some((s) => String(s) !== String(id) && fold(s) === fold(id))) return null;
  for (let n = 0; ; n++) {
    const dest = `${old}.legacy${n ? `.${n}` : ''}.bak`;
    if (existsSync(dest)) continue;
    try { renameSync(old, dest); return dest; } catch { return null; }
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
 * a backup is never overwritten. An existing backup with exactly the same bytes is
 * reused instead of making another (a migration that fails on every boot must not
 * add ~100 MB each time). Verifies the size. Returns the backup's path.
 * Throws when it cannot make one — the caller then must not migrate.
 */
export function backupOnce(file, suffix = 'pre-split') {
  for (let n = 0; ; n++) {
    const bak = `${file}.${suffix}${n ? `.${n}` : ''}.bak`;
    if (existsSync(bak)) {
      try {
        if (statSync(bak).size === statSync(file).size && readFileSync(bak).equals(readFileSync(file))) return bak;
      } catch { /* unreadable: treat it as different and move on */ }
      continue;
    }
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
