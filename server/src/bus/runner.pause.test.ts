import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AgentRunner } from './runner.js';
import type { Runner, RunOptions, MockOptions } from '../runner/index.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// Cluster C Phase 4c (spec §5.2 + AE-4 + AE-5): pause/resume gate on
// the AgentRunner. Tests prove the spec's invariants:
//
//   - In-flight turn (already running when pause arrives) is NOT
//     cancelled by pause — it completes naturally.
//   - The NEXT deliverTurn parks behind the pause gate and only
//     proceeds after resume.
//   - Resume releases EVERY queued deliverTurn in FIFO order.
//   - pendingDeliveries reflects the queue size (AE-5 observability).
//   - Re-pause + re-resume return false (idempotent no-op).
//   - Unknown agent: pause/resume return false without throwing.

function fakeRunner(messages: SDKMessage[]): Runner {
  async function* gen(): AsyncGenerator<SDKMessage> {
    for (const m of messages) yield m;
  }
  const it = gen();
  return { [Symbol.asyncIterator]: () => it, close: () => {} };
}

function resultMsg(sessionId: string): SDKMessage {
  return { type: 'result', subtype: 'success', session_id: sessionId } as unknown as SDKMessage;
}

/**
 * Build a runner whose every spawned turn parks until the per-call
 * `release()` is invoked. Lets tests drive turn lifecycle with frame-
 * accurate control over "turn started running" vs "turn finished."
 */
function buildBlockingRunner() {
  const turnReleases: Array<() => void> = [];
  const turnStarted: Array<() => void> = [];
  const runnerFactory = vi.fn((_opts: RunOptions & Partial<MockOptions>): Runner => {
    void _opts;
    let release!: () => void;
    let onStart!: () => void;
    const blocker = new Promise<void>((res) => {
      release = res;
    });
    // Construct the start-signal promise so onStart is initialized; the
    // promise itself is fired-and-forgotten (the test polls
    // turnStarted.length instead of awaiting the promise directly).
    void new Promise<void>((res) => {
      onStart = res;
    });
    turnReleases.push(release);
    turnStarted.push(onStart);
    async function* gen(): AsyncGenerator<SDKMessage> {
      onStart();
      await blocker;
      yield resultMsg(`sess-${turnReleases.length}`);
    }
    const it = gen();
    return { [Symbol.asyncIterator]: () => it, close: () => {} };
  });
  return { runnerFactory, turnReleases, turnStarted };
}

describe('AgentRunner — pause + resume (spec §5.2, AE-4)', () => {
  let originalApiKey: string | undefined;
  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (originalApiKey !== undefined) process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  test('in-flight turn is NOT cancelled by pause; completes naturally', async () => {
    const { runnerFactory, turnReleases, turnStarted } = buildBlockingRunner();
    const runner = new AgentRunner({ onEvent: () => undefined, runnerFactory });
    runner.register({ name: 'alpha', cwd: '/tmp/alpha' });

    // Start a turn; wait for it to actually be running.
    const inFlight = runner.deliverTurn('alpha', 'first');
    await turnStarted[0];
    expect(runner.isPaused('alpha')).toBe(false);

    // Pause AFTER the turn started — spec §5.2 says the in-flight turn
    // is NOT cancelled. Verify by releasing the in-flight blocker and
    // observing successful resolution.
    expect(runner.pause('alpha')).toBe(true);
    expect(runner.isPaused('alpha')).toBe(true);
    turnReleases[0]();
    await expect(inFlight).resolves.toBeUndefined();
  });

  test('next deliverTurn parks until resume; queued deliveries fire in FIFO order', async () => {
    const { runnerFactory, turnReleases, turnStarted } = buildBlockingRunner();
    const runner = new AgentRunner({ onEvent: () => undefined, runnerFactory });
    runner.register({ name: 'alpha', cwd: '/tmp/alpha' });

    // First turn: run + finish synchronously so the tail is `Promise.resolve()`.
    const first = runner.deliverTurn('alpha', 'first');
    await turnStarted[0];
    turnReleases[0]();
    await first;

    // Pause; queue two more deliveries. Neither should START a turn.
    expect(runner.pause('alpha')).toBe(true);
    const second = runner.deliverTurn('alpha', 'second');
    const third = runner.deliverTurn('alpha', 'third');
    // Flush microtasks so any non-pause-blocked work would have started.
    await new Promise((r) => setTimeout(r, 20));
    expect(runnerFactory.mock.calls.length).toBe(1); // first turn only
    expect(runner.getPendingDeliveries('alpha')).toBe(2); // both queued

    // Resume → both queued deliveries fire in order. We poll because the
    // factory is invoked lazily when `runOneTurn` actually starts (which
    // happens after the pause promise resolves + microtasks flush).
    expect(runner.resume('alpha')).toBe(true);
    expect(runner.isPaused('alpha')).toBe(false);

    await pollUntil(() => turnStarted.length >= 2);
    turnReleases[1]!();
    await second;
    await pollUntil(() => turnStarted.length >= 3);
    turnReleases[2]!();
    await third;

    // After all turns drain, pending count returns to 0.
    expect(runner.getPendingDeliveries('alpha')).toBe(0);
  });

  test('different agents are unaffected by another agent\'s pause', async () => {
    const { runnerFactory, turnReleases, turnStarted } = buildBlockingRunner();
    const runner = new AgentRunner({ onEvent: () => undefined, runnerFactory });
    runner.register({ name: 'alpha', cwd: '/tmp/alpha' });
    runner.register({ name: 'beta', cwd: '/tmp/beta' });

    runner.pause('alpha');
    const betaTurn = runner.deliverTurn('beta', 'hello');
    await turnStarted[0]; // beta turn started despite alpha being paused
    turnReleases[0]();
    await betaTurn;
  });

  test('re-pause returns false (idempotent no-op)', () => {
    const runner = new AgentRunner({ onEvent: () => undefined, runnerFactory: () => fakeRunner([]) });
    runner.register({ name: 'alpha', cwd: '/tmp/alpha' });
    expect(runner.pause('alpha')).toBe(true);
    expect(runner.pause('alpha')).toBe(false);
  });

  test('re-resume returns false (idempotent no-op)', () => {
    const runner = new AgentRunner({ onEvent: () => undefined, runnerFactory: () => fakeRunner([]) });
    runner.register({ name: 'alpha', cwd: '/tmp/alpha' });
    expect(runner.resume('alpha')).toBe(false); // never paused
    runner.pause('alpha');
    expect(runner.resume('alpha')).toBe(true);
    expect(runner.resume('alpha')).toBe(false); // already resumed
  });

  test('pause/resume on unknown agent: pause false (no-op), resume false', () => {
    const runner = new AgentRunner({ onEvent: () => undefined, runnerFactory: () => fakeRunner([]) });
    // unknown agent — pause should refuse (no spec entry to gate)
    expect(runner.pause('ghost')).toBe(false);
    expect(runner.resume('ghost')).toBe(false);
    expect(runner.isPaused('ghost')).toBe(false);
  });

  test('pendingDeliveries bumps + decrements around runOneTurn', async () => {
    const { runnerFactory, turnReleases, turnStarted } = buildBlockingRunner();
    const runner = new AgentRunner({ onEvent: () => undefined, runnerFactory });
    runner.register({ name: 'alpha', cwd: '/tmp/alpha' });

    expect(runner.getPendingDeliveries('alpha')).toBe(0);
    const turn1 = runner.deliverTurn('alpha', 'p1');
    // Right after deliverTurn returns, the counter has been bumped but the
    // turn hasn't started yet (microtask boundary). So pending is 1.
    expect(runner.getPendingDeliveries('alpha')).toBe(1);
    await turnStarted[0];
    // Once runOneTurn actually starts, the counter has been decremented.
    expect(runner.getPendingDeliveries('alpha')).toBe(0);
    turnReleases[0]();
    await turn1;
  });

  test('pendingDeliveries reports paused queue (AE-5 observability)', async () => {
    const { runnerFactory, turnReleases, turnStarted } = buildBlockingRunner();
    const runner = new AgentRunner({ onEvent: () => undefined, runnerFactory });
    runner.register({ name: 'alpha', cwd: '/tmp/alpha' });

    // Run + finish first turn so the tail is clean.
    const first = runner.deliverTurn('alpha', 'first');
    await turnStarted[0];
    turnReleases[0]();
    await first;

    // Pause + queue 3 deliveries — pending counter sees them all.
    runner.pause('alpha');
    const queued = [
      runner.deliverTurn('alpha', 'q1'),
      runner.deliverTurn('alpha', 'q2'),
      runner.deliverTurn('alpha', 'q3'),
    ];
    await new Promise((r) => setTimeout(r, 20));
    expect(runner.getPendingDeliveries('alpha')).toBe(3);

    // Resume → drain all three; counter ticks down each time.
    runner.resume('alpha');
    for (let i = 1; i <= 3; i++) {
      await pollUntil(() => turnStarted.length >= i + 1);
      turnReleases[i]!();
      await queued[i - 1];
    }
    expect(runner.getPendingDeliveries('alpha')).toBe(0);
  });
});

/**
 * Poll until predicate true. The pause-release path advances via
 * microtasks; `await new Promise(setTimeout)` lets the chain flush so the
 * next runOneTurn fires its factory + populates turnStarted/turnReleases.
 * 200×5ms cap is generous; tests shouldn't actually need most of that.
 */
async function pollUntil(predicate: () => boolean, maxTriesPer5ms = 200): Promise<void> {
  for (let i = 0; i < maxTriesPer5ms; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('pollUntil timed out waiting for predicate');
}
