import React from 'react';
import Dialog from './Dialog.jsx';
import Icon from './Icon.jsx';
import { useProjectMachines } from './InstallDepsDialog.jsx';
import { hostsProject, cloneState, cloneActions } from '../projectMachines.js';
import { useStrings } from '../i18n/useStrings.js';
import { api } from '../api.js';
import { fill } from '../i18n/index.js';

/**
 * How an account is shown: `@login — email` when the board knows the email it
 * goes by (a login alone is easy to mix up), else `@login`.
 */
export function accountLabel(t, account) {
  return account.email ? fill(t.topbar.manage.accountLabel, account) : `@${account.login}`;
}

/**
 * One of the server's account warnings (`{ code, login, ...details, message }`)
 * in the reader's language; one it has no words for falls back to the
 * server's own English `message`.
 */
export function accountWarningText(t, w) {
  const template = w && t.topbar.manage.accountWarning[w.code];
  if (template) return fill(template, w);
  return typeof w === 'string' ? w : String(w?.message ?? '');
}

/**
 * A card's «Machines» section: each runner's clone, with retry and the
 * per-project exclusion, and the way back to the install question.
 */
function CardMachines({ project, name, hasRunners, machineStatus, onInstall }) {
  const t = useStrings();
  const m = t.topbar.manage;
  const { rows, error, reload } = useProjectMachines(project, hasRunners);
  const [pending, setPending] = React.useState({});
  const [refusals, setRefusals] = React.useState({});

  const act = async (machine, request) => {
    setPending((now) => ({ ...now, [machine]: true }));
    setRefusals((now) => ({ ...now, [machine]: null }));
    try {
      await request();
      await reload();
    } catch (e) {
      setRefusals((now) => ({ ...now, [machine]: e.message }));
    } finally {
      setPending((now) => ({ ...now, [machine]: false }));
    }
  };

  const runners = (rows ?? []).filter((row) => row.kind !== 'local' && hostsProject(row));
  return (
    <section className="pm-machines" aria-label={`${m.machines}: ${name}`}>
      {error && <p className="pm-account-note" aria-live="polite">{fill(m.machinesFailed, { message: error })}</p>}
      {runners.map((row) => {
        const online = machineStatus[row.machine]?.online;
        const state = cloneState(m.cloneState, row, online);
        const { failed, byConvention, canClone, wraps } = cloneActions(row);
        return (
          <div key={row.machine}>
            <dl className="pm-fields">
              <div className="pm-field">
                <dt title={row.machine}>{row.machine}</dt>
                {!wraps && <dd title={state} aria-live="polite">{state}</dd>}
              </div>
            </dl>
            {wraps && <p className="pm-account-note" aria-live="polite">{state}</p>}
            {(byConvention || canClone) && (
              <div className="pm-card-actions">
                {byConvention && <label className="pm-field">
                  <input
                    type="checkbox" checked={row.autoClone !== false} disabled={!!pending[row.machine]}
                    aria-label={`${m.cloneAuto}: ${row.machine}`}
                    onChange={(e) => {
                      const autoClone = e.target.checked;
                      act(row.machine, () => api.setMachineOptions(project, row.machine, { autoClone }));
                    }}
                  />
                  {m.cloneAuto}
                </label>}
                {canClone && (
                  <button type="button" className="btn btn-sm" disabled={!!pending[row.machine]}
                    aria-label={`${failed ? t.common.retry : m.cloneNow}: ${row.machine}`}
                    onClick={() => act(row.machine, () => api.retryClone(project, row.machine))}>
                    {failed ? t.common.retry : m.cloneNow}
                  </button>
                )}
              </div>
            )}
            {refusals[row.machine] && <p className="pm-account-note" aria-live="polite">{refusals[row.machine]}</p>}
          </div>
        );
      })}
      <button type="button" className="btn btn-sm" onClick={() => onInstall?.(project)}>
        {m.dependencies}
      </button>
    </section>
  );
}

/**
 * Every project the board knows, as a responsive grid of cards: open it,
 * restrict or unrestrict it, change the GitHub account it works as, take it off
 * the board. Each card also shows the project on every runner (clone state,
 * clone or retry, exclusion from automatic cloning) and reopens the question
 * about installing dependencies. Importing a new one is the header button. Nothing is confirmed
 * here: `onRemove(project)` belongs to the caller, which asks.
 *
 * @param {object} props
 * @param {object[]} props.projects
 * @param {string|null} props.activeProject id of the active project
 * @param {() => void} props.onClose
 * @param {() => void} props.onImport
 * @param {(id: string) => void} props.onSelect
 * @param {(id: string, restricted: boolean) => void} props.onToggleRestricted
 * @param {(project: object) => void} props.onRemove
 * @param {{ name: string, kind: string }[]} props.machines
 * @param {Record<string, { online: boolean }>} props.machineStatus by machine name
 * @param {(id: string) => void} props.onInstall opens the install question
 */
export default function ManageProjectsDialog({
  projects = [], activeProject, onClose, onImport, onSelect, onToggleRestricted, onRemove,
  machines = [], machineStatus = {}, onInstall,
}) {
  const t = useStrings();
  const m = t.topbar.manage;
  const p = t.topbar.picker;
  const hasRunners = machines.some((x) => x.kind === 'runner');

  const field = (label, value) => (value ? (
    <div className="pm-field">
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  ) : null);

  // The accounts `gh` has a session for, asked once per opening. Per card, what
  // the last change answered: still saving, its warnings, or its refusal.
  const [accounts, setAccounts] = React.useState([]);
  // The login a project without its own account works as, named on that option.
  const [current, setCurrent] = React.useState(null);
  const [notes, setNotes] = React.useState({});
  React.useEffect(() => {
    api.ghAccounts().then((r) => {
      setAccounts(Array.isArray(r?.accounts) ? r.accounts : []);
      setCurrent(typeof r?.current === 'string' ? r.current : null);
    }, () => {});
  }, []);
  const note = (id, value) => setNotes((n) => ({ ...n, [id]: value }));

  const changeAccount = async (x, login) => {
    const ghUser = login || null;
    // The assignee follows the account when it was the account (or nobody);
    // one picked by hand stays.
    const follows = ghUser && (!x.assignee || x.assignee === x.ghUser);
    note(x.id, { busy: true });
    try {
      const saved = await api.setProjectGhAccount(x.id, ghUser, follows ? ghUser : undefined);
      note(x.id, { warnings: Array.isArray(saved?.warnings) ? saved.warnings : [] });
    } catch (e) {
      note(x.id, { error: e.message });
    }
  };

  // The project's own account stays offered even when `gh` lost its session:
  // the warning says so, and the select must not pretend it is another one.
  const accountOptions = (x) => (x.ghUser && !accounts.some((a) => a.login === x.ghUser)
    ? [...accounts, { login: x.ghUser, email: null }]
    : accounts);
  const currentAccount = current ? accounts.find((a) => a.login === current) ?? { login: current, email: null } : null;

  return (
    <Dialog
      title={m.title} icon="grid" wide className="pm-dialog"
      onDismiss={onClose}
      footer={(
        <>
          <span className="modal-caption pm-note">{m.note}</span>
          <span className="modal-spacer" />
          <button type="button" className="btn btn-ghost btn-md" onClick={onClose}>{m.close}</button>
        </>
      )}
    >
      <div className="pm-toolbar">
        <button type="button" className="btn btn-primary btn-md" onClick={() => onImport?.()}>
          <Icon name="plus"/> {m.import}
        </button>
      </div>
      {projects.length === 0 ? (
        <p className="pm-empty-state">{m.empty}</p>
      ) : (
        <ul className="pm-grid" aria-label={m.grid}>
          {projects.map((x) => {
            const isActive = x.id === activeProject;
            const name = x.name || x.id;
            return (
              <li key={x.id} className={`pm-card${isActive ? ' is-active' : ''}${x.restricted ? ' is-restricted' : ''}`}>
                <div className="pm-card-head">
                  <h3 className="pm-card-name" title={name}>{name}</h3>
                  {isActive && <span className="pm-badge pm-badge-active">{m.active}</span>}
                  {x.restricted && <span className="pm-badge pm-badge-restricted">{m.restricted}</span>}
                </div>
                <dl className="pm-fields">
                  {field(m.repo, x.repo)}
                  {field(m.path, x.repoPath)}
                  {field(m.assignee, x.assignee ? `@${x.assignee}` : '')}
                  <div className="pm-field">
                    <dt>{m.account}</dt>
                    <dd>
                      <select
                        className="pm-account" aria-label={`${m.account}: ${name}`}
                        value={x.ghUser ?? ''} disabled={notes[x.id]?.busy}
                        onChange={(e) => changeAccount(x, e.target.value)}
                      >
                        <option value="">{currentAccount ? fill(m.accountActiveIs, { account: accountLabel(t, currentAccount) }) : m.accountActive}</option>
                        {accountOptions(x).map((a) => <option key={a.login} value={a.login}>{accountLabel(t, a)}</option>)}
                      </select>
                    </dd>
                  </div>
                </dl>
                {notes[x.id]?.error && <p className="pm-account-note" aria-live="polite">{notes[x.id].error}</p>}
                {notes[x.id]?.warnings?.length > 0 && (
                  <ul className="pm-account-note" aria-live="polite">
                    {notes[x.id].warnings.map((w, i) => <li key={i}>{accountWarningText(t, w)}</li>)}
                  </ul>
                )}
                <CardMachines
                  project={x.id} name={name} hasRunners={hasRunners}
                  machineStatus={machineStatus} onInstall={onInstall}
                />
                <div className="pm-card-actions">
                  <button type="button" className="btn btn-md" onClick={() => { onSelect?.(x.id); onClose?.(); }}>
                    <Icon name="folder-git"/> {m.open}
                  </button>
                  <button type="button" className="btn btn-md btn-icon"
                    title={x.restricted ? p.unrestrict : p.restrict}
                    aria-label={`${x.restricted ? p.unrestrict : p.restrict}: ${name}`}
                    onClick={() => onToggleRestricted?.(x.id, !x.restricted)}>
                    <Icon name={x.restricted ? 'eye' : 'eye-off'}/>
                  </button>
                  <button type="button" className="btn btn-md btn-icon pm-danger"
                    title={p.remove} aria-label={`${p.remove}: ${name}`}
                    onClick={() => onRemove?.(x)}>
                    <Icon name="trash"/>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
