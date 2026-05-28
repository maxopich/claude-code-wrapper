// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { WorkspaceDiff } from '@cebab/shared/protocol';
import { ReopenSessionModal } from './ReopenSessionModal';
import type { ReopenState } from './ReopenContext';

// Cluster D Phase 5d (spec §6.3 / UI-D19, UI-D20, UI-D21): UI contract
// tests for the swept-session reopen modal.
//
// Per-state coverage:
//   - probing/committing: spinner + status text + no form
//   - confirming: state-dependent layout (clean / dirty / no-git);
//     ack checkbox required; typed gate when dirty/no-git; default
//     focus on Cancel (UI-D20).
//   - failed: terminal error + Close button + autoFocus.

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
  vi.useRealTimers();
});

const CLEAN_DIFF: WorkspaceDiff = {
  filesChanged: 0,
  filesAdded: 0,
  filesDeleted: 0,
  sampleChanges: [],
  fullDiffAvailable: true,
};
const DIRTY_DIFF: WorkspaceDiff = {
  filesChanged: 3,
  filesAdded: 1,
  filesDeleted: 1,
  sampleChanges: ['a.txt', 'b.txt', 'c.txt'],
  fullDiffAvailable: true,
};
const NO_GIT_DIFF: WorkspaceDiff = {
  filesChanged: 0,
  filesAdded: 0,
  filesDeleted: 0,
  sampleChanges: [],
  fullDiffAvailable: false,
};

function renderModal(state: Exclude<ReopenState, { kind: 'idle' }>) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  act(() => {
    root.render(<ReopenSessionModal state={state} onConfirm={onConfirm} onClose={onClose} />);
  });
  return { onConfirm, onClose };
}

// React-controlled inputs need the native value setter to fire React's
// onChange, otherwise React notices `input.value = X` was a direct DOM
// mutation and reverts on next render. Helper distilled from the same
// pattern used in EnvInjectionGateModal.test.tsx.
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('no value setter on HTMLInputElement.prototype');
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function toggleCheckbox(input: HTMLInputElement, checked: boolean) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
  if (!setter) throw new Error('no checked setter on HTMLInputElement.prototype');
  setter.call(input, checked);
  input.dispatchEvent(new Event('click', { bubbles: true }));
}

describe('ReopenSessionModal — probing state', () => {
  test('renders spinner + no form', () => {
    renderModal({ kind: 'probing', sessionId: 'abc12345-xx' });
    expect(container.querySelector('.reopen-modal-spinner')).toBeTruthy();
    expect(container.querySelector('.reopen-modal-ack')).toBeFalsy();
    expect(container.querySelector('input[type="text"]')).toBeFalsy();
    // Short id shown in body copy
    expect(container.textContent).toContain('abc12345');
  });
});

describe('ReopenSessionModal — committing state', () => {
  test('renders spinner + status text', () => {
    renderModal({
      kind: 'committing',
      sessionId: 'def67890-yy',
      projectPath: '/p',
      diff: CLEAN_DIFF,
    });
    expect(container.querySelector('.reopen-modal-spinner')).toBeTruthy();
    expect(container.textContent).toContain('Reopening');
    expect(container.textContent).toContain('def67890');
  });
});

describe('ReopenSessionModal — confirming state, clean workspace', () => {
  test('reopen button enabled after only checking ack (no typed gate)', () => {
    const { onConfirm } = renderModal({
      kind: 'confirming',
      sessionId: 's1',
      projectPath: '/p',
      diff: CLEAN_DIFF,
    });

    const reopenBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === 'Reopen',
    )!;
    expect(reopenBtn.disabled).toBe(true);

    // No typed input rendered for clean workspaces.
    expect(container.querySelector('.reopen-modal-typed')).toBeFalsy();
    // "No uncommitted changes" line rendered.
    expect(container.querySelector('.reopen-modal-clean')).toBeTruthy();

    // Check the acknowledgement.
    const ack = container.querySelector<HTMLInputElement>('.reopen-modal-ack input')!;
    act(() => {
      toggleCheckbox(ack, true);
    });
    expect(reopenBtn.disabled).toBe(false);

    act(() => {
      reopenBtn.click();
    });
    expect(onConfirm).toHaveBeenCalledWith({ acknowledgedWorkspaceDiff: true });
  });
});

describe('ReopenSessionModal — confirming state, dirty workspace', () => {
  test('renders typed gate when filesChanged > 0; reopen blocked until both ack+typed', () => {
    const { onConfirm } = renderModal({
      kind: 'confirming',
      sessionId: 's1',
      projectPath: '/myproj',
      diff: DIRTY_DIFF,
    });

    // Counts visible
    expect(container.textContent).toContain('3');
    expect(container.textContent).toContain('1 added');
    expect(container.textContent).toContain('1 deleted');
    // Sample paths rendered
    const samples = container.querySelectorAll('.reopen-modal-samples li');
    expect(samples.length).toBe(3);
    // Project path shown
    expect(container.textContent).toContain('/myproj');

    // Typed input rendered
    const typed = container.querySelector<HTMLInputElement>('.reopen-modal-typed input');
    expect(typed).toBeTruthy();

    const reopenBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === 'Reopen',
    )!;
    expect(reopenBtn.disabled).toBe(true);

    // Tick ack alone — still disabled.
    const ack = container.querySelector<HTMLInputElement>('.reopen-modal-ack input')!;
    act(() => {
      toggleCheckbox(ack, true);
    });
    expect(reopenBtn.disabled).toBe(true);

    // Wrong typed string — still disabled.
    act(() => {
      typeInto(typed!, 'REOPEN');
    });
    expect(reopenBtn.disabled).toBe(true);

    // Correct typed string — enabled.
    act(() => {
      typeInto(typed!, 'reopen');
    });
    expect(reopenBtn.disabled).toBe(false);

    act(() => {
      reopenBtn.click();
    });
    expect(onConfirm).toHaveBeenCalledWith({
      acknowledgedWorkspaceDiff: true,
      typedConfirmation: 'reopen',
    });
  });
});

describe('ReopenSessionModal — confirming state, no-git workspace', () => {
  test('non-git diff treated safe-by-default (typed gate required)', () => {
    renderModal({
      kind: 'confirming',
      sessionId: 's1',
      projectPath: '/p',
      diff: NO_GIT_DIFF,
    });

    // No-git banner visible.
    expect(container.querySelector('.reopen-modal-no-git')).toBeTruthy();
    // Typed input still required.
    expect(container.querySelector('.reopen-modal-typed')).toBeTruthy();
  });
});

describe('ReopenSessionModal — inline failure during commit', () => {
  test('lastFailureMessage renders above the form (role=alert)', () => {
    renderModal({
      kind: 'confirming',
      sessionId: 's1',
      projectPath: '/p',
      diff: CLEAN_DIFF,
      lastFailureMessage: 'Type "reopen" to confirm.',
    });
    const err = container.querySelector('.reopen-modal-error');
    expect(err).toBeTruthy();
    expect(err!.getAttribute('role')).toBe('alert');
    expect(err!.textContent).toContain('Type "reopen" to confirm.');
  });
});

describe('ReopenSessionModal — cancel default focus (UI-D20)', () => {
  test('Cancel button receives initial focus in confirming state', () => {
    renderModal({
      kind: 'confirming',
      sessionId: 's1',
      projectPath: '/p',
      diff: DIRTY_DIFF,
    });
    const cancel = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === 'Cancel',
    )!;
    expect(document.activeElement).toBe(cancel);
  });

  test('Cancel click invokes onClose without onConfirm', () => {
    const { onConfirm, onClose } = renderModal({
      kind: 'confirming',
      sessionId: 's1',
      projectPath: '/p',
      diff: CLEAN_DIFF,
    });
    const cancel = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === 'Cancel',
    )!;
    act(() => {
      cancel.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('ReopenSessionModal — failed state', () => {
  test('renders terminal error + Close button', () => {
    const { onClose } = renderModal({
      kind: 'failed',
      sessionId: 's1',
      reason: 'chain_reconstruction_unsupported',
      message: 'Chain mode is not supported in v1.',
    });
    // Title comes from FAILURE_TITLE map
    expect(container.querySelector('.gate-modal-title')?.textContent).toBe(
      'Cannot reopen chain session',
    );
    expect(container.textContent).toContain('Chain mode is not supported');
    // Reason chip rendered
    expect(container.querySelector('.reopen-modal-failed-reason')?.textContent).toBe(
      'chain_reconstruction_unsupported',
    );

    const closeBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === 'Close',
    )!;
    act(() => {
      closeBtn.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('failed reason rendered for each enumerated code', () => {
    const reasons = [
      'not_found',
      'still_running',
      'no_participant',
      'ack_required',
      'typed_confirmation_required',
      'chain_reconstruction_unsupported',
      'reactivate_failed',
    ] as const;
    for (const reason of reasons) {
      renderModal({ kind: 'failed', sessionId: 's', reason, message: 'msg' });
      // Title exists (asserts FAILURE_TITLE map is exhaustive)
      const title = container.querySelector('.gate-modal-title')?.textContent ?? '';
      expect(title.length).toBeGreaterThan(0);
      act(() => {
        root.unmount();
        root = createRoot(container);
      });
    }
  });
});
