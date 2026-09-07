import { describe, expect, it } from 'vitest';
import type { MultiAgentMutationView } from '@cebab/shared';

import { summarizeMutationCounts } from './store';

// Cebab-ygu.46: `summarizeMutationCounts` is the single source both mutation
// surfaces (the activity-bar chip and the Session-info disclosure) read from.
// It partitions rows into genuinely-mutating vs merely-unanalysable (shell /
// process substitution) — a shell-substitution verdict means "could not be
// analysed", not "mutates".

function mut(over: Partial<MultiAgentMutationView> = {}): MultiAgentMutationView {
  return {
    id: 1,
    sessionId: 's1',
    ts: 1000,
    agentName: 'worker',
    toolName: 'Bash',
    category: 'mutate',
    summary: 'did a thing',
    filePath: null,
    cwd: '/ws',
    confirmedAt: 1000,
    promoted: false,
    ...over,
  };
}

const unanalyzable = (over: Partial<MultiAgentMutationView> = {}) =>
  mut({
    category: 'dangerous',
    classifierReason: { rule: 'shell_substitution', detail: 'x', matched: '$(' },
    ...over,
  });

describe('summarizeMutationCounts (Cebab-ygu.46)', () => {
  it('empty run → all zero', () => {
    expect(summarizeMutationCounts([])).toEqual({ total: 0, mutations: 0, unanalyzable: 0 });
  });

  it('the reported case: one shell-substitution row is 0 mutations, 1 unanalyzable', () => {
    expect(summarizeMutationCounts([unanalyzable({ id: 1 })])).toEqual({
      total: 1,
      mutations: 0,
      unanalyzable: 1,
    });
  });

  it('partitions a mixed run and the two figures always sum to the row count', () => {
    const rows = [
      mut({ id: 1, category: 'mutate' }),
      mut({
        id: 2,
        category: 'dangerous',
        classifierReason: { rule: 'dangerous_first_token', detail: 'rm', matched: 'rm' },
      }),
      unanalyzable({ id: 3 }),
      unanalyzable({
        id: 4,
        classifierReason: { rule: 'process_substitution', detail: 'x', matched: '<(' },
      }),
    ];
    const c = summarizeMutationCounts(rows);
    expect(c).toEqual({ total: 4, mutations: 2, unanalyzable: 2 });
    expect(c.mutations + c.unanalyzable).toBe(c.total);
  });

  it('a dangerous row with a destructive rule counts as a mutation, not unanalyzable', () => {
    const rows = [
      mut({
        id: 1,
        category: 'dangerous',
        classifierReason: { rule: 'redirect_system_path', detail: 'x', matched: '/etc/x' },
      }),
    ];
    expect(summarizeMutationCounts(rows)).toEqual({ total: 1, mutations: 1, unanalyzable: 0 });
  });

  it('a dangerous row with NO reason (pre-022) counts as a mutation — absence makes no new claim', () => {
    const rows = [mut({ id: 1, category: 'dangerous' })];
    expect(summarizeMutationCounts(rows)).toEqual({ total: 1, mutations: 1, unanalyzable: 0 });
  });
});
