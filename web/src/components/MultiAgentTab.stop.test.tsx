// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ServerMsg } from '@cebab/shared/protocol';
import type { MultiAgentRun } from '../store';
import { TopRunBar } from './MultiAgentTab';

// Cebab-ygu.32: the run bar's Stop button applied its optimistic
// "Stopping…" state — disabling the run's ONLY stop control — before an
// unchecked `wsRef.current?.send(...)`, and nothing ever reset the flag. A
// Stop clicked while the socket was down (laptop sleep, server restart) froze
// the button on a disabled spinner while the run kept running, leaving a page
// reload as the only recovery.
//
// The fix mirrors InputBox's `stopping` reset: `handleStop` gates
// `setStopPending(true)` on whether `onStop` reports a delivered send, so a
// dropped send never flips the button. This file pins that gate from both
// sides. `stubProps` matches MultiAgentTab.mock.test.tsx.

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function buildRun(overrides: Partial<MultiAgentRun> = {}): MultiAgentRun {
  return {
    sessionId: 'bus-test',
    mode: 'orchestrator',
    participantAgentNames: ['orchestrator', 'workerA'],
    status: 'running',
    events: [],
    iterationId: null,
    // 'persistent' (not 'temp') so handleStop takes the direct, non-confirm
    // path — the temp branch's `requestConfirm` gate is out of scope here.
    lifecycle: 'persistent',
    sessionFolder: '/ws/.cebab/bus-test',
    awaitingContinue: false,
    activity: null,
    hopBudget: 30,
    hopsUsed: 0,
    pendingRetry: null,
    pauseOnDangerous: false,
    executeMode: false,
    mutations: [],
    pendingMutations: [],
    pendingQuestion: null,
    recoveryContext: null,
    routerDrops: [],
    participantControls: {},
    modelsByAgent: {},
    ...overrides,
  };
}

/** The run bar's Stop / Stopping… button (the only `primary-btn` it renders). */
function stopButton(container: HTMLElement): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>('button.primary-btn');
  if (!btn) throw new Error('stop button not found');
  return btn;
}

describe('TopRunBar — Stop gates its optimistic state on a delivered send', () => {
  let container: HTMLDivElement;
  let root: Root;
  const restProps: {
    onDismiss: () => void;
    onLoadSessionLog: (id: string, o: number, l: number, r: boolean) => void;
    subscribeServerMsg: (cb: (msg: ServerMsg) => void) => () => void;
  } = {
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

  test('a dropped send leaves the button enabled and labelled "Stop"', () => {
    // The regression: `onStop` reports the send never went out, so the button
    // must NOT flip to a disabled "Stopping…" — otherwise the run's sole stop
    // control is frozen with no path back short of a reload.
    const onStop = vi.fn(() => false);
    act(() => root.render(<TopRunBar run={buildRun()} onStop={onStop} {...restProps} />));

    const before = stopButton(container);
    expect(before.disabled).toBe(false);
    expect(before.textContent).toContain('Stop');
    expect(before.textContent).not.toContain('Stopping');

    act(() => before.click());

    expect(onStop).toHaveBeenCalledWith('bus-test');
    const after = stopButton(container);
    expect(after.disabled).toBe(false);
    expect(after.textContent).not.toContain('Stopping');
  });

  test('a delivered send flips the button to a disabled "Stopping…"', () => {
    const onStop = vi.fn(() => true);
    act(() => root.render(<TopRunBar run={buildRun()} onStop={onStop} {...restProps} />));

    act(() => stopButton(container).click());

    expect(onStop).toHaveBeenCalledWith('bus-test');
    const after = stopButton(container);
    expect(after.disabled).toBe(true);
    expect(after.textContent).toContain('Stopping');
  });

  test('leaving the running state resets the pending flag (no stale spinner)', () => {
    // TopRunBar is mounted without a `key`, so it is not remounted when a run
    // ends. The reset effect (mirroring InputBox) clears `stopPending` once the
    // run is no longer running; the button then renders as "Close".
    const onStop = vi.fn(() => true);
    act(() => root.render(<TopRunBar run={buildRun()} onStop={onStop} {...restProps} />));
    act(() => stopButton(container).click());
    expect(stopButton(container).textContent).toContain('Stopping');

    act(() =>
      root.render(
        <TopRunBar run={buildRun({ status: 'completed' })} onStop={onStop} {...restProps} />,
      ),
    );
    // No disabled spinner survives — the run bar now offers "Close".
    expect(container.querySelector('button.primary-btn')).toBeNull();
    const close = [...container.querySelectorAll('button.ghost-btn')].find((b) =>
      /Close/.test(b.textContent ?? ''),
    );
    expect(close).toBeTruthy();
  });
});
