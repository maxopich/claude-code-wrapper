import { query, type Options, type Query } from "@anthropic-ai/claude-agent-sdk";

export type RunOptions = {
  cwd: string;
  prompt: string;
  /** Pre-assigned session UUID. Required for new sessions; omit when resuming. */
  sessionId?: string;
  /** Resume an existing session by UUID. Mutually exclusive with sessionId. */
  resume?: string;
  /** Override permission mode. Default: "default" (asks via canUseTool). */
  permissionMode?: Options["permissionMode"];
  /** Permission callback. Required unless permissionMode is "bypassPermissions" / "acceptEdits" covers everything. */
  canUseTool?: Options["canUseTool"];
  /** Token-by-token deltas via stream_event. Default: true. */
  includePartialMessages?: boolean;
  /** Hard turn cap. */
  maxTurns?: number;
  /** External cancellation. */
  abortController?: AbortController;
};

/**
 * Strip every env var that would override OAuth subscription auth.
 * The Anthropic auth precedence puts API keys above subscription, so a stray
 * `export ANTHROPIC_API_KEY=...` in .zshrc would silently route us through paid billing.
 */
function subscriptionOnlyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const blocked = new Set([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (blocked.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export function runClaude(opts: RunOptions): Query {
  const options: Options = {
    cwd: opts.cwd,
    env: subscriptionOnlyEnv(process.env),
    settingSources: ["user", "project", "local"],
    includePartialMessages: opts.includePartialMessages ?? true,
    permissionMode: opts.permissionMode ?? "default",
    canUseTool: opts.canUseTool,
    abortController: opts.abortController,
  };
  if (opts.sessionId) options.sessionId = opts.sessionId;
  if (opts.resume) options.resume = opts.resume;
  if (opts.maxTurns !== undefined) options.maxTurns = opts.maxTurns;

  return query({ prompt: opts.prompt, options });
}
