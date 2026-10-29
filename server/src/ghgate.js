import { publishProblems } from './language.js';
import { PR_TITLE_MAX } from './prtitle.js';

/**
 * The gate on the `gh` commands an agent runs itself.
 *
 * PR #1445 is why this exists. Everything the board publishes goes through the
 * helpers in github.js, and those call `assertPublishable`: a Spanish comment
 * cannot leave that way. But a session with a Bash tool does not need the
 * board's helpers — it ran `gh pr comment --body "..."` with a Spanish body and
 * the comment was public before anyone read the log. The prompt asked for
 * English. A prompt asks; it does not guarantee.
 *
 * So the same check moves to where the command is decided: the caller can hand
 * a Bash call to `ghPublishProblems` before it runs and deny it. What this
 * module contributes is the boring, error-prone half — deciding whether a shell
 * line publishes anything at all, and pulling the body out of it.
 *
 * Which is harder than it looks, and the failures are asymmetric. A body this
 * module cannot see is a body nobody checks, so every path that ends in "no
 * text to look at" ends in a denial instead: heredocs, pipes, variables,
 * command substitution, `--fill`, a file this line rewrites before publishing
 * it. And a line it cannot even parse, but that plainly calls `gh`, is denied
 * too — an unreadable command is not a safe one.
 *
 * Three traps are worth naming, because each one was a hole:
 *
 * - `-F` means body-file to `gh pr`, and a typed field to `gh api`, where the
 *   file is spelled `-F body=@path` and `-f body=text` is literal.
 * - `gh api` defaults to POST the moment it carries a field, so requiring an
 *   explicit `-X POST` misses the most common way to write a comment. And the
 *   route does not matter: `PATCH …/pulls/7`, `POST …/issues` and a review
 *   event all publish prose. Any write with a visible `body` is checked.
 * - `gh api graphql` with an `addComment` mutation is exactly the pattern
 *   github.js itself uses, so it is the one an agent copies.
 *
 * Titles cross the same filter, with the cap a title has (`PR_TITLE_MAX`)
 * rather than a body's. github.js already guards the titles it writes itself,
 * so the hole was only ever the agent opening its own PR: `gh pr create
 * --title "<Spanish>"` published as much prose as a comment did and sailed
 * through. A title that fails says it is the title, because the agent has to
 * know which of the two to rewrite — and a title on its own is already
 * publishing, even when the body is left to the editor.
 *
 * What it still does not check: labels, reviewers, and the commit messages
 * behind `--fill`. The deny message says so rather than promising a cover it
 * does not give.
 *
 * All of the above is one question — «what would this publish?» — and the file
 * has a second half that asks another one: `stateChangeProblem`, at the bottom,
 * asks what a command *does* to GitHub, because closing an issue publishes no
 * prose and therefore leaves this half nothing to judge. It is an allow-list,
 * it is asked of the pipeline phases and not of the chat, and its own comment
 * explains why.
 */

/**
 * The cap github.js already applies to a PR body (`assertPublishable(body, …,
 * { maxChars: 60_000 })`). A normal body — a before/after table, four
 * sections — blows past the 4 000 characters `publishProblems` defaults to, so
 * without this a good PR would be denied for being long. It follows what is
 * being published, not which verb publishes it: a PR body written through
 * `gh api -X PATCH …/pulls/7` is still a PR body.
 */
export const PR_BODY_MAX = 60_000;

/**
 * The verbs that publish prose, with the flags each one spells it with. A
 * single `--body` rule would miss `gh pr close --comment` and
 * `gh release create --notes`, which are the same act under another name.
 *
 * `title` is only listed where `gh` really takes one. Guessing would be worse
 * than missing it: `gh pr create -T` is `--template` and `gh release create
 * -n` is the notes, so a flag read off the wrong verb reads the wrong string.
 */
const VERBS = new Map([
  ['pr comment', { kind: 'comment', text: ['--body', '-b'], file: ['--body-file', '-F'] }],
  ['issue comment', { kind: 'comment', text: ['--body', '-b'], file: ['--body-file', '-F'] }],
  ['pr review', { kind: 'review', text: ['--body', '-b'], file: ['--body-file', '-F'] }],
  ['pr create', { kind: 'pr-create', text: ['--body', '-b'], file: ['--body-file', '-F'], title: ['--title', '-t'], fill: ['--fill', '-f', '--fill-first', '--fill-verbose'] }],
  ['pr edit', { kind: 'pr-edit', text: ['--body', '-b'], file: ['--body-file', '-F'], title: ['--title', '-t'] }],
  ['issue create', { kind: 'issue-create', text: ['--body', '-b'], file: ['--body-file', '-F'], title: ['--title', '-t'] }],
  ['issue edit', { kind: 'issue-edit', text: ['--body', '-b'], file: ['--body-file', '-F'], title: ['--title', '-t'] }],
  ['pr merge', { kind: 'merge', text: ['--body', '-b'], file: ['--body-file', '-F'] }],
  ['pr close', { kind: 'comment', text: ['--comment', '-c'] }],
  ['issue close', { kind: 'comment', text: ['--comment', '-c'] }],
  ['release create', { kind: 'release-notes', text: ['--notes', '-n'], file: ['--notes-file', '-F'], title: ['--title', '-t'] }],
  ['release edit', { kind: 'release-notes', text: ['--notes', '-n'], file: ['--notes-file', '-F'], title: ['--title', '-t'] }],
]);

/** Bodies that are a document rather than a remark: the big cap. */
const LONG_BODY_KINDS = new Set(['pr-create', 'pr-edit', 'issue-create', 'issue-edit', 'release-notes']);

/** `gh api` flags that consume the token after them. */
const API_VALUE_FLAGS = new Set([
  '-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header',
  '--input', '--hostname', '--cache', '-t', '--template', '-q', '--jq', '-p', '--preview',
]);

/** Methods that publish. PUT is in: denying one costs a redraft, missing one is #1445. */
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT']);

/** Routes whose body is a remark. Only used to pick the cap — never to gate. */
const COMMENT_ROUTE = /\/(?:comments|reviews|replies|events)(?:\/\d+)?\/?$/;

/** Flags that sit between the group and the verb: `gh pr -R owner/repo comment 1`. */
const GROUP_VALUE_FLAGS = new Set(['-R', '--repo']);

/** Paths that are really the process's own input. Reading these can block. */
const STDIN_PATHS = new Set(['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0', '/dev/tty']);

/** Prefixes that run the next command unchanged, and how much of them to skip. */
const WRAPPERS = new Map([
  ['command', {}],
  ['exec', { valueFlags: new Set(['-a']) }],
  ['nohup', {}],
  ['env', { valueFlags: new Set(['-u', '--unset', '-C', '--chdir']) }],
  ['nice', { valueFlags: new Set(['-n', '--adjustment']) }],
  ['stdbuf', { valueFlags: new Set(['-i', '-o', '-e']) }],
  ['timeout', { valueFlags: new Set(['-k', '--kill-after', '-s', '--signal']), positional: 1 }],
  ['time', {}],
]);

/**
 * Words that open or join a compound command and run nothing themselves: in
 * `if true; then npm ci; fi` the piece after the `;` starts with `then`, and
 * the command is the word that follows it.
 */
const KEYWORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '{', '!']);

/** Shells whose `-c` argument is another command line. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/** What the program of a command has to be called for the rest to be a `gh` call. */
const GH_NAMES = new Set(['gh', 'gh.exe']);

/** The last-resort net: a line that calls `gh` at all. */
const LOOKS_LIKE_GH = /(?:^|[\s;&|(])gh(?:\.exe)?\s+(?:pr|issue|api|release)\b/;

/**
 * The same net for `callsGh`, without the verb list. `LOOKS_LIKE_GH` is asking
 * "could this line publish?", so naming the four groups that publish is right
 * there. `callsGh` is asking "does this line run `gh` at all?", and `gh label`,
 * `gh repo` and `gh auth` are exactly what the verb list drops — so this one
 * takes any word after `gh`, or none. A leading `/` is in the class because a
 * net is for the lines `parse` could not read, and `/usr/bin/gh` is one of the
 * shapes it misses there.
 *
 * The backtick is in the class for the same reason, and it is not a curiosity:
 * `` echo `gh issue close 1` `` runs `gh`, exactly as `echo "$(gh issue close
 * 1)"` does, and `lex` deliberately throws the inside of a backtick away as
 * unreadable — so `scan` never sees that call and this net is all there is.
 * (`lex` now also keeps the inside as `subs` on the word, for the install gate;
 * `scan` still ignores it.)
 * Without the backtick here the two spellings of the same substitution
 * answered differently, and models write the old one.
 */
const MENTIONS_GH = /(?:^|[\s;&|(<>/`])gh(?:\.exe)?(?:\s|$)/;

export const base = (value) => String(value ?? '').replace(/\\/g, '/').split('/').pop().toLowerCase();

// ---------------------------------------------------------------------------
// Reading the command line

/** Index of the first backtick at or after `from` that a backslash does not escape, or -1. */
function closingBacktick(src, from) {
  for (let k = from; k < src.length; k += 1) {
    if (src[k] === '\\') { k += 1; continue; }
    if (src[k] === '`') return k;
  }
  return -1;
}

/** Inside backticks bash removes the backslash before a backtick, a backslash or a dollar sign. */
const backtickBody = (text) => text.replace(/\\([`\\$])/g, '$1');

/**
 * Index of the `)` that closes the `(` at `open`, or the end of the text.
 * Quote-aware: a `)` inside '…' or "…" does not close `$(…)`, and a nested
 * `$(…)` inside double quotes opens its own fresh quoting context. An
 * unterminated quote swallows the rest, as the shell would keep waiting.
 *
 * `memo` (open index → answer of the quote-aware scan) is shared by every call
 * on the same text: without it each `$(` of a pathological line rescans the rest
 * of the line and the cost is quadratic.
 */
function closeParen(src, open, memo = new Map()) {
  // Quotes are only right when they pair up. An apostrophe in a heredoc body or a
  // `#` comment inside the substitution leaves one open: then the answer is the
  // plain parenthesis count, which is what this scan always was.
  const at = scanParen(src, open, true, memo);
  return at >= 0 ? at : Math.max(scanParen(src, open, false), 0) || src.length;
}

/**
 * The `)` closing the `(` at `open`, or -1. `aware` skips quoted spans.
 * Iterative: a `$(` inside double quotes pushes the state it interrupts on an
 * explicit stack, so a deeply nested line cannot overflow the call stack. In
 * aware mode every substitution the scan opens gets its answer recorded in
 * `memo`, closed or not.
 */
function scanParen(src, open, aware, memo) {
  const stack = [];          // contexts a `$(` inside double quotes interrupted
  let depth = 0;
  let inDq = false;
  let from = open;           // where the current context opened
  const fail = () => {
    if (memo) { memo.set(from, -1); for (const frame of stack) memo.set(frame.from, -1); }
    return -1;
  };
  if (aware && memo?.has(open)) return memo.get(open);
  for (let k = open; k < src.length; k += 1) {
    const c = src[k];
    if (inDq) {
      if (c === '\\') k += 1;
      else if (c === '"') inDq = false;
      else if (c === '$' && src[k + 1] === '(') {
        const known = memo?.get(k + 1);
        if (known !== undefined && known < 0) return fail();
        stack.push({ depth, from });
        depth = 0;
        inDq = false;
        from = k + 1;
        k += 1;
        depth += 1;
      }
      continue;
    }
    if (c === '\\') { k += 1; continue; }
    if (aware && c === "'") {
      const end = src.indexOf("'", k + 1);
      if (end < 0) return fail();
      k = end;
    } else if (aware && c === '"') inDq = true;
    else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth) continue;
      if (!stack.length) { if (memo && aware) memo.set(from, k); return k; }
      if (memo) memo.set(from, k);
      ({ depth, from } = stack.pop());
      inDq = true;
    }
  }
  return fail();
}

/** The text inside each `$(…)` and backtick of an unquoted heredoc body (they run). */
function heredocSubs(text) {
  const subs = [];
  const memo = new Map();
  for (let k = 0; k < text.length; k += 1) {
    if (text[k] === '\\') k += 1;
    else if (text[k] === '$' && text[k + 1] === '(') {
      const close = closeParen(text, k + 1, memo);
      subs.push(text.slice(k + 2, close));
      k = close;
    } else if (text[k] === '`') {
      const end = closingBacktick(text, k + 1);
      subs.push(backtickBody(text.slice(k + 1, end < 0 ? text.length : end)));
      if (end < 0) break;
      k = end;
    }
  }
  return subs;
}

/**
 * Splits a Bash line into tokens, honouring single and double quotes, escapes,
 * heredocs and command substitution.
 *
 * A token carries `unsafe` when its value depends on something only the shell
 * knows — `$VAR`, `$(…)`, a backtick — because a body like that cannot be
 * checked from here and must not be mistaken for the empty string. A lone `$`
 * is not that: `"Price in USD$"` is a price, and marking it unsafe would deny
 * a perfectly readable body.
 */
function lex(command, crlf = 'join') {
  const src = String(command ?? '');
  const tokens = [];
  const pending = [];        // heredoc delimiters whose body is still ahead
  let value = '';
  let unsafe = false;
  let started = false;
  let subs = [];             // the text inside each `$(…)` and backtick of the word
  let i = 0;

  const flush = () => {
    if (started) tokens.push(subs.length ? { value, unsafe, subs } : { value, unsafe });
    value = '';
    unsafe = false;
    started = false;
    subs = [];
  };

  const memo = new Map();
  const closeOf = (open) => closeParen(src, open, memo);
  const op = (token) => { flush(); tokens.push(token); };

  // Everything from here to the line that says the delimiter belongs to the
  // heredoc, not to the command line.
  const skipHeredocBodies = () => {
    while (pending.length) {
      const doc = pending.shift();
      const lines = [];
      while (i < src.length) {
        const nl = src.indexOf('\n', i);
        const line = nl < 0 ? src.slice(i) : src.slice(i, nl);
        i = nl < 0 ? src.length : nl + 1;
        if (line.trim() === doc.delim) break;
        lines.push(line);
      }
      doc.text = lines.join('\n');
    }
  };

  // `2>&1` and `2>/dev/null`: the descriptor belongs to the redirection, not
  // to the command — left as a word it lands where the route is read.
  const dropDescriptor = () => {
    if (started && /^\d+$/.test(value)) { value = ''; started = false; }
  };

  while (i < src.length) {
    const c = src[i];

    if (c === '\n') { op({ op: ';' }); i += 1; skipHeredocBodies(); continue; }
    if (c === ' ' || c === '\t' || c === '\r') { flush(); i += 1; continue; }

    if (c === "'") {
      started = true;
      const end = src.indexOf("'", i + 1);
      if (end < 0) { value += src.slice(i + 1); unsafe = true; i = src.length; continue; }
      value += src.slice(i + 1, end);
      i = end + 1;
      continue;
    }

    if (c === '"') {
      started = true;
      i += 1;
      let closed = false;
      while (i < src.length) {
        const d = src[i];
        if (d === '\\' && i + 1 < src.length && '"\\$`'.includes(src[i + 1])) { value += src[i + 1]; i += 2; continue; }
        if (d === '"') { i += 1; closed = true; break; }
        if (d === '`') {
          // The whole span goes into the value at once, so the closing backtick
          // is not mistaken for the opening of another one.
          unsafe = true;
          const end = closingBacktick(src, i + 1);
          subs.push(backtickBody(src.slice(i + 1, end < 0 ? src.length : end)));
          value += src.slice(i, end < 0 ? src.length : end + 1);
          i = end < 0 ? src.length : end + 1;
          continue;
        }
        if (d === '$' && /[A-Za-z_{(0-9]/.test(src[i + 1] ?? '')) {
          unsafe = true;
          if (src[i + 1] === '(') {
            // The whole substitution goes into the value at once: its own quotes
            // are not the ones that close this string.
            const close = closeOf(i + 1);
            subs.push(src.slice(i + 2, close));
            value += src.slice(i, close + 1);
            i = Math.min(close + 1, src.length);
            continue;
          }
        }
        value += d;
        i += 1;
      }
      if (!closed) unsafe = true;
      continue;
    }

    if (c === '\\' && i + 1 < src.length) {
      if (src[i + 1] === '\n') { i += 2; continue; }   // line continuation
      // The same with CRLF in a shell that skips the CR; one that does not escapes the CR
      // as a literal and the LF ends the command (a Linux bash). See `lineReadings`.
      if (crlf === 'join' && src[i + 1] === '\r' && src[i + 2] === '\n') { i += 3; continue; }
      started = true;
      value += src[i + 1];
      i += 2;
      continue;
    }

    if (c === '$' && src[i + 1] === '(') {
      started = true;
      unsafe = true;
      i += 1;
      const close = closeOf(i);
      subs.push(src.slice(i + 1, close));
      i = Math.min(close + 1, src.length);
      continue;
    }
    if (c === '$') {
      started = true;
      if (/[A-Za-z_{0-9]/.test(src[i + 1] ?? '')) unsafe = true;
      value += c;
      i += 1;
      continue;
    }
    if (c === '`') {
      started = true;
      unsafe = true;
      const end = closingBacktick(src, i + 1);
      subs.push(backtickBody(src.slice(i + 1, end < 0 ? src.length : end)));
      i = end < 0 ? src.length : end + 1;
      continue;
    }

    if (c === '<' && src[i + 1] === '<' && src[i + 2] === '<') {
      // A here-string: the word that follows is the shell's stdin.
      dropDescriptor();
      op({ op: 'redir', write: false, here: true });
      i += 3;
      continue;
    }
    if (c === '<' && src[i + 1] === '<') {
      dropDescriptor();
      flush();
      i += 2;
      if (src[i] === '-') i += 1;
      while (i < src.length && /\s/.test(src[i])) i += 1;
      let delim = '';
      let quoted = false;   // a quoted delimiter makes the body literal: nothing in it runs
      while (i < src.length && !/\s/.test(src[i]) && !'|&;<>'.includes(src[i])) {
        if (!`'"\\`.includes(src[i])) delim += src[i];
        else quoted = true;
        i += 1;
      }
      const doc = { delim, quoted, text: '' };
      pending.push(doc);
      tokens.push({ op: 'heredoc', doc });
      continue;
    }
    if (c === '<' || c === '>' || (c === '&' && src[i + 1] === '>')) {
      dropDescriptor();
      const write = c !== '<';
      op({ op: 'redir', write });
      i += 1;
      while (i < src.length && '<>&|'.includes(src[i])) i += 1;
      continue;
    }

    if (c === '|' || c === '&' || c === ';') {
      const double = src[i + 1] === c;
      op({ op: c === '|' && !double ? '|' : ';' });
      i += double ? 2 : 1;
      continue;
    }
    if (c === '(' || c === ')') { op({ op: ';' }); i += 1; continue; }

    started = true;
    value += c;
    i += 1;
  }
  flush();
  return tokens;
}

/**
 * The tokens grouped into the simple commands they belong to, each with
 * whether a heredoc fed it and which files it writes. A redirection target is
 * not an argument — but `printf … > body.md && gh pr comment -F body.md` turns
 * on knowing that this line wrote that file, so it is kept rather than
 * dropped.
 */
function split(command, crlf) {
  const out = [];
  // Besides what `scan` reads, a command carries for the install gate: `subs`
  // (the text inside its `$(…)` and backticks, wherever they sit, an assignment
  // included), `heredocBody` (the heredoc or here-string that feeds it) and
  // `pipedIn` (whether a `|` leads into it).
  const fresh = (pipedIn = false) => ({ words: [], heredoc: false, writes: [], subs: [], heredocBody: null, pipedIn, stdinFrom: false });
  let cur = fresh();
  let pendingRedir = null;

  for (const token of lex(command, crlf)) {
    if (token.op === undefined) {
      if (token.subs) cur.subs.push(...token.subs);
      if (pendingRedir) {
        if (pendingRedir.write) cur.writes.push(token);
        if (pendingRedir.here) cur.heredocBody = token.value;
        // `< file`: the command reads its stdin from a file this module cannot see.
        if (!pendingRedir.write && !pendingRedir.here) cur.stdinFrom = true;
        pendingRedir = null;
        continue;
      }
      cur.words.push(token);
      continue;
    }
    if (token.op === 'heredoc') { cur.heredoc = true; cur.heredocBody = token.doc; continue; }
    if (token.op === 'redir') { pendingRedir = token; continue; }
    out.push(cur);
    cur = fresh(token.op === '|');
    pendingRedir = null;
  }
  out.push(cur);
  // `lex` has filled every heredoc body by now: the holder becomes its text.
  for (const c of out) {
    if (!c.heredocBody || typeof c.heredocBody !== 'object') continue;
    const doc = c.heredocBody;
    c.heredocBody = doc.text;
    // An unquoted heredoc expands `$(…)` and backticks in its body.
    if (!doc.quoted) c.subs.push(...heredocSubs(doc.text));
  }
  return out.filter((c) => c.words.length || c.writes.length);
}

/**
 * Drops the transparent prefixes: `timeout 60 gh …`, `env X=1 gh …`, `nohup gh …`,
 * and the shell keywords that open a compound command (`then`, `do`, `{`, `!`…).
 */
function stripWrappers(words) {
  let i = 0;
  for (let guard = 0; guard < 8; guard += 1) {
    while (i < words.length) {
      // `function f { …`: the keyword and the name after it run nothing.
      if (!words[i].unsafe && words[i].value === 'function') { i += 2; continue; }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].value) || (!words[i].unsafe && KEYWORDS.has(words[i].value))) { i += 1; continue; }
      break;
    }
    const spec = WRAPPERS.get(base(words[i]?.value));
    if (!spec) break;
    i += 1;
    while (i < words.length && words[i].value.startsWith('-')) {
      const flag = words[i].value;
      i += 1;
      if (spec.valueFlags?.has(flag)) i += 1;
    }
    i += spec.positional ?? 0;
  }
  return words.slice(i);
}

/**
 * The readings of a line that a shell could give it. A backslash before a CRLF
 * is a continuation where the shell drops the CR, and an escaped CR followed by
 * a command separator where it does not (bash on Linux, the runner). A line that
 * has one is judged under both, `{ crlf: 'join' }` and `{ crlf: 'break' }`, and
 * the stricter verdict stands; any other line has the one reading.
 */
export function lineReadings(command) {
  return /\\\r\n/.test(String(command ?? '')) ? [{ crlf: 'join' }, { crlf: 'break' }] : [{ crlf: 'join' }];
}

/**
 * Commands, with `sh -c '…'` and `eval …` re-read as the command lines they are.
 * `words` has the transparent prefixes peeled (see `stripWrappers`); `rawWords`
 * is the same command before that, for a caller with a wrapper table of its own.
 * A shell spliced in place of the command that ran it takes that command's
 * substitutions, heredoc and pipe with it, so nothing the outer line expands is lost.
 */
export function parse(command, depth = 0, { crlf = 'join' } = {}) {
  const out = [];
  for (const cmd of split(command, crlf)) {
    const words = stripWrappers(cmd.words);
    const program = base(words[0]?.value);
    const rawWords = cmd.words;

    // The inner commands stand for `cmd`: what it expands, feeds and pipes still happens.
    const spliced = (inner) => {
      if (!inner.length) { out.push({ ...cmd, words: [], rawWords: [] }); return; }
      const [head, ...tail] = inner;
      out.push({
        ...head,
        subs: [...cmd.subs, ...head.subs],
        heredoc: head.heredoc || cmd.heredoc,
        heredocBody: head.heredocBody ?? cmd.heredocBody,
        pipedIn: head.pipedIn || cmd.pipedIn,
        writes: [...cmd.writes, ...head.writes],
      }, ...tail);
    };

    if (depth < 3 && SHELLS.has(program)) {
      const flag = words.findIndex((w, k) => k > 0 && /^-[a-z]*c$/.test(w.value));
      const arg = flag > 0 ? words[flag + 1] : null;
      if (arg && !arg.unsafe && arg.value) {
        spliced(parse(arg.value, depth + 1, { crlf }));
        continue;
      }
    }
    if (program === 'eval') {
      const rest = words.slice(1);
      // `eval 'gh pr comment …'` is one string to read again. `eval gh pr
      // comment … --body "a b"` is not: joining those words back into a line
      // would lose the quotes that hold the body together, and the body would
      // arrive as its first word. Dropping `eval` keeps every token intact.
      if (depth < 3 && rest.length === 1 && !rest[0].unsafe && rest[0].value) {
        spliced(parse(rest[0].value, depth + 1, { crlf }));
        continue;
      }
      out.push({ ...cmd, words: rest, rawWords });
      continue;
    }

    out.push({ ...cmd, words, rawWords });
  }
  return out;
}

/** How deep a substitution may sit inside another before the line is not read any further. */
const MAX_NESTING = 4;

/**
 * Every command on the line at every level, as `{ cmd, nested }`: the command,
 * then what its `$(…)` and backticks run, then the body of a heredoc a shell
 * reads (`bash <<EOF`). A substitution is a command line of its own, so it is
 * read again with the same reading; `nested` marks the ones that run in a
 * subshell, whose `cd` is not the line's. Past `MAX_NESTING` levels it does
 * not descend and does not throw: it yields `{ tooDeep: true, text }` for the
 * unread text, so everything read at the levels above it (the whole top level
 * and the siblings of the deep part) is still judged, in whatever quoting.
 * The callers judge the unread text with the `MENTIONS_GH` net: a command that
 * exists only inside it is refused when that text mentions `gh`, as the old
 * fallback did. Acceptable: no real session nests more than 4 levels.
 */
function* deepCommands(command, reading, depth = 0) {
  if (depth > MAX_NESTING) { yield { tooDeep: true, text: command }; return; }
  for (const cmd of parse(command, 0, reading)) {
    yield { cmd, nested: depth > 0 };
    for (const sub of cmd.subs) yield* deepCommands(sub, reading, depth + 1);
    if (typeof cmd.heredocBody === 'string' && SHELLS.has(base(cmd.words[0]?.value))) {
      yield* deepCommands(cmd.heredocBody, reading, depth + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// What a command publishes

/**
 * A flag and its value: `--body x`, `--body=x`, `-b x`, `-bx`. Null when this
 * token is not one of `names`. `used` counts the tokens it ate, so the caller
 * does not read the value again as if it were a flag of its own — a body that
 * happens to start with `-b` would otherwise match itself.
 */
function takeFlag(words, i, names) {
  const { value: raw, unsafe } = words[i];
  for (const name of names) {
    if (raw === name) return { ...(words[i + 1] ?? { value: '', unsafe: true }), used: 2 };
    if (raw.startsWith(`${name}=`)) return { value: raw.slice(name.length + 1), unsafe, used: 1 };
    if (!name.startsWith('--') && raw.startsWith(name) && raw.length > name.length) {
      return { value: raw.slice(name.length), unsafe, used: 1 };
    }
  }
  return null;
}

/**
 * The group and verb of a `gh` call, skipping the flags that sit between them.
 *
 * It gives up when `args[0]` is a flag, which for the prose gate is harmless —
 * no group means no entry in `VERBS` means no body to read — and for the gate
 * at the bottom of this file is not, so that one reads the call with `callOf`
 * instead. See the note there.
 */
function verbOf(args) {
  const group = args[0] && !args[0].value.startsWith('-') ? args[0].value.toLowerCase() : null;
  if (!group) return { group: null, verb: null };
  let i = 1;
  while (i < args.length) {
    const raw = args[i].value;
    if (!raw.startsWith('-')) return { group, verb: raw.toLowerCase() };
    i += GROUP_VALUE_FLAGS.has(raw) ? 2 : 1;
  }
  return { group, verb: null };
}

/** Where the body came from, or why there is none to read. */
function sourceOf({ body, bodyFile, heredoc, fill }) {
  if (fill) return 'fill';
  if (body !== null) return 'inline';
  if (bodyFile && STDIN_PATHS.has(bodyFile)) return heredoc ? 'heredoc' : 'stdin';
  if (bodyFile) return 'file';
  return heredoc ? 'heredoc' : 'expansion';
}

/** What a `gh pr` / `gh issue` / `gh release` call publishes, or null. */
function subcommandIntent(args, cmd) {
  const { group, verb } = verbOf(args);
  const spec = VERBS.get(`${group} ${verb}`);
  if (!spec) return null;

  let body = null;
  let bodyFile = null;
  let title = null;
  let seen = false;
  let titleSeen = false;
  let fill = false;

  for (let i = 0; i < args.length; i += 1) {
    if (spec.fill?.includes(args[i].value)) { fill = true; seen = true; continue; }

    // The file flag first: `--body-file` also starts with `--body`.
    const file = spec.file ? takeFlag(args, i, spec.file) : null;
    if (file) {
      seen = true;
      if (!file.unsafe && file.value) bodyFile = file.value;
      i += file.used - 1;
      continue;
    }
    const named = spec.title ? takeFlag(args, i, spec.title) : null;
    if (named) {
      titleSeen = true;
      if (!named.unsafe) title = named.value;
      i += named.used - 1;
      continue;
    }
    const text = takeFlag(args, i, spec.text);
    if (text) {
      seen = true;
      if (!text.unsafe) body = text.value;
      i += text.used - 1;
    }
  }

  // No body and no title: `gh pr comment 12` opens an editor and
  // `gh pr review --approve` publishes no prose. Neither is ours. But a title
  // with no body is not that case — `gh issue create --title "…"` leaves the
  // body to the editor and publishes the title all the same.
  if (!seen && !titleSeen) return null;

  return {
    verb: `${group} ${verb}`,
    kind: spec.kind,
    body,
    bodyFile,
    title,
    titleFile: null,
    titleJson: false,
    titleSource: titleSeen ? (title === null ? 'expansion' : 'inline') : null,
    // A command with no body flag has no body to place: `source` and
    // `maxChars` describe a body, so they say nothing rather than guessing.
    source: seen ? sourceOf({ body, bodyFile, heredoc: cmd.heredoc, fill: fill && body === null && bodyFile === null }) : null,
    maxChars: seen && LONG_BODY_KINDS.has(spec.kind) ? PR_BODY_MAX : null,
  };
}

/**
 * A `gh api` call taken apart: its method, its route, and every `-f`/`-F`
 * field, with `seen` for the `--input` payload that is a body nobody here can
 * read. `words` starts after `api`.
 *
 * Split out of `apiIntent` because `stateChangeProblem` asks a different
 * question of the same three answers — is this a write, and to what — and
 * reading `-X`, `-Xfoo`, `--method=foo` and `-F body=@x` correctly is the part
 * of this module that has been wrong most often. One reader, two questions.
 */
function apiParts(words) {
  let method = null;
  let route = null;
  let routeUnsafe = false;
  let inputFile = null;
  let seen = false;
  const fields = [];

  for (let i = 0; i < words.length; i += 1) {
    const { value: raw, unsafe } = words[i];

    if (!raw.startsWith('-') || raw === '-') {
      if (route === null) { route = raw; routeUnsafe = Boolean(unsafe); }
      continue;
    }

    let name = raw;
    let attached = null;
    const eq = raw.indexOf('=');
    if (raw.startsWith('--') && eq > 0) {
      name = raw.slice(0, eq);
      attached = { value: raw.slice(eq + 1), unsafe };
    } else if (!raw.startsWith('--') && raw.length > 2) {
      name = raw.slice(0, 2);
      attached = { value: raw.slice(2), unsafe };
    }

    const value = attached ?? (API_VALUE_FLAGS.has(name) ? words[i += 1] : null);
    if (!value) continue;

    if (name === '-X' || name === '--method') { method = String(value.value).toUpperCase(); continue; }
    if (name === '--input') {
      seen = true;
      if (!value.unsafe && value.value) inputFile = value.value;
      continue;
    }
    if (name === '-f' || name === '--raw-field' || name === '-F' || name === '--field') {
      const field = /^([A-Za-z_][\w.[\]]*)=([\s\S]*)$/.exec(value.value);
      if (!field) continue;
      // Only the typed form reads a file: `-F body=@x.md`. `-f body=@x.md` is
      // the literal eight characters, and checking it as prose is correct.
      const typed = name === '-F' || name === '--field';
      fields.push({ name: field[1], value: field[2], unsafe: value.unsafe, file: typed && field[2].startsWith('@') });
    }
  }

  return { method, route, routeUnsafe, inputFile, seen, fields };
}

/** What a `gh api` call publishes, or null. `words` starts after `api`. */
function apiIntent(words, cmd) {
  const { method, route, inputFile, seen, fields } = apiParts(words);
  let bodyFile = inputFile;

  // gh POSTs as soon as it carries a field; requiring `-X POST` misses the
  // most common way there is to write a comment.
  const wrote = fields.length > 0 || seen;
  if (!WRITE_METHODS.has(method ?? (wrote ? 'POST' : 'GET'))) return null;

  const graphql = base(route) === 'graphql';
  const carriers = graphql
    // A mutation says what it publishes inside its own text, and the variable
    // that feeds it is the comment. Both go through the filter whole.
    ? fields.filter((f) => f.name === 'body' || /mutation/i.test(f.value))
    : fields.filter((f) => f.name === 'body');

  // A mutation's own text already crosses the filter whole, and the title it
  // sets is inside that text — pulling it out again would only say it twice.
  const named = graphql ? [] : fields.filter((f) => f.name === 'title');

  // Nothing prose-shaped on the line: a label, a merge flag, a rename.
  if (!carriers.length && !named.length && !seen) return null;

  const unreadable = carriers.some((f) => f.unsafe);
  const fileField = carriers.find((f) => f.file && !f.unsafe);
  const texts = carriers.filter((f) => !f.unsafe && !f.file).map((f) => f.value);

  if (fileField) bodyFile = fileField.value.slice(1);
  const body = unreadable || !texts.length ? null : texts.join('\n\n');

  const title = titleOfApi(named, inputFile);

  return {
    verb: graphql ? 'api graphql' : 'api',
    kind: graphql ? 'graphql' : 'api',
    body,
    bodyFile: body === null ? bodyFile : null,
    ...title,
    // `-f title=…` on its own carries no body: without this the missing body
    // would read as one the module cannot see, and a legitimate rename would
    // be denied for a body that was never there.
    source: carriers.length || seen
      ? sourceOf({ body, bodyFile: body === null ? bodyFile : null, heredoc: cmd.heredoc, fill: false })
      : null,
    // A comment is a remark; anything else may well be a PR body, and the cap
    // only guards length — erring long costs nothing a reviewer would notice.
    maxChars: !graphql && route && COMMENT_ROUTE.test(String(route).split('?')[0]) ? null : PR_BODY_MAX,
  };
}

/**
 * Where a `gh api` call's title comes from. A `title=` field is the same three
 * shapes `body=` has — literal, `@file`, or a value only the shell knows — and
 * with none of them the title may still be inside the JSON `--input` hands
 * over, which is why that file is marked `titleJson`: there the title is the
 * `title` key, not the whole document.
 */
function titleOfApi(named, inputFile) {
  const none = { title: null, titleFile: null, titleSource: null, titleJson: false };

  if (!named.length) {
    // Standard input is not a file to open twice: the body already denies it.
    if (!inputFile || STDIN_PATHS.has(inputFile)) return none;
    return { title: null, titleFile: inputFile, titleSource: 'file', titleJson: true };
  }

  const file = named.find((f) => f.file && !f.unsafe);
  if (file) return { title: null, titleFile: file.value.slice(1), titleSource: 'file', titleJson: false };

  const texts = named.filter((f) => !f.unsafe && !f.file).map((f) => f.value);
  if (!texts.length) return { ...none, titleSource: 'expansion' };
  return { title: texts.join(' '), titleFile: null, titleSource: 'inline', titleJson: false };
}

/**
 * Every `gh` call on this line, what each publishes, where the line changed
 * directory, and what it wrote on the way.
 */
function scan(command) {
  const intents = [];
  const writes = [];
  let sawGh = false;
  let topGh = false;         // a `gh` outside every substitution, in the first reading
  let unreadGh = false;      // the text nested too deep to read mentions `gh`

  for (const [at, reading] of lineReadings(command).entries()) {
    let cwd = null;
    for (const { cmd, nested, tooDeep, text } of deepCommands(command, reading)) {
      if (tooDeep) {
        if (MENTIONS_GH.test(text)) { sawGh = true; unreadGh = true; }
        continue;
      }
      for (const write of cmd.writes) writes.push(write);

      const words = cmd.words;
      const program = base(words[0]?.value);
      if (program === 'cd' && words[1]) { if (!nested) cwd = words[1]; continue; }
      if (!GH_NAMES.has(program)) continue;

      sawGh = true;
      if (!nested && at === 0) topGh = true;
      const args = words.slice(1);
      const intent = args[0]?.value.toLowerCase() === 'api'
        ? apiIntent(args.slice(1), cmd)
        : subcommandIntent(args, cmd);
      if (intent) intents.push({ ...intent, cwd: cwd?.unsafe ? null : (cwd?.value ?? null), cwdUnknown: Boolean(cwd?.unsafe) });
    }
  }

  return { intents, writes, sawGh, topGh, unreadGh };
}

/**
 * What this shell line publishes to GitHub, or null when it publishes nothing.
 *
 * `body` is the text when it is written on the command line, `bodyFile` the
 * path when it comes from a file; both null means the command publishes a body
 * this module cannot see. `kind` says what is being published — `'pr-create'`,
 * `'pr-edit'`, `'issue-create'`, `'issue-edit'`, `'comment'`, `'review'`,
 * `'merge'`, `'release-notes'`, `'api'`, `'graphql'` — `maxChars` is the cap
 * that thing deserves, `source` where the body came from, and `cwd` the
 * directory a `cd` on the same line moved to, since a relative `bodyFile` is
 * relative to that and not to wherever the session started.
 *
 * `title`, `titleFile` and `titleSource` are the same three answers for the
 * title, and a null `titleSource` means this command sets none. `source` is
 * null in the mirror case: a `--title` with no `--body` still publishes.
 *
 * The first one, for a caller that wants to know what a line does.
 * `ghPublishProblems` looks at all of them.
 */
export function ghPublishIntent(command) {
  return scan(command).intents[0] ?? null;
}

/**
 * Whether this shell line calls `gh` at all — a different question from the
 * rest of this module, and one it could not answer before.
 *
 * Everything above gates on the prose a command publishes: it finds the body,
 * finds the title, and denies what it cannot read. A command that carries no
 * prose therefore carries nothing to look at, and `gh issue close 1274` walks
 * straight through `ghPublishProblems` — closing an issue is a write to GitHub,
 * but not one with a `--comment` on it.
 *
 * That is fine for a phase whose job is to publish something in English. It is
 * not fine for a phase whose job is to draft a proposal and touch nothing: for
 * that one the question is not "what does this publish?" but "does this reach
 * for `gh`, yes or no?", so the hook can deny the whole line without reading a
 * word of it.
 *
 * **This is a heuristic, not a guarantee, and it is worth being plain about it
 * because the name reads airtight.** It sees what `parse` sees, plus a regex
 * for the lines `parse` could not read. It does not see `echo 'gh issue close
 * 1' | sh`, `bash publish.sh`, `node -e '…'`, or `sh -c "$CMD"` whose argument
 * only exists at run time. Nothing that reads a command line can see those. The
 * guarantee is structural: don't give that session the Bash tool at all
 * (`runClaude` takes `tools`). This is the belt; the braces belong to whoever
 * wires the phase up.
 *
 * It errs the cheap way. An unparseable line that mentions `gh` counts as true,
 * the same doctrine `ghPublishProblems` follows — unread is not harmless — and
 * so does a `gh` sitting inside a string nobody executes. In a phase that must
 * publish nothing, a denied `echo` costs one turn; a missed `gh` costs a write
 * to GitHub that nobody asked for.
 */
export function callsGh(command) {
  const line = String(command ?? '');
  if (!line.trim()) return false;
  try {
    if (scan(line).sawGh) return true;
  } catch { /* a line this module cannot read still gets the net below */ }
  return MENTIONS_GH.test(line);
}

// ---------------------------------------------------------------------------
// What an unattended session may do with `gh`: the reads, the prose, and nothing else
//
// Everything above judges the prose a command publishes. That is a filter with
// a blind spot the size of a verb: closing an issue publishes nothing, so there
// is no text to judge, so nothing is denied. `gh issue close 1274` goes through
// `ghPublishProblems` clean.
//
// **The question this half asks is not «what verb is this», it is «is there a
// person in this turn».** A chat is Edson with the board open, watching every
// call as it happens; if he asks a chat to close an issue, asking *is* the
// confirmation, and a gate in the way would be friction over a decision that
// was already made by the only person entitled to make it. The same holds one
// step later, for the session the board forks off that chat to run a plan he
// wrote and approved and is watching run. A pipeline phase is the other case:
// it runs alone, nobody sees the call, no prompt asks it to close anything, and
// the board closes issues from its own window with a person in front of it. So
// this is asked of the turns nobody is watching and not of the ones somebody
// is — `attended`, in `ghGateDenial` — and the message is written to a session
// nobody is watching.
//
// **The predicate it enforces is not «don't close issues».** That one cannot be
// expressed from a command line, and it is worth saying plainly: `fix.md`
// instructs every fix session to write «Closes #{{issueNumber}}» in its commit
// body, so the issue closes by itself the moment that branch reaches `main` —
// through a `git push` and a merge with no `gh` anywhere on the line. What *is*
// expressible is «this phase only reads from GitHub, and publishes prose
// through the paths the board documents», and that is what is written below.
//
// It is an allow-list, and it was a deny-list first. A list of forbidden verbs
// is allow-by-default, and the parser does not understand enough for that to be
// safe: `gh -R owner/repo issue close 1274` reads as no verb at all (the flag
// comes first), `gh api graphql -F query=@m.gql` hides the mutation in a file,
// and `gh issue list … | xargs -I{} gh issue close {}` puts the call where no
// command starts. All three were measured going straight through the deny-list.
// The list of reads is short and stable; the list of writes is neither, and
// cannot be — so the unknown shape, today's and next year's, lands on the deny
// side.
//
// The other direction is what keeps it honest. A phase reads with `gh` all the
// time, and `gh api` is the only way to reach some of what the board publishes
// prose through — `gh` has no verb for editing a comment you already posted.
// Denying those would cost far more than the hole they close, so the reads and
// those publish routes are on the allow-list, and what they publish is judged
// by the half above, as it always was.
//
// It raises the cost of the *accidental* path — a phase that concludes «this is
// resolved» and reaches for `gh issue close` because it looks like the obvious
// next step, which is the failure that will actually happen — and it does not
// stop anyone who sets out to go around it. The braces are `tools` without
// Bash (`runClaude` takes it), which is what `draftIssueClosing` now does.

/** Reading GitHub. The whole list, and it barely moves from one year to the next. */
const READ_VERBS = new Set([
  'issue view', 'issue list', 'issue status',
  'pr view', 'pr list', 'pr diff', 'pr checks', 'pr status',
  'run view', 'run list',
  'repo view', 'label list', 'auth status', 'release view', 'release list',
]);

/** Groups that are a read whatever the verb: `gh search issues|prs|code|commits`. */
const READ_GROUPS = new Set(['search']);

/**
 * The verbs `VERBS` carries that do something besides publish. The two closings
 * are there because both take a `--comment`; `pr merge` because it takes a
 * body — and merging is the one call on that list whose side effect is bigger
 * than the issue in hand. No phase is asked to merge its own PR.
 *
 * The two release verbs are here for that same reason, and they arrived late:
 * `gh release create v9.9.9 --notes "…"` reads as publishing prose, passed, and
 * cuts a public tag — a bigger act than closing the issue this whole half
 * exists to stop. `release edit` is the same verb one step later: `--draft=false`
 * publishes a release that was not published. No phase of this board cuts
 * releases (nothing under `server/prompts/` so much as says `gh release`), so
 * there is nothing on the allow side to weigh against them.
 */
const STATE_VERBS = new Set(['issue close', 'pr close', 'pr merge', 'release create', 'release edit']);

/**
 * Publishing prose. Deliberately the same list `VERBS` already carries, minus
 * the verbs above: the half of this module above exists to judge exactly these
 * calls, so a verb it never heard of is not one a phase needs, and the two
 * lists cannot drift apart.
 */
const PUBLISH_VERBS = new Set([...VERBS.keys()].filter((verb) => !STATE_VERBS.has(verb)));

/**
 * The only flags an `edit` or a `create` may carry: the prose the gate next
 * door reads, and the one that merely says which repository.
 *
 * `issue edit`, `pr edit`, `issue create` and `pr create` are on the allow-list
 * for one reason — they can carry a title and a body — and everything else the
 * same verb can do is a state change with a notification on the end of it. This
 * was a list of the state-changing flags instead, and a deny-list inside an
 * allowed verb is allow-by-default in the one place this file had said it would
 * never be. It leaked exactly as a deny-list does: `-m` and `-B`, the shorts of
 * `--milestone` and `--base`, which were on it under their long names;
 * `--remove-milestone`, `--type`, `--remove-type`, `--add-blocked-by`,
 * `--add-sub-issue`, `--parent`, `--remove-parent`, which nobody had thought
 * of; and `--assignee`, `--label`, `--milestone` and `--reviewer` on the two
 * `create`s, which the list never covered at all. Twelve, measured.
 *
 * Read the other way round it closes all of them at once, closes the ones `gh`
 * ships next year, and needs no maintenance: a flag this file has never heard
 * of is not prose, so it is denied. That is the argument the rest of this half
 * already makes for `READ_VERBS`, `PUBLISH_ROUTES` and `PUBLISH_MUTATIONS`.
 *
 * The cost of being wrong is one denied turn, and nothing under
 * `server/prompts/` asks a phase to create or edit an issue or a PR from the
 * command line — checked, not assumed — so there is nothing legitimate on the
 * other side of the trade.
 */
const PROSE_FLAGS = [
  '--title', '-t',
  '--body', '-b',
  '--body-file', '-F',
  '--repo', '-R',
];

/**
 * Whether every flag on this call is one of `PROSE_FLAGS`. Positional words —
 * the group, the verb, the issue number — are not flags and are skipped, and a
 * flag's value is skipped with it so a body that starts with a dash is not read
 * as a flag of its own.
 */
function onlyProseFlags(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].value.startsWith('-')) continue;
    const flag = takeFlag(args, i, PROSE_FLAGS);
    if (!flag) return false;
    i += flag.used - 1;
  }
  return true;
}

/**
 * The `gh api` routes a phase publishes prose through, and only those: posting
 * a comment or a review, and correcting one already posted. They are here
 * because `gh api` is how prose reaches them — `gh` has no verb for editing
 * your own comment — and because what they carry is a body, which the half
 * above this file reads and judges. Everything else `gh api` can do is a state
 * change with nobody watching, and the method matters as much as the route: see
 * `apiAllowed`, where a `DELETE` to one of these is denied before it is read.
 *
 * `GITHUB_PUBLISH_RULE` spells the `-X PATCH …/issues/comments/<id>` recipe out
 * to the one session that may publish, which is the chat and only the chat
 * (`prompts.js` says why: handing the publish rule to a phase would teach it
 * commands this gate denies it). `ghgate.test.mjs` still takes the commands out
 * of that rule and runs them past here — not because the rule reaches a phase,
 * but because the same shape is what the board documents, and a route this list
 * spells differently from the rule is a route one of the two has wrong.
 *
 * The ids are anchored to digits and the segment after them is what decides:
 * `…/issues/comments/123` is a remark of yours, `…/issues/1274` is the ticket
 * itself and is not on this list. That is the whole difference between fixing
 * your own comment and closing somebody's issue, and it is one segment wide.
 */
const PUBLISH_ROUTES = [
  /^repos\/[^/]+\/[^/]+\/issues\/comments\/\d+$/,
  /^repos\/[^/]+\/[^/]+\/pulls\/comments\/\d+$/,
  /^repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/,
  /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments$/,
  /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews$/,
  /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews\/\d+(?:\/events)?$/,
  // A reply hangs off the PR *and* the comment it answers: `…/pulls/7/comments/
  // 123/replies`. It was written `…/pulls/comments/123/replies`, which is not a
  // route GitHub has — so the entry allowed nothing and the real one was
  // denied. Nothing broke, because the board answers threads over GraphQL from
  // Node; a list whose only defence is being exact does not get to keep a
  // wrong line in it.
  /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments\/\d+\/replies$/,
];

/**
 * The GraphQL mutations that publish prose — the shape `github.js` itself uses,
 * which is the one an agent copies. Everything else a mutation can do is off
 * this list by construction.
 *
 * «The shape `github.js` uses» is where the list came from, not a copy of what
 * that file calls: `resolveReviewThread` (`github.js:703`) is one of its
 * mutations and is deliberately not here, because resolving a thread changes
 * state rather than publishing a word. A mutation of the board's own is not
 * thereby a mutation a phase may run.
 */
const PUBLISH_MUTATIONS = new Set([
  'addComment', 'updateIssueComment', 'minimizeComment', 'unminimizeComment',
  'addPullRequestReview', 'submitPullRequestReview', 'updatePullRequestReview',
  'addPullRequestReviewThread', 'addPullRequestReviewThreadReply',
  'addPullRequestReviewComment', 'updatePullRequestReviewComment',
]);

/** Words that are followed by `(` in a GraphQL document without naming a call. */
const GRAPHQL_KEYWORDS = new Set(['query', 'mutation', 'subscription', 'fragment', 'on']);

/**
 * The groups a `gh` found in the middle of a line has to be followed by to
 * count as a call. `xargs -I{} gh issue close {}` and `find … -exec gh issue
 * close {} \;` put the call inside somebody else's arguments, where no parser
 * sees a command starting. The list is what makes reading those safe: without
 * it, `grep gh notas.md` would be a `gh` call with an unknown verb, and denied.
 *
 * «Followed by» means the first word that is not a flag, which is what
 * `positionals` walks to: `xargs -I{} gh -R owner/repo issue close {}` is the
 * same call with `-R` in front of the group, and reading only the next word
 * missed it.
 */
const GH_GROUPS = new Set([
  'issue', 'pr', 'api', 'repo', 'release', 'label', 'run', 'search', 'auth', 'alias',
  'cache', 'workflow', 'gist', 'project', 'secret', 'variable', 'browse', 'status',
  'extension', 'config', 'codespace', 'org', 'ruleset', 'ssh-key', 'gpg-key', 'attestation',
]);

/** A `gh api` route as the API means it: no host, no query string, no edges. */
function normalizeRoute(route) {
  return String(route ?? '')
    .replace(/\\/g, '/')
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '')
    .split('?')[0]
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * The first `limit` words of a `gh` call that are not flags — its group, its
 * verb — with the flags before them skipped, and the value of a flag that takes
 * one skipped with it so `-R owner/repo` does not read as the group.
 *
 * One walker, two callers, on purpose: `callOf` reads the group *and* the verb
 * of a call that starts a command, and `stateChangeProblem` reads the group
 * alone of a `gh` it found inside somebody else's arguments. They were two
 * loops, and the second one only looked at the very next word — so
 * `xargs -I{} gh -R owner/repo issue close {}` was a flag away from being
 * invisible to it while `callOf` read it perfectly. Two holes already closed
 * separately, open again in combination. Measured.
 */
function positionals(args, limit) {
  const words = [];
  for (let i = 0; i < args.length && words.length < limit; i += 1) {
    const raw = args[i].value;
    if (raw.startsWith('-')) {
      if (GROUP_VALUE_FLAGS.has(raw)) i += 1;
      continue;
    }
    words.push(args[i]);
  }
  return words;
}

/**
 * The group and verb of a `gh` call, with the leading flags skipped. `verbOf`
 * gives up the moment `args[0]` is a flag, and `gh -R owner/repo issue close
 * 1274` is exactly that shape — a hole measured, not imagined. `unsafe` says
 * one of the two words came out of a variable, which here means «unknown», and
 * unknown is denied.
 */
function callOf(args) {
  const words = positionals(args, 2);
  return {
    group: words[0] ? words[0].value.toLowerCase() : null,
    verb: words[1] ? words[1].value.toLowerCase() : null,
    unsafe: Boolean(words[0]?.unsafe || words[1]?.unsafe),
  };
}

/** Whether a `gh api graphql` call is one a phase may run. `parts` from `apiParts`. */
function graphqlAllowed({ fields, seen }) {
  // A query nobody here can read is not a query nobody should worry about:
  // `-F query=@mutacion.gql` and `--input` are both ways of handing over a
  // mutation with nothing on the line to see.
  if (seen) return false;
  if (fields.some((f) => f.unsafe || f.file || f.value.startsWith('@'))) return false;

  const text = fields.map((f) => f.value).join('\n');
  if (!/\bmutation\b/.test(text)) return true;   // a read, whatever it asks for

  const calls = [...text.matchAll(/([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]);
  return calls.every((name) => GRAPHQL_KEYWORDS.has(name) || PUBLISH_MUTATIONS.has(name));
}

/** Whether a `gh api` call is one a phase may run. `words` starts after `api`. */
function apiAllowed(words) {
  const parts = apiParts(words);

  if (base(parts.route) === 'graphql') return graphqlAllowed(parts);

  // A read: no method but a GET, and nothing to send. `gh` switches to POST the
  // moment the line carries a field, so «no `-X`» does not mean «a read».
  if ((parts.method ?? 'GET') === 'GET' && !parts.fields.length && !parts.seen) return true;

  // A write, then — and the method decides before the route does. The routes
  // below are on the list for the prose they carry, which is a `POST`, a
  // `PATCH` or a `PUT`; a `DELETE` to the very same route publishes nothing and
  // removes a comment, which is a state change like any other. Reading it off
  // the route alone let all three of `DELETE …/issues/comments/<id>`,
  // `DELETE …/pulls/comments/<id>` and `DELETE …/pulls/<n>/reviews/<id>`
  // through, measured — and the gate next door never saw them either, because
  // `apiIntent` reads no body off a method it does not count as a write. So the
  // method is checked here, with `gh`'s own default (`POST` once the line
  // carries a field) for the line that does not say one.
  if (!WRITE_METHODS.has(parts.method ?? 'POST')) return false;

  // And only when the route can be read at all.
  if (parts.routeUnsafe) return false;
  return PUBLISH_ROUTES.some((shape) => shape.test(normalizeRoute(parts.route)));
}

/** Whether this `gh` call is one a phase may run. `args` starts after `gh`. */
function ghCallAllowed(args) {
  const { group, verb, unsafe } = callOf(args);

  // `gh` with nothing but flags — `gh --version`, `gh --help` — asks GitHub for
  // nothing at all.
  if (group === null) return true;
  if (unsafe) return false;
  if (group === 'api') {
    const at = args.findIndex((w) => w.value.toLowerCase() === 'api');
    return apiAllowed(args.slice(at + 1));
  }
  if (READ_GROUPS.has(group)) return true;

  const call = `${group} ${verb}`;
  if (READ_VERBS.has(call)) return true;
  if (!PUBLISH_VERBS.has(call)) return false;

  // The two verbs that publish prose and can also do something else with the
  // same breath: `gh issue edit --add-label` relabels, `gh pr create --reviewer`
  // summons somebody, and the prose gate next door only ever reads a title and
  // a body. So they pass only while every flag on the line is prose.
  if (verb === 'edit' || verb === 'create') return onlyProseFlags(args);
  return true;
}

/**
 * The deny an unattended phase gets back. One text for every shape, and that is
 * the point.
 *
 * It says what the phase may do instead, and never how the line was read:
 * naming the field, the flag or the route that gave it away is a map of where
 * the gate does not look, and listing three denied spellings closes three and
 * advertises that there is a fourth. The precedent is next door —
 * `ghGateMessage` teaches `--body-file`, which is precisely the shape that
 * makes a body readable — so this one teaches the way *out* of GitHub instead:
 * say it, and stop. A message that only forbids leaves a model hunting for the
 * spelling that works.
 *
 * It used to close with «y ahí se acaba tu parte», and that sentence was
 * written for one phase and delivered to all of them: a `fix` session that
 * reached for `gh issue close` got told to end its turn with the fix half
 * done. What is left says what to do with *this* command — don't run it, write
 * the reason down — and leaves the turn where it was. The phase it was written
 * for no longer needs the sentence at all: `draftIssueClosing` hands its
 * session no Bash, so this text has no way of reaching it.
 */
const READ_ONLY_DENIAL =
  'Este comando no se ejecuta. En una fase del tablero `gh` sirve para LEER de GitHub —el issue, sus'
  + ' comentarios, el PR, sus checks— y para publicar prosa en inglés; nada más. Cambiar el estado o las'
  + ' etiquetas de un issue o de un PR no lo decide una fase que corre sola: lo publica el tablero desde su'
  + ' ventana de confirmación, con una persona delante que lo aprueba.'
  + ' Si has concluido que esto ya no necesita cambios, no lo ejecutes: dilo en tu respuesta final, con el'
  + ' motivo en una frase, y sigue con el resto de tu trabajo. Esa respuesta la lee una persona.';

/**
 * Why this command must not run in an **unattended phase**, because of what it
 * does to GitHub as opposed to what it publishes. In Spanish, ready to hand to
 * an agent as the reason of a `deny`. Null when every `gh` call on the line is
 * one a phase may make: a read, or the publishing of prose the gate above then
 * judges.
 *
 * The caller decides who is asking — `ghGateDenial` does not ask this of the
 * chat, where a person is watching every call and asking for a close *is* the
 * confirmation. Everything here is written for the other case.
 *
 * Synchronous and self-contained on purpose: it reads nothing off disk and
 * needs no injection, so the hook can ask it before anything expensive.
 *
 * **It denies by default.** Anything that is not on the allow-list is denied,
 * including every verb, route and mutation nobody thought of — which is the
 * whole reason it is written this way round, and why an unfamiliar denial is a
 * list to extend rather than a bug. The lists are `READ_VERBS`, `READ_GROUPS`,
 * `PUBLISH_VERBS` (which is `VERBS` minus `STATE_VERBS`), `PROSE_FLAGS`,
 * `PUBLISH_ROUTES` and `PUBLISH_MUTATIONS`. Every one of them reads the same
 * way round, including the flags of an `edit` or a `create`, which were the
 * last deny-list left in here and leaked twelve spellings before they were
 * turned over.
 *
 * **What it does with a line it cannot read**: the unknown is denied, exactly
 * like the unknown verb — a `gh` call whose group or verb comes out of a
 * variable, a write whose route does, a GraphQL document handed over in a file.
 * What it cannot deny is a line where no `gh` call is visible at all:
 * `echo 'gh issue close 1' | sh`, `bash cerrar.sh`, `sh -c "$CMD"`. Nothing
 * that reads a command line can see those, and denying every line that merely
 * mentions `gh` would take the reads down with them. That gap is the one
 * `callsGh` documents, and it closes the same way: don't give that session the
 * Bash tool.
 */
export function stateChangeProblem(command) {
  const line = String(command ?? '');
  if (!line.trim()) return null;

  try {
    // Every level: `echo $(gh issue close 1)` runs the `gh` in the substitution.
    for (const reading of lineReadings(line)) {
      for (const { cmd, tooDeep, text } of deepCommands(line, reading)) {
        // Unread deep text: judged by the net, the commands read so far stand.
        if (tooDeep) { if (MENTIONS_GH.test(text)) return READ_ONLY_DENIAL; continue; }
        // The call is usually the command, and sometimes an argument of one:
        // `xargs -I{} gh issue close {}` runs `gh` without ever starting with it.
        const at = cmd.words.findIndex((w, i) => GH_NAMES.has(base(w.value))
          && (i === 0 || GH_GROUPS.has(positionals(cmd.words.slice(i + 1), 1)[0]?.value.toLowerCase() ?? '')));
        if (at < 0) continue;
        if (!ghCallAllowed(cmd.words.slice(at + 1))) return READ_ONLY_DENIAL;
      }
    }
  } catch {
    // A throw in here is a bug, not a command. Denying a line that reaches for
    // `gh` costs the phase one turn; passing it costs a write nobody asked for.
    return MENTIONS_GH.test(line) ? READ_ONLY_DENIAL : null;
  }
  return null;
}

/** Every string under `key`, however deep. A review posts bodies by the batch. */
function under(value, key, out = []) {
  if (Array.isArray(value)) { for (const item of value) under(item, key, out); return out; }
  if (value && typeof value === 'object') {
    for (const [name, item] of Object.entries(value)) {
      if (name === key && typeof item === 'string') out.push(item);
      else under(item, key, out);
    }
  }
  return out;
}

/**
 * A JSON payload's prose. Parsing also undoes the `é` escapes a model
 * writes into JSON, which the filter would otherwise never see as an accent.
 */
function unwrap(text, kind) {
  if (kind !== 'api' && kind !== 'graphql') return text;
  try {
    const found = under(JSON.parse(text), 'body');
    if (found.length) return found.join('\n\n');
  } catch { /* not JSON: a `-F body=@x.md` file is markdown, and that is the body */ }
  return text;
}

/**
 * The title inside a `--input` payload, or null when it carries none. Falling
 * back to the whole document the way `unwrap` does would be wrong here: the
 * body check already reads that text, and handing it to a 256-character cap
 * would deny every review payload for being long.
 */
function payloadTitle(text) {
  try {
    const found = under(JSON.parse(text), 'title');
    return found.length ? found.join('\n\n') : null;
  } catch { return null; }
}

const UNREADABLE = {
  heredoc: 'llega por un heredoc, que el tablero no ve',
  stdin: 'llega por la entrada estándar',
  expansion: 'sale de una variable o de una sustitución de comandos',
  fill: 'lo rellena `gh` con los mensajes de commit, que no están en esta línea',
};

/** A path as this line means it: relative to the `cd` that came before the call. */
function resolve(file, intent) {
  if (!file || STDIN_PATHS.has(file)) return file;
  if (!intent.cwd) return file;
  if (/^(?:[A-Za-z]:[\\/]|[\\/]|~)/.test(file)) return file;
  return `${intent.cwd.replace(/[\\/]+$/, '')}/${file}`;
}

const sameFile = (a, b) => String(a).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
  === String(b).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

/**
 * The pieces of prose one call publishes: the title first, because that is the
 * order they are read in. A piece with no `source` is one this command does
 * not set — `gh issue create --title "…"` has a title and no body, and
 * `gh pr comment --body "…"` the other way round.
 */
function pieces(intent) {
  const out = [];
  if (intent.titleSource) {
    out.push({
      key: 'title',
      what: 'el título',
      text: intent.title,
      file: intent.titleFile,
      source: intent.titleSource,
      json: Boolean(intent.titleJson),
      maxChars: PR_TITLE_MAX,
    });
  }
  if (intent.source) {
    out.push({
      key: 'body',
      what: 'el cuerpo',
      text: intent.body,
      file: intent.bodyFile,
      source: intent.source,
      json: false,
      maxChars: intent.maxChars,
    });
  }
  return out;
}

/** Why one piece of one call must not go out. */
async function pieceProblems(intent, piece, writes, readFile) {
  const path = resolve(piece.file, intent);

  // Written and published on the same line: whatever is on disk now is not
  // what goes out, so reading it would check the wrong text.
  if (path && !STDIN_PATHS.has(path) && writes.some((w) => sameFile(w.value, path) || sameFile(w.value, piece.file))) {
    return [`\`gh ${intent.verb}\` publica ${piece.what} desde \`${piece.file}\`, y esta misma línea escribe ese`
      + ' fichero antes: lo que el tablero leería no es lo que se publicaría'];
  }
  if (piece.file && intent.cwdUnknown && !/^(?:[A-Za-z]:[\\/]|[\\/]|~)/.test(piece.file)) {
    return [`\`gh ${intent.verb}\` publica ${piece.what} desde \`${piece.file}\`, y la línea cambia de directorio a un`
      + ' sitio que sólo sabe el shell: el tablero no puede saber qué fichero se publicaría'];
  }

  let text = piece.text;
  if (text === null && piece.source === 'file') {
    let raw = null;
    try {
      raw = typeof readFile === 'function' ? await readFile(path) : null;
    } catch { raw = null; }
    if (raw === null || raw === undefined) {
      return [`\`gh ${intent.verb}\` publica ${piece.what} desde \`${path}\`, y el tablero no ha podido leerlo:`
        + ' no se puede comprobar que ese texto esté en inglés'];
    }
    if (piece.json) {
      // A payload with no `title` key sets no title. Nothing to deny.
      text = payloadTitle(String(raw));
      if (text === null) return [];
    } else {
      text = piece.key === 'body' ? unwrap(String(raw), intent.kind) : String(raw);
    }
  }

  if (text === null) {
    const why = UNREADABLE[piece.source] ?? 'no se puede leer desde la línea de comando';
    return [`\`gh ${intent.verb}\` publica en GitHub y ${piece.what} ${why}: no se puede comprobar que esté en inglés`];
  }

  // A GraphQL mutation is raw source: the body being published is itself a
  // quoted string inside it, so quotes must not be treated as quotations.
  return publishProblems(text, {
    ...(piece.maxChars ? { maxChars: piece.maxChars } : {}),
    ...(intent.kind === 'graphql' ? { keepQuotes: true } : {}),
  });
}

/**
 * Why one call must not run. A command that publishes a title and a body is
 * checked on both and reports both: the agent has one turn to fix whatever is
 * wrong, and learning about the second failure on the next try wastes it.
 */
async function intentProblems(intent, writes, readFile) {
  const found = [];
  for (const piece of pieces(intent)) found.push([piece, await pieceProblems(intent, piece, writes, readFile)]);

  // Naming the piece matters where the reader could guess wrong: a title
  // always, because the reader assumes the body; the body only when the title
  // failed as well. The structural reasons already name it in their own
  // sentence, so they are left alone.
  const both = found.filter(([, list]) => list.length).length > 1;
  const problems = [];
  for (const [piece, list] of found) {
    const name = both || piece.key === 'title' ? `${piece.what}: ` : '';
    for (const problem of list) problems.push(problem.startsWith('`gh ') ? problem : `${name}${problem}`);
  }
  return problems;
}

const UNREADABLE_LINE = 'la línea llama a `gh` y el tablero no ha sabido leerla, así que no puede comprobar'
  + ' qué se publicaría: escríbela como un solo comando `gh`, sin envoltorios';

/**
 * Why this command must not run, in Spanish. Empty means it publishes nothing,
 * or that everything it publishes passes the language gate.
 *
 * `readFile` is injected — `(path) => string | null` — so this stays pure and
 * the caller decides what a path means on the machine the session runs on.
 */
export async function ghPublishProblems(command, { readFile } = {}) {
  let scanned;
  try {
    scanned = scan(command);
  } catch {
    // Nested too deep to read. The hook around the gate lets a throw through, so
    // a line that reaches for `gh` is refused here instead.
    return MENTIONS_GH.test(String(command ?? '')) ? [UNREADABLE_LINE] : [];
  }
  const { intents, writes, topGh, unreadGh } = scanned;

  // A line that plainly calls `gh` only from inside a substitution is not a line
  // to wave through on the strength of what is read there: it has always been
  // refused, and reading the nested call adds verdicts instead of replacing this one.
  const buried = unreadGh || (!topGh && LOOKS_LIKE_GH.test(String(command ?? '')));
  if (!intents.length) return buried ? [UNREADABLE_LINE] : [];

  const problems = buried ? [UNREADABLE_LINE] : [];
  for (const intent of intents) {
    const found = await intentProblems(intent, writes, readFile);
    // With one call the reasons speak for themselves; with several, say which
    // one each belongs to.
    for (const problem of found) problems.push(intents.length > 1 ? `\`gh ${intent.verb}\`: ${problem}` : problem);
  }
  return [...new Set(problems)];
}

/** The `deny` an agent gets back, with the way out. */
export function ghGateMessage(problems) {
  const list = Array.isArray(problems) ? problems : [problems];
  return `Este comando no se ejecuta: ${list.join('; ')}.`
    + ' Todo lo que se publica en GitHub —comentarios, reviews, títulos y cuerpos de PR— va SIEMPRE en inglés,'
    + ' y el tablero tiene que poder leerlo antes de que salga.'
    + ' Reescribe el texto en inglés y vuelve a intentarlo.'
    + ' Si el cuerpo no te cabe en la línea de comando, o lleva comillas o saltos de línea,'
    + ' **escríbelo en un fichero con la herramienta Write** y pásalo con `--body-file <fichero>`'
    + ' (en `gh api`, `-F body=@<fichero>`): así se lee y se comprueba.'
    + ' Nada de heredocs, tuberías ni `$(...)` para el cuerpo, y no escribas ese fichero en la misma'
    + ' línea que lo publica: por ahí el tablero no ve lo que va a salir y no puede dejarlo pasar.';
}
