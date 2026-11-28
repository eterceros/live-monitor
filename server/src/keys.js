/**
 * Composite task keys: `<projectId>#<issue>`.
 *
 * The board used to watch one repository, so a task was identified by its bare
 * issue number (`store.js:260` — `this.tasks[issue.number] = task`). With a
 * second project (`eterceros/app-b`) in the same app, issue #12 of one
 * repo would silently overwrite #12 of the other. The composite key fixes that.
 *
 * ## The canonical form is the only form
 *
 * `<projectId>#<issue>`, project id matching `PROJECT_ID_RE`, issue a decimal
 * with no leading zeros. These keys are used as `Map` keys across the pipeline
 * (`liveChats`, `running`, `quietChecks`, `quotaSaid`, `taskPending` in
 * `pipeline.js`), so two spellings of the same task would be two distinct
 * entries — exactly the collision this module exists to prevent. Nobody else
 * splits on `#`: parsing lives here, in `parseKey`/`coerceKey`, and nowhere else.
 *
 * This module is pure: no imports from the rest of the server, no disk access.
 *
 * @module keys
 */

/**
 * The project the board has always watched (`HeliosSoftware/hfs`). Exported so
 * the literal lives in exactly one place. Callers that need it:
 *
 * - the project registry, to seed the first entry;
 * - `store.js`, which adopts today's `tasks.json` as this project's file;
 * - `quota.js:525`, `quota.js:538` and `quota.js:558-559`, where `hold.parked`
 *   is today a list of bare issue numbers (the JSDoc at `quota.js:547` says
 *   "Numbers, deliberately");
 * - `chatTabs` entries in `settings.js`, which now carry their project and
 *   are sealed with one at boot (`adoptLegacyTabs`);
 * - `attachments.js:27` and `attachments.js:36`, which build
 *   `path.join(ROOT_DIR, String(issue))`.
 *
 * @type {string}
 */
export const DEFAULT_PROJECT_ID = 'hfs';

/**
 * A project id: lowercase alphanumerics and hyphens, never starting with a
 * hyphen. Deliberately narrow — these ids appear in URL path segments
 * (`/api/projects/:project/...`) and in directory names
 * (`attachments/<project>/`), so anything that could be `.`, `..`, a path
 * separator or a case-folding collision is out.
 *
 * @type {RegExp}
 */
export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The one canonical key shape. Anchored, no leading zeros on the issue, no
 * surrounding whitespace.
 *
 * @type {RegExp}
 */
const KEY_RE = /^([a-z0-9][a-z0-9-]*)#([1-9]\d*)$/;

/**
 * The directory name every project chat of a project shares, under the
 * worktree root (`<worktreeRoot>/_proyecto`) and under `attachments/<project>/`.
 * Issues are numeric, so it can never collide with one.
 */
export const PROJECT_WORKTREE_DIR = '_proyecto';

/** A project chat holder's key: `<projectId>@<machine>`. Never a path segment. */
const HOLDER_KEY_RE = /^([a-z0-9][a-z0-9-]*)@([A-Za-z0-9._-]+)$/;

export const isHolderKey = (key) => typeof key === 'string' && HOLDER_KEY_RE.test(key);

export function parseHolderKey(key) {
  const m = typeof key === 'string' ? HOLDER_KEY_RE.exec(key) : null;
  return m ? { project: m[1], machine: m[2] } : null;
}

/** An issue number as a string: positive, decimal, no leading zeros. */
const ISSUE_RE = /^[1-9]\d*$/;

/**
 * Is `v` a valid project id?
 *
 * @param {unknown} v
 * @returns {boolean} true only for a string matching {@link PROJECT_ID_RE}.
 */
export function isProjectId(v) {
  return typeof v === 'string' && PROJECT_ID_RE.test(v);
}

/**
 * Is `issue` a usable issue number? A positive integer, either as a `number`
 * or as a canonical decimal string. `1.5`, `0`, `-3`, `'007'`, `NaN`,
 * `Infinity` and anything non-numeric are all out.
 *
 * @param {unknown} issue
 * @returns {boolean}
 */
function isIssue(issue) {
  if (typeof issue === 'number') return Number.isSafeInteger(issue) && issue > 0;
  if (typeof issue === 'string') return ISSUE_RE.test(issue);
  return false;
}

/**
 * Builds a canonical key. **Throws** on invalid input: this is the constructor,
 * and a malformed key that reaches a `Map` is a silent duplicate entry, which
 * is worse than a crash at the call site.
 *
 * @param {string} projectId a valid project id.
 * @param {number|string} issue a positive integer, no leading zeros.
 * @returns {string} `"<projectId>#<issue>"`.
 * @throws {TypeError} if either part is invalid.
 */
export function makeKey(projectId, issue) {
  if (!isProjectId(projectId)) {
    throw new TypeError(`makeKey: proyecto inválido: ${JSON.stringify(projectId)}`);
  }
  if (!isIssue(issue)) {
    throw new TypeError(`makeKey: issue inválido: ${JSON.stringify(issue)}`);
  }
  return `${projectId}#${issue}`;
}

/**
 * The key of a task.
 *
 * **Throws when `task.project` is missing.** There is deliberately no silent
 * default: filling one in here would recreate the very collision the composite
 * key exists to prevent — a task from the new project would quietly answer to
 * `hfs#12` and overwrite the old one.
 *
 * ## What this imposes on the store
 *
 * Every task must carry `project` **at load time**, not at use time. When
 * `store.js` reads a tasks file it stamps `project` onto every task it
 * hydrates — today's `tasks.json` is adopted wholesale as
 * {@link DEFAULT_PROJECT_ID}, with no migration pass and no rewrite — and
 * `addTask` stamps it on every task it builds. By the time any caller
 * holds a task object, `keyOf` cannot throw. If it does throw in production,
 * the bug is a task that entered the store without a project, not a caller
 * that forgot to pass one.
 *
 * @param {{project: string, issue: number|string}} task
 * @returns {string} the canonical key.
 * @throws {TypeError} if `task` is not an object, or `project`/`issue` is missing or invalid.
 */
export function keyOf(task) {
  if (!task || typeof task !== 'object') {
    throw new TypeError(`keyOf: tarea inválida: ${JSON.stringify(task ?? null)}`);
  }
  if (!isProjectId(task.project)) {
    throw new TypeError(
      `keyOf: la tarea #${task.issue ?? '?'} no tiene 'project' válido (${JSON.stringify(task.project ?? null)}); ` +
        'el store debe ponerlo al cargar, no al usarse',
    );
  }
  return makeKey(task.project, task.issue);
}

/**
 * Splits a canonical key. Accepts **only** the canonical form: no leading
 * zeros, no whitespace, no uppercase, no bare number.
 *
 * Use this when you know you hold a key. To read a value that might still be a
 * bare number from an older file, use {@link coerceKey}.
 *
 * @param {string} key
 * @returns {{projectId: string, issue: number}} `issue` comes back as a
 *   `number`, because that is what the store, the routes and GitHub all use.
 * @throws {TypeError} if `key` is not a canonical key.
 */
export function parseKey(key) {
  const m = typeof key === 'string' ? KEY_RE.exec(key) : null;
  if (!m) throw new TypeError(`parseKey: clave no canónica: ${JSON.stringify(key)}`);
  return { projectId: m[1], issue: Number(m[2]) };
}

/**
 * Reads a value that may already be a key, or may still be a bare issue number
 * from a file written before projects existed (`hold.parked` in `quota.js`,
 * `chatTabs` in `settings.js`, attachment directory names). **Never throws** —
 * it returns `null` for anything it cannot read, so a single bad entry in a
 * persisted list cannot take the board down at boot.
 *
 * | Input | Output (default `'hfs'`) |
 * |---|---|
 * | `12` | `'hfs#12'` |
 * | `'12'` | `'hfs#12'` |
 * | `'hfs#12'` | `'hfs#12'` |
 * | `'otro#12'` | `'otro#12'` — an explicit key always wins over the default |
 * | `'hfs#012'` | `null` |
 * | `'12abc'`, `NaN`, `true`, `null`, `{}` | `null` |
 *
 * @param {unknown} value a key, an issue number, or junk.
 * @param {string} [defaultProjectId] the project to assume for a bare number.
 * @returns {string|null} a canonical key, or `null`.
 */
export function coerceKey(value, defaultProjectId = DEFAULT_PROJECT_ID) {
  if (typeof value === 'string' && KEY_RE.test(value)) return value;
  if (!isProjectId(defaultProjectId)) return null;
  if (!isIssue(value)) return null;
  return `${defaultProjectId}#${value}`;
}

/**
 * The tasks file for a project, as a bare file name (the caller joins it to
 * `DATA_DIR`). Pure: it composes a name and touches no disk.
 *
 * The default project keeps `tasks.json`. That is the approved plan's decision:
 * today's file is **adopted as is**, with no migration and no rename, and the
 * new project starts a fresh `tasks.<id>.json`. `store.js` holds
 * `TASKS_FILE = path.join(DATA_DIR, 'tasks.json')` at `store.js:10` today.
 *
 * @param {string} projectId
 * @returns {string} `'tasks.json'` or `'tasks.<id>.json'`.
 * @throws {TypeError} if `projectId` is invalid — this name becomes a path
 *   segment, so an unvalidated id here is a path-traversal hole.
 */
export function tasksFileOf(projectId) {
  if (!isProjectId(projectId)) {
    throw new TypeError(`tasksFileOf: proyecto inválido: ${JSON.stringify(projectId)}`);
  }
  return projectId === DEFAULT_PROJECT_ID ? 'tasks.json' : `tasks.${projectId}.json`;
}

/* ===========================================================================
 * The contract for the packages that follow — documented here, implemented
 * elsewhere. Nothing below this line is exported by this module; it is the
 * shared reference the parallel packages are written against.
 * ======================================================================== */

/**
 * An entry in the project registry.
 *
 * `repoPath` and `worktreeRoot` change per machine and are read from
 * `config.json` (`project.repoPath`, `project.worktreeRoot`), never hardcoded.
 * `overrides` carries per-project deviations from the global config (models,
 * phase toggles, prompt tweaks); an absent key means "use the global value".
 *
 * @typedef {Object} Project
 * @property {string} id           matches {@link PROJECT_ID_RE}; the `<projectId>` half of every key.
 * @property {string} name         human label for the project selector.
 * @property {string} repoPath     absolute path to the checkout on this machine.
 * @property {string} worktreeRoot absolute path under which per-issue worktrees are created.
 * @property {string} repo         GitHub `owner/name`, e.g. `HeliosSoftware/hfs`.
 * @property {string} assignee     the GitHub login whose assigned issues this project watches.
 * @property {string} reviewer     the GitHub login asked to review its PRs.
 * @property {string} [ghUser]     the GitHub account its `gh` calls and agent sessions work as; absent means the active `gh` account.
 * @property {Object} overrides    per-project config overrides; `{}` when there are none.
 * @property {boolean} [restricted] `true` groups the project apart on the board and keeps it from being the opening project; absent means not restricted.
 * @property {boolean} [design]    `false` keeps the board's UX plugin out of this project's attended chats; absent means on.
 * @property {Object<string, {autoClone?: false, install?: 'yes'|'no'}>} [machines]
 *   per-machine choices, by machine name: excluded from background cloning, and
 *   the remembered answer about installing dependencies.
 */

/**
 * ## The store stays one object, and one event emitter
 *
 * The obvious shape — a `Store` instance per project — is wrong here, and the
 * reason is not in `store.js`: `index.js` subscribes the websocket to **one**
 * emitter, and `upgrade.js` subscribes to the same one. Split the store into
 * an instance per project and each gets its own emitter, so the browser would
 * only ever hear about the first project's tasks, silently.
 *
 * So `store` remains a single object with a single emitter. Being backed by
 * one file per project is an internal detail of `store.js`, not a shape its
 * callers see. That is also what keeps the fifty-odd call sites working while
 * they are converted, one package at a time.
 *
 * - `store.all()` returns the **union** across projects, ordered by `issue`
 *   descending with `project` breaking ties. This is what keeps the
 *   account-wide things correct without touching them: the active-task count
 *   against the global `maxActiveTasks`, the snapshot the board renders, and
 *   the "is the board idle" sweep the upgrade waits on.
 * - `store.get(v)` accepts a bare issue number, a numeric string, or a
 *   canonical key — see {@link coerceKey}. Anything else answers `undefined`.
 * - `store.addTask(issue, projectId)` requires `projectId`: omitting it throws
 *   `falta el proyecto en addTask`.
 * - `store.flush()` writes every dirty project's file.
 *
 * ### Events keep their positional shape and gain `project` last
 *
 * `'log'`, `'chat'` and `'chat-update'` keep every argument they have today
 * and take `project` as one more at the end. Existing listeners ignore an
 * extra argument, so nothing has to change in step; the web package reads it
 * when it is ready. Renaming or reordering would mean editing every listener
 * in the same commit as `store.js`, which is exactly the flag-day this design
 * exists to avoid.
 */

/**
 * `projectOf(id)` — returns the {@link Project} registry entry with that id,
 * or `undefined` when no project is registered under it.
 *
 * @callback ProjectOf
 * @param {string} id
 * @returns {Project|undefined}
 */

/* ---------------------------------------------------------------------------
 * HTTP routes
 *
 * The composite key NEVER travels in a URL: `#` starts the fragment, so a
 * browser would never send the second half. Routes carry the two halves as
 * separate path segments, and `:issue` stays numeric.
 *
 *   before                                  after
 *   ------------------------------------    -------------------------------------------------
 *   /api/tasks/:issue/…  (51 routes)        /api/projects/:project/tasks/:issue/…
 *
 * Verified against `server/src/index.js`: exactly 51 routes match
 * `/api/tasks/:issue`, spanning lines 308 to 729 (the brief said 308-651; the
 * count is right, the end of the range is not — the last one is
 * `POST /api/tasks/:issue/stack/stop` at line 729).
 *
 * New:
 *   GET  /api/projects                      the registry: one entry per `Project`.
 *   GET  /api/projects/:project/tasks       that project's tasks.
 *
 * Unchanged, global, not per project:
 *   GET  /api/machines   (index.js:540)
 *   GET  /api/models     (index.js:538)
 *   GET/POST /api/settings (index.js:276, 278)
 *
 * OPEN — decided by later packages, not here:
 *   1. Does `POST /api/poll` (index.js:565) become per project
 *      (`/api/projects/:project/poll`) or stay global and poll every project?
 *   2. Does `GET /api/tasks` (index.js:274) keep returning every project's
 *      tasks, or only the active project's? Today it answers with the whole
 *      `snapshot()`, which the web uses as its initial state.
 *
 * Also global today and untouched by this contract: `GET /api/preview`
 * (index.js:506); `POST /api/chat-tabs/open|close` now carry the project too.
 * ------------------------------------------------------------------------ */

/* ---------------------------------------------------------------------------
 * WebSocket message shapes
 *
 * INCOMING (browser → board). One message type today, at index.js:784-789,
 * sent by `web/src/api.js:25`:
 *
 *   { type: 'chat', project, issue, chatId, text, attachments }
 *                   ^^^^^^^ new
 *
 * `project` and `issue` stay separate on the wire, same as in URLs; the server
 * composes the key with `makeKey(msg.project, msg.issue)`. The handler today
 * does `sendChat(Number(msg.issue), …)` and ignores any project.
 *
 * OUTGOING (board → browser), at index.js:760-763:
 *
 *   { type: 'task', task }              task.project rides INSIDE the task — no
 *                                       new top-level field. `publicTask()` must
 *                                       carry `project` through.
 *   { type: 'log', project, issue, entry }          index.js:761 — gains `project`
 *   { type: 'chat', project, issue, chatId, message } index.js:762 — gains `project`
 *   { type: 'chat-update', project, issue, chatId, ...update } index.js:763 — gains `project`
 *
 * The store's `log`/`chat`/`chat-update` events therefore have to emit the
 * project alongside the issue; a listener that only sees an issue cannot route
 * the message to the right card.
 *
 * SNAPSHOT (index.js:781, sent once per connection; the same object `GET
 * /api/tasks` returns). The UI package depends on this more than on anything
 * else, so, precisely — it keeps every field it has today (`tasks`, `active`,
 * `settings`, `github`, `models`, `poll`, `defaultChatModel`, `project`,
 * `machines`, `upgrade`, `quota`, `usage`) and gains two:
 *
 *   {
 *     type: 'snapshot',
 *     projects: Project[],       // the registry, in display order, for the selector
 *     activeProject: string,     // the id the board OPENS on -- the first of
 *                                // projects[]. Not server-held selection:
 *                                // switching project in one browser must not
 *                                // switch it in another, and this board is
 *                                // open on a laptop and a phone at once. The
 *                                // choice lives in localStorage, like
 *                                // `lastChat.js` already keeps the last chat.
 *     tasks: [...],              // each task carries its own `project`
 *     ...everything else unchanged
 *   }
 *
 * Note the existing singular `project` field (index.js:256-272, `snapshot()`)
 * is `config.project` — the machine's repo paths, not a registry entry. It is a
 * different thing from `projects`/`activeProject`; renaming or reusing it is
 * out of scope here.
 * ------------------------------------------------------------------------ */

/* ---------------------------------------------------------------------------
 * Disk paths
 *
 * Attachments move from `attachments/<issue>/` to `attachments/<project>/<issue>/`
 * (`attachments.js:27` writes, `attachments.js:36` lists).
 *
 * The composite key is NEVER a path segment and NEVER a URL segment. `#` is
 * not a path character on either side. The key is in-memory currency — `Map`
 * keys in `pipeline.js`, React keys in `web/` — and nothing else. On disk and
 * on the wire the two halves always travel as separate segments or fields.
 * ------------------------------------------------------------------------ */

/* ---------------------------------------------------------------------------
 * The web does not parse keys
 *
 * `web/src` composes `` `${task.project}#${task.issue}` `` from what it already
 * receives, and never splits a key back apart. There is therefore no copy of
 * this module under `web/src`, and none is needed: parsing is a server concern.
 * ------------------------------------------------------------------------ */

/* ---------------------------------------------------------------------------
 * How the project reaches the modules that do not take a task
 *
 * Everything above travels inside a task. These five do not, and each one was
 * found in review as a signature two packages would otherwise have had to
 * invent separately and incompatibly. In all five the project is required:
 * omitting it throws `falta el proyecto en <fn>`, never a fall back to
 * {@link DEFAULT_PROJECT_ID}.
 *
 * 1. GITHUB (`github.js`). `repo()` caches one value for the life of the
 *    process; it becomes `repo(projectId)` over a `Map`. Every exported
 *    function takes `projectId` as a TRAILING argument -- `getIssue(n,
 *    projectId)`, `prView(n, projectId)` -- except the three that already take
 *    an options object, where it rides inside it: `prsForBranch(branch,
 *    {cache, project})`, `checksForOpenPrs({force, project})`,
 *    `createDraftPr({branch, title, body, project})`. The assignee and the
 *    reviewer stop coming from `config.github` and come from the registry
 *    entry. `prBranchCache` keys on `${repo}:${branch}`: a branch name alone
 *    would collide across repositories, which is this whole exercise in
 *    miniature.
 *
 * 2. BRANCHES (`worktree.js`). `listAllBranches({force, project})` and
 *    `findBranchesForIssue(issue, {project})`, with the cache keyed per
 *    project. Today both reach for the local machine's checkout, which is
 *    hfs's; a second project's branches are not in it.
 *
 * 3. MACHINES (`machine.js`). `machineFor(name, projectId)` is the primitive.
 *    For the default project it returns `machines()[name]` EXACTLY as today --
 *    live `config.project`, not the registry, because the registry freezes its
 *    seed on first load while `config` reloads, and several tests mutate
 *    `config.project` and expect the machine to follow. For another project on
 *    `local` it returns a view over the same machine with that project's
 *    `repoPath`/`worktreeRoot`; on a runner it throws, since no second project
 *    is declared there. `machineOf(task) = machineFor(task.machine ?? 'local',
 *    task.project)`.
 *
 * 4. PROMPTS (`prompts.js`). `renderPrompt(name, vars)` reads two new optional
 *    vars and still returns a string: `vars.projectId` picks the descriptor and
 *    the invariants, and `vars.onInvariantInjected({id, phrase, source})` fires
 *    once per load-bearing phrase the board had to put back. The callback is
 *    the only way the backstop can reach a task's log, since `renderPrompt` has
 *    no task. Extra keys in `vars` are ignored by the validator, which checks
 *    the template's placeholders, not the caller's object.
 *
 * 5. IMPORTING (`POST /api/projects`). Takes `{repoPath}` and as little else as
 *    possible, because the repository already knows most of it: the remote
 *    gives `repo` (`repo-identity.js`), the convention gives `worktreeRoot`
 *    (`<checkout>-wt`), the last path segment gives `id`. Returns 201 with the
 *    `Project`, or 400 carrying the registry's own refusal message -- a
 *    forbidden override, a bad id, a path that is not there.
 * ------------------------------------------------------------------------ */
