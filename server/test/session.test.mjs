import './isolate.mjs';   // primero: aisla el directorio de datos
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ChatSession } from '../src/session.js';

/**
 * A stand-in for the SDK's `query`: reads the prompts we push and answers each
 * with a scripted list of frames. Frames are functions of the user message so
 * a script can echo its uuid — which is exactly what the real CLI does and
 * what the attribution relies on.
 */
function fakeQuery({ script, onOpen = () => {}, onClose = () => {} }) {
  const calls = [];
  const fn = ({ prompt, options }) => {
    calls.push(options);
    onOpen(options);
    let interrupted = false;
    let closed = false;
    const gen = (async function* run() {
      yield { type: 'system', subtype: 'init', session_id: options.resume ?? 'fresh-1', model: options.model };
      for await (const user of prompt) {
        if (closed) return;
        // A frame may be a function: evaluated lazily, and it may return a
        // promise — that is how a script asks `options.canUseTool` and waits
        // for the board's answer, as the CLI would.
        for (const frame of script(user, { interrupted: () => interrupted, options })) {
          if (closed) return;
          yield typeof frame === 'function' ? await frame() : frame;
        }
        interrupted = false;
      }
    }());
    gen.interrupt = async () => { interrupted = true; };
    gen.setModel = async (m) => { calls.at(-1).modelSet = m; };
    gen.applyFlagSettings = async (f) => { (calls.at(-1).flags ??= []).push(f); };
    gen.setPermissionMode = async (m) => { calls.at(-1).modeSet = m; };
    gen.close = () => { closed = true; onClose(); gen.return(); };
    return gen;
  };
  fn.calls = calls;
  return fn;
}

const answer = (uuid, text, extra = {}) => [
  { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
  { type: 'assistant', user_message_uuid: uuid, message: { content: [{ type: 'text', text }] } },
  { type: 'result', subtype: 'success', result: text, session_id: 's1', user_message_uuid: uuid, num_turns: 1, ...extra },
];

test('un prompt, un resultado, y el proceso sigue vivo después', async () => {
  const q = fakeQuery({ script: (u) => answer(u.uuid, `eco: ${u.message.content}`) });
  const events = [];
  const s = new ChatSession({ cwd: '.', model: 'm', idleMs: 0, queryFn: q, onEvent: (e) => events.push(e.kind) });
  const r = await s.send('hola');
  assert.equal(r.ok, true);
  assert.equal(r.resultText, 'eco: hola');
  assert.equal(r.sessionId, 's1');
  assert.equal(s.alive, true, 'la entrada en streaming no cierra el proceso al terminar el turno');
  assert.equal(s.busy, false);
  assert.ok(events.includes('turn_start') && events.includes('turn_end'));
  const r2 = await s.send('otra');
  assert.equal(r2.resultText, 'eco: otra');
  assert.equal(q.calls.length, 1, 'dos prompts, un solo proceso');
  s.close();
});

test('un turno que el CLI arranca solo no se lleva el resultado del nuestro', async () => {
  // Before answering our prompt, the process runs a turn of its own (a
  // background task finished) whose result carries no stamp for us.
  const q = fakeQuery({
    script: (u) => [
      { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'el build terminó' }] } },
      { type: 'result', subtype: 'success', result: 'el build terminó', session_id: 's1', queued_turn_count: 1, num_turns: 1 },
      ...answer(u.uuid, 'respuesta de verdad'),
    ],
  });
  const ends = [];
  const s = new ChatSession({ cwd: '.', model: 'm', idleMs: 0, queryFn: q, onEvent: (e) => { if (e.kind === 'turn_end') ends.push(e.own); } });
  const r = await s.send('¿cómo va?');
  assert.equal(r.resultText, 'respuesta de verdad');
  assert.deepEqual(ends, [false, true], 'el primer turno se reporta como ajeno');
  s.close();
});

test('un resultado de éxito sin sello nunca es nuestro, diga lo que diga la cola', async () => {
  // #937: a notification turn ended with an unstamped success and an empty
  // queue right as our prompt went in; the board took it as our answer, the
  // real work ran as «nobody's», and the idle timer killed it 15 min later.
  const q = fakeQuery({
    script: (u) => [
      { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
      { type: 'result', subtype: 'success', result: 'la tarea de fondo acabó', session_id: 's1', queued_turn_count: 0, num_turns: 1 },
      ...answer(u.uuid, 'respuesta de verdad'),
    ],
  });
  const s = new ChatSession({ cwd: '.', model: 'm', idleMs: 0, queryFn: q });
  const r = await s.send('¿cómo va?');
  assert.equal(r.resultText, 'respuesta de verdad');
  s.close();
});

test('el reposo no corre mientras el proceso tiene un turno propio o tareas fuera', async () => {
  let closed = 0;
  const task = (subtype, id) => ({ type: 'system', subtype, task_id: id, description: 'agente', status: 'completed' });
  const selfTurn = [
    { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
    { type: 'result', subtype: 'success', result: 'reacciono', session_id: 's1', queued_turn_count: 0, num_turns: 1 },
  ];
  const q = fakeQuery({
    onClose: () => { closed += 1; },
    script: (u) => {
      const text = u.message.content;
      if (text === 'a') return [...answer(u.uuid, 'ok'), task('task_started', 't1')];   // a subagent stays out
      if (text === 'b') return [task('task_notification', 't1'), ...answer(u.uuid, 'ok'), { type: 'system', subtype: 'init', session_id: 's1', model: 'm' }];   // a turn of its own starts
      return [...selfTurn.slice(1), ...answer(u.uuid, 'ok')];   // and ends
    },
  });
  const s = new ChatSession({ cwd: '.', model: 'm', idleMs: 30, queryFn: q });
  await s.send('a');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(s.alive, true, 'con un subagente fuera no se apaga');
  assert.equal(s.working, true);
  await s.send('b');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(s.alive, true, 'con un turno propio en marcha no se apaga');
  await s.send('c');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(s.alive, false, 'sin nada en marcha, sí');
  assert.equal(closed, 1);
});

test('un resultado de error sin sello es nuestro sólo si no queda nada nuestro en cola', async () => {
  const q = fakeQuery({
    script: () => [
      { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
      { type: 'result', subtype: 'error_during_execution', errors: ['boom'], session_id: 's1', queued_turn_count: 0, num_turns: 0 },
    ],
  });
  const s = new ChatSession({ cwd: '.', model: 'm', idleMs: 0, queryFn: q });
  const r = await s.send('x');
  assert.equal(r.ok, false);
  s.close();
});

test('las herramientas del turno se cuentan, y las de un turno ajeno no', async () => {
  const q = fakeQuery({
    script: (u) => [
      { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] } },
      { type: 'result', subtype: 'success', result: '', session_id: 's1', queued_turn_count: 1, num_turns: 1 },
      { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
      { type: 'assistant', user_message_uuid: u.uuid, message: { content: [{ type: 'tool_use', id: 'a', name: 'Agent', input: {} }, { type: 'tool_use', id: 'b', name: 'Agent', input: {} }] } },
      { type: 'result', subtype: 'success', result: 'ok', session_id: 's1', user_message_uuid: u.uuid, num_turns: 1 },
    ],
  });
  const s = new ChatSession({ cwd: '.', model: 'm', idleMs: 0, queryFn: q });
  const r = await s.send('x');
  assert.deepEqual({ ...r.toolCounts }, { Agent: 2 });
  s.close();
});

test('si el proceso muere a mitad, el turno se resuelve como fallo en vez de colgar', async () => {
  const q = fakeQuery({
    script: () => [
      { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
      () => { throw new Error('el CLI se cayó'); },
    ],
  });
  const s = new ChatSession({ cwd: '.', model: 'm', idleMs: 0, queryFn: q });
  const r = await s.send('x');
  assert.equal(r.ok, false);
  assert.match(r.error, /se cayó/);
  assert.equal(s.alive, false);
  // And the next prompt opens a new process resuming the same id.
  const q2 = fakeQuery({ script: (u) => answer(u.uuid, 'de vuelta') });
  const s2 = new ChatSession({ cwd: '.', model: 'm', resume: 's1', idleMs: 0, queryFn: q2 });
  assert.equal((await s2.send('y')).resultText, 'de vuelta');
  assert.equal(q2.calls[0].resume, 's1');
  s2.close();
});

test('tras el tiempo de reposo el proceso se cierra, y el siguiente prompt lo reanuda', async () => {
  let closed = 0;
  const q = fakeQuery({ script: (u) => answer(u.uuid, 'ok'), onClose: () => { closed += 1; } });
  const s = new ChatSession({ cwd: '.', model: 'm', idleMs: 30, queryFn: q });
  await s.send('a');
  assert.equal(s.alive, true);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(s.alive, false, 'se apagó sola');
  assert.equal(closed, 1);
  await s.send('b');
  assert.equal(q.calls.length, 2, 'proceso nuevo');
  assert.equal(q.calls[1].resume, 's1', 'que reanuda la misma conversación');
  s.close();
});

test('la rama sólo se pide al primer proceso', async () => {
  const q = fakeQuery({ script: (u) => answer(u.uuid, 'ok') });
  const s = new ChatSession({ cwd: '.', model: 'm', resume: 'padre', forkSession: true, idleMs: 0, queryFn: q });
  await s.send('a');
  assert.equal(q.calls[0].forkSession, true);
  assert.equal(q.calls[0].resume, 'padre');
  s.close();
  await s.send('b');
  assert.equal(q.calls[1].forkSession, undefined, 'el segundo reanuda su propio id, sin volver a ramificar');
  s.close();
});

test('dos prompts a la vez no se aceptan: el segundo es cosa del que llama', async () => {
  const q = fakeQuery({ script: (u) => answer(u.uuid, 'ok') });
  const s = new ChatSession({ cwd: '.', model: 'm', idleMs: 0, queryFn: q });
  const first = s.send('a');
  await assert.rejects(s.send('b'), /already answering a prompt/);
  await first;
  s.close();
});

test('setModel cambia el modelo del proceso vivo y del siguiente', async () => {
  const q = fakeQuery({ script: (u) => answer(u.uuid, 'ok') });
  const s = new ChatSession({ cwd: '.', model: 'm', idleMs: 0, queryFn: q });
  await s.send('a');
  await s.setModel('otro');
  assert.equal(q.calls[0].modelSet, 'otro');
  s.close();
  await s.send('b');
  assert.equal(q.calls[1].model, 'otro');
  s.close();
});

test('mcpServers llega intacto hasta las options de la SDK', async () => {
  const mcp = { opencode: { type: 'sdk', name: 'opencode' } };
  const q = fakeQuery({ script: (u) => answer(u.uuid, 'ok') });
  const s = new ChatSession({ cwd: '.', model: 'm', idleMs: 0, queryFn: q, mcpServers: mcp });
  await s.send('a');
  assert.equal(q.calls[0].mcpServers, mcp);
  s.close();
});

test('close con un turno a medias lo resuelve como fallo', async () => {
  const q = fakeQuery({
    script: () => [{ type: 'system', subtype: 'init', session_id: 's1', model: 'm' }, () => new Promise(() => {})],
  });
  const s = new ChatSession({ cwd: '.', model: 'm', idleMs: 0, queryFn: q });
  const p = s.send('a');
  await new Promise((r) => setTimeout(r, 10));
  s.close();
  const r = await p;
  assert.equal(r.ok, false);
  assert.match(r.error, /se cerró/);
});

test('al cerrarse el proceso avisa una vez, se cierre por reposo o muera solo', async () => {
  const events = [];
  const q = fakeQuery({ script: (u) => answer(u.uuid, 'ok') });
  const s = new ChatSession({ cwd: '.', model: 'm', idleMs: 0, queryFn: q, onEvent: (e) => events.push(e.kind) });
  await s.send('a');
  s.close();
  s.close();   // a second close must not announce twice
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(events.filter((k) => k === 'session_closed').length, 1);

  // A process that dies on its own says goodbye too — once.
  const dying = fakeQuery({ script: () => [{ type: 'system', subtype: 'init', session_id: 's1', model: 'm' }, () => { throw new Error('boom'); }] });
  const ev2 = [];
  const s2 = new ChatSession({ cwd: '.', model: 'm', idleMs: 0, queryFn: dying, onEvent: (e) => ev2.push(e.kind) });
  await s2.send('x');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ev2.filter((k) => k === 'session_closed').length, 1);
  // And a fresh process after that gets a farewell of its own.
  s2.close();
  assert.equal(ev2.filter((k) => k === 'session_closed').length, 1, 'ya estaba cerrado: nada nuevo que anunciar');
});

// ---------------------------------------------------------------------------
// Plan mode and the tools that need a person

test('el modo de permisos y el callback llegan al proceso, y setPermissionMode cambia el vivo y el siguiente', async () => {
  const canUseTool = async () => ({ behavior: 'allow' });
  const q = fakeQuery({ script: (u) => answer(u.uuid, 'ok') });
  const s = new ChatSession({
    cwd: '.', model: 'm', idleMs: 0, queryFn: q,
    permissionMode: 'plan', canUseTool, planModeInstructions: 'solo lee', settings: { plansDirectory: 'tmp/p' },
  });
  await s.send('a');
  assert.equal(q.calls[0].permissionMode, 'plan');
  assert.equal(q.calls[0].canUseTool, canUseTool);
  assert.equal(q.calls[0].planModeInstructions, 'solo lee');
  assert.deepEqual(q.calls[0].settings, { plansDirectory: 'tmp/p' });
  assert.equal(q.calls[0].allowDangerouslySkipPermissions, true);
  await s.setPermissionMode('bypassPermissions');
  assert.equal(q.calls[0].modeSet, 'bypassPermissions', 'el proceso vivo cambia en caliente');
  s.close();
  await s.send('b');
  assert.equal(q.calls[1].permissionMode, 'bypassPermissions', 'el siguiente proceso nace en el modo nuevo');
  s.close();
});

test('una pregunta del modelo se aparca en canUseTool y la respuesta vuelve al turno como updatedInput', async () => {
  let resolveAnswer;
  const parked = new Promise((r) => { resolveAnswer = r; });
  const canUseTool = async (name, input) => {
    assert.equal(name, 'AskUserQuestion');
    const answers = await parked;                       // the board waits for the person
    return { behavior: 'allow', updatedInput: { questions: input.questions, answers } };
  };
  const questions = [{ question: '¿Qué?', header: 'Qué', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }];
  let toolResult = null;
  const q = fakeQuery({
    script: (u, { options }) => [
      { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
      { type: 'assistant', user_message_uuid: u.uuid, message: { content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions } }] } },
      async () => {
        const r = await options.canUseTool('AskUserQuestion', { questions }, { toolUseID: 'q1', requestId: 'r1', signal: new AbortController().signal });
        toolResult = r;
        return { type: 'user', user_message_uuid: u.uuid, message: { content: [{ type: 'tool_result', tool_use_id: 'q1', content: `answered: ${JSON.stringify(r.updatedInput.answers)}` }] } };
      },
      ...answer(u.uuid, 'sigo con B').slice(1),
    ],
  });
  const s = new ChatSession({ cwd: '.', model: 'm', idleMs: 0, queryFn: q, canUseTool });
  const turn = s.send('pregúntame');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.busy, true, 'el turno sigue nuestro mientras la pregunta espera');
  resolveAnswer({ '¿Qué?': 'B' });
  const r = await turn;
  assert.equal(r.resultText, 'sigo con B');
  assert.deepEqual(toolResult.updatedInput.answers, { '¿Qué?': 'B' });
  s.close();
});

test('un deny con interrupt cierra el turno del plan: el tablero ejecuta, el chat no', async () => {
  const canUseTool = async (name) => (name === 'ExitPlanMode'
    ? { behavior: 'deny', message: 'el tablero ejecuta el plan', interrupt: true }
    : { behavior: 'allow' });
  const q = fakeQuery({
    script: (u, { options, interrupted }) => [
      { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
      { type: 'assistant', user_message_uuid: u.uuid, message: { content: [{ type: 'tool_use', id: 'x1', name: 'ExitPlanMode', input: {} }] } },
      async () => {
        const r = await options.canUseTool('ExitPlanMode', {}, { toolUseID: 'x1', requestId: 'r1', signal: new AbortController().signal });
        return { type: 'user', user_message_uuid: u.uuid, message: { content: [{ type: 'tool_result', tool_use_id: 'x1', is_error: true, content: r.message }] } };
      },
      { type: 'result', subtype: 'success', result: '', session_id: 's1', user_message_uuid: u.uuid, num_turns: 1, is_interrupt: true },
    ],
  });
  const s = new ChatSession({ cwd: '.', model: 'm', idleMs: 0, queryFn: q, permissionMode: 'plan', canUseTool });
  const r = await s.send('planifica');
  assert.equal(r.ok, true);
  assert.equal(s.busy, false);
  s.close();
});

test('los ajustes de esfuerzo llegan a cada proceso; sin ellos no se pasa nada', async () => {
  const q = fakeQuery({ script: (u) => answer(u.uuid, 'ok') });
  const tuned = new ChatSession({ cwd: '.', model: 'opus', idleMs: 0, queryFn: q, effort: 'high', fallbackModel: 'sonnet', settingSources: ['user'] });
  await tuned.send('hola');
  tuned.close();
  assert.equal(q.calls[0].effort, 'high');
  assert.equal(q.calls[0].fallbackModel, 'sonnet');
  assert.deepEqual(q.calls[0].settingSources, ['user']);

  const plain = new ChatSession({ cwd: '.', model: 'opus', idleMs: 0, queryFn: q });
  await plain.send('hola');
  plain.close();
  assert.equal('effort' in q.calls[1], false);
  assert.deepEqual(q.calls[1].settingSources, ['user', 'project']);
});

test('boardPlugins survives every process the session opens, retune included', async () => {
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tempDir } = await import('./teardown.mjs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { boardPluginHooks } = await import('../src/boardplugin.js');
  const root = tempDir('hfs-boardplugin-');
  const dir = path.join(root, 'plugins', 'hfs-ux');
  mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), '{"name":"hfs-ux"}');
  const realRoot = boardPluginHooks.root;
  boardPluginHooks.root = root;
  try {
    const q = fakeQuery({ script: (u) => answer(u.uuid, 'ok') });
    const s = new ChatSession({ cwd: '.', model: 'opus', idleMs: 0, queryFn: q, boardPlugins: ['hfs-ux'], available: [{ id: 'opus', label: 'Opus' }], onWarning: () => {} });
    await s.send('hola');
    assert.deepEqual(q.calls[0].plugins, [{ type: 'local', path: dir }]);
    await s.retune({ thinking: { type: 'disabled' } });
    s.close();
    await s.send('otra vez');
    s.close();
    assert.deepEqual(q.calls.at(-1).plugins, [{ type: 'local', path: dir }], 'a reopened process still has it');

    const plain = new ChatSession({ cwd: '.', model: 'opus', idleMs: 0, queryFn: q });
    await plain.send('hola');
    plain.close();
    assert.equal('plugins' in q.calls.at(-1), false);
  } finally {
    boardPluginHooks.root = realRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// retune: hot model and effort, deferred reopen when the thinking no longer fits

const available = [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'haiku', label: 'Haiku' }];
const quiet = { available, onWarning: () => {} };

test('retune en caliente: setModel y applyFlagSettings solo cuando el nivel efectivo cambia', async () => {
  const q = fakeQuery({ script: (u) => answer(u.uuid, 'ok') });
  const s = new ChatSession({ cwd: '.', model: 'sonnet', idleMs: 0, queryFn: q, effort: 'high', ...quiet });
  await s.send('a');
  assert.equal(s.runningEffort, 'high');
  assert.equal(s.runningThinking, null);

  // Same effective level: the model switches, the flags are not touched.
  let r = await s.retune({ model: 'opus' });
  assert.deepEqual(r, { reopened: false, effort: 'high', reason: null });
  assert.equal(q.calls[0].modelSet, 'opus');
  assert.equal(q.calls[0].flags, undefined);

  // A different level goes through applyFlagSettings.
  r = await s.retune({ effort: 'xhigh' });
  assert.deepEqual(r, { reopened: false, effort: 'xhigh', reason: null });
  assert.deepEqual(q.calls[0].flags, [{ effortLevel: 'xhigh' }]);
  assert.equal(s.runningEffort, 'xhigh');

  // Haiku has no effort: the level goes null, and the stored choice survives.
  r = await s.retune({ model: 'haiku' });
  assert.deepEqual(r, { reopened: false, effort: null, reason: null });
  assert.deepEqual(q.calls[0].flags.at(-1), { effortLevel: null });
  assert.equal(s.runningEffort, null);
  assert.equal(s.alive, true, 'sin razonamiento abierto, no hay reapertura');

  // Back to Opus: the stored xhigh comes back, compared with what the process runs.
  r = await s.retune({ model: 'opus' });
  assert.deepEqual(r, { reopened: false, effort: 'xhigh', reason: null });
  assert.deepEqual(q.calls[0].flags.at(-1), { effortLevel: 'xhigh' });
  assert.equal(q.calls.length, 1);
  s.close();
});

test('retune reabre la sesión ociosa al momento si el razonamiento con que abrió no vale en el modelo nuevo', async () => {
  let closed = 0;
  const q = fakeQuery({ script: (u) => answer(u.uuid, 'ok'), onClose: () => { closed += 1; } });
  const s = new ChatSession({ cwd: '.', model: 'haiku', idleMs: 0, queryFn: q, thinking: { type: 'enabled', budgetTokens: 2048 }, ...quiet });
  await s.send('a');
  assert.deepEqual(s.runningThinking, { type: 'enabled', budgetTokens: 2048 });
  const r = await s.retune({ model: 'opus', thinking: 'auto' });
  assert.deepEqual(r, { reopened: true, effort: null, reason: 'model' });
  assert.equal(closed, 1);
  assert.equal(s.alive, false);
  assert.equal(s.runningThinking, null);
  await s.send('b');
  assert.equal(q.calls.length, 2, 'el siguiente mensaje abre un proceso nuevo');
  assert.equal(q.calls[1].model, 'opus');
  assert.equal(q.calls[1].resume, 's1', 'con la misma conversación');
  assert.equal('thinking' in q.calls[1], false);
  s.close();
});

test('retune con la sesión ocupada reabre al terminar el turno, no antes', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let closed = 0;
  const q = fakeQuery({
    onClose: () => { closed += 1; },
    script: (u) => [
      { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
      async () => { await gate; return { type: 'system', subtype: 'status', session_id: 's1' }; },
      ...answer(u.uuid, 'ok').slice(1),
    ],
  });
  const s = new ChatSession({ cwd: '.', model: 'haiku', idleMs: 0, queryFn: q, thinking: { type: 'enabled', budgetTokens: 1024 }, ...quiet });
  const turn = s.send('a');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.busy, true);
  const r = await s.retune({ model: 'sonnet' });
  assert.equal(r.reopened, true);
  assert.equal(closed, 0, 'ocupada: no se cierra todavía');
  assert.equal(s.alive, true);
  release();
  const result = await turn;
  assert.equal(result.ok, true, 'el turno en curso termina con su respuesta');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(closed, 1);
  assert.equal(s.alive, false);
  await s.send('b');
  assert.equal(q.calls.length, 2);
  s.close();
});

test('retune sin proceso solo recuerda los ajustes para el siguiente, y setEffort pasa por retune', async () => {
  const q = fakeQuery({ script: (u) => answer(u.uuid, 'ok') });
  const s = new ChatSession({ cwd: '.', model: 'opus', idleMs: 0, queryFn: q, ...quiet });
  assert.deepEqual(await s.retune({ effort: 'max' }), { reopened: false, effort: 'max', reason: null });
  assert.equal(s.runningEffort, null, 'nada vivo que recordar');
  await s.send('a');
  assert.equal(q.calls[0].effort, 'max');
  assert.equal(s.runningEffort, 'max');
  assert.deepEqual(await s.setEffort('low'), { reopened: false, effort: 'low', reason: null });
  assert.deepEqual(q.calls[0].flags, [{ effortLevel: 'low' }]);
  assert.equal(s.alive, true, 'setEffort ya no cierra el proceso');
  s.close();
});

test('retune de solo razonamiento con la sesión ociosa reabre al momento, con motivo thinking', async () => {
  let closed = 0;
  const q = fakeQuery({ script: (u) => answer(u.uuid, 'ok'), onClose: () => { closed += 1; } });
  const s = new ChatSession({ cwd: '.', model: 'opus', idleMs: 0, queryFn: q, ...quiet });
  await s.send('a');
  assert.equal(s.runningThinking, null);
  // The same thinking the process already runs (none) reopens nothing.
  assert.deepEqual(await s.retune({ thinking: null }), { reopened: false, effort: null, reason: null });
  const r = await s.retune({ thinking: { type: 'adaptive' } });
  assert.deepEqual(r, { reopened: true, effort: null, reason: 'thinking' });
  assert.equal(closed, 1);
  assert.equal(s.alive, false);
  await s.send('b');
  assert.deepEqual(q.calls[1].thinking, { type: 'adaptive' });
  assert.equal(q.calls[1].resume, 's1');
  // Asking for what it already runs is not a change that needs a process.
  assert.deepEqual(await s.retune({ thinking: { type: 'adaptive' } }), { reopened: false, effort: null, reason: null });
  assert.equal(s.alive, true);
  s.close();
});

test('retune de solo razonamiento con la sesión ocupada reabre al terminar el turno', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let closed = 0;
  const q = fakeQuery({
    onClose: () => { closed += 1; },
    script: (u) => [
      { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
      async () => { await gate; return { type: 'system', subtype: 'status', session_id: 's1' }; },
      ...answer(u.uuid, 'ok').slice(1),
    ],
  });
  const s = new ChatSession({ cwd: '.', model: 'opus', idleMs: 0, queryFn: q, thinking: { type: 'adaptive' }, ...quiet });
  const turn = s.send('a');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.busy, true);
  const r = await s.retune({ thinking: 'auto' });
  assert.deepEqual(r, { reopened: true, effort: null, reason: 'thinking' });
  assert.equal(closed, 0, 'ocupada: no se cierra todavía');
  release();
  assert.equal((await turn).ok, true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(closed, 1);
  assert.equal(s.alive, false);
  s.close();
});

test('design llega a las options de cada proceso, también al reabrir; sin él no se pasa el entrypoint', async () => {
  const prev = process.env.CLAUDE_CODE_ENTRYPOINT;
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
  try {
    const q = fakeQuery({ script: (u) => answer(u.uuid, 'ok') });
    const d = new ChatSession({ cwd: '.', model: 'm', idleMs: 0, queryFn: q, design: true });
    await d.send('a');
    d.close();
    await d.send('b');
    d.close();
    assert.equal(q.calls[0].env.CLAUDE_CODE_ENTRYPOINT, 'claude-vscode');
    assert.equal(q.calls[1].env.CLAUDE_CODE_ENTRYPOINT, 'claude-vscode');
    const plain = new ChatSession({ cwd: '.', model: 'm', idleMs: 0, queryFn: q });
    await plain.send('a');
    plain.close();
    assert.equal(q.calls[2].env.CLAUDE_CODE_ENTRYPOINT, undefined);
  } finally {
    if (prev !== undefined) process.env.CLAUDE_CODE_ENTRYPOINT = prev;
  }
});

test('commands(): opens a process with no prompt, lists, and the idle timer still lets it go', async () => {
  const q = fakeQuery({ script: (u) => answer(u.uuid, 'ok') });
  const list = [{ name: 'compact', description: 'd', argumentHint: '', builtin: true }];
  const wrapped = (args) => {
    const gen = q(args);
    gen.supportedCommands = async () => list;
    return gen;
  };
  const events = [];
  const s = new ChatSession({ cwd: '.', model: 'm', idleMs: 30, queryFn: wrapped, onEvent: (e) => events.push(e.kind) });
  assert.deepEqual(await s.commands(), list);
  assert.equal(q.calls.length, 1, 'one process, opened for the list');
  assert.equal(s.busy, false, 'no turn of ours');
  // The same process serves the next prompt.
  const r = await s.send('hola');
  assert.equal(r.resultText, 'ok');
  assert.equal(q.calls.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(s.alive, false, 'idle closes it as usual');
  assert.ok(events.includes('session_closed'));
});

test('commands() on its own, never followed by a prompt, does not keep the process', async () => {
  // As the real CLI does (measured with SDK 0.3.331): no frame at all until a
  // prompt arrives — the `init` of `fakeQuery` would count as a turn of its own.
  let closed = false;
  const wrapped = ({ prompt }) => {
    const gen = (async function* run() { for await (const _ of prompt) { /* never sent */ } }());
    return Object.assign(gen, { supportedCommands: async () => [], close: () => { closed = true; gen.return(); } });
  };
  const s = new ChatSession({ cwd: '.', model: 'm', idleMs: 30, queryFn: wrapped });
  await s.commands();
  assert.equal(s.alive, true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(s.alive, false);
  assert.equal(closed, true);
});

test('selfTurn is true only while a turn the process started by itself runs', async () => {
  const seen = [];
  let s;
  const q = fakeQuery({
    script: (u) => [
      { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
      { type: 'assistant', user_message_uuid: u.uuid, message: { content: [{ type: 'text', text: 'ok' }] } },
      { type: 'result', subtype: 'success', result: 'ok', session_id: 's1', user_message_uuid: u.uuid, num_turns: 1 },
    ],
  });
  s = new ChatSession({
    cwd: '.', model: 'm', idleMs: 0, queryFn: q,
    onEvent: (e) => { if (e.kind === 'turn_start' || e.kind === 'turn_end') seen.push([e.kind, e.own, s.selfTurn]); },
  });
  // The first frame is an `init` before any prompt of ours: a turn of its own.
  await s.commands().catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.selfTurn, true);
  await s.send('hola');
  assert.deepEqual(seen.at(-2), ['turn_start', true, false]);
  assert.equal(s.selfTurn, false);
  s.close();
});
