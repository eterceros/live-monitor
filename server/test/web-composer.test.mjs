import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The chat's input box: Escape stops a dictation and keeps its text, typing over
// a dictation makes the microphone step aside, and a ✕ empties the box (text,
// attachments and the dictation) with a few seconds to undo it. The behaviour is
// tried in a real browser by tools/voice-e2e; these pin the wiring so a refactor
// cannot quietly drop one of the pieces.

const src = (p) => readFileSync(new URL(`../../web/src/${p}`, import.meta.url), 'utf8');
const panel = src('components/ChatPanel.jsx');

test('Esc deja de grabar en el chat, igual que en los diálogos', () => {
  assert.match(panel, /import \{ useDictation, dictationSupport, useStopDictationOnEscape \} from '\.\.\/useDictation\.js'/);
  assert.match(panel, /useStopDictationOnEscape\(dictation\);/);
  // El gancho para (con stop, que conserva lo oído) y no aborta.
  assert.match(src('useDictation.js'), /e\.stopPropagation\(\);\s*dictation\.stop\(\);/);
});

test('teclear sobre un dictado corta el micrófono sin escribir nada más', () => {
  assert.match(panel, /if \(dictation\.listening && !e\.nativeEvent\.isComposing/);
  assert.match(panel, /e\.key === 'Backspace' \|\| e\.key === 'Delete'[\s\S]*?dictation\.abort\(\);/, 'aborta: un stop educado entregaría un último resultado encima de lo tecleado');
  assert.match(panel, /e\.key\.length === 1 && !e\.ctrlKey && !e\.metaKey && !e\.altKey/, 'un atajo de teclado no cuenta como teclear');
});

test('la ✕ vacía la caja cortando antes el micrófono, y se puede deshacer unos segundos', () => {
  assert.match(panel, /const CLEAR_UNDO_MS = 8000;/);
  const clear = panel.slice(panel.indexOf('const clearComposer'), panel.indexOf('const undoClear'));
  assert.ok(clear.indexOf('dictation.abort()') < clear.indexOf("setText('')"), 'primero el micrófono: si no, su siguiente resultado repone el texto');
  assert.match(clear, /setFiles\(\[\]\)/, 'también los adjuntos');
  assert.match(panel, /setCleared\(\{ text, files \}\)/);
  assert.match(panel, /const undoClear = \(\) => \{[\s\S]*?setText\(cleared\.text\);[\s\S]*?setFiles\(cleared\.files\);/);
  // Lo que se teclea después, o salir del chat, deja de ofrecer el deshacer.
  assert.match(panel, /useEffect\(\(\) => \{ if \(cleared && text\) dropUndo\(\); \}, \[text\]\)/);
  assert.match(panel, /useEffect\(\(\) => \{ dropUndo\(\); \}, \[chat\?\.id\]\)/);
});

test('la ✕ solo aparece cuando hay algo que borrar, y el deshacer se dice con estado', () => {
  assert.match(panel, /\{\(text \|\| files\.length > 0 \|\| dictation\.listening\) && \(\s*<button type="button" className="btn btn-icon btn-sm cp-clear"/);
  assert.match(panel, /<div className="cp-undo" role="status">/);
});
