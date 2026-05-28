import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  PauseExpiryRegistry,
  type PauseExpiryEntry,
  __resetRegistryForTesting,
  getPauseExpiryRegistry,
} from './pause_expiry.js';

// Cluster C Phase 4c2: pause-expiry registry tests. The fake-timer
// path covers schedule → fire and schedule → cancel-before-fire; the
// clearSession path covers session-end teardown.
//
// We use vitest's fake timers so each test can advance time
// deterministically rather than relying on real wall-clock sleeps —
// the registry's `setTimeoutFn` defaults are the platform's
// `setTimeout` which vitest's fake-timer stub replaces transparently.

function buildEntry(overrides: Partial<PauseExpiryEntry> = {}): PauseExpiryEntry {
  return {
    sessionId: 'sess-1',
    projectId: 42,
    agentName: 'worker-slug',
    pausedUntil: Date.now() + 60_000,
    expiryAction: 'auto_resume',
    reasonCode: 'off_task',
    reasonText: null,
    ...overrides,
  };
}

describe('PauseExpiryRegistry — schedule + fire', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('schedule + advance past deadline fires onExpire with the original entry', () => {
    const registry = new PauseExpiryRegistry();
    const onExpire = vi.fn();
    const entry = buildEntry({ pausedUntil: Date.now() + 5_000 });
    registry.schedule(entry, onExpire);

    expect(registry.isScheduled(entry.sessionId, entry.projectId)).toBe(true);
    expect(onExpire).not.toHaveBeenCalled();

    vi.advanceTimersByTime(4_999);
    expect(onExpire).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(onExpire).toHaveBeenCalledWith(entry);
    // Timer slot is freed once it fires — the cancel path now no-ops.
    expect(registry.isScheduled(entry.sessionId, entry.projectId)).toBe(false);
  });

  test('non-positive remaining deadline fires on the next tick', () => {
    const registry = new PauseExpiryRegistry();
    const onExpire = vi.fn();
    // Already in the past — used by R-A reseed path (a server-restart
    // reseed for a pause whose deadline lapsed during downtime).
    const entry = buildEntry({ pausedUntil: Date.now() - 1_000 });
    registry.schedule(entry, onExpire);

    expect(onExpire).not.toHaveBeenCalled(); // synchronous schedule call doesn't fire
    vi.advanceTimersByTime(0);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  test('cancel before fire prevents the callback', () => {
    const registry = new PauseExpiryRegistry();
    const onExpire = vi.fn();
    const entry = buildEntry({ pausedUntil: Date.now() + 10_000 });
    registry.schedule(entry, onExpire);

    const cancelled = registry.cancel(entry.sessionId, entry.projectId);
    expect(cancelled).toBe(true);
    expect(registry.isScheduled(entry.sessionId, entry.projectId)).toBe(false);

    vi.advanceTimersByTime(20_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  test('cancel returns false when nothing scheduled (no-op)', () => {
    const registry = new PauseExpiryRegistry();
    expect(registry.cancel('sess-x', 1)).toBe(false);
  });

  test('cancel for a different (sessionId, projectId) does not affect siblings', () => {
    const registry = new PauseExpiryRegistry();
    const onExpire1 = vi.fn();
    const onExpire2 = vi.fn();
    registry.schedule(buildEntry({ projectId: 1 }), onExpire1);
    registry.schedule(buildEntry({ projectId: 2 }), onExpire2);

    registry.cancel('sess-1', 1);
    vi.advanceTimersByTime(120_000);
    expect(onExpire1).not.toHaveBeenCalled();
    expect(onExpire2).toHaveBeenCalledTimes(1);
  });

  test('re-schedule with same key cancels prior timer (operator re-pause)', () => {
    const registry = new PauseExpiryRegistry();
    const first = vi.fn();
    const second = vi.fn();
    registry.schedule(buildEntry({ pausedUntil: Date.now() + 5_000 }), first);
    // Operator re-pauses with a longer timeout BEFORE the first fired.
    registry.schedule(buildEntry({ pausedUntil: Date.now() + 30_000 }), second);

    vi.advanceTimersByTime(6_000); // would have fired the first
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    vi.advanceTimersByTime(25_000); // crosses second deadline
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  test('clearSession cancels every timer for the session', () => {
    const registry = new PauseExpiryRegistry();
    const a = vi.fn();
    const b = vi.fn();
    const otherSession = vi.fn();
    registry.schedule(buildEntry({ sessionId: 'sess-x', projectId: 1 }), a);
    registry.schedule(buildEntry({ sessionId: 'sess-x', projectId: 2 }), b);
    registry.schedule(buildEntry({ sessionId: 'sess-y', projectId: 1 }), otherSession);

    const cleared = registry.clearSession('sess-x');
    expect(cleared).toBe(2);
    expect(registry.isScheduled('sess-x', 1)).toBe(false);
    expect(registry.isScheduled('sess-x', 2)).toBe(false);
    expect(registry.isScheduled('sess-y', 1)).toBe(true);

    vi.advanceTimersByTime(120_000);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    expect(otherSession).toHaveBeenCalledTimes(1);
  });

  test('clearSession returns 0 when nothing matches', () => {
    const registry = new PauseExpiryRegistry();
    expect(registry.clearSession('sess-nope')).toBe(0);
  });

  test('getScheduledCount tracks Map size across schedule/cancel/fire', () => {
    const registry = new PauseExpiryRegistry();
    expect(registry.getScheduledCount()).toBe(0);

    registry.schedule(buildEntry({ projectId: 1 }), vi.fn());
    registry.schedule(buildEntry({ projectId: 2 }), vi.fn());
    expect(registry.getScheduledCount()).toBe(2);

    registry.cancel('sess-1', 1);
    expect(registry.getScheduledCount()).toBe(1);

    vi.advanceTimersByTime(120_000); // fires the remaining one
    expect(registry.getScheduledCount()).toBe(0);
  });

  test('getEntry returns the captured snapshot until fire or cancel', () => {
    const registry = new PauseExpiryRegistry();
    const entry = buildEntry({ reasonText: 'tokens too high' });
    registry.schedule(entry, vi.fn());
    expect(registry.getEntry(entry.sessionId, entry.projectId)).toEqual(entry);

    registry.cancel(entry.sessionId, entry.projectId);
    expect(registry.getEntry(entry.sessionId, entry.projectId)).toBeUndefined();
  });

  test('throwing onExpire is caught + logged; registry stays usable', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const registry = new PauseExpiryRegistry();
    const blowUp = vi.fn(() => {
      throw new Error('downstream failed');
    });
    const next = vi.fn();
    registry.schedule(buildEntry({ projectId: 1, pausedUntil: Date.now() + 1_000 }), blowUp);
    registry.schedule(buildEntry({ projectId: 2, pausedUntil: Date.now() + 2_000 }), next);

    vi.advanceTimersByTime(1_500);
    expect(blowUp).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    // Sibling timer still fires after the explosion.
    vi.advanceTimersByTime(1_000);
    expect(next).toHaveBeenCalled();

    errSpy.mockRestore();
  });
});

describe('PauseExpiryRegistry — custom deps', () => {
  test('injectable setTimeoutFn / clearTimeoutFn / now', () => {
    let scheduledMs: number | undefined;
    const fakeHandle = { id: 'fake-timer' };
    const setTimeoutFn = vi.fn(
      (_cb: () => void, ms: number) =>
        ((scheduledMs = ms), fakeHandle) as unknown as ReturnType<typeof setTimeout>,
    );
    const clearTimeoutFn = vi.fn();
    const now = vi.fn(() => 1_700_000_000_000);

    const registry = new PauseExpiryRegistry({ setTimeoutFn, clearTimeoutFn, now });
    registry.schedule(buildEntry({ pausedUntil: 1_700_000_000_000 + 5_000 }), vi.fn());

    expect(setTimeoutFn).toHaveBeenCalledTimes(1);
    expect(scheduledMs).toBe(5_000);

    registry.cancel('sess-1', 42);
    expect(clearTimeoutFn).toHaveBeenCalledWith(fakeHandle);
  });
});

describe('PauseExpiryRegistry — singleton', () => {
  beforeEach(() => {
    __resetRegistryForTesting();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetRegistryForTesting();
  });

  test('getPauseExpiryRegistry returns the same instance', () => {
    const a = getPauseExpiryRegistry();
    const b = getPauseExpiryRegistry();
    expect(a).toBe(b);
  });

  test('__resetRegistryForTesting forces a fresh instance + cancels prior timers', () => {
    const onExpire = vi.fn();
    getPauseExpiryRegistry().schedule(buildEntry({ pausedUntil: Date.now() + 5_000 }), onExpire);

    __resetRegistryForTesting();
    const fresh = getPauseExpiryRegistry();
    expect(fresh.getScheduledCount()).toBe(0);

    vi.advanceTimersByTime(120_000);
    expect(onExpire).not.toHaveBeenCalled();
  });
});
