import { openSync, writeSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

/**
 * Cheap, safe persistence of very large JSON files (`tasks*.json`,
 * `projectchats.json`: tens of MB each).
 *
 * Three problems, three tools:
 *
 * 1. **Re-serializing everything on every write.** `SerCache` keeps the JSON
 *    text of each top-level entry (a task, a holder) and only re-serializes the
 *    ones a caller declared changed (`invalidate`). The file text is the join of
 *    the cached pieces, so the result is byte-for-byte what `JSON.stringify`
 *    would give for the whole object (compact form).
 * 2. **A change nobody declared.** The cache would then keep writing the old
 *    text forever. `SerCache.sweep` re-serializes entries a slice at a time and
 *    reports the ones whose text moved, so the caller can warn and save them;
 *    `revalidate` does the same in one go for the exit path. Neither can lose a
 *    value: they only ever replace a cached text with a fresher one.
 * 3. **A write that blocks, or dies half-way.** `writeAtomicSync` and
 *    `writeChunksAtomic` write to a temp file and `rename` over the target, so
 *    the target is always the old file or the new one — never a truncated one.
 */

/** Pieces of this many characters are handed to the file one at a time. */
const CHUNK_CHARS = 1 << 20;
/** A sweep slice never holds the event loop longer than this (ms), give or take one entry. */
const SLICE_BUDGET_MS = 8;

/** Cache of `serialize(obj)` (default `JSON.stringify`) per object, by identity. */
export class SerCache {
  #texts = new WeakMap();
  #serialize;

  constructor(serialize = JSON.stringify) {
    this.#serialize = serialize;
  }

  /** The compact JSON of `obj`, reused until `invalidate(obj)`. Non-objects are never cached. */
  text(obj) {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    let s = this.#texts.get(obj);
    if (s === undefined) {
      s = this.#serialize(obj);
      this.#texts.set(obj, s);
    }
    return s;
  }

  /** `obj` changed (or may have): its next `text()` serializes again. */
  invalidate(obj) {
    if (obj && typeof obj === 'object') this.#texts.delete(obj);
  }

  /** Drops everything: the next write serializes every entry again. */
  invalidateAll() {
    this.#texts = new WeakMap();
  }

  /** Whether `obj` has cached text (test seam). */
  has(obj) {
    return this.#texts.has(obj);
  }

  /**
   * Re-serializes the cached entries of `items` and replaces any text that has
   * moved. Entries without cached text are skipped (they serialize fresh at the
   * next write anyway). All at once: for the exit path and for tests.
   *
   * @param {Iterable<[string, object]>} items `[label, obj]`.
   * @returns {string[]} labels whose text had changed without `invalidate`.
   */
  revalidate(items) {
    const moved = [];
    for (const [label, obj] of items) {
      if (this.#checkOne(obj)) moved.push(label);
    }
    return moved;
  }

  /**
   * Same check as `revalidate`, but time-sliced so a big store never blocks the
   * loop: it yields to the event loop whenever a slice has used its budget.
   *
   * @param {Iterable<[string, object]>} items `[label, obj]`.
   * @returns {Promise<string[]>} labels whose text had changed without `invalidate`.
   */
  async sweep(items) {
    const moved = [];
    let start = performance.now();
    for (const [label, obj] of items) {
      if (this.#checkOne(obj)) moved.push(label);
      if (performance.now() - start > SLICE_BUDGET_MS) {
        await new Promise((r) => setImmediate(r));
        start = performance.now();
      }
    }
    return moved;
  }

  /** true when `obj` had cached text that is no longer true (and drops it). */
  #checkOne(obj) {
    const cached = this.#texts.get(obj);
    if (cached === undefined) return false;
    if (this.#serialize(obj) === cached) return false;
    this.#texts.delete(obj);
    return true;
  }
}

/**
 * The text of `{ "<key>": <value>, … }` as a list of pieces (~1 MB each), each
 * value from the cache. `prefix`/`suffix` wrap the object (`{"version":1,"holders":` … `}`).
 *
 * @param {SerCache | ((value: object, key: string) => string)} cache where each value's text comes from.
 * @param {[string, object][]} entries in the order they must appear.
 */
export function objectChunks(cache, entries, { prefix = '', suffix = '' } = {}) {
  const textOf = typeof cache === 'function' ? cache : (v) => cache.text(v);
  const out = new ChunkBuilder();
  out.add(`${prefix}{`);
  let first = true;
  for (const [key, value] of entries) {
    out.add(`${first ? '' : ','}${JSON.stringify(key)}:${textOf(value, key)}`);
    first = false;
  }
  out.add(`}${suffix}`);
  return out.done();
}

/** Collects text into pieces of ~1 MB, the unit the writers hand to the file. */
export class ChunkBuilder {
  #chunks = [];
  #buf = '';

  add(text) {
    this.#buf += text;
    if (this.#buf.length >= CHUNK_CHARS) {
      this.#chunks.push(this.#buf);
      this.#buf = '';
    }
  }

  done() {
    if (this.#buf || !this.#chunks.length) this.#chunks.push(this.#buf);
    this.#buf = '';
    return this.#chunks;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Writes `chunks` to `<file>.tmp-s` and renames it over `file`, synchronously.
 * Throws after removing the temp file; `file` is untouched in that case.
 */
export function writeAtomicSync(file, chunks) {
  const tmp = `${file}.tmp-s`;
  try {
    const fd = openSync(tmp, 'w');
    try {
      for (const c of chunks) {
        const buf = Buffer.from(c, 'utf8');
        let off = 0;
        while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
      }
    } finally {
      closeSync(fd);
    }
    // Windows can refuse a rename for a moment while a scanner holds the target.
    // This is the way-out path (nothing can wait for it later): ~2 s of retries.
    for (let attempt = 0; ; attempt++) {
      try { renameSync(tmp, file); break; } catch (e) {
        if (attempt >= 12 || !RETRYABLE.has(e.code)) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
      }
    }
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
}

/**
 * Writes `chunks` to `<file>.tmp` without blocking the loop (one piece per
 * turn), then renames it over `file` — unless `shouldCommit()` says a newer
 * write already landed, in which case the temp file is dropped and `false` is
 * returned. Throws after removing the temp file; `file` is untouched then.
 *
 * @returns {Promise<boolean>} whether `file` now holds these chunks.
 */
export async function writeChunksAtomic(file, chunks, shouldCommit = () => true) {
  const tmp = `${file}.tmp`;
  let fh = null;
  try {
    fh = await open(tmp, 'w');
    for (const c of chunks) await fh.writeFile(c, 'utf8');
    await fh.close();
    fh = null;
    // The check and the rename share one turn of the loop (`renameSync`), so a
    // synchronous flush cannot slip between them and be overwritten by older text.
    for (let attempt = 0; ; attempt++) {
      if (!shouldCommit()) {
        await unlink(tmp).catch(() => {});
        return false;
      }
      try { renameSync(tmp, file); break; } catch (e) {
        if (attempt >= 4 || !RETRYABLE.has(e.code)) throw e;
        await sleep(25 * (attempt + 1));
      }
    }
    return true;
  } catch (e) {
    try { await fh?.close(); } catch { /* already closed */ }
    await unlink(tmp).catch(() => {});
    throw e;
  }
}
