import { useCallback, useEffect, useRef, useState } from 'react';
import { Recognition, dictationSupport, dropMic, recognitionLang, takeMic } from './useDictation.js';
import { detailCommand, isStopCommand, toUtterances } from './voice.js';
import { onVoicePrefsChange, readVoiceListen, readVoiceName, readVoiceRate } from './voicePrefs.js';

/**
 * Why the browser's own synthesiser: like the dictation, it costs nothing and
 * needs no key. The voice is whatever the system offers, so `pickVoice` prefers
 * the one the person chose, else one of the chat's language.
 */
export const speechSupport = () => typeof window !== 'undefined'
  && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance !== 'undefined';

/**
 * Unlocks the synthesiser for what comes later. A phone's browser (iOS Safari
 * above all) only lets a page speak after a tap has made it speak once: a reply
 * that arrives over the socket, with no tap behind it, is silently dropped. So
 * the tap that turns the speaker on, and the one that sends a message, say one
 * silent word. It costs nothing and changes nothing on a computer.
 */
export function primeSpeech() {
  if (!speechSupport()) return;
  try {
    const word = new window.SpeechSynthesisUtterance(' ');
    word.volume = 0;
    window.speechSynthesis.speak(word);
  } catch { /* a browser that refuses: the voice will say so by being silent */ }
}

/** Every voice of this system, by language and then name: the chat speaks whichever language its summary is in. */
export function listVoices() {
  if (!speechSupport()) return [];
  return [...window.speechSynthesis.getVoices()].sort((a, b) => `${a.lang} ${a.name}`.localeCompare(`${b.lang} ${b.name}`));
}

/** A voice's language is its tag's first part: «es-MX» speaks `es`. */
const speaks = (voice, lang) => Boolean(lang) && voice.lang?.toLowerCase().startsWith(lang);

/**
 * The voice for a text in `lang`: the one the person chose, if it speaks that
 * language (a Spanish voice reading English sounds wrong, so a choice for
 * another language gives way); else the first voice of the language; else
 * nothing, and the browser picks.
 */
export function pickVoice(voices, name, lang) {
  const chosen = voices.find((v) => name && v.name === name);
  if (chosen && (!lang || speaks(chosen, lang))) return chosen;
  return voices.find((v) => speaks(v, lang)) ?? null;
}

const BCP47 = { es: 'es-ES', en: 'en-US', fr: 'fr-FR', de: 'de-DE' };

/**
 * Says text aloud, one sentence at a time, and can be cut at once. `speak`
 * takes the blocks of a message and queues them behind what is being said;
 * `stop` clears the queue and silences the current sentence.
 *
 * While it talks, and only if this browser asked for it, a recogniser listens
 * for a whole spoken command: a stop («para», «stop»…) silences it, and a
 * request for more or less detail or a repeat silences it and is handed to
 * `onCommand`, which sends it. It listens in the language of the browser, like
 * the dictation, and it needs headphones, or the chat would hear itself.
 */
export function useSpeech({ onCommand = null } = {}) {
  const commandRef = useRef(onCommand);
  commandRef.current = onCommand;
  const [speaking, setSpeaking] = useState(false);
  const queue = useRef([]);
  const alive = useRef(true);
  // Whether one of OUR sentences is in flight. `speechSynthesis.speaking` is not asked: a phone can leave the silent unlocking word «speaking» for good, and the reply would wait behind it forever.
  const playing = useRef(false);
  const listener = useRef(null);

  const stopListening = useCallback(() => {
    const entry = listener.current;
    listener.current = null;
    if (!entry) return;
    dropMic(entry);
    try { entry.rec.abort(); } catch { /* already gone */ }
  }, []);

  const stop = useCallback(() => {
    queue.current = [];
    playing.current = false;
    stopListening();
    if (speechSupport()) window.speechSynthesis.cancel();
    if (alive.current) setSpeaking(false);
  }, [stopListening]);

  const listenForStop = useCallback(() => {
    if (listener.current || !readVoiceListen() || !dictationSupport().ok) return;
    const rec = new Recognition();
    rec.lang = recognitionLang();
    rec.continuous = true;
    rec.interimResults = false;   // finals only: a half-heard fragment of the chat's own voice proves nothing
    const entry = { rec, release: () => { if (listener.current === entry) listener.current = null; } };
    rec.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (!r.isFinal) continue;
        const heard = r[0]?.transcript;
        if (isStopCommand(heard)) { stop(); return; }
        if (detailCommand(heard)) { stop(); commandRef.current?.(String(heard).trim()); return; }
      }
    };
    // A recogniser ends by itself after a silence: while the chat is still
    // talking it is started again, otherwise «para» would work for a minute only.
    rec.onend = () => {
      if (listener.current !== entry) return;
      listener.current = null;
      if (queue.current.length || playing.current) listenForStop();
    };
    rec.onerror = () => { if (listener.current === entry) listener.current = null; };
    listener.current = entry;
    takeMic(entry);
    try { rec.start(); } catch { listener.current = null; dropMic(entry); }
  }, [stop]);

  const next = useCallback(() => {
    if (!speechSupport()) return;
    const item = queue.current.shift();
    if (item === undefined) {
      playing.current = false;
      stopListening();
      if (alive.current) setSpeaking(false);
      return;
    }
    playing.current = true;
    const utterance = new window.SpeechSynthesisUtterance(item.text);
    const voice = pickVoice(window.speechSynthesis.getVoices(), readVoiceName(), item.lang);
    if (voice) { utterance.voice = voice; utterance.lang = voice.lang; } else if (item.lang) utterance.lang = BCP47[item.lang] ?? item.lang;
    utterance.rate = readVoiceRate();
    utterance.onend = next;
    utterance.onerror = () => { if (queue.current.length) next(); else { playing.current = false; if (alive.current) setSpeaking(false); } };
    window.speechSynthesis.speak(utterance);
  }, [stopListening]);

  const speak = useCallback((blocks) => {
    if (!speechSupport()) return;
    // A summary the detection cannot place is read in the browser's language.
    const parts = toUtterances(blocks, recognitionLang().slice(0, 2).toLowerCase());
    if (!parts.length) return;
    const idle = !playing.current;
    queue.current.push(...parts);
    setSpeaking(true);
    listenForStop();
    if (idle) {
      // Whatever the browser still holds is not ours (the unlocking word): clear it so this sentence is the next to be said.
      if (window.speechSynthesis.speaking || window.speechSynthesis.pending) window.speechSynthesis.cancel();
      next();
    }
  }, [listenForStop, next]);

  // A change of preferences (the listening switch, the voice) applies to what is said from now on.
  useEffect(() => onVoicePrefsChange(() => { if (!readVoiceListen()) stopListening(); }), [stopListening]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; queue.current = []; stopListening(); if (speechSupport()) window.speechSynthesis.cancel(); };
  }, [stopListening]);

  return { speaking, speak, stop };
}
