// La retención de cuota contra el módulo real del pipeline: qué se para, qué
// aparca, qué se rechaza, y cómo se reanuda.
//
// Ninguna prueba duerme. La retención se abre siempre con una hora futura y,
// cuando toca reabrir, se le mueve el `until` al pasado y se llama a
// `evaluateQuota()` a mano: es exactamente lo que hace el reloj de 30 s.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'hfsmon-quotahold-'));
process.env.HFSMON_DATA_DIR = dataDir;

let pipeline;
let quota;
let store;
let settings;
const runs = [];   // { task, resumeFrom, resolve, reject }

before(async () => {
  pipeline = await import('../src/pipeline.js');
  quota = await import('../src/quota.js');
  ({ store } = await import('../src/store.js'));
  ({ settings } = await import('../src/settings.js'));
  settings.update({ autoStart: true, maxActiveTasks: 3 });
  pipeline.pipelineHooks.run = (task, resumeFrom) => new Promise((resolve, reject) => {
    runs.push({ task, resumeFrom, resolve, reject });
  });
});

after(() => {
  quota.resetQuotaForTests();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  quota.resetQuotaForTests();
  for (const run of runs.splice(0)) run.resolve();
  // Settling a run calls `tick()`; let that happen here, and then throw away
  // anything it started, so no test sees the previous one's leftovers.
  await new Promise((r) => { setImmediate(r); });
  await new Promise((r) => { setImmediate(r); });
  for (const run of runs.splice(0)) run.resolve();
});

const settled = () => new Promise((r) => { setImmediate(r); });
const drain = async () => { await settled(); await settled(); await settled(); };

let n = 9000;
/**
 * A task the board will not pick up on its own. Auto-start is on in this file
 * — the first test needs it — so a task left `assigned` and classified would
 * be relaunched by any later `tick()` and land in somebody else's count.
 */
function freshTask(fields = {}) {
  n += 1;
  const task = store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
  return Object.assign(task, { classified: false, mode: 'manual', modeDecidedByUser: true, ...fields });
}

/** Abre la retención con una hora futura, como haría un rechazo del SDK. */
const hold = (minutes = 90) =>
  quota.noteQuotaHit({ status: 'rejected', via: 'sdk', resetsAt: Date.now() + minutes * 60_000, rateLimitType: 'five_hour' });

/** Mueve la hora al pasado y deja que el despertador decida, como el reloj. */
function reopen() {
  const h = quota.quotaHold();
  h.until = Date.now() - 1000;
  return quota.evaluateQuota();
}

const runOf = (task) => runs.find((r) => r.task === task) ?? null;

/** Cierra las ejecuciones abiertas para que `running` no ensucie la siguiente prueba. */
async function finishAll() {
  for (const run of runs.splice(0)) run.resolve();
  await drain();
}

// ---------------------------------------------------------------------------
// La parada

test('con la cuota agotada `tick()` no arranca nada, y al soltarla sí', async () => {
  const task = freshTask({ state: 'assigned', mode: 'auto', classified: true });
  hold();
  pipeline.tick();
  await drain();
  assert.equal(runOf(task), null, 'ni una sesión contra la ventana cerrada');

  quota.resetQuotaForTests();
  pipeline.tick();
  await drain();
  assert.ok(runOf(task), 'en cuanto la retención se va, la cola corre');
  task.classified = false;   // que no la vuelva a arrancar el `tick()` de nadie
  await finishAll();
});

test('«Iniciar» aparca en vez de rechazar, y la tarjeta dice la hora', async () => {
  const task = freshTask({ state: 'assigned' });
  hold();
  const result = pipeline.startTask(task.issue);
  await drain();
  assert.equal(result.started, false);
  assert.equal(result.parked, true);
  assert.equal(runOf(task), null);
  assert.equal(task.state, 'assigned', 'no llega a `error` nunca');
  assert.ok(task.quotaPark, 'lleva el marcador');
  assert.equal(task.quotaPark.resumeFrom, 'assigned');
  assert.match(task.log.at(-1).line, /will start on its own/);
  assert.equal(quota.quotaState().parked, 1);
});

test('«Reintentar» también aparca, desde la fase en la que murió', async () => {
  const task = freshTask({ state: 'error', phase: 'testing', error: 'los tests fallaron' });
  hold();
  assert.equal(pipeline.retry(task.issue), true, 'el clic se acepta');
  await drain();
  assert.equal(runOf(task), null);
  assert.notEqual(task.state, 'error');
  assert.equal(task.quotaPark.resumeFrom, 'testing');
  assert.equal(task.quotaPark.previousError, 'los tests fallaron', 'lo que falló antes se conserva');
});

test('«Publicar PR» conserva el título y aparca en el PR', async () => {
  const task = freshTask({
    state: 'error', phase: 'pr', branch: 'fix/9-x',
    prPark: { proposal: 'fix: algo', problems: ['demasiado largo'], at: new Date().toISOString() },
  });
  hold();
  const result = await pipeline.publishPr(task.issue, 'fix: un titulo correcto');
  await drain();
  assert.equal(result.parked, true);
  assert.equal(task.prTitle, 'fix: un titulo correcto');
  assert.equal(runOf(task), null);
  assert.equal(task.quotaPark.resumeFrom, 'pr');
});

test('aprobar un plan sin pipeline aparcado guarda la selección y aparca en el fix', async () => {
  const task = freshTask({ state: 'plan_ready' });
  task.workPlan = {
    id: 'p1', status: 'pending', version: 1, text: '# plan', messageId: null, selected: [], waves: [['t1']],
    tasks: [{ id: 't1', what: 'uno', files: [], dependsOn: [], check: null, status: 'pending', attempts: 0, extraRetries: 0 }],
  };
  hold();
  const result = pipeline.decideTaskPlan(task.issue, { decision: 'approve', selected: ['t1'] });
  await drain();
  assert.equal(result.parked, true);
  assert.deepEqual(task.workPlan.selected, ['t1'], 'la aprobación queda hecha');
  assert.equal(runOf(task), null);
  assert.equal(task.quotaPark.resumeFrom, 'fixing');
});

test('los botones que quemarían una sesión en balde devuelven 409 con la hora', async () => {
  const task = freshTask({ state: 'pr_draft', branch: 'fix/9-y', prNumber: 5 });
  task.changeRequests = [{ reviewId: 1, author: 'x', status: 'fixed', comments: [], draftReplies: [] }];
  hold();
  const is409 = (e) => e.status === 409 && /Quota exhausted/.test(e.message);
  await assert.rejects(() => pipeline.runBrowserQa(task.issue), is409);
  await assert.rejects(() => pipeline.generateDemoSteps(task), is409);
  await assert.rejects(() => pipeline.draftReviewReplies(task.issue, 1), is409);
  assert.ok(!task.quotaPark, 'un rechazo no aparca nada');
});

test('el chat no envía y lo explica en el panel, sin encolar el mensaje', async () => {
  const task = freshTask({ state: 'started', branch: 'fix/9-z' });
  const chat = task.chats[0];
  hold();
  pipeline.sendChat(task.issue, chat.id, 'hola, ¿qué tal va?');
  await drain();
  const last = chat.messages.at(-1);
  assert.equal(last.role, 'assistant');
  assert.match(last.text, /Quota exhausted/);
  assert.equal(chat.busy, false);
  assert.deepEqual(chat.notes ?? [], [], 'no se guarda para reenviarlo solo horas después');
});

test('un change request se queda `pending`, que es lo que `tick()` recoge al reabrir', async () => {
  const task = freshTask({ state: 'waiting_approval', prNumber: 7 });
  task.changeRequests = [{ reviewId: 2, author: 'r', status: 'pending', comments: [], draftReplies: [] }];
  task.activeChangeRequest = 2;
  hold();
  assert.equal(pipeline.startChangeRequest(task.issue, { force: true }), false);
  assert.equal(task.changeRequests[0].status, 'pending');
  assert.match(task.log.at(-1).line, /stays pending/);
});

test('una pregunta viva no sobrevive al aparcamiento; un plan esperando sí', async () => {
  const asking = freshTask({ state: 'fixing', phase: 'fixing', branch: 'fix/9-q' });
  asking.pending = { id: 'x', kind: 'question', source: 'claude', phase: 'fix', askedAt: new Date().toISOString(), questions: [], preview: null };
  hold();
  pipeline.parkTaskForQuotaOf(asking, 'fixing');
  assert.equal(asking.pending, null, 'nadie puede contestar a una sesión que ya no existe');

  const planning = freshTask({ state: 'plan_ready', branch: 'fix/9-p' });
  planning.pending = { id: 'p', kind: 'plan', source: 'board', phase: 'plan', askedAt: new Date().toISOString(), questions: null, preview: null };
  pipeline.parkTaskForQuotaOf(planning, 'fixing');
  assert.ok(planning.pending, 'un plan espera lo que haga falta');
});

// ---------------------------------------------------------------------------
// El despertador y la reanudación

test('`tick()` nunca reabre: el ciclo de vida es del temporizador', async () => {
  const task = freshTask({ state: 'started', branch: 'fix/9-a', phase: 'fixing' });
  hold();
  pipeline.parkTaskForQuotaOf(task, 'fixing');
  quota.quotaHold().until = Date.now() - 1000;

  for (let i = 0; i < 10; i += 1) pipeline.tick();
  await drain();
  assert.equal(quota.quotaHold().state, 'held', 'diez ticks y sigue retenido');
  assert.equal(runOf(task), null);

  // Y el despertador, dos veces seguidas, arranca exactamente una.
  quota.evaluateQuota();
  quota.evaluateQuota();
  await drain();
  assert.equal(runs.filter((r) => r.task === task).length, 1);
  assert.equal(quota.quotaHold().state, 'draining');
  await finishAll();
});

test('la canaria no se aparca a sí misma: las fases ven la retención abierta solo para ella', async () => {
  const a = freshTask({ state: 'started', branch: 'fix/9-e', phase: 'fixing' });
  const b = freshTask({ state: 'started', branch: 'fix/9-f', phase: 'testing' });
  hold();
  for (const t of [a, b]) pipeline.parkTaskForQuotaOf(t, t.phase);
  reopen();
  await drain();
  assert.equal(quota.quotaHold().state, 'draining');
  assert.equal(quota.quotaHoldsNewWork(a), false, 'la canaria pasa: es la que prueba la ventana');
  assert.equal(quota.quotaHoldsNewWork(b), true, 'las demás siguen paradas');
  assert.equal(quota.quotaHoldsNewWork(), true, 'y el resto del tablero también');
  quota.noteQuotaAlive();
  await drain();
  await finishAll();
});

test('la canaria: reabrir arranca una sola tarea y solo una señal de vida drena el resto', async () => {
  const a = freshTask({ state: 'started', branch: 'fix/9-b', phase: 'fixing' });
  const b = freshTask({ state: 'started', branch: 'fix/9-c', phase: 'testing' });
  const c = freshTask({ state: 'started', branch: 'fix/9-d', phase: 'pr' });
  hold();
  for (const t of [a, b, c]) pipeline.parkTaskForQuotaOf(t, t.phase);
  assert.equal(quota.quotaState().parked, 3);

  reopen();
  await drain();
  assert.equal(runs.length, 1, 'una sola tarea prueba la ventana');
  assert.equal(runOf(a).resumeFrom, 'fixing');
  assert.equal(quota.quotaHold().state, 'draining');

  quota.noteQuotaAlive();
  await drain();
  assert.equal(runs.length, 3, 'con señal de vida sale el resto');
  assert.equal(runOf(b).resumeFrom, 'testing');
  assert.equal(runOf(c).resumeFrom, 'pr');
  assert.equal(quota.quotaHold(), null, 'sin nada aparcado, la retención desaparece');
  await finishAll();
});

test('un golpe fresco durante el drenaje sube un peldaño en vez de abrir otra retención', async () => {
  const task = freshTask({ state: 'started', branch: 'fix/9-e', phase: 'fixing' });
  const first = hold();
  pipeline.parkTaskForQuotaOf(task, 'fixing');
  reopen();
  await drain();
  assert.equal(quota.quotaHold().state, 'draining');

  const second = quota.noteQuotaHit({ status: 'rejected', via: 'error' });
  assert.equal(second.id, first.id, 'la misma retención, no una segunda');
  assert.equal(second.attempt, 2, 'sube un peldaño');
  assert.equal(second.state, 'held');
  const minutes = (second.until - Date.now()) / 60_000;
  assert.ok(minutes > 39 && minutes <= 40.1, `peldaño 2 = 40 min, no ${minutes}`);
  await finishAll();
});

test('con el límite en 1 y tres aparcadas, arranca una y las otras esperan su turno', async () => {
  settings.update({ maxActiveTasks: 1 });
  const tasks = [1, 2, 3].map((i) => freshTask({ state: 'started', branch: `fix/9-f${i}`, phase: 'fixing' }));
  hold();
  for (const t of tasks) pipeline.parkTaskForQuotaOf(t, 'fixing');
  reopen();
  await drain();
  quota.noteQuotaAlive();
  await drain();
  assert.equal(runs.length, 1, 'el límite del tablero se respeta al reanudar');
  assert.ok(tasks[1].quotaPark && tasks[2].quotaPark, 'las otras conservan su marcador');

  // Al liberarse el hueco, el mismo reloj las saca.
  await finishAll();
  quota.evaluateQuota();
  await drain();
  assert.equal(runs.length, 1);
  settings.update({ maxActiveTasks: 3 });
  await finishAll();
});

test('una tarea que ya estaba en `error` antes del corte no se toca', async () => {
  const broken = freshTask({ state: 'error', phase: 'fixing', error: 'la rama no compila' });
  const parked = freshTask({ state: 'started', branch: 'fix/9-g', phase: 'fixing' });
  hold();
  pipeline.parkTaskForQuotaOf(parked, 'fixing');
  reopen();
  await drain();
  quota.noteQuotaAlive();
  await drain();
  assert.equal(runOf(broken), null, 'no tiene `quotaPark` ni está en la lista: es estructural');
  assert.equal(broken.state, 'error');
  assert.equal(broken.error, 'la rama no compila');
  assert.ok(runOf(parked));
  await finishAll();
});

test('`wasUserRun` sobrevive: una tarea manual vuelve siendo manual y con su pasada', async () => {
  const task = freshTask({ state: 'started', branch: 'fix/9-h', mode: 'manual', modeDecidedByUser: true });
  hold();
  const result = pipeline.startTask(task.issue);
  await drain();
  assert.equal(result.parked, true);
  assert.equal(task.quotaPark.wasUserRun, true);

  reopen();
  await drain();
  assert.ok(runOf(task), 'se reanuda aunque sea manual: la pasada la pediste tú');
  assert.equal(task.mode, 'manual', 'y sigue siendo manual: no se convierte en automática');
  assert.equal(pipeline.isUserRun(task.issue), true, 'la pasada se restablece antes de relanzar');
  await finishAll();
});

test('el arranque en frío: un `until` pasado libera al momento, uno futuro vuelve a armar', async () => {
  const task = freshTask({ state: 'started', branch: 'fix/9-i', phase: 'fixing' });
  const write = (until) => writeFileSync(path.join(dataDir, 'quota.json'), JSON.stringify({
    hold: {
      id: 'q-boot', state: 'held', since: new Date().toISOString(), at: new Date().toISOString(),
      until, kind: 'five_hour', certainty: 'sdk', attempt: 1, via: 'sdk', parked: [task.issue], releasedAt: null,
    },
    warning: null,
  }));

  // Futuro: sigue retenido y no arranca nada.
  quota.resetQuotaForTests();
  task.quotaPark = { holdId: 'q-boot', since: new Date().toISOString(), resumeFrom: 'fixing', wasUserRun: false, previousError: null };
  write(Date.now() + 45 * 60_000);
  quota.forgetQuotaCache();
  quota.resumeQuotaOnBoot();
  await drain();
  assert.equal(quota.quotaHold().state, 'held');
  assert.equal(runOf(task), null);

  // Pasado: se reanuda al momento.
  quota.resetQuotaForTests();
  task.quotaPark = { holdId: 'q-boot', since: new Date().toISOString(), resumeFrom: 'fixing', wasUserRun: false, previousError: null };
  write(Date.now() - 60_000);
  quota.forgetQuotaCache();
  quota.resumeQuotaOnBoot();
  await drain();
  assert.ok(runOf(task), 'la ventana ya estaba abierta cuando el tablero volvió');
  await finishAll();
});

test('una retención a medio drenar que pilla un reinicio vuelve a pasar por la canaria', async () => {
  const a = freshTask({ state: 'started', branch: 'fix/9-j', phase: 'fixing' });
  const b = freshTask({ state: 'started', branch: 'fix/9-k', phase: 'fixing' });
  quota.resetQuotaForTests();
  for (const t of [a, b]) {
    t.quotaPark = { holdId: 'q-drain', since: new Date().toISOString(), resumeFrom: 'fixing', wasUserRun: false, previousError: null };
  }
  writeFileSync(path.join(dataDir, 'quota.json'), JSON.stringify({
    hold: {
      id: 'q-drain', state: 'draining', since: new Date().toISOString(), at: new Date().toISOString(),
      until: Date.now() - 60_000, kind: null, certainty: 'blind', attempt: 1, via: null, parked: [a.issue, b.issue], releasedAt: null,
    },
    warning: null,
  }));
  quota.forgetQuotaCache();
  quota.resumeQuotaOnBoot();
  await drain();
  assert.equal(runs.length, 1, 'no se sueltan las dos de golpe tras el reinicio');
  await finishAll();
});

test('una canaria que nunca da señales no bloquea el tablero para siempre', async () => {
  const a = freshTask({ state: 'started', branch: 'fix/9-m', phase: 'fixing' });
  const b = freshTask({ state: 'started', branch: 'fix/9-n', phase: 'fixing' });
  hold();
  for (const t of [a, b]) pipeline.parkTaskForQuotaOf(t, 'fixing');
  reopen();
  await drain();
  assert.equal(runs.length, 1);
  assert.equal(quota.quotaHold().state, 'draining', 'y sin señal de vida se quedaría aquí');

  // `draining` retiene el tablero entero, así que no puede ser un estado en el
  // que nada se atasque: pasado el plazo se da la ventana por abierta.
  quota.quotaHold().drainingAt = new Date(Date.now() - quota.DRAIN_MAX_MS - 1000).toISOString();
  quota.evaluateQuota();
  await drain();
  assert.equal(runs.length, 2, 'el resto sale igual');
  assert.equal(quota.quotaHoldsNewWork(), false, 'y el tablero deja de estar retenido');
  await finishAll();
});

test('«Dar por hecho el fix» aparca en los tests, con lo que el clic ya decidió', async () => {
  // `acceptFix` habla con la máquina (worktree, commits) antes de llegar al
  // aparcamiento, así que lo que se prueba aquí es lo que hace después: la
  // decisión ya escrita, y la reanudación apuntando a los tests. Y el orden
  // importa — pone el modo en 'auto' ANTES de mirar la cuota, igual que sin
  // retención, así que una manual aceptada vuelve automática y sin `wasUserRun`.
  const task = freshTask({ state: 'started', branch: 'fix/9-af', mode: 'manual' });
  const HEAD = 'cafebabe0011223344';
  task.fixedAt = HEAD;
  pipeline.setMode(task.issue, 'auto');   // lo que hace `acceptFix` justo antes
  hold();
  pipeline.parkTaskForQuotaOf(task, 'testing');

  assert.equal(task.quotaPark.resumeFrom, 'testing', 'no se repite el fix que acabas de dar por hecho');
  assert.equal(task.quotaPark.wasUserRun, false, 'el clic la hizo automática: no hace falta una pasada tuya');
  assert.equal(task.mode, 'auto');
  assert.equal(task.fixedAt, HEAD, 'la decisión sigue escrita');
  assert.notEqual(task.state, 'error');
  assert.equal(runOf(task), null);
});
test('un plan detenido por una retención ajena tampoco deja la tarea en `error`', async () => {
  // El caso torcido: la retención la abrió OTRA tarea, así que la sesión de
  // este plan no murió por cuota — falló su check, se agotaron los reintentos,
  // y la pregunta del tablero se contestó con «detener». Sin la guarda, el
  // «El plan se quedó en stopped» acababa en `error` y en un clic humano.
  const { stopPlan } = await import('../src/planexec.js');
  const plan = { status: 'running', tasks: [{ id: 't1', status: 'asking', attempts: 4 }], quotaStopped: false };
  hold();
  stopPlan(plan, { onChange: () => {}, log: () => {}, interrupt: () => {} });
  assert.equal(plan.status, 'stopped');
  assert.equal(plan.quotaStopped, false, 'no lo paró su propia sesión');
  // Lo que lee `runFixPlan`: o la bandera, o la retención puesta.
  assert.equal(plan.quotaStopped || quota.quotaHoldsNewWork(), true);
});

test('una tarea borrada del tablero no mantiene viva la retención para siempre', async () => {
  const a = freshTask({ state: 'started', branch: 'fix/9-pr1', phase: 'fixing' });
  const ghost = freshTask({ state: 'started', branch: 'fix/9-pr2', phase: 'fixing' });
  hold();
  for (const t of [a, ghost]) pipeline.parkTaskForQuotaOf(t, 'fixing');
  delete store.tasks[store.keyFor(ghost.issue, ghost.project)];      // como la borra «Eliminar tarea»

  reopen();
  await drain();
  quota.noteQuotaAlive();
  await drain();
  assert.equal(runs.length, 1, 'solo la que existe');
  assert.equal(quota.quotaHold(), null, 'y la retención se cierra en vez de reintentar al fantasma cada 30 s');
  await finishAll();
});

test('una espera larga no llena el log: solo se dice lo que cambia', async () => {
  settings.update({ maxActiveTasks: 1 });
  const a = freshTask({ state: 'started', branch: 'fix/9-q1', phase: 'fixing' });
  const b = freshTask({ state: 'started', branch: 'fix/9-q2', phase: 'fixing' });
  hold();
  for (const t of [a, b] ) pipeline.parkTaskForQuotaOf(t, 'fixing');
  reopen();
  await drain();
  quota.noteQuotaAlive();
  await drain();

  const linesOf = (t) => t.log.filter((l) => l.phase === 'cuota').length;
  const before = linesOf(b);
  // El reloj de 30 s vuelve a pasar veinte veces mientras `a` sigue ocupando
  // el hueco. Cada línea es un `store.persist()` y un broadcast.
  for (let i = 0; i < 20; i += 1) quota.evaluateQuota();
  await drain();
  assert.equal(linesOf(b), before, 'veinte vueltas del reloj, ni una línea nueva');
  settings.update({ maxActiveTasks: 3 });
  await finishAll();
});

test('mientras quedan tareas haciendo cola, el chip tiene algo que dibujar', async () => {
  settings.update({ maxActiveTasks: 1 });
  const a = freshTask({ state: 'started', branch: 'fix/9-c1', phase: 'fixing' });
  const b = freshTask({ state: 'started', branch: 'fix/9-c2', phase: 'fixing' });
  hold();
  for (const t of [a, b]) pipeline.parkTaskForQuotaOf(t, 'fixing');
  assert.equal(quota.quotaState().state, 'held');
  reopen();
  await drain();
  quota.noteQuotaAlive();
  await drain();

  const state = quota.quotaState();
  assert.equal(state.parked, 1, 'una sigue esperando hueco');
  assert.notEqual(state, null);
  assert.equal(state.state, 'draining', 'ni «held» —la ventana está abierta— ni «released», que no pintaría nada');
  settings.update({ maxActiveTasks: 3 });
  await finishAll();
  quota.evaluateQuota();
  await drain();
  await finishAll();
  assert.equal(quota.quotaState(), null, 'y cuando no queda nadie, se apaga');
});

// ---------------------------------------------------------------------------
// Una retención sin nada aparcado

test('una retención que no aparcó nada se suelta al reabrir, en vez de bloquear el tablero para siempre', async () => {
  // El caso más probable de todos: el muro se topa en un chat, que pone una
  // burbuja y no aparca ninguna tarea.
  hold();
  assert.equal(quota.quotaState().parked, 0);
  assert.equal(quota.quotaHoldsNewWork(), true, 'mientras la ventana está cerrada, el tablero para');

  reopen();
  await drain();
  // Sin el arreglo: `resume` devuelve 0, la canaria vuelve a `held` con
  // `until = ahora + 30 s`, y así para siempre — `DRAIN_MAX_MS` no llega a
  // saltar porque el estado sale de `draining` en el mismo microtask, y
  // `noteQuotaAlive` no puede llegar porque todo lo que abriría una sesión lo
  // bloquea esta misma retención.
  assert.equal(quota.quotaHoldsNewWork(), false, 'no hay a quién esperar: la retención se acabó');
  assert.equal(quota.quotaHold(), null);

  // Y no revive: diez vueltas más del reloj y sigue libre.
  for (let i = 0; i < 10; i += 1) quota.evaluateQuota();
  await drain();
  assert.equal(quota.quotaHoldsNewWork(), false);
});

test('el camino real: el muro en un chat no deja el tablero parado', async () => {
  const task = freshTask({ state: 'started', branch: 'fix/9-ch' });
  const chat = task.chats[0];
  hold();
  pipeline.sendChat(task.issue, chat.id, '¿cómo va?');
  await drain();
  assert.match(chat.messages.at(-1).text, /Quota exhausted/);
  assert.equal(task.quotaPark, null, 'un chat no aparca ninguna tarea: por eso la lista queda vacía');

  reopen();
  await drain();
  assert.equal(quota.quotaHoldsNewWork(), false, 'y aun así el tablero vuelve solo');

  // Y lo que estaba en cola arranca otra vez.
  const queued = freshTask({ state: 'assigned', mode: 'auto', classified: true });
  pipeline.tick();
  await drain();
  assert.ok(runOf(queued));
  queued.classified = false;
  await finishAll();
});

test('el arranque en frío con una retención vacía y la hora pasada tampoco se atasca', async () => {
  quota.resetQuotaForTests();
  writeFileSync(path.join(dataDir, 'quota.json'), JSON.stringify({
    hold: {
      id: 'q-vacia', state: 'held', since: new Date().toISOString(), at: new Date().toISOString(),
      until: Date.now() - 60_000, kind: 'five_hour', certainty: 'sdk', attempt: 1, via: 'sdk', parked: [], releasedAt: null,
    },
    warning: null,
  }));
  quota.forgetQuotaCache();
  quota.resumeQuotaOnBoot();
  await drain();
  // Antes, el reinicio volvía a cargarla y volvía a entrar en el bucle: solo se
  // salía borrando `server/data/quota.json` a mano.
  assert.equal(quota.quotaHoldsNewWork(), false, 'el reinicio no hereda un bloqueo perpetuo');
  assert.equal(quota.quotaHold(), null);
});

test('una retención vacía pero con la hora todavía por venir sigue parando el tablero', async () => {
  // El otro lado del arreglo: vacía y con la ventana aún cerrada es lo normal
  // —el muro en un chat— y ahí el tablero TIENE que estar parado.
  hold(45);
  assert.equal(quota.quotaState().parked, 0);
  quota.evaluateQuota();
  await drain();
  assert.equal(quota.quotaHoldsNewWork(), true);
  assert.equal(quota.quotaHold().state, 'held');
});
