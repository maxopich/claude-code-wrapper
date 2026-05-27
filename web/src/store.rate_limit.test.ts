import { describe, expect, test } from 'vitest';
import { HELD_MESSAGES_CAP, initialState, reduce, type AppState, type SessionView } from './store';

// Cluster D Phase 4c: store-side rate-limit slice contract.
//
// What this exercises (and why these specifically):
//
//   1. `rate_limit_event` with `status: 'hard'` populates the slice with
//      the wire-side resetsAtMs + overage fields, defaulting paused +
//      retryInFlight to false.
//   2. `status: 'allowed'` clears the slice.
//   3. Unknown statuses (forward-compat) are no-ops.
//   4. `auto_retry` sets the `autoRetry` sub-field with attempt/maxAttempts/
//      backoffMs/retryAt/reason (and agentName when present).
//   5. `session_running { status: 'rate_limited' }` seeds an empty slice
//      if no rate_limit_event has landed yet (fallback so the banner
//      mounts on the held-turn echo even if the typed event lost the
//      race). And clears retryInFlight on subsequent flips.
//   6. `session_running` with no status / 'thinking' clears the slice.
//   7. `rl_enqueue_held` appends; cap at HELD_MESSAGES_CAP rejects further.
//   8. `rl_drop_held` removes by index; OOB is a no-op.
//   9. `rl_drain_one` pops the head; empty-queue is a no-op.
//  10. `rl_set_paused` toggles; same-value is a no-op.
//  11. `rl_retry_sent` flips retryInFlight=true; idempotent.

const PID = 17;
const SID = 'rl-test-sess';

function bootstrap(): AppState {
  // Seed the store with a known session so the rate-limit cases have
  // something to mutate. Uses the standard reducer path (no synthetic
  // construction) — closer to how the live app gets here.
  let s = reduce(initialState, { type: 'select_project', projectId: PID });
  s = reduce(s, {
    type: 'server',
    msg: {
      type: 'session_history_start',
      projectId: PID,
      sessionId: SID,
    },
  });
  s = reduce(s, {
    type: 'server',
    msg: {
      type: 'session_history_end',
      projectId: PID,
      sessionId: SID,
    },
  });
  // sessionToProject is populated by session_running, since
  // session_history_start doesn't set it. Force it via a server echo.
  s = reduce(s, {
    type: 'server',
    msg: {
      type: 'session_running',
      projectId: PID,
      sessionId: SID,
      running: false,
    },
  });
  return s;
}

function sessionOf(s: AppState): SessionView {
  const sv = s.sessionsByProject[PID]?.[SID];
  if (!sv) throw new Error('expected test session to exist');
  return sv;
}

describe('rate_limit_event reducer', () => {
  test('status=hard populates the slice with countdown + overage fields', () => {
    let s = bootstrap();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'rate_limit_event',
        sessionId: SID,
        status: 'hard',
        resetsAt: 1_700_000_000,
        resetsAtMs: 1_700_000_000_000,
        rateLimitType: 'five_hour',
        overageStatus: 'allowed',
        overageResetsAtMs: 1_700_000_100_000,
        isUsingOverage: true,
        payload: {},
      },
    });
    const rl = sessionOf(s).rateLimit;
    expect(rl).toBeDefined();
    expect(rl!.resetsAtMs).toBe(1_700_000_000_000);
    expect(rl!.overageStatus).toBe('allowed');
    expect(rl!.overageResetsAtMs).toBe(1_700_000_100_000);
    expect(rl!.isUsingOverage).toBe(true);
    expect(rl!.paused).toBe(false);
    expect(rl!.retryInFlight).toBe(false);
  });

  test('status=allowed clears the slice entirely (rate_limit:cleared)', () => {
    let s = bootstrap();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'rate_limit_event',
        sessionId: SID,
        status: 'hard',
        resetsAtMs: 1,
        payload: {},
      },
    });
    expect(sessionOf(s).rateLimit).toBeDefined();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'rate_limit_event',
        sessionId: SID,
        status: 'allowed',
        payload: {},
      },
    });
    expect(sessionOf(s).rateLimit).toBeUndefined();
    // Specifically: the property is gone from the object, not just set
    // to `undefined`.
    expect(Object.hasOwn(sessionOf(s), 'rateLimit')).toBe(false);
  });

  test('unknown status (forward-compat) is a no-op', () => {
    let s = bootstrap();
    const before = sessionOf(s).rateLimit;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'rate_limit_event',
        sessionId: SID,
        status: 'approaching',
        payload: {},
      },
    });
    expect(sessionOf(s).rateLimit).toBe(before); // exact-same object → no allocation, no slice
  });

  test('successive hard events update fields without losing paused / autoRetry', () => {
    let s = bootstrap();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'rate_limit_event',
        sessionId: SID,
        status: 'hard',
        resetsAtMs: 1_000,
        payload: {},
      },
    });
    s = reduce(s, { type: 'rl_set_paused', sessionId: SID, paused: true });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'auto_retry',
        sessionId: SID,
        attempt: 2,
        maxAttempts: 5,
        backoffMs: 30_000,
        retryAt: 1_500,
        reason: 'transient_overload',
      },
    });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'rate_limit_event',
        sessionId: SID,
        status: 'hard',
        resetsAtMs: 5_000,
        payload: {},
      },
    });
    const rl = sessionOf(s).rateLimit!;
    expect(rl.resetsAtMs).toBe(5_000);
    expect(rl.paused).toBe(true); // preserved
    expect(rl.autoRetry?.attempt).toBe(2); // preserved
    expect(rl.retryInFlight).toBe(false); // new event resets debounce
  });
});

describe('auto_retry reducer', () => {
  test('populates the autoRetry sub-field with all wire fields', () => {
    let s = bootstrap();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'auto_retry',
        sessionId: SID,
        attempt: 3,
        maxAttempts: 5,
        backoffMs: 30_000,
        retryAt: 1_700_000_030_000,
        reason: 'transient_overload',
        agentName: 'reviewer',
      },
    });
    const ar = sessionOf(s).rateLimit?.autoRetry;
    expect(ar).toEqual({
      attempt: 3,
      maxAttempts: 5,
      backoffMs: 30_000,
      retryAt: 1_700_000_030_000,
      reason: 'transient_overload',
      agentName: 'reviewer',
    });
  });

  test('agentName omitted on the wire means it stays absent on the slice', () => {
    let s = bootstrap();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'auto_retry',
        sessionId: SID,
        attempt: 1,
        maxAttempts: 5,
        backoffMs: 5_000,
        retryAt: 1,
        reason: 'rate_limit_hard',
      },
    });
    const ar = sessionOf(s).rateLimit?.autoRetry;
    if (!ar) throw new Error('expected autoRetry slice to be populated');
    expect(ar.agentName).toBeUndefined();
    expect(Object.hasOwn(ar, 'agentName')).toBe(false);
  });
});

describe('session_running rate-limit interaction', () => {
  test('status=rate_limited seeds an empty slice when none existed yet', () => {
    let s = bootstrap();
    expect(sessionOf(s).rateLimit).toBeUndefined();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_running',
        projectId: PID,
        sessionId: SID,
        running: true,
        status: 'rate_limited',
      },
    });
    const rl = sessionOf(s).rateLimit;
    expect(rl).toEqual({ paused: false, retryInFlight: false });
  });

  test('status=rate_limited preserves an existing slice (no overwrite)', () => {
    let s = bootstrap();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'rate_limit_event',
        sessionId: SID,
        status: 'hard',
        resetsAtMs: 9_999,
        payload: {},
      },
    });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_running',
        projectId: PID,
        sessionId: SID,
        running: false,
        status: 'rate_limited',
      },
    });
    expect(sessionOf(s).rateLimit?.resetsAtMs).toBe(9_999);
  });

  test('status=undefined (normal turn) clears the slice', () => {
    let s = bootstrap();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'rate_limit_event',
        sessionId: SID,
        status: 'hard',
        resetsAtMs: 1,
        payload: {},
      },
    });
    expect(sessionOf(s).rateLimit).toBeDefined();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_running',
        projectId: PID,
        sessionId: SID,
        running: true,
        // no status → 'thinking'
      },
    });
    expect(sessionOf(s).rateLimit).toBeUndefined();
  });

  test('status=rate_limited clears retryInFlight on subsequent re-flips', () => {
    let s = bootstrap();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'rate_limit_event',
        sessionId: SID,
        status: 'hard',
        resetsAtMs: 1,
        payload: {},
      },
    });
    s = reduce(s, { type: 'rl_retry_sent', sessionId: SID });
    expect(sessionOf(s).rateLimit?.retryInFlight).toBe(true);
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_running',
        projectId: PID,
        sessionId: SID,
        running: true,
        status: 'rate_limited',
      },
    });
    expect(sessionOf(s).rateLimit?.retryInFlight).toBe(false);
  });
});

describe('held-message queue (UI-D7)', () => {
  test('rl_enqueue_held appends to the queue', () => {
    let s = bootstrap();
    s = reduce(s, { type: 'rl_enqueue_held', sessionId: SID, text: 'one' });
    s = reduce(s, { type: 'rl_enqueue_held', sessionId: SID, text: 'two' });
    expect(sessionOf(s).heldMessages).toEqual(['one', 'two']);
  });

  test('rl_enqueue_held refuses past the cap (defense-in-depth)', () => {
    let s = bootstrap();
    for (let i = 0; i < HELD_MESSAGES_CAP; i++) {
      s = reduce(s, { type: 'rl_enqueue_held', sessionId: SID, text: `m${i}` });
    }
    expect(sessionOf(s).heldMessages).toHaveLength(HELD_MESSAGES_CAP);
    s = reduce(s, { type: 'rl_enqueue_held', sessionId: SID, text: 'overflow' });
    expect(sessionOf(s).heldMessages).toHaveLength(HELD_MESSAGES_CAP);
    expect(sessionOf(s).heldMessages.includes('overflow')).toBe(false);
  });

  test('rl_drop_held removes by index', () => {
    let s = bootstrap();
    s = reduce(s, { type: 'rl_enqueue_held', sessionId: SID, text: 'a' });
    s = reduce(s, { type: 'rl_enqueue_held', sessionId: SID, text: 'b' });
    s = reduce(s, { type: 'rl_enqueue_held', sessionId: SID, text: 'c' });
    s = reduce(s, { type: 'rl_drop_held', sessionId: SID, index: 1 });
    expect(sessionOf(s).heldMessages).toEqual(['a', 'c']);
  });

  test('rl_drop_held with out-of-bounds index is a no-op (no throw)', () => {
    let s = bootstrap();
    s = reduce(s, { type: 'rl_enqueue_held', sessionId: SID, text: 'a' });
    const before = sessionOf(s).heldMessages;
    s = reduce(s, { type: 'rl_drop_held', sessionId: SID, index: 99 });
    expect(sessionOf(s).heldMessages).toBe(before);
    s = reduce(s, { type: 'rl_drop_held', sessionId: SID, index: -1 });
    expect(sessionOf(s).heldMessages).toBe(before);
  });

  test('rl_drain_one pops the head (FIFO order)', () => {
    let s = bootstrap();
    s = reduce(s, { type: 'rl_enqueue_held', sessionId: SID, text: 'first' });
    s = reduce(s, { type: 'rl_enqueue_held', sessionId: SID, text: 'second' });
    s = reduce(s, { type: 'rl_drain_one', sessionId: SID });
    expect(sessionOf(s).heldMessages).toEqual(['second']);
    s = reduce(s, { type: 'rl_drain_one', sessionId: SID });
    expect(sessionOf(s).heldMessages).toEqual([]);
    // Idempotent on empty.
    s = reduce(s, { type: 'rl_drain_one', sessionId: SID });
    expect(sessionOf(s).heldMessages).toEqual([]);
  });
});

describe('pause + retry-in-flight client transitions', () => {
  test('rl_set_paused requires a slice; no-op when none exists', () => {
    let s = bootstrap();
    s = reduce(s, { type: 'rl_set_paused', sessionId: SID, paused: true });
    expect(sessionOf(s).rateLimit).toBeUndefined();
  });

  test('rl_set_paused toggles paused flag and skips identity write', () => {
    let s = bootstrap();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'rate_limit_event',
        sessionId: SID,
        status: 'hard',
        resetsAtMs: 1,
        payload: {},
      },
    });
    expect(sessionOf(s).rateLimit?.paused).toBe(false);
    s = reduce(s, { type: 'rl_set_paused', sessionId: SID, paused: true });
    expect(sessionOf(s).rateLimit?.paused).toBe(true);
    const before = sessionOf(s);
    s = reduce(s, { type: 'rl_set_paused', sessionId: SID, paused: true });
    expect(sessionOf(s)).toBe(before); // identity unchanged when value equals existing
  });

  test('rl_retry_sent is idempotent — flipping when already true is a no-op', () => {
    let s = bootstrap();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'rate_limit_event',
        sessionId: SID,
        status: 'hard',
        resetsAtMs: 1,
        payload: {},
      },
    });
    s = reduce(s, { type: 'rl_retry_sent', sessionId: SID });
    const after = sessionOf(s);
    expect(after.rateLimit?.retryInFlight).toBe(true);
    s = reduce(s, { type: 'rl_retry_sent', sessionId: SID });
    expect(sessionOf(s)).toBe(after); // no second flip
  });
});
