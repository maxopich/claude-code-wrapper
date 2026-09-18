/**
 * `Cebab-ormv`: serve one `mcp_control` request.
 *
 * A module with injected deps rather than a branch inside `ws/server.ts`, for
 * the reason `live_sink.ts` states at length: a seam that can only be exercised
 * by standing up a real WebSocket and a real CLI is a seam whose bugs are
 * unreachable from a test. Everything interesting here is ORDERING and
 * FAILURE-HANDLING, and both are testable only if the session is a fake.
 *
 * THE ORDERING RULE, and it is the whole design: the status re-read happens
 * AFTER the op and OUTSIDE its failure path. A reconnect that the CLI refuses
 * is the single most important thing this feature reports — measured, a
 * `needs-auth` server answers `reconnect` with a throw — and the operator needs
 * BOTH halves of that: the refusal, and the server list as it still stands. An
 * implementation that returned early on the op's throw would send the error
 * with `servers: null` and blank the panel at exactly the moment it became
 * useful.
 *
 * `servers: null` is therefore reserved for one thing: the read itself failed.
 * An empty array means the read worked and this project loads no MCP servers.
 * Collapsing those two would tell an operator with no servers that Cebab is
 * broken, and an operator whose session died that they have none.
 */
import type { McpControlOp, ServerMsg } from '@cebab/shared/protocol';
import type { McpServerLive } from '@cebab/shared';
import type { McpControlSession } from '../runner/mcp_control.js';

export type McpControlDeps = {
  /** Opens the live control session. Throws if the project is unknown or the
   *  spawn fails; both land in the same operator-facing refusal. */
  openSession: (projectId: number) => Promise<McpControlSession>;
  send: (msg: ServerMsg) => void;
};

export type McpControlRequest = {
  projectId: number;
  op: McpControlOp;
  serverName?: string;
  enabled?: boolean;
};

/** Ops that act on one named server. `status` is the only one that does not,
 *  and deriving the check from this set rather than from a chain of `if`s is
 *  what makes a future op's missing-name handling automatic. */
const NEEDS_SERVER_NAME: ReadonlySet<McpControlOp> = new Set<McpControlOp>([
  'reconnect',
  'authenticate',
  'clear_auth',
  'toggle',
]);

/**
 * Where Cebab tells the CLI to send the operator back after an OAuth round
 * trip. Only ever used by servers that ask for a callback — and Cebab refuses
 * that arm today (see `McpAuthStart`) — so this exists to be a well-formed,
 * local, inert value rather than to be visited. It is deliberately NOT a real
 * Cebab route: inventing an endpoint that nothing serves would look like a
 * feature that works.
 */
const OAUTH_REDIRECT_URI = 'http://127.0.0.1/cebab-mcp-oauth-unsupported';

export async function handleMcpControl(
  deps: McpControlDeps,
  req: McpControlRequest,
): Promise<void> {
  const base = {
    type: 'mcp_control_result' as const,
    projectId: req.projectId,
    op: req.op,
    ...(req.serverName !== undefined ? { serverName: req.serverName } : {}),
  };

  if (NEEDS_SERVER_NAME.has(req.op) && !req.serverName) {
    // A well-formed frame asking for something impossible — distinct from a
    // malformed one, which the validator already dropped before this runs.
    deps.send({ ...base, servers: null, error: `${req.op} needs a server name` });
    return;
  }

  let session: McpControlSession;
  try {
    session = await deps.openSession(req.projectId);
  } catch (err) {
    deps.send({ ...base, servers: null, error: describe(err) });
    return;
  }

  try {
    let authUrl: string | undefined;
    let callbackUnsupported = false;
    let opError: string | undefined;

    try {
      switch (req.op) {
        case 'status':
          break;
        case 'reconnect':
          await session.reconnect(req.serverName as string);
          break;
        case 'clear_auth':
          await session.clearAuth(req.serverName as string);
          break;
        case 'toggle':
          // `=== true` rather than truthiness: an absent `enabled` must not
          // read as "disable". A toggle with no target state is a caller bug,
          // and defaulting to the destructive direction is the wrong way to
          // guess.
          await session.toggle(req.serverName as string, req.enabled === true);
          break;
        case 'authenticate': {
          const started = await session.authenticate(req.serverName as string, OAUTH_REDIRECT_URI);
          if (started.kind === 'open_url') authUrl = started.authUrl;
          else if (started.kind === 'callback_required') callbackUnsupported = true;
          break;
        }
        default: {
          // Exhaustiveness: a new op cannot be added to the protocol without
          // being handled here.
          const _exhaustive: never = req.op;
          void _exhaustive;
          break;
        }
      }
    } catch (err) {
      // The op failed; the SESSION is still fine. Keep going to the read — see
      // the header. This is the `reconnect` on a needs-auth server path, which
      // is the most common non-trivial outcome this feature has.
      opError = describe(err);
    }

    let servers: McpServerLive[] | null = null;
    try {
      servers = await session.status();
    } catch (err) {
      // The read failed too. Prefer the OP's error if there was one — it is
      // what the operator asked for and the more specific of the two.
      opError = opError ?? describe(err);
    }

    deps.send({
      ...base,
      servers,
      ...(authUrl !== undefined ? { authUrl } : {}),
      ...(callbackUnsupported ? { callbackUnsupported: true } : {}),
      ...(opError !== undefined ? { error: opError } : {}),
    });
  } finally {
    // Holds a live `claude` process. Closing is not optional and must not
    // depend on any path above succeeding.
    try {
      session.close();
    } catch {
      // Already gone.
    }
  }
}

/**
 * The CLI's own words, never a Cebab paraphrase.
 *
 * `mcp_status.ts` argues that a status string must be printed and not
 * interpreted, because the set is not frozen and Cebab has not measured what
 * each value means. The same holds one level up for failures: `Server status:
 * needs-auth` tells the operator something true and specific, and any mapping
 * table Cebab wrote over it would be a guess that goes stale silently.
 */
function describe(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  const s = String(err);
  return s === '[object Object]' ? 'the MCP control session failed' : s;
}
