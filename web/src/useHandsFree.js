import { useCallback, useEffect, useRef, useState } from 'react';

/** Silence after words that closes your turn. */
export const PAUSE_MS = 1800;
/** Nothing said at all: the loop ends instead of listening for ever. */
export const NOBODY_MS = 10000;
/** The tail of the chat's own voice dies away before the microphone opens again. */
export const TAIL_MS = 600;

/**
 * The hands-free loop of a chat: you speak, a pause sends it, the chat's reply
 * is read aloud, and the microphone opens again by itself, until you break it.
 *
 * `phase` is `off`, `listen` (the microphone is yours) or `wait` (sent; the
 * chat works and talks). The microphone only reopens once the reply has come,
 * the chat is not busy and nothing is being said, so it never hears the chat
 * itself, nor the milestone notes of a long turn. It ends when nobody says
 * anything for `NOBODY_MS`, when you press Escape, stop the dictation or type
 * (those cut the dictation, they do not end it), or when it is turned off.
 *
 * It sends what was heard only if something new landed in the box, so a draft
 * left there is not sent just because the loop started.
 */
export function useHandsFree({ enabled, dictation, text, canSend, send, speaking, busy }) {
  const [phase, setPhase] = useState('off');
  const [replied, setReplied] = useState(false);
  const latest = useRef(null);
  latest.current = { dictation };
  const startText = useRef('');
  const cut = useRef(false);   // the loop closed the turn itself: it is not you stopping
  const was = useRef(false);

  const begin = useCallback(() => setPhase('listen'), []);
  const end = useCallback(() => setPhase('off'), []);
  const noteReply = useCallback(() => setReplied(true), []);

  useEffect(() => { if (!enabled) setPhase('off'); }, [enabled]);

  useEffect(() => {
    if (phase === 'off') return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setPhase('off'); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase]);

  // The turn ends when the microphone does: send what was heard, or leave the loop.
  useEffect(() => {
    const now = dictation.listening;
    if (now && !was.current) { startText.current = text; cut.current = false; }
    if (!now && was.current && phase === 'listen') {
      const heard = text.trim() !== '' && text !== startText.current;
      if ((cut.current || dictation.lastEnd.current === 'self') && heard && canSend) {
        setReplied(false);
        setPhase('wait');
        send();
      } else setPhase('off');
    }
    was.current = now;
  }, [dictation.listening]);

  // A pause after words closes the turn; no words at all end the loop.
  useEffect(() => {
    if (phase !== 'listen' || !dictation.listening) return undefined;
    const heard = text.trim() !== '' && text !== startText.current;
    const timer = setTimeout(() => {
      if (heard) { cut.current = true; latest.current.dictation.stop(); }
      else { latest.current.dictation.abort(); setPhase('off'); }
    }, heard ? PAUSE_MS : NOBODY_MS);
    return () => clearTimeout(timer);
  }, [phase, dictation.listening, text]);

  // The reply came and was said: it is your turn again.
  useEffect(() => {
    if (phase !== 'wait' || !replied || speaking || busy || dictation.listening) return undefined;
    const timer = setTimeout(() => {
      setPhase('listen');
      latest.current.dictation.toggle('');
    }, TAIL_MS);
    return () => clearTimeout(timer);
  }, [phase, replied, speaking, busy, dictation.listening]);

  return { phase, begin, end, noteReply };
}
