// Seeds a throwaway data dir with one task that has a chat, so the board can be
// opened in a browser without GitHub, Claude or any real project.
// usage (cwd = the repo to test): HFSMON_DATA_DIR=<dir> HFSMON_CONFIG=<cfg> node seed.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = process.cwd();
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const { saveProjects } = await load('server/src/projects.js');
const { store } = await load('server/src/store.js');

saveProjects([{
  id: 'voz', name: 'voz', repoPath: process.env.E2E_REPO, worktreeRoot: process.env.E2E_WT,
  repo: 'example/voz', assignee: 'tester', reviewer: null, overrides: {},
}]);
const task = store.addTask({ number: 77, title: 'Prueba de voz', labels: [], url: 'https://example.invalid/77', closed: false }, 'voz');
task.worktreePath = process.env.E2E_WT;   // a chat is writable once the task has a worktree
task.branch = 'feat/77-voz';
store.touch(task);
store.flush();
console.log(JSON.stringify({ chatId: task.chats[0].id, key: `voz#77` }));
process.exit(0);
