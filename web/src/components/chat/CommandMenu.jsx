import React, { useEffect, useRef } from 'react';
import { useStrings } from '../../i18n/useStrings.js';
import { shortDescription } from '../../chatCommands.js';

/**
 * The slash-command list over the chat's input box. The box keeps the focus and
 * the keys (ChatPanel's `onKeyDown`); this only draws the rows, marks the
 * active one (`aria-activedescendant` on the box points at it) and takes clicks.
 */
export default function CommandMenu({ id, items, active, loading, complete, onPick, onHover }) {
  const t = useStrings();
  const listRef = useRef(null);
  // The active row stays in sight while the arrows walk past the visible ones.
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);
  const boardCount = items.filter((c) => c.source === 'board').length;
  return (
    <div className="cp-cmd-menu">
      <ul id={id} ref={listRef} role="listbox" className="cp-cmd-list" aria-label={t.chat.panel.commands}>
        {items.map((c, i) => (
          <React.Fragment key={`${c.source}:${c.name}`}>
            {(i === 0 || i === boardCount) && (
              <li role="presentation" className="cp-cmd-group">
                {c.source === 'board' ? t.chat.panel.commandsBoard : t.chat.panel.commandsClaude}
              </li>
            )}
            <li
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`cp-cmd-row${i === active ? ' is-active' : ''}`}
              // The box must not lose the focus, or the keys stop reaching it.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => onHover(i)}
              onClick={() => onPick(c)}
              title={c.description}
            >
              <span className="cp-cmd-name">/{c.name}</span>
              {c.argumentHint && <span className="cp-cmd-hint">{c.argumentHint}</span>}
              <span className="cp-cmd-desc">{shortDescription(c.description)}</span>
            </li>
          </React.Fragment>
        ))}
        {!items.length && !loading && <li role="presentation" className="cp-cmd-empty">{t.chat.panel.commandsEmpty}</li>}
        {(loading || !complete) && (
          <li role="presentation" className="cp-cmd-empty">{loading ? t.chat.panel.commandsLoading : t.chat.panel.commandsPartial}</li>
        )}
      </ul>
    </div>
  );
}
