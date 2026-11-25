import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The chat's «Vaciar» button, `/clear`, and the slash-command menu. The web has
// no test runner: the wiring is read as text so a refactor cannot quietly drop
// one of the pieces. The menu's filtering is tested as code in chatcommands.test.mjs.

const src = (p) => readFileSync(new URL(`../../web/src/${p}`, import.meta.url), 'utf8');
const panel = src('components/ChatPanel.jsx');
const menu = src('components/chat/CommandMenu.jsx');

test('api and App: clearChat, chatCommands and the chat-reset frame', () => {
  const api = src('api.js');
  assert.match(api, /clearChat: \(owner, chatId\) => send\(`\$\{B\(owner\)\}\/chats\/\$\{chatId\}\/clear`\)/);
  assert.match(api, /chatCommands: \(owner, chatId\) => get\(`\$\{B\(owner\)\}\/chats\/\$\{chatId\}\/commands`\)/);
  assert.match(src('App.jsx'), /'chat-reset': \(msg\) => window\.dispatchEvent\(new CustomEvent\('task-chat-reset'/);
});

test('ChatPanel: an emptied chat drops its messages, on this device and on the others', () => {
  assert.match(panel, /const onReset = \(ev\) => \{\s*if \(mine\(ev\)\) setMessages\(\[\]\);/);
  assert.match(panel, /addEventListener\('task-chat-reset', onReset\)/);
  assert.match(panel, /removeEventListener\('task-chat-reset', onReset\)/);
});

test('ChatPanel: «Vaciar» and a typed /clear ask the same question and call the route, not the socket', () => {
  assert.match(panel, /className="btn btn-icon btn-sm cp-clear-chat"/);
  assert.match(panel, /disabled=\{!chat \|\| chat\.busy \|\| !chat\.messageCount\}\s*onClick=\{\(\) => emptyChat\(chat\)\}/);
  const empty = panel.slice(panel.indexOf('const emptyChat'), panel.indexOf('// Rename a conversation'));
  assert.match(empty, /await ask\(/);
  assert.match(empty, /api\.clearChat\(task, c\.id\)/);
  assert.match(empty, /isTaskMain\(c\) \? t\.chat\.panel\.clearChatMain/);
  const send = panel.slice(panel.indexOf('const send = async'), panel.indexOf('setSending(true)'));
  assert.match(send, /if \(isClearCommand\(body\) && !files\.length\) \{\s*if \(await emptyChat\(chat\)\) setText\(''\);\s*return;/);
});

test('ChatPanel: the menu has the keys before Enter sends, and a «/» button after the clip', () => {
  const keys = panel.slice(panel.indexOf('// The command menu, while it is open'), panel.indexOf("if (e.key !== 'Enter') return;"));
  for (const k of ['Escape', 'ArrowDown', 'ArrowUp', 'Tab', 'Enter']) assert.match(keys, new RegExp(`'${k}'`), k);
  assert.match(keys, /pickCommand\(/);
  assert.match(keys, /typedInFull\(row, text\)/, 'Enter sends a command that is already typed in full');
  assert.match(keys, /closeMenu\(\)/);
  const clip = panel.indexOf('<Icon name="paperclip" /></button>');
  const slash = panel.indexOf('<Icon name="slash" /></button>');
  assert.ok(clip > 0 && slash > clip && slash - clip < 900, 'the «/» button sits right after the attach button');
  assert.match(panel, /aria-activedescendant=\{menuOpen && menuItems\.length/);
  assert.match(panel, /api\.chatCommands\(task, id\)/);
});

test('CommandMenu: a listbox of options, clicks that keep the focus in the box', () => {
  assert.match(menu, /role="listbox"/);
  assert.match(menu, /role="option"/);
  assert.match(menu, /aria-selected=\{i === active\}/);
  assert.match(menu, /onMouseDown=\{\(e\) => e\.preventDefault\(\)\}/);
  assert.match(menu, /id=\{`\$\{id\}-\$\{i\}`\}/);
});
