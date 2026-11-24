import { mkdirSync, linkSync, copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { config, DATA_DIR, CONFIG_IS_TEST_FIXTURE } from './config.js';
import { writeDurableSync } from './durable.js';
import { reportDataProblem } from './datahealth.js';
import {
  liveFiles, stampOf, listSnapshots, retentionPlan, defaultSnapshotRoot, MANIFEST, DATA_SUBDIR, DEFAULT_KEEP,
} from './snapshotlib.js';

/**
 * Snapshots of the data folder, outside it, so the board can be put back as it
 * was an hour, a day or a week ago.
 *
 * On 2026-11-23 a power cut damaged several data files and the only copies were
 * weeks old. The durable writer (`durable.js`) keeps one previous version next
 * to each file; that survives a cut, not a bad restore, a bug that saves
 * nonsense for an hour, or a deleted folder. This is the history.
 *
 * - **When**: at start-up, before anything writes (`bootsnapshot.js` is the first
 *   import of every module that writes at start-up), and every hour after a
 *   flush that wrote everything (`index.js`).
 * - **How**: hard links of the live files (`snapshotlib.liveFiles`) into
 *   `<root>/<stamp>-<reason>/data/`. A link costs nothing and cannot change
 *   later: every writer replaces a file by renaming a new one over it, so the
 *   snapshot keeps the old inode. Another volume (no hard links) falls back to a copy.
 * - **Check**: a worker thread reads every file of the snapshot (all zeros? valid
 *   JSON?) and writes `manifest.json`. Only a valid snapshot counts for retention;
 *   an invalid one is kept (a damaged file is news: the board says so) but never
 *   pushes a good one out.
 * - **Retention** (`snapshotlib.retentionPlan`): 24 hourly, 14 daily, 8 weekly,
 *   and never the newest valid one.
 * - **Off-site** (optional, `backup.offsiteDir`): once a day, the newest valid
 *   snapshot as one archive there (OneDrive, another disk), the last 7 kept.
 *
 * Where: `HFSMON_SNAPSHOT_DIR`, else `backup.snapshotDir`, else
 * `%LOCALAPPDATA%\hfs-monitor\snapshots`. A board on another data folder
 * (`HFSMON_DATA_DIR`: a test, a second instance) takes none unless one of the
 * first two says where, so it can never mix its files into the real history.
 */

/** Test seam. */
export const snapshotHooks = {
  now: () => new Date(),
  /** Runs the archiver; resolves to its exit code. */
  archive: (file, fromDir) => runArchiver(file, fromDir),
};

const backup = () => config.backup ?? {};

/** The folder the snapshots go to, or null when this board takes none. */
export function snapshotRoot() {
  if (backup().enabled === false) return null;
  if (process.env.HFSMON_SNAPSHOT_DIR) return process.env.HFSMON_SNAPSHOT_DIR;
  if (backup().snapshotDir) return path.resolve(backup().snapshotDir);
  if (process.env.HFSMON_DATA_DIR || CONFIG_IS_TEST_FIXTURE) return null;
  return defaultSnapshotRoot();
}

/** Minutes between the hourly snapshots (`backup.everyMinutes`, default 60; 0 = only at start-up). */
export const snapshotEveryMinutes = () => {
  const n = Number(backup().everyMinutes ?? 60);
  return Number.isFinite(n) && n >= 0 ? n : 60;
};

/** Links made at once by the hourly snapshot. */
const LINK_BATCH = 32;

/** Snapshot folders whose check has not finished: never deleted meanwhile. */
const checking = new Set();

/** A new snapshot folder (never an existing one). */
function newFolder(root, reason) {
  const stamp = stampOf(snapshotHooks.now());
  for (let n = 0; ; n++) {
    const dir = path.join(root, `${stamp}-${reason}${n ? `-${n}` : ''}`);
    if (!existsSync(dir)) {
      mkdirSync(path.join(dir, DATA_SUBDIR), { recursive: true });
      return dir;
    }
  }
}

/** Puts `rel` of the data folder into the snapshot: a hard link, or a copy across volumes. */
function place(dataDir, dir, rel, made) {
  const from = path.join(dataDir, rel);
  const to = path.join(dir, DATA_SUBDIR, rel);
  const parent = path.dirname(to);
  if (!made.has(parent)) { mkdirSync(parent, { recursive: true }); made.add(parent); }
  try {
    linkSync(from, to);
    return 'link';
  } catch (e) {
    if (e.code === 'ENOENT') return 'gone';        // replaced or removed between listing and linking
    copyFileSync(from, to);
    return 'copy';
  }
}

/** The async twin of `place`, for the hourly snapshot: the loop is never held. */
async function placeAsync(dataDir, dir, rel, made) {
  const from = path.join(dataDir, rel);
  const to = path.join(dir, DATA_SUBDIR, rel);
  const parent = path.dirname(to);
  if (!made.has(parent)) { await fsp.mkdir(parent, { recursive: true }); made.add(parent); }
  try {
    await fsp.link(from, to);
    return 'link';
  } catch (e) {
    if (e.code === 'ENOENT') return 'gone';
    await fsp.copyFile(from, to);
    return 'copy';
  }
}

const snapshotFailed = (where, e) => reportDataProblem({
  file: where,
  severity: 'warning',
  problem: `A snapshot of the data folder could not be taken (${e.message})`,
  action: 'The board goes on; the previous snapshots are untouched. Check that the snapshot folder is writable.',
});

/** Links taken: start the check (in a worker) and return what the caller gets. */
function started(dir, files, reason, t0, copies) {
  const ms = Math.round(performance.now() - t0);
  checking.add(dir);
  const checked = check(dir, files, { reason, ms, copies }).finally(() => checking.delete(dir));
  return { dir, files: files.length, ms, checked };
}

/**
 * Takes the snapshot now, synchronously — the start-up one, which must be done
 * before the next line of the importing module writes anything (about 1 ms per
 * file: ~0.3 s for the ~230 files of a large board, before the port opens) — and
 * starts its check in a worker. Never throws: a snapshot that fails is reported.
 *
 * @returns {{dir: string, files: number, ms: number, checked: Promise<object|null>} | null}
 */
export function takeSnapshot(reason = 'manual', { dataDir = DATA_DIR } = {}) {
  const root = snapshotRoot();
  if (!root) return null;
  const t0 = performance.now();
  let dir = null;
  try {
    dir = newFolder(root, reason);
    const files = [];
    const made = new Set();
    let copies = 0;
    for (const rel of liveFiles(dataDir)) {
      const how = place(dataDir, dir, rel, made);
      if (how === 'gone') continue;
      if (how === 'copy') copies += 1;
      files.push(rel);
    }
    return started(dir, files, reason, t0, copies);
  } catch (e) {
    snapshotFailed(dir ?? root, e);
    return null;
  }
}

/**
 * The same, without holding the event loop: the running board's hourly snapshot.
 * A file saved while it links is linked whole, old or new (saves are renames).
 */
export async function takeSnapshotAsync(reason = 'hourly', { dataDir = DATA_DIR } = {}) {
  const root = snapshotRoot();
  if (!root) return null;
  const t0 = performance.now();
  let dir = null;
  try {
    dir = newFolder(root, reason);
    const all = liveFiles(dataDir);
    const made = new Set();
    // Folders first (few), then the links a batch at a time: one file per turn
    // of the thread pool would take seconds for a large board.
    for (const rel of all) {
      const parent = path.dirname(path.join(dir, DATA_SUBDIR, rel));
      if (!made.has(parent)) { await fsp.mkdir(parent, { recursive: true }); made.add(parent); }
    }
    const hows = [];
    for (let i = 0; i < all.length; i += LINK_BATCH) {
      hows.push(...await Promise.all(all.slice(i, i + LINK_BATCH).map((rel) => placeAsync(dataDir, dir, rel, made))));
    }
    const files = all.filter((_, i) => hows[i] !== 'gone');
    const copies = hows.filter((h) => h === 'copy').length;
    return started(dir, files, reason, t0, copies);
  } catch (e) {
    snapshotFailed(dir ?? root, e);
    return null;
  }
}

/** Runs `snapshotcheck.js` on the snapshot's files in a worker; resolves to the problems. */
function checkInWorker(files) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./snapshotcheck.js', import.meta.url), { workerData: { files } });
    w.once('message', resolve);
    w.once('error', reject);
    w.once('exit', (code) => { if (code !== 0) reject(new Error(`check worker exited with ${code}`)); });
    // Not unref'd: a process that ends on its own waits the few seconds of the check,
    // so the snapshot gets its manifest instead of staying «unchecked».
  });
}

/**
 * Checks a snapshot and writes its manifest; then applies retention and, when it
 * is the first valid one of the day, the off-site copy. Resolves to the manifest.
 */
async function check(dir, files, { reason, ms, copies }) {
  try {
    const problems = await checkInWorker(files.map((rel) => ({ rel, file: path.join(dir, DATA_SUBDIR, rel) })));
    let bytes = 0;
    for (const rel of files) { try { bytes += statSync(path.join(dir, DATA_SUBDIR, rel)).size; } catch { /* gone */ } }
    const manifest = {
      version: 1, createdAt: new Date().toISOString(), reason, files: files.length, bytes, linkMs: ms, copies,
      valid: problems.length === 0, problems,
    };
    writeDurableSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
    if (!manifest.valid) {
      reportDataProblem({
        file: path.join(dir, MANIFEST),
        problem: `The ${reason} snapshot found damaged data files: ${problems.slice(0, 5).map((p) => `${p.rel} (${p.problem})`).join(', ')}${problems.length > 5 ? ', …' : ''}`,
        action: `That snapshot is kept but not counted as good; older good snapshots are kept. Snapshot: ${path.basename(dir)}.`,
      });
    }
    await prune(path.dirname(dir));
    if (manifest.valid) await offsite(dir);
    return manifest;
  } catch (e) {
    reportDataProblem({
      file: dir,
      severity: 'warning',
      problem: `A snapshot of the data folder could not be checked (${e.message})`,
      action: 'It is kept unchecked (it never replaces a good one). The previous snapshots are untouched.',
    });
    return null;
  }
}

/** Deletes what retention says; never a snapshot still being checked. */
export async function prune(root = snapshotRoot()) {
  if (!root) return [];
  const list = listSnapshots(root).filter((s) => !checking.has(s.dir));
  const drop = retentionPlan(list, { ...DEFAULT_KEEP, ...(backup().keep ?? {}) });
  for (const name of drop) {
    await fsp.rm(path.join(root, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch((e) => {
      console.error(`[snapshots] no se pudo borrar ${name}: ${e.message}`);
    });
  }
  return drop;
}

const ARCHIVE_RE = /^hfs-monitor-data-(\d{8})\.(zip|tar\.gz)$/;

/** The archiver: Windows' own bsdtar writes a zip; elsewhere a tar.gz. Resolves to its exit code. */
function runArchiver(file, fromDir) {
  const win = process.platform === 'win32';
  const sys = win ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const args = win ? ['-a', '-c', '-f', file, '-C', fromDir, '.'] : ['-czf', file, '-C', fromDir, '.'];
  return new Promise((resolve) => {
    const child = spawn(existsSync(sys) || !win ? sys : 'tar', args, { stdio: 'ignore', windowsHide: true });
    child.once('error', () => resolve(-1));
    child.once('exit', (code) => resolve(code ?? -1));
  });
}

/**
 * The daily off-site copy: when `backup.offsiteDir` is set and it has no archive
 * of today yet, the snapshot `dir` is archived there (to a temp name, renamed
 * when whole), and only the newest `backup.offsiteKeep` (7) archives stay. In a
 * child process: the event loop never waits for it.
 */
export async function offsite(dir) {
  const target = backup().offsiteDir;
  if (!target) return null;
  const day = stampOf(snapshotHooks.now()).slice(0, 8);
  const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
  const file = path.join(target, `hfs-monitor-data-${day}.${ext}`);
  try {
    mkdirSync(target, { recursive: true });
    if (existsSync(file)) return null;
    const tmp = `${file}.partial`;
    await fsp.rm(tmp, { force: true });
    const code = await snapshotHooks.archive(tmp, path.join(dir, DATA_SUBDIR));
    if (code !== 0) throw new Error(`the archiver exited with ${code}`);
    await fsp.rename(tmp, file);
    const keep = Math.max(1, Number(backup().offsiteKeep ?? 7) || 7);
    const archives = readdirSync(target).filter((n) => ARCHIVE_RE.test(n)).sort().reverse();
    for (const old of archives.slice(keep)) await fsp.rm(path.join(target, old), { force: true });
    return file;
  } catch (e) {
    reportDataProblem({
      file: target,
      severity: 'warning',
      problem: `The daily off-site copy of the data could not be written (${e.message})`,
      action: 'The local snapshots are unaffected; it is tried again with the next snapshot.',
    });
    return null;
  }
}

/** The snapshot every `backup.everyMinutes` after a flush that wrote everything. */
export function startSnapshotTimer(flush) {
  const minutes = snapshotEveryMinutes();
  if (!snapshotRoot() || !(minutes > 0)) return null;
  const timer = setInterval(() => {
    let failures;
    try { failures = flush(); } catch (e) { failures = [{ error: e.message }]; }
    if (failures?.length) {
      console.error(`[snapshots] instantánea horaria omitida: el guardado falló (${failures.map((f) => f.error).join('; ')})`);
      return;
    }
    takeSnapshotAsync('hourly');
  }, minutes * 60_000);
  timer.unref?.();
  return timer;
}
