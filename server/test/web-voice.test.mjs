import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The browser side of the chat's voice. The rules that decide what is read and
// what silences it are pure (web/src/voice.js); the preferences are per
// browser (localStorage); the wiring is checked against the sources, like the
// other web tests here.

const { splitVoice, speakable, sentences, isStopCommand, normalizeSpoken, toUtterances } = await import('../../web/src/voice.js');

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const prefs = await import('../../web/src/voicePrefs.js');

const src = (p) => readFileSync(new URL(`../../web/src/${p}`, import.meta.url), 'utf8');

test('splitVoice: lo que va en <voz> se habla y el resto queda para los ojos', () => {
  const r = splitVoice('<voz>Encontré el fallo y lo arreglé.</voz>\n\nDetalle: `a.rs` línea 3.\n\n<voz>Falta que decidas.</voz>');
  assert.deepEqual(r.spoken, ['Encontré el fallo y lo arreglé.', 'Falta que decidas.']);
  assert.equal(r.text, 'Detalle: `a.rs` línea 3.');
  assert.deepEqual(splitVoice('Solo texto, sin etiqueta.').spoken, [], 'sin etiqueta no hay nada que decir en voz alta');
  assert.equal(splitVoice('Solo texto.').text, 'Solo texto.');
  assert.deepEqual(splitVoice('Antes. <voz>Se cortó a medias').spoken, ['Se cortó a medias'], 'una etiqueta sin cerrar también se habla');
  assert.deepEqual(splitVoice('<voz>  </voz>x').spoken, [], 'una etiqueta vacía no dice nada');
});

test('speakable: ni asteriscos, ni código, ni direcciones', () => {
  assert.equal(speakable('**Listo**: mira [el PR](https://github.com/x/y/pull/1) y `cargo test`.'), 'Listo: mira el PR y cargo test.');
  assert.equal(speakable('Antes\n```rust\nfn main() {}\n```\nDespués'), 'Antes Después');
  assert.equal(speakable('- uno\n- dos'), 'uno dos');
});

test('sentences: trozos cortos que el navegador no corta, y nunca partidos a media palabra', () => {
  const long = `${'palabra '.repeat(60)}fin.`;
  const parts = sentences(long, 100);
  assert.ok(parts.every((p) => p.length <= 100));
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), long.replace(/\s+/g, ' '));
  assert.deepEqual(sentences('Una. Dos! ¿Tres?'), ['Una.', 'Dos!', '¿Tres?']);
  assert.deepEqual(toUtterances(['**Hola.** Adiós.']), ['Hola.', 'Adiós.']);
});

test('isStopCommand: la frase ENTERA tiene que ser una orden de callar', () => {
  for (const ok of ['para', 'Para.', 'basta', '¡Basta!', 'ya entendí', 'Ya comprendí', 'silencio', 'cállate', 'stop']) {
    assert.equal(isStopCommand(ok), true, ok);
  }
  // «para» es una palabra corriente y con altavoces el micrófono oye al propio chat:
  // un trozo de una frase suya no puede contar.
  for (const no of ['para que funcione', 'lo hice para ti', 'más detalle', 'no pares', '', null, 'ya entendí lo que hace']) {
    assert.equal(isStopCommand(no), false, String(no));
  }
  assert.equal(normalizeSpoken('  ¡Ya   Entendí! '), 'ya entendi');
});

test('preferencias por navegador: cada chat con su altavoz, y el valor por defecto para los demás', () => {
  store.clear();
  assert.equal(prefs.readVoiceOn('c1'), false, 'apagado de serie');
  prefs.writeVoiceOn('c1', true);
  assert.equal(prefs.readVoiceOn('c1'), true);
  assert.equal(prefs.readVoiceOn('c2'), false, 'otro chat no cambia');
  prefs.writeVoiceDefault(true);
  assert.equal(prefs.readVoiceOn('c2'), true, 'un chat sin decisión propia sigue al valor por defecto');
  prefs.writeVoiceOn('c1', false);
  assert.equal(prefs.readVoiceOn('c1'), false, 'la decisión propia gana al valor por defecto');
});

test('preferencias: velocidad solo de las que se ofrecen, voz libre, escucha apagada de serie', () => {
  store.clear();
  assert.equal(prefs.readVoiceRate(), 1);
  prefs.writeVoiceRate(1.5);
  assert.equal(prefs.readVoiceRate(), 1.5);
  prefs.writeVoiceRate(9);
  assert.equal(prefs.readVoiceRate(), 1.5, 'un valor que no se ofrece no se guarda');
  store.set('hfsmon-voice-rate', '7');
  assert.equal(prefs.readVoiceRate(), 1, 'ni se lee');
  assert.equal(prefs.readVoiceName(), '');
  prefs.writeVoiceName('Microsoft Helena');
  assert.equal(prefs.readVoiceName(), 'Microsoft Helena');
  assert.equal(prefs.readVoiceListen(), false, 'escuchar «para» mientras habla es opcional');
  prefs.writeVoiceListen(true);
  assert.equal(prefs.readVoiceListen(), true);
});

test('el recorte de chats recordados no crece sin límite', () => {
  store.clear();
  for (let i = 0; i < 130; i += 1) prefs.writeVoiceOn(`chat-${i}`, true);
  const kept = JSON.parse(store.get('hfsmon-voice-chats'));
  assert.equal(Object.keys(kept).length, 100);
  assert.equal('chat-0' in kept, false, 'los más antiguos se van primero');
  assert.equal('chat-129' in kept, true);
});

test('el cableado: altavoz junto al micro, marca de voz al enviar y solo se habla lo que llega ahora', () => {
  const panel = src('components/ChatPanel.jsx');
  assert.match(panel, /<MicButton[\s\S]*?\/>\s*\{voiceSupported && \(/, 'el altavoz va justo después del micrófono');
  assert.match(panel, /onSend\(chat\.id, body \|\| t\.chat\.panel\.defaultPrompt, uploaded, \{ voice: voiceOn && voiceSupported \}\)/);
  // Hablar solo desde el evento de mensajes vivos, nunca al cargar el historial.
  assert.match(panel, /const onChat = [\s\S]*?voiceOnRef\.current && said\?\.role === 'assistant'[\s\S]*?speechRef\.current\.speak\(spoken\)/);
  assert.match(panel, /e\.key === 'Escape'/, 'Esc calla la voz');
  const api = src('api.js');
  assert.match(api, /sendChat\(owner, chatId, text, attachments = \[\], \{ voice = false \} = \{\}\)/);
  assert.match(api, /if \(voice\) msg\.voice = true/);
  assert.match(src('App.jsx'), /onSend=\{\(chatId, text, attachments, options\) =>\s*wsRef\.current\?\.sendChat\(chatTask, chatId, text, attachments, options\)\}/);
});

test('el resumen hablado se pinta aparte y sus etiquetas no llegan a la pantalla', () => {
  const bubbles = src('components/chat/ChatBubbles.jsx');
  assert.match(bubbles, /splitVoice\(m\.text\)/);
  assert.match(bubbles, /className="cb-voice"/);
  assert.match(bubbles, /voice \? \(voice\.text \? <Markdown text=\{voice\.text\} \/> : null\) : m\.text/);
});

test('los ajustes de voz solo salen si el navegador sabe hablar, sin tocar los controles segmentados', () => {
  const menu = src('components/topbar/SettingsMenu.jsx');
  assert.match(menu, /\{speechSupport\(\) && \(/);
  assert.equal((menu.match(/<SegmentedControl/g) ?? []).length, 3, 'la velocidad y la voz son desplegables, no un cuarto control segmentado');
  assert.match(menu, /writeVoiceDefault\(!voice\.isDefault\)/);
  assert.match(menu, /writeVoiceListen\(!voice\.listen\)/);
});
