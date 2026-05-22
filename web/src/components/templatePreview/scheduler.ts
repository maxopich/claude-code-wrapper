/**
 * Random-trip scheduler for the orchestrator preview animation.
 *
 * The visualization is "runtime-honest": at most one message is in flight
 * at any tick (mirrors the orchestrator's single sequential `deliver()`
 * wake), and the next addressee is picked with anti-repeat random so the
 * viewer doesn't infer a fixed routing order. The actual runtime picks
 * recipients by capability + prompt content — the tooltip says so — but
 * the animation has to fill in some order, and "random with anti-repeat"
 * is the least misleading choice (uniform + non-periodic).
 *
 * `chooseNextTrip(prev, n, rng)` returns an index in `[0, n)`. RNG is
 * injectable so tests can seed deterministically via `mulberry32`. The
 * production caller passes `Math.random` (default).
 *
 * Anti-repeat window: the last `k = min(n-1, 3)` destinations are
 * excluded. With N=5 and k=3, every destination is hit within any window
 * of 4 trips (liveness). N=2 degenerates to strict alternation. N=1 is
 * never invoked (the orchestrator effect short-circuits at workers.length=0,
 * and a single worker would loop on itself, which we treat as a no-op).
 */

export function chooseNextTrip(prev: number[], n: number, rng: () => number = Math.random): number {
  if (n <= 0) throw new Error('chooseNextTrip: n must be ≥ 1');
  if (n === 1) return 0;
  const k = Math.min(n - 1, 3);
  const recent = prev.slice(-k);
  const candidates: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!recent.includes(i)) candidates.push(i);
  }
  // candidates is guaranteed non-empty: at most k = n-1 excluded.
  return candidates[Math.floor(rng() * candidates.length)]!;
}

/**
 * Seeded PRNG for deterministic tests. Pulled from the standard
 * mulberry32 reference — fast, good distribution for N=10k draws, no
 * dependency. NOT cryptographically secure; never use for anything that
 * touches the bus or auth.
 */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
