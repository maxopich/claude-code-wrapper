import { describe, expect, test } from 'vitest';

import type { InFlightMeta } from '../runner/lifecycle.js';
import { describeConcurrentSingleTurn } from './server.js';

// Register S02b [security]. The one-turn-per-session guard (`describeTurnInFlight`)
// reads `conn.inFlight`, a per-CONNECTION map, so it only sees turns the socket
// that called it started. Two browser tabs are two connections: tab A's running
// turn is invisible to tab B's `conn.inFlight`, so tab B's `send_message` sailed
// through the guard and spawned a SECOND `claude --resume <sid>` against the same
// session — two interleaved SDK turns in one transcript, double subscription
// quota, and neither tab able to Stop the other's turn (`executeInterrupt` is
// per-connection too).
//
// The single-active-turn invariant only holds if it is process-wide. Every live
// single-agent turn is already in the lifecycle registry
// (`registerQuery(runner, { kind: 'single', sessionId, … })`); this guard reads
// that, the single-agent analogue of the bus's `describeLiveSessionConflict`
// (pinned in `start_guard_global.test.ts`).

const single = (sessionId: string): InFlightMeta => ({
  sessionId,
  projectId: 1,
  kind: 'single',
  startedAt: 0,
});

describe('describeConcurrentSingleTurn — process-wide one-turn-per-session [security]', () => {
  test('an empty registry permits a turn', () => {
    expect(describeConcurrentSingleTurn([], 'sess-1')).toBeNull();
  });

  test('a single-agent turn live on ANOTHER connection blocks this one', () => {
    // The core fix: tab A's turn is in the process-wide snapshot even though
    // tab B's `conn.inFlight` is empty. The per-connection guard could not see
    // this; this one must.
    expect(describeConcurrentSingleTurn([single('sess-1')], 'sess-1')).not.toBeNull();
  });

  test('the refusal points at the other window and says what to do', () => {
    const msg = describeConcurrentSingleTurn([single('sess-1')], 'sess-1') ?? '';
    expect(msg).toContain('already has a turn running');
    expect(msg).toContain('browser window');
    expect(msg).toContain('stop it');
  });

  test("another session's live turn does not block this one", () => {
    // Two DIFFERENT single-agent sessions running at once is normal — the guard
    // is per-session, not a global single-turn lock.
    expect(describeConcurrentSingleTurn([single('sess-other')], 'sess-1')).toBeNull();
  });

  test('a bus turn sharing the id does not block — the bus has its own guard', () => {
    // `snapshotInFlight()` also carries bus-worker / orchestrator entries. Those
    // are guarded by `describeLiveSessionConflict`; this single-agent path must
    // only refuse on another SINGLE turn, so it filters on `kind`.
    const busEntry: InFlightMeta = {
      sessionId: 'sess-1',
      projectId: 2,
      kind: 'bus-worker',
      startedAt: 0,
    };
    expect(describeConcurrentSingleTurn([busEntry], 'sess-1')).toBeNull();
  });

  test('a brand-new session id can never collide', () => {
    // `runOneTurn` keys a first turn by a fresh `randomUUID()`, so only a
    // genuine resume can be rejected — the guard must never refuse a new chat.
    expect(describeConcurrentSingleTurn([single('sess-1')], crypto.randomUUID())).toBeNull();
  });

  test('the session is startable again once its turn tears down', () => {
    // `runOneTurn`'s finally calls the `registerQuery` unregister callback,
    // which removes the entry from the snapshot — a session must be resumable
    // afterwards or one turn would wedge it across every connection.
    expect(describeConcurrentSingleTurn([single('sess-1')], 'sess-1')).not.toBeNull();
    expect(describeConcurrentSingleTurn([], 'sess-1')).toBeNull();
  });
});
