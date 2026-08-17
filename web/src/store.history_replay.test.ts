import { describe, expect, test } from 'vitest';
import {
  initialState,
  isSessionPending,
  reduce,
  sessionSelectionRequests,
  type AppState,
} from './store';

/**
 * Register W08: a replayed `session_started` must not be mistaken for a live
 * one.
 *
 * `replaySession` streams persisted rows back through `translate`, and a
 * persisted `system/init` row becomes a `session_started` indistinguishable on
 * the wire from the one a fresh turn emits. The reducer used to act on both
 * identically, so loading an old session while a first message was in flight
 * adopted the pending optimistic bucket: the operator's just-typed message
 * became the first line of an unrelated conversation, and the real session —
 * when it finally started — was empty.
 *
 * The pairing that matters is here: every "does not fire during a replay" case
 * sits next to the control proving it still fires when live. A guard that
 * simply deleted the migration would satisfy half of this file and fail the
 * other half.
 */

const PID = 1;
const OTHER_PID = 2;
const DRAFT = 'the message I just typed';

function open(projectId = PID, state: AppState = initialState): AppState {
  return reduce(state, { type: 'select_project', projectId });
}

function started(sessionId: string, projectId = PID) {
  return {
    type: 'server' as const,
    msg: {
      type: 'session_started' as const,
      sessionId,
      projectId,
      model: 'opus-4',
      tools: [],
    },
  };
}

function historyStart(sessionId: string, projectId = PID) {
  return {
    type: 'server' as const,
    msg: { type: 'session_history_start' as const, projectId, sessionId },
  };
}

function historyEnd(sessionId: string, projectId = PID) {
  return {
    type: 'server' as const,
    msg: { type: 'session_history_end' as const, projectId, sessionId },
  };
}

/** The project's pending session id, or undefined once it has been consumed. */
function pendingId(s: AppState, projectId = PID): string | undefined {
  return s.pendingByProject[projectId];
}

function userTexts(s: AppState, projectId: number, sessionId: string): string[] {
  const sess = s.sessionsByProject[projectId]?.[sessionId];
  if (!sess) return [];
  return sess.messages.filter((m) => m.kind === 'user').map((m) => (m as { text: string }).text);
}

describe('store / a replay does not steal the pending session (W08)', () => {
  test('the operator’s in-flight message survives loading an old session', () => {
    let s = open();
    s = reduce(s, { type: 'user_send', text: DRAFT });

    const pending = pendingId(s);
    expect(pending).toBeDefined();
    expect(isSessionPending(pending!)).toBe(true);

    // Operator clicks a past session of the SAME project while the new turn
    // is still spinning up. The server replays it: start, rows, end.
    s = reduce(s, historyStart('old-1'));
    s = reduce(s, started('old-1'));
    s = reduce(s, historyEnd('old-1'));

    // The pending pointer AND the pending bucket are both untouched. Losing
    // either one strands the message: without the pointer nothing renames the
    // bucket later, without the bucket there is nothing left to rename.
    expect(pendingId(s)).toBe(pending);
    expect(userTexts(s, PID, pending!)).toEqual([DRAFT]);

    // And the replayed session did not inherit it.
    expect(userTexts(s, PID, 'old-1')).toEqual([]);
  });

  test('CONTROL: the live session_started that follows still adopts it', () => {
    let s = open();
    s = reduce(s, { type: 'user_send', text: DRAFT });
    const pending = pendingId(s)!;

    s = reduce(s, historyStart('old-1'));
    s = reduce(s, started('old-1'));
    s = reduce(s, historyEnd('old-1'));

    // Now the real turn reports in.
    s = reduce(s, started('new-1'));

    expect(pendingId(s)).toBeUndefined();
    expect(s.sessionsByProject[PID]?.[pending]).toBeUndefined();
    expect(userTexts(s, PID, 'new-1')).toEqual([DRAFT]);
  });

  test('the guard keys on the project, so a session id that drifts mid-replay still counts', () => {
    // `translate` reads its sessionId from the persisted row's own
    // `session_id`, which need not match the id the replay was asked for;
    // `projectId` is injected by the server for every replayed row. Matching
    // the project is what keeps the guard honest across that gap.
    let s = open();
    s = reduce(s, { type: 'user_send', text: DRAFT });
    const pending = pendingId(s)!;

    s = reduce(s, historyStart('asked-for'));
    s = reduce(s, started('a-different-id-in-the-row'));

    expect(pendingId(s)).toBe(pending);
    expect(userTexts(s, PID, pending)).toEqual([DRAFT]);
  });

  test('CONTROL: replaying one project does not shield another project’s pending', () => {
    let s = open(OTHER_PID);
    s = open(PID, s);
    s = reduce(s, { type: 'user_send', text: DRAFT });
    const pending = pendingId(s)!;

    // A replay is in flight for a different project entirely.
    s = reduce(s, historyStart('elsewhere', OTHER_PID));
    // …while PID's real session starts. This one IS live for PID.
    s = reduce(s, started('new-1'));

    expect(pendingId(s)).toBeUndefined();
    expect(s.sessionsByProject[PID]?.[pending]).toBeUndefined();
    expect(userTexts(s, PID, 'new-1')).toEqual([DRAFT]);
  });
});

describe('store / the replay flag never gets stuck', () => {
  test('session_history_start records the replay, session_history_end retires it', () => {
    let s = open();
    expect(s.historyReplay).toBeNull();

    s = reduce(s, historyStart('old-1'));
    expect(s.historyReplay).toEqual({ projectId: PID, sessionId: 'old-1' });

    s = reduce(s, historyEnd('old-1'));
    expect(s.historyReplay).toBeNull();
  });

  test('session_history_end clears it even when there is no session bucket to close', () => {
    // `session_history_end` returns early when the bucket is missing. Clearing
    // after that early return would leave the flag set in exactly the case
    // where the replay went wrong — and a stuck flag fails unsafe, making the
    // next live session_started look like history.
    let s = open();
    s = reduce(s, historyStart('old-1'));
    s = reduce(s, historyEnd('a-session-that-was-never-hydrated'));

    expect(s.historyReplay).toBeNull();
  });

  test('a dropped connection retires a replay the server will never finish', () => {
    let s = open();
    s = reduce(s, historyStart('old-1'));
    s = reduce(s, { type: 'ws_close' });

    expect(s.historyReplay).toBeNull();
  });

  test('a stuck flag would strand the pending — proving why the two clears matter', () => {
    // Same sequence as the first test but with the replay never closed out.
    // Once `ws_close` retires it, the next live session_started migrates.
    let s = open();
    s = reduce(s, { type: 'user_send', text: DRAFT });
    const pending = pendingId(s)!;

    s = reduce(s, historyStart('old-1'));
    s = reduce(s, { type: 'ws_close' });
    s = reduce(s, started('new-1'));

    expect(pendingId(s)).toBeUndefined();
    expect(s.sessionsByProject[PID]?.[pending]).toBeUndefined();
    expect(userTexts(s, PID, 'new-1')).toEqual([DRAFT]);
  });
});

/**
 * Cebab-f9x: a replayed `session_started` must not stamp the session list with
 * `Date.now()`.
 *
 * Same root cause as W08 above, at the one site in that reducer case which was
 * never wired to `isReplay`. The sidebar orders and labels by `createdAt` /
 * `lastEventAt` and shows `totalCostUsd`, so a session that ran days ago was
 * synthesized as brand new and free, sorted to the top.
 *
 * The reachable path is the RunsBadge jump: it switches project and selects a
 * session in one action, so a replay can arrive for a project whose list was
 * never loaded. `session_history_start` creates the `sessionsByProject` bucket
 * but deliberately does not touch `knownSessions`, which is what leaves this
 * branch live during a replay — asserted below rather than argued, because it
 * is the premise the whole fix rests on.
 */
describe('knownSessions is not stamped from a replay (Cebab-f9x)', () => {
  const summaries = (s: AppState, projectId = PID) => s.knownSessions[projectId] ?? [];

  test('the premise: session_history_start does not populate knownSessions', () => {
    // If this ever stops being true the guard below becomes unreachable and
    // its test would pass while measuring nothing.
    const s = reduce(open(), historyStart('old-1'));
    expect(s.sessionsByProject[PID]?.['old-1']).toBeDefined();
    expect(s.knownSessions[PID]).toBeUndefined();
  });

  test('a replayed session_started adds no synthesized summary', () => {
    let s = open();
    s = reduce(s, historyStart('old-1'));
    s = reduce(s, started('old-1'));
    expect(summaries(s)).toEqual([]);
  });

  test('CONTROL: a live session_started still adds one', () => {
    // Without this, "never synthesize" passes the case above and the sidebar
    // silently stops gaining sessions — a worse bug than the one being fixed.
    let s = open();
    s = reduce(s, started('live-1'));
    expect(summaries(s).map((x) => x.id)).toEqual(['live-1']);
  });

  test('CONTROL: the guard is the replay flag, not the message', () => {
    // The same `started('old-1')` that was ignored during the replay is
    // honoured once `session_history_end` retires the flag. Pins that the fix
    // keys on replay state rather than on anything about the session id.
    let s = open();
    s = reduce(s, historyStart('old-1'));
    s = reduce(s, historyEnd('old-1'));
    s = reduce(s, started('old-1'));
    expect(summaries(s).map((x) => x.id)).toEqual(['old-1']);
  });

  test('a real summary already in the list is left alone by a replay', () => {
    // The pre-existing `alreadyKnown` short-circuit, kept honest: a replay must
    // neither invent a row nor overwrite the timestamps of a real one.
    const real = {
      id: 'old-1',
      title: 'yesterday',
      createdAt: 111,
      lastEventAt: 222,
      totalCostUsd: 0.5,
    };
    let s: AppState = { ...open(), knownSessions: { [PID]: [real] } };
    s = reduce(s, historyStart('old-1'));
    s = reduce(s, started('old-1'));
    expect(summaries(s)).toEqual([real]);
  });

  test('a replay in one project does not shield another project’s live start', () => {
    // `isReplay` keys on the project, matching the W08 guard above. A replay of
    // project 1 must not suppress a genuine new session in project 2.
    let s = open();
    s = reduce(s, historyStart('old-1'));
    s = reduce(s, started('live-2', OTHER_PID));
    expect(summaries(s, OTHER_PID).map((x) => x.id)).toEqual(['live-2']);
  });
});

/**
 * Cebab-f9x, the other half. Skipping the synthesis is only correct if the real
 * session list gets asked for; otherwise the fix trades a false sidebar row for
 * a missing one.
 *
 * `App.tsx` has no test harness, so the decision lives in `store.ts` and this
 * pins all four combinations. The fourth is the point: a hydrated conversation
 * in a project whose list was never loaded still needs `open_project`, which is
 * exactly what a `if (!alreadyHydrated) { … }` shape gets wrong.
 */
describe('sessionSelectionRequests (Cebab-f9x)', () => {
  const withList = (s: AppState, projectId = PID): AppState => ({
    ...s,
    knownSessions: { ...s.knownSessions, [projectId]: [] },
  });

  test('nothing loaded: asks for both the conversation and the list', () => {
    expect(sessionSelectionRequests(open(), PID, 'sess-1')).toEqual([
      { type: 'load_session', projectId: PID, sessionId: 'sess-1' },
      { type: 'open_project', projectId: PID },
    ]);
  });

  test('list loaded, conversation not: asks only for the conversation', () => {
    expect(sessionSelectionRequests(withList(open()), PID, 'sess-1')).toEqual([
      { type: 'load_session', projectId: PID, sessionId: 'sess-1' },
    ]);
  });

  test('both loaded: asks for nothing', () => {
    let s = withList(open());
    s = reduce(s, started('sess-1'));
    expect(sessionSelectionRequests(s, PID, 'sess-1')).toEqual([]);
  });

  test('conversation loaded, list absent: still asks for the list', () => {
    // THE CASE THAT MATTERS. Hanging the list request off the hydration check
    // — the obvious shape — returns [] here, and the sidebar stays empty for a
    // project the operator has been switched into.
    let s = open();
    s = reduce(s, historyStart('sess-1'));
    expect(s.sessionsByProject[PID]?.['sess-1']).toBeDefined();
    expect(s.knownSessions[PID]).toBeUndefined();
    expect(sessionSelectionRequests(s, PID, 'sess-1')).toEqual([
      { type: 'open_project', projectId: PID },
    ]);
  });

  test('an empty list is loaded, not absent', () => {
    // `[]` is a real answer from the server ("this project has no sessions").
    // A truthiness check would re-request it forever.
    expect(sessionSelectionRequests(withList(open()), PID, 'sess-1')).not.toContainEqual({
      type: 'open_project',
      projectId: PID,
    });
  });
});
