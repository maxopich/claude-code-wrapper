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

describe('store / session_renamed', () => {
  function seedProjectWithSession(sessionId: string) {
    let s = open();
    // project_opened populates knownSessions with a real SessionSummary.
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'project_opened',
        projectId: PID,
        sessions: [
          {
            id: sessionId,
            title: null,
            createdAt: 1000,
            lastEventAt: 2000,
            totalCostUsd: 0.01,
          },
        ],
        runningSessionIds: [],
      },
    });
    return s;
  }

  test('sets a title on a known session', () => {
    let s = seedProjectWithSession('sid-r1');
    s = reduce(s, {
      type: 'server',
      msg: { type: 'session_renamed', sessionId: 'sid-r1', projectId: PID, title: 'Refactor WS' },
    });
    expect(s.knownSessions[PID]).toEqual([
      expect.objectContaining({ id: 'sid-r1', title: 'Refactor WS' }),
    ]);
  });

  test('clears the title when null is sent', () => {
    let s = seedProjectWithSession('sid-r2');
    s = reduce(s, {
      type: 'server',
      msg: { type: 'session_renamed', sessionId: 'sid-r2', projectId: PID, title: 'tmp' },
    });
    expect(s.knownSessions[PID]![0]!.title).toBe('tmp');
    s = reduce(s, {
      type: 'server',
      msg: { type: 'session_renamed', sessionId: 'sid-r2', projectId: PID, title: null },
    });
    expect(s.knownSessions[PID]![0]!.title).toBeNull();
  });

  test('rename for an unknown session id is a silent no-op', () => {
    const before = seedProjectWithSession('sid-r3');
    const after = reduce(before, {
      type: 'server',
      msg: { type: 'session_renamed', sessionId: 'no-such-sid', projectId: PID, title: 'x' },
    });
    expect(after).toEqual(before);
  });

  test('rename for an unknown projectId is a silent no-op', () => {
    const before = seedProjectWithSession('sid-r4');
    const after = reduce(before, {
      type: 'server',
      msg: { type: 'session_renamed', sessionId: 'sid-r4', projectId: 999, title: 'x' },
    });
    expect(after).toEqual(before);
  });
});

describe('store / projects refresh (workspace switch)', () => {
  /**
   * Simulates: user is in workspace A with project P=2 selected + a session
   * loaded. Server then emits a fresh `projects` ServerMsg for a different
   * workspace where P doesn't exist. The reducer should:
   *   - swap state.projects to the new list (core "list updates" behavior)
   *   - drop activeProjectId so the new sidebar doesn't claim a project is
   *     selected when none of the new ones match
   *   - drop the orphan session data so the chat pane doesn't keep showing
   *     the previously-active session from the gone-project
   */
  function seedActiveInWorkspaceA() {
    let s = open();
    // Pretend the server already told us about Workspace A's projects.
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'projects',
        projects: [
          {
            id: 1,
            name: 'Cebab',
            path: '/ws-a/Cebab',
            trusted: false,
            lastUsedAt: null,
            hasClaudeMd: true,
            busInstalled: false,
            busAgentName: null,
          },
          {
            id: 2,
            name: 'agentic',
            path: '/ws-a/agentic',
            trusted: false,
            lastUsedAt: null,
            hasClaudeMd: true,
            busInstalled: false,
            busAgentName: null,
          },
        ],
      },
    });
    s = reduce(s, { type: 'select_project', projectId: 1 });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_started',
        sessionId: 'sid-A',
        projectId: 1,
        model: 'opus-4',
        tools: [],
      },
    });
    return s;
  }

  test('projects swap replaces the list when the workspace changes', () => {
    let s = seedActiveInWorkspaceA();
    expect(s.projects.map((p) => p.name)).toEqual(['Cebab', 'agentic']);

    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'projects',
        projects: [
          {
            id: 11,
            name: 'Alpha',
            path: '/ws-b/Alpha',
            trusted: false,
            lastUsedAt: null,
            hasClaudeMd: true,
            busInstalled: false,
            busAgentName: null,
          },
          {
            id: 12,
            name: 'Beta',
            path: '/ws-b/Beta',
            trusted: false,
            lastUsedAt: null,
            hasClaudeMd: true,
            busInstalled: false,
            busAgentName: null,
          },
        ],
      },
    });

    expect(s.projects.map((p) => p.name)).toEqual(['Alpha', 'Beta']);
  });

  test('switching to a workspace where the active project is gone drops activeProjectId', () => {
    let s = seedActiveInWorkspaceA();
    expect(s.activeProjectId).toBe(1);
    expect(activeSession(s)).not.toBeNull();

    // New workspace has no project with id=1.
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'projects',
        projects: [
          {
            id: 11,
            name: 'Alpha',
            path: '/ws-b/Alpha',
            trusted: false,
            lastUsedAt: null,
            hasClaudeMd: true,
            busInstalled: false,
            busAgentName: null,
          },
        ],
      },
    });

    expect(s.activeProjectId).toBeNull();
    expect(activeSession(s)).toBeNull();
  });

  test('staying on the same workspace (active project still present) keeps activeProjectId', () => {
    let s = seedActiveInWorkspaceA();

    // Same workspace, just a refresh — project id=1 still exists.
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'projects',
        projects: [
          {
            id: 1,
            name: 'Cebab',
            path: '/ws-a/Cebab',
            trusted: true,
            lastUsedAt: 1000,
            hasClaudeMd: true,
            busInstalled: false,
            busAgentName: null,
          },
          {
            id: 2,
            name: 'agentic',
            path: '/ws-a/agentic',
            trusted: false,
            lastUsedAt: null,
            hasClaudeMd: true,
            busInstalled: false,
            busAgentName: null,
          },
          {
            id: 3,
            name: 'newcomer',
            path: '/ws-a/newcomer',
            trusted: false,
            lastUsedAt: null,
            hasClaudeMd: true,
            busInstalled: false,
            busAgentName: null,
          },
        ],
      },
    });

    expect(s.activeProjectId).toBe(1);
    expect(activeSession(s)).not.toBeNull();
    // The trust flag flipped server-side; verify it reflects.
    expect(s.projects.find((p) => p.id === 1)!.trusted).toBe(true);
  });
});

describe('store / multi-agent reducer (PR 2)', () => {
  // Helper: seed a state with three projects in the list so we can manipulate
  // multiAgent.draftParticipants meaningfully.
  function seedWithThreeProjects() {
    let s = initialState;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'projects',
        projects: [
          {
            id: 1,
            name: 'Alpha',
            path: '/ws/Alpha',
            trusted: false,
            lastUsedAt: null,
            hasClaudeMd: true,
            busInstalled: false,
            busAgentName: null,
          },
          {
            id: 2,
            name: 'Beta',
            path: '/ws/Beta',
            trusted: false,
            lastUsedAt: null,
            hasClaudeMd: true,
            busInstalled: true,
            busAgentName: 'beta',
          },
          {
            id: 3,
            name: 'Gamma',
            path: '/ws/Gamma',
            trusted: false,
            lastUsedAt: null,
            hasClaudeMd: true,
            busInstalled: false,
            busAgentName: null,
          },
        ],
      },
    });
    return s;
  }

  test('ma_set_view flips the active main view', () => {
    let s = initialState;
    expect(s.multiAgent.view).toBe('chat');
    s = reduce(s, { type: 'ma_set_view', view: 'multi-agent' });
    expect(s.multiAgent.view).toBe('multi-agent');
    s = reduce(s, { type: 'ma_set_view', view: 'chat' });
    expect(s.multiAgent.view).toBe('chat');
  });

  test('ma_set_mode flips between orchestrator and chain without touching participants', () => {
    let s = seedWithThreeProjects();
    s = reduce(s, { type: 'ma_add_participant', projectId: 1 });
    s = reduce(s, { type: 'ma_set_mode', mode: 'chain' });
    expect(s.multiAgent.mode).toBe('chain');
    expect(s.multiAgent.draftParticipants).toEqual([1]);
    s = reduce(s, { type: 'ma_set_mode', mode: 'orchestrator' });
    expect(s.multiAgent.mode).toBe('orchestrator');
    expect(s.multiAgent.draftParticipants).toEqual([1]);
  });

  test('ma_add_participant appends, deduplicates, and rejects unknown ids', () => {
    let s = seedWithThreeProjects();
    s = reduce(s, { type: 'ma_add_participant', projectId: 1 });
    s = reduce(s, { type: 'ma_add_participant', projectId: 2 });
    expect(s.multiAgent.draftParticipants).toEqual([1, 2]);

    // Drag-twice is a no-op (idempotent).
    const before = s;
    s = reduce(s, { type: 'ma_add_participant', projectId: 1 });
    expect(s).toBe(before); // same reference — `return state` short-circuit

    // Unknown id rejected without throwing — defends against stale drag payload.
    s = reduce(s, { type: 'ma_add_participant', projectId: 999 });
    expect(s.multiAgent.draftParticipants).toEqual([1, 2]);
  });

  test('ma_remove_participant removes only the targeted id and preserves order', () => {
    let s = seedWithThreeProjects();
    s = reduce(s, { type: 'ma_add_participant', projectId: 1 });
    s = reduce(s, { type: 'ma_add_participant', projectId: 2 });
    s = reduce(s, { type: 'ma_add_participant', projectId: 3 });
    s = reduce(s, { type: 'ma_remove_participant', projectId: 2 });
    expect(s.multiAgent.draftParticipants).toEqual([1, 3]);
  });

  test('ma_reorder_participant swaps with neighbour and is a no-op at boundaries', () => {
    let s = seedWithThreeProjects();
    s = reduce(s, { type: 'ma_add_participant', projectId: 1 });
    s = reduce(s, { type: 'ma_add_participant', projectId: 2 });
    s = reduce(s, { type: 'ma_add_participant', projectId: 3 });

    s = reduce(s, { type: 'ma_reorder_participant', projectId: 2, direction: 'up' });
    expect(s.multiAgent.draftParticipants).toEqual([2, 1, 3]);

    s = reduce(s, { type: 'ma_reorder_participant', projectId: 3, direction: 'down' });
    // Already at the bottom — no change.
    expect(s.multiAgent.draftParticipants).toEqual([2, 1, 3]);

    s = reduce(s, { type: 'ma_reorder_participant', projectId: 2, direction: 'up' });
    // Already at the top — no change.
    expect(s.multiAgent.draftParticipants).toEqual([2, 1, 3]);
  });

  test('workspace switch prunes draftParticipants of vanished projects', () => {
    let s = seedWithThreeProjects();
    s = reduce(s, { type: 'ma_add_participant', projectId: 1 });
    s = reduce(s, { type: 'ma_add_participant', projectId: 2 });
    s = reduce(s, { type: 'ma_add_participant', projectId: 3 });

    // New workspace: only id=2 survives.
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'projects',
        projects: [
          {
            id: 2,
            name: 'Beta',
            path: '/ws/Beta',
            trusted: false,
            lastUsedAt: null,
            hasClaudeMd: true,
            busInstalled: true,
            busAgentName: 'beta',
          },
        ],
      },
    });
    expect(s.multiAgent.draftParticipants).toEqual([2]);
  });

  test('bus_integration_changed updates the matching project in-place', () => {
    let s = seedWithThreeProjects();
    // Project 1 starts out un-installed.
    expect(s.projects.find((p) => p.id === 1)!.busInstalled).toBe(false);

    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'bus_integration_changed',
        projectId: 1,
        installed: true,
        agentName: 'alpha',
      },
    });
    expect(s.projects.find((p) => p.id === 1)!.busInstalled).toBe(true);
    expect(s.projects.find((p) => p.id === 1)!.busAgentName).toBe('alpha');

    // And the reverse — uninstall clears the agent name.
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'bus_integration_changed',
        projectId: 1,
        installed: false,
        agentName: null,
      },
    });
    expect(s.projects.find((p) => p.id === 1)!.busInstalled).toBe(false);
    expect(s.projects.find((p) => p.id === 1)!.busAgentName).toBeNull();
  });

  test('bus_integration_changed for an unknown projectId is a silent no-op', () => {
    const before = seedWithThreeProjects();
    const after = reduce(before, {
      type: 'server',
      msg: {
        type: 'bus_integration_changed',
        projectId: 999,
        installed: true,
        agentName: 'ghost',
      },
    });
    expect(after).toBe(before);
  });
});
