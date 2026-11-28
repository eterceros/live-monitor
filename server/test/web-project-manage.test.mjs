import './isolate.mjs';
// The project picker panel and the manage-projects dialog, fixed as source text
// (the web has no browser runner; see web-topbar.test.mjs for the pattern).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const picker = read('web/src/components/ProjectPicker.jsx');
const dialog = read('web/src/components/ManageProjectsDialog.jsx');
const css = read('web/src/styles/projects.css');
const main = read('web/src/main.jsx');
const LANGS = ['es', 'en', 'fr', 'de'];
const cat = async (l) => (await import(`../../web/src/i18n/strings/${l}.js`)).default.topbar;

test('the picker never confirms a removal and stops icon clicks from selecting', () => {
  assert.match(picker, /e\.stopPropagation\(\)/);
  assert.match(picker, /onRemove\(x\)/);
  assert.ok(!picker.includes('useDialog') && !picker.includes('confirm('));
  assert.match(picker, /onToggleRestricted\(x\.id, !restricted\)/);
});

test('the picker keeps the active project listed even when restricted, and filters past eight', () => {
  assert.match(picker, /activeRestricted/);
  assert.match(picker, /FILTER_FROM = 8/);
  assert.match(picker, /projects\.length > FILTER_FROM/);
  assert.match(picker, /aria-expanded=\{privateShown\}/);
  assert.match(picker, /onManage\(\)/);
});

test('icon buttons carry aria-labels', () => {
  for (const src of [picker, dialog]) {
    assert.match(src, /aria-label=/);
  }
});

test('the dialog has the card grid, badges, the import button and the removal note', () => {
  assert.match(dialog, /<Dialog/);
  assert.match(dialog, /className="pm-grid"/);
  assert.match(dialog, /onImport\?\.\(\)/);
  assert.match(dialog, /onSelect\?\.\(x\.id\); onClose\?\.\(\)/);
  assert.match(dialog, /onToggleRestricted\?\.\(x\.id, !x\.restricted\)/);
  assert.match(dialog, /onRemove\?\.\(x\)/);
  assert.match(dialog, /m\.note/);
  assert.match(dialog, /m\.empty/);
  assert.match(dialog, /x\.repoPath/);
});

test('each card shows its runners, with retry, exclusion and the way back to the install question', () => {
  assert.match(dialog, /<CardMachines/);
  assert.match(dialog, /api\.retryClone\(project, row\.machine\)/);
  assert.match(dialog, /api\.setMachineOptions\(project, row\.machine, \{ autoClone \}\)/);
  assert.match(dialog, /onInstall\?\.\(project\)/);
});

test('the install dialog asks per machine, refuses a local install over node_modules and scopes its promise', async () => {
  const install = read('web/src/components/InstallDepsDialog.jsx');
  assert.match(install, /<Dialog/);
  assert.match(install, /local && !!row\.nodeModules/);
  assert.match(install, /api\.setMachineOptions\(project, machine, \{ install: choice \}\)/);
  assert.match(install, /if \(choice === 'yes'\) await api\.prepareProject\(project, machine\)/);
  assert.match(install, /d\.scope/);
  for (const l of LANGS) {
    const { installDeps } = (await import(`../../web/src/i18n/strings/${l}.js`)).default.dialogs;
    assert.match(installDeps.scope, /worktree/i, `${l}.installDeps.scope`);
  }
});

test('App reopens the install question, asks it after an import and forwards checkout messages', () => {
  const app = read('web/src/App.jsx');
  assert.match(app, /checkout: \(msg\) => window\.dispatchEvent\(new CustomEvent\('board-checkout'/);
  assert.match(app, /selectProject\(project\.id\);\s+setInstallFor\(project\.id\);/);
  assert.match(app, /onInstall=\{setInstallFor\}/);
  assert.match(app, /<InstallDepsDialog/);
});

const logic = () => import('../../web/src/projectMachines.js');
const runnerRow = (over = {}) => ({
  machine: 'devbox', kind: 'runner', reason: null, autoClone: true, present: true, deferred: false, install: 'yes',
  job: { status: 'idle', step: null, error: null, code: null }, ...over,
});
const failedJob = (code = null) => ({ status: 'failed', step: null, error: 'boom', code });

test('a saved yes can be run again, unless something else already covers it', async () => {
  const { canRunAgain } = await logic();
  assert.equal(canRunAgain(runnerRow()), true, 'nothing ran since the board started');
  assert.equal(canRunAgain(runnerRow({ job: failedJob() })), true);
  assert.equal(canRunAgain(runnerRow(), 'no'), false, 'an unsaved change goes through Save');
  assert.equal(canRunAgain(runnerRow({ install: 'no' })), false);
  assert.equal(canRunAgain(runnerRow({ install: null })), false);
  for (const status of ['queued', 'running']) {
    assert.equal(canRunAgain(runnerRow({ job: { status } })), false, status);
  }
  assert.equal(canRunAgain(runnerRow({ job: { status: 'done' }, installed: true })), false);
  assert.equal(canRunAgain(runnerRow({ job: { status: 'done' }, installed: false })), true, 'it ended without installing');
  assert.equal(canRunAgain(runnerRow({ kind: 'local', nodeModules: true })), false);
  assert.equal(canRunAgain(runnerRow({ kind: 'local', nodeModules: false })), true);
  const install = read('web/src/components/InstallDepsDialog.jsx');
  assert.match(install, /retryable = canRunAgain\(row, draft\[row\.machine\]\)/);
  assert.match(install, /onClick=\{\(\) => runAgain\(row\.machine\)\}/);
});

test('dismissing an import with warnings still counts as imported, so the install question follows', async () => {
  const { dismissOf } = await logic();
  const seen = [];
  const handlers = { onClose: () => seen.push('closed'), onImported: (p) => seen.push(p.id) };
  dismissOf({ busy: false, imported: { id: 'ehr' }, ...handlers })();
  dismissOf({ busy: false, imported: null, ...handlers })();
  assert.deepEqual(seen, ['ehr', 'closed']);
  assert.equal(dismissOf({ busy: true, imported: null, ...handlers }), null);
  assert.match(read('web/src/components/ImportProjectDialog.jsx'), /onDismiss=\{dismissOf\(\{ busy, imported, onClose, onImported \}\)\}/);
});

test('a card says «deferred» only of work the board will run again, and offers the retry otherwise', async () => {
  const { cloneState, cloneActions } = await logic();
  const s = (await cat('en')).manage.cloneState;
  const deferred = runnerRow({ job: failedJob('upgrading'), deferred: true });
  assert.equal(cloneState(s, deferred, true), s.deferred);
  const byHand = runnerRow({ job: failedJob('upgrading'), reason: 'explicit_path' });
  assert.equal(cloneState(s, byHand, true), s.failed.replace('{message}', 'boom'));
  assert.deepEqual(cloneActions(byHand), { failed: true, byConvention: false, canClone: true, wraps: true });
  assert.equal(cloneActions(runnerRow({ reason: 'explicit_path', present: false })).canClone, false);
  assert.equal(cloneActions(runnerRow({ present: false })).canClone, true);
  assert.equal(cloneActions(runnerRow()).canClone, false);
  assert.equal(cloneState(s, runnerRow({ reason: 'default_project', present: false }), true), s.explicitPath);
});

test('the four catalogs carry the same new keys and holes', async () => {
  const es = await cat('es');
  for (const l of LANGS) {
    const c = await cat(l);
    for (const k of ['choose', 'restrict', 'unrestrict', 'remove', 'restrictedHint', 'privateN', 'manage', 'filter', 'filterPlaceholder', 'list', 'noMatch']) {
      assert.ok(c.picker[k], `${l}.picker.${k}`);
    }
    for (const k of Object.keys(es.manage)) assert.ok(c.manage[k], `${l}.manage.${k}`);
    assert.deepEqual(Object.keys(c.manage), Object.keys(es.manage));
    assert.match(c.picker.privateN, /\{n\}/);
  }
  assert.equal(es.picker.privateN, 'Privados ({n})');
  assert.equal((await cat('en')).picker.privateN, 'Private ({n})');
  assert.equal((await cat('fr')).picker.privateN, 'Privés ({n})');
  assert.equal((await cat('de')).picker.privateN, 'Privat ({n})');
});

test('projects.css follows the CSS rules and is loaded', () => {
  assert.match(css, /^\/\*/);
  assert.match(css, /@media \(max-width: 780px\)/);
  assert.match(css, /44px/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(css, /!important/);
  for (const m of css.matchAll(/^\.([a-z][\w-]*)/gm)) assert.match(m[1], /^pm-/, `.${m[1]} must start with pm-`);
  assert.match(main, /import '\.\/styles\/projects\.css';/);
});

test('the picker moves focus in, returns it, and opens Privados for filter matches', () => {
  assert.match(picker, /\.pm-filter/);
  assert.match(picker, /anchorRef\.current\?\.focus/);
  assert.match(picker, /privateShown = privateOpen \|\| Boolean\(needle && priv\.length\)/);
});

test('only the topmost Dialog handles Esc', () => {
  const d = read('web/src/components/Dialog.jsx');
  assert.match(d, /openDialogs\[openDialogs\.length - 1\] !== token\.current/);
});
