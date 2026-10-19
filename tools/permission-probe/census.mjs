#!/usr/bin/env node
// Exp 0 - the census. Walks every CLI transcript on this machine, finds every
// tool denial, and says: project, session, phase, main thread or subagent,
// which tool, and how many seconds after the session's first end-of-turn.
//
// Reads only. Never imports anything from server/src: `tasks.json` is parsed
// with readFileSync so the live board's store is not touched.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
// Pure (only node:*), not the store: puts a task's log back when the board has split it into taskdata/.
import { readTasksFileMerged } from '../../server/src/splitfmt.js';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';

const PROJECTS = join(homedir(), '.claude', 'projects');
const BOARD = process.env.HFSMON_BOARD ?? decodeURIComponent(new URL('../..', import.meta.url).pathname).replace(/^[/]([A-Za-z]:)/, '$1').replace(/[/]$/, ''); // repo root, from this file's location; HFSMON_BOARD points the probes at the live board when run from a worktree
const OUT = join(BOARD, 'tools', 'permission-probe', 'out');

// ---------------------------------------------------------------- transcripts
function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

const parseCache = new Map();
function parse(file) {
  if (parseCache.has(file)) return parseCache.get(file);
  let rows = [];
  try {
    rows = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { rows = []; }
  if (parseCache.size > 40) parseCache.clear();
  parseCache.set(file, rows);
  return rows;
}

// A subagent transcript lives at <project>/<sessionId>/subagents/agent-*.jsonl.
// Its main thread is <project>/<sessionId>.jsonl.
function mainFileOf(file) {
  if (!file.includes(`${sepJoin('subagents')}`)) return file;
  const sessionDir = dirname(dirname(file));
  return `${sessionDir}.jsonl`;
}
function sepJoin(name) { return join('x', name).slice(1); } // platform separator + name

// ------------------------------------------------------------------ tool names
function toolNameFor(rows, id) {
  for (const r of rows) {
    if (r.type !== 'assistant') continue;
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === 'tool_use' && b.id === id) {
        return { name: b.name, input: b.input, ts: r.timestamp, uuid: r.uuid, sidechain: !!r.isSidechain };
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------ turn ends
// The transcript holds no SDK `result` frame. The closest faithful proxy for
// "the session produced a result" is an assistant message on the MAIN thread
// that stops without asking for a tool: stop_reason 'end_turn' (or any
// assistant message carrying no tool_use block).
function turnEnds(rows) {
  const out = [];
  for (const r of rows) {
    if (r.type !== 'assistant' || r.isSidechain) continue;
    const content = r.message?.content;
    const hasTool = Array.isArray(content) && content.some((b) => b.type === 'tool_use');
    if (hasTool) continue;
    const stop = r.message?.stop_reason;
    if (stop === 'tool_use') continue;
    out.push({ ts: Date.parse(r.timestamp), stop });
  }
  return out;
}

function userPrompts(rows) {
  return rows.filter((r) => r.type === 'user' && !r.isSidechain
    && (typeof r.message?.content === 'string'
      || (Array.isArray(r.message?.content) && r.message.content.every((b) => b.type === 'text'))))
    .map((r) => ({ ts: Date.parse(r.timestamp), permissionMode: r.permissionMode, origin: r.origin, source: r.promptSource }));
}

// --------------------------------------------------------------------- tasks
const tasks = readTasksFileMerged(join(BOARD, 'server', 'data', 'tasks.json'));
// sessionId -> {issue, where}
const sessionIndex = new Map();
for (const [issue, task] of Object.entries(tasks)) {
  const seen = new Set();
  const visit = (v, path) => {
    if (v == null) return;
    if (typeof v === 'string') {
      const m = v.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g);
      if (m) for (const id of m) if (!seen.has(id + path)) { seen.add(id + path); push(id, issue, path); }
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => visit(x, `${path}[${i}]`)); return; }
    if (typeof v === 'object') { for (const [k, x] of Object.entries(v)) visit(x, path ? `${path}.${k}` : k); }
  };
  visit(task, '');
}
function push(id, issue, path) {
  if (!sessionIndex.has(id)) sessionIndex.set(id, []);
  sessionIndex.get(id).push({ issue, path });
}

function phaseAt(issue, tsMs) {
  const log = tasks[issue]?.log;
  if (!Array.isArray(log)) return null;
  let best = null;
  for (const e of log) {
    const t = Date.parse(e.ts);
    if (Number.isNaN(t) || t > tsMs) continue;
    if (!best || t >= best.t) best = { t, phase: e.phase, line: e.line };
  }
  return best;
}

// ---------------------------------------------------------------------- main
const rowsOut = [];
const files = [...walk(PROJECTS)];
let scanned = 0;
for (const file of files) {
  let head;
  try { if (statSync(file).size === 0) continue; head = readFileSync(file, 'utf8'); } catch { continue; }
  if (!head.includes('"toolDenialKind"')) continue;
  scanned++;
  const rows = head.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const isSub = /subagents/.test(file);
  const mainFile = isSub ? `${dirname(dirname(file))}.jsonl` : file;
  let mainRows = rows;
  if (isSub) { try { mainRows = parse(mainFile); } catch { mainRows = []; } }
  const ends = turnEnds(mainRows.length ? mainRows : rows);
  const firstEnd = ends.length ? ends[0].ts : null;
  const prompts = userPrompts(mainRows.length ? mainRows : rows);
  const lastTs = Math.max(...rows.map((r) => Date.parse(r.timestamp) || 0));

  for (const r of rows) {
    if (!r.toolDenialKind) continue;
    const ts = Date.parse(r.timestamp);
    const block = Array.isArray(r.message?.content) ? r.message.content.find((b) => b.type === 'tool_result') : null;
    const id = block?.tool_use_id;
    let tool = id ? toolNameFor(rows, id) : null;
    if (!tool && id && isSub) tool = toolNameFor(mainRows, id);
    const text = typeof block?.content === 'string' ? block.content : JSON.stringify(block?.content ?? '');
    const sid = r.sessionId;
    const mainSid = isSub ? basename(mainFile, '.jsonl') : sid;
    const hits = sessionIndex.get(sid) || sessionIndex.get(mainSid) || [];
    const issue = hits.length ? hits[0].issue : null;
    const where = hits.length ? hits.map((h) => h.path).join('|') : null;
    const ph = issue ? phaseAt(issue, ts) : null;
    // last main-thread turn end before the denial
    let prevEnd = null; for (const e of ends) if (e.ts <= ts) prevEnd = e.ts;
    let prevPrompt = null; for (const p of prompts) if (p.ts <= ts) prevPrompt = p;
    rowsOut.push({
      project: basename(isSub ? dirname(dirname(dirname(file))) : dirname(file)),
      file: file.replace(PROJECTS, '~').replace(/\\/g, '/'),
      session: sid, mainSession: mainSid,
      sidechain: !!r.isSidechain || isSub,
      entrypoint: r.entrypoint, version: r.version, cwd: r.cwd,
      kind: r.toolDenialKind,
      tool: tool?.name ?? '(unresolved)',
      cmd: tool?.input?.command ? String(tool.input.input ?? tool.input.command).slice(0, 80)
        : (tool?.input ? JSON.stringify(tool.input).slice(0, 80) : ''),
      bg: tool?.input?.run_in_background ?? null,
      ts: r.timestamp,
      issue, taskWhere: where, phase: ph?.phase ?? null, phaseLine: ph?.line?.slice(0, 70) ?? null,
      permissionMode: prevPrompt?.permissionMode ?? null,
      promptSource: prevPrompt?.source ?? null,
      firstEndDeltaS: firstEnd == null ? null : Math.round((ts - firstEnd) / 1000),
      prevEndDeltaS: prevEnd == null ? null : Math.round((ts - prevEnd) / 1000),
      toSessionEndS: Math.round((lastTs - ts) / 1000),
      turnEndsBefore: ends.filter((e) => e.ts <= ts).length,
      promptsBefore: prompts.filter((p) => p.ts <= ts).length,
      snippet: text.slice(0, 90).replace(/\s+/g, ' '),
    });
  }
}

rowsOut.sort((a, b) => a.ts.localeCompare(b.ts));
writeFileSync(join(OUT, 'census.log'), JSON.stringify(rowsOut, null, 1));

const want = process.argv[2] || null; // e.g. 'cancelled'
const shown = want ? rowsOut.filter((r) => r.kind === want) : rowsOut;
console.log(`files with denials: ${scanned} / ${files.length} transcripts`);
const byKind = {};
for (const r of rowsOut) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
console.log('by kind:', byKind);
const byKindTool = {};
for (const r of rowsOut) { const k = `${r.kind} / ${r.tool}`; byKindTool[k] = (byKindTool[k] || 0) + 1; }
console.log('by kind+tool:', byKindTool);
console.log('');
const cols = ['ts', 'project', 'session', 'sidechain', 'entrypoint', 'tool', 'bg', 'issue', 'phase', 'permissionMode', 'firstEndDeltaS', 'prevEndDeltaS', 'toSessionEndS', 'turnEndsBefore', 'promptsBefore', 'version'];
console.log(cols.join('\t'));
for (const r of shown) console.log(cols.map((c) => String(r[c] ?? '')).join('\t'));
console.log(`\nwrote ${join(OUT, 'census.log')} (${rowsOut.length} denials)`);
