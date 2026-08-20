import { describe, expect, test } from 'vitest';
import { initialState, reduce, type AppState } from './store';

/**
 * Cebab-ws0.2: the session's `mcpStatus` slice — the MCP servers that loaded
 * but did not report as connected.
 *
 * Four decisions live in the reducer and each gets a case, because three of
 * them are silent when wrong: an absent field must not be read as "all
 * healthy", an all-healthy init must CLEAR rather than leave a stale banner
 * standing, and a replayed init must not speak for the present at all.
 */

const PID = 1;

function open(projectId = PID, state: AppState = initialState): AppState {
  return reduce(state, { type: 'select_project', projectId });
}

function started(
  sessionId: string,
  mcpServers?: { name: string; status: string }[],
  projectId = PID,
) {
  return {
    type: 'server' as const,
    msg: {
      type: 'session_started' as const,
      sessionId,
      projectId,
      model: 'opus-4',
      tools: [],
      ...(mcpServers !== undefined && { mcpServers }),
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

function slice(s: AppState, sessionId: string, projectId = PID) {
  return s.sessionsByProject[projectId]?.[sessionId]?.mcpStatus;
}

describe('store / session_started captures the not-connected MCP servers', () => {
  test('a live init with an unhealthy server stamps it, and leaves the healthy ones out', () => {
    let s = open();
    s = reduce(
      s,
      started('sess-1', [
        { name: 'alpha', status: 'connected' },
        { name: 'bravo', status: 'needs-auth' },
      ]),
    );
    expect(slice(s, 'sess-1')).toEqual([{ name: 'bravo', status: 'needs-auth' }]);
  });

  test('a live init where everything connects CLEARS a slice an earlier one set', () => {
    // The resume case. Spread-omitting the key instead of deleting it passes
    // the test above and fails here: the operator fixes the server, resumes,
    // and is still told it is broken.
    let s = open();
    s = reduce(s, started('sess-1', [{ name: 'bravo', status: 'failed' }]));
    expect(slice(s, 'sess-1')).toHaveLength(1);

    s = reduce(s, started('sess-1', [{ name: 'bravo', status: 'connected' }]));
    expect(slice(s, 'sess-1')).toBeUndefined();
  });

  test('an init with no mcpServers field leaves the slice untouched', () => {
    // An older server payload measured nothing, so it may neither raise the
    // banner nor lower it. Treating undefined as an all-healthy report reddens
    // on the second assertion.
    let s = open();
    s = reduce(s, started('sess-1', [{ name: 'bravo', status: 'failed' }]));
    expect(slice(s, 'sess-1')).toHaveLength(1);

    s = reduce(s, started('sess-1'));
    expect(slice(s, 'sess-1')).toEqual([{ name: 'bravo', status: 'failed' }]);
  });

  test('a REPLAYED init does not stamp the slice', () => {
    // A persisted system/init replays as a session_started identical on the
    // wire to a live one (Register W08). It describes a startup that happened
    // some time ago, and the banner's whole value is being about now.
    let s = open();
    s = reduce(s, historyStart('old-1'));
    s = reduce(s, started('old-1', [{ name: 'bravo', status: 'failed' }]));
    s = reduce(s, historyEnd('old-1'));
    expect(slice(s, 'old-1')).toBeUndefined();
  });

  test('CONTROL: the same payload arriving live does stamp it', () => {
    // Without this, deleting the capture entirely would satisfy the case above.
    let s = open();
    s = reduce(s, started('old-1', [{ name: 'bravo', status: 'failed' }]));
    expect(slice(s, 'old-1')).toEqual([{ name: 'bravo', status: 'failed' }]);
  });

  test('replaying a session leaves no slice, and the next live init re-establishes it', () => {
    // `session_history_start` REBUILDS the session bucket from scratch — that
    // is its documented job, and every derived field goes with it. So a replay
    // does not merely fail to stamp `mcpStatus`, it drops whatever was there,
    // and the guard above then declines to speak for the replayed init.
    //
    // That is the right end state and it is worth pinning rather than
    // discovering: after a replay Cebab is not claiming anything about this
    // session's servers, in either direction. It is also not a hole the
    // operator falls into during normal use — `sessionSelectionRequests` only
    // asks for a replay when the conversation is NOT already hydrated, so
    // re-selecting the session you are watching does not wipe its banner.
    //
    // The second half is what makes the loss acceptable: the very next live
    // init says so again.
    let s = open();
    s = reduce(s, started('sess-1', [{ name: 'bravo', status: 'failed' }]));

    s = reduce(s, historyStart('sess-1'));
    s = reduce(s, started('sess-1', [{ name: 'bravo', status: 'failed' }]));
    s = reduce(s, historyEnd('sess-1'));
    expect(slice(s, 'sess-1')).toBeUndefined();

    s = reduce(s, started('sess-1', [{ name: 'bravo', status: 'failed' }]));
    expect(slice(s, 'sess-1')).toEqual([{ name: 'bravo', status: 'failed' }]);
  });
});
