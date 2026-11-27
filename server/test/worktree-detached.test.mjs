import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync, utimesSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './teardown.mjs';
import { execFileSync } from 'node:child_process';

import { createWorktree, ensureDetachedWorktree, refreshDetachedWorktree } from '../src/worktree.js';
import { LocalMachine } from '../src/machine.js';

/** Against real git: what `status` and `merge-base` answer is the whole point. */
const git = (args, cwd) => execFileSync(
  'git',
  ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
  { cwd, stdio: 'pipe', encoding: 'utf8' },
).trim();

function fixture() {
  const root = tempDir('hfsmon-detached-');
  const repo = path.join(root, 'repo');
  const wtRoot = path.join(root, 'wt');
  const origin = path.join(root, 'origin.git');
  const pusher = path.join(root, 'pusher');
  mkdirSync(repo);
  git(['init', '--bare', '-b', 'main', origin], root);
  git(['init', '-b', 'main', '.'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  writeFileSync(path.join(repo, 'a.txt'), 'uno\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'seed'], repo);
  git(['remote', 'add', 'origin', origin], repo);
  git(['push', '-q', 'origin', 'main'], repo);
  // A second clone plays "the team": it advances origin/main.
  git(['clone', '-q', origin, pusher], root);
  git(['config', 'user.email', 'test@example.com'], pusher);
  git(['config', 'user.name', 'Test'], pusher);
  const machine = new LocalMachine('test', { repoPath: repo, worktreeRoot: wtRoot });
  return {
    repo, wtRoot, machine,
    advanceOrigin(text = 'dos\n') {
      writeFileSync(path.join(pusher, 'a.txt'), text);
      git(['commit', '-qam', 'advance'], pusher);
      git(['push', '-q', 'origin', 'main'], pusher);
      return git(['rev-parse', '--short', 'HEAD'], pusher);
    },
  };
}

test('ensureDetachedWorktree creates a detached worktree at origin/<base>', async () => {
  const f = fixture();
  const p = await ensureDetachedWorktree(f.machine, 'main', '_proyecto');
  assert.equal(p, path.join(f.wtRoot, '_proyecto'));
  assert.ok(existsSync(path.join(p, 'a.txt')));
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], p), 'HEAD', 'detached');
  assert.equal(git(['rev-parse', 'HEAD'], p), git(['rev-parse', 'origin/main'], f.repo));
});

test('ensureDetachedWorktree reuses an existing project worktree and refuses a plain directory', async () => {
  const f = fixture();
  const first = await ensureDetachedWorktree(f.machine, 'main', '_proyecto');
  const lines = [];
  const again = await ensureDetachedWorktree(f.machine, 'main', '_proyecto', { onLine: (l) => lines.push(l) });
  assert.equal(again, first);
  assert.ok(lines.some((l) => /reusing it/.test(l)));

  mkdirSync(path.join(f.wtRoot, 'otro'));
  await assert.rejects(() => ensureDetachedWorktree(f.machine, 'main', 'otro'), /not a worktree/);
});

test('ensureDetachedWorktree prunes a stale registration before adding', async () => {
  const f = fixture();
  const p = await ensureDetachedWorktree(f.machine, 'main', '_proyecto');
  rmSync(p, { recursive: true, force: true }); // folder gone, registration left behind
  const again = await ensureDetachedWorktree(f.machine, 'main', '_proyecto');
  assert.equal(again, p);
  assert.ok(existsSync(path.join(p, 'a.txt')));
});

test('refresh moves a clean detached worktree to the new origin/<base>', async () => {
  const f = fixture();
  const p = await ensureDetachedWorktree(f.machine, 'main', '_proyecto');
  const sha = f.advanceOrigin();
  const r = await refreshDetachedWorktree(f.machine, p, 'main');
  assert.equal(r.moved, true);
  assert.equal(r.note, null);
  assert.equal(r.head.branch, null);
  assert.equal(r.head.sha, sha);
  assert.equal(git(['rev-parse', '--short', 'HEAD'], p), sha);
});

test('refresh with nothing new is not a move and has no note', async () => {
  const f = fixture();
  const p = await ensureDetachedWorktree(f.machine, 'main', '_proyecto');
  const r = await refreshDetachedWorktree(f.machine, p, 'main');
  assert.equal(r.moved, false);
  assert.equal(r.note, null);
});

test('refresh does NOT move when on a branch', async () => {
  const f = fixture();
  const p = await ensureDetachedWorktree(f.machine, 'main', '_proyecto');
  git(['checkout', '-q', '-b', 'feat/x'], p);
  const before = git(['rev-parse', 'HEAD'], p);
  f.advanceOrigin();
  const r = await refreshDetachedWorktree(f.machine, p, 'main');
  assert.equal(r.moved, false);
  assert.match(r.note, /branch feat\/x/);
  assert.equal(r.head.branch, 'feat/x');
  assert.equal(git(['rev-parse', 'HEAD'], p), before);
});

test('refresh does NOT move when the tree is dirty', async () => {
  const f = fixture();
  const p = await ensureDetachedWorktree(f.machine, 'main', '_proyecto');
  const before = git(['rev-parse', 'HEAD'], p);
  writeFileSync(path.join(p, 'a.txt'), 'cambio mio\n');
  f.advanceOrigin('dos\n');
  const r = await refreshDetachedWorktree(f.machine, p, 'main');
  assert.equal(r.moved, false);
  assert.match(r.note, /uncommitted changes/);
  assert.equal(git(['rev-parse', 'HEAD'], p), before);
});

test('refresh does NOT move when HEAD is not an ancestor of origin/<base>', async () => {
  const f = fixture();
  const p = await ensureDetachedWorktree(f.machine, 'main', '_proyecto');
  git(['config', 'user.email', 'test@example.com'], p);
  git(['config', 'user.name', 'Test'], p);
  writeFileSync(path.join(p, 'b.txt'), 'mio\n');
  git(['add', 'b.txt'], p);
  git(['commit', '-qm', 'local work'], p); // detached commit, nowhere else
  const before = git(['rev-parse', 'HEAD'], p);
  f.advanceOrigin();
  const r = await refreshDetachedWorktree(f.machine, p, 'main');
  assert.equal(r.moved, false);
  assert.match(r.note, /not in origin\/main/);
  assert.equal(git(['rev-parse', 'HEAD'], p), before);
});

test('a stat-only change (mtime touched, content identical) is not dirty', async () => {
  const f = fixture();
  const p = await ensureDetachedWorktree(f.machine, 'main', '_proyecto');
  const file = path.join(p, 'a.txt');
  // Same bytes, new mtime: exactly what a compile leaves behind. The file is not
  // rewritten: with autocrlf on, LF over the CRLF checkout would be a real change.
  const future = new Date(Date.now() + 60_000);
  utimesSync(file, future, future);
  const sha = f.advanceOrigin();
  const r = await refreshDetachedWorktree(f.machine, p, 'main');
  assert.equal(r.moved, true, `stat-only must not count as dirty (note: ${r.note})`);
  assert.equal(r.head.sha, sha);
});

test('without the project checkout neither worktree call makes any directory', async () => {
  const root = tempDir('hfsmon-nocheckout-');
  const wtRoot = path.join(root, 'repo-wt');
  const machine = new LocalMachine('test', { repoPath: path.join(root, 'repo'), worktreeRoot: wtRoot });
  const missing = (e) => e.code === 'checkout_missing' && e.message.includes(`checkout missing at ${machine.repoPath}`);
  await assert.rejects(() => ensureDetachedWorktree(machine, 'main', '_proyecto'), missing);
  await assert.rejects(() => createWorktree(machine, 'feat/1-x'), missing);
  assert.equal(existsSync(wtRoot), false);
});
