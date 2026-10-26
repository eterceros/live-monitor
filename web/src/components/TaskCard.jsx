import React, { useEffect, useRef, useState } from 'react';
import { meta, modeMeta, BUSY_STATES, moveStepLabel, phaseLabel, latestPhaseModel } from '../status.js';
import Icon from './Icon.jsx';
import { cardId } from '../taskKey.js';
import { actionKey } from '../inflight.js';
import { highlightNumberRange, highlightRanges } from '../boardFilter.js';
import LoginCard from './LoginCard.jsx';
import { approx, runCount } from './BackgroundStrip.jsx';
import { countdown } from './QuotaChip.jsx';
import { laneSummary } from './PlanReview.jsx';
import { formatMs } from '../metricsView.js';
import { isPublishQuestion } from '../publishQuestion.js';
import Pill from './ui/Pill.jsx';
import Chip from './ui/Chip.jsx';
import ExpandButton from './ui/ExpandButton.jsx';
import UnitBar from './charts/UnitBar.jsx';
import './prPicker.css';
import DecisionGroup from './card/DecisionGroup.jsx';
import WorkGroup, { ChatButton, PlanButton } from './card/WorkGroup.jsx';
import CodeGroup, { ReadyButton, PrLink } from './card/CodeGroup.jsx';
import EnvGroup, { PlacesList } from './card/EnvGroup.jsx';
import SettingsGroup from './card/SettingsGroup.jsx';
import DangerGroup from './card/DangerGroup.jsx';
import { readHoverDelay, onHoverDelayChange } from '../cardHover.js';
import { nextTap, TAP_SLOP_PX, TAP_IGNORE } from '../doubleTap.js';
import { useStrings } from '../i18n/useStrings.js';
import { fill, plural, splitAround, strings } from '../i18n/index.js';

/** «ya estaba cubierto» / «descartada» / «duplicada de #N», or null when the
 * record carries no reason — an old task, or a close that never happened. */
function closeReasonLabel({ reason, duplicateOf } = {}) {
  const t = strings().board.card.closeReason;
  if (reason === 'completed') return t.completed;
  if (reason === 'not_planned') return t.notPlanned;
  if (reason !== 'duplicate') return null;
  // GitHub takes a number, but the record may hold it written as «#1274».
  const other = duplicateOf == null ? null : String(duplicateOf).replace(/^#/, '');
  return other ? fill(t.duplicateOf, { other }) : t.duplicate;
}

/**
 * What is moving on the task, in one line: work in the background, the waves'
 * progress, the board's plan, the longest wait, and servers up.
 */
function runningParts(running) {
  const t = strings().board.card;
  const { n } = runCount(running);
  const waits = [running.estimateMs, running.plan?.estimateMs].filter((ms) => ms != null);
  return [
    n > 0 && { icon: 'refresh', text: fill(t.inBackground, { n }) },
    running.agents.total > 0 && { text: fill(t.agentsDone, running.agents) },
    running.plan && { text: fill(t.planOf, running.plan) },
    waits.length > 0 && { text: approx(Math.max(...waits)) },
    running.servers > 0 && { icon: 'dot', text: fill(t.serving, { n: running.servers }) },
  ].filter(Boolean);
}

/** The same line as plain text, for the hover title. */
function runningLine(running) {
  return runningParts(running).map((x) => x.text).join(' · ');
}

/**
 * The live block of a running card: subagents with their bar, the board's plan
 * and what serves. The same figures as `runningLine`, drawn instead of written.
 */
function RunningBlock({ running }) {
  const t = useStrings().board.card;
  const { agents, plan, servers } = running;
  const { n } = runCount(running);
  const waits = [running.estimateMs, plan?.estimateMs].filter((ms) => ms != null);
  const hasAgents = agents.total > 0;
  const hasFoot = Boolean(plan) || servers > 0 || n > 0;
  if (!hasAgents && !hasFoot && waits.length === 0) return null;
  return (
    <div className="tc-live-block" title={runningLine(running)}>
      {(hasAgents || waits.length > 0) && (
        <div className="tc-live-row">
          {hasAgents
            ? <span className="tc-live-item"><Icon name="bot" /><span>{splitAround(t.agentsOf, { done: agents.done, total: agents.total }).map((p) => (p.hole === 'done' ? <b key={p.key}>{p.text}</b> : p.text))}</span></span>
            : <span />}
          {waits.length > 0 && <span className="tc-live-est">{approx(Math.max(...waits))}</span>}
        </div>
      )}
      {hasAgents && (
        <UnitBar done={agents.done} running={agents.running ?? 0} total={agents.total} width={256} height={6}
          label={fill(agents.running ? t.agentsBarRunning : t.agentsBar, { done: agents.done, total: agents.total, running: agents.running })} />
      )}
      {hasFoot && (
        <div className="tc-live-row tc-live-foot">
          {plan ? <span className="tc-live-item"><Icon name="clipboard" /><span>{fill(t.planOf, plan)}</span></span>
            : n > 0 ? <span className="tc-live-item"><Icon name="refresh" /><span>{fill(t.inBackground, { n })}</span></span> : <span />}
          {servers > 0 && <span className="tc-live-item"><Icon name="server" /><span>{fill(t.serving, { n: servers })}</span></span>}
        </div>
      )}
    </div>
  );
}

/** `text` with the parts the board search matched wrapped in <mark>. */
export function Highlighted({ text, parsed }) {
  const ranges = parsed ? highlightRanges(text, parsed) : [];
  if (!ranges.length) return text;
  const out = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) out.push(text.slice(at, a));
    out.push(<mark className="hit" key={i}>{text.slice(a, b)}</mark>);
    at = b;
  });
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/**
 * «Cambiar rama base», in the error area of a worktree that failed for its
 * base (`empty_repo`, `base_missing`). `base_missing` offers one button per
 * remote head (`errorInfo.remoteHeads` can be stale: the server's ls-remote
 * decides); `empty_repo` has nothing to pick from, so it takes a name. Both
 * go through the board's confirm dialog (`onChangeBase`, in `App`).
 */
function ChangeBaseControl({ task, onChangeBase }) {
  const t = useStrings().board.card;
  const current = task.errorInfo?.base ?? 'main';
  const heads = task.errorCode === 'base_missing' ? (task.errorInfo?.remoteHeads ?? []).filter((h) => h !== current) : [];
  const [draft, setDraft] = useState(current);
  const name = draft.trim();
  return (
    <div className="tc-change-base">
      <p className="tc-line">{splitAround(t.baseCurrent, { base: current }).map((p) => (p.hole ? <b key={p.key}>{p.text}</b> : p.text))}</p>
      {task.errorCode === 'base_missing' ? (
        <div className="tc-change-row">
          {heads.map((h) => (
            <button key={h} type="button" className="btn btn-warn btn-sm" onClick={() => onChangeBase(task.issue, h, current)}>{fill(t.useBase, { head: h })}</button>
          ))}
        </div>
      ) : (
        <div className="tc-change-row">
          <input type="text" className="tc-change-input" value={draft} aria-label={t.baseAria} spellCheck={false}
            onChange={(e) => setDraft(e.target.value)} />
          <button type="button" className="btn btn-warn btn-sm" disabled={!name || name === current}
            onClick={() => onChangeBase(task.issue, name, current)}>{t.change}</button>
        </div>
      )}
    </div>
  );
}

// Grace before a hover-opened card shortens again once the pointer is gone. The
// rest before it opens is the user's choice (readHoverDelay, 0 = off).
const HOVER_LEAVE_MS = 150;

export default function TaskCard({
  task, compact, parsed, inflightKeys, onChat, onDemo, onLog, onTimeline, onReady, onReviewer, onRetry, onBootstrapRepo, onChangeBase, onDeleteWorktree,
  onCreateWorktree, onStartStack, onStopStack, onStart, onToggleManual,
  onOpenCr, onToggleActiveCr, onDraftCr, onStartCr, onSetMode, onMergeMain, onPush, onMergeHelp,
  machines = [], onSetMachine, onQa, onSetBrowserQa, onSetDemo, onAcceptFix, onPublishPr, onCloseIssue,
  onAnswer, onReviewPlan, onSetApprovePlan, onSetFixGaps, onSetFullTests, onSetResolveConflicts, onSetDesign,
  onMove, onRetryMove, onDiscardMove, onDeletePlace,
  quota = null, quotaNow = null, onRenewLogin = null, onOpenSettings = null,
}) {
  const strs = useStrings();
  const t = strs.board.card;
  const worktreeDelete = strs.card.danger.worktreeDelete;
  const info = meta(task.state);
  const busy = BUSY_STATES.includes(task.state);
  const phaseModel = latestPhaseModel(task);
  // Something waiting on you: a question from a session, a plan to approve.
  const pending = task.pending ?? null;
  const chatPending = (task.chats ?? []).filter((c) => c.pending && !c.closedAt).length;
  const waiting = (task.awaitingYou ?? []).length > 0;
  const waitingSince = pending?.askedAt ? Math.max(1, Math.round((Date.now() - Date.parse(pending.askedAt)) / 60000)) : null;
  // The account's usage window ran out and the board parked this task where it
  // stood; it starts it again by itself. Nobody is waiting on you, so this
  // card carries no ❓ — and, because everything amber here means «click me»,
  // the card writes out in words that there is nothing to press. The clock is
  // the board's single one (`useQuotaClock` in `App`), handed down as `quotaNow`.
  const park = task.quotaPark ?? null;
  const quotaLeft = park ? countdown(quota?.until, quotaNow ?? Date.now()) : null;
  const parkedAt = park ? phaseLabel(park.resumeFrom) : null;
  // Where it runs. Chosen before anything exists there; once a worktree does,
  // the task lives on that machine and the card just says so.
  const machine = task.machine ?? 'local';
  const canPickMachine = machines.length > 1 && !task.hasWorktree && !busy && !task.chatBusy;
  // Para las acciones de git cuenta también el chat: el servidor las rechaza
  // mientras haya un turno en marcha, y un botón que falla no es un botón.
  const gitBusy = BUSY_STATES.includes(task.state) || Boolean(task.chatBusy);
  // A request of this card's own is in flight: its button must not send another.
  const inFlight = (action) => Boolean(inflightKeys?.has(actionKey(action, task.project, task.issue)));
  const mode = task.mode ?? 'auto';
  const chats = task.chats ?? [];
  const chatsBusy = chats.filter((c) => c.busy).length;
  const modeInfo = modeMeta(mode);
  const stack = task.stack;
  const services = Object.values(stack?.services ?? {});
  // Every PR the branch has ever had, newest first — falling back to the
  // classifier's cache for a record from before `task.prs` existed, and
  // finally to a single made-up entry from the legacy `prUrl`/`prNumber`
  // fields so an ancient task still shows a link instead of nothing.
  const knownPrs = task.prs?.length ? task.prs : (task.existingWork?.prs ?? []);
  const prList = knownPrs.length > 0 ? knownPrs
    : (task.prUrl ? [{ number: task.prNumber, url: task.prUrl, title: null, state: null, createdAt: null }] : []);
  // The picker remembers what you chose, but only until the newest PR
  // changes under it — a new draft, a reopened cycle — at which point it
  // snaps back to that one instead of pointing at a PR from a cycle that's
  // already gone.
  const [selectedPrNumber, setSelectedPrNumber] = useState(prList[0]?.number ?? null);
  // Lengthened in place, inside its own column: the extra controls are the
  // `tc-groups` below the body, never a second copy of it.
  // Two ways open: a click PINS it (stays until the button shortens it); resting
  // the pointer on the card for the chosen delay opens it only while it is over it.
  const [expanded, setExpanded] = useState(false);
  const pinned = useRef(false);
  // Set when the user collapses with the button: the pointer is still over the
  // card, so hover must not re-open it until the pointer leaves.
  const suppressHover = useRef(false);
  const hoverTimer = useRef(null);
  const leaveTimer = useRef(null);
  const expandedRef = useRef(false);
  expandedRef.current = expanded;
  // True from the moment the hover timer opens the card (set synchronously, so a
  // leave before the re-render still collapses it) until it closes or is pinned.
  const hoverOpened = useRef(false);
  // The rest the user chose, kept fresh without re-rendering; 0 = hover off.
  const hoverMs = useRef(readHoverDelay());
  useEffect(() => {
    hoverMs.current = readHoverDelay();
    return onHoverDelayChange(() => { hoverMs.current = readHoverDelay(); });
  }, []);
  const clearTimers = () => {
    clearTimeout(hoverTimer.current);
    clearTimeout(leaveTimer.current);
    hoverTimer.current = null;
    leaveTimer.current = null;
  };
  useEffect(() => clearTimers, []);
  const armHover = (e) => {
    clearTimeout(leaveTimer.current);
    clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    if (e.pointerType !== 'mouse' || suppressHover.current) return;
    if (hoverMs.current <= 0 || expandedRef.current || e.buttons !== 0) return;
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      if (expandedRef.current || pinned.current) return;
      hoverOpened.current = true;
      setExpanded(true);
    }, hoverMs.current);
  };
  // Pointer left (or was lost): cancel a pending open; close what hover opened.
  const onCardLeave = () => {
    suppressHover.current = false;
    clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    tapStart.current = null;
    if (pinned.current || !(hoverOpened.current || expandedRef.current)) return;
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null;
      if (pinned.current) return;
      hoverOpened.current = false;
      setExpanded(false);
    }, HOVER_LEAVE_MS);
  };
  const toggleExpanded = () => {
    clearTimers();
    hoverOpened.current = false;
    if (expandedRef.current) { pinned.current = false; suppressHover.current = true; setExpanded(false); } else { pinned.current = true; setExpanded(true); }
  };
  // Touch / pen: a double tap on the card body toggles it like the button does.
  const lastTap = useRef(null);
  const tapStart = useRef(null);
  const onTapDown = (e) => {
    if (e.pointerType === 'mouse') return;
    tapStart.current = e.target.closest?.(TAP_IGNORE) ? null : { x: e.clientX, y: e.clientY };
    if (!tapStart.current) lastTap.current = null;
  };
  const onTapMove = (e) => {
    if (e.pointerType === 'mouse' || !tapStart.current) return;
    if (Math.hypot(e.clientX - tapStart.current.x, e.clientY - tapStart.current.y) > TAP_SLOP_PX) {
      tapStart.current = null; lastTap.current = null; // the finger scrolled
    }
  };
  const onTapUp = (e) => {
    if (e.pointerType === 'mouse') return;
    const start = tapStart.current;
    tapStart.current = null;
    if (!start) return;
    const r = nextTap(lastTap.current, { t: e.timeStamp, x: e.clientX, y: e.clientY });
    lastTap.current = r.last;
    if (r.double) toggleExpanded();
  };
  const onTapCancel = (e) => {
    if (e.pointerType === 'mouse') return;
    tapStart.current = null; lastTap.current = null;
  };
  useEffect(() => {
    setSelectedPrNumber(prList[0]?.number ?? null);
  }, [prList[0]?.number]);
  const selectedPr = prList.find((p) => p.number === selectedPrNumber) ?? prList[0] ?? null;
  // The checks light belongs to the cycle's own PR, not to whichever old one
  // you happen to be looking at in the combobox.
  const showPrChecks = Boolean(selectedPr && task.prNumber && selectedPr.number === task.prNumber);
  // A task classified from GitHub has no branch of its own yet; show the one
  // the issue already carries, preferring the local checkout's name.
  const changeRequests = (task.changeRequests ?? []).filter((c) => c.status !== 'superseded');
  const activeCr = changeRequests.find((c) => c.reviewId === task.activeChangeRequest) ?? null;
  // Git state comes from the poll, and only for a worktree that really exists —
  // `hasWorktree` is just "the path is a string", which a leftover folder passes.
  const git = task.branchStatus ?? null;
  const behind = git?.behind ?? 0;
  const unpushed = git?.unpushed;                 // null = no remote branch yet
  const canPush = unpushed === null || unpushed > 0;
  const checks = task.checks ?? null;
  const light = !checks || checks.total === 0 || checks.stale ? null
    : checks.failed ? 'fail' : checks.pending ? 'pending' : 'ok';
  const known = task.existingWork?.branches ?? [];
  const branch = task.branch ?? known.find((b) => !b.startsWith('origin/')) ?? known[0] ?? null;
  // Moving between machines: in flight, failed, and what it left behind.
  const moving = task.moving ?? null;
  const movingLive = Boolean(moving && !moving.error);
  // A failed move that already arrived is finished only by «Reintentar mudanza»:
  // a new move from here would overwrite its half-done record.
  const canMove = machines.length > 1 && task.hasWorktree && !busy && !task.chatBusy
    && (!moving || Boolean(moving.error && !moving.arrived));
  const placesLocked = gitBusy || Boolean(moving?.error && moving.step === 'chats');
  const goBack = canMove && task.previousMachine && task.previousMachine !== machine ? task.previousMachine : null;
  const otherPlaces = (task.places ?? []).filter((p) => p.machine !== machine);
  const parked = otherPlaces.filter((p) => p.hasWorktree);
  const prewarm = task.prewarm && task.prewarm.machine === machine ? task.prewarm : null;
  // The board writing a plan: the first one, or a new version after «Pedir cambios».
  const planning = task.planning ?? null;
  const readyPlan = task.state === 'plan_ready' ? task.workPlan ?? null : null;
  // «🚀 Arrancar tarea»: any task at rest can be worked now, autostart on or
  // off, manual or not. An unconfirmed one is answered with 🤖/✋ first. A
  // move holds it while live and when it failed at `chats`, as the server's
  // `movingReason` does.
  // Where the run died. Only a stopped task has a phase to blame: while it
  // works, `phase` is where it *is*, and naming it as a failure would lie.
  const failedAt = task.state === 'error' ? phaseLabel(task.phase) : null;
  // Publishing the PR (or any resumed run) leaves the task in `error` until it
  // lands, so the card would keep offering three ways to launch it again on a
  // task that is already working. A board that does not send this field yet
  // says nothing, and the card behaves exactly as it did before.
  const rerunning = task.state === 'error' && task.pipelineRunning === true;
  // The PR that could not be published for what its title says: the proposal
  // waits on the card until it is edited and sent from «📝 Publicar PR». A
  // task that already has a PR has nothing to publish, whatever the park says.
  const prPark = task.state === 'error' && !rerunning && !task.prNumber ? task.prPark ?? null : null;
  // A Browser QA that stopped before checking everything: the PR still opens,
  // so the card is the only place that says how much of it was really seen.
  const qaCounts = task.qaVerdict === 'unverified' ? task.qaCounts ?? null : null;
  const qaChecked = qaCounts ? qaCounts.passed ?? 0 : 0;
  const qaTotal = qaCounts ? (qaCounts.passed ?? 0) + (qaCounts.failed ?? 0) + (qaCounts.unverified ?? 0) : 0;
  const priorWork = ['started', 'waiting_approval', 'done'].includes(task.state);
  // `priorWork` holds `done`, so without the last term the card would offer
  // «🚀 Arrancar tarea» on an issue already closed without a PR: a worktree and
  // a whole fix cycle over work that was decided not to need any.
  const canStart = (task.state === 'assigned' || priorWork) && !busy && !task.chatBusy
    && mode !== 'unconfirmed' && !(moving && (!moving.error || moving.step === 'chats'))
    && !task.closedWithoutPr;
  // Closing the issue without a PR. Every term earns its place:
  // - `!compact`: `Board.jsx` hands these same props to the compact cards of
  //   the «✅ Completadas» strip, where an action means nothing.
  // - no PR of any kind: a task whose PR merged without closing its issue
  //   (#787, the hint below the title) is not this case — there *was* a
  //   change, and «cerrada sin PR» would lie about it.
  // - `!busy && !task.chatBusy`: drafting resumes the chat's session and the
  //   server rejects that with a turn in flight. A button that fails is not a
  //   button. Same reason a parked or moving task is left alone.
  const anyPr = prList.some((p) => ['DRAFT', 'OPEN', 'MERGED'].includes(p.state));
  const canCloseIssue = !compact && !busy && !task.chatBusy && !park && !movingLive
    && task.state !== 'done' && !task.closedWithoutPr && !task.issueClosed
    && !task.prNumber && !anyPr;
  // The drafting session runs inside the worktree — that is what lets it cite
  // real paths — and publishing is already in flight once it started.
  const closePublishing = task.closing?.status === 'publishing';
  const closeBlocked = !task.hasWorktree || closePublishing;
  const closeWhy = task.closable?.why ?? null;
  // The cycle's PR if it is still live. Derived, never stored: the day it
  // merges the hints below stop saying anything, with no field to clear and
  // none to go stale. Same pair of states the server calls `isOpenPr`.
  const openPr = prList.find((p) => p.state === 'OPEN' || p.state === 'DRAFT');
  const closedReason = task.closedWithoutPr ? closeReasonLabel(task.closing ?? {}) : null;
  const closedKept = task.closing?.cleanup?.worktree === 'kept';
  const closedLine = closedReason ? fill(t.closedNoPrWhy, { why: closedReason }) : t.closedNoPr;
  // What the Demo switch shows: the server's resolved answer (own choice, else
  // the project's); the raw mode only for a payload that predates `demoWanted`.
  const demoOn = task.demoWanted ?? task.demo !== 'off';

  // What the control groups in `card/` read. The derivations stay here, once,
  // so a group never recomputes what the card already knows.
  const m = {
    info, busy, phaseModel, pending, chatPending, waiting, waitingSince, park, quotaLeft, parkedAt, machine,
    canPickMachine, gitBusy, inFlight, mode, chats, chatsBusy, modeInfo, stack, services, prList, selectedPr,
    selectedPrNumber, setSelectedPrNumber, showPrChecks, changeRequests, activeCr, git, behind, unpushed, canPush,
    checks, light, branch, moving, movingLive, canMove, placesLocked, goBack, otherPlaces, parked, prewarm, planning,
    readyPlan, failedAt, rerunning, prPark, qaCounts, qaChecked, qaTotal, priorWork, canStart, canCloseIssue,
    closePublishing, closeBlocked, closeWhy, openPr, demoOn,
  };
  const h = {
    onChat, onDemo, onLog, onTimeline, onReady, onReviewer, onRetry, onDeleteWorktree, onCreateWorktree,
    onStartStack, onStopStack, onStart, onToggleManual, onOpenCr, onToggleActiveCr, onDraftCr, onStartCr, onSetMode,
    onMergeMain, onPush, onMergeHelp, machines, onSetMachine, onQa, onSetBrowserQa, onSetDemo, onAcceptFix, onPublishPr,
    onCloseIssue, onAnswer, onReviewPlan, onSetApprovePlan, onSetFixGaps, onSetFullTests, onSetResolveConflicts, onSetDesign, onMove, onRetryMove,
    onDiscardMove, onDeletePlace, onRenewLogin, onOpenSettings,
  };

  // A finished card (the «Completadas» strip, or any `done` task) keeps its
  // worktree delete in reach while shortened; same gate as the Danger group.
  const canTrash = (compact || task.state === 'done') && task.hasWorktree && !busy;
  const cid = cardId(task.project, task.issue);
  // The compact card of the «Completadas» strip stays short until lengthened.
  const rich = !compact || expanded;
  // The question a session is asking, when the board sends it with `pending`
  // (`publicTask` copies the whole record, `questions` included).
  const questionText = pending?.kind === 'question' ? pending.questions?.[0]?.question ?? null : null;
  // «Si no contestas, Claude decide solo» is false for the Artifact gate: with
  // no answer nothing is published.
  const waitTitle = fill(isPublishQuestion(pending?.questions) ? t.waitTitlePublish : t.waitTitle, { min: waitingSince });
  const pillTone = { busy: 'live', warn: 'warn', ok: 'ok', error: 'danger', idle: 'idle', done: 'neutral' }[info.tone] ?? 'neutral';
  const askDot = waiting && (
    <span className="tc-ask" role="img" aria-label={t.decisionWaits} title={t.decisionWaits}><Icon name="help-circle" /></span>
  );
  const cls = ['tc', `tc-${info.tone}`, compact && 'tc-compact', expanded && 'is-expanded', waiting && 'tc-waiting',
    task.state === 'error' && 'tc-error', busy && 'tc-live'].filter(Boolean).join(' ');

  return (
    <article id={cid} className={cls} onPointerEnter={armHover} onPointerMove={(e) => { armHover(e); onTapMove(e); }} onPointerLeave={onCardLeave} onPointerCancel={(e) => { onCardLeave(e); onTapCancel(e); }} onPointerDown={onTapDown} onPointerUp={onTapUp}>
      <div className="tc-head">
        <a className="tc-issue" href={task.url} target="_blank" rel="noreferrer" title={t.openIssue}>{highlightNumberRange(String(task.issue), task, parsed) ? <mark className="hit">#{task.issue}</mark> : `#${task.issue}`}</a>
        {movingLive ? (
          <Pill tone="live" live icon="truck" title={fill(t.movingFrom, { from: moving.from })}>{fill(t.movingTo, { to: moving.to })}</Pill>
        ) : park ? (
          /* No live dot: nothing is moving. The window is shut and the board
             is doing exactly nothing until it reopens. */
          <Pill tone="idle" icon="hourglass"
            title={[parkedAt ? fill(t.quotaPausedAt, { phase: parkedAt }) : t.quotaPaused,
              quotaLeft ? fill(t.quotaResumesAt, quotaLeft) : t.quotaResumesLater, t.quotaNothing].join(' ')}>
            {quotaLeft ? fill(t.quotaPillLeft, { left: quotaLeft.left }) : t.quotaPill}
          </Pill>
        ) : planning ? (
          <Pill tone="live" live icon="note" title={planning.kind === 'revise' ? t.planningRevise : t.planningFirst}>
            {fill(planning.kind === 'revise' ? t.replanning : t.planning, { version: planning.version ?? 1 })}{askDot}
          </Pill>
        ) : pending?.kind === 'question' ? (
          <Pill tone="warn" icon="help-circle" title={waitTitle}>
            {waitingSince ? fill(t.awaitingAnswerMin, { min: waitingSince }) : t.awaitingAnswer}
          </Pill>
        ) : (
          <Pill tone={pillTone} live={busy} icon={info.icon}>{info.label}{askDot}</Pill>
        )}
        <span className="tc-spacer" />
        <ExpandButton expanded={expanded} onToggle={toggleExpanded} controls={`${cid}-controls`} />
      </div>

      <p className="tc-title"><Highlighted text={task.title} parsed={parsed} /></p>
      {branch && <code className="tc-branch" title={branch}>{branch}</code>}

      {rich && (
        <div className="tc-chips">
          {waitingSince != null && !park && pending?.kind !== 'question' && (
            <Chip tone="warn" icon="hourglass" title={fill(t.waitingChipTitle, { min: waitingSince })}>{waitingSince} min</Chip> /* i18n-ok: a bare unit */
          )}
          {busy && task.timing?.wallMs != null && (
            <Chip tone="live" icon="timer" title={t.wallTitle}>{formatMs(task.timing.wallMs)}</Chip>
          )}
          {task.reopenedAt && !task.prNumber && (
            /* A secondary badge, not a replacement for the status pill above:
               the pill still says what the task is doing (assigned, fixing…),
               this just adds that the cycle started from a reopened issue. It
               goes away on its own once the cycle gets its own PR — the
               contract clears `reopenedAt` in `draftPrPhase`. */
            <Chip icon="recycle" title={t.reopenedTitle}>{t.reopened}</Chip>
          )}
          {task.unassigned && !task.unassigned.settled && (
            <Chip tone="warn" icon="user"
              title={t.unassignedTitle}>
              {(task.unassigned.to ?? []).length > 0
                ? fill(t.reassignedTo, { to: task.unassigned.to.join(', ') })
                : t.unassigned}
            </Chip>
          )}
          {modeInfo && (
            <Chip tone="warn" icon={modeInfo.icon}
              title={mode === 'manual' ? t.manualTitle : t.unconfirmedTitle}>
              {modeInfo.label.toLowerCase()}
            </Chip>
          )}
          {task.userRun === true && (
            <Chip icon="hand" title={t.oneOffTitle}>{t.oneOff}</Chip>
          )}
          {task.complexity && (
            <Chip icon="layers" title={task.complexity === 'complex' ? t.triageAdvisor : t.triageNoAdvisor}>
              {task.complexity === 'complex' ? t.complexAdvisor : t.simple}
            </Chip>
          )}
          {phaseModel && (
            <Chip icon="brain" title={fill(t.lastSession, { phase: phaseLabel(phaseModel.phase) ?? phaseModel.phase })}>{phaseModel.label}</Chip>
          )}
          {(machine !== 'local' || otherPlaces.length > 0) && (
            <Chip icon="map-pin" title={fill(t.runsOn, { machine })}>{machine}</Chip>
          )}
          {task.design === true && (
            <Chip tone="violet" icon="palette" title={t.designTitle}>{t.design}</Chip>
          )}
        </div>
      )}
      {!expanded && <PlacesList task={task} m={m} h={h} />}

      {questionText && rich && !expanded && (
        <blockquote className="tc-quote"><Icon name="help-circle" /><span>{questionText}</span></blockquote>
      )}
      {task.state === 'done' && task.issueClosed === false && !task.closedWithoutPr && (
        /* #787: a PR can merge without closing its issue. The task still
           reads «Completada», but the issue itself is still open on GitHub —
           this is the only place that says so, in the strip too (compact
           renders this same line), so it does not silently look finished. */
        <p className="tc-line tc-line-muted pr-issue-open">{t.mergedIssueOpen}</p>
      )}
      {task.state === 'done' && task.issueClosed && openPr && !task.closedWithoutPr && (
        /* The third ending, and the quietest one: somebody closed the issue on
           GitHub while this pull request was still open. Nobody is watching it
           any more — the card is `done`, so its checks light goes out — and no
           merge ever happened, so neither of the two lines around this one
           applies. This is the only thing that will tell a human the PR is
           still sitting there. Information, not an action: the compact card in
           the strip renders it too. */
        <p className="tc-line tc-line-muted closed-open-pr">
          {splitAround(openPr.state === 'DRAFT' ? t.closedOpenPrDraft : t.closedOpenPrOpen, { pr: `#${openPr.number}` })
            .map((p) => (p.hole && openPr.url
              ? <a key={p.key} href={openPr.url} target="_blank" rel="noreferrer" title={t.closedOpenPrTitle}>{p.text}</a>
              : p.text))}
        </p>
      )}
      {task.state === 'done' && task.issueClosed && !openPr && !task.closedWithoutPr
        && !prList.some((p) => p.state === 'MERGED' || p.state == null) && (
        /* #937's shape: the issue was closed on GitHub, the board did not close
           it itself, and nothing on the branch ever merged. Without this line
           the card sits in «Completadas» looking exactly like merged work. A PR
           with no state at all is one adopted from an old record: we cannot see
           whether it merged, so the line says nothing rather than guess. */
        <p className="tc-line tc-line-muted closed-no-merge">{t.closedNoMerge}</p>
      )}
      {task.closedWithoutPr && (
        /* The other half of the pair above: this issue was closed *without* a
           PR, and the task then sits in «Completadas» like any merged one —
           only this line says which of the two endings it was. Information,
           not an action, so the compact card in the strip renders it too; and
           a kept worktree is exactly what you need to know right after,
           because nobody is going to clean it up for you. */
        <p className="tc-line tc-line-muted closed-no-pr">
          {task.closing?.commentUrl
            ? (
              <a href={task.closing.commentUrl} target="_blank" rel="noreferrer"
                title={t.closedCommentTitle}>
                {closedLine}
              </a>
            )
            : closedLine}
          {closedKept && (
            <span className="closed-kept"
              title={task.closing?.cleanup?.why ?? t.keptTitle}>
              {' · '}{task.closing?.cleanup?.why ? fill(t.keptWhy, { why: task.closing.cleanup.why }) : t.kept}
            </span>
          )}
        </p>
      )}
      {rich && park && (
        /* Mid-move the two readings would contradict each other — the pill
           says «Mudando», this says «en pausa» — so the line puts them in
           order: the move is what is happening, the pause is what is left
           when it lands. A move is git and git does not need Claude. */
        <p className="tc-line tc-line-muted"
          title={[t.parkTitleLead, movingLive && fill(t.parkMoveEnds, { to: moving.to }),
            fill(quotaLeft ? t.parkResumesAt : t.parkResumesLater, { phase: parkedAt ?? t.parkWhereLeft, ...quotaLeft })]
            .filter(Boolean).join(' ')}>
          <Icon name="pause" /> {fill(movingLive ? t.parkLineMoving : t.parkLine, { phase: parkedAt ?? t.parkWhere })}
          {' · '}{quotaLeft ? fill(t.parkResumesAtShort, { at: quotaLeft.at }) : t.parkResumesReopen}
          <span className="tc-nothing"> · {t.parkNothing}</span>
        </p>
      )}
      {rich && planning?.feedback && (
        <p className="tc-line" title={planning.feedback}><Icon name="pencil" /> {fill(t.feedback, { text: planning.feedback })}</p>
      )}
      {rich && !expanded && mode === 'unconfirmed' && task.suspect && (
        <p className="tc-suspect">
          {task.suspect.where === 'etiqueta' ? t.suspectInLabel : task.suspect.where === 'cuerpo' ? t.suspectInBody : t.suspectInTitle}{/* i18n-ok: server codes */}
          <q>{task.suspect.quote}</q>
          {t.suspectNothing}
        </p>
      )}
      {rich && busy && activeCr && (
        <p className="tc-line tc-line-live">{fill(t.fixingCr, { author: activeCr.author })}</p>
      )}
      {rich && movingLive && <p className="tc-line tc-line-live"><Icon name="truck" /> {fill(t.movingLine, { to: moving.to, step: moveStepLabel(moving) })}</p>}
      {rich && task.running && <RunningBlock running={task.running} />}
      {rich && busy && task.lastLine && <p className="tc-last" title={task.lastLine}>{task.lastLine}</p>}
      {rich && prewarm && !prewarm.endedAt && <p className="tc-line tc-line-muted"><Icon name="flame" /> {fill(t.prewarming, { machine: prewarm.machine })}</p>}
      {rich && prewarm?.endedAt && prewarm.ok === false && (
        <p className="tc-line tc-line-warn">{splitAround(t.prewarmFailed, { log: 'Log' }).map((p) => (p.hole ? <React.Fragment key={p.key}><Icon name="scroll" /> {p.text}</React.Fragment> : p.text))}</p> /* i18n-ok: Log is the button's name */
      )}
      {rich && prewarm?.endedAt && prewarm.ok === null && <p className="tc-line tc-line-muted">{t.prewarmInterrupted}</p>}
      {rich && task.waitingOn === 'install' && <p className="tc-line tc-line-muted"><Icon name="hourglass" /> {t.waitingInstall}</p>}
      {rich && canCloseIssue && task.closable && (
        /* A turn in the chat concluded that nothing needs changing. It is a
           suggestion, not a verdict: the line only points at the button, and
           nothing reaches GitHub until you confirm what the agent drafts. */
        <p className="tc-line tc-line-muted" title={closeWhy ?? undefined}>
          <Icon name="lock" /> {closeWhy ? fill(t.closableWhy, { why: closeWhy }) : t.closable}
        </p>
      )}
      {rich && !expanded && readyPlan && (
        <p className="tc-line tc-line-strong"><Icon name="clipboard" /> {splitAround(fill(plural(readyPlan.tasks.length, readyPlan.waves?.length > 0 ? t.planReadyLanes : t.planReady), { version: readyPlan.version ?? 1 }), { lanes: '' })
        .map((p) => (p.hole ? <span className="tc-lanes" key={p.key}>{laneSummary(readyPlan.waves)}</span> : p.text))}</p>
      )}
      {rich && busy && !task.running?.plan && task.workPlan && ['running', 'asking'].includes(task.workPlan.status) && (
        <p className="tc-line tc-line-muted"><Icon name="clipboard" /> {fill(t.planProgress, { done: task.workPlan.tasks.filter((w) => w.status === 'done').length, total: task.workPlan.tasks.filter((w) => w.status !== 'skipped').length })}</p>
      )}
      {rich && !expanded && git && (behind > 0 || git.conflicts > 0) && (
        <p className="tc-line tc-line-warn">
          <Icon name="alert-triangle" />
          {git.conflicts > 0 ? `${t.conflictMain} · ` : ''}{plural(behind, t.behind)}
        </p>
      )}
      {rich && !compact && showPrChecks && selectedPr && !expanded && (
        <div className="tc-pr-row">
          <PrLink task={task} m={m} h={h} size="sm" />
        </div>
      )}
      {task.error && !expanded && (
        <p className="tc-error-block tc-clamp">
          <Icon name="alert-triangle" />
          <span>
            {failedAt && <b>{fill(t.failedIn, { phase: failedAt })} </b>}
            {task.errorCode === 'empty_repo'
              ? t.emptyRepo
              : task.error}
            {task.errorCode === 'base_missing' && task.errorInfo?.remoteHeads?.length > 0
              && !String(task.error).includes(task.errorInfo.remoteHeads[0])
              && ` ${fill(t.remoteHeads, { heads: task.errorInfo.remoteHeads.join(', ') })}`}
          </span>
        </p>
      )}
      {task.errorCode === 'empty_repo' && task.state === 'error' && !rerunning && onBootstrapRepo && (
        <button type="button" className="btn btn-warn btn-sm tc-recover" onClick={() => onBootstrapRepo(task.issue, task.errorInfo?.base ?? 'main')}
          title={t.bootstrapTitle}>
          <Icon name="sprout" /> {fill(t.bootstrap, { base: task.errorInfo?.base ?? 'main' })}
        </button>
      )}
      {['empty_repo', 'base_missing'].includes(task.errorCode) && task.state === 'error' && !rerunning && onChangeBase && (
        <ChangeBaseControl key={task.errorInfo?.base ?? 'main'} task={task} onChangeBase={onChangeBase} />
      )}
      {task.errorCode === 'auth_failed' && task.state === 'error' && !rerunning && (
        <LoginCard machine={task.errorInfo?.machine ?? task.machine} onRenew={onRenewLogin} />
      )}
      {rich && rerunning && (
        <p className="tc-line tc-line-muted"><Icon name="hourglass" /> {task.phase === 'pr' ? t.openingPr : t.working}</p>
      )}
      {rich && task.fixIterations > 0 && (
        <p className="tc-line tc-line-warn"><Icon name="repeat" /> {plural(task.fixIterations, t.fixIterations)}</p>
      )}
      {rich && !task.hasWorktree && !busy && (
        <p className="tc-line tc-line-muted">
          {branch ? fill(t.noWorktreeFrom, { branch }) : t.noWorktree}
        </p>
      )}

      {expanded ? (
        <div className="tc-groups" id={`${cid}-controls`}>
          <DecisionGroup task={task} m={m} h={h} compact={compact} />
          <WorkGroup task={task} m={m} h={h} compact={compact} />
          {/* Side by side on a phone (card.css `.tc-pair`); a group that renders nothing leaves the other the full row. */}
          <div className="tc-pair">
            <CodeGroup task={task} m={m} h={h} compact={compact} />
            <EnvGroup task={task} m={m} h={h} compact={compact} />
          </div>
          <SettingsGroup task={task} m={m} h={h} compact={compact} />
          <DangerGroup task={task} m={m} h={h} compact={compact} />
        </div>
      ) : (
        <footer className="tc-foot">
          {compact || park ? <ChatButton task={task} m={m} h={h} />
            : busy ? <><ChatButton task={task} m={m} h={h} /><PlanButton task={task} m={m} h={h} /></>
              : (
                <>
                  <DecisionGroup task={task} m={m} h={h} compact={compact} variant="footer" />
                  <ReadyButton task={task} m={m} h={h} />
                  <ChatButton task={task} m={m} h={h} />
                  <PlanButton task={task} m={m} h={h} />
                </>
              )}
          {canTrash && (
            <button type="button" className="btn btn-icon btn-danger tc-foot-trash" title={worktreeDelete}
              aria-label={worktreeDelete}
              onClick={(e) => { e.stopPropagation(); h.onDeleteWorktree(task.issue); }}>
              <Icon name="trash" />
            </button>
          )}
        </footer>
      )}
    </article>
  );
}
