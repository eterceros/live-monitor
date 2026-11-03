import React, { useEffect, useRef, useState } from 'react';
import Dialog from './Dialog.jsx';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { useDialog } from '../useDialog.jsx';
import { moveStepLabel } from '../status.js';
import { useStrings } from '../i18n/useStrings.js';
import { fill, plural, splitAround, strings } from '../i18n/index.js';
import { formatNumber } from '../i18n/format.js';

/**
 * Moving a task to another machine: what stands in the way, what the move
 * will do, and the two choices it leaves — keep the worktree it leaves behind,
 * and warm the build on arrival.
 *
 * The preflight is asked on open and again five seconds after each answer, so
 * stopping a server from here shows up without closing anything. One question
 * at a time, none while the move itself is being sent, and the last answer
 * stays on screen while the next one comes.
 */
const POLL_MS = 5000;
const PREPARE_POLL_MS = 2000;
const LIFTABLE = new Set(['target_ahead', 'target_dirty']);
const WIP_MESSAGE = 'wip: uncommitted work'; // i18n-ok: the git commit message, not UI text

export function formatSize(bytes) {
  if (bytes == null) return strings().ops.move.sizeUnknown;
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${formatNumber(gb, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** «Qué pasará», one line per effect, from a preflight answer. */
function planLines(data, task, to) {
  const t = strings().ops.move;
  const lines = [];
  const src = data.source ?? {};
  const dirty = src.dirty ?? [];
  if (dirty.length) {
    const names = dirty.slice(0, 5).join(', ');
    const more = dirty.length - 5;
    const holes = { code: '', files: plural(dirty.length, t.files), names, more };
    lines.push({
      key: 'wip',
      body: splitAround(more > 0 ? t.wipMore : t.wip, holes).map((p) => (
        p.hole === 'code' ? <code key={p.key}>{WIP_MESSAGE}</code> : <React.Fragment key={p.key}>{p.text}</React.Fragment>)),
      warn: data.pr ? fill(t.wipWarn, { pr: data.pr }) : null,
    });
  }
  // Without a valid source worktree there is nothing known to push.
  const sourceValid = !(data.blockers ?? []).some((b) => b.code === 'no_worktree');
  if (src.unpushed == null) { if (sourceValid) lines.push({ key: 'push', body: t.push }); }
  else if (src.unpushed > 0) lines.push({ key: 'push', body: plural(src.unpushed, dirty.length ? t.pushCommitsWip : t.pushCommits) });
  else if (dirty.length) lines.push({ key: 'push', body: t.pushWip });

  const target = data.target ?? {};
  // An unready target was not looked at: its worktree is unknown, not absent.
  if (target.ready && target.worktree === 'exists') {
    const body = target.behind == null ? fill(t.targetExists, { to })
      : target.behind > 0 ? fill(plural(target.behind, t.targetExistsBehind), { to })
        : fill(t.targetExistsCurrent, { to });
    lines.push({ key: 'target', body });
  } else if (target.ready && target.worktree === 'none') {
    lines.push({ key: 'target', body: fill(t.targetCreate, { to, branch: task.branch ?? t.branchFallback }) });
  }
  for (const chat of data.chats ?? []) {
    const what = chat.plan === 'resume' ? fill(t.chatResume, { to })
      : chat.plan === 'handoff' ? t.chatHandoff
        : fill(t.chatFresh, { to });
    lines.push({ key: `chat-${chat.id}`, body: `${chat.title}: ${what}` });
  }
  if (data.stack) lines.push({ key: 'stack', body: fill(t.stack, { to }) });
  lines.push({ key: 'pending', body: fill(t.pending, { to }) });
  return lines;
}

/**
 * «Prepare» for a blocker that says the project is not on the destination
 * runner: clones it and installs its dependencies there. Reads the job on open
 * (one may already be running, started from another tab) and every two seconds
 * while it runs; `onDone` asks the dialog to re-check right away.
 */
function PrepareRow({ project, machine, onDone }) {
  const t = useStrings().ops.move;
  const [job, setJob] = useState(null);       // { status, step, lines, error } from the server
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const read = async () => {
      try {
        const next = await api.prepareStatus(project, machine);
        if (cancelled) return;
        setJob(next);
        if (next.status === 'running') timer = setTimeout(read, PREPARE_POLL_MS);
        else if (next.status === 'done') onDone();
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    };
    read();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [project, machine, tick]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      setJob(await api.prepareProject(project, machine));
      if (alive.current) setTick((n) => n + 1);
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) setStarting(false);
    }
  };

  const running = job?.status === 'running';
  const failure = error ?? (job?.status === 'failed' ? job.error : null);
  return (
    <span className="move-prepare">
      {running ? (
        <>
          <span className="move-prepare-step"><span className="spinner" /> {t.prepareStep?.[job.step] ?? t.preparing}</span>
          {(job.lines ?? []).length > 0 && <pre className="move-prepare-log">{job.lines.slice(-8).join('\n')}</pre>}
        </>
      ) : (
        <>
          <button className="btn btn-primary btn-sm" disabled={starting} onClick={start} title={fill(t.prepareTitle, { to: machine })}>
            {starting ? t.preparing : failure ? t.prepareRetry : t.prepare}
          </button>
          {failure && <span className="move-prepare-error">{fill(t.prepareFailed, { message: failure })}</span>}
        </>
      )}
    </span>
  );
}

export default function MoveDialog({ task, machines = [], machineStatus = {}, initialTo = null, onClose }) {
  const all = useStrings();
  const t = all.ops.move;
  const from = task.machine ?? 'local';
  const others = machines.filter((m) => m.name !== from);
  const [to, setTo] = useState(() => (others.some((m) => m.name === initialTo) ? initialTo : others[0]?.name ?? null));
  const [discard, setDiscard] = useState(false);
  const [oldWorktree, setOldWorktree] = useState('keep');
  const [prewarm, setPrewarm] = useState(true);
  // The last answer, with what it was asked for: a result for the other
  // checkbox value or another machine must not enable «Mover».
  const [pre, setPre] = useState(null);           // { data, to, discard }
  const [preError, setPreError] = useState(null);
  const [posting, setPosting] = useState(false);
  const [refused, setRefused] = useState(null);   // blockers from a 409
  const [failure, setFailure] = useState(null);
  const [stopping, setStopping] = useState(() => new Set());
  const [confirming, setConfirming] = useState(false);
  // Bumped when a «Prepare» finishes: ask the preflight again now, not in five seconds.
  const [recheck, setRecheck] = useState(0);
  const { ask, notice } = useDialog();
  const alive = useRef(true);
  const inflight = useRef(null);
  // When the last 409 came: the server caches its fetch for 30 s, so an answer
  // right after a refusal may still say «all clear» and must not undo it.
  const refusedAt = useRef(0);
  useEffect(() => () => { alive.current = false; }, []);

  // Another device started moving it: nothing left to decide here.
  const movingNow = Boolean(task.moving && !task.moving.error);
  useEffect(() => { if (movingNow) onClose(); }, [movingNow]);

  // A different machine is a different answer: no stale one in between.
  useEffect(() => { setPre((p) => (p && p.to !== to ? null : p)); setPreError(null); }, [to]);

  useEffect(() => {
    if (!to || posting) return undefined;
    let cancelled = false;
    let timer = null;
    const run = async () => {
      // Never two at once: a re-query waits for the one still out.
      if (inflight.current) await inflight.current.catch(() => {});
      if (cancelled) return;
      const asked = { to, discard };
      const promise = api.movePreflight(task.project, task.issue, to, { discardTargetLocal: discard });
      inflight.current = promise;
      try {
        const data = await promise;
        if (cancelled || !alive.current) return;
        setPre({ data, ...asked });
        setPreError(null);
        if (Date.now() - refusedAt.current > POLL_MS) setRefused(null);
        const listed = new Set((data.blockers ?? []).flatMap((b) => (b.items ?? []).map((i) => i?.itemId).filter(Boolean)));
        setStopping((s) => (s.size && [...s].some((id) => !listed.has(id)) ? new Set([...s].filter((id) => listed.has(id))) : s));
      } catch (e) {
        if (cancelled || !alive.current) return;
        setPreError(e.message);
      } finally {
        if (inflight.current === promise) inflight.current = null;
      }
      if (!cancelled) timer = setTimeout(run, POLL_MS);
    };
    run();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [task.issue, to, discard, posting, recheck]);

  const current = pre && pre.to === to ? pre : null;
  const data = current?.data ?? null;
  const blockers = refused ?? data?.blockers ?? [];
  const gating = blockers.filter((b) => !b.lifted);
  const liftable = blockers.some((b) => LIFTABLE.has(b.code));
  const canMove = Boolean(data) && current.discard === discard && !preError && !gating.length && !posting;

  const stop = async (item) => {
    setConfirming(true);
    const go = await ask({
      title: fill(t.stopTitle, { name: item.name }), icon: 'stop',
      text: t.stopText,
      options: [{ value: true, label: t.stopLabel, tone: 'danger' }], cancel: t.leave,
    });
    if (!alive.current) return;
    setConfirming(false);
    if (!go) return;
    setStopping((s) => new Set(s).add(item.itemId));
    try {
      await api.stopBackground(task, item.chatId, item.itemId);
    } catch (e) {
      if (!alive.current) return;
      setStopping((s) => { const next = new Set(s); next.delete(item.itemId); return next; });
      setConfirming(true);
      await notice({ title: t.stopFailed, text: e.message });
      if (alive.current) setConfirming(false);
    }
  };

  const submit = async () => {
    setPosting(true);
    setFailure(null);
    try {
      await api.moveTask(task.project, task.issue, { to, oldWorktree, prewarm, discardTargetLocal: discard });
      if (alive.current) onClose();
    } catch (e) {
      if (!alive.current) return;
      if (Array.isArray(e.data?.blockers) && e.data.blockers.length) {
        refusedAt.current = Date.now();
        setRefused(e.data.blockers);
      }
      else setFailure(e.message);
    } finally {
      if (alive.current) setPosting(false);
    }
  };

  const itemRow = (b, item, n) => {
    if (b.code === 'servers') {
      return (
        <li key={`${b.code}-${item.itemId ?? n}`} className="move-blocker-item">
          <span className="move-blocker-name"><Icon name="dot" className="icon-ok"/> {item.name}{item.port != null ? ` :${item.port}` : ''}</span>
          {stopping.has(item.itemId)
            ? <span className="move-stopping">{t.stopping}</span>
            : item.taskId && (
              <button className="btn btn-danger btn-icon btn-sm dlg-a-stop" onClick={() => stop(item)} title={t.stopLabel} aria-label={fill(t.stopAria, { name: item.name })}><Icon name="stop"/></button>
            )}
        </li>
      );
    }
    const name = typeof item === 'string' ? item : item?.name ?? item?.title ?? item?.path ?? JSON.stringify(item);
    return <li key={`${b.code}-${n}`} className="move-blocker-item"><span className="move-blocker-name">{name}</span></li>;
  };
  const withItems = new Set(['servers', 'background', 'chat_pending']);

  const single = others.length === 1;
  const title = single || !to ? fill(t.title, { issue: task.issue, to: to ?? '…' }) : fill(t.titleBare, { issue: task.issue });
  const retrying = task.moving?.error && task.moving.to === to;

  return (
    <Dialog
      title={title} icon="truck" className="move-dialog"
      onDismiss={confirming ? null : onClose}
      footer={(
        <>
          <button className="btn btn-ghost btn-md" onClick={onClose}>{t.leave}</button>
          <span className="modal-spacer" />
          <button className="btn btn-primary btn-md" disabled={!canMove} onClick={submit}>{posting ? t.moving : t.move}</button>
        </>
      )}
    >
      {!single && (
        <section className="move-section move-destination">
          <label>
            {t.destination}
            <select value={to ?? ''} onChange={(e) => { setTo(e.target.value); setDiscard(false); setRefused(null); setFailure(null); }}>
              {others.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}{machineStatus[m.name]?.online === false ? ` · ${t.offline}` : ''}
                </option>
              ))}
            </select>
          </label>
        </section>
      )}
      {retrying && <p className="move-note">{fill(t.retrying, { step: moveStepLabel(task.moving) })}</p>}

      {!data && !preError && <p className="move-checking"><span className="spinner" /> {t.checking}</p>}

      {(preError || failure || blockers.length > 0) && (
        <section className="move-section">
          <h4>{t.resolveFirst}</h4>
          <ul className="move-blockers">
            {preError && <li className="move-blocker"><span className="move-blocker-text">{fill(t.checkFailed, { message: preError })}</span></li>}
            {failure && <li className="move-blocker"><span className="move-blocker-text">{fill(t.moveFailed, { message: failure })}</span></li>}
            {blockers.map((b, i) => (
              <React.Fragment key={`${b.code}-${i}`}>
                <li className={`move-blocker ${b.lifted ? 'lifted' : ''}`} data-code={b.code}>
                  <span className="move-blocker-text">{b.text}</span>
                </li>
                {withItems.has(b.code) && (b.items ?? []).map((item, n) => itemRow(b, item, n))}
                {b.code === 'project_not_prepared' && (
                  <li className="move-blocker-item move-prepare-row">
                    <PrepareRow project={task.project} machine={to} onDone={() => setRecheck((n) => n + 1)} />
                  </li>
                )}
              </React.Fragment>
            ))}
          </ul>
          {liftable && (
            <label className="move-discard">
              <input type="checkbox" checked={discard} onChange={(e) => { setDiscard(e.target.checked); setRefused(null); }} />
              {fill(t.discard, { to })}
            </label>
          )}
        </section>
      )}

      {data && (
        <section className="move-section">
          <h4>{t.whatWillHappen}</h4>
          <ul className="move-plan">
            {planLines(data, task, to).map((l) => (
              <li key={l.key}>
                {l.body}
                {l.warn && <span className="move-plan-warn"> · {l.warn}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="move-section move-options">
        <div className="move-option" role="radiogroup" aria-label={fill(t.worktreeAria, { from })}>
          <span className="move-option-label">{fill(t.worktreeLabel, { from })}</span>
          <label>
            <input type="radio" name="move-old-worktree" value="keep" checked={oldWorktree === 'keep'} onChange={() => setOldWorktree('keep')} />
            {fill(t.keep, { size: data ? formatSize(data.source?.sizeBytes) : '…' })}
          </label>
          <label>
            <input type="radio" name="move-old-worktree" value="remove" checked={oldWorktree === 'remove'} onChange={() => setOldWorktree('remove')} />
            {all.common.delete}
          </label>
        </div>
        <label className="move-option">
          <input type="checkbox" checked={prewarm} onChange={(e) => setPrewarm(e.target.checked)} />
          {t.prewarm}
        </label>
      </section>
    </Dialog>
  );
}
