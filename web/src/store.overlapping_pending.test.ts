import { describe, expect, test } from 'vitest';
import { initialState, isSessionPending, reduce, type AppState } from './store';

/**
 * Cebab-ygu.25: two overlapping fresh turns in one project must not cross-wire.
 *
 * `pendingByProject` used to be a single pointer, so `session_started` adopted
 * whatever pending bucket the project pointed at RIGHT NOW rather than the one
 * the arriving session actually ran. The failure needs two fresh turns to
 * overlap, which `new_session` makes reachable: the operator sends a first
 * message, the spawn is slow, they click "new chat" (which used to drop the
 * pending pointer while keeping the orphaned bucket) and send a second — so
 * when the FIRST turn's `session_started` lands it found the SECOND turn's
 * pending pointer, renamed that bucket, and left the first turn's message
 * stranded in a bucket nothing referenced.
 *
 * The fix makes `pendingByProject` a FIFO queue and adopts oldest-first, which
 * matches the order overlapping turns spawn and their inits arrive.
 */

const PID = 1;

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

function userTexts(s: AppState, sessionId: string, projectId = PID): string[] {
  const sess = s.sessionsByProject[projectId]?.[sessionId];
  if (!sess) return [];
  return sess.messages.filter((m) => m.kind === 'user').map((m) => (m as { text: string }).text);
}

/** Any `pending:*` bucket still sitting in the project's session map. */
function orphanPending(s: AppState, projectId = PID): string[] {
  return Object.keys(s.sessionsByProject[projectId] ?? {}).filter(isSessionPending);
}

describe('store / overlapping fresh turns do not cross-wire (Cebab-ygu.25)', () => {
  test('the first turn keeps its own message; the second is not empty; nothing stranded', () => {
    let s = reduce(initialState, { type: 'select_project', projectId: PID });

    // Turn 1: first message, spawn still in flight.
    s = reduce(s, { type: 'user_send', text: 'msg1' });
    const p1 = s.pendingByProject[PID]![0]!;
    expect(isSessionPending(p1)).toBe(true);

    // Operator gives up waiting and clicks New chat — the pane looks idle
    // because the spawn has not reported in.
    s = reduce(s, { type: 'new_session', projectId: PID });
    // The in-flight turn is still queued; new_session must not drop it.
    expect(s.pendingByProject[PID]).toEqual([p1]);

    // Turn 2: second message in the same project.
    s = reduce(s, { type: 'user_send', text: 'msg2' });
    const p2 = s.pendingByProject[PID]!.at(-1)!;
    expect(p2).not.toBe(p1);
    expect(s.pendingByProject[PID]).toEqual([p1, p2]);

    // The FIRST turn reports in first (it spawned first).
    s = reduce(s, started('S1'));
    // The SECOND turn reports in.
    s = reduce(s, started('S2'));

    // Each session shows the message it actually ran — this is the whole bug:
    // on the old reducer S1 showed 'msg2' and S2 showed nothing.
    expect(userTexts(s, 'S1')).toEqual(['msg1']);
    expect(userTexts(s, 'S2')).toEqual(['msg2']);

    // No optimistic bucket is left behind, and the queue has drained.
    expect(orphanPending(s)).toEqual([]);
    expect(s.pendingByProject[PID]).toBeUndefined();

    // The view follows the last session to start, as it did before.
    expect(s.activeSessionByProject[PID]).toBe('S2');
  });

  test('new chat then a single slow turn: the message is adopted, not stranded', () => {
    // The single-turn slice of the same bug: even with no second message,
    // `new_session` dropping the pending pointer used to leave the first turn's
    // `session_started` with nothing to adopt — it minted an empty session and
    // stranded 'msg1' in an orphan bucket.
    let s = reduce(initialState, { type: 'select_project', projectId: PID });
    s = reduce(s, { type: 'user_send', text: 'msg1' });
    const p1 = s.pendingByProject[PID]![0]!;

    s = reduce(s, { type: 'new_session', projectId: PID });
    s = reduce(s, started('S1'));

    expect(userTexts(s, 'S1')).toEqual(['msg1']);
    expect(s.sessionsByProject[PID]?.[p1]).toBeUndefined();
    expect(orphanPending(s)).toEqual([]);
    expect(s.activeSessionByProject[PID]).toBe('S1');
  });

  test('a resume does not steal a stranded pending still in the queue', () => {
    // If a first turn somehow never reports in, its pending lingers in the
    // queue. A later resume of an EXISTING session (its id already in the map)
    // must not adopt that stranded bucket onto itself — the `!nextProjectMap`
    // guard in the adoption condition.
    let s = reduce(initialState, { type: 'select_project', projectId: PID });

    // An already-established session, then a fresh first turn stranded behind it.
    s = reduce(s, started('S-old'));
    s = reduce(s, { type: 'new_session', projectId: PID });
    s = reduce(s, { type: 'user_send', text: 'orphaned' });
    const stranded = s.pendingByProject[PID]!.at(-1)!;

    // The operator goes back to S-old and sends a follow-up (a resume): the
    // server re-emits `session_started` for the SAME id.
    s = reduce(s, started('S-old'));

    // S-old did not swallow the stranded first turn's message...
    expect(userTexts(s, 'S-old')).toEqual([]);
    // ...and the stranded pending is untouched, awaiting its own report.
    expect(s.sessionsByProject[PID]?.[stranded]).toBeDefined();
    expect(s.pendingByProject[PID]).toEqual([stranded]);
  });
});
