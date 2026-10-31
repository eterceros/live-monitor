// Drives the voice feature in a real Chromium against a throwaway board.
// A headless browser has no voices and no microphone, so the speech engine is a
// recorder: what is checked is the wiring (what is spoken, when, what is sent,
// what is stored), not how it sounds.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.E2E_PLAYWRIGHT);
const BASE = process.env.E2E_URL;
const CHAT_ID = process.env.E2E_CHAT_ID;
const OUT = process.env.E2E_OUT;
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

const browser = await chromium.launch({ headless: true });
// `--mobile` runs it at the size and with the touch of a phone: the same page, narrower.
const MOBILE = process.env.E2E_MOBILE === '1';
const context = await browser.newContext(MOBILE
  ? { locale: 'es-ES', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
  : { locale: 'es-ES', viewport: { width: 1400, height: 900 } });
const page = await context.newPage();

// The speech engine, as a recorder, before any page script runs.
await page.addInitScript(() => {
  window.__spoken = [];
  window.__cancels = 0;
  const voices = [
    { name: 'Voz de prueba A', lang: 'es-ES', default: true, localService: true, voiceURI: 'a' },
    { name: 'Voz de prueba B', lang: 'es-MX', default: false, localService: true, voiceURI: 'b' },
    { name: 'Test voice EN', lang: 'en-US', default: false, localService: true, voiceURI: 'c' },
  ];
  window.SpeechSynthesisUtterance = function Utterance(text) { this.text = text; this.rate = 1; this.voice = null; this.lang = ''; };
  const synth = {
    speaking: false,
    getVoices: () => voices,
    addEventListener() {}, removeEventListener() {},
    speak(u) {
      // The silent word that unlocks a phone's synthesiser is counted apart: it is not something the chat said.
      if (!u.text.trim()) { window.__primed = (window.__primed ?? 0) + 1; return; }
      window.__spoken.push({ text: u.text, rate: u.rate, voice: u.voice?.name ?? null });
      synth.speaking = true;
      // Finishes a moment later, like an engine: the queue moves on by itself.
      setTimeout(() => { synth.speaking = false; u.onend?.(); }, 60);
    },
    cancel() { window.__cancels += 1; synth.speaking = false; },
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  // A recogniser the test speaks through: `window.__recs.at(-1)` is the live one.
  window.__recs = [];
  window.webkitSpeechRecognition = function Rec() {
    this.start = () => { this.started = true; };
    this.stop = () => { this.stopped = true; setTimeout(() => this.onend?.(), 0); };
    this.abort = () => { this.aborted = true; setTimeout(() => this.onend?.(), 0); };
    window.__recs.push(this);
  };
});

// Everything the browser sends to the board is recorded; chat messages are NOT
// forwarded (no Claude is started) and the board's reply is injected by the test.
const sent = [];
let toPage = null;
await page.routeWebSocket(/\/ws/, (ws) => {
  const server = ws.connectToServer();
  toPage = (frame) => ws.send(JSON.stringify(frame));
  server.onMessage((m) => ws.send(m));
  ws.onMessage((m) => {
    let parsed = null;
    try { parsed = JSON.parse(m); } catch { /* not JSON */ }
    if (parsed?.type === 'chat') { sent.push(parsed); return; }
    server.send(m);
  });
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.screenshot({ path: path.join(OUT, '01-board.png') });

// Open the task's chat: the card has a chat button.
// The TASK chat (not the project chat of the top bar): the button inside the task's card.
const chatBtn = page.locator('button.tcw-chat').first();
await chatBtn.waitFor({ timeout: 15000 });
await chatBtn.click();
await page.waitForSelector('.cp-tools', { timeout: 15000 });
await page.screenshot({ path: path.join(OUT, '02-chat-open.png') });

const speaker = page.locator('button.speaker');
check('el altavoz sale junto al micrófono', (await speaker.count()) === 1);
check('empieza apagado y sin pulsar', (await speaker.getAttribute('aria-pressed')) === 'false');

// Order in the composer row: mic, then speaker.
const order = await page.evaluate(() => [...document.querySelectorAll('.cp-tools > button')].map((b) => b.className.includes('speaker') ? 'speaker' : b.className.includes('mic') ? 'mic' : 'other'));
check('el altavoz va justo después del micrófono', order.indexOf('speaker') === order.indexOf('mic') + 1, order.join(','));

// A reply arriving while the speaker is OFF is not spoken.
const chat = { type: 'chat', project: 'voz', issue: 77, chatId: CHAT_ID };
toPage({ ...chat, message: { id: 'a1', role: 'assistant', text: '<voz>Esto no debe oírse.</voz>\n\nDetalle uno.', ts: new Date().toISOString() } });
await page.waitForTimeout(400);
check('apagado: no habla', (await page.evaluate(() => window.__spoken.length)) === 0);
check('apagado: el resumen se ve igual, destacado y sin etiquetas', (await page.locator('.cb-voice').count()) === 1
  && !(await page.locator('.cb-claude').first().innerText()).includes('<voz>'));

// Turn it on.
await speaker.click();
check('al pulsar queda encendido', (await speaker.getAttribute('aria-pressed')) === 'true');
check('el toque que lo enciende desbloquea la voz del móvil (palabra en silencio)', (await page.evaluate(() => window.__primed ?? 0)) >= 1);

// Sending carries the voice mark.
await page.locator('textarea').first().fill('Cuéntame cómo va');
await page.getByRole('button', { name: /enviar|send/i }).last().click();
await page.waitForTimeout(300);
check('el mensaje sale con voice: true', sent.length === 1 && sent[0].voice === true && sent[0].text === 'Cuéntame cómo va', JSON.stringify(sent[0] ?? null));

// A live reply is spoken: only the summary, not the detail.
toPage({ ...chat, message: { id: 'a2', role: 'assistant', text: '<voz>Encontré el fallo. Ya lo arreglé y pasan los tests.</voz>\n\nDetalle largo con `código` que no se lee.', ts: new Date().toISOString() } });
await page.waitForTimeout(700);
const spoken = await page.evaluate(() => window.__spoken.map((s) => s.text));
check('habla solo el resumen, por frases', spoken.join('|') === 'Encontré el fallo.|Ya lo arreglé y pasan los tests.', spoken.join('|'));
check('el detalle no se oye', !spoken.some((s) => /Detalle|código/.test(s)));
await page.screenshot({ path: path.join(OUT, '03-spoken-summary.png') });

if (MOBILE) {
  // On a phone the rest is the same page: what matters is that the speaker is there, can be tapped and speaks.
  await page.screenshot({ path: path.join(OUT, '03-mobile-spoken.png') });
  const box = await speaker.boundingBox();
  check('móvil: el altavoz cabe en pantalla y es tocable', box && box.x >= 0 && box.x + box.width <= 390 && box.width >= 32 && box.height >= 32, JSON.stringify(box));
  await browser.close();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} comprobaciones`);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(bad.length ? 1 : 0);
}

// A message with no tag says nothing.
const before = (await page.evaluate(() => window.__spoken.length));
toPage({ ...chat, message: { id: 'a3', role: 'assistant', text: 'Respuesta sin resumen hablado.', ts: new Date().toISOString() } });
await page.waitForTimeout(400);
check('sin etiqueta no se lee nada', (await page.evaluate(() => window.__spoken.length)) === before);

// Esc silences it.
toPage({ ...chat, message: { id: 'a4', role: 'assistant', text: `<voz>${'Una frase larga para que dure. '.repeat(8)}</voz>`, ts: new Date().toISOString() } });
await page.waitForSelector('button.speaker-stop', { timeout: 3000 }).catch(() => {});
const cancelsBefore = await page.evaluate(() => window.__cancels);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('Esc calla la voz (cancela la síntesis)', (await page.evaluate(() => window.__cancels)) > cancelsBefore);

// The choice is kept in THIS browser, per chat.
const stored = await page.evaluate(() => localStorage.getItem('hfsmon-voice-chats'));
check('la elección se guarda en el navegador', JSON.parse(stored ?? '{}')[CHAT_ID] === true, stored);
await page.reload({ waitUntil: 'networkidle' });
await page.locator('button.tcw-chat').first().click();
await page.waitForSelector('button.speaker', { timeout: 15000 });
check('tras recargar sigue encendido', (await page.locator('button.speaker').getAttribute('aria-pressed')) === 'true');
await page.screenshot({ path: path.join(OUT, '04-after-reload.png') });

// What is dictated, typed and cleared in the box.
const box = page.locator('textarea').first();
const mic = page.locator('button.mic').first();
// A final result, as a recogniser gives it once the speaker has paused.
const say = (words) => page.evaluate((w) => {
  const result = [{ transcript: w }];
  result.isFinal = true;
  window.__recs.at(-1).onresult({ resultIndex: 0, results: [result] });
}, words);
await box.fill('');
check('con la caja vacía no hay ✕', (await page.locator('button.cp-clear').count()) === 0);

await mic.click();
await say('hola mundo');
check('el dictado llega a la caja', (await box.inputValue()) === 'hola mundo', await box.inputValue());
check('con texto aparece la ✕', (await page.locator('button.cp-clear').count()) === 1);
await box.focus();
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
check('Esc deja de grabar', (await mic.getAttribute('aria-pressed')) === 'false');
check('Esc conserva lo dictado', (await box.inputValue()) === 'hola mundo', await box.inputValue());

await mic.click();
await say('segunda parte');
await box.focus();
await page.keyboard.press('x');
await page.waitForTimeout(150);
check('teclear sobre un dictado corta el micrófono', (await mic.getAttribute('aria-pressed')) === 'false'
  && (await page.evaluate(() => window.__recs.at(-1).aborted === true)));
const typed = await box.inputValue();
check('lo tecleado no se pisa', typed.includes('x') && typed.startsWith('hola mundo'), typed);

await page.screenshot({ path: path.join(OUT, '06-with-clear-button.png') });
await page.locator('button.cp-clear').click();
check('la ✕ vacía la caja', (await box.inputValue()) === '');
check('ofrece deshacer', (await page.locator('.cp-undo button').count()) === 1);
await page.screenshot({ path: path.join(OUT, '06-cleared-undo.png') });
await page.locator('.cp-undo button').click();
check('deshacer devuelve lo borrado', (await box.inputValue()) === typed && (await page.locator('.cp-undo').count()) === 0, await box.inputValue());

await mic.click();
await page.locator('button.cp-clear').click();
check('la ✕ también corta un dictado en curso', (await mic.getAttribute('aria-pressed')) === 'false'
  && (await box.inputValue()) === ''
  && (await page.evaluate(() => window.__recs.at(-1).aborted === true)));
check('sin texto y sin dictado desaparece la ✕', (await page.locator('button.cp-clear').count()) === 0);

// A dictated whole command is sent by itself when the dictation ends; anything else is not.
sent.length = 0;
await box.fill('');
await mic.click();
await say('hola, solo estoy dictando');
await box.focus();
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('un dictado cualquiera NO se envía solo', sent.length === 0 && (await box.inputValue()) === 'hola, solo estoy dictando');
await box.fill('');
await mic.click();
await say('más detalle');
await box.focus();
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
check('«más detalle» dictado se envía solo, con la marca de voz', sent.length === 1 && sent[0].text === 'más detalle' && sent[0].voice === true, JSON.stringify(sent[0] ?? null));
check('y la caja queda vacía', (await box.inputValue()) === '');
sent.length = 0;
await mic.click();
await say('More detail');
await box.focus();
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
check('«More detail» en inglés también', sent.length === 1 && sent[0].text === 'More detail', JSON.stringify(sent[0] ?? null));

// The voice follows the language of what it reads.
await page.evaluate(() => { window.__spoken.length = 0; });
toPage({ ...chat, message: { id: 'e1', role: 'assistant', text: '<voz>I found the bug and fixed it, and all the tests pass.</voz>', ts: new Date().toISOString() } });
await page.waitForTimeout(500);
const english = await page.evaluate(() => window.__spoken.map((s) => s.voice));
check('un resumen en inglés lo lee una voz inglesa', english.length > 0 && english.every((v) => v === 'Test voice EN'), english.join('|'));
await page.evaluate(() => { window.__spoken.length = 0; });
toPage({ ...chat, message: { id: 'e2', role: 'assistant', text: '<voz>Encontré el fallo y ya lo arreglé, pasan todos los tests.</voz>', ts: new Date().toISOString() } });
await page.waitForTimeout(500);
const spanish = await page.evaluate(() => window.__spoken.map((s) => s.voice));
check('y uno en español, una voz española', spanish.length > 0 && spanish.every((v) => /^Voz de prueba/.test(v)), spanish.join('|'));

// Voice commands while it talks (the switch is off by default: turned on here).
await page.evaluate(() => localStorage.setItem('hfsmon-voice-listen', 'true'));
await page.evaluate(() => { window.__spoken.length = 0; window.__cancels = 0; });
const long = `<voz>${'Una frase larga que sigue sonando mientras se escucha. '.repeat(10)}</voz>`;
toPage({ ...chat, message: { id: 'l1', role: 'assistant', text: long, ts: new Date().toISOString() } });
await page.waitForTimeout(250);
check('mientras habla, el micrófono de las órdenes está escuchando', (await page.evaluate(() => window.__recs.at(-1).started === true)));
await say('para');
await page.waitForTimeout(250);
check('«para» entero lo calla', (await page.evaluate(() => window.__cancels)) >= 1);
sent.length = 0;
toPage({ ...chat, message: { id: 'l2', role: 'assistant', text: long, ts: new Date().toISOString() } });
await page.waitForTimeout(250);
await page.evaluate(() => { window.__cancels = 0; });
await say('menos detalle');
await page.waitForTimeout(350);
check('«menos detalle» lo calla y se envía solo', (await page.evaluate(() => window.__cancels)) >= 1 && sent.length === 1 && sent[0].text === 'menos detalle' && sent[0].voice === true, JSON.stringify(sent[0] ?? null));
toPage({ ...chat, message: { id: 'l3', role: 'assistant', text: long, ts: new Date().toISOString() } });
await page.waitForTimeout(250);
await page.evaluate(() => { window.__cancels = 0; });
await say('para que funcione bien');
await page.waitForTimeout(250);
check('una frase que solo contiene «para» no lo calla', (await page.evaluate(() => window.__cancels)) === 0);
await page.keyboard.press('Escape');
await page.evaluate(() => localStorage.removeItem('hfsmon-voice-listen'));

// Hands-free: one tap on the microphone, the pause sends, the reply is said, the microphone reopens by itself.
await page.evaluate(() => { localStorage.setItem('hfsmon-voice-handsfree', 'true'); window.dispatchEvent(new Event('hfsmon-voice-changed')); });
sent.length = 0;
await box.fill('');
await mic.click();
const recsBefore = await page.evaluate(() => window.__recs.length);
await say('cómo va el proyecto');
check('manos libres: no envía mientras sigues hablando', sent.length === 0);
await page.waitForTimeout(2400);
check('manos libres: la pausa cierra el turno y lo envía solo, con la marca de voz', sent.length === 1 && sent[0].text === 'cómo va el proyecto' && sent[0].voice === true, JSON.stringify(sent[0] ?? null));
check('manos libres: el micrófono no se reabre antes de la respuesta', (await page.evaluate(() => window.__recs.length)) === recsBefore);
toPage({ ...chat, message: { id: 'hf1', role: 'assistant', text: '<voz>Todo va bien.</voz>\n\nDetalle largo.', ts: new Date().toISOString() } });
await page.waitForTimeout(1500);
check('manos libres: tras decir la respuesta, el micrófono se abre solo', (await page.evaluate(() => window.__recs.length)) === recsBefore + 1
  && (await page.evaluate(() => window.__recs.at(-1).started === true)) && (await mic.getAttribute('aria-pressed')) === 'true');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('manos libres: Esc corta el micrófono', (await mic.getAttribute('aria-pressed')) === 'false');
toPage({ ...chat, message: { id: 'hf2', role: 'assistant', text: '<voz>Otra cosa.</voz>', ts: new Date().toISOString() } });
await page.waitForTimeout(1500);
check('manos libres: roto el ciclo con Esc, no se reabre', (await mic.getAttribute('aria-pressed')) === 'false');
await page.evaluate(() => { localStorage.removeItem('hfsmon-voice-handsfree'); window.dispatchEvent(new Event('hfsmon-voice-changed')); });

// Turning it off: sends without the mark and stops speaking.
await page.locator('button.speaker').click();
sent.length = 0;
await page.locator('textarea').first().fill('Otra pregunta');
await page.getByRole('button', { name: /enviar|send/i }).last().click();
await page.waitForTimeout(300);
check('apagado: el mensaje sale sin la marca de voz', sent.length === 1 && !('voice' in sent[0]), JSON.stringify(sent[0] ?? null));

// Settings: the voice rows are there.
await page.getByRole('button', { name: /ajustes|settings/i }).first().click().catch(() => {});
await page.waitForTimeout(400);
const menuText = await page.locator('body').innerText();
check('los ajustes ofrecen voz, velocidad, valor por defecto y órdenes de voz',
  /Voz del chat/.test(menuText) && /Velocidad de la voz/.test(menuText) && /Voz en chats nuevos/.test(menuText) && /Órdenes de voz/.test(menuText) && /Conversación manos libres/.test(menuText));
await page.screenshot({ path: path.join(OUT, '05-settings.png') });

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} comprobaciones`);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
