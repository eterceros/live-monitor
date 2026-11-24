import { takeSnapshot } from './snapshots.js';

/**
 * The start-up snapshot, taken when this module is first evaluated. It is the
 * FIRST import of every module that can write into the data folder at start-up
 * (settings, store, project chats, projects, quota, upgrade, board timings), so
 * whichever of them loads first takes it before anything is written, converted
 * or moved aside: the data exactly as the last run (or a cut) left it.
 */
export const bootSnapshot = takeSnapshot('boot');
