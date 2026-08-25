import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { stripComments } from '../test_support/strip_comments.js';

/**
 * `Cebab-vie.17` — the bus's two ceilings are resolved at the same seams, and
 * the next seam will be added by someone who only remembers one of them.
 *
 * `hopBudget` and `maxTurns` are re-resolved together at every bus session
 * start and resume, and there are five such places in this file. The three
 * RESUME seams are gated by the compiler — `maxTurns` is required on
 * `ResumeCallbacks` and on the reconstruct callbacks, exactly as `hopBudget`
 * already was — but the two START seams take an optional field, matching how
 * `hopBudget` has always been declared on the routers' start opts, so a sixth
 * site could quietly resolve one and not the other.
 *
 * The consequence of missing one is deliberately mild and therefore easy to
 * ship: the runner floors an absent cap at `config.maxTurns`, so the run is
 * still BOUNDED — it just silently ignores the number the operator typed into
 * Settings. Bounded-but-wrong is the kind of defect no behavioural test asks
 * about, which is why this one reads the source.
 *
 * Deliberately NOT a check that the two are equal or that either is correct:
 * it asks only that a site resolving one resolves the other, which is the
 * single thing a copy-paste gets wrong.
 */

const SERVER_TS = fileURLToPath(new URL('./server.ts', import.meta.url));

/** How far from a `resolveHopBudget()` use its `resolveMaxTurns(` sibling may sit. */
const WINDOW_LINES = 40;

/** Line numbers (1-based) of every `resolveHopBudget()` USE, declaration excluded. */
export function budgetSites(source: string): number[] {
  return stripComments(source)
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.includes('resolveHopBudget()'))
    .filter(({ line }) => !line.includes('function resolveHopBudget'))
    .map(({ n }) => n);
}

/** The subset of `budgetSites` with no `resolveMaxTurns(` within the window. */
export function unpairedSites(source: string): number[] {
  const lines = stripComments(source).split('\n');
  return budgetSites(source).filter((n) => {
    const from = Math.max(0, n - 1 - WINDOW_LINES);
    const to = Math.min(lines.length, n + WINDOW_LINES);
    return !lines.slice(from, to).some((l) => l.includes('resolveMaxTurns('));
  });
}

describe('every hop-budget resolution site resolves the turn cap too', () => {
  const source = fs.readFileSync(SERVER_TS, 'utf8');

  test('the scan found the sites it is meant to be checking', () => {
    // Anti-vacuity floor. Without it a rename of `resolveHopBudget` turns the
    // assertion below into "[] equals []" — the shape of a gate that measures
    // nothing while staying green.
    expect(budgetSites(source).length).toBeGreaterThanOrEqual(5);
  });

  test('no site resolves one ceiling and not the other', () => {
    expect(unpairedSites(source)).toEqual([]);
  });
});

describe('[security] the scanner reports an unpaired site rather than skipping it', () => {
  // Both halves required, failing for opposite reasons: the first would pass
  // if the scan found nothing, the second if it paired everything.

  test('a lone budget resolution is reported at its own line', () => {
    const src = ['const a = 1;', 'hopBudget: resolveHopBudget(),', 'const b = 2;'].join('\n');
    expect(unpairedSites(src)).toEqual([2]);
  });

  test('a paired one is not', () => {
    const src = ['hopBudget: resolveHopBudget(),', 'maxTurns: resolveMaxTurns(),'].join('\n');
    expect(unpairedSites(src)).toEqual([]);
  });

  test('a pairing that exists only in a COMMENT does not count', () => {
    // The most likely near-miss: a note saying the cap is handled elsewhere.
    const src = [
      '// resolveMaxTurns( is applied by the caller for this one',
      'hopBudget: resolveHopBudget(),',
    ].join('\n');
    expect(unpairedSites(src)).toEqual([2]);
  });

  test('the declaration itself is not a site', () => {
    const src = ['function resolveHopBudget(): number {', '  return 30;', '}'].join('\n');
    expect(budgetSites(src)).toEqual([]);
  });
});
