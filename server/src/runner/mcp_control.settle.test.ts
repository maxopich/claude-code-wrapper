/**
 * `Cebab-ormv`: the settle loop, and the browser run that produced it.
 *
 * WHAT WENT WRONG. The first implementation read status once, the instant the
 * control session came up. Driven against the Playground's `omega-manymcp`,
 * SIX healthy servers reported `pending` with `0 tools` — including connectors
 * a standalone probe had measured moments earlier carrying 29, 11, 9 and 8
 * tools — and each was offered a Reconnect it did not need. The second read
 * was byte-identical, so this was not an unlucky race; reading at t=0 was the
 * design, and the design reproduced the exact frozen-snapshot defect the whole
 * feature exists to fix.
 *
 * No fixture would have caught it. The shape it needed was a REMOTE server
 * taking seconds to finish connecting, and a unit test's fake answers instantly.
 * So the loop is the thing under test here and the timing is injected.
 */
import { describe, expect, test } from 'vitest';
import type { McpServerLive } from '@cebab/shared';
import { readSettledStatus } from './mcp_control.js';

const row = (name: string, status: string, tools: string[] = []): McpServerLive => ({
  name,
  status,
  toolNames: tools,
});

/** A fake that serves a scripted sequence of reads, so a test can describe a
 *  server that settles on the Nth look. */
function scripted(sequence: McpServerLive[][]) {
  let i = 0;
  const calls: number[] = [];
  return {
    read: async () => {
      calls.push(i);
      const out = sequence[Math.min(i, sequence.length - 1)] as McpServerLive[];
      i += 1;
      return out;
    },
    reads: () => calls.length,
  };
}

/** Clock + sleep that advance together without spending real time. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe('readSettledStatus', () => {
  test('THE BUG: a server still connecting is waited for, not reported as pending', async () => {
    const s = scripted([
      [row('gmail', 'pending')],
      [row('gmail', 'pending')],
      [row('gmail', 'connected', ['a', 'b'])],
    ]);
    const clock = fakeClock();
    const out = await readSettledStatus(s.read, { ...clock, intervalMs: 400, budgetMs: 11_000 });
    expect(out).toEqual([row('gmail', 'connected', ['a', 'b'])]);
    // And the tool list arrives with it — the thing the operator most notices
    // missing, because a pending row always reads `0 tools`.
    expect(out[0]?.toolNames).toHaveLength(2);
  });

  test('CONTROL: an already-settled read costs exactly one look', async () => {
    // Without this the case above passes for an implementation that always
    // polls to the budget, which would put 11s on every refresh.
    const s = scripted([[row('gmail', 'connected')]]);
    const clock = fakeClock();
    await readSettledStatus(s.read, { ...clock });
    expect(s.reads()).toBe(1);
    expect(clock.now()).toBe(0);
  });

  test('a genuinely stuck server ends the wait at the budget and reports pending', async () => {
    // `sloth` in the Playground delays 8s; something slower than the budget
    // must still produce an answer rather than hanging the panel.
    const s = scripted([[row('sloth', 'pending')]]);
    const clock = fakeClock();
    const out = await readSettledStatus(s.read, { ...clock, intervalMs: 400, budgetMs: 2_000 });
    expect(out).toEqual([row('sloth', 'pending')]);
    expect(clock.now()).toBeGreaterThanOrEqual(2_000);
    // Bounded, not unbounded: ~budget/interval looks, not hundreds.
    expect(s.reads()).toBeLessThanOrEqual(8);
  });

  test('needs-auth and failed are FINAL answers and are not waited on', async () => {
    // The dangerous direction. These never become connected on their own, so
    // waiting would put the budget on every read of a broken server — and the
    // operator would stare at a spinner instead of the Authenticate button.
    for (const status of ['needs-auth', 'failed', 'disabled', 'connected']) {
      const s = scripted([[row('x', status)]]);
      const clock = fakeClock();
      await readSettledStatus(s.read, { ...clock });
      expect(s.reads(), `${status} should settle immediately`).toBe(1);
    }
  });

  test('a status Cebab has never seen counts as settled', async () => {
    // The safe direction, and the opposite of what `mcp_status.ts` does for the
    // health question. Treating an unknown value as transient would spin for
    // the whole budget and return the same row anyway.
    const s = scripted([[row('x', 'some-future-status')]]);
    const clock = fakeClock();
    await readSettledStatus(s.read, { ...clock });
    expect(s.reads()).toBe(1);
  });

  test('a mixed roster waits for the pending one and keeps the rest', async () => {
    const s = scripted([
      [row('ok', 'connected', ['t']), row('slow', 'pending'), row('dead', 'failed')],
      [row('ok', 'connected', ['t']), row('slow', 'connected', ['u']), row('dead', 'failed')],
    ]);
    const clock = fakeClock();
    const out = await readSettledStatus(s.read, { ...clock });
    expect(out.map((r) => r.status)).toEqual(['connected', 'connected', 'failed']);
  });

  test('an empty roster settles immediately rather than waiting on nothing', async () => {
    const s = scripted([[]]);
    const clock = fakeClock();
    expect(await readSettledStatus(s.read, { ...clock })).toEqual([]);
    expect(s.reads()).toBe(1);
  });
});
