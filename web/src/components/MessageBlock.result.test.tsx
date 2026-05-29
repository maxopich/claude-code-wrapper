// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MessageView } from '../store';
import { MessageBlock } from './MessageBlock';

// Cluster H B5 — pins MessageBlock's result-footer behavior:
//
//   1. With `durationMs` present, the footer renders "subtype · $cost · 2.4s"
//      and the accessible label includes all three metadata.
//   2. Without `durationMs`, the footer degrades to "subtype · $cost" and the
//      accessible label lists just subtype + cost (no orphan separator).
//   3. The duration sub-span carries `.result-duration` so the CSS picks it up.
//   4. The separator dots are aria-hidden — screen readers consume only the
//      structured aria-label.

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

function resultMsg(partial: Partial<Extract<MessageView, { kind: 'result' }>>): MessageView {
  return {
    kind: 'result',
    id: 'm1',
    subtype: 'success',
    cost: 0.0123,
    ...partial,
  };
}

function renderResult(m: MessageView) {
  act(() => {
    root.render(<MessageBlock message={m} />);
  });
}

function getRoleEl(): HTMLElement | null {
  return container.querySelector('.msg.result .role');
}

describe('MessageBlock result footer — Cluster H B5', () => {
  test('renders duration when durationMs is present (sub-second band)', () => {
    renderResult(resultMsg({ durationMs: 42 }));
    const role = getRoleEl();
    expect(role).not.toBeNull();
    expect(role!.textContent).toMatch(/success/);
    expect(role!.textContent).toMatch(/\$0\.0123/);
    expect(role!.textContent).toMatch(/42ms/);
    const duration = container.querySelector('.result-duration');
    expect(duration).not.toBeNull();
    expect(duration!.textContent).toBe('42ms');
  });

  test('renders duration in the seconds band ("2.4s")', () => {
    renderResult(resultMsg({ durationMs: 2_400 }));
    const duration = container.querySelector('.result-duration');
    expect(duration!.textContent).toBe('2.4s');
  });

  test('renders duration in the minutes band ("1m 12s")', () => {
    renderResult(resultMsg({ durationMs: 72_000 }));
    const duration = container.querySelector('.result-duration');
    expect(duration!.textContent).toBe('1m 12s');
  });

  test('omits the duration sub-span when durationMs is absent', () => {
    renderResult(resultMsg({ durationMs: undefined }));
    const role = getRoleEl();
    expect(role).not.toBeNull();
    expect(container.querySelector('.result-duration')).toBeNull();
    // Footer should be exactly "subtype · $cost" — no trailing orphan
    // separator after cost.
    expect(role!.textContent).toMatch(/^success\s*·\s*\$0\.0123$/);
  });

  test('accessible label lists all parts when duration is present', () => {
    renderResult(resultMsg({ durationMs: 2_400 }));
    const role = getRoleEl();
    expect(role!.getAttribute('aria-label')).toBe('turn metadata: success, $0.0123, 2.4s');
  });

  test('accessible label omits duration when absent', () => {
    renderResult(resultMsg({ durationMs: undefined }));
    const role = getRoleEl();
    expect(role!.getAttribute('aria-label')).toBe('turn metadata: success, $0.0123');
  });

  test('separator dots are aria-hidden', () => {
    renderResult(resultMsg({ durationMs: 100 }));
    const role = getRoleEl();
    const hiddenSeparators = role!.querySelectorAll('span[aria-hidden="true"]');
    // 2 separator dots when duration is present: between subtype/cost and
    // between cost/duration.
    expect(hiddenSeparators.length).toBe(2);
    for (const sep of hiddenSeparators) {
      expect(sep.textContent).toMatch(/·/);
    }
  });

  test('still renders error subtype + duration footer for failure result', () => {
    renderResult(resultMsg({ subtype: 'error_during_execution', durationMs: 1_200, cost: 0.5 }));
    const role = getRoleEl();
    expect(role!.textContent).toContain('error_during_execution');
    expect(role!.textContent).toContain('$0.5000');
    expect(role!.textContent).toContain('1.2s');
    // Result block carries the .err modifier so the border picks up --err.
    expect(container.querySelector('.msg.result.err')).not.toBeNull();
  });
});
