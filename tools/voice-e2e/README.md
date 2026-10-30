# voice-e2e

Tries the chat's voice in a real Chromium against a throwaway board.

```
npm run build                      # the board serves web/dist
node tools/voice-e2e/run.mjs       # exit 0 = every check passed
```

It needs a Playwright package: `--playwright <path>`, `$E2E_PLAYWRIGHT`, this
repo's own if it ever has one, or the one the hfs checkout carries
(`crates/ui/e2e/node_modules/@playwright/test`). Chromium must be installed for
that Playwright version.

## What it does

- A temporary data folder and config of its own, one seeded task with a chat,
  and **this checkout's board on a free port**. The live board and its data are
  never touched. The board is stopped at the end, whatever happened.
- `voice.e2e.mjs` opens the task's chat and checks: the speaker next to the
  microphone and off by default; what is sent carries `voice: true` only when
  it is on; a live reply is read aloud as its `<voz>` summary only, sentence by
  sentence, never its detail, and a reply without a tag says nothing; Escape
  cancels the speech; the choice is stored per chat and survives a reload; the
  settings menu has the voice rows. It also checks the composer: dictation
  reaches the box, Escape stops the microphone and keeps the text, typing over
  a dictation makes the microphone step aside, and the ✕ empties the box (and
  any dictation) with an undo. Screenshots go to `--out`.
- The chat messages never reach Claude: the WebSocket is proxied, what the
  browser sends is recorded and the board's reply is injected by the test.

## What it cannot check

A headless browser has neither voices nor a microphone, so the speech engine is
replaced by a recorder (`window.speechSynthesis`, `SpeechSynthesisUtterance`,
`webkitSpeechRecognition`). It proves the wiring. How the voice sounds, what the
real recogniser hears (the stop command with headphones) and whether the model
follows the voice rule on real turns is checked by ear, in a real browser.

## When it breaks

The selectors are `button.tcw-chat` (the card's Chat button), `.cp-tools`,
`button.speaker`, `button.speaker-stop`, `.cb-voice` and the settings menu texts
(Spanish locale). A renamed class or a reworded label shows up here as a failed
check.
