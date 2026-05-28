// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ClientMsg } from '@cebab/shared/protocol';
import { RecoveryLogProvider } from './RecoveryLogContext';
import { RecoveryLogButton } from './RecoveryLogButton';

/**
 * Cluster D Phase 8b: RecoveryLogButton tests.
 *
 * Mirrors NotificationBell.test.tsx structure. Coverage:
 *   - mounts as a button with the expected aria-label
 *   - click toggles the popover open/closed
 *   - opening fires get_recovery_log_snapshot (and the inspector
 *     itself adds a second on mount, so total 2 messages per open)
 *   - Esc closes the popover and returns focus to the button
 *   - outside-click closes the popover
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

function mount(sent: ClientMsg[]) {
  act(() => {
    root.render(
      <RecoveryLogProvider send={(m) => sent.push(m)}>
        <RecoveryLogButton />
      </RecoveryLogProvider>,
    );
  });
}

function getButton(): HTMLButtonElement {
  const btn = container.querySelector('button.recovery-log-btn') as HTMLButtonElement | null;
  if (!btn) throw new Error('button not found');
  return btn;
}

describe('RecoveryLogButton', () => {
  test('renders a button with aria-label and no popover initially', () => {
    const sent: ClientMsg[] = [];
    mount(sent);
    const btn = getButton();
    expect(btn.getAttribute('aria-label')).toBe('Recovery activity');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.recovery-log-popover')).toBeNull();
    expect(sent).toEqual([]);
  });

  test('click opens the popover + fires snapshot requests', () => {
    const sent: ClientMsg[] = [];
    mount(sent);
    const btn = getButton();
    act(() => {
      btn.click();
    });
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.recovery-log-popover')).not.toBeNull();
    // Button's openPanel + inspector's mount effect both fire once.
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent.every((m) => m.type === 'get_recovery_log_snapshot')).toBe(true);
  });

  test('clicking again closes the popover', () => {
    const sent: ClientMsg[] = [];
    mount(sent);
    const btn = getButton();
    act(() => {
      btn.click();
    });
    expect(container.querySelector('.recovery-log-popover')).not.toBeNull();
    act(() => {
      btn.click();
    });
    expect(container.querySelector('.recovery-log-popover')).toBeNull();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  test('Escape closes the popover and returns focus to the button', () => {
    const sent: ClientMsg[] = [];
    mount(sent);
    const btn = getButton();
    act(() => {
      btn.click();
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container.querySelector('.recovery-log-popover')).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  test('outside pointerdown closes the popover', () => {
    const sent: ClientMsg[] = [];
    mount(sent);
    const btn = getButton();
    act(() => {
      btn.click();
    });
    // Click outside both the button and the popover.
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    act(() => {
      outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(container.querySelector('.recovery-log-popover')).toBeNull();
    outside.remove();
  });

  test('Escape is a no-op while popover is closed', () => {
    const sent: ClientMsg[] = [];
    mount(sent);
    // Esc fires but no popover is open — must not throw.
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container.querySelector('.recovery-log-popover')).toBeNull();
  });
});
