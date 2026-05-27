import { query, type Options, type Query } from '@anthropic-ai/claude-agent-sdk';

export type SettingSource = NonNullable<Options['settingSources']>[number];

export type RunOptions = {
  cwd: string;
  prompt: string;
  /** Pre-assigned session UUID. Required for new sessions; omit when resuming. */
  sessionId?: string;
  /** Resume an existing session by UUID. Mutually exclusive with sessionId. */
  resume?: string;
  /** Override permission mode. Default: "default" (asks via canUseTool). */
  permissionMode?: Options['permissionMode'];
  /** Permission callback. Required unless permissionMode is "bypassPermissions" / "acceptEdits" covers everything. */
  canUseTool?: Options['canUseTool'];
  /** Token-by-token deltas via stream_event. Default: true. */
  includePartialMessages?: boolean;
  /** Hard turn cap. */
  maxTurns?: number;
  /** Which scopes of settings.json the SDK should layer. Default: ['user']. */
  settingSources?: SettingSource[];
  /** In-process MCP servers (e.g. the multi-agent `bus_send` tool). */
  mcpServers?: Options['mcpServers'];
  /** Required by the SDK when permissionMode is 'bypassPermissions'. */
  allowDangerouslySkipPermissions?: boolean;
  /** External cancellation. */
  abortController?: AbortController;
};

/**
 * Auth-precedence env vars that override OAuth subscription. The Anthropic
 * CLI prefers `ANTHROPIC_API_KEY` over subscription, so a stray
 * `export ANTHROPIC_API_KEY=...` in `.zshrc` would silently route us through
 * paid billing; the Bedrock/Vertex/Foundry flags switch backends entirely.
 *
 * The list is exported so the WS layer can surface `getScrubbedEnvVars()`
 * on every attach (Cluster A Phase 3, BE-10/E1) — names only, never values.
 */
export const SCRUBBED_ENV_VAR_NAMES: ReadonlyArray<string> = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

/**
 * Cluster B Phase 3: human-readable posture hints for the credential-class
 * env keys. Used by `repo/project_authority.ts`'s `detectEnvInjections`
 * scan so the AuthorityPanel can render "Subscription auth" / "Bedrock
 * backend" labels rather than just the env-var name.
 *
 * Pinned next to `SCRUBBED_ENV_VAR_NAMES` so a future addition to that
 * list forces a matching posture string (CI catches the missing key via
 * the resolver's typecheck — `detectEnvInjections` looks up by name).
 *
 * NAMES only — never values. BE-B12 [security] invariant.
 */
export const SCRUBBED_ENV_POSTURES: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: 'Subscription auth (API key would override OAuth)',
  ANTHROPIC_AUTH_TOKEN: 'Subscription auth (bearer token would override OAuth)',
  CLAUDE_CODE_USE_BEDROCK: 'Bedrock backend (re-routes off Anthropic API)',
  CLAUDE_CODE_USE_VERTEX: 'Vertex backend (re-routes off Anthropic API)',
  CLAUDE_CODE_USE_FOUNDRY: 'Foundry backend (re-routes off Anthropic API)',
};

/**
 * Strip every env var that would override OAuth subscription auth.
 */
function subscriptionOnlyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const blocked = new Set(SCRUBBED_ENV_VAR_NAMES);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (blocked.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Cluster A Phase 3 (E1, UX-5): return the names of `SCRUBBED_ENV_VAR_NAMES`
 * that were actually present in `env`. Used by the WS env_scrubbed emission
 * on every attach — names only, never values, so a screenshot of the toast
 * can't leak the operator's token. Returns `[]` if none were set, so the
 * dispatcher can short-circuit the emit.
 */
export function getScrubbedEnvVars(env: NodeJS.ProcessEnv): string[] {
  return SCRUBBED_ENV_VAR_NAMES.filter((name) => typeof env[name] === 'string' && env[name] !== '');
}

export function runClaude(opts: RunOptions): Query {
  const options: Options = {
    cwd: opts.cwd,
    env: subscriptionOnlyEnv(process.env),
    // Default is intentionally narrow: only ~/.claude/settings.json is layered in.
    // The WS layer widens to ['user', 'project', 'local'] only for trusted projects
    // so a hostile sibling repo's `.claude/settings.local.json` can't auto-load
    // hooks the moment the user clicks it. Don't widen here without revisiting Trust.
    settingSources: opts.settingSources ?? ['user'],
    includePartialMessages: opts.includePartialMessages ?? true,
    permissionMode: opts.permissionMode ?? 'default',
    canUseTool: opts.canUseTool,
    abortController: opts.abortController,
  };
  if (opts.sessionId) options.sessionId = opts.sessionId;
  if (opts.resume) options.resume = opts.resume;
  if (opts.maxTurns !== undefined) options.maxTurns = opts.maxTurns;
  if (opts.mcpServers) options.mcpServers = opts.mcpServers;
  if (opts.allowDangerouslySkipPermissions) options.allowDangerouslySkipPermissions = true;

  return query({ prompt: opts.prompt, options });
}
