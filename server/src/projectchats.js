import { readFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { store } from './store.js';
import { migrateChats, resetChatsOnBoot } from './chats.js';
import { machines, machineFor, machineViewFor } from './machine.js';
import { listProjects, projectOf, baseBranchOf } from './projects.js';
import { ensureDetachedWorktree, refreshDetachedWorktree } from './worktree.js';
import { PROJECT_WORKTREE_DIR, isHolderKey, parseHolderKey } from './keys.js';
import { SerCache, objectChunks, writeAtomicSync, writeChunksAtomic } from './persistcache.js';

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
let seqStarted = 0;
let seqLanded = 0;
/** JSON text per holder: a write re-serializes only the holders that changed. */
let ser = new SerCache();
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

/** Test seam: forget everything in memory (the file is untouched). */
export function _resetProjectChatsForTests() {
  if (timer) clearTimeout(timer);
  timer = null;
  dirty = false;
  ser = new SerCache();
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

/** The file as pieces of text, each holder from the cache. */
function chunks() {
  return objectChunks(ser, [...holders], { prefix: `{"version":${FILE_VERSION},"holders":`, suffix: '}' });
}

/**
 * Writes `projectchats.json` now, synchronously (the way out): tmp + rename, so
 * a kill never leaves half a file. It first re-serializes every holder and
 * compares with the cached text, so a holder changed without `persistHolder`
 * is saved too.
 */
export function flushProjectChats() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (ser.revalidate([...holders]).length) dirty = true;
  if (!dirty) return;
  dirty = false;
  const f = file();
  const seq = ++seqStarted;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeAtomicSync(f, chunks());
    seqLanded = seq;
  } catch (e) {
    dirty = true;
    console.error(`[projectchats] no se pudo guardar ${f}: ${e.message}`);
  }
}

/** The timer's write: same file, written a piece per turn so the loop is never held for all of it. */
async function flushProjectChatsAsync() {
  if (writing) return;
  writing = true;
  try {
    if (!dirty) return;
    dirty = false;
    const f = file();
    const seq = ++seqStarted;
    const parts = chunks();   // a snapshot: immutable strings from here on
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      if (await writeChunksAtomic(f, parts, () => seqLanded < seq)) seqLanded = seq;
    } catch (e) {
      dirty = true;
      console.error(`[projectchats] no se pudo guardar ${f}: ${e.message}`);
    }
  } finally {
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
  const moved = await ser.sweep([...holders]);
  if (moved.length) {
    console.error(`[projectchats] ${moved.join(', ')} cambió sin persistHolder; se guarda igualmente`);
    dirty = true;
    if (!timer) arm();
  }
  return moved;
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

/** Coalesced write, like the task store's: bursts of tool events become one write. */
export function persistHolder(holder) {
  if (holder) {
    const key = holderKey(holder.project, holder.machine);
    // A holder handed in that is not the registered one still gets saved.
    if (!holders.has(key)) holders.set(key, holder);
    ser.invalidate(holder);
  } else {
    ser.invalidateAll();
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
