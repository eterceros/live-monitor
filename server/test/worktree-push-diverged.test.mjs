import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { createWorktree, pushBranch, mergeInProgress } from '../src/worktree.js';
import { LocalMachine } from '../src/machine.js';

/**
 * A rejected push (origin has commits the branch lacks: a rebase, an amend, or
 * someone else pushing) is integrated with a merge and pushed again, and never
 * forced. Real git against a bare origin: what matters is what the second push
 * leaves on origin and in the worktree.
 */
const git = (args, cwd) => execFileSync(
  'git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' },
);

const write = (dir, name, data) => {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  writeFileSync(path.join(dir, name), data);
};

function world() {
  const root = mkdtempSync(path.join(tmpdir(), 'hfsmon-diverged-'));
  const configure = (repo, name) => {
    git(['config', 'user.email', `${name.toLowerCase().replace(/\W+/g, '.')}@example.com`], repo);
    git(['config', 'user.name', name], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);
    git(['config', 'core.autocrlf', 'false'], repo);
  };
  const origin = path.join(root, 'origin.git');
  mkdirSync(origin);
  git(['init', '--bare', '-b', 'main', '.'], origin);
  const seed = path.join(root, 'seed');
  git(['clone', origin, seed], root);
  configure(seed, 'Seed');
  write(seed, 'shared.txt', 'uno\ndos\ntres\n');
  write(seed, 'mine.txt', 'mio\n');
  git(['add', '.'], seed);
  git(['commit', '-m', 'seed'], seed);
  git(['push', '-u', 'origin', 'main'], seed);

  const clone = (name, who) => {
    const repo = path.join(root, name);
    git(['clone', origin, repo], root);
    configure(repo, who);
    return { repo, wtRoot: path.join(root, `${name}-wt`), m: new LocalMachine(name, { repoPath: repo, worktreeRoot: path.join(root, `${name}-wt`) }) };
  };
  return { root, origin, board: clone('board', 'Board User'), other: clone('other', 'Otra Persona'), cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 3 }) };
}

/** The board's worktree with one pushed commit, and another person pushing on top of it from their clone. */
async function diverge(w, branch, { theirFile, theirText }) {
  const wt = await createWorktree(w.board.m, branch);
  write(wt, 'mine.txt', 'mio v1\n');
  git(['add', '--', 'mine.txt'], wt);
  git(['commit', '-m', 'work'], wt);
  await pushBranch(w.board.m, wt, branch);

  git(['fetch', 'origin', branch], w.other.repo);
  git(['checkout', '-b', branch, `origin/${branch}`], w.other.repo);
  write(w.other.repo, theirFile, theirText);
  git(['add', '--', theirFile], w.other.repo);
  git(['commit', '-m', 'their change'], w.other.repo);
  git(['push', 'origin', branch], w.other.repo);
  return wt;
}

test('un push normal no toca nada y dice que no hubo merge', async (t) => {
  const w = world();
  t.after(w.cleanup);
  const wt = await createWorktree(w.board.m, 'feat/1-uno');
  write(wt, 'mine.txt', 'mio v1\n');
  git(['add', '--', 'mine.txt'], wt);
  git(['commit', '-m', 'work'], wt);
  assert.deepEqual(await pushBranch(w.board.m, wt, 'feat/1-uno'), { merged: false, remoteOnly: [] });
});

test('rama reescrita con commits ajenos en origin: se integran con merge y el push sale, sin forzar', async (t) => {
  const w = world();
  t.after(w.cleanup);
  const branch = 'feat/2-dos';
  const wt = await diverge(w, branch, { theirFile: 'theirs.txt', theirText: 'suyo\n' });
  const theirs = git(['rev-parse', `refs/heads/${branch}`], w.origin).trim();

  git(['commit', '--amend', '-m', 'work, reworded'], wt);   // rewrites the pushed commit: a plain push is now rejected
  const lines = [];
  const res = await pushBranch(w.board.m, wt, branch, { onLine: (l) => lines.push(l) });

  assert.equal(res.merged, true);
  // The amended commit's old version is also «only on origin»: two commits, two authors, newest first.
  assert.deepEqual(res.remoteOnly.map((c) => [c.author, c.subject]), [['Otra Persona', 'their change'], ['Board User', 'work']]);
  assert.ok(lines.some((l) => /push rejected: origin\/feat\/2-dos has 2 commit\(s\) this branch lacks \(by Otra Persona, Board User\)/.test(l)), lines.join('\n'));
  // Their commit is still an ancestor of origin's tip: nothing was overwritten.
  git(['merge-base', '--is-ancestor', theirs, `refs/heads/${branch}`], w.origin);
  assert.equal(git(['show', `${branch}:theirs.txt`], w.origin), 'suyo\n');
  assert.equal(git(['show', `${branch}:mine.txt`], w.origin), 'mio v1\n');
  assert.equal(await mergeInProgress(w.board.m, wt), false);
});

test('si el merge choca: se aborta, el worktree queda como estaba y origin no cambia', async (t) => {
  const w = world();
  t.after(w.cleanup);
  const branch = 'feat/3-tres';
  const wt = await diverge(w, branch, { theirFile: 'mine.txt', theirText: 'mio version de otra persona\n' });
  const originTip = git(['rev-parse', `refs/heads/${branch}`], w.origin).trim();

  write(wt, 'mine.txt', 'mio v2 reescrito\n');
  git(['add', '--', 'mine.txt'], wt);
  git(['commit', '--amend', '-m', 'work rewritten'], wt);
  const head = git(['rev-parse', 'HEAD'], wt).trim();

  await assert.rejects(
    () => pushBranch(w.board.m, wt, branch),
    (e) => e.code === 'PUSH_DIVERGED' && /conflicts in mine\.txt/.test(e.message) && /nothing was forced/.test(e.message)
      && /ask the chat .*merge origin\/feat\/3-tres into this branch.*do not rebase or force-push/.test(e.message)
      && e.remoteOnly.length === 2 && e.remoteOnly[0].author === 'Otra Persona',
  );
  assert.equal(await mergeInProgress(w.board.m, wt), false, 'no queda un merge a medias');
  assert.equal(git(['rev-parse', 'HEAD'], wt).trim(), head, 'la rama local no se movió');
  assert.equal(git(['status', '--porcelain'], wt).trim(), '', 'sin archivos en conflicto');
  assert.equal(git(['rev-parse', `refs/heads/${branch}`], w.origin).trim(), originTip, 'origin intacto');
});

test('un rechazo de un hook (remote rejected) no es una divergencia: sigue siendo un error de push, sin merge', async (t) => {
  const w = world();
  t.after(w.cleanup);
  const wt = await createWorktree(w.board.m, 'feat/4-cuatro');
  write(wt, 'mine.txt', 'x\n');
  git(['add', '--', 'mine.txt'], wt);
  git(['commit', '-m', 'work'], wt);
  // A hook that declines is `[remote rejected]`, not a divergence: merging would not help.
  write(w.origin, 'hooks/pre-receive', '#!/bin/sh\necho "no pushes today" >&2\nexit 1\n');
  execFileSync('chmod', ['+x', path.join(w.origin, 'hooks', 'pre-receive')]);
  await assert.rejects(() => pushBranch(w.board.m, wt, 'feat/4-cuatro'), (e) => /git push failed/.test(e.message) && e.code !== 'PUSH_DIVERGED');
});
