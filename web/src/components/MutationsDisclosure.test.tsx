// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { MultiAgentMutationView } from '@cebab/shared';
import { MutationsDisclosure, MultiAgentActivityBar } from './MultiAgentTab';
import type { MultiAgentRun } from '../store';

// Cebab-ygu.46: the mutation surfaces must not call a read-only, merely-
// UNANALYSABLE command (shell / process substitution) a "mutation". Both the
// Session-info disclosure and the activity-bar chip read the split from
// `summarizeMutationCounts`. R2/criterion 18: the red `has-dangerous` alarm is
// a SEPARATE signal derived from `category`, and it must survive the change.

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mut(over: Partial<MultiAgentMutationView> = {}): MultiAgentMutationView {
  return {
    id: 1,
    sessionId: 's1',
    ts: 1000,
    agentName: 'reviewer-perf',
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
    summary: 'wc -l $(find /subject/src -type f)',
    classifierReason: { rule: 'shell_substitution', detail: 'x', matched: '$(' },
    ...over,
  });

function makeRun(mutations: MultiAgentMutationView[]): MultiAgentRun {
  return {
    sessionId: 's1',
    mode: 'orchestrator',
    participantAgentNames: ['orchestrator', 'reviewer-perf'],
    status: 'running',
    events: [],
    iterationId: null,
    lifecycle: 'persistent',
    sessionFolder: '/ws/.cebab/s1',
    awaitingContinue: false,
    activity: {
      agentName: 'reviewer-perf',
      phase: 'working',
      lastActivityTs: 1000,
      turnStartedAt: 1000,
    },
    hopBudget: 30,
    hopsUsed: 0,
    pendingRetry: null,
    pauseOnDangerous: true,
    executeMode: false,
    mutations,
    pendingMutations: [],
    pendingQuestion: null,
    recoveryContext: null,
    routerDrops: [],
    participantControls: {},
    modelsByAgent: {},
  };
}

describe('MutationsDisclosure counts (Cebab-ygu.46)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function textOf(mutations: MultiAgentMutationView[]): string {
    act(() => root.render(<MutationsDisclosure run={makeRun(mutations)} />));
    return container.querySelector('.ma-mutations-toggle')?.textContent ?? '';
  }

  test('the reported case: one unanalysable listing reads "0 mutations · 1 unanalyzable command"', () => {
    const text = textOf([unanalyzable({ id: 1 })]);
    expect(text).toContain('0 mutations');
    expect(text).toContain('1 unanalyzable command');
    // Singular, not "1 unanalyzable commands".
    expect(text).not.toContain('1 unanalyzable commands');
    // It must NOT be announced as a mutation.
    expect(text).not.toContain('1 mutation ');
  });

  test('pluralises unanalyzable commands (n=2)', () => {
    const text = textOf([
      unanalyzable({ id: 1 }),
      unanalyzable({
        id: 2,
        classifierReason: { rule: 'process_substitution', detail: 'x', matched: '<(' },
      }),
    ]);
    expect(text).toContain('0 mutations');
    expect(text).toContain('2 unanalyzable commands');
  });

  test('singular "1 mutation" for exactly one genuinely-mutating row, no unanalyzable segment', () => {
    const text = textOf([mut({ id: 1, category: 'mutate' })]);
    expect(text).toContain('1 mutation');
    expect(text).not.toContain('unanalyzable');
  });

  test('a run with both classes shows both counts', () => {
    const text = textOf([mut({ id: 1, category: 'mutate' }), unanalyzable({ id: 2 })]);
    expect(text).toContain('1 mutation');
    expect(text).toContain('1 unanalyzable command');
  });

  test('the "contains dangerous" marker survives (category-derived, not count-derived)', () => {
    const text = textOf([unanalyzable({ id: 1 })]);
    expect(text).toContain('contains dangerous');
  });
});

describe('MultiAgentActivityBar chip preserves the red alarm (criterion 18 / R2)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const threeRow = [
    mut({ id: 1, category: 'mutate', summary: 'wrote plan' }),
    mut({
      id: 2,
      category: 'dangerous',
      summary: 'rm -rf /tmp/x',
      classifierReason: { rule: 'dangerous_first_token', detail: 'rm', matched: 'rm' },
    }),
    unanalyzable({ id: 3 }),
  ];

  test('the three-row fixture still applies has-dangerous and the (some dangerous) aria fragment', () => {
    act(() => root.render(<MultiAgentActivityBar run={makeRun(threeRow)} />));
    const chip = container.querySelector('.ma-mutations-chip');
    expect(chip).not.toBeNull();
    // R2: derived from category, so a mix of mutate + dangerous still flags red.
    expect(chip!.classList.contains('has-dangerous')).toBe(true);
    expect(chip!.getAttribute('aria-label')).toContain('(some dangerous)');
    // The partition still renders: 2 mutations, 1 unanalyzable command.
    const label = chip!.getAttribute('aria-label') ?? '';
    expect(label).toContain('2 mutations');
    expect(label).toContain('1 unanalyzable command');
  });

  test('an unanalysable-only run still flags dangerous (the safety alarm is not gated by the split)', () => {
    act(() => root.render(<MultiAgentActivityBar run={makeRun([unanalyzable({ id: 1 })])} />));
    const chip = container.querySelector('.ma-mutations-chip');
    expect(chip!.classList.contains('has-dangerous')).toBe(true);
    expect(chip!.getAttribute('aria-label')).toContain('0 mutations');
  });
});
