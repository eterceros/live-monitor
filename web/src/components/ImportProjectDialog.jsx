import React, { useRef, useState } from 'react';
import Dialog from './Dialog.jsx';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { useStrings } from '../i18n/useStrings.js';
import { accountWarningText, accountLabel } from './ManageProjectsDialog.jsx';
import { dismissOf } from '../projectMachines.js';

/**
 * Importing a project: one obligatory field, the local checkout's path.
 *
 * Everything else the repository already knows (`keys.js`, point 5): the
 * remote gives `repo`, the convention `<checkout>-wt` gives `worktreeRoot`,
 * the last path segment gives `id`. Asking for any of it up front would be
 * asking the reader to repeat what is on disk.
 *
 * What the board could not deduce it asks for **with the value it proposes**,
 * and the answers are sent back with the path. A refusal is shown exactly as
 * the server wrote it — it names the forbidden override, the bad id or the
 * path that is not there, and rewording that here would only lose detail.
 */

/** The parts of a `Project` a person can answer for. `repoPath` is the field above. Labels and hints are in the catalog. */
const OPTIONAL = ['id', 'name', 'repo', 'worktreeRoot', 'ghUser', 'assignee', 'reviewer'];

/**
 * What the server says it still needs, whichever way it says it: a list of
 * field names, a list of `{field, suggestion}`, or an object of proposals.
 * Nothing here is required — with none of it the dialog just shows the
 * refusal and lets the optional fields be filled by hand.
 */
function asked(data) {
  const out = new Map();
  const proposals = data?.proposed ?? data?.suggestions ?? data?.defaults ?? null;
  if (proposals && typeof proposals === 'object' && !Array.isArray(proposals)) {
    for (const [field, value] of Object.entries(proposals)) {
      if (typeof value === 'string') out.set(field, value);
    }
  }
  const list = data?.needs ?? data?.missing ?? data?.asks ?? data?.fields ?? null;
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item === 'string') out.set(item, out.get(item) ?? '');
    else if (item && typeof item === 'object' && typeof item.field === 'string') {
      const value = item.suggestion ?? item.proposed ?? item.value ?? out.get(item.field) ?? '';
      out.set(item.field, typeof value === 'string' ? value : '');
    }
  }
  return out;
}

export default function ImportProjectDialog({ onClose, onImported, defaultAssignee = null }) {
  const t = useStrings();
  const [repoPath, setRepoPath] = useState('');
  const [answers, setAnswers] = useState({});
  // The fields the server asked about, so they are shown even when folded.
  const [askedFields, setAskedFields] = useState([]);
  // Folded unless the board has no default assignee: then that field is the one thing a person may have to fill in.
  const [open, setOpen] = useState(!defaultAssignee);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);       // the server's own words
  const [problems, setProblems] = useState([]);   // a list, when it sent one
  // Imported, but with what stands between it and its GitHub account (no gh
  // session, a remote that pushes as somebody else): shown before closing.
  const [imported, setImported] = useState(null);
  // The folder browser, offered only where the board itself runs. `here` is
  // the listing being shown: `{ path, parent, entries, truncated }`.
  const [canBrowse, setCanBrowse] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [here, setHere] = useState(null);
  const [walking, setWalking] = useState(false);
  const [browseError, setBrowseError] = useState(null);
  const alive = useRef(true);
  React.useEffect(() => () => { alive.current = false; }, []);

  // One probe when the dialog opens. A 200 both proves the endpoint is there
  // and leaves the roots in hand; anything else — the 403 a phone gets, a
  // board too old to have the route — just means no button. Nothing is said
  // about it: the path field alone is what this dialog always was.
  React.useEffect(() => {
    api.browse().then(
      (roots) => { if (alive.current) { setHere(roots); setCanBrowse(true); } },
      () => {},
    );
  }, []);

  const path = repoPath.trim();

  // The accounts `gh` has a session for, offered as suggestions for the
  // project's account; the field still takes any login. Asked with the path
  // typed so far, since that checkout's own email names the account it pushes
  // as — on a first import it is the only place that email is known. Only
  // while the fields are shown, and once the typing pauses.
  const [accounts, setAccounts] = useState([]);
  React.useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(() => {
      api.ghAccounts(path || null).then(
        (r) => { if (alive.current && Array.isArray(r?.accounts)) setAccounts(r.accounts); },
        () => {},
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [open, path]);
  // The server falls back to the project's account, then to the board's default; with neither, the assignee must be typed.
  const assigneeRequired = !defaultAssignee && !(answers.ghUser ?? '').trim();
  const set = (field, value) => setAnswers((a) => ({ ...a, [field]: value }));

  // Navigating by the `path` the server gave for that entry — never by
  // joining a name to a folder, which is where Windows path arithmetic in a
  // browser goes wrong.
  const walk = async (to) => {
    if (walking) return;
    setWalking(true);
    setBrowseError(null);
    try {
      const listing = await api.browse(to);
      if (alive.current) setHere(listing);
    } catch (e) {
      if (alive.current) setBrowseError(e.message);
    } finally {
      if (alive.current) setWalking(false);
    }
  };

  // Choosing fills the field and folds the panel. Importing stays a separate
  // click, so what landed in the field can still be corrected by hand.
  const choose = () => {
    if (!here?.path) return;
    setRepoPath(here.path);
    setBrowsing(false);
  };

  const submit = async () => {
    if (!path || busy || imported) return;
    setBusy(true);
    setError(null);
    setProblems([]);
    try {
      const body = { repoPath: path };
      for (const [field, value] of Object.entries(answers)) {
        const v = typeof value === 'string' ? value.trim() : value;
        if (v) body[field] = v;
      }
      const created = await api.createProject(body);
      if (!alive.current) return;
      const { warnings, ...project } = created?.project ?? created ?? {};
      if (Array.isArray(warnings) && warnings.length) {
        setImported(project);
        setProblems(warnings.map((w) => accountWarningText(t, w)).filter(Boolean));
        return;
      }
      onImported(project);
    } catch (e) {
      if (!alive.current) return;
      setError(e.message);
      if (Array.isArray(e.data?.problems)) setProblems(e.data.problems.filter((p) => typeof p === 'string'));
      const more = asked(e.data);
      if (more.size) {
        setAnswers((a) => {
          const next = { ...a };
          for (const [field, value] of more) if (!next[field]) next[field] = value;
          return next;
        });
        setAskedFields([...more.keys()]);
        setOpen(true);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  // Every field with a label of its own, plus anything the server named that
  // this dialog does not know about — it still gets an input.
  const rows = [...OPTIONAL, ...askedFields.filter((f) => f !== 'repoPath' && !OPTIONAL.includes(f))]
    .map((f) => [f, t.topbar.importProject.fields[f]?.label ?? f, t.topbar.importProject.fields[f]?.hint ?? null]);

  const placeholderOf = (field) => {
    if (field === 'assignee' && defaultAssignee) return defaultAssignee;
    if (field === 'assignee' && assigneeRequired) return t.topbar.importProject.required;
    return askedFields.includes(field) ? t.topbar.importProject.couldNotDeduce : t.topbar.importProject.deduces;
  };
  // With a board default, the hint says what an empty field will use.
  const hintOf = (field, hint) => (field === 'assignee' && defaultAssignee ? t.topbar.importProject.assigneeDefault : hint);

  return (
    <Dialog
      title={t.topbar.more.importProject} icon="plus" className="import-project"
      // Once imported, any way out counts as imported.
      onDismiss={dismissOf({ busy, imported, onClose, onImported })}
      footer={(
        <>
          <span className="modal-caption">{t.topbar.importProject.footerNote}</span>
          <span className="modal-spacer" />
          {imported ? (
            <button className="btn btn-primary btn-md" onClick={() => onImported(imported)}>{t.topbar.importProject.understood}</button>
          ) : (
            <>
              <button className="btn btn-ghost btn-md" onClick={onClose} disabled={busy}>{t.topbar.importProject.leave}</button>
              <button className="btn btn-primary btn-md" disabled={!path || busy} onClick={submit}>
                {busy ? t.topbar.importProject.submitting : t.topbar.importProject.submit}
              </button>
            </>
          )}
        </>
      )}
    >
      <label className="import-label" htmlFor="import-repo-path">{t.topbar.importProject.pathLabel}</label>
      <input
        id="import-repo-path"
        className="import-input"
        autoFocus spellCheck={false}
        value={repoPath}
        onChange={(e) => setRepoPath(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' /* i18n-ok: a key name */) submit(); }}
        placeholder={t.topbar.importProject.pathPlaceholder}
      />
      <p className="import-hint">{t.topbar.importProject.pathHint}</p>

      {canBrowse && (
        <button
          className="btn btn-sm dlg-a-browse-toggle" aria-expanded={browsing}
          onClick={() => setBrowsing((b) => !b)}
        >
          <Icon name="folder"/> {browsing ? t.topbar.importProject.closeBrowser : t.topbar.importProject.findFolder}
        </button>
      )}
      {canBrowse && browsing && (
        <div className="browse-panel">
          <div className="browse-bar">
            <button
              className="btn btn-ghost btn-sm btn-icon dlg-a-browse-up"
              disabled={walking || !here || here.parent === null}
              title={t.topbar.importProject.up} aria-label={t.topbar.importProject.up}
              onClick={() => walk(here.parent)}
            ><Icon name="arrow-up"/></button>
            <span className="browse-where" title={here?.path ?? ''}>
              {here?.path ?? t.topbar.importProject.drives}
            </span>
          </div>

          <ul className="browse-list">
            {(here?.entries ?? []).map((entry) => (
              <li key={entry.path}>
                <button
                  className={`browse-entry ${entry.isGit ? 'is-git' : ''}`}
                  disabled={walking}
                  onClick={() => walk(entry.path)}
                  title={entry.path}
                >
                  <span className="browse-entry-icon" aria-hidden="true">{entry.isGit ? <Icon name="folder-git"/> : <Icon name="folder"/>}</span>
                  <span className="browse-entry-name">{entry.name}</span>
                  {entry.isGit && <span className="browse-git" title={t.topbar.importProject.isGit}>git{/* i18n-ok: the tool's name */}</span>}
                </button>
              </li>
            ))}
            {here && (here.entries ?? []).length === 0 && !walking && (
              <li className="browse-empty">{t.topbar.importProject.noFolders}</li>
            )}
          </ul>

          {here?.truncated && (
            <p className="browse-note">{t.topbar.importProject.truncated}</p>
          )}
          {browseError && <p className="browse-error" aria-live="polite">{browseError}</p>}

          <div className="browse-foot">
            <button className="btn btn-primary btn-md dlg-a-browse-pick" disabled={walking || !here?.path} onClick={choose}>
              {t.topbar.importProject.pick}
            </button>
          </div>
        </div>
      )}

      <button className="btn btn-ghost btn-sm dlg-a-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? <Icon name="chevron-down"/> : <Icon name="chevron-right"/>} {t.topbar.importProject.deduced}
      </button>
      {open && (
        <div className="import-fields">
          {rows.map(([field, label, hint]) => (
            <label key={field} className="import-field">
              <span className="import-field-label">
                {label}{field === 'assignee' && assigneeRequired ? ` (${t.topbar.importProject.required})` : ''}
              </span>
              <input
                className={`import-input ${askedFields.includes(field) || (field === 'assignee' && assigneeRequired) ? 'is-asked' : ''}`}
                spellCheck={false}
                list={field === 'ghUser' && accounts.length ? 'import-gh-accounts' : undefined}
                value={answers[field] ?? ''}
                onChange={(e) => set(field, e.target.value)}
                aria-required={field === 'assignee' && assigneeRequired ? true : undefined}
                placeholder={placeholderOf(field)}
              />
              {hintOf(field, hint) && <span className="import-field-hint">{hintOf(field, hint)}</span>}
            </label>
          ))}
          {accounts.length > 0 && (
            <datalist id="import-gh-accounts">
              {accounts.map((a) => <option key={a.login} value={a.login} label={accountLabel(t, a)} />)}
            </datalist>
          )}
        </div>
      )}

      {error && <p className="import-error" aria-live="polite">{error}</p>}
      {imported && <p className="import-error" aria-live="polite">{t.topbar.importProject.warnings}</p>}
      {problems.length > 0 && (
        <ul className="import-problems">
          {problems.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}
    </Dialog>
  );
}
