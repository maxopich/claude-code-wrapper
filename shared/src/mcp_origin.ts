/**
 * `Cebab-6fax.42` item 3: whether a declaration's ORIGIN is a place the CLI
 * actually loads MCP servers from.
 *
 * Cebab reads `mcpServers` blocks out of four kinds of file and renders them as
 * one list, but only two of those files are ones the CLI starts servers from.
 * `.mcp.json` and `~/.claude.json` load; an `mcpServers` key in a
 * `.claude/settings*.json` layer is read by nothing — it is a place operators
 * put servers by mistake, believing it is the same schema.
 *
 * MEASURED, every row, `mcp_scope_smoke.ts` Parts 2 and 3 (2026-09-09, SDK
 * 0.3.251 / CLI 2.1.212), each with a positive control in the same spawn:
 *
 *   <proj>/.claude/settings.json        → not loaded
 *   ...the same + enableAllProjectMcpServers → not loaded
 *   <proj>/.claude/settings.local.json  → not loaded
 *   <cfg>/settings.json  (user scope)   → not loaded
 *
 * WHY THIS IS A FUNCTION AND NOT THREE `if`s. Three surfaces answer this same
 * question about the same declaration and had answered it differently: the TOFU
 * gate parked a spawn to ask the operator about a settings-layer row, the probe
 * refusal did the same, and the sidebar's scan line counted it as LOADS. The
 * operator therefore got a consent prompt for a server that cannot run, and a
 * summary claiming it does. Same reasoning as `mcp_status.ts` — one rule, one
 * definition, or the copies drift.
 *
 * THE DIRECTION IS DELIBERATE: this NAMES the three scopes known not to load
 * and returns `true` for everything else, rather than allow-listing the two
 * that do. A future `McpServerView['scope']` value added without touching this
 * file then defaults to "gate it", which costs an unnecessary prompt; the
 * allow-list form would default to "skip the gate", which silently retires
 * TOFU for a declaration nobody has measured. Only one of those two failures is
 * recoverable by the operator.
 *
 * `'cebab-injected'` (the pinned `bus_send` server) is `true` here because it
 * genuinely does load. The gate skips it earlier for its own reason — Cebab
 * declared it, so there is no third party to consent to — and that skip is not
 * this rule's business.
 */
import type { McpServerView } from './protocol.js';

export function mcpOriginLoads(scope: McpServerView['scope']): boolean {
  return scope !== 'user' && scope !== 'project' && scope !== 'local';
}
