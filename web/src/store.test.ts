import { describe, expect, test } from 'vitest';
import {
  activeSession,
  eventDefaultCollapsed,
  initialState,
  isSessionPending,
  reduce,
  trustChipState,
} from './store';
import type { MultiAgentEventView, MultiAgentRun } from './store';

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

  test('ma_set_view flips between the three main views', () => {
    let s = initialState;
    expect(s.multiAgent.view).toBe('chat');
    s = reduce(s, { type: 'ma_set_view', view: 'multi-agent' });
    expect(s.multiAgent.view).toBe('multi-agent');
    s = reduce(s, { type: 'ma_set_view', view: 'chained-chat' });
    expect(s.multiAgent.view).toBe('chained-chat');
    s = reduce(s, { type: 'ma_set_view', view: 'chat' });
    expect(s.multiAgent.view).toBe('chat');
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

  // Cluster G Phase 4 (D6/D11): lastBusInstallAt drives the
  // BusInstalledBadge 30s highlight. Spec §4.4 anti-pattern guard:
  // the badge MUST NOT appear unless an audit row exists; we enforce
  // structurally by only recording on `bus_integration_changed { installed:
  // true }`, which the server only emits after the bus trust gate
  // has dual-written `bus.trust_decided` + the projects column.
  test('bus_integration_changed { installed: true } records lastBusInstallAt', () => {
    let s = seedWithThreeProjects();
    expect(s.lastBusInstallAt).toEqual({});
    const before = Date.now();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'bus_integration_changed',
        projectId: 1,
        installed: true,
        agentName: 'alpha',
      },
    });
    const after = Date.now();
    expect(s.lastBusInstallAt[1]).toBeGreaterThanOrEqual(before);
    expect(s.lastBusInstallAt[1]).toBeLessThanOrEqual(after);
  });

  test('bus_integration_changed { installed: false } clears the timestamp', () => {
    let s = seedWithThreeProjects();
    // First install records the timestamp.
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'bus_integration_changed',
        projectId: 1,
        installed: true,
        agentName: 'alpha',
      },
    });
    expect(s.lastBusInstallAt[1]).toBeDefined();
    // Then uninstall removes it.
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'bus_integration_changed',
        projectId: 1,
        installed: false,
        agentName: null,
      },
    });
    expect(s.lastBusInstallAt[1]).toBeUndefined();
  });

  test('lastBusInstallAt is per-project (one install doesn\'t leak into siblings)', () => {
    let s = seedWithThreeProjects();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'bus_integration_changed',
        projectId: 2,
        installed: true,
        agentName: 'beta',
      },
    });
    expect(s.lastBusInstallAt[2]).toBeDefined();
    expect(s.lastBusInstallAt[1]).toBeUndefined();
    expect(s.lastBusInstallAt[3]).toBeUndefined();
  });

  test('ws_close clears lastBusInstallAt to prevent stale highlight on reconnect', () => {
    let s = seedWithThreeProjects();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'bus_integration_changed',
        projectId: 1,
        installed: true,
        agentName: 'alpha',
      },
    });
    expect(s.lastBusInstallAt[1]).toBeDefined();
    s = reduce(s, { type: 'ws_close' });
    expect(s.lastBusInstallAt).toEqual({});
  });
});

// Cluster E Phase 2.x — session_started aggregates participant models
// into MultiAgentRun.modelsByProject when:
//   - there's an active bus session
//   - the projectId belongs to a project whose busAgentName matches
//     one of the run's participantAgentNames
describe('store / session_started aggregates bus models (E2.x)', () => {
  function seedBusSession() {
    let s = initialState;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'projects',
        projects: [
          {
            id: 10,
            name: 'Orchestrator',
            path: '/ws/orchestrator',
            trusted: false,
            lastUsedAt: null,
            hasClaudeMd: true,
            busInstalled: true,
            busAgentName: 'orchestrator',
          },
          {
            id: 20,
            name: 'WorkerA',
            path: '/ws/worker-a',
            trusted: false,
            lastUsedAt: null,
            hasClaudeMd: true,
            busInstalled: true,
            busAgentName: 'worker-a',
          },
          {
            id: 30,
            name: 'NotParticipant',
            path: '/ws/notpart',
            trusted: false,
            lastUsedAt: null,
            hasClaudeMd: true,
            busInstalled: false,
            busAgentName: null,
          },
        ],
      },
    });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'multi_agent_started',
        sessionId: 'bus-1',
        mode: 'orchestrator',
        participants: [10, 20],
        participantAgentNames: ['orchestrator', 'worker-a'],
        lifecycle: 'persistent',
        sessionFolder: '/ws/.cebab/bus-1',
        hopBudget: 30,
        pauseOnMutation: false,
        mutationsAcknowledged: false,
        mutations: [],
      },
    });
    return s;
  }

  test('session_started for a participant project writes into modelsByProject', () => {
    let s = seedBusSession();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_started',
        sessionId: 'sa-orch',
        projectId: 10,
        model: 'claude-sonnet-4-5-20250929',
        tools: [],
      },
    });
    expect(s.multiAgent.active?.modelsByProject).toEqual({
      10: 'claude-sonnet-4-5-20250929',
    });
  });

  test('multiple participants aggregate into the map', () => {
    let s = seedBusSession();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_started',
        sessionId: 'sa-orch',
        projectId: 10,
        model: 'claude-sonnet-4-5-20250929',
        tools: [],
      },
    });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_started',
        sessionId: 'sa-worker',
        projectId: 20,
        model: 'claude-opus-4-1',
        tools: [],
      },
    });
    expect(s.multiAgent.active?.modelsByProject).toEqual({
      10: 'claude-sonnet-4-5-20250929',
      20: 'claude-opus-4-1',
    });
  });

  test('session_started for a non-participant project does not affect modelsByProject', () => {
    let s = seedBusSession();
    const before = s.multiAgent.active?.modelsByProject;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_started',
        sessionId: 'sa-other',
        projectId: 30,
        model: 'claude-haiku-4-5',
        tools: [],
      },
    });
    // Reference equality preserved when the bus state didn't need to change.
    expect(s.multiAgent.active?.modelsByProject).toBe(before);
    expect(s.multiAgent.active?.modelsByProject).toEqual({});
  });

  test('session_started without an active bus session is a no-op on modelsByProject', () => {
    // Set up projects + active SessionView but no bus run.
    let s = initialState;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'projects',
        projects: [
          {
            id: 10,
            name: 'Solo',
            path: '/ws/solo',
            trusted: false,
            lastUsedAt: null,
            hasClaudeMd: true,
            busInstalled: false,
            busAgentName: null,
          },
        ],
      },
    });
    expect(s.multiAgent.active).toBeNull();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_started',
        sessionId: 'sa-solo',
        projectId: 10,
        model: 'claude-sonnet-4-5',
        tools: [],
      },
    });
    // Single-agent SessionView captures the model.
    expect(s.sessionsByProject[10]?.['sa-solo']?.model).toBe('claude-sonnet-4-5');
    // No bus → no aggregation, active still null.
    expect(s.multiAgent.active).toBeNull();
  });

  test('re-emitting same model on a subsequent session_started is identity-preserving', () => {
    let s = seedBusSession();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_started',
        sessionId: 'sa-orch',
        projectId: 10,
        model: 'claude-sonnet-4-5-20250929',
        tools: [],
      },
    });
    const firstMap = s.multiAgent.active?.modelsByProject;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_started',
        sessionId: 'sa-orch-2',
        projectId: 10,
        model: 'claude-sonnet-4-5-20250929',
        tools: [],
      },
    });
    // Same value → skip the spread, identity preserved.
    expect(s.multiAgent.active?.modelsByProject).toBe(firstMap);
  });
});

describe('store / eventDefaultCollapsed', () => {
  function makeRun(mode: 'chain' | 'orchestrator'): MultiAgentRun {
    return {
      sessionId: 's1',
      mode,
      participantAgentNames: mode === 'orchestrator' ? ['orchestrator', 'beta'] : ['alpha', 'beta'],
      status: 'running',
      events: [],
      iterationId: null,
      lifecycle: 'persistent',
      sessionFolder: '/ws/.cebab/s1',
      awaitingContinue: false,
      activity: null,
      hopBudget: 30,
      pendingRetry: null,
      pauseOnMutation: false,
      mutationsAcknowledged: false,
      mutations: [],
      pendingMutation: null,
      recoveryContext: null,
      routerDrops: [],
      participantControls: {},
      modelsByProject: {},
    };
  }
  function ev(over: Partial<MultiAgentEventView>): MultiAgentEventView {
    return {
      eventId: 1,
      ts: 0,
      source: 'beta',
      destination: 'orchestrator',
      kind: 'reply',
      text: 'x',
      ...over,
    };
  }

  test('orchestrator mode: final answer to the user stays expanded', () => {
    const run = makeRun('orchestrator');
    expect(
      eventDefaultCollapsed(
        run,
        ev({ source: 'orchestrator', destination: 'user', kind: 'final' }),
      ),
    ).toBe(false);
  });

  test('orchestrator mode: worker → orchestrator reply collapses by default', () => {
    const run = makeRun('orchestrator');
    expect(
      eventDefaultCollapsed(
        run,
        ev({ source: 'beta', destination: 'orchestrator', kind: 'reply' }),
      ),
    ).toBe(true);
  });

  test('orchestrator mode: cebab briefing/intro collapses by default', () => {
    const run = makeRun('orchestrator');
    expect(
      eventDefaultCollapsed(
        run,
        ev({ source: 'cebab', destination: 'orchestrator', kind: 'intro' }),
      ),
    ).toBe(true);
  });

  test('orchestrator mode: error events are never auto-hidden', () => {
    const run = makeRun('orchestrator');
    expect(
      eventDefaultCollapsed(
        run,
        ev({ source: 'beta', destination: 'orchestrator', kind: 'error' }),
      ),
    ).toBe(false);
  });

  test('chain mode: plain hop bodies now collapse (kind-driven, not mode-driven)', () => {
    // Regression guard for the un-bury change: chain used to return false
    // unconditionally, leaving every verbose hop body open and burying the
    // spine. Plain hops now collapse the BODY (header/spine still shown).
    const run = makeRun('chain');
    expect(
      eventDefaultCollapsed(run, ev({ source: 'alpha', destination: 'beta', kind: 'reply' })),
    ).toBe(true);
    expect(
      eventDefaultCollapsed(run, ev({ source: 'cebab', destination: 'alpha', kind: 'intro' })),
    ).toBe(true);
  });

  test('final / error / →user stay expanded in BOTH modes', () => {
    for (const mode of ['chain', 'orchestrator'] as const) {
      const run = makeRun(mode);
      expect(eventDefaultCollapsed(run, ev({ kind: 'final' }))).toBe(false);
      expect(eventDefaultCollapsed(run, ev({ kind: 'error' }))).toBe(false);
      expect(eventDefaultCollapsed(run, ev({ destination: 'user', kind: 'reply' }))).toBe(false);
      // …and an ordinary intermediate hop collapses in both modes.
      expect(eventDefaultCollapsed(run, ev({ destination: 'beta', kind: 'prompt' }))).toBe(true);
    }
  });
});

describe('store / agent_activity (ephemeral liveness)', () => {
  function started() {
    return reduce(initialState, {
      type: 'server',
      msg: {
        type: 'multi_agent_started',
        sessionId: 'sess-A',
        mode: 'orchestrator',
        participants: [1, 2],
        participantAgentNames: ['orchestrator', 'coder'],
        lifecycle: 'persistent',
        sessionFolder: '/ws/.cebab/sess-A',
        hopBudget: 30,
        pauseOnMutation: false,
        mutationsAcknowledged: false,
        mutations: [],
      },
    });
  }
  function activity(
    over: Partial<{
      sessionId: string;
      agentName: string;
      phase: 'working' | 'stalled' | 'idle';
      currentTool?: string;
      lastActivityTs: number;
      turnStartedAt: number;
    }> = {},
  ) {
    return {
      type: 'agent_activity' as const,
      sessionId: 'sess-A',
      agentName: 'coder',
      phase: 'working' as 'working' | 'stalled' | 'idle',
      currentTool: 'Bash',
      lastActivityTs: 1000,
      turnStartedAt: 900,
      ...over,
    };
  }

  test('working sets active.activity; stalled replaces it', () => {
    let s = started();
    s = reduce(s, { type: 'server', msg: activity() });
    expect(s.multiAgent.active!.activity).toEqual({
      agentName: 'coder',
      phase: 'working',
      currentTool: 'Bash',
      lastActivityTs: 1000,
      turnStartedAt: 900,
    });
    s = reduce(s, {
      type: 'server',
      msg: activity({ phase: 'stalled', currentTool: 'Bash', lastActivityTs: 1000 }),
    });
    expect(s.multiAgent.active!.activity!.phase).toBe('stalled');
  });

  test('idle clears the activity to null', () => {
    let s = started();
    s = reduce(s, { type: 'server', msg: activity() });
    expect(s.multiAgent.active!.activity).not.toBeNull();
    s = reduce(s, { type: 'server', msg: activity({ phase: 'idle' }) });
    expect(s.multiAgent.active!.activity).toBeNull();
  });

  test('a mismatched sessionId is a no-op (stale tick from a prior run)', () => {
    let s = started();
    s = reduce(s, { type: 'server', msg: activity() });
    const before = s;
    s = reduce(s, { type: 'server', msg: activity({ sessionId: 'sess-OTHER', phase: 'idle' }) });
    expect(s).toBe(before); // same reference — short-circuited
    expect(s.multiAgent.active!.activity!.phase).toBe('working');
  });

  test('multi_agent_ended clears activity along with setting status', () => {
    let s = started();
    s = reduce(s, { type: 'server', msg: activity({ phase: 'stalled' }) });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'multi_agent_ended',
        sessionId: 'sess-A',
        reason: 'completed',
        iterationId: 'i1',
      },
    });
    expect(s.multiAgent.active!.status).toBe('completed');
    expect(s.multiAgent.active!.activity).toBeNull();
  });

  test('agent_activity with no active run is a no-op', () => {
    const s = reduce(initialState, { type: 'server', msg: activity() });
    expect(s.multiAgent.active).toBeNull();
  });
});

describe('store / hop budget', () => {
  test('multi_agent_started copies hopBudget into the active run', () => {
    const s = reduce(initialState, {
      type: 'server',
      msg: {
        type: 'multi_agent_started',
        sessionId: 's-budget',
        mode: 'orchestrator',
        participants: [1],
        participantAgentNames: ['orchestrator', 'coder'],
        lifecycle: 'persistent',
        sessionFolder: '/ws/.cebab/s-budget',
        hopBudget: 42,
        pauseOnMutation: false,
        mutationsAcknowledged: false,
        mutations: [],
      },
    });
    expect(s.multiAgent.active!.hopBudget).toBe(42);
  });

  test('settings reducer copies defaultHopBudget into SettingsView', () => {
    const s = reduce(initialState, {
      type: 'server',
      msg: {
        type: 'settings',
        workspaceRoot: '/ws',
        workspaceRootValid: true,
        defaultWorkspaceRoot: '/home/user/agents',
        defaultHopBudget: 50,
      },
    });
    expect(s.settings).toEqual({
      workspaceRoot: '/ws',
      workspaceRootValid: true,
      defaultWorkspaceRoot: '/home/user/agents',
      defaultHopBudget: 50,
    });
  });
});

// Item #4: pending-retry slot wiring. The reducer must (a) hydrate from
// `multi_agent_started.pendingRetry` on R-A/R-B attach, (b) set or clear via
// the `multi_agent_pending_retry` ServerMsg, (c) clear on session end so the
// banner doesn't linger on a stopped/crashed row, and (d) honor the
// optimistic `ma_clear_pending_retry` action with idempotent re-asserts.
describe('store / pending retry', () => {
  const baseStarted = {
    type: 'multi_agent_started' as const,
    sessionId: 's-pr',
    mode: 'orchestrator' as const,
    participants: [1],
    participantAgentNames: ['orchestrator', 'coder'],
    lifecycle: 'persistent' as const,
    sessionFolder: '/ws/.cebab/s-pr',
    hopBudget: 30,
    pauseOnMutation: false,
    mutationsAcknowledged: false,
    mutations: [],
  };

  test('multi_agent_started without pendingRetry → null (fresh start)', () => {
    const s = reduce(initialState, { type: 'server', msg: baseStarted });
    expect(s.multiAgent.active!.pendingRetry).toBeNull();
  });

  test('multi_agent_started with pendingRetry → hydrates the banner (R-A/R-B restore)', () => {
    const s = reduce(initialState, {
      type: 'server',
      msg: {
        ...baseStarted,
        pendingRetry: {
          agentName: 'coder',
          reason: "`coder`'s last turn failed: SDK result subtype=error_during_execution",
          lastPrompt: 'do the thing',
          ts: 1700000000000,
          errorEventId: 17,
        },
      },
    });
    expect(s.multiAgent.active!.pendingRetry).toMatchObject({
      agentName: 'coder',
      lastPrompt: 'do the thing',
      errorEventId: 17,
    });
  });

  test('multi_agent_pending_retry replaces the slot wholesale (set, then re-fail overwrites)', () => {
    let s = reduce(initialState, { type: 'server', msg: baseStarted });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'multi_agent_pending_retry',
        sessionId: 's-pr',
        pending: {
          agentName: 'coder',
          reason: 'first failure',
          lastPrompt: 'p1',
          ts: 1,
          errorEventId: 1,
        },
      },
    });
    expect(s.multiAgent.active!.pendingRetry!.reason).toBe('first failure');
    // Re-fail overwrites — never merges.
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'multi_agent_pending_retry',
        sessionId: 's-pr',
        pending: {
          agentName: 'coder',
          reason: 'retry failed too',
          lastPrompt: 'p1',
          ts: 2,
          errorEventId: 2,
        },
      },
    });
    expect(s.multiAgent.active!.pendingRetry!.reason).toBe('retry failed too');
    expect(s.multiAgent.active!.pendingRetry!.errorEventId).toBe(2);
  });

  test('multi_agent_pending_retry with pending=null clears the slot', () => {
    let s = reduce(initialState, {
      type: 'server',
      msg: {
        ...baseStarted,
        pendingRetry: {
          agentName: 'coder',
          reason: 'first',
          lastPrompt: 'p',
          ts: 1,
          errorEventId: 1,
        },
      },
    });
    s = reduce(s, {
      type: 'server',
      msg: { type: 'multi_agent_pending_retry', sessionId: 's-pr', pending: null },
    });
    expect(s.multiAgent.active!.pendingRetry).toBeNull();
  });

  test('multi_agent_ended also clears pendingRetry (no lingering banner on stopped/crashed)', () => {
    let s = reduce(initialState, {
      type: 'server',
      msg: {
        ...baseStarted,
        pendingRetry: {
          agentName: 'coder',
          reason: 'fail',
          lastPrompt: 'p',
          ts: 1,
          errorEventId: 1,
        },
      },
    });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'multi_agent_ended',
        sessionId: 's-pr',
        reason: 'stopped',
        iterationId: null,
      },
    });
    expect(s.multiAgent.active!.pendingRetry).toBeNull();
    expect(s.multiAgent.active!.status).toBe('stopped');
  });

  test('ma_clear_pending_retry optimistically clears; missing slot is a no-op', () => {
    let s = reduce(initialState, {
      type: 'server',
      msg: {
        ...baseStarted,
        pendingRetry: {
          agentName: 'coder',
          reason: 'fail',
          lastPrompt: 'p',
          ts: 1,
          errorEventId: 1,
        },
      },
    });
    s = reduce(s, { type: 'ma_clear_pending_retry' });
    expect(s.multiAgent.active!.pendingRetry).toBeNull();
    // Idempotent: a second clear on an already-empty slot returns the same
    // state (no spurious renders / no thrown).
    const s2 = reduce(s, { type: 'ma_clear_pending_retry' });
    expect(s2).toBe(s);
  });
});

// Item #5: mutation visibility + pause-on-first-mutation reducer wiring.
// The protocol additions are:
//   - `multi_agent_started.{pauseOnMutation, mutationsAcknowledged, mutations,
//     pendingMutation?}` — initial state hydration on R-A/R-B attach.
//   - `multi_agent_mutation` — append-with-dedupe per session.
//   - `multi_agent_pending_mutation` — set/clear the pause slot wholesale.
//   - `ma_set_draft_pause_on_mutation` — setup-screen toggle.
//   - `ma_clear_pending_mutation` — optimistic Continue.
describe('store / pause-on-mutation + mutations', () => {
  const baseStarted = {
    type: 'multi_agent_started' as const,
    sessionId: 's-pom',
    mode: 'orchestrator' as const,
    participants: [1],
    participantAgentNames: ['orchestrator', 'coder'],
    lifecycle: 'persistent' as const,
    sessionFolder: '/ws/.cebab/s-pom',
    hopBudget: 30,
    pauseOnMutation: false,
    mutationsAcknowledged: false,
    mutations: [],
  };

  test('multi_agent_started hydrates pauseOnMutation + mutations array', () => {
    const s = reduce(initialState, {
      type: 'server',
      msg: {
        ...baseStarted,
        pauseOnMutation: true,
        mutationsAcknowledged: false,
        mutations: [
          {
            id: 1,
            sessionId: 's-pom',
            ts: 100,
            agentName: 'coder',
            toolName: 'Write',
            category: 'mutate' as const,
            summary: 'create /foo (1 B)',
            filePath: '/foo',
            cwd: '/tmp/coder',
            confirmedAt: null,
            promoted: false,
          },
        ],
      },
    });
    expect(s.multiAgent.active!.pauseOnMutation).toBe(true);
    expect(s.multiAgent.active!.mutations.length).toBe(1);
    expect(s.multiAgent.active!.pendingMutation).toBeNull();
  });

  test('multi_agent_started with pendingMutation hydrates the banner (R-A/R-B)', () => {
    const pending = {
      id: 7,
      sessionId: 's-pom',
      ts: 200,
      agentName: 'coder',
      toolName: 'Bash',
      category: 'dangerous' as const,
      summary: 'rm -rf node_modules',
      filePath: null,
      cwd: '/tmp/coder',
      confirmedAt: null,
      promoted: false,
    };
    const s = reduce(initialState, {
      type: 'server',
      msg: { ...baseStarted, pauseOnMutation: true, pendingMutation: pending },
    });
    expect(s.multiAgent.active!.pendingMutation).toEqual(pending);
  });

  test('multi_agent_mutation appends to the list, deduped by id', () => {
    let s = reduce(initialState, { type: 'server', msg: baseStarted });
    const m1 = {
      id: 1,
      sessionId: 's-pom',
      ts: 100,
      agentName: 'coder',
      toolName: 'Edit',
      category: 'mutate' as const,
      summary: 'replace 5 chars in /foo',
      filePath: '/foo',
      cwd: '/tmp/coder',
      confirmedAt: null,
      promoted: false,
    };
    s = reduce(s, {
      type: 'server',
      msg: { type: 'multi_agent_mutation', sessionId: 's-pom', mutation: m1 },
    });
    expect(s.multiAgent.active!.mutations).toEqual([m1]);
    // Re-send the same id — dedupe (a re-attach may replay the live + the
    // initial-batch ServerMsg, the reducer must not duplicate).
    const s2 = reduce(s, {
      type: 'server',
      msg: { type: 'multi_agent_mutation', sessionId: 's-pom', mutation: m1 },
    });
    expect(s2.multiAgent.active!.mutations.length).toBe(1);
  });

  test('multi_agent_pending_mutation sets and clears the slot wholesale', () => {
    let s = reduce(initialState, { type: 'server', msg: baseStarted });
    const pending = {
      id: 7,
      sessionId: 's-pom',
      ts: 200,
      agentName: 'coder',
      toolName: 'Write',
      category: 'mutate' as const,
      summary: 'create /foo',
      filePath: '/foo',
      cwd: '/tmp/coder',
      confirmedAt: null,
      promoted: false,
    };
    s = reduce(s, {
      type: 'server',
      msg: { type: 'multi_agent_pending_mutation', sessionId: 's-pom', pending },
    });
    expect(s.multiAgent.active!.pendingMutation).toEqual(pending);
    s = reduce(s, {
      type: 'server',
      msg: { type: 'multi_agent_pending_mutation', sessionId: 's-pom', pending: null },
    });
    expect(s.multiAgent.active!.pendingMutation).toBeNull();
  });

  test('ma_clear_pending_mutation optimistically clears + flips ack flag; idempotent', () => {
    const pending = {
      id: 7,
      sessionId: 's-pom',
      ts: 200,
      agentName: 'coder',
      toolName: 'Bash',
      category: 'dangerous' as const,
      summary: 'rm x',
      filePath: null,
      cwd: '/tmp/coder',
      confirmedAt: null,
      promoted: false,
    };
    let s = reduce(initialState, {
      type: 'server',
      msg: { ...baseStarted, pauseOnMutation: true, pendingMutation: pending },
    });
    expect(s.multiAgent.active!.pendingMutation).not.toBeNull();
    s = reduce(s, { type: 'ma_clear_pending_mutation' });
    expect(s.multiAgent.active!.pendingMutation).toBeNull();
    expect(s.multiAgent.active!.mutationsAcknowledged).toBe(true);
    // Idempotent: a second click with the slot already empty no-ops.
    const s2 = reduce(s, { type: 'ma_clear_pending_mutation' });
    expect(s2).toBe(s);
  });

  test('multi_agent_ended clears pendingMutation too (no lingering banner on stopped/crashed)', () => {
    const pending = {
      id: 7,
      sessionId: 's-pom',
      ts: 200,
      agentName: 'coder',
      toolName: 'Bash',
      category: 'dangerous' as const,
      summary: 'rm x',
      filePath: null,
      cwd: '/tmp/coder',
      confirmedAt: null,
      promoted: false,
    };
    let s = reduce(initialState, {
      type: 'server',
      msg: { ...baseStarted, pauseOnMutation: true, pendingMutation: pending },
    });
    s = reduce(s, {
      type: 'server',
      msg: { type: 'multi_agent_ended', sessionId: 's-pom', reason: 'stopped', iterationId: null },
    });
    expect(s.multiAgent.active!.pendingMutation).toBeNull();
  });

  test('ma_set_draft_pause_on_mutation toggles setup-screen state', () => {
    let s = reduce(initialState, { type: 'ma_set_draft_pause_on_mutation', value: true });
    expect(s.multiAgent.draftPauseOnMutation).toBe(true);
    s = reduce(s, { type: 'ma_set_draft_pause_on_mutation', value: false });
    expect(s.multiAgent.draftPauseOnMutation).toBe(false);
  });
});

describe('store / trustChipState (Item #6)', () => {
  test('trusted=true → trusted-all regardless of mode', () => {
    expect(trustChipState(true, 'default')).toBe('trusted-all');
    expect(trustChipState(true, 'acceptEdits')).toBe('trusted-all');
  });
  test('trusted=false + acceptEdits → untrusted-edits', () => {
    expect(trustChipState(false, 'acceptEdits')).toBe('untrusted-edits');
  });
  test('trusted=false + default → untrusted-ask', () => {
    expect(trustChipState(false, 'default')).toBe('untrusted-ask');
  });
  test('mirrors shouldAutoAllow truth table on the boundary cases', () => {
    // Operator-visible projection of permission.ts:26-33:
    //   trusted always auto-allows EVERYTHING → 'trusted-all'.
    //   untrusted + acceptEdits auto-allows ONLY file-edit tools → 'untrusted-edits'.
    //   untrusted + default auto-allows NOTHING → 'untrusted-ask'.
    const cases = [
      [true, 'default' as const, 'trusted-all'],
      [true, 'acceptEdits' as const, 'trusted-all'],
      [false, 'acceptEdits' as const, 'untrusted-edits'],
      [false, 'default' as const, 'untrusted-ask'],
    ] as const;
    for (const [trusted, mode, expected] of cases) {
      expect(trustChipState(trusted, mode)).toBe(expected);
    }
  });
});

// Item #7: recovery context wiring. The reducer must (a) hydrate from
// `multi_agent_started.recoveryContext` on R-A/R-B attach when present,
// (b) leave it null when the server doesn't send it (fresh start, or any
// non-awaiting-continue resume), (c) clear on `ma_clear_awaiting` (the
// optimistic Continue click — banner-bound lifetime), and (d) clear on
// session end.
describe('store / recoveryContext (Item #7)', () => {
  const baseStarted = {
    type: 'multi_agent_started' as const,
    sessionId: 's-rec',
    mode: 'orchestrator' as const,
    participants: [1],
    participantAgentNames: ['orchestrator', 'coder'],
    lifecycle: 'persistent' as const,
    sessionFolder: '/ws/.cebab/s-rec',
    hopBudget: 30,
    pauseOnMutation: false,
    mutationsAcknowledged: false,
    mutations: [],
  };

  test('multi_agent_started without recoveryContext → null', () => {
    const s = reduce(initialState, { type: 'server', msg: baseStarted });
    expect(s.multiAgent.active!.recoveryContext).toBeNull();
  });

  test('multi_agent_started with recoveryContext → hydrates the disclosure', () => {
    const s = reduce(initialState, {
      type: 'server',
      msg: {
        ...baseStarted,
        awaitingContinue: true,
        recoveryContext: {
          staleSinceTs: 1700000000500,
          reconstructedAtTs: 1700000001000,
          interruptedAgents: [
            { agentName: 'coder', lastEventTs: 1700000000500, lastCheckpointTs: 1700000000300 },
          ],
        },
      },
    });
    expect(s.multiAgent.active!.recoveryContext).toEqual({
      staleSinceTs: 1700000000500,
      reconstructedAtTs: 1700000001000,
      interruptedAgents: [
        { agentName: 'coder', lastEventTs: 1700000000500, lastCheckpointTs: 1700000000300 },
      ],
    });
  });

  test('ma_clear_awaiting zeroes recoveryContext alongside awaitingContinue', () => {
    let s = reduce(initialState, {
      type: 'server',
      msg: {
        ...baseStarted,
        awaitingContinue: true,
        recoveryContext: {
          staleSinceTs: 100,
          reconstructedAtTs: 200,
          interruptedAgents: [],
        },
      },
    });
    expect(s.multiAgent.active!.awaitingContinue).toBe(true);
    expect(s.multiAgent.active!.recoveryContext).not.toBeNull();

    s = reduce(s, { type: 'ma_clear_awaiting' });
    expect(s.multiAgent.active!.awaitingContinue).toBe(false);
    expect(s.multiAgent.active!.recoveryContext).toBeNull();
  });

  test('multi_agent_ended drops recoveryContext (stopped/crashed banners dont resurface)', () => {
    let s = reduce(initialState, {
      type: 'server',
      msg: {
        ...baseStarted,
        awaitingContinue: true,
        recoveryContext: {
          staleSinceTs: 100,
          reconstructedAtTs: 200,
          interruptedAgents: [{ agentName: 'coder', lastEventTs: 100, lastCheckpointTs: null }],
        },
      },
    });
    expect(s.multiAgent.active!.recoveryContext).not.toBeNull();
    s = reduce(s, {
      type: 'server',
      msg: { type: 'multi_agent_ended', sessionId: 's-rec', reason: 'stopped', iterationId: null },
    });
    expect(s.multiAgent.active!.recoveryContext).toBeNull();
  });
});

// Cluster B Phase 6d: router_drop envelopes accumulate onto
// MultiAgentRun.routerDrops for the activity-bar counter chip.
describe('store / router_drop accumulation (Phase 6d)', () => {
  const baseStarted = {
    type: 'multi_agent_started' as const,
    sessionId: 's-drop',
    mode: 'orchestrator' as const,
    participants: [1],
    participantAgentNames: ['orchestrator', 'workerA'],
    lifecycle: 'persistent' as const,
    sessionFolder: '/ws/.cebab/s-drop',
    hopBudget: 30,
    pauseOnMutation: false,
    mutationsAcknowledged: false,
    mutations: [],
  };

  test('multi_agent_started initializes routerDrops to empty', () => {
    const s = reduce(initialState, { type: 'server', msg: baseStarted });
    expect(s.multiAgent.active!.routerDrops).toEqual([]);
  });

  test('router_drop appends a RouterDropView with client receivedAt', () => {
    let s = reduce(initialState, { type: 'server', msg: baseStarted });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'router_drop',
        sessionId: 's-drop',
        reasonCode: 'forged_source',
        source: 'workerA',
        destination: 'cebab',
        kind: 'reply',
        auditRowId: 'audit-1',
      },
    });
    const drops = s.multiAgent.active!.routerDrops;
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({
      auditRowId: 'audit-1',
      reasonCode: 'forged_source',
      source: 'workerA',
      destination: 'cebab',
      kind: 'reply',
    });
    expect(typeof drops[0]!.receivedAt).toBe('number');
  });

  test('router_drop dedupes by auditRowId', () => {
    let s = reduce(initialState, { type: 'server', msg: baseStarted });
    const drop = {
      type: 'router_drop' as const,
      sessionId: 's-drop',
      reasonCode: 'worker_to_user' as const,
      source: 'workerA',
      destination: '_user',
      kind: 'reply',
      auditRowId: 'audit-dedupe',
    };
    s = reduce(s, { type: 'server', msg: drop });
    s = reduce(s, { type: 'server', msg: drop });
    expect(s.multiAgent.active!.routerDrops).toHaveLength(1);
  });

  test('router_drop with non-matching sessionId is ignored', () => {
    let s = reduce(initialState, { type: 'server', msg: baseStarted });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'router_drop',
        sessionId: 's-different',
        reasonCode: 'forged_source',
        source: 'workerA',
        destination: 'cebab',
        kind: 'reply',
        auditRowId: 'audit-stranger',
      },
    });
    expect(s.multiAgent.active!.routerDrops).toEqual([]);
  });

  test('router_drop is a no-op when there is no active run', () => {
    const before = reduce(initialState, { type: 'select_project', projectId: 1 });
    const after = reduce(before, {
      type: 'server',
      msg: {
        type: 'router_drop',
        sessionId: 'nonexistent',
        reasonCode: 'forged_source',
        source: 'a',
        destination: 'b',
        kind: 'reply',
        auditRowId: 'audit-orphan',
      },
    });
    expect(after).toBe(before);
  });
});

// ---- Cluster C Phase 4g1: per-participant control state reducer cases ----
//
// The three envelopes (`participant_mute_changed`, `participant_pause_changed`,
// `participant_kicked`) update an in-memory map keyed by projectId on the
// active MultiAgentRun. Tests cover:
//   - row creation on first echo
//   - subsequent echo overwrites the slice fields
//   - sessionId mismatch is ignored
//   - kick supersedes pause (pausedUntil cleared)
//   - resume clears pausedUntil without touching muted
//   - countControlledParticipants honors expired pause via `now` arg

describe('store / participant control reducer cases', () => {
  function seedRunningRun(): {
    state: ReturnType<typeof reduce>;
    sessionId: string;
  } {
    let s = open();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'multi_agent_started',
        sessionId: 'bus-1',
        mode: 'orchestrator',
        participants: [PID, 42, 9, 7],
        participantAgentNames: ['orchestrator', 'worker-a'],
        lifecycle: 'persistent',
        sessionFolder: '/tmp/.cebab/bus-1',
        hopBudget: 30,
        pauseOnMutation: false,
        mutationsAcknowledged: false,
        mutations: [],
      },
    });
    return { state: s, sessionId: 'bus-1' };
  }

  test('participant_mute_changed creates a control row for the projectId', () => {
    const { state, sessionId } = seedRunningRun();
    const after = reduce(state, {
      type: 'server',
      msg: {
        type: 'participant_mute_changed',
        sessionId,
        projectId: 42,
        muted: true,
        reasonCode: 'forensics',
        reasonText: 'pending operator review',
        actor: 'operator',
        ts: 1000,
      },
    });
    const ctrl = after.multiAgent.active?.participantControls[42];
    expect(ctrl).toBeDefined();
    expect(ctrl?.muted).toBe(true);
    expect(ctrl?.mutedReasonCode).toBe('forensics');
    expect(ctrl?.mutedReasonText).toBe('pending operator review');
    expect(ctrl?.pausedUntil).toBeNull();
    expect(ctrl?.kickedAt).toBeNull();
  });

  test('participant_mute_changed unmute leaves prior pause alone', () => {
    let s = seedRunningRun().state;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'participant_pause_changed',
        sessionId: 'bus-1',
        projectId: 42,
        pausedUntil: 5000,
        expiryAction: 'auto_resume',
        reasonCode: 'topology_repair',
        actor: 'operator',
        ts: 1000,
        queuedDeliveries: 0,
      },
    });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'participant_mute_changed',
        sessionId: 'bus-1',
        projectId: 42,
        muted: false,
        reasonCode: 'topology_repair',
        actor: 'operator',
        ts: 2000,
      },
    });
    const ctrl = s.multiAgent.active!.participantControls[42];
    expect(ctrl.muted).toBe(false);
    expect(ctrl.pausedUntil).toBe(5000);
  });

  test('participant_pause_changed populates pausedUntil + expiryAction + queuedDeliveries', () => {
    const { state, sessionId } = seedRunningRun();
    const after = reduce(state, {
      type: 'server',
      msg: {
        type: 'participant_pause_changed',
        sessionId,
        projectId: 7,
        pausedUntil: 10_000,
        expiryAction: 'auto_kick',
        reasonCode: 'forensics',
        reasonText: 'awaiting check',
        actor: 'operator',
        ts: 500,
        queuedDeliveries: 3,
      },
    });
    const ctrl = after.multiAgent.active!.participantControls[7];
    expect(ctrl.pausedUntil).toBe(10_000);
    expect(ctrl.pauseExpiryAction).toBe('auto_kick');
    expect(ctrl.queuedDeliveries).toBe(3);
    expect(ctrl.pauseReasonText).toBe('awaiting check');
  });

  test('participant_pause_changed resume clears pausedUntil', () => {
    let s = seedRunningRun().state;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'participant_pause_changed',
        sessionId: 'bus-1',
        projectId: 7,
        pausedUntil: 10_000,
        expiryAction: 'auto_resume',
        reasonCode: 'topology_repair',
        actor: 'operator',
        ts: 500,
        queuedDeliveries: 1,
      },
    });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'participant_pause_changed',
        sessionId: 'bus-1',
        projectId: 7,
        pausedUntil: null,
        expiryAction: null,
        reasonCode: 'topology_repair',
        actor: 'operator',
        ts: 800,
        queuedDeliveries: 0,
      },
    });
    expect(s.multiAgent.active!.participantControls[7].pausedUntil).toBeNull();
  });

  test('participant_kicked sets kickedAt and clears pausedUntil', () => {
    let s = seedRunningRun().state;
    // First pause, then kick.
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'participant_pause_changed',
        sessionId: 'bus-1',
        projectId: 9,
        pausedUntil: 5000,
        expiryAction: 'auto_kick',
        reasonCode: 'tool_misuse',
        actor: 'operator',
        ts: 500,
        queuedDeliveries: 0,
      },
    });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'participant_kicked',
        sessionId: 'bus-1',
        projectId: 9,
        mode: 'drain',
        reasonCode: 'tool_misuse',
        reasonText: 'leaked credential',
        actor: 'operator',
        ts: 2000,
      },
    });
    const ctrl = s.multiAgent.active!.participantControls[9];
    expect(ctrl.kickedAt).toBe(2000);
    expect(ctrl.kickMode).toBe('drain');
    expect(ctrl.pausedUntil).toBeNull();
    expect(ctrl.kickReasonText).toBe('leaked credential');
  });

  test('control envelope on a stale sessionId is ignored', () => {
    const { state } = seedRunningRun();
    const after = reduce(state, {
      type: 'server',
      msg: {
        type: 'participant_mute_changed',
        sessionId: 'some-other-session',
        projectId: 42,
        muted: true,
        reasonCode: 'forensics',
        actor: 'operator',
        ts: 1000,
      },
    });
    // Object identity preserved: no-op reducer
    expect(after).toBe(state);
  });
});

describe('store / countControlledParticipants', () => {
  test('returns 0 for null run and for an empty map', async () => {
    const { countControlledParticipants } = await import('./store');
    expect(countControlledParticipants(null)).toBe(0);
    let s = open();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'multi_agent_started',
        sessionId: 'bus-2',
        mode: 'chain',
        participants: [PID],
        participantAgentNames: ['a', 'b'],
        lifecycle: 'persistent',
        sessionFolder: '/tmp/.cebab/bus-2',
        hopBudget: 30,
        pauseOnMutation: false,
        mutationsAcknowledged: false,
        mutations: [],
      },
    });
    expect(countControlledParticipants(s.multiAgent.active)).toBe(0);
  });

  test('counts muted + paused-alive + kicked, ignores expired pause', async () => {
    const { countControlledParticipants } = await import('./store');
    const now = 10_000;
    let s = open();
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'multi_agent_started',
        sessionId: 'bus-3',
        mode: 'orchestrator',
        participants: [PID, 1, 2, 3, 4],
        participantAgentNames: ['orchestrator', 'a', 'b', 'c', 'd'],
        lifecycle: 'persistent',
        sessionFolder: '/tmp/.cebab/bus-3',
        hopBudget: 30,
        pauseOnMutation: false,
        mutationsAcknowledged: false,
        mutations: [],
      },
    });
    // 1 muted
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'participant_mute_changed',
        sessionId: 'bus-3',
        projectId: 1,
        muted: true,
        reasonCode: 'forensics',
        actor: 'operator',
        ts: 0,
      },
    });
    // 1 paused alive (future deadline)
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'participant_pause_changed',
        sessionId: 'bus-3',
        projectId: 2,
        pausedUntil: now + 1000,
        expiryAction: 'auto_resume',
        reasonCode: 'topology_repair',
        actor: 'operator',
        ts: 0,
        queuedDeliveries: 0,
      },
    });
    // 1 paused EXPIRED (deadline in the past wrt the test's now)
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'participant_pause_changed',
        sessionId: 'bus-3',
        projectId: 3,
        pausedUntil: now - 1000,
        expiryAction: 'auto_resume',
        reasonCode: 'topology_repair',
        actor: 'operator',
        ts: 0,
        queuedDeliveries: 0,
      },
    });
    // 1 kicked
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'participant_kicked',
        sessionId: 'bus-3',
        projectId: 4,
        mode: 'drain',
        reasonCode: 'tool_misuse',
        actor: 'operator',
        ts: 0,
      },
    });
    expect(countControlledParticipants(s.multiAgent.active, now)).toBe(3);
  });
});

// Cluster E Phase 3 (A4): settings reducer carries the new
// defaultWorkspaceRootSource field through to SettingsView when present;
// older server payloads (field absent) leave the SettingsView's field
// undefined rather than coercing to a default.
describe('store / settings reducer carries defaultWorkspaceRootSource (E3)', () => {
  test('forwards source=env when server sets it', () => {
    let s = initialState;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'settings',
        workspaceRoot: null,
        workspaceRootValid: true,
        defaultWorkspaceRoot: '/home/op/agents',
        defaultWorkspaceRootSource: 'env',
        defaultHopBudget: 30,
      },
    });
    expect(s.settings?.defaultWorkspaceRootSource).toBe('env');
  });

  test('forwards source=builtin when server sets it', () => {
    let s = initialState;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'settings',
        workspaceRoot: '/whatever',
        workspaceRootValid: true,
        defaultWorkspaceRoot: '/home/op/agents',
        defaultWorkspaceRootSource: 'builtin',
        defaultHopBudget: 30,
      },
    });
    expect(s.settings?.defaultWorkspaceRootSource).toBe('builtin');
  });

  test('older server omits the field → SettingsView leaves it undefined', () => {
    let s = initialState;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'settings',
        workspaceRoot: null,
        workspaceRootValid: true,
        defaultWorkspaceRoot: '/home/op/agents',
        // defaultWorkspaceRootSource intentionally omitted (Phase 2 server)
        defaultHopBudget: 30,
      },
    });
    expect(s.settings?.defaultWorkspaceRootSource).toBeUndefined();
  });
});

// Cluster F Phase D9 — draftHopBudget reducer cases:
//   - ma_apply_template populates draftHopBudget + tags source='template'
//     (when the template has a hopBudget) or null + null (when it doesn't)
//   - ma_set_draft_hop_budget(value) sets value + tags source='user'
//   - ma_set_draft_hop_budget(null) clears both
//   - Manual edits (lifecycle flip, reorder, dismiss_active) clear both
describe('store / draftHopBudget + source (F-D9)', () => {
  test('ma_apply_template with hopBudget sets value + source="template"', () => {
    let s = initialState;
    s = reduce(s, {
      type: 'ma_apply_template',
      template: {
        id: 't1',
        name: 'Twin',
        mode: 'orchestrator',
        lifecycle: 'persistent',
        participants: [],
        hopBudget: 42,
      },
    });
    expect(s.multiAgent.draftHopBudget).toBe(42);
    expect(s.multiAgent.draftHopBudgetSource).toBe('template');
  });

  test('ma_apply_template without hopBudget leaves both null', () => {
    let s = initialState;
    s = reduce(s, {
      type: 'ma_apply_template',
      template: {
        id: 't1',
        name: 'Twin',
        mode: 'orchestrator',
        lifecycle: 'persistent',
        participants: [],
      },
    });
    expect(s.multiAgent.draftHopBudget).toBeNull();
    expect(s.multiAgent.draftHopBudgetSource).toBeNull();
  });

  test('ma_set_draft_hop_budget(75) sets value + source="user"', () => {
    let s = initialState;
    s = reduce(s, { type: 'ma_set_draft_hop_budget', value: 75 });
    expect(s.multiAgent.draftHopBudget).toBe(75);
    expect(s.multiAgent.draftHopBudgetSource).toBe('user');
  });

  test('ma_set_draft_hop_budget(null) clears both value and source', () => {
    let s = initialState;
    s = reduce(s, { type: 'ma_set_draft_hop_budget', value: 75 });
    s = reduce(s, { type: 'ma_set_draft_hop_budget', value: null });
    expect(s.multiAgent.draftHopBudget).toBeNull();
    expect(s.multiAgent.draftHopBudgetSource).toBeNull();
  });

  test('user override after template populates flips source to "user"', () => {
    let s = initialState;
    s = reduce(s, {
      type: 'ma_apply_template',
      template: {
        id: 't1',
        name: 'Twin',
        mode: 'orchestrator',
        lifecycle: 'persistent',
        participants: [],
        hopBudget: 42,
      },
    });
    expect(s.multiAgent.draftHopBudgetSource).toBe('template');
    s = reduce(s, { type: 'ma_set_draft_hop_budget', value: 100 });
    expect(s.multiAgent.draftHopBudget).toBe(100);
    expect(s.multiAgent.draftHopBudgetSource).toBe('user');
  });
});

// Cluster F Phase A1a — settings reducer carries defaultMaxTurns.
// Same forward-compat pattern as defaultWorkspaceRootSource: when the
// server omits the field (older payloads), SettingsView leaves it
// undefined rather than coercing to a default. The F-A1b SettingsModal
// numeric input degrades to placeholder-only when undefined.
describe('store / settings reducer carries defaultMaxTurns (F-A1a)', () => {
  test('forwards defaultMaxTurns when server sets it', () => {
    let s = initialState;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'settings',
        workspaceRoot: null,
        workspaceRootValid: true,
        defaultWorkspaceRoot: '/home/op/agents',
        defaultHopBudget: 30,
        defaultMaxTurns: 75,
      },
    });
    expect(s.settings?.defaultMaxTurns).toBe(75);
  });

  test('older server omits defaultMaxTurns → SettingsView leaves it undefined', () => {
    let s = initialState;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'settings',
        workspaceRoot: null,
        workspaceRootValid: true,
        defaultWorkspaceRoot: '/home/op/agents',
        defaultHopBudget: 30,
        // defaultMaxTurns omitted
      },
    });
    expect(s.settings?.defaultMaxTurns).toBeUndefined();
  });

  test('subsequent settings update with a new defaultMaxTurns replaces the prior value', () => {
    let s = initialState;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'settings',
        workspaceRoot: null,
        workspaceRootValid: true,
        defaultWorkspaceRoot: '/home/op/agents',
        defaultHopBudget: 30,
        defaultMaxTurns: 50,
      },
    });
    expect(s.settings?.defaultMaxTurns).toBe(50);
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'settings',
        workspaceRoot: null,
        workspaceRootValid: true,
        defaultWorkspaceRoot: '/home/op/agents',
        defaultHopBudget: 30,
        defaultMaxTurns: 125,
      },
    });
    expect(s.settings?.defaultMaxTurns).toBe(125);
  });
});

// Cluster F Phase A1b — `result` reducer must persist numTurns + effectiveMaxTurns
// onto the message entry. These drive the TurnCounterChip (post-hoc 80% warn)
// and the MaxTurnsResultCard's Extend +N target computation.
describe('store / result reducer carries numTurns + effectiveMaxTurns (F-A1b)', () => {
  test('forwards both fields when present', () => {
    let s = open();
    s = reduce(s, { type: 'user_send', text: 'hi' });
    const pending = activeSession(s)!;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_started',
        sessionId: 'sess-1',
        projectId: PID,
        model: 'claude-sonnet-4-5',
        tools: [],
      },
    });
    // Migrate pending to real id by replaying the session_started above
    // — the test fixture is set up so the user_send message is preserved.
    void pending;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'result',
        sessionId: 'sess-1',
        subtype: 'error_max_turns',
        durationMs: 12345,
        totalCostUsd: 0.05,
        numTurns: 50,
        effectiveMaxTurns: 50,
      },
    });
    const sess = activeSession(s)!;
    const last = sess.messages[sess.messages.length - 1];
    expect(last).toBeDefined();
    if (!last || last.kind !== 'result') throw new Error('expected result kind');
    expect(last.subtype).toBe('error_max_turns');
    expect(last.numTurns).toBe(50);
    expect(last.effectiveMaxTurns).toBe(50);
  });

  test('omits fields gracefully when the server payload lacks them (older server)', () => {
    let s = open();
    s = reduce(s, { type: 'user_send', text: 'hi' });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_started',
        sessionId: 'sess-1',
        projectId: PID,
        model: 'claude-sonnet-4-5',
        tools: [],
      },
    });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'result',
        sessionId: 'sess-1',
        subtype: 'success',
        durationMs: 10,
        totalCostUsd: 0.001,
        // numTurns + effectiveMaxTurns absent
      },
    });
    const sess = activeSession(s)!;
    const last = sess.messages[sess.messages.length - 1];
    if (!last || last.kind !== 'result') throw new Error('expected result kind');
    expect(last.numTurns).toBeUndefined();
    expect(last.effectiveMaxTurns).toBeUndefined();
  });
});

// Cluster G Phase 2a (A3): settings reducer carries the mockMode field
// through to SettingsView. Mirror of the Cluster E Phase 3 + F-A1a
// patterns — strict pass-through, no defaulting, optional for
// forward-compat so pre-G1 server payloads leave the field undefined.
describe('store / settings reducer carries mockMode (G2a)', () => {
  test('forwards mockMode=true when server sets it', () => {
    let s = initialState;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'settings',
        workspaceRoot: null,
        workspaceRootValid: true,
        defaultWorkspaceRoot: '/home/op/agents',
        defaultHopBudget: 30,
        mockMode: true,
      },
    });
    expect(s.settings?.mockMode).toBe(true);
  });

  test('forwards mockMode=false when server sets it', () => {
    let s = initialState;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'settings',
        workspaceRoot: '/whatever',
        workspaceRootValid: true,
        defaultWorkspaceRoot: '/home/op/agents',
        defaultHopBudget: 30,
        mockMode: false,
      },
    });
    expect(s.settings?.mockMode).toBe(false);
  });

  test('older server omits mockMode → SettingsView leaves it undefined', () => {
    // The MockBadge mount predicate uses strict equality (=== true), so
    // undefined renders nothing rather than implying "not mock".
    let s = initialState;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'settings',
        workspaceRoot: null,
        workspaceRootValid: true,
        defaultWorkspaceRoot: '/home/op/agents',
        defaultHopBudget: 30,
        // mockMode intentionally omitted (pre-G1 server)
      },
    });
    expect(s.settings?.mockMode).toBeUndefined();
  });
});

// Cluster G Phase 2b (UI-A3): session_started reducer threads the
// per-session `mock` flag (server projects from sessions.mock column)
// into both SessionView and the synthetic knownSessions entry. The
// ChatHeader's MockBadge reads SessionView.mock; the ProjectList row
// reads SessionSummary.mock from knownSessions.
describe('store / session_started threads mock onto SessionView + knownSessions (G2b)', () => {
  test('mock=true populates SessionView.mock', () => {
    let s = initialState;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'projects',
        projects: [
          {
            id: 1,
            name: 'p',
            path: '/tmp/p',
            trusted: false,
            busInstalled: false,
            busAgentName: null,
            lastUsedAt: null,
            hasClaudeMd: false,
          },
        ],
      },
    });
    s = reduce(s, {
      type: 'server',
      msg: { type: 'project_opened', projectId: 1, sessions: [], runningSessionIds: [] },
    });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_started',
        sessionId: 'sess-mock',
        projectId: 1,
        model: 'claude-sonnet-4',
        tools: [],
        mock: true,
      },
    });
    const sv = s.sessionsByProject[1]?.['sess-mock'];
    expect(sv?.mock).toBe(true);
  });

  test('mock omitted (pre-G2 server payload) → SessionView.mock stays undefined', () => {
    let s = initialState;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'projects',
        projects: [
          {
            id: 1,
            name: 'p',
            path: '/tmp/p',
            trusted: false,
            busInstalled: false,
            busAgentName: null,
            lastUsedAt: null,
            hasClaudeMd: false,
          },
        ],
      },
    });
    s = reduce(s, {
      type: 'server',
      msg: { type: 'project_opened', projectId: 1, sessions: [], runningSessionIds: [] },
    });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_started',
        sessionId: 'sess-live',
        projectId: 1,
        model: 'claude-sonnet-4',
        tools: [],
        // mock field intentionally absent — old server, live runtime
      },
    });
    const sv = s.sessionsByProject[1]?.['sess-live'];
    expect(sv?.mock).toBeUndefined();
  });

  test('mock=true also stamps the synthesized knownSessions entry', () => {
    // When session_started fires for a session that ISN'T yet in
    // knownSessions (the common flow: pending session → real session id
    // → reducer synthesizes a SessionSummary), the synthesized entry
    // must also carry mock so the ProjectList row badge appears
    // immediately without a full open_project re-sync.
    let s = initialState;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'projects',
        projects: [
          {
            id: 1,
            name: 'p',
            path: '/tmp/p',
            trusted: false,
            busInstalled: false,
            busAgentName: null,
            lastUsedAt: null,
            hasClaudeMd: false,
          },
        ],
      },
    });
    s = reduce(s, {
      type: 'server',
      msg: { type: 'project_opened', projectId: 1, sessions: [], runningSessionIds: [] },
    });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'session_started',
        sessionId: 'sess-mock',
        projectId: 1,
        model: 'claude-sonnet-4',
        tools: [],
        mock: true,
      },
    });
    const known = s.knownSessions[1] ?? [];
    const entry = known.find((k) => k.id === 'sess-mock');
    expect(entry?.mock).toBe(true);
  });

  test('project_opened.sessions carries mock through to knownSessions', () => {
    // Server projects sessions.mock from the DB row into the wire
    // payload's SessionSummary.mock. The reducer's project_opened arm
    // replaces knownSessions[projectId] verbatim, so this round-trips
    // by definition — but the assertion locks in the contract.
    let s = initialState;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'projects',
        projects: [
          {
            id: 1,
            name: 'p',
            path: '/tmp/p',
            trusted: false,
            busInstalled: false,
            busAgentName: null,
            lastUsedAt: null,
            hasClaudeMd: false,
          },
        ],
      },
    });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'project_opened',
        projectId: 1,
        sessions: [
          { id: 'sess-a', title: null, createdAt: 1, lastEventAt: 2, totalCostUsd: 0, mock: true },
          { id: 'sess-b', title: null, createdAt: 3, lastEventAt: 4, totalCostUsd: 0 },
        ],
        runningSessionIds: [],
      },
    });
    const known = s.knownSessions[1] ?? [];
    expect(known.find((k) => k.id === 'sess-a')?.mock).toBe(true);
    expect(known.find((k) => k.id === 'sess-b')?.mock).toBeUndefined();
  });
});

// Cluster G Phase 2c (UI-A3): the bus analog of the single-agent
// session_started.mock projection. `multi_agent_started.mock` is optional
// on the wire (server omits when 0/missing) and the reducer threads strict
// equality into MultiAgentRun.mock so downstream mounts (TopRunBar +
// MultiAgentActivityBar) can gate `<MockBadge variant="inline" />` with
// `run.mock === true`.
describe('store / multi_agent_started.mock projection (Phase 2c)', () => {
  const baseStarted = {
    type: 'multi_agent_started' as const,
    sessionId: 'bus-m',
    mode: 'orchestrator' as const,
    participants: [1],
    participantAgentNames: ['orchestrator', 'workerA'],
    lifecycle: 'persistent' as const,
    sessionFolder: '/ws/.cebab/bus-m',
    hopBudget: 30,
    pauseOnMutation: false,
    mutationsAcknowledged: false,
    mutations: [],
  };

  test('multi_agent_started.mock=true → MultiAgentRun.mock=true', () => {
    const s = reduce(initialState, {
      type: 'server',
      msg: { ...baseStarted, mock: true },
    });
    expect(s.multiAgent.active?.mock).toBe(true);
  });

  test('multi_agent_started without mock → run.mock is undefined (live session, pre-G2c server)', () => {
    // Additive-optional contract: server omits the field on the wire for
    // live sessions and pre-G2c builds. Reducer spreads with omit so the
    // run state mirrors the wire, leaving `mock` literally absent (not
    // forced to false). Mount predicates use strict `=== true`, so
    // {undefined, false} both collapse to "no badge" — but keeping the
    // distinction lets a future "tri-state" UI (mock / live / unknown)
    // surface "unknown" without a protocol change.
    const s = reduce(initialState, {
      type: 'server',
      msg: baseStarted,
    });
    expect(s.multiAgent.active?.mock).toBeUndefined();
  });

  test('chain mode also threads mock=true (same projection rule)', () => {
    const s = reduce(initialState, {
      type: 'server',
      msg: { ...baseStarted, mode: 'chain' as const, sessionId: 'chain-m', mock: true },
    });
    expect(s.multiAgent.active?.mode).toBe('chain');
    expect(s.multiAgent.active?.mock).toBe(true);
  });

  test('multi_agent_started overwrites prior run posture (Start replaces the slice)', () => {
    // The reducer wholesale replaces multiAgent.active on each
    // multi_agent_started; this pins the "fresh start clears prior mock
    // posture" behavior — a live session opened after a mock session does
    // NOT inherit the badge from the prior run's residual state.
    let s = reduce(initialState, {
      type: 'server',
      msg: { ...baseStarted, mock: true },
    });
    expect(s.multiAgent.active?.mock).toBe(true);
    s = reduce(s, {
      type: 'server',
      msg: { ...baseStarted, sessionId: 'bus-live-after' /* no mock field */ },
    });
    expect(s.multiAgent.active?.sessionId).toBe('bus-live-after');
    expect(s.multiAgent.active?.mock).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cluster G Phase 3b (G1 UI): `active_runs` ServerMsg → `state.activeRuns`
// reducer slice. The dispatcher's contract is "full snapshot each time"; the
// reducer's contract is "wire shape becomes state shape verbatim, with the
// spread-omit pattern preserved so `'projectId' in row` returns false when
// the wire omitted it." These tests pin both contracts at the seam.
// ---------------------------------------------------------------------------

describe('store / active_runs reducer (Phase 3b)', () => {
  test('initial state has empty activeRuns (badge mount predicate uses .length > 0)', () => {
    expect(initialState.activeRuns).toEqual([]);
  });

  test('first snapshot replaces empty slice with verbatim run rows', () => {
    const s = reduce(initialState, {
      type: 'server',
      msg: {
        type: 'active_runs',
        runs: [
          {
            sessionId: 's-a',
            projectId: 1,
            projectName: 'reviewer',
            kind: 'single',
            startedAt: 1_700_000_000_000,
            elapsedMs: 3_000,
          },
        ],
      },
    });
    expect(s.activeRuns).toHaveLength(1);
    expect(s.activeRuns[0]).toEqual({
      sessionId: 's-a',
      projectId: 1,
      projectName: 'reviewer',
      kind: 'single',
      startedAt: 1_700_000_000_000,
      elapsedMs: 3_000,
    });
  });

  test('subsequent snapshot REPLACES (not merges) — no leftover rows from prior emit', () => {
    // The dispatcher emits a fresh snapshot on every change; merging
    // would leak terminated runs forever. Pin replacement.
    let s = reduce(initialState, {
      type: 'server',
      msg: {
        type: 'active_runs',
        runs: [
          {
            sessionId: 's-old',
            projectId: 1,
            kind: 'single',
            startedAt: 0,
            elapsedMs: 1_000,
          },
        ],
      },
    });
    expect(s.activeRuns.map((r) => r.sessionId)).toEqual(['s-old']);
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'active_runs',
        runs: [
          {
            sessionId: 's-new',
            projectId: 2,
            kind: 'bus-worker',
            startedAt: 100,
            elapsedMs: 50,
          },
        ],
      },
    });
    expect(s.activeRuns.map((r) => r.sessionId)).toEqual(['s-new']);
  });

  test('empty snapshot clears the slice (drain-to-zero is wire-driven, not state-derived)', () => {
    let s = reduce(initialState, {
      type: 'server',
      msg: {
        type: 'active_runs',
        runs: [
          {
            sessionId: 's-x',
            projectId: 1,
            kind: 'single',
            startedAt: 0,
            elapsedMs: 0,
          },
        ],
      },
    });
    expect(s.activeRuns).toHaveLength(1);
    s = reduce(s, { type: 'server', msg: { type: 'active_runs', runs: [] } });
    expect(s.activeRuns).toEqual([]);
  });

  test('spread-omit preserved — wire-absent fields stay absent in state (not `undefined`)', () => {
    // The dispatcher's `buildActiveRunsMsg` projects with
    // `...(x !== undefined ? { x } : {})`. If the reducer accidentally
    // re-introduces `projectId: undefined`, the dropdown's strict
    // `in`-checks break and a transient `(no project)` fallback flickers.
    const s = reduce(initialState, {
      type: 'server',
      msg: {
        type: 'active_runs',
        runs: [
          {
            sessionId: 's-orphan',
            kind: 'single',
            startedAt: 0,
            elapsedMs: 0,
            // projectId, projectName, activeAgentName, currentActivity
            // ALL omitted on the wire.
          },
        ],
      },
    });
    const row = s.activeRuns[0]!;
    expect('projectId' in row).toBe(false);
    expect('projectName' in row).toBe(false);
    expect('activeAgentName' in row).toBe(false);
    expect('currentActivity' in row).toBe(false);
  });

  test('all optional fields populate when wire carries them (bus-worker happy path)', () => {
    const s = reduce(initialState, {
      type: 'server',
      msg: {
        type: 'active_runs',
        runs: [
          {
            sessionId: 'bus-1',
            projectId: 7,
            projectName: 'planner',
            kind: 'bus-worker',
            startedAt: 1_700_000_000_000,
            elapsedMs: 1_500,
            activeAgentName: 'planner-1',
            currentActivity: 'Read(README.md)',
          },
        ],
      },
    });
    expect(s.activeRuns[0]).toEqual({
      sessionId: 'bus-1',
      projectId: 7,
      projectName: 'planner',
      kind: 'bus-worker',
      startedAt: 1_700_000_000_000,
      elapsedMs: 1_500,
      activeAgentName: 'planner-1',
      currentActivity: 'Read(README.md)',
    });
  });

  test('order preserved from wire (matches lifecycle Map iteration contract)', () => {
    const s = reduce(initialState, {
      type: 'server',
      msg: {
        type: 'active_runs',
        runs: [
          { sessionId: 'first', kind: 'single', startedAt: 1, elapsedMs: 10 },
          { sessionId: 'second', kind: 'bus-worker', startedAt: 2, elapsedMs: 20 },
          { sessionId: 'third', kind: 'orchestrator', startedAt: 3, elapsedMs: 30 },
        ],
      },
    });
    expect(s.activeRuns.map((r) => r.sessionId)).toEqual(['first', 'second', 'third']);
  });

  test('ws_close clears activeRuns alongside liveSessions (snapshot is per-connection)', () => {
    // The dispatcher emits a fresh snapshot on every WS attach (even
    // empty). On disconnect we drop the snapshot so a stale dropdown
    // doesn't pretend the runs are still alive in another tab.
    let s = reduce(initialState, { type: 'ws_open' });
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'active_runs',
        runs: [
          {
            sessionId: 's-live',
            projectId: 1,
            kind: 'single',
            startedAt: 0,
            elapsedMs: 0,
          },
        ],
      },
    });
    expect(s.activeRuns).toHaveLength(1);
    s = reduce(s, { type: 'ws_close' });
    expect(s.activeRuns).toEqual([]);
    expect(s.connected).toBe(false);
    expect(s.liveSessions).toEqual({});
  });
});
