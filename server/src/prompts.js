import { readFileSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT, config } from './config.js';
import { projectContextFor } from './project-context.js';
import { DEFAULT_PROJECT_ID } from './keys.js';
import { parallelFor } from './parallel.js';
import { workPlanContract } from './workplan.js';
import { qaPlanContract, qaResultsContract } from './qa.js';
import { planBriefContract } from './planbrief.js';
import { PROCESS_RULE, GITHUB_LANGUAGE_RULE, GITHUB_PUBLISH_RULE } from './rules.js';
import { missingInvariants, backstopBlock } from './prompt-invariants.js';

const DIR = path.join(ROOT, 'server', 'prompts');

/**
 * The variables each prompt may use. Declared here on purpose: a template that
 * reaches for anything else is reported when it loads, not twenty minutes into
 * a task that finally runs that phase.
 */
export const ALLOWED = {
  triage: ['issueNumber', 'issueTitle', 'issueLabels', 'issueBody', 'parallel', 'workPlan', 'qaPlan', 'qaAvailable', 'projectContext'],
  advisor: ['issueNumber', 'issueTitle', 'triageSummary', 'issueBody', 'parallel'],
  'fix-plan': ['issueNumber', 'issueTitle', 'branch', 'issueBody', 'planSection', 'extraContext', 'parallel', 'workPlan', 'processRule', 'planBrief'],
  // The person asked for changes on the fix plan: sent to the session that wrote it.
  'plan-revise': ['feedback', 'workPlan', 'processRule', 'planBrief', 'parallel'],
  fix: ['issueNumber', 'issueTitle', 'branch', 'issueBody', 'planSection', 'extraContext', 'workPlanSection', 'e2eRule', 'parallel', 'processRule', 'shellRule', 'tmpRule', 'githubRule', 'projectContext'],
  // The second pass over a finished fix ("Cerrar huecos"): runs in the fix's own resumed session.
  'fix-gaps': ['issueNumber', 'issueTitle', 'issueBody', 'baseBranch', 'round', 'maxRounds', 'gapsContract', 'parallel', 'processRule', 'shellRule'],
  // A PR waiting for review fell into a conflict with its base: the fix's own session merges it.
  'resolve-conflicts': ['issueNumber', 'issueTitle', 'branch', 'baseBranch', 'behind', 'conflictCount', 'conflictFiles', 'parallel', 'processRule', 'shellRule'],
  // The body of the PR of a finished fix: written by a session, published by the board.
  'pr-body': ['issueNumber', 'issueTitle', 'issueBody', 'branch', 'diffSection', 'triageSummary', 'qaSection', 'githubRule', 'parallel'],
  demo: ['issueNumber', 'issueTitle', 'branch', 'diffSection', 'serversSection', 'parallel', 'workPlan', 'baseBranch'],
  'change-request': ['issueNumber', 'issueTitle', 'branch', 'changeRequestSection', 'parallel'],
  'review-replies': ['issueNumber', 'issueTitle', 'prNumber', 'branch', 'author', 'baseline', 'changeRequestSection', 'threadList', 'parallel'],
  // No PR to write: the analysis concluded nothing had to change, so a session
  // drafts the closing comment and the board publishes what the person confirms.
  // No `parallel`, and that is not an oversight: this phase runs with
  // `tools: ['Read', 'Grep']` and no Bash, so it has no subagent tool to fan
  // anything out with. See `draftIssueClosing`.
  'close-issue': ['issueNumber', 'issueTitle', 'issueBody', 'commentsSection', 'branch',
    'branchState', 'labelList', 'closableHint', 'commentMax', 'githubRule'],
  'chat-rules': ['text', 'siblings', 'handoff', 'machineNote', 'e2ePortEnv', 'attachments', 'parallel', 'processRule', 'shellRule', 'tmpRule', 'githubPublishRule'],
  // A conversation with no task: the project chat, in its own detached worktree.
  'chat-project-rules': ['text', 'siblings', 'attachments', 'githubPublishRule', 'machineNote', 'shellRule', 'tmpRule', 'processRule', 'parallel', 'project', 'repo', 'baseBranch', 'worktreePath', 'machine'],
  // The one-shot, no-tools query that drafts an issue from a project chat's transcript.
  'issue-draft': ['transcript'],
  // Sent to a session right before its task leaves the machine: no tools, just memory.
  handoff: [],
  'qa-plan': ['issueNumber', 'issueTitle', 'branch', 'issueBody', 'initialPlan', 'previousAttempt', 'diffStat', 'e2eTail', 'stackSection', 'parallel', 'processRule', 'qaPlan', 'baseBranch'],
  'qa-run': ['issueNumber', 'issueTitle', 'branch', 'servers', 'qaDir', 'e2eDir', 'plan', 'carriedNote', 'parallel', 'processRule', 'shellRule', 'tmpRule', 'qaResults', 'githubRule'],
  // Plan mode in a chat: the body of the CLI's plan-mode reminder.
  'plan-mode': ['workPlan', 'processRule', 'parallel', 'planBrief'],
  // One task of an approved plan, run by the board in a session of its own.
  'plan-task': ['taskId', 'what', 'files', 'checkLine', 'upstream', 'hint', 'processRule', 'shellRule', 'tmpRule', 'e2ePortEnv', 'parallel', 'projectContext'],
  'plan-retry': ['taskId', 'attempt', 'where', 'output', 'hint', 'parallel'],
  // The same check failed the same way over the same files: the task's own session looks for the fault in the plan.
  // No `projectContext`: the session is the task's own, resumed, and already carries it.
  'plan-repair': ['taskId', 'what', 'check', 'output', 'files', 'hint', 'processRule', 'shellRule', 'tmpRule', 'parallel'],
};

/**
 * Values every template gets without the caller passing them. `parallel` is one
 * instruction that must read the same in every phase (`renderPrompt` picks its
 * variant per template); `workPlan` is the output contract that turns it into
 * something the board can check. Both can be overridden per call when a phase
 * needs its own wording.
 */
const AUTOMATIC = {
  // `parallel` is not here: it depends on the template, see `parallelFor` in `renderPrompt`.
  workPlan: workPlanContract(),
  qaPlan: qaPlanContract(),
  qaResults: qaResultsContract(),
  processRule: PROCESS_RULE,
  // The brief that opens every plan: one contract, so the three templates that
  // ask for a plan cannot each describe it a little differently.
  planBrief: planBriefContract(),
  // Two rules, not one, because not every session may publish. `githubRule` is
  // only the language; `githubPublishRule` adds how to correct what is already
  // published, and goes exclusively to the chat — the one session that writes
  // to GitHub. Handing the publish version to a phase that is forbidden from
  // running `gh` would teach it the commands the line above denies it.
  githubRule: GITHUB_LANGUAGE_RULE,
  githubPublishRule: GITHUB_PUBLISH_RULE,
  // A chat that never moved has nothing to say about machines; the call
  // sites that know about a move pass these, the rest need not.
  handoff: '',
  machineNote: '',
  // The two optional halves of the PR body's context. A task can genuinely
  // have no triage summary and no browser QA, so an empty default is the
  // truthful value, not a forgotten call site. `diffSection` is deliberately
  // NOT here: a body written without having seen the diff is the failure this
  // phase exists to avoid, so forgetting it must throw.
  triageSummary: '',
  qaSection: '',
  // Same shape, for Browser QA's carry: a first attempt has no earlier one to
  // carry from, and «no hay intento anterior» is the truthful empty value.
  // Without these, any render that does not pass them throws — which is how
  // `parallel.test.mjs` went red the moment the carry landed.
  previousAttempt: '',
  carriedNote: '',
  // The Windows heredoc warning is the caller's to pass, because only the
  // caller knows which machine the session runs on. Empty by default on
  // purpose: `renderPrompt` throws on a missing variable, and forgetting a
  // call site has to cost one sentence of advice, never a phase that dies
  // twenty minutes into a task.
  shellRule: '',
  // Same as `shellRule`: only a runner has a RAM-disk `/tmp`, and only the
  // call sites that know which machine a session runs on can say so.
  tmpRule: '',
  // Triage asks for a QA_PLAN line; a project with no stack has no Browser QA,
  // and the caller says so with `qaAvailable: false`. Empty by default: QA is
  // assumed available, which is what every caller got before the variable.
  qaAvailable: '',
};

/** What triage reads when the project cannot run Browser QA. */
export const NO_QA_NOTE = 'Este proyecto no tiene Browser QA (no declara una app que levantar): no propongas pasos de navegador y deja la línea QA_PLAN como {"ui":false,"steps":[]}.\n';

/**
 * `{{qaAvailable}}`: `false` becomes the note above, a string passes through,
 * anything else (absent, `true`) is empty.
 */
function qaAvailableText(v) {
  if (v === false) return NO_QA_NOTE;
  return typeof v === 'string' ? v : '';
}

/**
 * `{{e2eRule}}`: the sentence about the e2e port, all of it or nothing. The
 * callers pass `e2ePortEnv: ''` when the project has none, so an AUTOMATIC
 * default could never apply; it is derived here from that variable instead.
 */
export function e2eRuleFor(portEnv) {
  const name = typeof portEnv === 'string' ? portEnv.trim() : '';
  if (!name) return '';
  return ` Para la suite e2e usa \`${name}=<puerto libre>\` junto con \`CI=1\`, que es como la lanza el orquestador.`;
}

let projectResolver = null;
/**
 * Late-bound project lookup: fn(projectId) => { repoPath } | null | undefined.
 * projects.js registers itself at load. It is not imported here because it can
 * write into the data dir, and prompts.js must stay free of such writers.
 */
export function setProjectResolver(fn) {
  projectResolver = typeof fn === 'function' ? fn : null;
}

/**
 * The checkout a task's project context is read from. No project id means the
 * default project, as before. A project id that is not registered is an error:
 * falling back to the default project's checkout would brief the session with
 * another repository's descriptor.
 */
function repoPathFor(projectId) {
  if (projectId === undefined || projectId === null) return config.project?.repoPath;
  // No resolver registered (projects.js not loaded, e.g. tests that import this
  // module without isolating the data dir): behave as before project support,
  // i.e. use the configured path for any project id.
  if (!projectResolver) return config.project?.repoPath;
  if (projectId === DEFAULT_PROJECT_ID) return projectResolver(projectId)?.repoPath ?? config.project?.repoPath;
  const p = projectResolver(projectId);
  if (!p?.repoPath) throw new Error(`Proyecto desconocido para {{projectContext}}: ${projectId}`);
  return p.repoPath;
}

/** What a variable looks like in a template. Exported so the tests that walk
 * the templates cannot drift from the one the renderer actually uses. */
export const PLACEHOLDER = /\{\{(\w+)\}\}/g;
const cache = new Map(); // name -> { mtimeMs, text }

const file = (name) => path.join(DIR, `${name}.md`);

function placeholdersOf(text) {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))];
}

/** Reads a template, reusing the cached copy while the file is unchanged. */
function read(name) {
  const allowed = ALLOWED[name];
  if (!allowed) throw new Error(`Prompt desconocido: ${name}`);
  const target = file(name);

  let mtimeMs;
  try {
    mtimeMs = statSync(target).mtimeMs;
  } catch {
    const cached = cache.get(name);
    if (cached) return cached.text;
    throw new Error(`No se encuentra la plantilla ${name}.md`);
  }

  const cached = cache.get(name);
  if (cached && cached.mtimeMs === mtimeMs) return cached.text;

  let text;
  try {
    text = readFileSync(target, 'utf8');
  } catch (e) {
    // Half-written file: keep serving the last good version.
    if (cached) return cached.text;
    throw e;
  }

  const unknown = placeholdersOf(text).filter((p) => !allowed.includes(p));
  if (unknown.length) {
    const problem = `${name}.md usa variables que no existen: ${unknown.join(', ')}. Permitidas: ${allowed.join(', ')}`;
    if (cached) {
      console.error(`[prompts] ${problem} — se mantiene la versión anterior`);
      return cached.text;
    }
    throw new Error(problem);
  }

  cache.set(name, { mtimeMs, text });
  return text;
}

/**
 * Renders a prompt. Substitution only — every conditional is composed in code
 * and handed in as a value, so templates stay prose and never grow logic.
 *
 * Two optional variables are read here and never reach a template
 * (`keys.js`, «How the project reaches the modules that do not take a task»,
 * point 4). Both are ignored by the validator, which checks the template's
 * placeholders and not the caller's object, and neither changes the return
 * type: this still answers a string.
 *
 * - `vars.projectId` picks the inventory of load-bearing phrases in
 *   `prompt-invariants.js`. Absent means the default project.
 * - `vars.onInvariantInjected({id, phrase, source})` fires once per phrase the
 *   board had to put back. It is the only way the backstop can reach a task's
 *   log, because `renderPrompt` has no task and no store.
 *
 * ## The backstop, and where it is spliced
 *
 * The phrases are checked against the **whole rendered prompt**, not against
 * the project's descriptor: what matters is whether the session ends up
 * reading them, not which half of the prompt they came from. Since 2026-09-26
 * the hfs literals are gone from `triage.md`, `fix.md` and `plan-task.md`, so
 * for hfs this is no longer inert: with the merged descriptor exactly one
 * phrase is put back (`hfs/plan-task/check-per-crate`, the only rule the
 * descriptor does not carry), and with a descriptor that went missing, eight.
 * A project with no inventory still renders byte for byte as it did before.
 *
 * What is put back goes **inside the value of `{{projectContext}}`**, never
 * appended to the end of the render. That is what keeps it confined to the
 * three templates that carry the variable — `triage`, `fix` and `plan-task` —
 * so it can never reach `handoff` (rendered byte for byte in
 * `handoff.test.mjs`) or a QA phase, and so the baseline's sentinel covers it.
 */
export function renderPrompt(name, vars = {}) {
  const text = read(name);
  // `projectContext` cannot live in `AUTOMATIC`: that object is a module-level
  // const, evaluated once at import, so the descriptor would be frozen as it
  // was when the board booted and editing it would change nothing until a
  // restart. Computed here instead, on every render, behind the mtime cache in
  // `project-context.js`. A caller that passes the variable always wins — that
  // is what lets `tools/prompt-baseline` render with a sentinel instead of the
  // live text of somebody else's repository.
  const all = {
    ...AUTOMATIC,
    // Per template, resolved on every render; a caller's `parallel` still wins.
    parallel: parallelFor(name),
    ...vars,
    e2eRule: vars.e2eRule ?? e2eRuleFor(vars.e2ePortEnv),
    qaAvailable: qaAvailableText(vars.qaAvailable),
  };
  const used = placeholdersOf(text);
  // Only a template that carries the variable needs the project: `handoff` and
  // the QA phases render for a task whatever its project's state.
  if (used.includes('projectContext')) {
    all.projectContext = vars.projectContext ?? projectContextFor({ repoPath: repoPathFor(vars.projectId) });
  }
  const missing = used.filter((p) => all[p] === undefined);
  if (missing.length) {
    throw new Error(`Faltan variables al render de ${name}.md: ${missing.join(', ')}`);
  }
  const fill = (bag) => text.replace(PLACEHOLDER, (_, key) => String(bag[key]));

  const rendered = fill(all);
  // No `{{projectContext}}`, nowhere to splice: the template is left exactly as
  // it renders today. This is the structural half of «the block cannot reach
  // `handoff`» — not a promise about the table's contents.
  if (!used.includes('projectContext')) return rendered;

  const gaps = missingInvariants(rendered, { projectId: vars.projectId, template: name });
  if (!gaps.length) return rendered;

  for (const gap of gaps) {
    try {
      vars.onInvariantInjected?.({ id: gap.id, phrase: gap.phrase, source: gap.source });
    } catch (e) {
      // A listener that throws must not cost the phase its prompt: the point of
      // the backstop is the injected text, and the log line is the report.
      console.error(`[prompts] onInvariantInjected falló para ${gap.id}: ${e.message}`);
    }
  }
  return fill({ ...all, projectContext: `${all.projectContext}${backstopBlock(gaps)}` });
}

/**
 * Loads and checks every template. Called at boot so typos surface there.
 * `scopeOf` is what `renderPrompt` calls on every render; asking it here for
 * each key turns a template missing from `PARALLEL_SCOPE` into a boot failure
 * instead of one in the middle of a task. It is a parameter so a test can stand
 * in for a key the real table lacks.
 */
export function validatePrompts({ scopeOf = parallelFor } = {}) {
  const onDisk = readdirSync(DIR).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  const declared = Object.keys(ALLOWED);

  const unscoped = [];
  for (const name of declared) {
    try {
      scopeOf(name);
    } catch (e) {
      unscoped.push(e.message);
    }
  }
  if (unscoped.length) throw new Error(unscoped.join('; '));

  for (const name of declared) read(name);

  const extra = onDisk.filter((n) => !declared.includes(n));
  if (extra.length) console.warn(`[prompts] archivos sin declarar en ALLOWED (no se usan): ${extra.join(', ')}`);
  return declared.length;
}
