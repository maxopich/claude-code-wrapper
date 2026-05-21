/**
 * Tool-call mutation classifier (Item #5).
 *
 * Pure function over the SDK's tool-input schema. Returns:
 *   - `category`: `'read'` (safe), `'mutate'` (changes filesystem/VCS state),
 *     or `'dangerous'` (data loss, privilege escalation, or remote code
 *     execution potential).
 *   - `summary`: one-line operator-readable description for the UI.
 *
 * Consumed by:
 *   - Server's single-agent `canUseTool` ([`server/src/ws/server.ts`]) — enriches
 *     the `permission_request` ServerMsg so the React card can pick the right
 *     subcomponent + badge color without re-classifying client-side.
 *   - Bus runner stream tap ([`server/src/bus/runner.ts`]) — classifies every
 *     `tool_use` block on assistant messages and (a) persists non-`read`
 *     calls into `multi_agent_mutations`, (b) optionally pauses the worker
 *     before the first mutation when `pause_on_mutation=1`.
 *
 * Design rules:
 *   - Pure: no I/O, no side effects, no clock reads. Same input → same output.
 *   - Unknown tool name → `mutate` (conservative). Better to ask once than miss
 *     a write that auto-allowed.
 *   - Bash sub-classifier: split on top-level `;`/`&&`/`||`/`|`, classify each
 *     piece by first token (after stripping env-var prefixes), reduce to worst.
 *     Unknown first token → `mutate`. Output redirection (`>`/`>>`) bumps any
 *     read to at least `mutate`. Shell substitution (`$(...)`, backticks) bumps
 *     to `dangerous` (we don't try to parse what's inside).
 */

export type MutationCategory = 'read' | 'mutate' | 'dangerous';

export type ToolClassification = {
  category: MutationCategory;
  summary: string;
  /**
   * Target file path for tools that write/edit a single file
   * (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`). Undefined for everything
   * else — including `Bash` (which may write to many files indirectly) and
   * `Read`-class tools (which target a file but don't mutate it). Surfaced
   * so the bus runner can persist it on the mutation row without re-parsing
   * the tool input, and so the artifact promotion classifier (Phase E) has
   * a single canonical field to glob against.
   */
  filePath?: string;
};

const CATEGORY_RANK: Record<MutationCategory, number> = {
  read: 0,
  mutate: 1,
  dangerous: 2,
};

function worse(a: MutationCategory, b: MutationCategory): MutationCategory {
  return CATEGORY_RANK[a] >= CATEGORY_RANK[b] ? a : b;
}

/**
 * Top-level dispatch. `toolName` is the SDK tool identifier
 * (`'Read'`, `'Bash'`, `'mcp__foo__bar'`, etc.); `input` is the tool's input
 * payload as JSON. Unknown tools default to `mutate` so the operator at least
 * sees a yellow badge.
 */
export function classifyToolCall(toolName: string, input: unknown): ToolClassification {
  const inp = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};

  switch (toolName) {
    case 'Read': {
      const path = stringField(inp, 'file_path') ?? '';
      const offset = numberField(inp, 'offset');
      const limit = numberField(inp, 'limit');
      const range =
        offset !== undefined || limit !== undefined
          ? ` [lines ${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : '+'}]`
          : '';
      return { category: 'read', summary: `read ${path}${range}` };
    }

    case 'Glob': {
      const pattern = stringField(inp, 'pattern') ?? '';
      const path = stringField(inp, 'path');
      return {
        category: 'read',
        summary: path ? `glob "${pattern}" in ${path}` : `glob "${pattern}"`,
      };
    }

    case 'Grep': {
      const pattern = stringField(inp, 'pattern') ?? '';
      const path = stringField(inp, 'path');
      return {
        category: 'read',
        summary: path ? `grep "${pattern}" in ${path}` : `grep "${pattern}"`,
      };
    }

    case 'WebFetch': {
      const url = stringField(inp, 'url') ?? '';
      return { category: 'read', summary: `fetch ${url}` };
    }

    case 'WebSearch': {
      const query = stringField(inp, 'query') ?? '';
      return { category: 'read', summary: `search "${query}"` };
    }

    case 'TodoWrite': {
      const todos = inp['todos'];
      const n = Array.isArray(todos) ? todos.length : 0;
      return { category: 'read', summary: `update ${n} todo${n === 1 ? '' : 's'}` };
    }

    case 'BashOutput':
    case 'KillShell':
      // Output reads / shell control — non-mutating from the operator's POV.
      return { category: 'read', summary: `${toolName}` };

    case 'Write': {
      const path = stringField(inp, 'file_path') ?? '';
      const content = stringField(inp, 'content') ?? '';
      const size = formatBytes(byteLength(content));
      return {
        category: 'mutate',
        summary: `create/overwrite ${path} (${size})`,
        ...(path ? { filePath: path } : {}),
      };
    }

    case 'Edit': {
      const path = stringField(inp, 'file_path') ?? '';
      const oldStr = stringField(inp, 'old_string') ?? '';
      const replaceAll = inp['replace_all'] === true;
      const snippet = previewSnippet(oldStr, 24);
      const verb = replaceAll
        ? `replace all "${snippet}"`
        : `replace ${oldStr.length} char${oldStr.length === 1 ? '' : 's'}`;
      return {
        category: 'mutate',
        summary: `${verb} in ${path}`,
        ...(path ? { filePath: path } : {}),
      };
    }

    case 'MultiEdit': {
      const path = stringField(inp, 'file_path') ?? '';
      const edits = inp['edits'];
      const n = Array.isArray(edits) ? edits.length : 0;
      return {
        category: 'mutate',
        summary: `apply ${n} edit${n === 1 ? '' : 's'} to ${path}`,
        ...(path ? { filePath: path } : {}),
      };
    }

    case 'NotebookEdit': {
      const path = stringField(inp, 'notebook_path') ?? '';
      const cell = stringField(inp, 'cell_id') ?? '';
      const mode = (stringField(inp, 'edit_mode') ?? 'replace').toLowerCase();
      return {
        category: 'mutate',
        summary: `edit ${cell ? `cell ${cell} in ` : ''}${path} (${mode})`,
        ...(path ? { filePath: path } : {}),
      };
    }

    case 'Bash': {
      const command = stringField(inp, 'command') ?? '';
      const desc = stringField(inp, 'description');
      const cls = classifyBashCommand(command);
      const truncated = command.length > 200 ? `${command.slice(0, 197)}...` : command;
      const suffix = desc ? ` (${truncateForDesc(desc)})` : '';
      return { category: cls.category, summary: `${truncated}${suffix}` };
    }

    case 'Agent':
    case 'Task': {
      const desc = stringField(inp, 'description') ?? stringField(inp, 'prompt') ?? '';
      const trimmed = previewSnippet(desc, 60);
      return { category: 'mutate', summary: `spawn agent "${trimmed}"` };
    }

    case 'bus_send': {
      // Cebab's in-process inter-agent message tool — touches no filesystem.
      const dest = stringField(inp, 'destination') ?? '';
      return { category: 'read', summary: `bus_send → ${dest}` };
    }

    default: {
      // Unknown tool — could be an MCP tool the operator has installed
      // (`mcp__foo__bar`) or a future SDK tool. Default safe: classify as
      // `mutate` so the operator sees a yellow badge rather than no signal.
      const inputPeek = JSON.stringify(input ?? {}).slice(0, 80);
      return { category: 'mutate', summary: `${toolName}: ${inputPeek}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Bash sub-classifier
// ---------------------------------------------------------------------------

/**
 * Dangerous Bash patterns — destructive, privilege-escalating, or remote-
 * code-executing. Matched as the first token (after env-var prefix stripping).
 * `kill -9` / `pkill` / `killall` are dangerous because they can knock out the
 * Cebab server itself if misdirected. Adding to this list is conservative — a
 * dangerous-classified read is one extra Allow click away.
 */
const DANGEROUS_FIRST_TOKENS: ReadonlySet<string> = new Set([
  'rm',
  'sudo',
  'dd',
  'mkfs',
  'pkill',
  'killall',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'eval',
  'exec',
  'source', // can run anything from a file
]);

/**
 * Mutating Bash patterns — modify filesystem, VCS state, packages, or
 * environment in a way that's not destructive on its own but should be
 * surfaced.
 */
const MUTATING_FIRST_TOKENS: ReadonlySet<string> = new Set([
  'mv',
  'cp',
  'mkdir',
  'touch',
  'ln',
  'rename',
  'chmod', // surfaced but not destructive on its own
  'chown',
  'tee',
  'patch',
  'tar',
  'unzip',
  'zip',
  'gunzip',
  'gzip',
  'curl', // downloads; can also be piped to sh — see redirection / pipe heuristics below
  'wget',
]);

/**
 * Read-only Bash patterns — pure queries / listings. Anything not in this set
 * defaults to `mutate` (conservative).
 */
const READONLY_FIRST_TOKENS: ReadonlySet<string> = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'pwd',
  'which',
  'whoami',
  'id',
  'date',
  'echo',
  'printf',
  'env',
  'set',
  'unset',
  'cd', // changing directory of a subshell has no persistent effect
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'xxd',
  'od',
  'file',
  'stat',
  'du',
  'df',
  'tree',
  'find', // sub-flags checked below (-delete / -exec → mutate)
  'grep',
  'rg',
  'ag',
  'sed', // sub-flags checked below (-i → mutate)
  'awk', // pure unless redirection
  'jq',
  'yq',
  'true',
  'false',
  'sleep',
  'test',
  '[',
  'expr',
  'basename',
  'dirname',
  'readlink',
  'realpath',
  'ps',
  'top',
  'history',
  'uptime',
  'hostname',
  'uname',
  'arch',
]);

/** Subcommand allowlist for known multi-token tools. Keys are first-token,
 *  values are the subcommands considered read-only. Anything else under that
 *  first token classifies via the parent rules (mutating-by-default). */
const READONLY_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  git: new Set([
    'status',
    'log',
    'diff',
    'show',
    'branch',
    'remote',
    'tag',
    'ls-files',
    'ls-tree',
    'rev-parse',
    'rev-list',
    'blame',
    'config', // typically read-only unless --set / --unset; we treat plain 'git config' as read
    'help',
    'describe',
    'cat-file',
    'shortlog',
  ]),
  npm: new Set(['ls', 'view', 'list', 'outdated', 'audit', 'doctor', 'config', 'help']),
  cargo: new Set(['tree', 'metadata', 'help']),
  docker: new Set(['ps', 'images', 'inspect', 'logs', 'top', 'stats', 'version', 'info', 'help']),
  python: new Set([]),
  python3: new Set([]),
  node: new Set([]),
};

/** Dangerous subcommand patterns: when the first two tokens together imply
 *  destruction beyond what the first token alone would. Matched as exact
 *  `firstToken subToken` pairs. */
const DANGEROUS_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'git push --force',
  'git push --force-with-lease',
  'git reset --hard',
  'git clean -fd',
  'git clean -fdx',
  'git filter-branch',
  'git filter-repo',
  'npm publish',
  'npm install -g',
  'npm i -g',
  'pip install --user',
  'pip3 install --user',
  'docker system prune',
  'docker volume prune',
  'docker container prune',
  'docker image prune',
  'docker network prune',
  'docker rm',
  'docker rmi',
]);

/**
 * Classify a single Bash command string. Exported for direct unit testing.
 *
 * The classification scans every top-level subcommand (split on `;`, `&&`,
 * `||`, `|`) and reduces to the worst category. Subshell-substitution
 * sequences (`$(...)`, backticks) are flagged as `dangerous` because their
 * contents could be anything.
 */
export function classifyBashCommand(command: string): ToolClassification {
  const trimmed = command.trim();
  if (!trimmed) return { category: 'mutate', summary: '' };

  // Shell-substitution: don't try to parse what's inside; mark dangerous.
  if (/(?<![\\$])\$\(/.test(trimmed) || /`/.test(trimmed)) {
    return { category: 'dangerous', summary: trimmed };
  }

  // Process-substitution: `<(curl ...)` etc. — also unparseable; dangerous.
  if (/<\(|>\(/.test(trimmed)) {
    return { category: 'dangerous', summary: trimmed };
  }

  let worst: MutationCategory = 'read';
  for (const piece of splitTopLevel(trimmed)) {
    const pieceCls = classifyBashPiece(piece);
    worst = worse(worst, pieceCls);
    if (worst === 'dangerous') break;
  }

  return { category: worst, summary: trimmed };
}

/** Classify one segment of a compound Bash command. */
function classifyBashPiece(piece: string): MutationCategory {
  const stripped = stripEnvAssignments(piece.trim());
  if (!stripped) return 'read';

  // Output redirection (`> file`, `>> file`) — at least `mutate`; targets to
  // sensitive system paths → `dangerous`.
  const redirMatch = /(?:^|\s)>>?\s*(\S+)/.exec(stripped);
  if (redirMatch) {
    const target = redirMatch[1] ?? '';
    if (
      target.startsWith('/etc/') ||
      target.startsWith('/usr/') ||
      target.startsWith('/var/') ||
      target.startsWith('/boot/') ||
      target.startsWith('/dev/') ||
      target.startsWith('/sys/') ||
      target.startsWith('/proc/') ||
      target === '/dev/sda' || // catch literal
      /^~\/\.ssh\b/.test(target) ||
      /^~\/\.aws\b/.test(target) ||
      /^~\/\.kube\b/.test(target)
    ) {
      return 'dangerous';
    }
    // Any other redirect target → mutate (at least).
    return worseOrSelf(classifyByTokens(stripped), 'mutate');
  }

  return classifyByTokens(stripped);
}

function classifyByTokens(stripped: string): MutationCategory {
  const tokens = stripped.split(/\s+/);
  const first = tokens[0] ?? '';
  const second = tokens[1] ?? '';
  const pair = second ? `${first} ${second}` : first;
  const triple = tokens[2] ? `${first} ${second} ${tokens[2]}` : pair;

  // 1) Universal version/help check: `<anything> --version` / `-V` /
  //    `--help` is always a query, no matter the binary. Cheap escape
  //    hatch so `node --version` doesn't fall through to the `mutate`
  //    default just because `node` isn't in any positive list. We deliberately
  //    omit `-h` and the bare `help` subtoken — those are overloaded
  //    (`shutdown -h`, `git help` is genuinely help but `npm help <cmd>` opens
  //    docs which is fine to default to mutate via a positive-list miss).
  if (second === '--version' || second === '-V' || second === '--help') {
    return 'read';
  }

  // 2) Exact dangerous-subcommand match.
  if (DANGEROUS_SUBCOMMANDS.has(triple) || DANGEROUS_SUBCOMMANDS.has(pair)) {
    return 'dangerous';
  }

  // 3) Plain `rm` (any args) is dangerous.
  if (DANGEROUS_FIRST_TOKENS.has(first)) {
    return 'dangerous';
  }

  // 4) `mkfs*` (mkfs.ext4, mkfs.xfs, etc.) — any filesystem-create variant.
  if (first.startsWith('mkfs.') || first === 'mkfs') {
    return 'dangerous';
  }

  // 5) Shell invocation (`sh`, `bash`, `zsh`):
  //    - bare `sh` with no args: typically the receiving end of a pipe
  //      (`curl | sh`). Dangerous.
  //    - `bash -c '<arbitrary>'`: arbitrary code. Dangerous.
  //    - `bash script.sh`: running a script. We can't introspect — mutate
  //      (operator sees the script path and decides).
  if (first === 'sh' || first === 'bash' || first === 'zsh') {
    if (tokens.length === 1) return 'dangerous';
    if (second === '-c') return 'dangerous';
    return 'mutate';
  }

  // 6) `kill` with `-9` / `-KILL` is dangerous; plain `kill` is mutate.
  if (first === 'kill') {
    return tokens.includes('-9') || tokens.includes('-KILL') ? 'dangerous' : 'mutate';
  }

  // 7) Subcommand-aware read-only check (git/npm/docker/cargo/...).
  const subAllow = READONLY_SUBCOMMANDS[first];
  if (subAllow) {
    if (second && subAllow.has(second)) return 'read';
    // Other subcommands of `git`/`npm`/`docker`/etc. → mutate (default).
    return 'mutate';
  }

  // 8) Plain read-only allowlist.
  if (READONLY_FIRST_TOKENS.has(first)) {
    // `find` with `-delete` / `-exec` flags is mutating.
    if (first === 'find' && (tokens.includes('-delete') || tokens.includes('-exec'))) {
      return 'mutate';
    }
    // `sed -i` is in-place edit → mutate.
    if (first === 'sed' && tokens.includes('-i')) {
      return 'mutate';
    }
    return 'read';
  }

  // 9) Mutating allowlist.
  if (MUTATING_FIRST_TOKENS.has(first)) {
    // `chmod` / `chown` on system paths → dangerous.
    if ((first === 'chmod' || first === 'chown') && hasSystemPath(tokens)) {
      return 'dangerous';
    }
    return 'mutate';
  }

  // 10) Anything else (unknown first token) defaults to mutate. The operator
  //     sees a yellow badge and the command verbatim and decides.
  return 'mutate';
}

function hasSystemPath(tokens: string[]): boolean {
  return tokens.some(
    (t) =>
      t === '/' ||
      t.startsWith('/etc/') ||
      t.startsWith('/usr/') ||
      t.startsWith('/var/') ||
      t.startsWith('/boot/') ||
      t.startsWith('/dev/') ||
      t.startsWith('/sys/') ||
      t.startsWith('/proc/'),
  );
}

/**
 * Strip leading env-var assignments (`FOO=bar BAZ=qux <cmd>`). Returns the
 * substring starting at the first real command token. If the string IS just
 * env-var assignments (no command), returns ''.
 */
function stripEnvAssignments(piece: string): string {
  let rest = piece;
  while (true) {
    const m = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+/.exec(rest);
    if (!m) break;
    rest = rest.slice(m[0].length);
  }
  return rest.trim();
}

/**
 * Split a Bash command on top-level `;`, `&&`, `||`, `|` boundaries. Does NOT
 * try to be fully shell-correct — single quotes, double quotes, and escaped
 * characters are roughly handled; heredocs, $(...) and backticks are caught
 * by the caller before this runs.
 */
function splitTopLevel(command: string): string[] {
  const pieces: string[] = [];
  let buf = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;

  while (i < command.length) {
    const ch = command[i];
    const next = command[i + 1];

    if (ch === '\\' && i + 1 < command.length) {
      buf += ch + (next ?? '');
      i += 2;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      buf += ch;
      i += 1;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (ch === ';') {
        if (buf.trim()) pieces.push(buf);
        buf = '';
        i += 1;
        continue;
      }
      if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
        if (buf.trim()) pieces.push(buf);
        buf = '';
        i += 2;
        continue;
      }
      if (ch === '|') {
        if (buf.trim()) pieces.push(buf);
        buf = '';
        i += 1;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  if (buf.trim()) pieces.push(buf);
  return pieces;
}

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

function stringField(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' ? v : undefined;
}

function numberField(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 2 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 2 : 1)} MB`;
}

function byteLength(s: string): number {
  // Approximate UTF-8 byte length without depending on Buffer (so the module
  // stays browser-safe). The TextEncoder branch handles real multi-byte; the
  // fallback is a count of code units (good enough for the size badge).
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(s).length;
  }
  return s.length;
}

function previewSnippet(s: string, max: number): string {
  if (s.length <= max) return s.replace(/\n/g, '\\n');
  return `${s.slice(0, max).replace(/\n/g, '\\n')}…`;
}

function truncateForDesc(s: string): string {
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

function worseOrSelf(current: MutationCategory, floor: MutationCategory): MutationCategory {
  return worse(current, floor);
}
