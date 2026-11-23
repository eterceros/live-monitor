import { writeDurableSync, writeDurable } from './durable.js';
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
 *    `writeChunksAtomic` write to a temp file, fsync it and `rename` it over the
 *    target, so the target is always the old file or the new one — never a
 *    truncated one, and (thanks to the fsync) never one full of zeros after a
 *    power cut either: a rename alone only protects against a killed process.
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

/**
 * Writes `chunks` to `<file>.tmp-s`, fsyncs it and renames it over `file`,
 * synchronously (`durable.js`). Throws after removing the temp file; `file` is
 * untouched in that case. `generations` previous versions are kept as `.bak`.
 */
export function writeAtomicSync(file, chunks, { generations = 0 } = {}) {
  writeDurableSync(file, chunks, { generations, tmp: `${file}.tmp-s` });
}

/**
 * Writes `chunks` to `<file>.tmp` without blocking the loop (one piece per
 * turn), fsyncs it, then renames it over `file` — unless `shouldCommit()` says a
 * newer write already landed, in which case the temp file is dropped and `false`
 * is returned. Throws after removing the temp file; `file` is untouched then.
 *
 * @returns {Promise<boolean>} whether `file` now holds these chunks.
 */
export function writeChunksAtomic(file, chunks, shouldCommit = () => true, { generations = 0 } = {}) {
  return writeDurable(file, chunks, { generations, shouldCommit, tmp: `${file}.tmp` });
}
