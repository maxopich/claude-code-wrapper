import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import { initialState, reduce, type AppState } from './store';

// Cluster C Phase 2 (spec §4.2): reducer slice tests for the per-session
// `lastInterrupt` state that drives the inline Stopped marker +
// reason-for-stop prompt.
//
// Coverage:
//   1. session_interrupted populates lastInterrupt with ackId + latency + ts
//   2. user_send clears lastInterrupt (operator moved on)
//   3. stop_reason_dismissed flips reasonSubmitted=true; keeps marker fields
//   4. stop_reason_dismissed no-ops on a session with no lastInterrupt
//   5. session_interrupted for an unknown session is a no-op
//   6. a second session_interrupted overwrites with the latest ackId

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-28T09:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

function seedSession(): AppState {
  let s = reduce(initialState, {
    type: 'server',
    msg: {
      type: 'projects',
      projects: [
        {
          id: 1,
          name: 'p',
          path: '/p',
          trusted: false,
          lastUsedAt: 0,
          hasClaudeMd: false,
          busInstalled: false,
          busAgentName: null,
        },
      ],
    },
  });
  s = reduce(s, { type: 'select_project', projectId: 1 });
  // Mint a session via session_started so projectFor() resolves.
  s = reduce(s, {
    type: 'server',
    msg: {
      type: 'session_started',
      sessionId: 'sess-1',
      projectId: 1,
      model: 'claude-sonnet-4-5',
      tools: [],
      permissionMode: 'default',
    },
  });
  return s;
}

describe('store / lastInterrupt — populate', () => {
  test('session_interrupted populates lastInterrupt with ackId + latency + ts', () => {
    const s0 = seedSession();
    expect(s0.sessionsByProject[1]?.['sess-1']?.lastInterrupt).toBeUndefined();

    const s1 = reduce(s0, {
      type: 'server',
      msg: {
        type: 'session_interrupted',
        sessionId: 'sess-1',
        ackLatencyMs: 42,
        interruptAckId: 'ack-fixed-1',
      },
    });

    const session = s1.sessionsByProject[1]!['sess-1']!;
    expect(session.lastInterrupt).toEqual({
      interruptAckId: 'ack-fixed-1',
      ackLatencyMs: 42,
      ts: Date.now(),
      reasonSubmitted: false,
    });
  });

  test('a second session_interrupted overwrites with the latest ackId', () => {
    let s = seedSession();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_interrupted',
        sessionId: 'sess-1',
        ackLatencyMs: 12,
        interruptAckId: 'ack-old',
      },
    });
    vi.advanceTimersByTime(3000);
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_interrupted',
        sessionId: 'sess-1',
        ackLatencyMs: 80,
        interruptAckId: 'ack-new',
      },
    });
    expect(s.sessionsByProject[1]!['sess-1']!.lastInterrupt).toEqual({
      interruptAckId: 'ack-new',
      ackLatencyMs: 80,
      ts: Date.now(),
      reasonSubmitted: false,
    });
  });

  test('session_interrupted for unknown session is a no-op (no crash)', () => {
    const s0 = seedSession();
    const s1 = reduce(s0, {
      type: 'server',
      msg: {
        type: 'session_interrupted',
        sessionId: 'sess-never-existed',
        ackLatencyMs: 5,
        interruptAckId: 'ack-z',
      },
    });
    // Other state unaffected.
    expect(s1.sessionsByProject[1]?.['sess-1']?.lastInterrupt).toBeUndefined();
  });
});

describe('store / lastInterrupt — clear on user_send', () => {
  test('user_send clears lastInterrupt for the active session', () => {
    let s = seedSession();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_interrupted',
        sessionId: 'sess-1',
        ackLatencyMs: 12,
        interruptAckId: 'ack-1',
      },
    });
    expect(s.sessionsByProject[1]!['sess-1']!.lastInterrupt).toBeDefined();

    // user_send needs an active session id pointing at sess-1; session_started
    // already set that. The reducer treats user_send as turn N+1.
    s = reduce(s, { type: 'user_send', text: 'follow-up' });
    expect(s.sessionsByProject[1]!['sess-1']!.lastInterrupt).toBeUndefined();
  });
});

describe('store / lastInterrupt — stop_reason_dismissed', () => {
  test('flips reasonSubmitted=true; preserves marker fields', () => {
    let s = seedSession();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_interrupted',
        sessionId: 'sess-1',
        ackLatencyMs: 42,
        interruptAckId: 'ack-1',
      },
    });
    s = reduce(s, { type: 'stop_reason_dismissed', sessionId: 'sess-1' });
    const li = s.sessionsByProject[1]!['sess-1']!.lastInterrupt!;
    expect(li.reasonSubmitted).toBe(true);
    // Marker metadata preserved so the "Stopped by you" line stays.
    expect(li.interruptAckId).toBe('ack-1');
    expect(li.ackLatencyMs).toBe(42);
    expect(typeof li.ts).toBe('number');
  });

  test('no-op when there is no lastInterrupt', () => {
    const s0 = seedSession();
    const s1 = reduce(s0, { type: 'stop_reason_dismissed', sessionId: 'sess-1' });
    // Identity equality on the session map → no churn.
    expect(s1.sessionsByProject).toBe(s0.sessionsByProject);
  });

  test('no-op when already submitted (double-dismiss is silent)', () => {
    let s = seedSession();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_interrupted',
        sessionId: 'sess-1',
        ackLatencyMs: 5,
        interruptAckId: 'ack-1',
      },
    });
    s = reduce(s, { type: 'stop_reason_dismissed', sessionId: 'sess-1' });
    const before = s.sessionsByProject;
    s = reduce(s, { type: 'stop_reason_dismissed', sessionId: 'sess-1' });
    // Identity-preserve.
    expect(s.sessionsByProject).toBe(before);
  });

  test('unknown sessionId dismissal is a no-op', () => {
    const s0 = seedSession();
    const s1 = reduce(s0, { type: 'stop_reason_dismissed', sessionId: 'sess-zzz' });
    expect(s1.sessionsByProject).toBe(s0.sessionsByProject);
  });
});
