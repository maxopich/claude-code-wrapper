// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { AuthRefreshModal } from './AuthRefreshModal';
import type { AuthRefreshState } from './AuthRefreshContext';

// Cluster D Phase 6c: per-state UI contract for the AuthRefreshModal.
//
// Coverage:
//   - spawning: spinner + status text + no Cancel button
//   - running: PID chip + output area + Cancel button (default focus)
//   - running with empty output: placeholder text visible
//   - running: the output pane follows the tail, and stops once scrolled up (W14)
//   - completed (success): success title + exit chip + Close button
//   - completed (failure): failure title + exit chip + output rendered
//   - failed (already_running): tailored copy + existingRunId hint
//   - failed (spawn_failed): tailored copy + error detail
//   - cancel click invokes onCancel; close click invokes onClose

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

function renderModal(state: Exclude<AuthRefreshState, { kind: 'idle' }>) {
  const onCancel = vi.fn();
  const onClose = vi.fn();
  act(() => {
    root.render(<AuthRefreshModal state={state} onCancel={onCancel} onClose={onClose} />);
  });
  return { onCancel, onClose };
}

describe('AuthRefreshModal — spawning state', () => {
  test('renders spinner + status text + no Cancel button', () => {
    renderModal({ kind: 'spawning' });
    expect(container.querySelector('.auth-refresh-modal-spinner')).toBeTruthy();
    expect(container.textContent).toContain('Spawning');
    expect(container.textContent).toContain('claude login');
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
    expect(buttons.find((b) => b.textContent === 'Cancel')).toBeUndefined();
    expect(buttons.find((b) => b.textContent === 'Close')).toBeUndefined();
  });
});

describe('AuthRefreshModal — running state', () => {
  test('renders PID + output + Cancel button (default-focused)', () => {
    renderModal({
      kind: 'running',
      runId: 'run-1',
      pid: 12345,
      output: 'Open https://login.claude.ai/...\n',
    });
    expect(container.textContent).toContain('Re-authenticating');
    expect(container.textContent).toContain('pid 12345');
    const output = container.querySelector('.auth-refresh-modal-output');
    expect(output?.textContent).toContain('Open https://login.claude.ai/');
    const cancel = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === 'Cancel',
    )!;
    expect(cancel).toBeTruthy();
    expect(document.activeElement).toBe(cancel);
  });

  test('placeholder visible when output is empty', () => {
    renderModal({ kind: 'running', runId: 'run-1', pid: 1, output: '' });
    expect(container.querySelector('.auth-refresh-modal-output-placeholder')).toBeTruthy();
    expect(container.textContent).toContain('Waiting for output');
  });

  test('Cancel click invokes onCancel without onClose', () => {
    const { onCancel, onClose } = renderModal({
      kind: 'running',
      runId: 'run-1',
      pid: 1,
      output: '',
    });
    const cancel = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === 'Cancel',
    )!;
    act(() => {
      cancel.click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});

/**
 * Register W14 — the second copy of the chat pane's unguarded auto-scroll.
 * Worse here than in the chat: this pane exists so the operator can read an
 * OAuth URL, and every new chunk used to drag it off screen mid-read.
 *
 * Staging is mandatory, not tidiness: jsdom runs no layout, so an unstaged
 * element reports `scrollTop`/`scrollHeight`/`clientHeight` all `0`, which the
 * pin predicate reads as "at the bottom" whatever position is assigned. Without
 * the two `defineProperty` calls the scrolled-up case below is not merely weak,
 * it is unrepresentable — the same shape measured against `ChatView`, whose
 * spec header records the experiment. `scrollTop` is writable and unclamped in
 * jsdom, so it is both how the position is staged and how the component's own
 * write is observed — no spy needed, unlike ChatView's `scrollTo`.
 */
describe('AuthRefreshModal — output pane follows the tail (W14)', () => {
  function outputPane(): HTMLElement {
    const el = container.querySelector('.auth-refresh-modal-output');
    if (!el) throw new Error('no output pane rendered');
    return el as HTMLElement;
  }

  function stage(el: HTMLElement, scrollTop: number) {
    Object.defineProperty(el, 'scrollHeight', { value: 3000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true });
    el.scrollTop = scrollTop;
    act(() => {
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
  }

  test('a new chunk scrolls to the bottom while the operator is still at the tail', () => {
    renderModal({ kind: 'running', runId: 'run-1', pid: 1, output: 'line one\n' });
    const pane = outputPane();
    stage(pane, 2400); // 3000 - 600 → exactly the bottom

    renderModal({ kind: 'running', runId: 'run-1', pid: 1, output: 'line one\nline two\n' });

    expect(outputPane().scrollTop).toBe(3000);
  });

  test('a new chunk does NOT yank the pane once the operator has scrolled up to read', () => {
    renderModal({ kind: 'running', runId: 'run-1', pid: 1, output: 'line one\n' });
    const pane = outputPane();
    stage(pane, 400);

    renderModal({ kind: 'running', runId: 'run-1', pid: 1, output: 'line one\nline two\n' });

    expect(outputPane().scrollTop).toBe(400);
  });
});

describe('AuthRefreshModal — completed state', () => {
  test('success: title + exit chip + Close + Re-authenticated copy', () => {
    renderModal({
      kind: 'completed',
      runId: 'run-1',
      exitCode: 0,
      success: true,
      output: 'final output',
    });
    expect(container.querySelector('.gate-modal-title')?.textContent).toBe('Re-authenticated');
    expect(container.querySelector('.auth-refresh-modal-exit-success')?.textContent).toBe('exit 0');
    expect(container.textContent).toContain('clear the next time a session starts');
    const closeBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === 'Close',
    )!;
    expect(closeBtn).toBeTruthy();
  });

  test('failure (non-zero exit): title + failed chip + output', () => {
    renderModal({
      kind: 'completed',
      runId: 'run-1',
      exitCode: 1,
      success: false,
      output: 'Error: auth declined',
    });
    expect(container.querySelector('.gate-modal-title')?.textContent).toBe(
      'Re-authentication failed',
    );
    expect(container.querySelector('.auth-refresh-modal-exit-failed')?.textContent).toBe('exit 1');
    expect(container.textContent).toContain('exited with code 1');
    expect(container.querySelector('.auth-refresh-modal-output')?.textContent).toContain(
      'Error: auth declined',
    );
  });

  test('failure (killed): exit chip reads "killed"; copy mentions cancellation', () => {
    renderModal({
      kind: 'completed',
      runId: 'run-1',
      exitCode: null,
      success: false,
      output: '',
    });
    expect(container.querySelector('.auth-refresh-modal-exit-failed')?.textContent).toBe(
      'exit killed',
    );
    expect(container.textContent).toContain('cancelled or timed out');
  });

  test('Close click invokes onClose', () => {
    const { onClose } = renderModal({
      kind: 'completed',
      runId: 'run-1',
      exitCode: 0,
      success: true,
      output: '',
    });
    const closeBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === 'Close',
    )!;
    act(() => {
      closeBtn.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('AuthRefreshModal — failed state', () => {
  test('already_running: tailored copy + existingRunId hint', () => {
    renderModal({
      kind: 'failed',
      reason: 'already_running',
      existingRunId: 'abcdef12-other-tab',
    });
    expect(container.querySelector('.gate-modal-title')?.textContent).toBe(
      'Another auth refresh is in progress',
    );
    expect(container.querySelector('.auth-refresh-modal-failed-reason')?.textContent).toBe(
      'already_running',
    );
    expect(container.textContent).toContain('cancel it from that tab');
    expect(container.textContent).toContain('abcdef12');
  });

  test('spawn_failed: tailored copy + error detail', () => {
    renderModal({
      kind: 'failed',
      reason: 'spawn_failed',
      error: 'ENOENT: claude not found',
    });
    expect(container.querySelector('.gate-modal-title')?.textContent).toBe(
      'Failed to spawn claude login',
    );
    expect(container.querySelector('.auth-refresh-modal-failed-reason')?.textContent).toBe(
      'spawn_failed',
    );
    expect(container.textContent).toContain('not being on the server');
    expect(container.textContent).toContain('ENOENT');
  });

  test('Close click invokes onClose', () => {
    const { onClose } = renderModal({
      kind: 'failed',
      reason: 'spawn_failed',
      error: 'oops',
    });
    const closeBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === 'Close',
    )!;
    act(() => {
      closeBtn.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
