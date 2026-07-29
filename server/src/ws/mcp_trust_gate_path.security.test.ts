import { describe, expect, test } from 'vitest';
import { isUngatedTrustDecisionAllowed, type McpTrustDecisionKind } from './server.js';

// [security] `mcp_trust_decision` has two entry paths. Path A answers a gate
// entry Cebab parked while blocking a spawn; path B is the AuthorityPanel
// affordance with nothing parked.
//
// Path B used to persist `trust` / `trust_pinned` too. That was a
// self-approving bypass of the TOFU gate: `mcp_trust` rows are exactly what
// `awaitMcpTrustDecisions` consults, so anything that can send this message
// could pre-seed a row and have the operator's NEXT session-start silently
// skip the prompt for an attacker-chosen MCP server. It matters because a bus
// agent runs as the operator's uid — it can read ~/.cebab/auth-token and open
// its own WS connection (see server/src/auth.ts).
//
// The invariant: path B may only ever REDUCE authority.

describe('[security] ungated MCP trust decisions', () => {
  test('escalating decisions are gate-only', () => {
    expect(isUngatedTrustDecisionAllowed('trust')).toBe(false);
    expect(isUngatedTrustDecisionAllowed('trust_pinned')).toBe(false);
  });

  test('denials need no parked gate — refusing authority is always safe', () => {
    expect(isUngatedTrustDecisionAllowed('deny_once')).toBe(true);
    expect(isUngatedTrustDecisionAllowed('deny_remember')).toBe(true);
  });

  test('every decision kind is classified explicitly', () => {
    // Guards the case where a new decision kind is added to the wire type and
    // silently inherits a permissive default. The switch is exhaustive, so a
    // new kind is a compile error there; this pins the runtime side.
    const all: McpTrustDecisionKind[] = ['trust', 'trust_pinned', 'deny_once', 'deny_remember'];
    for (const d of all) {
      expect(typeof isUngatedTrustDecisionAllowed(d)).toBe('boolean');
    }
  });
});
