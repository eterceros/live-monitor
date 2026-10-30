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
const context = await browser.newContext({ locale: 'es-ES', viewport: { width: 1400, height: 900 } });
const page = await context.newPage();

// The speech engine, as a recorder, before any page script runs.
await page.addInitScript(() => {
  window.__spoken = [];
  window.__cancels = 0;
  const voices = [
    { name: 'Voz de prueba A', lang: 'es-ES', default: true, localService: true, voiceURI: 'a' },
    { name: 'Voz de prueba B', lang: 'es-MX', default: false, localService: true, voiceURI: 'b' },
  ];
  window.SpeechSynthesisUtterance = function Utterance(text) { this.text = text; this.rate = 1; this.voice = null; this.lang = ''; };
  const synth = {
    speaking: false,
    getVoices: () => voices,
    addEventListener() {}, removeEventListener() {},
    speak(u) {
      window.__spoken.push({ text: u.text, rate: u.rate, voice: u.voice?.name ?? null });
      synth.speaking = true;
      // Finishes a moment later, like an engine: the queue moves on by itself.
      setTimeout(() => { synth.speaking = false; u.onend?.(); }, 60);
    },
    cancel() { window.__cancels += 1; synth.speaking = false; },
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  // A recogniser that never hears anything: enough for the support checks.
  window.webkitSpeechRecognition = function Rec() { this.start = () => {}; this.stop = () => {}; this.abort = () => {}; };
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
check('los ajustes ofrecen voz, velocidad, valor por defecto y escuchar «para»',
  /Voz del chat/.test(menuText) && /Velocidad de la voz/.test(menuText) && /Voz en chats nuevos/.test(menuText) && /Escuchar «para»/.test(menuText));
await page.screenshot({ path: path.join(OUT, '05-settings.png') });

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} comprobaciones`);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
