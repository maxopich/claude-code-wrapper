import { describe, expect, test } from 'vitest';

import { classifyHandlerFailure } from './server.js';
import { GateAbandonedError } from '../gate_abandon.js';

/**
 * `Cebab-6fax.17` — a cancellation is not a crash.
 *
 * The WS dispatch catch hard-coded `kind: 'process_crashed'` for everything
 * that reached it. So an operator DECLINING a trust or env-injection prompt — a
 * normal, deliberate action, which rejects the parked promise with an
 * `AbortError` — surfaced as "Server error … process_crashed", and so did the
 * single-active policy refusal ("another multi-agent session is already
 * running"), which this review saw live.
 *
 * Not cosmetic: `notifyFromServerMsg` and the session-status banner both branch
 * on `kind`, so calling a cancellation a crash is what puts a sticky red error
 * in front of someone who just clicked Cancel.
 */
describe('classifyHandlerFailure', () => {
  test('an abandoned gate is `aborted` — the operator declined', () => {
    expect(classifyHandlerFailure(new GateAbandonedError('session-start', 'cancelled'))).toBe(
      'aborted',
    );
  });

  test('so is any AbortError, including an AbortController abort', () => {
    // Same meaning, different source: "this did not happen because someone
    // stopped it".
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    expect(classifyHandlerFailure(err)).toBe('aborted');
  });

  test('ANTI-VACUITY: an unexpected throw is still `process_crashed`', () => {
    // The classifier is deliberately narrow. Widening it would downgrade real
    // failures into something the UI shows quietly, which is worse than the
    // defect being fixed.
    expect(classifyHandlerFailure(new Error('ENOENT: no such file'))).toBe('process_crashed');
    expect(classifyHandlerFailure(new TypeError('x is not a function'))).toBe('process_crashed');
  });

  test('and a non-Error rejection does not throw on the way through', () => {
    expect(classifyHandlerFailure('a string')).toBe('process_crashed');
    expect(classifyHandlerFailure(undefined)).toBe('process_crashed');
  });
});
