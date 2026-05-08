import { describe, expect, test } from 'vitest';
import { activeSession, initialState, isSessionPending, reduce } from './store';

const PID = 1;

function open(state = initialState) {
  return reduce(state, { type: 'select_project', projectId: PID });
}

describe('store / pending → real-id migration', () => {
  test('user_send creates a pending session whose user message survives session_started', () => {
    let s = open();
    s = reduce(s, { type: 'user_send', text: 'hello' });

    const sess = activeSession(s)!;
    expect(sess).not.toBeNull();
    expect(isSessionPending(sess.id)).toBe(true);
    expect(sess.messages).toHaveLength(1);
    expect(sess.messages[0]).toMatchObject({ kind: 'user', text: 'hello' });

    // Server replies with a real session id. The optimistic user message
    // would be lost if the reducer treated session_started as a fresh bucket.
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_started',
        sessionId: 'real-1',
        projectId: PID,
        model: 'opus-4',
        tools: [],
      },
    });

    const after = activeSession(s)!;
    expect(after.id).toBe('real-1');
    expect(isSessionPending(after.id)).toBe(false);
    // user message preserved + new system/init message appended
    expect(after.messages.find((m) => m.kind === 'user')).toMatchObject({
      kind: 'user',
      text: 'hello',
    });
    expect(after.messages.some((m) => m.kind === 'system' && m.subtype === 'init')).toBe(true);

    // The pending bucket is gone (only the real id remains for this project).
    expect(Object.keys(s.sessionsByProject[PID]!)).toEqual(['real-1']);
  });
});

describe('store / session_history_start resets the target session', () => {
  test('replay clears prior messages and registers sessionId → projectId', () => {
    let s = open();
    // Pretend we already have some content for this session id from a live run.
    s = reduce(s, { type: 'user_send', text: 'first' });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_started',
        sessionId: 'sid-x',
        projectId: PID,
        model: 'opus-4',
        tools: [],
      },
    });
    expect(activeSession(s)!.messages.length).toBeGreaterThan(0);

    // history_start should reset the bucket for that session and route future
    // server messages back to project PID via sessionToProject.
    s = reduce(s, {
      type: 'server',
      msg: { type: 'session_history_start', projectId: PID, sessionId: 'sid-x' },
    });
    const after = activeSession(s)!;
    expect(after.id).toBe('sid-x');
    expect(after.messages).toEqual([]);
    expect(after.streamingText).toBe('');
    expect(s.sessionToProject['sid-x']).toBe(PID);
  });
});

describe('store / permission_decided', () => {
  test('flips matching card to decided; idempotent on duplicate dispatch', () => {
    let s = open();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_started',
        sessionId: 'sid-y',
        projectId: PID,
        model: 'opus-4',
        tools: [],
      },
    });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'permission_request',
        requestId: 'req-1',
        sessionId: 'sid-y',
        toolName: 'Bash',
        input: { cmd: 'ls' },
      },
    });

    // Optimistic dispatch on click.
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'permission_decided',
        sessionId: 'sid-y',
        requestId: 'req-1',
        decision: 'allow',
      },
    });

    const card = activeSession(s)!.messages.find(
      (m) => m.kind === 'permission_request' && m.requestId === 'req-1',
    );
    expect(card).toMatchObject({ kind: 'permission_request', decided: 'allow' });

    // Server echo arrives — must be a no-op, not a second flip.
    const before = s;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'permission_decided',
        sessionId: 'sid-y',
        requestId: 'req-1',
        decision: 'allow',
      },
    });
    const cardAfter = activeSession(s)!.messages.find(
      (m) => m.kind === 'permission_request' && m.requestId === 'req-1',
    );
    expect(cardAfter).toMatchObject({ kind: 'permission_request', decided: 'allow' });
    // Equality of message arrays is enough — same data, no second mutation.
    expect(activeSession(s)!.messages).toEqual(activeSession(before)!.messages);
  });

  test('decision for an unknown requestId leaves state unchanged', () => {
    let s = open();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_started',
        sessionId: 'sid-z',
        projectId: PID,
        model: 'opus-4',
        tools: [],
      },
    });
    const before = s;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'permission_decided',
        sessionId: 'sid-z',
        requestId: 'no-such-req',
        decision: 'deny',
      },
    });
    expect(activeSession(s)!.messages).toEqual(activeSession(before)!.messages);
  });
});
