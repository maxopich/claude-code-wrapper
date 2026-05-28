import { describe, expect, test, vi } from 'vitest';
import type { ServerMsg } from '@cebab/shared';
import { executeInterrupt } from './server.js';

// Cluster C Phase 1 (spec §4.4 + §4.5): server-side coverage for the
// `interrupt` ClientMsg handler's extracted helper.
//
// Coverage:
//   - Unknown sessionId (no inFlight) → silent no-op
//   - runner.interrupt path → emits session_interrupted with ackLatencyMs
//   - ac.abort fallback when runner has no interrupt → still emits envelope
//   - runner.interrupt rejection → falls back to ac.abort + still emits
//   - ackLatencyMs reflects the elapsed delta via the now() seam

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
});
