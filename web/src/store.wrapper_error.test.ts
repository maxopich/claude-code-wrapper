import { describe, expect, test } from 'vitest';
import { activeSession, initialState, reduce, sessionPhase, type AppState } from './store';

/**
 * Register W16 + Cebab-da6: a `wrapper_error` with no session of its own must
 * not invent one, and must not borrow one either.
 *
 * W16 removed the reducer's THIRD fallback, `?? newPendingId()`, which minted
 * a `pending:*` id and wrote a full `SessionView` under it. Nothing pointed at
 * that session — not `activeSessionByProject`, not `pendingByProject`, not
 * `knownSessions` — so the error text was unreachable in the UI and every
 * occurrence leaked another bucket into state.
 *
 * da6 removed the SECOND, `?? getActiveSessionId(state, projectId)`, which
 * folded the error onto whichever session happened to be active. That is the
 * more damaging half: it flipped an unrelated conversation to `status:
 * 'error'`, appended a red inline error to its transcript, and cleared its
 * `streamingText`. Twenty-six server call sites send a sessionless
 * `wrapper_error` and nearly all of them are refusals of an operator ACTION —
 * "a multi-agent session needs at least one participant", a bad workspace
 * path, an `mcp_trust_decision` that failed validation. None of those is a
 * statement about the chat that happens to be open.
 *
 * The operator's surface for a sessionless error already exists:
 * `notifyFromServerMsg` pushes a sticky "Server error" toast for exactly the
 * `!msg.sessionId` case. Nothing had to replace either fallback.
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

/** A project with one live session, mid-stream, so the fold has a victim. */
function seedProjectWithLiveSession(streamingText = 'half a sentence so f'): AppState {
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
  // Anti-vacuity: the bug this file now guards destroys in-flight output, so
  // the fixture has to HAVE in-flight output. A session left at the default
  // `streamingText: ''` would pass every assertion below on the broken
  // reducer, because there would be nothing left to lose.
  const sess = s.sessionsByProject[PID]!['sess-1']!;
  return {
    ...s,
    sessionsByProject: {
      ...s.sessionsByProject,
      [PID]: { ...s.sessionsByProject[PID], 'sess-1': { ...sess, streamingText } },
    },
  };
}

function sessionlessError(kind: 'process_crashed' | 'auth_expired' = 'process_crashed') {
  return {
    type: 'server' as const,
    msg: { type: 'wrapper_error' as const, kind, message: 'the server fell over' },
  };
}

describe('store / a sessionless wrapper_error lands in no session (W16, Cebab-da6)', () => {
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

  test('does not borrow the active session (Cebab-da6)', () => {
    // This test previously existed with the opposite assertion, as
    // `CONTROL: an error that DOES have somewhere to land still lands there`.
    // It was a scope fence, not an endorsement — its comment said the error
    // "renders inline AS BEFORE", i.e. W16 chose not to touch this half. It is
    // the half da6 is about, so the assertion inverts.
    const before = seedProjectWithLiveSession();
    const after = reduce(before, sessionlessError());

    const sess = after.sessionsByProject[PID]?.['sess-1'];
    expect(sess).toBeDefined();
    // Not flagged failed: nothing about this session failed.
    expect(sess!.status).not.toBe('error');
    expect(sess!.messages.filter((m) => m.kind === 'error')).toHaveLength(0);
    // And the partial output is still there. This is the assertion that fails
    // loudest on the old reducer, because W01's `streamingText: ''` ran
    // unconditionally once the fold picked this session.
    expect(sess!.streamingText).toBe('half a sentence so f');
  });

  test('still bumps failureSeq with a live session present', () => {
    // The two things the guard must NOT swallow, measured on the path the
    // test above walks — so "left the session alone" cannot be achieved by
    // returning `state` untouched.
    const before = seedProjectWithLiveSession();
    const after = reduce(before, sessionlessError());
    expect(after.failureSeq).toBe(before.failureSeq + 1);
  });

  test('reports even before any project is selected', () => {
    // The guard also moved above the project resolution. It used to sit under
    // `if (projectId === null) return state;`, so a sessionless error arriving
    // before the operator clicked a project bumped nothing and raised no
    // auth banner.
    expect(initialState.activeProjectId).toBeNull();
    const after = reduce(initialState, sessionlessError('auth_expired'));
    expect(after.failureSeq).toBe(initialState.failureSeq + 1);
    expect(after.authExpired?.count).toBe(1);
  });

  test('CONTROL: an error that NAMES a session still lands in it', () => {
    // Without this, the assertions above would all pass on a reducer that
    // ignored `wrapper_error` entirely.
    const before = seedProjectWithLiveSession();
    const after = reduce(before, {
      type: 'server',
      msg: {
        type: 'wrapper_error',
        sessionId: 'sess-1',
        kind: 'process_crashed',
        message: 'this one really did fall over',
      },
    });

    const sess = after.sessionsByProject[PID]?.['sess-1'];
    expect(sess!.status).toBe('error');
    expect(sess!.messages.filter((m) => m.kind === 'error')).toHaveLength(1);
    // W01 still retires the streaming buffer for a session that really failed.
    expect(sess!.streamingText).toBe('');
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

/**
 * Cebab-ygu.24: a session-scoped `wrapper_error` whose id the browser has NOT
 * adopted yet (a first-turn spawn that dies before `system/init`, so no
 * `session_started` ever migrates the optimistic `pending:*` bucket). W16
 * removed the orphan-bucket leak only for the SESSIONLESS variant; the
 * unknown-session-id case still landed the error in a fresh bucket nothing
 * pointed at, leaving the operator's pending session spinning forever.
 *
 * Drives the real reducer through the exact failure sequence: select_project →
 * user_send → session_running(true) → wrapper_error.
 */
describe('store / a wrapper_error for an un-adopted first-turn session (Cebab-ygu.24)', () => {
  const REAL = 'sess-uuid';

  /** Fresh chat + first message in flight, server id minted but not adopted. */
  function seedFirstTurn(): { before: AppState; pendingId: string } {
    let s = reduce(initialState, { type: 'select_project', projectId: PID });
    s = reduce(s, { type: 'user_send', text: 'hi' });
    const pendingId = s.pendingByProject[PID]!;
    expect(pendingId).toMatch(/^pending:/);
    // Server minted the real id and announced it live — this writes only
    // `sessionToProject`, never adopting the pending bucket.
    s = reduce(s, {
      type: 'server',
      msg: { type: 'session_running', sessionId: REAL, projectId: PID, running: true },
    });
    return { before: s, pendingId };
  }

  function crash(): {
    type: 'server';
    msg: { type: 'wrapper_error'; sessionId: string; kind: 'process_crashed'; message: string };
  } {
    return {
      type: 'server',
      msg: {
        type: 'wrapper_error',
        sessionId: REAL,
        kind: 'process_crashed',
        message: 'spawn claude ENOENT',
      },
    };
  }

  test('the pending session is adopted onto the real id, not left spinning in an orphan bucket', () => {
    const { before, pendingId } = seedFirstTurn();
    const after = reduce(before, crash());

    // The optimistic bucket is gone; the real id is the only session.
    expect(Object.keys(after.sessionsByProject[PID] ?? {})).toEqual([REAL]);
    expect(after.sessionsByProject[PID]?.[pendingId]).toBeUndefined();

    // The project now points at the real session, and the pending pointer is
    // cleared.
    expect(after.activeSessionByProject[PID]).toBe(REAL);
    expect(after.pendingByProject[PID]).toBeUndefined();
  });

  test('the error is reachable — it lands in the shown session next to the user message', () => {
    const { before } = seedFirstTurn();
    const after = reduce(before, crash());

    const shown = activeSession(after);
    expect(shown).not.toBeNull();
    expect(shown!.id).toBe(REAL);
    // The user's optimistic message survived the migration...
    expect(
      shown!.messages.filter((m) => m.kind === 'user').map((m) => (m as { text: string }).text),
    ).toEqual(['hi']);
    // ...and the error text is on the same, visible transcript.
    const errs = shown!.messages.filter((m) => m.kind === 'error');
    expect(errs).toHaveLength(1);
    expect((errs[0] as { message: string }).message).toBe('spawn claude ENOENT');
  });

  test('the spinner stops — the shown session is error, not a running pending bucket', () => {
    const { before } = seedFirstTurn();

    // Before the fix, the shown (pending) session is still 'running' →
    // 'thinking' with the composer stuck on Stop.
    const stuck = activeSession(before)!;
    expect(stuck.status).toBe('running');
    expect(sessionPhase(stuck, true)).toBe('thinking');

    const after = reduce(before, crash());
    const shown = activeSession(after)!;
    expect(shown.status).toBe('error');
    expect(sessionPhase(shown, false)).toBe('error');
  });

  test('repeated crashes for un-adopted ids leak no orphan buckets', () => {
    let { before: s } = seedFirstTurn();
    for (let i = 0; i < 5; i += 1) s = reduce(s, crash());
    // Still exactly one session (idempotent re-application, no leak).
    expect(Object.keys(s.sessionsByProject[PID] ?? {})).toEqual([REAL]);
    expect(s.failureSeq).toBe(5);
  });

  test('still promotes auth_expired when the un-adopted spawn failed on credentials', () => {
    const { before } = seedFirstTurn();
    const after = reduce(before, {
      type: 'server',
      msg: {
        type: 'wrapper_error',
        sessionId: REAL,
        kind: 'auth_expired',
        message: 'oauth token revoked',
      },
    });
    expect(after.authExpired?.count).toBe(1);
    expect(after.activeSessionByProject[PID]).toBe(REAL);
  });
});
