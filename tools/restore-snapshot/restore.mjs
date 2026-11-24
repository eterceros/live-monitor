#!/usr/bin/env node
/**
 * Lists the board's data snapshots and restores one, without overwriting anything.
 *
 * Usage
 * -----
 *   node tools/restore-snapshot/restore.mjs list [--dir <snapshots>]
 *   node tools/restore-snapshot/restore.mjs restore <name|latest> [--dir <snapshots>] [--to <folder>]
 *   node tools/restore-snapshot/restore.mjs restore <name|latest> --into-data [--data <data-dir>] [--port <n>]
 *
 * `--dir` defaults to where the board puts them: `HFSMON_SNAPSHOT_DIR`, else
 * `backup.snapshotDir` of config(.local).json, else `%LOCALAPPDATA%\hfs-monitor\snapshots`.
 *
 * `restore` copies the snapshot's files into a NEW folder (`--to`, default
 * `./restored-<name>`); an existing non-empty folder is refused. Look at it,
 * compare, copy what you need by hand.
 *
 * `--into-data` puts them back into the board's data folder (`--data`, default
 * `server/data`). Only with the board stopped (its port must be free), and every
 * file it would replace is first moved to `<data>/.pre-restore-<stamp>/`, so the
 * restore itself can be undone. Files the snapshot does not have are left alone.
 *
 * A snapshot whose check found damaged files is refused unless `--allow-invalid`;
 * one never checked (the board stopped while checking it) needs `--allow-unchecked`.
 * Nothing of the board is loaded: only `server/src/snapshotlib.js` (pure).
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, copyFileSync, renameSync, constants } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSnapshots, defaultSnapshotRoot, DATA_SUBDIR, stampOf } from '../../server/src/snapshotlib.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (['into-data', 'allow-invalid', 'allow-unchecked'].includes(key)) out[key] = true;
      else out[key] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

/** config.json with config.local.json over it (shallow enough for `port` and `backup`). */
function readConfig(root) {
  const read = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return {}; } };
  const base = read(process.env.HFSMON_CONFIG ?? path.join(root, 'config.json'));
  const local = read((process.env.HFSMON_CONFIG ?? path.join(root, 'config.json')).replace(/\.json$/, '.local.json'));
  return { ...base, ...local, backup: { ...(base.backup ?? {}), ...(local.backup ?? {}) } };
}

export function snapshotDirOf(args, cfg) {
  if (args.dir) return path.resolve(args.dir);
  if (process.env.HFSMON_SNAPSHOT_DIR) return process.env.HFSMON_SNAPSHOT_DIR;
  if (cfg.backup?.snapshotDir) return path.resolve(ROOT, cfg.backup.snapshotDir);
  return defaultSnapshotRoot();
}

/** Every file under `dir`, relative, forward slashes. */
function filesUnder(dir, rel = '') {
  const out = [];
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesUnder(dir, child));
    else if (e.isFile()) out.push(child);
  }
  return out;
}

/** Whether something answers on 127.0.0.1:`port` (a board still running). */
export function portBusy(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => { s.destroy(); resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1500, () => done(false));
  });
}

const human = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

/**
 * Runs the command. Returns the exit code; prints with `log` / `err`.
 * @param {string[]} argv
 */
export async function main(argv, { log = console.log, err = console.error, root = ROOT, cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  const [cmd, which] = args._;
  const cfg = readConfig(root);
  const snapDir = snapshotDirOf(args, cfg);
  const list = listSnapshots(snapDir);

  if (cmd === 'list') {
    if (!list.length) { log(`No snapshots in ${snapDir}`); return 0; }
    log(`Snapshots in ${snapDir} (newest first):`);
    for (const s of list) {
      const m = s.manifest;
      const detail = m ? `${m.files} files, ${human(m.bytes ?? 0)}${m.valid ? '' : `, damaged: ${m.problems.map((p) => p.rel).join(', ')}`}` : 'not checked';
      log(`  ${s.name}  ${s.status.padEnd(9)}  ${detail}`);
    }
    return 0;
  }

  if (cmd !== 'restore' || !which) {
    err('Usage: restore.mjs list [--dir <snapshots>] | restore <name|latest> [--to <folder> | --into-data [--data <dir>]]');
    return 2;
  }
  const snap = which === 'latest' ? list.find((s) => s.status === 'valid') : list.find((s) => s.name === which);
  if (!snap) { err(`No ${which === 'latest' ? 'valid snapshot' : `snapshot named ${which}`} in ${snapDir}`); return 1; }
  if (snap.status === 'invalid' && !args['allow-invalid']) {
    err(`${snap.name} has damaged files (${snap.manifest.problems.map((p) => `${p.rel}: ${p.problem}`).join('; ')}). Use --allow-invalid to restore it anyway.`);
    return 1;
  }
  if (snap.status === 'unchecked' && !args['allow-unchecked']) {
    err(`${snap.name} was never checked. Use --allow-unchecked to restore it anyway.`);
    return 1;
  }
  const from = path.join(snap.dir, DATA_SUBDIR);
  const files = filesUnder(from);

  if (!args['into-data']) {
    const to = path.resolve(cwd, args.to ?? `restored-${snap.name}`);
    if (existsSync(to) && readdirSync(to).length) { err(`${to} exists and is not empty; choose another --to`); return 1; }
    for (const rel of files) {
      const dest = path.join(to, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(path.join(from, rel), dest, constants.COPYFILE_EXCL);
    }
    log(`Restored ${files.length} files of ${snap.name} into ${to}. Nothing else was touched.`);
    return 0;
  }

  const data = path.resolve(args.data ?? process.env.HFSMON_DATA_DIR ?? path.join(root, 'server', 'data'));
  const port = Number(args.port ?? cfg.port ?? 7420);
  if (await portBusy(port)) { err(`Something answers on port ${port}: stop the board first (stop.ps1).`); return 1; }
  if (existsSync(path.join(root, '.hfs-monitor.pid'))) {
    err(`${path.join(root, '.hfs-monitor.pid')} exists: the board may be running. Stop it first (stop.ps1).`);
    return 1;
  }
  const aside = path.join(data, `.pre-restore-${stampOf(new Date())}`);
  let moved = 0;
  for (const rel of files) {
    const dest = path.join(data, rel);
    if (existsSync(dest)) {
      const keep = path.join(aside, rel);
      mkdirSync(path.dirname(keep), { recursive: true });
      renameSync(dest, keep);
      moved += 1;
    }
  }
  for (const rel of files) {
    const dest = path.join(data, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(path.join(from, rel), dest, constants.COPYFILE_EXCL);
  }
  log(`Restored ${files.length} files of ${snap.name} into ${data}.`);
  log(moved ? `The ${moved} files it replaced are in ${aside}.` : 'It replaced no file.');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e.message); process.exitCode = 1; });
}

