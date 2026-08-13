import { describe, expect, test } from 'vitest';
import { initialState, reduce, type AppState } from './store';

/**
 * Register W16: a `wrapper_error` with no session of its own must not invent
 * one.
 *
 * The reducer's third fallback used to be `?? newPendingId()`, which minted a
 * `pending:*` id and wrote a full `SessionView` under it. Nothing pointed at
 * that session — not `activeSessionByProject`, not `pendingByProject`, not
 * `knownSessions` — so the error text was unreachable in the UI and every
 * occurrence leaked another bucket into state.
 *
 * The operator's surface for a sessionless error already exists:
 * `notifyFromServerMsg` pushes a sticky "Server error" toast for exactly the
 * `!msg.sessionId` case. Nothing had to replace the invented session, only
 * stop being created.
 *
 * The shape of the guard is copied from the bus-scoped one directly above it
 * in the same case: return early, but still bump `failureSeq` so pending
 * spinners clear and still promote `authExpired` so the app-wide banner isn't
 * something this guard can swallow.
 */

const PID = 1;

function seedProject(): AppState {
  return reduce(initialState, { type: 'select_project', projectId: PID });
}

function sessionlessError(kind: 'process_crashed' | 'auth_expired' = 'process_crashed') {
  return {
    type: 'server' as const,
    msg: { type: 'wrapper_error' as const, kind, message: 'the server fell over' },
  };
}

describe('store / a sessionless wrapper_error with nowhere to land (W16)', () => {
  test('creates no session at all', () => {
    const before = seedProject();
    expect(before.sessionsByProject[PID]).toBeUndefined();

    const after = reduce(before, sessionlessError());

    // Not one bucket, pending-shaped or otherwise.
    expect(Object.keys(after.sessionsByProject[PID] ?? {})).toEqual([]);
    expect(after.activeSessionByProject[PID]).toBeUndefined();
    expect(after.pendingByProject[PID]).toBeUndefined();
  });

  test('repeated occurrences leak nothing', () => {
    let s = seedProject();
    for (let i = 0; i < 5; i += 1) s = reduce(s, sessionlessError());

    expect(Object.keys(s.sessionsByProject[PID] ?? {})).toEqual([]);
    // The counter is the part that must still move — five failures, five bumps.
    expect(s.failureSeq).toBe(5);
  });

  test('still bumps failureSeq so pending spinners clear', () => {
    const before = seedProject();
    const after = reduce(before, sessionlessError());
    expect(after.failureSeq).toBe(before.failureSeq + 1);
  });

  test('still promotes auth_expired so the app-wide banner is not swallowed', () => {
    const s = reduce(seedProject(), sessionlessError('auth_expired'));
    expect(s.authExpired).toBeDefined();
    expect(s.authExpired?.count).toBe(1);
  });

  test('CONTROL: an error that DOES have somewhere to land still lands there', () => {
    // Same sessionless envelope, but this project has an active session, so
    // `getActiveSessionId` resolves and the error renders inline as before.
    let s = seedProject();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_started',
        sessionId: 'sess-1',
        projectId: PID,
        model: 'opus-4',
        tools: [],
      },
    });

    s = reduce(s, sessionlessError());

    const sess = s.sessionsByProject[PID]?.['sess-1'];
    expect(sess).toBeDefined();
    expect(sess!.status).toBe('error');
    expect(sess!.messages.some((m) => m.kind === 'error')).toBe(true);
  });

  test('CONTROL: a session-scoped error is unaffected by the guard', () => {
    let s = seedProject();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_started',
        sessionId: 'sess-2',
        projectId: PID,
        model: 'opus-4',
        tools: [],
      },
    });

    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'wrapper_error',
        sessionId: 'sess-2',
        kind: 'process_crashed',
        message: 'boom',
      },
    });

    const sess = s.sessionsByProject[PID]?.['sess-2'];
    expect(sess!.status).toBe('error');
    expect(sess!.messages.filter((m) => m.kind === 'error')).toHaveLength(1);
  });
});
