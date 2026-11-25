// The chat's slash-command menu, without React: when it opens, what it shows,
// and what picking a row writes in the box. Pure, so node can test it.

/** The menu follows the box while it holds `/` and a command name being typed, nothing else. */
export const COMMAND_DRAFT = /^\/[\w:-]*$/;

/** The partial name in the box (`/com` → `com`), or null when the box is not a command being typed. */
export function commandQuery(text) {
  const s = String(text ?? '');
  return COMMAND_DRAFT.test(s) ? s.slice(1).toLowerCase() : null;
}

/**
 * The rows for a partial name: the board's own commands before Claude's, and
 * in each of the two, names (and aliases) that start with it before those that
 * merely contain it. Otherwise the server's order holds.
 */
export function filterCommands(list, query) {
  const q = String(query ?? '').toLowerCase();
  const rows = Array.isArray(list) ? list : [];
  const names = (c) => [c.name, ...(c.aliases ?? [])].map((n) => String(n).toLowerCase());
  const pick = (group) => {
    if (!q) return group;
    const starts = group.filter((c) => names(c).some((n) => n.startsWith(q)));
    const contains = group.filter((c) => !starts.includes(c) && names(c).some((n) => n.includes(q)));
    return [...starts, ...contains];
  };
  return [...pick(rows.filter((c) => c.source === 'board')), ...pick(rows.filter((c) => c.source !== 'board'))];
}

/**
 * What picking a row leaves in the box: the command and a space, ready for its
 * arguments. Text already there that is not a command being typed is kept
 * after it, as the command's arguments.
 */
export function commandText(row, text = '') {
  const s = String(text ?? '');
  if (!s.trim() || COMMAND_DRAFT.test(s)) return `/${row.name} `;
  return `/${row.name} ${s.replace(/^\s+/, '')}`;
}

/** `/clear` and its aliases, typed alone: the panel empties the chat itself, after asking. */
export const isClearCommand = (text) => /^\/(clear|reset|new)\s*$/i.test(String(text ?? '').trim());

/** A description short enough for one row of the menu. */
export function shortDescription(text, max = 90) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
