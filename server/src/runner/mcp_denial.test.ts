import { describe, expect, test } from 'vitest';

import { mcpDenialOptions } from './claude.js';

// Register H04: the two SDK knobs a denial turns into.
//
// Both were MEASURED against @anthropic-ai/claude-agent-sdk 0.3.201 with a
// real MCP stdio server, reading `system/init.mcp_servers`:
//
//   settings.deniedMcpServers  → the server is ABSENT from mcp_servers and
//                                exposes no tools. The process never starts.
//   disallowedTools mcp__x__*  → the server still reports 'connected'; only
//                                its tools are gone.
//
// That asymmetry is the whole reason both are emitted: the first is the
// actual enforcement, the second is defense-in-depth for the case where the
// flag-settings layer is honoured less completely than documented. A future
// edit that drops `settings` and keeps only `disallowedTools` would look
// harmless and would silently let denied binaries run again — so the shape is
// pinned here rather than left to a comment.
describe('[security] mcpDenialOptions', () => {
  test('no denials produces no options at all', () => {
    // Byte-identical to pre-H04 behaviour for the overwhelmingly common case:
    // a run with nothing denied must not acquire a settings layer.
    expect(mcpDenialOptions(undefined)).toEqual({});
    expect(mcpDenialOptions([])).toEqual({});
  });

  test('a denial blocks the server AND strips its tools', () => {
    const out = mcpDenialOptions(['evil']);
    expect(out.settings).toEqual({ deniedMcpServers: [{ serverName: 'evil' }] });
    expect(out.disallowedTools).toEqual(['mcp__evil__*']);
  });

  test('the tool spec uses the SDK server-level wildcard, not an enumeration', () => {
    // `mcp__server__*` is native SDK syntax (sdk.d.ts:48) and removes every
    // tool from that server, including ones Cebab has never observed. Listing
    // known tool names instead would miss anything the server adds later.
    expect(mcpDenialOptions(['a']).disallowedTools).toEqual(['mcp__a__*']);
  });

  test('several denied servers each get both layers', () => {
    const out = mcpDenialOptions(['one', 'two']);
    expect(out.settings).toEqual({
      deniedMcpServers: [{ serverName: 'one' }, { serverName: 'two' }],
    });
    expect(out.disallowedTools).toEqual(['mcp__one__*', 'mcp__two__*']);
  });

  test('duplicates collapse', () => {
    // The same server can be refused twice in one gate pass — a persisted
    // denied_remember AND a per-session deny_once both push a row.
    const out = mcpDenialOptions(['dup', 'dup']);
    expect(out.settings).toEqual({ deniedMcpServers: [{ serverName: 'dup' }] });
    expect(out.disallowedTools).toEqual(['mcp__dup__*']);
  });
});
