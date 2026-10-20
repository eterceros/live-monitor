import { EventEmitter } from 'node:events';
import { readFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, config } from './config.js';
import { migrateTask } from './mode.js';
import { migrateChats, resetChatsOnBoot, chatById, chatsOf, MAX_CHAT_MESSAGES } from './chats.js';
import { settings } from './settings.js';
import { familyOf } from './models.js';
import { EFFORT_LEVELS } from './effort.js';
import { requireProject } from './machine.js';
import { metricsHooks } from './metrics.js';
import { DEFAULT_PROJECT_ID, coerceKey, isProjectId, keyOf, tasksFileOf } from './keys.js';
import { SerCache, objectChunks, writeAtomicSync, writeChunksAtomic } from './persistcache.js';
import {
  SPLIT_MARK, coreText, heavyChunks, heavyItems, heavyPath, mergeHeavy, readHeavy, quarantine, ensureHeavyDir, backupOnce, scopeOf,
} from './splitfmt.js';

/**
 * One tasks file per project, the union in one object.
 *
 * The store stays a **single** object with a **single** emitter — see the
 * contract in `keys.js`, «The store stays one object, and one event emitter»:
 * `index.js` wires the websocket to one emitter and `upgrade.js` to the same
 * one, so an instance per project would leave the browser hearing about the
 * first project only, silently. Being backed by one file per project is an
 * internal detail of this module.
 *
 * In memory, tasks are indexed by the canonical key `<project>#<issue>`. On
 * disk, each project's file keeps the shape it has always had — `{ "<issue>":
 * task }` — and a file in that shape is adopted as is. The one addition is
 * `project` on every task, stamped at load time because `keyOf` refuses a task
 * without one.
 *
 * What a task's entry holds is split: its `log` and the `messages` of its chats
 * (90% of the bytes, and what grows) live in `taskdata/<file>/<issue>.json`
 * (`splitfmt.js`), the entry keeps a `persistSplit` marker. Nothing else sees
 * the difference — in memory `task.log` and `chat.messages` are what they were —
 * and the first write of a file still in the old shape backs it up (`.pre-split.bak`,
 * never overwritten) before converting it.
 */
const MAX_LOG_LINES = 3000;
// A burst of tool events becomes one write. The files are tens of MB, so the
// window is wide: a hard kill (taskkill /F, power loss) loses at most this much;
// every orderly exit (signal, restart, upgrade) flushes synchronously anyway.
// `HFSMON_PERSIST_DELAY_MS` exists for tests.
const PERSIST_DELAY_MS = process.env.HFSMON_PERSIST_DELAY_MS !== undefined
  ? Number(process.env.HFSMON_PERSIST_DELAY_MS)
  : 3000;
// How often a slice-by-slice check looks for a task that changed without
// `persist(task)` (see `sweep`). 0 disables it.
const SWEEP_INTERVAL_MS = Number(process.env.HFSMON_SWEEP_INTERVAL_MS ?? 60_000);

export const STATES = [
  'assigned',          // detected on GitHub, nothing started, waiting for a slot
  'started',           // a branch already claims the issue — not the board's doing
  'worktree',          // creating / holding a worktree
  'triage',            // Opus triage (+ advisor when complex)
  'fixing',            // Opus implementing the fix
  'testing',           // Playwright e2e
  'pr_draft',          // draft PR open
  'ready',             // PR marked ready, reviewer assigned
  'waiting_approval',  // an open PR is waiting for review/approval
  'done',              // PR merged
  'error',
];

/**
 * The steps of a move between machines (move.js), in order. Kept here because
 * the boot block reads them: up to `build_target` the task has not arrived.
 */
export const MOVE_STEPS = [
  'blockers', 'source_git', 'handoff', 'park_source', 'build_target', 'chats', 'remove_source', 'prewarm', 'done',
];

/** The file a project's tasks live in. `tasksFileOf` validates the id. */
const tasksFile = (projectId) => path.join(DATA_DIR, tasksFileOf(projectId));

/** A non-default project's tasks file: `tasks.<id>.json`. */
const TASKS_FILE_RE = /^tasks\.([a-z0-9][a-z0-9-]*)\.json$/;

/**
 * Which projects to load, discovered by looking at `DATA_DIR` rather than by
 * asking the project registry. A glob has no import: the store boots before —
 * and independently of — whoever writes the registry, and a project whose file
 * exists is loaded even if nobody registered it.
 *
 * The default project is always in, file or no file: the board has to write
 * `tasks.json` at boot even when it is empty.
 *
 * @returns {string[]} project ids.
 */
function discoverProjects() {
  const found = new Set([DEFAULT_PROJECT_ID]);
  let names = [];
  try { names = readdirSync(DATA_DIR); } catch { /* a fresh data dir has nothing */ }
  for (const name of names) {
    const m = TASKS_FILE_RE.exec(name);
    // `tasks.hfs.json` is not the default project's file — `tasks.json` is —
    // so it is skipped rather than read twice under the same id.
    if (m && m[1] !== DEFAULT_PROJECT_ID) found.add(m[1]);
  }
  return [...found];
}

/**
 * Boot-time fix-up of the model each chat of `task` stored. Idempotent: it
 * runs on every boot and a second pass changes nothing.
 *
 * 1. A chat that pinned a version (`claude-opus-4`) moves to its family
 *    (`opus`), so "always the newest" holds for it too.
 *
 * A chat pinned to an id we do not recognise (a newer family the config has
 * not caught up with) is left alone: it may be legitimate, and resetting it
 * would overwrite something the user chose.
 *
 * @param {object} task
 * @param {{id: string}[]} available the configured models.
 * @param {(line: string) => void} [_log] unused; kept for the caller's signature.
 */
export function migrateChatModels(task, available, _log) {
  for (const chat of chatsOf(task)) {
    // The chat's own effort is stored like its model; a value this board does
    // not know (an old build, a hand edit) goes back to auto instead of reaching the CLI.
    if (chat.effort != null && chat.effort !== 'auto' && !EFFORT_LEVELS.includes(chat.effort)) chat.effort = null;
    const family = familyOf(chat.model, available);
    if (family && family !== chat.model) chat.model = family;
  }
}

/** Whether the file already holds exactly these pieces (so it need not be written). */
function sameAsFile(file, chunks) {
  try {
    const text = chunks.join('');
    return statSync(file).size === Buffer.byteLength(text) && readFileSync(file, 'utf8') === text;
  } catch {
    return false;
  }
}

class Store extends EventEmitter {
  /** Project ids with changes not yet on disk. */
  #dirty = new Set();
  /** projectId → { orphans }. Its keys are the projects this store writes. */
  #projects = new Map();
  #timer = null;
  /** Text of each task's entry in the main file (its core: everything but log and messages). */
  #coreSer = new SerCache(coreText);
  /** Text of each log line and message, so a write re-serializes only what changed. */
  #itemSer = new SerCache();
  /** Keys of the tasks whose heavy part (log, messages) is not on disk yet. */
  #heavyDirty = new Set();
  /** Projects whose file on disk is still the old, single-file format. */
  #legacy = new Set();
  /** Projects whose migration failed: they keep being written in the old format. */
  #noSplit = new Set();
  /** What the running async write took off the dirty lists and has not landed yet: a sync flush must write it again. */
  #inflightProjects = new Set();
  #inflightKeys = new Set();
  /** The first flush: sidecars equal to what is on disk are not rewritten. */
  #bootFlush = false;
  /** Length each array had when it was serialized (to notice a silent push/splice). */
  #lens = new WeakMap();
  /** An async write is running; the next one waits for it. */
  #writing = false;
  /** file → sequence of the newest write started / landed (stale async writes are dropped). */
  #seqStarted = new Map();
  #seqLanded = new Map();
  #sweepTimer = null;
  /** Counts the changes announced; `#flushedVersion` is the count at the last successful flush. */
  #version = 0;
  #flushedVersion = 0;
  /** Registered by `projectchats.js`: the store cannot import it (it imports the store). */
  #holderPersister = null;
  #holderFlusher = null;

  constructor() {
    super();
    mkdirSync(DATA_DIR, { recursive: true });
    /** Every project's tasks, in one object, by canonical key. */
    this.tasks = {};
    for (const projectId of discoverProjects()) this.#adopt(projectId);
    // A crash mid-phase leaves tasks stranded in a running state; on boot,
    // park them in error so the user can hit "retry" deliberately.
    for (const t of Object.values(this.tasks)) {
      migrateTask(t);
      migrateChats(t);
      resetChatsOnBoot(t);
      // A chat that pinned a version (`claude-opus-4`) moves to its family
      // (`opus`), so "always the newest" holds for it too. A chat pinned to
      // an unknown pin is left alone.
      migrateChatModels(t, config.claude?.available ?? [], (line) => {
        // Straight onto the log: `addLog` would persist and emit mid-boot,
        // and `flush()` below writes everything once anyway.
        t.log ??= [];
        const entry = { ts: new Date().toISOString(), phase: 'chat', line };
        t.log.push(entry);
        t.updatedAt = entry.ts;
      });
      // A move cut by the restart. Its `worktree` state was only the move's
      // own busy marker: the card goes back to what it was before, untouched —
      // a task in `error` keeps its Retry — and the move keeps its record,
      // failed, so «Reintentar mudanza» picks it up step by step. Before the
      // block below, or that marker would turn into an error of its own.
      if (t.moving && !t.moving.error) {
        const saved = t.moving.saved ?? {};
        t.state = saved.state ?? t.state;
        t.prevState = saved.prevState ?? null;
        t.error = saved.error ?? null;
        t.moving.error = 'The board restarted in the middle of the move; «Retry move» finishes it';
        // Not arrived yet: whatever the last write caught, the task is still
        // where it came from, with that machine's worktree.
        if (MOVE_STEPS.indexOf(t.moving.step) <= MOVE_STEPS.indexOf('build_target') && t.moving.from) {
          t.machine = t.moving.from;
          if (t.moving.sourceWt !== undefined) t.worktreePath = t.moving.sourceWt;
        }
      }
      // The build it started went down with the board.
      if (t.prewarm && !t.prewarm.endedAt) {
        t.prewarm.ok = null;
        t.prewarm.endedAt = new Date().toISOString();
      }
      if (['worktree', 'triage', 'fixing', 'testing', 'browser_qa', 'fix_gaps'].includes(t.state)) {
        t.prevState = t.state;
        // Where the run was, for «Reintentar». Only when the phase is not
        // already written: a task that reached the PR carries `pr` here, and
        // its state — the last one a phase reached — would walk it back.
        t.phase ??= t.state;
        t.state = 'error';
        t.error = 'The server restarted during this phase. Use Retry.';
      }
      t.demoBusy = false;
      t.qaBusy = false;
      // What a failed triage was waiting for dies with the process that waited.
      t.waitingOn = null;
      t.creatingWorktree = false;
      // A stack mid-start lost its watcher; containers may well be up, so mark
      // it unknown rather than pretending it is running.
      if (t.stack?.status === 'starting') {
        t.stack.status = 'error';
        t.stack.error = 'The server restarted while the stack was starting.';
      }
      // Nor does a running one (or a stop cut half-way) stay as it was: the board
      // lost its handles, and what a command service started outside its own
      // tree (containers) outlives the restart. Left `running`, the card showed
      // green links to nothing; the saved stop commands run on the next Stop.
      if (t.stack?.status === 'running' || t.stack?.status === 'stopping') {
        t.stack.status = 'error';
        t.stack.error = 'The board restarted and lost track of the servers of this task; some may still be running. Press «Stop stack» to clean up, then start them again.';
        for (const svc of Object.values(t.stack.services ?? {})) svc.healthy = false;
      }
    }
    for (const projectId of this.#projects.keys()) this.#dirty.add(projectId);
    // The boot fix-ups above may have touched any task: its heavy part is
    // compared with the file (and rewritten only if different) by this first flush.
    for (const key of Object.keys(this.tasks)) this.#heavyDirty.add(key);
    this.#bootFlush = true;
    this.flush();
    this.#bootFlush = false;

    // A kill leaves the last burst unwritten otherwise. `beforeExit` covers the
    // ordinary end, the signals cover the way this board is actually stopped.
    process.once('beforeExit', () => this.flush());
    // `process.exit()` (upgrade.js after handing over to the script, a signal handler) fires
    // `exit` but not `beforeExit`. Synchronous work is all an exit handler may do, and flush()
    // is. It is skipped when nothing changed since the last successful flush, so the usual
    // signal -> flush -> process.exit(0) does not serialize everything twice.
    process.once('exit', () => {
      if (this.#version !== this.#flushedVersion || this.#writing || this.#dirty.size) this.flush();
    });
    this.#flushedVersion = this.#version;
    this.#armSweep();
    // The ways the board is stopped: Ctrl+C, the service manager, a closed console (SIGHUP) and,
    // on Windows, Ctrl+Break or a closed console window (SIGBREAK).
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
      try {
        process.once(signal, () => { this.flush(); process.exit(0); });
      } catch { /* a signal this platform does not have */ }
    }
  }

  /**
   * A project chat's holder is task-shaped (`kind: 'project'`) but is never in
   * `this.tasks`: every method below that takes a task hands it to this
   * persister instead of writing a tasks file, and emits `'project-chat'`
   * (with the raw holder) instead of `'task'`.
   */
  setHolderPersister(fn) { this.#holderPersister = typeof fn === 'function' ? fn : null; }

  /** Called by `flush()`, so the exit/handover paths write the holders too. */
  setHolderFlusher(fn) { this.#holderFlusher = typeof fn === 'function' ? fn : null; }

  /**
   * The sixth argument of `'chat'`, `'chat-update'` and `'log'` for a holder;
   * `undefined` for a task, so a task's events keep their old arity.
   */
  static #holderExtra(task) {
    return task?.kind === 'project' ? { owner: 'project', machine: task.machine } : undefined;
  }

  /**
   * Reads one project's tasks file into `this.tasks` and registers the project,
   * whether or not the file exists — an empty project still owns its file.
   *
   * The file is adopted, not migrated: its keys stay whatever they were, and
   * the only field added is `project`, stamped here because `keyOf` throws
   * without it and no caller should have to pass one. It rides along on the
   * next write, which is additive: code that predates projects ignores it.
   *
   * An entry nothing can key — no usable issue number — is kept aside in
   * `orphans` and written back untouched. Dropping it would be data loss on
   * the very first flush, which happens at boot.
   */
  #adopt(projectId) {
    const orphans = {};
    this.#projects.set(projectId, { orphans });
    const file = tasksFile(projectId);
    // A half-written file still throws here, as it always has: the board
    // refusing to boot is better than one silently missing its tasks.
    const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) ?? {} : {};
    let legacy = false;
    for (const [fileKey, task] of Object.entries(raw)) {
      if (!task || typeof task !== 'object') { orphans[fileKey] = task; continue; }
      task.project = projectId;
      const key = coerceKey(task.issue ?? fileKey, projectId);
      if (!key) {
        console.error(`[store] ${file}: la entrada ${JSON.stringify(fileKey)} no tiene un issue usable; se conserva sin tocar`);
        orphans[fileKey] = task;
        continue;
      }
      if (task[SPLIT_MARK]) this.#loadHeavy(file, fileKey, task); else legacy = true;
      this.tasks[key] = task;
    }
    if (legacy) this.#legacy.add(projectId);
  }

  /**
   * A sidecar that needed more than filling in: an older build wrote into the main
   * file after the split (`merged`: the two were united), or the sidecar has
   * messages of a chat the main file does not list (`orphans`: a cut between the
   * two writes). Either way a copy of the sidecar as it was is kept (the next write
   * replaces it) and the task's log says so, instead of ignoring it in silence.
   */
  #noteRecovery(task, label, sidecar, info) {
    if (!info.merged && !info.orphans.length) return;
    const suffix = info.orphans.length ? 'orphan-chats' : 'pre-merge';
    let bak = null;
    try { bak = backupOnce(sidecar, suffix); } catch (e) { bak = `(sin copia: ${e.message})`; }
    const line = info.orphans.length
      ? `Recovered data: the data file had messages of chats this task does not list (${info.orphans.join(', ')}); copy kept in ${bak}`
      : `Recovered data: an older build had written into the main file after the split; both were united; copy of the data file kept in ${bak}`;
    console.error(`[store] ${label}: ${line}`);
    task.log ??= [];
    task.log.push({ ts: new Date().toISOString(), phase: 'chat', line });
  }

  /**
   * Puts a split task's log and messages back from its sidecar. A sidecar that
   * is missing or unreadable is reported, never papered over: an unreadable one
   * is moved aside (so the next write cannot overwrite it) and the task starts
   * with no history; the `.pre-split.bak` left at migration still has it.
   */
  #loadHeavy(file, fileKey, task) {
    const r = readHeavy(DATA_DIR, scopeOf(file), fileKey);
    if (!r.ok) {
      const aside = r.reason === 'corrupt' ? quarantine(r.file) : null;
      console.error(`[store] ${file}: la tarea ${fileKey} está dividida pero ${r.file} está ${r.foreign ? 'a nombre de otro id (no se lee)' : r.reason === 'missing' ? 'ausente' : `ilegible (${r.error}); ${aside ? `movido a ${aside}` : 'NO se pudo apartar'}`}; arranca sin historial (la copia .pre-split.bak lo conserva)`);
      delete task[SPLIT_MARK];
      return;
    }
    if (r.legacyName) console.error(`[store] ${file}: la tarea ${fileKey} se leyó de ${r.file}, con el nombre antiguo; se reescribe con el nuevo`);
    const lost = mergeHeavy(task, r.heavy);
    if (lost.log || lost.chats.length) {
      console.error(`[store] ${file}: la tarea ${fileKey} perdió en ${r.file}: ${lost.log ? 'el log ' : ''}${lost.chats.length ? `mensajes de ${lost.chats.join(', ')}` : ''}`);
    }
    this.#noteRecovery(task, `${file} #${fileKey}`, r.file, lost);
  }

  /** Registers a project so that `flush` writes its file. */
  #project(projectId) {
    if (!this.#projects.has(projectId)) this.#projects.set(projectId, { orphans: {} });
    return this.#projects.get(projectId);
  }

  /**
   * Marks the store dirty and writes once the current burst settles.
   *
   * It used to write on every single change, and the file is not small: 6.8 MB,
   * serialized and written synchronously, measured at 33 ms a time. A chat turn
   * calls this once per tool use — the real peak in this store was 1326 writes
   * in one minute, nearly 9 GB, from a single task — and `writeFileSync` blocks
   * the event loop, so the websocket and the poll cycle stall behind it.
   *
   * Coalescing costs nothing in practice: the in-memory state is the truth for
   * every reader, the events still fire immediately, and the only thing at risk
   * is the last few seconds if the process is killed outright — which is why
   * exit flushes.
   *
   * `hint` is `'append'` only from the callers that know exactly what they
   * changed — a log line or a chat message added, one message patched — so the
   * log lines and messages already serialized are kept. Any other call (no hint)
   * distrusts everything the task has and serializes it again.
   */
  persist(task = null, hint = null, changed = null) {
    this.#version += 1;
    if (task?.kind === 'project') {
      this.#holderPersister?.(task, hint, changed);
      return;
    }
    if (changed) this.#itemSer.invalidate(changed);
    this.#markDirty(task, hint !== 'append');
    if (this.#timer) return;
    this.#arm(PERSIST_DELAY_MS);
  }

  #arm(ms) {
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#flushAsync();
    }, ms);
    // Never hold the process open just to write a file.
    this.#timer.unref?.();
  }

  #keyOfTask(task) {
    try { return keyOf(task); } catch { return `${task.project}#${task.issue}`; }
  }

  /**
   * Which files the next write has to touch. A change carries the task it
   * happened to, so only that project's file (and that task's data file) is
   * rewritten; `store.persist()` with nothing in hand cannot tell, so it marks
   * every project and every task.
   */
  #markDirty(task, full = true) {
    this.#version += 1;
    const projectId = task && isProjectId(task.project) ? task.project : null;
    if (task) {
      // Its cached text is stale from this moment; the next write serializes it again.
      this.#coreSer.invalidate(task);
      if (full) for (const item of heavyItems(task)) this.#itemSer.invalidate(item);
      this.#heavyDirty.add(this.#keyOfTask(task));
    }
    if (projectId) {
      this.#project(projectId);
      this.#dirty.add(projectId);
      return;
    }
    // Without a (valid) task nothing can be trusted: everything is serialized again.
    this.#coreSer.invalidateAll();
    this.#itemSer.invalidateAll();
    for (const key of Object.keys(this.tasks)) this.#heavyDirty.add(key);
    for (const id of this.#projects.keys()) this.#dirty.add(id);
  }

  /** `<project>`'s main file as pieces: orphans first, then its tasks, in `JSON.stringify` order. */
  #coreChunks(projectId, { plain = false } = {}) {
    const orphans = this.#projects.get(projectId)?.orphans ?? {};
    const out = { ...orphans };
    for (const task of Object.values(this.tasks)) {
      if (task.project === projectId) out[task.issue] = task;
    }
    const raw = new Set(Object.values(orphans));
    // Orphans are written back untouched; `plain` is the old one-file format.
    const textOf = (v) => (plain || v === null || typeof v !== 'object' || raw.has(v) ? JSON.stringify(v) : this.#coreSer.text(v));
    return objectChunks(textOf, Object.entries(out));
  }

  #heavyFile(task) {
    return heavyPath(DATA_DIR, scopeOf(tasksFile(task.project)), task.issue);
  }

  /** `task`'s log and messages as pieces; also remembers how long each array was. */
  #heavyOf(task) {
    const chunks = heavyChunks(task, (item) => this.#itemSer.text(item), task.issue);
    for (const arr of this.#arraysOf(task)) this.#lens.set(arr, arr.length);
    return chunks;
  }

  *#arraysOf(task) {
    if (Array.isArray(task.log)) yield task.log;
    for (const chat of Array.isArray(task.chats) ? task.chats : []) {
      if (chat && Array.isArray(chat.messages)) yield chat.messages;
    }
  }

  /**
   * A task's heavy part is not what was last written: an array longer or shorter
   * than when it was serialized, a new array, or an item nobody serialized — a
   * change `persist` was never told about, and that no cached text can show.
   */
  #shapeMoved(task) {
    for (const arr of this.#arraysOf(task)) {
      if (this.#lens.get(arr) !== arr.length) return true;
      for (const item of arr) {
        if (item !== null && typeof item === 'object' && !this.#itemSer.has(item)) return true;
      }
    }
    return false;
  }

  *#itemEntries(key, task) {
    for (const item of heavyItems(task)) yield [key, item];
  }

  /** Writes one task's data file now; `verify` reads it back and compares. */
  #writeHeavySync(task, { skipIfSame = false, verify = false } = {}) {
    const file = this.#heavyFile(task);
    const chunks = this.#heavyOf(task);
    ensureHeavyDir(file);
    if (skipIfSame && sameAsFile(file, chunks)) return;
    const seq = this.#nextSeq(file);
    writeAtomicSync(file, chunks);
    this.#seqLanded.set(file, seq);
    if (verify && readFileSync(file, 'utf8') !== chunks.join('')) {
      throw new Error(`${file}: what was written does not match what was read back`);
    }
  }

  #writeCoreSync(projectId, opts) {
    const file = tasksFile(projectId);
    const seq = this.#nextSeq(file);
    writeAtomicSync(file, this.#coreChunks(projectId, opts));
    this.#seqLanded.set(file, seq);
  }

  /**
   * One project, synchronously. The first write of a file still in the old
   * format is the migration: a backup of it (never overwritten), every task's
   * data file written and read back, and only then the main file. If any of that
   * fails the old format keeps being written — saving never stops — and the
   * backup, if made, stays.
   */
  #writeProjectSync(projectId, keys) {
    if (this.#noSplit.has(projectId)) return this.#writeCoreSync(projectId, { plain: true });
    if (this.#legacy.has(projectId)) {
      const file = tasksFile(projectId);
      try {
        const bak = existsSync(file) ? backupOnce(file) : null;
        for (const task of Object.values(this.tasks)) {
          if (task.project === projectId) this.#writeHeavySync(task, { verify: true });
        }
        this.#writeCoreSync(projectId);
        this.#legacy.delete(projectId);
        if (bak) console.log(`[store] ${file}: pasa al formato dividido; copia de seguridad en ${bak}`);
      } catch (e) {
        this.#noSplit.add(projectId);
        console.error(`[store] ${file}: no se pudo migrar al formato dividido (${e.message}); sigue en el formato antiguo`);
        this.#writeCoreSync(projectId, { plain: true });
      }
      return undefined;
    }
    for (const key of keys) {
      const task = this.tasks[key];
      if (task) this.#writeHeavySync(task, { skipIfSame: this.#bootFlush });
    }
    return this.#writeCoreSync(projectId);
  }

  #revalidateAll() {
    const moved = new Set(this.#coreSer.revalidate(Object.entries(this.tasks)));
    for (const [key, task] of Object.entries(this.tasks)) {
      for (const label of this.#itemSer.revalidate(this.#itemEntries(key, task))) moved.add(label);
      if (this.#shapeMoved(task)) moved.add(key);
    }
    return [...moved];
  }

  /**
   * Writes every dirty project's files now, synchronously. For the way out
   * (signals, restart, upgrade, tests): it first re-serializes every task and
   * compares with the cached text, so a task changed without `persist(task)`
   * is saved here too, even when nothing declared its project dirty.
   *
   * Returns the writes that failed, `[{file, error}]`: empty when everything is on
   * disk. The failed projects stay dirty and a retry is armed, but the caller (the
   * `/api/flush` route stop.ps1 uses) must not take «no exception» for «saved».
   *
   * @returns {{file: string, error: string}[]}
   */
  flush() {
    const failures = [...(this.#holderFlusher?.() ?? [])];
    // An explicit write makes the scheduled one redundant, and leaving it armed
    // means firing into a directory that may not be there any more.
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#adoptMoved(this.#revalidateAll(), true);
    // A write in flight took its projects off the lists when it started; if the
    // process leaves now (a signal, upgrade.js) it is cut off half-way. They are
    // written again here; the sequence check then drops the older in-flight text.
    for (const id of this.#inflightProjects) this.#dirty.add(id);
    for (const k of this.#inflightKeys) this.#heavyDirty.add(k);
    if (!this.#dirty.size) {
      if (!failures.length) this.#flushedVersion = this.#version;
      return failures;
    }
    const pending = [...this.#dirty];
    this.#dirty.clear();

    for (const projectId of pending) {
      const keys = [...this.#heavyDirty].filter((k) => this.tasks[k]?.project === projectId);
      for (const k of keys) this.#heavyDirty.delete(k);
      try {
        this.#writeProjectSync(projectId, keys);
      } catch (e) {
        // Losing one write is not worth taking the board down: memory is still
        // the truth, and the next change writes the project again anyway.
        this.#dirty.add(projectId);
        for (const k of keys) this.#heavyDirty.add(k);
        console.error(`[store] no se pudo guardar ${tasksFile(projectId)}: ${e.message}`);
        failures.push({ file: tasksFile(projectId), error: e.message });
      }
    }
    if (failures.length) {
      if (!this.#timer) this.#arm(PERSIST_DELAY_MS);   // try again soon
    } else {
      this.#flushedVersion = this.#version;
    }
    return failures;
  }

  #nextSeq(file) {
    const n = (this.#seqStarted.get(file) ?? 0) + 1;
    this.#seqStarted.set(file, n);
    return n;
  }

  /** Whether the write numbered `seq` of `file` may still land (no newer one has). */
  #current(file, seq) {
    return (this.#seqLanded.get(file) ?? 0) < seq;
  }

  /**
   * The timer's write: same files, but the event loop is never held for the
   * whole of it. Each file's text comes from the caches (only what changed is
   * serialized), then goes to a temp file a piece per turn, renamed over the
   * real one — so a file is always whole. A synchronous `flush()` that lands
   * meanwhile wins: the older text is dropped instead of renamed.
   */
  async #flushAsync() {
    if (this.#writing) return;   // the running write re-arms the timer if more came in
    this.#writing = true;
    const pending = [...this.#dirty];
    this.#dirty.clear();
    const heavy = [...this.#heavyDirty];
    this.#heavyDirty.clear();
    this.#inflightProjects = new Set(pending);
    this.#inflightKeys = new Set(heavy);
    const done = new Set();
    try {
      for (const projectId of pending) {
        // A file not yet in the split format is migrated by the synchronous path (it runs once).
        if (this.#legacy.has(projectId) || this.#noSplit.has(projectId)) {
          const keys = heavy.filter((k) => this.tasks[k]?.project === projectId);
          keys.forEach((k) => done.add(k));
          try { this.#writeProjectSync(projectId, keys); } catch (e) {
            this.#dirty.add(projectId);
            console.error(`[store] no se pudo guardar ${tasksFile(projectId)}: ${e.message}`);
          }
          continue;
        }
        const keys = heavy.filter((k) => this.tasks[k]?.project === projectId);
        keys.forEach((k) => done.add(k));
        try {
          for (const key of keys) {            // the data files first, the main file last
            const task = this.tasks[key];
            if (!task) continue;
            const file = this.#heavyFile(task);
            const chunks = this.#heavyOf(task);   // a snapshot: immutable strings from here on
            ensureHeavyDir(file);
            const seq = this.#nextSeq(file);
            if (await writeChunksAtomic(file, chunks, () => this.#current(file, seq))) this.#seqLanded.set(file, seq);
          }
          const file = tasksFile(projectId);
          const parts = this.#coreChunks(projectId);
          const seq = this.#nextSeq(file);
          if (await writeChunksAtomic(file, parts, () => this.#current(file, seq))) this.#seqLanded.set(file, seq);
        } catch (e) {
          this.#dirty.add(projectId);
          for (const k of keys) this.#heavyDirty.add(k);
          console.error(`[store] no se pudo guardar ${tasksFile(projectId)}: ${e.message}`);
        }
      }
    } finally {
      for (const k of heavy) if (!done.has(k)) this.#heavyDirty.add(k);
      this.#inflightProjects = new Set();
      this.#inflightKeys = new Set();
      this.#writing = false;
      // More changes arrived while writing (or a write failed): go again.
      if (this.#dirty.size && !this.#timer) this.#arm(PERSIST_DELAY_MS);
    }
  }

  /** Test seam: the write the timer runs, now, awaitable. */
  async flushAsync() {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    while (this.#writing) await new Promise((r) => setTimeout(r, 5));
    await this.#flushAsync();
  }

  /**
   * Tasks whose data moved with no `persist(task)` to say so (a mutation that
   * skipped the store's methods). Their cached text is dropped and they are
   * marked dirty, so the next write carries them.
   */
  #adoptMoved(moved, quiet = false) {
    for (const key of moved) {
      const task = this.tasks[key];
      if (!task) continue;
      if (!quiet) console.error(`[store] ${key} cambió sin store.persist(task); se guarda igualmente`);
      this.#markDirty(task);
    }
    return moved;
  }

  /**
   * Slice-by-slice check (a few ms at a time) for tasks changed without
   * `persist(task)`, so a missed call costs at most one interval and never a
   * value. Resolves to the keys it found.
   */
  async sweep() {
    const moved = new Set();
    let start = performance.now();
    for (const [key, task] of Object.entries(this.tasks)) {
      // Known dirty: its next write carries whatever else moved in it.
      if (this.#heavyDirty.has(key)) continue;
      if (this.#coreSer.revalidate([[key, task]]).length || this.#shapeMoved(task)) moved.add(key);
      for (const label of await this.#itemSer.sweep(this.#itemEntries(key, task))) moved.add(label);
      if (performance.now() - start > 8) {
        await new Promise((r) => setImmediate(r));
        start = performance.now();
      }
    }
    const keys = [...moved];
    this.#adoptMoved(keys);
    if (keys.length && !this.#timer) this.#arm(PERSIST_DELAY_MS);
    return keys;
  }

  #armSweep() {
    if (!(SWEEP_INTERVAL_MS > 0)) return;
    this.#sweepTimer = setTimeout(async () => {
      try { await this.sweep(); } catch (e) { console.error(`[store] sweep: ${e.message}`); }
      this.#armSweep();
    }, SWEEP_INTERVAL_MS);
    this.#sweepTimer.unref?.();
  }

  /**
   * Every project's tasks, newest issue first, `project` breaking ties. The
   * union is what keeps the account-wide readings right while the call sites
   * are converted: the active-task count, the board's snapshot, and the «is
   * the board idle» sweep the upgrade waits on.
   */
  all() {
    return Object.values(this.tasks)
      .sort((a, b) => b.issue - a.issue || String(a.project).localeCompare(String(b.project)));
  }

  /**
   * A task by canonical key (`'hfs#12'`), by issue number (`12`) or by numeric
   * string (`'12'`) — a bare number means the default project. Anything else
   * answers `undefined`, as an unknown key always has.
   */
  get(v) {
    const key = coerceKey(v);
    return key ? this.tasks[key] : undefined;
  }

  /**
   * The canonical key a value stands for, or `null`. The store's own reading of
   * {@link coerceKey}, exposed so that callers holding `store.tasks` — the two
   * tests that delete a task by hand — do not have to spell the key out.
   */
  keyFor(v, projectId) {
    requireProject(projectId, 'keyFor');
    return coerceKey(v, projectId);
  }

  addTask(issue, projectId) {
    requireProject(projectId, 'addTask');
    const task = {
      issue: issue.number,
      // Which project this task belongs to: the other half of its key. Set at
      // birth, never later — `keyOf` refuses a task without it.
      project: projectId,
      title: issue.title,
      labels: issue.labels,
      url: issue.url,
      // A closed issue is finished work by definition; classification refines
      // this to `done`/`waiting_approval` once GitHub has been consulted.
      state: issue.closed ? 'done' : 'assigned',
      classified: false,
      // Where the work runs: a key of config.machines. The dashboard's default
      // at birth, changeable until something exists there, and fixed from then
      // on — the worktree is wherever it is. The project's own default, else the board's.
      machine: settings.defaultMachineFor(projectId),
      branch: null,
      worktreePath: null,
      complexity: null,
      advisorPlan: null,
      // The current cycle's PR (OPEN or DRAFT only), and every PR the branch
      // has had, newest first: a task can go back to work after a merge.
      prNumber: null,
      prUrl: null,
      prs: [],
      reopenedAt: null,
      // The title you edited on the card, and the proposal waiting there when
      // the board could not publish one (see `prtitle.js`).
      prTitle: null,
      prPark: null,
      // Which phase of the run is in flight, so a failure at the last step is
      // retried from that step and not from the last state a phase reached.
      phase: null,
      fixIterations: 0,
      error: null,
      // Why a failure has a button of its own: `empty_repo` | `base_missing` |
      // `remote_empty` | `no_remote`, with `{ base, remoteHeads? }` (see worktree.js).
      errorCode: null,
      errorInfo: null,
      prevState: null,
      // Who drives this task. Only `auto` is ever started by the board itself;
      // `unconfirmed` is detection asking, `manual` is you having answered.
      mode: 'auto',
      modeDecidedByUser: false,  // your call; keyword detection must not undo it
      bodyCheckedForMode: false, // the issue body was fetched once for the keyword
      suspect: null,             // { where, quote } — why the board is asking
      // Change requests: reviews asking for changes on this task's PR.
      // `handledReviews` is what stops a review that stays CHANGES_REQUESTED
      // from being picked up again on every cycle, forever.
      changeRequests: [],
      handledReviews: [],
      activeChangeRequest: null,
      // How this branch stands against origin/main and against its remote, and
      // how the PR's CI is doing. Both are filled by the poll cycle.
      branchStatus: null,
      checks: null,
      // The sha the board's own fix produced. The fix is skipped only when it
      // still matches HEAD: anything committed since is work it has not seen.
      fixedAt: null,
      demoSteps: null,
      demoBusy: false,
      // What the run is waiting on after its own step ended (`'install'`), or null.
      waitingOn: null,
      // The HEAD the demo steps were last written for: a finished demo is not
      // written twice on the same commit when a run resumes at the PR.
      demoAt: null,
      // Whether the run ends by writing the demo steps: `auto` follows the
      // project's setting live, `on`/`off` is the card overruling it.
      // `demoMigrated` says this task is past the one-time move to `auto`.
      demo: 'auto',
      demoMigrated: true,
      // The PR body an agent wrote for this cycle, waiting for the PR to be
      // opened with it. Null falls back to the board's own `Closes #N` body.
      prBody: null,
      // Waiting for the account's quota to come back, with the phase to come
      // back to. Written by `quota.js`; null the rest of the time.
      quotaPark: null,
      // Browser QA: `auto` follows triage's verdict on whether the issue has a
      // UI side; `on`/`off` is you overruling it. Born `off` when the project's
      // effective setting is off, `auto` otherwise. `qa` holds the plans, the
      // results and the evidence list once the phase has run.
      browserQa: settings.browserQaFor(projectId) ? 'auto' : 'off',
      // Plan approval and the close-the-gaps round are copied from the project's
      // effective values at birth, not left on `auto`: moving the switch later
      // only affects tasks created afterwards.
      approvePlan: settings.approvePlanFor(projectId) ? 'on' : 'off',
      fixGaps: settings.fixGapsFor(projectId) ? 'on' : 'off',
      qa: null,
      qaBusy: false,
      stack: null,
      existingWork: null,
      forced: false,
      // Set only by a person (setDesign); the Artifact tools in work phases.
      design: false,
      creatingWorktree: false,
      issueClosed: false,
      log: [],
      // Spans of what the task did and waited for (metrics.js); capped apart from the log.
      timings: [],
      // Session ids the parallelism nudge already asked once (nudge.js).
      nudged: [],
      // One conversation to start with, the principal: the board's own phases
      // resume through it. More are added from the panel.
      chats: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    migrateChats(task);          // gives it its principal conversation
    // Before anything is stored: `keyOf` throws on an invalid project or issue,
    // and a malformed key in this map is a silent collision — exactly what the
    // composite key exists to prevent.
    const key = keyOf(task);
    this.#project(projectId);
    this.tasks[key] = task;
    this.touch(task);
    return task;
  }

  touch(task, hint = null) {
    task.updatedAt = new Date().toISOString();
    this.persist(task, hint);
    if (task.kind === 'project') this.emit('project-chat', task);
    else this.emit('task', task);
  }

  setState(task, state, { error = null } = {}) {
    const was = task.state;
    if (state === 'error') task.prevState = task.state;
    task.state = state;
    // Completion date: stamped on the first transition INTO done. Round trips
    // done -> worktree -> done keep the original; beginNewCycle clears it.
    if (state === 'done' && was !== 'done' && !task.doneAt) task.doneAt = new Date().toISOString();
    task.error = error;
    this.addLog(task, 'estado', `→ ${state}${error ? ` (${error})` : ''}`);
  }

  addLog(task, phase, line) {
    const entry = { ts: new Date().toISOString(), phase, line };
    task.log ??= [];
    task.log.push(entry);
    if (task.log.length > MAX_LOG_LINES) task.log.splice(0, task.log.length - MAX_LOG_LINES);
    task.updatedAt = entry.ts;
    this.persist(task, 'append');   // a new line: nothing already serialized changed
    if (task.kind === 'project') {
      this.emit('log', null, entry, task.project, Store.#holderExtra(task));
      this.emit('project-chat', task);
      return;
    }
    // `project` last, and every older argument where it was: a listener written
    // before projects existed ignores one more argument, so this module changes
    // without a flag-day edit of everyone who listens.
    this.emit('log', task.issue, entry, task.project);
    this.emit('task', task);
  }

  /**
   * Appends to one conversation. `chatId` may be null, which means the
   * principal — the board's own messages have no tab of their own.
   */
  addChat(task, chatId, role, text, attachments = []) {
    const chat = chatById(task, chatId);
    if (!chat) {
      throw new Error(task.kind === 'project'
        ? `Project chat ${task.project}@${task.machine} has no chat ${chatId}`
        : `Task #${task.issue} has no chat ${chatId}`);
    }
    const message = { id: newMessageId(), role, text, ts: new Date().toISOString() };
    if (attachments.length) message.attachments = attachments;
    return this.pushChat(task, chat, message);
  }

  /** Appends a message already shaped — an activity tree, for one. */
  pushChat(task, chat, message) {
    if (!message.id) message.id = newMessageId();
    chat.messages.push(message);
    if (chat.messages.length > MAX_CHAT_MESSAGES) {
      chat.messages.splice(0, chat.messages.length - MAX_CHAT_MESSAGES);
    }
    this.touch(task, 'append');   // a new message: the ones before it did not change
    if (task.kind === 'project') this.emit('chat', null, chat.id, message, task.project, Store.#holderExtra(task));
    else this.emit('chat', task.issue, chat.id, message, task.project);
    return message;
  }

  /**
   * A message changed in place — a bubble learning how it was delivered, an
   * activity tree gaining an item. Only the change travels: `patch` for a
   * message's own fields, `item` (+ `parentId`) for one node of the tree, so
   * a turn with two hundred tool calls does not resend the tree two hundred
   * times. Persistence rides the usual coalesced write.
   */
  updateChat(task, chat, message, { patch = null, item = null, parentId = null } = {}) {
    if (patch) Object.assign(message, patch);
    task.updatedAt = new Date().toISOString();
    // Only this message changed (a patch, or an item in its tree).
    this.persist(task, 'append', message);
    const change = { messageId: message.id, patch, item, parentId };
    if (task.kind === 'project') {
      this.emit('chat-update', null, chat.id, change, task.project, Store.#holderExtra(task));
      return;
    }
    this.emit('chat-update', task.issue, chat.id, change, task.project);
  }
}

let messageCounter = 0;
function newMessageId() {
  messageCounter += 1;
  return `m${Date.now().toString(36)}${messageCounter.toString(36)}`;
}

export const store = new Store();

// Spans persist through the store's debounced write, without `touch`: no
// `updatedAt` bump and no broadcast, so recording a span never costs a push.
metricsHooks.persist = (task) => store.persist(task);
