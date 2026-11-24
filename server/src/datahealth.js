import { EventEmitter } from 'node:events';
import path from 'node:path';

/**
 * What the board found wrong with its own data files, for the log and for the
 * banner on the board. A file that could not be read, was read from a backup, or
 * was moved aside so nothing overwrites it: the person must hear about it in the
 * board itself, not only in a log nobody opens.
 *
 * The text is English (it reaches the screen). In memory only: the problems are
 * found at start-up, and the next start-up finds them again if they are still there.
 */

export const dataHealthEvents = new EventEmitter();
const items = [];
let seq = 0;

/**
 * Records one problem and logs it.
 *
 * @param {{file: string, problem: string, action: string, severity?: 'error'|'warning'}} p
 *   `problem`: what is wrong; `action`: what the board did about it (and where the damaged copy is).
 */
export function reportDataProblem({ file, problem, action, severity = 'error' }) {
  // A file read on every call (the project registry while it has no file) must
  // not fill the log and the banner with the same line.
  const same = items.find((i) => i.path === String(file) && i.problem === String(problem));
  if (same) return same;
  const item = {
    id: ++seq,
    at: new Date().toISOString(),
    severity,
    file: path.basename(String(file)),
    path: String(file),
    problem: String(problem),
    action: String(action ?? ''),
  };
  items.push(item);
  console.error(`[data] ${item.path}: ${item.problem}. ${item.action}`);
  dataHealthEvents.emit('change', dataHealth());
  return item;
}

/** Every problem recorded since start-up, oldest first. */
export const dataHealth = () => items.map((i) => ({ ...i }));

/** Test seam. */
export function _resetDataHealthForTests() {
  items.length = 0;
}

/**
 * Reports what a `readJsonDurable` result says, if anything. Returns the result.
 * `what` names the file for a person ("the settings", "the tasks of ehr").
 */
export function reportRead(file, result, what) {
  if (result.status === 'missing' || !result.problems?.length) return result;
  const why = result.problems.map((p) => `${path.basename(p.file)}: ${p.problem}`).join('; ');
  const kept = result.keptAt ? ` The damaged file was kept as ${path.basename(result.keptAt)}.` : '';
  if (result.status === 'ok') {
    reportDataProblem({
      file,
      problem: `${what} could not be read from ${path.basename(file)} (${why})`,
      action: `Loaded from the backup ${path.basename(result.source)}; the last changes before it may be missing.${kept}`,
    });
  } else {
    reportDataProblem({
      file,
      problem: `${what} could not be read and no backup was usable (${why})`,
      action: `Started without them.${kept || ' The damaged file could NOT be moved aside.'}`,
    });
  }
  return result;
}
