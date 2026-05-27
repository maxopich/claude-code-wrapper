// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { AuthorityProvider } from './AuthorityContext';
import { AuthorityPreflightModal } from './AuthorityPreflightModal';

// Cluster B Phase 6e — UI-B3: AuthorityPreflightModal contract.
//
// Tests:
//   - single-project mode: title is "Authority preview", one panel mounts
//   - aggregate mode: title shows the project count, N panels mount
//   - [Start session] absent when onStart not provided (review-only path)
//   - [Start session] present when onStart provided; click fires onStart
//     then onClose
//   - initial focus lands on [Start session] when provided, else [Close]
//   - clicking [Close] fires onClose
//   - role=dialog + aria-modal + aria-labelledby plumbed

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

function mountModal(props: { projectIds: number[]; onStart?: () => void; onClose?: () => void }) {
  const onClose = props.onClose ?? (() => {});
  act(() => {
    root.render(
      <AuthorityProvider send={() => {}}>
        <AuthorityPreflightModal
          projectIds={props.projectIds}
          onStart={props.onStart}
          onClose={onClose}
        />
      </AuthorityProvider>,
    );
  });
}

describe('AuthorityPreflightModal — render', () => {
  test('single-project title reads "Authority preview"', () => {
    mountModal({ projectIds: [1] });
    expect(container.querySelector('.gate-modal-title')?.textContent).toBe('Authority preview');
  });

  test('aggregate title shows the project count', () => {
    mountModal({ projectIds: [1, 2, 3] });
    expect(container.querySelector('.gate-modal-title')?.textContent).toBe(
      'Authority preview · 3 projects',
    );
  });

  test('renders one AuthorityPanel per projectId', () => {
    mountModal({ projectIds: [5, 7] });
    const panels = container.querySelectorAll('.authority-panel');
    expect(panels.length).toBe(2);
  });

  test('role=dialog, aria-modal=true, aria-labelledby set + label element exists', () => {
    mountModal({ projectIds: [42] });
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelId = dialog.getAttribute('aria-labelledby')!;
    expect(labelId).toBe('authority-preflight-title-42');
    expect(document.getElementById(labelId)).not.toBeNull();
  });
});

describe('AuthorityPreflightModal — Start session button', () => {
  test('absent when onStart not provided', () => {
    mountModal({ projectIds: [1] });
    const labels = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.gate-modal-buttons button'),
    ).map((b) => b.textContent);
    expect(labels).toEqual(['Close']);
  });

  test('present when onStart provided', () => {
    mountModal({ projectIds: [1], onStart: () => {} });
    const labels = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.gate-modal-buttons button'),
    ).map((b) => b.textContent);
    expect(labels).toContain('Start session');
  });

  test('click fires onStart then onClose', () => {
    const calls: string[] = [];
    const onStart = () => calls.push('start');
    const onClose = () => calls.push('close');
    mountModal({ projectIds: [1], onStart, onClose });
    const start = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.gate-modal-buttons button'),
    ).find((b) => b.textContent === 'Start session')!;
    act(() => {
      start.click();
    });
    expect(calls).toEqual(['start', 'close']);
  });

  test('initial focus lands on [Start session] when provided', () => {
    mountModal({ projectIds: [1], onStart: () => {} });
    const start = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.gate-modal-buttons button'),
    ).find((b) => b.textContent === 'Start session');
    expect(document.activeElement).toBe(start);
  });

  test('initial focus falls back to [Close] in review-only mode', () => {
    mountModal({ projectIds: [1] });
    const close = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.gate-modal-buttons button'),
    ).find((b) => b.textContent === 'Close');
    expect(document.activeElement).toBe(close);
  });
});

describe('AuthorityPreflightModal — Close', () => {
  test('clicking [Close] fires onClose', () => {
    let closed = 0;
    mountModal({ projectIds: [1], onClose: () => (closed += 1) });
    const close = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.gate-modal-buttons button'),
    ).find((b) => b.textContent === 'Close')!;
    act(() => {
      close.click();
    });
    expect(closed).toBe(1);
  });
});
