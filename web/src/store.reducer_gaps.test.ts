import { describe, expect, test } from 'vitest';
import type { ServerMsg } from '@cebab/shared';

import { initialState, reduce } from './store';
import type { AppState } from './store';

/**
 * `Cebab-6fax.45` item 3 — ten reducer branches that carry a real decision and
 * had no test anywhere in `web/`.
 *
 * Found by enumerating every `case '<name>'` in `reduce`/`reduceServer` and
 * grepping each literal across the web test suite: a discriminated-union
 * action cannot be constructed in a test without its literal, so zero hits is
 * proof of zero coverage. Seven more names have no test either, and correctly
 * so — they are the deliberate no-op fall-through and carry no logic.
 *
 * EVERY GUARDED CASE ASSERTS REFERENTIAL IDENTITY, not field equality. A guard
 * that was deleted would rebuild an object with identical contents, so
 * `toEqual` would stay green over exactly the deletion these cases exist to
 * catch. `toBe` is the assertion that means "the reducer did not reach in".
 */

const SID = 'bus-1';

function bus(over: Record<string, unknown> = {}) {
  return {
    type: 'server' as const,
    msg: {
      type: 'multi_agent_started',
      sessionId: SID,
      mode: 'orchestrator',
      participants: [10, 20],
      participantAgentNames: ['orchestrator', 'worker-a'],
      lifecycle: 'persistent',
      sessionFolder: '/ws/.cebab/bus-1',
      hopBudget: 30,
      hopsUsed: 0,
      pauseOnDangerous: false,
      mutations: [],
      pendingMutations: [],
      participantControls: [],
      routerDrops: [],
      ...over,
    } as ServerMsg,
  };
}

function run(state: AppState) {
  const active = state.multiAgent.active;
  if (!active) throw new Error('no active bus run');
  return active;
}

describe('ma_dismiss_active refuses to drop a live run', () => {
  test('a running session survives the dismiss', () => {
    const s = reduce(initialState, bus());
    expect(run(s).status).toBe('running');
    const after = reduce(s, { type: 'ma_dismiss_active' });
    // Identity: the guard returns `state`, so nothing below it ran.
    expect(after).toBe(s);
  });

  test('and an ended one is dropped', () => {
    // The other direction — a guard that refused everything would pass the
    // case above and make the dismiss button dead.
    let s = reduce(initialState, bus());
    s = reduce(s, {
      type: 'server',
      msg: { type: 'multi_agent_ended', sessionId: SID, reason: 'stopped', iterationId: null },
    });
    const after = reduce(s, { type: 'ma_dismiss_active' });
    expect(after.multiAgent.active).toBeNull();
  });

  test('with no run at all it is a no-op rather than a throw', () => {
    expect(reduce(initialState, { type: 'ma_dismiss_active' })).toBe(initialState);
  });
});

describe('the managed-delete modal lifecycle', () => {
  test('open → started → close is a three-step sequence', () => {
    let s = reduce(initialState, { type: 'managed_delete_open', projectId: 7, name: 'agent-a' });
    expect(s.managedDelete).toMatchObject({
      projectId: 7,
      name: 'agent-a',
      status: 'confirming',
      result: null,
    });

    s = reduce(s, { type: 'managed_delete_started' });
    expect(s.managedDelete?.status).toBe('deleting');

    s = reduce(s, { type: 'managed_delete_close' });
    expect(s.managedDelete).toBeNull();
  });

  test('started with no modal open is a no-op', () => {
    // The null guard. Reachable if the operator closes the modal between the
    // click and the dispatch.
    expect(reduce(initialState, { type: 'managed_delete_started' })).toBe(initialState);
  });

  test('a result for a modal that was replaced is ignored', () => {
    // The late-answer guard: the operator closed this modal and opened one for
    // a different project before the server answered.
    const s = reduce(initialState, { type: 'managed_delete_open', projectId: 7, name: 'a' });
    const after = reduce(s, {
      type: 'server',
      msg: {
        type: 'managed_delete_result',
        projectId: 9,
        result: { ok: true, name: 'other', sessionsRemoved: 0 },
      },
    });
    expect(after).toBe(s);
  });

  test('and a result for the open modal lands', () => {
    const s = reduce(initialState, { type: 'managed_delete_open', projectId: 7, name: 'a' });
    const after = reduce(s, {
      type: 'server',
      msg: {
        type: 'managed_delete_result',
        projectId: 7,
        result: { ok: true, name: 'a', sessionsRemoved: 3 },
      },
    });
    expect(after.managedDelete?.status).toBe('done');
    expect(after.managedDelete?.result).toEqual({ ok: true, name: 'a', sessionsRemoved: 3 });
  });
});

describe('bus echoes are scoped to the run they name', () => {
  test('multi_agent_lifecycle_changed for another session is ignored', () => {
    const s = reduce(initialState, bus());
    const after = reduce(s, {
      type: 'server',
      msg: { type: 'multi_agent_lifecycle_changed', sessionId: 'other', lifecycle: 'temp' },
    });
    expect(after).toBe(s);
  });

  test('and for this one it lands', () => {
    const s = reduce(initialState, bus());
    const after = reduce(s, {
      type: 'server',
      msg: { type: 'multi_agent_lifecycle_changed', sessionId: SID, lifecycle: 'temp' },
    });
    expect(run(after).lifecycle).toBe('temp');
  });

  test('multi_agent_participant_added appends once and only once', () => {
    // Two guards in one branch: the session scope, and the idempotency check
    // its own comment says exists for a future resubscribe.
    let s = reduce(initialState, bus());
    const added = (sessionId: string, agentName: string) =>
      ({
        type: 'server',
        msg: {
          type: 'multi_agent_participant_added',
          sessionId,
          projectId: 30,
          agentName,
          busWasAlreadyInstalled: true,
        },
      }) as const;

    const foreign = reduce(s, added('other', 'worker-b'));
    expect(foreign).toBe(s);

    s = reduce(s, added(SID, 'worker-b'));
    expect(run(s).participantAgentNames).toEqual(['orchestrator', 'worker-a', 'worker-b']);

    // A replay of the same add must not double the roster.
    const replay = reduce(s, added(SID, 'worker-b'));
    expect(replay).toBe(s);
  });
});

describe('the small setters that carry a decision', () => {
  test('permission_mode_changed records the mode per session', () => {
    // Emitted TWICE on every `open_session` (two server sites), so the branch
    // must be idempotent in effect as well as harmless.
    const msg = {
      type: 'server',
      msg: { type: 'permission_mode_changed', sessionId: 's1', mode: 'acceptEdits' },
    } as const;
    let s = reduce(initialState, msg);
    expect(s.permissionModeBySession['s1']).toBe('acceptEdits');
    s = reduce(s, msg);
    expect(s.permissionModeBySession['s1']).toBe('acceptEdits');
    s = reduce(s, {
      type: 'server',
      msg: { type: 'permission_mode_changed', sessionId: 's1', mode: 'default' },
    });
    expect(s.permissionModeBySession['s1']).toBe('default');
  });

  test('ma_set_lifecycle dissociates the draft from its template', () => {
    // The part worth pinning is not the lifecycle field — it is the four
    // template associations the flip deliberately clears, because the next
    // Start is now an ad-hoc run with the operator's settings.
    let s = reduce(initialState, {
      type: 'ma_apply_template',
      template: {
        id: 't1',
        name: 'reviewers',
        mode: 'orchestrator',
        lifecycle: 'persistent',
        participants: [],
        roles: { '10': 'review security' },
        hopBudget: 12,
      },
    });
    expect(s.multiAgent.draftTemplateId).toBe('t1');
    expect(s.multiAgent.draftHopBudget).toBe(12);

    s = reduce(s, { type: 'ma_set_lifecycle', lifecycle: 'temp' });
    expect(s.multiAgent.draftLifecycle).toBe('temp');
    expect(s.multiAgent.draftTemplateId).toBeNull();
    expect(s.multiAgent.draftHopBudget).toBeNull();
    expect(s.multiAgent.draftHopBudgetSource).toBeNull();
    expect(s.multiAgent.draftRoles).toEqual({});
  });

  test('connection_lost_dismissed clears the overlay', () => {
    const s = reduce(initialState, {
      type: 'connection_lost',
      view: { reason: 'origin_not_allowed', diagnostic: { ts: 1 } },
    });
    expect(s.connectionLost).toBeDefined();
    expect(reduce(s, { type: 'connection_lost_dismissed' }).connectionLost).toBeUndefined();
  });
});
