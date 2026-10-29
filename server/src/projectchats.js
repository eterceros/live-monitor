import { readFileSync, renameSync, mkdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { store } from './store.js';
import { migrateChats, resetChatsOnBoot } from './chats.js';
import { machines, machineFor, machineViewFor } from './machine.js';
import { listProjects, projectOf, baseBranchOf } from './projects.js';
import { ensureDetachedWorktree, refreshDetachedWorktree } from './worktree.js';
import { PROJECT_WORKTREE_DIR, isHolderKey, parseHolderKey } from './keys.js';
import { SerCache, objectChunks, writeAtomicSync, writeChunksAtomic } from './persistcache.js';
import {
  SPLIT_MARK, coreText, heavyChunks, heavyItems, heavyPath, mergeHeavy, readHeavy, quarantine, ensureHeavyDir, backupOnce, retireLegacyName,
} from './splitfmt.js';

// Pure helpers live in `keys.js` (the runner imports them and must not pull in
// this module's store); re-exported so every importer here keeps working.
export { PROJECT_WORKTREE_DIR, isHolderKey, parseHolderKey };

/**
 * The project chat: conversations that belong to a project, not to an issue.
 *
 * Their owner is a **holder** — a plain object shaped enough like a task
 * (`kind: 'project'`, `project`, `machine`, `chats`, `log`, `worktreePath`…)
 * that the chat code in `store.js`/`chats.js`/`pipeline.js` works on it
 * unchanged. A holder is never in the task store, never polled and never on
 * the board's task list; it lives in `projectchats.json` and is dispatched by
 * `store.js` on `task.kind === 'project'`.
 *
 * One holder per (project, machine). All its chats share one detached
 * worktree, `<worktreeRoot>/_proyecto`, cut from `origin/<baseBranch>` — never
 * the project's own checkout.
 */

export const HOLDER_TITLE = 'Proyecto';

const FILE_NAME = 'projectchats.json';
const SCOPE = 'projectchats';   // folder of the holders' data files, under taskdata/
const FILE_VERSION = 1;
// Same window and same reasons as the task store's (`store.js`): the file is
// tens of MB, a burst of tool events must become one write.
const PERSIST_DELAY_MS = process.env.HFSMON_PERSIST_DELAY_MS !== undefined
  ? Number(process.env.HFSMON_PERSIST_DELAY_MS)
  : 3000;
const SWEEP_INTERVAL_MS = Number(process.env.HFSMON_SWEEP_INTERVAL_MS ?? 60_000);

const file = () => path.join(DATA_DIR, FILE_NAME);

/** key → holder. Filled by `loadProjectChats`, lazily. */
const holders = new Map();
let loaded = false;
let dirty = false;
let timer = null;
let sweepTimer = null;
let writing = false;
/** What the running async write took off the dirty lists and has not landed yet: a sync flush must write it again. */
let inflight = false;
const inflightKeys = new Set();
let seqStarted = 0;
let seqLanded = 0;
/** Text of each holder's entry in the main file (everything but log and messages). */
let coreSer = new SerCache(coreText);
/** Text of each log line and message, so a write re-serializes only what changed. */
let itemSer = new SerCache();
/** Keys of the holders whose data file is not on disk yet. */
const heavyDirty = new Set();
/** The file on disk is still the old, single-file format (until the first write migrates it). */
let legacy = false;
/** The migration failed: keep writing the old format. */
let noSplit = false;
/** Length each array had when it was serialized (to notice a silent push/splice). */
let lens = new WeakMap();
/** key → in-flight `ensureHolderWorktree`, so two chats starting at once create it once. */
const ensuring = new Map();

export const holderKey = (project, machine) => `${project}@${machine}`;

/**
 * The machines a project's chat can live on: the ones its project can stand on
 * (`machineViewFor` refuses a non-default project on a runner, deliberately).
 * Unknown project: none.
 */
export function holderMachines(projectId) {
  if (typeof projectId !== 'string' || !projectId) return [];
  return Object.keys(machines()).filter((name) => machineViewFor({ project: projectId }, name).machine);
}

function newHolder(project, machine) {
  const holder = {
    kind: 'project',
    project,
    machine,
    issue: null,
    title: HOLDER_TITLE,
    baseBranch: baseBranchOf(project),
    worktreePath: null,
    head: null,
    chats: [],
    log: [],
    updatedAt: new Date().toISOString(),
  };
  migrateChats(holder); // gives it its principal conversation
  return holder;
}

/** Reads the file once. Idempotent; a missing or unreadable file means "no holders yet". */
export function loadProjectChats() {
  if (loaded) return;
  loaded = true;
  const f = file();
  if (!existsSync(f)) return;
  let raw;
  try {
    raw = JSON.parse(readFileSync(f, 'utf8'));
  } catch (e) {
    // Keep the broken file aside rather than overwrite it with an empty one.
    console.error(`[projectchats] ${f} no se pudo leer (${e.message}); se conserva como .bad`);
    try { renameSync(f, `${f}.bad`); } catch { /* best effort */ }
    return;
  }
  for (const [key, holder] of Object.entries(raw?.holders ?? {})) {
    if (!holder || typeof holder !== 'object' || holder.kind !== 'project') continue;
    const parsed = parseHolderKey(key);
    if (!parsed) continue;
    if (holder[SPLIT_MARK]) loadHeavy(f, key, holder); else legacy = true;
    holder.project = parsed.project;
    holder.machine = parsed.machine;
    holder.issue = null;
    holder.title = HOLDER_TITLE;
    holder.log = Array.isArray(holder.log) ? holder.log : [];
    migrateChats(holder);
    resetChatsOnBoot(holder);
    holders.set(key, holder);
  }
}

/**
 * Puts a split holder's log and messages back from its data file. One that is
 * missing or unreadable is reported (an unreadable one is moved aside so the next
 * write cannot overwrite it); the holder starts with no history, and the
 * `.pre-split.bak` left at migration still has it.
 */
function loadHeavy(f, key, holder) {
  const r = readHeavy(DATA_DIR, SCOPE, key);
  if (!r.ok) {
    const aside = r.reason === 'corrupt' ? quarantine(r.file) : null;
    console.error(`[projectchats] ${f}: el chat ${key} está dividido pero ${r.file} está ${r.foreign ? 'a nombre de otro id (no se lee)' : r.reason === 'missing' ? 'ausente' : `ilegible (${r.error}); ${aside ? `movido a ${aside}` : 'NO se pudo apartar'}`}; arranca sin historial (la copia .pre-split.bak lo conserva)`);
    delete holder[SPLIT_MARK];
    return;
  }
  if (r.legacyName) console.error(`[projectchats] ${f}: el chat ${key} se leyó de ${r.file}, con el nombre antiguo; se reescribe con el nombre nuevo`);
  const lost = mergeHeavy(holder, r.heavy);
  if (lost.log || lost.chats.length) {
    console.error(`[projectchats] ${f}: el chat ${key} perdió en ${r.file}: ${lost.log ? 'el log ' : ''}${lost.chats.length ? `mensajes de ${lost.chats.join(', ')}` : ''}`);
  }
  if (lost.merged || lost.orphans.length) {
    // An older build wrote into the main file after the split (both united), or the data
    // file has messages of a chat the main file does not list (a cut between the writes).
    // A copy of the data file as it was is kept (the next write replaces it) and the log says so.
    let bak = null;
    try { bak = backupOnce(r.file, lost.orphans.length ? 'orphan-chats' : 'pre-merge'); } catch (e) { bak = `(sin copia: ${e.message})`; }
    const line = lost.orphans.length
      ? `Recovered data: the data file had messages of chats this project chat does not list (${lost.orphans.join(', ')}); copy kept in ${bak}`
      : `Recovered data: an older build had written into the main file after the split; both were united; copy of the data file kept in ${bak}`;
    console.error(`[projectchats] ${f}: ${key}: ${line}`);
    holder.log ??= [];
    holder.log.push({ ts: new Date().toISOString(), phase: 'chat', line });
  }
}

/**
 * Converts the file to the split format now if it is still in the old one (the
 * task store does the same at boot): a backup, every holder's data file, then the
 * main file. Without this the conversion would wait for the first write of a
 * project chat and block the board for those seconds in the middle of a session.
 * Nothing to do for a missing, empty or already split file.
 */
export function migrateProjectChatsOnBoot() {
  loadProjectChats();
  if (!legacy || !holders.size) return;
  dirty = true;
  flushProjectChats();
}

/** Test seam: the holders in memory, as `[key, holder]`. */
export function _loadedHoldersForTests() {
  loadProjectChats();
  return [...holders];
}

/** Test seam: forget everything in memory (the file is untouched). */
export function _resetProjectChatsForTests() {
  if (timer) clearTimeout(timer);
  timer = null;
  dirty = false;
  coreSer = new SerCache(coreText);
  itemSer = new SerCache();
  heavyDirty.clear();
  inflight = false;
  inflightKeys.clear();
  legacy = false;
  noSplit = false;
  lens = new WeakMap();
  loaded = false;
  holders.clear();
  ensuring.clear();
}

function allowed(project, machine) {
  return Boolean(projectOf(project)) && holderMachines(project).includes(machine);
}

/** The holder of a project on a machine; created (with its principal chat) on first ask. */
export function getHolder(project, machine) {
  loadProjectChats();
  if (!allowed(project, machine)) {
    throw new Error(`No project chat for ${JSON.stringify(project)} on machine ${JSON.stringify(machine)}`);
  }
  const key = holderKey(project, machine);
  let holder = holders.get(key);
  if (!holder) {
    holder = newHolder(project, machine);
    holders.set(key, holder);
    persistHolder(holder);
  }
  // Live, not frozen: the registry may have changed the base since last time.
  holder.baseBranch = baseBranchOf(project);
  return holder;
}

/** `null` when the key is not a holder key or its holder is not allowed. */
export function getHolderByKey(key) {
  const parsed = parseHolderKey(key);
  if (!parsed) return null;
  try {
    return getHolder(parsed.project, parsed.machine);
  } catch {
    return null;
  }
}

/** Every holder of every registered project on every machine it can stand on. */
export function allHolders() {
  const out = [];
  for (const p of listProjects()) {
    for (const machine of holderMachines(p.id)) {
      const h = getHolderByKey(holderKey(p.id, machine));
      if (h) out.push(h);
    }
  }
  return out;
}

/** The main file as pieces of text, each holder's entry from the cache. */
function coreChunks({ plain = false } = {}) {
  const textOf = (v) => (plain ? JSON.stringify(v) : coreSer.text(v));
  return objectChunks(textOf, [...holders], { prefix: `{"version":${FILE_VERSION},"holders":`, suffix: '}' });
}

const heavyFile = (key) => heavyPath(DATA_DIR, SCOPE, key);

function* arraysOf(holder) {
  if (Array.isArray(holder.log)) yield holder.log;
  for (const chat of Array.isArray(holder.chats) ? holder.chats : []) {
    if (chat && Array.isArray(chat.messages)) yield chat.messages;
  }
}

/** A holder's log and messages as pieces; also remembers how long each array was. */
function heavyOf(holder) {
  const out = heavyChunks(holder, (item) => itemSer.text(item), holderKey(holder.project, holder.machine));
  for (const arr of arraysOf(holder)) lens.set(arr, arr.length);
  return out;
}

/** An array longer or shorter than when serialized, a new array, or an item nobody serialized. */
function shapeMoved(holder) {
  for (const arr of arraysOf(holder)) {
    if (lens.get(arr) !== arr.length) return true;
    for (const item of arr) {
      if (item !== null && typeof item === 'object' && !itemSer.has(item)) return true;
    }
  }
  return false;
}

function* itemEntries(key, holder) {
  for (const item of heavyItems(holder)) yield [key, item];
}

function sameAsFile(f, chunks) {
  try {
    const text = chunks.join('');
    return statSync(f).size === Buffer.byteLength(text) && readFileSync(f, 'utf8') === text;
  } catch {
    return false;
  }
}

const seqs = new Map();      // file → sequence of the newest write started
const landed = new Map();    // file → sequence of the newest write that landed
const nextSeq = (f) => { const n = (seqs.get(f) ?? 0) + 1; seqs.set(f, n); return n; };
const current = (f, seq) => (landed.get(f) ?? 0) < seq;

function writeHeavySync(key, holder, { verify = false } = {}) {
  const f = heavyFile(key);
  const chunks = heavyOf(holder);
  ensureHeavyDir(f);
  const seq = nextSeq(f);
  writeAtomicSync(f, chunks);
  landed.set(f, seq);
  if (verify && readFileSync(f, 'utf8') !== chunks.join('')) throw new Error(`${f}: what was written does not match what was read back`);
  retireLegacyName(DATA_DIR, SCOPE, key, [...holders.keys()]);
}

function writeCoreSync(opts) {
  const f = file();
  const seq = nextSeq(f);
  writeAtomicSync(f, coreChunks(opts));
  landed.set(f, seq);
}

/**
 * Everything, synchronously. The first write of a file still in the old format
 * is the migration: a backup of it (never overwritten), every holder's data
 * file written and read back, and only then the main file. If any of that fails
 * the old format keeps being written — saving never stops.
 */
function writeAllSync(keys) {
  mkdirSync(DATA_DIR, { recursive: true });
  if (noSplit) return writeCoreSync({ plain: true });
  if (legacy) {
    const f = file();
    try {
      const bak = existsSync(f) ? backupOnce(f) : null;
      for (const [key, holder] of holders) writeHeavySync(key, holder, { verify: true });
      writeCoreSync();
      legacy = false;
      if (bak) console.log(`[projectchats] ${f}: pasa al formato dividido; copia de seguridad en ${bak}`);
    } catch (e) {
      noSplit = true;
      console.error(`[projectchats] ${f}: no se pudo migrar al formato dividido (${e.message}); sigue en el formato antiguo`);
      writeCoreSync({ plain: true });
    }
    return undefined;
  }
  for (const key of keys) {
    const holder = holders.get(key);
    if (holder) writeHeavySync(key, holder);
  }
  return writeCoreSync();
}

/** Holders whose data moved with no `persistHolder` to say so; their cached text is dropped. */
function revalidateAll() {
  const moved = new Set(coreSer.revalidate([...holders]));
  for (const [key, holder] of holders) {
    for (const label of itemSer.revalidate(itemEntries(key, holder))) moved.add(label);
    if (shapeMoved(holder)) moved.add(key);
  }
  return [...moved];
}

function adoptMoved(keys) {
  for (const key of keys) {
    const holder = holders.get(key);
    if (!holder) continue;
    coreSer.invalidate(holder);
    for (const item of heavyItems(holder)) itemSer.invalidate(item);
    heavyDirty.add(key);
    dirty = true;
  }
}

/**
 * Writes the project chats now, synchronously (the way out): tmp + rename, so a
 * kill never leaves half a file. It first re-serializes every holder and
 * compares with the cached text, so a holder changed without `persistHolder`
 * is saved too. Returns the writes that failed, `[{file, error}]` (empty: all on disk).
 */
export function flushProjectChats() {
  const failures = [];
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  adoptMoved(revalidateAll());
  // A write in flight took the dirty flags off when it started; if the process
  // leaves now (a signal, upgrade.js) it is cut off half-way. Write it all again;
  // the sequence check then drops the older in-flight text.
  if (inflight) {
    dirty = true;
    for (const k of inflightKeys) heavyDirty.add(k);
  }
  if (!dirty) return failures;
  dirty = false;
  const keys = [...heavyDirty];
  heavyDirty.clear();
  try {
    writeAllSync(keys);
  } catch (e) {
    dirty = true;
    keys.forEach((k) => heavyDirty.add(k));
    console.error(`[projectchats] no se pudo guardar ${file()}: ${e.message}`);
    failures.push({ file: file(), error: e.message });
    if (!timer) arm();   // try again soon
  }
  return failures;
}

/** The timer's write: same files, written a piece per turn so the loop is never held for all of it. */
async function flushProjectChatsAsync() {
  if (writing) return;
  writing = true;
  const keys = [...heavyDirty];
  heavyDirty.clear();
  const wasDirty = dirty;
  dirty = false;
  inflight = wasDirty;
  inflightKeys.clear();
  for (const k of keys) inflightKeys.add(k);
  try {
    if (!wasDirty) return;
    // The migration (once) and the old-format fallback go through the synchronous path.
    if (legacy || noSplit) { writeAllSync(keys); return; }
    mkdirSync(DATA_DIR, { recursive: true });
    for (const key of keys) {             // the data files first, the main file last
      const holder = holders.get(key);
      if (!holder) continue;
      const f = heavyFile(key);
      const parts = heavyOf(holder);       // a snapshot: immutable strings from here on
      ensureHeavyDir(f);
      const seq = nextSeq(f);
      if (await writeChunksAtomic(f, parts, () => current(f, seq))) {
        landed.set(f, seq);
        retireLegacyName(DATA_DIR, SCOPE, key, [...holders.keys()]);
      }
    }
    const f = file();
    const parts = coreChunks();
    const seq = nextSeq(f);
    if (await writeChunksAtomic(f, parts, () => current(f, seq))) landed.set(f, seq);
  } catch (e) {
    dirty = true;
    keys.forEach((k) => heavyDirty.add(k));
    console.error(`[projectchats] no se pudo guardar ${file()}: ${e.message}`);
  } finally {
    inflight = false;
    inflightKeys.clear();
    writing = false;
    if (dirty && !timer) arm();
  }
}

/** Test seam: the write the timer runs, now, awaitable. */
export async function _flushProjectChatsAsyncForTests() {
  if (timer) { clearTimeout(timer); timer = null; }
  while (writing) await new Promise((r) => setTimeout(r, 5));
  await flushProjectChatsAsync();
}

/** Slice-by-slice check for holders changed without `persistHolder`; resolves to their keys. */
export async function sweepProjectChats() {
  const moved = new Set();
  let start = performance.now();
  for (const [key, holder] of holders) {
    if (heavyDirty.has(key)) continue;   // known dirty: its next write carries whatever else moved
    if (coreSer.revalidate([[key, holder]]).length || shapeMoved(holder)) moved.add(key);
    for (const label of await itemSer.sweep(itemEntries(key, holder))) moved.add(label);
    if (performance.now() - start > 8) {
      await new Promise((r) => setImmediate(r));
      start = performance.now();
    }
  }
  const keys = [...moved];
  if (keys.length) {
    console.error(`[projectchats] ${keys.join(', ')} cambió sin persistHolder; se guarda igualmente`);
    adoptMoved(keys);
    if (!timer) arm();
  }
  return keys;
}

function armSweep() {
  if (!(SWEEP_INTERVAL_MS > 0) || sweepTimer) return;
  sweepTimer = setTimeout(async () => {
    sweepTimer = null;
    try { await sweepProjectChats(); } catch (e) { console.error(`[projectchats] sweep: ${e.message}`); }
    armSweep();
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

function arm() {
  timer = setTimeout(() => {
    timer = null;
    flushProjectChatsAsync();
  }, PERSIST_DELAY_MS);
  timer.unref?.();
}

/**
 * Coalesced write, like the task store's: bursts of tool events become one write.
 * `hint === 'append'` comes from the callers that know exactly what they changed
 * (a log line or message added, one message patched): what is already serialized
 * is kept. Any other call distrusts everything the holder has.
 */
export function persistHolder(holder, hint = null, changed = null) {
  if (holder) {
    const key = holderKey(holder.project, holder.machine);
    // A holder handed in that is not the registered one still gets saved.
    if (!holders.has(key)) holders.set(key, holder);
    coreSer.invalidate(holder);
    itemSer.invalidate(changed);   // the one message a patch changed, if the caller said which
    if (hint !== 'append') for (const item of heavyItems(holder)) itemSer.invalidate(item);
    heavyDirty.add(key);
  } else {
    coreSer.invalidateAll();
    itemSer.invalidateAll();
    for (const key of holders.keys()) heavyDirty.add(key);
  }
  dirty = true;
  armSweep();
  if (timer) return;
  arm();
}

const machineOfHolder = (holder) => machineFor(holder.machine ?? 'local', holder.project);

/** The holder's detached worktree, created on first use. Resolves to its path on that machine. */
export async function ensureHolderWorktree(holder, { onLine } = {}) {
  const key = holderKey(holder.project, holder.machine);
  if (ensuring.has(key)) return ensuring.get(key);
  const job = (async () => {
    const wtPath = await ensureDetachedWorktree(
      machineOfHolder(holder), baseBranchOf(holder.project), PROJECT_WORKTREE_DIR, { onLine },
    );
    if (holder.worktreePath !== wtPath) {
      holder.worktreePath = wtPath;
      store.touch(holder);
    }
    return wtPath;
  })().finally(() => ensuring.delete(key));
  ensuring.set(key, job);
  return job;
}

/** Brings the worktree to origin/base when harmless; records what HEAD is. Resolves to `{ moved, note, head }`. */
export async function refreshHolderWorktree(holder) {
  if (!holder.worktreePath) return { moved: false, note: null, head: holder.head ?? null };
  const r = await refreshDetachedWorktree(machineOfHolder(holder), holder.worktreePath, baseBranchOf(holder.project));
  holder.head = r.head;
  store.touch(holder);
  return r;
}

// The store dispatches on `kind === 'project'` through these.
store.setHolderPersister(persistHolder);
store.setHolderFlusher(flushProjectChats);
