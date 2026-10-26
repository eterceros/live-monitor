import { fill, strings } from './i18n/index.js';

/**
 * One place naming every flow state, so cards, columns and pills agree.
 * `icon` is a name from the closed map in components/Icon.jsx (this file stays
 * plain JS: node imports it in tests, so it must not import Icon or lucide).
 * `label` and `hint` are getters over the catalog: a language switch reaches a
 * card that already holds the object. `hint: false` is a state with no hint.
 */
const state = (icon, tone, key, hint = true) => ({
  icon,
  tone,
  get label() { return strings().shared.status[key].label; },
  get hint() { return hint ? strings().shared.status[key].hint : ''; },
});

export const STATUS = {
  assigned: state('inbox', 'idle', 'assigned'),
  started: state('construction', 'warn', 'started'),
  worktree: state('tree', 'busy', 'worktree'),
  triage: state('search', 'busy', 'triage'),
  plan_ready: state('clipboard', 'warn', 'plan_ready'),
  fixing: state('settings', 'busy', 'fixing'),
  testing: state('flask', 'busy', 'testing'),
  browser_qa: state('compass', 'busy', 'browser_qa'),
  fix_gaps: state('bandage', 'busy', 'fix_gaps'),
  resolving_conflicts: state('branch', 'busy', 'resolving_conflicts'),
  pr_draft: state('note', 'ok', 'pr_draft'),
  ready: state('eye', 'ok', 'ready'),
  waiting_approval: state('eye', 'ok', 'waiting_approval'),
  // `done` is reused by a task closed without a PR (FSD-G09) and by one whose
  // issue somebody closed on GitHub: no merge happened in either, so the hint
  // no longer promises one. The card says which of the three endings it is;
  // this string has no per-task hook, so it covers all of them.
  done: state('check-circle', 'done', 'done'),
  error: state('x-circle', 'error', 'error', false),
};

export const BUSY_STATES = ['worktree', 'triage', 'fixing', 'testing', 'browser_qa', 'fix_gaps', 'resolving_conflicts'];

/**
 * Columns of the board, in flow order, each naming the states it holds — every
 * state except `done` (its own bottom strip) must appear in exactly one column,
 * or its tasks vanish from the board. `ready` and `waiting_approval` share one:
 * both mean an open PR waiting on a reviewer, and two identical columns would
 * only puzzle the reader.
 */
export const COLUMNS = [
  { key: 'assigned', states: ['assigned'] },
  { key: 'started', states: ['started'] },
  { key: 'worktree', states: ['worktree'] },
  { key: 'triage', states: ['triage'] },
  { key: 'plan_ready', states: ['plan_ready'] },
  { key: 'fixing', states: ['fixing'] },
  { key: 'testing', states: ['testing'] },
  { key: 'browser_qa', states: ['browser_qa'] },
  { key: 'fix_gaps', states: ['fix_gaps'] },
  { key: 'resolving_conflicts', states: ['resolving_conflicts'] },
  { key: 'pr_draft', states: ['pr_draft'] },
  { key: 'waiting_approval', states: ['waiting_approval', 'ready'] },
  { key: 'error', states: ['error'] },
];

/**
 * Columns drawn only while they hold a card. `fix_gaps` stays in COLUMNS (for
 * mapping and labels) but the feature is off by default, so an always-empty
 * «Cerrando huecos» column would just be noise.
 */
export const HIDE_WHEN_EMPTY = ['error', 'started', 'fix_gaps', 'resolving_conflicts'];

/**
 * Who drives a task. Not a state: a manual task keeps its real place in the
 * flow (started, waiting_approval...) and only stops being carried by itself.
 * These two get their own columns, grouped by mode instead of by state.
 */
export const MODES = {
  unconfirmed: {
    icon: 'help-circle',
    tone: 'warn',
    get label() { return strings().shared.mode.unconfirmed.label; },
    get hint() { return strings().shared.mode.unconfirmed.hint; },
  },
  manual: {
    icon: 'hand',
    tone: 'warn',
    get label() { return strings().shared.mode.manual.label; },
    get hint() { return strings().shared.mode.manual.hint; },
  },
};

export const modeMeta = (mode) => MODES[mode] ?? null;

/**
 * States and modes that no column would render. Called at boot: this guard was
 * written for exactly the kind of change that moved `manual` out of the states,
 * and it protects nothing if nobody calls it.
 */
export const orphanStates = () => Object.keys(STATUS)
  .filter((s) => s !== 'done' && !COLUMNS.some((c) => c.states.includes(s)));

export const meta = (state) => STATUS[state] ?? { icon: 'dot', label: state, hint: '', tone: 'idle' };

/** The step a machine move is on, or failed at, as the card and the move dialog say it. */
export function moveStepLabel(moving) {
  const { step, from, to } = moving ?? {};
  const labels = strings().shared.moveStep;
  return Object.hasOwn(labels, step) ? fill(labels[step], { from, to }) : String(step ?? '');
}

/**
 * The phase a run is on, or the one it died at. Mirror of `PHASE_LABEL` in
 * `server/src/phases.js`, exactly as the move steps above mirror the move's:
 * the server sends the bare phase and the board says it in the language in
 * use. An unknown (or absent) phase has no label, and the card then says
 * nothing.
 */
export const phaseLabel = (p) => (Object.hasOwn(strings().shared.phase, p) ? strings().shared.phase[p] : null);

/**
 * «modelo · esfuerzo» of the latest session a task ran, for the card's chip and
 * the chat header. `phaseModels` is written in the order sessions start, so the
 * last key is the latest. No effort recorded means «auto». Null when nothing ran.
 */
export function latestPhaseModel(task) {
  const entries = Object.entries(task?.phaseModels ?? {}).filter(([, v]) => v?.model);
  if (!entries.length) return null;
  const [phase, { model, effort }] = entries[entries.length - 1];
  return { phase, model, effort: effort ?? null, label: `${model} · ${effort ?? 'auto'}` };
}

/** The same «modelo · esfuerzo» text for a chat's own pair. */
export const modelEffortLabel = (model, effort) => `${model || strings().shared.modelDefault} · ${effort && effort !== 'auto' ? effort : 'auto'}`;

/**
 * The steps of an SDK upgrade, as the upgrade dialog lists them. Runner steps
 * carry the machine in their `detail`; an unknown name shows as it came.
 */
export const upgradeStepLabel = (name) => (Object.hasOwn(strings().shared.upgradeStep, name)
  ? strings().shared.upgradeStep[name]
  : String(name ?? ''));
