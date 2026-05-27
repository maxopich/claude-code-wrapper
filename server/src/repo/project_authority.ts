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
import { SCRUBBED_ENV_POSTURES, SCRUBBED_ENV_VAR_NAMES } from '../runner/claude.js';
import { getProject } from './projects.js';

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

type SettingsLayer = {
  scope: 'user' | 'project' | 'local';
  scopePath: string;
  data: RawSettings | null;
};

const USER_SCOPE_PATH = path.join(os.homedir(), '.claude', 'settings.json');

/**
 * Read + parse a `.claude/settings.json` (or `.claude/settings.local.json`).
 * Returns `null` for "file absent" and "file unreadable" alike — the
 * inspector treats both as "no rules from this scope" (vs. a noisy error).
 * Malformed JSON logs a console.warn so a misconfigured operator notices
 * once on session start.
 */
function readSettingsFile(p: string): RawSettings | null {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) as RawSettings;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    console.warn(`[project_authority] could not read ${p}: ${String(e)}`);
    return null;
  }
}

/**
 * Collect the three settings layers for a project. User scope is always
 * read (whether the project is trusted or not — `~/.claude/settings.json`
 * is operator-controlled). Project + local scopes are only read for
 * trusted projects, matching the SDK's settingSources widening — see
 * `runner/claude.ts:76-80`. The inspector's `settingSourcesUsed` field
 * reflects this so the AuthorityPanel doesn't lie about layers that
 * weren't actually applied.
 */
function loadSettingsLayers(projectPath: string, trusted: boolean): SettingsLayer[] {
  const layers: SettingsLayer[] = [
    { scope: 'user', scopePath: USER_SCOPE_PATH, data: readSettingsFile(USER_SCOPE_PATH) },
  ];
  if (trusted) {
    const projectScopePath = path.join(projectPath, '.claude', 'settings.json');
    const localScopePath = path.join(projectPath, '.claude', 'settings.local.json');
    layers.push({
      scope: 'project',
      scopePath: projectScopePath,
      data: readSettingsFile(projectScopePath),
    });
    layers.push({
      scope: 'local',
      scopePath: localScopePath,
      data: readSettingsFile(localScopePath),
    });
  }
  return layers;
}

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
      if (!scrubbed.has(envKey)) continue;
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
 * TOFU fields (`trust`, `binarySha`, `firstSeenAt`, `lastSeenAt`) are
 * Phase 4 — Phase 3 marks every row `trust: 'unknown'` so the
 * AuthorityPanel renders no trust badge yet.
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
 * Probe mode (`mode === 'probe'`) is Phase 3b — for now it falls through
 * to cache behavior with an info log so reviewers can verify the path is
 * wired without spawning the SDK. The protocol type already accepts both
 * modes so Phase 3b is a pure server-side change.
 */
export type ResolverInput = {
  projectId: number;
  mode: 'cache' | 'probe';
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

  if (input.mode === 'probe') {
    // Phase 3b will spawn a `maxTurns: 0` SDK run here. Until then, fall
    // through to cache behavior so the wire round-trip works end-to-end.
    console.log(
      `[project_authority] probe mode requested for project ${input.projectId}; falling through to cache (Phase 3b lands SDK spawn)`,
    );
  }

  const trusted = project.trusted === 1;
  const layers = loadSettingsLayers(project.path, trusted);
  const settingSourcesUsed = layers.map((l) => l.scope);

  // MCP servers: declared shape from layers, overlaid with effective status
  // from the cached session_started (when present).
  const declaredMcp = detectMcpServers(layers);
  const initMcp = input.latestSessionStarted?.mcpServers ?? [];
  for (const dm of declaredMcp) {
    const init = initMcp.find((m) => m.name === dm.name);
    if (init) dm.status = init.status;
  }
  // SDK-reported servers that aren't in any settings layer (e.g. the
  // cebab_bus injection) get appended with scope='cebab-injected'.
  for (const im of initMcp) {
    if (!declaredMcp.some((d) => d.name === im.name)) {
      declaredMcp.push({
        name: im.name,
        status: im.status,
        scope: 'cebab-injected',
        tools: [],
        trust: 'unknown',
      });
    }
  }

  // Tools: every tool name the SDK reported, attributed against layers +
  // MCP availability. When the cache is empty, no tools are resolved
  // (operator opens an empty Tools section).
  const initTools = input.latestSessionStarted?.tools ?? [];
  const tools: ToolView[] = initTools.map((t) =>
    resolveToolAuthority(t, layers, { mcpServers: declaredMcp }),
  );

  const out: ProjectAuthority = {
    projectId: input.projectId,
    capturedAt: Date.now(),
    fromProbe: false,
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
  USER_SCOPE_PATH,
};
