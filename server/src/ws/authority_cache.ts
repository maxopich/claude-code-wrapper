/**
 * The per-connection authority snapshot cache and its writer (Cebab-ajvv,
 * extracted from `ws/server.ts`).
 *
 * A connection holds at most one `session_started` snapshot per project — the
 * most recent wins — and the authority resolver reads it to fill the SDK-only
 * half of a project's authority (tools, skills, per-MCP-server status). This
 * module owns the type and the single writer so the label carry-over below has
 * one home.
 *
 * WHY THE CARRY-OVER EXISTS. The selection probe (`probeAuthority`) is the only
 * spawn that reads MCP scope labels — a real turn's `system/init` carries none.
 * But a real turn also produces a `session_started` and REPLACES this snapshot.
 * Without carry-over, sending one message after a probe would erase every scope
 * label the probe set, and the panel would fall back to `scope: 'unknown'` for
 * connectors it had just attributed. So a write keeps the previous snapshot's
 * label for any server still present in the new init, unless the fresh capture
 * has a newer one.
 */
import type { ServerMsg } from '@cebab/shared/protocol';

/**
 * Doesn't include sessionId because the AuthorityPanel is project-scoped (per
 * spec §6.1) and we only need ONE init snapshot per project per connection.
 */
export type CachedSessionStarted = {
  capturedAt: number;
  model?: string;
  tools?: string[];
  cwd?: string;
  permissionMode?: string;
  apiKeySource?: string;
  mcpServers?: { name: string; status: string }[];
  slashCommands?: string[];
  skills?: string[];
  agents?: string[];
  plugins?: { name: string; path: string }[];
  /**
   * `Cebab-ajvv`: `serverName → CLI scope label`, from the probe that captured
   * this or carried over from the prior snapshot. A Map, never a plain object:
   * server names are strings the CLI reports and some are project-controlled, so
   * a plain-object lookup of a server named `constructor` would return a
   * prototype member. Absent when empty.
   */
  mcpScopes?: ReadonlyMap<string, string>;
};

/**
 * Fold a `session_started` into `cache`, carrying MCP scope labels forward.
 *
 * `freshScopes` are the labels the current spawn captured (empty or omitted for
 * a real turn, which reads none). For each server named in the new init, the
 * label is the fresh one if present, else the previous snapshot's label for that
 * project; a server absent from the new init loses its label. The map is
 * attached only when it ends up non-empty.
 */
export function cacheSessionStarted(
  cache: Map<number, CachedSessionStarted>,
  out: ServerMsg,
  freshScopes?: ReadonlyMap<string, string>,
): void {
  if (out.type !== 'session_started') return;
  const prev = cache.get(out.projectId);
  const snapshot: CachedSessionStarted = { capturedAt: Date.now() };
  if (out.model !== undefined) snapshot.model = out.model;
  if (out.tools !== undefined) snapshot.tools = out.tools;
  if (out.cwd !== undefined) snapshot.cwd = out.cwd;
  if (out.permissionMode !== undefined) snapshot.permissionMode = out.permissionMode;
  if (out.apiKeySource !== undefined) snapshot.apiKeySource = out.apiKeySource;
  if (out.mcpServers !== undefined) snapshot.mcpServers = out.mcpServers;
  if (out.slashCommands !== undefined) snapshot.slashCommands = out.slashCommands;
  if (out.skills !== undefined) snapshot.skills = out.skills;
  if (out.agents !== undefined) snapshot.agents = out.agents;
  if (out.plugins !== undefined) snapshot.plugins = out.plugins;

  const scopes = new Map<string, string>();
  for (const server of out.mcpServers ?? []) {
    const fresh = freshScopes?.get(server.name);
    if (fresh !== undefined) {
      scopes.set(server.name, fresh);
      continue;
    }
    const carried = prev?.mcpScopes?.get(server.name);
    if (carried !== undefined) scopes.set(server.name, carried);
  }
  if (scopes.size > 0) snapshot.mcpScopes = scopes;

  cache.set(out.projectId, snapshot);
}
