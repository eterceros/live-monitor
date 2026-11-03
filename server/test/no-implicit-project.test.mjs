// The project is never implicit.
//
// Forgetting the project used to silently target hfs: the root cause of the
// «Tarea #N desconocida» / wrong repo / wrong worktree bugs on other projects.
// Three rings here:
//   (i)   no function parameter defaults to DEFAULT_PROJECT_ID;
//   (ii)  every remaining mention of the constant in server/src is on an
//         allowlist with a reason (a new mention fails, and so does an entry
//         that no longer matches anything);
//   (iii) the functions that lost their default throw `missing project`.
//
// Blind spots, on purpose (ring (ii) counts mentions per file, it does not
// compare line text): swapping one allowlisted mention for another in the same
// file; a default split across lines; an aliased import
// (`import { DEFAULT_PROJECT_ID as X }`); and a literal 'hfs' used as a default.
// Review catches those; the test only guards the common regression.
import './isolate.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return name.endsWith('.js') ? [full] : [];
  });
}

/** Source with comments blanked out, so prose mentions do not count. */
function stripComments(text) {
  return text
    // A `/*` only opens a comment when it is not glued to a word, quote, backtick
    // or slash: route strings such as '/x/*rel' contain one and are real code.
    .replace(/(^|[^\w'"`/])\/\*[\s\S]*?\*\//g, '$1')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function code(file) {
  return stripComments(readFileSync(file, 'utf8'));
}

const files = sourceFiles(SRC).map((f) => ({ rel: path.relative(SRC, f).split(path.sep).join('/'), text: code(f) }));
const MENTION = /\bDEFAULT_PROJECT_ID\b/g;

// Code mentions that remain, per file: [count, why it is legitimate]. The
// import line counts as one.
const ALLOWLIST = {
  'keys.js': [3, 'defines the constant; coerceKey keeps its default (legacy reader of bare issue numbers); tasksFileOf maps hfs to tasks.json'],
  'projects.js': [2, 'registry seed (import + seed entry)'],
  'store.js': [3, 'import + project discovery of the default tasks.json file'],
  'github.js': [3, 'import + resolveRepo/repo comparisons against the default project (value comparisons, not defaults)'],
  'machine.js': [3, 'import + machineFor comparison (the default project reads the machine itself) + machineHostsProject (the default project is hosted everywhere)'],
  'attachments.js': [2, 'import + legacy attachments directory belongs to the default project (comparison)'],
  'prompts.js': [2, 'import + repoPathFor comparison: documented semantics of the default project'],
  'prompt-invariants.js': [2, 'import + documented "no project given means the default" constant'],
  'files.js': [5, 'import + allowedRoots comparison + legacy chat task fallback + legacy bare-issue route + comparison'],
  'pipeline.js': [2, 'import + legacy rows without project in the PR-checks sweep (one reader)'],
  'index.js': [11, 'import + route layer: legacy clients (bare issue, /api/preview), board-wide tuning, empty-registry fallback, legacy rows'],
};

test('no function parameter defaults to DEFAULT_PROJECT_ID', () => {
  const offenders = [];
  for (const { rel, text } of files) {
    text.split('\n').forEach((line, i) => {
      if (/(?<![=!<>])=\s*DEFAULT_PROJECT_ID/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  // keys.js `coerceKey(value, defaultProjectId = DEFAULT_PROJECT_ID)` is the one
  // legacy reader: persisted chat tabs and the quota hold list hold bare numbers.
  const unexpected = offenders.filter((o) => !/^keys\.js:\d+: export function coerceKey\(/.test(o));
  assert.deepEqual(unexpected, []);
  assert.equal(offenders.length - unexpected.length, 1, 'coerceKey still keeps its documented default');
});

test('every remaining DEFAULT_PROJECT_ID mention is allowlisted, and every entry is alive', () => {
  const found = {};
  for (const { rel, text } of files) {
    const n = (text.match(MENTION) ?? []).length;
    if (n) found[rel] = n;
  }
  const expected = Object.fromEntries(Object.entries(ALLOWLIST).map(([f, [n]]) => [f, n]));
  assert.deepEqual(found, expected,
    'a new mention needs a reason in ALLOWLIST; an entry with no mention left must be deleted');
  for (const [f, [n, why]] of Object.entries(ALLOWLIST)) {
    assert.ok(n > 0 && why.length > 10, `${f} needs a count and a reason`);
  }
});

test('the comment stripper does not eat code after a route string holding /*', () => {
  const snippet = "app.get('/x/*rel', h);\nconst p = q ?? DEFAULT_PROJECT_ID;\n/* real comment DEFAULT_PROJECT_ID */\n";
  const out = stripComments(snippet);
  assert.equal((out.match(MENTION) ?? []).length, 1);
  assert.match(out, /\?\? DEFAULT_PROJECT_ID/);
});

// --- the functions that lost their default throw ---------------------------

const github = await import('../src/github.js');
const worktree = await import('../src/worktree.js');
const { store } = await import('../src/store.js');
const { machineFor } = await import('../src/machine.js');
const { detectExistingWork } = await import('../src/pipeline.js');

const ISSUE = { number: 1, title: 't', labels: [], url: 'https://x/1', closed: false };
const NEEDS = [
  ['github.repo', () => github.repo()],
  ['github.listAssignedIssues', () => github.listAssignedIssues()],
  ['github.getIssue', () => github.getIssue(1)],
  ['github.issueStates', () => github.issueStates([1])],
  ['github.findPrForBranch', () => github.findPrForBranch('b')],
  ['github.prView', () => github.prView(1)],
  ['github.commentOnPr', () => github.commentOnPr(1, 'x')],
  ['github.checksForOpenPrs', () => github.checksForOpenPrs({})],
  ['worktree.listAllBranches', () => worktree.listAllBranches({})],
  ['worktree.findBranchesForIssue', () => worktree.findBranchesForIssue(1, {})],
  ['store.addTask', () => store.addTask(ISSUE)],
  ['store.keyFor', () => store.keyFor(1)],
  ['machine.machineFor', () => machineFor('local')],
  ['pipeline.detectExistingWork', () => detectExistingWork(1, {})],
];

for (const [name, call] of NEEDS) {
  test(`${name} without a project throws «missing project»`, async () => {
    await assert.rejects(async () => call(), /missing project in/);
  });
}
