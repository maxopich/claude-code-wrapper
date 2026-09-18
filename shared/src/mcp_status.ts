/**
 * Cebab-ws0.2: which of a session's MCP servers are not carrying tools.
 *
 * The SDK's `system/init` reports one status per MCP server it LOADED, and
 * Cebab forwards that list verbatim on `session_started.mcpServers`. A server
 * that loaded but did not reach `connected` contributes zero tools — and from
 * inside the session that is indistinguishable from a server that was never
 * declared at all. The model has no such tools and no way to say why, which is
 * how a transcript ends up inventing a remedy that could not have worked.
 *
 * THE RULE IS "NOT CONNECTED", NOT A LIST OF BAD STATUSES, and that is the
 * edit to resist. Enumerating `failed` and `needs-auth` reads more precise and
 * is strictly worse: the SDK's status set is not frozen, so the first failure
 * mode it adds would be silently invisible here — which is the exact blind spot
 * this exists to close. Whatever a server has to report, `connected` is the
 * only value that means "its tools are on the session's list".
 *
 * The accepted cost of that direction is the mirror case: a future SDK could
 * emit some transient status at init for a server that then settles fine, and
 * this would name it. That stays honest only because nothing downstream
 * interprets the string — the banner prints the status the SDK gave and never
 * translates it into a cause. Keep it that way.
 *
 * NOT covered here, deliberately: a server the project declares that the
 * session's `settingSources` never read. That one is absent from `mcpServers`
 * entirely rather than present-and-unhealthy, so no status exists to report and
 * this function cannot see it. The sidebar's per-project scan line owns that
 * case (`Cebab-ws0.6`), and the two must not be blurred together — "it loaded
 * and broke" and "it was never loaded" have different causes and different
 * fixes.
 */

/** One entry of `session_started.mcpServers`, which is `{ name, status }` with
 *  `status` carried through as whatever string the SDK sent. */
export type McpServerStatus = { name: string; status: string };

/**
 * `Cebab-ormv`: one server as a LIVE read describes it.
 *
 * The same server, seen through `Query.mcpServerStatus()` rather than through
 * the `system/init` snapshot above — which is a strict superset, measured: init
 * carries `{ name, status }` and the live read adds the scope, the failure
 * string, and the server's actual TOOL LIST. It is a separate type rather than
 * optional fields on `McpServerStatus` because the two come from different
 * places and mean different things: one is what was true when the session
 * booted, the other is what is true now.
 *
 * It EXTENDS `McpServerStatus` so `isConnected` / `notConnected` /
 * `toolsForMcpServer` apply to it unchanged. That is the point — a second
 * status rule for live rows is exactly the drift `mcp_status_single_definition`
 * exists to prevent.
 *
 * `toolNames` is `[]` for a server that contributed none, which is the honest
 * answer for one that loaded and did not connect. A caller with no tool list at
 * all must leave the field absent rather than pass `[]`, the same distinction
 * `toolsForMcpServer`'s header draws between "none" and "we never looked".
 */
export type McpServerLive = McpServerStatus & {
  /** The CLI's own scope label — `user`, `project`, `local`, `claudeai`,
   *  `managed`. Printed, never interpreted; the set is not frozen. */
  scope?: string;
  /** Present when the server reported a failure. Verbatim from the SDK. */
  error?: string;
  toolNames: string[];
};

/**
 * Whether one server's tools are on the session's list.
 *
 * The single-server arm exists because there are three readers of this rule,
 * not two, and the third asks about one server rather than a list: the
 * authority resolver's per-TOOL view (`toolViewFor` in
 * `server/src/repo/project_authority.ts`) marks an `mcp__x__y` tool
 * unavailable when server `x` is unhealthy. It had written the comparison out
 * by hand, with its own comment restating the same reasoning — an independent
 * second definition, predating both `Cebab-ws0.2` and `Cebab-ws0.15`, that
 * would have kept its own counsel the next time this rule moved.
 */

/**
 * Every server whose status is not exactly `'connected'`, in the order the SDK
 * reported them. Empty means every loaded server is carrying its tools — or
 * that none were loaded, which reads the same from the session's point of view.
 */
export function isConnected(server: McpServerStatus): boolean {
  return server.status === 'connected';
}

export function notConnected(
  servers: readonly McpServerStatus[] | undefined,
): readonly McpServerStatus[] {
  if (servers === undefined) return [];
  return servers.filter((s) => !isConnected(s));
}

/**
 * The prefix an MCP server's tools carry on the session's tool list.
 *
 * Tools arrive as `mcp__<prefix>__<tool>`, and the prefix is NOT the server
 * name — the CLI replaces every character outside `[A-Za-z0-9_]` with `_`.
 * Measured live 2026-09-15 on a session with twelve loaded servers:
 *
 *   "claude.ai Google Calendar"  →  mcp__claude_ai_Google_Calendar__…
 *   "atlas"                      →  mcp__atlas__…
 *
 * IT EXISTS BECAUSE TWO READERS GOT IT WRONG IN OPPOSITE DIRECTIONS, and both
 * failed silently (`Cebab-as7x`):
 *
 *   - `McpServersList` renders a per-server tool count that every construction
 *     site filled with `[]`, so every card read "0 tools" however many the
 *     server contributed.
 *   - `toolViewFor` marked an `mcp__x__y` tool unavailable by looking up a
 *     server whose `name` equals the prefix. For any server whose name carries
 *     a space or a dot — every claude.ai connector — that lookup found nothing,
 *     so the availability rule it implements did not run at all. The failure
 *     mode is the dangerous direction: a `needs-auth` connector's tools were
 *     presented as available.
 *
 * Sharing the rule is the same argument `isConnected` makes one function up: a
 * second hand-written copy is how the two answers drift, and here they had not
 * merely drifted — neither was right.
 */
export function mcpToolPrefix(serverName: string): string {
  return serverName.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * The `mcp__…` tool names on `toolNames` that belong to `serverName`.
 *
 * Returns them in the order the SDK reported, and returns `[]` for a server
 * that contributed none — which is the honest answer for a server that loaded
 * and did not connect, and must stay distinguishable from "we never looked".
 * Callers that have no tool list at all should pass none and leave the field
 * absent rather than pass `[]`.
 */
export function toolsForMcpServer(serverName: string, toolNames: readonly string[]): string[] {
  const prefix = `mcp__${mcpToolPrefix(serverName)}__`;
  return toolNames.filter((t) => t.startsWith(prefix));
}
