// A runner that goes away while a Claude session of it is up: the board has to
// hear that the process is gone. The real SDK against a real runner over
// loopback; only the CLI is a stand-in that speaks the stream-json protocol.
import './isolate.mjs';   // first: isolates the data directory
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';

import { createRunner } from '../src/runner/app.js';
import { RunnerMachine } from '../src/runner-client.js';
import { ChatSession } from '../src/session.js';
import { tempDir } from './teardown.mjs';

// The runner spawns one command with the SDK's flags: a script with a shebang.
const skip = process.platform === 'win32' ? 'the stand-in CLI is a shebang script' : false;

const FAKE_CLI = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.type === 'control_request') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { commands: [], agents: [], models: [], account: {}, output_style: 'default', available_output_styles: [] } } });
    } else if (m.type === 'user') {
      out({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' });
      if (String(m.message.content).includes('never answer')) continue;
      out({ type: 'assistant', user_message_uuid: m.uuid, session_id: 's1', message: { content: [{ type: 'text', text: 'ok' }] } });
      out({ type: 'result', subtype: 'success', result: 'ok', session_id: 's1', user_message_uuid: m.uuid, num_turns: 1 });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

async function setup(t) {
  const root = tempDir('hfsmon-restart-');
  const cli = path.join(root, 'claude');
  writeFileSync(cli, FAKE_CLI);
  chmodSync(cli, 0o755);
  const options = { token: 't', repoPath: root, worktreeRoot: `${root}-wt`, attachmentsDir: path.join(root, 'attachments'), claudeCommand: cli };
  const box = { runner: createRunner(options) };
  const { port } = await box.runner.listen(0, '127.0.0.1');
  const machine = new RunnerMachine('devbox', { url: `http://127.0.0.1:${port}`, token: 't', repoPath: root, worktreeRoot: `${root}-wt` });
  const events = [];
  const session = new ChatSession({ machine, cwd: root, model: 'm', idleMs: 0, onEvent: (e) => events.push(e.kind) });
  t.after(async () => {
    session.close();
    await box.runner.close().catch(() => {});
  });
  /** The runner goes away and, on the same address, comes back. */
  box.restart = async () => {
    await box.runner.close();
    box.runner = createRunner(options);
    await box.runner.listen(port, '127.0.0.1');
  };
  return { box, session, events };
}

const within = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => { setTimeout(() => reject(new Error(`still waiting after ${ms} ms: ${what}`)), ms).unref(); }),
]);

async function until(ok, what, ms = 8000) {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error(`never happened: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('an idle session closes when its runner restarts, and the next prompt opens a new one', { skip }, async (t) => {
  const { box, session, events } = await setup(t);
  assert.equal((await within(session.send('one'), 15_000, 'the first turn')).ok, true);
  assert.equal(session.alive, true);

  await box.restart();
  await until(() => !session.alive, 'the session notices its process is gone');
  assert.ok(events.includes('session_closed'), events.join(' '));

  const second = await within(session.send('two'), 15_000, 'the turn after the restart');
  assert.equal(second.ok, true, second.error);
  assert.equal(second.resultText, 'ok');
});

test('a turn in flight when the runner goes away ends with an error instead of hanging', { skip }, async (t) => {
  const { box, session, events } = await setup(t);
  const turn = session.send('never answer');
  await until(() => events.includes('turn_start'), 'the prompt reaches the CLI');
  await box.runner.close();
  const result = await within(turn, 8000, 'the turn that lost its runner');
  assert.equal(result.ok, false);
  assert.ok(result.error, 'says why');
  assert.equal(session.alive, false);
});
