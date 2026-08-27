/**
 * The rehearsal, run by CI.
 *
 * `scripts/loop-rehearsal.mjs` is the only thing that executes the loop's
 * green path — WATCH-green -> LAND -> merge -> close the bead -> next bead from
 * an advanced `main` — which ten real iterations never once reached. A harness
 * nothing runs is a harness that quietly stops working, which is the
 * `scripts/kanban-sync.mjs` trap: 20 tests, gitignored, never gated, and
 * nobody noticed. So it is wired here rather than left to a manual command.
 *
 * SKIPPED ON WINDOWS, and the reason is mechanical rather than a shrug: the
 * fake `gh`/`bd`/`npm`/`claude` are `#!/usr/bin/env node` scripts found on
 * PATH, and Windows needs a `.cmd` shim for each. The driver itself is
 * exercised on every platform by `scripts/loop.test.mjs`; what only runs here
 * is the end-to-end wiring. Where that mattered — the stale-main decision —
 * the rule was extracted into `landedOnStaleMain` so it is pinned everywhere.
 *
 * Each scenario spawns a real `node scripts/loop.mjs` against a real scratch
 * git repo, so the timeout is generous: this is minutes-scale work compressed
 * into seconds, not a unit test.
 */
import { describe, expect, test } from 'vitest';

import { SCENARIO_NAMES, rehearse } from './loop-rehearsal.mjs';

const SUPPORTED = process.platform !== 'win32';

describe.skipIf(!SUPPORTED)('the loop rehearses its green path (Cebab-qd2.12)', () => {
  for (const name of SCENARIO_NAMES) {
    test(
      name,
      () => {
        const [result] = rehearse([name]);
        // The failure strings ARE the report — each names the property that did
        // not hold, so a red here says what broke without opening the harness.
        expect(result.failures).toEqual([]);
      },
      240000,
    );
  }
});

test('every scenario is actually wired into the suite above', () => {
  // Reddens if a scenario is added to the harness and never run. The loop-level
  // version of the same idea as the single-emit-point tests: the list and the
  // thing that consumes it must not drift.
  expect(SCENARIO_NAMES.length).toBeGreaterThanOrEqual(15);
  expect(SCENARIO_NAMES).toContain('green-merge');
  expect(SCENARIO_NAMES).toContain('queued');
  // The three that carry a P0/P1 fix each and have no unit-test equivalent —
  // a restart, a repair budget and a bead label are all end-to-end facts. A
  // silent deletion here is exactly the vacuity this file exists to prevent.
  expect(SCENARIO_NAMES).toContain('driver-stale');
  expect(SCENARIO_NAMES).toContain('capped-keeps-repair');
  expect(SCENARIO_NAMES).toContain('declined');
});
