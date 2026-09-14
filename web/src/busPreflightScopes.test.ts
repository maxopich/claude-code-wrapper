/**
 * Cebab-6fax.21 [security]: a multi-agent preflight must honour each
 * participant's Trust — it may NOT force the "all scopes load whatever Trust
 * says" override on.
 *
 * The maintainer's 2026-09-10 decision reversed Cebab-ph8r: a bus participant
 * now runs `settingSources: ['user']` when its project is untrusted, exactly
 * like an untrusted single-agent session, so an untrusted participant's project
 * hooks and `.mcp.json` servers really are inert. The panel resolves each
 * participant trust-derived on the server (`respondWithProjectAuthority`); the
 * `runsWithAllScopes` UI override that used to fold those declarations into the
 * loaded lists is gone. A call site that re-introduced it would OVERSTATE a
 * participant's authority — telling the operator a hook auto-executes when Trust
 * is off keeps it inert.
 *
 * The prop no longer exists, so a stray `runsWithAllScopes` also reddens
 * typecheck; this gate is the behavioural statement of the same rule, and
 * `MultiAgentTab.tsx` has no test file of its own that mounts the button.
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

describe('no multi-agent AuthorityPreflightModal forces all-scopes', () => {
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

  test('no call site passes runsWithAllScopes', () => {
    const src = Object.values(SOURCES)[0];
    const offenders: string[] = [];
    for (const m of src.matchAll(/<AuthorityPreflightModal\b/g)) {
      // The element runs from the tag to its self-closing `/>`.
      const end = src.indexOf('/>', m.index);
      const element = src.slice(m.index, end === -1 ? m.index + 400 : end);
      if (/\brunsWithAllScopes\b/.test(element)) {
        offenders.push(element.replace(/\s+/g, ' ').slice(0, 120));
      }
    }
    expect(offenders).toEqual([]);
  });
});
