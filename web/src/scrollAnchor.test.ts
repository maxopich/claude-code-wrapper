import { describe, expect, test } from 'vitest';
import { isPinnedToBottom, SCROLL_STICK_THRESHOLD_PX, type ScrollMetrics } from './scrollAnchor';

/**
 * Register W14 — the stick-to-bottom predicate, on synthetic numbers.
 *
 * These are plain objects on purpose. The component specs that consume this
 * predicate run under jsdom, where no layout happens and all three metrics
 * read `0`; pinning the rule here means the rule is measured somewhere the
 * environment cannot quietly answer for it. See `scrollAnchor.ts`'s header.
 */

/** A 3000px document in a 600px viewport — bottom is `scrollTop === 2400`. */
const at = (scrollTop: number): ScrollMetrics => ({
  scrollTop,
  scrollHeight: 3000,
  clientHeight: 600,
});

describe('isPinnedToBottom', () => {
  test('exactly at the bottom → pinned', () => {
    expect(isPinnedToBottom(at(2400))).toBe(true);
  });

  test('one pixel inside the threshold → pinned (a nudge does not un-stick it)', () => {
    expect(isPinnedToBottom(at(2400 - (SCROLL_STICK_THRESHOLD_PX - 1)))).toBe(true);
  });

  test('exactly on the threshold → pinned (the bound is inclusive)', () => {
    expect(isPinnedToBottom(at(2400 - SCROLL_STICK_THRESHOLD_PX))).toBe(true);
  });

  test('one pixel past the threshold → NOT pinned', () => {
    expect(isPinnedToBottom(at(2400 - (SCROLL_STICK_THRESHOLD_PX + 1)))).toBe(false);
  });

  test('scrolled well up to read earlier output → NOT pinned (this is W14)', () => {
    expect(isPinnedToBottom(at(0))).toBe(false);
    expect(isPinnedToBottom(at(1200))).toBe(false);
  });

  test('a fractional landing short of the bottom still counts as pinned', () => {
    // A clamped scrollTo can land sub-pixel short on fractional DPRs.
    expect(isPinnedToBottom({ scrollTop: 2399.6, scrollHeight: 3000, clientHeight: 600 })).toBe(
      true,
    );
  });

  test('an explicit threshold overrides the default in both directions', () => {
    expect(isPinnedToBottom(at(2000), 400)).toBe(true);
    expect(isPinnedToBottom(at(2000), 399)).toBe(false);
  });

  test('content shorter than the viewport → pinned (nothing to scroll)', () => {
    expect(isPinnedToBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 600 })).toBe(true);
  });

  /**
   * THE TRAP, asserted rather than described.
   *
   * An unstaged jsdom element reports all zeroes, and this predicate answers
   * `true` — the same answer it gives a real container with nothing to scroll.
   * Same value, opposite meaning. That is why a component spec which renders
   * and asserts without staging `scrollTop`/`scrollHeight`/`clientHeight` can
   * only write the assertion W14 also satisfies: the pane reads as pinned
   * whatever position is assigned, so "scrolled up, so no scroll" is not a weak
   * test but an unwritable one. Measured both ways; `ChatView.test.tsx`'s
   * header records the numbers.
   *
   * If this case ever fails, the two component specs that depend on staged
   * metrics need re-reading, not this line.
   */
  test('all zeroes → pinned, which is why component specs MUST stage metrics', () => {
    expect(isPinnedToBottom({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })).toBe(true);
  });
});

describe('SCROLL_STICK_THRESHOLD_PX', () => {
  test('is a small positive slack, not a disguised "always pinned"', () => {
    // A threshold at or above a viewport height would make every offset count
    // as pinned, restoring W14 while every other case above still passed.
    expect(SCROLL_STICK_THRESHOLD_PX).toBeGreaterThan(0);
    expect(SCROLL_STICK_THRESHOLD_PX).toBeLessThan(100);
  });
});
