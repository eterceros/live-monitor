// What this browser chose about the chat's voice. Per browser on purpose: the
// board is open on a laptop and a phone at once, and a voice that suits one
// annoys the other. Same shape as `cardHover.js`.
import { read, write } from './storage.js';

const CHATS_KEY = 'hfsmon-voice-chats';       // { [chatId]: boolean }, the speaker of each chat
const DEFAULT_KEY = 'hfsmon-voice-default';   // what a chat with no choice of its own does
const VOICE_KEY = 'hfsmon-voice-name';        // '' is «automatic»: a voice of the chat's language
const RATE_KEY = 'hfsmon-voice-rate';
const LISTEN_KEY = 'hfsmon-voice-listen';     // listen for «para» while it talks (needs headphones)
const CHANGED = 'hfsmon-voice-changed';

/** The speeds the settings menu offers. */
export const RATE_OPTIONS = [0.8, 1, 1.2, 1.5];
/** Chats remembered; every chat ever opened would write to the key forever. */
const CHAT_LIMIT = 100;

const tell = () => { try { window.dispatchEvent(new Event(CHANGED)); } catch { /* no window: nothing to tell */ } };

/** Calls `fn` whenever any voice preference changes; returns the unsubscribe. */
export function onVoicePrefsChange(fn) {
  window.addEventListener(CHANGED, fn);
  return () => window.removeEventListener(CHANGED, fn);
}

const readChats = () => {
  const stored = read(CHATS_KEY, {});
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
};

export const readVoiceDefault = () => read(DEFAULT_KEY, false) === true;
export function writeVoiceDefault(on) { write(DEFAULT_KEY, on === true); tell(); }

/** Whether this chat speaks: its own choice if it has one, else the browser's default. */
export function readVoiceOn(chatId) {
  const own = chatId == null ? undefined : readChats()[chatId];
  return typeof own === 'boolean' ? own : readVoiceDefault();
}

export function writeVoiceOn(chatId, on) {
  if (chatId == null) return;
  const chats = { ...readChats(), [chatId]: on === true };
  const keys = Object.keys(chats);
  // Oldest choices go first once the cap is reached (object keys keep insertion order).
  for (const k of keys.slice(0, Math.max(0, keys.length - CHAT_LIMIT))) delete chats[k];
  write(CHATS_KEY, chats);
  tell();
}

export const readVoiceName = () => { const v = read(VOICE_KEY, ''); return typeof v === 'string' ? v : ''; };
export function writeVoiceName(name) { write(VOICE_KEY, String(name ?? '')); tell(); }

export function readVoiceRate() {
  const v = read(RATE_KEY, 1);
  return RATE_OPTIONS.includes(v) ? v : 1;
}
export function writeVoiceRate(rate) {
  if (!RATE_OPTIONS.includes(rate)) return;
  write(RATE_KEY, rate);
  tell();
}

export const readVoiceListen = () => read(LISTEN_KEY, false) === true;
export function writeVoiceListen(on) { write(LISTEN_KEY, on === true); tell(); }
