import { describe, expect, test, vi } from 'vitest';
import type { ServerMsg } from '@cebab/shared';
import { executeInterrupt, INTERRUPT_WATCHDOG_MS } from './server.js';

// Cluster C Phase 1 (spec §4.4 + §4.5): server-side coverage for the
// `interrupt` ClientMsg handler's extracted helper.
//
// Coverage:
//   - Unknown sessionId (no inFlight) → silent no-op
//   - runner.interrupt path → emits session_interrupted with ackLatencyMs
//   - ac.abort fallback when runner has no interrupt → still emits envelope
//   - runner.interrupt rejection → falls back to ac.abort + still emits
//   - ackLatencyMs reflects the elapsed delta via the now() seam
//
// `Cebab-vie.24` adds the case none of the above covered: an interrupt that
// NEVER settles. That is not a hypothetical — `Query.interrupt()` parks a
// control-request promise that only a CLI response or the SDK's own cleanup
// can settle, so a wedged control loop left the operator with no ack, no
// abort, and a session that refused every later send_message.

function makeInFlight(interrupt?: () => Promise<void>): {
  runner: { interrupt?: () => Promise<void> };
  ac: AbortController;
} {
  return {
    runner: interrupt ? { interrupt } : {},
    ac: new AbortController(),
  };
}

describe('executeInterrupt', () => {
  test('unknown sessionId (no inFlight) → silent no-op, no envelope', async () => {
    const sent: ServerMsg[] = [];
    executeInterrupt({
      inFlight: undefined,
      sessionId: 'unknown',
      send: (m) => sent.push(m),
    });
    // Yield once in case anything was async.
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([]);
  });

  test('runner.interrupt path → emits session_interrupted with measured ackLatencyMs + ackId', async () => {
    const sent: ServerMsg[] = [];
    let resolveInterrupt: () => void;
    const interruptPromise = new Promise<void>((resolve) => {
      resolveInterrupt = resolve;
    });
    const interrupt = vi.fn(() => interruptPromise);
    const inFlight = makeInFlight(interrupt);

    // Synthetic clock advances by exactly 42 ms between handler entry
    // and runner.interrupt() resolution.
    let ts = 1_000_000;
    const now = vi.fn(() => ts);
    // Phase 2: deterministic ackId for assertion. Real path uses
    // randomUUID; test seam injects a fixed string.
    const generateAckId = vi.fn(() => 'ack-fixed');

    executeInterrupt({
      inFlight,
      sessionId: 'sess-1',
      send: (m) => sent.push(m),
      now,
      generateAckId,
    });

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]); // envelope ships after the .then

    // Advance the clock + resolve the runner's interrupt promise.
    ts = 1_000_042;
    resolveInterrupt!();
    await interruptPromise;
    // One more microtask for the .then to flush.
    await new Promise((r) => setTimeout(r, 0));

    expect(sent).toEqual([
      {
        type: 'session_interrupted',
        sessionId: 'sess-1',
        ackLatencyMs: 42,
        interruptAckId: 'ack-fixed',
      },
    ]);
    // The ac.abort was NOT called when runner.interrupt succeeds.
    expect(inFlight.ac.signal.aborted).toBe(false);
  });

  test('trackAckId is invoked synchronously with the generated id', () => {
    const sent: ServerMsg[] = [];
    const interrupt = vi.fn(() => new Promise<void>(() => {})); // never resolves
    const inFlight = makeInFlight(interrupt);
    const tracked: Array<{ sessionId: string; ackId: string }> = [];
    const generateAckId = () => 'ack-tracked-1';

    executeInterrupt({
      inFlight,
      sessionId: 'sess-track',
      send: (m) => sent.push(m),
      trackAckId: (sessionId, ackId) => tracked.push({ sessionId, ackId }),
      generateAckId,
      // This case's interrupt never settles, which since `Cebab-vie.24` would
      // otherwise leave a live watchdog timer running for ten seconds after
      // the test returns. The assertions here are about the synchronous
      // tracking, so opt the watchdog out rather than let it fire into a
      // finished test.
      interruptTimeoutMs: 0,
    });

    // trackAckId fires synchronously even though the envelope hasn't
    // shipped yet — important so a concurrent stop_reason has the id
    // available immediately.
    expect(tracked).toEqual([{ sessionId: 'sess-track', ackId: 'ack-tracked-1' }]);
    expect(sent).toEqual([]); // envelope still pending on runner.interrupt
  });

  test('runner without interrupt → uses ac.abort and still emits envelope', async () => {
    const sent: ServerMsg[] = [];
    const inFlight = makeInFlight(); // no interrupt fn

    let ts = 500;
    const now = vi.fn(() => {
      const t = ts;
      ts += 5;
      return t;
    });

    executeInterrupt({
      inFlight,
      sessionId: 'sess-fb',
      send: (m) => sent.push(m),
      now,
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(inFlight.ac.signal.aborted).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'session_interrupted',
      sessionId: 'sess-fb',
      // emitAck reads `now()` after the first call; the seam returns
      // 500 then 505 → delta 5.
      ackLatencyMs: 5,
    });
  });

  test('runner.interrupt rejection → ac.abort fallback + envelope still ships', async () => {
    const sent: ServerMsg[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const interruptErr = new Error('runner unhappy');
    const interrupt = vi.fn(() => Promise.reject(interruptErr));
    const inFlight = makeInFlight(interrupt);

    executeInterrupt({
      inFlight,
      sessionId: 'sess-bad',
      send: (m) => sent.push(m),
    });

    // Yield enough for the .then(_, reject) to fire.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(warnSpy).toHaveBeenCalled();
    expect(inFlight.ac.signal.aborted).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'session_interrupted', sessionId: 'sess-bad' });
    warnSpy.mockRestore();
  });

  test('double-call against the same runner: each emits its own envelope', async () => {
    // Mirrors BE-3's idempotence claim — duplicate interrupts are
    // safe; each registers an ack. The runner.interrupt may itself
    // be idempotent (Agent SDK is), but the wrapper helper just
    // forwards each call.
    const sent: ServerMsg[] = [];
    const interrupt = vi.fn(() => Promise.resolve());
    const inFlight = makeInFlight(interrupt);

    executeInterrupt({
      inFlight,
      sessionId: 's',
      send: (m) => sent.push(m),
    });
    executeInterrupt({
      inFlight,
      sessionId: 's',
      send: (m) => sent.push(m),
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(interrupt).toHaveBeenCalledTimes(2);
    expect(sent.filter((m) => m.type === 'session_interrupted')).toHaveLength(2);
  });

  // ---------------------------------------------------------------------
  // `Cebab-vie.24` — the Stop watchdog.
  // ---------------------------------------------------------------------

  function makeWedged(interrupt: () => Promise<unknown>) {
    return {
      runner: { interrupt, close: vi.fn() },
      ac: new AbortController(),
    };
  }

  test('THE BUG: an interrupt that never answers → watchdog hard-closes the runner, aborts and still acks', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const sent: ServerMsg[] = [];
      // A wedged CLI control loop: the SDK's control-request promise is parked
      // and nothing will ever settle it.
      const interrupt = vi.fn(() => new Promise<unknown>(() => {}));
      const inFlight = makeWedged(interrupt);

      executeInterrupt({
        inFlight,
        sessionId: 'sess-wedged',
        send: (m) => sent.push(m),
      });

      // One millisecond short of the ceiling is exactly the state the operator
      // used to be stranded in, permanently.
      await vi.advanceTimersByTimeAsync(INTERRUPT_WATCHDOG_MS - 1);
      expect(sent).toEqual([]);
      expect(inFlight.runner.close).not.toHaveBeenCalled();
      expect(inFlight.ac.signal.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(inFlight.runner.close).toHaveBeenCalledTimes(1);
      expect(inFlight.ac.signal.aborted).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: 'session_interrupted',
        sessionId: 'sess-wedged',
      });
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test('a runner with no close() still gets reaped by the watchdog via ac.abort', async () => {
    // The mock runner exposes neither close nor interrupt; a live Query has
    // both. This pins the in-between shape — interrupt present, close absent —
    // so the optional call can never become the only reaper.
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const sent: ServerMsg[] = [];
      const inFlight = {
        runner: { interrupt: vi.fn(() => new Promise<unknown>(() => {})) },
        ac: new AbortController(),
      };

      executeInterrupt({ inFlight, sessionId: 'sess-noclose', send: (m) => sent.push(m) });
      await vi.advanceTimersByTimeAsync(INTERRUPT_WATCHDOG_MS);

      expect(inFlight.ac.signal.aborted).toBe(true);
      expect(sent).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test('the rejection close() provokes does not ship a SECOND envelope', async () => {
    // The real sequence, not a hypothetical one: the SDK's close() rejects the
    // parked control promise with "Query closed before response received", so
    // after every watchdog fire our rejection handler also runs.
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const sent: ServerMsg[] = [];
      let rejectInterrupt!: (err: unknown) => void;
      const parked = new Promise<unknown>((_resolve, reject) => {
        rejectInterrupt = reject;
      });
      const inFlight = {
        runner: {
          interrupt: vi.fn(() => parked),
          close: vi.fn(() => rejectInterrupt(new Error('Query closed before response received'))),
        },
        ac: new AbortController(),
      };

      executeInterrupt({ inFlight, sessionId: 'sess-once', send: (m) => sent.push(m) });
      await vi.advanceTimersByTimeAsync(INTERRUPT_WATCHDOG_MS);
      // Extra flushes: the rejection lands on a later microtask than the close.
      await vi.advanceTimersByTimeAsync(0);

      expect(inFlight.runner.close).toHaveBeenCalledTimes(1);
      expect(sent).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test('an interrupt that answers in time clears the watchdog: no close, no abort, one envelope', async () => {
    vi.useFakeTimers();
    try {
      const sent: ServerMsg[] = [];
      const inFlight = makeWedged(vi.fn(() => Promise.resolve()));

      executeInterrupt({ inFlight, sessionId: 'sess-ok', send: (m) => sent.push(m) });
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toHaveLength(1);

      // Well past the ceiling: a cleared timer must not reap a turn that has
      // already torn itself down, which would abort the NEXT turn's controller
      // if the session were reused.
      await vi.advanceTimersByTimeAsync(INTERRUPT_WATCHDOG_MS * 2);
      expect(inFlight.runner.close).not.toHaveBeenCalled();
      expect(inFlight.ac.signal.aborted).toBe(false);
      expect(sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('interruptTimeoutMs: 0 arms no watchdog — the pre-fix behaviour, addressable on purpose', async () => {
    // The anti-vacuity control for the first case: with the timer opted out,
    // the identical wedged runner produces NOTHING. So the envelope up there
    // is the watchdog's doing and not some other path in the helper.
    vi.useFakeTimers();
    try {
      const sent: ServerMsg[] = [];
      const inFlight = makeWedged(vi.fn(() => new Promise<unknown>(() => {})));

      executeInterrupt({
        inFlight,
        sessionId: 'sess-disabled',
        send: (m) => sent.push(m),
        interruptTimeoutMs: 0,
      });
      await vi.advanceTimersByTimeAsync(INTERRUPT_WATCHDOG_MS * 3);

      expect(sent).toEqual([]);
      expect(inFlight.runner.close).not.toHaveBeenCalled();
      expect(inFlight.ac.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
