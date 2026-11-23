import fs from 'node:fs';
import path from 'node:path';

/**
 * Writes that survive a power cut, and reads that survive the ones that did not.
 *
 * ## Why
 *
 * On 2026-11-23 Windows went down hard. `settings.json` (written straight over
 * itself) and `projectchats.json` came back as files of the right size full of
 * NUL bytes, and five task data files that had gone through tmp + rename were
 * NUL too. That is NTFS doing what it is allowed to: the size and the rename are
 * journaled metadata and land first; the data was still in the cache. A rename
 * protects against a killed process, never against a lost cache.
 *
 * So, for every file the board keeps:
 *
 * 1. **Write**: a temp file, `fsync` (the data is on the disk before anything
 *    points at it), close, keep the previous generation, rename over the target.
 *    After a cut the name holds the old bytes or the new ones, both flushed.
 * 2. **Previous generations** (`<file>.bak`, `<file>.bak.1`, …) are hard links to
 *    the inode the name held before the rename: no copy, O(1) even for 40 MB. That
 *    only works because every writer renames (a write in place would change the
 *    backup too). A file is only rotated into `.bak` when this process knows it is
 *    good (read whole or written by itself), so a damaged file never pushes the
 *    good generations out.
 * 3. **Read**: empty, all-NUL, unparseable or the wrong shape is a problem with a
 *    name, the generations are tried in order, and the damaged file is moved aside
 *    (never overwritten, never deleted) before anyone writes the name again.
 *
 * No directory fsync: Windows refuses one (EPERM), and NTFS journals the rename.
 */

/** Test seam: the file operations, so a test can record their order or make one fail. */
export const durableHooks = {
  ops: {
    openSync: (...a) => fs.openSync(...a),
    writeSync: (...a) => fs.writeSync(...a),
    fsyncSync: (...a) => fs.fsyncSync(...a),
    closeSync: (...a) => fs.closeSync(...a),
    renameSync: (...a) => fs.renameSync(...a),
    linkSync: (...a) => fs.linkSync(...a),
    unlinkSync: (...a) => fs.unlinkSync(...a),
    open: (...a) => fs.promises.open(...a),
  },
};
const ops = () => durableHooks.ops;

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Files this process read whole or wrote itself: the only ones rotated into `.bak`. */
const known = new Set();
const keyOf = (file) => path.resolve(file).toLowerCase();

/** `file` holds good data (just read whole, or just written by us). */
export const markGood = (file) => known.add(keyOf(file));
/** Whether `file` is known good in this process. */
export const isKnownGood = (file) => known.has(keyOf(file));
/** Test seam: forget what was known. */
export const _forgetKnownForTests = () => known.clear();

/** The name of generation `n` of `file`: `.bak`, `.bak.1`, `.bak.2`… */
export const generationPath = (file, n) => `${file}.bak${n ? `.${n}` : ''}`;

/**
 * Moves `file` aside as `<file>.<tag>-<stamp>` (a counter if that exists): never
 * over anything. Returns the new path, or null when it could not be moved.
 */
export function quarantine(file, tag = 'corrupt') {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  for (let n = 0; n < 100; n++) {
    const dest = `${file}.${tag}-${stamp}${n ? `-${n}` : ''}`;
    if (fs.existsSync(dest)) continue;
    try { ops().renameSync(file, dest); return dest; } catch { return null; }
  }
  return null;
}

/**
 * Keeps `generations` previous versions of `file` as hard links, newest in `.bak`.
 * Best effort: a backup that cannot be made never stops the write (it logs).
 */
function rotate(file, generations) {
  if (!(generations > 0) || !isKnownGood(file) || !fs.existsSync(file)) return;
  try {
    for (let i = generations - 1; i >= 1; i--) {
      const from = generationPath(file, i - 1);
      if (fs.existsSync(from)) ops().renameSync(from, generationPath(file, i));
    }
    const fresh = `${generationPath(file, 0)}.new`;
    try { ops().unlinkSync(fresh); } catch { /* none left over */ }
    ops().linkSync(file, fresh);
    ops().renameSync(fresh, generationPath(file, 0));
  } catch (e) {
    console.error(`[durable] ${file}: could not keep the previous version (${e.message})`);
  }
}

const toBuffers = (data) => (Array.isArray(data) ? data : [data]).map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8')));

/**
 * Writes `data` (a string, a Buffer or a list of pieces) to `file` durably and
 * synchronously. Throws after removing the temp file; `file` is untouched then.
 *
 * @param {{generations?: number, tmp?: string, retries?: number}} [opts]
 */
export function writeDurableSync(file, data, { generations = 0, tmp = `${file}.tmp-s`, retries = 12 } = {}) {
  try {
    const fd = ops().openSync(tmp, 'w');
    try {
      for (const buf of toBuffers(data)) {
        let off = 0;
        while (off < buf.length) off += ops().writeSync(fd, buf, off, buf.length - off);
      }
      ops().fsyncSync(fd);
    } finally {
      ops().closeSync(fd);
    }
    rotate(file, generations);
    // Windows can refuse a rename for a moment while a scanner holds the target.
    for (let attempt = 0; ; attempt++) {
      try { ops().renameSync(tmp, file); break; } catch (e) {
        if (attempt >= retries || !RETRYABLE.has(e.code)) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
      }
    }
    markGood(file);
  } catch (e) {
    try { ops().unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
}

/**
 * Same as `writeDurableSync` without blocking the loop: one piece per turn, the
 * fsync on the thread pool. Before renaming it asks `shouldCommit()`; when that
 * says a newer write already landed, the temp file is dropped and it returns false.
 */
export async function writeDurable(file, chunks, { generations = 0, tmp = `${file}.tmp`, shouldCommit = () => true, retries = 4 } = {}) {
  let fh = null;
  try {
    fh = await ops().open(tmp, 'w');
    for (const c of Array.isArray(chunks) ? chunks : [chunks]) await fh.writeFile(c, 'utf8');
    await fh.sync();
    await fh.close();
    fh = null;
    // The check, the rotation and the rename share one turn of the loop, so a
    // synchronous flush cannot slip between them and be overwritten by older text.
    for (let attempt = 0; ; attempt++) {
      if (!shouldCommit()) {
        try { ops().unlinkSync(tmp); } catch { /* already gone */ }
        return false;
      }
      try {
        if (attempt === 0) rotate(file, generations);
        ops().renameSync(tmp, file);
        break;
      } catch (e) {
        if (attempt >= retries || !RETRYABLE.has(e.code)) throw e;
        await sleep(25 * (attempt + 1));
      }
    }
    markGood(file);
    return true;
  } catch (e) {
    try { await fh?.close(); } catch { /* already closed */ }
    try { ops().unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
}

/** Whether every byte is 0 (what a cut leaves where the data never landed). */
export function isAllNul(buf) {
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false;
  return buf.length > 0;
}

/**
 * What is wrong with `buf` as the JSON of `file`, or null when nothing is, plus
 * the parsed value. `validate(value)` may throw to say the shape is wrong.
 */
export function inspectJson(buf, validate) {
  if (!buf.length) return { problem: 'the file is empty' };
  if (isAllNul(buf)) return { problem: `the file is ${buf.length} zero bytes (its data never reached the disk, typically a power cut)` };
  let value;
  try {
    value = JSON.parse(buf.toString('utf8').replace(/^﻿/, ''));
  } catch (e) {
    return { problem: `the file is not valid JSON (${e.message})` };
  }
  try {
    validate?.(value);
  } catch (e) {
    return { problem: `the file has an unexpected shape (${e.message})` };
  }
  return { problem: null, value };
}

/**
 * Reads the JSON of `file`, falling back on its generations.
 *
 * - `{status: 'missing'}`: neither the file nor any generation exists.
 * - `{status: 'ok', value, source, problems, keptAt}`: `source` is the path read.
 *   When it is not `file`, `problems` says what was wrong with the ones before,
 *   and the damaged `file` itself was moved to `keptAt` (when `aside`).
 * - `{status: 'failed', problems, keptAt}`: nothing readable. With `aside`, the
 *   damaged `file` was moved to `keptAt`, so a fresh write cannot destroy it.
 *
 * `aside: 'recovered'` moves the damaged file only when a generation was read in
 * its place: for a caller that refuses to start without the data, the file must
 * still be there for the person to look at.
 *
 * @param {string} file
 * @param {{generations?: number, validate?: (v: any) => void, aside?: boolean | 'recovered'}} [opts]
 */
export function readJsonDurable(file, { generations = 3, validate, aside = true } = {}) {
  const candidates = [file];
  for (let i = 0; i < Math.max(generations, 1); i++) candidates.push(generationPath(file, i));
  const problems = [];
  let found = false;
  let mainBad = false;
  for (const candidate of candidates) {
    let buf;
    try {
      buf = fs.readFileSync(candidate);
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      problems.push({ file: candidate, problem: `could not be read (${e.message})` });
      if (candidate === file) mainBad = true;
      found = true;
      continue;
    }
    found = true;
    const r = inspectJson(buf, validate);
    if (r.problem) {
      problems.push({ file: candidate, problem: r.problem });
      if (candidate === file) mainBad = true;
      continue;
    }
    if (candidate === file) markGood(file);
    else if (!mainBad && !fs.existsSync(file)) problems.push({ file, problem: 'the file is missing' });
    const keptAt = mainBad && aside ? quarantine(file) : null;
    return { status: 'ok', value: r.value, source: candidate, problems, keptAt };
  }
  if (!found) return { status: 'missing', problems };
  const keptAt = mainBad && aside === true ? quarantine(file) : null;
  return { status: 'failed', problems, keptAt };
}
