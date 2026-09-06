/**
 * Cebab-ph8r [security]: every multi-agent preflight must declare that its
 * projects run with all three setting scopes.
 *
 * `AuthorityPreflightModal` is shared: the single-agent new-chat preview opens
 * the same body, and there the Trust-derived scope rule is TRUE. The difference
 * is carried by one optional prop, and an optional prop is exactly what a fourth
 * call site forgets — the panel would silently go back to telling the operator
 * that a project hook is inert on a path that auto-executes it every hop.
 *
 * The unit tests next to the panel prove it renders correctly when the prop is
 * passed. Only this proves it IS passed, and `MultiAgentTab.tsx` has no test
 * file of its own that mounts the button.
 */
import { describe, expect, test } from 'vitest';

const SOURCES = Object.fromEntries(
  Object.entries(
    import.meta.glob(['./components/MultiAgentTab.tsx'], {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>,
  ),
);

describe('every multi-agent AuthorityPreflightModal declares bus scopes', () => {
  test('the source was actually loaded — this gate is not scanning nothing', () => {
    expect(Object.keys(SOURCES)).toHaveLength(1);
    expect(Object.values(SOURCES)[0].length).toBeGreaterThan(10_000);
  });

  test('there is at least one call site to check', () => {
    // Anti-vacuity in the other direction: if the component were renamed, the
    // per-site assertion below would iterate an empty list and pass.
    const src = Object.values(SOURCES)[0];
    expect([...src.matchAll(/<AuthorityPreflightModal\b/g)].length).toBeGreaterThanOrEqual(3);
  });

  test('every call site passes runsWithAllScopes', () => {
    const src = Object.values(SOURCES)[0];
    const offenders: string[] = [];
    for (const m of src.matchAll(/<AuthorityPreflightModal\b/g)) {
      // The element runs from the tag to its self-closing `/>`.
      const end = src.indexOf('/>', m.index);
      const element = src.slice(m.index, end === -1 ? m.index + 400 : end);
      if (!/\brunsWithAllScopes\b/.test(element)) {
        offenders.push(element.replace(/\s+/g, ' ').slice(0, 120));
      }
    }
    expect(offenders).toEqual([]);
  });
});
