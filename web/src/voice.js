// What the chat says aloud, and what stops it. Pure: no DOM, no storage, so the
// rules are testable and the hooks around them stay thin.
//
// In voice mode the chat writes an executive summary inside `<voz>…</voz>` (see
// `server/src/voice.js`); the browser reads only what is inside the tag. The
// rest of the message is for the eyes.

const TAG = /<voz>([\s\S]*?)<\/voz>/gi;
// A `<voz>` that was never closed (a message cut short): its tail is still spoken.
const OPEN_TAIL = /<voz>([\s\S]*)$/i;

/**
 * `{ spoken, text }`: the contents of every `<voz>` block, in order, and the
 * message without them. A message with no tag has nothing to say aloud.
 */
export function splitVoice(text) {
  const source = String(text ?? '');
  const spoken = [];
  let rest = source.replace(TAG, (_, inner) => {
    const clean = inner.trim();
    if (clean) spoken.push(clean);
    return '';
  });
  const tail = OPEN_TAIL.exec(rest);
  if (tail) {
    const clean = tail[1].trim();
    if (clean) spoken.push(clean);
    rest = rest.slice(0, tail.index);
  }
  return { spoken, text: rest.replace(/\n{3,}/g, '\n\n').trim() };
}

/** Markdown out, so the voice does not say «asterisco» or read a URL letter by letter. */
export function speakable(markdown) {
  return String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*~]+/g, '')
    .replace(/[>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Cuts a text into sentences no longer than `max` characters. Browsers stop a
 * long utterance after about fifteen seconds, and one sentence at a time also
 * lets a stop take effect between two of them.
 */
export function sentences(text, max = 200) {
  const out = [];
  for (const piece of String(text ?? '').split(/(?<=[.!?…:;])\s+/)) {
    let rest = piece.trim();
    while (rest.length > max) {
      const cut = rest.lastIndexOf(' ', max);
      const at = cut > 40 ? cut : max;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

/** Lowercase, no accents, no punctuation: how a spoken command is compared. */
export const normalizeSpoken = (s) => String(s ?? '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// What silences the voice. The WHOLE utterance has to be one of these: «para»
// is a very common word, and with loudspeakers the recogniser hears the chat
// itself, so a fragment of its own sentence must never count. Each word is one
// the recogniser has to match, not text anyone reads.
const STOP_PHRASES = new Set([
  'para', // i18n-ok: a word to recognise
  'basta', // i18n-ok: a word to recognise
  'ya basta', // i18n-ok: a word to recognise
  'alto', // i18n-ok: a word to recognise
  'silencio', // i18n-ok: a word to recognise
  'callate', // i18n-ok: a word to recognise
  'ya entendi', // i18n-ok: a word to recognise
  'ya comprendi', // i18n-ok: a word to recognise
  'ya esta', // i18n-ok: a word to recognise
  'es suficiente', // i18n-ok: a word to recognise
  'stop', // i18n-ok: a word to recognise
].map(normalizeSpoken));

/** Whether a final transcript is, as a whole, a request to stop talking. */
export const isStopCommand = (transcript) => STOP_PHRASES.has(normalizeSpoken(transcript));

/** The sentences to say for a list of spoken blocks, ready for the synthesiser. */
export const toUtterances = (blocks) => blocks.flatMap((b) => sentences(speakable(b)));
