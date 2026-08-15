// @vitest-environment jsdom
// App.tsx reads `window.location` at module scope, so importing it needs a DOM
// even for a pure helper — same reason composerReason.test.tsx opts in.
import { describe, expect, test, vi } from 'vitest';
import { sendThenApply } from './App';

/**
 * Register W29: the UI may only show a decision as made once it has gone out.
 *
 * The permission card used to dispatch `permission_decided` first — flipping
 * its buttons to "decided: …" — and then call `send`, which returned nothing
 * and silently swallowed the message on a socket that was still connecting.
 * The operator was left looking at "Allowed" while the agent stayed parked in
 * `canUseTool`, with no card left to answer.
 *
 * Every refusal is paired with the control that proves the permitted path
 * still works: a version that simply never applied would satisfy the first
 * case on its own.
 *
 * The matching CALL-SITE gate — that `decidePermission` and
 * `interruptSession` actually route through this, without which the helper
 * proves nothing — lives in `scripts/optimisticSends.test.mjs`. It cannot
 * live here: `web/tsconfig.json` sets `"types": []` on purpose and
 * `web/src/nodeTypeIsolation.test.ts` fails typecheck if that changes, so a
 * web-side test may not read source off disk.
 */
describe('sendThenApply (W29)', () => {
  test('a failed send applies nothing and tells the operator', () => {
    const apply = vi.fn();
    const onUndeliverable = vi.fn();

    const ok = sendThenApply({ send: () => false, apply, onUndeliverable });

    expect(ok).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(onUndeliverable).toHaveBeenCalledTimes(1);
  });

  test('CONTROL: a successful send applies and stays quiet', () => {
    const apply = vi.fn();
    const onUndeliverable = vi.fn();

    const ok = sendThenApply({ send: () => true, apply, onUndeliverable });

    expect(ok).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(onUndeliverable).not.toHaveBeenCalled();
  });

  test('the send happens BEFORE the apply, not after', () => {
    // The ordering is the fix. A version that applied first and rolled back on
    // failure would pass both cases above while leaving the window this is
    // about — a frame in which the UI claims a decision that has not landed.
    const order: string[] = [];
    sendThenApply({
      send: () => {
        order.push('send');
        return true;
      },
      apply: () => order.push('apply'),
      onUndeliverable: () => order.push('undeliverable'),
    });
    expect(order).toEqual(['send', 'apply']);
  });

  test('the send runs exactly once either way', () => {
    // Guards a retry creeping in: a duplicate `permission_decision` is not
    // harmful server-side (the handler is idempotent), but a duplicate
    // `interrupt` or `acknowledge_and_start` is a different question, and this
    // helper is shared.
    for (const result of [true, false]) {
      const send = vi.fn(() => result);
      sendThenApply({ send, apply: () => {}, onUndeliverable: () => {} });
      expect(send).toHaveBeenCalledTimes(1);
    }
  });
});
