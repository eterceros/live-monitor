// A card in «ready for review» whose PR is turned back into a draft on GitHub
// returns to «PR draft» on the next reclassification. GitHub only enters
// through the injectable steps: nothing here calls `gh` or `git`.
import './isolate.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as pipeline from '../src/pipeline.js';
import { store } from '../src/store.js';

const BRANCH = 'perf/2294-search-ids';
const pr = (state) => ({
  number: 2340, url: 'https://github.com/x/pull/2340', title: 'perf: pr', state,
  createdAt: '2026-11-01T00:00:00Z', mergedAt: null, closedAt: null,
});

let n = 22000;
function readyTask() {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  task.issueClosed = false;
  return Object.assign(task, {
    state: 'ready', classified: true, branch: BRANCH, prNumber: 2340, prUrl: pr('OPEN').url, prs: [pr('OPEN')],
  });
}

const github = (state) => ({
  findBranchesForIssue: async () => [BRANCH],
  linkedPullRequests: async () => [],
  prsForBranch: async () => [pr(state)],
  issueReopenInfo: async () => null,
  prView: async (number) => ({ number, state, isDraft: state === 'DRAFT' }),
});

test('ready + PR turned back into a draft -> pr_draft', async () => {
  const task = readyTask();
  await pipeline.refreshClassification(task, github('DRAFT'));
  assert.equal(task.state, 'pr_draft');
  assert.equal(task.prNumber, 2340);
});

test('ready + PR still open (not a draft) stays ready', async () => {
  const task = readyTask();
  await pipeline.refreshClassification(task, github('OPEN'));
  assert.equal(task.state, 'ready');
});

test('pr_draft + PR draft stays pr_draft', async () => {
  const task = readyTask();
  task.state = 'pr_draft';
  await pipeline.refreshClassification(task, github('DRAFT'));
  assert.equal(task.state, 'pr_draft');
});
