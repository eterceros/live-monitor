/**
 * A task's conversations.
 *
 * There used to be exactly one per task, told through four separate fields on
 * the task — `chat`, `sessionId`, `chatModel`, `chatBusy` — plus a mutex keyed
 * by issue. That shape is what made a second conversation impossible: two turns
 * resuming one session id do not run side by side, they fork the transcript and
 * one branch is silently dropped (measured: resuming returns the *same* session
 * id and appends to the same file).
 *
 * So a chat is now a thing with its own id, its own session and its own
 * history, and a task holds a list of them. The first one is the principal: the
 * board's own phases — fix, demo steps, review replies — keep talking through
 * it, which is why it is never removed.
 *
 * Kept free of the SDK and of `store.js` on purpose: these are the decisions
 * worth testing, and everything here is a pure function over a task.
 */

import { groupProgress, isServerLike } from './activity.js';

/** A chat keeps the last of these; the task log has had its own cap all along. */
export const MAX_CHAT_MESSAGES = 600;

export const PRINCIPAL_TITLE = 'Main';

let counter = 0;
/** Short, sortable and unique within a process — ids only need to be stable. */
export function newChatId() {
  counter += 1;
  return `c${Date.now().toString(36)}${counter.toString(36)}`;
}

export function makeChat({ id, title, sessionId = null, model = null, effort = null, thinking = null, forkedFrom = null } = {}) {
  return {
    id: id ?? newChatId(),
    title: title ?? PRINCIPAL_TITLE,
    // True once a person named it by hand: the first prompt then leaves it alone.
    titleManual: false,
    sessionId,
    model,                 // null = el modelo por defecto de config
    effort,                // null = auto (no se pasa nada); si no, low|medium|high|xhigh|max
    // null = hereda el del rol «chat»; 'auto' = no se pasa nada; si no { type, budgetTokens? }
    thinking,
    // Cuándo terminó el último turno (ISO): la interfaz lo usa para saber si la caché sigue caliente.
    lastTurnAt: null,
    busy: false,
    activity: null,
    // What the user typed while a turn was running: handed to the model
    // mid-turn through a hook, or made the next turn if none came in time.
    notes: [],
    forkedFrom,            // el chat del que salió, si nació ramificando
    // Closing keeps everything — messages, session, title — and only takes
    // the tab away; reopening puts it back and resumes the same thread.
    closedAt: null,
    // The sha this chat last knew about. What changed since is what its next
    // turn gets told, computed when the prompt is built — a pre-rendered note
    // would be stale by the time a queued turn finally runs.
    lastSeenSha: null,
    // Plan mode: the session only reads and proposes until a plan is approved,
    // and the board runs the approved plan. Off by birth; the switch or
    // `/plan on` turns it on, and closing the plan turns it off.
    planMode: false,
    // Something waiting on a person: a question the model asked, a plan to
    // approve, or the board asking how to go on. `{ id, kind, source, askedAt,
    // messageId }`; the payload lives in the message it points to.
    pending: null,
    // The approved plan being run by the board, with each task's state.
    plan: null,
    // Set when the task arrives on another machine: what this chat is told on
    // its first turn there, then cleared. `{ from, to, at, text, brief, resumed, wip }`.
    handoff: null,
    messages: [],
    createdAt: new Date().toISOString(),
  };
}

/** Brings one stored chat up to the current field set. Idempotent. */
export function migrateChat(chat) {
  if (chat.planMode === undefined) chat.planMode = false;
  if (chat.titleManual === undefined) chat.titleManual = false;
  if (chat.effort === undefined) chat.effort = null;
  if (chat.thinking === undefined) chat.thinking = null;
  if (chat.lastTurnAt === undefined) chat.lastTurnAt = null;
  if (chat.pending === undefined) chat.pending = null;
  if (chat.plan === undefined) chat.plan = null;
  if (chat.handoff === undefined) chat.handoff = null;
  return chat;
}

const PENDING_ROLES = new Set(['question', 'plan']);

/**
 * A question or plan nobody can answer any more — the process died, the turn
 * ended, the board restarted — is marked so in the history, so the bubble
 * stops offering to answer it. Returns the messages it changed.
 */
export function expirePendingMessages(chat) {
  const changed = [];
  for (const m of chat.messages ?? []) {
    // A task's plan bubble is the board's, not a turn's: it waits on the task
    // (`plan_ready`), which outlives any process and any restart.
    if (m.scope === 'task') continue;
    if (PENDING_ROLES.has(m.role) && m.status === 'pending') {
      m.status = 'expired';
      m.decidedAt = new Date().toISOString();
      changed.push(m);
    }
  }
  return changed;
}

/** Every conversation, open or closed. */
export const chatsOf = (task) => (Array.isArray(task?.chats) ? task.chats : []);

/** The ones with a tab. */
export const openChats = (task) => chatsOf(task).filter((c) => !c.closedAt);

/** The ones in the history, most recently closed first. */
export const closedChats = (task) =>
  chatsOf(task).filter((c) => c.closedAt).sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1));

/** The board's own conversation. Always the first, always present. */
export const principalChat = (task) => chatsOf(task)[0] ?? null;

export const chatById = (task, id) =>
  (id ? chatsOf(task).find((c) => c.id === id) ?? null : principalChat(task));

/** True while any conversation of this task is mid-turn. */
export const isChatBusy = (task) => chatsOf(task).some((c) => c.busy);

/**
 * What is actually moving in a chat right now, small enough to ride on every
 * projection: how many subagents of the waves still running are done, how many
 * finite commands are in the background, how many servers are up, and how long
 * the slowest wave still has.
 *
 * Only a wave with someone still in it counts. A turn from yesterday that
 * launched twelve agents and finished them all would otherwise read as
 * «12 subagentes, 12 hechos» forever, on top of today's three.
 *
 * Null when nothing at all is going on — the common case, and the one where
 * the projection should weigh nothing.
 */
export function chatRunning(chat, now = Date.now()) {
  const agents = { total: 0, done: 0, running: 0 };
  let commands = 0;
  let servers = 0;
  let estimateMs = null;

  for (const message of chat?.messages ?? []) {
    if (message.role !== 'activity') continue;

    const group = groupProgress(message, now);
    if (group.running) {
      agents.total += group.total;
      agents.done += group.done;
      agents.running += group.running;
      // Waves run side by side too: the one that ends last is the wait.
      if (group.remainingMs != null) estimateMs = Math.max(estimateMs ?? 0, group.remainingMs);
    }

    const walk = (items) => {
      for (const item of items ?? []) {
        if (item.kind === 'bash' && item.background && ['running', 'stopping'].includes(item.status)) {
          if (isServerLike(item, now)) servers += 1; else commands += 1;
        }
        walk(item.children);
      }
    };
    walk(message.items);
  }

  if (!agents.total && !commands && !servers) return null;
  return { agents, commands, servers, estimateMs };
}

/** The chats working right now, other than this one. */
export const busySiblings = (task, chatId) =>
  openChats(task).filter((c) => c.id !== chatId && c.busy);

/**
 * Takes a chat's tab away, keeping the chat. Refused for the principal — the
 * board's phases talk through it — and for a chat mid-turn, which is a click
 * away from cutting edits in half. Returns why it was refused, or null.
 */
export function closeChatOf(task, id, now = new Date()) {
  const chat = chatById(task, id);
  if (!chat) return 'Ese chat no existe';
  if (chat === principalChat(task)) return 'El chat principal no se puede cerrar: es por donde el tablero conversa';
  if (chat.busy) return 'Ese chat está trabajando; deténlo antes de cerrarlo';
  if (!chat.closedAt) chat.closedAt = now.toISOString();
  return null;
}

/** Gives a closed chat its tab back. Returns why it could not, or null. */
export function reopenChatOf(task, id) {
  const chat = chatById(task, id);
  if (!chat) return 'Ese chat no existe';
  chat.closedAt = null;
  return null;
}

export const UNTITLED = 'Untitled';
// Chats stored before the switch to English carry the Spanish placeholder.
export const isUntitled = (title) => title === UNTITLED || title === 'Sin título';

/**
 * A title from the first thing you asked. Better than "Chat 2" and free: the
 * first line of the prompt is almost always what the conversation is about.
 */
export function titleFromPrompt(text, fallback = UNTITLED) {
  const first = String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean);
  if (!first) return fallback;
  const clean = first.replace(/^[/#>*\-\s]+/, '').trim();
  if (!clean) return fallback;
  return clean.length > 38 ? `${clean.slice(0, 37)}…` : clean;
}

/** Adds a chat to the task and returns it. */
export function addChatTo(task, options = {}) {
  if (!Array.isArray(task.chats)) task.chats = [];
  const chat = makeChat(options);
  task.chats.push(chat);
  return chat;
}

/**
 * Drops a chat for good — the one irreversible step, so only from the history
 * and only a chat already closed. The principal never goes: the board's phases
 * resume through it, and a task with no conversation would have nowhere to put
 * what they say.
 */
export function removeChat(task, id) {
  const chats = chatsOf(task);
  const index = chats.findIndex((c) => c.id === id);
  if (index <= 0) return false;      // -1 = unknown, 0 = principal
  if (!chats[index].closedAt) return false;
  chats.splice(index, 1);
  return true;
}

/**
 * Brings a stored task up to this shape, and does nothing on a task already in
 * it — this runs on every boot. The old history becomes the principal's, copied
 * rather than aliased: sharing the array would keep both fields alive and hide
 * the bug until the day the old one is deleted.
 */
export function migrateChats(task) {
  if (Array.isArray(task.chats) && task.chats.length) {
    for (const chat of task.chats) migrateChat(chat);
    return task;
  }

  const principal = makeChat({
    title: PRINCIPAL_TITLE,
    sessionId: task.sessionId ?? null,
    model: task.chatModel ?? null,
  });
  principal.messages = Array.isArray(task.chat) ? [...task.chat] : [];
  if (task.createdAt) principal.createdAt = task.createdAt;
  task.chats = [principal];

  delete task.chat;
  delete task.sessionId;
  delete task.chatModel;
  delete task.chatBusy;
  delete task.chatQueued;
  delete task.chatActivity;
  return task;
}

/**
 * What one chat is told about the others, at the start of its turn.
 *
 * Naming the files is the whole point. A session that read `config.rs` three
 * turns ago still has that text in its context in full fidelity, and "the other
 * chat changed some files" does not dislodge it — only being told to read that
 * exact path again does.
 */
export function renderSiblings({ busy = [], commits = [], files = [], me = '' } = {}) {
  const parts = [];

  if (commits.length) {
    const list = commits.slice(0, 8).map((c) => `- ${c}`).join('\n');
    const more = commits.length > 8 ? `\n- …y ${commits.length - 8} más` : '';
    parts.push(`Desde la última vez que miraste esta rama, han entrado ${commits.length} commit(s) que no son tuyos:\n${list}${more}`);
  }
  if (files.length) {
    const list = files.slice(0, 20).map((f) => `- \`${f}\``).join('\n');
    const more = files.length > 20 ? `\n- …y ${files.length - 20} más` : '';
    parts.push(`Archivos que cambiaron:\n${list}${more}\n\n**Vuelve a leer con Read cualquiera de esos archivos antes de editarlo.** Lo que tengas de ellos en contexto es anterior a esos cambios.`);
  }
  if (busy.length) {
    const quienes = busy.map((c) => `«${c.title}»`).join(', ');
    parts.push(`Ahora mismo hay otra conversación trabajando en este mismo worktree: ${quienes}. Puede commitear o mover archivos mientras tú trabajas.`);
  }
  if (!parts.length) return '';

  return `\n\n[Aviso del tablero${me ? ` para «${me}»` : ''}: ${parts.join('\n\n')}]`;
}

/**
 * A note left for the other conversations of a task, to be handed to each of
 * them the next time they are about to touch a file. Kept in memory only for as
 * long as it takes to deliver: what matters is arriving fresh.
 */
export function tellSiblings(task, fromChatId, text) {
  for (const chat of chatsOf(task)) {
    if (chat.id === fromChatId) continue;
    chat.news = [...(chat.news ?? []), text];
  }
}

/** Takes what a chat has pending to hear, and empties the queue. */
export function drainNews(chat) {
  const news = chat?.news ?? [];
  if (!news.length) return '';
  chat.news = [];
  return news.join('\n');
}

/**
 * A message typed while the chat was mid-turn. It waits here for the next
 * opening — a hook before the next tool call — and if the turn ends first,
 * for the turn that follows. `messageId` is the bubble it came from, so the
 * panel can say which of the two ways it took.
 */
export function leaveNote(chat, text, messageId, attachments = [], { voice = false } = {}) {
  chat.notes = [...(chat.notes ?? []), { text, messageId, attachments, ...(voice ? { voice: true } : {}) }];
}

/** Takes the notes waiting on a chat, and empties them. */
export function drainNotes(chat) {
  const notes = chat?.notes ?? [];
  chat.notes = [];
  return notes;
}

/**
 * After a restart nothing is running, whatever the file says. `lastSeenSha`
 * survives on purpose: it is still true what each chat had seen.
 */
export function resetChatsOnBoot(task) {
  for (const chat of chatsOf(task)) {
    chat.busy = false;
    chat.activity = null;
    // Nothing was mid-turn, so nothing is waiting to be told: the start of the
    // next turn works it out from `lastSeenSha` anyway. Notes are different:
    // those are the user's words, and they ride with the next prompt.
    chat.news = [];
    chat.notes = Array.isArray(chat.notes) ? chat.notes : [];
    // A question parked in a process that no longer exists can never be
    // answered; a plan that was running is stopped, and Continuar picks it up.
    chat.pending = null;
    expirePendingMessages(chat);
    if (chat.plan) {
      for (const t of chat.plan.tasks ?? []) {
        if (['running', 'checking', 'asking'].includes(t.status)) t.status = 'stopped';
      }
      if (['running', 'asking'].includes(chat.plan.status)) chat.plan.status = 'stopped';
    }
    // A turn cut by the restart left its activity spinning in the history.
    for (const m of chat.messages ?? []) {
      if (m.role !== 'activity') continue;
      const walk = (items) => {
        for (const i of items ?? []) {
          if (['running', 'stopping'].includes(i.status)) { i.status = 'stopped'; i.endedAt = i.endedAt ?? new Date().toISOString(); }
          walk(i.children);
        }
      };
      walk(m.items);
    }
  }
  // A fix plan being made when the board went down can never arrive: the
  // planning is cleared and its bubble says so. The changes you asked for stay
  // in `planFeedback`, and Retry — the task is in error, cut mid-`fixing` —
  // replans with them.
  const planning = task.planning ?? null;
  if (task.planning !== undefined) task.planning = null;
  for (const m of principalChat(task)?.messages ?? []) {
    if (m.role !== 'plan' || m.scope !== 'task' || m.status !== 'planning') continue;
    const revising = (m.id === planning?.messageId ? planning.kind : m.kind) === 'revise';
    m.status = 'failed';
    m.error = revising ? 'the board restarted while replanning' : 'the board restarted while planning';
    m.progress = null;
    m.decidedAt = new Date().toISOString();
  }
  return task;
}
