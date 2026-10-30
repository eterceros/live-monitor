import { useEffect, useRef, useState } from 'react';
import { fill, strings } from './i18n/index.js';

export const Recognition = typeof window !== 'undefined'
  && (window.SpeechRecognition || window.webkitSpeechRecognition);

/**
 * Why the browser's own recogniser and not an API: it costs nothing and needs
 * no key, which is the whole point of running this board on a subscription.
 *
 * It only works in a secure context, so the microphone is available on
 * localhost but not over plain http from the phone — `isSecureContext` is what
 * the button uses to explain itself instead of failing silently.
 */
/** The language the microphone listens in: the browser's own, for the dictation and the voice commands alike. */
export const recognitionLang = () => (typeof navigator !== 'undefined' && navigator.language) || 'es-ES';

export const dictationSupport = () => {
  if (!Recognition) return { ok: false, reason: strings().app.dictation.unsupported };
  if (!window.isSecureContext) {
    return { ok: false, reason: strings().app.dictation.insecure };
  }
  return { ok: true, reason: '' };
};

/**
 * Who owns the microphone, for the whole board.
 *
 * The microphone is a browser resource, not a React one — it admits a single
 * live recogniser — and the boxes that dictate are mounted from different
 * parents (the chat's composer, and the plan and question dialogs, which are
 * portals). So ownership lives in the module, the way `useComposerHeight`
 * keeps its localStorage key there.
 *
 * Whoever starts last keeps it, and the previous owner is cut without asking:
 * `release()` first, so the loser repaints as stopped in the same commit, and
 * then `abort()` — never `stop()`, because a polite stop still delivers one
 * last result, and that result would land in the box you have just left.
 * `'aborted'` is swallowed below, so being cut shows no error at all.
 */
let live = null;                       // { rec, release }

export const takeMic = (entry) => {
  const prev = live;
  live = entry;
  if (prev && prev !== entry) {
    prev.release();
    try { prev.rec.abort(); } catch { /* already gone */ }
  }
};

export const dropMic = (entry) => { if (live === entry) live = null; };

/**
 * Dictates into a text field: keeps whatever was typed before as a prefix and
 * appends what is heard, so speaking never eats an existing draft.
 *
 * Gives back `stop` (polite: the last words still land) and `abort` (blunt:
 * nothing else is written), besides the `toggle` the button uses.
 */
export function useDictation({ onText, lang }) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState(null);
  const recognition = useRef(null);
  const owned = useRef(null);
  const prefix = useRef('');

  // Unmounting drops the ownership as well as the recogniser: a module-level
  // `live` still pointing at a dead one would make the next `start()`
  // anywhere on the board call `release()` on a component that is gone.
  useEffect(() => () => {
    dropMic(owned.current);
    owned.current = null;
    try { recognition.current?.abort(); } catch { /* already gone */ }
  }, []);

  const finish = (hard) => {
    const rec = recognition.current;
    recognition.current = null;
    dropMic(owned.current);
    owned.current = null;
    setListening(false);
    if (!rec) return;
    try { if (hard) rec.abort(); else rec.stop(); } catch { /* already stopped */ }
  };

  const stop = () => finish(false);
  const abort = () => finish(true);

  const start = (currentText) => {
    const support = dictationSupport();
    if (!support.ok) { setError({ key: 'support' }); return; }

    const rec = new Recognition();
    rec.lang = lang || recognitionLang();
    rec.continuous = true;      // dictating a prompt, not a single command
    rec.interimResults = true;  // show words as they land

    prefix.current = currentText ? `${currentText.replace(/\s+$/, '')} ` : '';
    setError(null);

    rec.onresult = (event) => {
      let heard = '';
      for (let i = 0; i < event.results.length; i++) heard += event.results[i][0].transcript;
      onText(prefix.current + heard.trimStart());
    };
    // A session also ends on its own — a silence, the network, Chrome's own
    // cap of about a minute — and that has to give the microphone back as
    // thoroughly as `stop()` does: otherwise the module keeps an owner whose
    // recogniser is dead and the next `start()` anywhere on the board would
    // `release()` a corpse.
    //
    // Guarded on «is this still the live one»: a recogniser that was cut ends
    // a tick later, and an unguarded end would turn off the icon of the
    // dictation that replaced it — and clean up its ownership, not its own.
    const ended = () => {
      if (recognition.current !== rec) return;
      recognition.current = null;
      dropMic(owned.current);
      owned.current = null;
      setListening(false);
    };
    rec.onerror = (event) => {
      // "aborted" is what stopping on purpose — or being cut — looks like.
      if (event.error !== 'aborted') {
        setError(event.error === 'not-allowed' ? { key: 'denied' } : { key: 'failed', detail: event.error });
      }
      ended();
    };
    rec.onend = ended;

    recognition.current = rec;
    const mine = {
      rec,
      release: () => {
        if (recognition.current === rec) recognition.current = null;
        if (owned.current === mine) owned.current = null;
        setListening(false);
      },
    };
    owned.current = mine;
    // Before `start()`, never after: Chrome must not see two live recognisers,
    // or the second one throws InvalidStateError and never begins.
    takeMic(mine);
    try {
      rec.start();
    } catch (e) {
      dropMic(mine);
      recognition.current = null;
      owned.current = null;
      setError({ key: 'failed', detail: e?.name ?? 'error' });
      return;
    }
    setListening(true);
  };

  return { listening, error: errorText(error), stop, abort, toggle: (text) => (listening ? stop() : start(text)) };
}

/**
 * Escape stops the dictation instead of closing the dialog around it, so the
 * first Escape keeps what you dictated and only the second one closes.
 *
 * It has to listen on `window` in the capture phase: `Dialog.jsx` listens in
 * the bubble phase and, being the child, registers its effect first — in the
 * bubble phase the dialog would always win. Same trick, for the same reason,
 * as `viewer/FileViewer.jsx`. Registered only while listening, so an idle
 * dialog still closes at the first Escape.
 */
export function useStopDictationOnEscape(dictation) {
  const { listening } = dictation;

  // `stop` from whichever render this closed over does the same thing as any
  // other: it only reads refs and sets state, so it is never stale and the
  // effect can hang on `listening` alone.
  useEffect(() => {
    if (!listening) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // The file viewer opens from the Markdown of these very dialogs and
      // listens in the capture phase too. `stopPropagation` does not stop a
      // sibling listener on the same node in the same phase, so without this
      // one Escape would close the viewer *and* stop the microphone
      // underneath it. The viewer is on top: the key is its.
      if (document.querySelector('.viewer-backdrop')) return;
      e.stopPropagation();
      dictation.stop();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [listening]);
}

// The error is kept as `{ key, detail }` and said at render, so a language
// chosen after it happened still reads it.
function errorText(error) {
  if (!error) return null;
  if (error.key === 'support') return dictationSupport().reason;
  return fill(strings().app.dictation[error.key], { detail: error.detail });
}
