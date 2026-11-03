// Guard: a test must not create a temp directory it never removes.
//
// A raw `mkdtemp` in a test file leaves an `hfsmon-*` directory in the OS temp
// folder on every run (#32: 32,000 of them). `tempDir()` from `./teardown.mjs`
// registers the directory for removal at process exit, so new code uses that.
// The files below still call `mkdtemp` directly because they remove what they
// create themselves; the list only shrinks. A new raw call fails this test, and an
// entry with no call left must be deleted.
//
// Blind spot, on purpose: it counts calls, it does not follow the path to the
// removal. An allowlisted file whose cleanup breaks is not seen here.
//
// Fixed-name sandboxes (`hfsmon-restart-sandbox`, `hfsmon-upgrade-sandbox`) are made
// with `mkdirSync`, persist by design and do not grow, so the scan never sees them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

// Built at run time: a literal would make this file report itself.
const CALL = new RegExp(`${'mkd' + 'temp'}(?:Sync)?\\s*\\(`, 'g');

/** Source with `//` and block comments removed; string and template contents stay. */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c; out += c; i += 1;
    } else if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
    } else {
      out += c; i += 1;
    }
  }
  return out;
}

const countCalls = (src) => (stripComments(src).match(CALL) ?? []).length;

// file -> [raw calls, why the file is allowed to call it directly].
const OWN_AFTER = 'removes it in its own after hook';
const OWN_FINALLY = 'removes it in a finally block';
const OWN_T_AFTER = 'removes it through t.after on each fixture';
const OWN_REPORTED = 'removes it with removeTree/removeTreeReported, which waits out a Windows lock';
const ALLOWLIST = {
  'base-branch.test.mjs': [1, `ROOT of git fixtures; ${OWN_AFTER}`],
  'boot.test.mjs': [1, `data dir; ${OWN_AFTER}`],
  'browse.test.mjs': [1, `fixture tree; ${OWN_AFTER}`],
  'config-reload.test.mjs': [1, `config copy; ${OWN_FINALLY}`],
  'decisions.test.mjs': [1, `decisions scratch; ${OWN_AFTER}`],
  'docs-stale.test.mjs': [1, `git fixture; ${OWN_AFTER}`],
  'empty-repo.test.mjs': [1, `git fixtures; ${OWN_AFTER}`],
  'files-holder-project.test.mjs': [2, `data dir and fake repos; ${OWN_AFTER}`],
  'files-page.test.mjs': [2, `data dir and fixture root; ${OWN_AFTER}`],
  'files.test.mjs': [2, `data dir and git fixtures; ${OWN_AFTER}`],
  'github-repo.test.mjs': [1, `git fixture; ${OWN_AFTER}`],
  'issuedraft.test.mjs': [1, `helper for fake repos; ${OWN_AFTER}`],
  'machine.test.mjs': [1, `scratch; ${OWN_FINALLY}`],
  'merge.test.mjs': [1, `git fixture; ${OWN_T_AFTER}`],
  'metrics-api.test.mjs': [1, `data dir of a spawned board; ${OWN_REPORTED}`],
  'metrics-baseline.test.mjs': [1, `CLI fixture; ${OWN_FINALLY}`],
  'metrics-overlap.test.mjs': [1, `CLI data dir; ${OWN_REPORTED}`],
  'metrics-subagents.test.mjs': [1, `CLI data dir; ${OWN_FINALLY}`],
  'move.test.mjs': [3, `data dir, git fixtures, fake worktree; ${OWN_AFTER}`],
  'pending-work.test.mjs': [1, `git fixture; ${OWN_T_AFTER}`],
  'persist.test.mjs': [1, `data dir; ${OWN_AFTER}`],
  'phases.test.mjs': [1, `data dir; ${OWN_AFTER}`],
  'profiles.test.mjs': [1, `fake checkout; ${OWN_FINALLY}`],
  'project-chat-routes.test.mjs': [1, `data dir of a spawned board; ${OWN_REPORTED}`],
  'project-context.test.mjs': [1, `fake checkout; ${OWN_T_AFTER}`],
  'project-settings-route.test.mjs': [1, `data dir of a spawned board; ${OWN_REPORTED}`],
  'prompt-baseline-freeze.test.mjs': [1, `baseline copy; ${OWN_REPORTED}`],
  'quota-hold.test.mjs': [1, `data dir; ${OWN_AFTER}`],
  'quota.test.mjs': [1, `data dir; ${OWN_AFTER}`],
  'repo-identity.test.mjs': [1, `git fixture; ${OWN_T_AFTER}`],
  'restart-spawn.test.mjs': [1, `restart.ps1 holder dir; ${OWN_REPORTED}`],
  'routes-wave2.test.mjs': [1, `data dir of a spawned board; ${OWN_REPORTED}`],
  'routes.test.mjs': [1, `data dir of a spawned board; ${OWN_REPORTED}`],
  'runner-offline.test.mjs': [1, `data dir; ${OWN_AFTER}`],
  'runner.test.mjs': [1, `fake claude scratch; ${OWN_AFTER}`],
  'stack-command.test.mjs': [1, `data dir and cwd of daemons; ${OWN_REPORTED}`],
  'stack-health.test.mjs': [1, `data dir; ${OWN_AFTER}`],
  'teardown.test.mjs': [3, `tests the teardown helpers themselves; ${OWN_FINALLY}`],
  'upgrade.test.mjs': [1, `git fixtures and data dir; ${OWN_AFTER}`],
  'web-build.test.mjs': [1, `vite outDir; ${OWN_FINALLY}`],
  'worktree-branch.test.mjs': [1, `git fixture; ${OWN_T_AFTER}`],
  'worktree-move.test.mjs': [2, `git fixtures and a size scratch; ${OWN_T_AFTER}`],
  'worktree-push-diverged.test.mjs': [1, `git fixture (bare origin and two clones); ${OWN_T_AFTER}`],
  'worktree-remove.test.mjs': [1, `git fixture; ${OWN_T_AFTER}`],
  'zen-proxy.test.mjs': [1, `scratch; ${OWN_AFTER}`],
};

const scanned = readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.mjs') || f === 'isolate.mjs').sort();
const found = {};
for (const f of scanned) {
  const n = countCalls(readFileSync(path.join(TEST_DIR, f), 'utf8'));
  if (n > 0) found[f] = n;
}

test('the call counter ignores comments and imports, and sees namespace calls', () => {
  const call = `${'mkd' + 'temp'}Sync`;
  const src = [
    `// ${call}(x)`,
    `/* ${call}(x) */`,
    `import { ${call} } from 'node:fs';`,
    `const a = ${call}(p);`,
    `const b = fs.${call} (p);`,
    `const c = fs.${'mkd' + 'temp'}(p, cb);`,
  ].join('\n');
  assert.equal(countCalls(src), 3);
});

test('every raw temp-directory call is allowlisted (use tempDir() from ./teardown.mjs)', () => {
  const expected = Object.fromEntries(Object.entries(ALLOWLIST).map(([f, [n]]) => [f, n]));
  assert.deepEqual(found, expected,
    'a new test must create its temp directories with tempDir() from ./teardown.mjs, which removes them at exit; an allowlist entry with no call left must be deleted');
});

test('every allowlist entry has a count and a reason', () => {
  for (const [f, [n, why]] of Object.entries(ALLOWLIST)) {
    assert.ok(n > 0 && why.length > 10, `${f} needs a count and a reason`);
  }
});
