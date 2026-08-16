// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { MultiAgentMutationView, PendingAskUserQuestionView } from '@cebab/shared/protocol';
import type { MultiAgentRun } from '../store';
import { ActiveRunView } from './MultiAgentTab';
import { ReopenProvider } from './reopen/ReopenContext';

/**
 * Register U10 — a blocking decision must be above the scrollback.
 *
 * `.multi-agent` is `overflow-y: auto` and the event list is uncapped, so
 * anything rendered after the scrollback `<section>` is pushed off-screen by
 * however many events the run has produced. Four surfaces were: the
 * awaiting-continue banner, the pending-retry banner, the pause-on-dangerous
 * gate, and the AskUserQuestion card — i.e. every point where the bus stops and
 * waits for a human. The operator saw an apparently idle run and had to scroll
 * hundreds of rows to find out it was halted on a decision.
 *
 * This gate mounts the real `ActiveRunView` with a run that is holding all of
 * them at once and asserts DOM order against the event list. DOM order, not
 * CSS: it is what reading order AND tab order follow, and it is what a text
 * scan of the JSX could not honestly prove (the banners are behind three
 * different guards).
 *
 * It also pins the premise the focus-steal rests on — that the composer is
 * unmounted while a decision is pending — because that is the whole reason
 * stealing focus here is acceptable and stealing it for a toast is not.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // `consumeFocusOnce` keys on sessionStorage, so a steal only fires once per
  // banner id per tab. Clear it so each test starts from "never announced".
  sessionStorage.clear();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function mutation(over: Partial<MultiAgentMutationView> = {}): MultiAgentMutationView {
  return {
    id: 7,
    sessionId: 'bus-test',
    ts: 1_700_000_000_000,
    agentName: 'workerA',
    toolName: 'Bash',
    category: 'dangerous',
    summary: 'rm -rf build',
    filePath: null,
    cwd: null,
    confirmedAt: null,
    promoted: false,
    ...over,
  };
}

const QUESTION: PendingAskUserQuestionView = {
  agent: 'workerA',
  toolUseId: 'tu-1',
  questions: [
    {
      question: 'Which database should the migration target?',
      header: 'Database',
      options: [{ label: 'sqlite' }, { label: 'postgres' }],
      multiSelect: false,
    },
  ],
};

function buildRun(overrides: Partial<MultiAgentRun> = {}): MultiAgentRun {
  return {
    sessionId: 'bus-test',
    mode: 'orchestrator',
    participantAgentNames: ['orchestrator', 'workerA'],
    status: 'running',
    // Enough rows that "below the scrollback" is meaningfully below.
    events: Array.from({ length: 40 }, (_, i) => ({
      eventId: i + 1,
      ts: 1_700_000_000_000 + i,
      source: 'orchestrator',
      destination: 'workerA',
      kind: 'message' as const,
      text: `event ${i + 1}`,
    })),
    iterationId: null,
    lifecycle: 'persistent',
    sessionFolder: '/ws/.cebab/bus-test',
    awaitingContinue: false,
    activity: null,
    hopBudget: 30,
    pendingRetry: null,
    pauseOnDangerous: true,
    executeMode: false,
    mutations: [],
    pendingMutations: [],
    pendingQuestion: null,
    recoveryContext: null,
    routerDrops: [],
    participantControls: {},
    ...overrides,
  } as MultiAgentRun;
}

function render(run: MultiAgentRun): void {
  act(() => {
    root.render(
      // `ActiveRunView` reads the reopen flow's context for the swept-session
      // banner. Real provider, no-op sink — this test is about layout, and a
      // stubbed context would be one more thing that could drift.
      <ReopenProvider send={vi.fn()}>
        <ActiveRunView
          run={run}
          tabMode="orchestrator"
          projects={[]}
          onSendUserPrompt={vi.fn()}
          onContinue={vi.fn()}
          onSetLifecycle={vi.fn()}
          onAddParticipant={vi.fn()}
          onMuteParticipant={vi.fn()}
          onUnmuteParticipant={vi.fn()}
          onPauseParticipant={vi.fn()}
          onResumeParticipant={vi.fn()}
          onKickParticipant={vi.fn()}
          onRetryWorker={vi.fn()}
          onAbandonSession={vi.fn()}
          onArchiveSession={vi.fn()}
          onContinueThroughMutation={vi.fn()}
          onAnswerQuestion={vi.fn()}
          onClearAutoRetry={vi.fn()}
        />
      </ReopenProvider>,
    );
  });
}

function required(selector: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`expected ${selector} to be rendered`);
  return el;
}

/** True when `a` comes before `b` in document order. */
function precedes(a: Node, b: Node): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

const BLOCKING: Array<{ label: string; selector: string; run: () => MultiAgentRun }> = [
  {
    label: 'pause-on-dangerous gate',
    selector: '#multi-agent-warning-mutation-bus-test-7',
    run: () => buildRun({ pendingMutations: [mutation()] }),
  },
  {
    label: 'pending-retry banner',
    selector: '#multi-agent-warning-retry-bus-test-12',
    run: () =>
      buildRun({
        pendingRetry: {
          agentName: 'workerA',
          reason: 'process exited 1',
          lastPrompt: 'do the thing',
          ts: 1_700_000_000_000,
          errorEventId: 12,
        },
      }),
  },
  {
    label: 'awaiting-continue banner',
    selector: '#multi-agent-warning-awaiting-bus-test',
    run: () => buildRun({ awaitingContinue: true }),
  },
  {
    label: 'AskUserQuestion card',
    selector: '.ask-user-card',
    run: () => buildRun({ pendingQuestion: QUESTION }),
  },
];

describe('blocking decisions render above the scrollback', () => {
  test.each(BLOCKING.map((b) => [b.label, b] as const))('%s', (_label, blocking) => {
    render(blocking.run());
    const events = required('ol.event-list');
    // Guards against a vacuous pass: if the fixture stopped producing events
    // or the banner stopped mounting, `required` throws rather than the
    // ordering assertion passing over nothing.
    expect(events.children.length).toBe(40);
    expect(precedes(required(blocking.selector), events)).toBe(true);
  });

  test('all four at once, and the composer still last', () => {
    render(
      buildRun({
        awaitingContinue: true,
        pendingRetry: {
          agentName: 'workerA',
          reason: 'process exited 1',
          lastPrompt: 'do the thing',
          ts: 1_700_000_000_000,
          errorEventId: 12,
        },
        pendingMutations: [mutation()],
        pendingQuestion: QUESTION,
      }),
    );
    const events = required('ol.event-list');
    for (const { selector } of BLOCKING) {
      expect(precedes(required(selector), events)).toBe(true);
    }
  });

  test('the composer is below the scrollback when nothing is pending', () => {
    render(buildRun());
    const events = required('ol.event-list');
    expect(precedes(events, required('.multi-agent-input-section'))).toBe(true);
  });
});

describe('a halted run steals focus once', () => {
  test.each([
    [
      'pause-on-dangerous gate',
      '#multi-agent-warning-mutation-bus-test-7',
      'Continue with this command',
    ],
    ['awaiting-continue banner', '#multi-agent-warning-awaiting-bus-test', 'Continue session'],
  ] as const)('%s focuses its primary action', (_label, selector, buttonLabel) => {
    vi.useFakeTimers();
    try {
      render(
        selector.includes('mutation')
          ? buildRun({ pendingMutations: [mutation()] })
          : buildRun({ awaitingContinue: true }),
      );
      // SessionBanner defers the focus one tick so it lands after the banner
      // is in the accessibility tree.
      act(() => {
        vi.advanceTimersByTime(1);
      });
      const banner = required(selector);
      const focused = document.activeElement as HTMLElement | null;
      expect(focused).not.toBeNull();
      expect(banner.contains(focused)).toBe(true);
      expect(focused?.textContent).toBe(buttonLabel);
    } finally {
      vi.useRealTimers();
    }
  });

  test('and does not steal it a second time for the same decision', () => {
    vi.useFakeTimers();
    try {
      const run = buildRun({ pendingMutations: [mutation()] });
      render(run);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      (document.activeElement as HTMLElement | null)?.blur();
      act(() => {
        root.render(<div />);
      });
      render(run);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(document.activeElement).toBe(document.body);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the composer is unmounted while a decision is pending', () => {
  // This is the premise the focus steal rests on: nothing the operator is
  // typing can be interrupted, because there is nowhere to type. If a future
  // change lets the composer coexist with a blocking banner, the steal
  // becomes rude and this test says so.
  test.each(BLOCKING.map((b) => [b.label, b] as const))('%s hides the composer', (_l, blocking) => {
    render(blocking.run());
    expect(container.querySelector('.multi-agent-input-section')).toBeNull();
  });
});
