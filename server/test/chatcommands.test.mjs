// Slash commands typed in a chat: what counts as one, which the board answers,
// which it refuses, and how a name finds its row in the CLI's list. Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCommand, boardCommand, isDenied, resolveCommand, mergeCommandList, helpText, BOARD_COMMANDS,
} from '../src/chatcommands.js';
import {
  commandQuery, filterCommands, commandText, isClearCommand, shortDescription, typedInFull,
} from '../../web/src/chatCommands.js';

const SDK = [
  { name: 'clear', description: 'Start a new session', argumentHint: '[name]', aliases: ['reset', 'new'], builtin: true },
  { name: 'compact', description: 'Free up context', argumentHint: '<optional instructions>', builtin: true },
  { name: 'context', description: 'Show current context usage', argumentHint: '', builtin: true },
  { name: 'usage', description: 'Show session cost', argumentHint: '', aliases: ['cost', 'stats'], builtin: true },
  { name: 'model', description: 'Set the AI model', argumentHint: '<model>', builtin: true },
  { name: 'effort', description: 'Set effort', argumentHint: '', builtin: true },
  { name: 'design-review', description: 'x', argumentHint: '', builtin: true },
  { name: 'doctor', description: 'Diagnose', argumentHint: '', builtin: true },
  { name: 'review', description: 'Project review command', argumentHint: '' },
  { name: 'frontend-design:frontend-design', description: 'A plugin skill', argumentHint: '' },
  { name: 'context', description: 'A custom command that shadows a builtin', argumentHint: '' },
];

test('parseCommand: a name, optional arguments; a path is conversation', () => {
  assert.deepEqual(parseCommand('/compact'), { name: 'compact', args: '' });
  assert.deepEqual(parseCommand('  /compact   keep the code  '), { name: 'compact', args: 'keep the code' });
  assert.deepEqual(parseCommand('/plugin:cmd a\nb'), { name: 'plugin:cmd', args: 'a\nb' });
  assert.deepEqual(parseCommand('/review-pr 12'), { name: 'review-pr', args: '12' });
  for (const text of ['/a/b', '/src/app.js', 'hola /compact', '/', '/ compact', '/1abc', '', null, '//x']) {
    assert.equal(parseCommand(text), null, String(text));
  }
});

test('boardCommand: clear and its aliases, model, plan, help — case-insensitive', () => {
  for (const n of ['clear', 'reset', 'new', 'CLEAR']) assert.equal(boardCommand(n)?.name, 'clear', n);
  assert.equal(boardCommand('model').name, 'model');
  assert.equal(boardCommand('plan').name, 'plan');
  assert.equal(boardCommand('help').name, 'help');
  assert.equal(boardCommand('compact'), null);
});

test('isDenied: the fixed list, the design* prefix and the terminal-only list', () => {
  for (const n of ['effort', 'fast', 'config', 'rename', 'mcp', 'design', 'design-review', 'goal', 'loop', 'MCP']) assert.ok(isDenied(n), n);
  for (const n of ['compact', 'context', 'usage', 'review', 'designer-x'.slice(0, 3)]) assert.ok(!isDenied(n), n);
  assert.ok(isDenied('doctor'), 'terminal-only as CLI 2.1.331 lists it, before any init frame');
  assert.ok(!isDenied('statusline'));
  assert.ok(isDenied('statusline', ['statusline']), 'and whatever the init of the session adds');
});

test('resolveCommand: name (builtin first), alias, unique plugin suffix; unknown is null', () => {
  assert.equal(resolveCommand(SDK, 'compact').name, 'compact');
  assert.equal(resolveCommand(SDK, 'context').builtin, true, 'a builtin row wins over a custom one of the same name');
  assert.equal(resolveCommand(SDK, 'cost').name, 'usage');
  assert.equal(resolveCommand(SDK, 'STATS').name, 'usage');
  assert.equal(resolveCommand(SDK, 'frontend-design').name, 'frontend-design:frontend-design');
  assert.equal(resolveCommand(SDK, 'frontend-design:frontend-design').name, 'frontend-design:frontend-design');
  assert.equal(resolveCommand(SDK, 'nope'), null);
  assert.equal(resolveCommand([...SDK, { name: 'other:frontend-design', description: '' }], 'frontend-design'), null, 'two plugins with the name: ambiguous');
  assert.equal(resolveCommand(null, 'compact'), null);
});

test('mergeCommandList: the board first, then the CLI minus what the board answers or refuses', () => {
  const list = mergeCommandList([...SDK, { name: 'statusline', description: '', argumentHint: '', builtin: true }], { terminal: ['statusline'] });
  assert.deepEqual(list.slice(0, BOARD_COMMANDS.length).map((c) => [c.name, c.source]), BOARD_COMMANDS.map((c) => [c.name, 'board']));
  const names = list.map((c) => c.name);
  for (const gone of ['effort', 'design-review', 'doctor', 'statusline']) assert.ok(!names.includes(gone), gone);
  assert.equal(names.filter((n) => n === 'clear').length, 1, 'the CLI\'s /clear is the board\'s');
  assert.equal(names.filter((n) => n === 'model').length, 1);
  assert.equal(names.filter((n) => n === 'context').length, 1, 'a name shown once');
  assert.equal(list.find((c) => c.name === 'compact').source, 'claude');
  assert.equal(list.find((c) => c.name === 'review').source, 'custom');
  assert.deepEqual(list.find((c) => c.name === 'usage').aliases, ['cost', 'stats']);
  assert.deepEqual(mergeCommandList().map((c) => c.source), BOARD_COMMANDS.map(() => 'board'));
});

test('helpText names every board command', () => {
  const text = helpText();
  for (const c of BOARD_COMMANDS) assert.match(text, new RegExp(`/${c.name}\\b`));
});

test('web: the menu opens only on `/` and a name being typed', () => {
  assert.equal(commandQuery('/'), '');
  assert.equal(commandQuery('/Com'), 'com');
  assert.equal(commandQuery('/plugin:x-y'), 'plugin:x-y');
  for (const t of ['', 'hola', '/compact ', '/a/b', ' /x']) assert.equal(commandQuery(t), null, t);
});

test('web: filtering puts the board first, then prefix before substring', () => {
  const list = mergeCommandList(SDK);
  assert.deepEqual(filterCommands(list, '').map((c) => c.name), list.map((c) => c.name));
  assert.deepEqual(filterCommands(list, 'co').map((c) => c.name), ['compact', 'context', 'usage'], 'usage by its alias «cost»');
  const e = filterCommands(list, 'e').map((c) => c.name);
  assert.deepEqual(e.slice(0, 3), ['clear', 'model', 'help'], 'board commands that contain it, still first');
  assert.ok(e.indexOf('review') > e.indexOf('help'));
  assert.deepEqual(filterCommands(list, 'zzz'), []);
});

test('web: picking writes the command and a space; other text stays as its argument', () => {
  assert.equal(commandText({ name: 'compact' }, '/co'), '/compact ');
  assert.equal(commandText({ name: 'compact' }, ''), '/compact ');
  assert.equal(commandText({ name: 'review' }, '  the auth module'), '/review the auth module');
  assert.ok(isClearCommand('/clear') && isClearCommand(' /reset ') && isClearCommand('/NEW'));
  assert.ok(!isClearCommand('/clear now') && !isClearCommand('/clearx') && !isClearCommand('clear'));
  assert.equal(shortDescription('a  b\nc'), 'a b c');
  assert.equal(shortDescription('x'.repeat(100), 10), `${'x'.repeat(9)}…`);
});

test('typedInFull: Enter sends a command that is already typed, and completes one that is not', () => {
  const clear = { name: 'clear', aliases: ['reset', 'new'], source: 'board' };
  const compact = { name: 'compact', source: 'claude' };
  assert.equal(typedInFull(clear, '/clear'), true);
  assert.equal(typedInFull(clear, '  /CLEAR '), true, 'case and surrounding space do not matter');
  assert.equal(typedInFull(clear, '/reset'), true, 'an alias counts');
  assert.equal(typedInFull(clear, '/cle'), false, 'half a name still gets completed');
  assert.equal(typedInFull(compact, '/clear'), false, 'only the highlighted row is looked at');
  assert.equal(typedInFull(clear, '/clear now'), false, 'with arguments the menu is closed anyway');
  assert.equal(typedInFull(null, '/clear'), false);
  assert.equal(typedInFull(clear, ''), false);
});
