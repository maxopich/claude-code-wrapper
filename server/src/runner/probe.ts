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
 * COST. We break at the first `system/init` and abort — that message is
 * emitted by the CLI at startup, before it contacts the API, so a probe is a
 * process spawn and no model turn. `canUseTool` denies everything as a
 * belt-and-braces second stop, and the whole run is bounded by
 * `PROBE_TIMEOUT_MS` so a wedged CLI cannot park a WS handler forever.
 *
 * Goes through `pickRunner`, so mock mode replays a fixture's init exactly as
 * every other Cebab spawn does.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ServerMsg } from '@cebab/shared/protocol';
import { pickRunner, type Runner } from './index.js';
import { registerQuery } from './lifecycle.js';
import type { SettingSource } from './claude.js';
import { translate } from '../ws/translate.js';

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
 * Spawn, read the init payload, abort. Resolves to the translated
 * `session_started` message (the same shape a real turn produces, so callers
 * reuse the existing cache/merge path verbatim) or `null` when no init arrived.
 */
export async function probeSessionStarted(opts: {
  cwd: string;
  projectId: number;
  settingSources: readonly SettingSource[];
}): Promise<ServerMsg | null> {
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
      return translate(msg, opts.projectId);
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
