// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ServerMsg } from '@cebab/shared/protocol';
import type { MultiAgentRun } from '../store';
import { MultiAgentActivityBar, TopRunBar } from './MultiAgentTab';

// Cluster G Phase 2c (UI-A3): integration mount tests for the two
// multi-agent surfaces that get the `<MockBadge variant="inline" />` chip.
//
// What this file pins:
//   - TopRunBar mounts MockBadge iff `run.mock === true`.
//   - MultiAgentActivityBar mounts MockBadge iff `run.mock === true`.
//   - The strict-equality guard collapses `false` and `undefined` to "no
//     badge" — so a pre-G2c server (omits the field on the wire) and a live
//     session (omits the field too, additive-optional contract) both render
//     nothing.
//
// What this file does NOT pin:
//   - The badge's visual shape (handled by `MockBadge.test.tsx`'s
//     `variant="inline"` test in Phase 2b).
//   - The reducer's row→state projection (handled by `store.test.ts`'s
//     Phase 2c block).
//   - The server's row→wire projection (handled by
//     `multi_agent_started.mock.test.ts`).
//
// Uses createRoot + act (no @testing-library) per project convention
// (ConsultantModeChip.test.tsx, MockBadge.test.tsx).

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Minimal MultiAgentRun fixture. Fields are sized for the smallest payload
// each component will read (the chip cluster doesn't traverse most of the
// state); see the per-component overrides inside the tests.
function buildRun(overrides: Partial<MultiAgentRun> = {}): MultiAgentRun {
  return {
    sessionId: 'bus-test',
    mode: 'orchestrator',
    participantAgentNames: ['orchestrator', 'workerA'],
    status: 'running',
    events: [],
    iterationId: null,
    lifecycle: 'persistent',
    sessionFolder: '/ws/.cebab/bus-test',
    awaitingContinue: false,
    activity: null,
    hopBudget: 30,
    pendingRetry: null,
    pauseOnMutation: false,
    mutationsAcknowledged: false,
    mutations: [],
    pendingMutation: null,
    pendingQuestion: null,
    recoveryContext: null,
    routerDrops: [],
    participantControls: {},
    modelsByProject: {},
    ...overrides,
  };
}

describe('TopRunBar — MockBadge mount predicate', () => {
  let container: HTMLDivElement;
  let root: Root;
  // Stable stubs for TopRunBar's required callback props. None of these
  // fire in the tests below (we're asserting the badge mount, not the
  // Stop/Close behaviour). TS allows wider-domain (zero-arg) functions to
  // satisfy narrower parameter types, so we keep the stub bodies empty.
  const stubProps: {
    onStop: (id: string) => void;
    onDismiss: () => void;
    onLoadSessionLog: (id: string, o: number, l: number, r: boolean) => void;
    subscribeServerMsg: (cb: (msg: ServerMsg) => void) => () => void;
  } = {
    onStop: () => {},
    onDismiss: () => {},
    onLoadSessionLog: () => {},
    subscribeServerMsg: () => () => {},
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('run.mock === true → MockBadge mounts with variant="inline"', () => {
    const run = buildRun({ mock: true });
    act(() => root.render(<TopRunBar run={run} {...stubProps} />));
    const badge = container.querySelector('.mock-badge');
    expect(badge).not.toBeNull();
    // variant="inline" stamps the modifier class + data-testid (Phase 2b
    // variant contract). This is the same surface single-agent ChatHeader
    // uses — so the operator's eye trains to a consistent chip across both
    // single-agent and bus surfaces.
    expect(badge?.classList.contains('mock-badge-inline')).toBe(true);
    expect(badge?.getAttribute('data-testid')).toBe('mock-badge-inline');
  });

  test('run.mock undefined (pre-G2c server / live session) → no MockBadge', () => {
    const run = buildRun(); // no mock field
    act(() => root.render(<TopRunBar run={run} {...stubProps} />));
    expect(container.querySelector('.mock-badge')).toBeNull();
  });

  test('run.mock === false → no MockBadge (strict-equality guard)', () => {
    // Belt-and-suspenders against a future refactor that might force the
    // server to emit `mock: false` instead of omitting. Strict `=== true`
    // still collapses to "no badge", so the additive-optional contract
    // stays the same shape from the caller's perspective.
    const run = buildRun({ mock: false });
    act(() => root.render(<TopRunBar run={run} {...stubProps} />));
    expect(container.querySelector('.mock-badge')).toBeNull();
  });

  test('chain mode + mock=true also mounts MockBadge', () => {
    // The mount predicate is mode-agnostic — the same chip appears for
    // orchestrator and chain. Confirms no accidental coupling to
    // `run.mode === 'orchestrator'` (the ConsultantModeChip's gate).
    const run = buildRun({ mode: 'chain', mock: true });
    act(() => root.render(<TopRunBar run={run} {...stubProps} />));
    expect(container.querySelector('.mock-badge')).not.toBeNull();
  });
});

describe('MultiAgentActivityBar — MockBadge mount predicate', () => {
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

  // Populating `activity` is the simplest way past the activity bar's
  // early returns (the alternative is feeding `events` with a
  // non-sentinel destination so `activeAgent` returns non-null). Either
  // path lands on the same render branch where the chip cluster lives.
  function activeRun(overrides: Partial<MultiAgentRun> = {}): MultiAgentRun {
    return {
      ...buildRun({
        activity: {
          agentName: 'workerA',
          phase: 'working',
          lastActivityTs: Date.now(),
          turnStartedAt: Date.now() - 1000,
        },
      }),
      ...overrides,
    };
  }

  test('run.mock === true → MockBadge mounts in the activity bar', () => {
    const run = activeRun({ mock: true });
    act(() => root.render(<MultiAgentActivityBar run={run} />));
    const badge = container.querySelector('.mock-badge');
    expect(badge).not.toBeNull();
    expect(badge?.classList.contains('mock-badge-inline')).toBe(true);
  });

  test('run.mock undefined → no MockBadge', () => {
    const run = activeRun();
    act(() => root.render(<MultiAgentActivityBar run={run} />));
    expect(container.querySelector('.mock-badge')).toBeNull();
  });

  test('run.mock === true but bar early-returns (awaitingContinue) → no MockBadge', () => {
    // The activity bar hides itself wholesale during awaiting-continue
    // (R-B reconstruct read-only) — so the mock chip rides along with the
    // rest of the bar. Confirms the badge can't "leak" out of the bar's
    // hidden state via a sibling render path.
    const run = activeRun({ mock: true, awaitingContinue: true });
    act(() => root.render(<MultiAgentActivityBar run={run} />));
    expect(container.querySelector('.mock-badge')).toBeNull();
  });

  test('run === null → no MockBadge (no active run)', () => {
    act(() => root.render(<MultiAgentActivityBar run={null} />));
    expect(container.querySelector('.mock-badge')).toBeNull();
  });
});
