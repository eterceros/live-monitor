import './isolate.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './teardown.mjs';
import { execFileSync } from 'node:child_process';

process.env.HFSMON_NO_AUTOSTART = '1';

const { unsafeConflicts, decide, pickToStart, maxParallelOf, maxAttemptsOf } = await import('../src/conflicts.js');
const { verifyMergeResolution, rollbackMergeAttempt, resolveRef } = await import('../src/worktree.js');
const { LocalMachine } = await import('../src/machine.js');
const { config } = await import('../src/config.js');
const { store } = await import('../src/store.js');
const { settings } = await import('../src/settings.js');
const { saveProjects } = await import('../src/projects.js');
const { keyOf } = await import('../src/keys.js');
const { renderPrompt, ALLOWED } = await import('../src/prompts.js');
const pipeline = await import('../src/pipeline.js');
const { conflictHooks, conflictTick, fixHooks, resolveConflictsWanted, setResolveConflicts, QuotaExhausted } = pipeline;

// --- the pure decisions --------------------------------------------------------

test('unsafeConflicts: lockfiles, migraciones, esquemas y generados necesitan a una persona; el código no', () => {
  const files = ['src/a.rs', 'Cargo.lock', 'web/package-lock.json', 'db/migrations/001_init.sql', 'crates/x/generated/types.ts', 'README.md'];
  assert.deepEqual(unsafeConflicts(files), ['Cargo.lock', 'web/package-lock.json', 'db/migrations/001_init.sql', 'crates/x/generated/types.ts']);
  assert.deepEqual(unsafeConflicts(['src/a.rs', 'src/b.ts']), []);
});

const idle = (over = {}) => ({
  state: 'pr_draft', issue: 1, project: 'p', base: 'main', updatedAt: '2026-01-01T00:00:00Z',
  branchStatus: { conflicts: 2, dirty: 0, mainSha: 'm1', conflictFiles: ['src/a.rs', 'src/b.rs'] },
  conflictRun: null, ...over,
});
const facts = (over = {}) => ({ wanted: true, canAuto: true, held: false, busy: false, dirty: false, mainSha: 'm1', files: ['src/a.rs'], limits: {}, ...over });

test('decide: solo con la tarea quieta; durante una fase espera y no dice nada', () => {
  for (const state of ['pr_draft', 'ready', 'waiting_approval']) assert.equal(decide(idle({ state }), facts()).act, 'resolve', state);
  for (const state of ['fixing', 'testing', 'browser_qa', 'fix_gaps', 'resolving_conflicts', 'error', 'done', 'assigned']) {
    assert.equal(decide(idle({ state }), facts()).act, 'wait', state);
  }
  assert.equal(decide(idle({ branchStatus: { conflicts: 0 } }), facts()).act, 'wait');
  assert.equal(decide(idle(), facts({ busy: true })).act, 'wait', 'un turno de chat en marcha');
  assert.equal(decide(idle(), facts({ wanted: false })).act, 'wait', 'apagado: ni avisa');
});

test('decide: manual, archivos delicados, trabajo sin commitear y el tope de intentos se dejan a una persona, y se dicen una vez', () => {
  assert.deepEqual(decide(idle(), facts({ canAuto: false })), { act: 'skip', reason: 'the task is manual: resolve it yourself or start it from its card', say: true });
  const lock = decide(idle(), facts({ files: ['Cargo.lock', 'src/a.rs'] }));
  assert.equal(lock.act, 'skip');
  assert.match(lock.reason, /Cargo\.lock/);
  assert.match(decide(idle(), facts({ dirty: true })).reason, /uncommitted/);

  const tried = idle({ conflictRun: { status: 'needs_attention', mainSha: 'm1', attempts: 2, reason: 'boom', said: true } });
  const capped = decide(tried, facts());
  assert.equal(capped.act, 'skip');
  assert.equal(capped.say, false, 'ya se dijo contra este origin/main');
  assert.match(capped.reason, /already tried 2 time/);

  const oneLeft = idle({ conflictRun: { status: 'needs_attention', mainSha: 'm1', attempts: 1, said: true } });
  assert.equal(decide(oneLeft, facts()).act, 'resolve', 'el segundo intento todavía cabe');

  const newMain = idle({ conflictRun: { status: 'needs_attention', mainSha: 'm0', attempts: 2, said: true } });
  assert.equal(decide(newMain, facts()).act, 'resolve', 'otro origin/main: la cuenta vuelve a empezar');
});

test('límites: 5 a la vez y 2 intentos por defecto, y la configuración manda', () => {
  assert.equal(maxParallelOf({}), 5);
  assert.equal(maxParallelOf({ maxConflictResolutions: 3 }), 3);
  assert.equal(maxParallelOf({ maxConflictResolutions: 0 }), 5);
  assert.equal(maxAttemptsOf(undefined), 2);
  assert.equal(maxAttemptsOf({ maxConflictAttempts: 4 }), 4);
});

test('pickToStart: nunca más de 5 por proyecto, la cola rellena y cada proyecto cuenta aparte', () => {
  const mk = (project, issue) => ({ project, issue, updatedAt: `2026-01-${String(issue).padStart(2, '0')}T00:00:00Z` });
  const queue = [...Array.from({ length: 8 }, (_, i) => mk('a', i + 1)), mk('b', 20), mk('b', 21)];
  const first = pickToStart(queue, new Map(), 5);
  assert.deepEqual(first.filter((t) => t.project === 'a').map((t) => t.issue), [1, 2, 3, 4, 5], 'las más antiguas primero');
  assert.deepEqual(first.filter((t) => t.project === 'b').map((t) => t.issue), [20, 21], 'el otro proyecto tiene su propio cupo');
  // Tres de las cinco terminan: quedan 2 en vuelo y se rellena hasta 5.
  const rest = queue.filter((t) => !first.includes(t) || t.issue > 2);
  const refill = pickToStart(queue.filter((t) => t.project === 'a' && t.issue > 5), new Map([['a', 2]]), 5);
  assert.deepEqual(refill.map((t) => t.issue), [6, 7, 8], 'tres huecos libres, tres tareas más');
  assert.ok(rest.length > 0);
});

// --- the interruptor -----------------------------------------------------------

test('resolveConflicts: encendido de serie, por proyecto y por tarjeta', () => {
  assert.equal(settings.resolveConflicts, true);
  assert.equal(settings.resolveConflictsFor('cualquiera'), true);
  settings.updateProject('p-off', { resolveConflicts: false });
  assert.equal(settings.resolveConflictsFor('p-off'), false);
  assert.equal(resolveConflictsWanted({ resolveConflicts: 'auto', project: 'p-off' }), false);
  assert.equal(resolveConflictsWanted({ resolveConflicts: 'on', project: 'p-off' }), true);
  assert.equal(resolveConflictsWanted({ resolveConflicts: 'off', project: 'cualquiera' }), false);
  settings.updateProject('p-off', { resolveConflicts: null });
  assert.equal(settings.resolveConflictsFor('p-off'), true);
});

test('el prompt: las variables exactas, sin push y con la salida de emergencia', () => {
  assert.ok(ALLOWED['resolve-conflicts']);
  const out = renderPrompt('resolve-conflicts', {
    issueNumber: 7, issueTitle: 'T', branch: 'feat/7', baseBranch: 'main', behind: 3, conflictCount: 2,
    conflictFiles: '- `a.rs`\n- `b.rs`', processRule: 'p.', shellRule: 's.',
  });
  assert.match(out, /git merge origin\/main/);
  assert.match(out, /No hagas push/);
  assert.match(out, /git merge --abort/);
  assert.match(out, /`a\.rs`/);
});

// --- verification against real git ----------------------------------------------

const M = new LocalMachine('test');
function repo() {
  const root = tempDir('hfsmon-conflicts-');
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const other = path.join(root, 'other');
  const git = (args, cwd) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'pipe' }).toString();
  mkdirSync(origin);
  git(['init', '--bare', '-b', 'main', '.'], origin);
  git(['clone', origin, work], root);
  const setup = (dir) => { for (const [k, v] of [['user.email', 't@e.com'], ['user.name', 'T'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(['config', k, v], dir); };
  setup(work);
  writeFileSync(path.join(work, 'shared.txt'), 'uno\ndos\ntres\n');
  git(['add', '.'], work);
  git(['commit', '-m', 'seed'], work);
  git(['push', '-u', 'origin', 'main'], work);
  git(['clone', origin, other], root);
  setup(other);
  git(['checkout', '-b', 'feat/x'], work);
  writeFileSync(path.join(work, 'shared.txt'), 'uno\nDOS DE LA RAMA\ntres\n');
  git(['commit', '-am', 'mine'], work);
  writeFileSync(path.join(other, 'shared.txt'), 'uno\nDOS DE MAIN\ntres\n');
  git(['commit', '-am', 'theirs'], other);
  git(['push', 'origin', 'main'], other);
  git(['fetch', 'origin'], work);
  return { work, git: (a) => git(a, work), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('verifyMergeResolution: un merge bien resuelto pasa; marcadores, merge a medias o sin commit, no', async () => {
  const r = repo();
  try {
    const headBefore = await resolveRef(M, r.work, 'HEAD');
    const mainSha = await resolveRef(M, r.work, 'origin/main');
    const files = ['shared.txt'];

    // Nothing done yet: no merge commit.
    let v = await verifyMergeResolution(M, r.work, { headBefore, mainSha, files });
    assert.equal(v.ok, false);
    assert.match(v.problems.join(';'), /no merge commit/);

    // Half-done merge (conflicted, uncommitted).
    assert.throws(() => r.git(['merge', 'origin/main']));
    v = await verifyMergeResolution(M, r.work, { headBefore, mainSha, files });
    assert.equal(v.ok, false);
    assert.match(v.problems.join(';'), /half-done/);

    // Committed with the markers still inside.
    r.git(['add', '.']);
    r.git(['commit', '--no-edit']);
    v = await verifyMergeResolution(M, r.work, { headBefore, mainSha, files });
    assert.equal(v.ok, false);
    assert.match(v.problems.join(';'), /conflict markers/);

    // Put back where it was, then do it properly.
    assert.equal(await rollbackMergeAttempt(M, r.work, headBefore), true);
    assert.equal(await resolveRef(M, r.work, 'HEAD'), headBefore, 'la rama vuelve a donde estaba');
    assert.throws(() => r.git(['merge', 'origin/main']));
    writeFileSync(path.join(r.work, 'shared.txt'), 'uno\nLAS DOS\ntres\n');
    r.git(['add', '.']);
    r.git(['commit', '--no-edit']);
    v = await verifyMergeResolution(M, r.work, { headBefore, mainSha, files });
    assert.deepEqual(v, { ok: true, problems: [] });
  } finally { r.cleanup(); }
});

test('rollbackMergeAttempt aborta un merge a medias y deja el árbol limpio', async () => {
  const r = repo();
  try {
    const headBefore = await resolveRef(M, r.work, 'HEAD');
    assert.throws(() => r.git(['merge', 'origin/main']));
    assert.equal(await rollbackMergeAttempt(M, r.work, headBefore), true);
    assert.equal(r.git(['status', '--porcelain']).trim(), '');
    assert.equal(await resolveRef(M, r.work, 'HEAD'), headBefore);
  } finally { r.cleanup(); }
});

// --- the flow, with fakes -----------------------------------------------------------

const entries = () => [
  { id: 'plain', name: 'plain', repoPath: config.project.repoPath, worktreeRoot: config.project.worktreeRoot, repo: 'eterceros/plain', assignee: config.github.assignee, reviewer: null, overrides: { e2e: null, stack: null } },
];
const realHooks = { ...conflictHooks };
const realRun = fixHooks.runClaude;
const savedLimits = config.limits;
before(() => {
  saveProjects(entries());
  settings.update({ autoStart: false });
  // One attempt per origin/<base>, so a failed run is not retried at once and the tests read one run each.
  config.limits = { ...savedLimits, maxConflictAttempts: 1 };
});
after(() => { Object.assign(conflictHooks, realHooks); fixHooks.runClaude = realRun; config.limits = savedLimits; saveProjects(entries()); });

let n = 9700;
function taskOf(fields = {}) {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'plain');
  task.worktreePath = `/wt/${n}`;
  task.branch = `fix/${n}-thing`;
  task.chats[0].sessionId = 'fix-session';
  return Object.assign(task, { state: 'pr_draft', resolveConflicts: 'on', branchStatus: { behind: 1, unpushed: 0, dirty: 0, conflicts: 2, mainSha: 'm1', conflictFiles: ['src/a.rs', 'src/b.rs'] } }, fields);
}

/** The git and the session as scripted fakes; `calls` records what ran, in order. */
function fakes({ verifyOk = true, testFails = false, pushFails = false, quota = false, clean = false } = {}) {
  const calls = [];
  conflictHooks.isProjectWorktree = async () => true;
  conflictHooks.resolveRef = async () => 'm1';
  conflictHooks.analyzeMerge = async () => ({ mainSha: 'm1', behind: 1, clean, conflicts: clean ? [] : ['src/a.rs', 'src/b.rs'] });
  conflictHooks.mergeBlockers = async () => ({ blocked: false });
  conflictHooks.getIssue = async (issue) => ({ number: issue, title: 'Issue', body: 'x' });
  let head = 'h0';
  conflictHooks.headCommit = async () => head;
  fixHooks.runClaude = async (o) => { calls.push(['session', o.prompt.includes('git merge origin/main'), o.resume]); head = 'h1'; return { ok: true, resultText: 'listo', sessionId: 'fix-session', toolCounts: {}, quota }; };
  conflictHooks.verify = async () => { calls.push(['verify']); return verifyOk ? { ok: true, problems: [] } : { ok: false, problems: ['conflict markers are still in: a.rs'] }; };
  conflictHooks.testPhase = async (t) => { calls.push(['test', t.e2ePassedAt]); if (testFails) throw new Error('The e2e tests still fail after 3 attempts'); };
  conflictHooks.push = async () => { calls.push(['push']); if (pushFails) throw new Error('rejected'); };
  conflictHooks.rollback = async (_m, _c, before) => { calls.push(['rollback', before]); head = before; return true; };
  return calls;
}

const settled = async (task) => {
  for (let i = 0; i < 200 && task.state === 'resolving_conflicts'; i += 1) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 30));
};
const chatOf = (task) => task.chats[0].messages.filter((m) => m.role === 'assistant').map((m) => m.text ?? m.content ?? '');
const withAutostart = async (fn) => {
  process.env.HFSMON_NO_AUTOSTART = '0';
  try { return await fn(); } finally { process.env.HFSMON_NO_AUTOSTART = '1'; }
};

test('flujo feliz: sesión, verificación, tests acotados, push y la tarea vuelve a su estado', async () => {
  const task = taskOf();
  const calls = fakes();
  await withAutostart(async () => {
    conflictTick();
    assert.equal(task.state, 'resolving_conflicts', 'se reclama al instante, antes de la primera espera');
    await settled(task);
  });
  assert.deepEqual(calls.map((c) => c[0]), ['session', 'verify', 'test', 'push']);
  assert.deepEqual(calls[0], ['session', true, 'fix-session'], 'reanuda la sesión del fix con las instrucciones del merge');
  assert.equal(calls[2][1], null, 'e2ePassedAt se invalidó antes de volver a probar');
  assert.equal(task.state, 'pr_draft');
  assert.equal(task.conflictRun.status, 'resolved');
  assert.equal(task.e2ePassedAt, 'h1');
  assert.ok(chatOf(task).some((m) => /Resolved the conflict/.test(m)));
});

test('una resolución que no pasa la verificación se deshace: sin tests, sin push, y se dice por qué', async () => {
  const task = taskOf({ state: 'waiting_approval' });
  const calls = fakes({ verifyOk: false });
  await withAutostart(async () => { conflictTick(); await settled(task); });
  assert.deepEqual(calls.map((c) => c[0]), ['session', 'verify', 'rollback']);
  assert.deepEqual(calls[2], ['rollback', 'h0']);
  assert.equal(task.state, 'waiting_approval', 'vuelve al estado en que esperaba');
  assert.equal(task.conflictRun.status, 'needs_attention');
  assert.match(task.conflictRun.reason, /conflict markers/);
  assert.ok(chatOf(task).some((m) => /could not resolve/.test(m)));
});

test('tests en rojo tras resolver: se deshace y no se sube nada', async () => {
  const task = taskOf({ state: 'ready' });
  const calls = fakes({ testFails: true });
  await withAutostart(async () => { conflictTick(); await settled(task); });
  assert.deepEqual(calls.map((c) => c[0]), ['session', 'verify', 'test', 'rollback']);
  assert.equal(task.state, 'ready');
  assert.match(task.conflictRun.reason, /still fail/);
});

test('un push rechazado también deshace', async () => {
  const task = taskOf();
  const calls = fakes({ pushFails: true });
  await withAutostart(async () => { conflictTick(); await settled(task); });
  assert.equal(calls.at(-1)[0], 'rollback');
  assert.equal(task.conflictRun.status, 'needs_attention');
});

test('un conflicto que ya no existe: no hay sesión y la tarea vuelve a su estado', async () => {
  const task = taskOf();
  const calls = fakes({ clean: true });
  await withAutostart(async () => { conflictTick(); await settled(task); });
  assert.deepEqual(calls, []);
  assert.equal(task.state, 'pr_draft');
  assert.equal(task.conflictRun.status, 'gone');
});

test('sin cuota la sesión no cuenta como intento y la tarea sigue en espera', async () => {
  const task = taskOf();
  fakes({ quota: true });
  // The real hold stops `conflictTick`; here the fake does it, or the run would repeat.
  const quotaRun = fixHooks.runClaude;
  fixHooks.runClaude = async (o) => { task.resolveConflicts = 'off'; return quotaRun(o); };
  await withAutostart(async () => { conflictTick(); await settled(task); });
  assert.equal(task.conflictRun.status, 'waiting_quota');
  assert.equal(task.conflictRun.attempts, 0);
  assert.equal(task.state, 'pr_draft');
  assert.ok(QuotaExhausted);
});

test('manual, apagado y lockfiles: no se lanza ninguna sesión', async () => {
  const manual = taskOf({ mode: 'manual' });
  const off = taskOf({ resolveConflicts: 'off' });
  const lock = taskOf({ branchStatus: { behind: 1, unpushed: 0, dirty: 0, conflicts: 1, mainSha: 'm1', conflictFiles: ['package-lock.json'] } });
  const calls = fakes();
  await withAutostart(async () => { conflictTick(); await new Promise((r) => setTimeout(r, 60)); });
  assert.deepEqual(calls, [], 'nada corrió');
  for (const t of [manual, off, lock]) assert.equal(t.state, 'pr_draft');
  assert.equal(manual.conflictRun?.status, 'skipped');
  assert.equal(lock.conflictRun?.status, 'skipped');
  assert.equal(off.conflictRun, null, 'apagado no avisa: no es asunto del tablero');
  assert.ok(chatOf(lock).some((m) => /left to you/.test(m)));
  // Once per origin/<base>: a second tick says nothing new.
  const before = chatOf(lock).length;
  await withAutostart(async () => { conflictTick(); await new Promise((r) => setTimeout(r, 30)); });
  assert.equal(chatOf(lock).length, before);
});

test('nunca más de 5 resoluciones a la vez en un proyecto; las demás esperan en cola', async () => {
  // Park every session until released, so the in-flight count can be read.
  const release = [];
  fakes();
  fixHooks.runClaude = (o) => new Promise((resolve) => release.push(() => resolve({ ok: true, resultText: '', sessionId: 'fix-session', toolCounts: {}, quota: false })));
  const tasks = Array.from({ length: 8 }, () => taskOf());
  await withAutostart(async () => {
    conflictTick();
    const resolving = () => tasks.filter((t) => t.state === 'resolving_conflicts').length;
    assert.equal(resolving(), 5, 'cinco en vuelo, tres en cola');
    // The test hooks answer instantly once released; finish three and the queue refills to five.
    await new Promise((r) => setTimeout(r, 30));
    for (const t of release.splice(0, 3)) t();
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(tasks.filter((t) => t.state === 'resolving_conflicts').length, 5, 'rellena hasta cinco');
    for (let i = 0; i < 20; i += 1) { for (const t of release.splice(0)) t(); await new Promise((r) => setTimeout(r, 30)); }
  });
  assert.ok(tasks.every((t) => t.state === 'pr_draft'));
  assert.ok(tasks.every((t) => t.conflictRun.status === 'resolved'));
});

test('setResolveConflicts valida el modo', () => {
  const task = taskOf();
  assert.equal(setResolveConflicts(keyOf(task), 'off'), 'off');
  assert.throws(() => setResolveConflicts(keyOf(task), 'quizá'), /auto, on or off/);
});
