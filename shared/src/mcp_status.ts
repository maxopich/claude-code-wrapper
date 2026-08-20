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
