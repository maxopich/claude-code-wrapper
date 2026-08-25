/**
 * `Cebab-vie.8` — the tail rule, from both sides.
 *
 * The value of this file is not that `tailAwaitsAgent` returns booleans; it is
 * that the rule has exactly one definition and both readers agree about every
 * member of the sentinel set. So each sentinel gets its own case rather than a
 * "some falsy" sweep: a two-of-three implementation passes any assertion that
 * only checks "at least one destination is excluded".
 *
 * The positive control is the point of the negative ones. A predicate that
 * always returned false would satisfy every "does not await" case here, so the
 * agent-destination case runs first and is asserted per kind.
 */
import { describe, expect, test } from 'vitest';
import { BUS_SENTINEL_RECIPIENTS, tailAwaitsAgent } from './bus_tail.js';

describe('tailAwaitsAgent — positive control', () => {
  // Reddens if the predicate is inverted, hard-coded false, or narrowed to
  // one event kind. `intro`/`prompt`/`reply`/`final` are the four non-error
  // members of the closed kind set, and all four are real deliveries.
  test.each(['intro', 'prompt', 'reply', 'final'])(
    'a %s addressed to an agent means that agent was woken',
    (kind) => {
      expect(tailAwaitsAgent({ destination: 'scribe', kind })).toBe(true);
    },
  );

  test('the orchestrator is an agent, not a sentinel', () => {
    // Deliberate: the orchestrator runs real turns, so a tail pointing at it
    // means it is computing. Reddens if `orchestrator` is ever added to the
    // sentinel set "for symmetry" with `user`/`_sink`/`cebab`.
    expect(tailAwaitsAgent({ destination: 'orchestrator', kind: 'reply' })).toBe(true);
    expect(BUS_SENTINEL_RECIPIENTS.has('orchestrator')).toBe(false);
  });
});

describe('tailAwaitsAgent — the cases that mean nobody is computing', () => {
  // One case per sentinel. A rule that dropped any single member would leave
  // the other two green, which is exactly how a partial fix survives review.
  test.each([...BUS_SENTINEL_RECIPIENTS])('a tail addressed to %s awaits nobody', (dest) => {
    expect(tailAwaitsAgent({ destination: dest, kind: 'reply' })).toBe(false);
  });

  test('an error to an agent awaits nobody', () => {
    // Reddens if the `kind === 'error'` arm is removed. Kept because the web
    // activity bar has excluded it since `activeAgent` was written — the
    // server-side detector exists to match that bar, not to re-decide it.
    expect(tailAwaitsAgent({ destination: 'scribe', kind: 'error' })).toBe(false);
  });

  test('no events at all awaits nobody', () => {
    expect(tailAwaitsAgent(null)).toBe(false);
    expect(tailAwaitsAgent(undefined)).toBe(false);
  });
});

describe('the sentinel set', () => {
  test('is exactly the three routing sentinels', () => {
    // A by-value assertion, not a size check: a set that swapped a member for
    // a typo would keep its size. Sorted so the assertion does not depend on
    // insertion order.
    expect([...BUS_SENTINEL_RECIPIENTS].sort()).toEqual(['_sink', 'cebab', 'user']);
  });
});
