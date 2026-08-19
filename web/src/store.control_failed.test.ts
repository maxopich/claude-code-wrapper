import { describe, expect, test } from 'vitest';
import { initialState, reduce, type AppState } from './store';

/**
 * Register B21/B12/B19, client half.
 *
 * A refused per-agent control verb used to ship as
 * `wrapper_error { sessionId: <bus id>, kind: 'process_crashed' }`, and it
 * reached nobody. `notifyFromServerMsg` skips any `wrapper_error` carrying a
 * `sessionId` (it assumes the store renders a session banner), and the store
 * could not, because a bus session id is deliberately absent from
 * `sessionToProject` / `sessionsByProject`. The fallback resolved to
 * `activeProjectId`, found no session, and **invented one** flagged
 * `status: 'error'`.
 *
 * So refusing to mute the orchestrator — a guard-rail rejection the server
 * gets right — produced a phantom crashed chat session in whatever
 * single-agent project happened to be selected, and nothing at all in the
 * multi-agent UI.
 *
 * These tests pin both halves: the new envelope does the one job it has
 * (stop the spinner), and neither it nor a genuine bus-scoped `wrapper_error`
 * can fabricate a session again.
 */

const BUS_SESSION = 'bus-sess-1';

function seedBusRun(): AppState {
  let s = reduce(initialState, {
    type: 'server',
    msg: {
      type: 'projects',
      projects: [
        {
          id: 1,
          name: 'p',
          path: '/p',
          trusted: false,
          lastUsedAt: 0,
          hasClaudeMd: false,
          busInstalled: false,
          busAgentName: null,
          model: null,
        },
      ],
    },
  });
  s = reduce(s, { type: 'select_project', projectId: 1 });
  s = reduce(s, {
    type: 'server',
    msg: {
      type: 'multi_agent_started',
      sessionId: BUS_SESSION,
      mode: 'orchestrator',
      participants: [1, 2],
      participantAgentNames: ['orchestrator', 'worker-a'],
      lifecycle: 'persistent',
      sessionFolder: '/ws/.cebab/bus-sess-1',
      hopBudget: 30,
      pauseOnDangerous: false,
      mutations: [],
      pendingMutations: [],
    },
  });
  return s;
}

function controlFailed(sessionId: string) {
  return {
    type: 'participant_control_failed' as const,
    sessionId,
    projectId: 2,
    verb: 'mute' as const,
    failureCode: 'orchestrator_cannot_kick' as const,
    message: 'cannot mute the orchestrator — it would silently end the session',
    ts: 1_700_000_000_000,
  };
}

describe('store / participant_control_failed', () => {
  test('bumps failureSeq so a pending row spinner stops', () => {
    const s0 = seedBusRun();
    const s1 = reduce(s0, { type: 'server', msg: controlFailed(BUS_SESSION) });
    expect(s1.failureSeq).toBe(s0.failureSeq + 1);
  });

  test('[security] does NOT fabricate a chat session in the active project', () => {
    // The assertion that matters, and it only means something because the
    // OLD envelope genuinely did create one — see the wrapper_error suite
    // below, which shows the fabrication behaviour still exists for the
    // unguarded case.
    const s0 = seedBusRun();
    const s1 = reduce(s0, { type: 'server', msg: controlFailed(BUS_SESSION) });

    expect(s1.sessionsByProject[1] ?? {}).toEqual({});
    expect(s1.sessionToProject[BUS_SESSION]).toBeUndefined();
  });

  test('an envelope for a stale session is ignored entirely', () => {
    const s0 = seedBusRun();
    const s1 = reduce(s0, { type: 'server', msg: controlFailed('some-other-session') });
    expect(s1).toBe(s0);
  });

  test('with no active run at all it is a no-op', () => {
    const s0 = reduce(initialState, { type: 'select_project', projectId: 1 });
    const s1 = reduce(s0, { type: 'server', msg: controlFailed(BUS_SESSION) });
    expect(s1).toBe(s0);
  });
});

describe('store / wrapper_error scoped to the active bus session', () => {
  test('[security] does not invent a SessionView under the active project', () => {
    const s0 = seedBusRun();
    const s1 = reduce(s0, {
      type: 'server',
      msg: {
        type: 'wrapper_error',
        sessionId: BUS_SESSION,
        kind: 'process_crashed',
        message: 'the bus turn died',
      },
    });

    expect(s1.sessionsByProject[1] ?? {}).toEqual({});
    expect(s1.failureSeq).toBe(s0.failureSeq + 1);
  });

  test('a single-agent wrapper_error still lands in its session (positive control)', () => {
    // Without this, the guard above could be over-broad — swallowing every
    // wrapper_error and still passing.
    let s = seedBusRun();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_started',
        sessionId: 'sa-1',
        projectId: 1,
        model: 'opus-4',
        tools: [],
      },
    });
    const before = s;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'wrapper_error',
        sessionId: 'sa-1',
        kind: 'process_crashed',
        message: 'the turn died',
      },
    });

    expect(s.sessionsByProject[1]?.['sa-1']?.status).toBe('error');
    expect(s.failureSeq).toBe(before.failureSeq + 1);
  });

  test('an unknown non-bus sessionId still falls back to the active project', () => {
    // The guard is narrow on purpose: it only covers the ACTIVE bus session.
    // Anything else keeps the old fallback, which is register W16's territory
    // and deliberately untouched here.
    const s0 = seedBusRun();
    const s1 = reduce(s0, {
      type: 'server',
      msg: {
        type: 'wrapper_error',
        sessionId: 'who-knows',
        kind: 'process_crashed',
        message: 'orphan',
      },
    });
    expect(s1.sessionsByProject[1]?.['who-knows']?.status).toBe('error');
  });

  test('a bus-scoped auth_expired still raises the app-wide banner', () => {
    // The early return must not be able to swallow the auth slice.
    const s0 = seedBusRun();
    const s1 = reduce(s0, {
      type: 'server',
      msg: {
        type: 'wrapper_error',
        sessionId: BUS_SESSION,
        kind: 'auth_expired',
        message: 'OAuth expired',
      },
    });
    expect(s1.authExpired?.count).toBe(1);
    expect(s1.authExpired?.lastMessage).toBe('OAuth expired');
  });
});
