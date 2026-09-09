import { describe, expect, test } from 'vitest';
import type { MultiAgentMutationView, ServerMsg } from '@cebab/shared';

import { groupArtifacts } from './components/ArtifactsView';
import { initialState, reduce } from './store';
import type { AppState } from './store';

/**
 * `Cebab-6fax.45` items 1, 2 and 6 — three ways the bus wire and the reducer
 * disagreed about a message the server sends more than once.
 *
 * All three are about a re-emit: the same mutation id arriving with a
 * confirmation, the same `multi_agent_started` arriving on a re-attach, and a
 * session ending under banners that outlived it.
 */

const SID = 'bus-1';

function started(over: Partial<Extract<ServerMsg, { type: 'multi_agent_started' }>> = {}) {
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

function mut(over: Partial<MultiAgentMutationView> = {}): MultiAgentMutationView {
  return {
    id: 1,
    sessionId: SID,
    ts: 1000,
    agentName: 'worker-a',
    toolName: 'Write',
    category: 'mutate',
    summary: 'wrote a plan',
    filePath: '/ws/worker-a/plans/PLAN.md',
    cwd: '/ws/worker-a',
    confirmedAt: null,
    promoted: false,
    ...over,
  };
}

const mutation = (m: MultiAgentMutationView) =>
  ({ type: 'server', msg: { type: 'multi_agent_mutation', sessionId: SID, mutation: m } }) as const;

describe('multi_agent_mutation is keyed by id and REPLACES (item 1)', () => {
  test('the confirm re-emit lands, so confirmedAt and promoted reach the UI', () => {
    let s = reduce(initialState, started());
    s = reduce(s, mutation(mut()));
    expect(run(s).mutations).toHaveLength(1);
    // Pre-fix state of the world: the row is provisional and stays that way.
    expect(run(s).mutations[0]!.confirmedAt).toBeNull();

    // Same id, now confirmed + promoted — `onToolResultHook`'s re-emit.
    s = reduce(s, mutation(mut({ confirmedAt: 1200, promoted: true })));

    expect(run(s).mutations).toHaveLength(1);
    expect(run(s).mutations[0]!.confirmedAt).toBe(1200);
    expect(run(s).mutations[0]!.promoted).toBe(true);
  });

  test('and the Artifacts surface, which filters on confirmedAt, is no longer empty', () => {
    // The consequence that made this more than a field nobody read:
    // `groupArtifacts` skips `confirmedAt === null`, and the Artifacts
    // disclosure is gated on the group count, so the whole surface stayed
    // empty for the life of a live run.
    let s = reduce(initialState, started());
    s = reduce(s, mutation(mut()));
    expect(groupArtifacts(run(s).mutations)).toHaveLength(0);

    s = reduce(s, mutation(mut({ confirmedAt: 1200, promoted: true })));
    expect(groupArtifacts(run(s).mutations)).toHaveLength(1);
    expect(groupArtifacts(run(s).mutations)[0]!.filePath).toBe('/ws/worker-a/plans/PLAN.md');
  });

  test('a replacement keeps its position — the lane stays ts-ascending', () => {
    let s = reduce(initialState, started());
    s = reduce(s, mutation(mut({ id: 1, ts: 1000 })));
    s = reduce(s, mutation(mut({ id: 2, ts: 2000 })));
    s = reduce(s, mutation(mut({ id: 3, ts: 3000 })));
    // Confirm the MIDDLE row: an append-on-replace would move it to the end.
    s = reduce(s, mutation(mut({ id: 2, ts: 2000, confirmedAt: 2500 })));

    expect(run(s).mutations.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(run(s).mutations[1]!.confirmedAt).toBe(2500);
  });

  test('an unknown id still appends', () => {
    let s = reduce(initialState, started());
    s = reduce(s, mutation(mut({ id: 1 })));
    s = reduce(s, mutation(mut({ id: 2 })));
    expect(run(s).mutations.map((m) => m.id)).toEqual([1, 2]);
  });

  test('a mutation for another session is ignored', () => {
    let s = reduce(initialState, started());
    const before = s.multiAgent;
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'multi_agent_mutation',
        sessionId: 'other',
        mutation: mut({ sessionId: 'other' }),
      },
    });
    expect(s.multiAgent).toBe(before);
  });
});

describe('multi_agent_started only switches tabs for a session change (item 2)', () => {
  test('a re-attach of the run already showing leaves the operator where they are', () => {
    let s = reduce(initialState, started());
    // The operator navigates back to the single-agent chat.
    s = reduce(s, { type: 'ma_set_view', view: 'chat' });
    expect(s.multiAgent.view).toBe('chat');

    // WS reconnect: the server re-emits the identical start for R-A.
    s = reduce(s, started());
    expect(s.multiAgent.view).toBe('chat');
    expect(run(s).sessionId).toBe(SID);
  });

  test('but a genuinely new session still pulls the operator to its tab', () => {
    // The other direction, so the guard cannot pass by never switching.
    let s = reduce(initialState, started());
    s = reduce(s, { type: 'ma_set_view', view: 'chat' });
    s = reduce(s, started({ sessionId: 'bus-2' }));
    expect(s.multiAgent.view).toBe('multi-agent');
    expect(run(s).sessionId).toBe('bus-2');
  });

  test('a chain start lands on the chain tab', () => {
    const s = reduce(initialState, started({ sessionId: 'bus-3', mode: 'chain' }));
    expect(s.multiAgent.view).toBe('chained-chat');
  });
});

describe('multi_agent_ended retires every banner slot (item 6)', () => {
  const ended = {
    type: 'server',
    msg: { type: 'multi_agent_ended', sessionId: SID, reason: 'stopped', iterationId: null },
  } as const;

  test('awaitingContinue is cleared, so a stopped R-B session loses its dead Continue banner', () => {
    let s = reduce(initialState, started({ awaitingContinue: true }));
    expect(run(s).awaitingContinue).toBe(true);

    s = reduce(s, ended);
    expect(run(s).status).toBe('stopped');
    expect(run(s).awaitingContinue).toBe(false);
  });

  test('the auto-retry countdown is dropped rather than left ticking', () => {
    let s = reduce(initialState, started());
    s = reduce(s, {
      type: 'server',
      msg: {
        type: 'auto_retry',
        sessionId: SID,
        attempt: 2,
        maxAttempts: 5,
        backoffMs: 30_000,
        retryAt: 1_700_000_000_000,
        reason: 'transient_overload',
      },
    });
    expect(run(s).autoRetry).toBeDefined();

    s = reduce(s, ended);
    expect(run(s).autoRetry).toBeUndefined();
  });

  test('the slots it already retired stay retired', () => {
    // Guards the four this case handled before, so a future edit to the
    // destructure above cannot quietly drop one of them.
    let s = reduce(initialState, started({ pendingMutations: [mut({ id: 9 })] }));
    s = reduce(s, ended);
    const r = run(s);
    expect(r.pendingRetry).toBeNull();
    expect(r.pendingMutations).toEqual([]);
    expect(r.pendingQuestion).toBeNull();
    expect(r.recoveryContext).toBeNull();
    expect(r.activity).toBeNull();
  });
});
