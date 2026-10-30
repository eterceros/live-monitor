import React from 'react';
import { api } from '../../api.js';
import Icon from '../Icon.jsx';
import Markdown from '../Markdown.jsx';
import { splitVoice } from '../../voice.js';
import Stamp from '../Stamp.jsx';
import LiveDot from '../ui/LiveDot.jsx';
import { laneSummary } from '../PlanReview.jsx';
import { useDialog } from '../../useDialog.jsx';
import { useStrings } from '../../i18n/useStrings.js';
import { plural } from '../../i18n/index.js';
import { isPublishQuestion, publishTarget, PUBLISH_COPY } from '../../publishQuestion.js';

// Bubbles of the chat thread (redesign C): you in a `--surface-3` bubble, Claude
// as bare text on the column, and the board's own questions and plans as quiet
// cards that turn amber while they wait for you. Cyan is for what is live only.

/** The icon of how a message typed mid-turn reached the model; its words are `t.chat.bubbles.delivery`. */
const DELIVERY_ICON = { pending: 'hourglass', inline: 'forward', next: 'skip' };

/** The states of a plan in the thread; a task plan adds `planning` and `failed`, since the board plans it before it is ever pending. */
const PLAN_STATES = ['pending', 'approved', 'revise', 'expired'];

const join = (v) => (Array.isArray(v) ? v.join(', ') : v);

/** The «who · time» line over a bubble. */
function Who({ name, ts }) {
  return <span className="cb-who">{name}<Stamp ts={ts} className="cb-time" /></span>;
}

/** The board's card: neutral at rest, amber with a stripe while it waits for you. */
function BoardCard({ tone, className = '', children }) {
  return <div className={`cb-board cb-board--${tone} ${className}`.trim()}>{children}</div>;
}

/**
 * The board's plan for the task itself (`scope: 'task'`), one bubble per
 * version. It never goes through `chat.pending`: «Revisar» opens the task's
 * plan dialog, and only while that very version is the one waiting.
 */
export function TaskPlanBubble({ message: m, task, onReview }) {
  const t = useStrings();
  const n = m.tasks?.length ?? 0;
  const live = m.status === 'pending' && task.state === 'plan_ready' && Boolean(task.workPlan)
    && (task.workPlan.version == null || task.workPlan.version === m.version);
  // A pending bubble can outlive its wait (the task stopped, moved or failed
  // without a decision): it then says so, and offers nothing to click.
  const stale = m.status === 'pending' && !live;
  const statusText = stale ? t.chat.bubbles.stale : t.chat.bubbles.pStatus[m.status] ?? m.status;
  const tone = live ? 'wait' : m.status === 'failed' ? 'fail' : 'rest';
  return (
    <div className="cb-msg">
      <Who name={t.chat.bubbles.board} ts={m.ts} />
      <BoardCard tone={tone} className={`task-plan is-${m.status}`}>
        <div className="cb-head">
          <Icon name="clipboard" />
          <span className="cb-title"><b>Plan v{m.version}</b>{/* i18n-ok: «Plan» is the same word in es, en, fr and de */} · <span className="cb-status">{statusText}</span></span>
          {live && onReview && (
            <button type="button" className="btn btn-amber btn-sm cb-action" onClick={onReview}>{t.chat.bubbles.review}</button>
          )}
        </div>
        {m.status === 'planning' && (
          <div className="task-plan-planning">
            <LiveDot />
            <span className="task-plan-progress" title={m.progress ?? ''}>{m.progress || t.chat.bubbles.starting}</span>
          </div>
        )}
        {m.status === 'pending' && (
          <div className="cb-line">
            <span>{plural(n, t.chat.bubbles.tasks)}</span>
            {m.waves?.length > 0 && <>· <span className="task-plan-lanes" title={t.chat.bubbles.lanesTitle}>{laneSummary(m.waves)}</span></>}
          </div>
        )}
        {m.status === 'approved' && m.progress && <div className="cb-progress">{m.progress}</div>}
        {m.status === 'failed' && m.error && <div className="task-plan-error">{m.error}</div>}
      </BoardCard>
    </div>
  );
}

/** A question or a plan in the thread: its state, and its answers once given. */
export function PendingBubble({ message: m, pending, onOpen }) {
  const t = useStrings();
  const isQ = m.role === 'question';
  const live = Boolean(pending && pending.messageId === m.id);
  const n = isQ ? m.questions?.length ?? 0 : m.tasks?.length ?? 0;
  const waiting = m.status === 'pending';
  const publish = isQ && isPublishQuestion(m.questions);
  const target = publish ? publishTarget(m.questions) : null;

  let statusText;
  if (isQ) {
    statusText = t.chat.bubbles.qStatus[m.status] ?? m.status;
    if (publish) {
      // The publish question has its own wording: «no se publicó» is the fact that matters.
      if (m.status === 'expired') statusText = PUBLISH_COPY.unanswered;
      else if (m.status === 'answered') statusText = PUBLISH_COPY.answered;
    } else if (m.status === 'answered' && n === 1) {
      statusText = t.chat.bubbles.qAnswered;
    }
  } else {
    statusText = PLAN_STATES.includes(m.status) ? t.chat.bubbles.pStatus[m.status] : m.status;
  }

  return (
    <div className="cb-msg">
      <Who name={m.source === 'board' ? t.chat.bubbles.board : 'Claude'} ts={m.ts} />{/* i18n-ok: a product name */}
      <BoardCard tone={live ? 'wait' : 'rest'} className={`bubble-${m.role}`}>
        <div className="cb-head">
          <Icon name={isQ ? 'help-circle' : 'clipboard'} />
          <span className="cb-title">
            {isQ ? <b>{plural(n, t.chat.bubbles.questions)}</b> : <b>{plural(n, t.chat.bubbles.planTasks)}</b>}
            {' · '}<span className="cb-status">{statusText}</span>
          </span>
          {live && <button type="button" className="btn btn-amber btn-sm cb-action" onClick={onOpen}>{isQ ? t.chat.bubbles.answer : t.chat.bubbles.review}</button>}
        </div>
        {publish && (waiting || m.status === 'expired') && target && (
          <div className="cb-line">
            <Icon name="alert-triangle" className="cb-warn" />
            <span className="cb-ellipsis"><b>Artifact</b> · {target.action}{target.title ? ` «${target.title}»` : ''}</span>{/* i18n-ok: the tool's name */}
          </div>
        )}
        {isQ && m.status === 'answered' && m.answers && m.questions.map((q) => (
          <div className="cb-line cb-line--answer" key={q.question}>
            <Icon name="check" className="cb-ok" />
            <span><b>{q.header}</b> → {join(m.answers[q.question])}</span>
          </div>
        ))}
        {isQ && waiting && !live && !publish && <div className="cb-line cb-line--quiet">{m.questions.map((q) => q.header).join(' · ')}</div>}
        {!isQ && m.progress && <div className="cb-progress">{m.progress}</div>}
        {!isQ && m.status === 'revise' && m.feedback && <div className="cb-line cb-line--quiet">«{m.feedback}»</div>}
      </BoardCard>
    </div>
  );
}

/** One of your messages or Claude's, with its attachments and delivery note. */
export function MessageBubble({ m }) {
  const t = useStrings();
  const mine = m.role === 'user';
  // Claude's `<voz>` summaries (see voice.js) come out of the text and are shown apart.
  const voice = m.role === 'assistant' ? splitVoice(m.text) : null;
  return (
    <div className={`cb-msg${mine ? ' cb-msg--user' : ''}`}>
      <Who name={mine ? t.chat.bubbles.you : 'Claude'} ts={m.ts} />{/* i18n-ok: a product name */}
      {/* Claude writes Markdown, and printed raw it read as stray
          asterisks and backticks. You do not: a `*` you typed stays
          a `*`. So only its messages are rendered. A `boardOnly` one
          is yours too, sent to the board's planner, not to Claude. */}
      <div
        className={`${mine ? 'cb-user' : 'cb-claude bubble-md'}${m.boardOnly ? ' cb-board-only' : ''}`}
        title={m.boardOnly ? t.chat.bubbles.boardOnlyTitle : undefined}
      >
        {voice?.spoken.map((s, i) => (
          <div key={i} className="cb-voice" role="note">
            <span className="cb-voice-tag"><Icon name="volume" /> {t.chat.bubbles.spoken}</span> {s}
          </div>
        ))}
        {voice ? (voice.text ? <Markdown text={voice.text} /> : null) : m.text}
        {m.attachments?.length > 0 && (
          <div className="cb-attached">{m.attachments.map((a) => <span key={a}><Icon name="paperclip" /> {a}</span>)}</div>
        )}
        {m.delivery && DELIVERY_ICON[m.delivery] && <div className="cb-delivery"><Icon name={DELIVERY_ICON[m.delivery]} /> {t.chat.bubbles.delivery[m.delivery]}</div>}
      </div>
    </div>
  );
}

/** The «thinking» bubble of a busy chat, with its stop button. */
export function ThinkingBubble({ task, chat, pending, onAnswer }) {
  const t = useStrings();
  const { notice } = useDialog();
  const say = (e) => notice(typeof e === 'string' ? e : e.message);
  const planning = Boolean(chat.plan && ['running', 'asking'].includes(chat.plan.status));
  return (
    <div className="cb-msg">
      <Who name={planning ? t.chat.bubbles.board : 'Claude'} />{/* i18n-ok: a product name */}
      <div className="cb-thinking" role="status">
        <LiveDot />
        <span className="cb-activity">{chat.activity ?? t.chat.bubbles.thinking}</span>
        {pending && <button type="button" className="btn btn-amber btn-sm" onClick={onAnswer}>{t.chat.bubbles.answer}</button>}
        {planning ? (
          <button type="button" className="btn btn-danger btn-sm cb-stop" onClick={() => api.stopPlan(task, chat.id).catch(say)}><Icon name="stop" /> {t.chat.bubbles.stopPlan}</button>
        ) : (
          <button type="button" className="btn btn-danger btn-sm cb-stop" onClick={() => api.stopChat(task, chat.id).catch(say)}><Icon name="stop" /> {t.chat.bubbles.stop}</button>
        )}
      </div>
    </div>
  );
}

/** The day label that opens the first message of each day. */
export function DayDivider({ label }) {
  // `day-divider` stays: the sticky band in styles.css (`.messages > .day-divider`) hangs on it.
  return <div className="day-divider cb-day"><span>{label}</span></div>;
}
