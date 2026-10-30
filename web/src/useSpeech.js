import { useCallback, useEffect, useRef, useState } from 'react';
import { Recognition, dictationSupport, dropMic, takeMic } from './useDictation.js';
import { isStopCommand, toUtterances } from './voice.js';
import { onVoicePrefsChange, readVoiceListen, readVoiceName, readVoiceRate } from './voicePrefs.js';

/**
 * Why the browser's own synthesiser: like the dictation, it costs nothing and
 * needs no key. The voice is whatever the system offers, so `pickVoice` prefers
 * the one the person chose, else one of the chat's language.
 */
export const speechSupport = () => typeof window !== 'undefined'
  && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance !== 'undefined';

/** The voices of this system, in the language the chat speaks first when asked. */
export function listVoices(lang = 'es') {
  if (!speechSupport()) return [];
  const all = window.speechSynthesis.getVoices();
  const mine = all.filter((v) => v.lang?.toLowerCase().startsWith(lang));
  return mine.length ? mine : all;
}

/** The chosen voice by name, else the first of the language, else the browser's own pick. */
export function pickVoice(voices, name, lang = 'es') {
  return voices.find((v) => name && v.name === name)
    ?? voices.find((v) => v.lang?.toLowerCase().startsWith(lang))
    ?? null;
}

/**
 * Says text aloud, one sentence at a time, and can be cut at once. `speak`
 * takes the blocks of a message and queues them behind what is being said;
 * `stop` clears the queue and silences the current sentence.
 *
 * While it talks, and only if this browser asked for it, a recogniser listens
 * for a stop command (see `isStopCommand`): the whole utterance has to be
 * «para», «basta», «ya entendí»… and it needs headphones, or the chat would
 * hear itself.
 */
export function useSpeech({ lang = 'es' } = {}) {
  const [speaking, setSpeaking] = useState(false);
  const queue = useRef([]);
  const alive = useRef(true);
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
    stopListening();
    if (speechSupport()) window.speechSynthesis.cancel();
    if (alive.current) setSpeaking(false);
  }, [stopListening]);

  const listenForStop = useCallback(() => {
    if (listener.current || !readVoiceListen() || !dictationSupport().ok) return;
    const rec = new Recognition();
    rec.lang = lang === 'es' ? 'es-ES' : (navigator.language || 'es-ES');
    rec.continuous = true;
    rec.interimResults = false;   // finals only: a half-heard fragment of the chat's own voice proves nothing
    const entry = { rec, release: () => { if (listener.current === entry) listener.current = null; } };
    rec.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal && isStopCommand(r[0]?.transcript)) { stop(); return; }
      }
    };
    // A recogniser ends by itself after a silence: while the chat is still
    // talking it is started again, otherwise «para» would work for a minute only.
    rec.onend = () => {
      if (listener.current !== entry) return;
      listener.current = null;
      if (queue.current.length || window.speechSynthesis?.speaking) listenForStop();
    };
    rec.onerror = () => { if (listener.current === entry) listener.current = null; };
    listener.current = entry;
    takeMic(entry);
    try { rec.start(); } catch { listener.current = null; dropMic(entry); }
  }, [lang, stop]);

  const next = useCallback(() => {
    if (!speechSupport()) return;
    const text = queue.current.shift();
    if (text === undefined) {
      stopListening();
      if (alive.current) setSpeaking(false);
      return;
    }
    const utterance = new window.SpeechSynthesisUtterance(text);
    const voice = pickVoice(window.speechSynthesis.getVoices(), readVoiceName(), lang);
    if (voice) { utterance.voice = voice; utterance.lang = voice.lang; } else utterance.lang = lang === 'es' ? 'es-ES' : lang;
    utterance.rate = readVoiceRate();
    utterance.onend = next;
    utterance.onerror = () => { if (queue.current.length) next(); else if (alive.current) setSpeaking(false); };
    window.speechSynthesis.speak(utterance);
  }, [lang, stopListening]);

  const speak = useCallback((blocks) => {
    if (!speechSupport()) return;
    const parts = toUtterances(blocks);
    if (!parts.length) return;
    const idle = !queue.current.length && !window.speechSynthesis.speaking;
    queue.current.push(...parts);
    setSpeaking(true);
    listenForStop();
    if (idle) next();
  }, [listenForStop, next]);

  // A change of preferences (the listening switch, the voice) applies to what is said from now on.
  useEffect(() => onVoicePrefsChange(() => { if (!readVoiceListen()) stopListening(); }), [stopListening]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; queue.current = []; stopListening(); if (speechSupport()) window.speechSynthesis.cancel(); };
  }, [stopListening]);

  return { speaking, speak, stop };
}
