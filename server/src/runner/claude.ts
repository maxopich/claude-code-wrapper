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
  /**
   * Model to run this turn on — an id or an alias, passed through verbatim to
   * the SDK's `Options.model`.
   *
   * ABSENT IS NOT THE SAME AS 'default'. Omitting this leaves the key off the
   * options object entirely, which is what makes an operator who has chosen
   * nothing byte-identical to Cebab before model selection existed. The CLI's
   * own catalogue does contain a row whose value is the literal string
   * `'default'`; resolving that row to `undefined` (not to that string) is the
   * caller's job — see `resolveModel` in `ws/server.ts`.
   */
  model?: string;
  /**
   * A COMPLETE REPLACEMENT for this turn's system prompt. One caller: the
   * built-in help assistant (`ASSISTANT_SYSTEM_PROMPT` in
   * `assistant/identity.ts`), which is a different product with its own
   * identity and deliberately does not want Claude Code's instructions.
   *
   * DO NOT reach for this to add a line. It replaces everything — measured:
   * `system_prompt_smoke.ts`'s sentinel case sets a string here and the agent
   * then answers only the sentinel, having lost the tool guidance, the working
   * directory and the rest. Use `systemPromptAppend` instead, which cannot do
   * that.
   *
   * WHY THAT WARNING IS NOT THEORETICAL (`Cebab-6s27`). This field's previous
   * doc said writing here was ADDITIVE, on the measured premise that an ordinary
   * turn ran with an empty system prompt so there was nothing to destroy. That
   * premise stopped holding: an ordinary turn now carries Claude Code's real
   * prompt, and the MCP status note — a paragraph about one broken server — was
   * on course to replace the agent's entire instruction set on exactly the turns
   * where something was already wrong. The lesson kept here on purpose: a safety
   * property that rests on a measured external behaviour needs the measurement
   * re-run, not remembered.
   */
  systemPrompt?: string;
  /**
   * Text Cebab ADDS to this turn's system prompt, after Claude Code's own.
   *
   * Reaches the SDK as the `append` field of
   * `{ type: 'preset', preset: 'claude_code', append }`, so it is structurally
   * incapable of replacing anything — which is the entire reason it exists as a
   * separate field from `systemPrompt` above rather than as a convention about
   * how that one is used.
   *
   * Ignored when `systemPrompt` is set: a full override has nothing to append
   * to. The help assistant is the only caller that does so, and it wants none.
   */
  systemPromptAppend?: string;
  /**
   * The base set of built-in tools this turn may use (SDK `Options.tools`).
   *
   * Accepts the SDK's full shape — a `string[]` of tool names, `[]` to disable
   * every built-in, or the `{ type: 'preset'; preset: 'claude_code' }` object.
   * The Cebab-owned assistant passes `['Read', 'Glob', 'Grep']` so a help turn
   * can read its knowledge base and nothing else; ordinary/bus runs omit it and
   * inherit the CLI's default toolset unchanged.
   *
   * Guarded by `!== undefined`, NOT truthiness: `[]` is a meaningful value
   * ("no built-in tools") and is truthy anyway, so a truthiness check would
   * read as "if there are tools" and mislead. Absent unless the caller asks.
   */
  tools?: Options['tools'];
  /**
   * Which skills the SDK enables for this turn (SDK `Options.skills`).
   *
   * OMITTING THIS IS NOT "SKILLS OFF": per the SDK docs an omitted `skills`
   * applies no SDK auto-configuration and the CLI's own defaults still surface
   * skills. To actually hide every skill from the model — as the assistant
   * does — the caller passes `[]` (enable only the listed skills; none). That
   * empty array must survive to the SDK, so this too is guarded by `!== undefined`.
   */
  skills?: Options['skills'];
  /** In-process MCP servers (e.g. the multi-agent `bus_send` tool). */
  mcpServers?: Options['mcpServers'];
  /**
   * Tool names removed from the model's context entirely (SDK `disallowedTools`
   * — the model cannot call them even if it would otherwise be allowed). Used to
   * hard-lock the bus orchestrator to delegation-only (no file/shell/analysis
   * tools). Works in any permission mode.
   */
  disallowedTools?: string[];
  /**
   * Register H04: MCP server NAMES the operator denied at the TOFU gate.
   *
   * Before this existed, a denial was persisted and audited and then ignored —
   * the operator clicked Deny and the binary loaded anyway. Callers pass the
   * names; `runClaude` owns how they are enforced, so no call site can get
   * half of it right.
   *
   * Two layers, both measured against SDK 0.3.201 with a real MCP stdio
   * server (reading `system/init.mcp_servers`):
   *
   *   settings.deniedMcpServers  → server ABSENT from mcp_servers, tools 0.
   *                                The process never starts. The real gate.
   *   disallowedTools mcp__x__*  → server still 'connected', tools 0. Strips
   *                                the tools but does NOT stop startup side
   *                                effects. Defense-in-depth only.
   *
   * Passed through the SDK's inline `settings` (flag) layer, so nothing is
   * written to disk — the CLAUDE.md "Cebab writes nothing into the operator
   * project" guarantee is preserved.
   */
  deniedMcpServers?: string[];
  /** Required by the SDK when permissionMode is 'bypassPermissions'. */
  allowDangerouslySkipPermissions?: boolean;
  /** External cancellation. */
  abortController?: AbortController;
};

/**
 * Auth-precedence env vars that override OAuth subscription. The Anthropic
 * CLI prefers `ANTHROPIC_API_KEY` over subscription, so a stray
 * `export ANTHROPIC_API_KEY=...` in `.zshrc` would silently route us through
 * paid billing; the backend flags switch backends entirely.
 *
 * The set is the CLI's OWN auth-precedence enumeration, not a subset. The
 * bundled binary's credential-env array is `[ANTHROPIC_API_KEY,
 * ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, AWS_BEARER_TOKEN_BEDROCK,
 * ANTHROPIC_FOUNDRY_API_KEY, ANTHROPIC_FOUNDRY_AUTH_TOKEN, ANTHROPIC_AWS_API_KEY]`
 * and its backend-flag check covers `CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY,
 * ANTHROPIC_AWS,ANTHROPIC_GOOGLE_CLOUD,MANTLE,GATEWAY}` plus the OAuth-token
 * file descriptor, the WIF pair and the unix socket.
 *
 * `GATEWAY` WAS MISSING UNTIL Cebab-m99x, and the way it was missed is the
 * reason the test beside this list changed shape. The claim above — "the CLI's
 * OWN enumeration, not a subset" — was checked by a test that compared this
 * constant against a HAND-COPIED list, so the two agreed with each other and
 * neither was compared to the CLI. `claude.env_scrubbed.test.ts` now extracts
 * the switch names from the shipped bundle instead, which is what makes the
 * sentence above a measurement rather than an intention.
 *
 * The same bundle array also carries backend CONFIGURATION —
 * `ANTHROPIC_VERTEX_PROJECT_ID`, `ANTHROPIC_AWS_WORKSPACE_ID`,
 * `ANTHROPIC_GOOGLE_CLOUD_{PROJECT,LOCATION,WORKSPACE_ID}`,
 * `ANTHROPIC_FOUNDRY_RESOURCE`, `CLOUD_ML_REGION`. Those are deliberately NOT
 * scrubbed: none of them selects a backend on its own, they are inert unless
 * the matching `CLAUDE_CODE_USE_*` switch is set, and every one of those is
 * stripped here. Scrubbing them too would widen the operator-facing
 * `getScrubbedEnvVars()` report with names that cannot re-route a spawn. The strongest case is
 * `CLAUDE_CODE_OAUTH_TOKEN`: the CLI documents `export CLAUDE_CODE_OAUTH_TOKEN=…`
 * (from `claude setup-token`) as the non-interactive auth path, and its
 * auth-source resolver returns `{source:"CLAUDE_CODE_OAUTH_TOKEN"}` BEFORE it
 * reaches the persisted `~/.claude/.credentials.json` OAuth session — so a
 * stray export authenticates every spawn as the token's identity, not the
 * operator's subscription. Any name left off here passes through
 * `subscriptionOnlyEnv()` untouched (the SDK REPLACES the child env wholesale),
 * so the omission is the bug — the list must track the CLI's behaviour.
 *
 * The list is exported so the WS layer can surface `getScrubbedEnvVars()`
 * on every attach (Cluster A Phase 3, BE-10/E1) — names only, never values.
 */
export const SCRUBBED_ENV_VAR_NAMES: ReadonlyArray<string> = [
  // Credential-class env keys the CLI honours over the stored OAuth session.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_AWS_API_KEY',
  // WIF (workload-identity federation) pair — the CLI's own error text names
  // `ANTHROPIC_FEDERATION_RULE_ID + ANTHROPIC_ORGANIZATION_ID` as the WIF vars.
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
  // Alternate transport the CLI dials instead of the default endpoint.
  'ANTHROPIC_UNIX_SOCKET',
  // Backend switches that re-route off the Anthropic API entirely.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
];

/**
 * Cluster B Phase 3: human-readable posture hints for the credential-class
 * env keys. Used by `repo/project_authority.ts`'s `detectEnvInjections`
 * scan so the AuthorityPanel can render "Subscription auth" / "Bedrock
 * backend" labels rather than just the env-var name.
 *
 * Pinned next to `SCRUBBED_ENV_VAR_NAMES` so a future addition to that list
 * forces a matching posture string. `Cebab-6fax.8`: this used to claim CI
 * caught a missing key "via the resolver's typecheck". It did not and could
 * not — the map is a `Record<string, string>` and the one read site
 * (`project_authority.ts`) has a `?? 'credential-class env injection'`
 * fallback, so a missing key was a silently vaguer posture label, at runtime,
 * forever. `claude.env_scrubbed.test.ts` asserts the parity now, which is the
 * same answer that file already gives for the list itself: where a checker
 * cannot be a type, make it a test rather than a sentence.
 *
 * NAMES only — never values. BE-B12 [security] invariant.
 */
export const SCRUBBED_ENV_POSTURES: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: 'Subscription auth (API key would override OAuth)',
  ANTHROPIC_AUTH_TOKEN: 'Subscription auth (bearer token would override OAuth)',
  CLAUDE_CODE_OAUTH_TOKEN: 'Subscription auth (setup-token would override OAuth)',
  CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR:
    'Subscription auth (setup-token FD would override OAuth)',
  AWS_BEARER_TOKEN_BEDROCK: 'Bedrock backend (bearer token re-routes off Anthropic API)',
  ANTHROPIC_FOUNDRY_API_KEY: 'Foundry backend (API key re-routes off Anthropic API)',
  ANTHROPIC_FOUNDRY_AUTH_TOKEN: 'Foundry backend (bearer token re-routes off Anthropic API)',
  ANTHROPIC_AWS_API_KEY: 'AWS backend (API key re-routes off Anthropic API)',
  ANTHROPIC_FEDERATION_RULE_ID: 'WIF auth (federation identity would override OAuth)',
  ANTHROPIC_ORGANIZATION_ID: 'WIF auth (federation identity would override OAuth)',
  ANTHROPIC_UNIX_SOCKET: 'Alternate transport (dials a socket instead of the API endpoint)',
  CLAUDE_CODE_USE_BEDROCK: 'Bedrock backend (re-routes off Anthropic API)',
  CLAUDE_CODE_USE_VERTEX: 'Vertex backend (re-routes off Anthropic API)',
  CLAUDE_CODE_USE_FOUNDRY: 'Foundry backend (re-routes off Anthropic API)',
  CLAUDE_CODE_USE_ANTHROPIC_AWS: 'AWS backend (re-routes off Anthropic API)',
  CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: 'Google Cloud backend (re-routes off Anthropic API)',
  CLAUDE_CODE_USE_MANTLE: 'Mantle backend (re-routes off Anthropic API)',
  CLAUDE_CODE_USE_GATEWAY: 'Gateway backend (re-routes off Anthropic API)',
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

/**
 * Register H04: turn denied MCP server names into the two SDK knobs that
 * enforce them. Exported so tests can assert the exact shape without spawning.
 *
 * Returns `{}` for an empty list so a run with no denials is byte-identical to
 * before — the common case must not gain a `settings` layer it didn't have.
 */
export function mcpDenialOptions(names: readonly string[] | undefined): {
  settings?: Options['settings'];
  disallowedTools?: string[];
} {
  if (!names || names.length === 0) return {};
  // De-duplicate: the same server can be refused for two reasons in one pass
  // (a persisted denied_remember AND a per-session deny_once).
  const unique = [...new Set(names)];
  return {
    settings: { deniedMcpServers: unique.map((serverName) => ({ serverName })) },
    // Server-level wildcard is native SDK syntax (`mcp__server__*` removes
    // every tool from that server) — no need to enumerate tool names.
    disallowedTools: unique.map((n) => `mcp__${n}__*`),
  };
}

/**
 * Assemble the SDK options object for a run. Split out of `runClaude` so it can
 * be asserted directly: `query()` is never mocked anywhere in this repo, so
 * until this existed NOTHING covered the assembly below — not the `??`
 * defaults, not the conditional assignments, not the `disallowedTools` union.
 * Same reasoning as `mcpDenialOptions` above and `resolveMaxTurns` in the WS
 * layer: the shape a spawn depends on gets pinned by a test, not by a comment.
 *
 * The two idioms here are load-bearing and deliberately different. Keys in the
 * literal are ALWAYS present (some with `??` defaults); keys assigned below it
 * are absent unless the caller asked for them. Moving a field from the second
 * group to the first would send `undefined` where the SDK currently sees
 * nothing at all.
 */
export function buildSdkOptions(opts: RunOptions): Options {
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
  // H04: fold the operator's MCP denials in. Union with any caller-supplied
  // `disallowedTools` (the bus orchestrator's delegate-only lock) rather than
  // overwriting either — both restrictions must survive together.
  const denial = mcpDenialOptions(opts.deniedMcpServers);
  const allDisallowed = [...(opts.disallowedTools ?? []), ...(denial.disallowedTools ?? [])];
  if (allDisallowed.length > 0) options.disallowedTools = allDisallowed;
  if (denial.settings) options.settings = denial.settings;
  if (opts.allowDangerouslySkipPermissions) options.allowDangerouslySkipPermissions = true;
  // Truthiness, not `!== undefined`: an empty string is not a model, and the
  // key must stay ABSENT rather than become `undefined` when nothing is chosen.
  if (opts.model) options.model = opts.model;
  // `Cebab-6s27`: the system prompt is now always set EXPLICITLY, and that is
  // the point of the change rather than a detail of it. Omitting the option was
  // never "use the CLI's default" — it resolved to whatever the SDK's normalizer
  // did that release, which moved under us once already and took a documented
  // safety property with it. Cebab states its posture instead of inheriting one.
  //
  // Two shapes, and only the assistant gets the first:
  //   a string  → a COMPLETE replacement (the help assistant's own identity)
  //   otherwise → Claude Code's preset, with Cebab's text APPENDED if any
  //
  // The append arm is what makes the MCP status note safe: it can add a
  // paragraph and cannot remove the agent's instructions, whatever a future
  // normalizer decides an absent value means.
  options.systemPrompt = opts.systemPrompt
    ? opts.systemPrompt
    : {
        type: 'preset',
        preset: 'claude_code',
        // Truthiness, not `!== undefined`: `''` is not a note. A turn with
        // nothing to add must send the bare preset rather than an empty append.
        ...(opts.systemPromptAppend ? { append: opts.systemPromptAppend } : {}),
      };
  // `!== undefined`, NOT truthiness: an empty array is a meaningful value for
  // both (tools `[]` = no built-ins; skills `[]` = every skill hidden) and is
  // truthy, so it survives either way — but the intent reads correctly only
  // with the explicit undefined check, and the key stays ABSENT when the
  // caller omits it so an ordinary spawn is byte-identical to before.
  if (opts.tools !== undefined) options.tools = opts.tools;
  if (opts.skills !== undefined) options.skills = opts.skills;

  return options;
}

export function runClaude(opts: RunOptions): Query {
  return query({ prompt: opts.prompt, options: buildSdkOptions(opts) });
}
