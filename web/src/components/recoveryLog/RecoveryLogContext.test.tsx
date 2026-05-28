// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, useRef } from 'react';
import type {
  ClientMsg,
  RecoveryClassAggregate,
  RecoveryLogEntry,
  ServerMsg,
} from '@cebab/shared/protocol';
import {
  RecoveryLogProvider,
  initialRecoveryLogState,
  recoveryLogReducer,
  useRecoveryLogActions,
  useRecoveryLogState,
} from './RecoveryLogContext';

/**
 * Cluster D Phase 8b: RecoveryLogContext tests.
 *
 * Two layers covered (mirrors InboxContext.test.tsx):
 *   1. Pure reducer — snapshot overwrites prior state; `loaded` flips
 *      to true after first snapshot.
 *   2. Provider bridge — handlerRef receives a filter to the
 *      `recovery_log_snapshot` discriminant; other ServerMsgs are
 *      silently ignored. `requestSnapshot` ships the matching
 *      ClientMsg.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function makeAggregate(overrides: Partial<RecoveryClassAggregate> = {}): RecoveryClassAggregate {
  return {
    failureClass: 'sweep',
    count: 1,
    reachedFinalRate: null,
    medianTimeToRecoveryMs: null,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<RecoveryLogEntry> = {}): RecoveryLogEntry {
  return {
    id: 1,
    ts: 1_700_000_000_000,
    sessionId: 'sess-1',
    parentSessionId: null,
    operatorId: 'local-user',
    failureClass: 'sweep',
    operatorAction: 'archive',
    timeToRecoveryMs: null,
    outcome: null,
    forensicsId: null,
    invariantResultsJson: null,
    ...overrides,
  };
}

describe('recoveryLogReducer', () => {
  test('initial state has loaded=false, empty fields, null gauges', () => {
    expect(initialRecoveryLogState.loaded).toBe(false);
    expect(initialRecoveryLogState.aggregates).toEqual([]);
    expect(initialRecoveryLogState.recent).toEqual([]);
    expect(initialRecoveryLogState.sweepReopenRate).toBeNull();
    expect(initialRecoveryLogState.authResumeChoiceRatio).toBeNull();
  });

  test('snapshot action overwrites state and flips loaded=true', () => {
    const agg = makeAggregate({ failureClass: 'rate_limit', count: 3 });
    const entry = makeEntry({ id: 42 });
    const next = recoveryLogReducer(initialRecoveryLogState, {
      type: 'snapshot',
      aggregates: [agg],
      sweepReopenRate: { rate: 0.5, sweeps: 4 },
      authResumeChoiceRatio: null,
      recent: [entry],
    });
    expect(next.loaded).toBe(true);
    expect(next.aggregates).toEqual([agg]);
    expect(next.sweepReopenRate).toEqual({ rate: 0.5, sweeps: 4 });
    expect(next.recent).toEqual([entry]);
  });

  test('successive snapshots replace, not merge', () => {
    const first = recoveryLogReducer(initialRecoveryLogState, {
      type: 'snapshot',
      aggregates: [makeAggregate({ failureClass: 'sweep', count: 1 })],
      sweepReopenRate: { rate: 0, sweeps: 1 },
      authResumeChoiceRatio: null,
      recent: [makeEntry({ id: 1 })],
    });
    const second = recoveryLogReducer(first, {
      type: 'snapshot',
      aggregates: [makeAggregate({ failureClass: 'chain_crash', count: 2 })],
      sweepReopenRate: null,
      authResumeChoiceRatio: { inSessionRate: 1, inSession: 1, newSession: 0 },
      recent: [makeEntry({ id: 2 })],
    });
    expect(second.aggregates.map((a) => a.failureClass)).toEqual(['chain_crash']);
    expect(second.sweepReopenRate).toBeNull();
    expect(second.recent.map((r) => r.id)).toEqual([2]);
  });
});

describe('RecoveryLogProvider bridge', () => {
  test('handlerRef receives a snapshot router; state updates on push', () => {
    const handlerRef = { current: null as ((msg: ServerMsg) => void) | null };

    const holder: { state?: ReturnType<typeof useRecoveryLogState> } = {};
    function Probe() {
      holder.state = useRecoveryLogState();
      return null;
    }

    act(() => {
      root.render(
        <RecoveryLogProvider send={() => {}} handlerRef={handlerRef}>
          <Probe />
        </RecoveryLogProvider>,
      );
    });

    expect(handlerRef.current).not.toBeNull();
    expect(holder.state?.loaded).toBe(false);

    const entry = makeEntry({ id: 99 });
    act(() => {
      handlerRef.current!({
        type: 'recovery_log_snapshot',
        aggregates: [makeAggregate({ failureClass: 'rate_limit', count: 5 })],
        sweepReopenRate: { rate: 0.25, sweeps: 8 },
        authResumeChoiceRatio: null,
        recent: [entry],
      });
    });

    expect(holder.state?.loaded).toBe(true);
    expect(holder.state?.aggregates[0]?.failureClass).toBe('rate_limit');
    expect(holder.state?.sweepReopenRate).toEqual({ rate: 0.25, sweeps: 8 });
    expect(holder.state?.recent[0]?.id).toBe(99);
  });

  test('non-recovery_log_snapshot ServerMsgs are silently ignored', () => {
    const handlerRef = { current: null as ((msg: ServerMsg) => void) | null };
    const holder: { state?: ReturnType<typeof useRecoveryLogState> } = {};
    function Probe() {
      holder.state = useRecoveryLogState();
      return null;
    }

    act(() => {
      root.render(
        <RecoveryLogProvider send={() => {}} handlerRef={handlerRef}>
          <Probe />
        </RecoveryLogProvider>,
      );
    });

    act(() => {
      // Type-correct ServerMsg of the wrong variant — must not crash
      // + must not flip loaded.
      handlerRef.current!({ type: 'projects', projects: [] });
    });

    expect(holder.state?.loaded).toBe(false);
  });

  test('requestSnapshot sends get_recovery_log_snapshot with optional recentLimit', () => {
    const sent: ClientMsg[] = [];
    const actionsHolder: { actions?: ReturnType<typeof useRecoveryLogActions> } = {};
    function Probe() {
      actionsHolder.actions = useRecoveryLogActions();
      return null;
    }

    act(() => {
      root.render(
        <RecoveryLogProvider send={(m) => sent.push(m)}>
          <Probe />
        </RecoveryLogProvider>,
      );
    });

    act(() => {
      actionsHolder.actions!.requestSnapshot();
    });
    act(() => {
      actionsHolder.actions!.requestSnapshot(50);
    });

    expect(sent).toEqual([
      { type: 'get_recovery_log_snapshot', recentLimit: undefined },
      { type: 'get_recovery_log_snapshot', recentLimit: 50 },
    ]);
  });

  test('handlerRef is cleared on unmount so dangling callers no-op', () => {
    const handlerRef = { current: null as ((msg: ServerMsg) => void) | null };
    function Empty() {
      useRef(null);
      return null;
    }

    act(() => {
      root.render(
        <RecoveryLogProvider send={() => {}} handlerRef={handlerRef}>
          <Empty />
        </RecoveryLogProvider>,
      );
    });
    expect(handlerRef.current).not.toBeNull();

    act(() => {
      root.unmount();
    });
    expect(handlerRef.current).toBeNull();
    root = createRoot(container);
  });

  test('useRecoveryLogState throws outside provider', () => {
    function ProbeOut() {
      useRecoveryLogState();
      return null;
    }
    // React error boundaries surface via console.error in test; swallow.
    const origErr = console.error;
    console.error = vi.fn();
    expect(() => {
      act(() => {
        root.render(<ProbeOut />);
      });
    }).toThrow(/requires <RecoveryLogProvider>/);
    console.error = origErr;
  });

  test('useRecoveryLogActions throws outside provider', () => {
    function ProbeOut() {
      useRecoveryLogActions();
      return null;
    }
    const origErr = console.error;
    console.error = vi.fn();
    expect(() => {
      act(() => {
        root.render(<ProbeOut />);
      });
    }).toThrow(/requires <RecoveryLogProvider>/);
    console.error = origErr;
  });
});
