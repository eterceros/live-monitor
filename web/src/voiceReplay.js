import { createContext } from 'react';

/**
 * Lets a bubble read its own spoken summary again without owning a voice: the
 * chat panel provides `{ supported, speaking, replayId, replay(id, blocks), stop() }`
 * and the bubble asks for its summary by an id of its own, so only the one that
 * is being read shows «stop».
 */
export const VoiceReplayContext = createContext(null);

/** The newest reply that has something to say aloud: its id and every `<voz>` block of it, or null. */
export function lastSpokenReply(messages, splitVoice) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'assistant') continue;
    const { spoken } = splitVoice(m.text);
    if (spoken.length) return { id: m.id, spoken };
  }
  return null;
}
