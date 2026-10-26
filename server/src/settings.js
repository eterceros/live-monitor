import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';
import { machines } from './machine.js';
import { openTab, closeTab, pruneTabs, normalizeTabs, sealTabs, isLegacyTab } from './chattabs.js';
import { isProjectId } from './keys.js';
import { normalizeEffort, THINKING_BUDGET } from './effort.js';

const FILE = path.join(DATA_DIR, 'settings.json');

const UPGRADE_DEFAULTS = { skipped: null, snoozedUntil: null, seen: null, acknowledgedJob: null };
const SDK_VERSION = /^0\.3\.\d{1,6}$/;

/**
 * The switches a project may decide for itself, each with the validation that
 * produces the value actually stored.
 *
 * This table is the single definition of "what a valid value for this switch
 * is": {@link Settings#update} and {@link Settings#updateProject} both go
 * through it, so a board-wide value and a per-project one can never drift into
 * accepting different things.
 *
 * `maxActiveTasks` is deliberately **not** here. It protects the Claude account
 * and this machine — not a project — so a project that raised its own would be
 * raising everyone's. Same for `upgrade`, which is about the installed SDK.
 */
const OVERRIDABLE = {
  defaultMachine(value) {
    const name = String(value);
    if (!machines()[name]) {
      throw new Error(`defaultMachine must be one of: ${Object.keys(machines()).join(', ')}`);
    }
    return name;
  },
  pollIntervalMinutes(value) {
    const n = Number(value);
    // The floor is not bureaucracy: at one minute this is a `gh issue list`
    // every minute plus a review query per waiting task, which is how an API
    // quota disappears by way of the minus button.
    if (!Number.isInteger(n) || n < 1 || n > 120) {
      throw new Error('pollIntervalMinutes must be an integer between 1 and 120');
    }
    return n;
  },
  gitRefreshSeconds(value) {
    const n = Number(value);
    // 0 switches the git refresh off; below 15 s it would be a `git fetch`
    // storm per project.
    if (value === null || value === '' || !Number.isInteger(n) || !(n === 0 || (n >= 15 && n <= 3600))) {
      throw new Error('gitRefreshSeconds must be 0 (off) or an integer between 15 and 3600');
    }
    return n;
  },
  autoStart: (value) => Boolean(value),
  browserQa: (value) => Boolean(value),
  approvePlan: (value) => Boolean(value),
  fixGaps: (value) => Boolean(value),
  fullTests: (value) => Boolean(value),
  resolveConflicts: (value) => Boolean(value),
  demo: (value) => Boolean(value),
};

/** A stable order to apply a project patch in, so a rejected patch fails the same way twice. */
const OVERRIDE_ORDER = ['defaultMachine', 'pollIntervalMinutes', 'gitRefreshSeconds', 'autoStart', 'browserQa', 'approvePlan', 'fixGaps', 'fullTests', 'resolveConflicts', 'demo'];

/** The session roles whose model and effort the board can override. */
export const TUNING_ROLES = Object.freeze(['triage', 'advisor', 'plan', 'fix', 'pr', 'demo', 'reply', 'chat', 'qa', 'qaPlan']);

/** A stored effort override: `'auto'` (explicitly nothing) or a level; never undefined. */
function effortOverride(value) {
  return normalizeEffort(value) ?? 'auto';
}

const THINKING_TYPES = ['adaptive', 'enabled', 'disabled'];

/**
 * A stored thinking override: `'auto'` (explicitly nothing) or `{ type, budgetTokens? }`.
 * Only the shape is checked here; whether the model accepts the mode is
 * tuning.js's question, because it needs the model list.
 */
function thinkingOverride(value) {
  if (typeof value === 'string' && value.trim().toLowerCase() === 'auto') return 'auto';
  if (!value || typeof value !== 'object' || Array.isArray(value) || !THINKING_TYPES.includes(value.type)) {
    throw new Error(`thinking must be auto or { type: ${THINKING_TYPES.join('|')} }`);
  }
  if (value.type !== 'enabled') return { type: value.type };
  const n = value.budgetTokens;
  if (!Number.isInteger(n) || n < THINKING_BUDGET.min || n > THINKING_BUDGET.max) {
    throw new Error(`thinking enabled needs budgetTokens, an integer between ${THINKING_BUDGET.min} and ${THINKING_BUDGET.max}`);
  }
  return { type: 'enabled', budgetTokens: n };
}

/**
 * `name@marketplace`: the id `claude plugin install` takes. The first character is
 * alphanumeric so an id can never read as a flag, and nothing outside the class
 * can reach a command line.
 */
export const REQUIRED_PLUGIN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MAX_REQUIRED_PLUGINS = 20;
/** What a board without a stored list requires: installed from the official marketplace, never copied. */
export const DEFAULT_REQUIRED_PLUGINS = Object.freeze(['frontend-design@claude-plugins-official']);

const uniqueTrimmed = (list) => [...new Set(list.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))];

/** Strict, for writes: the whole list is well-formed or it throws. */
function requiredPluginsOverride(value) {
  if (!Array.isArray(value)) throw new Error('requiredPlugins must be a list of ids name@marketplace');
  if (value.some((x) => typeof x !== 'string')) throw new Error('requiredPlugins: each id must be a text name@marketplace');
  const out = uniqueTrimmed(value);
  const bad = out.find((x) => !REQUIRED_PLUGIN_RE.test(x));
  if (bad !== undefined) throw new Error(`requiredPlugins: «${bad}» is not an id name@marketplace`);
  if (out.length > MAX_REQUIRED_PLUGINS) throw new Error(`requiredPlugins accepts at most ${MAX_REQUIRED_PLUGINS} plugins`);
  return out;
}

/** Lenient, for what is read from disk: a hand-edited file cannot hand a bad id to a command line. */
function normalizeRequiredPlugins(stored) {
  if (!Array.isArray(stored)) return [...DEFAULT_REQUIRED_PLUGINS];
  return uniqueTrimmed(stored).filter((x) => REQUIRED_PLUGIN_RE.test(x)).slice(0, MAX_REQUIRED_PLUGINS);
}

const DISMISS_ID = /^[A-Za-z0-9._:[\]-]{1,100}$/;
const MAX_DISMISSED = 50;
const dismissedList = (value) => [...new Set((Array.isArray(value) ? value : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))];

/**
 * The `tuning` overlay as read from disk: only well-formed entries survive, so
 * a hand-edited or older file cannot hand a bad value to a session.
 */
function normalizeTuning(stored) {
  const out = { roles: {} };
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out;
  for (const role of TUNING_ROLES) {
    const o = stored.roles?.[role];
    if (!o || typeof o !== 'object') continue;
    const kept = {};
    if (typeof o.model === 'string' && o.model.trim()) kept.model = o.model.trim();
    try { if (o.effort !== undefined && o.effort !== null) kept.effort = effortOverride(o.effort); } catch { /* dropped */ }
    try { if (o.thinking !== undefined && o.thinking !== null) kept.thinking = thinkingOverride(o.thinking); } catch { /* dropped */ }
    if (Object.keys(kept).length) out.roles[role] = kept;
  }
  if (typeof stored.fastMode === 'boolean') out.fastMode = stored.fastMode;
  // `contextWindow` (an older file) is not read: 5.x always runs with 1M.
  const dismissed = dismissedList(stored.dismissedModels);
  if (dismissed.length) out.dismissedModels = dismissed;
  return out;
}

/**
 * The `upgrade` patch, validated whole before anything is kept: each field is
 * either null (cleared) or a value of its exact shape, and unknown keys are
 * refused rather than stored.
 */
function nextUpgradeSettings(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('upgrade must be an object');
  }
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in UPGRADE_DEFAULTS)) throw new Error(`upgrade.${key} does not exist`);
    if (value === null) {
      next[key] = null;
    } else if (key === 'skipped' || key === 'seen') {
      if (typeof value !== 'string' || !SDK_VERSION.test(value)) throw new Error(`upgrade.${key} must be a 0.3.N version or null`);
      next[key] = value;
    } else if (key === 'snoozedUntil') {
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error('upgrade.snoozedUntil must be an ISO date or null');
      next[key] = new Date(value).toISOString();
    } else if (key === 'acknowledgedJob') {
      if (typeof value !== 'string' || !/^u-[a-z0-9]{1,20}$/.test(value)) throw new Error('upgrade.acknowledgedJob must be an upgrade id or null');
      next[key] = value;
    }
  }
  return next;
}

/**
 * The `projects` overlay as read from disk: an object of project id → patch,
 * with anything unrecognizable dropped rather than carried around. A file
 * written before projects existed has no `projects` at all and lands on `{}`.
 */
function normalizeProjects(stored) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const out = {};
  for (const [id, patch] of Object.entries(stored)) {
    if (!isProjectId(id)) continue;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) continue;
    const kept = {};
    for (const key of Object.keys(OVERRIDABLE)) {
      if (patch[key] !== undefined) kept[key] = patch[key];
    }
    if (Object.keys(kept).length) out[id] = kept;
  }
  return out;
}

/**
 * Runtime-adjustable settings (edited from the dashboard, persisted to disk).
 *
 * ## One board, two very different projects
 *
 * The board watches hfs (Rust, with `hfs`/`hts` binaries and a Playwright
 * suite) and app-b (Python + Vite, with neither). A switch like
 * `browserQa` cannot mean the same thing for both, so on top of the flat values
 * there is an overlay: `values.projects[id]`.
 *
 * The flat values are **both the default and the fallback** — nothing was
 * demoted. `valueFor(id, key)` reads the overlay and falls back to the flat
 * value, so a board with no overlay at all (which is every board until someone
 * sets one) behaves exactly as it did before, and `settings.browserQa` and
 * friends keep answering what they always answered.
 */
class Settings extends EventEmitter {
  constructor() {
    super();
    mkdirSync(DATA_DIR, { recursive: true });
    const stored = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
    this.values = {
      maxActiveTasks: config.limits.defaultMaxActiveTasks,
      autoStart: true,
      pollIntervalMinutes: Math.round((config.poll?.intervalSeconds ?? 600) / 60),
      // How often git state (fetch + branch status) is refreshed; 0 = off.
      gitRefreshSeconds: config.poll?.gitIntervalSeconds ?? 300,
      // Where a task lands when nobody chose: auto-start never asks, so this
      // is the one decision that lets it stay unattended with two machines.
      defaultMachine: 'local',
      // The Browser QA phase, board-wide. Off here and no task runs it,
      // whatever its own switch says.
      browserQa: true,
      // Whether new tasks wait for you to approve the plan before the fix.
      approvePlan: false,
      // Whether a finished fix gets a "close the gaps" round before the PR.
      fixGaps: false,
      // Whether the test phase runs the project's whole suite instead of only
      // what the diff touched. Off: the full suite is CI's job.
      fullTests: false,
      // Whether a task waiting for review that falls into a conflict with its
      // base is merged, verified and pushed by the board. On: it is the
      // common case, and the switch is for the project that wants it off.
      resolveConflicts: true,
      // Whether a finished run writes the demo steps; a task on `auto` follows it.
      demo: true,
      // The tabs over the chat panel: one per task, shared by every browser.
      chatTabs: [],
      // Per-project deviations from everything above. Absent means `{}`.
      projects: {},
      ...stored,
    };
    this.values.chatTabs = normalizeTabs(this.values.chatTabs);
    this.values.projects = normalizeProjects(this.values.projects);
    this.values.tuning = normalizeTuning(this.values.tuning);
    this.values.requiredPlugins = normalizeRequiredPlugins(this.values.requiredPlugins);
  }

  /** The user-level plugins every machine should have (board-wide, never per project). */
  get requiredPlugins() { return [...this.values.requiredPlugins]; }

  /** The board's overrides: `{ roles: {role: {model?, effort?, thinking?}}, fastMode?, dismissedModels? }`. */
  get tuning() { return structuredClone(this.values.tuning); }

  /**
   * Changes the tuning overrides. The whole patch is validated before anything
   * is kept. `null` removes an override (a role, one of its fields or
   * `fastMode`); unknown roles and keys throw. `dismissModel` adds one model
   * to the «new model» notices already dismissed; `contextWindow` is accepted
   * and ignored (older clients still send it).
   *
   * @param {{roles?: Object, fastMode?: boolean|null, contextWindow?: *, dismissModel?: string}} patch
   * @param {{isModel?: (id: string) => boolean}} [check] model validation lives
   *   with the model list (tuning.js), not here.
   */
  updateTuning(patch, { isModel = () => true } = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('tuning must be an object');
    for (const key of Object.keys(patch)) {
      if (!['roles', 'fastMode', 'contextWindow', 'dismissModel'].includes(key)) throw new Error(`tuning.${key} does not exist`);
    }
    const next = structuredClone(this.values.tuning);
    if (patch.roles !== undefined) {
      if (!patch.roles || typeof patch.roles !== 'object' || Array.isArray(patch.roles)) throw new Error('tuning.roles must be an object');
      for (const [role, o] of Object.entries(patch.roles)) {
        if (!TUNING_ROLES.includes(role)) throw new Error(`role «${role}» does not exist: use ${TUNING_ROLES.join(', ')}`);
        if (o === null) { delete next.roles[role]; continue; }
        if (typeof o !== 'object' || Array.isArray(o)) throw new Error(`tuning.roles.${role} must be an object or null`);
        const cur = { ...(next.roles[role] ?? {}) };
        for (const key of Object.keys(o)) {
          if (key !== 'model' && key !== 'effort' && key !== 'thinking') throw new Error(`tuning.roles.${role}.${key} does not exist`);
        }
        if (o.model !== undefined) {
          if (o.model === null) delete cur.model;
          else {
            const id = String(o.model).trim();
            if (!isModel(id)) throw new Error(`model «${id}» is not available for ${role}`);
            cur.model = id;
          }
        }
        if (o.effort !== undefined) {
          if (o.effort === null) delete cur.effort;
          else cur.effort = effortOverride(o.effort);
        }
        if (o.thinking !== undefined) {
          if (o.thinking === null) delete cur.thinking;
          else cur.thinking = thinkingOverride(o.thinking);
        }
        if (Object.keys(cur).length) next.roles[role] = cur;
        else delete next.roles[role];
      }
    }
    if (patch.fastMode !== undefined) {
      if (patch.fastMode === null) delete next.fastMode;
      else if (typeof patch.fastMode !== 'boolean') throw new Error('tuning.fastMode must be true, false or null');
      else next.fastMode = patch.fastMode;
    }
    if (patch.dismissModel !== undefined) {
      if (typeof patch.dismissModel !== 'string' || !DISMISS_ID.test(patch.dismissModel.trim())) throw new Error('tuning.dismissModel must be a model id');
      // Capped: the oldest dismissals fall off.
      next.dismissedModels = dismissedList([...(next.dismissedModels ?? []), patch.dismissModel]).slice(-MAX_DISMISSED);
    }
    this.values.tuning = next;
    return this.#persist();
  }

  /** What the upgrade offer remembers: a version skipped, a snooze, the version already shown. */
  get upgrade() { return { ...UPGRADE_DEFAULTS, ...(this.values.upgrade ?? {}) }; }

  get browserQa() { return this.values.browserQa !== false; }
  get approvePlan() { return this.values.approvePlan === true; }
  get fixGaps() { return this.values.fixGaps === true; }
  get fullTests() { return this.values.fullTests === true; }
  get resolveConflicts() { return this.values.resolveConflicts !== false; }
  get demo() { return this.values.demo !== false; }

  get maxActiveTasks() { return this.values.maxActiveTasks; }
  get pollIntervalMinutes() { return this.values.pollIntervalMinutes; }
  get gitRefreshSeconds() { return this.values.gitRefreshSeconds; }
  get autoStart() { return this.values.autoStart; }
  get ceiling() { return config.limits.maxActiveTasksCeiling; }

  /** A machine removed from config.json since this was chosen falls back to local. */
  get defaultMachine() {
    return machines()[this.values.defaultMachine] ? this.values.defaultMachine : 'local';
  }

  /* ---------------------------------------------------------------------
   * Per project
   * ------------------------------------------------------------------ */

  /** Everything this project decides for itself; `{}` when it follows the board. */
  projectValues(id) {
    return { ...(this.values.projects?.[id] ?? {}) };
  }

  /**
   * One switch as it applies to one project: its own value when it set one,
   * the board's otherwise.
   *
   * An unknown or missing `id` simply finds no overlay and gets the board
   * value, which is what makes every existing caller — and every call site
   * still to be converted — correct without a special case.
   *
   * @param {string|undefined} id
   * @param {string} key
   */
  valueFor(id, key) {
    return this.values.projects?.[id]?.[key] ?? this.values[key];
  }

  /** {@link Settings#browserQa} for one project. */
  browserQaFor(id) { return this.valueFor(id, 'browserQa') !== false; }

  /** {@link Settings#approvePlan} for one project. */
  approvePlanFor(id) { return this.valueFor(id, 'approvePlan') === true; }

  /** {@link Settings#fixGaps} for one project. */
  fixGapsFor(id) { return this.valueFor(id, 'fixGaps') === true; }

  /** {@link Settings#fullTests} for one project. */
  fullTestsFor(id) { return this.valueFor(id, 'fullTests') === true; }

  /** {@link Settings#resolveConflicts} for one project: on unless it says otherwise. */
  resolveConflictsFor(id) { return this.valueFor(id, 'resolveConflicts') !== false; }

  /** {@link Settings#demo} for one project: on unless it says otherwise. */
  demoFor(id) { return this.valueFor(id, 'demo') !== false; }

  /** {@link Settings#autoStart} for one project. */
  autoStartFor(id) { return this.valueFor(id, 'autoStart'); }

  /** {@link Settings#pollIntervalMinutes} for one project. */
  pollIntervalMinutesFor(id) { return this.valueFor(id, 'pollIntervalMinutes'); }

  /** {@link Settings#gitRefreshSeconds} for one project. */
  gitRefreshSecondsFor(id) { return this.valueFor(id, 'gitRefreshSeconds'); }

  /** {@link Settings#defaultMachine} for one project, with the same fallback to local. */
  defaultMachineFor(id) {
    const name = this.valueFor(id, 'defaultMachine');
    return machines()[name] ? name : 'local';
  }

  /**
   * Sets what one project decides for itself. Each key is validated exactly as
   * {@link Settings#update} validates it — same function, so they cannot drift.
   *
   * `null` **removes** the override and the project goes back to following the
   * board. Without it there would be no way back: `Boolean(null)` is `false`,
   * so a null would otherwise mean "off", not "whatever the board says".
   *
   * A key that is not per-project is refused rather than quietly stored, so
   * `maxActiveTasks` cannot end up in a project's patch looking like it works.
   *
   * @param {string} id a valid project id.
   * @param {Object} patch
   */
  updateProject(id, patch) {
    if (!isProjectId(id)) throw new Error(`invalid project: ${JSON.stringify(id ?? null)}`);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('the project settings must be an object');
    }
    for (const key of Object.keys(patch)) {
      if (patch[key] === undefined) continue;
      if (!(key in OVERRIDABLE)) {
        throw new Error(`${key} is not set per project (it belongs to the whole board): ${Object.keys(OVERRIDABLE).join(', ')}`);
      }
    }
    const next = { ...(this.values.projects?.[id] ?? {}) };
    for (const key of OVERRIDE_ORDER) {
      const value = patch[key];
      if (value === undefined) continue;
      if (value === null) delete next[key];
      else next[key] = OVERRIDABLE[key](value);
    }
    const projects = { ...(this.values.projects ?? {}) };
    if (Object.keys(next).length) projects[id] = next;
    else delete projects[id];
    this.values.projects = projects;
    return this.#persist();
  }

  /**
   * The board-wide values: unchanged, key by key and in the same order as
   * before, only with the shared switches validated through {@link OVERRIDABLE}
   * instead of inline. `maxActiveTasks` and `upgrade` stay here and only here.
   */
  update(patch) {
    // Validated up front so a bad list leaves the other keys of the patch unapplied.
    const required = patch.requiredPlugins !== undefined ? requiredPluginsOverride(patch.requiredPlugins) : null;
    if (patch.defaultMachine !== undefined) {
      this.values.defaultMachine = OVERRIDABLE.defaultMachine(patch.defaultMachine);
    }
    if (patch.maxActiveTasks !== undefined) {
      const n = Number(patch.maxActiveTasks);
      if (!Number.isInteger(n) || n < 1 || n > this.ceiling) {
        throw new Error(`maxActiveTasks must be an integer between 1 and ${this.ceiling}`);
      }
      this.values.maxActiveTasks = n;
    }
    if (patch.pollIntervalMinutes !== undefined) {
      this.values.pollIntervalMinutes = OVERRIDABLE.pollIntervalMinutes(patch.pollIntervalMinutes);
    }
    if (patch.gitRefreshSeconds !== undefined) {
      this.values.gitRefreshSeconds = OVERRIDABLE.gitRefreshSeconds(patch.gitRefreshSeconds);
    }
    if (patch.upgrade !== undefined) this.values.upgrade = nextUpgradeSettings(this.upgrade, patch.upgrade);
    if (patch.autoStart !== undefined) this.values.autoStart = OVERRIDABLE.autoStart(patch.autoStart);
    if (patch.browserQa !== undefined) this.values.browserQa = OVERRIDABLE.browserQa(patch.browserQa);
    if (patch.approvePlan !== undefined) this.values.approvePlan = OVERRIDABLE.approvePlan(patch.approvePlan);
    if (patch.fixGaps !== undefined) this.values.fixGaps = OVERRIDABLE.fixGaps(patch.fixGaps);
    if (patch.fullTests !== undefined) this.values.fullTests = OVERRIDABLE.fullTests(patch.fullTests);
    if (patch.resolveConflicts !== undefined) this.values.resolveConflicts = OVERRIDABLE.resolveConflicts(patch.resolveConflicts);
    if (patch.demo !== undefined) this.values.demo = OVERRIDABLE.demo(patch.demo);
    if (required) this.values.requiredPlugins = required;
    return this.#persist();
  }

  get chatTabs() { return this.values.chatTabs; }

  /**
   * Opens a task's tab, or marks an open one as just used. The strip changes
   * one operation at a time here, never as a whole list sent by a browser:
   * two devices doing that would overwrite each other's tabs. `isKnown` drops
   * the tabs of tasks the board no longer has.
   */
  openChatTab(entry, isKnown = () => true) {
    this.values.chatTabs = openTab(pruneTabs(this.values.chatTabs, isKnown), entry);
    return this.#persist();
  }

  /** Takes a tab out of the strip. Its chats are not touched. */
  closeChatTab(entry) {
    this.values.chatTabs = closeTab(this.values.chatTabs, entry);
    return this.#persist();
  }

  /**
   * Gives the tabs saved before projects existed (no `project`) the project the
   * board opens on. Settings cannot see the registry, so the caller says which.
   * Writes only when there was something to seal.
   */
  adoptLegacyTabs(projectId) {
    if (!this.values.chatTabs.some(isLegacyTab)) return this.snapshot();
    this.values.chatTabs = sealTabs(this.values.chatTabs, projectId);
    return this.#persist();
  }

  #persist() {
    writeFileSync(FILE, JSON.stringify(this.values, null, 2), 'utf8');
    this.emit('change', this.snapshot());
    return this.snapshot();
  }

  /**
   * What the board renders from. The flat values stay flat and stay first-class
   * — `web/src/App.jsx` reads them straight off this object and posts them back
   * to `/api/settings` — and `projects` rides alongside them, never instead.
   */
  snapshot() {
    return {
      ...this.values,
      upgrade: this.upgrade,
      defaultMachine: this.defaultMachine,
      ceiling: this.ceiling,
      projects: { ...(this.values.projects ?? {}) },
    };
  }
}

export const settings = new Settings();
