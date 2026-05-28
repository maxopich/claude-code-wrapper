import { describe, expect, test } from 'vitest';
import type { IterationSummary } from '@cebab/shared/protocol';
import { initialState, reduce } from './store';

// Cluster D Phase 5 (spec §6.4): the `iteration_archived` ServerMsg
// arrives after the operator clicks the `archive` action on a
// `session_superseded` toast (App.tsx routes the NotificationAction
// through wsRef.send({type:'archive_session', sessionId}); the server's
// `executeArchiveSession` flips the row + replies). The reducer's job
// is to drop the row from the iterations cache so the IterationsList
// stops rendering it without a second `list_iterations` round-trip.

function iter(sessionId: string, overrides: Partial<IterationSummary> = {}): IterationSummary {
  return {
    sessionId,
    mode: 'orchestrator',
    status: 'crashed',
    startedAt: 1000,
    endedAt: 2000,
    iterationId: '001',
    artifactsDir: `/tmp/${sessionId}`,
    participantAgentNames: [],
    resumable: false,
    ...overrides,
  };
}

function withIterations(items: IterationSummary[]) {
  return reduce(initialState, {
    type: 'server',
    msg: { type: 'iterations', items },
  });
}

describe('store / iteration_archived', () => {
  test('drops the matching session from the iterations cache', () => {
    let s = withIterations([iter('keep-1'), iter('drop-this'), iter('keep-2')]);
    expect(s.multiAgent.iterations?.map((it) => it.sessionId)).toEqual([
      'keep-1',
      'drop-this',
      'keep-2',
    ]);

    s = reduce(s, {
      type: 'server',
      msg: { type: 'iteration_archived', sessionId: 'drop-this', removedArtifacts: false },
    });

    // Drop-this is gone; the other two are preserved in order.
    expect(s.multiAgent.iterations?.map((it) => it.sessionId)).toEqual(['keep-1', 'keep-2']);
  });

  test('removedArtifacts:true is ignored at the reducer level (just confirmation)', () => {
    // The flag is for operator confirmation only — the cache doesn't
    // surface disk state, so both true and false drop the row the same way.
    let s = withIterations([iter('wipe-me'), iter('survives')]);
    s = reduce(s, {
      type: 'server',
      msg: { type: 'iteration_archived', sessionId: 'wipe-me', removedArtifacts: true },
    });
    expect(s.multiAgent.iterations?.map((it) => it.sessionId)).toEqual(['survives']);
  });

  test('unknown sessionId is a no-op (identity-preserved state)', () => {
    // Defensive: if the server emits an iteration_archived for a row
    // the client never cached (race with list_iterations refresh), the
    // reducer should not synthesize an entry or change state.
    const s1 = withIterations([iter('a'), iter('b')]);
    const s2 = reduce(s1, {
      type: 'server',
      msg: { type: 'iteration_archived', sessionId: 'never-cached', removedArtifacts: false },
    });
    // Identity-preserve (same reference) — useReducer skips re-renders.
    expect(s2).toBe(s1);
    expect(s2.multiAgent.iterations?.map((it) => it.sessionId)).toEqual(['a', 'b']);
  });

  test('iterations cache uninitialized → no-op (no crash)', () => {
    // If the operator archives via a sticky toast before opening the
    // iterations panel, `state.multiAgent.iterations` is still null.
    // The reducer must not throw; nothing to drop.
    expect(initialState.multiAgent.iterations).toBeNull();
    const next = reduce(initialState, {
      type: 'server',
      msg: { type: 'iteration_archived', sessionId: 'some-id', removedArtifacts: false },
    });
    // Identity-preserve — no churn for a no-op.
    expect(next).toBe(initialState);
    expect(next.multiAgent.iterations).toBeNull();
  });

  test('repeat archive of the same id is idempotent (second is a no-op)', () => {
    let s = withIterations([iter('once'), iter('twice')]);
    s = reduce(s, {
      type: 'server',
      msg: { type: 'iteration_archived', sessionId: 'once', removedArtifacts: false },
    });
    expect(s.multiAgent.iterations?.map((it) => it.sessionId)).toEqual(['twice']);

    // Second archive — entry already dropped, should identity-preserve.
    const s2 = reduce(s, {
      type: 'server',
      msg: { type: 'iteration_archived', sessionId: 'once', removedArtifacts: true },
    });
    expect(s2).toBe(s);
  });

  test('does not perturb other multiAgent state (templates, active, draft)', () => {
    // Sanity check: the reducer touches only multiAgent.iterations.
    let s = withIterations([iter('drop'), iter('keep')]);
    const beforeTemplates = s.multiAgent.templates;
    const beforeActive = s.multiAgent.active;
    const beforeDraft = s.multiAgent.draftPrompt;

    s = reduce(s, {
      type: 'server',
      msg: { type: 'iteration_archived', sessionId: 'drop', removedArtifacts: false },
    });

    expect(s.multiAgent.templates).toBe(beforeTemplates);
    expect(s.multiAgent.active).toBe(beforeActive);
    expect(s.multiAgent.draftPrompt).toBe(beforeDraft);
  });
});
