import { authHeaders, withToken } from './token.js';
import { viewMessage, shouldSend } from './viewReport.js';

// The view this browser last wanted the server to know, and the last one that
// went out on the current socket (reset on every reconnect, so it is resent).
let wantedView = null;
let sentView = null;
let liveSocket = null;

function flushView() {
  if (!wantedView || liveSocket?.readyState !== WebSocket.OPEN) return;
  if (!shouldSend(sentView, wantedView)) return;
  sentView = wantedView;
  liveSocket.send(JSON.stringify(wantedView));
}

/**
 * Tell the server which project is on screen and whether the tab is visible.
 * Sends at once when the socket is open; `open` sends it again after a reconnect.
 */
export function reportView(project, visible = typeof document === 'undefined' || document.visibilityState === 'visible') {
  wantedView = viewMessage(project, visible);
  flushView();
}

export function connectWs(handlers) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let socket;
  let alive = true;

  const open = () => {
    socket = new WebSocket(withToken(`${proto}://${location.host}/ws`));
    liveSocket = socket;
    sentView = null;
    socket.onopen = () => { handlers.onStatus?.(true); flushView(); };
    socket.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      handlers[msg.type]?.(msg);
    };
    socket.onclose = () => {
      handlers.onStatus?.(false);
      if (alive) setTimeout(open, 2000);
    };
  };
  open();

  return {
    // `project` and `issue` travel as two fields, never as a composite key:
    // the server composes the key itself (`keys.js`, WebSocket section).
    // `owner` is a task, or a project-chat holder summary: a holder has no
    // issue, it travels as `owner: 'project'` plus its machine.
    sendChat(owner, chatId, text, attachments = [], { voice = false } = {}) {
      if (socket?.readyState !== WebSocket.OPEN) return;
      const msg = owner.kind === 'project'
        ? { type: 'chat', project: owner.project, owner: 'project', machine: owner.machine, chatId, text, attachments }
        : { type: 'chat', project: owner.project, issue: owner.issue, chatId, text, attachments };
      // Voice mode is this browser's choice: the board only adds the rule to a message that says so.
      if (voice) msg.voice = true;
      socket.send(JSON.stringify(msg));
    },
    close() {
      alive = false;
      socket?.close();
    },
  };
}

/** Client-side ceilings, so a hung request can never keep a spinner on forever. */
export const POLL_TIMEOUT_MS = 15 * 1000; // the server answers 202 at once; the cycle runs on in the background
export const GIT_TIMEOUT_MS = 2 * 60 * 1000;

async function send(url, body, method = 'POST', timeoutMs = 0) {
  const ctl = timeoutMs ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(url, {
      method,
      signal: ctl?.signal,
      headers: { ...authHeaders(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e?.name === 'AbortError') { const te = new Error('timeout'); te.timeout = true; throw te; }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // The payload travels with the error: a refusal can carry what the caller
    // needs to ask a follow-up question, like which files are uncommitted.
    const e = new Error(data.error ?? res.statusText);
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return data;
}

/**
 * A GET that fails the way `send` fails: an `Error` carrying `.status` and
 * `.data`, so the caller can tell a refusal (403 from a phone) from a real
 * breakage without parsing the message.
 */
async function get(url) {
  const res = await fetch(url, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error ?? res.statusText);
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return data;
}

/**
 * A task's URL prefix. The composite key `<project>#<issue>` never travels in
 * a URL — `#` starts the fragment — so the two halves are separate segments.
 */
const T = (project, issue) => `/api/projects/${encodeURIComponent(project)}/tasks/${issue}`;

/**
 * The URL prefix of a chat's owner: a task, or a project-chat holder summary
 * (`kind: 'project'`, no issue). Every chat call below takes the owner.
 */
const B = (owner) => (owner.kind === 'project'
  ? `/api/projects/${encodeURIComponent(owner.project)}/project-chats/${encodeURIComponent(owner.machine)}`
  : T(owner.project, owner.issue));

const LG = (machine) => `/api/machines/${encodeURIComponent(machine)}`;

// GET without a body, POST with one; the ticket (when there is one) goes in a header.
async function loginCall(url, ticket, body) {
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...authHeaders(),
      ...(ticket ? { 'x-login-ticket': ticket } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? res.statusText), { status: res.status, data });
  return data;
}

export const api = {
  tasks: () => fetch('/api/tasks', { headers: authHeaders() }).then((r) => r.json()),
  // The registry behind the project selector. The snapshot already carries it;
  // this is for a refresh after an import.
  projects: () => fetch('/api/projects', { headers: authHeaders() }).then((r) => r.json()),
  // Importing a project: the checkout path is the only thing the board cannot
  // deduce. Anything else sent is an answer to something it could not deduce.
  createProject: (body) => send('/api/projects', body),
  // Restricted: the project stays registered but is hidden from the picker's
  // default list. Removing it only unregisters; its data stays on disk.
  setProjectRestricted: (id, restricted) => send(`/api/projects/${encodeURIComponent(id)}/restricted`, { restricted: !!restricted }),
  removeProject: (id) => send(`/api/projects/${encodeURIComponent(id)}`, undefined, 'DELETE'),
  // The GitHub accounts `gh` has a session for, and the one a project works
  // as (`null`: the active account). The answer may carry `warnings`.
  ghAccounts: (repoPath = null) => get(`/api/gh-accounts${repoPath ? `?repoPath=${encodeURIComponent(repoPath)}` : ''}`),
  setProjectGhAccount: (id, ghUser, assignee) => send(`/api/projects/${encodeURIComponent(id)}/gh-account`, {
    ghUser, ...(assignee ? { assignee } : {}),
  }),
  // Walking the board machine's disk to find that checkout. Without a path it
  // answers the roots; every entry carries its own absolute path, so nobody
  // here ever joins a name to a folder. Only loopback may ask: from a phone it
  // refuses with 403, and the dialog simply does not offer the browser.
  browse: (path = null) => get(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  log: (project, issue) => fetch(`${T(project, issue)}/log`, { headers: authHeaders() }).then((r) => r.json()),
  chat: (owner, chatId) => fetch(
    `${B(owner)}/chat${chatId ? `?chatId=${encodeURIComponent(chatId)}` : ''}`,
    { headers: authHeaders() },
  ).then((r) => r.json()),
  createChat: (owner, forkFrom = null) => send(`${B(owner)}/chats`, { forkFrom }),
  closeChat: (owner, chatId) => send(`${B(owner)}/chats/${chatId}/close`),
  reopenChat: (owner, chatId) => send(`${B(owner)}/chats/${chatId}/reopen`),
  deleteChat: (owner, chatId) => send(`${B(owner)}/chats/${chatId}/delete`),
  stopChat: (owner, chatId) => send(`${B(owner)}/chat/stop`, { chatId }),
  // Model, effort and thinking are per chat. `fields` carries only the keys to
  // write (always the current `model` among them): a key left out keeps its value.
  setModel: (owner, chatId, fields) => send(`${B(owner)}/model`, { chatId, ...fields }),
  // A subagent's calls from its transcript: fill the tree, or load the earlier ones.
  backfillAgent: (owner, chatId, toolUseId) => send(`${B(owner)}/chats/${chatId}/agents/${encodeURIComponent(toolUseId)}/backfill`),
  agentCalls: (owner, chatId, toolUseId) => fetch(`${B(owner)}/chats/${chatId}/agents/${encodeURIComponent(toolUseId)}/calls`, { headers: authHeaders() })
    .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error ?? r.statusText); return d; }),
  // A background task of that chat, stopped the only way the board can: by
  // asking the session for a TaskStop.
  stopBackground: (owner, chatId, itemId) => send(`${B(owner)}/chats/${chatId}/background/${encodeURIComponent(itemId)}/stop`),
  // Renaming a conversation, for both owners: `{ id, title }`.
  renameChat: (owner, chatId, title) => send(`${B(owner)}/chats/${chatId}/rename`, { title }),
  // A project chat's holder, and «📌 Crear tarea»: the draft (English title and
  // body, written from the conversation) and the issue created from the edited one.
  holder: (project, machine) => get(`/api/projects/${encodeURIComponent(project)}/project-chats/${encodeURIComponent(machine)}`),
  draftIssue: (owner, chatId) => send(`${B(owner)}/chats/${chatId}/draft-issue`),
  createIssue: (owner, chatId, { title, body }) => send(`${B(owner)}/chats/${chatId}/create-issue`, { title, body }),
  // What a chat is waiting on: a question (answers | skip) or a plan (approve + selected | revise + feedback).
  answer: (owner, chatId, body) => send(`${B(owner)}/chats/${chatId}/answer`, body),
  setPlanMode: (owner, chatId, on) => send(`${B(owner)}/chats/${chatId}/plan-mode`, { on }),
  stopPlan: (owner, chatId) => send(`${B(owner)}/chats/${chatId}/plan/stop`),
  continuePlan: (owner, chatId) => send(`${B(owner)}/chats/${chatId}/plan/continue`),
  // What a task (a pipeline session, or the board) is waiting on.
  answerTask: (project, issue, body) => send(`${T(project, issue)}/answer`, body),
  setApprovePlan: (project, issue, mode) => send(`${T(project, issue)}/approve-plan`, { mode }),
  // «Cerrar huecos»: 'auto' | 'on' | 'off', like the plan switch.
  setFixGaps: (project, issue, mode) => send(`${T(project, issue)}/fix-gaps`, { mode }),
  setFullTests: (project, issue, mode) => send(`${T(project, issue)}/full-tests`, { mode }),
  setResolveConflicts: (project, issue, mode) => send(`${T(project, issue)}/resolve-conflicts`, { mode }),
  setDesign: (project, issue, on) => send(`${T(project, issue)}/design`, { on }),
  // Model and effort per role, for the board's «Modelos» section.
  tuning: () => get('/api/tuning'),
  timings: (project, issue) => get(`${T(project, issue)}/timings`),
  metrics: (project) => get(project ? `/api/projects/${encodeURIComponent(project)}/metrics` : '/api/metrics'),
  setTuning: (patch) => send('/api/tuning', patch),
  // Who can review a project's PRs (the reviewer dialog's search).
  reviewers: (project, q = '', exclude = null) => get(
    `/api/projects/${encodeURIComponent(project)}/reviewers?q=${encodeURIComponent(q)}${exclude ? `&exclude=${encodeURIComponent(exclude)}` : ''}`,
  ),
  // The project's reviewer setting, without touching any PR:
  // `{ reviewer?: login|null, noReviewer?: boolean }` → `{ project }`.
  setProjectReviewer: (project, body) => send(`/api/projects/${encodeURIComponent(project)}/reviewer`, body),
  decidePlan: (project, issue, body) => send(`${T(project, issue)}/plan/decide`, body),
  uploadAttachment: (owner, file) => send(`${B(owner)}/attachments`, file),
  demo: (project, issue) => fetch(`${T(project, issue)}/demo`, { headers: authHeaders() }).then((r) => r.json()),
  generateDemo: (project, issue) => send(`${T(project, issue)}/demo`),
  qa: (project, issue) => fetch(`${T(project, issue)}/qa`, { headers: authHeaders() }).then((r) => r.json()),
  runQa: (project, issue) => send(`${T(project, issue)}/qa/run`),
  setBrowserQa: (project, issue, mode) => send(`${T(project, issue)}/browser-qa`, { mode }),
  // The demo phase, per task: 'auto' | 'on' | 'off'. `auto` follows the
  // project's setting; the card's switch only ever writes 'on' or 'off'.
  setDemo: (project, issue, mode) => send(`${T(project, issue)}/demo-mode`, { mode }),
  qaEvidenceUrl: (project, issue, rel) => withToken(`${T(project, issue)}/qa/evidence/${rel.split('/').map(encodeURIComponent).join('/')}`),
  // `opts`: { force, reviewer, noReviewer, always }. A project with no reviewer
  // answers `{ needsReviewer: true, suggested, excludeLogin }` and does nothing.
  ready: (project, issue, opts = {}) => send(`${T(project, issue)}/ready`, {
    force: opts.force === true,
    ...(opts.reviewer ? { reviewer: opts.reviewer } : {}),
    ...(opts.noReviewer ? { noReviewer: true } : {}),
    ...(opts.always ? { always: true } : {}),
  }),
  retry: (project, issue) => send(`${T(project, issue)}/retry`),
  // An empty repository: writes an initial commit on the base branch and pushes
  // it. The server refuses without `confirm: true`, so a stray call writes nothing.
  bootstrapRepo: (project, issue) => send(`${T(project, issue)}/bootstrap-repo`, { confirm: true }),
  // Changes a project's base branch live (a worktree that failed for its base).
  // `body`: { baseBranch, issue? } — with `issue`, that task is retried. A 409
  // `base_not_on_remote` carries `data.remoteHeads`.
  changeBaseBranch: (project, body) => send(`/api/projects/${encodeURIComponent(project)}/base-branch`, body),
  // A PR that could not be published for what its title says: the corrected
  // title publishes it and the run goes on from there. A 400 comes back with
  // `problems`, the reasons the control refused it.
  publishPr: (project, issue, title) => send(`${T(project, issue)}/pr`, { title }),
  // Closing an issue with no PR, when the analysis concluded no change is
  // needed. Nothing reaches GitHub until `closeIssue`: drafting, discarding,
  // the repo's labels and checking a duplicate's number all stay on the board.
  // The draft's body travels only in the GET — the task's park carries every
  // other `closing` field but not that one.
  closeDraft: (project, issue) => get(`${T(project, issue)}/close/draft`),
  draftClose: (project, issue) => send(`${T(project, issue)}/close/draft`),
  discardClose: (project, issue) => send(`${T(project, issue)}/close/discard`),
  closeOptions: (project, issue) => get(`${T(project, issue)}/close/options`),
  verifyRef: (project, issue, ref) => get(`${T(project, issue)}/close/verify?ref=${encodeURIComponent(ref)}`),
  closeIssue: (project, issue, body) => send(`${T(project, issue)}/close`, body),
  acceptFix: (project, issue) => send(`${T(project, issue)}/accept-fix`),
  mergeMain: (project, issue) => send(`${T(project, issue)}/merge-main`),
  push: (project, issue) => send(`${T(project, issue)}/push`),
  mergeHelp: (project, issue) => send(`${T(project, issue)}/merge-help`),
  // «🚀 Arrancar tarea»: the board works this task now, whatever autostart
  // says; a manual task stays manual and gets one run.
  startTask: (project, issue) => send(`${T(project, issue)}/start`),
  setMode: (project, issue, mode) => send(`${T(project, issue)}/mode`, { mode }),
  setMachine: (project, issue, machine) => send(`${T(project, issue)}/machine`, { machine }),
  machines: () => fetch('/api/machines', { headers: authHeaders() }).then((r) => r.json()),
  models: () => fetch('/api/models', { headers: authHeaders() }).then((r) => r.json()),
  // Refreshes only the project that is open; with none, the body is empty.
  pollNow: (project) => send('/api/poll', project ? { project } : undefined, 'POST', POLL_TIMEOUT_MS),
  cancelPoll: () => send('/api/poll/cancel', undefined, 'POST', POLL_TIMEOUT_MS),
  refreshGit: (project) => send('/api/git/refresh', project ? { project } : undefined, 'POST', GIT_TIMEOUT_MS),
  startCr: (project, issue) => send(`${T(project, issue)}/change-requests/start`),
  setActiveCr: (project, issue, reviewId, active) =>
    send(`${T(project, issue)}/change-requests/${reviewId}/active`, { active }),
  resolveCr: (project, issue, reviewId, force = false) =>
    send(`${T(project, issue)}/change-requests/${reviewId}/resolve`, { force }),
  draftCrReplies: (project, issue, reviewId) =>
    send(`${T(project, issue)}/change-requests/${reviewId}/draft-replies`),
  discardCrReplies: (project, issue, reviewId) =>
    send(`${T(project, issue)}/change-requests/${reviewId}/discard-replies`),
  preview: () => fetch('/api/preview', { headers: authHeaders() }).then((r) => r.json()),
  createWorktree: (project, issue) => send(`${T(project, issue)}/worktree`),
  deleteWorktree: (project, issue) => send(`${T(project, issue)}/worktree/delete`),
  startStack: (project, issue) => send(`${T(project, issue)}/stack/start`),
  stopStack: (project, issue) => send(`${T(project, issue)}/stack/stop`),
  // Moving a task to another machine: what blocks it and what it would do, the
  // move itself, a retry or a discard of a failed one, and a kept worktree deleted.
  movePreflight: async (project, issue, to, { discardTargetLocal = false } = {}) => {
    const qs = `to=${encodeURIComponent(to)}${discardTargetLocal ? '&discardTargetLocal=1' : ''}`;
    const res = await fetch(`${T(project, issue)}/move/preflight?${qs}`, { headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error ?? res.statusText), { status: res.status, data });
    return data;
  },
  moveTask: (project, issue, body) => send(`${T(project, issue)}/move`, body),
  retryMove: (project, issue) => send(`${T(project, issue)}/move/retry`),
  discardMove: (project, issue) => send(`${T(project, issue)}/move/discard`),
  deletePlace: (project, issue, machine) => send(`${T(project, issue)}/places/${encodeURIComponent(machine)}/delete`),
  saveSettings: (patch) => send('/api/settings', patch),
  // A patch of the project's own overrides; a `null` value goes back to following the board.
  saveProjectSettings: (project, patch) => send(`/api/projects/${encodeURIComponent(project)}/settings`, patch),
  // Upgrading the Claude SDK, the CLI and the runners' code from the board.
  upgradeState: async ({ fresh = false } = {}) => {
    const res = await fetch(`/api/upgrade${fresh ? '?fresh=1' : ''}`, { headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error ?? res.statusText), { status: res.status, data });
    return data;
  },
  requestUpgrade: ({ target, onlyLaptop = false, updatePathCli = false }) => send('/api/upgrade', { target, onlyLaptop, updatePathCli }),
  upgradeNow: () => send('/api/upgrade/now'),
  cancelUpgrade: () => send('/api/upgrade/cancel'),
  ackUpgrade: (id) => send('/api/upgrade/ack', { id }),
  // Restarting the board from its own button. The state GET throws like
  // `upgradeState` does, so a caller can tell a 409 (an upgrade is running)
  // from a network error (the board is going down): `e.status` is undefined
  // for the latter.
  restartState: async () => {
    const res = await fetch('/api/restart', { headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error ?? res.statusText), { status: res.status, data });
    return data;
  },
  requestRestart: ({ force }) => send('/api/restart', { force }),
  cancelRestart: () => send('/api/restart/cancel'),
  // Renewing one machine's Claude login. The ticket answers the POST that
  // started the job and rides in a header (never a query) on every later call:
  // only the device that clicked may read the login URL or send the code.
  loginState: async () => {
    const res = await fetch('/api/login', { headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error ?? res.statusText), { status: res.status, data });
    return data;
  },
  startLogin: (machine, { force = false } = {}) => send(`${LG(machine)}/login`, { force }),
  loginJob: (machine, ticket) => loginCall(`${LG(machine)}/login/job`, ticket),
  sendLoginCode: (machine, ticket, code) => loginCall(`${LG(machine)}/login/code`, ticket, { code }),
  cancelLogin: (machine, ticket) => loginCall(`${LG(machine)}/login/cancel`, ticket, {}),
  // The required user-level plugins: what each machine lacks, and an install
  // that only runs when asked. The list itself is a board setting.
  pluginsState: () => get('/api/plugins'),
  installPlugin: (machine, id) => send(`${LG(machine)}/plugins/install`, { id }),
  setRequiredPlugins: (requiredPlugins) => send('/api/settings', { requiredPlugins }),
  // Whether chats of a project load the board's UX plugin (`null`: the default, on).
  setProjectDesign: (project, design) => send(`/api/projects/${encodeURIComponent(project)}/design`, { design }),
  // The offer's answers live in the board's settings, so every device agrees.
  // A snooze clears `seen`: otherwise the offer would never come back.
  snoozeUpgrade: (untilIso) => api.saveSettings({ upgrade: { snoozedUntil: untilIso, seen: null } }),
  skipUpgrade: (version) => api.saveSettings({ upgrade: { skipped: version } }),
  markUpgradeSeen: (version) => api.saveSettings({ upgrade: { seen: version } }),
  // The tab strip is the board's, shared by every device, so a tab carries the
  // project it belongs to: issue #12 of two repos are two different tabs.
  openChatTab: (project, issue) => send('/api/chat-tabs/open', { project, issue }),
  closeChatTab: (project, issue) => send('/api/chat-tabs/close', { project, issue }),
  // A project chat's tab: the entry is `p:<project>@<machine>` on the server.
  openProjectTab: (project, machine) => send('/api/chat-tabs/open', { project, owner: 'project', machine }),
  closeProjectTab: (project, machine) => send('/api/chat-tabs/close', { project, owner: 'project', machine }),
  // On demand refresh of the account's usage window, throttled server-side
  // to 60 s; a throttled call still answers with the current state.
  refreshUsage: () => send('/api/usage/refresh', {}),
};
