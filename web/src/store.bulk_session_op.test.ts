import { describe, expect, test } from 'vitest';
import type { SessionSummary } from '@cebab/shared/protocol';
import { initialState, reduce } from './store';

// Cluster I Phase C5 UI: the `bulk_session_op_result` ServerMsg arrives
// after the operator hits Archive/Delete in the sidebar's Select mode.
// The backend (#188) flipped `archived`/`deleted_at` for the succeeded
// ids; the reducer's job is to drop those rows from every per-project
// cache so the sidebar stops rendering them — without a second
// `project_opened` round-trip. Failed ids stay put (the toast reports
// them).

const PID = 1;
const PID2 = 2;

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    title: null,
    createdAt: 1000,
    lastEventAt: 2000,
    totalCostUsd: 0,
    ...overrides,
  };
}

/** Seed knownSessions + sessionToProject via project_opened, then optionally
 *  mark one session active via select_session. */
function withProject(pid: number, sessions: SessionSummary[], state = initialState) {
  return reduce(state, {
    type: 'server',
    msg: { type: 'project_opened', projectId: pid, sessions, runningSessionIds: [] },
  });
}

describe('store / bulk_session_op_result', () => {
  test('archive drops succeeded ids from knownSessions, preserves the rest in order', () => {
    let s = withProject(PID, [
      summary('keep-1'),
      summary('drop-a'),
      summary('keep-2'),
      summary('drop-b'),
    ]);
    expect(s.knownSessions[PID]?.map((x) => x.id)).toEqual([
      'keep-1',
      'drop-a',
      'keep-2',
      'drop-b',
    ]);

    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'bulk_session_op_result',
        op: 'archive',
        succeededSessionIds: ['drop-a', 'drop-b'],
        failed: [],
        removedArtifacts: false,
      },
    });

    expect(s.knownSessions[PID]?.map((x) => x.id)).toEqual(['keep-1', 'keep-2']);
  });

  test('delete drops succeeded ids the same way archive does', () => {
    let s = withProject(PID, [summary('a'), summary('b'), summary('c')]);
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'bulk_session_op_result',
        op: 'delete',
        succeededSessionIds: ['b'],
        failed: [],
        removedArtifacts: false,
      },
    });
    expect(s.knownSessions[PID]?.map((x) => x.id)).toEqual(['a', 'c']);
  });

  test('failed ids are NOT dropped — only succeeded ids vanish', () => {
    let s = withProject(PID, [summary('ok'), summary('still-running')]);
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'bulk_session_op_result',
        op: 'delete',
        succeededSessionIds: ['ok'],
        failed: [{ sessionId: 'still-running', reason: 'running', message: 'busy' }],
        removedArtifacts: false,
      },
    });
    // still-running stays in the list; ok is gone.
    expect(s.knownSessions[PID]?.map((x) => x.id)).toEqual(['still-running']);
  });

  test('drops sessionToProject routing entries for succeeded ids', () => {
    let s = withProject(PID, [summary('routed'), summary('keep')]);
    expect(s.sessionToProject['routed']).toBe(PID);

    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'bulk_session_op_result',
        op: 'archive',
        succeededSessionIds: ['routed'],
        failed: [],
        removedArtifacts: false,
      },
    });
    expect(s.sessionToProject['routed']).toBeUndefined();
    expect(s.sessionToProject['keep']).toBe(PID);
  });

  test('clears the active session pointer when the active session is dropped', () => {
    let s = withProject(PID, [summary('active-one'), summary('other')]);
    s = reduce(s, { type: 'select_session', projectId: PID, sessionId: 'active-one' });
    expect(s.activeSessionByProject[PID]).toBe('active-one');

    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'bulk_session_op_result',
        op: 'delete',
        succeededSessionIds: ['active-one'],
        failed: [],
        removedArtifacts: false,
      },
    });
    // Active pointer cleared so the chat pane doesn't render an orphan.
    expect(s.activeSessionByProject[PID]).toBeUndefined();
  });

  test('leaves the active pointer intact when a NON-active session is dropped', () => {
    let s = withProject(PID, [summary('active-one'), summary('bystander')]);
    s = reduce(s, { type: 'select_session', projectId: PID, sessionId: 'active-one' });

    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'bulk_session_op_result',
        op: 'archive',
        succeededSessionIds: ['bystander'],
        failed: [],
        removedArtifacts: false,
      },
    });
    expect(s.activeSessionByProject[PID]).toBe('active-one');
  });

  test('only touches the projects that owned the dropped sessions', () => {
    let s = withProject(PID, [summary('p1-a'), summary('p1-b')]);
    s = withProject(PID2, [summary('p2-a')], s);

    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'bulk_session_op_result',
        op: 'archive',
        succeededSessionIds: ['p1-a'],
        failed: [],
        removedArtifacts: false,
      },
    });

    expect(s.knownSessions[PID]?.map((x) => x.id)).toEqual(['p1-b']);
    // PID2 untouched.
    expect(s.knownSessions[PID2]?.map((x) => x.id)).toEqual(['p2-a']);
  });

  test('empty succeededSessionIds is a no-op (identity-preserved)', () => {
    const s1 = withProject(PID, [summary('a')]);
    const s2 = reduce(s1, {
      type: 'server',
      msg: {
        type: 'bulk_session_op_result',
        op: 'archive',
        succeededSessionIds: [],
        failed: [{ sessionId: 'x', reason: 'unknown', message: 'no such' }],
        removedArtifacts: false,
      },
    });
    expect(s2).toBe(s1);
  });

  test('succeeded id the client never cached is a harmless no-op', () => {
    const s1 = withProject(PID, [summary('a'), summary('b')]);
    const s2 = reduce(s1, {
      type: 'server',
      msg: {
        type: 'bulk_session_op_result',
        op: 'delete',
        succeededSessionIds: ['never-seen'],
        failed: [],
        removedArtifacts: false,
      },
    });
    // Nothing matched anywhere — identity-preserved.
    expect(s2).toBe(s1);
    expect(s2.knownSessions[PID]?.map((x) => x.id)).toEqual(['a', 'b']);
  });
});
