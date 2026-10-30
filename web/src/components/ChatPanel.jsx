import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import {
  cacheIsWarm, modelCommandArgument, resolveModelName, thinkingFits, thinkingForMode,
  thinkingModeOf, thinkingModesOfModel, thinkingOptions,
} from '../modelRules.js';
import { sameTask } from '../taskKey.js';
import { latestPhaseModel, modelEffortLabel, meta } from '../status.js';
import { useDictation, dictationSupport, useStopDictationOnEscape } from '../useDictation.js';
import { useSpeech, speechSupport } from '../useSpeech.js';
import { splitVoice } from '../voice.js';
import { onVoicePrefsChange, readVoiceOn, writeVoiceOn } from '../voicePrefs.js';
import { useComposerHeight } from '../useComposerHeight.js';
import Icon from './Icon.jsx';
import Pill from './ui/Pill.jsx';
import Chip from './ui/Chip.jsx';
import LiveDot from './ui/LiveDot.jsx';
import Popover, { usePopover } from './ui/Popover.jsx';
import ActivityGroup from './ActivityGroup.jsx';
import MicButton from './MicButton.jsx';
import CreateTaskDialog from './CreateTaskDialog.jsx';
import QuestionDialog from './QuestionDialog.jsx';
import BackgroundStrip, { runCount } from './BackgroundStrip.jsx';
import PlanReview from './PlanReview.jsx';
import LoginCard from './LoginCard.jsx';
import { useDialog } from '../useDialog.jsx';
import { ago, dayDividers } from '../time.js';
import { readDrafts, saveDraft } from '../storage.js';
import { useStrings } from '../i18n/useStrings.js';
import { fill, plural, splitAround } from '../i18n/index.js';
import { TaskPlanBubble, PendingBubble, MessageBubble, ThinkingBubble, DayDivider } from './chat/ChatBubbles.jsx';
import { ChatPathsContext } from '../viewer/context.js';
import { collectPaths, fallbackFor, signatureOf } from '../viewer/chatPaths.js';
import './planBubble.css';

const MAX_MB = 20;
// How long the typing has to stop before the draft is mirrored to the
// browser. Dictation calls `setText` on every interim result, and each write
// is a parse, a sort and a stringify of every draft there is.
const DRAFT_DEBOUNCE = 400;
// How long «Deshacer» stays offered after the ✕ emptied the box.
const CLEAR_UNDO_MS = 8000;

/** Puts one node of an activity tree in place, under its parent or at the top. */
function upsertItem(items, item, parentId) {
  const replaceIn = (list) => {
    const at = list.findIndex((i) => i.id === item.id);
    if (at >= 0) return [...list.slice(0, at), item, ...list.slice(at + 1)];
    return null;
  };
  if (!parentId) return replaceIn(items) ?? [...items, item];
  const walk = (list) => list.map((i) => {
    if (i.id === parentId) {
      const children = i.children ?? [];
      return { ...i, children: replaceIn(children) ?? [...children, item] };
    }
    return i.children?.length ? { ...i, children: walk(i.children) } : i;
  });
  const placed = walk(items);
  // A parent we never saw: keep the node at the top rather than lose it.
  const found = JSON.stringify(placed) !== JSON.stringify(items);
  return found ? placed : (replaceIn(items) ?? [...items, item]);
}

function applyUpdate(messages, { messageId, patch, item, parentId }) {
  const at = messages.findIndex((m) => m.id === messageId);
  if (at < 0) return messages;
  if (patch?.removed) return [...messages.slice(0, at), ...messages.slice(at + 1)];
  const current = messages[at];
  const next = { ...current, ...(patch ?? {}) };
  if (item) next.items = upsertItem(current.items ?? [], item, parentId);
  return [...messages.slice(0, at), next, ...messages.slice(at + 1)];
}

// The tone of a flow state (status.js) as the pill names it.
const PILL_TONE = { busy: 'live', error: 'danger', done: 'ok', ok: 'ok', warn: 'warn', idle: 'idle' };

export default function ChatPanel({
  task, chatId, onSelectChat, onClose, onSend, onCreateWorktree,
  onReviewTaskPlan = null,   // opens the task's own plan dialog, from the board's plan bubble
  onRenewLogin = null,       // opens the renew-login dialog for a machine, from the auth card
  models = { list: [], fallback: 'opus' },
  tabs = null,   // the strip of task tabs, drawn above everything else
}) {
  const t = useStrings();
  // A project chat's holder summary stands in for a task here: no issue, no
  // plan and no demo, and its worktree is made on first use.
  const isProject = task.kind === 'project';
  const ownerLabel = isProject ? t.chat.project : `#${task.issue}`;
  const all = task.chats ?? [];
  // Tabs are the open ones; the closed ones live behind the history button, with everything
  // they had, until you bring them back or delete them for good.
  const chats = all.filter((c) => !c.closedAt);
  const closed = all.filter((c) => c.closedAt).sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1));
  const chat = chats.find((c) => c.id === chatId) ?? chats[0] ?? null;
  // Closed chats and the model picker hang off the header as popovers.
  const histPop = usePopover();
  const modelPop = usePopover();
  const { ask, notice } = useDialog();
  const CONFIRM_MODEL_SWITCH = {
    title: t.chat.panel.modelSwitch.title, icon: 'brain', text: t.chat.panel.modelSwitch.text,
    options: [{ value: true, label: t.chat.panel.modelSwitch.confirm }], cancel: t.chat.panel.modelSwitch.cancel, focus: 'cancel',
  };
  const say = (e) => notice(typeof e === 'string' ? e : e.message);
  // The dialog for what this chat waits on, dismissable on this device: the
  // bubble's «Responder» brings it back. Reconnect re-derives it from the
  // task's `pending` and the reloaded message.
  const [dismissedId, setDismissedId] = useState(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [answering, setAnswering] = useState(false);
  // «Crear tarea» open (holders only), and the tab being renamed: { id, value }.
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(null);
  const renameRef = useRef(null);
  // What each family resolves to today, so the picker can say «Opus (claude-opus-4-1)».
  const [resolved, setResolved] = useState({});
  // What effort each model accepts (the board's tuning snapshot): the effort
  // select offers only those, and none when the model takes none.
  const [tuningModels, setTuningModels] = useState([]);
  useEffect(() => {
    api.tuning().then((t) => setTuningModels(t.models ?? [])).catch(() => {});
  }, [task.issue]);
  useEffect(() => {
    api.models().then((r) => setResolved(Object.fromEntries((r.models ?? []).map((m) => [m.alias, m.resolved])))).catch(() => {});
  }, [task.issue]);

  const chatModel = chat?.model ?? models.fallback;
  const effortsOf = (id) => tuningModels.find((m) => m.id === id)?.efforts ?? [];
  const chatEfforts = effortsOf(chatModel);
  // An effort the model does not accept is shown as stored, never as «auto»:
  // the server lowers it and says to what (`effectiveEffort`).
  const chatEffort = chat?.effort ?? 'auto';
  const chatLowered = chat?.effort && chat.effectiveEffort && chat.effectiveEffort !== chat.effort ? chat.effectiveEffort : null;
  const chatModes = thinkingModesOfModel({ models: tuningModels }, chatModel);
  // '' = inherits the role «chat»; 'auto' = send nothing.
  const chatThinkingValue = chat?.thinking == null ? '' : thinkingModeOf(chat.thinking);
  const warm = cacheIsWarm(chat);
  // Every change goes through here and carries the chat's current model. A model
  // switch asks first while the cache is warm: the new model rereads the whole
  // conversation without it. A thinking that no longer fits goes back to inherited.
  const changeChat = async (fields) => {
    const model = fields.model !== undefined ? fields.model : chat?.model ?? null;
    if (fields.model !== undefined && warm && (fields.model ?? models.fallback) !== chatModel) {
      const go = await ask(CONFIRM_MODEL_SWITCH);
      if (!go) return;
    }
    const body = { ...fields, model };
    if (fields.model !== undefined && fields.thinking === undefined && chat?.thinking != null
      && !thinkingFits(chat.thinking, thinkingModesOfModel({ models: tuningModels }, model ?? models.fallback))) {
      body.thinking = null;
    }
    api.setModel(task, chat?.id, body).catch(say);
  };
  const phaseModel = isProject ? null : latestPhaseModel(task);

  // Nothing left in the history: do not keep the popover «open» for the next one that closes.
  useEffect(() => { if (!closed.length) histPop.close(); }, [closed.length]);

  const closeTab = (c) => {
    if (c.busy) { say(t.chat.panel.closeBusy); return; }
    // Closing the tab you are on lands you on the one before it.
    const at = chats.findIndex((x) => x.id === c.id);
    const fallback = chats[at - 1] ?? chats[at + 1] ?? chats[0];
    api.closeChat(task, c.id)
      .then(() => { if (c.id === chat?.id && fallback) onSelectChat(fallback.id); })
      .catch(say);
  };
  const reopen = (c) => api.reopenChat(task, c.id)
    .then(() => { histPop.close(); onSelectChat(c.id); })
    .catch(say);
  const remove = async (c) => {
    const go = await ask({
      title: fill(t.chat.panel.deleteTitle, { title: c.title }), icon: 'trash',
      text: plural(c.messageCount, t.chat.panel.deleteText),
      options: [{ value: true, label: t.common.delete, tone: 'danger' }], cancel: t.chat.panel.keep,
    });
    if (go) api.deleteChat(task, c.id).catch(say);
  };
  // Rename a conversation: double-click its name, Enter or leaving the box
  // saves, Esc cancels. Blur follows Enter and Esc, so `renameRef` says once.
  const startRename = (c) => { renameRef.current = c.id; setRenaming({ id: c.id, value: c.title }); };
  const endRename = (save) => {
    const cur = renaming;
    if (renameRef.current == null || !cur) return;
    renameRef.current = null;
    setRenaming(null);
    if (!save) return;
    const title = cur.value.replace(/\s+/g, ' ').trim();
    if (!title || title === all.find((x) => x.id === cur.id)?.title) return;
    api.renameChat(task, cur.id, title).catch(say);
  };
  const [messages, setMessages] = useState([]);
  // The full paths this chat's own Read/Write/Edit rows name: a fallback for a bare file name.
  // The context value is keyed on their content, so streaming tokens do not re-render every chip.
  const chatPaths = useMemo(() => collectPaths(messages), [messages]);
  const chatPathsKey = signatureOf(chatPaths);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const chatPathsValue = useMemo(() => ({ fallbackFor: (ref) => fallbackFor(chatPaths, ref) }), [chatPathsKey]);

  // What this chat waits on, and the message holding its payload. After
  // `messages`: reading it above its declaration blanked the whole board.
  const pending = chat?.pending ?? null;
  // The board's task-plan bubbles (`scope: 'task'`) are never this chat's
  // pending plan nor its running one: they have their own dialog in App.
  const pendingMessage = pending ? messages.find((m) => m.id === pending.messageId && m.scope !== 'task') ?? null : null;
  const planMessage = chat?.plan ? messages.find((m) => m.role === 'plan' && m.scope !== 'task' && m.record?.id === chat.plan.id) ?? null : null;
  const answer = async (body) => {
    if (!pending) return;
    setAnswering(true);
    try {
      await api.answer(task, chat.id, { id: pending.id, ...body });
      setDismissedId(null);
    } catch (e) {
      if (e.status === 409) notice({ title: t.chat.panel.answeredTitle, text: t.chat.panel.answeredText });
      else say(e);
    } finally {
      setAnswering(false);
    }
  };
  const showQuestion = pending?.kind === 'question' && pendingMessage && dismissedId !== pending.id;
  const showPlanReview = pending?.kind === 'plan' && pendingMessage && dismissedId !== pending.id;
  // One draft per conversation: switching tabs, closing the panel and
  // reloading all used to eat what you were halfway through typing.
  //
  // The map in state is the truth, and `localStorage` is its mirror. That
  // order matters twice: the updater stays pure (StrictMode runs it twice),
  // and a browser with storage turned off — private mode, blocked site data
  // — still keeps every tab's draft for as long as the panel lives, which is
  // what the in-memory map did before it learned to persist.
  const [drafts, setDrafts] = useState(readDrafts);
  const text = drafts[chat?.id] ?? '';
  const setText = (value) => setDrafts((d) => {
    const id = chat?.id;
    if (!id) return d;
    const next = typeof value === 'function' ? value(d[id] ?? '') : value;
    return next === (d[id] ?? '') ? d : { ...d, [id]: next };
  });
  // What the mirror already holds, and what it still owes: leaving the
  // conversation, or the page, has to write the owed draft instead of
  // dropping it along with the timer that was going to.
  const mirrored = useRef(drafts);
  const owed = useRef(null);
  const flushDraft = () => {
    if (!owed.current) return;
    const { id, text: draft } = owed.current;
    owed.current = null;
    mirrored.current = { ...mirrored.current, [id]: draft };
    saveDraft(id, draft);
  };
  useEffect(() => {
    const id = chat?.id;
    if (!id || (mirrored.current[id] ?? '') === text) return undefined;
    owed.current = { id, text };
    const timer = setTimeout(flushDraft, DRAFT_DEBOUNCE);
    return () => clearTimeout(timer);
  }, [chat?.id, text]);
  // Changing tab or unmounting: the cleanup is the flush itself.
  useEffect(() => flushDraft, [chat?.id]);
  useEffect(() => {
    // A reload two keystrokes after typing must not lose them either.
    window.addEventListener('pagehide', flushDraft);
    return () => window.removeEventListener('pagehide', flushDraft);
  }, []);
  const [files, setFiles] = useState([]);      // { name, size, dataBase64 }
  // «Borrado · Deshacer»: what the ✕ emptied, kept for a few seconds so a click
  // by mistake does not cost a long dictation.
  const [cleared, setCleared] = useState(null);   // { text, files }
  const clearTimer = useRef(null);
  const dropUndo = () => { clearTimeout(clearTimer.current); setCleared(null); };
  const clearComposer = () => {
    // First the microphone: a recogniser that is still listening would write
    // the old text back with its next result.
    dictation.abort();
    if (!text && !files.length) return;
    setCleared({ text, files });
    clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => setCleared(null), CLEAR_UNDO_MS);
    setText('');
    setFiles([]);
  };
  const undoClear = () => {
    if (!cleared) return;
    setText(cleared.text);
    setFiles(cleared.files);
    dropUndo();
  };
  // Typing something new makes the old text a thing nobody asked to get back, and so does leaving the chat.
  useEffect(() => { if (cleared && text) dropUndo(); }, [text]);
  useEffect(() => () => clearTimeout(clearTimer.current), []);
  useEffect(() => { dropUndo(); }, [chat?.id]);
  const [sending, setSending] = useState(false);
  const [dropping, setDropping] = useState(false);
  const scrollRef = useRef(null);
  const fileInput = useRef(null);
  const dictation = useDictation({ onText: setText });
  const micSupport = dictationSupport();
  // Dictating, the first Escape stops the microphone and keeps what was heard
  // (the dialogs do the same); the next one is free for the voice or the panel.
  useStopDictationOnEscape(dictation);
  // The voice of this chat, a choice of this browser (see voicePrefs.js): the
  // chat reads aloud the `<voz>` summaries of its replies, and what is sent
  // while it is on carries the voice rule for that turn.
  const speech = useSpeech();
  const voiceSupported = speechSupport();
  const [voiceOn, setVoiceOn] = useState(() => readVoiceOn(chat?.id));
  const voiceOnRef = useRef(voiceOn);
  voiceOnRef.current = voiceOn;
  const speechRef = useRef(speech);
  speechRef.current = speech;
  useEffect(() => {
    setVoiceOn(readVoiceOn(chat?.id));
    return onVoicePrefsChange(() => setVoiceOn(readVoiceOn(chat?.id)));
  }, [chat?.id]);
  // A voice must not carry over to the next tab, nor outlive the panel.
  useEffect(() => () => speechRef.current.stop(), [chat?.id]);
  const toggleVoice = () => {
    const on = !voiceOn;
    writeVoiceOn(chat?.id, on);
    setVoiceOn(on);
    if (!on) speech.stop();
  };
  // Esc silences it at once, from wherever the focus is.
  useEffect(() => {
    if (!speech.speaking) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') speechRef.current.stop(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [speech.speaking]);
  // The composer follows its text until you drag its grip. It measures itself
  // against the thread, so it reuses `scrollRef` instead of a second ref.
  const composer = useComposerHeight({ value: text, messagesRef: scrollRef });
  // The keys are said in the footer row (hidden on a phone, where the box is
  // two lines tall and a long hint clipped mid-sentence), not in the placeholder.
  const promptHint = t.chat.panel.placeholderPrompt;
  const promptId = useId();

  // La voz escribe en la pestaña que estaba activa al empezar; si cambias,
  // dejaría de caer donde miras. Se aborta, no se para: `onText` es el
  // `setText` de la pestaña anterior, y una parada educada aún entrega un
  // último resultado, que caería en el borrador equivocado.
  useEffect(() => () => dictation.abort(), [chat?.id]);

  useEffect(() => {
    if (!chat) return undefined;
    let vigente = true;
    setMessages([]);
    const load = () => api.chat(task, chat.id).then((r) => { if (vigente) setMessages(r.chat); }).catch(() => {});
    load();
    const mine = (ev) => sameTask(ev.detail, task) && ev.detail.chatId === chat.id;
    const onChat = (ev) => {
      // Filtrar por chat además de por tarea: sin esto, lo que responde una
      // pestaña aparece en la que estés mirando.
      if (!mine(ev)) return;
      setMessages((prev) => [...prev, ev.detail.message]);
      // Only a message that arrives now is read: loading a chat never speaks its history.
      const said = ev.detail.message;
      if (voiceOnRef.current && said?.role === 'assistant') {
        const { spoken } = splitVoice(said.text);
        if (spoken.length) speechRef.current.speak(spoken);
      }
    };
    const onUpdate = (ev) => {
      if (mine(ev)) setMessages((prev) => applyUpdate(prev, ev.detail));
    };
    window.addEventListener('task-chat', onChat);
    window.addEventListener('task-chat-update', onUpdate);
    window.addEventListener('board-connected', load);
    return () => {
      vigente = false;
      window.removeEventListener('task-chat', onChat);
      window.removeEventListener('task-chat-update', onUpdate);
      window.removeEventListener('board-connected', load);
    };
  }, [task.project, task.issue, task.machine, chat?.id]);

  // Follow the end only while you are at the end: a tool event lands every
  // few seconds during a turn, and yanking the view down each time would make
  // reading anything above impossible.
  const stick = useRef(true);
  // Mirrors `stick` for rendering: the arrow-down button shows only away from the end.
  const [atEnd, setAtEnd] = useState(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAtEnd(stick.current);
  };
  useEffect(() => {
    if (stick.current) scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
    onScroll();
  }, [messages, chat?.busy]);
  const toEnd = () => {
    stick.current = true;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  };

  // A holder's worktree is ensured by the server when a turn starts.
  const ready = isProject || task.hasWorktree;
  const canAttach = ready;
  // Derived on every render, never remembered: `applyUpdate` can delete the
  // message that opened a day, and a cached divider would stay behind it.
  const dividers = dayDividers(messages);

  const addFiles = async (list) => {
    for (const file of list) {
      if (file.size > MAX_MB * 1024 * 1024) {
        say(fill(t.chat.panel.tooBig, { name: file.name, mb: MAX_MB }));
        continue;
      }
      const dataBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      // A pasted screenshot arrives as "image.png"; timestamp it so several in
      // one conversation stay tellable apart.
      const name = file.name && file.name !== 'image.png'
        ? file.name
        : fill(t.chat.panel.screenshotName, { time: new Date().toTimeString().slice(0, 8).replaceAll(':', '') });
      setFiles((prev) => [...prev, { name, size: file.size, dataBase64 }]);
    }
  };

  const send = async () => {
    const body = text.trim();
    if ((!body && !files.length) || !ready || sending || !chat) return;
    // A typed `/model <name>` is answered by the server, but the cache warning
    // belongs here: resolve the name as the server does and ask only when it
    // lands on a different model. An unresolvable name goes through as typed.
    const wanted = modelCommandArgument(body);
    if (wanted && warm) {
      const { match } = resolveModelName(models.list, wanted);
      if (match && match.id !== chatModel && !(await ask(CONFIRM_MODEL_SWITCH))) return;
    }
    setSending(true);
    try {
      const uploaded = [];
      for (const f of files) {
        uploaded.push(await api.uploadAttachment(task, { name: f.name, dataBase64: f.dataBase64 }));
      }
      onSend(chat.id, body || t.chat.panel.defaultPrompt, uploaded, { voice: voiceOn && voiceSupported });
      setText('');
      setFiles([]);
    } catch (e) {
      say(fill(t.chat.panel.attachFailed, { error: e.message }));
    } finally {
      setSending(false);
    }
  };

  // What the header says besides the number and the branch.
  const stateMeta = isProject ? null : meta(task.state);
  const planCount = (() => {
    if (isProject) return null;
    if (chat?.plan) return { done: chat.plan.done, total: chat.plan.total, scope: 'chat' };
    const list = task.workPlan?.tasks;
    if (!Array.isArray(list)) return null;
    return {
      done: list.filter((t) => t.status === 'done').length,
      total: list.filter((t) => t.status !== 'skipped').length,
      scope: 'task',
    };
  })();
  const canSend = Boolean((text.trim() || files.length) && ready && !sending);
  // A disabled button says why, as the artboard's «Escribe algo para enviar».
  const sendTitle = canSend ? undefined : !ready ? t.chat.panel.sendNoWorktree : t.chat.panel.sendEmpty;
  const busyChats = chats.filter((c) => c.busy).length;
  const modelLabel = modelEffortLabel(models.list.find((m) => m.id === chatModel)?.label ?? chatModel, chatEffort);

  return (
    <ChatPathsContext.Provider value={chatPathsValue}>
    <section
      className={`subpanel subpanel-chat ${dropping ? 'dropping' : ''}`}
      onDragOver={(e) => { e.preventDefault(); if (canAttach) setDropping(true); }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        if (canAttach && e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]);
      }}
    >
      {tabs}
      <header className="cp-head">
        <div className="cp-head-top">
          {isProject
            ? (
              <>
                <h2 className="cp-title" title={task.worktreePath ?? undefined}><Icon name="message" /> <span>{t.chat.project} ·</span></h2>
                <code className="cp-branch" title={task.baseBranch}>{task.baseBranch}</code>
              </>
            )
            : (
              <>
                <h2 className="cp-title"><Icon name="message" /> <span>#{task.issue}</span></h2>
                <code className="cp-branch" title={task.branch}>{task.branch}</code>
              </>
            )}
          <span className="cp-spacer" />
          {isProject && (
            <button
              type="button"
              className="btn-create-task btn btn-sm cp-create"
              disabled={!chat || chat.busy || !chat.messageCount}
              title={!chat?.messageCount
                ? t.chat.panel.createTaskSpeakFirst
                : chat.busy ? t.chat.panel.createTaskBusy : t.chat.panel.createTaskTitle}
              onClick={() => setCreating(true)}
            ><Icon name="pin" /> {t.chat.panel.createTask}</button>
          )}
          <button
            type="button"
            className="btn btn-icon btn-sm cp-history-btn"
            aria-haspopup="dialog"
            aria-label={closed.length ? plural(closed.length, t.chat.panel.historyAria) : t.chat.panel.historyNone}
            title={closed.length ? plural(closed.length, t.chat.panel.historyTitle) : t.chat.panel.historyNone}
            disabled={!closed.length}
            {...histPop.triggerProps}
          >
            <Icon name="history" />
            {closed.length > 0 && <span className="cp-badge" aria-hidden="true">{closed.length}</span>}
          </button>
          <button type="button" className="btn btn-close" aria-label={t.chat.panel.closePanel} title={t.chat.panel.closePanel} onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className="cp-head-meta">
          {isProject
            ? (
              <Pill tone={chat?.busy ? 'live' : 'project'} live={Boolean(chat?.busy)} icon="message" title={t.chat.panel.projectPillTitle}>
                {chat?.busy ? t.chat.panel.projectWorking : t.chat.panel.projectChat}
              </Pill>
            )
            : (
              <Pill tone={PILL_TONE[stateMeta.tone] ?? 'neutral'} live={stateMeta.tone === 'busy'} icon={stateMeta.icon} title={stateMeta.hint || undefined}>
                {stateMeta.label}
              </Pill>
            )}
          {planCount && (
            <span className="cp-meta-text" title={fill(planCount.scope === 'chat' ? t.chat.panel.planOfChat : t.chat.panel.planOfTask, planCount)}>
              <Icon name="clipboard" /> {fill(t.chat.panel.planCount, planCount)}
            </span>
          )}
          {task.machine && <Chip icon="map-pin" title={t.chat.panel.machineTitle}>{task.machine}</Chip>}
          {task.design === true && (
            <Chip
              icon="palette" tone="violet"
              title={t.chat.panel.designTitle}
            >{t.chat.panel.designChip}</Chip>
          )}
          <span className="cp-spacer" />
          {/* Model and effort are this chat's, behind one button: the three
              selects only matter while you change them. */}
          {models.list.length > 0 && (
            <button
              type="button"
              className="btn cp-model-btn"
              aria-haspopup="dialog"
              title={t.chat.panel.modelButtonTitle}
              {...modelPop.triggerProps}
            >
              <Icon name="brain" /><span className="cp-model-label">{modelLabel}</span><Icon name="chevron-down" />
            </button>
          )}
        </div>
      </header>

      {closed.length > 0 && (
        <Popover pop={histPop} placement="bottom-end" label={t.chat.panel.historyHeading} className="cp-pop cp-history">
          <p className="cp-pop-title">{t.chat.panel.historyHeading}</p>
          {closed.map((c) => (
            <div key={c.id} className="cp-history-row">
              <span className="cp-history-name" title={c.title}>{c.title}</span>
              <span className="cp-history-meta">{ago(c.closedAt)} · {plural(c.messageCount, t.chat.panel.messageCount)}</span>
              <span className="cp-history-actions">
                <button type="button" className="reopen btn btn-sm" onClick={() => reopen(c)}>{t.chat.panel.reopen}</button>
                <button type="button" className="delete btn btn-danger btn-sm" title={t.chat.panel.deleteForever} onClick={() => remove(c)}>{t.common.delete}</button>
              </span>
            </div>
          ))}
        </Popover>
      )}

      {models.list.length > 0 && (
        <Popover pop={modelPop} placement="bottom-end" label={t.chat.panel.modelPopoverLabel} className="cp-pop cp-model-pop">
          <label className="cp-field">
            <span>{t.chat.panel.fieldModel}</span>
            <select
              className="cp-select"
              value={chatModel}
              title={t.chat.panel.modelTitle}
              onChange={(e) => changeChat({ model: e.target.value })}
            >
              {models.list.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}{resolved[m.id] ? ` (${resolved[m.id]})` : ''}{m.hint ? ` — ${m.hint}` : ''}
                </option>
              ))}
            </select>
          </label>
          {chatEfforts.length > 0 && (
            <label className="cp-field">
              <span>{t.chat.panel.fieldEffort}</span>
              <select
                className="cp-select"
                value={chatEffort}
                title={t.chat.panel.effortTitle}
                onChange={(e) => changeChat({ effort: e.target.value })}
              >
                <option value="auto">auto</option>{/* i18n-ok: «auto» is the stored value */}
                {chat?.effort && !chatEfforts.includes(chat.effort) && <option value={chat.effort}>{chat.effort}</option>}
                {chatEfforts.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
              {chatLowered && <span className="cp-field-note" title={fill(t.chat.panel.effortLoweredTitle, { effort: chat.effort })}>{fill(t.chat.panel.effortLowered, { effort: chatLowered })}</span>}
            </label>
          )}
          {chatModes.length > 0 && (
            <label className="cp-field">
              <span>{t.chat.panel.fieldThinking}</span>
              <select
                className="cp-select"
                value={chatThinkingValue}
                title={t.chat.panel.thinkingTitle}
                onChange={(e) => {
                  const v = e.target.value;
                  // Inherit (null), or a mode; the budget of «presupuesto» comes from the role «chat».
                  changeChat({ thinking: v === '' ? null : v === 'auto' ? 'auto' : v === 'enabled' ? { type: 'enabled' } : thinkingForMode(v) });
                }}
              >
                <option value="">{t.chat.panel.thinkingInherit}</option>
                {thinkingOptions(chatModes).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
          )}
          {phaseModel && (
            <div className="cp-field cp-field-phase">
              <span>{t.chat.panel.fieldPhase}</span>
              <Chip icon="settings" title={t.chat.panel.phaseTitle}>{phaseModel.label}</Chip>
            </div>
          )}
        </Popover>
      )}

      <nav className="cp-tabs" aria-label={fill(t.chat.panel.tabsAria, { owner: ownerLabel })}>
        {chats.map((c, i) => {
          // Before the title, not after: a long title clips from the right.
          const run = runCount(c.running);
          return (
            <span key={c.id} className={`chat-tab ${c.id === chat?.id ? 'is-active' : ''}`}>
              {renaming?.id === c.id ? (
                <input
                  className="chat-tab-rename"
                  value={renaming.value}
                  maxLength={80}
                  autoFocus
                  aria-label={t.chat.panel.renameLabel}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => setRenaming({ id: c.id, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (e.key === 'Enter') { e.preventDefault(); endRename(true); } // i18n-ok: KeyboardEvent.key
                    else if (e.key === 'Escape') { e.preventDefault(); endRename(false); }
                  }}
                  onBlur={() => endRename(true)}
                />
              ) : (
                <button
                  type="button"
                  className="chat-tab-label"
                  aria-current={c.id === chat?.id ? 'page' : undefined}
                  title={c.pending ? fill(t.chat.panel.tabWaiting, { title: c.title }) : c.busy ? fill(t.chat.panel.tabBusy, { title: c.title, activity: c.activity ?? '' }) : c.title}
                  onClick={() => onSelectChat(c.id)}
                >
                  {c.busy && <LiveDot size={6} />}
                  {run.n > 0 && <span className="run-count" title={run.title}><Icon name="refresh" /> {run.n}</span>}
                  <span className="chat-tab-name" data-label={c.title}
                    onDoubleClick={(e) => { e.preventDefault(); startRename(c); }}>{c.title}</span>
                  {c.pending && <span className="ask-dot"><Icon name="help-circle" /><span className="cp-sr">{t.chat.panel.tabWaitingSr}</span></span>}
                </button>
              )}
              {/* The principal has no close button: the board talks through it. */}
              {i > 0 && chats.length > 1 && (
                <button
                  type="button"
                  className={`chat-tab-close btn btn-close ${c.busy ? 'is-busy' : ''}`}
                  title={c.busy ? t.chat.panel.tabCloseBusy : t.chat.panel.tabClose}
                  aria-label={c.busy ? t.chat.panel.tabCloseBusy : t.chat.panel.tabClose}
                  onClick={(e) => { e.stopPropagation(); closeTab(c); }}
                ><Icon name="x" /></button>
              )}
            </span>
          );
        })}
        <button type="button" className="chat-tab chat-add" title={t.chat.panel.newChat}
          aria-label={t.chat.panel.newChat}
          onClick={() => onSelectChat('+nuevo')}><Icon name="plus" /></button>
        {chat?.messageCount > 0 && (
          <button type="button" className="chat-tab chat-add" title={t.chat.panel.branchChat}
            aria-label={t.chat.panel.branchChat}
            onClick={() => onSelectChat(`+rama:${chat.id}`)}><Icon name="branch" /></button>
        )}
        <span className="cp-spacer" />
        {chat?.plan && (
          <button type="button" className="btn btn-sm cp-plan-open" onClick={() => setPlanOpen(true)} title={t.chat.panel.planOpenTitle}>
            <Icon name="clipboard" /> Plan {chat.plan.done}/{chat.plan.total}{/* i18n-ok: «Plan» is the same word in es, en, fr and de */}
          </button>
        )}
        {chat && (
          <button
            type="button"
            className={`btn cp-plan-mode ${chat.planMode ? 'is-on' : ''}`}
            aria-pressed={chat.planMode === true}
            title={t.chat.panel.planModeTitle}
            onClick={() => api.setPlanMode(task, chat.id, !chat.planMode).catch(say)}
          >
            <Icon name="note" /> <span>{t.chat.panel.planMode}</span> <span className="cp-plan-state">· {chat.planMode ? t.chat.panel.planModeOn : t.chat.panel.planModeOff}</span>
          </button>
        )}
      </nav>

      {busyChats > 1 && (
        <p className="cp-parallel" role="note">
          <Icon name="alert-triangle" /> {fill(t.chat.panel.parallel, { n: busyChats })}
        </p>
      )}
      {!ready && !isProject && (
        <div className="cp-no-worktree">
          <Icon name="tree" />
          <span>{t.chat.panel.noWorktree}</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onCreateWorktree(task.issue)}><Icon name="tree" /> {t.chat.panel.createWorktree}</button>
        </div>
      )}

      <div
        className="messages cp-messages"
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-label={fill(t.chat.panel.logAria, { title: chat?.title ?? '', owner: ownerLabel })}
      >
        {messages.length === 0 && (
          <p className="cp-empty">
            {isProject
              ? splitAround(t.chat.panel.emptyProject, { icon: '' }).map((part) => (
                part.hole ? <Icon key={part.key} name="pin" /> : <React.Fragment key={part.key}>{part.text}</React.Fragment>
              ))
              : t.chat.panel.emptyTask}
          </p>
        )}
        {messages.flatMap((m, i) => [
          // Siblings in the same flat list, never a wrapper: a Fragment that
          // appears and disappears with the divider changes the element type,
          // and React would throw away an open activity tree with its state.
          // Keyed by the message it opens, not by its day: two stamps out of
          // order would name the same day twice and collide.
          dividers[i] && <DayDivider key={`day-${m.id ?? i}`} label={dividers[i].label} />,
          (m.role === 'activity'
          ? <ActivityGroup key={m.id ?? i} activity={m} owner={task} chatId={chat?.id} />
          : m.role === 'plan' && m.scope === 'task'
            ? <TaskPlanBubble key={m.id ?? i} message={m} task={task} onReview={onReviewTaskPlan} />
          : m.role === 'auth'
            ? <LoginCard key={m.id ?? i} machine={m.machine ?? task.machine} onRenew={onRenewLogin} />
          : m.role === 'question' || m.role === 'plan'
            ? <PendingBubble key={m.id ?? i} message={m} pending={pending} onOpen={() => setDismissedId(null)} />
            : <MessageBubble key={m.id ?? i} m={m} />),
        ])}
        {chat?.busy && <ThinkingBubble task={task} chat={chat} pending={pending} onAnswer={() => setDismissedId(null)} />}
      </div>
      {!atEnd && (
        <div className="to-end-anchor">
          <button className="to-end btn btn-icon btn-sm" title={t.chat.panel.toEnd} aria-label={t.chat.panel.toEnd} onClick={toEnd}><Icon name="arrow-down" /></button>
        </div>
      )}

      <BackgroundStrip messages={messages} owner={task} chatId={chat?.id} />

      {showQuestion && (
        <QuestionDialog
          questions={pendingMessage.questions}
          source={pendingMessage.source ?? 'claude'}
          who={`${ownerLabel} · ${chat.title}`}
          preview={pendingMessage.preview ?? null}
          submitting={answering}
          onSubmit={(answers) => answer({ answers })}
          onSkip={() => answer({ decision: 'skip' })}
          onDismiss={() => setDismissedId(pending.id)}
        />
      )}
      {showPlanReview && (
        <PlanReview
          plan={{ text: pendingMessage.plan, tasks: pendingMessage.tasks, waves: pendingMessage.waves, selected: pendingMessage.tasks.map((t) => t.id) }}
          who={`${ownerLabel} · ${chat.title}`}
          mode="review"
          busy={answering}
          onApprove={(selected) => answer({ decision: 'approve', selected })}
          onRevise={(feedback) => answer({ decision: 'revise', feedback })}
          onDismiss={() => setDismissedId(pending.id)}
        />
      )}
      {planOpen && chat?.plan && planMessage?.record && (
        <PlanReview
          plan={planMessage.record}
          who={`${ownerLabel} · ${chat.title}`}
          mode="progress"
          onStop={() => api.stopPlan(task, chat.id).catch(say)}
          onContinue={() => api.continuePlan(task, chat.id).catch(say)}
          onDismiss={() => setPlanOpen(false)}
        />
      )}

      {files.length > 0 && (
        <div className="cp-files">
          {files.map((f, i) => (
            <span className="cp-file" key={i}>
              <Icon name="paperclip" /> <span className="cp-file-name">{f.name}</span> <em>{Math.round(f.size / 1024)} KB</em>
              <button type="button" className="btn btn-close btn-xs" aria-label={t.chat.panel.removeFile} title={t.chat.panel.removeFile} onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}><Icon name="x" /></button>
            </span>
          ))}
        </div>
      )}

      {/* A phone has no tooltips, so an unusable mic has to say why on screen. */}
      {ready && !micSupport.ok && <p className="dictation-error"><Icon name="mic" /> {micSupport.reason}</p>}
      {dictation.error && <p className="dictation-error">{dictation.error}</p>}

      <div className="cp-composer">
        {/* The grip goes inside the box it resizes, hanging from its top edge. */}
        <div className="cp-box">
          {ready && (
            <div
              className={`composer-grip ${composer.pinned ? 'is-pinned' : ''}`}
              role="separator"
              aria-label={t.chat.panel.gripLabel}
              title={t.chat.panel.gripTitle}
              onPointerDown={composer.startResize}
              onDoubleClick={composer.reset}
            />
          )}
          <label htmlFor={promptId} className="cp-sr">{fill(t.chat.panel.promptLabel, { chat: chat?.title ?? t.chat.panel.promptChatFallback, owner: ownerLabel })}</label>
          <textarea
            id={promptId}
            className="cp-input"
            ref={composer.textareaRef}
            value={text}
            disabled={!ready}
            placeholder={!ready
              ? t.chat.panel.placeholderNoWorktree
              : dictation.listening
                ? t.chat.listening
                : pending
                  ? t.chat.panel.placeholderPending
                  : chat?.plan && ['running', 'asking'].includes(chat.plan.status)
                    ? t.chat.panel.placeholderPlanRunning
                    : chat?.busy
                      ? t.chat.panel.placeholderBusy
                      : chat?.planMode
                        ? t.chat.panel.placeholderPlanMode
                        : promptHint}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              // A screenshot on the clipboard often shows up only in `items`,
              // with `files` empty — reading just one of the two silently lost
              // the image and pasted nothing.
              const fromFiles = [...(e.clipboardData.files ?? [])];
              const fromItems = [...(e.clipboardData.items ?? [])]
                .filter((i) => i.kind === 'file')
                .map((i) => i.getAsFile())
                .filter(Boolean);
              const seen = new Set(fromFiles.map((f) => `${f.name}:${f.size}`));
              const pasted = [...fromFiles, ...fromItems.filter((f) => !seen.has(`${f.name}:${f.size}`))];
              if (pasted.length) { e.preventDefault(); addFiles(pasted); }
            }}
            onKeyDown={(e) => {
              // Typing over a dictation: the microphone steps aside (nothing else is
              // written), or its next result would put its words over what was typed.
              if (dictation.listening && !e.nativeEvent.isComposing
                && ((e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) || e.key === 'Backspace' || e.key === 'Delete')) { // i18n-ok: KeyboardEvent.key
                dictation.abort();
              }
              if (e.key !== 'Enter') return; // i18n-ok: KeyboardEvent.key
              // Dictation and an IME confirm their candidate with Enter: that
              // one is not a send, it is the text landing in the box.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              // Shift+Enter still breaks the line; Ctrl/⌘+Enter also sends.
              if (e.shiftKey && !e.ctrlKey && !e.metaKey) return;
              e.preventDefault();
              send();
            }}
          />
          {(text || files.length > 0 || dictation.listening) && (
            <button type="button" className="btn btn-icon btn-sm cp-clear" disabled={!ready}
              aria-label={t.chat.panel.clearDraft} title={t.chat.panel.clearDraftTitle}
              onClick={clearComposer}><Icon name="x" /></button>
          )}
          {cleared && (
            <div className="cp-undo" role="status">
              <span>{t.chat.panel.cleared}</span>
              <button type="button" className="btn btn-xs" onClick={undoClear}>{t.chat.panel.undo}</button>
            </div>
          )}
          <div className="cp-tools">
            <button type="button" className="btn btn-icon btn-sm cp-tool" disabled={!ready} title={t.chat.panel.attach} aria-label={t.chat.panel.attach}
              onClick={() => fileInput.current?.click()}><Icon name="paperclip" /></button>
            <input ref={fileInput} type="file" multiple hidden
              onChange={(e) => { addFiles([...e.target.files]); e.target.value = ''; }} />
            <MicButton
              className="cp-tool"
              listening={dictation.listening}
              support={micSupport}
              disabled={!ready}
              onToggle={() => dictation.toggle(text)}
            />
            {voiceSupported && (
              <button type="button" className={`btn btn-icon btn-sm cp-tool speaker${voiceOn ? ' on' : ''}`} disabled={!ready}
                aria-pressed={voiceOn} aria-label={voiceOn ? t.chat.panel.voiceOff : t.chat.panel.voiceOn}
                title={voiceOn ? t.chat.panel.voiceOffTitle : t.chat.panel.voiceOnTitle}
                onClick={toggleVoice}><Icon name={voiceOn ? 'volume' : 'volume-off'} /></button>
            )}
            {speech.speaking && (
              <button type="button" className="btn btn-icon btn-sm cp-tool speaker-stop"
                aria-label={t.chat.panel.voiceStop} title={t.chat.panel.voiceStopTitle}
                onClick={speech.stop}><Icon name="stop" /></button>
            )}
            <span className="cp-hint">{t.chat.panel.keysHint}</span>
            <button type="button" className="btn btn-primary cp-send" onClick={send} disabled={!canSend} title={sendTitle}>
              {sending ? t.chat.panel.uploading : <><Icon name="arrow-up" /> <span>{t.chat.panel.send}</span></>}
            </button>
          </div>
        </div>
      </div>
      {creating && chat && (
        <CreateTaskDialog owner={task} chatId={chat.id} onClose={() => setCreating(false)} />
      )}
    </section>
    </ChatPathsContext.Provider>
  );
}
