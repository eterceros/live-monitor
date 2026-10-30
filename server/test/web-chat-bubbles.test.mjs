import './isolate.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import es from '../../web/src/i18n/strings/es.js';
const E = (p) => { const v = p.split('.').reduce((o, k) => o?.[k], es); assert.equal(typeof v, 'string', `missing es key ${p}`); return v; };

// The web has no browser runner: these read the source as text.
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const src = read('web', 'src', 'components', 'chat', 'ChatBubbles.jsx');
const css = read('web', 'src', 'styles', 'chat-bubbles.css');

test('the five bubbles ChatPanel calls are exported by name', () => {
  for (const name of ['PendingBubble', 'TaskPlanBubble', 'MessageBubble', 'ThinkingBubble', 'DayDivider']) {
    assert.match(src, new RegExp(`export function ${name}\\(`), name);
  }
});

test('the publish question is recognised and worded as its own', () => {
  assert.match(src, /isPublishQuestion\(m\.questions\)/);
  assert.match(src, /publishTarget\(m\.questions\)/);
  // «no se publicó» only for an expired publish question, never for another one.
  assert.match(src, /m\.status === 'expired'\) statusText = PUBLISH_COPY\.unanswered/);
  assert.match(src, /alert-triangle/);
});

test('a waiting question says so and offers Responder in amber', () => {
  assert.match(src, /t\.chat\.bubbles\.qStatus\[m\.status\]/);
  assert.equal(E('chat.bubbles.qStatus.pending'), 'esperando tu respuesta');
  assert.match(src, /btn btn-amber btn-sm[^>]*onClick=\{onOpen\}[^<]*>\{isQ \? t\.chat\.bubbles\.answer/);
  assert.equal(E('chat.bubbles.answer'), 'Responder');
  assert.doesNotMatch(src, /'Responder'|esperando tu respuesta/);
  // Only when this very message is the live one.
  assert.match(src, /const live = Boolean\(pending && pending\.messageId === m\.id\)/);
  assert.match(src, /\{live && <button/);
});

test('answers read «header → answer»', () => {
  assert.match(src, /<b>\{q\.header\}<\/b> → \{join\(m\.answers\[q\.question\]\)\}/);
});

test('only Claude is rendered as Markdown, and you sit in a neutral bubble', () => {
  // Claude's `<voz>` summaries come out first (see voice.js); what is left is still Markdown, and yours stays plain.
  assert.match(src, /voice \? \(voice\.text \? <Markdown text=\{voice\.text\} \/> : null\) : m\.text/);
  assert.match(src, /const voice = m\.role === 'assistant' \? splitVoice\(m\.text\) : null/);
  assert.equal((src.match(/<Markdown /g) ?? []).length, 1);
  assert.match(css, /\.cb-user \{[^}]*background: var\(--surface-3\)/);
  assert.doesNotMatch(css, /tint-live|info-border/, 'cyan is for what is live, not for your messages');
});

test('no old aliases in the bubbles', () => {
  assert.doesNotMatch(src, /answer-btn/);
  assert.doesNotMatch(src, /className="stop /);
});

test('a waiting board card carries the amber stripe', () => {
  assert.match(css, /\.cb-board--wait \{[^}]*color-mix\(in srgb, var\(--amber\) 8%, var\(--card\)\)/);
  assert.match(css, /inset 3px 0 0 var\(--amber\)/);
});

test('a pending question that is not the live one stays at rest', () => {
  assert.match(src, /<BoardCard tone=\{live \? 'wait' : 'rest'\}/);
});
