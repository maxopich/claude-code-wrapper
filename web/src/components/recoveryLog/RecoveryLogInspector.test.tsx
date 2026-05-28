// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type {
  ClientMsg,
  RecoveryClassAggregate,
  RecoveryLogEntry,
  ServerMsg,
} from '@cebab/shared/protocol';
import { RecoveryLogProvider } from './RecoveryLogContext';
import { RecoveryLogInspector } from './RecoveryLogInspector';

/**
 * Cluster D Phase 8b: RecoveryLogInspector rendering tests.
 *
 * Wraps the inspector in a real RecoveryLogProvider so the bridge +
 * mount-time `requestSnapshot()` effect both fire — same posture as
 * Phase 5d's ReopenSessionModal tests. Coverage:
 *
 *   - mount-time requestSnapshot fires a get_recovery_log_snapshot
 *   - loading skeleton renders before first snapshot
 *   - empty state shows the "no recovery actions recorded yet" text
 *   - populated state renders aggregates + gauges + recent rows
 *   - gauges render null-friendly "no data yet" copy
 *   - chips carry class-specific CSS class
 *   - operator action labels render verbatim
 *   - onClose button + invocation
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
    ts: Date.now() - 30_000, // 30s ago → "just now" formatting
    sessionId: 'abcdef1234',
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

type HarnessHandle = {
  pushSnapshot: (msg: Extract<ServerMsg, { type: 'recovery_log_snapshot' }>) => void;
  sent: ClientMsg[];
  onClose: ReturnType<typeof vi.fn>;
};

function mount(): HarnessHandle {
  const handlerRef = { current: null as ((msg: ServerMsg) => void) | null };
  const sent: ClientMsg[] = [];
  const onClose = vi.fn();

  act(() => {
    root.render(
      <RecoveryLogProvider send={(m) => sent.push(m)} handlerRef={handlerRef}>
        <RecoveryLogInspector onClose={onClose} />
      </RecoveryLogProvider>,
    );
  });

  return {
    sent,
    onClose,
    pushSnapshot: (msg) => {
      act(() => {
        handlerRef.current!(msg);
      });
    },
  };
}

describe('RecoveryLogInspector', () => {
  test('mount fires get_recovery_log_snapshot exactly once', () => {
    const h = mount();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toEqual({ type: 'get_recovery_log_snapshot', recentLimit: undefined });
  });

  test('renders Loading… skeleton before first snapshot', () => {
    mount();
    expect(container.textContent).toMatch(/Loading/);
  });

  test('renders empty-state copy when snapshot arrives with no aggregates', () => {
    const h = mount();
    h.pushSnapshot({
      type: 'recovery_log_snapshot',
      aggregates: [],
      sweepReopenRate: null,
      authResumeChoiceRatio: null,
      recent: [],
    });
    expect(container.textContent).toMatch(/No recovery actions recorded/);
    expect(container.textContent).toMatch(/No recent rows/);
  });

  test('renders aggregates table with per-class rows', () => {
    const h = mount();
    h.pushSnapshot({
      type: 'recovery_log_snapshot',
      aggregates: [
        makeAggregate({ failureClass: 'rate_limit', count: 3, reachedFinalRate: 0.5, medianTimeToRecoveryMs: 800 }),
        makeAggregate({ failureClass: 'chain_crash', count: 1, reachedFinalRate: null, medianTimeToRecoveryMs: null }),
      ],
      sweepReopenRate: null,
      authResumeChoiceRatio: null,
      recent: [],
    });
    // Both chips by label.
    const text = container.textContent ?? '';
    expect(text).toContain('Rate limit');
    expect(text).toContain('Chain crash');
    // count + reachedFinalRate columns.
    expect(text).toContain('3');
    expect(text).toContain('50%');
    expect(text).toContain('800 ms');
    // null → em dash for the chain_crash row.
    expect(container.querySelectorAll('.recovery-log-table tbody tr').length).toBe(2);
  });

  test('renders sweepReopenRate gauge with count detail', () => {
    const h = mount();
    h.pushSnapshot({
      type: 'recovery_log_snapshot',
      aggregates: [],
      sweepReopenRate: { rate: 0.5, sweeps: 4 },
      authResumeChoiceRatio: null,
      recent: [],
    });
    const text = container.textContent ?? '';
    expect(text).toContain('Sweep reopen rate');
    expect(text).toContain('50%');
    expect(text).toContain('(2 of 4)');
  });

  test('renders null-state copy for both gauges', () => {
    const h = mount();
    h.pushSnapshot({
      type: 'recovery_log_snapshot',
      aggregates: [],
      sweepReopenRate: null,
      authResumeChoiceRatio: null,
      recent: [],
    });
    const text = container.textContent ?? '';
    expect(text).toContain('No sweeps recorded yet');
    expect(text).toContain('No auth recoveries recorded yet');
  });

  test('renders authResumeChoiceRatio gauge with count detail', () => {
    const h = mount();
    h.pushSnapshot({
      type: 'recovery_log_snapshot',
      aggregates: [],
      sweepReopenRate: null,
      authResumeChoiceRatio: { inSessionRate: 2 / 3, inSession: 2, newSession: 1 },
      recent: [],
    });
    const text = container.textContent ?? '';
    expect(text).toContain('Auth resume choice');
    expect(text).toContain('66.7%');
    expect(text).toContain('(2 of 3)');
  });

  test('renders recent rows with action labels + session prefix + ts', () => {
    const h = mount();
    h.pushSnapshot({
      type: 'recovery_log_snapshot',
      aggregates: [],
      sweepReopenRate: null,
      authResumeChoiceRatio: null,
      recent: [
        makeEntry({
          id: 7,
          sessionId: 'abcdef1234567890',
          failureClass: 'rate_limit',
          operatorAction: 'auto_retry',
          timeToRecoveryMs: 1500,
          outcome: 'reached_final',
          ts: Date.now() - 30_000,
        }),
        makeEntry({
          id: 8,
          sessionId: null, // process-level
          failureClass: 'other',
          operatorAction: 'abort',
        }),
      ],
    });
    const rows = container.querySelectorAll('.recovery-log-recent-row');
    expect(rows.length).toBe(2);
    const text = container.textContent ?? '';
    expect(text).toContain('Rate limit');
    expect(text).toContain('auto-retry');
    expect(text).toContain('session abcdef12'); // 8-char truncation
    expect(text).toContain('time-to-recovery 1.5 s');
    expect(text).toContain('reached final');
    // Process-level row.
    expect(text).toContain('process-level');
    expect(text).toContain('abort');
  });

  test('class chip carries the failure-class-specific CSS class', () => {
    const h = mount();
    h.pushSnapshot({
      type: 'recovery_log_snapshot',
      aggregates: [
        makeAggregate({ failureClass: 'rate_limit', count: 1 }),
      ],
      sweepReopenRate: null,
      authResumeChoiceRatio: null,
      recent: [],
    });
    const chip = container.querySelector('.recovery-log-class-rate_limit');
    expect(chip).not.toBeNull();
  });

  test('close button invokes onClose', () => {
    const h = mount();
    h.pushSnapshot({
      type: 'recovery_log_snapshot',
      aggregates: [],
      sweepReopenRate: null,
      authResumeChoiceRatio: null,
      recent: [],
    });
    const closeBtn = container.querySelector(
      'button.recovery-log-inspector-close',
    ) as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();
    act(() => {
      closeBtn.click();
    });
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });
});
