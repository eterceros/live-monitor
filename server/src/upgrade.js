import './bootsnapshot.js';   // first: the start-up snapshot comes before any write
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import express from 'express';
import { isDirectLoopback } from './access.js';
import { createRequire } from 'node:module';
import {
  existsSync, readFileSync, mkdirSync, rmSync, appendFileSync,
} from 'node:fs';
import { writeDurableSync } from './durable.js';
import path from 'node:path';
import { ROOT, DATA_DIR } from './config.js';
import { store } from './store.js';
import { keyOf } from './keys.js';
import { settings } from './settings.js';
import { beginBoardSpan, endBoardSpan, closeOpenBoardSpans } from './boardtimings.js';
import { machines } from './machine.js';
import { runnerEvents, isRunnerOffline } from './runner-client.js';
import { run } from './exec.js';
import { chatsOf, chatRunning } from './chats.js';
import { allHolders, holderKey } from './projectchats.js';
import {
  sdkVersion, expectedClaudeVersion, isNewerVersion, isStrictVersion, pairedCliVersion, versionAtLeast,
} from './claude.js';
import { gitBusyReason, movingReason, closeTaskSessions, tick } from './pipeline.js';
import { checkoutHooks, checkoutsBusy } from './checkout.js';

/**
 * Upgrading the Claude Agent SDK, the CLI and the runner from the board.
 *
 * The board cannot restart itself — `stop.ps1` kills its whole process tree —
 * so the work is split in two. What can be done with the board alive happens
 * here: detection, the prechecks, waiting until nothing is running, and the
 * runners (CLI install outside the runner's cgroup, pull, restart through
 * systemd). Then the board closes its sessions, hands over to `upgrade.ps1`
 * and exits; the script replaces the SDK on the laptop and starts the board
 * again, which picks the result up in `resumeOnBoot`.
 *
 * The job lives in `server/data/upgrade.json`, shared with the script:
 * `waiting → running → laptop → done | failed`.
 */

const REGISTRY = 'https://registry.npmjs.org';
const NOTES_URL = 'https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md';
const TARGET_RE = /^0\.3\.\d{1,6}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const JOB_ID_RE = /^u-[0-9a-z]+$/;
const UNFINISHED = ['waiting', 'running', 'laptop'];
const TERMINAL = ['done', 'failed'];
const MAX_LOG_TAIL = 40;
const CHECK_TTL_MS = 30_000;
const PERIODIC_MS = 6 * 60 * 60_000;
const WAIT_RECHECK_MS = 15_000;
// PowerShell may write a byte-order mark; built from its code point so the
// source carries no invisible character.
const LEADING_BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);

/** Files whose change between two commits means the runner's code changed. */
export const RUNNER_PATHS = [
  'server/runner.js', 'server/src/runner/', 'server/src/machine.js', 'server/src/runner-client.js',
  'server/src/exec.js', 'server/src/config.js', 'remote/hfsmon-runner.service',
  // The board plugin is loaded from the runner's own checkout, so a change there must reach it.
  'plugins/',
];
/** What the laptop script commits; they must be clean before it starts. */
export const LAPTOP_FILES = ['server/package.json', 'server/package-lock.json', 'remote/bootstrap.sh'];

const LOCAL_GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const RUNNER_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };

/**
 * A `systemd-run --user` transient unit gets the user manager's environment,
 * not the runner unit's `Environment=PATH=…`: without these, `claude` does not
 * resolve there. `XDG_RUNTIME_DIR` is what lets `--user` find the bus from a
 * process a service started.
 */
const SYSTEMD_ENV = 'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"';
const systemdRun = (unit, rest) =>
  `${SYSTEMD_ENV}; systemd-run --user --collect --quiet --unit=${unit} --setenv=PATH="$PATH" --setenv=HOME="$HOME" --working-directory="$HOME" ${rest}`;

/** Seams: everything that reaches outside the process goes through here. */
export const upgradeHooks = {
  /** The hfs-monitor checkout: `upgrade.ps1`, the lock, and where local git runs. */
  root: ROOT,
  now: () => new Date(),
  git: (args, { timeoutMs = 60_000 } = {}) => run('git', args, { cwd: upgradeHooks.root, timeoutMs, env: LOCAL_GIT_ENV }),
  fetchRegistry: async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    let body = null;
    try { body = await res.json(); } catch { /* not JSON: the status says enough */ }
    return { status: res.status, body };
  },
  resolveTool: async (name) => (await run(process.platform === 'win32' ? 'where' : 'which', [name], { timeoutMs: 10_000 })).ok,
  sdkVersion: () => sdkVersion(),
  /** `{ sdk, cli, laptopCli }` of this laptop, as installed right now. */
  laptopVersions: () => readLaptopVersions(),
  spawnScript: (opts) => spawnUpgradeScript(opts),
  /**
   * True while a «Renovar login» job runs: an upgrade (or a runner restart) would
   * kill the login in progress. Wired by index.js; the login module imports this
   * file, never the other way round.
   */
  loginRunning: () => false,
  exit: (code) => process.exit(code),
  isAlive: (pid) => pidAlive(pid),
  timing: {
    // Longer than the retries the runner client spends on one request: a box
    // that is merely slow to answer must be given the chance to answer, not
    // aborted by this ceiling in the middle of its own retrying.
    infoTimeoutMs: 20_000,
    donePollMs: 5000,
    // Longer than the `timeout 900` around `claude install`, so its own exit
    // code is what gets read.
    doneTimeoutMs: 16 * 60_000,
    restartPollMs: 2000,
    restartTimeoutMs: 60_000,
    exitDelayMs: 300,
    laptopWatchMs: 2000,
    // With no live lock but a live `scriptPid`, how long to believe the pid:
    // after a reboot it may belong to something else.
    staleGraceMs: 30_000,
    // Consecutive looks without a readable job file before a dead script is
    // taken as gone without a result.
    missingLooks: 10,
  },
};

/** `state` on every job change and every check result. */
export const upgradeEvents = new EventEmitter();

const iso = () => upgradeHooks.now().toISOString();
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const short = (sha) => (sha ? String(sha).slice(0, 7) : '?');
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const LOGIN_RUNNING_MESSAGE = 'Se está renovando el login de Claude en una máquina';
const lastLines = (text, n = 6) => String(text ?? '').split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(-n).join(' | ');

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not respond in ${Math.round(ms / 1000)} s`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------
// The job file, the lock and the log.

export const jobFile = () => path.join(DATA_DIR, 'upgrade.json');
export const logFile = (id) => path.join(DATA_DIR, 'upgrade', `${id}.log`);
export const lockFile = () => path.join(upgradeHooks.root, '.hfs-monitor.upgrading');

/** The job on disk: `{ job }`, or `{ error }` when the file is there but unreadable. */
function readJobFile() {
  const file = jobFile();
  if (!existsSync(file)) return { job: null };
  try {
    const text = readFileSync(file, 'utf8').replace(LEADING_BOM, '');
    const parsed = JSON.parse(text);
    return { job: parsed && typeof parsed === 'object' ? parsed : null };
  } catch (e) {
    return { error: e.message };
  }
}

function writeJobFile(value) {
  const file = jobFile();
  mkdirSync(path.dirname(file), { recursive: true });
  if (!value) {
    rmSync(file, { force: true });
    return;
  }
  writeDurableSync(file, JSON.stringify(value, null, 2), { tmp: `${file}.${process.pid}.tmp` });
}

function readLogTail(id, n = MAX_LOG_TAIL) {
  try {
    return readFileSync(logFile(id), 'utf8').replace(LEADING_BOM, '').split(/\r?\n/).filter(Boolean).slice(-n);
  } catch {
    return null;
  }
}

let job = null;
let jobLoaded = false;
// After the last write before the handover, this process writes nothing more:
// the file belongs to the script from then on.
let frozen = false;

function currentJob() {
  if (!jobLoaded) {
    // A file mid-replace is not "no job": only a clean read settles it.
    const read = readJobFile();
    if (!read.error) {
      job = read.job ?? null;
      jobLoaded = true;
    }
  }
  return job;
}

/** The job left an unfinished state: whatever it held back may start now. */
function releaseGates() {
  try { tick(); } catch { /* the next tick will do */ }
}

export const getUpgradeJob = () => currentJob();

/** A job scheduled or under way: nothing new starts. */
export function upgradeHoldsNewWork() {
  return UNFINISHED.includes(currentJob()?.state);
}

// `checkout.js` cannot import this module (`pipeline.js` imports it), so the
// guard is handed to it from here: nothing is cloned or installed while a job
// is waiting or running.
checkoutHooks.holdsNewWork = upgradeHoldsNewWork;

/** The runners or the laptop are being replaced right now. */
export function upgradeRunning() {
  return ['running', 'laptop'].includes(currentJob()?.state);
}

/** Refuses with 409 while the upgrade runs. */
export function assertNoUpgradeRunning() {
  if (upgradeRunning()) throw httpError(409, 'The board is updating', { job: currentJob() });
}

function save() {
  if (frozen || !job) return;
  const tail = readLogTail(job.id);
  if (tail) job.logTail = tail;
  writeJobFile(job);
  emitState();
}

function logLine(j, text) {
  const file = logFile(j.id);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${iso()} ${text}\n`, 'utf8');
  } catch { /* the job still says what happened */ }
}

// Board-span ids live in memory only: `upgrade.json` is rewritten by the
// PowerShell script, and an id cannot outlive the process anyway. A board that
// comes up after a cut closes what is left open by exact span name instead.
const stepSpans = new WeakMap();
let jobSpanId = null;

/**
 * The job's own span, closed by id when this process opened it, else by name
 * and job id (never another job's span). `at` is the job's real end time when
 * the caller knows it; the by-id path always ends now, in this process.
 */
function endJobSpan(jobId, outcome, meta = {}, at = undefined) {
  const id = jobSpanId;
  jobSpanId = null;
  if (id && endBoardSpan(id, { outcome, ...meta })) return;
  closeOpenBoardSpans(at, { name: 'upgrade', outcome, job: jobId, meta });
}

/**
 * Closes what a finished job left open: its own `upgrade` span with the job's
 * real end time, outcome and failed step, and any `upgrade` span of an older
 * job as interrupted with zero length (nobody saw it end).
 */
function closeFinishedJobSpans(j) {
  const outcome = j.state === 'done' ? 'ok' : 'failed';
  const meta = j.state === 'failed' ? { failedStep: j.failedStep ?? null } : {};
  const at = j.endedAt && !Number.isNaN(Date.parse(j.endedAt)) ? j.endedAt : iso();
  jobSpanId = null;
  closeOpenBoardSpans(at, { name: 'upgrade', outcome, job: j.id, meta });
  closeOpenBoardSpans(at, { name: 'upgrade', outcome: 'interrupted', except: j.id });
}

function stepStart(j, name, detail) {
  const step = { name, state: 'running', detail, at: iso() };
  j.steps.push(step);
  j.step = name;
  const spanId = beginBoardSpan({ name: `upgrade:${name}`, job: j.id });
  if (spanId) stepSpans.set(step, spanId);
  logLine(j, `${name}: ${detail}`);
  save();
  return step;
}

function stepEnd(j, step, state, detail) {
  step.state = state;
  step.endedAt = iso();
  endBoardSpan(stepSpans.get(step), { outcome: state });
  if (detail !== undefined) step.detail = detail;
  logLine(j, `${step.name} → ${state}: ${step.detail}`);
  save();
}

/** One step: `fn` may end it itself (`skipped`, `warn`); a throw marks it failed. */
async function withStep(j, name, detail, fn) {
  const step = stepStart(j, name, detail);
  try {
    const result = await fn(step);
    if (step.state === 'running') stepEnd(j, step, 'ok');
    return result;
  } catch (e) {
    if (step.state === 'running') stepEnd(j, step, 'failed', `${detail}: ${e.message}`);
    if (!e.step) e.step = name;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// What is running, and would be cut.

const PLAN_LIVE = ['running', 'asking'];

/**
 * Why the upgrade has to wait, per task, and what it will cut without
 * waiting for. A running stack is only a warning: it can stay up for days.
 */
export function idleReasons() {
  const reasons = [];
  const warnings = [];
  const tasks = store.all();
  // With one project the board reads as it always has, «#12 está…»; the project
  // only earns a place in the text once there is more than one of them and a
  // bare issue number stops identifying anything.
  const many = new Set(tasks.map((t) => t.project)).size > 1;
  for (const task of tasks) {
    const key = keyOf(task);
    const label = (text) => (many ? `${key}: ${text}` : text);
    const add = (raw, extra = {}) => {
      const text = label(raw);
      // By key, not by issue: two projects both stuck on their own #12 are two
      // reasons to wait, not one.
      if (!reasons.some((r) => keyOf(r) === key && r.text === text)) {
        // `machine` lets the login renewal ask for the busy work of ONE machine.
        reasons.push({ project: task.project, issue: task.issue, text, machine: task.machine ?? 'local', ...extra });
      }
    };
    const busy = gitBusyReason(task);
    if (busy) add(busy);
    for (const chat of chatsOf(task)) {
      if (PLAN_LIVE.includes(chat.plan?.status)) add(`el chat «${chat.title}» está ejecutando un plan`);
      if (chat.closedAt) continue;
      const moving = chatRunning(chat);
      if (moving && (moving.agents.running || moving.commands || moving.servers)) {
        const parts = [
          moving.agents.running ? `${moving.agents.running} subagente(s)` : null,
          moving.commands ? `${moving.commands} comando(s)` : null,
          moving.servers ? `${moving.servers} servidor(es)` : null,
        ].filter(Boolean);
        add(`el chat «${chat.title}» tiene en marcha ${parts.join(', ')}`);
      }
    }
    if (PLAN_LIVE.includes(task.workPlan?.status)) add('el plan de trabajo está en marcha');
    if (task.qaBusy) add('Browser QA está en marcha');
    if (task.creatingWorktree) add('se está creando el worktree');
    // A move touches both machines' credentials, so it is busy on both.
    if (task.moving && !task.moving.error) {
      add(movingReason(task), { machines: [task.moving.from, task.moving.to].filter(Boolean) });
    }
    if (task.prewarm && !task.prewarm.endedAt) add(`se está precompilando en ${task.prewarm.machine}`);
    // A warning keeps the shape it has today, `{ issue, text }`, and takes the
    // project in its text like everything else. It is deliberately NOT gaining
    // a `project` field: `upgrade.test.mjs:614` compares the whole array with
    // `deepEqual`, and that line is not this package's to edit.
    if (task.stack?.status === 'running') warnings.push({ issue: task.issue, text: label('el stack de HFS se parará') });
  }
  // A project chat is not a task and is not in `store.all()`, but a turn cut
  // in the middle is just as lost: it waits too. Added after the task loop
  // because those reasons carry no issue, and the dedupe above reads `keyOf`.
  for (const holder of allHolders()) {
    const where = `el chat de proyecto ${holderKey(holder.project, holder.machine)}`;
    for (const chat of chatsOf(holder)) {
      if (chat.closedAt) continue;
      const moving = chatRunning(chat);
      const live = chat.busy
        || PLAN_LIVE.includes(chat.plan?.status)
        || (moving && (moving.agents.running || moving.commands || moving.servers));
      if (live) reasons.push({ project: holder.project, issue: null, text: `${where}: «${chat.title}» está en marcha`, machine: holder.machine });
    }
  }
  // A clone or a Prepare, running or queued: a restarted runner would cut it.
  // It may belong to no task (Prepare) and to no live chat turn.
  for (const job of checkoutsBusy()) {
    let text = `preparing ${job.repo} on ${job.machine} (${job.step})`;
    if (job.status === 'queued') text = `${job.repo} is waiting for its checkout on ${job.machine}`;
    else if (job.step === 'clone') text = `cloning or checking ${job.repo} on ${job.machine}`;
    reasons.push({ project: job.project, issue: null, text, machine: job.machine });
  }
  return { reasons, warnings };
}

// ---------------------------------------------------------------------------
// Detection.

let lastCheck = null;    // { at, value }
let checking = null;

async function registry(url) {
  try {
    return await upgradeHooks.fetchRegistry(url);
  } catch {
    return { status: 0, body: null };
  }
}

/** The CLI a SDK version pairs with, and whether npm can serve both. */
export async function describeVersion(version) {
  if (!isStrictVersion(version)) return { cli: null, installable: false, manual: true };
  const meta = await registry(`${REGISTRY}/@anthropic-ai/claude-agent-sdk/${version}`);
  const cli = pairedCliVersion(version, meta.status === 200 ? meta.body : null);
  if (!cli) return { cli: null, installable: false, manual: true };
  const [native, code] = await Promise.all([
    registry(`${REGISTRY}/@anthropic-ai/claude-agent-sdk-win32-x64/${version}`),
    registry(`${REGISTRY}/@anthropic-ai/claude-code/${cli}`),
  ]);
  return { cli, installable: meta.status === 200 && native.status === 200 && code.status === 200, manual: false };
}

async function checkSdk() {
  const current = upgradeHooks.sdkVersion();
  const res = await registry(`${REGISTRY}/@anthropic-ai/claude-agent-sdk/latest`);
  const latest = res.status === 200 && isStrictVersion(res.body?.version) ? res.body.version : null;
  const behind = isNewerVersion(latest, current);
  // Up to date is not «nothing to say»: the installed version is described too,
  // so `cli` names the CLI that pairs with it and `installable` means something
  // — the runner-only upgrade lives exactly here. Three registry requests per
  // check: `fresh: true` skips the TTL, and only concurrent calls are shared.
  const described = await describeVersion(behind ? latest : current);
  return { current, latest, behind, ...described, notesUrl: latest ? NOTES_URL : null };
}

async function checkGit() {
  const git = upgradeHooks.git;
  const fetched = await git(['fetch', '--quiet', 'origin', 'main'], { timeoutMs: 60_000 });
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = await git(['status', '--porcelain', '--', ...LAPTOP_FILES]);
  const main = await git(['rev-parse', '--verify', 'origin/main']);
  const originMain = main.ok && SHA_RE.test(main.stdout.trim()) ? main.stdout.trim() : null;
  let unpushed = null;
  if (originMain) {
    const count = await git(['rev-list', '--count', 'origin/main..HEAD']);
    if (count.ok) unpushed = Number(count.stdout.trim()) || 0;
  }
  return {
    branch: branch.ok ? branch.stdout.trim() : null,
    dirty: status.ok
      ? status.stdout.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.slice(3).trim())
      : ['(git status falló)'],
    unpushed,
    originMain,
    fetchError: fetched.ok ? null : (lastLines(fetched.stderr) || 'git fetch falló'),
  };
}

/**
 * How a runner's commit stands against the laptop's `origin/main`:
 * `current`, `behind` (an ancestor, with runner code changed in between),
 * `diverged` (not an ancestor: never pulled) or `unknown`.
 */
export async function compareRunnerCommit(sha, target) {
  if (!SHA_RE.test(String(sha ?? '')) || !SHA_RE.test(String(target ?? ''))) return 'unknown';
  const git = upgradeHooks.git;
  if (!(await git(['cat-file', '-e', `${sha}^{commit}`])).ok) return 'unknown';
  if (sha === target) return 'current';
  if (!(await git(['merge-base', '--is-ancestor', sha, target])).ok) return 'diverged';
  const diff = await git(['diff', '--name-only', sha, target, '--', ...RUNNER_PATHS]);
  if (!diff.ok) return 'unknown';
  return diff.stdout.trim() ? 'behind' : 'current';
}

/** `runner` block of a machine: the running commit decides; null is unknown. */
export async function runnerCodeStatus(info, target) {
  const valid = (v) => (typeof v === 'string' && SHA_RE.test(v) ? v : null);
  const commit = valid(info?.commit);
  const diskCommit = valid(info?.diskCommit);
  const status = commit && target ? await compareRunnerCommit(commit, target) : 'unknown';
  return { commit, diskCommit, target: target ?? null, status };
}

async function checkMachines(originMain) {
  const wanted = expectedClaudeVersion();
  const out = {};
  await Promise.all(Object.values(machines()).map(async (m) => {
    try {
      const info = await withTimeout(m.info(), upgradeHooks.timing.infoTimeoutMs, m.name);
      const claude = info?.claude ?? null;
      const entry = { kind: m.kind, online: true, claude, wanted, ok: !wanted || versionAtLeast(claude, wanted) };
      if (m.kind === 'runner') entry.runner = await runnerCodeStatus(info, originMain);
      out[m.name] = entry;
    } catch (e) {
      out[m.name] = {
        kind: m.kind, online: false, claude: null, wanted, ok: false, error: e.message,
        ...(m.kind === 'runner' ? { runner: { commit: null, diskCommit: null, target: originMain, status: 'unknown' } } : {}),
      };
    }
  }));
  return out;
}

async function runCheck() {
  const [sdk, git] = await Promise.all([checkSdk(), checkGit()]);
  const found = await checkMachines(git.originMain);
  return { sdk, machines: found, git, checkedAt: iso() };
}

/**
 * Detection, cached 30 s (`fresh` bypasses it). The job is never part of the
 * cache: it is merged in, current, by `currentUpgradeState`.
 */
export function checkUpgrade({ fresh = false } = {}) {
  if (!fresh && lastCheck && Date.now() - lastCheck.at < CHECK_TTL_MS) return Promise.resolve(lastCheck.value);
  if (checking) return checking;
  checking = runCheck()
    .then((value) => {
      lastCheck = { at: Date.now(), value };
      emitState();
      return value;
    })
    .finally(() => { checking = null; });
  return checking;
}

/**
 * What the board knows now, without waiting on anything: the last detection
 * (nulls before the first one) and the job as it is this instant.
 */
export function currentUpgradeState() {
  const check = lastCheck?.value;
  return {
    sdk: check?.sdk ?? {
      current: upgradeHooks.sdkVersion(), latest: null, behind: false, cli: null, installable: false, manual: false, notesUrl: null,
    },
    machines: check?.machines ?? {},
    git: check?.git ?? null,
    idle: idleReasons(),
    job: currentJob(),
    settings: settings.upgrade,
    checkedAt: check?.checkedAt ?? null,
  };
}

/**
 * `GET /api/upgrade`. Never waits on the network unless `fresh`: the laptop
 * script polls this URL as its health check, and a slow registry or runner
 * must not read as a board that did not come back.
 */
export async function upgradeState({ fresh = false } = {}) {
  if (fresh) {
    await checkUpgrade({ fresh: true }).catch(() => null);
  } else if (!checking && (!lastCheck || Date.now() - lastCheck.at >= CHECK_TTL_MS)) {
    checkUpgrade({ fresh: true }).catch(() => null);
  }
  return currentUpgradeState();
}

function emitState() {
  upgradeEvents.emit('state', currentUpgradeState());
}

/**
 * A runner found unreachable by *any* call — a git command of a chat, a file
 * read, a health check — not only by the detection above, which runs every six
 * hours. The board already knows how to draw `online: false` with its reason
 * (the header chip and the upgrade dialog both do), so the cached machines
 * block is corrected and broadcast rather than left saying the box is fine
 * until the next check. A box that answers again only invalidates the cache:
 * its CLI version and its commit have to be asked for, not guessed.
 */
export function noteRunnerReachable(name, online, error = null) {
  const found = lastCheck?.value?.machines?.[name];
  if (!found || found.online === online) return;
  if (online) {
    lastCheck = null;
  } else {
    found.online = false;
    found.claude = null;
    found.ok = false;
    found.error = error ?? `${name} no responde`;
  }
  emitState();
}

runnerEvents.on('offline', ({ machine, error }) => noteRunnerReachable(machine, false, error));
runnerEvents.on('online', ({ machine }) => noteRunnerReachable(machine, true));

let periodicTimer = null;
/** On boot and every 6 h. */
export function startUpgradeChecks() {
  checkUpgrade({ fresh: true }).catch(() => null);
  if (periodicTimer) return;
  periodicTimer = setInterval(() => checkUpgrade({ fresh: true }).catch(() => null), PERIODIC_MS);
  periodicTimer.unref?.();
}

// ---------------------------------------------------------------------------
// The request.

export function bundledCliPath() {
  try {
    const entry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    return path.join(path.dirname(entry), '..', `claude-agent-sdk-${process.platform}-${process.arch}`, exe);
  } catch {
    return null;
  }
}

const firstToken = (r) => {
  const token = r.ok ? r.stdout.trim().split(/\s+/)[0] : null;
  return isStrictVersion(token) ? token : null;
};

async function readLaptopVersions() {
  const exe = bundledCliPath();
  const bundled = exe && existsSync(exe) ? firstToken(await run(exe, ['--version'], { timeoutMs: 20_000 })) : null;
  const onPath = firstToken(await run('claude', ['--version'], { timeoutMs: 20_000 }));
  return { sdk: sdkVersion(), cli: bundled ?? expectedClaudeVersion(), laptopCli: onPath };
}

/**
 * A runner a runner-only job leaves alone. Such a job updates the runners it
 * *can*: a box that does not answer, and a box whose code diverged from
 * `origin/main`, both wait for someone to look at them — `runner_check`
 * refuses a divergence on purpose, and nothing here can guess what to do with
 * it — but neither of them holds back the healthy boxes. Waiting for a hand is
 * the whole point: with the SDK already current, the alternative is that one
 * box nobody has fixed keeps the rest on old code indefinitely.
 */
const skippedByRunnerOnly = (m) => !m.online || m.runner?.status === 'diverged';

/**
 * Runners worth a runner-only upgrade: code behind `origin/main`, or a CLI
 * below the one the installed SDK pairs with. Only the ones such a job would
 * really touch, so «nada que actualizar» is not answered with a job that then
 * touches nothing.
 */
export function runnersNeedingUpdate(state) {
  return Object.entries(state.machines ?? {})
    .filter(([, m]) => m.kind === 'runner' && !skippedByRunnerOnly(m)
      && (m.runner?.status === 'behind' || (m.wanted && !versionAtLeast(m.claude, m.wanted))))
    .map(([name]) => name);
}

async function prechecks(state, { onlyLaptop, runnerOnly }) {
  const blockers = [];
  const git = state.git ?? {};
  // What the laptop script needs; a runner-only job never starts it.
  if (!runnerOnly) {
    if (git.branch !== 'main') {
      blockers.push({ code: 'wrong_branch', text: `el tablero está en la rama ${git.branch ?? '(desconocida)'}, no en main` });
    }
    if (git.dirty?.length) {
      blockers.push({ code: 'dirty_files', files: git.dirty, text: `hay cambios sin commitear en ${git.dirty.join(', ')}` });
    }
    const tools = process.platform === 'win32' ? ['npm.cmd', 'git', 'claude'] : ['npm', 'git', 'claude'];
    for (const tool of tools) {
      if (!(await upgradeHooks.resolveTool(tool))) blockers.push({ code: 'missing_tool', tool, text: `no se encuentra ${tool} en el PATH` });
    }
  }
  if (!onlyLaptop) {
    for (const [name, m] of Object.entries(state.machines ?? {})) {
      if (m.kind !== 'runner') continue;
      // A runner-only job updates the runners it can; the ones it cannot are
      // left out of it, not turned into a refusal for the healthy ones.
      if (runnerOnly && skippedByRunnerOnly(m)) continue;
      if (!m.online) {
        blockers.push({ code: 'runner_offline', machine: name, text: `${name} no responde a /info: arráncalo o elige «Solo la portátil»` });
      } else if (m.runner?.status === 'diverged') {
        blockers.push({ code: 'runner_diverged', machine: name, text: `el runner de ${name} ha divergido de origin/main: arréglalo a mano o elige «Solo la portátil»` });
      }
    }
  }
  return blockers;
}

let requestChain = Promise.resolve();

/**
 * `POST /api/upgrade`. Serialized: two requests at once make one job, and the
 * second hears about it with 409.
 */
export function requestUpgrade(body = {}, { loopback = false } = {}) {
  const next = requestChain.then(() => createJob(body ?? {}, { loopback }));
  requestChain = next.catch(() => null);
  return next;
}

async function createJob({
  target, onlyLaptop = false, force = false, updatePathCli = false,
}, { loopback }) {
  if (typeof target !== 'string' || !TARGET_RE.test(target)) {
    throw httpError(400, 'target must be a 0.3.N version');
  }
  const forced = force === true;
  if (forced && !(process.env.HFSMON_UPGRADE_FORCE === '1' && loopback)) {
    throw httpError(403, 'force only works with HFSMON_UPGRADE_FORCE=1 and from this same machine');
  }
  const existing = currentJob();
  if (existing && UNFINISHED.includes(existing.state)) {
    throw httpError(409, 'There is already an unfinished update', { job: existing });
  }
  if (upgradeHooks.loginRunning()) throw httpError(409, LOGIN_RUNNING_MESSAGE);

  const state = await checkUpgrade({ fresh: true });
  let cli;
  let installable;
  let runnerOnly = false;
  if (forced) {
    if (target !== state.sdk.current) {
      throw httpError(400, `with force the target is the installed version (${state.sdk.current}), not ${target}`);
    }
    ({ cli, installable } = await describeVersion(target));
  } else if (target === state.sdk.latest && state.sdk.behind) {
    ({ cli, installable } = state.sdk);
  } else if (target === state.sdk.current) {
    // The SDK stays; only runners behind on code or CLI are brought up to it.
    if (onlyLaptop === true || !runnersNeedingUpdate(state).length) throw httpError(400, 'nothing to update');
    runnerOnly = true;
    // The fresh check above already described the installed version: three
    // registry requests not worth making twice. Unless it described a newer
    // one — `behind` means `state.sdk` speaks of `latest`, not of this target.
    ({ cli, installable } = state.sdk.behind ? await describeVersion(target) : state.sdk);
  } else {
    throw httpError(400, `${target} is not the latest published version (${state.sdk.latest ?? 'unknown'})`);
  }

  const blockers = [];
  if (!cli) blockers.push({ code: 'manual', text: `no se sabe qué CLI va con ${target}: actualiza a mano` });
  // npm only gates what the laptop installs. A runner-only job targets the
  // installed version — whose Windows native package npm published by
  // definition — and the `npm ci` of `runner_code` runs with the box's own
  // reach: here `installable: false` only means this laptop cannot get to npm.
  else if (!installable && !runnerOnly) blockers.push({ code: 'not_installable', text: `npm todavía no sirve ${target} para Windows o claude-code ${cli}` });
  blockers.push(...await prechecks(state, { onlyLaptop: onlyLaptop === true, runnerOnly }));
  if (blockers.length) throw httpError(409, blockers.map((b) => b.text).join('; '), { blockers });

  const previous = await upgradeHooks.laptopVersions();
  const runners = {};
  if (onlyLaptop !== true) {
    for (const [name, m] of Object.entries(state.machines)) {
      // The same rule as the prechecks: a box the job will not touch has no
      // business in the map the dialog reads as «qué se va a tocar», and
      // `runJob` walks these names — a diverged one would die in `runner_check`.
      if (m.kind !== 'runner' || (runnerOnly && skippedByRunnerOnly(m))) continue;
      runners[name] = { commitBefore: m.runner?.diskCommit ?? m.runner?.commit ?? null, commitAfter: null, cliBefore: m.claude ?? null, cliAfter: null };
    }
  }
  job = {
    id: `u-${upgradeHooks.now().getTime().toString(36)}`,
    state: 'waiting',
    target: { sdk: target, cli },
    previous: { sdk: previous.sdk ?? null, cli: previous.cli ?? null, laptopCli: previous.laptopCli ?? null },
    onlyLaptop: onlyLaptop === true,
    // Runners only: the SDK is already current, the laptop is not touched.
    runnerOnly,
    /**
     * Whether `upgrade.ps1` also runs `claude install` over the `claude` on the
     * laptop's PATH — Edson's interactive CLI. Off unless asked for, and never
     * on by default, because that install does nothing for the board: the
     * board's own sessions run the CLI bundled inside the SDK, and the
     * `CLAUDE_VERSION_WANTED` the runner checks is written by `laptop_bootstrap`.
     * What it does do is take up to ten minutes and share the credentials file
     * with the sessions that are open while it runs (2026-09-24: it blew its
     * 600 s deadline, was killed mid-install leaving a 0-byte binary in the
     * versions folder, and very likely took a live session down with
     * `OAuth session expired and could not be refreshed`).
     *
     * A runner-only job never starts `upgrade.ps1` at all, so the flag would be
     * an announcement of something that cannot happen: it stays false there
     * whatever was asked for.
     */
    updatePathCli: updatePathCli === true && !runnerOnly,
    force: forced,
    requestedAt: iso(),
    startedAt: null,
    endedAt: null,
    step: null,
    steps: [],
    failedStep: null,
    error: null,
    runners,
    laptop: { commit: null, pushed: null, pushError: null, rolledBack: false },
    scriptPid: null,
    boardPid: null,
    logTail: [],
    acknowledged: false,
  };
  jobLoaded = true;
  frozen = false;
  logLine(job, runnerOnly
    ? `pedida: solo los runners (${Object.keys(runners).join(', ')}), CLI ${cli}`
    : `pedida: SDK ${previous.sdk} → ${target}, CLI ${cli}${job.onlyLaptop ? ', solo la portátil' : ''}${job.updatePathCli ? ', con el claude del PATH' : ''}${forced ? ', force' : ''}; ${state.git?.unpushed ?? 0} commit(s) sin push viajarán`);
  save();
  armWaiting();
  evaluateWaiting();
  return job;
}

// ---------------------------------------------------------------------------
// Waiting.

let waitTimer = null;
let taskListener = null;
let evalTimer = null;
let lastReasonsKey = null;

/**
 * A call a timer makes and nobody waits for. Whatever it throws — a machine
 * that is not there, a file that would not write — belongs in the log, never
 * in an unhandled rejection: this process holds every task in flight.
 */
function detached(what, fn) {
  try {
    return Promise.resolve(fn()).catch((e) => console.error(`[upgrade] ${what}: ${e.stack ?? e.message}`));
  } catch (e) {
    console.error(`[upgrade] ${what}: ${e.stack ?? e.message}`);
    return Promise.resolve();
  }
}

function armWaiting() {
  if (waitTimer) return;
  waitTimer = setInterval(() => detached('la espera', evaluateWaiting), WAIT_RECHECK_MS);
  waitTimer.unref?.();
  // A task event per tool call: coalesced to at most one look a second.
  taskListener = () => {
    if (evalTimer) return;
    evalTimer = setTimeout(() => { evalTimer = null; detached('la espera', evaluateWaiting); }, 1000);
    evalTimer.unref?.();
  };
  store.on('task', taskListener);
}

function disarmWaiting() {
  if (waitTimer) clearInterval(waitTimer);
  waitTimer = null;
  if (evalTimer) clearTimeout(evalTimer);
  evalTimer = null;
  if (taskListener) store.off('task', taskListener);
  taskListener = null;
  lastReasonsKey = null;
}

/** Starts a waiting job once nothing is running; otherwise tells the boards why not. */
export function evaluateWaiting() {
  if (currentJob()?.state !== 'waiting') {
    disarmWaiting();
    return Promise.resolve(null);
  }
  const { reasons } = idleReasons();
  if (reasons.length) {
    const key = JSON.stringify(reasons);
    if (key !== lastReasonsKey) {
      lastReasonsKey = key;
      emitState();
    }
    return Promise.resolve(null);
  }
  return startRunning();
}

let runInFlight = null;   // { job, done }

/**
 * `waiting → running`, exactly once: the check and the change are one
 * synchronous stretch, and a run in flight answers every other caller.
 * `now` skips the idle check — «Actualizar ya».
 */
export function startRunning({ now = false } = {}) {
  if (runInFlight) return Promise.resolve(runInFlight.job);
  const j = currentJob();
  if (j?.state !== 'waiting') return Promise.resolve(null);
  // Outside the `!now` test: «Actualizar ya» skips the wait for busy work, not this.
  if (upgradeHooks.loginRunning()) return Promise.resolve(null);
  if (!now && idleReasons().reasons.length) return Promise.resolve(null);
  j.state = 'running';
  j.startedAt = iso();
  jobSpanId = beginBoardSpan({ name: 'upgrade', job: j.id, onlyLaptop: !!j.onlyLaptop, runnerOnly: !!j.runnerOnly });
  disarmWaiting();
  logLine(j, now ? 'empieza ya, sin esperar' : 'el tablero está libre: empieza');
  save();
  const entry = { job: j, done: null };
  runInFlight = entry;
  // `runJob` records its own failures in the job; the `catch` is for what even
  // that could not do — writing the file, say — which must not become an
  // unhandled rejection on a promise only the tests ever await.
  entry.done = runJob(j)
    .finally(() => { if (runInFlight === entry) runInFlight = null; })
    .catch((e) => console.error(`[upgrade] el trabajo ${j.id} murió: ${e.stack ?? e.message}`));
  return Promise.resolve(j);
}

/** The run in flight, for whoever needs to wait for it (tests). */
export const upgradeRun = () => runInFlight?.done ?? Promise.resolve();

async function runJob(j) {
  try {
    const names = j.onlyLaptop ? [] : Object.keys(j.runners ?? {});
    if (j.onlyLaptop) {
      const skipped = Object.values(machines()).filter((m) => m.kind === 'runner').map((m) => m.name);
      if (skipped.length) {
        const step = stepStart(j, 'runner_check', skipped.join(', '));
        stepEnd(j, step, 'skipped', `solo la portátil: ${skipped.join(', ')} no se toca`);
      }
    }
    for (const name of names) {
      const m = machines()[name];
      if (!m || m.kind !== 'runner') continue;
      await upgradeRunner(j, m);
    }
    if (j.runnerOnly) {
      // Nothing to hand over: the board keeps running, the job is over.
      j.state = 'done';
      j.step = null;
      j.endedAt = iso();
      logLine(j, 'runners al día; la portátil no se toca');
      endJobSpan(j.id, 'ok');
      save();
      releaseGates();
      return;
    }
    await handover(j);
  } catch (e) {
    if (frozen) return;
    j.state = 'failed';
    j.failedStep = e.step ?? j.step ?? null;
    j.error = e.message;
    j.endedAt = iso();
    logLine(j, `falló en ${j.failedStep}: ${e.message}`);
    endJobSpan(j.id, 'failed', { failedStep: j.failedStep });
    save();
    releaseGates();
  }
}

// ---------------------------------------------------------------------------
// Runner steps.

/** A command on the runner, through `sh -c`, with its lines in the job's log. */
function runnerShell(j, m) {
  return (script, { cwd, timeoutMs = 120_000 } = {}) => {
    logLine(j, `${m.name}$ ${script}`);
    return m.exec('sh', ['-c', script], {
      cwd, env: RUNNER_ENV, timeoutMs, onLine: (line) => logLine(j, `${m.name}: ${line}`),
    });
  };
}

const FALLBACK_RUNNER_UNIT = 'hfsmon-runner.service';
const UNIT_NAME_RE = /^[A-Za-z0-9@_.:-]+$/;

/** The unit `/info` reports, validated and with its `.service` suffix; null if absent or odd. */
function reportedRunnerUnit(info) {
  if (typeof info?.unit !== 'string') return null;
  const bare = info.unit.trim().replace(/\.service$/, '');
  return bare && UNIT_NAME_RE.test(bare) ? `${bare}.service` : null;
}

/**
 * The systemd user unit the runner runs under: the one `/info` reports (it
 * ends up in shell commands, so only a plain unit name is accepted), or, for a
 * runner too old to say, the historical `hfsmon-runner.service`.
 */
export function runnerUnitName(info) {
  return reportedRunnerUnit(info) ?? FALLBACK_RUNNER_UNIT;
}

/**
 * Where the runner's checkout is: `/info` says so since it learned to; an
 * older runner is asked where its own process runs, then systemd.
 */
export async function locateMonitorDir(m, info, sh) {
  // Absolute, and with the runner's entry point in it, whoever said so.
  const absolute = (dir) => path.posix.isAbsolute(dir) || path.win32.isAbsolute(dir);
  const looksRight = async (dir) => typeof dir === 'string' && Boolean(dir) && absolute(dir) && dir !== '/'
    && await m.fs.exists(m.path.join(dir, 'server', 'runner.js')).catch(() => false);
  if (await looksRight(info?.monitorDir)) return info.monitorDir;
  const fromProc = await sh('dirname "$(readlink -f /proc/$PPID/cwd)"', { timeoutMs: 15_000 });
  const procDir = fromProc.ok ? fromProc.stdout.trim() : '';
  if (await looksRight(procDir)) return procDir;
  const fromUnit = await sh(`${SYSTEMD_ENV}; systemctl --user show -p WorkingDirectory --value ${runnerUnitName(info)}`, { timeoutMs: 15_000 });
  const workDir = fromUnit.ok ? fromUnit.stdout.trim() : '';
  const unitDir = workDir ? path.posix.dirname(workDir) : '';
  if (await looksRight(unitDir)) return unitDir;
  return null;
}

async function runnerInfo(m) {
  return withTimeout(m.info(), upgradeHooks.timing.infoTimeoutMs, m.name);
}

/**
 * Polls `/info` until `test` holds, or gives up. Errors are the restart itself,
 * but not silent: `seen` (when given) keeps the last answer, the last error and
 * how many polls failed, so a timeout can say what the board saw.
 */
export async function waitForRunner(m, test, timeoutMs, seen = {}) {
  const deadline = Date.now() + timeoutMs;
  seen.polls = 0;
  seen.failed = 0;
  while (Date.now() < deadline) {
    await sleep(upgradeHooks.timing.restartPollMs);
    seen.polls += 1;
    try {
      const got = await runnerInfo(m);
      seen.info = got;
      seen.error = null;
      if (test(got)) return got;
    } catch (e) {
      seen.failed += 1;
      seen.error = e?.message ?? String(e);
    }
  }
  return null;
}

/** What the board saw last, in one line, plus a diagnosis. */
export function describeLastSeen(seen, { sha, pidBefore, unit = FALLBACK_RUNNER_UNIT }, lang = 'en') {
  const es = lang === 'es';
  const info = seen?.info;
  const parts = (i) => {
    const unchanged = Number.isInteger(pidBefore) && i.pid === pidBefore;
    const pid = Number.isInteger(i.pid)
      ? `pid ${i.pid}${unchanged ? (es ? ' (sin cambio)' : ' (unchanged)') : Number.isInteger(pidBefore) ? (es ? ` (antes ${pidBefore})` : ` (was ${pidBefore})`) : ''}`
      : 'pid ?';
    return [pid, `commit ${i.commit ? short(i.commit) : '?'}`, `diskCommit ${i.diskCommit ? short(i.diskCommit) : '?'}`,
      ...(i.monitorDir ? [`dir ${i.monitorDir}`] : [])].join(', ');
  };
  let line;
  let diagnosis;
  if (seen?.error || !info) {
    const why = seen?.error ?? (es ? 'sin respuesta' : 'no data');
    line = es
      ? `visto por última vez: sin respuesta (${why}), ${seen?.failed ?? 0} sondeo(s) fallido(s)${info ? `; antes: ${parts(info)}` : ''}`
      : `last seen: no answer (${why}), ${seen?.failed ?? 0} failed poll(s)${info ? `; before that: ${parts(info)}` : ''}`;
    diagnosis = es ? 'el runner no responde' : 'the runner is not answering';
  } else {
    line = `${es ? 'visto por última vez' : 'last seen'}: ${parts(info)}`;
    const pidKnown = Number.isInteger(pidBefore) && Number.isInteger(info.pid);
    if (pidKnown && info.pid === pidBefore) {
      diagnosis = es
        ? `el reinicio no sustituyó al proceso que escucha en este puerto; comprueba que la unidad ${unit} es la que lo ejecuta`
        : `the restart did not replace the process that listens on this port; check that the ${unit} unit is the one running it`;
    } else if (info.commit !== sha || info.diskCommit !== sha) {
      diagnosis = es ? 'el runner se reinició desde otro checkout o commit' : 'the runner restarted from another checkout/commit';
    } else {
      diagnosis = null;
    }
  }
  return diagnosis ? `${line}. ${es ? 'Diagnóstico' : 'Diagnosis'}: ${diagnosis}` : line;
}

/**
 * Reads the runner's systemd unit and compares its MainPID with the pid that
 * serves `/info`. `fail` means a restart would not replace the live process;
 * any trouble running the probe is a `warn`, never a block.
 */
export async function checkUnitPid(sh, info, { restartNeeded = true, unit = runnerUnitName(info) } = {}) {
  let out;
  try {
    out = await sh(`${SYSTEMD_ENV}; systemctl --user show ${unit} -p LoadState -p MainPID -p ActiveState`, { timeoutMs: 15_000 });
  } catch (e) {
    return { level: 'warn', message: `could not read the ${unit} unit (${e.message})` };
  }
  if (!out?.ok) return { level: 'warn', message: `could not read the ${unit} unit (${lastLines(out?.stderr) || `code ${out?.code}`})` };
  const props = {};
  for (const line of String(out.stdout).split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) props[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  if (props.LoadState === 'not-found') {
    // Nothing to compare, but a restart that is coming would hit a unit that
    // does not exist: say so now, not after the code was already pulled.
    if (!restartNeeded) return { level: 'ok', message: null };
    const pid = Number.isInteger(info?.pid) ? info.pid : '?';
    const hint = reportedRunnerUnit(info)
      ? ''
      : '; the runner did not report its unit, so it may be an older version: restart it once by hand (systemctl --user restart <its unit>, or kill it and start it again) and upgrade again';
    return {
      level: 'fail',
      message: `the runner process (pid ${pid}) is not managed by a systemd user unit named ${unit}: the board cannot restart it; start it under a user unit or restart it by hand${hint}`,
    };
  }
  if (!props.ActiveState || !/^\d+$/.test(props.MainPID ?? '')) {
    return { level: 'warn', message: `the ${unit} unit answered something unexpected` };
  }
  const mainPid = Number(props.MainPID);
  const servedPid = Number.isInteger(info?.pid) ? info.pid : null;
  const active = props.ActiveState === 'active';
  if (active && (servedPid === null || mainPid === servedPid)) return { level: 'ok', message: null };
  const fix = `to fix it, the owner runs on the runner: kill ${servedPid ?? '<pid>'} (the process serving the port), then systemctl --user restart ${unit}`;
  const message = active
    ? `the ${unit} unit runs pid ${mainPid}, but the process answering /info is pid ${servedPid}: restarting the unit will not replace it; ${fix}`
    : `the ${unit} unit is ${props.ActiveState} (MainPID ${mainPid}) while pid ${servedPid ?? '?'} answers /info: restarting the unit will not replace it; ${fix}`;
  return { level: restartNeeded ? 'fail' : 'warn', message };
}

/**
 * A watch on the box that a connection blip must not end.
 *
 * `RUNNER_OFFLINE` means the request never reached the runner: that is not an
 * answer, so the caller asks again while it still has time. Every other error
 * *is* an answer — a route that replied 500, a body that would not parse — and
 * is thrown on as it always was, because swallowing those turns a broken box
 * into a silent wait. Blips are counted, and the first of each streak and the
 * recovery go to the job's log, so the dialog shows the box went away and came
 * back instead of a stretch of nothing (job u-mufyrg56: a `/fs/read` that came
 * back `UND_ERR_CONNECT_TIMEOUT` 22 s after the launch threw away 16 min of
 * waiting and failed an install that had already exited 0).
 */
function offlineTolerance(j, m) {
  const state = { blips: 0, streak: 0, last: null };
  return {
    state,
    /** `{ value }` from `fn`, or null for «the box was not there, ask again». */
    async attempt(fn) {
      try {
        const value = await fn();
        if (state.streak) {
          logLine(j, `${m.name}: vuelve a responder tras ${state.streak} intento(s) sin conexión`);
          state.streak = 0;
        }
        return { value };
      } catch (e) {
        if (!isRunnerOffline(e)) throw e;
        state.blips += 1;
        state.streak += 1;
        state.last = e.message;
        if (state.streak === 1) logLine(j, `${m.name}: no responde (${e.message}); se sigue esperando`);
        return null;
      }
    },
  };
}

/**
 * Waits for `claude install` to leave its exit code in `done` on the box,
 * copies the tail of what it printed into the job's log, and returns the
 * runner's `/info` afterwards.
 *
 * The only thing that fails this wait is the deadline running out. While it
 * has time, a box that cannot be reached is asked again — the `.done` does not
 * disappear because one request did not arrive — and the reason the deadline
 * ran out is in the message, since «no terminó en 16 min» and «the box was not
 * there» ask for different fixes. A bad exit code, or a box that answers with
 * an error instead of not answering, still fails at once.
 *
 * Exported for the tests: exercising this wait needs no POSIX shell, and the
 * step around it does.
 */
export async function awaitCliInstall(j, m, { cli, done, log }) {
  const { donePollMs, doneTimeoutMs, restartPollMs, restartTimeoutMs } = upgradeHooks.timing;
  const deadline = Date.now() + doneTimeoutMs;
  const watch = offlineTolerance(j, m);
  let code = null;
  while (Date.now() < deadline) {
    await sleep(donePollMs);
    const found = await watch.attempt(() => m.fs.exists(done));
    if (!found || !found.value) continue;
    // The file is on the box now. A blip on this read leaves the loop alone:
    // the `.done` is not going anywhere, so the next round reads it again
    // rather than letting a missing answer pass for an exit code. Empty is not
    // an answer either: `> done` truncates the file before `echo $?` fills it,
    // and that instant would otherwise fail the step with «salió con ».
    const read = await watch.attempt(() => m.fs.readFile(done));
    if (!read || !String(read.value).trim()) continue;
    code = String(read.value).trim();
    break;
  }
  const output = await m.fs.readFile(log).catch((e) => {
    // The only call here whose failure is swallowed: what the install printed
    // is context, not the verdict. Swallowed, but not silent — `salió con 3:`
    // with nothing after it is unreadable without this line.
    logLine(j, `${m.name}: no se pudo leer ${log}: ${e.message}`);
    return '';
  });
  for (const line of String(output).split(/\r?\n/).filter(Boolean).slice(-10)) logLine(j, `${m.name}: ${line}`);
  if (code === null) {
    const waited = `claude install ${cli} no terminó en ${Math.round(doneTimeoutMs / 60_000)} min`;
    throw new Error(watch.state.blips
      ? `${waited}: ${m.name} was unreachable (${watch.state.blips} connection drop(s), the last one: ${watch.state.last})`
      : waited);
  }
  if (code !== '0') throw new Error(`claude install exited with ${code}: ${lastLines(output)}`);
  // The install replaces the `claude` binary; it does not restart the runner.
  // So this is not `waitForRunner`, which ignores every error because a box
  // mid-restart answers nonsense: here a box that accepts the connection and
  // then says 500, or does not answer within `infoTimeoutMs`, is broken and
  // says so at once. Only a connection that never lands is retried, and only
  // for a restart's worth — a box still away a minute after a finished install
  // has earned its failure.
  const infoDeadline = Date.now() + restartTimeoutMs;
  for (;;) {
    const got = await watch.attempt(() => runnerInfo(m));
    if (got) return got.value;
    if (Date.now() >= infoDeadline) break;
    await sleep(restartPollMs);
  }
  throw new Error(`${m.name} did not answer /info after installing claude ${cli}: it was unreachable for ${Math.round(restartTimeoutMs / 1000)} s (${watch.state.last})`);
}

async function upgradeRunner(j, m) {
  if (!JOB_ID_RE.test(j.id)) throw Object.assign(new Error(`invalid update id: ${j.id}`), { step: 'runner_check' });
  const rec = j.runners[m.name] ?? (j.runners[m.name] = { commitBefore: null, commitAfter: null, cliBefore: null, cliAfter: null });
  const sh = runnerShell(j, m);
  const ctx = {};

  await withStep(j, 'runner_check', m.name, async (step) => {
    const info = await runnerInfo(m);
    ctx.info = info;
    ctx.unit = runnerUnitName(info);
    rec.cliBefore = info.claude ?? null;
    const dir = await locateMonitorDir(m, info, sh);
    if (!dir) throw new Error('the runner folder was not found');
    ctx.dir = dir;
    ctx.bus = (await sh(systemdRun(`hfsmon-upgrade-${j.id}-check`, 'true'), { timeoutMs: 30_000 })).ok;
    const linger = await sh('loginctl show-user "$(id -un)" -p Linger --value', { timeoutMs: 15_000 });
    const lingerOff = linger.ok && linger.stdout.trim() === 'no';

    const dirty = await sh('git status --porcelain --untracked-files=no', { cwd: dir });
    if (!dirty.ok) throw new Error(`git status failed: ${lastLines(dirty.stderr)}`);
    if (dirty.stdout.trim()) throw new Error(`there are uncommitted changes in ${dir}: ${lastLines(dirty.stdout)}`);
    const fetched = await sh('timeout 60 git fetch --quiet origin main', { cwd: dir, timeoutMs: 90_000 });
    if (!fetched.ok) throw new Error(`git fetch failed: ${lastLines(fetched.stderr) || `code ${fetched.code}`}`);
    const head = (await sh('git rev-parse HEAD', { cwd: dir })).stdout.trim();
    const target = (await sh('git rev-parse origin/main', { cwd: dir })).stdout.trim();
    if (!SHA_RE.test(head) || !SHA_RE.test(target)) throw new Error('could not read HEAD or origin/main');
    ctx.head = head;
    ctx.target = target;
    rec.commitBefore = head;
    if (!(await sh('git merge-base --is-ancestor HEAD origin/main', { cwd: dir })).ok) {
      throw new Error(`HEAD ${short(head)} has diverged from origin/main ${short(target)}: not pulling`);
    }
    const diff = await sh(`git diff --name-only HEAD origin/main -- ${RUNNER_PATHS.map(shq).join(' ')}`, { cwd: dir });
    if (!diff.ok) throw new Error(`git diff failed: ${lastLines(diff.stderr)}`);
    ctx.codeBehind = head !== target && diff.stdout.trim() !== '';
    // Null is unknown, never "differs": only a known running commit that is
    // not the one on disk asks for a restart by itself.
    const running = typeof info.commit === 'string' && SHA_RE.test(info.commit) ? info.commit : null;
    ctx.staleProcess = Boolean(running && running !== head);
    if ((ctx.codeBehind || ctx.staleProcess) && !ctx.bus) {
      throw new Error('without a systemd user bus the runner cannot be restarted');
    }
    let unitWarn = null;
    if (ctx.bus) {
      const unit = await checkUnitPid(sh, info, { restartNeeded: ctx.codeBehind || ctx.staleProcess, unit: ctx.unit });
      if (unit.level === 'fail') throw new Error(unit.message);
      if (unit.level === 'warn') unitWarn = unit.message;
    }
    const summary = `${m.name}: ${dir} · ${short(head)} · origin/main ${short(target)} · ${ctx.codeBehind ? 'código atrasado' : 'código al día'}`;
    const warns = [lingerOff && 'linger desactivado: el runner no sobrevive a un logout', unitWarn].filter(Boolean);
    if (warns.length) stepEnd(j, step, 'warn', `${summary} · ${warns.join(' · ')}`);
    else stepEnd(j, step, 'ok', summary);
  });

  await withStep(j, 'runner_cli', m.name, async (step) => {
    const cli = j.target?.cli;
    if (!isStrictVersion(cli)) throw new Error(`invalid CLI version: ${cli}`);
    if (versionAtLeast(ctx.info.claude, cli) && !j.force) {
      rec.cliAfter = ctx.info.claude;
      stepEnd(j, step, 'skipped', `${m.name} ya tiene claude ${ctx.info.claude}`);
      return;
    }
    const home = ctx.info.home;
    if (typeof home !== 'string' || !home) throw new Error('the runner does not report its home');
    const dir = `${home}/.hfs-monitor/upgrade`;
    const log = `${dir}/${j.id}-cli.log`;
    const done = `${dir}/${j.id}-cli.done`;
    const inner = `timeout 900 claude install ${cli} > ${shq(log)} 2>&1; echo $? > ${shq(done)}`;
    // Without a bus the install is backgrounded on its own, every stream
    // redirected: a background job holding this command's stdout would keep
    // the request open until the install ends.
    const launch = ctx.bus
      ? systemdRun(`hfsmon-upgrade-${j.id}-cli`, `sh -c ${shq(inner)}`)
      : `nohup sh -c ${shq(inner)} </dev/null >/dev/null 2>&1 &`;
    const started = await sh(`mkdir -p ${shq(dir)} && rm -f ${shq(done)} || exit 1; ${launch}`, { timeoutMs: 30_000 });
    if (!started.ok) throw new Error(`could not launch claude install: ${lastLines(started.stderr) || `code ${started.code}`}`);
    logLine(j, `${m.name}: claude install ${cli} lanzado (${ctx.bus ? 'systemd-run' : 'nohup'})`);

    const after = await awaitCliInstall(j, m, { cli, done, log });
    rec.cliAfter = after.claude ?? null;
    if (after.claude !== cli) throw new Error(`stayed on claude ${after.claude ?? '(none)'}, not ${cli}`);
    stepEnd(j, step, 'ok', `${m.name}: claude ${ctx.info.claude ?? '?'} → ${cli}`);
  });

  let lockChanged = false;
  let restarted = false;
  try {
    await withStep(j, 'runner_code', m.name, async (step) => {
      if (!ctx.codeBehind) {
        stepEnd(j, step, 'skipped', `${m.name}: el código del runner está al día`);
        return;
      }
      ctx.touched = true;
      const pulled = await sh('timeout 120 git pull --ff-only --quiet origin main', { cwd: ctx.dir, timeoutMs: 150_000 });
      if (!pulled.ok) throw new Error(`git pull --ff-only failed: ${lastLines(pulled.stderr) || `code ${pulled.code}`}`);
      const head = (await sh('git rev-parse HEAD', { cwd: ctx.dir })).stdout.trim();
      if (!SHA_RE.test(head)) throw new Error('could not read HEAD after the pull');
      ctx.newHead = head;
      const lock = await sh(`git diff --name-only ${ctx.head} HEAD -- server/package-lock.json`, { cwd: ctx.dir });
      lockChanged = lock.ok && lock.stdout.trim() !== '';
      if (lockChanged) {
        const ci = await sh('npm ci --omit=dev', { cwd: m.path.join(ctx.dir, 'server'), timeoutMs: 900_000 });
        if (!ci.ok) throw new Error(`npm ci failed: ${lastLines(ci.stderr) || `code ${ci.code}`}`);
      }
      stepEnd(j, step, 'ok', `${m.name}: ${short(ctx.head)} → ${short(head)}${lockChanged ? ' · npm ci' : ''}`);
    });

    await withStep(j, 'runner_restart', m.name, async (step) => {
      const expected = ctx.newHead ?? ctx.head;
      if (!ctx.codeBehind && !ctx.staleProcess) {
        rec.commitAfter = expected;
        stepEnd(j, step, 'skipped', `${m.name}: no hace falta reiniciar`);
        return;
      }
      ctx.touched = true;
      restarted = true;
      const pidBefore = (await runnerInfo(m).catch(() => ctx.info))?.pid;
      const r = await sh(systemdRun(`hfsmon-upgrade-${j.id}-restart`, `--on-active=2s systemctl --user restart ${ctx.unit}`), { timeoutMs: 30_000 });
      if (!r.ok) throw new Error(`could not schedule the restart: ${lastLines(r.stderr) || `code ${r.code}`}`);
      const { restartTimeoutMs } = upgradeHooks.timing;
      const seen = {};
      const back = await waitForRunner(m, restartedOn(expected, pidBefore), restartTimeoutMs, seen);
      if (!back) {
        const detail = describeLastSeen(seen, { sha: expected, pidBefore, unit: ctx.unit });
        logLine(j, `${m.name}: ${detail}`);
        throw new Error(`the runner did not come back with ${short(expected)} in ${Math.round(restartTimeoutMs / 1000)} s; ${detail}`);
      }
      if (back.commit === undefined) {
        // A runner that does not report its commit: the pid changed, and the
        // disk is asked directly.
        const disk = (await sh('git rev-parse HEAD', { cwd: ctx.dir })).stdout.trim();
        if (disk !== expected) throw new Error(`the runner restarted, but its disk is at ${short(disk)}, not ${short(expected)}`);
      }
      rec.commitAfter = expected;
      stepEnd(j, step, 'ok', `${m.name}: corre ${short(expected)}`);
    });
  } catch (e) {
    if (ctx.touched) {
      const problem = await rollbackRunner(j, m, sh, ctx, { lockChanged, restarted });
      if (problem) e.message = `${e.message}; la vuelta atrás falló: ${problem}`;
    }
    throw e;
  }
}

/**
 * The runner restarted and is back on `sha`. The pid must have changed
 * whenever the old one is known: a rollback after a restart that never
 * happened finds `commit === diskCommit === sha` before its own restart has
 * run, and would call the runner settled seconds before it goes down. Beyond
 * the pid, `commit` and `diskCommit` must name `sha` — or, on a runner from
 * before those fields, the pid is all there is.
 */
function restartedOn(sha, pidBefore) {
  return (info) => {
    const pidKnown = Number.isInteger(pidBefore) && Number.isInteger(info.pid);
    if (pidKnown && info.pid === pidBefore) return false;
    if (info.commit === undefined) return pidKnown;
    return info.commit === sha && info.diskCommit === sha;
  };
}

/** Puts the runner back on the commit it had. Returns what went wrong, or null. */
async function rollbackRunner(j, m, sh, ctx, { lockChanged, restarted }) {
  const rec = j.runners[m.name];
  const prev = ctx.head;
  const user = String(ctx.info?.home ?? '').split('/').filter(Boolean).pop() || '';
  const byHand = `arréglalo por ssh: ssh ${user ? `${user}@` : ''}${m.host}; cd ${ctx.dir}; git reset --keep ${prev}; systemctl --user restart ${ctx.unit}`;
  // The runner itself may be what is broken: new code that does not boot
  // leaves nothing to send the rollback through.
  const reach = async (script, opts) => {
    try {
      return await sh(script, opts);
    } catch (e) {
      throw new Error(`${m.name} is not responding (${e.message}): the runner's new code probably does not start; ${byHand}`);
    }
  };
  try {
    await withStep(j, 'runner_rollback', m.name, async (step) => {
      if (!SHA_RE.test(prev)) throw new Error('it is not known which commit to go back to');
      const problems = [];
      const reset = await reach(`git reset --keep ${prev}`, { cwd: ctx.dir });
      if (!reset.ok) problems.push(`git reset --keep falló: ${lastLines(reset.stderr)}`);
      if (lockChanged) {
        const ci = await reach('npm ci --omit=dev', { cwd: m.path.join(ctx.dir, 'server'), timeoutMs: 900_000 });
        if (!ci.ok) problems.push(`npm ci falló: ${lastLines(ci.stderr)}`);
      }
      if (restarted) {
        const pidBefore = (await runnerInfo(m).catch(() => ctx.info))?.pid;
        const r = await reach(systemdRun(`hfsmon-upgrade-${j.id}-rollback`, `--on-active=2s systemctl --user restart ${ctx.unit}`), { timeoutMs: 30_000 });
        if (!r.ok) {
          problems.push(`no se pudo programar el reinicio; ${byHand}`);
        } else {
          const seen = {};
          const back = await waitForRunner(m, restartedOn(prev, pidBefore), upgradeHooks.timing.restartTimeoutMs, seen);
          if (!back) {
            const detail = describeLastSeen(seen, { sha: prev, pidBefore, unit: ctx.unit }, 'es');
            logLine(j, `${m.name}: ${detail}`);
            problems.push(`el runner no volvió con ${short(prev)}; ${detail}; ${byHand}`);
          }
        }
      }
      const disk = await reach('git rev-parse HEAD', { cwd: ctx.dir }).catch(() => ({ ok: false }));
      rec.commitAfter = disk.ok ? disk.stdout.trim() : null;
      if (problems.length) throw new Error(problems.join('; '));
      stepEnd(j, step, 'ok', `${m.name}: de vuelta en ${short(prev)}`);
    });
    return null;
  } catch (e) {
    return e.message;
  }
}

// ---------------------------------------------------------------------------
// The handover to upgrade.ps1.

/** The environment the script inherits: nothing of npm's or of a Claude session's. */
export function scriptEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^(npm_|INIT_CWD$|CLAUDECODE$|CLAUDE_CODE_|ANTHROPIC_)/i.test(key)) out[key] = value;
  }
  return out;
}

/**
 * The PowerShell that starts `upgrade.ps1` hidden and writes its PID to
 * `pidFile`. Every interpolated value is validated first.
 */
export function upgradeScriptCommand({ root, boardPid, jobId, pidFile }) {
  if (!Number.isInteger(boardPid) || boardPid <= 0) throw new Error(`invalid boardPid: ${boardPid}`);
  if (!JOB_ID_RE.test(String(jobId))) throw new Error(`invalid update id: ${jobId}`);
  const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const script = path.win32.join(root, 'upgrade.ps1');
  if (script.includes('"')) throw new Error(`invalid path: ${script}`);
  // Start-Process joins -ArgumentList with spaces: a root with spaces needs
  // its own double quotes around the path.
  return `$p = Start-Process powershell -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${quote(`"${script}"`)},'-BoardPid',${boardPid},'-JobId',${quote(jobId)}; `
    + `[IO.File]::WriteAllText(${quote(pidFile)}, [string]$p.Id)`;
}

/**
 * Spawns the intermediate PowerShell without a console and resolves with the
 * PID of the script it started.
 *
 * Not detached: on this Windows a detached PowerShell exits 0 in about 100 ms
 * without running its command at all — no PID file, no script (measured
 * 2026-09-15, job u-mu2mycey). Detaching is not needed either: the
 * `Start-Process` grandchild already leaves Node's job object, and it was
 * measured alive after the board exited.
 */
export function spawnUpgradeScript({ root, boardPid, jobId }) {
  const pidFile = path.join(DATA_DIR, 'upgrade', `${jobId}.pid`);
  mkdirSync(path.dirname(pidFile), { recursive: true });
  rmSync(pidFile, { force: true });
  const command = upgradeScriptCommand({ root, boardPid, jobId, pidFile });
  return new Promise((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
      detached: false, windowsHide: true, stdio: 'ignore', env: scriptEnv(),
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
      reject(new Error('PowerShell did not launch upgrade.ps1 in 30 s'));
    }, 30_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      let pid = NaN;
      try { pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10); } catch { /* no file: no script */ }
      if (Number.isInteger(pid) && pid > 0) resolve(pid);
      else reject(new Error(`could not launch upgrade.ps1 (PowerShell exited with ${code})`));
    });
  });
}

async function handover(j) {
  const step = stepStart(j, 'laptop_launch', 'portátil');
  for (const task of store.all()) {
    try { await closeTaskSessions(task); } catch { /* a session that will not close dies with the board */ }
  }
  for (const holder of allHolders()) {
    try { await closeTaskSessions(holder); } catch { /* same: it dies with the board */ }
  }
  // Recorded before the spawn: the script reads the job, and a new board that
  // finds `laptop` knows whose lock and PID to look for.
  j.state = 'laptop';
  j.boardPid = process.pid;
  save();
  store.flush();

  let pid;
  try {
    pid = await upgradeHooks.spawnScript({ root: upgradeHooks.root, boardPid: process.pid, jobId: j.id });
  } catch (e) {
    // The board stays up: the job fails here and nothing was handed over.
    j.scriptPid = null;
    stepEnd(j, step, 'failed', e.message);
    throw Object.assign(e, { step: 'laptop_launch' });
  }
  j.scriptPid = pid;
  step.state = 'ok';
  step.endedAt = iso();
  endBoardSpan(stepSpans.get(step), { outcome: 'ok' });
  // The job span stays open on purpose: the script owns the job from here, and
  // the board that comes up after it closes the span in `watchLaptop`.
  step.detail = `upgrade.ps1 en marcha (pid ${pid}); el tablero se cierra`;
  logLine(j, `laptop_launch → ok: ${step.detail}`);
  // The last write of this process: from here the file is the script's.
  save();
  frozen = true;
  store.flush();
  setTimeout(() => upgradeHooks.exit(0), upgradeHooks.timing.exitDelayMs);
}

// ---------------------------------------------------------------------------
// The other buttons.

/** «Cancelar»: only a job still waiting. */
export function cancelUpgrade() {
  const j = currentJob();
  if (j?.state !== 'waiting') throw httpError(409, 'Only a waiting update can be cancelled', { job: j });
  logLine(j, 'cancelada');
  disarmWaiting();
  job = null;
  writeJobFile(null);
  emitState();
  releaseGates();
  return null;
}

/** «Actualizar ya»: a waiting job starts now, cutting what `idle.reasons` lists. */
export async function upgradeNow() {
  const j = currentJob();
  if (j?.state !== 'waiting') throw httpError(409, 'There is no update waiting', { job: j });
  if (upgradeHooks.loginRunning()) throw httpError(409, LOGIN_RUNNING_MESSAGE, { job: j });
  return startRunning({ now: true });
}

/** The result was seen: a done or failed job is marked acknowledged. */
export function acknowledgeUpgrade(id) {
  const j = currentJob();
  if (!j || j.id !== id) throw httpError(404, 'That update does not exist');
  if (!TERMINAL.includes(j.state)) throw httpError(409, 'The update has not finished', { job: j });
  j.acknowledged = true;
  save();
  settings.update({ upgrade: { acknowledgedJob: id } });
  return j;
}

// ---------------------------------------------------------------------------
// Boot.

let laptopTimer = null;
let bootRetries = 0;

/**
 * What a board starting up does with the job it finds: a waiting one keeps
 * waiting; one cut in the runner steps failed there; one handed to the laptop
 * is watched until the script writes its result or is gone without one.
 */
export async function resumeOnBoot() {
  frozen = false;
  if (laptopTimer) clearInterval(laptopTimer);
  laptopTimer = null;
  const read = readJobFile();
  if (read.error) {
    // Written whole by a rename on both sides, so this should not happen; a
    // bad read is retried, never taken as a failure.
    if (bootRetries++ < 5) setTimeout(() => detached('retomar la actualización', resumeOnBoot), upgradeHooks.timing.laptopWatchMs).unref?.();
    return null;
  }
  bootRetries = 0;
  job = read.job;
  jobLoaded = true;
  if (!job) return null;

  if (job.state === 'waiting') {
    armWaiting();
  } else if (job.state === 'running') {
    const at = job.step ?? 'runner_check';
    const cut = [...(job.steps ?? [])].reverse().find((s) => s.state === 'running');
    if (cut) {
      cut.state = 'failed';
      cut.endedAt = iso();
      closeOpenBoardSpans(undefined, { name: `upgrade:${cut.name}`, outcome: 'interrupted' });
    }
    const found = [];
    await Promise.all(Object.keys(job.runners ?? {}).map(async (name) => {
      const m = machines()[name];
      if (!m) return;
      try {
        const info = await runnerInfo(m);
        job.runners[name].commitAfter = info.diskCommit ?? null;
        job.runners[name].cliAfter = info.claude ?? null;
        found.push(`${name}: disco ${short(info.diskCommit)}, claude ${info.claude ?? '?'}`);
      } catch (e) {
        found.push(`${name}: no responde (${e.message})`);
      }
    }));
    job.state = 'failed';
    job.failedStep = at;
    job.error = `El tablero se reinició durante los pasos del runner${found.length ? ` (${found.join('; ')})` : ''}`;
    job.endedAt = iso();
    logLine(job, `falló en ${at}: ${job.error}`);
    endJobSpan(job.id, 'interrupted', { failedStep: at });
    save();
    releaseGates();
  } else if (job.state === 'laptop') {
    watchLaptop();
  } else if (TERMINAL.includes(job.state)) {
    // The script (or an earlier board) already wrote the result: a span left
    // open by the handover ends at the job's real end, not at this boot.
    closeFinishedJobSpans(job);
  }
  emitState();
  return job;
}

/** The lock counts only while the PID written in it is alive. */
function liveLock() {
  try {
    const { pid } = JSON.parse(readFileSync(lockFile(), 'utf8').replace(LEADING_BOM, ''));
    return upgradeHooks.isAlive(Number(pid));
  } catch {
    return false;
  }
}

/**
 * While the script works: re-read the file every 2 s.
 *
 * PowerShell 5.1's `Move-Item -Force` deletes the old file before moving the
 * new one in, so a look may find no file or half of one: that is retried,
 * never read as "no job". The watch lets go of `laptop` only for a parsed job
 * with another id or another state.
 *
 * It is `failed` when nothing is working on it any more: no lock whose PID is
 * alive, and no live `scriptPid` — or one alive past a grace period with no
 * lock, since after a reboot that PID may be anyone's. Before writing, the
 * file is read once more, and only a `laptop` job with the same id is
 * overwritten: the script may have written its result in between.
 */
function watchLaptop() {
  const id = job.id;
  let orphanSince = null;
  let unreadable = 0;
  const stop = () => {
    if (laptopTimer) clearInterval(laptopTimer);
    laptopTimer = null;
  };
  const adopt = (onDisk) => {
    stop();
    job = onDisk;
    if (onDisk.id === id && TERMINAL.includes(onDisk.state)) closeFinishedJobSpans(onDisk);
    else endJobSpan(id, 'interrupted');
    emitState();
    releaseGates();
  };
  const look = () => {
    const read = readJobFile();
    const onDisk = read.error ? null : read.job;
    if (onDisk && (onDisk.id !== id || onDisk.state !== 'laptop')) return adopt(onDisk);
    if (onDisk) {
      job = onDisk;
      unreadable = 0;
    } else {
      unreadable += 1;
    }

    const { staleGraceMs, missingLooks } = upgradeHooks.timing;
    if (liveLock()) {
      orphanSince = null;
      return undefined;
    }
    if (upgradeHooks.isAlive(job.scriptPid)) {
      orphanSince ??= Date.now();
      if (Date.now() - orphanSince < staleGraceMs) return undefined;
    }
    // Nothing is working on it. With no readable file, give the script's
    // last rename a few more looks before deciding it left nothing.
    if (!onDisk && unreadable < missingLooks) return undefined;

    const again = readJobFile();
    if (again.error) return undefined;
    if (again.job && (again.job.id !== id || again.job.state !== 'laptop')) return adopt(again.job);
    if (!again.job && unreadable < missingLooks) return undefined;
    stop();
    job = again.job ?? job;
    job.state = 'failed';
    job.failedStep = job.step ?? 'laptop_launch';
    job.error = 'El script de actualización terminó sin dejar resultado';
    job.endedAt = iso();
    logLine(job, `falló en ${job.failedStep}: ${job.error}`);
    endJobSpan(job.id, 'failed', { failedStep: job.failedStep });
    save();
    releaseGates();
    return undefined;
  };
  look();
  if (job?.state === 'laptop' && job.id === id) {
    laptopTimer = setInterval(look, upgradeHooks.timing.laptopWatchMs);
    laptopTimer.unref?.();
  }
}

// ---------------------------------------------------------------------------
// HTTP.

const sendError = (res, e) => res.status(e.status ?? 500).json({
  error: e.message,
  ...(e.job !== undefined ? { job: e.job } : {}),
  ...(e.blockers ? { blockers: e.blockers } : {}),
});

/** `GET/POST /api/upgrade`, `/now`, `/cancel`, `/ack`. Mounted after the JSON body parser. */
export function upgradeRouter() {
  const router = express.Router();
  router.get('/api/upgrade', async (req, res) => {
    try {
      res.json(await upgradeState({ fresh: req.query.fresh === '1' }));
    } catch (e) {
      sendError(res, e);
    }
  });
  router.post('/api/upgrade', async (req, res) => {
    try {
      // `force` is believed only from a request made on this very machine.
      res.status(202).json({ job: await requestUpgrade(req.body ?? {}, { loopback: isDirectLoopback(req) }) });
    } catch (e) {
      sendError(res, e);
    }
  });
  router.post('/api/upgrade/now', async (_req, res) => {
    try {
      res.status(202).json({ job: await upgradeNow() });
    } catch (e) {
      sendError(res, e);
    }
  });
  router.post('/api/upgrade/cancel', (_req, res) => {
    try {
      res.json({ job: cancelUpgrade() });
    } catch (e) {
      sendError(res, e);
    }
  });
  router.post('/api/upgrade/ack', (req, res) => {
    try {
      res.json({ job: acknowledgeUpgrade(String(req.body?.id ?? '')) });
    } catch (e) {
      sendError(res, e);
    }
  });
  return router;
}

// Still allowed while the upgrade runs: the upgrade's own buttons, the
// settings (snooze, skip), the chat tab strip, and every Stop — «Actualizar
// ya» can leave a turn, a command, a plan or a stack running into the runner
// phase, and stopping them must stay possible.
// A task's routes moved under the project that owns it
// (`/api/projects/:project/tasks/:issue/…`, `keys.js`). Without the prefix here
// every Stop button would answer 409 during an upgrade — precisely when a turn,
// a command, a plan or a stack is most likely to be left running by «Actualizar
// ya». The prefix is optional so a board still serving the old bundle, or a
// browser tab left open across the update, keeps its Stop buttons too.
// The same goes for every Stop of a project chat (`index.js` `HB`): its turn,
// its commands and its plan can also be left running. Its routes never existed
// without the project prefix, so HOLDER has no optional part.
const TASK = '(projects/[^/]+/)?tasks/\\d+';
const HOLDER = 'projects/[^/]+/project-chats/[^/]+';
const GUARD_EXEMPT = new RegExp(`^/api/(${[
  'upgrade(/(now|cancel|ack))?',
  'settings',
  // Reads the account's usage; the probe itself is paused during an upgrade.
  'usage/refresh',
  'chat-tabs/(open|close)',
  `${TASK}/chat/stop`,
  `${TASK}/chats/[^/]+/(plan|background/[^/]+)/stop`,
  `${TASK}/stack/stop`,
  `${HOLDER}/chat/stop`,
  `${HOLDER}/chats/[^/]+/(plan|background/[^/]+)/stop`,
].join('|')})/?$`);

/**
 * 409 on every other state-changing call while the upgrade runs. Express
 * routes ignore case, so the path is compared lowercased, and a method that
 * can change something is refused whatever its prefix.
 */
export function upgradeGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !upgradeRunning()) return next();
  const p = String(req.path ?? '').toLowerCase().replace(/\/{2,}/g, '/');
  if (GUARD_EXEMPT.test(p)) return next();
  return res.status(409).json({ error: 'The board is updating', code: 'upgrading', job: currentJob() });
}
