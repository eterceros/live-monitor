// The language gate reaching the sessions.
//
// `ghgate.test.mjs` proves the module reads a command line correctly. This
// proves the other half, which is the half that failed in #1445: that what
// every Bash call goes through actually asks it, and that a `gh` publishing
// Spanish never runs.
//
// Through the `PreToolUse` hook, because that is the path that runs. It was
// wired to `canUseTool` first and those tests passed while the gate was inert:
// every working session uses `permissionMode: 'bypassPermissions'`, where the
// CLI approves the call before the callback is consulted — the SDK says so on
// every session as `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`. A green test over code
// the SDK never calls is worse than no test, so these drive the hook.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tempDir } from './teardown.mjs';
import path from 'node:path';

process.env.HFSMON_DATA_DIR = tempDir('hfsmon-ghgate-');
process.env.HFSMON_NO_AUTOSTART = '1';

let pipeline;
let store;

before(async () => {
  pipeline = await import('../src/pipeline.js');
  ({ store } = await import('../src/store.js'));
});

let n = 9300;
const freshTask = () => {
  n += 1;
  return store.addTask({ number: n, title: `t${n}`, labels: [], url: `https://x/${n}`, closed: false }, 'hfs');
};

/** What the SDK hands a `PreToolUse` hook, and what it reads back from it. */
const hookOf = (task, phase) => {
  const set = pipeline.ghGateHooks(task, phase);
  const matcher = set.PreToolUse[0];
  assert.equal(matcher.matcher, 'Bash', 'the matcher narrows the CLI side to Bash');
  const fn = matcher.hooks[0];
  return (command, extra = {}) => fn({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...extra });
};
const decisionOf = (out) => out?.hookSpecificOutput?.permissionDecision ?? 'allow';
const reasonOf = (out) => out?.hookSpecificOutput?.permissionDecisionReason ?? '';

const ENGLISH = 'Fixed by narrowing the storage lookup to the tenant of the request.';
const SPANISH = 'Arreglado: la consulta ahora se limita al tenant de la petición, que era el problema.';

test('a pipeline phase cannot comment in Spanish, and can in English', async () => {
  const hook = hookOf(freshTask(), 'fix');

  const denied = await hook(`gh pr comment 7 --body "${SPANISH}"`);
  assert.equal(decisionOf(denied), 'deny');
  assert.equal(denied.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(reasonOf(denied), /inglés/);

  assert.equal(decisionOf(await hook(`gh pr comment 7 --body "${ENGLISH}"`)), 'allow');
});

test('anything that does not publish goes through untouched', async () => {
  const hook = hookOf(freshTask(), 'fix');
  for (const command of ['cargo test -p helios-rest', 'gh pr view 7 --json body', 'git commit -m "fix: tenant scope"']) {
    assert.equal(decisionOf(await hook(command)), 'allow', command);
  }
});

test('a subagent publishing is gated exactly like the main thread', async () => {
  // The reason this had to be a hook and not only a callback: `canUseTool` sees
  // the main thread, hooks fire inside the subagents too — and a subagent that
  // posts a comment publishes just as publicly as its parent.
  const hook = hookOf(freshTask(), 'fix');
  const inSubagent = { agent_id: 'agent_1', agent_type: 'general-purpose' };
  assert.equal(decisionOf(await hook(`gh pr comment 7 --body "${SPANISH}"`, inSubagent)), 'deny');
  assert.equal(decisionOf(await hook(`gh pr comment 7 --body "${ENGLISH}"`, inSubagent)), 'allow');
});

test('a tool that is not Bash, or a call with nothing to read, is left alone', async () => {
  // The matcher is a pattern, not an identity: `BashOutput` reaches the hook
  // too, and it carries no command line.
  const hook = hookOf(freshTask(), 'fix');
  assert.equal(decisionOf(await hook(SPANISH, { tool_name: 'BashOutput' })), 'allow');
  assert.equal(decisionOf(await hook(undefined)), 'allow');
});

test('--body-file is read in the worktree, which is where the session wrote it', async () => {
  // The one case where the injection matters, and the one the gate's own deny
  // message tells the agent to use: a relative path resolved against the
  // board's process instead of the worktree reads nothing, denies for being
  // unreadable, and sends the agent round the same loop until its turns run out.
  const task = freshTask();
  task.worktreePath = tempDir('hfsmon-wt-');
  const hook = hookOf(task, 'fix');

  writeFileSync(path.join(task.worktreePath, 'notes.md'), `${ENGLISH}\n`);
  assert.equal(decisionOf(await hook('gh pr comment 7 --body-file notes.md')), 'allow');

  writeFileSync(path.join(task.worktreePath, 'notas.md'), `${SPANISH}\n`);
  const denied = await hook('gh pr comment 7 --body-file notas.md');
  assert.equal(decisionOf(denied), 'deny');
  assert.match(reasonOf(denied), /inglés/);

  // An absolute path is left exactly as written.
  assert.equal(
    decisionOf(await hook(`gh pr comment 7 --body-file "${path.join(task.worktreePath, 'notes.md').replace(/\\/g, '/')}"`)),
    'allow',
  );

  // And a file that is not there is still a body nobody can check.
  assert.equal(decisionOf(await hook('gh pr comment 7 --body-file ausente.md')), 'deny');
});

test('every phase keeps its subagents in the foreground, and a chat does not', async () => {
  const task = freshTask();
  const phase = pipeline.ghGateHooks(task, 'plan');
  assert.deepEqual(phase.PreToolUse.map((m) => m.matcher), ['Bash', 'Artifact|ArtifactComments|ArtifactData', 'Agent|Task'], 'Bash stays first, Artifact second');
  const launch = (tool_name) => phase.PreToolUse[2].hooks[0]({
    hook_event_name: 'PreToolUse', tool_name, tool_input: { prompt: 'x', subagent_type: 'Explore', run_in_background: true },
  });
  for (const name of ['Agent', 'Task']) {
    const out = await launch(name);
    assert.equal(out.hookSpecificOutput.updatedInput.run_in_background, false);
    assert.equal(out.hookSpecificOutput.updatedInput.subagent_type, 'Explore', 'the rest of the input travels');
  }
  assert.deepEqual(pipeline.ghGateHooks(task, 'chat').PreToolUse.map((m) => m.matcher), ['Bash', 'Artifact|ArtifactComments|ArtifactData']);
});

test('a gate that breaks lets the command through instead of taking the phase down', async () => {
  // This runs in front of every Bash call of every phase, so a bug of its own
  // must not be able to kill a turn — not even the logging of its own failure.
  // A task that throws on every read is every one of those bugs at once.
  const broken = new Proxy({}, { get(_, key) { throw new Error(`boom: ${String(key)}`); } });
  const hook = hookOf(broken, 'fix');
  assert.equal(decisionOf(await hook(`gh pr comment 7 --body "${SPANISH}"`)), 'allow');
});

test('the chat keeps its own hook, and the gate joins it rather than replacing it', async () => {
  const task = freshTask();
  const chat = { id: 'c1', planMode: false, pending: null, messages: [] };
  const live = { pending: new Map(), opencodeCalls: [] };
  const merged = pipeline.mergeHooks(pipeline.chatHooks(task, chat, live), pipeline.ghGateHooks(task, 'chat'));

  // Both matchers are there, in that order: the chat's news first, the gate second.
  assert.equal(merged.PreToolUse.length, 3);
  assert.equal(merged.PreToolUse[0].matcher, undefined);
  assert.equal(merged.PreToolUse[1].matcher, 'Bash');

  const call = (command) => merged.PreToolUse[1].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
  assert.equal(decisionOf(await call(`gh issue comment 7 --body "${SPANISH}"`)), 'deny');
  assert.equal(decisionOf(await call(`gh issue comment 7 --body "${ENGLISH}"`)), 'allow');

  // And the chat's own hook still delivers what you typed mid-turn.
  const chatHook = merged.PreToolUse[0].hooks[0];
  assert.deepEqual(await chatHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }), {});
});

test('the chat in plan mode still answers with the plan, not with the language', async () => {
  // Plan mode is the one place `canUseTool` does see a Bash call, and there the
  // reason a person reads on the card should be the plan.
  const task = freshTask();
  const chat = { id: 'c2', planMode: true, pending: null, messages: [] };
  const live = { pending: new Map() };
  const inPlan = await pipeline.chatCanUseTool(task, chat, live, 'Bash', { command: `gh issue comment 7 --body "${ENGLISH}"` }, {});
  assert.equal(inPlan.behavior, 'deny');
  assert.match(inPlan.message, /modo plan/);
});

test('every session the pipeline starts carries the gate', async () => {
  // The bug this file exists for was not a bad check, it was a check nobody
  // called, and a session added later with no `hooks` is that same bug again,
  // silently. Behaviour is checked where the SDK seam exists
  // (`pipeline-advisor.test.mjs`), but most sessions have no seam, so the
  // source is read as well: this is the assertion that cannot be satisfied by
  // testing the gate harder.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/pipeline.js', import.meta.url), 'utf8');

  // Same shapes `maxturns-caps.test.mjs` watches: the direct calls, the
  // injectable `run({` spelling (`readWorkPlanFrom`) and the `nudgedSession`
  // wrapper.
  const calls = [...src.matchAll(/\b(?:fixHooks\.)?runClaude\(\{|\brun\(\{|\bnudgedSession\(task,\s*'[^']+',\s*\{/g)];
  // Pinned: a new session site must be added here on purpose, after checking it.
  assert.equal(calls.length, 22, `found ${calls.length} session literals`);

  const ungated = [];
  for (const m of calls) {
    // The object literal of the call, by brace matching.
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < src.length; end += 1) {
      if (src[end] === '{') depth += 1;
      else if (src[end] === '}' && (depth -= 1) === 0) break;
    }
    const literal = src.slice(m.index, end);
    // `...common` (the plan phase) and `...options` (the advisor) spread an
    // object that carries the gate.
    if (!/\bhooks:/.test(literal) && !/\.\.\.(common|options)\b/.test(literal)) {
      ungated.push(`line ${src.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepEqual(ungated, [], 'a session with no hooks is a session outside the language gate');
});

test('una fase no cierra un issue; un chat sí, porque ahí hay una persona mirando', async () => {
  const task = freshTask();

  // Una fase corre sola: nadie le ha pedido ese cierre y nadie ve la llamada.
  const phase = hookOf(task, 'fix');
  const denied = await phase('gh issue close 1274');
  assert.equal(decisionOf(denied), 'deny');
  assert.match(reasonOf(denied), /respuesta final/);
  // Y lo que la fase sí hace con `gh` —leer, y publicar prosa en inglés— pasa.
  assert.equal(decisionOf(await phase('gh issue view 1274')), 'allow');
  assert.equal(decisionOf(await phase(`gh issue comment 1274 --body "${ENGLISH}"`)), 'allow');

  // Un chat es Edson con el tablero abierto, viendo cada llamada en vivo: si
  // pide cerrar un issue, pedirlo ES la confirmación, y una compuerta delante
  // sería fricción sobre una decisión ya tomada por quien puede tomarla.
  const chat = hookOf(task, 'chat');
  assert.equal(decisionOf(await chat('gh issue close 1274')), 'allow');
  assert.equal(decisionOf(await chat('gh issue edit 1274 --add-label wontfix')), 'allow');
  // Lo que el chat sigue sin poder hacer es publicar en español: esa compuerta
  // no distingue quién pregunta, porque el idioma del repositorio tampoco.
  assert.equal(decisionOf(await chat(`gh issue comment 1274 --body "${SPANISH}"`)), 'deny');
});
