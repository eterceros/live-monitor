import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { tempDir } from './teardown.mjs';
import { moveToTrash, reapTrash, clearHeavyDirs, trashHooks, TRASH_DIR } from '../src/trash.js';
import { removeWorktree } from '../src/worktree.js';
import { LocalMachine } from '../src/machine.js';

/**
 * Deleting a worktree on Windows (`trash.js`): renamed away at once, deleted by
 * a reaper one tree at a time. The first tests use no git and run anywhere; the
 * rest are real git on Windows, where `removeWorktree` takes this path.
 */
const git = (args, cwd) => execFileSync(
  'git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' },
);
const write = (file, text = 'x\n') => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
const restore = (saved) => Object.assign(trashHooks, saved);
const WIN = process.platform === 'win32';

test('moveToTrash lo saca de su sitio al instante y lo deja en .trash', async () => {
  const root = tempDir('hfsmon-trash-');
  const dir = path.join(root, 'feat-1');
  write(path.join(dir, 'node_modules', 'a', 'index.js'));
  const dest = await moveToTrash(root, dir);
  assert.ok(dest, 'se movió');
  assert.equal(existsSync(dir), false);
  assert.equal(path.dirname(dest), path.join(root, TRASH_DIR));
  assert.ok(existsSync(path.join(dest, 'node_modules', 'a', 'index.js')), 'el contenido va entero');
});

test('si el rename se niega (un proceso lo tiene abierto) devuelve null y no toca nada', async (t) => {
  const saved = { ...trashHooks };
  t.after(() => restore(saved));
  const root = tempDir('hfsmon-trash-');
  const dir = path.join(root, 'feat-2');
  write(path.join(dir, 'a.txt'));
  trashHooks.rename = async () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); };
  assert.equal(await moveToTrash(root, dir), null);
  assert.ok(existsSync(path.join(dir, 'a.txt')), 'sigue donde estaba');
});

test('el reaper borra lo que hay en .trash de uno en uno, y varias peticiones no se pisan', async (t) => {
  const saved = { ...trashHooks };
  t.after(() => restore(saved));
  const root = tempDir('hfsmon-trash-');
  for (const n of ['a', 'b', 'c']) write(path.join(root, TRASH_DIR, n, 'f.txt'));
  let running = 0; let peak = 0; const order = [];
  trashHooks.deleteTree = async (dir) => {
    running += 1; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 20));
    order.push(path.basename(dir));
    running -= 1;
  };
  await Promise.all([reapTrash(root), reapTrash(root), reapTrash(root)]);
  assert.equal(peak, 1, 'nunca dos borrados a la vez');
  assert.deepEqual([...new Set(order)].sort(), ['a', 'b', 'c']);
});

test('un borrado que falla no detiene el resto', async (t) => {
  const saved = { ...trashHooks };
  t.after(() => restore(saved));
  const root = tempDir('hfsmon-trash-');
  for (const n of ['a', 'b']) write(path.join(root, TRASH_DIR, n, 'f.txt'));
  const seen = [];
  trashHooks.deleteTree = async (dir) => { seen.push(path.basename(dir)); if (path.basename(dir) === 'a') throw new Error('bloqueado'); };
  const warn = console.warn; console.warn = () => {};
  try { await reapTrash(root); } finally { console.warn = warn; }
  assert.deepEqual(seen.sort(), ['a', 'b']);
});

test('reapTrash de una carpeta sin .trash no es un error', async () => {
  await reapTrash(tempDir('hfsmon-trash-'));
});

test('clearHeavyDirs borra node_modules, target, .next, dist y build, y nada más', async () => {
  const dir = tempDir('hfsmon-trash-');
  for (const n of ['node_modules', 'target', '.next', 'dist', 'build']) write(path.join(dir, n, 'x', 'f.txt'));
  write(path.join(dir, 'src', 'lib.rs'));
  const lines = [];
  await clearHeavyDirs(dir, { onLine: (l) => lines.push(l) });
  assert.deepEqual(readdirSync(dir), ['src']);
  assert.equal(lines.length, 5);
});

function world() {
  const root = tempDir('hfsmon-trash-wt-');
  const repo = path.join(root, 'repo');
  const wtRoot = path.join(root, 'wt');
  mkdirSync(repo); mkdirSync(wtRoot);
  git(['init', '-b', 'main', '.'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 'T'], repo);
  write(path.join(repo, 'a.txt'), 'hola\n');
  write(path.join(repo, '.gitignore'), 'node_modules/\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'seed'], repo);
  const machine = new LocalMachine('t', { repoPath: repo, worktreeRoot: wtRoot });
  const add = (name) => { const wt = path.join(wtRoot, name); git(['worktree', 'add', '-b', name, wt], repo); return wt; };
  const registered = () => (existsSync(path.join(repo, '.git', 'worktrees')) ? readdirSync(path.join(repo, '.git', 'worktrees')) : []);
  return { repo, wtRoot, machine, add, registered };
}

test('removeWorktree en Windows: vuelve en cuanto lo mueve, git lo olvida, la rama queda y la papelera se vacía sola', { skip: !WIN && 'solo Windows usa la papelera' }, async () => {
  const w = world();
  const wt = w.add('feat-3');
  for (let i = 0; i < 200; i++) write(path.join(wt, 'node_modules', `p${i % 10}`, `f${i}.js`));
  const lines = [];
  await removeWorktree(w.machine, wt, { onLine: (l) => lines.push(l) });
  assert.equal(existsSync(wt), false, 'ya no está donde estaba');
  assert.deepEqual(w.registered(), [], 'git lo olvidó');
  assert.ok(lines.some((l) => /deleting it in the background/.test(l)), lines.join('\n'));
  assert.match(git(['branch', '--list', 'feat-3'], w.repo), /feat-3/, 'la rama sigue');
  await reapTrash(w.wtRoot);   // queues behind the one removeWorktree started
  assert.deepEqual(readdirSync(path.join(w.wtRoot, TRASH_DIR)), [], 'la papelera quedó vacía');
});

test('removeWorktree en Windows: un fichero reservado (`nul`) tampoco sobrevive en la papelera', { skip: !WIN && 'solo Windows tiene nombres reservados' }, async () => {
  const w = world();
  const wt = w.add('feat-4');
  writeFileSync(`\\\\?\\${path.resolve(wt, 'nul')}`, 'salida que alguien creyó descartar\n');
  await removeWorktree(w.machine, wt);
  assert.equal(existsSync(wt), false);
  await reapTrash(w.wtRoot);
  assert.deepEqual(readdirSync(path.join(w.wtRoot, TRASH_DIR)), [], 'ni el fichero reservado ni su carpeta');
});

test('removeWorktree en Windows: con el rename negado borra node_modules con rmdir y git hace el resto', { skip: !WIN && 'solo Windows usa la papelera' }, async (t) => {
  const saved = { ...trashHooks };
  t.after(() => restore(saved));
  const w = world();
  const wt = w.add('feat-5');
  write(path.join(wt, 'node_modules', 'a', 'f.js'));
  trashHooks.rename = async () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); };
  const lines = [];
  await removeWorktree(w.machine, wt, { onLine: (l) => lines.push(l) });
  assert.equal(existsSync(wt), false);
  assert.deepEqual(w.registered(), []);
  assert.ok(lines.some((l) => /deleting node_modules with rmdir/.test(l)), lines.join('\n'));
});

test('un worktree fuera de la carpeta de worktrees no se mueve a la papelera', { skip: !WIN && 'solo Windows usa la papelera' }, async () => {
  const w = world();
  const elsewhere = path.join(path.dirname(w.wtRoot), 'otro-sitio', 'feat-6');
  mkdirSync(path.dirname(elsewhere));
  git(['worktree', 'add', '-b', 'feat-6', elsewhere], w.repo);
  await removeWorktree(w.machine, elsewhere);
  assert.equal(existsSync(elsewhere), false);
  assert.equal(existsSync(path.join(w.wtRoot, TRASH_DIR)), false, 'no se creó papelera: tomó el camino de siempre');
});
