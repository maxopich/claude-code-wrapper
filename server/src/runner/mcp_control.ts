/**
 * `Cebab-ormv`: a live view of this project's MCP servers, and the four actions
 * that can fix one.
 *
 * WHY IT EXISTS. Until this module, everything Cebab knew about MCP came from
 * `system/init.mcp_servers` — one snapshot, taken at the least settled moment
 * of a session's life, carrying `{ name, status }` and nothing else. Cebab read
 * it once per turn and never asked again, and had no way to act on what it
 * said. The operator-reported failure that produced this bead:
 *
 *     claude mcp list        →  claude.ai Microsoft Learn: ✔ Connected
 *     an SDK spawn (Cebab)   →  needs-auth, 0 tools
 *
 * measured 2026-09-18 on the same machine, same account, same minute, and
 * reproduced with the SDK pinned to the very CLI binary whose `mcp list` said
 * Connected — so it is NOT a version skew. A headless session and an
 * interactive one genuinely disagree, and the interactive one has `/mcp` to fix
 * it while Cebab had nothing at all.
 *
 * THE SESSION SHAPE, AND WHY IT IS NOT THE PROBE'S. Every control method needs
 * a LIVE `Query`, and Cebab closes its query when a turn ends. Measured: a
 * query built from a STRING prompt dies when that turn completes — ~6-9s — and
 * calls after it fail with `ProcessTransport is not ready for writing`, which
 * is how the first draft of this lost a `reconnectMcpServer` mid-flight. A
 * query built from a STREAMING-INPUT prompt that never yields stays idle and
 * answerable indefinitely (measured alive and serving `mcpServerStatus()` at
 * +21s, and `reconnectMcpServer` still resolved there).
 *
 * That shape also costs NO MODEL TURN, which is the difference that matters
 * against `probeSessionStarted`. The probe breaks at `system/init` and is still
 * billed — the CLI sends its request ~2ms after init and the close grace does
 * not cancel it (`Cebab-lh24`). This session never sends a message at all: the
 * measured message stream is `system/hook_started`, `system/hook_response`, and
 * nothing else — no `assistant`, no `result`. So a refresh here is a process
 * spawn and no tokens.
 *
 * "NO TOKENS" IS NOT "NO SIDE EFFECTS", and the hook rows above are the proof:
 * a control session runs the project's `SessionStart` hooks exactly as a turn
 * would, under the project's own Trust. That is not new exposure — the
 * authority probe has always done the same — but it is the reason this must
 * stay OPERATOR-INITIATED and never become a poll.
 *
 * WHAT `reconnect` CANNOT DO, stated here because a button that lies is worse
 * than no button. Measured: `reconnectMcpServer` against a `needs-auth` server
 * throws `Server status: needs-auth`. Reconnect is the remedy for a server that
 * FAILED or is still PENDING; the remedy for `needs-auth` is `authenticate`,
 * and the UI must not offer the first where only the second can work.
 */
import {
  query,
  type Options,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { McpServerLive } from '@cebab/shared';
import { config } from '../config.js';
import { buildSdkOptions, type SettingSource } from './claude.js';
import { registerQuery } from './lifecycle.js';
import { resolveProjectAuthority } from '../repo/project_authority.js';
import { refuseUnapprovedForProbe } from '../repo/mcp_trust_gate.js';

/**
 * A control session that has not come up by now is not going to. Matches
 * `PROBE_TIMEOUT_MS` deliberately: same spawn, same cold-start cost, same
 * Windows penalty, and two different numbers would only invite the question of
 * which one is right.
 */
export const MCP_CONTROL_TIMEOUT_MS = 30_000;

/**
 * How long a read waits for `pending` servers to settle, and how often it looks.
 *
 * FOUND IN A BROWSER, NOT IN A TEST (`Cebab-ormv`). The first cut read status
 * once, the instant the session came up, and shipped that. On the Playground's
 * `omega-manymcp` — twelve servers — six healthy ones came back `pending` with
 * `0 tools`, including connectors a standalone probe had just measured carrying
 * 29, 11, 9 and 8. Identical on a second read, so it was not a race that got
 * unlucky: it was the design. A panel whose entire purpose is "the init
 * snapshot is frozen and lies about `pending`" had reproduced that lie exactly,
 * and then offered a Reconnect for servers that needed nothing.
 *
 * The budget clears the Playground's deliberately slow fixture (`sloth` delays
 * its initialize reply by 8 s) with room to spare, and the loop exits the
 * moment nothing is pending — which is the common case and costs one read.
 */
export const MCP_SETTLE_BUDGET_MS = 11_000;
export const MCP_SETTLE_INTERVAL_MS = 400;

/**
 * Read status until no server is still connecting, or the budget runs out.
 *
 * THIS IS NOT THE STATUS ALLOW-LIST `shared/src/mcp_status.ts` FORBIDS, and the
 * difference is worth stating because the code looks similar. That module
 * refuses to enumerate which statuses are BAD, because the SDK's set is not
 * frozen and an allow-list makes the first new failure mode invisible. This
 * asks a different question — is this answer FINAL? — and `pending` is the one
 * value that means "not yet" by definition rather than by Cebab's judgement.
 *
 * Every other value, INCLUDING ONE CEBAB HAS NEVER SEEN, counts as settled.
 * That is the safe direction: an unknown status treated as transient would make
 * this spin for the whole budget and then return the same row anyway, turning a
 * status nobody has measured into an eleven-second delay on every read.
 *
 * Injectable clock and sleep so the unit test does not spend real seconds.
 */
export async function readSettledStatus(
  read: () => Promise<McpServerLive[]>,
  opts: {
    budgetMs?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<McpServerLive[]> {
  const budgetMs = opts.budgetMs ?? MCP_SETTLE_BUDGET_MS;
  const intervalMs = opts.intervalMs ?? MCP_SETTLE_INTERVAL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;

  const startedAt = now();
  let latest = await read();
  while (latest.some((s) => s.status === 'pending')) {
    if (now() - startedAt >= budgetMs) break;
    await sleep(intervalMs);
    latest = await read();
  }
  return latest;
}

/**
 * What starting authentication produced.
 *
 * `callback_required` is the arm Cebab REFUSES rather than guesses. Measured
 * against the only servers available to measure — claude.ai connectors — the
 * CLI answers `{ authUrl, requiresUserAction: true, callbackExpected: false }`:
 * the flow finishes on claude.ai, and Cebab only has to open the URL and re-read
 * status. A server that sets `callbackExpected: true` needs
 * `mcpSubmitOAuthCallbackUrl` called on THE SAME session that started the flow,
 * because the PKCE verifier lives in that process — so it also needs a session
 * that outlives a browser round trip, which this deliberately short-lived one
 * does not. That path is UNMEASURED. It is reported to the operator as
 * unsupported, with the reason, rather than half-built behind a button that
 * would look like it works.
 */
export type McpAuthStart =
  | { kind: 'open_url'; authUrl: string }
  | { kind: 'callback_required' }
  | { kind: 'no_action_needed' };

export type McpControlSession = {
  status: () => Promise<McpServerLive[]>;
  reconnect: (serverName: string) => Promise<void>;
  authenticate: (serverName: string, redirectUri: string) => Promise<McpAuthStart>;
  clearAuth: (serverName: string) => Promise<void>;
  toggle: (serverName: string, enabled: boolean) => Promise<void>;
  close: () => void;
};

/**
 * The SDK's `Query`, plus the three methods that are PRESENT ON THE OBJECT and
 * ABSENT FROM `sdk.d.ts`.
 *
 * Measured 2026-09-18 against 0.3.251: `grep -c` over the shipped `.d.ts`
 * returns 0 for these three names and 3 for the typed trio
 * (`mcpServerStatus` / `reconnectMcpServer` / `toggleMcpServer`), while every
 * one of the six reads `function` off a real `query()` object before any
 * iteration. So they work and carry no type contract — exactly the shape that
 * disappears in a patch release with no compile error anywhere.
 *
 * This declaration is the ONLY place in the repo that names them, and
 * `mcp_control.sdk_surface.test.ts` is what keeps it honest: it extracts the
 * method names from the shipped bundle, so the day the SDK drops one a test
 * reddens instead of an operator clicking a dead button. It asserts the
 * direction too — when these become typed, it says so, and this cast should go.
 *
 * Optional on purpose. A missing method must be a handled refusal, not a
 * `TypeError` inside a WS handler.
 */
type ControlQuery = Query & {
  mcpAuthenticate?: (
    serverName: string,
    redirectUri?: string,
  ) => Promise<{ authUrl?: string; requiresUserAction?: boolean; callbackExpected?: boolean }>;
  mcpClearAuth?: (serverName: string) => Promise<unknown>;
  mcpSubmitOAuthCallbackUrl?: (serverName: string, callbackUrl: string) => Promise<unknown>;
};

/** The names this module depends on, in one list, so the conformance gate and
 *  the seam above cannot drift apart. Order is irrelevant; membership is not. */
export const REQUIRED_SDK_METHODS = [
  'mcpServerStatus',
  'reconnectMcpServer',
  'toggleMcpServer',
  'mcpAuthenticate',
  'mcpClearAuth',
  'mcpSubmitOAuthCallbackUrl',
] as const;

/** The three of those that `sdk.d.ts` does not declare. Split out rather than
 *  inlined so the conformance test can assert BOTH directions: these are
 *  missing from the types today, and the typed trio is present. */
export const UNTYPED_SDK_METHODS = [
  'mcpAuthenticate',
  'mcpClearAuth',
  'mcpSubmitOAuthCallbackUrl',
] as const;

/** Thrown when the SDK object lacks a method this module needs — i.e. when the
 *  bundle moved under us and the conformance gate has not been re-run. Named so
 *  the operator sees "Cebab cannot do this against this SDK" rather than a
 *  stack trace about `undefined is not a function`. */
export class McpControlUnsupportedError extends Error {
  constructor(method: string) {
    super(`this SDK build does not expose ${method}; Cebab cannot drive MCP ${method} here`);
    this.name = 'McpControlUnsupportedError';
  }
}

/** A prompt that never yields and never returns, so the CLI stays idle and
 *  answerable instead of completing a turn and tearing the transport down. The
 *  promise is deliberately never settled: `query.close()` is what ends this. */
function idlePrompt(): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    await new Promise<never>(() => {});
    // Unreachable; present so the generator's element type is inferred.
    yield undefined as unknown as SDKUserMessage;
  })();
}

/**
 * One SDK status row, narrowed to the wire shape.
 *
 * Every field is treated as optional on the way in even though `sdk.d.ts`
 * declares `name` and `status` required: this row crosses a process boundary
 * from a CLI whose version Cebab does not control, and a `undefined.length`
 * inside a WS handler is a worse outcome than a row that reads `unknown`.
 */
function toLive(row: {
  name?: string;
  status?: string;
  scope?: string;
  error?: string;
  tools?: Array<{ name?: string }>;
}): McpServerLive {
  return {
    name: row.name ?? '',
    status: row.status ?? 'unknown',
    ...(row.scope ? { scope: row.scope } : {}),
    ...(row.error ? { error: row.error } : {}),
    toolNames: (row.tools ?? []).map((t) => t?.name ?? '').filter((n) => n !== ''),
  };
}

/**
 * Open an idle control session against a project.
 *
 * Mirrors the posture a real turn would run with — same `buildSdkOptions`, so
 * the env scrub, the setting scopes and the operator's MCP denials are the ones
 * the next turn will actually get. That mirroring is the point: a panel
 * resolved against different scopes would report a different set of servers
 * than the turn it is describing, which is the exact class of contradiction
 * `sendProjects`' single-emit-point rule exists to prevent.
 *
 * ALWAYS `close()` the result. It holds a live `claude` process.
 */
export async function openMcpControlSession(opts: {
  cwd: string;
  projectId: number;
  settingSources: readonly SettingSource[];
}): Promise<McpControlSession> {
  if (config.mock) return mockControlSession();

  // [security] Same rule, same reason, as `probeSessionStarted`: resolve
  // against the scopes THIS spawn will use, and do not start a server the
  // operator denied. A control session spawns the project's MCP servers for
  // real; without this it would be the one path that starts a denied binary
  // (`Cebab-ygu.6`). `mode: 'cache'` reads files and the ledger and never
  // spawns, which is what keeps this from recursing.
  const authority = resolveProjectAuthority({
    projectId: opts.projectId,
    mode: 'cache',
    settingSources: opts.settingSources,
  });
  const deniedMcpServers = authority
    ? refuseUnapprovedForProbe(opts.projectId, authority.mcpServers)
    : [];

  const ac = new AbortController();
  const options: Options = buildSdkOptions({
    cwd: opts.cwd,
    // Unused: the idle prompt below replaces it. Present because `RunOptions`
    // requires one, and inert so nothing mistakes it for operator intent.
    prompt: 'mcp-control',
    permissionMode: 'default',
    settingSources: [...opts.settingSources],
    abortController: ac,
    // No partials to stream and nothing to render them: this session produces
    // no conversation.
    includePartialMessages: false,
    ...(deniedMcpServers.length > 0 ? { deniedMcpServers } : {}),
    // Unreachable — no turn ever runs — and deliberately still a deny. A
    // control session must never be able to act.
    canUseTool: async () => ({
      behavior: 'deny' as const,
      message: 'mcp control session: read-only',
    }),
  });

  const q = query({ prompt: idlePrompt(), options }) as ControlQuery;
  const unregister = registerQuery(q);

  // The iteration is never awaited for its VALUES — it exists because the SDK
  // pumps its transport from it. Without a consumer the control responses
  // never arrive. Errors here are the session dying, which every method below
  // reports on its own; swallowing keeps an unhandled rejection off the WS
  // handler that opened this.
  void (async () => {
    try {
      for await (const _ of q) void _;
    } catch {
      // Closing an idle session rejects the iterator; not an error to surface.
    }
  })();

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    ac.abort();
    try {
      q.close();
    } catch {
      // Already gone.
    }
    unregister();
  };

  // A session that never answers must not park a WS handler forever — the same
  // budget the probe carries, for the same reason.
  const timer = setTimeout(close, MCP_CONTROL_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();

  const need = <K extends keyof ControlQuery>(method: K): NonNullable<ControlQuery[K]> => {
    const fn = q[method];
    if (typeof fn !== 'function') throw new McpControlUnsupportedError(String(method));
    return fn as NonNullable<ControlQuery[K]>;
  };

  return {
    status: async () =>
      readSettledStatus(async () => {
        const rows = (await q.mcpServerStatus()) as Array<Parameters<typeof toLive>[0]>;
        return rows.map(toLive);
      }),
    reconnect: async (serverName) => {
      await q.reconnectMcpServer(serverName);
    },
    toggle: async (serverName, enabled) => {
      await q.toggleMcpServer(serverName, enabled);
    },
    clearAuth: async (serverName) => {
      await need('mcpClearAuth').call(q, serverName);
    },
    authenticate: async (serverName, redirectUri) => {
      const res = await need('mcpAuthenticate').call(q, serverName, redirectUri);
      // `callbackExpected` first: a server that wants a callback is the
      // unmeasured arm, and it must be refused even if an authUrl came with it.
      if (res?.callbackExpected === true) return { kind: 'callback_required' };
      if (typeof res?.authUrl === 'string' && res.authUrl !== '') {
        return { kind: 'open_url', authUrl: res.authUrl };
      }
      // No URL and no callback wanted — the CLI had nothing for the operator to
      // do. Reported as such rather than as a failure.
      return { kind: 'no_action_needed' };
    },
    close: () => {
      clearTimeout(timer);
      close();
    },
  };
}

/**
 * Mock mode's session. Serves a fixed roster that exercises every arm the UI
 * has to render — connected-with-tools, needs-auth, failed-with-an-error and
 * pending — because a mock that only ever returns healthy servers would let
 * every empty-state and every action path ship untested.
 *
 * The actions mutate this roster so the UI's optimistic paths are drivable
 * without a network: `reconnect` settles a pending/failed server, and
 * deliberately REFUSES a needs-auth one with the live CLI's own message, since
 * that refusal is the behaviour most worth not regressing.
 */
function mockControlSession(): McpControlSession {
  const roster: McpServerLive[] = [
    {
      name: 'mock-docs',
      status: 'connected',
      scope: 'user',
      toolNames: ['mcp__mock_docs__search'],
    },
    { name: 'mock-oauth', status: 'needs-auth', scope: 'claudeai', toolNames: [] },
    {
      name: 'mock-broken',
      status: 'failed',
      scope: 'project',
      error: 'connection refused',
      toolNames: [],
    },
    { name: 'mock-slow', status: 'pending', scope: 'user', toolNames: [] },
  ];
  const find = (n: string): McpServerLive | undefined => roster.find((r) => r.name === n);
  return {
    status: async () => roster.map((r) => ({ ...r, toolNames: [...r.toolNames] })),
    reconnect: async (name) => {
      const row = find(name);
      if (!row) return;
      // The measured live behaviour, kept verbatim: reconnect cannot clear a
      // needs-auth server, and a mock that pretended otherwise would make the
      // UI's most important refusal path untestable.
      if (row.status === 'needs-auth') throw new Error('Server status: needs-auth');
      row.status = 'connected';
    },
    toggle: async (name, enabled) => {
      const row = find(name);
      if (row) row.status = enabled ? 'connected' : 'disabled';
    },
    clearAuth: async (name) => {
      const row = find(name);
      if (row) row.status = 'needs-auth';
    },
    authenticate: async (name) => {
      const row = find(name);
      if (!row || row.status !== 'needs-auth') return { kind: 'no_action_needed' };
      return { kind: 'open_url', authUrl: 'https://example.invalid/mock-mcp-auth' };
    },
    close: () => {},
  };
}
