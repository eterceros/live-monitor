import './isolate.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Voice mode of a chat. The preference is the browser's; the board only adds a
// rule to a message that says it is spoken. Server side: the rule, and that a
// message typed while the chat works keeps its voice mark until the next turn.

const { VOICE_RULE, VOICE_MAX_WORDS, withVoiceRule } = await import('../src/voice.js');
const { leaveNote, drainNotes } = await import('../src/chats.js');

test('la regla de voz pide un resumen hablado en <voz>, por capas, con avisos de progreso', () => {
  assert.match(VOICE_RULE, /<voz>…<\/voz>/);
  assert.match(VOICE_RULE, new RegExp(`${VOICE_MAX_WORDS} palabras`));
  assert.match(VOICE_RULE, /más detalle/i);
  assert.match(VOICE_RULE, /menos detalle/i);
  assert.match(VOICE_RULE, /hito/i, 'avisa en cada hito');
  assert.match(VOICE_RULE, /cómo va/i, 'contesta hablando cuando le preguntan cómo va');
  assert.match(VOICE_RULE, /NO se lee en voz alta/, 'el detalle solo se muestra');
});

test('withVoiceRule: solo un turno marcado como de voz lleva la regla, y al final', () => {
  const rules = 'Pregunta del usuario\n[Reglas del entorno]';
  assert.equal(withVoiceRule(rules, false), rules);
  assert.equal(withVoiceRule(rules, undefined), rules);
  assert.equal(withVoiceRule(rules, 'sí'), rules, 'solo true exacto');
  const spoken = withVoiceRule(rules, true);
  assert.ok(spoken.startsWith(rules));
  assert.ok(spoken.endsWith(VOICE_RULE));
});

test('un mensaje de voz que espera a que acabe el turno conserva su marca', () => {
  const chat = {};
  leaveNote(chat, 'hola', 'm1', [], { voice: true });
  leaveNote(chat, 'adiós', 'm2');
  const notes = drainNotes(chat);
  assert.equal(notes[0].voice, true);
  assert.equal('voice' in notes[1], false, 'sin marca no se guarda nada');
  assert.deepEqual(chat.notes, []);
});

test('la regla de voz responde en el idioma en que le hablan y conoce las órdenes en otros idiomas', () => {
  assert.match(VOICE_RULE, /Contesta en el idioma en que te hablan/);
  for (const phrase of ['more detail', 'plus de détails', 'mehr Details', 'less detail', 'repeat that']) {
    assert.ok(VOICE_RULE.includes(phrase), phrase);
  }
});
