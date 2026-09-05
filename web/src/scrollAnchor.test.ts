import { describe, expect, test } from 'vitest';
import { isPinnedToBottom, SCROLL_STICK_THRESHOLD_PX, type ScrollMetrics } from './scrollAnchor';

/**
 * Register W14 — the stick-to-bottom predicate, on synthetic numbers.
 *
 * Plain objects on purpose: jsdom runs no layout, so a rendered element reports
 * all three metrics as `0`. `isPinnedToBottom`'s own JSDoc has the trap that
 * follows from that; this file just needs numbers the environment cannot answer
 * for.
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

/**
 * WHERE the predicate is called, which is the half no assertion above reaches.
 *
 * Every case in this file feeds synthetic numbers to a pure function. All ten
 * of them stay green if a component moves the call from its `onScroll` handler
 * into the effect that reacts to new content — and that move silently
 * reintroduces W14, because by the time the content effect runs `scrollHeight`
 * has already grown, so an operator pinned to the bottom measures as "scrolled
 * up by the height of whatever just arrived". One long tool result and the pane
 * stops following.
 *
 * That claim lived only in `scrollAnchor.ts`'s header until 2026-09-05 — seven
 * lines of prose asking politely, in a file whose test suite could not tell the
 * difference. This is the mechanism version.
 */
describe('W14: the predicate is consulted where the operator chose the position', () => {
  // Vite's ?raw + glob, same idiom as operatorCopy.test.ts — `web/tsconfig.json`
  // sets `types: []`, so a web-side test cannot open a file with `fs`.
  const SOURCES = Object.fromEntries(
    Object.entries(
      import.meta.glob(['./**/*.tsx'], {
        query: '?raw',
        import: 'default',
        eager: true,
      }) as Record<string, string>,
    ).filter(([file]) => !file.endsWith('.test.tsx')),
  );

  const CALL = /\bisPinnedToBottom\s*\(/g;
  const callers = Object.entries(SOURCES).filter(([, src]) => CALL.test(src.replace(CALL, '$&')));

  /** Body of every `useEffect(` in `src`, braces matched. */
  function effectBodies(src: string): string[] {
    const out: string[] = [];
    for (let i = src.indexOf('useEffect('); i !== -1; i = src.indexOf('useEffect(', i + 1)) {
      let depth = 0;
      for (let j = i; j < src.length; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')' && --depth === 0) {
          out.push(src.slice(i, j + 1));
          break;
        }
      }
    }
    return out;
  }

  test('the corpus found the known call sites — anti-vacuity', () => {
    // Both assertions below are "this list is empty", which an empty corpus
    // satisfies for free. Name the two components the register was written
    // about, so a rename or a glob that stops matching fails here first.
    expect(callers.map(([f]) => f).sort()).toEqual([
      './components/ChatView.tsx',
      './components/authRefresh/AuthRefreshModal.tsx',
    ]);
    expect(effectBodies(SOURCES['./components/ChatView.tsx']).length).toBeGreaterThan(0);
  });

  test('no useEffect body calls it', () => {
    const offenders: string[] = [];
    for (const [file, src] of callers) {
      if (effectBodies(src).some((b) => /\bisPinnedToBottom\s*\(/.test(b))) offenders.push(file);
    }
    expect(
      offenders,
      'isPinnedToBottom is called inside a useEffect. By then scrollHeight has ' +
        'already grown, so a scroller pinned to the bottom measures as scrolled ' +
        'up and the pane stops following its tail. Measure in the `scroll` ' +
        'handler, where the number still describes where the operator chose to be.',
    ).toEqual([]);
  });

  test('every call sits in an onScroll handler', () => {
    const offenders: string[] = [];
    for (const [file, src] of callers) {
      for (const m of src.matchAll(/\bisPinnedToBottom\s*\(/g)) {
        // The nearest `onScroll` before the call must be nearer than the
        // nearest `useEffect(` — a positional rule rather than a shape one, so
        // it survives the handler being reformatted or given a name.
        const before = src.slice(0, m.index);
        if (before.lastIndexOf('onScroll') <= before.lastIndexOf('useEffect('))
          offenders.push(file);
      }
    }
    expect(offenders, 'a call to isPinnedToBottom is not inside an onScroll handler').toEqual([]);
  });
});
