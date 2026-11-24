import { readFileSync } from 'node:fs';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

/**
 * The check a snapshot must pass before it counts: every file reads, is not all
 * zero bytes (what a power cut leaves), and parses as JSON.
 *
 * Run in a worker thread by `snapshots.js`: parsing 400 MB of JSON on the main
 * thread would hold the event loop for seconds. Only `node:*` here, so the worker
 * loads nothing of the board.
 *
 * @param {{rel: string, file: string}[]} files
 * @returns {{rel: string, problem: string}[]} the files that failed, with why.
 */
export function checkFiles(files) {
  const problems = [];
  for (const { rel, file } of files) {
    let buf;
    try {
      buf = readFileSync(file);
    } catch (e) {
      problems.push({ rel, problem: `could not be read (${e.code ?? e.message})` });
      continue;
    }
    if (!buf.length) { problems.push({ rel, problem: 'empty' }); continue; }
    let nul = true;
    for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) { nul = false; break; }
    if (nul) { problems.push({ rel, problem: `${buf.length} zero bytes` }); continue; }
    try {
      JSON.parse(buf.toString('utf8').replace(/^﻿/, ''));
    } catch (e) {
      problems.push({ rel, problem: `not valid JSON (${e.message})` });
    }
  }
  return problems;
}

if (!isMainThread && workerData?.files) {
  parentPort.postMessage(checkFiles(workerData.files));
}
