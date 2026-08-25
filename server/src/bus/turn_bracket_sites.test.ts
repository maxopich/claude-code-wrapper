import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { SINK_RECIPIENT, USER_RECIPIENT, CEBAB_SOURCE } from './runtime.js';
import { BUS_SENTINEL_RECIPIENTS } from '@cebab/shared';

/**
 * `Cebab-vie.8` — two source-derived claims the detector rests on.
 *
 * Both are the kind a type cannot catch and a behavioural test only catches by
 * accident, so they are asserted against the source and the constants instead.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => fs.readFileSync(path.join(HERE, f), 'utf8');

/**
 * CLAIM 1: every turn is bracketed.
 *
 * The stranded-run count is complete "by construction" only while each router
 * has exactly ONE `deliverTurn` call site and that site is bracketed by
 * `onTurnStarted` / `onTurnSettled`. A second call site added later — a new
 * operator verb, a warm-up turn — would run a turn the count never sees, and
 * the failure is silent and one-directional: the count reads lower than the
 * truth, so the detector reports a wedge on a run that is working.
 *
 * Counting occurrences rather than matching a shape on purpose. The two
 * wirings are near-copies, and what actually goes wrong is a THIRD call
 * appearing, not the existing two being written differently.
 */
describe('every deliverTurn is bracketed by the turn counter', () => {
  test.each(['orchestrator.ts', 'chain.ts'])('%s', (file) => {
    const src = read(file);
    const delivers = src.match(/\.deliverTurn\(/g) ?? [];
    const started = src.match(/router\.onTurnStarted\(/g) ?? [];
    const settled = src.match(/router\.onTurnSettled\(/g) ?? [];
    // Positive control: if the router stopped calling `deliverTurn` at all,
    // 0 === 0 === 0 would pass while nothing worked.
    expect(delivers).toHaveLength(1);
    expect(started).toHaveLength(delivers.length);
    expect(settled).toHaveLength(delivers.length);
  });

  test('the settle runs inside the finally, not the then', () => {
    // Ordering matters and is not visible from the counts. `onWorkerFailed`
    // runs in the `.catch` and writes the `cebab → user` row the detector then
    // reads; a settle hoisted into `.then` would also skip the failure path
    // entirely, so a crashed worker would never settle its own turn.
    for (const file of ['orchestrator.ts', 'chain.ts']) {
      const src = read(file);
      const deliverAt = src.indexOf('.deliverTurn(');
      const finallyAt = src.indexOf('.finally(() => {', deliverAt);
      const settleAt = src.indexOf('router.onTurnSettled(', deliverAt);
      // All three present, in that order — the settle sits after the
      // `.finally(` opener, so it cannot be in the `.then` or the `.catch`.
      expect(deliverAt, file).toBeGreaterThan(-1);
      expect(finallyAt, file).toBeGreaterThan(deliverAt);
      expect(settleAt, file).toBeGreaterThan(finallyAt);
    }
  });
});

/**
 * CLAIM 2: the two spellings of the routing sentinels agree.
 *
 * `shared/src/bus_tail.ts` holds the set because the browser and the server
 * must answer "is this tail awaiting an agent?" identically. The server also
 * needs the three one at a time, which is what `bus/runtime.ts` has always
 * provided — so there are two spellings, and this is what keeps them one rule.
 */
describe('the shared sentinel set matches the router constants', () => {
  test('same three, no more and no fewer', () => {
    expect([...BUS_SENTINEL_RECIPIENTS].sort()).toEqual(
      [SINK_RECIPIENT, USER_RECIPIENT, CEBAB_SOURCE].sort(),
    );
  });
});
