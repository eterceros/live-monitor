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
  .replace(/['’]/g, '')           // an apostrophe joins, it does not split: «that's» is «thats», «j'ai» is «jai»
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// What silences the voice. The WHOLE utterance has to be one of these: «para»
// is a very common word, and with loudspeakers the recogniser hears the chat
// itself, so a fragment of its own sentence must never count. All four
// languages are accepted whichever one the recogniser listens in: a phrase it
// cannot transcribe just never matches. Each line is words to recognise, not
// text anyone reads.
const STOP_PHRASES = new Set([
  'para', 'basta', 'ya basta', 'alto', 'silencio', 'callate', 'ya entendi', 'ya comprendi', 'ya esta', 'es suficiente', // i18n-ok: words to recognise (es)
  'stop', 'enough', 'that is enough', 'thats enough', 'got it', 'i got it', 'quiet', 'silence', 'okay stop', 'ok stop', // i18n-ok: words to recognise (en)
  'arrete', 'ca suffit', 'cest bon', 'jai compris', 'assez', 'tais toi', // i18n-ok: words to recognise (fr)
  'stopp', 'genug', 'es reicht', 'verstanden', 'ruhe', 'halt', 'ich habe verstanden', // i18n-ok: words to recognise (de)
].map(normalizeSpoken));

/** Whether a final transcript is, as a whole, a request to stop talking. */
export const isStopCommand = (transcript) => STOP_PHRASES.has(normalizeSpoken(transcript));

// Asking the chat for more or less of what it just said, or to say it again.
// Sent as an ordinary message, so the chat understands it in any language; these
// lists only say which dictated phrases are whole commands. // i18n-ok: words to recognise
const DETAIL_PHRASES = {
  more: [
    'mas detalle', 'mas detalles', 'dame mas detalle', 'dame mas detalles', 'con mas detalle', // i18n-ok: words to recognise (es)
    'more detail', 'more details', 'give me more detail', 'give me more details', 'in more detail', // i18n-ok: words to recognise (en)
    'plus de details', 'plus de detail', 'donne moi plus de details', // i18n-ok: words to recognise (fr)
    'mehr details', 'mehr detail', 'gib mir mehr details', // i18n-ok: words to recognise (de)
  ],
  less: [
    'menos detalle', 'menos detalles', 'dame menos detalle', 'dame menos detalles', // i18n-ok: words to recognise (es)
    'less detail', 'fewer details', 'give me less detail', 'give me fewer details', // i18n-ok: words to recognise (en)
    'moins de details', 'moins de detail', 'donne moi moins de details', // i18n-ok: words to recognise (fr)
    'weniger details', 'weniger detail', 'gib mir weniger details', // i18n-ok: words to recognise (de)
  ],
  repeat: [
    'repitelo', 'repite', 'repitemelo', 'repite eso', 'dilo otra vez', // i18n-ok: words to recognise (es)
    'repeat that', 'repeat it', 'say that again', 'say it again', // i18n-ok: words to recognise (en)
    'repete', 'repete ca', 'redis le', // i18n-ok: words to recognise (fr)
    'wiederhole das', 'wiederhole es', 'nochmal', 'sag das nochmal', // i18n-ok: words to recognise (de)
  ],
};
const DETAIL_BY_PHRASE = new Map(Object.entries(DETAIL_PHRASES).flatMap(([kind, list]) => list.map((p) => [normalizeSpoken(p), kind])));

/** `'more' | 'less' | 'repeat'` when the whole utterance is such a request, else null. */
export const detailCommand = (transcript) => DETAIL_BY_PHRASE.get(normalizeSpoken(transcript)) ?? null;

// The most frequent little words of each language: enough to tell which one a
// short summary is written in, without asking the chat to say so. // i18n-ok: words to recognise
const FUNCTION_WORDS = {
  es: 'de la que el en y los se del las un por con una su para es al lo como más pero ya este porque esta entre cuando muy sin sobre también hay donde todo qué ha fue está hice encontré arreglé pasan', // i18n-ok: words to recognise
  en: 'the of and to in is that it for was on are with as this be at have from or by not but what all were we when your can there an which their if do will how each about my has did found fixed pass', // i18n-ok: words to recognise
  fr: 'le la les de des du un une et est en que qui dans pour pas sur au avec ce il elle ne se plus par mais ou nous vous je tu ont été fait très aussi trouvé corrigé', // i18n-ok: words to recognise
  de: 'der die das und ist nicht ein eine zu den mit von auf für im dem des sich auch es an als aber wie wir ich sie oder wenn noch nur bei aus nach wird hat habe gefunden behoben', // i18n-ok: words to recognise
};
const WORD_SETS = Object.fromEntries(Object.entries(FUNCTION_WORDS).map(([lang, words]) => [lang, new Set(words.split(' ').map(normalizeSpoken))]));

/**
 * `'es' | 'en' | 'fr' | 'de'` for a text, or null when it is too short or too
 * even to say. A count of function words: crude, deterministic, and enough to
 * pick a voice of the right language.
 */
export function detectLang(text) {
  const words = normalizeSpoken(text).split(' ').filter(Boolean);
  const scores = Object.entries(WORD_SETS)
    .map(([lang, set]) => [lang, words.filter((w) => set.has(w)).length])
    .sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  return best[1] >= 2 && best[1] > second[1] ? best[0] : null;
}

/**
 * The sentences to say for a list of spoken blocks, each with the language it is
 * in (its own, else `fallbackLang`), ready for the synthesiser.
 */
export const toUtterances = (blocks, fallbackLang = null) => blocks.flatMap((b) => {
  const lang = detectLang(b) ?? fallbackLang;
  return sentences(speakable(b)).map((text) => ({ text, lang }));
});
