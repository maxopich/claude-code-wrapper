import { describe, expect, test } from 'vitest';
import { mcpOriginLoads } from './mcp_origin.js';
import type { McpServerView } from './protocol.js';

/**
 * `Cebab-6fax.42` item 3. The predicate that decides whether a declaration is
 * one the CLI can start a server from — and therefore whether the operator is
 * asked to consent to it.
 *
 * The table it encodes is measured, not assumed: `mcp_scope_smoke.ts` Parts 2
 * and 3 write each of these four files in a temp project and read
 * `system/init.mcp_servers`, with a control declaration in the same spawn so a
 * directory the CLI never read cannot pass as a negative.
 */
describe('[security] mcpOriginLoads', () => {
  test('the two origins the CLI loads from are gated', () => {
    // The positive half. If these ever return false the TOFU gate goes silent
    // for the servers that actually run, which is the failure that matters.
    expect(mcpOriginLoads('mcp-json')).toBe(true);
    expect(mcpOriginLoads('claude-json')).toBe(true);
  });

  test('the three settings-layer scopes are not', () => {
    expect(mcpOriginLoads('user')).toBe(false);
    expect(mcpOriginLoads('project')).toBe(false);
    expect(mcpOriginLoads('local')).toBe(false);
  });

  test('an unrecognised scope is gated, not skipped', () => {
    // The direction check, and the reason the implementation names the three
    // it excludes instead of allow-listing the two it admits. A scope value
    // added to `McpServerView` later reaches this function without anyone
    // editing it; under an allow-list that new declaration would silently skip
    // TOFU. Here it costs a prompt instead — recoverable, in a way that a
    // retired gate is not.
    expect(mcpOriginLoads('unknown')).toBe(true);
    expect(mcpOriginLoads('cebab-injected')).toBe(true);
    expect(mcpOriginLoads('some-future-origin' as McpServerView['scope'])).toBe(true);
  });

  test('every scope the protocol declares has an answer here', () => {
    // Anti-vacuity: the three cases above enumerate scopes by hand, so a new
    // union member could be added and tested nowhere. Total functions cannot
    // be checked at runtime, so this asserts the property that matters — no
    // scope throws, and at least one of each verdict exists, which fails if a
    // future edit collapses the function to a constant.
    const all: McpServerView['scope'][] = [
      'user',
      'project',
      'local',
      'mcp-json',
      'claude-json',
      'cebab-injected',
      'unknown',
    ];
    const verdicts = all.map(mcpOriginLoads);
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
  });
});
