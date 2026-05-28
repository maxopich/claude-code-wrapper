import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import { initialState, reduce, type AppState } from './store';

// Cluster D Phase 6 (spec §6.4 / UI-D22): reducer slice tests for the
// top-level `authExpired` state.
//
// Coverage:
//   1. wrapper_error{kind:'auth_expired'} populates the slice with
//      first-seen / last-seen / count / lastMessage
//   2. subsequent observations bump count + lastSeenMs without
//      changing firstSeenMs
//   3. observation after dismiss flips dismissed back to false so
//      the banner re-surfaces (no silent silence)
//   4. wrapper_error{kind:other} does NOT touch the slice
//   5. auth_expired_dismissed sets dismissed=true; identity-preserves
//      when nothing to dismiss
//   6. session_started clears the slice entirely (positive auth signal)
//   7. session_started is a no-op when slice already empty (identity-
//      preserve avoids re-render churn on every running turn)

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-28T09:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

function seedProjectAndSession(): AppState {
  // The wrapper_error reducer needs an activeProjectId so the per-
  // session inline error has somewhere to land. Use the standard test
  // dispatch chain: project_opened → select_project (or rely on
  // sessionToProject mapping from a prior session_started).
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
  return s;
}

describe('store / auth_expired slice — populate', () => {
  test('first wrapper_error{kind:auth_expired} populates first/last/count/lastMessage', () => {
    const s0 = seedProjectAndSession();
    expect(s0.authExpired).toBeUndefined();

    const s1 = reduce(s0, {
      type: 'server',
      msg: {
        type: 'wrapper_error',
        kind: 'auth_expired',
        message: 'OAuth expired (run claude login)',
      },
    });

    expect(s1.authExpired).toBeDefined();
    expect(s1.authExpired!.firstSeenMs).toBe(Date.now());
    expect(s1.authExpired!.lastSeenMs).toBe(Date.now());
    expect(s1.authExpired!.count).toBe(1);
    expect(s1.authExpired!.lastMessage).toBe('OAuth expired (run claude login)');
    expect(s1.authExpired!.dismissed).toBe(false);
  });

  test('subsequent observation bumps count + lastSeenMs, keeps firstSeenMs', () => {
    const s0 = seedProjectAndSession();
    const s1 = reduce(s0, {
      type: 'server',
      msg: { type: 'wrapper_error', kind: 'auth_expired', message: 'first' },
    });
    const firstMs = s1.authExpired!.firstSeenMs;

    // Advance time and observe again
    vi.advanceTimersByTime(5000);
    const s2 = reduce(s1, {
      type: 'server',
      msg: { type: 'wrapper_error', kind: 'auth_expired', message: 'second' },
    });

    expect(s2.authExpired!.firstSeenMs).toBe(firstMs);
    expect(s2.authExpired!.lastSeenMs).toBe(firstMs + 5000);
    expect(s2.authExpired!.count).toBe(2);
    expect(s2.authExpired!.lastMessage).toBe('second');
  });

  test('observation after dismiss re-surfaces banner (dismissed → false)', () => {
    let s = seedProjectAndSession();
    s = reduce(s, {
      type: 'server',
      msg: { type: 'wrapper_error', kind: 'auth_expired', message: 'first' },
    });
    s = reduce(s, { type: 'auth_expired_dismissed' });
    expect(s.authExpired!.dismissed).toBe(true);

    // Fresh failure arrives → re-surface
    s = reduce(s, {
      type: 'server',
      msg: { type: 'wrapper_error', kind: 'auth_expired', message: 'second' },
    });
    expect(s.authExpired!.dismissed).toBe(false);
    expect(s.authExpired!.count).toBe(2);
  });

  test('wrapper_error{kind:other} does NOT touch the slice (auth-only signal)', () => {
    const s0 = seedProjectAndSession();
    const s1 = reduce(s0, {
      type: 'server',
      msg: { type: 'wrapper_error', kind: 'process_crashed', message: 'process died' },
    });
    expect(s1.authExpired).toBeUndefined();

    // And with an existing slice, a non-auth wrapper_error preserves it identity-wise
    const s2 = reduce(s1, {
      type: 'server',
      msg: { type: 'wrapper_error', kind: 'auth_expired', message: 'expired' },
    });
    expect(s2.authExpired).toBeDefined();
    const s3 = reduce(s2, {
      type: 'server',
      msg: { type: 'wrapper_error', kind: 'parse_error', message: 'bad json' },
    });
    // authExpired slice unchanged (same reference even — non-auth path doesn't rebuild it)
    expect(s3.authExpired).toBe(s2.authExpired);
  });
});

describe('store / auth_expired slice — dismiss', () => {
  test('auth_expired_dismissed sets dismissed=true', () => {
    let s = seedProjectAndSession();
    s = reduce(s, {
      type: 'server',
      msg: { type: 'wrapper_error', kind: 'auth_expired', message: 'fail' },
    });
    s = reduce(s, { type: 'auth_expired_dismissed' });
    expect(s.authExpired!.dismissed).toBe(true);
  });

  test('auth_expired_dismissed is identity-preserving when slice is empty', () => {
    const s0 = seedProjectAndSession();
    expect(s0.authExpired).toBeUndefined();
    const s1 = reduce(s0, { type: 'auth_expired_dismissed' });
    // Same reference — reducer bailed without rebuilding state
    expect(s1).toBe(s0);
  });

  test('auth_expired_dismissed is identity-preserving when already dismissed', () => {
    let s = seedProjectAndSession();
    s = reduce(s, {
      type: 'server',
      msg: { type: 'wrapper_error', kind: 'auth_expired', message: 'fail' },
    });
    const dismissed = reduce(s, { type: 'auth_expired_dismissed' });
    const dismissedAgain = reduce(dismissed, { type: 'auth_expired_dismissed' });
    expect(dismissedAgain).toBe(dismissed);
  });
});

describe('store / auth_expired slice — clear on session_started', () => {
  test('session_started clears the slice (positive auth signal)', () => {
    let s = seedProjectAndSession();
    s = reduce(s, {
      type: 'server',
      msg: { type: 'wrapper_error', kind: 'auth_expired', message: 'fail' },
    });
    expect(s.authExpired).toBeDefined();

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
    expect(s.authExpired).toBeUndefined();
  });

  test('session_started is identity-equivalent when slice was already empty', () => {
    // session_started with no prior auth_expired should still emit a new
    // state (the rest of the case rebuilds session maps), but the
    // authExpired field stays undefined — verify by deep-checking it
    // didn't accidentally get reset to a fresh value.
    let s = seedProjectAndSession();
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
    expect(s.authExpired).toBeUndefined();
  });
});
