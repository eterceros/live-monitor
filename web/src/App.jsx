import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { connectWs, api, reportView } from './api.js';
import Board from './components/Board.jsx';
import NoProjectState from './components/NoProjectState.jsx';
import ImportProjectDialog from './components/ImportProjectDialog.jsx';
import ManageProjectsDialog from './components/ManageProjectsDialog.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import DemoPanel from './components/DemoPanel.jsx';
import BrowserQaPanel from './components/BrowserQaPanel.jsx';
import LogPanel from './components/LogPanel.jsx';
import TimelinePanel from './components/TimelinePanel.jsx';
import MetricsDialog from './components/MetricsDialog.jsx';
import ChangeRequestPanel from './components/ChangeRequestPanel.jsx';
import TaskTabs from './components/TaskTabs.jsx';
import Topbar from './components/topbar/Topbar.jsx';
import KpiStrip from './components/kpi/KpiStrip.jsx';
import QuestionDialog from './components/QuestionDialog.jsx';
import PlanReview from './components/PlanReview.jsx';
import MoveDialog from './components/MoveDialog.jsx';
import PrTitleDialog from './components/PrTitleDialog.jsx';
import ReviewerDialog from './components/ReviewerDialog.jsx';
import { ASK_EVERY_TIME, readyPick, settingsPick } from './reviewerRules.js';
import { actionKey, createInflight } from './inflight.js';
import ModelsDialog from './components/ModelsDialog.jsx';
import CloseIssueDialog from './components/CloseIssueDialog.jsx';
import UpgradeDialog, { upgradeChip } from './components/UpgradeDialog.jsx';
import Icon from './components/Icon.jsx';
import { autoOfferBlocked, manualCheckOutcome } from './upgradeOffer.js';
import { requestLoginRenew } from './loginChip.js';
import { useQuotaClock } from './components/QuotaChip.jsx';
import { BUSY_STATES } from './status.js';
import { useSidePanel } from './useSidePanel.js';
import { useDialog } from './useDialog.jsx';
import { lastChatOf, rememberChat } from './lastChat.js';
import { pickActiveProject, readActiveProject, rememberActiveProject, rememberNoProject } from './activeProject.js';
import { cardId, holderKey, holderTabEntry, keyOf, parseHolderTab, taskKey } from './taskKey.js';
import { parseQuery, matchTask, isExempt } from './boardFilter.js';
import { useFileViewerScope } from './viewer/FileViewer.jsx';
import { ago } from './time.js';
import { finishedOutcome } from './pollProgress.js';
import { useStrings } from './i18n/useStrings.js';
import { fill, locale, plural } from './i18n/index.js';

// How far a job has got: a broadcast or an answer never takes a job back.
/** A poll that «runs» without progress for longer than this is a dead one, not a slow one. */
const POLL_STALE_MS = 10 * 60 * 1000;

/** Whether the server's `running` is a leftover: no progress (or start) for POLL_STALE_MS; progress resets it. */
export function pollRunningStale(info, seenSince, now) {
  if (!info?.running) return false;
  const since = info.progressAt ?? info.startedAt ?? seenSince;
  return since != null && now - since > POLL_STALE_MS;
}

/** The current time, refreshed every 30 s so a staleness verdict is re-evaluated without any message. */
function useStaleTick() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const JOB_RANK = { waiting: 0, running: 1, laptop: 2, done: 3, failed: 3 };

/**
 * Every write of the upgrade state goes through here, because they race: a
 * fresh GET can come back after a WebSocket message that is already newer.
 * Detection (versions, machines, git, idle) keeps the later check; a job keeps
 * whichever copy is further along. A different job, or none (cancelled), wins.
 */
function mergeUpgrade(prev, next) {
  if (!next) return prev ?? null;
  if (!prev) return next;
  const staleCheck = prev.checkedAt && next.checkedAt && Date.parse(prev.checkedAt) > Date.parse(next.checkedAt);
  const base = staleCheck
    ? { ...next, sdk: prev.sdk, machines: prev.machines, git: prev.git, idle: prev.idle, checkedAt: prev.checkedAt }
    : next;
  const a = prev.job;
  const b = next.job;
  let job = b ?? null;
  if (a && b && a.id === b.id) {
    const ra = JOB_RANK[a.state] ?? -1;
    const rb = JOB_RANK[b.state] ?? -1;
    const keepPrev = ra > rb || (ra === rb && (a.steps?.length ?? 0) > (b.steps?.length ?? 0));
    job = keepPrev ? a : b;
    // An acknowledgement never comes undone.
    if (a.acknowledged && !job.acknowledged) job = { ...job, acknowledged: true };
  }
  return base === next && job === b ? next : { ...base, job };
}

/**
 * The quota hold out of a message, whichever way the server wraps it: as the
 * upgrade's own broadcast does (`state`), under `quota`, or — a hold sent flat,
 * with its own `state: 'held'` — as the message itself. Reading `msg.state`
 * blindly would take that string for the whole hold.
 */
function readQuota(msg) {
  if (!msg) return null;
  if (msg.quota !== undefined) return msg.quota ?? null;
  if (typeof msg.state === 'string') {
    const { type, ...hold } = msg;
    return hold;
  }
  return msg.state ?? null;
}

export default function App() {
  const [tasks, setTasks] = useState([]);
  // The registry behind the selector, and the project this screen is looking
  // at. The board watches several projects and paints one at a time.
  const [projects, setProjects] = useState([]);
  // The project the board OPENS on — the first of the registry. It is not a
  // selection: the selection is this device's, in `localStorage`, because this
  // board is open on a laptop and on a phone at once and switching project on
  // one must not switch it on the other.
  const [opensOn, setOpensOn] = useState(null);
  const [activeProject, setActiveProject] = useState(readActiveProject);
  const [meta, setMeta] = useState({ github: {}, project: {} });
  const [settings, setSettings] = useState({ maxActiveTasks: 1, ceiling: 10, autoStart: true });
  const [models, setModels] = useState({ list: [], fallback: 'opus' });
  // Where tasks can run: names from the snapshot, reachability probed apart
  // (a box that is off must not hold the board's own load up).
  const [machines, setMachines] = useState([]);
  const [machineStatus, setMachineStatus] = useState({});
  const [connected, setConnected] = useState(false);
  // The project chats' holders (one per project × machine), as summaries that
  // look enough like a task for `ChatPanel`: `kind: 'project'`, no issue.
  const [projectChats, setProjectChats] = useState([]);
  // { project, owner: 'task', issue, chatId } or { project, owner: 'project',
  // machine, chatId } — un dueño tiene varias conversaciones, como `crView`.
  const [chatView, setChatView] = useState(null);
  const [demoIssue, setDemoIssue] = useState(null);
  const [qaIssue, setQaIssue] = useState(null);
  const [logIssue, setLogIssue] = useState(null);
  const [timelineIssue, setTimelineIssue] = useState(null);
  const [metricsOpen, setMetricsOpen] = useState(false);
  // The project dialogs live here: the empty state, the bar and the manager all open them.
  const [importOpen, setImportOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [crView, setCrView] = useState(null);   // { issue, reviewId }
  const [pollStarting, setPollStarting] = useState(false); // between the click and the first answer
  const [refreshingGit, setRefreshingGit] = useState(false);
  // When `pollInfo.running` was first seen true (for servers that send no startedAt).
  const runningSince = useRef(null);
  const [fetchMsg, setFetchMsg] = useState(null);
  const [pollInfo, setPollInfo] = useState({ lastPollAt: null });
  const [clock, setClock] = useState(0);
  // What a task itself waits on, opened from its card: { issue, kind: 'answer' | 'plan' | 'pr' }.
  const [taskDialog, setTaskDialog] = useState(null);
  const [deciding, setDeciding] = useState(false);
  // «Listo para revisión» on a project with no reviewer: { project, issue, suggested, excludeLogin }.
  const [reviewerAsk, setReviewerAsk] = useState(null);
  const reviewerAskRef = useRef(null);
  // Actions with a request in flight, so a second click sends nothing (inflight.js).
  const [pending, setPending] = useState(() => new Set());
  const inflight = useRef(null);
  if (!inflight.current) inflight.current = createInflight(setPending);
  // The «👤 Revisor» button: the project's reviewer setting, no PR involved (a project id).
  const [reviewerSettings, setReviewerSettings] = useState(null);
  const [modelsOpen, setModelsOpen] = useState(false);
  // The settings menu (opened from the bar, and from a card's «Ajustes»), and whether the first snapshot has landed.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // The move dialog: { issue, to } — `to` is null for «Mover a…», a machine for «↩ volver».
  const [moveDialog, setMoveDialog] = useState(null);
  // The SDK/CLI/runner upgrade: its live state, and whether its dialog is open.
  const [upgrade, setUpgrade] = useState(null);
  const [upgradeDialog, setUpgradeDialog] = useState(false);
  const upgradeOffered = useRef(false);
  // The SDK offer's `ask` is on screen, or a manual check is running: the button waits.
  const [offerOpen, setOfferOpen] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  // The account's usage window: null on a server that does not send it yet,
  // and then the board is exactly what it was before this existed.
  const [quota, setQuota] = useState(null);
  // The account's usage probe: null on a server that has not sampled it yet,
  // or before the first snapshot/WS message brings one.
  const [usage, setUsage] = useState(null);
  // The snapshot right after a (re)connection is the board as it is now: a
  // restarted board legitimately starts over with `checkedAt: null`.
  const acceptSnapshot = useRef(false);
  const writeUpgrade = (next) => setUpgrade((u) => mergeUpgrade(u, typeof next === 'function' ? next(u) : next));
  const wsRef = useRef(null);
  const side = useSidePanel();
  const { ask, notice } = useDialog();
  const t = useStrings();
  const say = (e) => notice(typeof e === 'string' ? e : e.message);

  useEffect(() => {
    const ws = connectWs({
      onStatus: (up) => {
        setConnected(up);
        // A board restarted while a panel was open: whatever that panel shows
        // as running is what it saw last, not what is. Panels reload on this.
        if (up) {
          acceptSnapshot.current = true;
          window.dispatchEvent(new CustomEvent('board-connected'));
        }
      },
      snapshot: (msg) => {
        setTasks(msg.tasks);
        setLoaded(true);
        setProjectChats(msg.projectChats ?? []);
        // A board whose server does not send the registry yet: the tasks still
        // say which project they belong to, so the filter has something to go on.
        const opens = msg.activeProject ?? msg.tasks?.[0]?.project ?? null;
        setProjects(msg.projects ?? []);
        setOpensOn(opens);
        setActiveProject((cur) => pickActiveProject(msg.projects, opens, cur));
        setMeta({ github: msg.github, project: msg.project });
        setSettings(msg.settings);
        setModels({ list: msg.models ?? [], fallback: msg.defaultChatModel ?? 'opus' });
        setMachines(msg.machines ?? []);
        if (msg.poll) setPollInfo(msg.poll);
        if (msg.upgrade !== undefined) {
          if (acceptSnapshot.current) setUpgrade(msg.upgrade ?? null);
          else writeUpgrade(msg.upgrade);
        }
        // The hold has no history to merge: the snapshot is the board as it
        // is now, and a released window is the absence of one.
        if (msg.quota !== undefined) setQuota(msg.quota ?? null);
        if (msg.usage !== undefined) setUsage(msg.usage ?? null);
        acceptSnapshot.current = false;
      },
      upgrade: (msg) => writeUpgrade(msg.state ?? null),
      quota: (msg) => setQuota(readQuota(msg)),
      usage: (msg) => setUsage(msg.usage ?? null),
      login: (msg) => window.dispatchEvent(new CustomEvent('board-login', { detail: msg })),
      plugins: (msg) => window.dispatchEvent(new CustomEvent('board-plugins', { detail: msg })),
      settings: (msg) => {
        setSettings(msg.settings);
        // The offer's answers from another device (`skipped`, `seen`) land at once.
        const prefs = msg.settings?.upgrade;
        if (prefs) writeUpgrade((u) => (u ? { ...u, settings: { ...(u.settings ?? {}), ...prefs } } : u));
      },
      poll: (msg) => { setPollInfo(msg.poll); if (msg.poll?.running) setFetchMsg(null); },
      // By (project, issue), not by issue: #12 of one repository must not
      // replace #12 of the other. `project` rides inside the task.
      task: (msg) => {
        setTasks((prev) => {
          const key = taskKey(msg.task);
          const next = prev.filter((t) => taskKey(t) !== key);
          next.push(msg.task);
          return next.sort((a, b) => b.issue - a.issue || String(a.project).localeCompare(String(b.project)));
        });
      },
      // A holder changing (its chats, head, busy flag): replaced whole by key.
      'project-chat': (msg) => {
        const h = msg.holder;
        if (!h) return;
        setProjectChats((prev) => {
          const key = taskKey(h);
          const at = prev.findIndex((x) => taskKey(x) === key);
          return at < 0 ? [...prev, h] : [...prev.slice(0, at), h, ...prev.slice(at + 1)];
        });
      },
      log: (msg) => window.dispatchEvent(new CustomEvent('task-log', { detail: msg })),
      error: (msg) => notice(msg.error),
      chat: (msg) => window.dispatchEvent(new CustomEvent('task-chat', { detail: msg })),
      // A message changing in place: one node of a turn's activity tree, or a
      // bubble learning how it was delivered.
      'chat-update': (msg) => window.dispatchEvent(new CustomEvent('task-chat-update', { detail: msg })),
    });
    wsRef.current = ws;
    return () => ws.close();
  }, []);

  // The first time the board sees a newer SDK it offers it, once per page
  // load; `seen` is written as it shows so no other device offers it again,
  // and «Más tarde» clears it again so the snooze can expire into a new offer.
  // The offer itself, shared by the automatic path and the «Buscar actualizaciones» button.
  const offerUpgrade = (sdk) => {
    const latest = sdk.latest;
    const setPrefs = (patch) => writeUpgrade((u) => (u ? { ...u, settings: { ...(u.settings ?? {}), ...patch } } : u));
    setPrefs({ seen: latest });
    api.markUpgradeSeen(latest).catch((e) => console.warn('upgrade notice:', e.message)); // i18n-ok: console diagnostic
    setOfferOpen(true);
    ask({
      title: t.app.offer.title, icon: 'arrow-up',
      text: fill(t.app.offer.text, { current: sdk.current, latest, cli: sdk.cli ? fill(t.app.offer.pairedCli, { cli: sdk.cli }) : '' }),
      options: [
        { value: 'now', label: t.app.offer.now, description: t.app.offer.nowHint },
        { value: 'skip', label: t.app.offer.skip, tone: 'warn', description: fill(t.app.offer.skipHint, { latest }) },
      ],
      cancel: t.app.offer.later,
    }).then((choice) => {
      setOfferOpen(false);
      if (choice === 'now') setUpgradeDialog(true);
      else if (choice === 'skip') {
        setPrefs({ skipped: latest });
        api.skipUpgrade(latest).catch(say);
      } else {
        const until = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        setPrefs({ snoozedUntil: until, seen: null });
        api.snoozeUpgrade(until).catch(say);
      }
    });
  };

  useEffect(() => {
    if (upgradeOffered.current || !upgrade) return;
    if (autoOfferBlocked(upgrade)) return;
    // One `ask` at a time: opened over another dialog, the one below would be dismissed
    // (and «Más tarde» would snooze the offer for a day).
    if (upgradeDialog || moveDialog || taskDialog || offerOpen) return;
    upgradeOffered.current = true;
    offerUpgrade(upgrade.sdk);
  }, [upgrade, upgradeDialog, moveDialog, taskDialog, offerOpen]);

  // «Buscar actualizaciones»: a fresh check, and a click means «now» — the offer
  // ignores skipped, seen and the snooze. Nothing opens over a live dialog.
  const checkForUpdates = async () => {
    if (checkingUpdates || offerOpen || upgradeDialog || moveDialog || taskDialog) return;
    const before = upgrade;
    setCheckingUpdates(true);
    upgradeOffered.current = true; // the automatic offer must not race this one
    let outcome;
    try {
      const next = await api.upgradeState({ fresh: true });
      writeUpgrade(next);
      outcome = manualCheckOutcome(before, next);
    } catch (e) {
      outcome = { kind: 'error', message: e.message };
    } finally {
      setCheckingUpdates(false);
    }
    if (outcome.kind === 'offer') offerUpgrade(outcome.sdk);
    else if (outcome.kind === 'job') setUpgradeDialog(true);
    else if (outcome.kind === 'manual') {
      notice({ title: t.app.check.manualTitle, icon: 'arrow-up', text: fill(t.app.check.manualText, { current: outcome.current, latest: outcome.latest }) });
    } else if (outcome.kind === 'uptodate') {
      const v = outcome.versions;
      const lines = [fill(t.app.check.sdkLine, { sdk: v.sdk ?? '?', latest: v.latest })];
      if (v.cli) lines.push(fill(t.app.check.pairedCli, { cli: v.cli }));
      for (const m of v.machines) lines.push(fill(t.app.check.machineLine, { name: m.name, claude: m.claude ?? '?', outdated: m.ok ? '' : t.app.check.outdated }));
      notice({ title: t.app.check.uptodateTitle, icon: 'check-circle', text: fill(t.app.check.uptodateText, { lines: lines.join('\n') }) });
    } else {
      notice({ title: t.app.check.failedTitle, icon: 'alert-triangle', text: fill(t.app.check.failedText, { message: outcome.message }) });
    }
  };

  // Re-render once a minute so the "last search" label ages on its own.
  useEffect(() => {
    const id = setInterval(() => setClock((c) => c + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // And once at midnight, because that is when «hoy» stops being today. The
  // minute above would get there within a minute; a panel left open across
  // midnight deserves the exact second, and one timer aimed at it costs
  // nothing. It re-arms itself off `clock`.
  useEffect(() => {
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    const id = setTimeout(() => setClock((c) => c + 1), midnight.getTime() - Date.now() + 250);
    return () => clearTimeout(id);
  }, [clock]);

  // A remote box's state, every minute: reachable, and with the CLI the
  // board expects. Only worth asking when there is somewhere else to run.
  useEffect(() => {
    if (machines.length < 1) return undefined;
    const probe = () => api.machines()
      .then((r) => setMachineStatus(Object.fromEntries((r.machines ?? []).map((m) => [m.name, m]))))
      .catch(() => {});
    probe();
    const id = setInterval(probe, 60_000);
    return () => clearInterval(id);
  }, [machines.length]);

  // The one project on screen. Every panel, dialog and card below reads this
  // list; `tasks` stays the union, because what it feeds is not the project's:
  // the active-task count is the account's — one Claude, one limit — and the
  // pending-decision notice speaks for every project at once.
  // A task reassigned away from the board user and already settled is hidden
  // everywhere (reversible: it comes back when the issue is assigned back).
  // `tasks` itself stays whole: a hidden run in flight still holds a slot.
  const shown = useMemo(() => tasks.filter((t) => !t.unassigned?.settled), [tasks]);
  const visible = useMemo(
    () => (activeProject ? shown.filter((t) => t.project === activeProject) : []),
    [shown, activeProject],
  );

  const activeCount = useMemo(
    () => tasks.filter((t) => BUSY_STATES.includes(t.state)).length,
    [tasks],
  );

  useEffect(() => { rememberActiveProject(activeProject); }, [activeProject]);

  // What is open here, for the server: the project on screen (null: none) and
  // whether the tab is visible. A project change, a hidden tab and a page that
  // is going away all say so; the socket resends it after every reconnect.
  useEffect(() => {
    reportView(activeProject);
    const onVisibility = () => reportView(activeProject, document.visibilityState === 'visible');
    const onHide = () => reportView(activeProject, false);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onVisibility);
    };
  }, [activeProject]);

  /** What to call a project on screen; a registry the server has not sent yet leaves the id. */
  const projectName = (id) => projects.find((p) => p.id === id)?.name || id;

  /**
   * Changing project changes everything on screen: what is open belongs to the
   * project being left, so the panels and dialogs close rather than show
   * another project's task under the old one's number.
   */
  const closePanels = () => {
    setChatView(null);
    setDemoIssue(null);
    setQaIssue(null);
    setLogIssue(null);
    setTimelineIssue(null);
    setCrView(null);
    setTaskDialog(null);
    setMoveDialog(null);
  };

  const selectProject = (id) => {
    if (!id || id === activeProject) return;
    setActiveProject(id);
    rememberActiveProject(id);
    closePanels();
  };

  // Restricting never moves the screen: the project stays open and in the picker.
  const toggleRestricted = (id, restricted) => {
    const set = (value) => setProjects((list) => list.map((p) => (p.id === id ? { ...p, restricted: !!value } : p)));
    set(restricted);
    api.setProjectRestricted(id, restricted).catch((e) => { set(!restricted); say(e); });
  };

  // Unregisters only: chats, tasks and data stay and return on re-import. If it
  // was the one on screen the board shows no project; it never picks another.
  const removeProject = async (project) => {
    const id = typeof project === 'string' ? project : project?.id;
    if (!id) return;
    const ok = await ask({
      title: fill(t.app.removeProject.title, { project: projectName(id) }), icon: 'trash',
      text: t.app.removeProject.text,
      options: [{ value: true, label: t.app.removeProject.confirm, tone: 'danger' }], cancel: t.app.reviewer.leave,
    });
    if (!ok) return;
    // Before the request: the server broadcasts a snapshot ahead of the DELETE
    // response, and it must find the board already on the blank state.
    const wasActive = id === activeProject;
    const before = projects;
    if (wasActive) {
      setActiveProject(null);
      rememberNoProject();
      closePanels();
    }
    setProjects((list) => list.filter((p) => p.id !== id));
    try {
      await api.removeProject(id);
    } catch (e) {
      setProjects(before);
      if (wasActive) {
        setActiveProject(id);
        rememberActiveProject(id);
      }
      say(e);
    }
  };

  /** An imported project is the one you want to look at, so the board goes there. */
  const projectImported = (project) => {
    if (!project?.id) return;
    setProjects((list) => (list.some((p) => p.id === project.id) ? list : [...list, project]));
    selectProject(project.id);
    // And then the registry as the server has it, in case it filled in more.
    api.projects()
      .then((r) => { const list = Array.isArray(r) ? r : r?.projects; if (Array.isArray(list)) setProjects(list); })
      .catch((e) => console.warn('project registry:', e.message)); // i18n-ok: console diagnostic
  };

  // The bar edits the active project: its own overrides, else the board's value.
  const own = settings.projects?.[activeProject] ?? {};
  const eff = (key) => own[key] ?? settings[key];
  const isOwn = (key) => key in own;

  const pollMins = eff('pollIntervalMinutes') ?? 10;

  const saveSettings = (patch) => {
    setSettings((s) => ({ ...s, ...patch }));
    api.saveSettings(patch).catch(say);
  };

  /** A `null` value drops the override. With no active project it is the flat setting, as before. */
  const saveProjectSetting = (patch) => {
    if (!activeProject) return saveSettings(patch);
    setSettings((s) => {
      const mine = { ...(s.projects?.[activeProject] ?? {}) };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete mine[k]; else mine[k] = v;
      }
      const projects = { ...(s.projects ?? {}) };
      if (Object.keys(mine).length) projects[activeProject] = mine; else delete projects[activeProject];
      return { ...s, projects };
    });
    api.saveProjectSettings(activeProject, patch).catch(say);
  };

  // `design` lives in the registry, not in the overrides: on unless the project says `false`.
  const designOn = projects.find((p) => p.id === activeProject)?.design !== false;
  const saveDesign = (on) => {
    setProjects((list) => list.map((p) => {
      if (p.id !== activeProject) return p;
      const { design: _drop, ...rest } = p;
      return on ? rest : { ...rest, design: false };
    }));
    api.setProjectDesign(activeProject, on ? null : false).catch(say);
  };

  /**
   * A tab is `{ project, issue }`. One written before projects existed has no
   * project: it belongs to the project the board opens on, which is the only
   * one that existed when it was written.
   */
  const tabProject = (t) => t.project ?? opensOn ?? activeProject;
  // A holder's entry is `{ issue: 'p:<project>@<machine>' }`: its halves come
  // from parsing the string, never from `tabProject` (which is for tasks).
  const projectTabs = (settings.chatTabs ?? [])
    .map((t) => {
      const h = parseHolderTab(t.issue);
      return h ? { ...t, ...h } : { ...t, project: tabProject(t) };
    })
    .filter((t) => t.project === activeProject);
  // The holders of the project on screen: the board's card and the strip's tabs.
  const holders = useMemo(
    () => (activeProject ? projectChats.filter((h) => h.project === activeProject) : []),
    [projectChats, activeProject],
  );

  /**
   * What the two collapse buttons do. On a desktop it is the rail of always.
   * On a phone there is no rail — the panel is the whole screen — so
   * collapsing there closes it and lets the board through; leaving it
   * «collapsed» painted an opaque slab over a board that was working.
   */
  const collapseSide = () => {
    if (!side.phone) { side.toggle(); return; }
    setChatView(null);
    setDemoIssue(null);
    setQaIssue(null);
    setLogIssue(null);
    setTimelineIssue(null);
    setCrView(null);
  };

  /**
   * Shows a task's chats and puts its tab in the strip. The strip is the
   * board's, so the tab is added on the server — and here first, so a new tab
   * never flickers in as a provisional one before the broadcast lands.
   */
  const openChat = (project, issue, chatId = null) => {
    setChatView({ project, owner: 'task', issue, chatId });
    // A collapsed panel would open the chat behind its rail, out of sight.
    side.expand();
    setSettings((s) => {
      const tabs = s.chatTabs ?? [];
      return tabs.some((t) => tabProject(t) === project && t.issue === issue)
        ? s
        : { ...s, chatTabs: [...tabs, { project, issue, usedAt: Date.now() }] };
    });
    api.openChatTab(project, issue).catch((e) => console.warn('chat tab:', e.message)); // i18n-ok: console diagnostic
  };

  /**
   * Shows a project chat — a holder's — and puts its tab in the strip, exactly
   * as `openChat` does for a task. Its strip entry is `p:<project>@<machine>`.
   */
  const openProjectChat = (project, machine, chatId = null) => {
    setChatView({ project, owner: 'project', machine, chatId });
    side.expand();
    const entry = holderTabEntry(project, machine);
    setSettings((s) => {
      const tabs = s.chatTabs ?? [];
      return tabs.some((t) => t.issue === entry) ? s : { ...s, chatTabs: [...tabs, { issue: entry, usedAt: Date.now() }] };
    });
    api.openProjectTab(project, machine).catch((e) => console.warn('chat tab:', e.message)); // i18n-ok: console diagnostic
  };

  /**
   * Moves to another conversation of the task already on screen — a chat tab,
   * or the one just created by «+» / «⑂».
   *
   * Only the chat changes: the task keeps the identity the view already holds.
   * Rewriting the whole view here is what broke it — `{ issue, chatId }`, with
   * no `project`, and `chatTask` matches on BOTH halves (`<project>#<issue>`),
   * so it found nothing, `sideOpen` went false and the entire panel vanished
   * on every click. Patching the view instead of rebuilding it cannot drop a
   * half, this one or one added later.
   */
  const showChat = (chatId) => setChatView((v) => (v ? { ...v, chatId } : v));

  /**
   * A tab's ✕ takes it out of the strip and nothing else: no chat is stopped
   * or archived. Closing the one on screen moves to its neighbour, the right
   * one first; closing the last one hides the panel.
   */
  const closeTaskTab = (project, issue) => {
    const mine = (t) => t.project === project && t.issue === issue;
    const next = neighbourOf(mine);
    setSettings((s) => ({ ...s, chatTabs: (s.chatTabs ?? []).filter((t) => !(tabProject(t) === project && t.issue === issue)) }));
    api.closeChatTab(project, issue).catch((e) => console.warn('chat tab:', e.message)); // i18n-ok: console diagnostic
    if (!chatView || chatView.owner === 'project' || !mine(chatView)) return;
    if (next) openTab(next); else setChatView(null);
  };

  /** A project chat's tab ✕: the same, for the holder's entry. */
  const closeProjectTab = (project, machine) => {
    const entry = holderTabEntry(project, machine);
    const mine = (t) => t.issue === entry;
    const next = neighbourOf(mine);
    setSettings((s) => ({ ...s, chatTabs: (s.chatTabs ?? []).filter((t) => t.issue !== entry) }));
    api.closeProjectTab(project, machine).catch((e) => console.warn('chat tab:', e.message)); // i18n-ok: console diagnostic
    if (!chatView || chatView.owner !== 'project' || chatView.project !== project || chatView.machine !== machine) return;
    if (next) openTab(next); else setChatView(null);
  };

  /** The tab to land on when `mine` goes: the right one first, then the left. */
  const neighbourOf = (mine) => {
    const isHolderTab = (t) => parseHolderTab(t.issue) != null;
    // Holder tabs first, as `TaskTabs` draws them, so «next» is what is beside it.
    const tabsShown = [...projectTabs.filter(isHolderTab), ...projectTabs.filter((t) => !isHolderTab(t))]
      .filter((t) => (isHolderTab(t)
        ? holders.some((h) => taskKey(h) === holderKey(t.project, parseHolderTab(t.issue).machine))
        : visible.some((x) => x.issue === t.issue && x.project === t.project)));
    const at = tabsShown.findIndex(mine);
    return at >= 0 ? (tabsShown[at + 1] ?? tabsShown[at - 1]) : tabsShown.at(-1);
  };
  /** Opens a strip entry of either kind, on the conversation last looked at there. */
  const openTab = (t) => {
    const h = parseHolderTab(t.issue);
    if (h) openProjectChat(h.project, h.machine, lastChatOf(holderKey(h.project, h.machine)));
    else openChat(t.project, t.issue, lastChatOf(keyOf(t.project, t.issue)));
  };

  /**
   * Both "ready for review" actions push first, and the server refuses with 409
   * when the worktree still holds uncommitted work. That refusal is a question,
   * not a failure: it names the files and lets you decide.
   */
  const conPendientes = (hacer) => hacer(false).catch(async (e) => {
    if (e.status !== 409 || !e.data?.dirty) return say(e);
    const files = e.data.dirty;
    const lista = files.slice(0, 6).join('\n') + (files.length > 6 ? `\n${fill(t.app.dirty.moreFiles, { n: files.length - 6 })}` : '');
    const ok = await ask({
      title: t.app.dirty.title, icon: 'alert-triangle',
      text: `${e.data.error}:\n\n${lista}`,
      options: [
        { value: true, label: t.app.dirty.continueAnyway, tone: 'warn', description: t.app.dirty.continueHint },
      ],
      cancel: t.app.dirty.commitFirst,
    });
    return ok ? hacer(true).catch(say) : undefined;
  });

  /**
   * «Listo para revisión». The server answers `needsReviewer` — and has done
   * nothing — when the project names nobody, and the dialog asks who. The pick
   * comes back through here with `pick` (`{ reviewer, always }` or
   * `{ noReviewer: true }`), and the dirty-worktree retry carries it along.
   */
  const markReady = (project, issue, pick = {}) => inflight.current.run(actionKey('ready', project, issue), () =>
    conPendientes((force) => api.ready(project, issue, { force, ...pick }))
      .then((r) => {
        if (r?.needsReviewer) { askReviewer({ project, issue, suggested: r.suggested ?? null, excludeLogin: r.excludeLogin ?? null }); return; }
        // «Usar siempre» changed the registry: refresh, or the settings dialog shows the old «Ahora:».
        if (pick.always) api.projects().then((f) => Array.isArray(f?.projects) && setProjects(f.projects)).catch(() => {});
      }));
  // The ask is consumed through a ref: two picks from the same render would
  // both see the state's closure still set and both send.
  const askReviewer = (ask) => { reviewerAskRef.current = ask; setReviewerAsk(ask); };
  const pickReviewer = (login, { remember } = {}) => {
    const ask = reviewerAskRef.current;
    askReviewer(null);
    if (!ask) return;
    markReady(ask.project, ask.issue, readyPick(login, remember));
  };
  // Stable, or the dialog's debounced search would restart on every render.
  const askProject = reviewerAsk?.project ?? reviewerSettings;
  const askExclude = reviewerAsk?.excludeLogin ?? null;
  const searchReviewers = useCallback(
    (q) => api.reviewers(askProject, q, askExclude).then((r) => r.users ?? []),
    [askProject, askExclude],
  );
  // Settings mode: the registry changes, the PR does not. Only this board learns
  // the change at once; another open board catches up on reconnect.
  const saveProjectReviewer = async (project, body) => {
    setReviewerSettings(null);
    try {
      const r = await api.setProjectReviewer(project, body);
      if (r?.project?.id) setProjects((list) => list.map((p) => (p.id === r.project.id ? { ...p, ...r.project } : p)));
      const fresh = await api.projects();
      const list = Array.isArray(fresh) ? fresh : fresh?.projects;
      if (Array.isArray(list)) setProjects(list);
    } catch (e) { say(e); }
  };
  // «Sin revisor» replaces a configured reviewer: confirm it, like «Preguntar cada vez».
  const pickProjectReviewer = async (project, login) => {
    const current = login ? null : projects.find((p) => p.id === project)?.reviewer;
    if (current) {
      const ok = await ask({
        title: t.app.reviewer.noneTitle, icon: 'user',
        text: fill(t.app.reviewer.removeText, { login: current, project: projects.find((p) => p.id === project)?.name ?? project }),
        options: [{ value: true, label: t.app.reviewer.remove, tone: 'warn', description: t.app.reviewer.noneHint }],
        cancel: t.app.reviewer.leave, focus: 'cancel',
      });
      if (!ok) return;
    }
    saveProjectReviewer(project, settingsPick(login));
  };
  const clearProjectReviewer = async (project) => {
    const current = projects.find((p) => p.id === project)?.reviewer;
    if (current) {
      const ok = await ask({
        title: t.app.reviewer.askTitle, icon: 'user',
        text: fill(t.app.reviewer.removeText, { login: current, project: projects.find((p) => p.id === project)?.name ?? project }),
        options: [{ value: true, label: t.app.reviewer.remove, tone: 'warn', description: t.app.reviewer.askHint }],
        cancel: t.app.reviewer.leave, focus: 'cancel',
      });
      if (!ok) return;
    }
    saveProjectReviewer(project, ASK_EVERY_TIME);
  };

  /**
   * Pulls a task's own dialog data from the live task list, so it updates as
   * the task does. Matched on both halves of the key, like `chatTask`: with
   * two projects on the board a #12 of one is not a #12 of the other.
   */
  const dialogTask = taskDialog
    ? visible.find((t) => t.issue === taskDialog.issue && t.project === taskDialog.project) ?? null
    : null;
  const decideTask = async (fn) => {
    setDeciding(true);
    try {
      await fn();
      setTaskDialog(null);
    } catch (e) {
      if (e.status === 409) notice({ title: t.app.decided.title, text: t.app.decided.text });
      else say(e);
    } finally {
      setDeciding(false);
    }
  };
  /**
   * Every project, not just the one on screen. A task stopped for an answer in
   * a hidden project would otherwise be announced nowhere — on a board that
   * drives itself, that is a dead task. The button changes project when it has
   * to, so the ones already on screen come first and it only pulls you out of
   * context when nothing here is waiting.
   */
  const awaiting = useMemo(() => {
    // Only registered projects: a removed project's tasks must not reopen it.
    const known = new Set(projects.map((p) => p.id));
    const all = shown.filter((t) => (t.awaitingYou ?? []).length > 0 && (!known.size || known.has(t.project)));
    const here = (t) => t.project === activeProject;
    return [...all.filter(here), ...all.filter((t) => !here(t))];
  }, [shown, activeProject, projects]);
  // Live, like `dialogTask`: the dialog follows the broadcasts while it is open.
  const movingTask = moveDialog ? visible.find((t) => t.issue === moveDialog.issue) ?? null : null;
  // A task gone from the board takes its dialog with it, so it cannot reopen on its own.
  useEffect(() => {
    if (moveDialog && !movingTask) setMoveDialog(null);
  }, [moveDialog, movingTask]);

  /**
   * «🚀 Arrancar tarea»: confirm, then the board works the task now. The
   * confirmation opens on «Dejarla», so a second Enter backs out rather than
   * starts; while it is open a held Enter or Space is swallowed, so the repeat
   * of the key that pressed 🚀 does not close it either. One start per task
   * is in flight at a time. A dialog that replaces this one resolves it as
   * cancelled (see `useDialog`), which is what runs the `finally` below.
   */
  const starting = useRef(new Set());
  const startTask = async (issue) => {
    const task = visible.find((t) => t.issue === issue);
    if (!task || starting.current.has(issue)) return;
    starting.current.add(issue);
    const swallowRepeat = (e) => {
      if (e.repeat && (e.key === 'Enter' || e.key === ' ')) { // i18n-ok: key name
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', swallowRepeat, true);
    try {
      const machine = task.machine ?? 'local';
      const priorWork = ['started', 'waiting_approval', 'done'].includes(task.state);
      // Only the phases this task will really go through: Browser QA when it
      // is wanted, and a stop at the plan when it waits for your approval.
      const steps = [
        t.app.start.stepWorktree, 'triage', task.approvePlanWanted && t.app.start.stepPlan, // i18n-ok: phase names
        'fix', 'tests', task.qaWanted && 'Browser QA', 'PR', // i18n-ok: phase names
      ].filter(Boolean);
      const stepText = new Intl.ListFormat(locale(), { type: 'conjunction' }).format(steps);
      // The client counts busy states only; the server also counts pipelines
      // parked mid-run, so its answer may still report going over the limit.
      const warned = activeCount >= settings.maxActiveTasks;
      const text = [
        fill(t.app.start.text, { machine, steps: stepText }),
        priorWork && t.app.start.prior,
        task.mode === 'manual' && t.app.start.manual,
        warned && fill(t.app.start.overBy, { active: activeCount, limit: settings.maxActiveTasks, next: activeCount + 1 }),
      ].filter(Boolean).join('\n\n');
      const go = await ask({
        title: fill(t.app.start.title, { issue }), icon: 'rocket', text,
        options: [{ value: true, icon: 'rocket', label: t.app.start.confirm, ...(priorWork ? { tone: 'warn' } : {}) }],
        cancel: t.app.start.leave, focus: 'cancel',
      });
      if (!go) return;
      const r = await api.startTask(task.project, issue);
      if (r?.overLimit && !warned) {
        notice({ title: fill(t.app.start.overTitle, { issue }), icon: 'rocket', text: fill(t.app.start.overText, { active: r.active, limit: r.limit }) });
      }
    } catch (e) {
      say(e);
    } finally {
      window.removeEventListener('keydown', swallowRepeat, true);
      starting.current.delete(issue);
    }
  };

  const runGitRefresh = () => {
    if (refreshingGit) return;
    setRefreshingGit(true);
    api.refreshGit(activeProject)
      .catch((e) => say(e.timeout ? t.topbar.bar.timeout : e))
      .finally(() => setRefreshingGit(false));
  };

  // The POST answers at once (202) and the cycle runs on in the server: its
  // progress and its end arrive as `poll` messages.
  const runPoll = () => {
    setPollStarting(true);
    api.pollNow(activeProject)
      .then((r) => { if (r.poll) setPollInfo(r.poll); })
      .catch((e) => setFetchMsg({ error: e.timeout ? t.topbar.bar.timeout : e.message }))
      .finally(() => setPollStarting(false));
  };
  const cancelPoll = () => {
    api.cancelPoll()
      .then((r) => { if (r.poll) setPollInfo(r.poll); })
      .catch((e) => setFetchMsg({ error: e.timeout ? t.topbar.bar.timeout : e.message }));
  };

  // A server that says «running» with no progress for ages is stale (its poll died): do not spin forever.
  const nowTick = useStaleTick();
  if (!pollInfo.running) runningSince.current = null;
  else if (runningSince.current == null) runningSince.current = Date.now();
  const serverRunning = pollInfo.running && !pollRunningStale(pollInfo, runningSince.current, nowTick);
  const buscando = pollStarting || serverRunning;
  // When a cycle ends (running true -> false) its result is said once, from `last`.
  const wasRunning = useRef(false);
  useEffect(() => {
    const out = finishedOutcome(wasRunning.current, pollInfo);
    wasRunning.current = Boolean(pollInfo.running);
    if (out) setFetchMsg(out);
  }, [pollInfo]);
  // The result of the last search is kept as numbers and said here, so a
  // language chosen afterwards still reads it.
  const fetchText = !fetchMsg ? null : fetchMsg.cancelled ? t.topbar.poll.cancelled
    : fetchMsg.error !== undefined ? fill(t.app.poll.error, { message: fetchMsg.error })
    : [fetchMsg.tasks && plural(fetchMsg.tasks, t.app.poll.news), fetchMsg.changeRequests && plural(fetchMsg.changeRequests, t.app.poll.crs)]
      .filter(Boolean).join(' · ') || t.app.poll.nothing;
  const lastPollShort = pollInfo.lastPollAt ? ago(pollInfo.lastPollAt) : t.app.poll.never;
  const lastPollText = pollInfo.lastPollAt ? fill(t.app.poll.last, { ago: lastPollShort }) : lastPollShort;

  const upgradeChipNow = upgradeChip(upgrade);

  // One clock for the whole board: the meter and every parked card read this
  // same `now`, so twenty cards in pause are still one interval. With no hold
  // it still counts down to whichever usage window is active, so the meter's
  // own countdown ticks without a hold in play.
  const quotaNow = useQuotaClock(
    quota && quota.state !== 'released' ? quota.until : (usage?.rows?.find((r) => r.active)?.resetsAt ?? null),
  );

  // The click of the «esperan tu decisión» button: goes to the first task that waits.
  const jumpToAwaiting = () => {
    const first = awaiting[0];
    // React batches a handler's state changes, so the project moves
    // first and whatever opens goes last: the last one wins and the
    // dialog stays open over the project just switched to. The other
    // way round, `selectProject` would close it again.
    selectProject(first.project);
    const key = { project: first.project, issue: first.issue };
    if (first.pending?.kind === 'question') setTaskDialog({ ...key, kind: 'answer' });
    else if (first.state === 'plan_ready') setTaskDialog({ ...key, kind: 'plan' });
    else if ((first.chats ?? []).some((c) => c.pending)) openChat(first.project, first.issue, (first.chats ?? []).find((c) => c.pending)?.id ?? null);
    else {
      // A project just changed has not painted its cards yet, so the
      // jump waits for them, exactly as `locate` waits in `Board`.
      const id = cardId(first.project, first.issue);
      const go = () => document.getElementById(id)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (first.project === activeProject) go(); else setTimeout(go, 50);
    }
  };

  const refreshUsage = () => api.refreshUsage()
    .then((r) => { if (r?.usage !== undefined) setUsage(r.usage ?? null); })
    .catch((e) => console.warn('quota refresh:', e.message)); // i18n-ok: console diagnostic

  const chatTask = !chatView ? null
    : chatView.owner === 'project'
      ? holders.find((h) => h.project === chatView.project && h.machine === chatView.machine) ?? null
      : visible.find((t) => t.issue === chatView.issue && t.project === chatView.project) ?? null;
  const demoTask = visible.find((t) => t.issue === demoIssue) ?? null;
  const qaTask = visible.find((t) => t.issue === qaIssue) ?? null;
  const logTask = visible.find((t) => t.issue === logIssue) ?? null;
  const timelineTask = visible.find((t) => t.issue === timelineIssue) ?? null;
  const crTask = crView ? visible.find((t) => t.issue === crView.issue) ?? null : null;
  const sideOpen = chatTask || demoTask || qaTask || logTask || timelineTask || crTask;

  // Board search. Filters ONLY the board's columns; panels and dialogs keep
  // resolving against `visible`. Tasks waiting on the user or open in a
  // panel stay on the board whatever the query says.
  const [query, setQuery] = useState('');
  const searchRef = useRef(null);
  const parsed = useMemo(() => parseQuery(query), [query]);
  const awaitingKeys = useMemo(() => new Set(awaiting.map(taskKey)), [awaiting]);
  const openKeys = useMemo(() => {
    const keys = new Set();
    const tabTasks = projectTabs
      .map((t) => visible.find((x) => x.issue === t.issue && x.project === t.project))
      .filter(Boolean);
    for (const t of [chatTask, dialogTask, movingTask, demoTask, qaTask, logTask, timelineTask, crTask, ...tabTasks]) {
      if (t) keys.add(taskKey(t));
    }
    return keys;
  }, [chatTask, dialogTask, movingTask, demoTask, qaTask, logTask, timelineTask, crTask, projectTabs, visible]);
  const boardTasks = useMemo(
    () => (parsed
      ? visible.filter((t) => isExempt(t, { awaitingKeys, openKeys }) || matchTask(t, parsed))
      : visible),
    [visible, parsed, awaitingKeys, openKeys],
  );
  // Nothing matches here: say where else the query does match.
  const crossHint = useMemo(() => {
    if (!parsed || visible.some((t) => matchTask(t, parsed))) return null;
    const counts = new Map();
    for (const t of shown) {
      if (t.project === activeProject || !matchTask(t, parsed)) continue;
      counts.set(t.project, (counts.get(t.project) ?? 0) + 1);
    }
    if (counts.size === 0) return null;
    return [t.app.search.none, ...[...counts].map(([id, n]) => fill(t.app.search.elsewhere, { n, project: projectName(id) }))].join(' · ');
  }, [parsed, visible, shown, activeProject, projects, t]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The chat actually on screen for the task, remembered on this device, so
  // going back to the task's tab lands on it rather than on the principal.
  const openChats = (chatTask?.chats ?? []).filter((c) => !c.closedAt);
  const shownChatId = chatTask
    ? (openChats.find((c) => c.id === chatView.chatId) ?? openChats[0])?.id ?? null
    : null;
  useEffect(() => {
    if (chatTask && shownChatId) rememberChat(taskKey(chatTask), shownChatId);
  }, [chatTask ? taskKey(chatTask) : null, shownChatId]);
  // A file named in that chat resolves against its task: its worktree on
  // each machine comes first.
  useFileViewerScope(chatTask ? { project: chatTask.project, issue: chatTask.issue, chatId: shownChatId, machine: chatTask.machine ?? null } : null);

  return (
    <div
      className={`app ${sideOpen ? 'with-side' : ''} ${side.collapsed ? 'side-collapsed' : ''}`}
      style={sideOpen ? { '--side-width': `${side.width}px` } : undefined}
    >
      <Topbar
        projects={projects} activeProject={activeProject} onSelectProject={selectProject} onImported={projectImported}
        onToggleRestricted={toggleRestricted} onRemoveProject={removeProject} onManageProjects={() => setManageOpen(true)}
        fallbackRepo={meta.github.repo ? `${meta.github.repo} · @${meta.github.assignee}` : null}
        settingsMenu={{
          activeProject, projectLabel: projectName(activeProject), settings, eff, isOwn, saveSettings, saveProjectSetting,
          designOn, saveDesign, machines, pollMins, onOpenModels: () => setModelsOpen(true),
          open: settingsOpen, onOpenChange: setSettingsOpen,
        }}
        moreMenu={{
          checkingUpdates, updatesDisabled: checkingUpdates || offerOpen || upgradeDialog,
          onCheckUpdates: checkForUpdates, onImported: projectImported, defaultAssignee: meta.github?.assignee ?? null,
        }}
        machines={machines} machineStatus={machineStatus} onOpenMetrics={() => setMetricsOpen(true)}
        gitRefresh={{ busy: refreshingGit, run: runGitRefresh }}
        poll={{ busy: buscando, text: lastPollText, short: lastPollShort, msg: fetchText, run: runPoll, info: pollInfo, cancel: cancelPoll }}
        query={query} setQuery={setQuery} searchRef={searchRef}
        upgradeChip={upgradeChipNow} onOpenUpgrade={() => setUpgradeDialog(true)} connected={connected}
      />
      <KpiStrip
        awaiting={awaiting} activeProject={activeProject} projectName={projectName} onJumpAwaiting={jumpToAwaiting}
        activeCount={activeCount} maxActive={settings.maxActiveTasks} ceiling={settings.ceiling}
        onSetMax={(n) => saveSettings({ maxActiveTasks: n })}
        allTasks={shown} projectTasks={visible} usage={usage} quota={quota} now={quotaNow} onRefreshUsage={refreshUsage}
      />

      {crossHint && <div className="board-search-hint">{crossHint}</div>}

      {activeProject || !loaded ? (
        <Board
          tasks={boardTasks}
          loading={!loaded}
          polling={buscando}
          onPollNow={runPoll}
          onOpenSettings={() => setSettingsOpen(true)}
          projectChats={holders}
          inflightKeys={pending}
          onOpenProjectChat={(project, machine) => openProjectChat(project, machine, lastChatOf(holderKey(project, machine)))}
          query={query}
          parsed={parsed}
          doneTotal={visible.filter((t) => t.state === 'done').length}
          machines={machines}
          quota={quota}
          quotaNow={quotaNow}
          onSetMachine={(issue, machine) => api.setMachine(activeProject, issue, machine).catch(say)}
          onChat={(issue) => openChat(activeProject, issue)}
          // Like a chat: a panel opened while the side is a rail must be seen.
          onDemo={(issue) => { setDemoIssue(issue); side.expand(); }}
          onQa={(issue) => { setQaIssue(issue); side.expand(); }}
          onSetBrowserQa={(issue, mode) => api.setBrowserQa(activeProject, issue, mode).catch(say)}
          onSetDemo={(issue, mode) => api.setDemo(activeProject, issue, mode).catch(say)}
          onLog={(issue) => { setLogIssue(issue); side.expand(); }}
          onTimeline={(issue) => { setTimelineIssue(issue); side.expand(); }}
          onReady={(issue) => markReady(activeProject, issue)}
          onReviewer={() => setReviewerSettings(activeProject)}
          onRetry={(issue) => api.retry(activeProject, issue).catch(say)}
          onRenewLogin={requestLoginRenew}
          onBootstrapRepo={async (issue, base) => {
            const repo = meta.github?.repo ?? activeProject;
            const go = await ask({
              title: fill(t.app.bootstrap.title, { issue }), icon: 'sprout',
              text: fill(t.app.bootstrap.text, { base, repo }),
              options: [{ value: true, label: t.app.bootstrap.confirm, tone: 'warn' }],
              cancel: t.app.reviewer.leave, focus: 'cancel',
            });
            if (go) api.bootstrapRepo(activeProject, issue).catch(say);
          }}
          onChangeBase={async (issue, baseBranch) => {
            const go = await ask({
              title: fill(t.app.base.title, { issue }), icon: 'sprout',
              text: fill(t.app.base.text, { project: activeProject, base: baseBranch }),
              options: [{ value: true, label: t.app.base.confirm, tone: 'warn' }],
              cancel: t.app.reviewer.leave, focus: 'cancel',
            });
            if (!go) return;
            api.changeBaseBranch(activeProject, { baseBranch, issue }).then((r) => {
              if (r?.retryError) say(fill(t.app.base.retryFailed, { base: baseBranch, error: r.retryError }));
            }).catch((e) => {
              const heads = e.data?.remoteHeads;
              say(heads?.length ? fill(t.app.base.remoteHeads, { message: e.message, heads: heads.join(', ') }) : e);
            });
          }}
          onAcceptFix={async (issue) => {
            const go = await ask({
              title: fill(t.app.acceptFix.title, { issue }), icon: 'play',
              text: t.app.acceptFix.text,
              options: [{ value: true, label: t.app.acceptFix.confirm }],
            });
            if (go) api.acceptFix(activeProject, issue).catch(say);
          }}
          onStart={startTask}
          onPublishPr={(issue) => setTaskDialog({ project: activeProject, issue, kind: 'pr' })}
          // Like `onDraftCr`: the window opens first and the draft is asked for
          // after, so the person sees «redactando…» instead of a click that
          // seems to do nothing. A draft already made is not redone.
          onCloseIssue={(issue) => {
            setTaskDialog({ project: activeProject, issue, kind: 'close' });
            const t = visible.find((x) => x.issue === issue);
            if (!t?.hasClosingDraft || t?.closing?.status === 'failed') api.draftClose(activeProject, issue).catch(say);
          }}
          onAnswer={(issue) => setTaskDialog({ project: activeProject, issue, kind: 'answer' })}
          onReviewPlan={(issue) => setTaskDialog({ project: activeProject, issue, kind: 'plan' })}
          onSetApprovePlan={(issue, mode) => api.setApprovePlan(activeProject, issue, mode).catch(say)}
          onSetFixGaps={(issue, mode) => api.setFixGaps(activeProject, issue, mode).catch(say)}
          onSetFullTests={(issue, mode) => api.setFullTests(activeProject, issue, mode).catch(say)}
          onSetResolveConflicts={(issue, mode) => api.setResolveConflicts(activeProject, issue, mode).catch(say)}
          onSetDesign={(issue, on) => api.setDesign(activeProject, issue, on).catch(say)}
          onSetMode={(issue, mode) => api.setMode(activeProject, issue, mode).catch(say)}
          onStartCr={(issue) => api.startCr(activeProject, issue).catch(say)}
          onMergeMain={(issue) => inflight.current.run(actionKey('merge', activeProject, issue), () => conPendientes(() => api.mergeMain(activeProject, issue)))}
          onPush={(issue) => inflight.current.run(actionKey('push', activeProject, issue), () => api.push(activeProject, issue).catch(say))}
          onMergeHelp={async (issue) => {
            const go = await ask({
              title: t.app.mergeHelp.title, icon: 'message',
              text: t.app.mergeHelp.text,
              options: [{ value: true, label: t.app.mergeHelp.confirm }],
            });
            if (go) api.mergeHelp(activeProject, issue).then(() => openChat(activeProject, issue)).catch(say);
          }}
          // Like the other four openers: a panel opened while it is a rail
          // must be seen, and on a phone it must not stay collapsed.
          onOpenCr={(issue, reviewId) => { setCrView({ issue, reviewId }); side.expand(); }}
          onToggleActiveCr={(issue, reviewId, active) =>
            api.setActiveCr(activeProject, issue, reviewId, active).catch(say)}
          onDraftCr={(issue, reviewId) => {
            setCrView({ issue, reviewId });
            side.expand();
            api.draftCrReplies(activeProject, issue, reviewId).catch(say);
          }}
          onCreateWorktree={(issue) => api.createWorktree(activeProject, issue).catch(say)}
          onStartStack={(issue) => api.startStack(activeProject, issue).catch(say)}
          onStopStack={(issue) => api.stopStack(activeProject, issue).catch(say)}
          onDeleteWorktree={async (issue) => {
            const go = await ask({
              title: fill(t.app.deleteWorktree.title, { issue }), icon: 'trash',
              text: t.app.deleteWorktree.text,
              options: [{ value: true, label: t.app.deleteWorktree.confirm, tone: 'danger' }], cancel: t.app.reviewer.leave,
            });
            if (go) api.deleteWorktree(activeProject, issue).catch(say);
          }}
          onMove={(issue, to) => setMoveDialog({ issue, to })}
          onRetryMove={(issue) => api.retryMove(activeProject, issue).catch(say)}
          onDiscardMove={async (issue) => {
            const moving = visible.find((t) => t.issue === issue)?.moving;
            const go = await ask({
              title: fill(t.app.discardMove.title, { issue, to: moving ? fill(t.app.discardMove.to, { to: moving.to }) : '' }), icon: 'truck',
              text: fill(t.app.discardMove.text, { from: moving?.from ?? t.app.discardMove.fromFallback }),
              options: [{ value: true, label: t.app.discardMove.confirm, tone: 'warn' }], cancel: t.app.start.leave,
            });
            if (go) api.discardMove(activeProject, issue).catch(say);
          }}
          onDeletePlace={async (issue, machine) => {
            const go = await ask({
              title: fill(t.app.deletePlace.title, { issue, machine }), icon: 'trash',
              text: t.app.deletePlace.text,
              options: [{ value: true, label: t.common.delete, tone: 'danger' }], cancel: t.app.reviewer.leave,
            });
            if (go) api.deletePlace(activeProject, issue, machine).catch(say);
          }}
        />
      ) : (
        <NoProjectState onManage={() => setManageOpen(true)} onImport={() => setImportOpen(true)} />
      )}

      {movingTask && (
        <MoveDialog
          key={`${moveDialog.issue}:${moveDialog.to ?? ''}`}
          task={movingTask}
          machines={machines}
          machineStatus={machineStatus}
          initialTo={moveDialog.to}
          onClose={() => setMoveDialog(null)}
        />
      )}

      {modelsOpen && <ModelsDialog onClose={() => setModelsOpen(false)} />}
      {importOpen && (
        <ImportProjectDialog defaultAssignee={meta.github?.assignee ?? null} onClose={() => setImportOpen(false)} onImported={(p) => { setImportOpen(false); projectImported(p); }} />
      )}
      {manageOpen && (
        <ManageProjectsDialog
          projects={projects} activeProject={activeProject} onClose={() => setManageOpen(false)}
          onImport={() => setImportOpen(true)} onSelect={selectProject}
          onToggleRestricted={toggleRestricted} onRemove={removeProject}
        />
      )}
      {metricsOpen && <MetricsDialog project={activeProject} onClose={() => setMetricsOpen(false)} />}

      {reviewerSettings && !reviewerAsk && (
        <ReviewerDialog
          mode="settings"
          project={projects.find((p) => p.id === reviewerSettings) ?? { id: reviewerSettings }}
          search={searchReviewers}
          onPick={(login) => pickProjectReviewer(reviewerSettings, login)}
          onClear={() => clearProjectReviewer(reviewerSettings)}
          onCancel={() => setReviewerSettings(null)}
        />
      )}
      {reviewerAsk && (
        <ReviewerDialog
          project={projects.find((p) => p.id === reviewerAsk.project) ?? { id: reviewerAsk.project }}
          suggested={reviewerAsk.suggested}
          excludeLogin={reviewerAsk.excludeLogin}
          search={searchReviewers}
          onPick={pickReviewer}
          onCancel={() => askReviewer(null)}
        />
      )}

      {upgradeDialog && (
        <UpgradeDialog
          upgrade={upgrade}
          onState={writeUpgrade}
          onClose={() => setUpgradeDialog(false)}
        />
      )}

      {/* A task's own dialogs, from its card: a session's question, or the plan to approve. */}
      {dialogTask && taskDialog.kind === 'answer' && dialogTask.pending?.kind === 'question' && (
        <QuestionDialog
          questions={dialogTask.pending.questions}
          source={dialogTask.pending.source ?? 'claude'}
          who={`#${dialogTask.issue} · ${dialogTask.pending.phase ?? ''}`}
          preview={dialogTask.pending.preview ?? null}
          submitting={deciding}
          onSubmit={(answers) => decideTask(() => api.answerTask(dialogTask.project, dialogTask.issue, { id: dialogTask.pending.id, answers }))}
          onSkip={() => decideTask(() => api.answerTask(dialogTask.project, dialogTask.issue, { id: dialogTask.pending.id, decision: 'skip' }))}
          onDismiss={() => setTaskDialog(null)}
        />
      )}
      {dialogTask && taskDialog.kind === 'plan' && dialogTask.workPlan && (
        <PlanReview
          plan={dialogTask.workPlan}
          who={`#${dialogTask.issue}`}
          mode={dialogTask.state === 'plan_ready' ? 'review' : 'progress'}
          feedback={dialogTask.workPlan.feedback}
          busy={deciding}
          onApprove={(selected) => decideTask(() => api.decidePlan(dialogTask.project, dialogTask.issue, { decision: 'approve', selected }))}
          onRevise={(feedback) => decideTask(() => api.decidePlan(dialogTask.project, dialogTask.issue, { decision: 'revise', feedback }))}
          onContinue={() => decideTask(() => api.retry(dialogTask.project, dialogTask.issue))}
          onDismiss={() => setTaskDialog(null)}
        />
      )}
      {/* The PR parked for what its title says: editing it here publishes it.
          Once the server learns a PR number the park is gone, and so is this. */}
      {dialogTask && taskDialog.kind === 'pr' && dialogTask.prPark && (
        <PrTitleDialog
          key={dialogTask.issue}
          task={dialogTask}
          onClose={() => setTaskDialog(null)}
        />
      )}
      {/* Closing the issue with no PR: the agent proposes, the person edits,
          the person publishes. Keyed by `draftedAt` as well, so a fresh draft
          remounts the window instead of leaving the old one on screen. */}
      {dialogTask && taskDialog.kind === 'close' && (
        <CloseIssueDialog
          key={`${dialogTask.issue}:${dialogTask.closing?.draftedAt ?? ''}`}
          task={dialogTask}
          onClose={() => setTaskDialog(null)}
        />
      )}

      {sideOpen && (
        <aside className="side">
          {/* Drag the edge to resize; the tab collapses the panel to a rail so
              the board can use the whole window without closing anything. */}
          {!side.collapsed && (
            <div className="side-resizer" onPointerDown={side.startResize}
              title={t.app.side.resize} />
          )}
          <button className="btn btn-ghost btn-icon btn-sm side-toggle" onClick={collapseSide}
            title={side.phone ? t.app.side.closePanel : side.collapsed ? t.app.side.expandPanel : t.app.side.collapsePanel}
            aria-label={side.phone ? t.app.side.closePanel : side.collapsed ? t.app.side.expandPanel : t.app.side.collapsePanel}>
            {side.phone ? <Icon name="x"/> : side.collapsed ? <Icon name="chevron-left"/> : <Icon name="chevron-right"/>}
          </button>
          {chatTask && (
            <ChatPanel
              task={chatTask}
              chatId={chatView.chatId}
              tabs={(
                <TaskTabs
                  tabs={projectTabs}
                  tasks={visible}
                  holders={holders}
                  activeKey={taskKey(chatTask)}
                  // On the active tab this keeps the chat on screen and pins
                  // the tab back if another device had closed it.
                  onSelect={(project, issue) => openChat(
                    project, issue,
                    issue === chatTask.issue && project === chatTask.project
                      ? chatView.chatId
                      : lastChatOf(keyOf(project, issue)),
                  )}
                  onClose={closeTaskTab}
                  onSelectHolder={(project, machine) => openProjectChat(
                    project, machine,
                    chatTask.kind === 'project' && chatTask.project === project && chatTask.machine === machine
                      ? chatView.chatId
                      : lastChatOf(holderKey(project, machine)),
                  )}
                  onCloseHolder={closeProjectTab}
                  // A second collapse tab, at the right end of the strip: the
                  // one on the panel's left edge is far away when it is wide.
                  onCollapse={collapseSide}
                  phone={side.phone}
                />
              )}
              onSelectChat={(id) => {
                // Las pestañas «+» y «⑂» no son pestañas: son acciones que
                // crean una conversación y te llevan a ella.
                if (id === '+nuevo' || id.startsWith('+rama:')) {
                  const fork = id.startsWith('+rama:') ? id.slice('+rama:'.length) : null;
                  api.createChat(chatTask, fork)
                    .then((c) => showChat(c.id))
                    .catch(say);
                  return;
                }
                showChat(id);
              }}
              onClose={() => setChatView(null)}
              onSend={(chatId, text, attachments) =>
                wsRef.current?.sendChat(chatTask, chatId, text, attachments)}
              onCreateWorktree={(issue) => api.createWorktree(chatTask.project, issue).catch(say)}
              // The board's plan bubble in the chat opens the task's own plan
              // dialog, the same one as the card's «📝 Revisar plan».
              onReviewTaskPlan={() => setTaskDialog({ project: chatTask.project, issue: chatTask.issue, kind: 'plan' })}
              onRenewLogin={requestLoginRenew}
              models={models}
            />
          )}
          {qaTask && (
            <BrowserQaPanel
              task={qaTask}
              onClose={() => setQaIssue(null)}
              onStartStack={(issue) => api.startStack(qaTask.project, issue).catch(say)}
            />
          )}
          {demoTask && (
            <DemoPanel
              task={demoTask}
              onClose={() => setDemoIssue(null)}
              onStartStack={(issue) => api.startStack(demoTask.project, issue).catch(say)}
            />
          )}
          {crTask && (
            <ChangeRequestPanel
              task={crTask}
              reviewId={crView.reviewId}
              onClose={() => setCrView(null)}
              onDraft={(reviewId) => api.draftCrReplies(crTask.project, crTask.issue, reviewId).catch(say)}
              onDiscard={(reviewId) => api.discardCrReplies(crTask.project, crTask.issue, reviewId).catch(say)}
              pending={pending.has(actionKey('publish', crTask.project, `${crTask.issue}:${crView.reviewId}`))}
              onPublish={(reviewId) => {
                const publishKey = actionKey('publish', crTask.project, `${crTask.issue}:${reviewId}`);
                if (inflight.current.has(publishKey)) return;
                const cr = (crTask.changeRequests ?? []).find((c) => c.reviewId === reviewId);
                const n = (cr?.draftReplies ?? []).length;
                ask({
                  title: crTask.prNumber ? fill(t.app.publishCr.title, { n: crTask.prNumber }) : t.app.publishCr.titleNoPr, icon: 'note',
                  text: fill(t.app.publishCr.text, { replies: plural(n, t.app.publishCr.replies), author: cr?.author }),
                  options: [{ value: true, label: t.app.publishCr.confirm, tone: 'warn' }],
                }).then((go) => {
                  if (!go) return;
                  // The re-request goes to the change request's author, so a
                  // `needsReviewer` reply is not expected; if one comes, say so.
                  inflight.current.run(publishKey, () => conPendientes((force) => api.resolveCr(crTask.project, crTask.issue, reviewId, force))
                    .then((r) => { if (r?.needsReviewer) notice({ title: t.app.reviewer.missingTitle, text: t.app.reviewer.missingText }); }));
                });
              }}
            />
          )}
          {logTask && <LogPanel task={logTask} onClose={() => setLogIssue(null)} />}
          {timelineTask && <TimelinePanel task={timelineTask} onClose={() => setTimelineIssue(null)} />}
        </aside>
      )}
    </div>
  );
}
