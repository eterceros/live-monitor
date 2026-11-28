/**
 * What the screens decide about a project's rows from
 * `GET /api/projects/:p/machines`. Plain functions, so Node tests can run them.
 */
import { fill } from './i18n/index.js';

/** A clone or install waiting its turn on the machine is as unfinished as a running one. */
export const isBusy = (job) => job?.status === 'queued' || job?.status === 'running';

/**
 * A machine the project can live on. A runner is left out when the convention is
 * off and it has no path of its own, or when the project has no repository to
 * clone.
 */
export const hostsProject = (row) => row.kind === 'local' || !['projects_root_off', 'no_repo'].includes(row.reason);

/**
 * Whether the install question offers to run a saved «yes» again: picking the
 * option that is already selected changes nothing, so it needs its own button.
 *
 * @param {object} row
 * @param {'yes'|'no'|undefined} drafted the answer changed here and not yet saved
 */
export function canRunAgain(row, drafted) {
  if (row.install !== 'yes' || drafted || isBusy(row.job)) return false;
  if (row.kind === 'local' && row.nodeModules) return false;
  return row.job?.status === 'failed' || row.job?.status === 'idle';
}

/**
 * One line saying how a runner's copy of the project stands. A job in progress
 * or failed says more than what is on disk. «Deferred» is only said of work the
 * board will run again on its own (`row.deferred`).
 */
export function cloneState(s, row, online) {
  const { job } = row;
  if (job?.status === 'queued') return s.queued;
  if (isBusy(job)) return job.step === 'install' ? s.installing : s.cloning;
  if (job?.status === 'failed') return row.deferred ? s.deferred : fill(s.failed, { message: job.error });
  if (online === false || row.reason === 'home_unknown') return s.unreachable;
  if (row.present) return s.cloned;
  if (row.autoClone === false) return s.excluded;
  // The default project's path is one the config sets too.
  if (row.reason === 'explicit_path' || row.reason === 'default_project') return s.explicitPath;
  return s.notCloned;
}

/** What a card offers for one runner. */
export function cloneActions(row) {
  const failed = row.job?.status === 'failed';
  // A path written in the config is never cloned unasked, so it has no switch.
  const byConvention = row.reason !== 'explicit_path' && row.reason !== 'default_project';
  // A failure nobody else will retry can always be retried by hand.
  const retry = failed && !row.deferred;
  return {
    failed,
    byConvention,
    canClone: !isBusy(row.job) && (retry || (byConvention && (failed || !row.present))),
    // A failure carries the server's message: it wraps, never truncates.
    wraps: failed && !row.deferred,
  };
}

/**
 * How the import dialog is dismissed (X, Esc, backdrop). Once the project is
 * imported, any way out counts as imported, so the install question follows.
 */
export function dismissOf({ busy, imported, onClose, onImported }) {
  if (busy) return null;
  return imported ? () => onImported(imported) : onClose;
}
