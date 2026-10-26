/**
 * Cuota agotada: the board stops, waits, and starts itself again.
 *
 * The account's limit is not a task's failure. When a session hits it, every
 * other session would hit the same wall within seconds, so what this module
 * holds is the whole board — and what it remembers is enough to pick the work
 * up again by itself, at the hour the window reopens, without a click.
 *
 * It knows nothing about pipelines. `claude.js` imports it (that is where the
 * limit is seen), so importing `pipeline.js` back would close the circle:
 * `pipeline.js` registers what to do through `quotaHooks`, the way
 * `pipelineHooks`/`fixHooks` already work.
 *
 * The hold lives in `server/data/quota.json`, with the upgrade job's pattern:
 * written atomically by rename, read lazily and cached, and a half-read file
 * retried rather than taken for «there is no hold».
 *
 * States: `held → draining → released`.
 */

import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { coerceKey, keyOf, parseKey } from './keys.js';
import { looksLikeUsageLimit, USAGE_LIMIT_ERROR_PREFIXES } from './usage-limit.js';
import { metricsHooks, record } from './metrics.js';

export { looksLikeUsageLimit, USAGE_LIMIT_ERROR_PREFIXES };

const HOLD_STATES = ['held', 'draining', 'released'];
/** A hold the wake has to honour: nothing new starts under either. */
const BLOCKING = ['held', 'draining'];

/**
 * A reconstructed clock time further out than this is not believed.
 *
 * Without it, reading «resets 16:30» at 16:45 schedules the wake for *tomorrow*
 * and the board sleeps a day over a fifteen-minute wait. Only reconstructed
 * times are clamped: a `resetsAt` the SDK handed over may legitimately be days
 * away on a seven-day limit.
 */
export const MAX_RECONSTRUCTED_MS = 6 * 60 * 60_000;

/** With nothing readable at all, wait this long — one rung per fresh hit. */
export const BLIND_LADDER_MINUTES = [20, 40, 80, 160, 300];

/**
 * The same ladder for a weekly limit, which a five-hour ladder reads terribly:
 * 20 minutes into a window that reopens in six days is about 34 canary
 * sessions burnt over the week. It starts at four hours and tops out at a day.
 */
export const BLIND_LADDER_WEEKLY_MINUTES = [4 * 60, 8 * 60, 16 * 60, 24 * 60];

/** Whether this limit is one of the weekly ones. */
export const isWeeklyLimit = (kind) => typeof kind === 'string' && kind.startsWith('seven_day');

/** The clock ticks on this cadence: it survives a suspended laptop and a clock step. */
export const WAKE_INTERVAL_MS = 30_000;

/**
 * How long `draining` may last with no sign of life. It holds the whole board,
 * so it must not be a state anything can get stuck in: if the canary never
 * reaches a model — it failed on gh, on git, on anything before its first turn
 * — the window is taken as open rather than blocking the board for ever.
 */
export const DRAIN_MAX_MS = 10 * 60_000;

/**
 * A hit arriving right after a release is the same window still shut, not a
 * new one: it climbs the ladder instead of restarting it.
 */
const SAME_WINDOW_MS = 10 * 60_000;

/** PowerShell may write a byte-order mark. */
const LEADING_BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);

export const quotaEvents = new EventEmitter();

/**
 * Everything this module does outside itself. `pipeline.js` fills `resume` in;
 * the rest are seams a test can watch without a board.
 */
export const quotaHooks = {
  /** Relaunch what the hold parked. `limit` caps how many go at once (the canary). */
  resume: async (_hold, _options) => {},
  /**
   * Whether this issue is still a task this hold speaks for. Registered by
   * `pipeline.js`, which owns the store; null until it is, and then the list is
   * simply never pruned rather than wrongly emptied.
   */
  stillParked: null,
  /** Something to say on the board's own log; the tasks get their own lines. */
  log: (line) => console.log(`[quota] ${line}`),
};

const iso = () => new Date().toISOString();
const quotaFile = () => path.join(DATA_DIR, 'quota.json');

const EMPTY = { hold: null, warning: null };

let cache = null;
let loaded = false;

/**
 * Reads the file, retrying a parse failure a couple of times: a file caught
 * mid-rename is not «no hold», and reading it as one is exactly how a board
 * would forget it was waiting and burn the closed window all over again.
 */
function readHoldFile() {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let text;
    try {
      text = readFileSync(quotaFile(), 'utf8');
    } catch (e) {
      // Nothing written yet is a clean answer; anything else is not.
      if (e.code === 'ENOENT') return { value: { ...EMPTY } };
      last = e;
      continue;
    }
    try {
      const parsed = JSON.parse(text.replace(LEADING_BOM, ''));
      if (parsed && typeof parsed === 'object') {
        return { value: { hold: parsed.hold ?? null, warning: parsed.warning ?? null } };
      }
      return { value: { ...EMPTY } };
    } catch (e) {
      last = e;
    }
  }
  return { error: last?.message ?? 'no se pudo leer' };
}

function current() {
  if (!loaded) {
    const read = readHoldFile();
    if (read.error) return cache ?? { ...EMPTY };   // keep trying; never «no hold»
    cache = read.value;
    loaded = true;
  }
  return cache ?? { ...EMPTY };
}

function write(value) {
  const file = quotaFile();
  mkdirSync(path.dirname(file), { recursive: true });
  if (!value.hold && !value.warning) {
    rmSync(file, { force: true });
    return;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, file);
}

function save() {
  const data = current();
  try {
    write(data);
  } catch (e) {
    quotaHooks.log(`no se pudo guardar la retención: ${e.message}`);
  }
  quotaEvents.emit('state', quotaState());
}

// ---------------------------------------------------------------------------
// Reading the hour back out of a sentence

const ZONE_OFFSETS_MIN = {
  UTC: 0, GMT: 0, Z: 0, UT: 0,
  EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420,
  BST: 60, CET: 60, CEST: 120,
};

/** Y/M/D/H/M as that zone reads them at `at`, plus the zone's offset in ms. */
function zoneParts(zone, at) {
  const fixed = ZONE_OFFSETS_MIN[String(zone).toUpperCase()];
  if (fixed !== undefined) {
    const shifted = new Date(at + fixed * 60_000);
    return {
      year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate(),
      offsetMs: fixed * 60_000,
    };
  }
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = Object.fromEntries(fmt.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
    // Seconds are in both halves, so they cancel: what is left is the offset.
    const offsetMs = Math.round((asUtc - Math.floor(at / 1000) * 1000) / 60_000) * 60_000;
    return { year: Number(p.year), month: Number(p.month) - 1, day: Number(p.day), offsetMs };
  } catch {
    return null;
  }
}

/** The same, for the machine's own zone: the reading when no zone is named. */
function localParts(at) {
  const d = new Date(at);
  return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), offsetMs: -d.getTimezoneOffset() * 60_000 };
}

/**
 * The instant a notice names, or null.
 *
 * `Date.parse('4:30pm (UTC)')` is `NaN`, which is the whole reason this exists.
 * It reads «in 42 minutes», a 12- or 24-hour clock time, and a zone between
 * parentheses; a clock time that has already gone by today is taken as
 * tomorrow's — and then thrown away, because more than six hours out is far
 * more likely to be a time that just passed than a real wait.
 */
export function parseResetTime(text, now = Date.now()) {
  if (typeof text !== 'string' || !text.trim()) return null;

  const relative = /\bin\s+(\d{1,4})\s*(second|sec|minute|min|hour|hr|day)s?\b/i.exec(text);
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const ms = unit.startsWith('sec') ? 1000
      : unit.startsWith('min') ? 60_000
        : unit.startsWith('h') ? 3_600_000
          : 86_400_000;
    const until = now + n * ms;
    return until > now ? until : null;
  }

  // «resets 4:30pm (UTC)», «resets at 16:30», «resets 9am».
  const clock = /\b(?:resets?|reset)\b[^0-9]{0,12}(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i.exec(text);
  if (!clock) return null;
  let hour = Number(clock[1]);
  const minute = Number(clock[2] ?? 0);
  const meridiem = (clock[3] ?? '').toLowerCase().replace(/\./g, '');
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) return null;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23) return null;

  // The zone, if the notice names one between parentheses right after the hour.
  const after = text.slice(clock.index + clock[0].length);
  const zoneMatch = /^\s*\(([A-Za-z][A-Za-z0-9_+\-/]{1,30})\)/.exec(after);
  const parts = zoneMatch ? zoneParts(zoneMatch[1], now) ?? localParts(now) : localParts(now);

  let until = Date.UTC(parts.year, parts.month, parts.day, hour, minute) - parts.offsetMs;
  if (until <= now) until += 86_400_000;
  // The clamp that keeps the board from sleeping a day over a 15-minute wait.
  if (until - now > MAX_RECONSTRUCTED_MS) return null;
  return until;
}

/**
 * The blind wait for this rung of the ladder, in ms from `now`. A weekly limit
 * climbs its own, much longer one: the rungs are about how far away the window
 * plausibly is, and a seven-day window is not twenty minutes away.
 */
export function blindUntil(attempt, now = Date.now(), kind = null) {
  const ladder = isWeeklyLimit(kind) ? BLIND_LADDER_WEEKLY_MINUTES : BLIND_LADDER_MINUTES;
  const i = Math.min(Math.max(1, attempt) - 1, ladder.length - 1);
  return now + ladder[i] * 60_000;
}

/** An epoch the SDK handed over, in ms — it may arrive in seconds. */
function epochMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

// ---------------------------------------------------------------------------
// Detection

/**
 * What one SDK message says about the account's limit, in the order that
 * matters: the structural event first (it carries the exact hour), then the
 * assistant's own error code, then — last — the SDK's text prefixes.
 *
 * Only `rate_limit` parks among the error codes: `overloaded` is a hiccup that
 * a retry fixes, and `billing_error` is permanent — waiting for that one never
 * ends.
 */
export function detectRateLimit(message) {
  if (!message || typeof message !== 'object') return null;

  if (message.type === 'rate_limit_event') {
    const info = message.rate_limit_info ?? {};
    const common = {
      resetsAt: epochMs(info.resetsAt),
      rateLimitType: info.rateLimitType ?? null,
      utilization: Number.isFinite(info.utilization) ? info.utilization : null,
      via: 'sdk',
    };
    if (info.status === 'rejected') return { status: 'rejected', ...common };
    if (info.status === 'allowed_warning') return { status: 'warning', ...common };
    // `allowed` is the account saying outright that the window is open — the
    // cheapest sign of life there is, and it arrives before the first token.
    if (info.status === 'allowed') return { status: 'allowed', ...common };
    return null;
  }

  if (message.type === 'assistant') {
    if (message.error === 'rate_limit') {
      return { status: 'rejected', resetsAt: null, rateLimitType: null, utilization: null, via: 'error', text: assistantText(message) };
    }
    // Last resort: the prefixes, read from the SDK so a new one arrives free.
    const text = assistantText(message);
    if (looksLikeUsageLimit(text)) {
      return { status: 'rejected', resetsAt: null, rateLimitType: null, utilization: null, via: 'text', text };
    }
    return null;
  }

  if (message.type === 'result') {
    const text = typeof message.result === 'string' ? message.result : '';
    if (looksLikeUsageLimit(text)) {
      return { status: 'rejected', resetsAt: null, rateLimitType: null, utilization: null, via: 'text', text };
    }
  }
  return null;
}

function assistantText(message) {
  const content = message.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

// ---------------------------------------------------------------------------
// The hold

let holdCounter = 0;
const newHoldId = () => {
  holdCounter += 1;
  return `q-${Date.now().toString(36)}${holdCounter.toString(36)}`;
};

/**
 * `hold.parked` as canonical keys, whatever the file holds.
 *
 * The list is persisted, and every `quota.json` written before projects existed
 * holds bare issue numbers — a board that upgrades mid-hold reads its own older
 * file. `coerceKey` reads both spellings and answers `null` for junk, which is
 * dropped here rather than carried: a `12abc` left on the list would never
 * match a task and would keep the chip counting a phantom for ever.
 *
 * Every entry point normalises on the way in and on the way out, so nothing
 * downstream ever has to ask which of the two shapes it is holding.
 */
const asKeys = (list) => (Array.isArray(list) ? list : []).map((v) => coerceKey(v)).filter(Boolean);

/** The hold as it stands, or null. */
export function quotaHold() {
  const hold = current().hold;
  return hold && HOLD_STATES.includes(hold.state) ? hold : null;
}

/** The last `allowed_warning`, while the window it talks about is still ahead. */
export function quotaWarning() {
  const warning = current().warning;
  if (!warning) return null;
  if (warning.resetsAt && warning.resetsAt <= Date.now()) return null;
  return warning;
}

/** A hold that stops new work: nothing starts under it, and clicks park or refuse. */
export function quotaHoldsNewWork(task) {
  const hold = quotaHold();
  if (!BLOCKING.includes(hold?.state)) return false;
  // The canary is the one task the drain is waiting on: if its own phases saw
  // the hold they would park it again before it ever reached a model, and the
  // window would only reopen when `DRAIN_MAX_MS` gave up on it.
  if (task && hold.state === 'draining' && hold.canary && hold.canary === keyOf(task)) return false;
  return true;
}

/** Marks the task the drain is testing the window with. */
export function markQuotaCanary(task) {
  const hold = quotaHold();
  if (hold?.state !== 'draining') return;
  hold.canary = keyOf(task);
  save();
}

/** The projection the board draws, exactly as the web block expects it. */
export function quotaState() {
  const hold = quotaHold();
  const warning = quotaWarning();
  const warningPart = warning
    ? { utilization: warning.utilization ?? null, resetsAt: warning.resetsAt ?? null, kind: warning.kind ?? null }
    : null;
  if (!hold) {
    // A warning with no hold still paints the chip amber; nothing is parked
    // and nothing is waiting, so the state it reports is `released`.
    if (!warningPart) return null;
    return { state: 'released', until: null, kind: warningPart.kind, certainty: null, attempt: 0, parked: 0, warning: warningPart };
  }
  const parked = (hold.parked ?? []).length;
  return {
    // `released` with tasks still on the list is not «nothing to see»: the
    // window is open and they are queueing for a free slot. It keeps its own
    // name so the chip has something to draw — with nothing left waiting,
    // `released` really does mean over.
    state: hold.state === 'released' && parked ? 'draining' : hold.state,
    until: hold.until ?? null,
    kind: hold.kind ?? null,
    certainty: hold.certainty ?? null,
    attempt: hold.attempt ?? 1,
    parked,
    warning: warningPart,
  };
}

/**
 * An `allowed_warning`: it never parks — that would be a policy nobody
 * approved — but it is remembered, because it carries the hour a later
 * rejection may not, and without it that one falls into the blind ladder.
 */
export function noteQuotaWarning(hit) {
  const data = current();
  data.warning = {
    utilization: hit.utilization ?? null,
    resetsAt: hit.resetsAt ?? null,
    kind: hit.rateLimitType ?? null,
    at: iso(),
  };
  cache = data;
  save();
  return data.warning;
}

/** Where the reopening hour comes from, best source first. */
function decideUntil(hit, attempt, now, kind) {
  if (hit?.resetsAt && hit.resetsAt > now) return { until: hit.resetsAt, certainty: 'sdk' };
  const seed = quotaWarning();
  if (seed?.resetsAt && seed.resetsAt > now) return { until: seed.resetsAt, certainty: 'sdk' };
  const read = parseResetTime(hit?.text ?? '', now);
  // A weekly window is never fifteen minutes away, whatever a clock time says:
  // that reading belongs to the five-hour limit and would send the canary out
  // dozens of times over a week. Judged on what THIS hit says it is, never on
  // the kind the hold inherited — a text-only hit during a weekly hold's drain
  // is most likely the five-hour limit talking, and throwing its hour away
  // would turn a 15-minute wait into eight hours. The ladder below is the other
  // way round: how far the window plausibly is, which the inherited kind knows.
  if (read && !isWeeklyLimit(hit?.rateLimitType)) return { until: read, certainty: 'clock' };
  return { until: blindUntil(attempt, now, kind), certainty: 'blind' };
}

/**
 * A rejection reached the board. Opens the hold, or — when one is already
 * draining, or was released moments ago — climbs a rung instead of opening a
 * second one.
 */
export function noteQuotaHit(hit = {}) {
  const data = current();
  const now = Date.now();
  const existing = data.hold;

  if (existing?.state === 'held') {
    // Already holding. A hit that carries a real hour still improves a guess.
    if (hit.resetsAt && hit.resetsAt > now && existing.certainty !== 'sdk') {
      existing.until = hit.resetsAt;
      existing.certainty = 'sdk';
      existing.kind = hit.rateLimitType ?? existing.kind;
      save();
      armWake();
    }
    return existing;
  }

  const stillShut = existing?.state === 'draining'
    || (existing?.state === 'released' && existing.releasedAt && now - Date.parse(existing.releasedAt) < SAME_WINDOW_MS);
  const attempt = stillShut ? (existing.attempt ?? 1) + 1 : 1;
  const kind = hit.rateLimitType ?? (stillShut ? existing.kind : null) ?? null;
  const { until, certainty } = decideUntil(hit, attempt, now, kind);

  const hold = {
    id: stillShut ? existing.id : newHoldId(),
    state: 'held',
    since: stillShut ? existing.since : iso(),
    at: iso(),
    until,
    kind,
    certainty,
    attempt,
    via: hit.via ?? null,
    // The list is explicit on purpose: deriving it by scanning for
    // `state === 'error'` would sweep up tasks that failed for other reasons.
    parked: stillShut ? asKeys(existing.parked) : [],
    releasedAt: null,
  };
  data.hold = hold;
  cache = data;
  save();
  quotaHooks.log(stillShut
    ? `la ventana sigue cerrada: peldaño ${attempt}, se reintenta ${describeResume(hold)}`
    : `cuota agotada (${certainty}): el tablero se detiene y se reanuda ${describeResume(hold)}`);
  armWake();
  return hold;
}

/** «at 16:30» — always the absolute hour: a countdown alone ages badly. */
export function resumeHour(hold) {
  const until = hold?.until;
  if (!until) return null;
  return new Date(until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/**
 * The hour has passed but the hold is still on: the board is testing the window
 * (`draining`) or the 30 s clock has not come round yet. Quoting that hour would
 * say «comes back at 18:00» at 18:02, so it says what is actually happening.
 */
function hourHasPassed(hold) {
  return Boolean(hold?.until) && hold.until <= Date.now();
}

/** «at 16:30» / «in a moment» / «as soon as the account is back». */
export function describeResume(hold) {
  if (hourHasPassed(hold)) return 'in a moment';
  const hour = resumeHour(hold);
  return hour ? `at ${hour}` : 'as soon as the account is back';
}

/** The same hour, in the form an «until» takes. */
export function untilResume(hold) {
  if (hourHasPassed(hold)) return 'while it checks that the account is back';
  const hour = resumeHour(hold);
  return hour ? `until ${hour}` : 'until the account is back';
}

/** The line a parked task gets in its log. */
export function quotaWaitLine(hold, phaseLabel) {
  return `⏳ quota exhausted: the task is paused${phaseLabel ? ` at ${phaseLabel}` : ''}`
    + ` and will start on its own ${describeResume(hold)}. Nothing to press.`;
}

/** What a click that cannot run right now is told. */
export function quotaRefusalMessage(hold = quotaHold()) {
  return `Quota exhausted: the board does not open new sessions ${untilResume(hold)}`;
}

/** Refuses with 409 while a hold is on — for the clicks that must not park. */
export function assertNoQuotaHold() {
  if (!quotaHoldsNewWork()) return;
  throw Object.assign(new Error(quotaRefusalMessage()), { status: 409, quota: quotaState() });
}

/**
 * Marks one task as waiting for the window, and lists it on the hold.
 *
 * Only a marker on the task: no new state. A state would mean touching
 * `STATES`, `STATUS`, `COLUMNS` and `orphanStates()` for a wait that passes.
 */
export function parkForQuota(task, { resumeFrom = null, wasUserRun = false, previousError = null } = {}) {
  const hold = quotaHold() ?? noteQuotaHit({});
  task.quotaPark = {
    holdId: hold.id,
    since: iso(),
    resumeFrom,
    wasUserRun: Boolean(wasUserRun),
    previousError: previousError ?? null,
  };
  hold.parked = [...new Set([...asKeys(hold.parked), keyOf(task)])];
  save();
  armWake();
  return hold;
}

/** Takes the marker off a task and off the hold's list. */
export function clearQuotaPark(task) {
  if (!task) return;
  const hold = quotaHold();
  const had = Boolean(task.quotaPark);
  // The park ends here, whoever ends it (resume, boot, a user run), so this is
  // the one place that can time it. `since` is persisted, so a park that spans
  // a board restart still gets its whole length.
  if (had) {
    record(task, {
      kind: 'wait',
      name: 'quota_park',
      startedAt: task.quotaPark.since,
      endedAt: new Date(metricsHooks.now()).toISOString(),
      meta: { within: null, resumeFrom: task.quotaPark.resumeFrom ?? null, wasUserRun: Boolean(task.quotaPark.wasUserRun) },
    });
  }
  task.quotaPark = null;
  if (hold) {
    const key = keyOf(task);
    hold.parked = asKeys(hold.parked).filter((parked) => parked !== key);
    // A released hold with nothing left waiting has nothing left to say.
    if (hold.state === 'released' && !hold.parked.length) current().hold = null;
    save();
  }
  return had;
}

/**
 * The tasks this hold parked, as canonical keys, in order. Keys, deliberately:
 * resolving them to tasks belongs to `pipeline.js`.
 *
 * Two projects park in the same list, so a bare issue number is no longer an
 * identity: `12` of one repository and `12` of the other would be one entry,
 * and only one of the two would ever be relaunched. Every entry is coerced
 * here, on the way out, so a `quota.json` written before projects existed
 * resumes correctly instead of handing bare numbers to the caller.
 *
 * The order is `(project, issue)`, and it is read through `parseKey` because a
 * key sorts terribly by hand: `[...].sort((a, b) => a - b)` over strings is
 * `NaN` every time, which leaves the list in whatever order the file had. That
 * order decides which task goes out as the canary, so it is not cosmetic.
 *
 * This module is imported by `claude.js`, so every session loads it. Reaching
 * the store from here would put `store.js` on that import path — and `store.js`
 * builds its singleton at module load, reading and then synchronously
 * rewriting the whole of `tasks.json`. Five test files that set no
 * `HFSMON_DATA_DIR` reach `claude.js`; through this edge they would all have
 * read and rewritten the live board's file, and did: a torn read killed
 * `session.test.mjs` at module load. The dependency stays out.
 */
export function parkedIssues(hold = quotaHold()) {
  return asKeys(hold?.parked).sort((a, b) => {
    const x = parseKey(a);
    const y = parseKey(b);
    if (x.projectId !== y.projectId) return x.projectId < y.projectId ? -1 : 1;
    return x.issue - y.issue;
  });
}

/**
 * Drops issues this hold no longer speaks for — a task deleted from the board
 * while it waited, or one whose marker is gone. Without this `parked.length`
 * stays above zero for ever: a released hold never disappears and the clock
 * keeps calling the resumption every 30 s for a task that is not there.
 * `keep(key)` answers whether that task — a canonical `<project>#<issue>` key —
 * is still parked on this hold.
 *
 * The list is normalised in place on the way through: an older file's bare
 * numbers become keys here too, and the write only happens when something was
 * actually dropped, so a board that boots into a hold it cannot prune does not
 * rewrite `quota.json` on every one of the 30-second ticks.
 */
export function pruneParked(hold, keep) {
  if (!hold) return [];
  const before = hold.parked ?? [];
  const left = asKeys(before).filter((key) => keep(key));
  const unchanged = left.length === before.length && left.every((key, i) => key === before[i]);
  hold.parked = left;
  if (unchanged) return left;
  if (hold.state === 'released' && !left.length) current().hold = null;
  save();
  return left;
}

// ---------------------------------------------------------------------------
// The wake

let interval = null;
let aimed = null;
let reopening = false;

function clearAim() {
  if (aimed) {
    clearTimeout(aimed);
    aimed = null;
  }
}

/** Points the one-shot at the exact instant, so the reopening loses no seconds. */
function armWake() {
  clearAim();
  const hold = quotaHold();
  if (hold?.state !== 'held') return;
  const wait = Math.max(0, (hold.until ?? 0) - Date.now());
  aimed = setTimeout(() => { aimed = null; evaluateQuota(); }, wait);
  aimed.unref?.();
}

/**
 * The one function that decides the window reopened, behind a latch: `tick()`
 * is called from ten places and must only ever *read* the hold — the life
 * cycle belongs to this clock.
 */
export function evaluateQuota() {
  const hold = quotaHold();
  if (!hold) {
    clearAim();
    return null;
  }
  if (hold.state === 'released') {
    // What could not go when the window opened — no free slot, a chat still
    // answering, a move — is tried again on this very cadence.
    if ((hold.parked ?? []).length) {
      Promise.resolve()
        .then(() => quotaHooks.resume(hold, {}))
        .catch((e) => quotaHooks.log(`la reanudación falló: ${e.message}`));
    } else {
      clearAim();
    }
    return null;
  }
  if (hold.state === 'draining') {
    // The canary went out and nothing ever came back — a phase that failed for
    // some other reason before it ever reached a model, say. `draining` blocks
    // the whole board, so it cannot be a state anything gets stuck in: past
    // this deadline the window is taken as open and the rest goes.
    const since = Date.parse(hold.drainingAt ?? hold.at ?? '') || 0;
    if (Date.now() - since > DRAIN_MAX_MS) {
      quotaHooks.log('la canaria no dio señales en 10 min: se da la ventana por abierta y se suelta el resto');
      noteQuotaAlive();
    }
    return null;
  }
  if (hold.state !== 'held') return null;
  // Tasks that left the board while they waited. The list is what the chip
  // counts, so without this it says «3 en pausa» for hours over tasks that are
  // gone. The state is deliberately left alone: a `held` hold with an empty
  // list is normal and correct — that is a wall met in a chat, and the board
  // must stay stopped for it. Whether an empty list means «nobody to wait for»
  // is a question only the reopening gets to ask.
  if (quotaHooks.stillParked) pruneParked(hold, quotaHooks.stillParked);
  if (hold.until && Date.now() < hold.until) {
    armWake();
    return null;
  }
  if (reopening) return null;
  reopening = true;
  clearAim();
  hold.state = 'draining';
  hold.drainingAt = iso();
  save();
  quotaHooks.log(`la ventana debería estar abierta: se prueba con una sola tarea (peldaño ${hold.attempt ?? 1})`);
  // The canary: exactly one task goes, and only a real sign of life lets the
  // rest follow. Relaunching twenty into a window that never opened is how
  // the incident that started all this burned four sessions in seconds.
  Promise.resolve()
    .then(() => quotaHooks.resume(hold, { limit: 1 }))
    .then((started) => {
      if (started) return;
      const live = quotaHold();
      if (live?.state !== 'draining') return;
      // Nothing is parked at all — the wall was met in a chat, say, which posts
      // a bubble and parks nothing; or the hold opened while a change request
      // stayed `pending`. There is nobody to wait for, so the hold is over.
      //
      // Going back to `held` here is the one thing that must not happen: with
      // an empty list the canary can never start anything, so `started` is 0 for
      // ever, `DRAIN_MAX_MS` never fires (the state leaves `draining` within a
      // microtask), and `noteQuotaAlive` never fires either, because every path
      // that would open a session is blocked by this very hold. The board stops
      // for good — and `resumeQuotaOnBoot` loads it again after a restart.
      if (!(live.parked ?? []).length) {
        noteQuotaAlive();
        return;
      }
      // Something IS parked but could not go: a chat still answering, a move,
      // no free slot. Stay held and try again on the next tick rather than
      // draining into the dark — `draining` with no canary out would never end.
      live.state = 'held';
      live.until = Date.now() + WAKE_INTERVAL_MS;
      save();
      armWake();
    })
    .catch((e) => quotaHooks.log(`la reanudación falló: ${e.message}`))
    .finally(() => { reopening = false; });
  return hold;
}

/**
 * A session got a real answer: the window is open. Only this drains the rest.
 * Called from `claude.js` on the events that cannot happen behind a wall.
 */
export function noteQuotaAlive() {
  const hold = quotaHold();
  if (hold?.state !== 'draining') return null;
  hold.state = 'released';
  hold.releasedAt = iso();
  // Nothing left waiting — the canary was the last one, or the rest were
  // pruned — so the hold has nothing more to say and goes. Without this it
  // would sit in `released` for ever and the chip would never clear.
  if (!(hold.parked ?? []).length) {
    current().hold = null;
    save();
    quotaHooks.log('la ventana está abierta y no queda nada aparcado: se cierra la retención');
    return null;
  }
  save();
  quotaHooks.log('la ventana está abierta: se reanuda el resto de lo aparcado');
  Promise.resolve()
    .then(() => quotaHooks.resume(hold, {}))
    .catch((e) => quotaHooks.log(`la reanudación falló: ${e.message}`));
  return hold;
}

/** The 30 s clock, plus whatever one-shot the hold deserves. */
export function startQuotaClock() {
  if (!interval) {
    interval = setInterval(() => { evaluateQuota(); }, WAKE_INTERVAL_MS);
    interval.unref?.();
  }
  armWake();
  return evaluateQuota();
}

export function stopQuotaClock() {
  if (interval) clearInterval(interval);
  interval = null;
  clearAim();
}

/**
 * The hold a previous board left. A past `until` reopens now; a future one
 * arms the clock again. A board that died mid-drain finishes draining.
 */
export function resumeQuotaOnBoot() {
  const hold = quotaHold();
  if (!hold) {
    startQuotaClock();
    return null;
  }
  // The file may predate projects, or have been written by an older board: its
  // list is bare issue numbers. Normalised here, once, at the only point where
  // a hold enters this process from disk — after this every reader of
  // `hold.parked` in memory sees keys.
  hold.parked = asKeys(hold.parked);
  if (hold.state === 'draining') {
    // Nothing is in flight after a restart: go back to `held` with the hour it
    // had, so the canary runs again rather than everything at once.
    hold.state = 'held';
    save();
  }
  quotaHooks.log(hold.until && hold.until > Date.now()
    ? `retención pendiente del arranque anterior: se reanuda ${describeResume(hold)}`
    : 'retención pendiente del arranque anterior con la hora ya pasada: se reanuda ahora');
  return startQuotaClock();
}

/** Test seam: forgets everything this process cached, and the file. */
export function resetQuotaForTests({ wipe = true } = {}) {
  stopQuotaClock();
  reopening = false;
  cache = { ...EMPTY };
  loaded = true;
  if (wipe) {
    try { rmSync(quotaFile(), { force: true }); } catch { /* nothing to remove */ }
  }
}

/** Test seam: reads the file again on the next question. */
export function forgetQuotaCache() {
  cache = null;
  loaded = false;
}
