// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ConnectionLostView } from '../../store';
import { ConnectionLostOverlay } from './ConnectionLostOverlay';

// Cluster G E3 UI: ConnectionLostOverlay tests pin:
//
//   1. Mount predicate (`view === undefined` → no mount).
//   2. Variant copy lookup per reason.
//   3. Retry button only shown for server_unreachable.
//   4. Esc dismisses (only while mounted).
//   5. Copy diagnostic calls navigator.clipboard with formatted text.
//   6. Auto-retry timer fires onRetry after backoff and bumps attempt.
//   7. Focus moves to primary action on mount.

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

function render(props: Parameters<typeof ConnectionLostOverlay>[0]) {
  act(() => {
    root.render(<ConnectionLostOverlay {...props} />);
  });
}

const view = (overrides: Partial<ConnectionLostView> = {}): ConnectionLostView => ({
  reason: 'unknown',
  diagnostic: { ts: 1_700_000_000_000 },
  ...overrides,
});

describe('ConnectionLostOverlay / mount predicate', () => {
  test('view=undefined → renders nothing', () => {
    render({ view: undefined, onDismiss: vi.fn() });
    expect(container.querySelector('.connection-lost-overlay')).toBeNull();
  });
  test('view defined → overlay + card mount', () => {
    render({ view: view(), onDismiss: vi.fn() });
    expect(container.querySelector('.connection-lost-overlay')).not.toBeNull();
    expect(container.querySelector('.connection-lost-card')).not.toBeNull();
  });
});

describe('ConnectionLostOverlay / variant copy', () => {
  test('origin_not_allowed renders origin-specific title + docs link', () => {
    render({ view: view({ reason: 'origin_not_allowed' }), onDismiss: vi.fn() });
    expect(container.querySelector('.connection-lost-title')?.textContent).toBe(
      'Origin not allowed',
    );
    expect(container.querySelector('.connection-lost-docs a')?.textContent).toBe(
      'Edit allowed origins',
    );
  });
  test('host_not_allowed renders host-specific title', () => {
    render({ view: view({ reason: 'host_not_allowed' }), onDismiss: vi.fn() });
    expect(container.querySelector('.connection-lost-title')?.textContent).toBe('Host not allowed');
  });
  test('auth_token_invalid renders auth-failed title with no docs link', () => {
    render({ view: view({ reason: 'auth_token_invalid' }), onDismiss: vi.fn() });
    expect(container.querySelector('.connection-lost-title')?.textContent).toBe(
      'Authentication failed',
    );
    expect(container.querySelector('.connection-lost-docs')).toBeNull();
  });
  test('server_unreachable renders unreachable title', () => {
    render({ view: view({ reason: 'server_unreachable' }), onDismiss: vi.fn(), onRetry: vi.fn() });
    expect(container.querySelector('.connection-lost-title')?.textContent).toBe(
      'Cebab server unreachable',
    );
  });
  test('unknown renders generic title', () => {
    render({ view: view({ reason: 'unknown' }), onDismiss: vi.fn() });
    expect(container.querySelector('.connection-lost-title')?.textContent).toBe(
      'Connection to Cebab failed',
    );
  });
});

describe('ConnectionLostOverlay / retry affordance', () => {
  test('server_unreachable + onRetry → Retry button rendered', () => {
    render({ view: view({ reason: 'server_unreachable' }), onDismiss: vi.fn(), onRetry: vi.fn() });
    const btns = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(btns.some((t) => t?.includes('Retry now'))).toBe(true);
  });
  test('origin_not_allowed → no Retry button (operator must fix the config first)', () => {
    render({ view: view({ reason: 'origin_not_allowed' }), onDismiss: vi.fn(), onRetry: vi.fn() });
    const btns = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(btns.some((t) => t?.includes('Retry now'))).toBe(false);
  });
  test('server_unreachable WITHOUT onRetry → no Retry button (host opted out)', () => {
    render({ view: view({ reason: 'server_unreachable' }), onDismiss: vi.fn() });
    const btns = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(btns.some((t) => t?.includes('Retry now'))).toBe(false);
  });
  test('Retry click invokes onRetry', () => {
    const onRetry = vi.fn();
    render({ view: view({ reason: 'server_unreachable' }), onDismiss: vi.fn(), onRetry });
    const retryBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('Retry now'),
    );
    act(() => {
      retryBtn?.click();
    });
    expect(onRetry).toHaveBeenCalled();
  });
});

describe('ConnectionLostOverlay / Esc dismiss', () => {
  test('Esc while mounted invokes onDismiss', () => {
    const onDismiss = vi.fn();
    render({ view: view(), onDismiss });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onDismiss).toHaveBeenCalled();
  });
  test('Esc while unmounted → no-op (listener not bound)', () => {
    const onDismiss = vi.fn();
    render({ view: undefined, onDismiss });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });
  test('non-Esc key → no-op', () => {
    const onDismiss = vi.fn();
    render({ view: view(), onDismiss });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe('ConnectionLostOverlay / dismiss button', () => {
  test('clicking Dismiss invokes onDismiss', () => {
    const onDismiss = vi.fn();
    render({ view: view(), onDismiss });
    const dismissBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.trim() === 'Dismiss',
    );
    act(() => {
      dismissBtn?.click();
    });
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe('ConnectionLostOverlay / Copy diagnostic', () => {
  test('Copy click writes formatted text to clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // Stub navigator.clipboard (jsdom doesn't have it by default).
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render({
      view: view({
        reason: 'origin_not_allowed',
        diagnostic: { ts: 1_700_000_000_000, rejectReason: 'origin_not_allowed' },
      }),
      onDismiss: vi.fn(),
    });
    const copyBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.trim() === 'Copy diagnostic',
    );
    act(() => {
      copyBtn?.click();
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0]?.[0] as string;
    expect(text).toContain('reason: origin_not_allowed');
    expect(text).toContain('reject_reason: origin_not_allowed');
  });
});

describe('ConnectionLostOverlay / auto-retry', () => {
  test('server_unreachable + onRetry → auto-fires after 2s backoff', () => {
    const onRetry = vi.fn();
    render({ view: view({ reason: 'server_unreachable' }), onDismiss: vi.fn(), onRetry });
    expect(onRetry).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('Retry button click resets the backoff anchor (next auto fires at the new backoff)', () => {
    const onRetry = vi.fn();
    render({ view: view({ reason: 'server_unreachable' }), onDismiss: vi.fn(), onRetry });
    // Half-elapse the first window then click Retry.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    const retryBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('Retry now'),
    );
    act(() => {
      retryBtn?.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    // Now we're at attempt=1 → next backoff is 4s. The remaining 1s of
    // the original window should NOT auto-fire (anchor was reset).
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    // After the full new window passes, it fires again.
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(onRetry).toHaveBeenCalledTimes(2);
  });
});

describe('ConnectionLostOverlay / a11y', () => {
  test('focus moves to the primary action on mount', () => {
    render({ view: view({ reason: 'server_unreachable' }), onDismiss: vi.fn(), onRetry: vi.fn() });
    const retryBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('Retry now'),
    );
    expect(document.activeElement).toBe(retryBtn);
  });

  test('non-retry variant → focus moves to Copy diagnostic (the primary affordance)', () => {
    render({ view: view({ reason: 'origin_not_allowed' }), onDismiss: vi.fn() });
    const copyBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.trim() === 'Copy diagnostic',
    );
    expect(document.activeElement).toBe(copyBtn);
  });

  test('card has role=alert and aria-live=assertive', () => {
    render({ view: view(), onDismiss: vi.fn() });
    const card = container.querySelector('.connection-lost-card');
    expect(card?.getAttribute('role')).toBe('alert');
    expect(card?.getAttribute('aria-live')).toBe('assertive');
  });
});
