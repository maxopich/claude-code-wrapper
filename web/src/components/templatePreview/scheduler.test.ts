import { describe, expect, test } from 'vitest';
import { chooseNextTrip, mulberry32 } from './scheduler';

/**
 * Liveness predicate for AC-15 (random anti-repeat with liveness).
 *
 * For N=5, RNG seeded with 42, 16 trips:
 *   1. Coverage: every destination is visited at least once
 *   2. No-repeat in window of 3 (since k=min(N-1,3)=3): dest[i] ∉ {dest[i-1], dest[i-2], dest[i-3]}
 *   3. Determinism: same seed → identical dest[]
 *   4. Degenerate: N=2 → strict alternation; N=1 → branch not invoked at runtime
 */

function runTrips(n: number, seed: number, count: number): number[] {
  const rng = mulberry32(seed);
  const prev: number[] = [];
  const dest: number[] = [];
  for (let i = 0; i < count; i++) {
    const next = chooseNextTrip(prev, n, rng);
    dest.push(next);
    prev.push(next);
    if (prev.length > 3) prev.shift();
  }
  return dest;
}

describe('chooseNextTrip — liveness (AC-15)', () => {
  test('N=5 seed=42 16 trips: coverage', () => {
    const dest = runTrips(5, 42, 16);
    expect(new Set(dest).size).toBe(5);
  });

  test('N=5 seed=42 16 trips: no repeat in window of 3', () => {
    const dest = runTrips(5, 42, 16);
    for (let i = 1; i < dest.length; i++) {
      const window = dest.slice(Math.max(0, i - 3), i);
      expect(window).not.toContain(dest[i]);
    }
  });

  test('N=5 determinism: same seed → identical sequence', () => {
    const a = runTrips(5, 42, 32);
    const b = runTrips(5, 42, 32);
    expect(a).toEqual(b);
  });

  test('N=5 different seeds diverge', () => {
    const a = runTrips(5, 42, 32);
    const b = runTrips(5, 1729, 32);
    expect(a).not.toEqual(b);
  });

  test('N=2 strict alternation (k=1 excludes only the previous)', () => {
    const dest = runTrips(2, 42, 20);
    for (let i = 1; i < dest.length; i++) {
      expect(dest[i]).not.toBe(dest[i - 1]);
    }
    // And the only valid sequence under strict alternation has both values
    expect(new Set(dest).size).toBe(2);
  });

  test('N=1 short-circuits to 0 (degenerate)', () => {
    expect(chooseNextTrip([], 1)).toBe(0);
    expect(chooseNextTrip([0], 1)).toBe(0);
  });

  test('throws on N=0', () => {
    expect(() => chooseNextTrip([], 0)).toThrow();
  });
});

describe('chooseNextTrip — uniformity (within window) over 10k draws', () => {
  test('N=4, distribution within 5% of uniform across the long run', () => {
    const rng = mulberry32(123);
    const counts = [0, 0, 0, 0];
    const prev: number[] = [];
    const trials = 10000;
    for (let i = 0; i < trials; i++) {
      const next = chooseNextTrip(prev, 4, rng);
      counts[next]!++;
      prev.push(next);
      if (prev.length > 3) prev.shift();
    }
    const expected = trials / 4;
    const tolerance = expected * 0.05;
    for (const c of counts) {
      expect(Math.abs(c - expected)).toBeLessThan(tolerance);
    }
  });
});

describe('chooseNextTrip — anti-repeat window size scales with N', () => {
  test('N=3 uses k=2 (last 2 excluded)', () => {
    // With k=2 and N=3, the candidate after [0,1] must be 2.
    const dest = runTrips(3, 42, 30);
    for (let i = 2; i < dest.length; i++) {
      const window = [dest[i - 1], dest[i - 2]];
      expect(window).not.toContain(dest[i]);
    }
  });

  test('N=10 uses k=3 (caps at 3 even though N-1=9)', () => {
    const dest = runTrips(10, 42, 100);
    for (let i = 3; i < dest.length; i++) {
      const window = [dest[i - 1], dest[i - 2], dest[i - 3]];
      expect(window).not.toContain(dest[i]);
    }
    // Coverage check: 10 workers should all be hit within 100 trips.
    expect(new Set(dest).size).toBe(10);
  });
});

describe('mulberry32 — basic sanity', () => {
  test('seed produces deterministic sequence', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    for (let i = 0; i < 50; i++) expect(a()).toBe(b());
  });

  test('output is in [0, 1)', () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
