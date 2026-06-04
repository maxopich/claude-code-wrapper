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
 *     to `dangerous` (we don't try to parse what's inside). Windows-native
 *     commands (cmd builtins + PowerShell cmdlets/aliases, `powershell -c`,
 *     redirects to `C:\Windows`) are matched case-insensitively — Cebab
 *     targets Windows without WSL.
 */

export type MutationCategory = 'read' | 'mutate' | 'dangerous';

/**
 * Cluster F Phase F3 (UI-F3): stable IDs for every classifier rule that can
 * promote a Bash command above `read`. The rationale is operator-facing
 * (rendered as a tooltip on the mutation badge in `MutationsDisclosure`)
 * AND machine-facing (persisted on `multi_agent_mutations.classifier_reason_json`,
 * which the safety_audit + forensic-replay paths can query without re-parsing
 * the command string). Add new variants conservatively — once a rule is on the
 * wire it's also in the durable record, so renames need a back-fill story.
 */
export type BashClassifierRule =
  | 'shell_substitution'
  | 'process_substitution'
  | 'redirect_system_path'
  | 'redirect_path'
  | 'dangerous_subcommand'
  | 'dangerous_first_token'
  | 'mkfs_variant'
  | 'shell_invocation_bare'
  | 'shell_invocation_dash_c'
  | 'shell_invocation_script'
  | 'kill_minus_nine'
  | 'kill_other'
  | 'chmod_chown_system_path'
  | 'find_with_delete_or_exec'
  | 'sed_in_place'
  | 'unknown_subcommand_of_known_tool'
  | 'mutating_first_token'
  | 'unknown_first_token';

export type BashClassifierReason = {
  /** Stable rule ID; see `BashClassifierRule` above. */
  rule: BashClassifierRule;
  /**
   * Operator-readable explanation, e.g.
   *   `"first token 'rm' is always dangerous"`,
   *   `"output redirect to system path /etc/passwd"`,
   *   `"git subcommand 'push --force' is in the dangerous-subcommand list"`.
   * Kept short — the badge tooltip is the primary surface. Render as-is.
   */
  detail: string;
  /**
   * The actual fragment that triggered the rule. For first-token rules this
   * is the token (`'rm'`); for subcommand rules it's `'<bin> <sub>'`; for
   * redirect rules it's the resolved target. Surfaced so the operator can
   * tell at a glance "yes, that's the bit I meant".
   */
  matched: string;
};

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
  /**
   * Cluster F Phase F3 (UI-F3): for `Bash` commands classified as `mutate`
   * or `dangerous`, the rule that fired + the matched fragment. Undefined
   * for non-Bash tools (the tool name itself is the rationale) and for
   * Bash commands classified as `read` (the operator never sees a badge).
   * When a command compounds multiple top-level pieces (`;`/`&&`/`||`/`|`),
   * this is the reason for the *worst* piece — the piece that pinned the
   * overall category.
   */
  reason?: BashClassifierReason;
};

const CATEGORY_RANK: Record<MutationCategory, number> = {
  read: 0,
  mutate: 1,
  dangerous: 2,
};

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
      return {
        category: cls.category,
        summary: `${truncated}${suffix}`,
        ...(cls.reason ? { reason: cls.reason } : {}),
      };
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

    case 'AskUserQuestion': {
      // Asks the operator a question — touches no filesystem. Classify as
      // `read` so it never trips the pause-on-mutation gate or inflates the
      // mutations counter (pre-fix it fell through to `default` → `mutate`).
      // In the bus this tool is separately intercepted and surfaced to the
      // operator (see the runner's canUseTool path); the classification here
      // only governs the mutation log/counter.
      const qs = inp['questions'];
      const n = Array.isArray(qs) ? qs.length : 0;
      return { category: 'read', summary: `ask user ${n} question${n === 1 ? '' : 's'}` };
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
  // Filesystem / disk destroyers and persistence-layer mutators.
  'shred',
  'truncate',
  'wipefs',
  'fdisk',
  'parted',
  'diskutil',
  'chflags',
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
  // Infra-as-code, cluster, cloud, and DB destructive ops. Matched as exact
  // first-token pairs (and `aws s3 rm` as a triple) — see classifyByTokens.
  'kubectl delete',
  'terraform destroy',
  'terraform apply',
  'helm delete',
  'helm uninstall',
  'aws s3 rm',
  'psql -c',
  'mysql -e',
]);

/**
 * Windows-native dangerous first tokens (cmd builtins + PowerShell cmdlets and
 * aliases). Cebab targets Windows without WSL, so a worker's Bash-tool string
 * can be a cmd / PowerShell command. Matched CASE-INSENSITIVELY against the
 * lowercased first-token basename (PowerShell is case-insensitive and
 * alias-rich: `Remove-Item` / `ri` / `del` / `rd` are one thing). `attrib` /
 * `icacls` are intentionally absent — permission tweaks ~ chmod → `mutate`.
 */
const DANGEROUS_WINDOWS_FIRST_TOKENS: ReadonlySet<string> = new Set([
  // cmd builtins + disk / recovery / boot tools.
  'del',
  'erase',
  'rd',
  'rmdir',
  'format',
  'diskpart',
  'takeown',
  'cipher', // `cipher /w` wipes free space
  'vssadmin', // shadow-copy deletion — ransomware pattern
  'fsutil',
  'bcdedit',
  'taskkill', // can knock out the Cebab server (~ pkill)
  // PowerShell destructive cmdlets + aliases.
  'remove-item',
  'ri',
  'clear-disk',
  'format-volume',
  'clear-content',
  'clear-item',
  'stop-computer',
  'restart-computer',
  'set-executionpolicy', // disables the script-signing brake
  'invoke-expression', // arbitrary code (~ eval)
  'iex',
]);

/**
 * Windows shells whose `-Command` / `-c` / `-EncodedCommand` / `/c` invocation
 * runs an arbitrary, un-introspectable command string (the `bash -c` analogue).
 * Matched on the lowercased basename so `C:\Windows\System32\cmd.exe` matches.
 */
const WINDOWS_SHELLS: ReadonlySet<string> = new Set([
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'cmd',
  'cmd.exe',
]);

/**
 * Arbitrary-code flags for the Windows shells above (lowercased exact match).
 * `-c` / `-e` are PowerShell's documented abbreviations of `-Command` /
 * `-EncodedCommand`; `/c` `/k` are cmd's.
 */
const WINDOWS_SHELL_CODE_FLAGS: ReadonlySet<string> = new Set([
  '-command',
  '-c',
  '-encodedcommand',
  '-enc',
  '-ec',
  '-e',
  '/c',
  '/k',
]);

/**
 * Windows dangerous subcommands — `<bin> <sub>` pairs (lowercased): registry
 * mutation (persistence), account / service control. `reg query` / `reg export`
 * fall through to the default (`mutate`).
 */
const DANGEROUS_WINDOWS_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'reg delete',
  'reg add',
  'reg import',
  'reg load',
  'reg unload',
  'net user',
  'net localgroup',
  'net stop',
  'sc delete',
  'sc stop',
  'sc config',
]);

/**
 * Internal verdict shape: bundle the category with the reason that produced
 * it, so the multi-piece reduction in `classifyBashCommand` can preserve the
 * `worst` piece's rationale (not just its category). `reason` is `null` for
 * `read` verdicts and for the initial "no pieces yet" seed.
 */
type Verdict = { category: MutationCategory; reason: BashClassifierReason | null };

function verdictWorse(a: Verdict, b: Verdict): Verdict {
  return CATEGORY_RANK[a.category] >= CATEGORY_RANK[b.category] ? a : b;
}

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
  if (!trimmed) {
    return {
      category: 'mutate',
      summary: '',
      reason: {
        rule: 'unknown_first_token',
        detail: 'empty Bash command — defaulting to mutate',
        matched: '',
      },
    };
  }

  // Shell-substitution: don't try to parse what's inside; mark dangerous.
  // Detection patterns are deliberately marker-only (no `[^)]*\)` body
  // match) to keep the regex O(N) on adversarial input — see r-A1 in the
  // F3 plan. CodeQL flagged the previous body-matching pattern as
  // polynomial-ReDoS on inputs like `<(<(<(<(...` with no closing `)`.
  // The operator reads the offending substring from `summary` (which
  // carries the full command verbatim); `matched` is just the trigger
  // marker for "this is the bit that fired".
  const subMatch = /(?<![\\$])\$\(|`/.exec(trimmed);
  if (subMatch) {
    return {
      category: 'dangerous',
      summary: trimmed,
      reason: {
        rule: 'shell_substitution',
        detail:
          'command contains shell-substitution (`$(...)` or backticks) — the substituted text could be anything',
        matched: subMatch[0],
      },
    };
  }

  // Process-substitution: `<(curl ...)` etc. — also unparseable; dangerous.
  // Same marker-only detection as shell-substitution above (CodeQL
  // `js/polynomial-redos`); the operator inspects `summary` for the
  // full fragment.
  const procMatch = /<\(|>\(/.exec(trimmed);
  if (procMatch) {
    return {
      category: 'dangerous',
      summary: trimmed,
      reason: {
        rule: 'process_substitution',
        detail:
          'command contains process-substitution (`<(...)` or `>(...)`) — the substituted process could run anything',
        matched: procMatch[0],
      },
    };
  }

  let worst: Verdict = { category: 'read', reason: null };
  for (const piece of splitTopLevel(trimmed)) {
    const pieceVerdict = classifyBashPiece(piece);
    worst = verdictWorse(worst, pieceVerdict);
    if (worst.category === 'dangerous') break;
  }

  return {
    category: worst.category,
    summary: trimmed,
    ...(worst.reason ? { reason: worst.reason } : {}),
  };
}

/** Classify one segment of a compound Bash command. */
function classifyBashPiece(piece: string): Verdict {
  const stripped = stripEnvAssignments(piece.trim());
  if (!stripped) return { category: 'read', reason: null };

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
      /^~\/\.kube\b/.test(target) ||
      // Shell-init / persistence / credential dotfiles — a redirect here is
      // an RCE-on-next-shell or secret-overwrite vector.
      /^~\/\.(zshrc|bashrc|bash_profile|zprofile|profile|gitconfig|npmrc)\b/.test(target) ||
      // Windows system locations (case-insensitive; `\` or `/` separators).
      /^[a-z]:[\\/]windows(?:[\\/]|$)/i.test(target) ||
      /^%(?:systemroot|windir)%/i.test(target)
    ) {
      return {
        category: 'dangerous',
        reason: {
          rule: 'redirect_system_path',
          detail: `output redirect (>, >>) to system or secret-store path '${target}'`,
          matched: target,
        },
      };
    }
    // Any other redirect target → mutate (at least). Run the token-level
    // classifier too in case the redirect *target* is benign but the
    // *first token* is dangerous (`sudo something > /tmp/x`).
    const inner = classifyByTokens(stripped);
    if (CATEGORY_RANK[inner.category] >= CATEGORY_RANK['mutate']) return inner;
    return {
      category: 'mutate',
      reason: {
        rule: 'redirect_path',
        detail: `output redirect (>, >>) to '${target}'`,
        matched: target,
      },
    };
  }

  return classifyByTokens(stripped);
}

function classifyByTokens(stripped: string): Verdict {
  const tokens = stripped.split(/\s+/);
  const first = tokens[0] ?? '';
  const second = tokens[1] ?? '';
  const pair = second ? `${first} ${second}` : first;
  const triple = tokens[2] ? `${first} ${second} ${tokens[2]}` : pair;
  // Windows commands are case-insensitive; compare lowercased forms (and the
  // shell basename so a full-path `C:\…\cmd.exe` still matches).
  const firstBase = first.toLowerCase().replace(/^.*[\\/]/, '');
  const winPair = second ? `${firstBase} ${second.toLowerCase()}` : firstBase;

  // 1) Universal version/help check: `<anything> --version` / `-V` /
  //    `--help` is always a query, no matter the binary. Cheap escape
  //    hatch so `node --version` doesn't fall through to the `mutate`
  //    default just because `node` isn't in any positive list. We deliberately
  //    omit `-h` and the bare `help` subtoken — those are overloaded
  //    (`shutdown -h`, `git help` is genuinely help but `npm help <cmd>` opens
  //    docs which is fine to default to mutate via a positive-list miss).
  if (second === '--version' || second === '-V' || second === '--help') {
    return { category: 'read', reason: null };
  }

  // 2) Exact dangerous-subcommand match.
  const dangerSub = DANGEROUS_SUBCOMMANDS.has(triple)
    ? triple
    : DANGEROUS_SUBCOMMANDS.has(pair)
      ? pair
      : null;
  if (dangerSub) {
    return {
      category: 'dangerous',
      reason: {
        rule: 'dangerous_subcommand',
        detail: `subcommand '${dangerSub}' is in the dangerous-subcommand list (destructive, force-push, prune, or untrusted install)`,
        matched: dangerSub,
      },
    };
  }

  // 3) Plain `rm` (any args) is dangerous.
  if (DANGEROUS_FIRST_TOKENS.has(first)) {
    return {
      category: 'dangerous',
      reason: {
        rule: 'dangerous_first_token',
        detail: `first token '${first}' is always dangerous (destructive, privilege-escalating, or remote-code-executing)`,
        matched: first,
      },
    };
  }

  // 4) `mkfs*` (mkfs.ext4, mkfs.xfs, etc.) — any filesystem-create variant.
  if (first.startsWith('mkfs.') || first === 'mkfs') {
    return {
      category: 'dangerous',
      reason: {
        rule: 'mkfs_variant',
        detail: `'${first}' creates a filesystem — irreversible data loss on the target device`,
        matched: first,
      },
    };
  }

  // 5) Shell invocation (`sh`, `bash`, `zsh`):
  //    - bare `sh` with no args: typically the receiving end of a pipe
  //      (`curl | sh`). Dangerous.
  //    - `bash -c '<arbitrary>'`: arbitrary code. Dangerous.
  //    - `bash script.sh`: running a script. We can't introspect — mutate
  //      (operator sees the script path and decides).
  if (first === 'sh' || first === 'bash' || first === 'zsh') {
    if (tokens.length === 1) {
      return {
        category: 'dangerous',
        reason: {
          rule: 'shell_invocation_bare',
          detail: `bare '${first}' with no arguments — typically the receiving end of a 'curl | sh' pipe`,
          matched: first,
        },
      };
    }
    if (second === '-c') {
      return {
        category: 'dangerous',
        reason: {
          rule: 'shell_invocation_dash_c',
          detail: `'${first} -c' runs an arbitrary command string from its argument`,
          matched: `${first} -c`,
        },
      };
    }
    return {
      category: 'mutate',
      reason: {
        rule: 'shell_invocation_script',
        detail: `'${first} ${second}' runs the named script — its contents aren't parsed by the classifier`,
        matched: `${first} ${second}`,
      },
    };
  }

  // 6) `kill` with `-9` / `-KILL` is dangerous; plain `kill` is mutate.
  if (first === 'kill') {
    if (tokens.includes('-9') || tokens.includes('-KILL')) {
      const signal = tokens.includes('-9') ? '-9' : '-KILL';
      return {
        category: 'dangerous',
        reason: {
          rule: 'kill_minus_nine',
          detail: `'kill ${signal}' is unmaskable — could knock out the Cebab server if misdirected`,
          matched: `kill ${signal}`,
        },
      };
    }
    return {
      category: 'mutate',
      reason: {
        rule: 'kill_other',
        detail: `'kill' sends a signal to a process — surfaced so the operator can confirm intent`,
        matched: 'kill',
      },
    };
  }

  // 6b) Windows-native dangerous commands (cmd / PowerShell). Cebab runs on
  //     Windows without WSL, so a Bash-tool string may be a Windows command.
  //     Checked case-insensitively against the lowercased token / basename.
  if (DANGEROUS_WINDOWS_SUBCOMMANDS.has(winPair)) {
    return {
      category: 'dangerous',
      reason: {
        rule: 'dangerous_subcommand',
        detail: `Windows subcommand '${winPair}' is destructive (registry, account, or service mutation)`,
        matched: winPair,
      },
    };
  }
  if (WINDOWS_SHELLS.has(firstBase)) {
    const codeFlag = tokens.slice(1).find((t) => WINDOWS_SHELL_CODE_FLAGS.has(t.toLowerCase()));
    if (codeFlag) {
      return {
        category: 'dangerous',
        reason: {
          rule: 'shell_invocation_dash_c',
          detail: `'${first} ${codeFlag}' runs an arbitrary (possibly base64-encoded) command string — contents not introspected`,
          matched: `${firstBase} ${codeFlag.toLowerCase()}`,
        },
      };
    }
    if (tokens.length === 1) {
      return {
        category: 'dangerous',
        reason: {
          rule: 'shell_invocation_bare',
          detail: `bare '${first}' with no arguments — typically the receiving end of a pipe`,
          matched: firstBase,
        },
      };
    }
    return {
      category: 'mutate',
      reason: {
        rule: 'shell_invocation_script',
        detail: `'${first}' runs the named script / args — contents aren't parsed by the classifier`,
        matched: firstBase,
      },
    };
  }
  if (DANGEROUS_WINDOWS_FIRST_TOKENS.has(firstBase)) {
    return {
      category: 'dangerous',
      reason: {
        rule: 'dangerous_first_token',
        detail: `Windows command '${first}' is destructive, privilege-escalating, or remote-code-executing`,
        matched: first,
      },
    };
  }

  // 7) Subcommand-aware read-only check (git/npm/docker/cargo/...).
  const subAllow = READONLY_SUBCOMMANDS[first];
  if (subAllow) {
    if (second && subAllow.has(second)) return { category: 'read', reason: null };
    // Other subcommands of `git`/`npm`/`docker`/etc. → mutate (default).
    return {
      category: 'mutate',
      reason: {
        rule: 'unknown_subcommand_of_known_tool',
        detail: `'${first} ${second || '<no subcommand>'}' is not in the readonly-subcommand allowlist for '${first}'`,
        matched: pair,
      },
    };
  }

  // 8) Plain read-only allowlist.
  if (READONLY_FIRST_TOKENS.has(first)) {
    // `find` with `-delete` / `-exec` flags is mutating.
    if (first === 'find' && (tokens.includes('-delete') || tokens.includes('-exec'))) {
      const flag = tokens.includes('-delete') ? '-delete' : '-exec';
      return {
        category: 'mutate',
        reason: {
          rule: 'find_with_delete_or_exec',
          detail: `'find ${flag}' mutates files (or executes a command per match)`,
          matched: `find ${flag}`,
        },
      };
    }
    // `sed -i` is in-place edit → mutate.
    if (first === 'sed' && tokens.includes('-i')) {
      return {
        category: 'mutate',
        reason: {
          rule: 'sed_in_place',
          detail: `'sed -i' edits files in place`,
          matched: 'sed -i',
        },
      };
    }
    return { category: 'read', reason: null };
  }

  // 9) Mutating allowlist.
  if (MUTATING_FIRST_TOKENS.has(first)) {
    // `chmod` / `chown` on system paths → dangerous.
    if ((first === 'chmod' || first === 'chown') && hasSystemPath(tokens)) {
      const sysToken =
        tokens.find(
          (t) =>
            t === '/' ||
            t.startsWith('/etc/') ||
            t.startsWith('/usr/') ||
            t.startsWith('/var/') ||
            t.startsWith('/boot/') ||
            t.startsWith('/dev/') ||
            t.startsWith('/sys/') ||
            t.startsWith('/proc/'),
        ) ?? '';
      return {
        category: 'dangerous',
        reason: {
          rule: 'chmod_chown_system_path',
          detail: `'${first}' targets system path '${sysToken}'`,
          matched: `${first} ${sysToken}`,
        },
      };
    }
    return {
      category: 'mutate',
      reason: {
        rule: 'mutating_first_token',
        detail: `first token '${first}' is in the mutating-token list (filesystem, VCS, packages, or download)`,
        matched: first,
      },
    };
  }

  // 10) Anything else (unknown first token) defaults to mutate. The operator
  //     sees a yellow badge and the command verbatim and decides.
  return {
    category: 'mutate',
    reason: {
      rule: 'unknown_first_token',
      detail: `first token '${first}' is not in any classifier allowlist — defaulted to mutate (conservative)`,
      matched: first,
    },
  };
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
