import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

export { parseTaggedJson, stripTaggedLine } from './tagged.js';
// Re-exported: `sessionOptions` below is the reason it exists, and a caller
// asking claude.js about it should not have to know where it lives.
export { isLoopbackUrl } from './loopback.js';
import { isLoopbackUrl } from './loopback.js';
import { noteResolved } from './models.js';
import { effortOptionsFor } from './effort.js';
import { detectRateLimit, noteQuotaHit, noteQuotaWarning, noteQuotaAlive } from './quota.js';
import { noteUsageEvent } from './usage.js';
import { record as recordSpan, openPhaseOf } from './metrics.js';
import { SUBAGENT_TOOLS } from './subagentgate.js';
import { createSealNet, REPORT_SETTLE_MS } from './sealnet.js';
import { boardPluginPath } from './boardplugin.js';
import { ghEnvAt } from './gh-account.js';

// The cost a session had reached at its last result, by session id. The SDK's
// `total_cost_usd` is cumulative and continues from the transcript on resume,
// so what one call cost is the difference against where the last one stopped.
const COST_BASELINE_MAX = 500;
const costBaseline = new Map();
const tokenBaseline = new Map();

/**
 * What one run or chat turn cost and took, from the ctx `dispatch` filled.
 * `costUsd` is the delta of the running total; null when the session was
 * resumed from one this process never saw (no baseline) or no result carried a
 * cost. `tokens` come from `modelUsage`, which, unlike `usage`, includes subagents.
 */
export function statsOf(ctx, { ms, resumed = false, graceMs = 0, resumedFrom = null } = {}) {
  // A session continues its transcript when it was resumed, or when a live
  // process answers a later turn (`resumedFrom` is then the id it already had).
  const continued = resumed || Boolean(resumedFrom);
  const key = resumedFrom ?? null;
  const total = ctx.costUsdTotal ?? null;
  let costUsd = null;
  if (total != null) {
    if (!continued) costUsd = total;
    else if (key && costBaseline.has(key)) costUsd = Math.max(0, total - costBaseline.get(key));
    if (ctx.sessionId) {
      costBaseline.delete(ctx.sessionId);
      costBaseline.set(ctx.sessionId, total);
      if (costBaseline.size > COST_BASELINE_MAX) costBaseline.delete(costBaseline.keys().next().value);
    }
  }
  // `modelUsage` is cumulative like the cost, so `tokens` is the delta against
  // the last result of the same session; `tokensTotal` keeps the running total.
  let tokensTotal = null;
  let tokens = null;
  if (ctx.modelUsage) {
    tokensTotal = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    for (const u of Object.values(ctx.modelUsage)) {
      tokensTotal.input += u?.inputTokens ?? 0;
      tokensTotal.output += u?.outputTokens ?? 0;
      tokensTotal.cacheRead += u?.cacheReadInputTokens ?? 0;
      tokensTotal.cacheCreation += u?.cacheCreationInputTokens ?? 0;
    }
    if (!continued) tokens = { ...tokensTotal };
    else if (key && tokenBaseline.has(key)) {
      const base = tokenBaseline.get(key);
      tokens = {};
      for (const k of Object.keys(tokensTotal)) tokens[k] = Math.max(0, tokensTotal[k] - (base[k] ?? 0));
    }
    if (ctx.sessionId) {
      tokenBaseline.delete(ctx.sessionId);
      tokenBaseline.set(ctx.sessionId, tokensTotal);
      if (tokenBaseline.size > COST_BASELINE_MAX) tokenBaseline.delete(tokenBaseline.keys().next().value);
    }
  }
  return {
    ms, turns: ctx.turns ?? null, subtype: ctx.subtype ?? null,
    costUsdTotal: total, costUsd, tokens, tokensTotal, graceMs, resumed, sealedOpen: ctx.sealedOpen ?? 0,
    // `sealedEarly`: background subagents that had already reported inside the
    // sealed turn. `answerFrom`: whose answer the phase got: `sealed` (the sealed
    // result's), `post` (the later turn that closed the window) or `unclosed` (a
    // later turn was adopted but none closed the window) or `error-closed` (as
    // `unclosed`, then an error result, never adopted, did close it). `turns` is
    // the adopted result's `num_turns`, like `subtype`, not the session total.
    sealedEarly: ctx.sealedEarly ?? 0, answerFrom: ctx.answerFrom ?? 'sealed',
  };
}

const MAX_TOOL_KINDS = 30;

/** Writes the session span (and the grace wait, if any) for `runClaude`'s `metrics` option. */
function recordSession(metrics, ctx, stats, { startedAt, endedAt, graceStartedAt, outcome, within = null }) {
  const { task, role = null, stage = null, nudge = false } = metrics ?? {};
  if (!task) return;
  const counts = Object.entries(ctx.toolCounts).sort((a, b) => b[1] - a[1]).slice(0, MAX_TOOL_KINDS);
  const subagents = SUBAGENT_TOOLS.reduce((n, name) => n + (ctx.toolCounts[name] ?? 0), 0);
  // The uncapped total, which `toolCounts` (top 30 kinds) cannot give.
  const toolCalls = Object.values(ctx.toolCounts).reduce((a, b) => a + b, 0);
  recordSpan(task, {
    kind: 'session', name: stage ?? role ?? 'session', startedAt, endedAt, outcome,
    meta: {
      role, stage, within, nudge: nudge === true, toolCalls, model: ctx.requestedModel ?? null, effort: ctx.requestedEffort ?? null,
      turns: stats.turns, subtype: stats.subtype, toolCounts: Object.fromEntries(counts), subagents,
      resumed: stats.resumed, costUsd: stats.costUsd, costUsdTotal: stats.costUsdTotal, tokens: stats.tokens, sealedOpen: stats.sealedOpen,
      sealedEarly: stats.sealedEarly, answerFrom: stats.answerFrom,
    },
  });
  if (stats.graceMs > 0 && graceStartedAt) {
    recordSpan(task, {
      kind: 'wait', name: 'subagent_grace', startedAt: graceStartedAt,
      endedAt: new Date(Date.parse(graceStartedAt) + stats.graceMs).toISOString(),
      meta: { within: openPhaseOf(task), stage },
    });
  }
}

/**
 * How long a session is kept open past its own result for background work that
 * is still out. A subagent that never reports would otherwise hold the phase
 * for good; at the cap the board says so and ends the session itself:
 * interrupt, then (if it is still alive after `GRACE_END_MS`) kill the CLI's
 * process tree by pid and close the query. Closing stdin alone is not enough —
 * the CLI does not exit while a background command of its own is alive.
 */
export const TASK_GRACE_MS = 10 * 60_000;

/** How long each step of ending a session at the grace cap waits for the one before. */
export const GRACE_END_MS = 5_000;

/**
 * Seams. `query` exists so a test can drive `runClaude` without opening a real
 * session — the same trick `usage.js` plays with `usageHooks.query` — and
 * `taskGraceMs` so it need not wait ten minutes for the grace cap above, and
 * `reportSettleMs` for the short wait of `REPORT_SETTLE_MS`. `graceEndMs` and
 * `killTree` belong to the end of a session at the cap: the second is a seam
 * because a test with a made-up pid must never run a real `taskkill`.
 */
export const claudeHooks = {
  query,
  taskGraceMs: TASK_GRACE_MS,
  graceEndMs: GRACE_END_MS,
  // Ends the process tree of a pid the SDK reported for its local CLI. A remote
  // machine reports none, so this never runs there.
  killTree: (pid, machine) => machine?.daemon?.kill?.(pid),
  reportSettleMs: REPORT_SETTLE_MS,
  // Called with the machine name when a session of that machine reports that
  // its Claude login is dead. Wired by the board; unset in tests.
  onAuthFailure: null,
  // Called with `{ machine, skills, plugins, pluginErrors }` from the `init` frame
  // of a session, once per session. Wired by the board; unset in tests.
  onInit: null,
};

/**
 * The words the CLI puts in a `tool_result` when it refuses a tool call.
 *
 * The two records the SDK documents as authoritative for this —
 * `system/permission_denied` frames and `result.permission_denials` — arrived
 * empty in all four failing arms of `tools/permission-probe`, so this text is
 * the only in-band signal there is. It is matched loosely on purpose: the
 * sentence has had two spellings, and missing a denial is worse than matching
 * one too widely.
 */
export const DENIED_TOOL_TEXT = "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.";
const DENIED_RE = /doesn't want to (?:take this action|proceed)/;

/** True for the text of a `tool_result` the CLI refused to run. */
export const isDeniedToolResult = (text) => DENIED_RE.test(String(text ?? ''));

/** Whether a frame belongs to the turn that answers the prompt with this uuid. */
export const stamped = (message, uuid) =>
  message.user_message_uuid === uuid || (message.user_message_uuids ?? []).includes(uuid);

/**
 * Whether a `result` closes the turn that answers the prompt with this uuid —
 * the seal. Stamped results say so themselves. A successful result without a
 * stamp is a turn the process ran on its own (the turn that answers us always
 * echoes our uuid), so it is never ours, whatever else it carries. An error
 * result carries no stamp, so it is ours only when the CLI reports nothing
 * else of ours still waiting behind it.
 *
 * Shared by `runClaude` and `ChatSession`: one rule, one place.
 */
export function resultAnswers(result, uuid) {
  if (stamped(result, uuid)) return true;
  if (result.subtype === 'success') return false;
  const stampedAtAll = result.user_message_uuid !== undefined || result.user_message_uuids !== undefined;
  return !stampedAtAll && (result.queued_turn_count ?? 0) === 0;
}

/** The installed SDK's version, read from the file next to its entry point. */
export function sdkVersion() {
  try {
    const entry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
    return JSON.parse(readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/**
 * The newest SDK on npm, asked at most once a day. The CLI that resolves
 * `opus` to its newest version ships inside the SDK, so a board that never
 * updates it is the one way left to fall behind — and this is what notices.
 * No network, no answer, no error: null.
 */
let latestProbe = { at: 0, value: null, ok: false };
// A failed probe is remembered for minutes, not a day: a laptop that woke up
// offline would otherwise not hear of a new SDK until tomorrow.
export const LATEST_FAILURE_MAX_AGE_MS = 10 * 60_000;
export async function latestSdkVersion({ maxAgeMs = 24 * 60 * 60_000, failureMaxAgeMs = LATEST_FAILURE_MAX_AGE_MS } = {}) {
  const age = Date.now() - latestProbe.at;
  if (age < (latestProbe.ok ? maxAgeMs : failureMaxAgeMs)) return latestProbe.value;
  latestProbe = { at: Date.now(), value: null, ok: false };
  try {
    const res = await fetch('https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest', { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const version = (await res.json()).version ?? null;
      if (isStrictVersion(version)) latestProbe = { at: latestProbe.at, value: version, ok: true };
    }
  } catch { /* offline, or the registry is: nothing to say */ }
  return latestProbe.value;
}

/** Forgets the last registry probe (tests). */
export function resetLatestSdkProbe() {
  latestProbe = { at: 0, value: null, ok: false };
}

/** `x.y.z` and nothing else: a prerelease or a tag is never a version to offer. */
export const isStrictVersion = (v) => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v);

/** True when `latest` is a newer version than `current`; both must be strict `x.y.z`. */
export function isNewerVersion(latest, current) {
  if (!isStrictVersion(latest) || !isStrictVersion(current)) return false;
  const a = latest.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** True when `have` is a strict version at or above `want`. */
export function versionAtLeast(have, want) {
  return isStrictVersion(have) && isStrictVersion(want) && !isNewerVersion(want, have);
}

/**
 * The CLI an SDK version pairs with: the `claudeCodeVersion` its package
 * metadata declares, or — when that is missing — the lockstep rule
 * 0.3.N → 2.1.N. Null when neither says anything.
 */
export function pairedCliVersion(sdk, metadata = null) {
  if (isStrictVersion(metadata?.claudeCodeVersion)) return metadata.claudeCodeVersion;
  const m = /^0\.3\.(\d+)$/.exec(String(sdk ?? ''));
  return m ? `2.1.${m[1]}` : null;
}

/**
 * The CLI version this SDK speaks to. They ship in lockstep — SDK 0.3.N with
 * CLI 2.1.N, measured here: 0.3.266 ↔ 2.1.266 — and the stream-json protocol
 * between them is not guaranteed across a mismatch. A machine whose `claude`
 * says something else is refused before a task starts there, not after a fix
 * dies halfway with a protocol error nobody can read.
 *
 * Null when the SDK line is one this mapping does not know: then the guard
 * warns instead of refusing.
 */
export function expectedClaudeVersion() {
  try {
    // The SDK's `exports` map does not expose its package.json, so resolve the
    // entry point and read the file next to it.
    const entry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
    const pkg = JSON.parse(readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8'));
    return pairedCliVersion(pkg.version, pkg);
  } catch {
    return null;
  }
}

/**
 * The options every session gets, one-shot or live. The local `claude` login
 * (Pro/Max) stays the only credential *towards Anthropic*: ANTHROPIC_API_KEY is
 * stripped so the SDK can never fall back to pay-per-token API billing.
 *
 * `env` overlays the result of that stripping, for a session that must talk to
 * somewhere else — the delegate's loopback proxy, which rewrites the model to
 * an OpenCode one and injects the real key itself. A credential in the overlay
 * is therefore only accepted together with a base URL on 127.0.0.1: a loopback
 * address cannot reach Anthropic, so the guarantee above still holds however
 * this is called.
 */
export function sessionOptions({
  machine, cwd, model, resume, forkSession, maxTurns, hooks, mcpServers,
  permissionMode = 'bypassPermissions', canUseTool, planModeInstructions, settings, tools,
  env: overlay,
  // Tuning (effort.js). Each is optional and `undefined` passes nothing.
  effort, thinking, fastMode, fallbackModel, available, onWarning,
  // Which settings files the CLI reads. `local` is deliberately not offered:
  // pipeline sessions never load localSettings.
  settingSources = ['user', 'project'],
  // Board-owned plugins (`plugins/<name>/`) to load, by name. Resolved here to
  // the path on the machine the CLI runs on; absent means none.
  boardPlugins,
  // A design session: the only one that declares the VS Code entrypoint, which
  // is what makes the CLI load the `Artifact` tool (undocumented; see ADR-0082).
  design = false,
}) {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  // The GitHub account of the project this session works in, so a `gh` the
  // agent runs answers as that account (`gh-account.js`). Local sessions only:
  // a runner's CLI never receives this machine's tokens (`spawnClaude`).
  if (!machine || machine.kind === 'local') Object.assign(env, ghEnvAt(cwd));
  if (overlay) {
    const carriesCredential = 'ANTHROPIC_API_KEY' in overlay || 'ANTHROPIC_AUTH_TOKEN' in overlay;
    const toLoopback = isLoopbackUrl(overlay.ANTHROPIC_BASE_URL);
    if (carriesCredential && !toLoopback) {
      throw new Error('sessionOptions: an Anthropic credential is only accepted towards a local proxy (ANTHROPIC_BASE_URL on 127.0.0.1)');
    }
    Object.assign(env, overlay);
  }
  // Last word on the entrypoint, after the overlay: a board started from inside
  // another session must not leak its own into sessions that are not design ones.
  // The SDK itself only fills in `sdk-ts` when the variable is missing.
  if (design === true) env.CLAUDE_CODE_ENTRYPOINT = 'claude-vscode';
  else delete env.CLAUDE_CODE_ENTRYPOINT;

  const options = {
    cwd,
    model,
    // `bypassPermissions` for work, `plan` for a chat that must only read
    // until its plan is approved. The CLI enforces plan mode itself.
    permissionMode,
    allowDangerouslySkipPermissions: true,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: settingSources ?? ['user', 'project'],
    env,
    // What a subagent says, not just what it calls: without this the SDK only
    // forwards its tool blocks, and its final report is a blob nobody reads.
    forwardSubagentText: true,
  };
  // The two tools that need a person — `AskUserQuestion`, and `ExitPlanMode`
  // in plan mode — come through this callback even under bypass. The SDK warns
  // the opposite, once per session and for every tool alike
  // (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`), but the warning is blanket and these
  // two are the exception: measured again on CLI 2.1.281, a bypass session
  // asked to call `AskUserQuestion` reaches this callback. The board parks them
  // until someone answers from the panel.
  //
  // Everything else the warning says is true, and it is not a detail: a gate on
  // ordinary tool calls — a Bash line, say — put here is a gate that never
  // runs. Those belong in a `PreToolUse` hook below.
  if (canUseTool) options.canUseTool = canUseTool;
  // The body of the plan-mode reminder, in the board's words; the CLI keeps
  // its read-only preamble and the ExitPlanMode footer around it.
  if (planModeInstructions) options.planModeInstructions = planModeInstructions;
  // Session-scoped settings, such as where the CLI writes plan files.
  if (settings) options.settings = settings;
  if (resume) options.resume = resume;
  // Resuming appends to the very transcript it resumed — measured: the returned
  // session id is the same one. Forking replays that history into a session of
  // its own, which is what a branched chat needs to stop writing into its
  // parent's thread.
  if (resume && forkSession) options.forkSession = true;
  if (maxTurns) options.maxTurns = maxTurns;
  // Hooks fire between tool calls, which is the only opening a running
  // session has: what one returns as `additionalContext` reaches the model
  // there and then, without interrupting it. They are callbacks on this side
  // of the wire, so they keep working when the CLI runs on another machine.
  //
  // And a `PreToolUse` hook is the only thing that can still say no under
  // bypass — `permissionDecision: 'deny'` with `permissionDecisionReason` —
  // which is why the language gate on `gh` rides here and not on `canUseTool`.
  // Unlike that callback, hooks fire inside subagents too.
  if (hooks) options.hooks = hooks;
  // A task on another machine runs its CLI there — with that machine's login
  // — and the SDK talks to it through whatever the machine hands back.
  if (machine?.spawnClaude) options.spawnClaudeCodeProcess = machine.spawnClaude;
  // Extra tools for one session — the Playwright browser for Browser QA. The
  // CLI starts them, so they run wherever the CLI runs: next to the app.
  if (mcpServers) options.mcpServers = mcpServers;
  // The built-in tools the session has at all; `[]` leaves it none. Unlike a
  // `canUseTool` deny, this holds in plan mode too, where read-only tools run
  // without asking. Checked with `!== undefined`: an empty list is the point.
  if (tools !== undefined) options.tools = tools;
  // A plugin the CLI cannot find would fail the session; a path of the wrong
  // machine would be silently ignored. So a name with no path on this machine is
  // dropped and reported, and the session starts without it.
  if (boardPlugins?.length) {
    const plugins = [];
    for (const name of boardPlugins) {
      const dir = boardPluginPath(machine, name);
      if (dir) plugins.push({ type: 'local', path: dir });
      else (onWarning ?? ((m) => console.warn(`[plugin] ${m}`)))(`the board plugin «${name}» is not available on ${machine?.name ?? 'local'}: the session goes on without it`);
    }
    if (plugins.length) options.plugins = plugins;
  }
  // Effort, thinking, fast mode, fallback. A combination the model
  // family cannot honour is dropped and reported, never thrown: this runs at
  // session start, from config.
  const tuning = effortOptionsFor({ model, effort, thinking, fastMode, fallbackModel, settings, available });
  Object.assign(options, tuning.options);
  for (const w of tuning.warnings) (onWarning ?? ((m) => console.warn(`[effort] ${m}`)))(w);
  return options;
}

/**
 * Turns one SDK message into the board's events. Shared by the one-shot runner
 * below and the live chat session, so both see the same things: what a tool
 * was asked, what it answered, what a subagent did inside its own thread, and
 * what a background command reported after the turn moved on.
 *
 * `ctx.toolCounts` is filled here because nothing in the board counted anything
 * before: "parallelise" was an instruction nobody could check, and a session
 * that fanned out looked exactly like one that went single file.
 */
export function dispatch(message, ctx) {
  const { onEvent } = ctx;
  // The account's limit, before anything else this message might say. Shared
  // by the phases and by the live chats, on this machine and on a runner: it
  // is the one place every session's frames go through.
  //
  // Except for a session that is not speaking to Anthropic at all: the
  // delegate's harness runs on another provider's model through the loopback
  // proxy, and its answers say nothing about this account's window. Counting
  // them as «the window is open» would drain everything parked against a limit
  // that is still shut.
  if (ctx.trackQuota !== false) {
    quotaFrom(message, ctx);
    // Same exemption, same reason: a delegated session's login is not ours.
    authFrom(message, ctx);
  }
  switch (message.type) {
    case 'system':
      dispatchSystem(message, ctx);
      break;

    case 'assistant': {
      const parentId = message.parent_tool_use_id ?? null;
      for (const block of message.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim()) {
          onEvent?.({ kind: 'text', text: block.text, parentId });
        } else if (block.type === 'tool_use') {
          // Subagent calls count too: they are the fan-out being measured.
          ctx.toolCounts[block.name] = (ctx.toolCounts[block.name] ?? 0) + 1;
          // Remembered only so a denial can be named: the refusal arrives as a
          // `tool_result`, which carries the call's id and not its tool.
          (ctx.toolNames ??= new Map()).set(block.id, block.name);
          onEvent?.({
            kind: 'tool', id: block.id, name: block.name, parentId,
            input: summarizeToolInput(block), args: block.input ?? {},
          });
        }
      }
      break;
    }

    case 'user': {
      // Tool results ride on user-role messages. This is where the output of
      // Bash, the text a subagent came back with and a failed test's tail
      // actually are — and what the board used to throw away unread.
      const parentId = message.parent_tool_use_id ?? null;
      const content = message.message?.content;
      if (!Array.isArray(content)) break;
      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        const output = resultText(block.content);
        const denied = isDeniedToolResult(output);
        onEvent?.({
          kind: 'tool_end',
          id: block.tool_use_id,
          parentId,
          ok: !block.is_error,
          output,
          structured: message.tool_use_result ?? null,
          denied,
        });
        // A denial is never a detail. The text above tells the model to stop and
        // wait for the user, and a phase has no user: whatever was being done
        // stops there and nobody would have known why. So it is said out loud,
        // as a warning the phase log paints with ⚠️.
        if (denied) {
          const name = ctx.toolNames?.get(block.tool_use_id);
          onEvent?.({
            kind: 'warn',
            warning: `the CLI DENIED the call to ${name ?? 'a tool'}${parentId ? ' from a subagent' : ''} and told the model to wait for a user who does not exist in a phase`,
          });
        }
      }
      break;
    }

    case 'tool_progress':
      onEvent?.({
        kind: 'progress', id: message.tool_use_id, name: message.tool_name,
        parentId: message.parent_tool_use_id ?? null, elapsed: message.elapsed_time_seconds,
      });
      break;

    case 'result': {
      // A turn that ended on a dead login can still arrive as a `success`
      // result carrying the error text, so `ctx.auth` overrides the subtype.
      const ok = message.subtype === 'success' && !ctx.auth;
      // `ctx.sealed` says the result that answered our prompt already came and
      // went. With the input channel held open (see `runClaude`) the CLI runs
      // turns of its own afterwards — reacting to background work — and each
      // ends in a result of its own. Those are post-turn: the log and the tool
      // counters take them, the phase's answer does not. Without this the
      // TRIAGE_RESULT line, the work plan or the body of a PR would be
      // whatever the last of those turns happened to say.
      //
      // The exception is a phase that fans out first and answers last: if the
      // seal left subagents owing a report (`sealnet.js`), the sealed text is
      // only the sentence that says «they are still working». Then the later
      // successful results replace it, up to the turn that follows the last
      // report (`ctx.adopting`, set by `runClaude` from the net). Background
      // commands do not count: a session that answered and then reacts to one
      // keeps its own answer.
      const adopt = !ctx.sealed || ctx.adopting === true;
      if (adopt) {
        // A text adopted after the seal that another adopted text replaces is kept
        // (newest first, bounded): the good answer can be an intermediate turn's,
        // and the turn that follows may be an acknowledgement.
        const next = message.result ?? '';
        if (ctx.sealed && ctx.answerFrom && ctx.resultText && ctx.resultText !== next) {
          ctx.replaced = [ctx.resultText, ...(ctx.replaced ?? []).filter((t) => t !== ctx.resultText)].slice(0, 5);
        }
        ctx.ok = ok;
        ctx.resultText = next;
        // `post` only when this result ended the window; a later turn adopted
        // without closing it may still be a waiting sentence (`unclosed`).
        if (ctx.sealed) ctx.answerFrom = ctx.closes === true ? 'post' : 'unclosed';
      } else if (ctx.sealed && ctx.closes === true && ctx.answerFrom === 'unclosed') {
        // An error result ended the window without being adopted: a turn did
        // close it, so `unclosed` («no turn closed the window») would be false.
        ctx.answerFrom = 'error-closed';
      }
      if (message.session_id) ctx.sessionId = message.session_id;
      // For the timings (`statsOf`). Subtype and turns follow the answer: those
      // of the sealed result, or of the later turn that replaced it, so `ok` and
      // the subtype never disagree. A post-turn `error_max_turns` that was not
      // adopted does not rewrite how the phase's own turn ended. Cost and usage
      // are running totals in the SDK ("read the latest result rather than
      // summing"), so the latest wins.
      if (adopt) {
        ctx.subtype = message.subtype ?? null;
        ctx.turns = message.num_turns ?? null;
      }
      if (Number.isFinite(message.total_cost_usd)) ctx.costUsdTotal = message.total_cost_usd;
      if (message.modelUsage && typeof message.modelUsage === 'object') ctx.modelUsage = message.modelUsage;
      onEvent?.({ kind: 'result', ok, costUsd: message.total_cost_usd, turns: message.num_turns, post: Boolean(ctx.sealed) });
      break;
    }

    default:
      break;
  }
}

/**
 * Reads one message for the account's limit, and tells `quota.js` what it saw.
 *
 * A rejection marks the turn — `ctx.quota` — instead of throwing: too many
 * call sites read an exception as «the task failed», and this is not a failure
 * of the task. A warning never parks; it is remembered, because it carries the
 * hour a later rejection may not.
 *
 * The other direction matters just as much: a real answer from the model is
 * the only thing that can say a shut window has reopened, and that is what
 * lets the canary drain the rest of what is parked.
 */
function quotaFrom(message, ctx) {
  const hit = detectRateLimit(message);
  // Every window reading the account sends feeds the quota meter's fallback,
  // whatever the status: it is what the meter shows while its probe cannot.
  if (hit?.via === 'sdk') noteUsageEvent(hit);
  if (hit?.status === 'rejected') {
    ctx.quota = true;
    const hold = noteQuotaHit(hit);
    ctx.onEvent?.({ kind: 'quota', until: hold.until ?? null, certainty: hold.certainty, via: hit.via });
    return;
  }
  if (hit?.status === 'warning') {
    noteQuotaWarning(hit);
    ctx.onEvent?.({ kind: 'quota_warning', utilization: hit.utilization ?? null, until: hit.resetsAt ?? null });
    return;
  }
  // The account saying the window is open, before a single token is spent:
  // the cheapest possible confirmation that the canary made it through.
  if (hit?.status === 'allowed') {
    noteQuotaAlive();
    return;
  }
  // Something the model actually produced: nothing of this reaches a session
  // sitting behind a closed window.
  if (message.type === 'assistant' && !message.error && (message.message?.content ?? []).length) noteQuotaAlive();
  else if (message.type === 'result' && message.subtype === 'success') noteQuotaAlive();
}

/**
 * The machine's Claude login is dead. Matches the SDK's structured error
 * (`assistant.error`, or `system/api_retry.error`), never the English sentence.
 * Marks the turn (`ctx.auth`, so its result is not ok), tells the listener once
 * per context and the board on every sighting (marking a login expired is
 * idempotent). Carries the machine name only: no URL, no output.
 */
function authFrom(message, ctx) {
  const hit = (message.type === 'assistant' || (message.type === 'system' && message.subtype === 'api_retry'))
    && message.error === 'authentication_failed';
  if (!hit) return;
  const machine = ctx.machine ?? 'local';
  const first = !ctx.auth;
  ctx.auth = true;
  if (first) ctx.onEvent?.({ kind: 'auth', machine });
  claudeHooks.onAuthFailure?.(machine);
}

function dispatchSystem(message, ctx) {
  const { onEvent } = ctx;
  switch (message.subtype) {
    case 'init': {
      ctx.sessionId = message.session_id;
      // The CLI repeats the frame every turn; announce what it carries once
      // per context, and only when it carries anything about plugins.
      if (claudeHooks.onInit && !ctx.initAnnounced && (message.skills || message.plugins || message.plugin_errors)) {
        ctx.initAnnounced = true;
        try {
          claudeHooks.onInit({
            machine: ctx.machine, skills: message.skills ?? [], plugins: message.plugins ?? [], pluginErrors: message.plugin_errors ?? [],
          });
        } catch { /* a listener must not break the session */ }
      }
      // What the alias in config turned into today, and whether that is new.
      const note = noteResolved(ctx.requestedModel, message.model);
      onEvent?.({
        kind: 'init', sessionId: ctx.sessionId, model: message.model,
        requested: ctx.requestedModel ?? null, changed: note.changed, previous: note.previous,
        // Commands whose UX is bound to a terminal: a chat refuses them.
        terminalCommands: Array.isArray(message.terminal_slash_commands) ? message.terminal_slash_commands : [],
      });
      break;
    }
    // The command list changed mid-session (a skill found in a subdirectory):
    // the payload replaces whatever list the listener cached.
    case 'commands_changed':
      if (Array.isArray(message.commands)) onEvent?.({ kind: 'commands', commands: message.commands });
      break;
    // `/compact`, or the CLI compacting by itself: the status while it runs,
    // the boundary with the token counts when it is done.
    case 'status':
      onEvent?.({
        kind: 'status', status: message.status ?? null,
        compactResult: message.compact_result ?? null, compactError: message.compact_error ?? null,
      });
      break;
    case 'compact_boundary':
      onEvent?.({
        kind: 'compact', trigger: message.compact_metadata?.trigger ?? null,
        preTokens: message.compact_metadata?.pre_tokens ?? null, postTokens: message.compact_metadata?.post_tokens ?? null,
      });
      break;
    // A command sent to the background, or a subagent: it has a life of its
    // own past the tool call that started it, and reports through these.
    case 'task_started':
      if (message.ambient) break;
      onEvent?.({
        kind: 'task_started', taskId: message.task_id, toolUseId: message.tool_use_id ?? null,
        description: message.description, background: message.is_backgrounded === true,
        taskType: message.task_type ?? null,
      });
      break;
    case 'task_progress':
      onEvent?.({
        kind: 'task_progress', taskId: message.task_id, toolUseId: message.tool_use_id ?? null,
        description: message.description, lastTool: message.last_tool_name ?? null,
        summary: message.summary ?? null,
      });
      break;
    case 'task_notification':
      if (message.ambient) break;
      onEvent?.({
        kind: 'task_done', taskId: message.task_id, toolUseId: message.tool_use_id ?? null,
        status: message.status, summary: message.summary ?? '', outputFile: message.output_file ?? null,
      });
      break;
    default:
      break;
  }
}

/** The text of a tool_result: a string, or blocks of which the text ones matter. */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

/**
 * The phase's prompt, as a stream that stays open.
 *
 * A `prompt` given to the SDK as a string — and a generator that *returns*,
 * which is the same thing: the SDK calls `endInput()` when it runs dry — closes
 * the CLI's stdin at the first `result`. Stdin is the control channel, so with
 * it gone every hook of ours, being a callback on this side of the wire, is
 * aborted mid-flight; and the CLI then denies every tool the aborted
 * `PreToolUse` hook's matcher covers. The CLI says so itself:
 *
 *   PreToolUse SDK callback hook cancelled (control stream closed)
 *   hook failed: core: errorKind=AbortError (classic.PreToolUse; skipped)
 *
 * Measured in `tools/permission-probe`: the same hook with a string prompt →
 * one denial; the same hook with the channel open → none. `canUseTool` and
 * `settingSources` made no difference, and the permission mode never degraded.
 * What suffers most is a subagent still working after the main thread closed
 * its turn — the shape of every phase that fans out.
 *
 * So the turn's message goes out and the generator then *waits*: only
 * `release()` ends it, and `runClaude` releases when the turn is over for real.
 * Same idea as `idlePrompt()` in `usage.js`, which keeps its probe session open
 * without ever sending a turn.
 */
function phasePrompt(text, sessionId) {
  const uuid = randomUUID();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  async function* stream() {
    // The shape `session.js` pushes. The uuid is the point: the CLI echoes it
    // back on the frames of the turn that answers this prompt, which is how
    // that turn's result is told from the ones the CLI runs on its own.
    yield {
      type: 'user',
      uuid,
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: sessionId ?? '',
    };
    await gate;
  }
  return { prompt: stream(), uuid, release };
}

/**
 * Keeps `tasks` — the background work still out, subagents included — up to
 * date from one message.
 *
 * `background_tasks_changed` is a level with REPLACE semantics and is what this
 * trusts: a bookend the board misses cannot wedge a task that is long gone.
 * The edges stay as a fallback because the level's own documentation warns of
 * two things: nothing is emitted at startup, and its order against
 * `task_started`/`task_notification` for the same transition is unspecified.
 * Ambient entries (watchers, `skip_transcript` work) are not activity and are
 * skipped here, exactly as `dispatchSystem` skips them.
 */
function trackTasks(message, tasks, toolNames) {
  if (message.type !== 'system') return;
  // `tasks` maps id → «is a subagent». A task of unknown type counts as a
  // command: the seal rule only bends for work known to be a subagent.
  const isAgent = (t, was) => was || t.task_type === 'local_agent' || t.task_type === 'agent'
    || Boolean(t.subagent_type) || SUBAGENT_TOOLS.includes(toolNames?.get(t.tool_use_id));
  switch (message.subtype) {
    case 'background_tasks_changed': {
      const before = new Map(tasks);
      tasks.clear();
      for (const t of message.tasks ?? []) {
        if (!t?.ambient && t?.task_id) tasks.set(t.task_id, isAgent(t, before.get(t.task_id) ?? false));
      }
      break;
    }
    case 'task_started':
      if (!message.ambient && message.task_id) tasks.set(message.task_id, isAgent(message, false));
      break;
    case 'task_notification':
      if (!message.ambient && message.task_id) tasks.delete(message.task_id);
      break;
    default:
      break;
  }
}

/**
 * Runs one Claude Code turn in `cwd` and waits for it: the phases (triage,
 * fix, demo…) work this way, one process per call. Chats do not — see
 * `session.js` — because a process per prompt re-reads the whole transcript
 * every time and kills its background commands when the turn ends.
 *
 * `prompt` stays a string here, at the boundary: the generator that carries it
 * is built inside (`phasePrompt`), because every caller and every stub of this
 * function reads the prompt as text.
 *
 * When the turn is over is two conditions, not one. «A result arrived» was the
 * old answer and it is precisely the one that closed the channel too early:
 *
 *   1. the result that answers OUR prompt has arrived (`resultAnswers`), and
 *   2. nothing non-ambient is still running — no background command, no
 *      subagent, and no turn of the CLI's own in flight.
 *
 * Whatever is still out at `TASK_GRACE_MS` is given up on: the board says so,
 * closes the channel and ends the session (interrupt, then kill the CLI's tree
 * by pid and close the query), so a task that never reports costs ten minutes
 * instead of the whole phase. A forced end returns the sealed answer, or
 * `ok: false` if nothing was sealed.
 */
export async function runClaude({
  machine, cwd, prompt, model, resume, forkSession, maxTurns, hooks, mcpServers, onEvent, onQuery,
  permissionMode, canUseTool, planModeInstructions, settings, tools, env, trackQuota = true,
  effort, thinking, fastMode, fallbackModel, settingSources, available, onWarning,
  boardPlugins,
  metrics, design,
}) {
  const startedMs = Date.now();
  // The phase open when the session starts, not when it ends: a session can
  // outlive its phase's span, and the share per phase is read from this.
  const within = metrics?.task ? openPhaseOf(metrics.task) : null;
  const options = sessionOptions({
    machine, cwd, model, resume, forkSession, maxTurns, hooks, mcpServers,
    permissionMode, canUseTool, planModeInstructions, settings, tools, env,
    effort, thinking, fastMode, fallbackModel, settingSources, available, onWarning, boardPlugins, design,
  });
  // The pid of the CLI the SDK spawns locally. The option is not in `sdk.d.ts`
  // (AGENTS.md); without it `cliPid` stays null and the cap only closes the query.
  let cliPid = null;
  options.onProcessSpawned = (pid) => { cliPid = pid; };
  const ctx = {
    onEvent, machine: machine?.name ?? 'local', toolCounts: Object.create(null), sessionId: resume ?? null, resultText: '',
    ok: false, quota: false, requestedModel: model, requestedEffort: effort ?? null, trackQuota,
  };

  // Timings. `graceMs` is the time the channel was held open past the result
  // waiting for background work (what `startGrace` arms), summed over arms.
  let graceMs = 0;
  let graceStarted = null;      // epoch ms of the arm in flight
  let graceFirst = null;        // epoch ms of the first arm
  const closeGraceClock = () => {
    if (graceStarted != null) graceMs += Date.now() - graceStarted;
    graceStarted = null;
  };
  /** Builds `stats`, writes the spans if the caller asked, and returns `base` with stats. */
  const finish = (base, outcome) => {
    try {
      closeGraceClock();
      const endedMs = Date.now();
      const stats = statsOf(ctx, { ms: endedMs - startedMs, resumed: Boolean(resume), graceMs, resumedFrom: resume ?? null });
      if (metrics) {
        const maxed = stats.subtype === 'error_max_turns';
        recordSession(metrics, ctx, stats, {
          startedAt: new Date(startedMs).toISOString(), endedAt: new Date(endedMs).toISOString(),
          graceStartedAt: graceFirst != null ? new Date(graceFirst).toISOString() : null,
          within,
          outcome: outcome ?? (maxed ? 'max_turns' : base.quota ? 'quota' : base.ok ? 'ok' : 'error'),
        });
      }
      // The sealed answer, when the net replaced it with a later turn's text: the
      // callers' validators fall back to it if the adopted text does not validate.
      const sealedText = ctx.answerFrom && ctx.answerFrom !== 'sealed' && ctx.sealedText && ctx.sealedText !== base.resultText
        ? ctx.sealedText : null;
      const replacedTexts = (ctx.replaced ?? []).filter((t) => t && t !== base.resultText);
      return {
        ...base, stats,
        ...(sealedText ? { sealedText } : {}),
        ...(replacedTexts.length ? { replacedTexts } : {}),
      };
    } catch {
      return base;
    }
  };

  // A caller that already built its own stream keeps it, and the board does not
  // pretend to know when that one is done. No caller does this today.
  const streamed = typeof prompt === 'string';
  const turn = streamed ? phasePrompt(prompt, resume) : { prompt, uuid: null, release: () => {} };

  let sealed = false;      // the result that answers our prompt has arrived
  let sawStamp = false;    // this CLI stamps frames with the prompt's uuid at all
  let results = 0;
  let openTurn = false;    // a turn is in flight (`init` opens one, `result` closes it)
  const tasks = new Map();   // task id → is a subagent (see `trackTasks`)
  const net = createSealNet();   // the later results that may replace a sealed waiting sentence
  let grace = null;
  let settle = null;       // the short wait for the turn that follows an owed report

  const stopSettle = () => { if (settle) clearTimeout(settle); settle = null; };
  const startSettle = () => {
    if (settle || !streamed) return;
    settle = setTimeout(() => {
      settle = null;
      net.giveUp();
      if (ctx.answerFrom === 'unclosed') {
        onEvent?.({ kind: 'warn', warning: 'the wait for the turn that should follow the report ran out; the answer of a turn already in flight stays, which may be the waiting phrase' });
      } else if (ctx.answerFrom !== 'post') {
        onEvent?.({ kind: 'warn', warning: 'the subagent reported and the CLI opened no turn after it; the sealed answer stays' });
      }
      closeIfDone();
    }, claudeHooks.reportSettleMs);
    settle.unref?.();
  };
  const stopGrace = () => { if (grace) clearTimeout(grace); grace = null; closeGraceClock(); };
  // Ending the session at the grace cap. `graceFired` stops the timer from
  // re-arming and the loop from reading frames (the CLI's reaction to the
  // interrupt must not overwrite the sealed answer); `forced` means the CLI did
  // not exit by itself after the interrupt, so the tree was killed and the
  // query closed; `abandon` lets `runClaude` return even if the iterator never ends.
  let session = null;
  let graceFired = false;
  let forced = false;
  let loopDone = false;
  let graceWhat = '';
  let endTimer = null;
  let abandon = () => {};
  const abandoned = new Promise((resolve) => { abandon = resolve; });
  const endSession = () => {
    // Not awaited: with the input already released the control request may
    // never be answered.
    try { session?.interrupt?.()?.catch?.(() => {}); } catch { /* unsupported or already gone */ }
    turn.release();
    endTimer = setTimeout(async () => {
      if (loopDone) return;
      forced = true;
      if (cliPid != null) {
        try { await claudeHooks.killTree(cliPid, machine); } catch { /* already gone */ }
      }
      try { session?.close?.()?.catch?.(() => {}); } catch { /* already gone */ }
      endTimer = setTimeout(abandon, claudeHooks.graceEndMs);
      endTimer.unref?.();
    }, claudeHooks.graceEndMs);
    endTimer.unref?.();
  };
  const forcedEnd = () => {
    const base = { quota: Boolean(ctx.quota), sessionId: ctx.sessionId, toolCounts: ctx.toolCounts };
    if (sealed && ctx.ok) return finish({ ok: true, ...base, resultText: ctx.resultText });
    return finish({
      ok: false, ...base, resultText: '',
      error: `the session did not finish after the grace limit: ${graceWhat}`,
    });
  };

  const startGrace = () => {
    if (grace || !streamed || graceFired) return;
    graceStarted = Date.now();
    graceFirst ??= graceStarted;
    grace = setTimeout(() => {
      grace = null;
      closeGraceClock();
      const what = !sealed
        ? 'no result is recognised as the answer to our prompt'
        : tasks.size
          ? `${tasks.size} background task(s) still have not reported (${[...tasks.keys()].join(', ')})`
          : 'a CLI turn is still unfinished';
      const ms = claudeHooks.taskGraceMs;
      const waited = ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${ms} ms`;
      onEvent?.({ kind: 'warn', warning: `${waited} after the first result — ${what}: the channel is closed and the turn is taken as finished` });
      graceFired = true;
      graceWhat = what;
      endSession();
    }, claudeHooks.taskGraceMs);
    grace.unref?.();
  };
  // Closes the input channel — and with it the CLI — once both conditions hold.
  const closeIfDone = () => {
    if (!sealed) {
      // A result arrived and the board could not tell it was the answer to our
      // prompt. No better signal is coming, so the wait is bounded here too:
      // the alternative is a phase that hangs for ever on a CLI that stamps
      // its results differently than measured.
      if (results) startGrace();
      return;
    }
    if (openTurn || net.turnOpen() || tasks.size) { stopSettle(); startGrace(); return; }
    // A subagent owed to the seal has reported and the CLI has not yet opened
    // the turn that reads the report: hold the channel for a moment, or that
    // turn dies with the stdin.
    if (net.awaitsTurn()) { startSettle(); return; }
    stopSettle();
    stopGrace();
    turn.release();
  };

  try {
    session = claudeHooks.query({ prompt: turn.prompt, options });
    // Hand the handle back so a long turn can be interrupted from the UI.
    onQuery?.(session);
    // The iterator raced against `abandon`: if the SDK never ends it, the loop
    // still does. A rejection of the abandoned `next()` is already handled by the race.
    const frames = (async function* () {
      try {
        const it = session[Symbol.asyncIterator]();
        const gone = abandoned.then(() => ({ done: true }));
        for (;;) {
          const step = await Promise.race([it.next(), gone]);
          if (step.done) return;
          yield step.value;
        }
      } finally {
        loopDone = true;
      }
    })();
    for await (const message of frames) {
      // After the cap the session is being ended: whatever the CLI still says
      // (the result of our own interrupt) does not touch the answer.
      if (graceFired) continue;
      if (message.user_message_uuid !== undefined || message.user_message_uuids !== undefined) sawStamp = true;
      trackTasks(message, tasks, ctx.toolNames);
      net.observe(message, tasks);
      if (message.type === 'system' && message.subtype === 'init') openTurn = true;
      if (message.type === 'result') {
        results += 1;
        openTurn = false;
        // The seal. The fallback is for a CLI that stamps nothing at all: then
        // there is no signal to match on, and the first result is the best
        // reading there is — which is also exactly what the board did before.
        const mine = streamed && (resultAnswers(message, turn.uuid) || (results === 1 && !sawStamp));
        const verdict = net.result(message, tasks, { mine: mine && !sealed });
        ctx.adopting = sealed && verdict.adopt;
        ctx.closes = verdict.closes;
        dispatch(message, ctx);   // the sealed result is still the one that sets ok/resultText
        if (mine && !sealed) {
          sealed = true;
          ctx.sealed = true;
          ctx.sealedOpen = verdict.seal.out;
          ctx.sealedEarly = verdict.seal.early;
          // Kept for the guard of #31 §6: a later turn adopted by the net can be a
          // one-line acknowledgement that replaced a good answer.
          ctx.sealedText = ctx.ok ? ctx.resultText : null;
          const phase = metrics?.stage ?? metrics?.role ?? 'phase';
          if (ctx.sealedOpen) {
            onEvent?.({ kind: 'warn', warning: `the answer of ${phase} was sealed with ${ctx.sealedOpen} subagent(s) still out; the result of the turn after the last report is taken` });
          }
          if (ctx.sealedEarly) {
            onEvent?.({ kind: 'warn', warning: `the answer of ${phase} was sealed with ${ctx.sealedEarly} subagent(s) that had already reported in that same turn; the next turn is awaited` });
          }
        }
      } else {
        dispatch(message, ctx);
      }
      closeIfDone();
    }
  } catch (e) {
    // Killed by us at the grace cap: the exit error is expected, not news.
    if (forced) return forcedEnd();
    // The CLI can exit non-zero *after* delivering a successful result — the
    // work (edits, commit) is already done, so throwing it away would park a
    // finished task as failed.
    if (ctx.ok) {
      onEvent?.({ kind: 'warn', warning: `the session ended with "${e.message}" after completing the turn; the result is kept` });
      return finish({ ok: true, quota: false, sessionId: ctx.sessionId, resultText: ctx.resultText, toolCounts: ctx.toolCounts });
    }
    onEvent?.({ kind: 'error', error: e.message });
    // The counts survive the failure on purpose: a turn that died halfway still
    // says how it was working up to that point.
    // `quota` is not an error of the task's: a turn that died against the
    // account's limit is flagged, never thrown — too many call sites read an
    // exception as «the fix failed» and park the card in `error` for a click.
    return finish({ ok: false, quota: Boolean(ctx.quota), sessionId: ctx.sessionId, resultText: '', toolCounts: ctx.toolCounts, error: e.message });
  } finally {
    // However this ended — result, error, interrupt — the generator is let go
    // and the timer with it: an open gate would keep a promise (and the CLI's
    // stdin) waiting on nothing.
    stopSettle();
    stopGrace();
    if (endTimer) clearTimeout(endTimer);
    turn.release();
  }

  if (forced) return forcedEnd();
  return finish({ ok: ctx.ok, quota: Boolean(ctx.quota), sessionId: ctx.sessionId, resultText: ctx.resultText, toolCounts: ctx.toolCounts });
}

export function summarizeToolInput(block) {
  const input = block.input ?? {};
  switch (block.name) {
    case 'Bash': return input.description || (input.command ?? '').slice(0, 120);
    case 'Read': case 'Write': case 'Edit': return input.file_path;
    case 'Grep': case 'Glob': return input.pattern;
    // `Task` en SDK 0.1.x, `Agent` desde la 0.3: los dos son un subagente, y si
    // el nombre no se reconoce la línea del log se vuelve un volcado de JSON.
    case 'Task': case 'Agent':
      return `${input.subagent_type ?? 'agent'}: ${(input.description ?? '')}`;
    case 'AskUserQuestion': {
      const qs = Array.isArray(input.questions) ? input.questions : [];
      return qs.length === 1 ? `question: ${qs[0]?.question ?? ''}` : `${qs.length} questions: ${qs.map((q) => q?.header).filter(Boolean).join(', ')}`;
    }
    case 'mcp__opencode__delegate': return `opencode: ${String(input.task ?? '').slice(0, 100)}`;
    case 'Artifact': case 'ArtifactComments': case 'ArtifactData': {
      // An omitted action means publish.
      const action = input.action ?? (block.name === 'Artifact' ? 'publish' : '');
      const what = input.title ?? input.file_path ?? input.url ?? '';
      return action === 'publish' && what ? `${action}: ${what}` : action || JSON.stringify(input).slice(0, 120);
    }
    case 'ExitPlanMode': return 'plan ready for review';
    case 'EnterPlanMode': return 'enters plan mode';
    default: {
      const s = JSON.stringify(input);
      return s.length > 120 ? `${s.slice(0, 120)}…` : s;
    }
  }
}

/** Extracts the last `TRIAGE_RESULT: {...}` JSON line from a triage transcript. */
export function parseTriageResult(text) {
  const matches = [...text.matchAll(/TRIAGE_RESULT:\s*(\{.*\})/g)];
  if (!matches.length) return null;
  try {
    const parsed = JSON.parse(matches[matches.length - 1][1]);
    if (parsed.complexity === 'simple' || parsed.complexity === 'complex') return parsed;
  } catch { /* fall through */ }
  return null;
}
