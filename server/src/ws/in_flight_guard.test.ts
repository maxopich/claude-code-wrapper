import { describe, expect, test } from 'vitest';

import { describeTurnInFlight } from './server.js';

// Register S02 [security]. `runOneTurn` resolved `sessionId` and then called
// `conn.inFlight.set(...)` with no check in between. Two `send_message`s for
// one session therefore started PARALLEL SDK queries against the same
// `--resume` id — and turn one's `finally` does
// `conn.inFlight.delete(sessionId)`, which removed TURN TWO's entry. From
// there Stop, permission-mode changes and the active-runs badge all silently
// targeted nothing: the operator had a running agent they could no longer
// stop from the UI.
//
// The codebase already knew this was wrong — `resolveRetryRateLimited` guards
// the identical hazard and spells out the reasoning ("would spawn parallel SDK
// turns on the same `--resume` id and wedge the session"). Only the main entry
// point lacked it.

describe('describeTurnInFlight — one turn per session [security]', () => {
  test('an idle session may start a turn', () => {
    expect(describeTurnInFlight(new Map(), 'sess-1')).toBeNull();
  });

  test('a session with a live turn is refused', () => {
    const inFlight = new Map([['sess-1', {}]]);
    expect(describeTurnInFlight(inFlight, 'sess-1')).not.toBeNull();
  });

  test('the refusal tells the operator what to do instead', () => {
    // Without this the message is just "no" for something the UI let them do
    // (the composer does not yet block sending mid-turn — that is bead W02).
    const msg = describeTurnInFlight(new Map([['sess-1', {}]]), 'sess-1') ?? '';
    expect(msg).toContain('already has a turn running');
    expect(msg).toContain('stop it');
  });

  test("another session's live turn does not block this one", () => {
    // The guard is per-session, not global: two different sessions running at
    // once is normal and must stay allowed.
    const inFlight = new Map([['sess-other', {}]]);
    expect(describeTurnInFlight(inFlight, 'sess-1')).toBeNull();
  });

  test('a brand-new session id can never collide', () => {
    // `runOneTurn` uses `msg.sessionId ?? randomUUID()`, so a first turn is
    // keyed by a fresh UUID. Only a genuine resume can be rejected — the guard
    // must never refuse someone starting a new conversation.
    const inFlight = new Map([['sess-1', {}]]);
    expect(describeTurnInFlight(inFlight, crypto.randomUUID())).toBeNull();
  });

  test('the entry clears once the turn finishes', () => {
    // `runOneTurn`'s finally deletes the key; a session must be startable
    // again afterwards, or one turn would wedge it permanently.
    const inFlight = new Map<string, unknown>([['sess-1', {}]]);
    expect(describeTurnInFlight(inFlight, 'sess-1')).not.toBeNull();
    inFlight.delete('sess-1');
    expect(describeTurnInFlight(inFlight, 'sess-1')).toBeNull();
  });
});
