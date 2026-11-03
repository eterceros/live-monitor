import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Deleting a worktree on Windows, without making anyone wait for it.
 *
 * NTFS has no «delete this tree» call: every program deletes file by file, and
 * Defender looks at each one. A worktree with its `node_modules` or `target`
 * has tens of thousands of files, and `git worktree remove --force` took a
 * minute or more for each of them, with several at once saturating the disk
 * until the board itself crawled. Two measured ways out (15 000 small files):
 * `rmdir /s /q` is about 2.6 times faster than git, and a rename is instant.
 *
 * So the folder is renamed into `<worktreeRoot>/.trash` (same volume, instant,
 * and git forgets the worktree on the next `prune`), and a reaper deletes what
 * is in there with `rmdir /s /q`, one tree at a time and out of the way. Whatever
 * a crash leaves behind is reaped on the next start (`reapTrash`).
 *
 * Only for a local Windows machine, and only for a worktree directly under the
 * worktree root: anywhere else the caller keeps its old path.
 */
export const TRASH_DIR = '.trash';

/** Seams for the tests: the rename that must be instant and the deletion that must not be waited for. */
export const trashHooks = {
  rename: (from, to) => fsp.rename(from, to),
  deleteTree: (dir) => deleteTree(dir),
};

/** Folders that hold most of a worktree's weight and nothing anyone wants kept. */
export const HEAVY_DIRS = ['node_modules', 'target', '.next', 'dist', 'build'];

/** Whether this machine is the one this module is for. */
export const canTrash = (machine) => machine.kind === 'local' && machine.platform === 'win32';

const trashDir = (root) => path.join(root, TRASH_DIR);
let counter = 0;

/**
 * Moves `dir` into `<root>/.trash`. Returns where it went, or null when the
 * rename was refused (a process holds a file or stands inside it): the caller
 * then deletes it the slow way.
 */
export async function moveToTrash(root, dir) {
  const dest = path.join(trashDir(root), `${path.basename(dir)}-${Date.now().toString(36)}${(counter++).toString(36)}`);
  try {
    mkdirSync(trashDir(root), { recursive: true });
    await trashHooks.rename(dir, dest);
    return dest;
  } catch {
    return null;
  }
}

/**
 * `rmdir /s /q` first. A name Windows reserves (`nul`, `con`…) exists in a
 * worktree when somebody wrote `> nul` under bash, and only the `\\?\` form of
 * the path can delete it: what `rmdir` leaves behind goes that way.
 */
async function deleteTree(dir) {
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const child = spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], { stdio: 'ignore', windowsHide: true });
      // Out of the way of the board: it is a chore, not something anyone waits for.
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* already gone, or not allowed */ }
      child.on('error', resolve);
      child.on('close', resolve);
    });
  }
  if (existsSync(dir)) {
    const target = process.platform === 'win32' ? `\\\\?\\${path.resolve(dir)}` : dir;
    await fsp.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
  }
}

/** Deletes the heavy folders at the top of `dir` (the slow path's first step). */
export async function clearHeavyDirs(dir, { onLine } = {}) {
  for (const name of HEAVY_DIRS) {
    const sub = path.join(dir, name);
    if (!existsSync(sub)) continue;
    onLine?.(`deleting ${name} with rmdir before git removes the rest`);
    await trashHooks.deleteTree(sub);
  }
}

const chains = new Map();

/**
 * Deletes everything in `<root>/.trash`, one tree at a time. Calls for the same
 * root queue behind each other, so ten removals never mean ten deletions at once.
 * The promise is for tests and for the start-up sweep; callers do not wait on it.
 */
export function reapTrash(root) {
  const key = path.resolve(root).toLowerCase();
  const next = (chains.get(key) ?? Promise.resolve()).then(async () => {
    let names;
    try { names = await fsp.readdir(trashDir(root)); } catch { return; }
    for (const name of names) {
      try { await trashHooks.deleteTree(path.join(trashDir(root), name)); } catch (e) { console.warn(`[trash] ${name}: ${e.message}`); }
    }
  });
  chains.set(key, next);
  return next;
}
