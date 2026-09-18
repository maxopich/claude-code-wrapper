/**
 * `Cebab-ibb4`: one glance-width line naming what the agent is doing RIGHT NOW.
 *
 * The chat's thinking indicator has always had the tool's NAME ("running
 * Bash…"), which is the half that carries no information — of course it is
 * running Bash, it is always running Bash. What the operator wants is the
 * SUBJECT: which file, which command, which pattern. That is the whole
 * difference between a spinner and a status line, and it is what makes hiding
 * the finished steps survivable.
 *
 * WHY THIS IS NOT `classifyToolCall`, which switches over the same tool names
 * in `shared/src/mutation.ts`. That function answers a different question — how
 * risky is this call, and which file does it write — and its `summary` is
 * EVIDENCE FOR AN APPROVAL DECISION, so it is deliberately verbose: absolute
 * paths, byte counts, 200 characters of shell command, the model's own
 * description in parentheses. Three of its arms are actively wrong for a status
 * line, and the worst is the one that matters most to an operator with MCP
 * servers installed: every `mcp__*` tool falls to its `default` arm and comes
 * back as `mcp__x__y: {"path":"/Users/…` — a JSON peek, in the single place a
 * plain "Calling search (linear)" was wanted.
 *
 * So this is a DISPLAY map, not a second opinion about any tool. There is no
 * judgement here the two could disagree about: no category, no risk, no file
 * path anyone acts on. An unknown tool degrades to "Running <name>" rather than
 * to a wrong answer, which is why the table not knowing about a future tool
 * costs a little specificity and nothing else.
 */

/** A verb phrase and, when the tool has one worth naming, its subject. Kept as
 *  two fields rather than one string so the row can weight them differently —
 *  the verb is chrome, the subject is the information. */
export type ToolActivity = {
  verb: string;
  subject?: string;
};

/**
 * Longest subject we will render. The row is one line in a chat column, and a
 * subject is a path, a pattern or a shell command — all three can be arbitrarily
 * long, and all three carry their identity at one END or the other.
 */
const MAX_SUBJECT = 52;

/**
 * Flatten anything that could break out of a single line.
 *
 * The character class is the one `quoteFlat` uses in
 * `server/src/runner/mcp_status_note.ts`, for the same reason and against the
 * same input: tool inputs are MODEL-WRITTEN text. `\p{Cc}` catches the literal
 * newline; `\p{Cf}` catches the invisibles that are not whitespace and survive
 * every naive escape — U+2028, and the bidi overrides (U+202E) that would
 * reverse the rest of the line's reading order.
 *
 * It is a separate function from `quoteFlat` rather than a shared one because
 * the outputs are not interchangeable: that one produces a JSON-quoted token
 * for a system prompt and clips at prompt scale, this one produces a bare label
 * for a DOM text node and clips at column width. Sharing them would mean one
 * caller stripping quotes off the other's answer. What they genuinely share is
 * the character class, and that is one line — `Cebab-1mdl` tracks giving it a
 * single home in `shared/`.
 */
function flatten(raw: string): string {
  return raw.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim();
}

/** Clip keeping the HEAD — right for commands and patterns, which say what they
 *  are in their first few words. */
function clipHead(raw: string, max = MAX_SUBJECT): string {
  const flat = flatten(raw);
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The tail of a path, which is where its identity lives.
 *
 * Clipping a path from the HEAD would produce `/Users/maksym/Claude_Spa…` for
 * every file in the project — the same label for all of them, which is the one
 * outcome a status line cannot have. So segments are taken from the end: up to
 * three, then dropped from the front until the result fits.
 *
 * Three rather than two because two is not enough to tell this repo's own
 * packages apart — `web/src/store.ts` and `server/src/store.ts` both end
 * `src/store.ts`. Three is still not a guarantee of uniqueness and is not meant
 * to be one: this is a glance-width label, and the expanded turn carries the
 * full input verbatim.
 */
const MAX_PATH_SEGMENTS = 3;

function pathTail(raw: string, max = MAX_SUBJECT): string {
  // Flatten BEFORE splitting: a newline inside a path must not be able to
  // manufacture a segment boundary that the input did not have.
  const flat = flatten(raw);
  if (flat === '') return '';
  const segments = flat.split(/[/\\]/).filter((s) => s !== '');
  if (segments.length === 0) return flat;

  const tail = segments.slice(-MAX_PATH_SEGMENTS);
  while (tail.length > 1 && tail.join('/').length > max) tail.shift();
  const joined = tail.join('/');
  if (joined.length <= max) return joined;
  // Even the basename is too long: keep its END, which is where an extension
  // and a disambiguating suffix live.
  return `…${joined.slice(joined.length - (max - 1))}`;
}

function str(input: unknown, field: string): string | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const v = (input as Record<string, unknown>)[field];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** `mcp__<prefix>__<tool>` split at the SECOND separator — a tool name may
 *  contain `__` of its own, a server prefix may not (the CLI builds it by
 *  replacing every character outside `[A-Za-z0-9_]`, see `mcpToolPrefix`). */
function mcpParts(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep <= 0) return null;
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

/** The host a URL points at, which is the part of it worth a glance. Falls back
 *  to a head-clip of the raw string when the model sent something unparseable —
 *  a status line never throws. */
function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return clipHead(url, 32);
  }
}

export function toolActivity(name: string, input: unknown): ToolActivity {
  // A caller that has a phase but no tool name — the multi-agent activity bar
  // reads its tool from a bus event that may not carry one. Naming nothing is
  // better than naming the empty string.
  if (name === '') return { verb: 'running a tool' };

  const file = (field: string) => {
    const p = str(input, field);
    return p === undefined ? {} : { subject: pathTail(p) };
  };

  switch (name) {
    case 'Read':
      return { verb: 'reading', ...file('file_path') };
    case 'Write':
      return { verb: 'writing', ...file('file_path') };
    case 'Edit':
    case 'MultiEdit':
      return { verb: 'editing', ...file('file_path') };
    case 'NotebookEdit':
      return { verb: 'editing', ...file('notebook_path') };

    case 'Bash': {
      // The command, not the model's `description`. The description is a
      // sentence written for an approval card ("List files in current
      // directory") and reads as filler next to a verb; the command is what the
      // operator would have typed, and its first line is what identifies it.
      const command = str(input, 'command');
      if (command !== undefined) return { verb: 'running', subject: clipHead(command) };
      const desc = str(input, 'description');
      return desc === undefined
        ? { verb: 'running a command' }
        : { verb: 'running', subject: clipHead(desc) };
    }
    case 'BashOutput':
      return { verb: 'reading shell output' };
    case 'KillShell':
      return { verb: 'stopping a shell' };

    case 'Grep': {
      const pattern = str(input, 'pattern');
      return pattern === undefined
        ? { verb: 'searching' }
        : { verb: 'searching for', subject: clipHead(pattern) };
    }
    case 'Glob': {
      const pattern = str(input, 'pattern');
      return pattern === undefined
        ? { verb: 'finding files' }
        : { verb: 'finding', subject: clipHead(pattern) };
    }

    case 'WebFetch': {
      const url = str(input, 'url');
      return url === undefined
        ? { verb: 'fetching a page' }
        : { verb: 'reading', subject: host(url) };
    }
    case 'WebSearch': {
      const query = str(input, 'query');
      return query === undefined
        ? { verb: 'searching the web' }
        : { verb: 'searching the web for', subject: clipHead(query) };
    }

    // `Agent` is the live sub-agent tool and `Task` the older CLI spelling —
    // both kept for the reason `classifyToolCall` keeps both.
    case 'Agent':
    case 'Task': {
      const what = str(input, 'description') ?? str(input, 'subagent_type');
      return what === undefined
        ? { verb: 'running a subagent' }
        : { verb: 'running a subagent', subject: clipHead(what, 40) };
    }

    case 'TodoWrite':
      return { verb: 'updating its task list' };
    case 'ExitPlanMode':
      return { verb: 'writing up a plan' };
    case 'SlashCommand': {
      const command = str(input, 'command');
      return command === undefined
        ? { verb: 'running a command' }
        : { verb: 'running', subject: clipHead(command) };
    }
    // Parked for the operator rather than executed, so the chat shows a card
    // and this line should never be the thing on screen. Named anyway: if the
    // ordering that guarantees the card ever regresses, "asking you a question"
    // is a far better tell than "Running AskUserQuestion".
    case 'AskUserQuestion':
      return { verb: 'asking you a question' };

    default: {
      const mcp = mcpParts(name);
      if (mcp)
        return { verb: `calling ${clipHead(mcp.tool, 32)}`, subject: clipHead(mcp.server, 24) };
      return { verb: 'running', subject: clipHead(name, 32) };
    }
  }
}

/** One string, for the places that cannot weight the two halves (aria labels,
 *  titles, tests). */
export function toolActivityText(a: ToolActivity): string {
  return a.subject === undefined ? a.verb : `${a.verb} ${a.subject}`;
}
