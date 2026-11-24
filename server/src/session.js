import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { sessionOptions, dispatch, stamped, resultAnswers, statsOf } from './claude.js';
import { clampEffort, thinkingModesFor, effortOptionsFor } from './effort.js';

/**
 * A chat's live session: one `claude` process that stays up between prompts.
 *
 * It used to be one process per prompt, resumed from the transcript on disk.
 * That has two costs that grow with the conversation. Every prompt re-reads
 * the whole transcript before answering — the one for #942 is 12.9 MB, so that
 * chat starts slower with every message. And a one-shot process kills the
 * commands it sent to the background when its turn ends: a build launched
 * with `run_in_background` from a chat did not survive the reply.
 *
 * Driving the SDK with streaming input (`prompt` as an async iterable) keeps
 * the process alive: each pushed message is a turn, each turn ends with its
 * own `result`, and what runs in the background reports back between turns.
 *
 * Measured while building this: the CLI also starts turns *on its own* — when
 * a background command finishes it wakes the model to react — so results
 * cannot be matched to prompts by order. Each prompt carries a uuid and the
 * frames of the turn that answers it echo that uuid back; that is what a
 * result is matched against.
 *
 * The process still goes away when nobody is talking to it — after `idleMs`
 * of quiet — and the next prompt resumes the same transcript. The thread
 * survives; only the process is recycled. Quiet means quiet on both sides:
 * the timer counts from the last frame the process sent, not from the end of
 * our last prompt, and it does not run at all while the process has a turn
 * of its own going or a subagent / background command still out. On #937 it
 * counted from a prompt that a foreign result had closed in zero seconds,
 * and fifteen minutes later it killed two subagents in mid-implementation.
 */

export const DEFAULT_IDLE_MS = 15 * 60_000;

/** A push queue the SDK can pull from. Ending it is how the process is told to exit. */
function inputQueue() {
  const items = [];
  let waiter = null;
  let ended = false;
  const wake = () => { const w = waiter; waiter = null; w?.(); };
  return {
    push(message) { if (!ended) { items.push(message); wake(); } },
    end() { ended = true; wake(); },
    async* [Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) { yield items.shift(); continue; }
        if (ended) return;
        await new Promise((resolve) => { waiter = resolve; });
      }
    },
  };
}

export class ChatSession {
  #input = null;
  #query = null;
  #turn = null;         // { uuid, resolve, ctx, active } while a prompt is being answered
  #idle = null;
  #alive = false;
  #selfTurn = false;    // a turn the process started on its own is running
  #tasks = new Set();   // subagents and background commands still out
  #forkPending;
  // True from the moment a process is opened on an existing id until its first turn starts.
  #resumePending = false;
  #hooks;
  #canUseTool;
  #planModeInstructions;
  #settings;
  #tuning;              // effort, thinking, fastMode, fallbackModel, settingSources, available, onWarning, boardPlugins, design
  #queryFn;
  #runningEffort = null;    // the effort level the live process is running with (null: none sent)
  #runningThinking = null;  // the thinking the live process was OPENED with (null: none sent)
  #reopenPending = false;   // close the process once nothing of ours is in flight

  /**
   * `resume` is where the conversation left off, `forkSession` makes the first
   * process branch it instead of appending to it. `onEvent` receives the same
   * events `runClaude` emits, plus `turn_start`/`turn_end` for every turn the
   * process runs — including the ones it starts by itself.
   */
  constructor({
    machine = null, cwd, model, resume = null, forkSession = false, hooks = null,
    idleMs = DEFAULT_IDLE_MS, onEvent = null, queryFn = query, mcpServers = null,
    permissionMode = 'bypassPermissions', canUseTool = null, planModeInstructions = null, settings = null,
    effort, thinking, fastMode, fallbackModel, settingSources, available, onWarning, boardPlugins, design,
  }) {
    this.#tuning = { effort, thinking, fastMode, fallbackModel, settingSources, available, onWarning, boardPlugins, design };
    this.machine = machine;
    this.cwd = cwd;
    this.model = model;
    this.sessionId = resume;
    this.idleMs = idleMs;
    this.onEvent = onEvent;
    // `plan` keeps the process read-only until a plan is approved; the
    // switch changes it live, and a recycled process is born in it.
    this.permissionMode = permissionMode;
    this.#forkPending = Boolean(resume && forkSession);
    this.#hooks = hooks;
    this.#canUseTool = canUseTool;
    this.#planModeInstructions = planModeInstructions;
    this.#settings = settings;
    this.#queryFn = queryFn;
    this.mcpServers = mcpServers;
  }

  /** True while a process is up. */
  get alive() { return this.#alive; }

  /** The effort level the live process runs with, or null (none sent, or no process). */
  get runningEffort() { return this.#alive ? this.#runningEffort : null; }

  /** The thinking the live process was opened with, or null (none sent, or no process). */
  get runningThinking() { return this.#alive ? this.#runningThinking : null; }

  /** True while a prompt of ours is being answered. */
  get busy() { return this.#turn !== null; }

  /** True while the process has work going that no prompt of ours is waiting on. */
  get working() { return this.#selfTurn || this.#tasks.size > 0; }

  /**
   * Sends one prompt and resolves with that turn's outcome, shaped like
   * `runClaude`'s. One turn at a time: the caller decides what a prompt that
   * arrives mid-turn means (for chats: it is handed over through a hook).
   */
  send(text) {
    if (this.#turn) return Promise.reject(new Error('This session is already answering a prompt'));
    if (!this.#alive) this.#open();
    this.#stopIdle();
    // Only the first turn of a process opened on an id is an SDK resume; later turns of the live process are not.
    const resumed = this.#resumePending;
    this.#resumePending = false;

    return new Promise((resolve) => {
      const uuid = randomUUID();
      const ctx = {
        onEvent: (ev) => this.onEvent?.(ev),
        machine: this.machine?.name ?? 'local',
        toolCounts: Object.create(null),
        sessionId: this.sessionId,
        resultText: '',
        ok: false,
        quota: false,
        requestedModel: this.model,
      };
      this.#turn = { uuid, resolve, ctx, active: false, startedMs: Date.now(), resumed, resumedFrom: this.sessionId ?? null };
      this.#input.push({
        type: 'user',
        uuid,
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id: this.sessionId ?? '',
      });
    });
  }

  /**
   * The slash commands this session's CLI offers (`SlashCommand[]`: name,
   * description, argumentHint, aliases, builtin). A control request, not a
   * prompt: no turn, no cost. With no process up one is opened for it — the
   * next `send` reuses it — and the idle timer is armed so a list asked for
   * and never followed by a prompt does not leave a process behind for good.
   */
  async commands() {
    if (!this.#alive) this.#open();
    const q = this.#query;
    try {
      return await q.supportedCommands();
    } finally {
      this.#armIdle();
    }
  }

  /** Cuts the turn in flight. The process stays up for the next prompt. */
  async interrupt() {
    if (!this.#alive || !this.#query) throw new Error('There is no turn in progress');
    await this.#query.interrupt();
  }

  /** Changes the model from the next reply on, without restarting anything. */
  async setModel(model) {
    this.model = model;
    if (this.#alive && this.#query) await this.#query.setModel(model);
  }

  /**
   * Changes model, effort and thinking from the next reply on, hot where the
   * CLI allows it. The model switches in place (`setModel`) and the effort
   * level is re-applied (`applyFlagSettings`) only when the level the new model
   * will honour differs from the one the process runs with. Thinking is a
   * process option: when the thinking the process was OPENED with is not among
   * the new model's modes, the process is closed (now if nothing of ours is in
   * flight, else once it is) and the next `send` reopens it resuming the same
   * transcript with the new thinking. A key left `undefined` keeps its value.
   *
   * A thinking change that the running process does not have also reopens it.
   *
   * Resolves `{ reopened, effort, reason }`: whether the process was (or will be)
   * recycled, the effort level in force (null when none is sent), and why
   * (`'model'` the opened thinking clashes with the model, `'thinking'` the
   * requested thinking differs from the running one, null when not reopened).
   */
  async retune({ model, effort, thinking } = {}) {
    if (model !== undefined) this.model = model;
    const next = { ...this.#tuning };
    if (effort !== undefined) next.effort = effort;
    const prevThinking = this.#tuning.thinking;
    if (thinking !== undefined) next.thinking = thinking;
    this.#tuning = next;
    const available = next.available ?? [];
    const level = clampEffort(this.model, next.effort, available) ?? null;
    if (!this.#alive || !this.#query) return { reopened: false, effort: level, reason: null };

    if (model !== undefined) await this.#query.setModel(model);
    if (level !== this.#runningEffort) {
      await this.#query.applyFlagSettings?.({ effortLevel: level });
      this.#runningEffort = level;
    }

    const opened = this.#runningThinking?.type;
    const clash = Boolean(opened) && !thinkingModesFor(this.model, available).includes(opened);
    // A thinking change the process does not run yet also needs a new process:
    // thinking is an open-time option and cannot be switched live.
    const changed = thinking !== undefined && JSON.stringify(thinking ?? null) !== JSON.stringify(prevThinking ?? null);
    let differs = false;
    if (changed && !clash) {
      const wanted = effortOptionsFor({ model: this.model, thinking: next.thinking, available }).options.thinking ?? null;
      differs = JSON.stringify(wanted) !== JSON.stringify(this.#runningThinking ?? null);
    }
    const reopen = clash || differs;
    if (reopen) {
      this.#reopenPending = true;
      this.#reopenIfQuiet();
    }
    return { reopened: reopen, effort: level, reason: clash ? 'model' : differs ? 'thinking' : null };
  }

  /** Effort only; the same path as `retune`. */
  setEffort(effort) {
    return this.retune({ effort });
  }

  /** Applies a pending reopen as soon as no prompt of ours and no process work is out. */
  #reopenIfQuiet() {
    if (!this.#reopenPending || !this.#alive || this.busy || this.working) return;
    this.close();
  }

  /**
   * Switches between reading-only (`plan`) and working (`bypassPermissions`)
   * in place: a running turn changes behaviour at its next tool call, and the
   * next process is born in the new mode.
   */
  async setPermissionMode(mode) {
    this.permissionMode = mode;
    if (this.#alive && this.#query) await this.#query.setPermissionMode(mode);
  }

  /** Ends the process. The transcript on disk is what the next `send` resumes. */
  close() {
    this.#stopIdle();
    this.#reopenPending = false;
    if (!this.#alive) return;
    this.#alive = false;
    this.#input?.end();
    try { this.#query?.close?.(); } catch { /* already gone */ }
    // A turn in flight cannot finish any more; say so instead of hanging it.
    this.#settle('la sesión se cerró con el turno a medias');
    this.#selfTurn = false;
    this.#tasks.clear();
    this.#announceClosed();
  }

  /**
   * Once per process, whichever way it went — closed for idling, or died.
   * Whatever was still running in it (a background build, a subagent) can no
   * longer report, and the listener has trees to mark accordingly.
   */
  #announcedClosed = false;
  #announceClosed() {
    if (this.#announcedClosed) return;
    this.#announcedClosed = true;
    this.onEvent?.({ kind: 'session_closed' });
  }

  #open() {
    this.#announcedClosed = false;   // a new process gets its own farewell
    this.#resumePending = Boolean(this.sessionId);
    this.#input = inputQueue();
    const options = sessionOptions({
      machine: this.machine, cwd: this.cwd, model: this.model, resume: this.sessionId,
      forkSession: this.#forkPending, hooks: this.#hooks, mcpServers: this.mcpServers,
      permissionMode: this.permissionMode, canUseTool: this.#canUseTool,
      planModeInstructions: this.#planModeInstructions, settings: this.#settings,
      ...this.#tuning,
    });
    // The fork is a property of the first process: once it has its own id,
    // every later process resumes that id plain.
    this.#forkPending = false;
    this.#runningEffort = options.effort ?? null;
    this.#runningThinking = options.thinking ?? null;
    this.#query = this.#queryFn({ prompt: this.#input, options });
    this.#alive = true;
    this.#pump(this.#query);
  }

  async #pump(q) {
    // Between turns nothing of ours is in flight, yet the process still talks:
    // background work reporting, and the turns it starts by itself to react to
    // it. Those go to the same listener, credited to no prompt.
    const idle = { onEvent: (ev) => this.onEvent?.(ev), machine: this.machine?.name ?? 'local', toolCounts: Object.create(null), requestedModel: this.model };
    try {
      for await (const message of q) {
        const turn = this.#turn;
        if (turn && stamped(message, turn.uuid)) turn.active = true;
        const mine = message.type === 'result'
          ? Boolean(turn) && this.#answers(message, turn)
          : Boolean(turn?.active);
        const ctx = mine ? turn.ctx : idle;

        dispatch(message, ctx);
        if (ctx.sessionId) this.sessionId = ctx.sessionId;

        if (message.type === 'system' && message.subtype === 'init') {
          this.#selfTurn = !turn;
          this.onEvent?.({ kind: 'turn_start', own: Boolean(turn) });
        } else if (message.type === 'result') {
          this.#selfTurn = false;
          this.onEvent?.({ kind: 'turn_end', own: mine });
          if (mine) this.#finish();
        } else if (message.type === 'system' && message.subtype === 'task_started' && !message.ambient) {
          this.#tasks.add(message.task_id);
        } else if (message.type === 'system' && message.subtype === 'task_notification' && !message.ambient) {
          this.#tasks.delete(message.task_id);
        }
        // Every frame is a sign of life; only real quiet counts towards idling.
        this.#armIdle();
        this.#reopenIfQuiet();
      }
    } catch (e) {
      this.#settle(e.message);
    } finally {
      if (this.#query === q) {
        this.#alive = false;
        this.#query = null;
        this.#selfTurn = false;
        this.#tasks.clear();
      }
      this.#settle('el proceso de la sesión terminó sin responder');
      this.#announceClosed();
    }
  }

  /**
   * Whether a result closes our turn. The rule itself lives in `claude.js`
   * (`resultAnswers`): the phases need the same seal, and one rule read two
   * ways is how the two drift apart.
   */
  #answers(result, turn) {
    return resultAnswers(result, turn.uuid);
  }

  #finish() {
    const turn = this.#turn;
    if (!turn) return;
    this.#turn = null;
    const { ctx } = turn;
    turn.resolve({
      ok: ctx.ok, quota: Boolean(ctx.quota), sessionId: this.sessionId, resultText: ctx.resultText, toolCounts: ctx.toolCounts,
      stats: this.#statsOf(turn),
    });
    this.#armIdle();
  }

  /** Timing and cost of one turn. Never throws: a stats bug must not lose the turn's answer. */
  #statsOf(turn) {
    try {
      return statsOf(turn.ctx, { ms: Date.now() - turn.startedMs, resumed: turn.resumed, resumedFrom: turn.resumedFrom });
    } catch {
      return null;
    }
  }

  /** Resolves a turn that will never get its `result`. No-op when there is none. */
  #settle(error) {
    const turn = this.#turn;
    if (!turn) return;
    this.#turn = null;
    this.onEvent?.({ kind: 'error', error });
    turn.resolve({ ok: false, quota: Boolean(turn.ctx.quota), sessionId: this.sessionId, resultText: '', toolCounts: turn.ctx.toolCounts, error, stats: this.#statsOf(turn) });
  }

  /**
   * (Re)starts the quiet timer, unless there is nothing quiet about the
   * process: a prompt of ours pending, a turn of its own, or a task still out.
   */
  #armIdle() {
    this.#stopIdle();
    if (!this.idleMs || !this.#alive) return;
    if (this.#turn || this.working) return;
    this.#idle = setTimeout(() => this.close(), this.idleMs);
    this.#idle.unref?.();
  }

  #stopIdle() {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = null;
  }
}
