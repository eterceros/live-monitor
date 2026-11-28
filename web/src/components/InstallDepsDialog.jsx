import React, { useCallback, useEffect, useRef, useState } from 'react';
import Dialog from './Dialog.jsx';
import { useStrings } from '../i18n/useStrings.js';
import { api } from '../api.js';
import { fill } from '../i18n/index.js';

/** A clone or install waiting its turn on the machine is as unfinished as a running one. */
export const isBusy = (job) => job?.status === 'queued' || job?.status === 'running';

/** A machine the project can live on: a runner with the convention off and no path of its own is not one. */
export const hostsProject = (row) => row.kind === 'local' || !['projects_root_off', 'no_repo'].includes(row.reason);

/**
 * The per-machine rows of one project (`GET /api/projects/:p/machines`), kept
 * live by the `checkout` messages App forwards as `board-checkout`. A finished
 * job re-reads the rows, because it changes what is on disk there.
 *
 * @param {string} project
 * @param {boolean} [enabled] false asks nothing
 * @returns {{ rows: object[]|null, error: string|null, reload: () => Promise<void> }}
 */
export function useProjectMachines(project, enabled = true) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  // Only the latest read is applied; the ref also silences reads after unmount.
  const latest = useRef(0);
  const known = useRef([]);
  known.current = rows ?? [];

  const reload = useCallback(async () => {
    const seq = ++latest.current;
    try {
      const r = await api.projectMachines(project);
      if (seq !== latest.current) return;
      setRows(Array.isArray(r?.machines) ? r.machines : []);
      setError(null);
    } catch (e) {
      if (seq === latest.current) setError(e.message);
    }
  }, [project]);

  useEffect(() => {
    if (!enabled) return undefined;
    const onCheckout = (event) => {
      const msg = event.detail;
      if (msg?.project !== project) return;
      const job = { status: msg.status, step: msg.step, error: msg.error, code: msg.code };
      const listed = known.current.some((row) => row.machine === msg.machine);
      setRows((list) => list && list.map((row) => (row.machine === msg.machine ? { ...row, job } : row)));
      // A read still in flight may predate this message, so it is asked again.
      if (!listed || !isBusy(job)) reload();
    };
    window.addEventListener('board-checkout', onCheckout);
    window.addEventListener('board-connected', reload);
    reload();
    return () => {
      latest.current += 1;
      window.removeEventListener('board-checkout', onCheckout);
      window.removeEventListener('board-connected', reload);
    };
  }, [project, enabled, reload]);

  return { rows, error, reload };
}

/**
 * Whether to install the project's dependencies, asked per machine. The saved
 * answer is what each row opens on; only the answers changed here are applied.
 * An install prepares the main checkout and nothing else.
 *
 * @param {object} props
 * @param {string} props.project project id
 * @param {string} props.name how the project is called on screen
 * @param {() => void} props.onClose
 */
export default function InstallDepsDialog({ project, name, onClose }) {
  const t = useStrings();
  const d = t.dialogs.installDeps;
  const { rows, error, reload } = useProjectMachines(project);
  const [draft, setDraft] = useState({});
  const [failures, setFailures] = useState({});
  const [saving, setSaving] = useState(false);

  const shown = (rows ?? []).filter(hostsProject);
  const changes = Object.entries(draft);

  const explain = (code, message) => {
    if (code === 'upgrading') return d.deferred;
    if (code === 'node_modules_exists') return d.nodeModules;
    return fill(d.failed, { message });
  };

  // A saved «yes» cannot be picked again, so running it once more has its own button.
  const runAgain = async (machine) => {
    setSaving(true);
    setFailures((now) => ({ ...now, [machine]: null }));
    try {
      await api.prepareProject(project, machine);
    } catch (e) {
      setFailures((now) => ({ ...now, [machine]: explain(e.data?.code, e.message) }));
    }
    await reload();
    setSaving(false);
  };

  const apply = async () => {
    setSaving(true);
    setFailures({});
    const failed = {};
    const left = {};
    // One machine's refusal must not keep the others from getting their answer.
    await Promise.all(changes.map(async ([machine, choice]) => {
      try {
        await api.setMachineOptions(project, machine, { install: choice });
        if (choice === 'yes') await api.prepareProject(project, machine);
      } catch (e) {
        failed[machine] = explain(e.data?.code, e.message);
        left[machine] = choice;
      }
    }));
    await reload();
    setFailures(failed);
    setDraft(left);
    setSaving(false);
  };

  const status = (row) => {
    const job = row.job;
    if (isBusy(job)) return d.step[job.step] ?? d.working;
    if (job?.status === 'failed') return explain(job.code, job.error);
    return null;
  };

  return (
    <Dialog
      title={fill(d.title, { project: name })} icon="folder-git" className="pm-install-deps"
      onDismiss={onClose}
      footer={(
        <>
          <span className="modal-spacer" />
          <button type="button" className="btn btn-ghost btn-md" onClick={onClose}>{t.common.close}</button>
          <button type="button" className="btn btn-primary btn-md" disabled={saving || changes.length === 0} onClick={apply}>
            {saving ? d.saving : t.common.save}
          </button>
        </>
      )}
    >
      <p>{d.intro}</p>
      <p className="modal-caption">{d.scope}</p>
      {error && <p className="pm-account-note" aria-live="polite">{fill(d.loadFailed, { message: error })}</p>}
      {!rows && !error && <p><span className="spinner" /> {t.common.loading}</p>}
      {shown.map((row) => {
        const local = row.kind === 'local';
        const busy = isBusy(row.job);
        const refused = local && !!row.nodeModules;
        const choice = draft[row.machine] ?? row.install ?? null;
        const failed = row.job?.status === 'failed';
        const retryable = row.install === 'yes' && !draft[row.machine] && !busy && !refused
          && (failed || row.job?.status === 'idle');
        const label = local ? fill(d.boardMachine, { machine: row.machine }) : row.machine;
        const option = (value, text, disabled) => (
          <label>
            <input
              type="radio" name={`install-deps-${project}-${row.machine}`} value={value}
              checked={choice === value} disabled={saving || disabled}
              onChange={() => setDraft((now) => ({ ...now, [row.machine]: value }))}
            />{' '}{text}
          </label>
        );
        const note = failures[row.machine] ?? status(row);
        return (
          <fieldset key={row.machine}>
            <legend>{label}</legend>
            {option('yes', d.yes, refused || busy)}{' '}
            {option('no', d.no, false)}
            {refused && !busy && <p className="modal-caption">{d.nodeModules}</p>}
            {note && <p className="modal-caption" aria-live="polite">{busy && <span className="spinner" />} {note}</p>}
            {retryable && (
              <button type="button" className="btn btn-sm" disabled={saving}
                aria-label={`${failed ? t.common.retry : d.installNow}: ${label}`}
                onClick={() => runAgain(row.machine)}>
                {failed ? t.common.retry : d.installNow}
              </button>
            )}
          </fieldset>
        );
      })}
    </Dialog>
  );
}
