import { machineFor, requireProject } from './machine.js';
import { shared } from './inflight.js';
import { assertPushIdentity } from './gh-account.js';

/**
 * Git on a task's worktree. Every function takes the `Machine` the worktree
 * lives on first: the same `git rev-parse` runs here for a local task and on
 * the dev box for a remote one, and the path arithmetic follows that machine's
 * conventions (`machine.path`), not this process's.
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'is', 'are',
  'with', 'when', 'not', 'does', 'should', 'from', 'that', 'this', 'via',
  'el', 'la', 'los', 'las', 'de', 'del', 'en', 'un', 'una', 'y', 'o', 'que',
  'con', 'para', 'por', 'no', 'se', 'al', 'es',
]);

/**
 * Branch convention (HeliosSoftware/hfs, CONTRIBUTING.md): `<type>/<number>-<slug>`.
 * `fix/` when the issue is labeled `bug`, `feat/` otherwise (the default).
 * Slug: 2-4 lowercase hyphenated words from the title — the subject, not the symptom.
 */
export function deriveBranchName(issue) {
  const type = issue.labels.includes('bug') ? 'fix' : 'feat';
  const words = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .slice(0, 4);
  const slug = words.length >= 2 ? words.join('-') : 'fix';
  return `${type}/${issue.number}-${slug}`;
}

/**
 * Branches that belong to an issue: the segment after the type prefix starts
 * with the number. Handles the multi-issue form too (`fix/765-790-791-slug`),
 * where the leading numbers are joined with hyphens.
 */
export function branchBelongsToIssue(branch, issueNumber) {
  const name = branch.replace(/^origin\//, '');
  const tail = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
  const leading = tail.match(/^(\d+(?:-\d+)*)(?:[-_/]|$)/);
  if (!leading) return false;
  return leading[1].split('-').includes(String(issueNumber));
}

// Classifying a backlog asks about every issue in a row; fetching and listing
// refs once per issue would mean dozens of `git fetch` calls per poll. Branches
// are what GitHub knows about, so the local clone is enough to ask.
const BRANCH_TTL_MS = 60_000;

/**
 * One entry per project, not one list. The cache is filled from a project's
 * own checkout, and a second project's branches are simply not in the first
 * one's — a shared list would answer `fix/12-...` for an issue of a repository
 * that never had that branch, and the pipeline would adopt it.
 *
 * @type {Map<string, {at: number, list: string[]}>}
 */
const branchCaches = new Map();

const EMPTY = { at: 0, list: [] };

/**
 * Every local and remote branch of a project, cached for a minute.
 *
 * @param {{force?: boolean, project: string}} opts `project` is required.
 * @returns {Promise<string[]>}
 */
export async function listAllBranches({ force = false, project } = {}) {
  requireProject(project, 'listAllBranches');
  const cached = branchCaches.get(project) ?? EMPTY;
  if (!force && Date.now() - cached.at < BRANCH_TTL_MS) return cached.list;
  if (!force) {
    // A forced fetch under way is at least as fresh as what this call wants.
    return branchInflight.get(`${project}:force`)
      ?? shared(branchInflight, project, () => fetchBranches(project));
  }
  // Forced: wait for an unforced one under way (its fetch may predate the
  // caller's wish), then fetch; identical forced calls share one promise.
  return shared(branchInflight, `${project}:force`, async () => {
    const plain = branchInflight.get(project);
    if (plain) await plain.catch(() => {});
    return fetchBranches(project);
  });
}

const branchInflight = new Map();   // project | project:force -> in-flight fetch

async function fetchBranches(project) {
  const cached = branchCaches.get(project) ?? EMPTY;
  const m = machineFor('local', project);
  const repo = m.repoPath;
  await m.exec('git', ['fetch', 'origin', '--prune'], { cwd: repo, timeoutMs: 3 * 60 * 1000 });
  const r = await m.exec('git', [
    'for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin',
  ], { cwd: repo, timeoutMs: 60_000 });
  if (!r.ok) return cached.list;
  const fresh = {
    at: Date.now(),
    list: r.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.endsWith('/HEAD')),
  };
  branchCaches.set(project, fresh);
  return fresh.list;
}

/**
 * Local + remote branches already claiming this issue number, in one project.
 *
 * @param {number} issueNumber
 * @param {{project: string}} opts `project` is required.
 * @returns {Promise<string[]>}
 */
export async function findBranchesForIssue(issueNumber, { project } = {}) {
  requireProject(project, 'findBranchesForIssue');
  const all = await listAllBranches({ project });
  return all.filter((b) => branchBelongsToIssue(b, issueNumber));
}

/**
 * True only for a real linked worktree of the configured project. A stored path
 * that is merely *a directory* must not be handed to a Claude session: with no
 * repo under it, the session cheerfully clones one to get its bearings.
 */
export async function isProjectWorktree(machine, wtPath) {
  const common = await commonGitDir(machine, wtPath);
  return common !== null && machine.samePath(common, machine.path.join(machine.repoPath, '.git'));
}

/**
 * The `.git` this directory answers to, or null when it answers to none. Null
 * is the interesting answer: it means the path is a plain directory that no
 * repository claims, which is what a half-removed worktree leaves.
 */
async function commonGitDir(machine, wtPath) {
  if (!wtPath || !(await machine.fs.exists(wtPath))) return null;
  const r = await machine.exec('git', [RO, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: wtPath });
  if (!r.ok) return null;
  return r.stdout.trim();
}

/**
 * The base branch when a caller does not say. Callers that know the project
 * pass `baseBranchOf(task.project)` as `base`; this only keeps the positional
 * signatures working for code written before projects had their own.
 */
export const DEFAULT_BASE = 'main';

/**
 * Why a worktree cannot be cut from the project's base branch, as something the
 * card can explain instead of git's own words. `code` is one of `empty_repo`,
 * `base_missing`, `remote_empty`, `no_remote`; `info` is `{ base, remoteHeads? }`.
 * Both travel to the task (`errorCode` / `errorInfo`) and the message is Spanish.
 */
export class RepoStateError extends Error {
  constructor(code, info, message) {
    super(message);
    this.name = 'RepoStateError';
    this.code = code;
    this.info = info;
  }
}

/** The git-check-ref-format subset the registry applies to branch names. */
export function isSafeBranchName(v) {
  // A leading `+` would make `push origin +<base>` a force push; a lone `@` is HEAD.
  return typeof v === 'string' && v !== '' && v !== '@'
    && !/^-|^\+|^\/|\/\/|\.\.|[\s~^:?*[\\\x00-\x1f\x7f]|\/$|\.$|\.lock$|@\{/.test(v);
}

const REMOTE_PREFIX = 'refs/remotes/origin/';

/**
 * What the project checkout has: any local branch, whether `origin` exists, and
 * the heads `origin` has as of the last fetch. Read-only, no network.
 */
async function repoRefs(machine) {
  const repo = machine.repoPath;
  const [local, remotes, remote] = await Promise.all([
    machine.exec('git', ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/heads'], { cwd: repo }),
    machine.exec('git', ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin'], { cwd: repo }),
    machine.exec('git', ['remote'], { cwd: repo }),
  ]);
  const remoteHeads = remotes.ok
    ? remotes.stdout.split(/\r?\n/).map((s) => s.trim())
      .filter((s) => s.startsWith(REMOTE_PREFIX) && s !== `${REMOTE_PREFIX}HEAD`)
      .map((s) => s.slice(REMOTE_PREFIX.length))
    : [];
  return {
    // A failed read is "unknown", never "empty": the caller must not act on it.
    known: local.ok && remotes.ok && remote.ok,
    hasLocal: local.ok && local.stdout.trim() !== '',
    hasOrigin: remote.ok && remote.stdout.split(/\r?\n/).some((s) => s.trim() === 'origin'),
    remoteHeads,
  };
}

/**
 * Names what is wrong when a worktree could not be cut from `origin/<base>`, or
 * returns null when the problem is something else (the caller keeps git's own
 * message). Emptiness is "no branch of any kind, here or on origin" — not "HEAD
 * fails": an orphan HEAD in a repository with branches is not an empty one.
 */
export async function classifyRepoState(machine, base) {
  const { known, hasLocal, hasOrigin, remoteHeads } = await repoRefs(machine);
  if (!known) return null;
  const info = { base, remoteHeads };
  if (!hasOrigin) {
    return new RepoStateError('no_remote', { base },
      'El repositorio no tiene remoto origin: añádelo con git remote add origin <url>');
  }
  if (remoteHeads.length === 0) {
    return hasLocal
      ? new RepoStateError('remote_empty', { base },
        `El remoto origin está vacío, pero el repositorio local tiene commits: súbelos a mano con «git push -u origin ${base}» y reintenta.`)
      : new RepoStateError('empty_repo', { base },
        'El repositorio está vacío: no tiene ningún commit, y sin una rama base no se pueden crear worktrees ni abrir PRs.');
  }
  if (!remoteHeads.includes(base)) {
    return new RepoStateError('base_missing', info,
      `La rama base «${base}» no existe en origin. Ramas del remoto: ${remoteHeads.join(', ')}. Corrige la rama base del proyecto.`);
  }
  return null;
}

/**
 * Creates a linked worktree of the project checkout at `<worktreeRoot>/<flat>`,
 * on a new branch cut from origin/<base> (never from the possibly-stale local
 * base branch). The folder name is the branch with `/` flattened to `-` — cosmetic;
 * the branch itself keeps the real `<type>/<number>-<slug>` convention.
 */
export async function createWorktree(machine, branch, { onLine, adopt = false, base = DEFAULT_BASE } = {}) {
  const repo = machine.repoPath;
  const wtPath = worktreePathFor(machine, branch);

  await machine.fs.mkdir(machine.worktreeRoot);

  if (await machine.fs.exists(wtPath)) {
    // Only reuse it if it really is one. A leftover directory — git removes the
    // worktree but leaves the folder when something untracked survives, as the
    // stray `nul` did in fix-942 — would otherwise be handed to a Claude session
    // as a checkout, and a session with no repo under it clones one to get its
    // bearings. That mistake once cost 1.9 GB.
    if (await isProjectWorktree(machine, wtPath)) {
      onLine?.(`worktree already exists, reusing it: ${wtPath}`);
      return wtPath;
    }
    throw new Error(`${wtPath} exists but is not a worktree of this project: delete it by hand and try again`);
  }

  const fetch = await machine.exec('git', ['fetch', 'origin'], { cwd: repo, onLine });
  if (!fetch.ok) {
    // No `origin` at all makes the fetch fail; say that instead of git's text.
    const state = await classifyRepoState(machine, base);
    if (state?.code === 'no_remote') throw state;
    throw new Error(`git fetch failed: ${fetch.stderr}`);
  }

  // Adopting: attach to the branch that already carries this issue's work
  // rather than cutting a second one. Local branch wins; otherwise track the
  // remote. If neither is there any more, fall through to a fresh branch.
  if (adopt) {
    const attach = await localBranchExists(machine, branch)
      ? ['worktree', 'add', wtPath, branch]
      : ['worktree', 'add', '--track', '-b', branch, wtPath, `origin/${branch}`];
    const r = await machine.exec('git', attach, { cwd: repo, onLine });
    if (r.ok) {
      onLine?.(`worktree adopting the existing branch ${branch}`);
      return wtPath;
    }
    onLine?.(`could not adopt ${branch} (${r.stderr.trim().split('\n').pop()}); creating it from origin/${base}`);
  }

  const add = await machine.exec('git', [
    'worktree', 'add', wtPath, '-b', branch, `origin/${base}`,
  ], { cwd: repo, onLine });
  if (!add.ok) {
    if (/already exists/.test(add.stderr)) {
      const retry = await machine.exec('git', ['worktree', 'add', wtPath, branch], { cwd: repo, onLine });
      if (!retry.ok) throw new Error(`git worktree add failed: ${retry.stderr}`);
    } else {
      // Only now, when git already refused: the happy path asks nothing more.
      throw (await classifyRepoState(machine, base)) ?? new Error(`git worktree add failed: ${add.stderr}`);
    }
  }
  return wtPath;
}

/**
 * A detached worktree of the project checkout at `<worktreeRoot>/<dirName>`,
 * sitting on origin/<base> with no branch of its own. The project chat lives
 * in one: it is a place to read and try things in, never the project's own
 * checkout (`repoPath`), which a session must not wander in.
 *
 * An existing directory is reused only when it is a real worktree of this
 * project, as `createWorktree` demands; anything else is an error, not a
 * reason to delete it.
 *
 * @returns {Promise<string>} the worktree path on that machine.
 */
export async function ensureDetachedWorktree(machine, base, dirName, { onLine } = {}) {
  const repo = machine.repoPath;
  const wtPath = machine.path.join(machine.worktreeRoot, dirName);

  await machine.fs.mkdir(machine.worktreeRoot);

  if (await machine.fs.exists(wtPath)) {
    if (await isProjectWorktree(machine, wtPath)) {
      onLine?.(`worktree already exists, reusing it: ${wtPath}`);
      return wtPath;
    }
    throw new Error(`${wtPath} exists but is not a worktree of this project: delete it by hand and try again`);
  }

  const fetch = await machine.exec('git', ['fetch', 'origin', base], { cwd: repo, onLine });
  if (!fetch.ok) throw new Error(`git fetch failed: ${fetch.stderr}`);

  // A registration whose folder is gone makes `worktree add` refuse the path.
  await machine.exec('git', ['worktree', 'prune'], { cwd: repo, onLine });

  const add = await machine.exec('git', ['worktree', 'add', '--detach', wtPath, `origin/${base}`], { cwd: repo, onLine });
  if (!add.ok) throw new Error(`git worktree add failed: ${add.stderr}`);
  return wtPath;
}

/**
 * Brings a detached worktree up to origin/<base> when that cannot hurt anyone.
 *
 * It moves only if the tree is clean, HEAD is detached, and HEAD is an
 * ancestor of origin/<base> (so nothing is left behind). Otherwise it leaves
 * everything as is and says why, in English, in `note`.
 *
 * `update-index --refresh` comes first: a compile (or a checkout on another
 * line-ending setting) leaves files whose stat data changed but whose content
 * did not, and `status` would call those dirty. Untracked files are ignored
 * on purpose: they cannot be lost by a checkout.
 *
 * @returns {Promise<{moved: boolean, note: string|null, head: {branch: string|null, sha: string|null}}>}
 */
export async function refreshDetachedWorktree(machine, wtPath, base) {
  const fetch = await machine.exec('git', ['fetch', 'origin', base], { cwd: wtPath });
  await machine.exec('git', ['update-index', '-q', '--refresh'], { cwd: wtPath });
  const status = await machine.exec('git', [RO, 'status', '--porcelain', '--untracked-files=no'], { cwd: wtPath });
  const dirty = !status.ok || status.stdout.trim() !== '';
  const sym = await machine.exec('git', [RO, 'symbolic-ref', '-q', '--short', 'HEAD'], { cwd: wtPath });
  const branch = sym.ok && sym.stdout.trim() ? sym.stdout.trim() : null;

  const headOf = async () => {
    const r = await machine.exec('git', [RO, 'rev-parse', '--short', 'HEAD'], { cwd: wtPath });
    return { branch, sha: r.ok ? r.stdout.trim() : null };
  };

  if (!fetch.ok) return { moved: false, note: 'Could not fetch origin: nothing was moved.', head: await headOf() };
  if (branch) return { moved: false, note: `You are on branch ${branch}: nothing was moved.`, head: await headOf() };
  if (dirty) return { moved: false, note: 'There are uncommitted changes: nothing was moved.', head: await headOf() };

  const target = await machine.exec('git', [RO, 'rev-parse', '--verify', '--quiet', `origin/${base}^{commit}`], { cwd: wtPath });
  if (!target.ok) return { moved: false, note: `Cannot find origin/${base}: nothing was moved.`, head: await headOf() };
  const cur = await machine.exec('git', [RO, 'rev-parse', 'HEAD'], { cwd: wtPath });
  if (cur.ok && cur.stdout.trim() === target.stdout.trim()) return { moved: false, note: null, head: await headOf() };

  const anc = await machine.exec('git', [RO, 'merge-base', '--is-ancestor', 'HEAD', `origin/${base}`], { cwd: wtPath });
  if (!anc.ok) {
    return { moved: false, note: `This worktree has commits that are not in origin/${base}: nothing was moved.`, head: await headOf() };
  }
  const co = await machine.exec('git', ['checkout', '--detach', `origin/${base}`], { cwd: wtPath });
  if (!co.ok) return { moved: false, note: 'Could not move the worktree to origin: leaving it as is.', head: await headOf() };
  return { moved: true, note: null, head: await headOf() };
}

/** True when the branch has at least one commit beyond origin/<base>. */
export async function hasCommits(machine, wtPath, { base = DEFAULT_BASE } = {}) {
  const r = await machine.exec('git', [RO, 'rev-list', '--count', `origin/${base}..HEAD`], { cwd: wtPath });
  return r.ok && Number(r.stdout.trim()) > 0;
}

/**
 * The subject of the **first** commit this branch put on top of origin/<base>, or
 * null when the branch has none.
 *
 * First, not newest: after a repair round or a change request the newest is
 * «fix: address review feedback», which describes the last patch rather than
 * the work — and the work is what a PR title is for. `--no-merges` matters for
 * the same reason: once main has been brought in, HEAD is usually a merge.
 *
 * `-1` cannot help here: git applies the limit before reversing, so `-1
 * --reverse` is still the newest commit. The first line of the output is.
 */
export async function commitSubject(machine, wtPath, { base = DEFAULT_BASE, range = `origin/${base}..HEAD` } = {}) {
  const r = await machine.exec('git', [RO, 'log', '--reverse', '--no-merges', '--format=%s', range], { cwd: wtPath });
  return r.ok ? (r.stdout.trim().split(/\r?\n/)[0] || null) : null;
}

/**
 * With no terminal to answer a credential prompt, a push that asks for one
 * fails at once instead of hanging until the timeout; three minutes still
 * leaves room for a slow upload over the tailnet.
 */
export async function pushBranch(machine, wtPath, branch, { onLine } = {}) {
  // Pushed as the project's GitHub account, or not at all (`gh-account.js`).
  // Only a local worktree can be asked; a runner's paths are not this machine's.
  if (machine.kind === 'local') await assertPushIdentity(wtPath);
  const r = await machine.exec('git', ['push', '-u', 'origin', branch], {
    cwd: wtPath, onLine, timeoutMs: 3 * 60 * 1000, env: { GIT_TERMINAL_PROMPT: '0' },
  });
  if (!r.ok) throw new Error(`git push failed: ${r.stderr}`);
}

/** Where `createWorktree` puts a branch on this machine: the branch with `/` flattened to `-`. */
export function worktreePathFor(machine, branch) {
  return machine.path.join(machine.worktreeRoot, branch.replaceAll('/', '-'));
}

/** True when the project checkout on this machine has the branch locally. */
export async function localBranchExists(machine, branch) {
  const r = await machine.exec('git', [RO, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: machine.repoPath });
  return r.ok;
}

// ---------------------------------------------------------------------------
// Bringing origin/<base> into a task's branch.

/**
 * Global git option for every read-only call: a poll must never take
 * `index.lock` (status would refresh the index) against a pipeline's add/commit.
 */
export const RO = '--no-optional-locks';

const lines = (text) => String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** A ref as a sha, so every later step talks about the same commit. */
export async function resolveRef(machine, wtPath, ref, { base = DEFAULT_BASE } = {}) {
  const r = await machine.exec('git', [RO, 'rev-parse', ref || `origin/${base}`], { cwd: wtPath });
  return r.ok ? r.stdout.trim() : null;
}

/** True while a merge is half-done — an index in stages, waiting for someone. */
export async function mergeInProgress(machine, wtPath) {
  const r = await machine.exec('git', [RO, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: wtPath });
  return r.ok && Boolean(r.stdout.trim());
}

/**
 * What merging `mainSha` would do, without doing any of it.
 *
 * `merge-tree --write-tree` performs the whole merge in memory: it reads
 * neither the index nor the working tree and writes to neither, so this is safe
 * to run at any time — even mid-e2e. Only the real merge needs exclusivity.
 *
 * Two details the manual is emphatic about, and that a naive parser gets wrong:
 * the exit code is the answer (1 means conflicts, and an empty file list does
 * NOT mean a clean merge — directory renames conflict with nothing to list),
 * and the paths come quoted unless `core.quotePath` is off.
 */
export async function analyzeMerge(machine, wtPath, mainSha) {
  const behindR = await machine.exec('git', [RO, 'rev-list', '--count', `HEAD..${mainSha}`], { cwd: wtPath });
  const behind = behindR.ok ? Number(behindR.stdout.trim()) : null;
  const head = await resolveRef(machine, wtPath, 'HEAD');
  if (behind === 0) return { mainSha, head, behind, clean: true, conflicts: [], fastForward: false };

  const ff = await machine.exec('git', [RO, 'merge-base', '--is-ancestor', 'HEAD', mainSha], { cwd: wtPath });
  const r = await machine.exec('git', [RO, 
    '-c', 'core.quotePath=false',
    'merge-tree', '--write-tree', '--name-only', 'HEAD', mainSha,
  ], { cwd: wtPath, timeoutMs: 2 * 60 * 1000 });

  if (r.code === 0) return { mainSha, head, behind, clean: true, conflicts: [], fastForward: ff.ok };
  if (r.code !== 1) {
    throw new Error(`could not analyze the merge: ${r.stderr.trim().split('\n').pop() || `git exited with ${r.code}`}`);
  }
  // On conflict: the tree oid, then the conflicted paths, then a blank line and
  // the human-readable messages.
  const [, ...rest] = String(r.stdout).split(/\r?\n/);
  const conflicts = [];
  for (const line of rest) {
    if (!line.trim()) break;
    conflicts.push(line.trim());
  }
  return { mainSha, head, behind, clean: false, conflicts, fastForward: false };
}

/**
 * Whether a session's conflict resolution left the branch the way it was asked
 * to: `mainSha` merged in, the work that was there kept, nothing half-done, no
 * conflict marker left in the files that conflicted. Read-only.
 *
 * `{ ok, problems }`: every problem is a sentence, so the log and the card can
 * say what was wrong without the reader opening the worktree.
 */
export async function verifyMergeResolution(machine, wtPath, { headBefore, mainSha, files = [] }) {
  const problems = [];
  if (await mergeInProgress(machine, wtPath)) problems.push('the merge was left half-done (MERGE_HEAD is still there)');
  const status = await machine.exec('git', [RO, '-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=no'], { cwd: wtPath });
  if (status.ok && status.stdout.trim()) problems.push(`tracked files were left uncommitted: ${status.stdout.trim().split('\n').slice(0, 3).join('; ')}`);
  const head = await resolveRef(machine, wtPath, 'HEAD');
  if (!head || head === headBefore) problems.push('the session made no merge commit');
  else {
    const hasMain = await machine.exec('git', [RO, 'merge-base', '--is-ancestor', mainSha, 'HEAD'], { cwd: wtPath });
    if (!hasMain.ok) problems.push('origin/<base> is not part of the branch after the resolution');
    const keeps = await machine.exec('git', [RO, 'merge-base', '--is-ancestor', headBefore, 'HEAD'], { cwd: wtPath });
    if (!keeps.ok) problems.push('the branch lost the commits it had before the resolution');
  }
  if (files.length) {
    const marks = await machine.exec('git', [RO, 'grep', '-n', '-E', '^(<<<<<<<|>>>>>>>) ', 'HEAD', '--', ...files], { cwd: wtPath });
    // Exit 0 means a match; 1 means none; anything else is git failing, which is not a verdict.
    if (marks.code === 0) problems.push(`conflict markers are still in: ${marks.stdout.trim().split('\n').slice(0, 3).join('; ')}`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Puts the branch back exactly where it was before a resolution that did not
 * pass its checks: the half-done merge is aborted, then the branch returns to
 * `headBefore`. Safe because nothing of the attempt was pushed.
 */
export async function rollbackMergeAttempt(machine, wtPath, headBefore) {
  if (await mergeInProgress(machine, wtPath)) await machine.exec('git', [RO, 'merge', '--abort'], { cwd: wtPath });
  const r = await machine.exec('git', [RO, 'reset', '--hard', headBefore], { cwd: wtPath });
  return r.ok;
}

/**
 * What in the worktree would make a real merge unsafe.
 *
 * The dirt that matters here is the opposite of the one `pendingWork` reports:
 * not what this branch has been editing, but what **main is about to
 * overwrite**. git refuses such a merge, and its manual warns that
 * `git merge --abort` may not be able to reconstruct uncommitted changes — so
 * this is the check that stands between a merge and losing work done in the chat.
 */
export async function mergeBlockers(machine, wtPath, mainSha) {
  const [incomingR, modifiedR, stagedR, status] = await Promise.all([
    machine.exec('git', [RO, 'diff', '--name-only', `HEAD...${mainSha}`], { cwd: wtPath }),
    machine.exec('git', [RO, '-c', 'core.quotePath=false', 'diff', '--name-only'], { cwd: wtPath }),
    machine.exec('git', [RO, '-c', 'core.quotePath=false', 'diff', '--name-only', '--cached'], { cwd: wtPath }),
    machine.exec('git', [RO, '-c', 'core.quotePath=false', 'status', '--porcelain'], { cwd: wtPath, timeoutMs: 60_000 }),
  ]);

  const incoming = new Set(lines(incomingR.stdout));
  const overlapping = [...new Set(lines(modifiedR.stdout))].filter((f) => incoming.has(f));
  // Any staged change blocks the merge, whatever the file: git refuses to merge
  // with an index that differs from HEAD.
  const staged = [...new Set(lines(stagedR.stdout))];
  const untracked = status.ok
    ? status.stdout.split(/\r?\n/).filter((l) => l.startsWith('??')).map((l) => statusPath(l))
    : [];
  const inTheWay = untracked.filter((p) => (p.endsWith('/')
    ? [...incoming].some((f) => f.startsWith(p))
    : incoming.has(p)));

  return { overlapping, staged, inTheWay, blocked: overlapping.length + staged.length + inTheWay.length > 0 };
}

/**
 * The real merge. Never a rebase: the branch is published and under review, and
 * rewriting its history would break the conversation on the PR.
 *
 * The short timeout is deliberate. This repo signs commits, and the board runs
 * git with no terminal: the day that key carries a passphrase, git would sit
 * waiting for one. Ten minutes of that leaves a half-merged worktree; two
 * minutes and a clear error do not.
 */
export async function mergeMain(machine, wtPath, { mainSha, branch, onLine, base = DEFAULT_BASE } = {}) {
  if (await mergeInProgress(machine, wtPath)) {
    throw new Error('merge in progress in this worktree: resolve or abort it first');
  }
  const before = await resolveRef(machine, wtPath, 'HEAD');
  const r = await machine.exec('git', [
    'merge', '--no-edit', '-m', `Merge origin/${base} into ${branch}`, mainSha,
  ], {
    cwd: wtPath,
    onLine,
    timeoutMs: 2 * 60 * 1000,
    env: { GIT_TERMINAL_PROMPT: '0' },
  });

  if (!r.ok) {
    // Only abort a merge that actually started: with no MERGE_HEAD, `--abort`
    // answers "there is no merge to abort" and buries the real reason.
    if (await mergeInProgress(machine, wtPath)) {
      await machine.exec('git', ['merge', '--abort'], { cwd: wtPath });
      if (await mergeInProgress(machine, wtPath)) {
        throw new Error('the merge failed and could not be aborted: the worktree is left mid-merge');
      }
    }
    throw new Error(`git merge failed: ${r.stderr.trim().split('\n').pop() || r.stdout.trim()}`);
  }

  const head = await resolveRef(machine, wtPath, 'HEAD');
  return { merged: head !== before, head, before };
}

/**
 * The paths in a `git status --porcelain` line: `[path]`, or `[old, new]` for
 * a rename or copy (`XY old -> new`).
 *
 * The status code is matched rather than sliced off, because `pendingWork`
 * hands its lines on trimmed: ` M src/lib.rs` arrives as `M src/lib.rs`, and a
 * fixed `slice(3)` would eat the first letter of the path.
 */
export function statusPaths(line) {
  const m = /^([ MADRCUT?!]{1,2}) +(.*)$/.exec(String(line ?? '').trimEnd());
  if (!m) return [];
  return m[2].split(' -> ').map((p) => p.replace(/^"|"$/g, ''));
}

/** The path a status line leaves in the worktree: for a rename, the new one. */
export function statusPath(line) {
  return statusPaths(line).pop() ?? '';
}

/**
 * What the worktree is holding back: work committed but not pushed, and work
 * not even committed. Both matter when handing a PR to a reviewer, and they
 * matter differently — the first the board can send, the second it must not
 * decide about on its own.
 *
 * A dirty file is only reported when the branch has already touched that path.
 * Measured on the real worktrees before writing this: `git status` there lists
 * 3574 modified files in two of them — R6 spec fixtures the build rewrites —
 * plus test output directories and a stray `nul`. None of it is work anyone
 * meant to commit, and a warning that fires every single time is a warning
 * nobody reads. What the branch itself has been editing is a different matter:
 * that is this task's work, left uncommitted.
 */
export async function pendingWork(machine, wtPath, branch, { base = DEFAULT_BASE } = {}) {
  const [status, ahead, touched, behindR] = await Promise.all([
    // Unquoted paths, here and in the diff: `café.txt` would otherwise come out
    // as `"caf\303\251.txt"`, match nothing the branch touched, and fail a
    // `git add` if it ever got that far.
    machine.exec('git', [RO, '-c', 'core.quotePath=false', 'status', '--porcelain'], { cwd: wtPath }),
    // `--not origin/<base>` so the count keeps meaning "your work": after bringing
    // main in, the plain count would include every commit main contributed.
    machine.exec('git', [RO, 'rev-list', '--count', `origin/${branch}..HEAD`, '--not', `origin/${base}`], { cwd: wtPath, timeoutMs: 60_000 }),
    machine.exec('git', [RO, '-c', 'core.quotePath=false', 'diff', '--name-only', `origin/${base}...HEAD`], { cwd: wtPath, timeoutMs: 60_000 }),
    machine.exec('git', [RO, 'rev-list', '--count', `HEAD..origin/${base}`], { cwd: wtPath, timeoutMs: 60_000 }),
  ]);

  const lines = status.ok ? status.stdout.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean) : [];
  const branchFiles = touched.ok
    ? touched.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    : [];

  const relevant = (line) => {
    const p = statusPath(line);
    // An untracked directory is listed as `dir/`: it counts when the branch has
    // been working anywhere inside it — or, like a new file, when it sits next
    // to what the branch edits: a whole new module directory is left out of a
    // move otherwise, and deleted with the source worktree.
    // Not at the top level, though: that is where `target-r4-main/` and its
    // kin live, and a branch that edits `Cargo.toml` would sweep tens of GB of
    // build output into the commit.
    if (p.endsWith('/')) {
      if (branchFiles.some((f) => f.startsWith(p))) return true;
      const parent = p.slice(0, p.slice(0, -1).lastIndexOf('/') + 1);
      return Boolean(parent) && line.startsWith('??') && branchFiles.some((f) => f.startsWith(parent));
    }
    // Either side of a rename: moving a file the branch created is still this
    // branch's work, even though the new name is in no diff yet.
    if (statusPaths(line).some((q) => branchFiles.includes(q))) return true;
    // A brand-new file is in no diff yet, so it gets judged by its neighbours:
    // a new source file next to the ones this branch is editing is almost
    // certainly part of the same work, and forgetting it would leave the
    // reviewer with code that does not compile.
    if (line.startsWith('??')) {
      const cut = p.lastIndexOf('/');
      const dir = cut === -1 ? '' : p.slice(0, cut + 1);
      return branchFiles.some((f) => (dir ? f.startsWith(dir) : !f.includes('/')));
    }
    return false;
  };

  const dirty = lines.filter(relevant).map((l) => l.trim());
  return {
    dirty,
    // Debris: worth a line in the log, never worth stopping for.
    otherDirty: lines.length - dirty.length,
    // No remote branch yet (or no fetch since): treat it as "there is something
    // to push" rather than claiming everything is already up there.
    unpushed: ahead.ok ? Number(ahead.stdout.trim()) : null,
    behind: behindR.ok ? Number(behindR.stdout.trim()) : null,
  };
}

/**
 * Removes the linked worktree from disk (freeing its node_modules/build output)
 * and prunes the registration. The branch is kept — only the working copy goes.
 * --force because a built tree is never clean enough for plain `remove`.
 *
 * `git worktree remove` can half-succeed, and did, twice: it deregisters the
 * worktree and deletes what it tracks, then fails on the directory itself with
 * "Directory not empty" when anything untracked survived. Both #942 and #969
 * were left that way by a file literally named `nul` — a Windows-style `> nul`
 * redirect run under bash writes a file instead of discarding. From that point
 * git answers "is not a working tree" for ever, the board treated it as fatal,
 * and the task could never let go of a worktree that no longer existed.
 *
 * So git's verdict is read from the directory afterwards, not from its exit
 * code, and whatever it leaves behind is cleared here.
 */
export async function removeWorktree(machine, wtPath, { onLine } = {}) {
  const repo = machine.repoPath;
  if (!(await machine.fs.exists(wtPath))) {
    await machine.exec('git', ['worktree', 'prune'], { cwd: repo });
    return;
  }

  if (await isProjectWorktree(machine, wtPath)) {
    const r = await machine.exec('git', ['worktree', 'remove', '--force', wtPath], {
      cwd: repo, onLine, timeoutMs: 20 * 60 * 1000,
    });
    // Only a failure that left it registered is a real failure.
    if (!r.ok && await isProjectWorktree(machine, wtPath)) {
      throw new Error(`git worktree remove failed: ${r.stderr}`);
    }
  } else if (await commonGitDir(machine, wtPath)) {
    // A working copy of some other repository. Not ours to delete.
    throw new Error(`${wtPath} belongs to another repository: delete it by hand if you really want to`);
  }

  await machine.exec('git', ['worktree', 'prune'], { cwd: repo });

  if (await machine.fs.exists(wtPath)) {
    onLine?.(`git released the worktree but left the directory; deleting it: ${wtPath}`);
    // Retries cover the build output a just-stopped server may still hold.
    await machine.fs.rm(wtPath, { retries: 5 });
  }
}

// ---------------------------------------------------------------------------
// Moving a task between machines.
//
// Each machine has its own independent clone, so a task travels through
// origin: commit what is left, push, fetch on the other side, fast-forward.
// Every ref here is spelled out as `origin/<branch>`: a worktree created with
// `-b <branch> origin/<base>` has origin/<base> as its upstream, and a bare
// `git pull` there would merge main into the branch instead.

/** Board-made writes: no prompt to hang on, and a short leash (see `mergeMain`). */
const GIT_WRITE = { timeoutMs: 2 * 60 * 1000, env: { GIT_TERMINAL_PROMPT: '0' } };

const lastLine = (r) => r.stderr.trim().split('\n').pop()
  || r.stdout.trim().split('\n').pop()
  || `git exited with ${r.code}`;

/**
 * The paths behind `pendingWork().dirty`, ready for `git add --` and
 * `git commit --only --`. A rename gives both names: committing only the new
 * one would leave the deletion of the old one staged, and the old file would
 * quietly stay in HEAD. Untracked directories keep their trailing `/`.
 */
export function dirtyPaths(dirtyLines) {
  return [...new Set((dirtyLines ?? []).flatMap((l) => statusPaths(l)).filter(Boolean))];
}

/**
 * `git fetch origin <branch>`, which also moves `refs/remotes/origin/<branch>`
 * through the clone's default fetch refspec. Runs from the project checkout or
 * any worktree of it — the target machine fetches before it has a worktree.
 *
 * A branch never pushed is not a failure: `missing` says so, and the caller
 * reads it as "everything is still to push".
 */
export async function fetchBranch(machine, cwd, branch, { onLine } = {}) {
  const r = await machine.exec('git', ['fetch', 'origin', branch], { cwd, onLine, ...GIT_WRITE });
  if (r.ok) return { ok: true, missing: false };
  if (/couldn't find remote ref/i.test(r.stderr)) return { ok: true, missing: true };
  throw new Error(`git fetch origin ${branch} failed: ${lastLine(r)}`);
}

/**
 * How the local branch and `origin/<branch>` differ, as of the last fetch.
 * Compares the refs, not HEAD, so it answers from the project checkout even
 * when the branch's worktree was deleted. Null when either ref is missing.
 */
export async function aheadBehind(machine, cwd, branch) {
  const r = await machine.exec('git', [
    'rev-list', '--left-right', '--count', `refs/remotes/origin/${branch}...refs/heads/${branch}`,
  ], { cwd });
  if (!r.ok) return null;
  const [behind, ahead] = r.stdout.trim().split(/\s+/).map(Number);
  return Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead, behind } : null;
}

/**
 * Brings the worktree's branch to `origin/<branch>` and makes that its upstream.
 *
 * By default only a fast-forward: diverged history or local changes in the way
 * make git refuse, and so does this. A branch merely *ahead* of origin is left
 * as it is — git calls that up to date — so a caller that cares checks
 * `aheadBehind` first.
 *
 * `discardLocal` resets hard instead. That throws away local commits **and
 * uncommitted changes to tracked files**, so the caller must have checked that
 * `pendingWork().dirty` is empty. Untracked files survive only at paths
 * `origin/<branch>` does not track (a `target-x/`): one at a path the remote
 * tracks is overwritten by the reset.
 */
export async function fastForwardTo(machine, wtPath, branch, { discardLocal = false, onLine } = {}) {
  const remote = `refs/remotes/origin/${branch}`;
  if (!(await resolveRef(machine, wtPath, remote))) {
    throw new Error(`origin/${branch} branch does not exist in this clone: fetch the branch first`);
  }
  // Both commands act on whatever is checked out: make sure it is the branch.
  // The full ref, because `--short` turns into `heads/<b>` when a tag of the
  // same name exists.
  const head = await machine.exec('git', [RO, 'symbolic-ref', '--quiet', 'HEAD'], { cwd: wtPath });
  if (!head.ok || head.stdout.trim() !== `refs/heads/${branch}`) {
    throw new Error(`worktree ${wtPath} is not on ${branch} (it is on ${head.stdout.trim() || 'a detached HEAD'})`);
  }

  const before = await resolveRef(machine, wtPath, 'HEAD');
  const args = discardLocal ? ['reset', '--hard', remote] : ['merge', '--ff-only', remote];
  const r = await machine.exec('git', args, { cwd: wtPath, onLine, ...GIT_WRITE });
  if (!r.ok) {
    throw new Error(discardLocal
      ? `git reset --hard origin/${branch} failed: ${lastLine(r)}`
      : `could not advance ${branch} to origin/${branch} (diverged branches or local changes in the way): ${lastLine(r)}`);
  }

  const up = await machine.exec('git', ['branch', `--set-upstream-to=origin/${branch}`, branch], { cwd: wtPath, ...GIT_WRITE });
  if (!up.ok) onLine?.(`could not set origin/${branch} as upstream: ${lastLine(up)}`);

  const after = await resolveRef(machine, wtPath, 'HEAD');
  return { moved: before !== after, before, after };
}

/**
 * The subject of the commit a move makes with unfinished work. `handoff.js`
 * names it to the session verbatim, from its own copy (see there).
 */
export const WIP_COMMIT_MESSAGE = 'wip: uncommitted work';

/**
 * Commits exactly `paths` — the branch's own uncommitted work — and nothing
 * else. Returns the new HEAD, or null when there was nothing to commit.
 *
 * `--only` is what keeps anything else already staged out of the commit (and
 * staged). The paths are listed explicitly because `git add -A` would sweep in
 * the thousands of rewritten fixtures and the unignored `target-*` output a
 * worktree of this project carries.
 *
 * The message stays neutral — no machine, no board — because on a PR the team
 * reads it. Signing is left to the repository's config, as for `mergeMain`.
 */
export async function wipCommit(machine, wtPath, paths, { message = WIP_COMMIT_MESSAGE, onLine } = {}) {
  if (!paths?.length) return null;
  if (await mergeInProgress(machine, wtPath)) {
    throw new Error('merge in progress in this worktree: resolve or abort it first');
  }

  // `git add` rejects a path it cannot match in the index or on disk, and the
  // old name of a staged rename is in neither. `commit --only` does accept it
  // (it also looks at HEAD), so only the add is narrowed.
  const known = await machine.exec('git', [
    'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...paths,
  ], { cwd: wtPath });
  if (!known.ok) throw new Error(`git ls-files failed: ${lastLine(known)}`);
  const listed = known.stdout.split('\0').filter(Boolean);
  const addable = paths.filter((p) => listed.some((f) => (p.endsWith('/') ? f.startsWith(p) : f === p)));

  if (addable.length) {
    const add = await machine.exec('git', ['add', '--', ...addable], { cwd: wtPath, onLine, ...GIT_WRITE });
    if (!add.ok) throw new Error(`git add failed: ${lastLine(add)}`);
  }

  // The exit code is the answer: 0 means those paths match HEAD already.
  const staged = await machine.exec('git', ['diff', '--cached', '--quiet', '--', ...paths], { cwd: wtPath });
  if (staged.code === 0) return null;
  if (staged.code !== 1) throw new Error(`git diff --cached failed: ${lastLine(staged)}`);

  const commit = await machine.exec('git', [
    'commit', '--only', '--no-verify', '-m', message, '--', ...paths,
  ], { cwd: wtPath, onLine, ...GIT_WRITE });
  if (!commit.ok) throw new Error(`git commit failed: ${lastLine(commit)}`);
  return resolveRef(machine, wtPath, 'HEAD');
}

/**
 * A worktree of this machine's checkout that has the branch checked out
 * somewhere other than where `createWorktree` would put it — which makes
 * `git worktree add` refuse. The main checkout counts. Returned as git prints
 * it (forward slashes, even on Windows); null when there is none.
 *
 * Pruned first: a worktree whose directory was deleted by hand stays listed,
 * and still blocks the add, until git is told to forget it.
 */
export async function foreignWorktreeFor(machine, branch) {
  const repo = machine.repoPath;
  await machine.exec('git', ['worktree', 'prune'], { cwd: repo });
  const r = await machine.exec('git', [RO, 'worktree', 'list', '--porcelain'], { cwd: repo });
  if (!r.ok) throw new Error(`git worktree list failed: ${lastLine(r)}`);

  const own = worktreePathFor(machine, branch);
  for (const block of r.stdout.split(/\r?\n\r?\n/)) {
    const fields = block.split(/\r?\n/);
    const wt = fields.find((f) => f.startsWith('worktree '))?.slice('worktree '.length);
    if (!wt || fields.includes('bare') || fields.includes('detached')) continue;
    if (fields.includes(`branch refs/heads/${branch}`) && !machine.samePath(wt, own)) return wt;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cleaning up after an issue that closed without a PR.

/**
 * Deletes the branch from this machine's project checkout — the local ref only.
 * Runs in `machine.repoPath`, never in a worktree.
 *
 * Never throws: it reports what happened so the caller can put a line in the
 * log and carry on. By the time this runs the issue is already closed, and a
 * branch that outlives it is untidy, not a failure.
 *
 * `origin/<branch>` is never touched. If the branch was ever pushed, the remote
 * still has it, and that is the copy anyone could still want.
 *
 * `git worktree prune` first, and it is not optional: `git branch -d` refuses a
 * branch registered as checked out in a worktree **even when that worktree's
 * directory no longer exists** (measured here, git 2.55). `removeWorktree`
 * prunes on its way out, but the half-removed state that #942 and #969 were
 * left in — deregistered by git, directory surviving, or the reverse when
 * something deletes the folder by hand — would otherwise answer "cannot delete
 * branch … used by worktree at …" for a path that is gone. `foreignWorktreeFor`
 * prunes for exactly the same reason.
 *
 * ## What `-d` protects, and what it does not
 *
 * **`-d` is not the guard here.** Read that twice before trusting the flag.
 *
 * git refuses `-d` for a branch that is not fully merged — but "merged" means
 * merged into its **upstream** when it has one, not into main. A branch cut by
 * `createWorktree` starts out tracking `origin/<base>`, and while that lasts `-d`
 * really does mean "already in main". `pushBranch` runs `git push -u`, which
 * moves the upstream to `origin/<branch>`; from that moment the branch is
 * trivially an ancestor of itself, and `-d` deletes it whether or not a single
 * commit of it ever reached main. In practice `-d` only protects a branch that
 * was never pushed.
 *
 * So the guard is the `git rev-list --count origin/<base>..<branch>` this
 * function runs first: any commit the branch has that main does not, and the
 * branch is left alone with `reason: 'unmerged'` without `git branch` ever
 * being asked. `-d` stays as a weak second belt for whatever that count could
 * not see.
 *
 * The count lives **inside** this function on purpose. It used to be the
 * caller's job — `hasCommits` plus `pendingWork` before the call — and that
 * was a promise, not a mechanism: both of those take a worktree path, and the
 * caller that matters here is the one closing an issue with no PR, which has
 * normally already deleted the worktree. It could not run the check even if it
 * remembered to. This one asks the project checkout, which is always there.
 *
 * When the count itself fails — no `origin/<base>`, no remote, a repository this
 * is not — nothing is deleted and `reason` is `'error'`. Refusing is the safe
 * answer: the branch surviving costs a line in the log, and the board deleting
 * work it could not measure costs the work.
 *
 * `-D` is still never used, and must not be added: when git does object,
 * something is true that the caller believed was not, and the honest answer is
 * to say so in the log and leave the branch alone.
 *
 * @param {import('./machine.js').LocalMachine} machine the machine the checkout is on.
 * @param {string} branch the local branch to delete.
 * @param {{base?: string}} [opts] the project's base branch; `main` when omitted.
 * @returns {Promise<{deleted: boolean, reason: 'unmerged'|'checked-out'|'missing'|'error'|null, message: string}>}
 *   `missing` is not an error: this cleanup is idempotent, and a retry after a
 *   successful run lands there.
 */
export async function deleteLocalBranch(machine, branch, { base = DEFAULT_BASE } = {}) {
  const repo = machine.repoPath;
  try {
    if (!(await localBranchExists(machine, branch))) {
      return { deleted: false, reason: 'missing', message: `the local branch ${branch} was already gone` };
    }

    // La guarda, antes de tocar nada: commits que tiene la rama y no tiene
    // `origin/<base>`. No necesita worktree, así que vale también cuando el
    // worktree ya se borró, que es justo el caso del cierre sin PR.
    const ahead = await machine.exec('git', [RO, 
      'rev-list', '--count', `origin/${base}..${branch}`,
    ], { cwd: repo });
    // The empty string is the trap: `Number('')` is 0, not NaN, so a call that
    // answers ok with nothing on stdout — a dropped buffer from the runner over
    // a flaky tailnet — would read as "no commits of its own" and go on to
    // delete. Counted output that is not a count is a failed count.
    const counted = ahead.ok ? ahead.stdout.trim() : '';
    const own = /^\d+$/.test(counted) ? Number(counted) : NaN;
    if (!Number.isFinite(own)) {
      return {
        deleted: false,
        reason: 'error',
        message: `could not compare ${branch} with origin/${base} (${lastLine(ahead)}):`
          + ' leaving the branch where it is',
      };
    }
    if (own > 0) {
      return {
        deleted: false,
        reason: 'unmerged',
        message: `the branch ${branch} has ${own} commit${own === 1 ? '' : 's'}`
          + ` not in origin/${base}: not deleting it`,
      };
    }

    await machine.exec('git', ['worktree', 'prune'], { cwd: repo });

    // `advice.forceDeleteBranch=false`: without it a refusal ends in two `hint:`
    // lines recommending `-D`, and `lastLine` would report that advice instead
    // of the reason. Recommending `-D` is the one thing this must not relay.
    const r = await machine.exec('git', [
      '-c', 'advice.forceDeleteBranch=false', 'branch', '-d', branch,
    ], { cwd: repo, ...GIT_WRITE });

    if (r.ok) return { deleted: true, reason: null, message: `local branch ${branch} deleted` };

    // Both spellings of the refusal: git says "used by worktree at" since 2.45,
    // "checked out at" before that.
    const stderr = String(r.stderr ?? '');
    const reason = /not fully merged/i.test(stderr) ? 'unmerged'
      : /checked out|used by worktree/i.test(stderr) ? 'checked-out'
        : 'error';
    return { deleted: false, reason, message: lastLine(r) };
  } catch (e) {
    // `machine.exec` does not reject locally, but a runner's does when the
    // tailnet drops mid-call. Losing the board over a tidy-up would be absurd.
    return { deleted: false, reason: 'error', message: e?.message ?? String(e) };
  }
}

/**
 * Bytes under `dir`, or null when it cannot be told in time. A built worktree
 * of this project runs to tens of GB and walking it may well take longer than
 * a dialog should wait: null is the honest answer, not a guess.
 */
export async function dirSize(machine, dir, { timeoutMs = 15_000 } = {}) {
  try {
    // Checked first: on Windows a missing directory measures as an empty sum,
    // which would read as 0 bytes.
    if (!dir || !(await machine.fs.exists(dir))) return null;
    if (machine.platform === 'win32') {
      const literal = `'${dir.replaceAll("'", "''")}'`;
      const script = `(Get-ChildItem -LiteralPath ${literal} -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum`;
      const r = await machine.exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs });
      if (r.code === -2 || r.code === -1) return null;
      const text = r.stdout.trim();
      if (!text && !r.ok) return null;
      const n = Number(text || 0);
      return Number.isFinite(n) ? n : null;
    }
    // `du` exits non-zero over an unreadable subdirectory but still prints a
    // total for the rest: that total is still worth showing.
    const r = await machine.exec('du', ['-sk', dir], { timeoutMs });
    if (r.code === -2 || r.code === -1) return null;
    const m = /^\s*(\d+)/.exec(r.stdout);
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}
