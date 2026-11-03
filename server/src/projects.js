/**
 * The project registry: which projects the board watches, and what each one is
 * allowed to override from the global configuration.
 *
 * The board has always watched exactly one project, spelled out in
 * `config.json` (`project.repoPath`, `project.worktreeRoot`, `github.*`). This
 * module is where a second one becomes expressible, without any of today's
 * readers changing: `stack.js`, `pipeline.js` and `claude.js` still read the
 * global `config`, and nothing here is wired into them yet.
 *
 * ## Without `server/data/projects.json`, nothing changes
 *
 * There is no migration and no file written at boot. When the file is absent
 * the registry seeds itself, in memory only, with one entry built from today's
 * `config` — the same repo, the same assignee, no overrides — so a board that
 * never grows a second project behaves exactly as it does now.
 *
 * ## Nothing here writes on import
 *
 * `server/test/data-dir.test.mjs` is a static analyser over the import graph:
 * a module that writes to the data directory at load time poisons every test
 * that can reach it, and several of them can reach this one. So the seeding is
 * lazy — it happens on the first call, and it touches no disk. The single
 * place that writes is {@link saveProjects}, which today nobody calls; the
 * project form in the UI will.
 *
 * @module projects
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { config, mergeInto, DATA_DIR } from './config.js';
import { PROFILE_IDS, isProfileId } from './profiles.js';
import { DEFAULT_PROJECT_ID, PROJECT_ID_RE, isProjectId } from './keys.js';
import { setProjectResolver } from './prompts.js';

/** @typedef {import('./keys.js').Project} Project */

const FILE = path.join(DATA_DIR, 'projects.json');

/**
 * Config paths a project may never override, as exact paths or as patterns
 * against the dotted path.
 *
 * These are the secrets. `config.json` is versioned and `config.local.json` is
 * not, which is the whole mechanism keeping tokens out of git; a per-project
 * override would carry a token back into `projects.json`, a file the UI writes
 * and nobody thought to gitignore. A project that needs a different token
 * needs a different machine, not an override.
 *
 * @type {ReadonlyArray<string|RegExp>}
 */
export const FORBIDDEN_OVERRIDES = ['access.token', /^machines\.[^.]+\.token$/];

/**
 * An id that is only digits. {@link PROJECT_ID_RE} admits it — deliberately,
 * it is a URL-and-directory-safety rule and `1447` breaks none of it — but the
 * registry refuses it anyway: attachments used to live in `attachments/<issue>/`
 * and are moving to `attachments/<project>/<issue>/`, so a project called
 * `1447` would land on top of issue 1447's old directory. Cheaper to forbid
 * seven ids than to disambiguate that forever.
 */
const ALL_DIGITS = /^\d+$/;

/** The loaded registry, or `null` before the first call. */
let cache = null;
/** So the seeded default does not log its (empty) overrides on every read. */
const SEED_ANNOUNCED = { done: false };
function announceOnce(flag, list) {
  if (flag.done) return;
  flag.done = true;
  if (list) announce(list);
}

/* -------------------------------------------------------------------------
 * Overrides
 * ---------------------------------------------------------------------- */

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Every dotted path inside `obj`, parents included.
 *
 * Parents matter for {@link assertOverridesAllowed}: `{access: {token: {...}}}`
 * has no leaf at `access.token`, and a check that only looked at leaves would
 * wave it through.
 *
 * @param {Object} obj
 * @param {string} [prefix]
 * @returns {string[]} in declaration order, each parent before its children.
 */
function allPaths(obj, prefix = '') {
  const out = [];
  for (const [key, value] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${key}` : key;
    out.push(p);
    if (isPlainObject(value)) out.push(...allPaths(value, p));
  }
  return out;
}

/**
 * The dotted paths of the values an overrides object actually sets — the
 * leaves, with no intermediate objects. This is what the log line reports:
 * `models.fix` says something, `models` on its own does not.
 *
 * @param {Object} obj
 * @param {string} [prefix]
 * @returns {string[]}
 */
function leafPaths(obj, prefix = '') {
  const out = [];
  for (const [key, value] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value) && Object.keys(value).length) out.push(...leafPaths(value, p));
    else out.push(p);
  }
  return out;
}

const forbids = (dotted) =>
  FORBIDDEN_OVERRIDES.some((rule) => (typeof rule === 'string' ? rule === dotted : rule.test(dotted)));

/**
 * Refuses an overrides object that would replace a secret. **Throws**, naming
 * the exact path: a silently dropped override is worse than a crash, because
 * the project would then run on the global token while its file says otherwise.
 *
 * @param {Object} overrides
 * @returns {void}
 * @throws {Error} if any path — leaf or parent — is a forbidden one.
 */
export function assertOverridesAllowed(overrides) {
  if (overrides === undefined || overrides === null) return;
  if (!isPlainObject(overrides)) {
    throw new Error(`overrides must be an object, not ${JSON.stringify(overrides)}`);
  }
  for (const dotted of allPaths(overrides)) {
    if (forbids(dotted)) {
      throw new Error(`overrides.${dotted}: keys holding secrets cannot be overridden per project`);
    }
  }
}

/* -------------------------------------------------------------------------
 * Entries
 * ---------------------------------------------------------------------- */

function str(value, where) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${where}: expected a non-empty string, not ${JSON.stringify(value ?? null)}`);
  }
  return value;
}

/** `local` is deliberately absent: pipeline sessions never load localSettings. */
const SETTING_SOURCES = ['user', 'project'];
/** A GitHub login: alphanumerics and inner hyphens, at most 39 characters. */
export const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const LANGUAGE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

function branchName(value, where) {
  const v = str(value, where);
  // Enough of git's check-ref-format to keep a value out of a command line as
  // anything but a branch name.
  // A leading `+` would turn the base into a force-push refspec downstream, and
  // the lone `@` is git's alias for HEAD.
  if (/^[-+]|^@$|^\/|\/\/|\.\.|[\s~^:?*[\\\x00-\x1f\x7f]|\/$|\.$|\.lock$|@\{/.test(v)) {
    throw new Error(`${where}: invalid branch name ${JSON.stringify(v)}`);
  }
  return v;
}

function loginOf(value, where) {
  const v = str(value, where);
  if (!LOGIN_RE.test(v)) throw new Error(`${where}: invalid GitHub login ${JSON.stringify(v)}`);
  return v;
}

function strOrNull(value, where) {
  if (value === undefined || value === null) return null;
  return str(value, where);
}

/**
 * Validates one registry entry and returns it in canonical shape.
 *
 * @param {unknown} raw
 * @param {string} where what to call it in an error message.
 * @returns {Project}
 * @throws {Error} on any invalid field.
 */
function normalize(raw, where) {
  if (!isPlainObject(raw)) {
    throw new Error(`${where}: expected an object, not ${JSON.stringify(raw ?? null)}`);
  }
  const id = raw.id;
  if (!isProjectId(id)) {
    throw new Error(
      `${where}.id: invalid project id ${JSON.stringify(id ?? null)}; `
      + `it must match ${PROJECT_ID_RE}`,
    );
  }
  if (ALL_DIGITS.test(id)) {
    throw new Error(
      `${where}.id: "${id}" is only digits; it would clash with the legacy directory `
      + `attachments/${id}/ of issue ${id}`,
    );
  }
  const overrides = raw.overrides === undefined || raw.overrides === null ? {} : raw.overrides;
  if (!isPlainObject(overrides)) {
    throw new Error(`${where}.overrides: expected an object, not ${JSON.stringify(overrides)}`);
  }
  assertOverridesAllowed(overrides);
  const out = {
    id,
    name: str(raw.name, `${where}.name`),
    repoPath: str(raw.repoPath, `${where}.repoPath`),
    worktreeRoot: str(raw.worktreeRoot, `${where}.worktreeRoot`),
    repo: strOrNull(raw.repo, `${where}.repo`),
    assignee: str(raw.assignee, `${where}.assignee`),
    reviewer: raw.reviewer === undefined || raw.reviewer === null ? null : loginOf(raw.reviewer, `${where}.reviewer`),
    overrides: structuredClone(overrides),
  };
  // Optional fields appear only when declared, so an old registry round-trips
  // byte for byte and a seeded entry keeps today's shape.
  if (raw.baseBranch !== undefined && raw.baseBranch !== null) {
    out.baseBranch = branchName(raw.baseBranch, `${where}.baseBranch`);
  }
  if (raw.lastReviewer !== undefined && raw.lastReviewer !== null) {
    out.lastReviewer = loginOf(raw.lastReviewer, `${where}.lastReviewer`);
  }
  // The GitHub account the project works as: a login, never a token. The
  // token is asked of `gh`'s keyring at use (`gh-account.js`), so nothing
  // secret ever reaches this file.
  if (raw.ghUser !== undefined && raw.ghUser !== null) {
    out.ghUser = loginOf(raw.ghUser, `${where}.ghUser`);
  }
  if (raw.noReviewer !== undefined && raw.noReviewer !== null) {
    if (typeof raw.noReviewer !== 'boolean') {
      throw new Error(`${where}.noReviewer: expected true or false, not ${JSON.stringify(raw.noReviewer)}`);
    }
    out.noReviewer = raw.noReviewer;
  }
  if (raw.design !== undefined && raw.design !== null) {
    if (typeof raw.design !== 'boolean') {
      throw new Error(`${where}.design: expected true or false, not ${JSON.stringify(raw.design)}`);
    }
    out.design = raw.design;
  }
  if (raw.restricted !== undefined && raw.restricted !== null) {
    if (typeof raw.restricted !== 'boolean') {
      throw new Error(`${where}.restricted: expected true or false, not ${JSON.stringify(raw.restricted)}`);
    }
    // Stored only when true, so an unrestricted registry round-trips as it was.
    if (raw.restricted) out.restricted = true;
  }
  if (raw.language !== undefined && raw.language !== null) {
    if (typeof raw.language !== 'string' || !LANGUAGE_RE.test(raw.language)) {
      throw new Error(`${where}.language: expected a code such as "en" or "es", not ${JSON.stringify(raw.language)}`);
    }
    out.language = raw.language;
  }
  if (raw.kind !== undefined && raw.kind !== null) {
    if (!isProfileId(raw.kind)) {
      throw new Error(`${where}.kind: unknown profile ${JSON.stringify(raw.kind)}; valid: ${PROFILE_IDS.join(', ')}`);
    }
    out.kind = raw.kind;
  }
  if (raw.settingSources !== undefined && raw.settingSources !== null) {
    const ss = raw.settingSources;
    if (!Array.isArray(ss) || ss.length === 0 || ss.some((v) => !SETTING_SOURCES.includes(v)) || new Set(ss).size !== ss.length) {
      throw new Error(
        `${where}.settingSources: expected a subset without repeats of ${SETTING_SOURCES.join('|')}, not ${JSON.stringify(ss)}`,
      );
    }
    out.settingSources = [...ss];
  }
  return out;
}

/**
 * The whole list, validated together: entry shapes plus the one rule that
 * needs more than one entry to check.
 *
 * @param {unknown} list
 * @returns {Project[]}
 */
function normalizeList(list) {
  if (!Array.isArray(list)) {
    throw new Error(`projects.json: expected an array, not ${JSON.stringify(list ?? null)}`);
  }
  // An empty list is valid: every project may have been removed from the board.
  const out = list.map((raw, i) => normalize(raw, `projects[${i}]`));
  const seen = new Set();
  for (const p of out) {
    if (seen.has(p.id)) throw new Error(`projects.json: duplicate project id "${p.id}"`);
    seen.add(p.id);
  }
  return out;
}

/**
 * The registry the board has today, expressed as one entry. Built from
 * `config`, in memory, every time it is needed.
 *
 * `repo` comes straight from `config.github.repo`, `null` when it is unset:
 * detecting it means shelling out to `git`, and `github.js` already does that,
 * cached, where it matters. A registry built at import time is no place for a
 * subprocess.
 *
 * @returns {Project}
 */
function seed() {
  return {
    id: DEFAULT_PROJECT_ID,
    name: 'hfs',
    repoPath: config.project.repoPath,
    worktreeRoot: config.project.worktreeRoot,
    repo: config.github.repo ?? null,
    assignee: config.github.assignee,
    reviewer: config.github.reviewer,
    overrides: {},
  };
}

/**
 * Says, once per load, what each project deviates from. A project can move a
 * port, change a model or lift the task cap; that has to be visible in the log
 * without anyone opening `projects.json`.
 *
 * @param {Project[]} list
 */
function announce(list) {
  for (const p of list) {
    const paths = leafPaths(p.overrides);
    if (paths.length) console.log(`[projects] ${p.id} sobrescribe: ${paths.join(', ')}`);
  }
}

/**
 * Loads the registry on first use and keeps it. No disk write on this path,
 * ever — a missing file seeds in memory and stays there until someone calls
 * {@link saveProjects}.
 *
 * @returns {Project[]}
 */
function load() {
  if (cache) return cache;
  let raw;
  try {
    raw = readFileSync(FILE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // Seeded, not cached. The seed is derived from `config`, which reloads
    // from disk while the board runs -- the README promises that editing the
    // assignee or the reviewer in config.json takes effect without a restart,
    // and caching the seed here would quietly take that away. A file on disk
    // is a decision someone made and is cached; a seed is just today's config
    // wearing a registry's shape.
    //
    // A config that names no checkout (`project.repoPath` empty, as in the
    // checked-in `config.json` of a fresh board) describes no project at all:
    // seeding one would put an entry that fails validation in front of every
    // list, and the first import, which saves the whole list, would be refused
    // for it. Such a board starts empty, like one whose projects were removed.
    if (!config.project?.repoPath?.trim()) return [];
    announceOnce(SEED_ANNOUNCED, null);
    return [seed()];
  }
  cache = normalizeList(JSON.parse(raw));
  announce(cache);
  return cache;
}

/* -------------------------------------------------------------------------
 * The API
 * ---------------------------------------------------------------------- */

/**
 * Every registered project, in file order — which is display order for the
 * selector.
 *
 * @returns {Project[]} a fresh array each call; the entries themselves are the
 *   cached objects, so callers must not mutate them.
 */
export function listProjects() {
  return [...load()];
}

/**
 * One project by id.
 *
 * @param {string} id
 * @returns {Project|undefined} `undefined` when nothing is registered under it.
 */
export function projectOf(id) {
  return load().find((p) => p.id === id);
}

// Late-bound so prompts.js never imports this (data-dir writer) module.
setProjectResolver((id) => projectOf(id));

/**
 * Sections a project's override REPLACES outright instead of merging into.
 *
 * Everywhere else a recursive merge is what you want: a project that sets one
 * model or one limit means that one, and inherits the rest. These three are
 * different, because they are not settings -- they are the commands the board
 * runs inside somebody's repository.
 *
 * Merged, a Python project that declares `e2e: { testCommand: 'pytest' }`
 * would inherit hfs's `prepareCommand`, and the board would run
 * `cargo build --release` in a repository with no Cargo.toml before running
 * its tests. Inherited defaults are helpful for a number and dangerous for a
 * command line: the failure is silent, plausible, and in the wrong repository.
 *
 * So declaring one of these means declaring all of it.
 */
const REPLACED_WHOLE = ['e2e', 'stack', 'qa'];

/**
 * The global configuration with this project's overrides merged on top.
 *
 * **A new object every call, never a cached one.** Two reasons, both load
 * bearing: `mergeInto` mutates its first argument (`config.js:22`), so it must
 * be handed a clone or it would rewrite the live config; and `config` is a
 * singleton reloaded in place when `config.json` changes (`config.js:67-69`),
 * so a cached merge would go on serving values the file no longer has.
 *
 * @param {string} id
 * @returns {Object} a deep clone of `config`, with the overrides applied.
 * @throws {Error} if no project is registered under `id`.
 */
export function configFor(id) {
  const project = projectOf(id);
  if (!project) {
    throw new Error(`configFor: no project is registered as ${JSON.stringify(id ?? null)}`);
  }
  const merged = mergeInto(structuredClone(config), project.overrides);
  for (const section of REPLACED_WHOLE) {
    if (Object.hasOwn(project.overrides, section)) {
      merged[section] = structuredClone(project.overrides[section]);
    }
  }
  return merged;
}

/**
 * One section of {@link configFor}, without cloning the rest of the
 * configuration: the board asks for a single section once per task and per chat
 * every time it builds its state, and a deep clone of everything for each of
 * them was most of the time it took. Same result as `configFor(id)[section]`,
 * and just as fresh: a new object, never a cached one.
 *
 * @param {string} id
 * @param {string} section a top-level key of the configuration.
 * @returns {*} the merged section, or `undefined` when neither side has it.
 * @throws {Error} if no project is registered under `id`.
 */
export function configSectionFor(id, section) {
  const project = projectOf(id);
  if (!project) {
    throw new Error(`configFor: no project is registered as ${JSON.stringify(id ?? null)}`);
  }
  const over = project.overrides ?? {};
  if (REPLACED_WHOLE.includes(section) && Object.hasOwn(over, section)) return structuredClone(over[section]);
  const base = config[section] === undefined ? {} : { [section]: structuredClone(config[section]) };
  return mergeInto(base, Object.hasOwn(over, section) ? { [section]: over[section] } : {})[section];
}

/**
 * Writes the registry to `server/data/projects.json`, validating it first.
 *
 * The only function in this module that touches disk for writing, and the only
 * place the file is ever produced — which is why nothing writes at import time
 * and why a board with no `projects.json` never grows one by accident.
 *
 * @param {Project[]} list
 * @returns {Project[]} the normalized list, now also the cached one.
 * @throws {Error} if the list is invalid; nothing is written in that case.
 */
export function saveProjects(list) {
  const next = normalizeList(list);
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  cache = next;
  announce(cache);
  return [...cache];
}

/**
 * The branch PRs and worktrees of this project start from and target: the
 * registry's `baseBranch`, else `'main'`. Dependency-free on purpose.
 *
 * @param {string} [projectId]
 * @returns {string}
 */
export function baseBranchOf(projectId) {
  return projectOf(projectId)?.baseBranch || 'main';
}

/**
 * Changes a project's base branch live, through the same single writer as
 * {@link saveProjects}: that call updates `cache`, and `baseBranchOf` reads the
 * registry at use (no task stores its base), so no restart is needed. The name
 * goes through `branchName`, which already refuses a leading `+` and a lone `@`.
 *
 * On a board with no `projects.json` the first write freezes the config seed
 * into the file, exactly as `rememberReviewer` and `setReviewer` do.
 *
 * @param {string} id
 * @param {string} base
 * @returns {Project} the saved entry.
 * @throws {Error} if the project is unknown or the name is not a valid branch.
 */
export function setBaseBranch(id, base) {
  const list = load().map((p) => ({ ...p }));
  const target = list.find((p) => p.id === id);
  if (!target) throw new Error(`setBaseBranch: no project is registered as ${JSON.stringify(id ?? null)}`);
  target.baseBranch = branchName(base, 'baseBranch');
  return saveProjects(list).find((p) => p.id === id);
}

/**
 * Remembers the reviewer last picked for a project, through the same single
 * writer as {@link saveProjects}.
 *
 * @param {string} id
 * @param {string} login
 * @returns {Project[]} the saved list.
 * @throws {Error} if the project is unknown or the login is not a string.
 */
export function rememberReviewer(id, login) {
  const list = load().map((p) => ({ ...p }));
  const target = list.find((p) => p.id === id);
  if (!target) throw new Error(`rememberReviewer: no project is registered as ${JSON.stringify(id ?? null)}`);
  target.lastReviewer = loginOf(login, 'lastReviewer');
  return saveProjects(list);
}

/**
 * Makes a login the project's reviewer for good (the dialog's "always" box),
 * through the same single writer as {@link saveProjects}.
 *
 * @param {string} id
 * @param {string} login
 * @returns {Project[]} the saved list.
 * @throws {Error} if the project is unknown or the login is not a valid one.
 */
export function setReviewer(id, login) {
  const list = load().map((p) => ({ ...p }));
  const target = list.find((p) => p.id === id);
  if (!target) throw new Error(`setReviewer: no project is registered as ${JSON.stringify(id ?? null)}`);
  target.reviewer = loginOf(login, 'reviewer');
  // A reviewer and "no reviewer" conflict: the newest choice wins.
  delete target.noReviewer;
  return saveProjects(list);
}

/**
 * Makes "no reviewer" the project's standing choice (or undoes it), through the
 * same single writer. Turning it on clears the project's `reviewer`: the two
 * conflict, and the dialog's newest choice is the one that counts. Turning it
 * off removes the field, so the registry round-trips as it was.
 *
 * @param {string} id
 * @param {boolean} value
 * @returns {Project[]} the saved list.
 * @throws {Error} if the project is unknown or `value` is not a boolean.
 */
export function setNoReviewer(id, value) {
  if (typeof value !== 'boolean') throw new Error(`setNoReviewer: expected true or false, not ${JSON.stringify(value)}`);
  const list = load().map((p) => ({ ...p }));
  const target = list.find((p) => p.id === id);
  if (!target) throw new Error(`setNoReviewer: no project is registered as ${JSON.stringify(id ?? null)}`);
  if (value) {
    target.noReviewer = true;
    target.reviewer = null;
  } else {
    delete target.noReviewer;
  }
  return saveProjects(list);
}

/**
 * Changes the GitHub account a project works as, and optionally its assignee,
 * through the same single writer. `ghUser: null` removes the field: the
 * project goes back to the active `gh` account. The assignee is only touched
 * when given, because who issues are assigned to and who publishes are two
 * decisions that usually, but not always, coincide.
 *
 * @param {string} id
 * @param {{ghUser?: string|null, assignee?: string}} patch
 * @returns {Project} the saved entry.
 * @throws {Error} if the project is unknown or a login is not a valid one.
 */
export function setGhAccount(id, { ghUser, assignee } = {}) {
  const list = load().map((p) => ({ ...p }));
  const target = list.find((p) => p.id === id);
  if (!target) throw new Error(`setGhAccount: no project is registered as ${JSON.stringify(id ?? null)}`);
  if (ghUser === null) delete target.ghUser;
  else if (ghUser !== undefined) target.ghUser = loginOf(ghUser, 'ghUser');
  if (assignee !== undefined) target.assignee = loginOf(assignee, 'assignee');
  return saveProjects(list).find((p) => p.id === id);
}

/** A path compared as the file system does: forward slashes, no trailing one, case-folded on Windows. */
function samePathForm(p) {
  const s = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/**
 * The project a directory belongs to: the one whose checkout or worktree root
 * contains it, the deepest match winning. `undefined` for a directory of no
 * project. This is how a session started with only a `cwd` learns whose
 * GitHub account it works as.
 *
 * @param {string} dir
 * @returns {Project|undefined}
 */
export function projectAt(dir) {
  if (typeof dir !== 'string' || !dir) return undefined;
  const here = samePathForm(dir);
  let best;
  let bestLength = -1;
  for (const p of load()) {
    for (const root of [p.repoPath, p.worktreeRoot]) {
      if (typeof root !== 'string' || !root) continue;
      const r = samePathForm(root);
      if ((here === r || here.startsWith(`${r}/`)) && r.length > bestLength) {
        best = p;
        bestLength = r.length;
      }
    }
  }
  return best;
}

/**
 * Whether chats with a person in front load the board's UX plugin: on unless
 * the project declares `design: false`. Dependency-free on purpose.
 *
 * @param {string} [projectId]
 * @returns {boolean}
 */
export function projectDesignOf(projectId) {
  return projectOf(projectId)?.design !== false;
}

/**
 * Turns the board's UX plugin on or off for a project, through the same single
 * writer. `true` is the default, so it (and `null`) removes the field and the
 * registry round-trips as it was; only `false` is stored.
 *
 * @param {string} id
 * @param {boolean|null} value
 * @returns {Project} the saved entry.
 * @throws {Error} if the project is unknown or `value` is not true, false or null.
 */
export function setProjectDesign(id, value) {
  if (value !== null && typeof value !== 'boolean') throw new Error(`setProjectDesign: expected true or false, not ${JSON.stringify(value)}`);
  const list = load().map((p) => ({ ...p }));
  const target = list.find((p) => p.id === id);
  if (!target) throw new Error(`setProjectDesign: no project is registered as ${JSON.stringify(id ?? null)}`);
  if (value === false) target.design = false;
  else delete target.design;
  return saveProjects(list).find((p) => p.id === id);
}

/**
 * The reviewer route's writer: one registry write for `{ reviewer, noReviewer }`.
 * A login sets the reviewer and clears `noReviewer`; `noReviewer: true` clears
 * the reviewer; `reviewer: null` with `noReviewer: false` clears both (the
 * dialog asks again next time). Validated before anything is written.
 *
 * @param {string} id
 * @param {{reviewer?: string|null, noReviewer?: boolean}} choice
 * @returns {Project} the saved entry.
 * @throws {Error} on an unknown project, an invalid login or an empty choice.
 */
export function setReviewerChoice(id, { reviewer, noReviewer } = {}) {
  if (reviewer !== undefined && reviewer !== null && typeof reviewer !== 'string') {
    throw new Error(`reviewer: expected a login or null, not ${JSON.stringify(reviewer)}`);
  }
  if (noReviewer !== undefined && typeof noReviewer !== 'boolean') {
    throw new Error(`noReviewer: expected true or false, not ${JSON.stringify(noReviewer)}`);
  }
  const login = typeof reviewer === 'string' ? reviewer.trim() : null;
  if (typeof reviewer === 'string' && !login) throw new Error('reviewer: empty login');
  if (login && !LOGIN_RE.test(login)) throw new Error(`Invalid GitHub login for the reviewer: ${JSON.stringify(login)}`);
  if (!login && reviewer === undefined && noReviewer === undefined) throw new Error('reviewer or noReviewer is missing');
  const list = load().map((p) => ({ ...p }));
  const target = list.find((p) => p.id === id);
  if (!target) throw new Error(`setReviewerChoice: no project is registered as ${JSON.stringify(id ?? null)}`);
  if (login) {
    target.reviewer = login;
    delete target.noReviewer;
  } else if (noReviewer === true) {
    target.reviewer = null;
    target.noReviewer = true;
  } else {
    // `reviewer: null` + `noReviewer: false`: ask again next time. Only
    // `noReviewer: false` leaves the reviewer alone.
    if (reviewer === null) target.reviewer = null;
    delete target.noReviewer;
  }
  return saveProjects(list).find((p) => p.id === id);
}

/**
 * Restricts a project (or lifts the restriction), through the same single
 * writer. Only `true` is stored; `false`/`null` remove the field.
 *
 * @param {string} id
 * @param {boolean|null} value
 * @returns {Project} the saved entry.
 * @throws {Error} if the project is unknown or `value` is not true, false or null.
 */
export function setProjectRestricted(id, value) {
  if (value !== null && typeof value !== 'boolean') throw new Error(`setProjectRestricted: expected true or false, not ${JSON.stringify(value)}`);
  const list = load().map((p) => ({ ...p }));
  const target = list.find((p) => p.id === id);
  if (!target) throw new Error(`setProjectRestricted: no project is registered as ${JSON.stringify(id ?? null)}`);
  if (value === true) target.restricted = true;
  else delete target.restricted;
  return saveProjects(list).find((p) => p.id === id);
}

/**
 * Removes a project from the registry and NOTHING else: `tasks.<id>.json`, the
 * settings overlay, attachments, project chats, worktrees and the repo stay
 * where they are, so importing the same `repoPath` again (same id) finds them.
 * The registry may end up empty; removing the in-memory seed persists `[]`
 * instead of re-seeding.
 *
 * @param {string} id
 * @returns {Project[]} the saved list.
 * @throws {Error} if the project is unknown.
 */
export function removeProject(id) {
  const list = load();
  const gone = list.find((p) => p.id === id);
  if (!gone) throw new Error(`removeProject: no project is registered as ${JSON.stringify(id ?? null)}`);
  // Keep the entry's settings (reviewer, baseBranch, overrides, kind...) so a
  // re-import of the same checkout restores them. Written only here, on remove.
  const kept = readRemoved().filter((r) => r.id !== gone.id && repoKey(r.repoPath) !== repoKey(gone.repoPath));
  writeRemoved([...kept, structuredClone(gone)]);
  return saveProjects(list.filter((p) => p.id !== id));
}

const REMOVED_FILE = path.join(DATA_DIR, 'projects-removed.json');

/** Path identity for matching a re-import: slashes normalised, case-insensitive. */
const repoKey = (p) => String(p ?? '').replace(/[\\]/g, '/').replace(/\/+$/, '').toLowerCase();

/** Read lazily on every use (never at import): the file is rarely touched. */
function readRemoved() {
  try {
    const raw = JSON.parse(readFileSync(REMOVED_FILE, 'utf8'));
    return Array.isArray(raw) ? raw.filter((r) => r && typeof r === 'object') : [];
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return [];
    throw err;
  }
}

function writeRemoved(list) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(REMOVED_FILE, `${JSON.stringify(list, null, 2)}
`, 'utf8');
}

/**
 * The entry a removed project left behind, matched by repoPath (slashes and
 * case normalised) or by id. Does not modify anything.
 *
 * @param {{id?: string, repoPath?: string}} match
 * @returns {Project|undefined}
 */
export function removedProjectFor({ id, repoPath } = {}) {
  const key = repoPath ? repoKey(repoPath) : null;
  return readRemoved().find((r) => (key && repoKey(r.repoPath) === key) || (id && r.id === id));
}

/**
 * Drops the removed entry matching the same id or repoPath, once it has been
 * restored. Writes only when something is dropped.
 *
 * @param {{id?: string, repoPath?: string}} match
 */
export function forgetRemovedProject({ id, repoPath } = {}) {
  const key = repoPath ? repoKey(repoPath) : null;
  const all = readRemoved();
  const rest = all.filter((r) => !((key && repoKey(r.repoPath) === key) || (id && r.id === id)));
  if (rest.length !== all.length) writeRemoved(rest);
}
