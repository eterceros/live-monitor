// Moving a task between two machines, against real git: a bare origin, clone A
// as the board's own machine and clone B served by an in-process runner. The
// Claude handoff, the readiness check and the machines' home directories go
// through `moveHooks`, so nothing here starts a session or touches the user's
// real `~/.claude/projects`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dataDir = mkdtempSync(path.join(tmpdir(), 'hfsmon-move-data-'));
process.env.HFSMON_DATA_DIR = dataDir;
process.env.HFSMON_NO_AUTOSTART = '1';

const git = (args, cwd) => execFileSync(
  'git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' },
);
const write = (dir, name, data) => {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  writeFileSync(path.join(dir, name), data);
};
const commitIn = (wt, name, text, message) => {
  write(wt, name, text);
  git(['add', '--', name], wt);
  git(['commit', '-m', message], wt);
  return git(['rev-parse', 'HEAD'], wt).trim();
};
const head = (wt) => git(['rev-parse', 'HEAD'], wt).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = mkdtempSync(path.join(tmpdir(), 'hfsmon-move-'));
const TOKEN = 'secreto-de-prueba';
const HOME = { local: path.join(ROOT, 'home-local'), box: path.join(ROOT, 'home-box') };

let move;
let store;
let config;
let machines;
let createWorktree;
let isProjectWorktree;
let worktreePathFor;
let pipeline;
let runner;
let savedMachines;
const w = {};
const handoffCalls = [];
let failTarget = false;

before(async () => {
  ({ config } = await import('../src/config.js'));
  ({ store } = await import('../src/store.js'));
  ({ machines } = await import('../src/machine.js'));
  ({ createWorktree, isProjectWorktree, worktreePathFor } = await import('../src/worktree.js'));
  move = await import('../src/move.js');
  pipeline = await import('../src/pipeline.js');
  const { createRunner } = await import('../src/runner/app.js');

  const configure = (repo) => {
    git(['config', 'user.email', 'test@example.com'], repo);
    git(['config', 'user.name', 'Test'], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);
    git(['config', 'core.autocrlf', 'false'], repo);
  };
  const origin = path.join(ROOT, 'origin.git');
  mkdirSync(origin);
  git(['init', '--bare', '-b', 'main', '.'], origin);
  const seed = path.join(ROOT, 'seed');
  git(['clone', origin, seed], ROOT);
  configure(seed);
  write(seed, 'README.md', '# seed\n');
  write(seed, 'src/lib.rs', 'pub fn a() {}\n');
  write(seed, 'other.txt', 'ajeno\n');
  git(['add', '.'], seed);
  git(['commit', '-m', 'seed'], seed);
  git(['push', '-u', 'origin', 'main'], seed);
  for (const name of ['a', 'b']) {
    const repo = path.join(ROOT, name);
    git(['clone', origin, repo], ROOT);
    configure(repo);
    w[name] = { repo, wtRoot: path.join(ROOT, `${name}-wt`) };
  }

  runner = createRunner({
    token: TOKEN, repoPath: w.b.repo, worktreeRoot: w.b.wtRoot,
    attachmentsDir: path.join(ROOT, 'attachments'), claudeCommand: process.execPath,
  });
  const addr = await runner.listen(0, '127.0.0.1');
  savedMachines = config.machines;
  config.machines = {
    local: { kind: 'local', repoPath: w.a.repo, worktreeRoot: w.a.wtRoot },
    box: { kind: 'runner', url: `http://127.0.0.1:${addr.port}`, token: TOKEN, repoPath: w.b.repo, worktreeRoot: w.b.wtRoot },
  };

  move.moveHooks.homeOf = async (m) => HOME[m.name];
  move.moveHooks.assertMachineReady = async (m) => {
    if (failTarget && m.name === 'box') throw new Error('box caída a propósito');
  };
  move.moveHooks.runClaude = async (options) => {
    handoffCalls.push({ machine: options.machine.name, cwd: options.cwd, resume: options.resume, permissionMode: options.permissionMode, maxTurns: options.maxTurns, tools: options.tools });
    const denied = await options.canUseTool?.('Bash', {}, {});
    assert.equal(denied?.behavior, 'deny', 'el turno de handoff no usa herramientas');
    return { ok: true, sessionId: options.resume, resultText: `handoff escrito en ${options.machine.name}`, toolCounts: {} };
  };
});

after(async () => {
  config.machines = savedMachines;
  if (savedMachines === undefined) delete config.machines;
  store.flush();
  await runner?.close();
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

let n = 7000;
/** A task on `local` with its worktree, one commit on the branch and a chat session there. */
async function taskOnLocal(slug, { sessionId = `sess-${slug}`, state = 'started' } = {}) {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  task.machine = 'local';
  task.state = state;
  task.branch = `feat/${n}-${slug}`;
  task.worktreePath = await createWorktree(machines().local, task.branch);
  commitIn(task.worktreePath, 'src/lib.rs', `pub fn a() { ${n} }\n`, 'trabajo de la rama');
  const chat = task.chats[0];
  if (sessionId) {
    chat.sessionId = sessionId;
    fakeTranscript('local', task.worktreePath, sessionId);
  }
  return task;
}

/** A transcript where the CLI of that machine would have written it. */
function fakeTranscript(machineName, cwd, sessionId) {
  const m = machines()[machineName];
  const [file] = move.sessionTranscriptCandidates({ home: HOME[machineName], cwd, sessionId, join: (...p) => m.path.join(...p) });
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '{"type":"user"}\n');
}

/** Starts a move and waits until it is over, one way or the other. */
async function moveAndWait(task, options) {
  const from = task.machine;
  const logged = task.log.length;
  const moving = await move.moveTask(task.issue, options);
  assert.ok(moving, 'moveTask vuelve con la mudanza en marcha');
  return settle(task, logged, from, options.to);
}

/** The `op` spans a move left on the task, in order: one per step it entered. */
const opSpans = (task) => (task.timings ?? []).filter((s) => s.kind === 'op' && s.name.startsWith('move:'));

async function settle(task, logged, from, to) {
  const limit = Date.now() + 90_000;
  while (Date.now() < limit) {
    if (task.moving?.error) return task.moving;
    if (!task.moving && task.log.slice(logged).some((l) => l.line === `moved from ${from} to ${to}`)) return null;
    await sleep(50);
  }
  throw new Error(`la mudanza no terminó: ${task.log.slice(-5).map((l) => l.line).join(' | ')}`);
}

test('ida y vuelta: el WIP de la rama viaja solo, la sesión de allí vuelve y cada chat llega con su handoff', async () => {
  const task = await taskOnLocal('viaje');
  const chat = task.chats[0];
  const wtA = task.worktreePath;
  write(wtA, 'src/lib.rs', 'pub fn a() { "sin commitear" }\n');
  write(wtA, 'target-x/debug/basura.bin', 'x');
  write(wtA, 'other.txt', 'ajeno y sucio\n');
  const headA = head(wtA);
  chat.lastSeenSha = headA;

  const failed = await moveAndWait(task, { to: 'box', prewarm: false });
  assert.equal(failed, null, failed?.error);
  assert.equal(task.machine, 'box');
  assert.equal(task.state, 'started', 'la tarjeta vuelve a su estado');
  const wtB = task.worktreePath;
  assert.ok(await isProjectWorktree(machines().box, wtB));

  assert.equal(git(['log', '-1', '--format=%s'], wtB).trim(), 'wip: uncommitted work');
  assert.deepEqual(git(['show', '--name-only', '--format=', 'HEAD'], wtB).trim().split(/\r?\n/), ['src/lib.rs']);
  assert.equal(existsSync(path.join(wtB, 'target-x')), false, 'target-x/ no viaja');
  assert.equal(git(['show', 'HEAD:other.txt'], wtB), 'ajeno\n', 'ni el archivo ajeno');
  const statusA = git(['status', '--porcelain'], wtA);
  assert.match(statusA, /^ M other\.txt$/m, 'se queda sucio donde estaba');
  assert.match(statusA, /^\?\? target-x\/$/m);
  assert.equal(chat.lastSeenSha, head(wtA), 'el WIP no se le anuncia al chat como commit ajeno');

  assert.deepEqual(handoffCalls.at(-1), { machine: 'local', cwd: wtA, resume: 'sess-viaje', permissionMode: 'plan', maxTurns: 6, tools: [] });
  assert.equal(chat.sessionId, null, 'en box no tenía sesión: empieza de cero');
  assert.equal(chat.handoff.text, 'handoff escrito en local');
  assert.equal(chat.handoff.resumed, false);
  assert.equal(chat.handoff.wip, true);
  assert.match(chat.handoff.brief, /trabajo de la rama|wip/);
  assert.equal(chat.handoffDraft, undefined);
  assert.equal(task.places.local.sessions[chat.id], 'sess-viaje');
  assert.equal(task.places.local.worktreePath, wtA);
  assert.equal(task.places.box.worktreePath, wtB);

  // A turn in box: a session there, a commit of its own.
  chat.handoff = null;
  chat.sessionId = 'sess-box';
  fakeTranscript('box', wtB, 'sess-box');
  const inBox = commitIn(wtB, 'src/b.rs', 'pub fn b() {}\n', 'hecho en box');

  const back = await moveAndWait(task, { to: 'local', prewarm: false });
  assert.equal(back, null, back?.error);
  assert.equal(task.machine, 'local');
  assert.equal(task.worktreePath, wtA, 'el worktree conservado se reutiliza');
  assert.equal(head(wtA), inBox, 'y avanza hasta lo que se hizo en box');
  assert.equal(chat.sessionId, 'sess-viaje', 'la conversación de local se reanuda');
  assert.equal(chat.handoff.resumed, true);
  assert.equal(chat.handoff.text, 'handoff escrito en box');
  assert.equal(chat.handoff.wip, false);
  assert.equal(task.places.box.sessions[chat.id], 'sess-box', 'y la de box queda apuntada para la próxima');
  assert.deepEqual(Object.keys(task.places).sort(), ['box', 'local']);
  assert.match(git(['status', '--porcelain'], wtA), /^ M other\.txt$/m, 'lo ajeno sigue sin tocar');
});

test('volver a un worktree conservado: se avanza si va por detrás; con commits sin subir bloquea, y descartarlos lo deja como origin', async () => {
  const task = await taskOnLocal('conservado', { sessionId: null });
  const wtA = task.worktreePath;
  git(['push', '-u', 'origin', task.branch], wtA);
  const wtB = await createWorktree(machines().box, task.branch, { adopt: true });
  const second = commitIn(wtA, 'src/lib.rs', 'pub fn a() { 2 }\n', 'segundo, sin subir');

  assert.equal(await moveAndWait(task, { to: 'box', prewarm: false }), null);
  assert.equal(task.worktreePath, wtB);
  assert.equal(head(wtB), second, 'el worktree que había en box se puso al día');

  assert.equal(await moveAndWait(task, { to: 'local', prewarm: false }), null);
  const local = commitIn(wtB, 'src/solo-box.rs', 'x\n', 'local de box, sin subir');

  const blockers = await move.moveBlockers(task, 'box');
  const ahead = blockers.find((b) => b.code === 'target_ahead');
  assert.ok(ahead, JSON.stringify(blockers));
  assert.equal(ahead.lifted, undefined);
  await assert.rejects(move.moveTask(task.issue, { to: 'box', prewarm: false }), (e) => {
    assert.equal(e.status, 409);
    assert.ok(e.blockers.some((b) => b.code === 'target_ahead'));
    return true;
  });
  assert.equal(task.moving, null, 'rechazada, no deja rastro');

  const preflight = await move.movePreflight(task.issue, 'box', { discardTargetLocal: true });
  assert.equal(preflight.blockers.find((b) => b.code === 'target_ahead')?.lifted, true, 'se sigue viendo, tachado');
  assert.equal(preflight.target.worktree, 'exists');
  assert.equal(preflight.target.ahead, 1);

  assert.equal(await moveAndWait(task, { to: 'box', prewarm: false, discardTargetLocal: true }), null);
  assert.equal(head(wtB), head(wtA), 'box queda como origin');
  assert.notEqual(head(wtB), local);
});

test('una tarea en error conserva estado, fase previa y error: Reintentar sigue sirviendo allí', async () => {
  const task = await taskOnLocal('error', { state: 'error' });
  task.prevState = 'testing';
  task.error = 'x';
  task.lastError = 'antes';

  assert.equal(await moveAndWait(task, { to: 'box', prewarm: false }), null);
  assert.equal(task.state, 'error');
  assert.equal(task.prevState, 'testing');
  assert.equal(task.error, 'x');
  assert.equal(task.lastError, 'antes');
});

test('un plan esperando aprobación llega marcado para replanificar, sin sesiones de la otra máquina', async () => {
  const task = await taskOnLocal('plan', { state: 'plan_ready' });
  task.planSessionId = 'plan-sess';
  task.workPlan = { status: 'approved', forkFrom: 'plan-sess', tasks: [{ id: 't1', status: 'pending', sessionId: 's1' }] };
  task.chats[0].plan = { id: 'p1', status: 'done', selected: [], tasks: [{ id: 'c1', sessionId: 'cs1' }] };

  assert.equal(await moveAndWait(task, { to: 'box', prewarm: false }), null);
  const ops = opSpans(task);
  assert.ok(ops.length >= 4, `one op span per step entered, got ${ops.map((o) => o.name).join(',')}`);
  for (const name of ['move:source_git', 'move:handoff', 'move:build_target']) {
    assert.ok(ops.some((o) => o.name === name), `${name} is recorded`);
  }
  for (const o of ops) {
    assert.notEqual(o.endedAt, null, `${o.name} has an end`);
    assert.equal(o.outcome, 'ok');
    assert.equal(o.meta.from, 'local');
    assert.equal(o.meta.to, 'box');
  }
  assert.ok(!ops.some((o) => o.name === 'move:done'), 'done is the end, not a step');
  assert.equal(task.state, 'plan_ready');
  assert.equal(task.workPlan.replan.from, 'local');
  assert.ok(task.workPlan.replan.at);
  assert.equal(task.workPlan.forkFrom, null);
  assert.equal(task.workPlan.tasks[0].sessionId, null);
  assert.equal(task.planSessionId, null);
  assert.equal(task.chats[0].plan.tasks[0].sessionId, null);
});

test('si el destino falla al construirse, la tarea sigue entera en local; reintentar la termina sin repetir el handoff', async () => {
  const task = await taskOnLocal('falla');
  const chat = task.chats[0];
  const wtA = task.worktreePath;

  const logged = task.log.length;
  await move.moveTask(task.issue, { to: 'box', prewarm: false });
  failTarget = true;   // after validation: only the build step sees it
  let failed;
  try {
    failed = await settle(task, logged, 'local', 'box');
  } finally {
    failTarget = false;
  }
  assert.match(failed?.error ?? '', /box caída a propósito/);
  assert.equal(failed.step, 'build_target');
  const failedOps = opSpans(task);
  const cut = failedOps[failedOps.length - 1];
  assert.equal(cut.name, 'move:build_target');
  assert.equal(cut.outcome, 'error', 'the step that threw closes as error');
  assert.notEqual(cut.endedAt, null);
  assert.ok(failedOps.slice(0, -1).every((o) => o.outcome === 'ok' && o.endedAt), 'earlier steps closed ok');
  assert.equal(task.machine, 'local');
  assert.equal(task.worktreePath, wtA);
  assert.equal(chat.sessionId, 'sess-falla', 'las sesiones no se tocaron');
  assert.equal(task.state, 'started');
  assert.equal(task.places.local.sessions[chat.id], 'sess-falla');
  const calls = handoffCalls.length;

  const retried = task.log.length;
  await move.retryMove(task.issue);
  assert.equal(await settle(task, retried, 'local', 'box'), null);
  assert.equal(task.machine, 'box');
  assert.equal(task.moving, null);
  assert.ok(opSpans(task).every((o) => o.endedAt != null), 'no step span is left open after the retry');
  assert.equal(opSpans(task).filter((o) => o.name === 'move:build_target' && o.outcome === 'ok').length, 1);
  assert.equal(handoffCalls.length, calls, 'el borrador de handoff marca ese paso como hecho');
  assert.equal(chat.handoff.text, 'handoff escrito en local');
  await assert.rejects(move.retryMove(task.issue), (e) => e.status === 400);
});

test('«borrar» el worktree de origen: se va del disco, pero sus sesiones quedan apuntadas', async () => {
  const task = await taskOnLocal('borrar');
  const chat = task.chats[0];
  const wtA = task.worktreePath;

  assert.equal(await moveAndWait(task, { to: 'box', oldWorktree: 'remove', prewarm: false }), null);
  assert.equal(existsSync(wtA), false);
  assert.equal(task.places.local.worktreePath, null);
  assert.equal(task.places.local.sessions[chat.id], 'sess-borrar');
  assert.equal(task.machine, 'box');

  // Only ever the board's own directory for this branch, and no other task's.
  const stray = await taskOnLocal('ajena', { sessionId: null });
  const elsewhere = mkdtempSync(path.join(ROOT, 'no-es-del-tablero-'));
  task.places.local.worktreePath = elsewhere;
  await assert.rejects(move.removePlace(task, 'local'), (e) => e.status === 409 && /is not where the board puts/.test(e.message));
  assert.equal(existsSync(elsewhere), true);
  task.places.local.worktreePath = null;
  const shared = store.addTask({ number: 7990, title: 'comparte', labels: [], url: 'x', closed: false }, 'hfs');
  shared.machine = 'box';
  shared.places = { local: { worktreePath: stray.worktreePath, sessions: {}, at: new Date().toISOString() } };
  await assert.rejects(move.removePlace(stray, 'local'), (e) => e.status === 409 && /#7990/.test(e.message));
  assert.equal(existsSync(stray.worktreePath), true);
});

test('un push que origin rechaza para la mudanza en source_git, con el estado de antes y sin forzar nada', async () => {
  const task = await taskOnLocal('rechazo', { sessionId: null, state: 'pr_draft' });
  const wtA = task.worktreePath;
  git(['push', '-u', 'origin', task.branch], wtA);
  // Someone else pushes to the same branch from another clone.
  const seed = path.join(ROOT, 'seed');
  git(['fetch', 'origin', task.branch], seed);
  git(['checkout', '-B', task.branch, `origin/${task.branch}`], seed);
  const theirs = commitIn(seed, 'src/ajeno.rs', 'x\n', 'de otro');
  git(['push', 'origin', task.branch], seed);
  git(['checkout', 'main'], seed);
  const mine = commitIn(wtA, 'src/lib.rs', 'pub fn a() { "mío" }\n', 'mío, sin subir');

  const started = Date.now();
  const failed = await moveAndWait(task, { to: 'box', prewarm: false });
  assert.ok(Date.now() - started < 30_000, 'un rechazo no se reintenta con esperas');
  assert.equal(failed?.step, 'source_git', JSON.stringify(failed));
  assert.match(failed.error, /push/i);
  assert.equal(task.state, 'pr_draft');
  assert.equal(task.machine, 'local');
  assert.equal(task.worktreePath, wtA);
  assert.equal(pipeline.isPipelineRunning(task.issue), false, 'y la tarea queda libre');
  assert.equal(git(['rev-parse', task.branch], path.join(ROOT, 'origin.git')).trim(), theirs, 'origin no se tocó');
  assert.equal(head(wtA), mine);
  move.discardMove(task.issue);
});

test('un destino que no contesta y uno cuyo git worktree list falla son un bloqueo cada uno, no un cuelgue ni una excepción', async () => {
  const task = await taskOnLocal('inalcanzable', { sessionId: null });
  const original = config.machines;
  const { probeMs } = move.moveHooks;
  const ready = move.moveHooks.assertMachineReady;
  config.machines = {
    ...original,
    // A checkout whose .git is not a repository: it is there, but git cannot list its worktrees.
    ghost: { ...original.box, repoPath: path.join(ROOT, 'roto') },
    // No checkout at all: the project was never put on that machine.
    vacio: { ...original.box, repoPath: path.join(ROOT, 'no-existe') },
    mute: { ...original.box },
  };
  mkdirSync(path.join(ROOT, 'roto', '.git'), { recursive: true });
  move.moveHooks.probeMs = 2000;
  move.moveHooks.assertMachineReady = (m) => (m.name === 'mute' ? new Promise(() => {}) : ready(m));
  try {
    const started = Date.now();
    const mute = await move.moveBlockers(task, 'mute');
    assert.ok(Date.now() - started < 15_000, 'la espera tiene tope');
    assert.ok(mute.some((b) => b.code === 'target_unreachable'), JSON.stringify(mute));

    const ghost = await move.moveBlockers(task, 'ghost');
    assert.match(ghost.find((b) => b.code === 'target_git')?.text ?? '', /worktree list/, JSON.stringify(ghost));

    const vacio = await move.moveBlockers(task, 'vacio');
    assert.match(vacio.find((b) => b.code === 'project_not_prepared')?.text ?? '', /not on vacio yet/, JSON.stringify(vacio));
  } finally {
    config.machines = original;
    move.moveHooks.probeMs = probeMs;
    move.moveHooks.assertMachineReady = ready;
  }
});

test('restaurar sesiones: un fork toma la de su padre aunque vaya antes que él, y sin home no se pierde ninguna', async () => {
  const { addChatTo } = await import('../src/chats.js');
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  task.machine = 'local';
  task.branch = `feat/${n}-forks`;
  const principal = task.chats[0];
  const grandchild = addChatTo(task, { title: 'nieto' });   // listed before its parent on purpose
  const child = addChatTo(task, { title: 'hijo', forkedFrom: principal.id });
  grandchild.forkedFrom = child.id;
  const orphan = addChatTo(task, { title: 'huérfano', forkedFrom: 'no-existe' });
  task.places = {
    box: {
      worktreePath: null,
      sessions: {
        [principal.id]: 'sp',
        [child.id]: { forkFrom: 'perdida' },
        [grandchild.id]: { forkFrom: 'perdida-2' },
        [orphan.id]: { forkFrom: 'perdida-3' },
      },
      at: new Date().toISOString(),
    },
  };
  fakeTranscript('box', worktreePathFor(machines().box, task.branch), 'sp');

  principal.sessionId = 'la-de-local';
  const homeOf = move.moveHooks.homeOf;
  move.moveHooks.homeOf = async (m) => (m.name === 'box' ? null : HOME[m.name]);
  try {
    await assert.rejects(move.restoreSessions(task, 'box'), /could not read its home/);
  } finally {
    move.moveHooks.homeOf = homeOf;
  }
  assert.equal(principal.sessionId, 'la-de-local', 'sin saber dónde mirar, nada se anula');

  const restored = await move.restoreSessions(task, 'box');
  assert.deepEqual([principal.sessionId, principal.forkPending], ['sp', false]);
  assert.deepEqual([child.sessionId, child.forkPending], ['sp', true], 'el fork parte de la sesión de su padre allí');
  assert.deepEqual([grandchild.sessionId, grandchild.forkPending], ['sp', true], 'y el fork del fork, aunque vaya antes');
  assert.deepEqual([orphan.sessionId, orphan.forkPending], [null, false]);
  assert.deepEqual([...restored].sort(), [principal.id, child.id, grandchild.id].sort());
});

test('precalentar: cargo build en el destino, log con cuentagotas, y la siguiente mudanza lo mata por pid', async () => {
  const { EventEmitter } = await import('node:events');
  const task = await taskOnLocal('prewarm', { sessionId: null });
  const box = machines().box;
  const spawned = [];
  const killedPids = [];
  const handles = [];
  box.daemon.spawn = (bin, opts) => {
    const handle = new EventEmitter();
    handle.pid = 4242 + handles.length;
    handle.kills = 0;
    handle.kill = () => { handle.kills += 1; };
    handles.push(handle);
    spawned.push({ bin, ...opts });
    return handle;
  };
  box.daemon.kill = async (pid) => { killedPids.push(pid); };

  assert.equal(await moveAndWait(task, { to: 'box' }), null, 'precalentar va marcado por defecto');
  assert.deepEqual(spawned, [{ bin: 'cargo', cwd: task.worktreePath, args: ['build'] }]);
  assert.equal(task.prewarm.machine, 'box');
  assert.equal(task.prewarm.endedAt, null);
  assert.equal(task.prewarm.ok, null);

  const [first] = handles;
  const logged = task.log.length;
  for (let i = 1; i <= 120; i += 1) first.emit('line', `Compiling crate-${i}`);
  assert.equal(task.log.slice(logged).filter((l) => /^cargo build:/.test(l.line)).length, 2, 'una línea de cada 50');
  assert.equal(move.startPrewarm(task, 'box', task.worktreePath), null, 'uno en marcha no se duplica');
  assert.equal(spawned.length, 1);

  assert.equal(await moveAndWait(task, { to: 'local', prewarm: false }), null);
  assert.deepEqual(killedPids, [4242], 'el árbol entero, por pid');
  assert.equal(first.kills, 1, 'y el kill del handle de reserva');
  assert.equal(task.prewarm.ok, null);
  const { endedAt } = task.prewarm;
  assert.ok(endedAt, 'cerrado sin esperar a un exit que puede no llegar');
  first.emit('exit', null);
  assert.equal(task.prewarm.endedAt, endedAt, 'el exit tardío no reescribe nada');

  const done = move.startPrewarm(task, 'box', '/wt');
  done.emit('exit', 0);
  assert.equal(task.prewarm.ok, true);
  const broken = move.startPrewarm(task, 'box', '/wt');
  broken.emit('line', 'error[E0308]: mismatched types');
  broken.emit('exit', 101);
  assert.equal(task.prewarm.ok, false);
  assert.ok(task.log.some((l) => l.line === 'error[E0308]: mismatched types'), 'el final de la salida va al log');
});

test('descartar una mudanza fallida: sólo si no llegó; si llegó, sólo cabe reintentarla, y sin home no pierde sesiones', async () => {
  const task = await taskOnLocal('descartar');
  const chat = task.chats[0];

  let logged = task.log.length;
  await move.moveTask(task.issue, { to: 'box', prewarm: false });
  failTarget = true;
  let failed;
  try {
    failed = await settle(task, logged, 'local', 'box');
  } finally {
    failTarget = false;
  }
  assert.equal(failed?.step, 'build_target');
  assert.ok(chat.handoffDraft, 'el borrador del intento sigue ahí');
  assert.equal(move.discardMove(task.issue), true);
  assert.equal(task.moving, null);
  assert.equal(chat.handoffDraft, undefined);
  assert.equal(task.machine, 'local');
  assert.throws(() => move.discardMove(task.issue), (e) => e.status === 409);

  // Fails after arriving: box's home cannot be read, with a session to restore there.
  task.places.box = { worktreePath: null, sessions: { [chat.id]: 'sess-vieja-box' }, at: new Date().toISOString() };
  const homeOf = move.moveHooks.homeOf;
  move.moveHooks.homeOf = async (m) => (m.name === 'box' ? null : HOME[m.name]);
  let afterArrival;
  try {
    afterArrival = await moveAndWait(task, { to: 'box', prewarm: false });
  } finally {
    move.moveHooks.homeOf = homeOf;
  }
  assert.equal(afterArrival?.step, 'chats', JSON.stringify(afterArrival));
  assert.equal(task.machine, 'box');
  assert.equal(chat.sessionId, 'sess-descartar', 'nada se anuló sin saber');
  assert.throws(() => move.discardMove(task.issue), (e) => e.status === 409 && /Retry move/.test(e.message));
  // Nor a fresh move elsewhere: it would overwrite the half-done record.
  const halfDone = task.moving;
  await assert.rejects(move.moveTask(task.issue, { to: 'local', prewarm: false }),
    (e) => e.status === 409 && e.message === 'The previous move reached box but was left half-done: retry it'
      && e.blockers?.[0]?.code === 'moving_unfinished');
  assert.equal(task.moving, halfDone, 'el registro a medias sigue intacto');
  assert.equal(task.moving.step, 'chats');
  assert.equal(task.machine, 'box');

  fakeTranscript('box', task.worktreePath, 'sess-vieja-box');
  logged = task.log.length;
  await move.retryMove(task.issue);
  assert.equal(await settle(task, logged, 'local', 'box'), null);
  assert.equal(chat.sessionId, 'sess-vieja-box');
  assert.equal(chat.handoff.resumed, true);
  assert.equal(chat.handoff.text, 'handoff escrito en local');
});

test('bloqueos: chat trabajando, subagente, servidor con su taskId, rama en un worktree ajeno y tarea sin rama; todos a la vez', async () => {
  const task = await taskOnLocal('bloqueos');
  const chat = task.chats[0];
  const now = new Date().toISOString();
  chat.busy = true;
  store.pushChat(task, chat, {
    role: 'activity', ts: now, dropped: 0,
    items: [
      { id: 'a1', kind: 'agent', name: 'Agent', summary: 'Explore: rutas', status: 'running', startedAt: now, children: [] },
      { id: 'b1', kind: 'bash', name: 'Bash', background: true, status: 'running', command: 'node serve.js dist 18003', port: 18003, taskId: 'bg_1', startedAt: now },
    ],
  });
  git(['worktree', 'add', '-b', task.branch, path.join(ROOT, 'ajeno-box')], w.b.repo);

  const blockers = await move.moveBlockers(task, 'box');
  const codes = blockers.map((b) => b.code);
  assert.ok(codes.includes('busy'), codes.join());
  assert.ok(blockers.find((b) => b.code === 'background').items.some((i) => i.itemId === 'a1'));
  assert.deepEqual(blockers.find((b) => b.code === 'servers').items, [
    { chatId: chat.id, itemId: 'b1', name: 'node serve.js dist 18003', port: 18003, taskId: 'bg_1' },
  ]);
  assert.match(blockers.find((b) => b.code === 'target_foreign').text, /ajeno-box/);
  await assert.rejects(move.moveTask(task.issue, { to: 'box' }), (e) => e.status === 409 && e.blockers.length === blockers.length);

  await assert.rejects(move.moveTask(task.issue, { to: 'box', oldWorktree: 'tirar' }), (e) => e.status === 400);
  assert.ok((await move.moveBlockers(task, 'local')).some((b) => b.code === 'same_machine'));
  assert.ok((await move.moveBlockers(task, 'marte')).some((b) => b.code === 'unknown_machine'));

  const noBranch = store.addTask({ number: 7999, title: 'sin rama', labels: [], url: 'x', closed: false }, 'hfs');
  noBranch.machine = 'local';
  assert.ok((await move.moveBlockers(noBranch, 'box')).some((b) => b.code === 'no_branch'));
});

/** Until the chat's turn is over. */
async function idle(chat) {
  const limit = Date.now() + 30_000;
  await sleep(20);
  while (chat.busy) {
    if (Date.now() > limit) throw new Error('el turno no terminó');
    await sleep(20);
  }
}

const moving = (step, error = null) => ({
  from: 'local', to: 'box', step, error, saved: { state: 'started', prevState: null, error: null }, startedAt: new Date().toISOString(),
});

test('el turno de handoff no tiene herramientas: tools vacío llega a las opciones del SDK', async () => {
  const { sessionOptions } = await import('../src/claude.js');
  assert.deepEqual(sessionOptions({ cwd: '/x', model: 'm', tools: [] }).tools, [], 'una lista vacía no se pierde por falsa');
  assert.equal('tools' in sessionOptions({ cwd: '/x', model: 'm' }), false, 'sin decirlo, las de siempre');

  const task = await taskOnLocal('sin-herramientas');
  let seen;
  const original = move.moveHooks.runClaude;
  move.moveHooks.runClaude = async (options) => {
    seen = options;
    return { ok: true, sessionId: options.resume, resultText: 'nota', toolCounts: {} };
  };
  try {
    assert.equal(await move.handoffFor(task, task.chats[0], { machine: machines().local, cwd: task.worktreePath }), 'nota');
  } finally {
    move.moveHooks.runClaude = original;
  }
  assert.deepEqual(seen.tools, []);
  assert.equal(seen.permissionMode, 'plan');
});

test('a mitad de mudanza un mensaje se contesta sin abrir turno y lo demás se rechaza con 409; tras un fallo ya llegada, también', async () => {
  const { startStack } = await import('../src/stack.js');
  const task = await taskOnLocal('mensaje');
  const chat = task.chats[0];
  const live = pipeline.liveEntryOf(task, chat);
  let sent = 0;
  live.session.send = async () => {
    sent += 1;
    return { ok: true, sessionId: chat.sessionId, resultText: 'vale', toolCounts: {} };
  };

  task.moving = moving('handoff');
  let before = chat.messages.length;
  pipeline.sendChat(task.issue, chat.id, 'hola');
  await idle(chat);
  assert.equal(sent, 0, 'ningún turno');
  assert.deepEqual(chat.messages.slice(before).map((m) => m.role), ['user', 'assistant']);
  assert.match(chat.messages.at(-1).text, /is moving to another machine/);
  assert.deepEqual(chat.notes ?? [], [], 'y no se deja en cola para una sesión que se queda atrás');

  const refused = (e) => e.status === 409;
  assert.throws(() => pipeline.createChat(task.issue), refused);
  assert.throws(() => startStack(task.issue), refused);
  assert.throws(() => pipeline.setChatPlanMode(task.issue, chat.id, true), refused);
  await assert.rejects(pipeline.pushNow(task.issue), refused);
  await assert.rejects(pipeline.ensureWorktree(task.issue), refused);
  await assert.rejects(pipeline.runBrowserQa(task.issue), refused);
  await assert.rejects(pipeline.bringMain(task), refused);
  await assert.rejects(pipeline.deleteWorktree(task.issue), refused);
  await assert.rejects(pipeline.generateDemoSteps(task), refused);
  assert.ok(!task.demoBusy, 'se rechaza antes de marcar nada');
  await assert.rejects(pipeline.interruptChat(task.issue, chat.id), (e) => e.status !== 409 && /no turn in progress/.test(e.message),
    'Detener nunca se bloquea por la mudanza');

  // Failed before arriving: the task is whole where it was, and usable.
  task.moving = moving('build_target', 'box caída');
  assert.doesNotThrow(() => pipeline.assertNotMoving(task));
  // Failed after the chats were rewired: usable too.
  task.moving = moving('prewarm', 'raro');
  assert.doesNotThrow(() => pipeline.assertNotMoving(task));
  // Failed at `chats`: the chats may still hold the other machine's sessions.
  task.moving = moving('chats', 'sin home');
  assert.throws(() => pipeline.assertNotMoving(task), (e) => e.status === 409 && /retry it/.test(e.message));
  await assert.rejects(move.removePlace(task, 'local'), refused);
  // Retry would start a pipeline that fails on the move and overwrites the error.
  Object.assign(task, { state: 'error', prevState: 'testing', error: 'lo de antes' });
  assert.throws(() => pipeline.retry(task.issue), refused);
  assert.deepEqual([task.state, task.prevState, task.error], ['error', 'testing', 'lo de antes']);
  assert.equal(pipeline.isPipelineRunning(task.issue), false);
  Object.assign(task, { state: 'started', prevState: null, error: null });
  before = chat.messages.length;
  pipeline.sendChat(task.issue, chat.id, 'sigue');
  await idle(chat);
  assert.equal(sent, 0);
  assert.match(chat.messages.at(-1).text, /retry it/);

  task.moving = null;
  pipeline.sendChat(task.issue, chat.id, 'ahora sí');
  await idle(chat);
  assert.equal(sent, 1, 'sin mudanza, el turno corre');
});

test('una sesión sin transcript en esta máquina se suelta: el mensaje se reenvía una sola vez a una sesión nueva, y ese turno consume el handoff', async () => {
  const { ChatSession } = await import('../src/session.js');
  const task = await taskOnLocal('autocura');
  const chat = task.chats[0];
  chat.handoff = { from: 'box', to: 'local', at: new Date().toISOString(), text: 'lo que dejó box', brief: null, resumed: false, wip: false };
  const trees = [];
  const onChat = (issue, chatId, message) => { if (issue === task.issue && message.role === 'activity') trees.push(message); };
  store.on('chat', onChat);
  // On the prototype: the resend runs on a live entry created inside the turn.
  const sends = [];
  const originalSend = ChatSession.prototype.send;
  ChatSession.prototype.send = async function send(prompt) {
    sends.push({ prompt, session: this });
    return sends.length === 1
      ? { ok: false, sessionId: 'x', resultText: '', toolCounts: {}, error: 'Claude Code process exited with code 1. stderr: No conversation found with session ID: x' }
      : { ok: true, sessionId: 'nueva', resultText: 'hola', toolCounts: {} };
  };
  try {
    pipeline.sendChat(task.issue, chat.id, 'mensaje que no se pierde');
    const limit = Date.now() + 30_000;
    while (sends.length < 2 && Date.now() < limit) await sleep(20);
    await idle(chat);
    await sleep(300);
    assert.equal(sends.length, 2, 'un reenvío, y ninguno más');
    for (const { prompt } of sends) {
      assert.match(prompt, /mensaje que no se pierde/);
      assert.match(prompt, /\[Handoff from the board:/);
      assert.match(prompt, /lo que dejó box/);
      assert.match(prompt, /8080 y 8090/, 'la regla de procesos de local');
    }
    assert.notEqual(sends[1].session, sends[0].session, 'en un proceso nuevo, sin el id viejo');
    assert.equal(chat.sessionId, 'nueva');
    assert.equal(chat.forkPending, false);
    assert.equal(chat.handoff, null, 'consumido por el turno que salió bien');
    assert.ok(chat.messages.some((m) => m.role === 'assistant' && /resent to a new session/.test(m.text)));
    assert.equal(chat.messages.filter((m) => m.role === 'user').length, 1, 'la burbuja del usuario no se duplica');
    assert.equal(trees[0]?.machine, 'local', 'el árbol del turno lleva su máquina');
  } finally {
    ChatSession.prototype.send = originalSend;
    store.off('chat', onChat);
  }
});

test('borrar el worktree conserva las sesiones en places, y crearlo otra vez reanuda las que siguen teniendo transcript', async () => {
  const { addChatTo } = await import('../src/chats.js');
  const task = await taskOnLocal('recrear');
  const chat = task.chats[0];
  const other = addChatTo(task, { title: 'otro' });
  other.sessionId = 'sin-transcript';
  const wt = task.worktreePath;

  await pipeline.deleteWorktree(task.issue);
  assert.equal(existsSync(wt), false);
  assert.equal(task.worktreePath, null);
  assert.equal(chat.sessionId, 'sess-recrear', 'ya no se anula');
  assert.equal(task.places.local.worktreePath, null);
  assert.equal(task.places.local.sessions[chat.id], 'sess-recrear');
  assert.equal(task.places.local.sessions[other.id], 'sin-transcript');
  await assert.rejects(pipeline.setTaskMachine(task.issue, 'box'), (e) => e.status === 409 && /Move to/.test(e.message),
    'con conversaciones apuntadas la máquina no se cambia a mano');

  // As a board from before left them: the chats forgot their sessions.
  chat.sessionId = null;
  other.sessionId = null;
  assert.equal(await pipeline.ensureWorktree(task.issue), wt);
  assert.equal(task.places.local.worktreePath, wt);
  assert.equal(chat.sessionId, 'sess-recrear', 'la conversación de antes vuelve');
  assert.equal(other.sessionId, null, 'la que ya no tiene transcript, no');
  assert.equal(task.state, 'started');
});

test('un plan que llegó de otra máquina se replanifica aquí partiendo de él, también con commits en la rama; sin plan nuevo, se conserva para Reintentar', async () => {
  const task = await taskOnLocal('replan', { sessionId: null });
  task.approvePlan = 'off';
  task.workPlan = {
    id: 'fix-viejo', text: 'PLAN VIEJO: t1 toca src/lib.rs', status: 'approved', selected: ['t1'], forkFrom: null,
    tasks: [{ id: 't1', what: 'tocar lib', files: ['src/lib.rs'], dependsOn: [], status: 'pending', sessionId: null }],
    waves: [['t1']], replan: { from: 'box', at: new Date().toISOString() },
  };
  const issue = { number: task.issue, title: task.title, body: 'cuerpo' };
  const old = task.workPlan;
  const calls = [];
  const original = pipeline.fixHooks.runClaude;
  pipeline.fixHooks.runClaude = async (options) => {
    // Told apart by what they are, not by their order: the planning call is the
    // only one of the phase with a turn limit.
    const kind = options.maxTurns === 30 ? 'plan' : 'fix';
    calls.push({ kind, prompt: options.prompt, workPlan: task.workPlan });
    // The planning call leaves no usable plan; the fix session finds nothing to add.
    return kind === 'plan'
      ? { ok: false, sessionId: null, resultText: '', toolCounts: {}, error: 'sin plan' }
      : { ok: true, sessionId: null, resultText: 'ya estaba', toolCounts: {} };
  };
  const replanFailed = (e) => /Could not replan/.test(e.message) && /Retry/.test(e.message);
  try {
    await assert.rejects(pipeline.fixPhaseOf(task, issue, 'CONTEXTO DE LA RAMA', { continuing: true }), replanFailed);
    assert.deepEqual(calls.map((c) => c.kind), ['plan'], 'planifica aunque la rama tenga commits, y sin plan no sigue en una sola sesión');
    assert.match(calls[0].prompt, /PLAN VIEJO/);
    assert.match(calls[0].prompt, /CONTEXTO DE LA RAMA/);
    assert.match(calls[0].prompt, /en box/);
    assert.equal(calls[0].workPlan, old, 'el registro viejo sigue ahí mientras se planifica');
    assert.equal(task.workPlan, old, 'y se queda, con su marca');
    assert.ok(task.workPlan.replan);
    assert.ok(task.log.some((l) => /replanning on local/.test(l.line)));

    // Retry plans from it again.
    calls.length = 0;
    await assert.rejects(pipeline.fixPhaseOf(task, issue, 'CONTEXTO DE LA RAMA', { continuing: true }), replanFailed);
    assert.deepEqual(calls.map((c) => c.kind), ['plan']);
    assert.match(calls[0].prompt, /PLAN VIEJO/);

    // Without a moved plan, a continuation goes straight to one session.
    task.workPlan = null;
    calls.length = 0;
    await pipeline.fixPhaseOf(task, issue, 'CONTEXTO DE LA RAMA', { continuing: true });
    assert.deepEqual(calls.map((c) => c.kind), ['fix']);
  } finally {
    pipeline.fixHooks.runClaude = original;
  }
});
