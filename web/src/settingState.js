/**
 * What a setting says, computed on the client from the task / settings the board
 * already has: its three-valued choice, whether it is effectively on, and where
 * that answer comes from. Plain JS (no React, no JSX): node imports it in tests.
 */

import { fill, strings } from './i18n/index.js';

const words = () => strings().shared.setting;

/**
 * The three-valued choice of the card and the menu: force on, force off, or
 * follow the default. `label` is a getter over the catalog, so the options a
 * component already holds follow a language switch.
 */
export const TRI_OPTIONS = [
  { value: 'on', get label() { return words().tri.on; } },
  { value: 'off', get label() { return words().tri.off; } },
  { value: 'auto', get label() { return words().tri.auto; } },
];

/** The same without `auto`: project settings when there is no active project (the flat board value). */
export const DUO_OPTIONS = TRI_OPTIONS.slice(0, 2);

/** The word shown next to a setting's name: «sí» / «no» in Spanish. */
export function statusText(effective) {
  return effective ? words().yes : words().no;
}

/**
 * The state of one three-valued setting of a task. The semantics are the ones the
 * card's switches always had (TaskCard `Toggle`s): the server's `*Wanted` answer
 * decides what `auto` means, and the project's Browser QA switch can lock the card.
 *
 * @param {object} task a task as the board serves it
 * @param {'demo'|'browserQa'|'approvePlan'|'fixGaps'|'fullTests'|'resolveConflicts'} key
 * @returns {{ value: 'on'|'off'|'auto', effective: boolean, source: string, locked: boolean, detail: string }}
 */
export function taskTriState(task, key) {
  const t = task ?? {};
  switch (key) {
    case 'demo': {
      const value = t.demo ?? 'auto';
      // The server's `demoWanted` already folds the project and the task together.
      const effective = Boolean(t.demoWanted ?? t.demo !== 'off');
      const w = words();
      const detail = value === 'off'
        ? w.demoOff
        : value === 'on'
          ? w.demoOn
          : fill(w.demoAuto, { state: statusText(effective) });
      return { value, effective, source: value === 'auto' ? w.fromProject : w.chosen, locked: false, detail };
    }
    case 'browserQa': {
      // The project's switch (or the board's) wins over the card's own: with it
      // off the phase never runs, so the card shows it off and locked.
      const locked = t.browserQaProjectOn === false;
      const value = t.browserQa ?? 'auto';
      const effective = !locked && value !== 'off' && (value === 'on' || t.qaUi !== false);
      const w = words();
      let detail;
      if (locked) detail = w.browserQaLocked;
      else if (value === 'off') detail = w.browserQaOff;
      else if (value === 'on') detail = w.browserQaOn;
      else {
        const seen = t.qaUi === false ? w.qaNotApplicable : t.qaUi ? w.qaApplicable : w.qaUndecided;
        detail = fill(w.browserQaAuto, { seen });
      }
      const source = locked ? w.offInProject : value === 'auto' ? w.fromTriage : w.chosen;
      return { value, effective, source, locked, detail };
    }
    case 'approvePlan': {
      const value = t.approvePlan ?? 'auto';
      const effective = value === 'on' || (value !== 'off' && t.approvePlanWanted === true);
      const w = words();
      const detail = value === 'off'
        ? w.approveOff
        : value === 'on'
          ? w.approveOn
          : fill(w.approveAuto, { state: statusText(t.approvePlanWanted === true) });
      return { value, effective, source: value === 'auto' ? w.fromBoard : w.chosen, locked: false, detail };
    }
    case 'fixGaps': {
      // Gaps are what the verification found and the fix did not close; the
      // board tries before opening the PR.
      const value = t.fixGaps ?? 'auto';
      const effective = value === 'on' || (value !== 'off' && t.fixGapsWanted === true);
      const w = words();
      const detail = value === 'off'
        ? w.gapsOff
        : value === 'on'
          ? w.gapsOn
          : fill(w.gapsAuto, { state: statusText(t.fixGapsWanted === true) });
      return { value, effective, source: value === 'auto' ? w.fromBoard : w.chosen, locked: false, detail };
    }
    case 'fullTests': {
      // Off: the test phase runs only what the diff touched; CI runs the rest.
      const value = t.fullTests ?? 'off';
      const effective = value === 'on' || (value === 'auto' && t.fullTestsWanted === true);
      const w = words();
      const detail = value === 'off'
        ? w.fullTestsOff
        : value === 'on'
          ? w.fullTestsOn
          : fill(w.fullTestsAuto, { state: statusText(t.fullTestsWanted === true) });
      return { value, effective, source: value === 'auto' ? w.fromBoard : w.chosen, locked: false, detail };
    }
    case 'resolveConflicts': {
      // On unless the project or the card says otherwise: a PR waiting for
      // review that falls into a conflict with its base is resolved by the board.
      const value = t.resolveConflicts ?? 'auto';
      const effective = value === 'on' || (value === 'auto' && t.resolveConflictsWanted !== false);
      const w = words();
      const detail = value === 'off'
        ? w.resolveConflictsOff
        : value === 'on'
          ? w.resolveConflictsOn
          : fill(w.resolveConflictsAuto, { state: statusText(t.resolveConflictsWanted !== false) });
      return { value, effective, source: value === 'auto' ? w.fromBoard : w.chosen, locked: false, detail };
    }
    default:
      throw new Error(`taskTriState: unknown setting "${key}"`); // i18n-ok: developer error
  }
}

/** Keys that are on unless the value is explicitly `false`; the rest are on only when exactly `true`. */
const DEFAULT_ON = new Set(['autoStart', 'browserQa', 'demo', 'resolveConflicts']);

const isOn = (key, v) => (DEFAULT_ON.has(key) ? v !== false : v === true);

/**
 * The state of one setting of the active project: its own override, else the board's value.
 *
 * @param {object|undefined} own `settings.projects[activeProject] ?? {}`
 * @param {object|undefined} settings the board's flat settings
 * @param {string} key autoStart | browserQa | demo | approvePlan | fixGaps | fullTests | resolveConflicts
 * @param {boolean} hasProject with no active project the flat value is edited, so there is no `auto`
 * @returns {{ value: 'on'|'off'|'auto', effective: boolean, source: string }}
 */
export function projectTriState(own, settings, key, hasProject) {
  const mine = own ?? {};
  const board = settings ?? {};
  if (!hasProject) {
    const effective = isOn(key, board[key]);
    return { value: effective ? 'on' : 'off', effective, source: words().fromBoard };
  }
  if (key in mine) {
    const effective = isOn(key, mine[key]);
    return { value: mine[key] ? 'on' : 'off', effective, source: words().projectOwn };
  }
  return { value: 'auto', effective: isOn(key, board[key]), source: words().fromBoard };
}

/** @returns {boolean|null} what `saveProjectSetting` takes: `null` drops the override. */
export function triToProject(value) {
  if (value === 'on') return true;
  if (value === 'off') return false;
  return null;
}
