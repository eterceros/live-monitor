import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The browser side of the chat's voice. The rules that decide what is read and
// what silences it are pure (web/src/voice.js); the preferences are per
// browser (localStorage); the wiring is checked against the sources, like the
// other web tests here.

const { splitVoice, speakable, sentences, isStopCommand, detailCommand, detectLang, normalizeSpoken, toUtterances } = await import('../../web/src/voice.js');
const { pickVoice } = await import('../../web/src/useSpeech.js');

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
  assert.deepEqual(toUtterances(['**Hola.** Adiós.']).map((u) => u.text), ['Hola.', 'Adiós.']);
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
  assert.equal(prefs.readVoiceHandsFree(), false, 'el manos libres es opcional');
  prefs.writeVoiceHandsFree(true);
  assert.equal(prefs.readVoiceHandsFree(), true);
});

test('manos libres: el ciclo lo gobierna useHandsFree y el panel solo lo enchufa', () => {
  const loop = src('useHandsFree.js');
  assert.match(loop, /export const PAUSE_MS = /);
  assert.match(loop, /dictation\.lastEnd\.current === 'self'/, 'solo se envía lo que terminó solo o lo que cortó el propio ciclo');
  assert.match(loop, /phase !== 'wait' \|\| !replied \|\| speaking \|\| busy/, 'el micrófono no se reabre mientras el chat trabaja o habla');
  assert.match(loop, /e\.key === 'Escape'/);
  const panel = src('components/ChatPanel.jsx');
  assert.match(panel, /useHandsFree\(\{/);
  assert.match(panel, /handsFree\.phase === 'off' && detailCommand\(text\)/, 'el envío de «más detalle» no se duplica dentro del ciclo');
  assert.match(panel, /else if \(handsFreePref && voiceOn && voiceSupported\) handsFree\.begin\(\)/);
  assert.match(src('useDictation.js'), /lastEnd\.current = 'self'/);
  assert.match(src('components/topbar/SettingsMenu.jsx'), /writeVoiceHandsFree\(!voice\.handsFree\)/);
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

test('isStopCommand: las órdenes de callar valen en los cuatro idiomas, y siempre enteras', () => {
  for (const ok of ['stop', 'enough', 'That\'s enough', 'got it', 'okay stop', 'arrête', 'ça suffit', 'j\'ai compris', 'stopp', 'genug', 'verstanden', 'es reicht']) {
    assert.equal(isStopCommand(ok), true, ok);
  }
  for (const no of ['enough already', 'stop the server', 'je pense que ça suffit pour aujourd\'hui', 'genug Zeit']) {
    assert.equal(isStopCommand(no), false, no);
  }
});

test('detailCommand: más, menos o repetir, enteros y en cuatro idiomas', () => {
  assert.equal(detailCommand('Más detalle.'), 'more');
  assert.equal(detailCommand('dame más detalles'), 'more');
  assert.equal(detailCommand('More detail'), 'more');
  assert.equal(detailCommand('plus de détails'), 'more');
  assert.equal(detailCommand('Mehr Details'), 'more');
  assert.equal(detailCommand('menos detalle'), 'less');
  assert.equal(detailCommand('less detail'), 'less');
  assert.equal(detailCommand('moins de détails'), 'less');
  assert.equal(detailCommand('weniger Details'), 'less');
  assert.equal(detailCommand('repítelo'), 'repeat');
  assert.equal(detailCommand('repeat that'), 'repeat');
  assert.equal(detailCommand('répète'), 'repeat');
  assert.equal(detailCommand('wiederhole das'), 'repeat');
  // Una frase que solo CONTIENE la orden es una pregunta, no la orden.
  for (const no of ['quiero más detalle del segundo punto', 'more detail about the tests', 'hola', '', null]) {
    assert.equal(detailCommand(no), null, String(no));
  }
});

test('detectLang: el idioma de un resumen corto, o nada si no se puede decir', () => {
  assert.equal(detectLang('Encontré el fallo. Ya lo arreglé y pasan los tests.'), 'es');
  assert.equal(detectLang('I found the bug and fixed it, and all the tests pass.'), 'en');
  assert.equal(detectLang('J’ai trouvé le bug et je l’ai corrigé, tout passe.'), 'fr');
  assert.equal(detectLang('Ich habe den Fehler gefunden und behoben.'), 'de');
  assert.equal(detectLang('ok'), null, 'demasiado corto');
  assert.equal(detectLang(''), null);
  const mixed = toUtterances(['Encontré el fallo y lo arreglé.', 'I fixed it and all the tests pass.'], 'es');
  assert.deepEqual(mixed.map((u) => u.lang), ['es', 'en'], 'cada bloque con su idioma');
  assert.equal(toUtterances(['ok'], 'fr')[0].lang, 'fr', 'sin idioma claro, el del navegador');
});

test('pickVoice: la voz elegida solo se usa si habla el idioma del texto', () => {
  const voices = [
    { name: 'Voz A', lang: 'es-ES' }, { name: 'Voz B', lang: 'es-MX' }, { name: 'Voice C', lang: 'en-US' }, { name: 'Voix D', lang: 'fr-FR' },
  ];
  assert.equal(pickVoice(voices, 'Voz B', 'es').name, 'Voz B', 'la elegida y del mismo idioma');
  assert.equal(pickVoice(voices, 'Voz B', 'en').name, 'Voice C', 'leyendo inglés no se usa una voz española');
  assert.equal(pickVoice(voices, '', 'fr').name, 'Voix D', 'sin elección, la primera del idioma');
  assert.equal(pickVoice(voices, 'Voz A', null).name, 'Voz A', 'sin idioma conocido se respeta la elección');
  assert.equal(pickVoice(voices, '', 'de'), null, 'sin voz de ese idioma, decide el navegador');
});

test('el cableado: el micrófono de las órdenes escucha en el idioma del navegador, y lo dictado entero se envía solo', () => {
  const speech = src('useSpeech.js');
  assert.match(speech, /rec\.lang = recognitionLang\(\);/, 'el mismo idioma que el dictado, no uno fijo');
  assert.match(src('useDictation.js'), /rec\.lang = lang \|\| recognitionLang\(\);/);
  assert.match(speech, /if \(detailCommand\(heard\)\) \{ stop\(\); commandRef\.current\?\.\(String\(heard\)\.trim\(\)\); return; \}/);
  const panel = src('components/ChatPanel.jsx');
  assert.match(panel, /onCommand: \(words\) => \{ if \(chat && ready\) onSend\(chat\.id, words, \[\], \{ voice: voiceOnRef\.current && speechSupport\(\) \}\)/);
  assert.match(panel, /wasListening\.current && !dictation\.listening && handsFree\.phase === 'off' && detailCommand\(text\) && ready && !sending && !files\.length\) send\(\)/);
});

test('el toque que enciende el altavoz y el que envía desbloquean la voz del móvil', () => {
  const speech = src('useSpeech.js');
  assert.match(speech, /export function primeSpeech\(\)/);
  assert.match(speech, /word\.volume = 0;/, 'una palabra en silencio: no se oye nada');
  const panel = src('components/ChatPanel.jsx');
  assert.match(panel, /else primeSpeech\(\);/, 'al encenderlo');
  assert.match(panel, /if \(voiceOn && voiceSupported\) primeSpeech\(\);/, 'al enviar con la voz encendida');
});
