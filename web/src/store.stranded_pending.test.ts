/**
 * Cebab-so96: a pending bucket stranded by a disconnect must not be adopted by
 * the next unrelated turn.
 *
 * A `pending:*` bucket is a turn waiting for its `session_started`. The server
 * aborts and clears every `conn.inFlight` entry on `ws.on('close')`, and
 * nothing re-sends the message on reconnect, so after a drop that bucket's turn
 * is dead and its `session_started` will never arrive.
 *
 * Nothing drained it. #478 removed the only path that ever did (`new_session`),
 * deliberately — a turn already spawning still owns its bucket (Cebab-ygu.25) —
 * and `ws_close` did not touch the queue. Adoption is oldest-first, so the dead
 * head was handed to the next real session id: the operator's new prompt
 * disappeared into an orphan bucket, the answer streamed under the PREVIOUS
 * prompt, and the tab stayed one message behind for that project until a full
 * page reload. #479 then un-wedged the composer after exactly this event, so the
 * documented escape walked straight into it.
 *
 * Measured on the merged reducer before the fix: `S-real`'s user messages were
 * `['msg-A']` and `msg-B` was stranded in `pending:3`.
 */
import { describe, expect, test } from 'vitest';
import { initialState, reduce, type AppState } from './store';

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
  const messages = s.sessionsByProject[projectId]?.[sessionId]?.messages ?? [];
  return messages.filter((m) => m.kind === 'user').map((m) => (m as { text: string }).text);
}

const pendingQueue = (s: AppState, projectId = PID) => s.pendingByProject[projectId] ?? [];

describe('[web-store] a disconnect retires the pending queue (Cebab-so96)', () => {
  test("the next turn's session_started carries the next turn's message", () => {
    // The bead's failure scenario, action for action.
    let s: AppState = reduce(initialState, { type: 'select_project', projectId: PID });
    s = reduce(s, { type: 'user_send', text: 'msg-A' });
    const stranded = pendingQueue(s)[0];
    expect(stranded).toMatch(/^pending:/);

    s = reduce(s, { type: 'ws_close' });
    s = reduce(s, { type: 'ws_open' });
    s = reduce(s, { type: 'new_session', projectId: PID });
    s = reduce(s, { type: 'user_send', text: 'msg-B' });
    s = reduce(s, started('S-real'));

    // Before the fix: ['msg-A'].
    expect(userTexts(s, 'S-real')).toEqual(['msg-B']);
  });

  test('the disconnect empties the queue, so nothing is left to be adopted', () => {
    let s: AppState = reduce(initialState, { type: 'select_project', projectId: PID });
    s = reduce(s, { type: 'user_send', text: 'msg-A' });
    expect(pendingQueue(s)).toHaveLength(1);

    s = reduce(s, { type: 'ws_close' });
    expect(pendingQueue(s)).toHaveLength(0);
  });

  test('the operator still sees the message the drop stranded', () => {
    // The queue is cleared, not the bucket. Deleting it would blank the chat
    // they are looking at and destroy text they actually typed.
    let s: AppState = reduce(initialState, { type: 'select_project', projectId: PID });
    s = reduce(s, { type: 'user_send', text: 'msg-A' });
    const stranded = pendingQueue(s)[0];

    s = reduce(s, { type: 'ws_close' });

    expect(userTexts(s, stranded)).toEqual(['msg-A']);
    // Retired by `retireRunningSessions`, so the composer does not stay wedged
    // showing Stop for a turn the server already aborted (Cebab-ygu.26).
    expect(s.sessionsByProject[PID]?.[stranded]?.status).toBe('done');
  });

  test('no orphan bucket accumulates across repeated drops', () => {
    // Each stranded turn used to leak another un-adoptable bucket into the
    // queue, so the tab fell further behind with every drop.
    let s: AppState = reduce(initialState, { type: 'select_project', projectId: PID });
    for (let i = 0; i < 3; i++) {
      s = reduce(s, { type: 'new_session', projectId: PID });
      s = reduce(s, { type: 'user_send', text: `msg-${i}` });
      s = reduce(s, { type: 'ws_close' });
      s = reduce(s, { type: 'ws_open' });
    }
    expect(pendingQueue(s)).toHaveLength(0);

    s = reduce(s, { type: 'new_session', projectId: PID });
    s = reduce(s, { type: 'user_send', text: 'the live one' });
    s = reduce(s, started('S-live'));
    expect(userTexts(s, 'S-live')).toEqual(['the live one']);
  });

  test('CONTROL: two turns queued on ONE connection still adopt oldest-first', () => {
    // Cebab-ygu.25, which is why `new_session` must NOT clear the queue and why
    // the clear belongs on the disconnect instead. Deleting the queue anywhere
    // a turn is still legitimately spawning would reintroduce that defect, so
    // this case has to fail if the fix is applied in the wrong place.
    let s: AppState = reduce(initialState, { type: 'select_project', projectId: PID });
    s = reduce(s, { type: 'user_send', text: 'first' });
    s = reduce(s, { type: 'new_session', projectId: PID });
    s = reduce(s, { type: 'user_send', text: 'second' });
    expect(pendingQueue(s)).toHaveLength(2);

    s = reduce(s, started('S-first'));
    s = reduce(s, started('S-second'));

    expect(userTexts(s, 'S-first')).toEqual(['first']);
    expect(userTexts(s, 'S-second')).toEqual(['second']);
  });
});
