/**
 * Authority probe: ask the SDK what a project ACTUALLY loads, without making
 * the operator spend a chat turn to find out (Cebab-ys9).
 *
 * WHY THIS EXISTS. `resolveProjectAuthority` has two halves. The file-scan
 * half (declared MCP servers, hooks, env injections, allow/deny rules) it can
 * read on demand. The SDK half — the tool list, skills, slash commands,
 * sub-agents, and the per-MCP-server STATUS — exists only in a `system/init`
 * payload, which until now arrived solely as a side effect of a real turn and
 * was cached per WebSocket connection. So a freshly-opened window showed an
 * authority panel with every SDK-derived section at zero, and `mode: 'probe'`
 * — the Refresh affordance the panel already had — logged a line and returned
 * that same empty cache.
 *
 * That gap is not cosmetic. A project-scoped MCP server that LOADS AND FAILS
 * contributes zero tools and is reported nowhere: the model simply has no such
 * tools and cannot say why, and a `Bash`-spawned `claude mcp list` answers
 * about the config file rather than this session, so it reports the server
 * connected while the session watched it fail. The status field this probe
 * recovers is the difference between "never loaded" and "loaded and broke".
 *
 * COST. We break at the first `system/init` and abort. That message is emitted
 * at startup, but it is NOT before the CLI contacts the API: measured
 * (2026-09-10, SDK 0.3.251, `probe_no_model_turn_smoke.ts`), the CLI dispatches
 * a request ~2 ms after init and aborting at init does not cancel it — the SDK
 * waits ~2 s (its close grace) before SIGTERM, long enough for a short turn to
 * complete and bill. So a probe sends a real, billed request (~16 output /
 * ~10.7k cache-write / ~24k cache-read tokens); its reply is RECORDED in the
 * transcript only if it completes inside that grace. Whether to avoid the
 * request or accept the cost is the maintainer's decision (Cebab-lh24); the
 * behaviour here is deliberately unchanged. `canUseTool` denies everything as a
 * belt-and-braces second stop, and the whole run is bounded by
 * `PROBE_TIMEOUT_MS` so a wedged CLI cannot park a WS handler forever.
 *
 * Goes through `pickRunner`, so mock mode replays a fixture's init exactly as
 * every other Cebab spawn does.
 *
 * WHAT IT REFUSES TO START (Cebab-ygu.6 / Cebab-ygu.17). This is a spawn, and
 * it used to be an ungated one: `gateProjectsForSpawn`'s header listed "every
 * path to a spawn" and did not list this. A server the operator had answered
 * "Deny & remember" to was started by it anyway, and a never-seen server ran
 * before they were ever asked — with no prompt, no refusal and no
 * `safety_audit` row. A probe cannot prompt (since `Cebab-ws0.7` it fires ~400ms
 * after the operator lands on a project, so a modal here would mean arrowing
 * down a sidebar throws dialogs), so it takes the strict posture instead: it
 * starts only what is already trusted. `refuseUnapprovedForProbe` decides, and
 * this function computes the list ITSELF rather than taking it as an option —
 * there are four call sites, and the same argument H04 makes about `runClaude`
 * applies here: no call site can get half of it right if none of them owns it.
 *
 * SIDE EFFECT, deliberate (Cebab-ws0.3): while the CLI is up and before the
 * abort, this also refreshes the account-wide model catalogue. The list rides
 * the initialize handshake, so it is already in hand — asking for it here costs
 * a measured ~0ms and no extra spawn. It rides the same spawn as the probe's
 * own billed request (see COST) rather than adding a turn of its own.
 * `refreshModelCatalogue` cannot throw and cannot extend this probe past its own
 * budget; a failure there leaves the previous catalogue alone and this
 * function's contract unchanged.
 *
 * SIDE EFFECT, also deliberate (Cebab-ajvv): the same up-and-before-abort window
 * reads each MCP server's SCOPE from `Query.mcpServerStatus()` — the CLI's own
 * label for where a server came from (project / user / local / claudeai /
 * managed / dynamic). This is the ONE source that can attribute a server no file
 * declares: a claude.ai connector reads `claudeai`, a plugin server `dynamic`,
 * where `system/init` carries only `{ name, status }`. It is a LABEL source and
 * feeds NO gate — `captureMcpScopes` copies the scope string and nothing else,
 * never the row's `config`, which carries connector URLs and ids. Like the model
 * catalogue it cannot throw and is bounded by its own timeout, so it can neither
 * fail this probe nor extend it past that budget.
 */
import type { McpServerStatus, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ServerMsg } from '@cebab/shared/protocol';
import { pickRunner, type Runner } from './index.js';
import { registerQuery } from './lifecycle.js';
import type { SettingSource } from './claude.js';
import { translate } from '../ws/translate.js';
import { refreshModelCatalogue } from './model_catalogue.js';
import { resolveProjectAuthority } from '../repo/project_authority.js';
import { refuseUnapprovedForProbe } from '../repo/mcp_trust_gate.js';

/**
 * A probe that has not produced an init by now is not going to. Generous
 * because a cold `claude` start on a large project (and every Windows spawn)
 * is slower than the ~2s a warm one takes; short enough that the operator gets
 * an answer rather than a spinner.
 */
export const PROBE_TIMEOUT_MS = 30_000;

/** The prompt is never answered — we abort at init. It exists because the SDK
 *  requires one, and it is deliberately inert rather than something a fixture
 *  or a transcript reader would mistake for operator intent. */
const PROBE_PROMPT = 'probe';

/**
 * Budget for the one `mcpServerStatus()` read, deliberately separate from
 * `PROBE_TIMEOUT_MS` (which bounds the whole spawn) — same split, and same
 * reason, as `CATALOGUE_TIMEOUT_MS` in `model_catalogue.ts`. Sharing the probe
 * budget would let a wedged status call eat the whole probe and turn a free
 * extra into the reason the panel never answered. Generous against a measured
 * ~0ms because the failure guarded is a hang, not slowness.
 */
export const MCP_SCOPE_CAPTURE_TIMEOUT_MS = 2_000;

/**
 * Read each MCP server's SCOPE label from the CLI's own status report
 * (Cebab-ajvv). Never throws and never hangs; returns an empty Map on every
 * failure so a caller cannot be made to fail by it.
 *
 * Returns empty when the runner cannot answer (the mock has no
 * `mcpServerStatus`), when the call rejects, when it does not settle inside
 * `timeoutMs`, or when it returns something that is not an array. A row is kept
 * only when its `name` and `scope` are BOTH non-empty strings, mapping
 * `name → scope`.
 *
 * READS ONCE. Scope does not depend on connection status, so this must not wait
 * for `pending` servers to settle — that is `readSettledStatus`'s job, and doing
 * it here would turn a label read into a retry loop.
 *
 * COPIES ONLY THE SCOPE. The status rows' `config` carries a claude.ai
 * connector's URL and id; those must never be stored, logged or sent, so nothing
 * but `name` and `scope` is read off a row.
 */
export async function captureMcpScopes(
  runner: { mcpServerStatus?: () => Promise<unknown> },
  timeoutMs: number = MCP_SCOPE_CAPTURE_TIMEOUT_MS,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (typeof runner.mcpServerStatus !== 'function') return out;
  const TIMED_OUT = Symbol('timeout');
  let timer: NodeJS.Timeout | undefined;
  try {
    const raced = await Promise.race([
      runner.mcpServerStatus(),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
    if (raced === TIMED_OUT) return out;
    if (!Array.isArray(raced)) return out;
    for (const row of raced as McpServerStatus[]) {
      const name = (row as { name?: unknown })?.name;
      const scope = (row as { scope?: unknown })?.scope;
      if (
        typeof name === 'string' &&
        name.length > 0 &&
        typeof scope === 'string' &&
        scope.length > 0
      ) {
        out.set(name, scope);
      }
    }
    return out;
  } catch {
    // A CLI that died mid-handshake, or one too old to answer this control
    // request. The label is a nice-to-have; its absence just leaves the
    // undeclared rows reading `scope: 'unknown'`, which is the pre-Cebab-ajvv
    // behaviour.
    return out;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * What a probe recovers: the translated `session_started` (the same shape a
 * real turn produces, so callers reuse the existing cache/merge path verbatim)
 * AND the MCP scope labels captured in the same spawn. `mcpScopes` is empty when
 * the runner could not answer — see `captureMcpScopes`.
 */
export type ProbeResult = {
  started: ServerMsg;
  mcpScopes: ReadonlyMap<string, string>;
};

/**
 * Spawn, read the init payload, abort. Resolves to a {@link ProbeResult} or
 * `null` when no init arrived.
 *
 * At init, before the abort in `finally`, it does two reads in order — the
 * model catalogue then the MCP scopes — because both need the control channel
 * up. Neither can throw or extend the probe past its own budget.
 */
export async function probeAuthority(opts: {
  cwd: string;
  projectId: number;
  settingSources: readonly SettingSource[];
}): Promise<ProbeResult | null> {
  // [security] Resolve against the scopes THIS spawn will use, not the
  // project's Trust setting — the same rule `gateProjectsForSpawn` carries.
  // A probe resolved against different scopes would compute denials for a
  // surface the spawn does not load, and miss the one it does.
  //
  // `mode: 'cache'` is what keeps this from recursing: cache mode reads files
  // and the trust ledger, and never spawns.
  //
  // No project row (the live smoke scripts pass `projectId: 0`) → no
  // authority → no names → nothing refused. Structural rather than a policy
  // choice: `deniedMcpServers` needs names, and there are none to give.
  const authority = resolveProjectAuthority({
    projectId: opts.projectId,
    mode: 'cache',
    // No cast: `SettingSource` (the SDK's) and `SettingScope` (Cebab's) are
    // both 'user' | 'project' | 'local' today, and letting the compiler check
    // that is the point — if the SDK ever widens its union, this line goes red
    // instead of silently resolving against a scope the resolver cannot read.
    settingSources: opts.settingSources,
  });
  const deniedMcpServers = authority
    ? refuseUnapprovedForProbe(opts.projectId, authority.mcpServers)
    : [];

  const ac = new AbortController();
  let runner: Runner | undefined;
  let unregister: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;

  try {
    // Inside the try on purpose: constructing a runner can throw
    // SYNCHRONOUSLY, and both runners do. `runMock` throws on a missing
    // fixture, and on the live path `query()` spawns the CLI — on Windows,
    // spawning a `.cmd` shim without `shell: true` throws `EINVAL` before any
    // promise exists (the CVE-2024-27980 behaviour `scripts/bootstrap.mjs`
    // documents). Constructed outside, that throw would reject the WS handler
    // that called us instead of resolving to "no snapshot".
    runner = pickRunner({
      cwd: opts.cwd,
      prompt: PROBE_PROMPT,
      permissionMode: 'default',
      settingSources: [...opts.settingSources],
      abortController: ac,
      maxTurns: 1,
      // Empty stays empty: `mcpDenialOptions` returns `{}` for an empty list,
      // so a project whose servers are all approved spawns byte-identically
      // to before this existed.
      ...(deniedMcpServers.length > 0 ? { deniedMcpServers } : {}),
      // Unreachable in practice (we abort at init, before any tool call) and
      // deliberately still a deny: a probe must never be able to act.
      canUseTool: async () => ({
        behavior: 'deny' as const,
        message: 'authority probe: read-only',
      }),
    });
    unregister = registerQuery(runner);
    timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);

    for await (const msg of runner as AsyncIterable<SDKMessage>) {
      const m = msg as unknown as { type?: string; subtype?: string };
      if (m.type !== 'system' || m.subtype !== 'init') continue;
      // Before the abort, while the control channel is still up.
      await refreshModelCatalogue(runner);
      const mcpScopes = await captureMcpScopes(runner);
      const started = translate(msg, opts.projectId);
      return started ? { started, mcpScopes } : null;
    }
    return null;
  } catch {
    // An aborted iteration (timeout), a CLI that died on startup, and a runner
    // that could not be constructed at all all land here. Every one of them
    // means "no snapshot", which the caller renders as a failed probe — there
    // is nothing to distinguish for the operator, and throwing would turn a
    // diagnostic into an outage.
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    ac.abort();
    try {
      runner?.close?.();
    } catch {
      // Closing an already-aborted runner is not an error worth surfacing.
    }
    // Only registered if construction got that far; a leak here would
    // accumulate per button click.
    unregister?.();
  }
}

/**
 * The bare `session_started`, for the callers that never wanted the scopes: the
 * `get_model_catalogue` refresh (which discards the result), and the
 * `mcp_scope_smoke` / `managed_file_smoke` / probe test paths. Keeps its
 * historical signature so those sites are unchanged — the scope-carrying result
 * reaches only `runAuthorityProbe`, which calls `probeAuthority` directly.
 */
export async function probeSessionStarted(opts: {
  cwd: string;
  projectId: number;
  settingSources: readonly SettingSource[];
}): Promise<ServerMsg | null> {
  return (await probeAuthority(opts))?.started ?? null;
}
