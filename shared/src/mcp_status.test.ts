import { describe, expect, test } from 'vitest';
import { mcpToolPrefix, notConnected, toolsForMcpServer } from './mcp_status.js';

/**
 * Cebab-ws0.2. The rule under test is "not connected", not "on a list of bad
 * statuses", so the case that matters most is the one nobody has seen yet: a
 * status string this code has never heard of still has to count.
 */
describe('notConnected', () => {
  test('keeps every status that is not exactly connected, including an unknown one', () => {
    // `failed` and `needs-auth` are the two the reported incident produced;
    // `disabled` is the operator's own switch and still means zero tools; and
    // `some-future-status` stands for whatever the SDK adds next. Narrowing
    // this to an allow-list of known-bad values reddens here, on the last one
    // — which is exactly the blind spot this bead exists to close.
    const out = notConnected([
      { name: 'alpha', status: 'connected' },
      { name: 'bravo', status: 'failed' },
      { name: 'charlie', status: 'needs-auth' },
      { name: 'delta', status: 'disabled' },
      { name: 'echo', status: 'some-future-status' },
    ]);
    expect(out.map((s) => s.name)).toEqual(['bravo', 'charlie', 'delta', 'echo']);
    // The status is carried through untouched — nothing downstream may render
    // a cause the SDK did not report.
    expect(out.map((s) => s.status)).toEqual([
      'failed',
      'needs-auth',
      'disabled',
      'some-future-status',
    ]);
  });

  test('CONTROL: an all-connected list, an empty list and an absent list all yield nothing', () => {
    // Without this the assertion above passes just as well on a function that
    // returns its input.
    expect(
      notConnected([
        { name: 'alpha', status: 'connected' },
        { name: 'bravo', status: 'connected' },
      ]),
    ).toEqual([]);
    expect(notConnected([])).toEqual([]);
    expect(notConnected(undefined)).toEqual([]);
  });

  test('reported order is preserved', () => {
    const out = notConnected([
      { name: 'zulu', status: 'failed' },
      { name: 'alpha', status: 'failed' },
    ]);
    expect(out.map((s) => s.name)).toEqual(['zulu', 'alpha']);
  });
});

/**
 * Cebab-as7x. The prefix rule is measured, not assumed: a live session on
 * 2026-09-15 reported twelve loaded servers and 60 `mcp__` tools, and the
 * distinct prefixes were `atlas, beacon, cinder, claude_ai_Gmail,
 * claude_ai_Google_Calendar, claude_ai_Google_Drive, delta, ember` against
 * server names that included `"claude.ai Gmail"` and `"claude.ai Google
 * Calendar"`.
 */
describe('mcpToolPrefix / toolsForMcpServer — the name is not the prefix (Cebab-as7x)', () => {
  test('non-word characters become underscores, measured against a real session', () => {
    expect(mcpToolPrefix('claude.ai Gmail')).toBe('claude_ai_Gmail');
    expect(mcpToolPrefix('claude.ai Google Calendar')).toBe('claude_ai_Google_Calendar');
    // A plain name is its own prefix — the case that made the old raw-name
    // comparison look correct everywhere it was tested.
    expect(mcpToolPrefix('atlas')).toBe('atlas');
    // Underscores are already legal and must not be doubled or stripped.
    expect(mcpToolPrefix('cebab_bus')).toBe('cebab_bus');
  });

  test('tools are attributed to the server that contributed them', () => {
    const toolNames = [
      'Bash',
      'mcp__atlas__atlas_echo',
      'mcp__atlas__atlas_ping',
      'mcp__claude_ai_Gmail__send',
      'mcp__beacon__beacon_ping',
    ];
    expect(toolsForMcpServer('atlas', toolNames)).toEqual([
      'mcp__atlas__atlas_echo',
      'mcp__atlas__atlas_ping',
    ]);
    // The case the raw-name comparison got wrong, and the reason the whole
    // availability rule silently did not run for connectors.
    expect(toolsForMcpServer('claude.ai Gmail', toolNames)).toEqual(['mcp__claude_ai_Gmail__send']);
    // A server that contributed none — the honest answer for one that loaded
    // and did not connect. Must not collapse into "we did not look".
    expect(toolsForMcpServer('sloth', toolNames)).toEqual([]);
  });

  test('a prefix is not matched by a longer server name that starts the same way', () => {
    // `mcp__atlas__x` must not be claimed by a server called `atlas2`, and
    // `mcp__atlas2__y` must not be claimed by `atlas`. The `__` delimiter is
    // what makes this exact; a `startsWith(name)` would get both wrong.
    const toolNames = ['mcp__atlas__x', 'mcp__atlas2__y'];
    expect(toolsForMcpServer('atlas', toolNames)).toEqual(['mcp__atlas__x']);
    expect(toolsForMcpServer('atlas2', toolNames)).toEqual(['mcp__atlas2__y']);
  });
});
