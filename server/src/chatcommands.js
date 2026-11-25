/**
 * Slash commands typed in a chat. Pure: no store, no session.
 *
 * A message is a command when it is `/name` (letters, digits, `_`, `:`, `-`;
 * a letter first) optionally followed by whitespace and arguments. A path such
 * as `/src/app.js` is not: the second `/` breaks the name, and it goes to the
 * model as conversation, as it always did.
 *
 * Three families, decided in this order:
 *   - the board's own (`BOARD_COMMANDS`): answered by the board, never sent;
 *   - the ones the board keeps for itself (`DENIED`, plus whatever the CLI
 *     tags as terminal-only): refused with a pointer to the board's control —
 *     run inside the SDK they would change the session behind the chat's back
 *     (the model, the effort) or wait on a terminal nobody is looking at;
 *   - everything else the CLI lists (`query.supportedCommands()`): sent to the
 *     session as typed. A name nobody lists is refused, not sent: the CLI would
 *     hand an unknown command to the model as plain text and spend a turn.
 */

const COMMAND_RE = /^\/([A-Za-z][\w:-]*)(?:\s+([\s\S]*))?$/;

/** `{ name, args }` for a command, or null for anything that is conversation. */
export function parseCommand(text) {
  const m = String(text ?? '').trim().match(COMMAND_RE);
  if (!m) return null;
  return { name: m[1], args: (m[2] ?? '').trim() };
}

/** The commands the board answers itself. Descriptions are shown in the chat's command menu. */
export const BOARD_COMMANDS = [
  { name: 'clear', aliases: ['reset', 'new'], argumentHint: '', description: 'Empty this chat: its messages and the model\'s context (a fresh session)' },
  { name: 'model', aliases: [], argumentHint: '[name]', description: 'Show or switch this chat\'s model' },
  { name: 'plan', aliases: [], argumentHint: '[on|off]', description: 'Show or switch plan mode for this chat' },
  { name: 'help', aliases: [], argumentHint: '', description: 'What the chat\'s commands do' },
];

/** The board command a name (or alias) stands for, or null. Case-insensitive. */
export function boardCommand(name) {
  const n = String(name ?? '').toLowerCase();
  return BOARD_COMMANDS.find((c) => c.name === n || c.aliases.includes(n)) ?? null;
}

/**
 * CLI commands the chat does not run: each has a control of its own on the
 * board (the model picker, the effort and thinking selects, the tab's rename)
 * or only makes sense in an interactive terminal. A name ending in `*` covers
 * every name it starts.
 */
export const DENIED = [
  'model', 'effort', 'fast', 'config', 'settings', 'rename', 'name', 'mcp', 'output-style', 'autocompact',
  'advisor', 'goal', 'loop', 'import', 'heapdump', 'design*', 'usage-credits', 'extra-usage',
  '__remote-workflow', 'workflow-launch-exec',
];

/**
 * What the CLI tags as terminal-only (`terminal_slash_commands`), as CLI
 * 2.1.331 lists it. The CLI only says so in the `init` frame of a turn, and the
 * command menu is often asked for before any turn: this covers that gap, and
 * the session's own list is added on top once a turn has run.
 */
export const TERMINAL_COMMANDS = ['doctor', 'color', 'focus', 'reload-plugins'];

/** Whether a command name is refused; `terminal` is the CLI's own list of terminal-only commands. */
export function isDenied(name, terminal = []) {
  const n = String(name ?? '').toLowerCase();
  if ([...TERMINAL_COMMANDS, ...terminal].some((t) => String(t).toLowerCase() === n)) return true;
  return DENIED.some((d) => (d.endsWith('*') ? n.startsWith(d.slice(0, -1)) : n === d));
}

/**
 * The row of `list` (the CLI's `SlashCommand[]`) that `/name` runs, or null.
 * Name first — a built-in row wins over a custom one of the same name, as the
 * CLI itself decides — then an alias, then a plugin command typed without its
 * prefix (`/review` for `plugin:review`) when exactly one row ends that way.
 */
export function resolveCommand(list, name) {
  const rows = Array.isArray(list) ? list.filter((r) => r && typeof r.name === 'string') : [];
  const n = String(name ?? '').toLowerCase();
  const named = rows.filter((r) => r.name.toLowerCase() === n);
  if (named.length) return named.find((r) => r.builtin) ?? named[0];
  const aliased = rows.find((r) => (r.aliases ?? []).some((a) => String(a).toLowerCase() === n));
  if (aliased) return aliased;
  if (!n.includes(':')) {
    const suffixed = rows.filter((r) => r.name.toLowerCase().endsWith(`:${n}`));
    if (suffixed.length === 1) return suffixed[0];
  }
  return null;
}

/**
 * The list the menu shows: the board's commands first, then what the CLI
 * offers minus what the board answers or refuses. `source` is `board`,
 * `claude` (built into Claude Code) or `custom` (project, user, plugin, MCP).
 */
export function mergeCommandList(sdk = [], { terminal = [] } = {}) {
  const out = BOARD_COMMANDS.map((c) => ({
    name: c.name, description: c.description, argumentHint: c.argumentHint, aliases: [...c.aliases], source: 'board',
  }));
  const taken = new Set(BOARD_COMMANDS.flatMap((c) => [c.name, ...c.aliases]));
  const seen = new Set();
  for (const r of Array.isArray(sdk) ? sdk : []) {
    if (!r || typeof r.name !== 'string' || !r.name) continue;
    const name = r.name;
    const key = name.toLowerCase();
    if (taken.has(key) || seen.has(key) || isDenied(name, terminal)) continue;
    seen.add(key);
    out.push({
      name,
      description: String(r.description ?? ''),
      argumentHint: String(r.argumentHint ?? ''),
      aliases: Array.isArray(r.aliases) ? r.aliases.filter((a) => typeof a === 'string') : [],
      source: r.builtin ? 'claude' : 'custom',
    });
  }
  return out;
}

/** The board's `/help` answer. */
export function helpText() {
  const lines = BOARD_COMMANDS.map((c) => `- /${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}${c.aliases.length ? ` (also ${c.aliases.map((a) => `/${a}`).join(', ')})` : ''}: ${c.description}`);
  return 'Commands the board answers itself:\n'
    + `${lines.join('\n')}\n\n`
    + 'Any other command Claude Code offers in this session (for example /compact, /context, /usage, and the project\'s own commands and skills) '
    + 'is sent to the session as typed. Type / in the box to see the full list.';
}
