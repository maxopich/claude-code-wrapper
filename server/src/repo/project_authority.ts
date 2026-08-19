import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  EnvInjection,
  HookView,
  McpServerView,
  ProjectAuthority,
  ToolView,
} from '@cebab/shared/protocol';
import { isSensitiveKey } from '@cebab/shared';
import { SCRUBBED_ENV_POSTURES, SCRUBBED_ENV_VAR_NAMES } from '../runner/claude.js';
import { readTextBounded } from '../safe_fs.js';

/**
 * Register H03: ceiling on a project's `.claude/settings*.json`.
 *
 * Real ones are a few KB. 1 MiB leaves enormous headroom for a legitimately
 * baroque config while refusing the multi-gigabyte file that would otherwise
 * be read whole into memory during a pre-spawn resolve.
 */
const MAX_SETTINGS_BYTES = 1024 * 1024;

/**
 * Same ceiling for the project-root `.mcp.json`. Same threat, same shape: it
 * is a project-supplied file read on the way into a spawn.
 */
const MAX_MCP_JSON_BYTES = 1024 * 1024;

/** Project-root MCP manifest. See `readMcpJsonServers` for why this exists. */
const MCP_JSON_FILENAME = '.mcp.json';

/**
 * `~/.claude.json` — the CLI's own state file, and the OTHER place MCP servers
 * actually load from. See `readClaudeJsonServers`.
 *
 * A larger ceiling than its siblings on purpose: this is CLI-managed state, not
 * a hand-written config. It accumulates a block per project the user has ever
 * opened, so it grows without anyone editing it (measured: 138 KB across 62
 * projects on the development machine). 1 MiB would be a live truncation risk
 * within a year of ordinary use, and truncating this file means silently
 * failing to gate a server.
 */
const MAX_CLAUDE_JSON_BYTES = 8 * 1024 * 1024;
const CLAUDE_JSON_FILENAME = '.claude.json';
import { getProject } from './projects.js';
import { checkTrust, computeBinarySha, firstDecisionTs, listForServer } from './mcp_trust.js';
import { listSessionsForProject } from './sessions.js';
import { getDb } from '../db.js';

// Cluster B Phase 3 (§4.3): file-read-only resolver for ProjectAuthority.
//
// The resolver does NOT spawn Claude; it reads (a) the cached
// `session_started` snapshot the WS layer already holds (= effective state
// at the runner boundary) and (b) the `.claude/settings*.json` layers
// (= declared provenance), and merges them into a single
// `ProjectAuthority` envelope that the AuthorityPanel (Phase 6+) renders.
//
// The "probe" mode of `get_project_authority` (spawn a maxTurns:0 SDK run
// for a fresh effective snapshot) lands in Phase 3b; this module
// intentionally does not import the SDK to keep its surface area small.

// ---- settings.json shape ----
//
// We deliberately type only the fields we read. The SDK declares the full
// `Settings` type but pulling it in would couple the resolver to SDK
// internals we don't need.
type RawSettings = {
  permissions?: { allow?: string[]; deny?: string[] };
  env?: Record<string, string | null | undefined>;
  mcpServers?: Record<
    string,
    | {
        command?: string;
        args?: string[];
        env?: Record<string, unknown>;
      }
    | undefined
  >;
  hooks?: Record<
    string,
    Array<{
      hooks?: Array<{
        type?: string;
        command?: string;
        args?: string[];
      }>;
    }>
  >;
};

/**
 * `~/.claude.json`, typed to the two blocks we read. The real file carries
 * dozens of other keys (caches, counters, per-project usage stats) — none of
 * them are our business and none are typed here, deliberately: this file is
 * read for MCP declarations only.
 */
type ClaudeJson = {
  mcpServers?: RawSettings['mcpServers'];
  projects?: Record<string, { mcpServers?: RawSettings['mcpServers'] } | undefined>;
};

/** A `settings.json` scope the SDK can be told to layer in. Structurally the
 *  same set as `runner/claude.ts`'s `SettingSource`. */
export type SettingScope = 'user' | 'project' | 'local';

type SettingsLayer = {
  scope: SettingScope;
  scopePath: string;
  data: RawSettings | null;
};

const USER_SCOPE_PATH = path.join(os.homedir(), '.claude', 'settings.json');

/**
 * MCP server names Cebab itself injects. Only these may carry
 * `scope: 'cebab-injected'`, which grants an automatic `trust: 'trusted'`
 * (`enrichWithTrustState`) and a skip in `awaitMcpTrustDecisions`.
 *
 * Keep in sync with the `mcpServers` keys in `bus/runner.ts`'s
 * `runOneAttempt` — and keep it MINIMAL. `bus` used to be listed here for the
 * deprecation alias; now that the alias is gone, leaving it would mean a
 * participant's own server named `bus` — one Cebab does not inject and never
 * saw in a settings layer — is laundered into permanently-trusted and skipped
 * by TOFU. Only add a name here when `runOneAttempt` actually registers it.
 */
const CEBAB_INJECTED_MCP_NAMES: ReadonlySet<string> = new Set(['cebab_bus']);

/**
 * Read + parse a `.claude/settings.json` (or `.claude/settings.local.json`).
 * Returns `null` for "file absent" and "file unreadable" alike — the
 * inspector treats both as "no rules from this scope" (vs. a noisy error).
 * Malformed JSON logs a console.warn so a misconfigured operator notices
 * once on session start.
 */
function readSettingsFile(p: string): RawSettings | null {
  // Register H03: this file belongs to the PROJECT, so on an untrusted one it
  // is attacker-controlled, and this runs during the pre-spawn authority
  // resolve — on the way into every session start. It used to be a bare
  // `fs.readFileSync(p, 'utf8')`: a FIFO left at `.claude/settings.json`
  // parked the single-threaded event loop for the whole server, and a
  // multi-gigabyte file exhausted memory. `readFileBounded` opens once with
  // O_NONBLOCK, fstats that descriptor (not the path — closing the TOCTOU
  // swap window), rejects non-regular files and caps the size.
  const read = readTextBounded(p, MAX_SETTINGS_BYTES);
  if (!read.ok) {
    // 'unreadable' covers the ENOENT case this function has always treated
    // as a silent "no rules from this scope". The other refusals mean the
    // path exists but is hostile or absurd, which the operator should hear
    // about exactly once — same posture as malformed JSON below.
    if (read.refusal !== 'unreadable') {
      console.warn(`[project_authority] refused to read ${p}: ${read.refusal}`);
    }
    return null;
  }
  try {
    return JSON.parse(read.text) as RawSettings;
  } catch (e: unknown) {
    console.warn(`[project_authority] could not parse ${p}: ${String(e)}`);
    return null;
  }
}

/**
 * Read the project-root `.mcp.json` — the only project-scoped location the
 * CLI actually loads MCP servers from.
 *
 * WHY THIS EXISTS. Everything else in this module attributes MCP servers from
 * `mcpServers` blocks in `.claude/settings*.json`. Measured against SDK
 * 0.3.201 with a real MCP stdio server, reading `system/init.mcp_servers`,
 * that key is **not loaded at any scope**:
 *
 *   <proj>/.claude/settings.json      → mcpServers  → NOT loaded
 *   ...the same + enableAllProjectMcpServers: true  → NOT loaded
 *   ~/.claude/settings.json           → mcpServers  → NOT loaded
 *   <proj>/.mcp.json                                → LOADED, 'connected'
 *
 * `~/.claude.json` was missing from that table and is now measured too — see
 * `readClaudeJsonServers`. Both of its blocks load, so `.mcp.json` was never
 * "the only" loading location; it was the only one anyone had checked.
 *
 * So before this function the TOFU gate could only ever prompt about
 * declarations that would never run, while the servers that DO run reached
 * the spawn with no prompt, no `mcp_trust` row and no `safety_audit` row.
 * The gate was watching the wrong file.
 *
 * SCOPE GATING is not a nicety — it is the contract `loadSettingsLayers`
 * documents: read exactly what the spawn will load. `.mcp.json` loads iff the
 * spawn's `settingSources` includes `'project'` (measured: `['user']` and `[]`
 * do not load it, `['user','project','local']` does). That is every bus
 * participant and every trusted single-agent project — and reading it for an
 * untrusted single-agent project would prompt the operator about a server
 * their Trust setting already prevents from loading.
 *
 * Returns `[]` for absent / unreadable / malformed, matching
 * `readSettingsFile`'s "no rules from this scope" posture.
 */
export function readMcpJsonServers(
  projectPath: string,
  scopes: readonly SettingScope[],
): McpServerView[] {
  if (!scopes.includes('project')) return [];

  const p = path.join(projectPath, MCP_JSON_FILENAME);
  // Bounded + TOCTOU-safe for the same reasons as `readSettingsFile`: this is
  // a project-controlled path read during a pre-spawn resolve.
  const read = readTextBounded(p, MAX_MCP_JSON_BYTES);
  if (!read.ok) {
    if (read.refusal !== 'unreadable') {
      console.warn(`[project_authority] refused to read ${p}: ${read.refusal}`);
    }
    return [];
  }

  let parsed: RawSettings;
  try {
    parsed = JSON.parse(read.text) as RawSettings;
  } catch (e: unknown) {
    console.warn(`[project_authority] could not parse ${p}: ${String(e)}`);
    return [];
  }
  if (!parsed?.mcpServers) return [];

  const out: McpServerView[] = [];
  for (const [name, conf] of Object.entries(parsed.mcpServers)) {
    if (!conf) continue;
    const envKeys = conf.env ? Object.keys(conf.env) : undefined;
    const config: { command?: string; args?: string[]; envKeys?: string[] } = {};
    if (typeof conf.command === 'string') config.command = conf.command;
    if (Array.isArray(conf.args)) config.args = conf.args;
    if (envKeys && envKeys.length > 0) config.envKeys = envKeys;
    const view: McpServerView = {
      name,
      status: 'unknown',
      scope: 'mcp-json',
      originPath: p,
      tools: [],
      trust: 'unknown',
    };
    if (config.command || config.args || config.envKeys) view.config = config;
    out.push(view);
  }
  return out;
}

/**
 * Read `~/.claude.json` — the CLI's own state file, and the second place MCP
 * servers actually load from.
 *
 * WHY THIS EXISTS. `readMcpJsonServers` above closed the gap for
 * project-declared servers. What was left reached a spawn with **no
 * `originPath`**, so `mcp_trust_gate` skipped it (the `!server.originPath`
 * check) and it ran with no TOFU prompt, no `mcp_trust` row and no
 * `safety_audit` row. Register `x1n.6.23` guessed this was where they came
 * from and could not act on it, because a runtime-observed server has no
 * durable anchor to key `(server_name, origin_path, binary_sha)` on. Reading
 * the declaration gives it one: this file's path.
 *
 * MEASURED against SDK 0.3.201 (same method as the table above — a bogus
 * `command` in each location, read back off `system/init.mcp_servers`, with
 * `.mcp.json` as the positive control):
 *
 *   ~/.claude.json  mcpServers                       → LOADED at EVERY scope
 *                                                      set, ['user'] included
 *   ~/.claude.json  projects[<cwd>].mcpServers       → LOADED iff scopes
 *                                                      include 'local'
 *   <proj>/.mcp.json (control)                       → LOADED iff 'project'
 *
 * The first row is the one that matters most and is easy to miss: **top-level
 * `mcpServers` loads under `['user']`**, which is what an UNTRUSTED
 * single-agent project runs. The Trust toggle stops a project's own
 * `settings.local.json` from loading; it does not stop this. So a
 * `claude mcp add --scope user` server reaches every Cebab spawn regardless of
 * Trust, and before this function it did so ungated.
 *
 * KEYED BY RESOLVED PATH. The `projects` block is keyed by the CLI's resolved
 * cwd. Measured: a key written with an UNRESOLVED path matches nothing — on
 * macOS `/var/folders/…` is a symlink to `/private/var/…`, so looking up the
 * raw path silently finds no servers and reports a clean, wrong negative. We
 * look up the realpath and fall back to the literal path only when the
 * directory cannot be resolved.
 *
 * Returns `[]` for absent / unreadable / malformed, matching
 * `readSettingsFile`'s "no rules from this scope" posture.
 */
export function readClaudeJsonServers(
  projectPath: string,
  scopes: readonly SettingScope[],
): McpServerView[] {
  const p = path.join(os.homedir(), CLAUDE_JSON_FILENAME);
  const read = readTextBounded(p, MAX_CLAUDE_JSON_BYTES);
  if (!read.ok) {
    if (read.refusal !== 'unreadable') {
      console.warn(`[project_authority] refused to read ${p}: ${read.refusal}`);
    }
    return [];
  }

  let parsed: ClaudeJson;
  try {
    parsed = JSON.parse(read.text) as ClaudeJson;
  } catch (e: unknown) {
    console.warn(`[project_authority] could not parse ${p}: ${String(e)}`);
    return [];
  }

  const out: McpServerView[] = [];
  const push = (block: RawSettings['mcpServers'] | undefined) => {
    if (!block) return;
    for (const [name, conf] of Object.entries(block)) {
      if (!conf) continue;
      // A name already taken by the other block in the SAME file: keep the
      // first. Both anchor to this path, so the trust row is identical either
      // way and there is nothing to choose between them.
      if (out.some((v) => v.name === name)) continue;
      const envKeys = conf.env ? Object.keys(conf.env) : undefined;
      const config: { command?: string; args?: string[]; envKeys?: string[] } = {};
      if (typeof conf.command === 'string') config.command = conf.command;
      if (Array.isArray(conf.args)) config.args = conf.args;
      if (envKeys && envKeys.length > 0) config.envKeys = envKeys;
      const view: McpServerView = {
        name,
        status: 'unknown',
        scope: 'claude-json',
        originPath: p,
        tools: [],
        trust: 'unknown',
      };
      if (config.command || config.args || config.envKeys) view.config = config;
      out.push(view);
    }
  };

  // Unconditional: measured to load at every scope set Cebab passes, including
  // the `['user']` an untrusted project runs. Gating it on a scope would make
  // Cebab stop prompting for a server that still loads.
  push(parsed.mcpServers);

  if (scopes.includes('local')) {
    let key: string;
    try {
      key = fs.realpathSync(projectPath);
    } catch {
      key = projectPath;
    }
    push(parsed.projects?.[key]?.mcpServers);
  }
  return out;
}

/**
 * Collect the settings layers for a project, for a GIVEN scope set.
 *
 * The scope set must be the one the spawn this resolution gates will
 * actually pass to the SDK — that is the whole contract. Reading fewer
 * layers than the spawn loads makes the inspector and, far worse, the
 * spawn gates (`awaitMcpTrustDecisions` / `awaitEnvInjectionAck`) blind to
 * rules that then execute.
 *
 * Two callers, two scope sets, and they genuinely differ:
 *   - single-agent — trust-derived, matching `ws/server.ts`'s
 *     `trusted ? ['user','project','local'] : ['user']`.
 *   - bus participants — always `['user','project','local']`, because
 *     `bus/{orchestrator,chain}.ts` register every worker with that literal
 *     regardless of trust.
 *
 * `settingSourcesUsed` on the resolved authority reflects whatever was
 * passed, so the AuthorityPanel never claims a layer that wasn't applied.
 */
function loadSettingsLayers(projectPath: string, scopes: readonly SettingScope[]): SettingsLayer[] {
  const layers: SettingsLayer[] = [];
  for (const scope of scopes) {
    if (scope === 'user') {
      layers.push({
        scope: 'user',
        scopePath: USER_SCOPE_PATH,
        data: readSettingsFile(USER_SCOPE_PATH),
      });
      continue;
    }
    const scopePath = path.join(
      projectPath,
      '.claude',
      scope === 'project' ? 'settings.json' : 'settings.local.json',
    );
    layers.push({ scope, scopePath, data: readSettingsFile(scopePath) });
  }
  return layers;
}

/**
 * The scope set a project's SINGLE-AGENT run would use, derived from Trust.
 * Mirrors `ws/server.ts`'s `const settingSources = trusted ? [...] : [...]`.
 * Bus callers must NOT use this — see `BUS_SETTING_SCOPES`.
 */
export function trustDerivedScopes(trusted: boolean): readonly SettingScope[] {
  return trusted ? (['user', 'project', 'local'] as const) : (['user'] as const);
}

/**
 * The scope set every bus participant runs under, irrespective of Trust.
 * Pinned here so the gate and the spawn read from one definition instead of
 * three hardcoded literals drifting apart — the exact divergence that let an
 * untrusted worker's project-declared MCP servers and `env:` block load
 * without ever reaching a gate.
 *
 * Keep in sync with the `runner.register({ settingSources: ... })` calls in
 * `bus/orchestrator.ts` and `bus/chain.ts`.
 */
export const BUS_SETTING_SCOPES: readonly SettingScope[] = ['user', 'project', 'local'];

/**
 * Normalize a permissions.allow / .deny entry to the tool name it
 * targets. SDK permission strings are either bare tool names (`"Read"`)
 * or tool-with-input patterns (`"Bash(echo:*)"`); both attribute to the
 * tool itself (`"Read"` / `"Bash"`). Patterns past Phase 3's matching
 * granularity (regex etc.) still attribute to the leftmost identifier.
 */
function ruleTargetTool(rule: string): string {
  const parenIdx = rule.indexOf('(');
  return (parenIdx === -1 ? rule : rule.slice(0, parenIdx)).trim();
}

/**
 * Walk a single tool through every settings layer and return the merged
 * allow/deny decision per spec BE-B7. Convention (matches SDK):
 *
 *   - deny wins over allow
 *   - if multiple scopes match, the DEEPEST one wins (local > project > user),
 *     matching the SDK's settingSources merging (`runner/claude.ts:80`)
 *   - no matching rule → not allowed, not denied, rulingScope='default'
 *     (i.e. the SDK applies its built-in fallback)
 *
 * The agentic-reviewer §6.4 "tool denied by SDK not in any visible deny
 * list" divergence is precisely the `rulingScope='default' + denied=false`
 * + at-runtime-denied case — Phase 3 surfaces it via `rulingScope`, Phase
 * 10's usage-diff highlights it in the "Attempted-but-denied" column.
 */
export function resolveToolAuthority(
  toolName: string,
  layers: SettingsLayer[],
  options?: { mcpServers?: McpServerView[] },
): ToolView {
  let allowScope: 'user' | 'project' | 'local' | null = null;
  let denyScope: 'user' | 'project' | 'local' | null = null;
  for (const layer of layers) {
    if (!layer.data?.permissions) continue;
    const allowList = layer.data.permissions.allow ?? [];
    const denyList = layer.data.permissions.deny ?? [];
    if (allowList.some((r) => ruleTargetTool(r) === toolName)) {
      allowScope = layer.scope;
    }
    if (denyList.some((r) => ruleTargetTool(r) === toolName)) {
      denyScope = layer.scope;
    }
  }
  // mcp__<server>__<tool> conventions: if the named MCP server is
  // `needs-auth`/`disabled`/`failed`, the tool is effectively unavailable
  // regardless of allow/deny (BE-B6). We surface this as denied=true with
  // rulingScope='default' so the AuthorityPanel can render it distinctly
  // from operator-declared denies — the ruling came from MCP runtime
  // status, NOT from any settings-layer rule.
  let mcpUnavailable = false;
  let source: ToolView['source'] = 'builtin';
  let mcpServer: string | undefined;
  if (toolName.startsWith('mcp__')) {
    // Server names themselves may contain underscores (e.g. 'cebab_bus'),
    // so we can't match `[^_]+`. The `__` (double underscore) is the
    // delimiter — find the FIRST occurrence after the 'mcp__' prefix.
    const sepIdx = toolName.indexOf('__', 5);
    if (sepIdx > 5) {
      source = 'mcp';
      mcpServer = toolName.slice(5, sepIdx);
      const owner = options?.mcpServers?.find((s) => s.name === mcpServer);
      // Conservative: anything other than "connected" treated as unavailable.
      if (owner && owner.status !== 'connected') {
        mcpUnavailable = true;
      }
    }
  }
  // The cebab_bus injection is identity-pinned by Cebab (`bus/runner.ts`).
  // Surface its origin distinctly so the operator can see it isn't from
  // their own MCP config.
  if (mcpServer === 'cebab_bus') {
    source = 'cebab-injected';
  }
  const denied = denyScope !== null || mcpUnavailable;
  const allowed = !denied && allowScope !== null;
  // Ruling priority: explicit deny > explicit allow > 'default'. When the
  // ruling came from an MCP cascade (not a settings-layer rule), we report
  // 'default' even if allow was granted at user/project/local — the deny
  // doesn't trace back to a visible rule.
  const rulingScope: ToolView['rulingScope'] = mcpUnavailable
    ? 'default'
    : (denyScope ?? allowScope ?? 'default');
  const view: ToolView = {
    name: toolName,
    source,
    allowed,
    denied,
    rulingScope,
  };
  if (mcpServer) view.mcpServer = mcpServer;
  return view;
}

/**
 * Scan every settings layer for `env:` keys matching the credential-class
 * list (`SCRUBBED_ENV_VAR_NAMES`). Returns one row per (envKey, scope)
 * tuple — the operator may have the same key declared at multiple layers
 * and the inspector needs to surface every one so edits don't miss a
 * sibling declaration.
 *
 * BE-B11: detection covers every credential-class key. BE-B12 [security]:
 * we never read the VALUE the operator put in `settings.json`; only the
 * key's presence + posture hint + whether `process.env` currently has
 * something for it. A screenshot of the AuthorityPanel must not leak the
 * operator's token.
 */
export function detectEnvInjections(layers: SettingsLayer[]): EnvInjection[] {
  const out: EnvInjection[] = [];
  const scrubbed = new Set(SCRUBBED_ENV_VAR_NAMES);
  for (const layer of layers) {
    if (!layer.data?.env) continue;
    for (const envKey of Object.keys(layer.data.env)) {
      // Register H05: this used to be `if (!scrubbed.has(envKey)) continue`,
      // i.e. only the five Anthropic/cloud-backend switches counted. But this
      // list is what `session_start_gate.awaitEnvInjectionAck` gates on, and
      // it returns immediately when the list is EMPTY — so a project
      // declaring `env: { GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, NPM_TOKEN }`
      // produced no gate, no operator prompt and no audit row, while the SDK
      // layered those values straight into the agent's spawn env.
      //
      // `isSensitiveKey` is the redactor's own key heuristic, shared rather
      // than re-implemented, so a name masked in a transcript is a name
      // prompted for here. Fail-closed by design: it will also match things
      // like AUTH_ENABLED or TOKEN_LIMIT, and asking about a non-credential
      // is a far cheaper mistake than silently shipping a real one.
      if (!scrubbed.has(envKey) && !isSensitiveKey(envKey)) continue;
      out.push({
        envKey,
        scope: layer.scope,
        scopePath: layer.scopePath,
        posture: SCRUBBED_ENV_POSTURES[envKey] ?? 'credential-class env injection',
        // Whether the operator's CURRENT process env has this key — orthogonal
        // to settings.json's declared value (which we deliberately never read).
        isSet: typeof process.env[envKey] === 'string' && process.env[envKey] !== '',
      });
    }
  }
  return out;
}

/**
 * Scan every settings layer for `hooks:` declarations. Per spec §11.1
 * (agentic-reviewer) the AuthorityPanel surfaces every hook so the
 * operator can see what's been pre-wired before committing to a session
 * start; UI-B40 force-expands the section when any hook is at the local
 * tier (least-trusted).
 *
 * SDK shape: `hooks: { [hookKind]: [{ hooks: [{ type, command, args }] }] }`
 * — the outer array is matcher buckets, the inner is concrete hook entries.
 * We flatten because the AuthorityPanel renders one card per concrete
 * entry regardless of matcher grouping.
 *
 * `binarySha` (sha256 of the resolved hook command's binary target) is
 * computed in Phase 4 alongside the TOFU MCP gate — Phase 3 just enumerates.
 */
export function detectHooks(layers: SettingsLayer[]): HookView[] {
  const out: HookView[] = [];
  for (const layer of layers) {
    if (!layer.data?.hooks) continue;
    for (const [hookKind, buckets] of Object.entries(layer.data.hooks)) {
      if (!Array.isArray(buckets)) continue;
      for (const bucket of buckets) {
        const entries = bucket?.hooks;
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (typeof entry.command !== 'string') continue;
          const view: HookView = {
            hookKind,
            scope: layer.scope,
            scopePath: layer.scopePath,
            command: entry.command,
          };
          if (Array.isArray(entry.args)) view.args = entry.args;
          out.push(view);
        }
      }
    }
  }
  return out;
}

/**
 * Project MCP servers from each settings layer into McpServerView rows.
 * Phase 3 attributes scope via SDK precedence (deepest wins) so a server
 * declared at user AND local gets one row attributed to local — matching
 * what the SDK actually uses. The `originPath` points at the winning
 * layer's settings file so the operator can `[Open settings.json]` on the
 * right file.
 *
 * Phase 4 fills in the TOFU fields (`trust`, `binarySha`, `firstSeenAt`,
 * `lastSeenAt`) via a JOIN against `mcp_trust` (see
 * `enrichWithTrustState`). Without the enrichment pass the row stays
 * `trust: 'unknown'` — the resolver's orchestrator always runs the JOIN,
 * but callers (tests, etc.) can use `detectMcpServers` alone if they
 * don't want the DB hit.
 *
 * Effective status (`status: 'connected' | 'needs-auth' | …`) is overlaid
 * from the cached `session_started.mcpServers` at merge time — settings
 * declarations alone can't say whether a server is actually running.
 */
export function detectMcpServers(layers: SettingsLayer[]): McpServerView[] {
  // Map<name, [scope, scopePath, config]> — last write wins (deepest scope).
  const byName = new Map<
    string,
    {
      scope: McpServerView['scope'];
      scopePath: string;
      config: { command?: string; args?: string[]; envKeys?: string[] };
    }
  >();
  for (const layer of layers) {
    if (!layer.data?.mcpServers) continue;
    for (const [name, conf] of Object.entries(layer.data.mcpServers)) {
      if (!conf) continue;
      const envKeys = conf.env ? Object.keys(conf.env) : undefined;
      const config: { command?: string; args?: string[]; envKeys?: string[] } = {};
      if (typeof conf.command === 'string') config.command = conf.command;
      if (Array.isArray(conf.args)) config.args = conf.args;
      if (envKeys && envKeys.length > 0) config.envKeys = envKeys;
      byName.set(name, { scope: layer.scope, scopePath: layer.scopePath, config });
    }
  }
  const out: McpServerView[] = [];
  for (const [name, entry] of byName.entries()) {
    const view: McpServerView = {
      name,
      // Overlaid by the merger when cached session_started is available.
      status: 'unknown',
      scope: entry.scope,
      originPath: entry.scopePath,
      tools: [],
      trust: 'unknown',
    };
    if (entry.config.command || entry.config.args || entry.config.envKeys) {
      view.config = entry.config;
    }
    out.push(view);
  }
  return out;
}

/**
 * Cluster B Phase 4 (§4.4): TOFU enrichment pass. For each declared MCP
 * server with a resolvable command, computes the binary sha and looks up
 * the trust state in `mcp_trust`. Mutates the views in-place and returns
 * them for chaining.
 *
 * Mapping from repository lookup → protocol enum:
 *   - `trusted` / `trusted_pinned_hash` → `trust: 'trusted'`
 *   - `denied_remember`                  → `trust: 'denied'`
 *   - `hash_changed`                     → `trust: 'hash_changed'`
 *   - `first_seen`                       → `trust: 'pending_tofu'`
 *
 * Cebab-injected servers (`scope: 'cebab-injected'`, e.g. `cebab_bus`)
 * are always `trust: 'trusted'` — Cebab pins them, no operator decision
 * is needed. They skip the lookup.
 *
 * `lastSeenAt` comes from `listForServer` (most-recent first). `firstSeenAt`
 * comes from `firstDecisionTs`, i.e. the append-only `safety_audit` chain —
 * NOT from the oldest surviving lookup row, which is a different question.
 * `mcp_trust` replaces rows it supersedes, so its oldest survivor answers
 * "the oldest decision not yet overwritten"; on the non-null-sha path that has
 * never equalled the first decision, and register D09's migration 033 makes the
 * null-sha path behave the same way. Both absent when the server has never had
 * a recorded decision.
 */
export function enrichWithTrustState(views: McpServerView[]): McpServerView[] {
  for (const view of views) {
    if (view.scope === 'cebab-injected') {
      view.trust = 'trusted';
      continue;
    }
    if (!view.originPath) continue;
    const candidateSha = view.config?.command ? computeBinarySha(view.config.command) : null;
    if (candidateSha !== null) view.binarySha = candidateSha;
    const lookup = checkTrust(view.name, view.originPath, candidateSha);
    switch (lookup.decision) {
      case 'trusted':
      case 'trusted_pinned_hash':
        view.trust = 'trusted';
        break;
      case 'denied_remember':
        view.trust = 'denied';
        break;
      case 'hash_changed':
        view.trust = 'hash_changed';
        break;
      case 'first_seen':
        view.trust = 'pending_tofu';
        break;
    }
    // Decision history → first/last seen, from the two sources that actually
    // answer each question: the lookup for "most recent", the audit chain for
    // "first ever".
    const history = listForServer(view.name, view.originPath);
    if (history.length > 0) {
      view.lastSeenAt = history[0].ts;
    }
    const firstTs = firstDecisionTs(view.name, view.originPath);
    if (firstTs !== null) {
      view.firstSeenAt = firstTs;
    }
  }
  return views;
}

/**
 * Cluster B Phase 10 (UI-B31 / spec §4.8): per-tool usage tally across every
 * session in a project.
 *
 * The "Used vs Available" inspector (`<ToolsList mode='usage-diff'>`) wants
 * two counters on every `ToolView`:
 *   - `calledCount` — how many times the SDK ran this tool (post-permission)
 *   - `deniedCount` — how many times the operator denied a request for it
 *
 * Both signals live in the `events` table, which already records every SDK
 * message via `persistMessage()`. We don't add new instrumentation — just an
 * aggregation pass (spec §4.8: "every tool call already produces an SDK
 * event with `tool_name + ts + result_status`. No new instrumentation;
 * just retention + aggregation."). Three event shapes feed the tally:
 *
 *   - `type='assistant'` rows whose `message.content` contains a
 *     `tool_use` block — the SDK actually invoked the tool. Each block
 *     bumps `calledCount[name]`.
 *   - `type='wrapper' subtype='permission_request'` rows carry
 *     `{ requestId, toolName }` — we index them so we can resolve a
 *     denial's `requestId` back to a tool name.
 *   - `type='wrapper' subtype='permission_decided'` rows carry
 *     `{ requestId, decision }` — when `decision === 'deny'`, we look up
 *     the toolName via the requestId index and bump `deniedCount[name]`.
 *
 * The two passes happen in a single SQL fetch + JS aggregation. We
 * deliberately don't try to surface "SDK refused at runtime" denials
 * (tool_result with is_error=true) — those are usually input-shape
 * failures rather than authorization signals and would muddy the
 * "Attempted-but-denied" column the operator reads for trust intent.
 *
 * Stream events are excluded from `events` (see `persistMessage()` line
 * 23-24 — `stream_event` short-circuits before insert), so we don't
 * double-count tool_use blocks that arrive both as deltas and again in
 * the final assistant message.
 *
 * Sessions with no events (newly-created) contribute zero rows. Projects
 * with no sessions return an empty Map — the resolver then leaves every
 * `ToolView.calledCount` / `deniedCount` undefined, which the
 * AuthorityPanel renders as "(no usage yet)" rather than zero badges.
 */
export type ToolUsageTally = Map<string, { calledCount: number; deniedCount: number }>;

export function tallyToolUsage(projectId: number): ToolUsageTally {
  const sessions = listSessionsForProject(projectId);
  if (sessions.length === 0) return new Map();
  const sessionIds = sessions.map((s) => s.id);
  // Bind every session id as a positional parameter — better-sqlite3 won't
  // bind an array in a single placeholder, so we expand. The list is
  // bounded by the operator's per-project session count (typically <100).
  const placeholders = sessionIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare<string[], { type: string; subtype: string | null; raw: string }>(
      `SELECT type, subtype, raw FROM events
        WHERE session_id IN (${placeholders})
          AND (
            type = 'assistant'
            OR (type = 'wrapper' AND (subtype = 'permission_request' OR subtype = 'permission_decided'))
          )`,
    )
    .all(...sessionIds);

  const tally: ToolUsageTally = new Map();
  const reqToTool = new Map<string, string>();

  for (const r of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(r.raw);
    } catch {
      // A row with non-JSON raw is broken at persistence time; skip rather
      // than poison the tally for one bad row.
      continue;
    }

    if (r.type === 'assistant') {
      // SDK shape: { type: 'assistant', message: { content: ContentBlock[] }, ... }
      const content = (payload as { message?: { content?: unknown } })?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (
          block &&
          typeof block === 'object' &&
          (block as { type?: unknown }).type === 'tool_use' &&
          typeof (block as { name?: unknown }).name === 'string'
        ) {
          bumpCalled(tally, (block as { name: string }).name);
        }
      }
    } else if (r.type === 'wrapper' && r.subtype === 'permission_request') {
      const p = payload as { requestId?: unknown; toolName?: unknown };
      if (typeof p.requestId === 'string' && typeof p.toolName === 'string') {
        reqToTool.set(p.requestId, p.toolName);
      }
    } else if (r.type === 'wrapper' && r.subtype === 'permission_decided') {
      const p = payload as { requestId?: unknown; decision?: unknown };
      if (p.decision === 'deny' && typeof p.requestId === 'string') {
        const toolName = reqToTool.get(p.requestId);
        if (toolName) bumpDenied(tally, toolName);
      }
    }
  }
  return tally;
}

function bumpCalled(t: ToolUsageTally, name: string): void {
  const cur = t.get(name);
  if (cur) cur.calledCount += 1;
  else t.set(name, { calledCount: 1, deniedCount: 0 });
}

function bumpDenied(t: ToolUsageTally, name: string): void {
  const cur = t.get(name);
  if (cur) cur.deniedCount += 1;
  else t.set(name, { calledCount: 0, deniedCount: 1 });
}

/**
 * Cluster B Phase 3 (BE-B3): resolver entry point. Given a `projectId` and
 * (optionally) the most recent `session_started` snapshot the WS layer has
 * cached for any session in this project, return the merged
 * `ProjectAuthority` envelope.
 *
 * Cache-miss behavior: when `latestSessionStarted` is undefined, the
 * resolver still returns a snapshot — populated from file-read scans only.
 * Tools / agents / slash_commands / skills / plugins come from the SDK
 * init payload, so they'll be empty (the AuthorityPanel renders
 * "Authority snapshot unavailable; start a session to populate" in that
 * case). The settings-declared data (MCP servers, env injections, hooks,
 * allow/deny rules) is still useful pre-flight.
 *
 * Probe mode (`mode === 'probe'`) is handled by the CALLER, not here: the WS
 * `get_project_authority` handler runs `probeSessionStarted` and writes the
 * result into the same per-connection cache a real turn fills, then calls this
 * resolver unchanged. This function stays synchronous and file-read-only, and
 * `mode` is carried on the input only so the envelope can report which kind of
 * resolve produced it.
 */
export type ResolverInput = {
  projectId: number;
  mode: 'cache' | 'probe';
  /**
   * Scope set to resolve against. Omit for the trust-derived default, which
   * is what the AuthorityPanel and the single-agent spawn gate want.
   *
   * A BUS spawn gate must pass `BUS_SETTING_SCOPES` — bus participants run
   * with all three layers regardless of Trust, so resolving trust-derived
   * here would hand the gates an empty MCP/env list for an untrusted project
   * whose rules the SDK then loads anyway.
   */
  settingSources?: readonly SettingScope[];
  latestSessionStarted?: {
    tools?: string[];
    model?: string;
    apiKeySource?: string;
    permissionMode?: string;
    cwd?: string;
    mcpServers?: { name: string; status: string }[];
    slashCommands?: string[];
    skills?: string[];
    agents?: string[];
    plugins?: { name: string; path: string }[];
  };
};

export function resolveProjectAuthority(input: ResolverInput): ProjectAuthority | null {
  const project = getProject(input.projectId);
  if (!project) return null;

  const trusted = project.trusted === 1;
  const scopes = input.settingSources ?? trustDerivedScopes(trusted);
  const layers = loadSettingsLayers(project.path, scopes);
  const settingSourcesUsed = layers.map((l) => l.scope);

  // MCP servers: declared shape from layers, overlaid with effective status
  // from the cached session_started (when present).
  //
  // `.mcp.json` is merged in FIRST and wins on a name collision, because it is
  // the declaration that actually loads — a same-named `mcpServers` entry in
  // `.claude/settings.json` describes a server the CLI never starts (see
  // `readMcpJsonServers`). Letting the settings row win would anchor the trust
  // decision to the wrong file and the wrong binary path.
  const declaredMcp = detectMcpServers(layers);
  // `~/.claude.json` is merged on the same rule and for the same reason: both
  // it and `.mcp.json` are measured to load, and a settings row of the same
  // name is a declaration the CLI never starts. `.mcp.json` is applied LAST so
  // it wins a collision between the two loading files — an arbitrary but fixed
  // choice (which one the CLI itself prefers on a duplicate name is not
  // measured), and it preserves the precedence that shipped first.
  for (const fromLoadingFile of [
    ...readClaudeJsonServers(project.path, scopes),
    ...readMcpJsonServers(project.path, scopes),
  ]) {
    const clash = declaredMcp.findIndex((d) => d.name === fromLoadingFile.name);
    if (clash >= 0) declaredMcp.splice(clash, 1);
    declaredMcp.push(fromLoadingFile);
  }
  const initMcp = input.latestSessionStarted?.mcpServers ?? [];
  for (const dm of declaredMcp) {
    const init = initMcp.find((m) => m.name === dm.name);
    if (init) dm.status = init.status;
  }
  // SDK-reported servers that aren't in any settings layer get appended.
  //
  // `scope: 'cebab-injected'` means "Cebab itself injected this", and
  // `enrichWithTrustState` grants those `trust: 'trusted'` unconditionally
  // while `mcp_trust_gate` skips them entirely. So the label must be reserved
  // for servers Cebab actually injects — otherwise a server merely OBSERVED in
  // a prior session's `session_started` (e.g. a project-scope one that the
  // trust-truncated layer read missed) gets laundered into permanently
  // trusted-and-never-prompted.
  //
  // Anything else unattributable stays `scope: 'unknown'` + `trust: 'unknown'`
  // so it is visible in the panel.
  //
  // STILL NOT GATED, and the class that reaches here has shrunk twice. An
  // appended row has no `originPath`, so `awaitMcpTrustDecisions` skips it at
  // the `!server.originPath` check, and its `trust: 'unknown'` would hit the
  // silent-continue case immediately after anyway. (An earlier version of this
  // comment claimed these "still reach TOFU" — they never did.)
  //
  // `readMcpJsonServers` removed project-declared servers from this class;
  // `readClaudeJsonServers` removed the `claude mcp add` ones at both scopes,
  // which register x1n.6.23 correctly guessed were the bulk of the remainder.
  // What is left is servers with NO on-disk declaration Cebab can find —
  // plugin-provided ones, and anything a future CLI loads from a location not
  // in the measured table above. Those genuinely have no durable anchor to key
  // `(server_name, origin_path, binary_sha)` on, so they stay visible-but-
  // ungated by design rather than by omission.
  for (const im of initMcp) {
    if (!declaredMcp.some((d) => d.name === im.name)) {
      const isCebabInjected = CEBAB_INJECTED_MCP_NAMES.has(im.name);
      declaredMcp.push({
        name: im.name,
        status: im.status,
        scope: isCebabInjected ? 'cebab-injected' : 'unknown',
        tools: [],
        trust: 'unknown',
      });
    }
  }
  // Phase 4 (§4.4): JOIN against mcp_trust to populate per-row TOFU
  // state. Runs after the cebab-injected append so those rows get
  // 'trusted' via the same pass (no operator decision needed for
  // Cebab-pinned servers).
  enrichWithTrustState(declaredMcp);

  // Tools: every tool name the SDK reported, attributed against layers +
  // MCP availability. When the cache is empty, no tools are resolved
  // (operator opens an empty Tools section).
  const initTools = input.latestSessionStarted?.tools ?? [];
  const tools: ToolView[] = initTools.map((t) =>
    resolveToolAuthority(t, layers, { mcpServers: declaredMcp }),
  );

  // Cluster B Phase 10 (UI-B31 / spec §4.8): attach the usage tally so the
  // ToolsList's usage-diff mode can render Used + Attempted-but-denied
  // counts per tool. Tally walks the project's persisted `events` rows;
  // missing names in `initTools` (e.g. a tool the operator denied that
  // was later removed from the SDK's surface) are silently ignored — the
  // operator can still see total denies for the current surface, which is
  // the most-asked question. A future enhancement could surface "denied
  // but no longer on surface" as its own row when that edge case matters.
  const tally = tallyToolUsage(input.projectId);
  for (const tool of tools) {
    const counts = tally.get(tool.name);
    if (!counts) continue;
    // Leave undefined when zero so the AuthorityPanel can distinguish
    // "tool exists on surface but nobody has tried it" from "tool was
    // tried zero times" — both are the same number but the former is the
    // expected default and shouldn't paint a chip.
    if (counts.calledCount > 0) tool.calledCount = counts.calledCount;
    if (counts.deniedCount > 0) tool.deniedCount = counts.deniedCount;
  }

  const out: ProjectAuthority = {
    projectId: input.projectId,
    capturedAt: Date.now(),
    fromProbe: input.mode === 'probe',
    // Empty and unmeasured are different facts. Without this the panel had to
    // guess from `model === undefined`, and guessed wrong in the direction
    // that asserts the project has nothing.
    sdkSnapshot: input.latestSessionStarted !== undefined,
    settingSourcesUsed,
    tools,
    mcpServers: declaredMcp,
    slashCommands: input.latestSessionStarted?.slashCommands ?? [],
    skills: input.latestSessionStarted?.skills ?? [],
    agents: input.latestSessionStarted?.agents ?? [],
    plugins: input.latestSessionStarted?.plugins ?? [],
    hooks: detectHooks(layers),
    detectedEnvInjections: detectEnvInjections(layers),
  };
  // Pick-through cached single-value fields.
  if (input.latestSessionStarted?.model !== undefined) {
    out.model = input.latestSessionStarted.model;
  }
  if (input.latestSessionStarted?.apiKeySource !== undefined) {
    out.apiKeySource = input.latestSessionStarted.apiKeySource;
  }
  if (input.latestSessionStarted?.permissionMode !== undefined) {
    out.permissionMode = input.latestSessionStarted.permissionMode;
  }
  if (input.latestSessionStarted?.cwd !== undefined) {
    out.cwd = input.latestSessionStarted.cwd;
  }
  return out;
}

// Re-exported for the resolver test suite — they don't need a real DB and
// pass settings layers directly.
export const _testing = {
  loadSettingsLayers,
  readSettingsFile,
  readMcpJsonServers,
  readClaudeJsonServers,
  USER_SCOPE_PATH,
};
