// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ConnectionLostView } from '../../store';
import { INERT_EXEMPT_ATTR } from '../../useModalSurface';
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

/**
 * W07 — the ladder must climb across repeat failures.
 *
 * The reset used to key on the `view` OBJECT. `case 'connection_lost'` always
 * stores a fresh literal, and App.tsx's `/auth-token` non-OK branch dispatches
 * unguarded (unlike its fetch-threw branch, which checks the existing slice
 * first). `resolveFromAuthTokenResponse` maps a 502/504 to
 * `server_unreachable`, so a stale proxy produced a new view object on every
 * attempt, reset the counter, and pinned the 2/4/8/15/30s ladder at 2s —
 * hammering a server that was already struggling.
 *
 * Each re-render below passes a brand-new object with a fresh `ts`, which is
 * what the reducer really hands over.
 */
describe('ConnectionLostOverlay / backoff across repeat failures (W07)', () => {
  const unreachable = (ts: number) => view({ reason: 'server_unreachable', diagnostic: { ts } });

  test('a repeat of the same failure advances the ladder instead of restarting it', () => {
    const onRetry = vi.fn();
    render({ view: unreachable(1), onDismiss: vi.fn(), onRetry });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(onRetry).toHaveBeenCalledTimes(1);

    // The retry failed the same way: a NEW object, same reason.
    render({ view: unreachable(2), onDismiss: vi.fn(), onRetry });
    // Before the fix this reset to attempt 0 and fired again at 2s.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  test('CONTROL: a genuinely different failure resets the ladder to 2s', () => {
    const onRetry = vi.fn();
    render({ view: unreachable(1), onDismiss: vi.fn(), onRetry });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    // A different reason is a different episode — and `unknown` does not
    // auto-retry at all, so route back through unreachable to observe the
    // window rather than its absence.
    render({ view: view({ reason: 'unknown' }), onDismiss: vi.fn(), onRetry });
    render({ view: unreachable(3), onDismiss: vi.fn(), onRetry });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  test('CONTROL: dismiss-then-fail restarts at the first window', () => {
    const onRetry = vi.fn();
    render({ view: unreachable(1), onDismiss: vi.fn(), onRetry });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    // The operator dismissed; the slice clears, the dep passes through
    // undefined, and the next failure is a fresh episode.
    render({ view: undefined, onDismiss: vi.fn(), onRetry });
    render({ view: unreachable(4), onDismiss: vi.fn(), onRetry });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  test('the ladder keeps climbing: 2s, 4s, 8s across three repeat failures', () => {
    const onRetry = vi.fn();
    render({ view: unreachable(1), onDismiss: vi.fn(), onRetry });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    render({ view: unreachable(2), onDismiss: vi.fn(), onRetry });
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(onRetry).toHaveBeenCalledTimes(2);
    render({ view: unreachable(3), onDismiss: vi.fn(), onRetry });
    act(() => {
      vi.advanceTimersByTime(7999);
    });
    expect(onRetry).toHaveBeenCalledTimes(2);
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(onRetry).toHaveBeenCalledTimes(3);
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

  // U27 moved the alert region DOWN a level: it used to be the whole card,
  // which meant the ticking countdown in the Retry label re-announced the
  // title, body and every button once a second (`role="alert"` implies
  // `aria-atomic="true"`, so the region is re-read in full on any change).
  // It is now the title + body, which are static for the overlay's life.
  test('the message — not the card — is the assertive alert region', () => {
    render({ view: view(), onDismiss: vi.fn() });
    const card = container.querySelector('.connection-lost-card');
    expect(card?.getAttribute('role')).toBeNull();
    expect(card?.getAttribute('aria-live')).toBeNull();

    const message = container.querySelector('.connection-lost-message');
    expect(message).not.toBeNull();
    expect(message?.getAttribute('role')).toBe('alert');
    expect(message?.getAttribute('aria-live')).toBe('assertive');
    // The announcement still carries the failure — scoping it must not have
    // emptied it.
    expect(message?.textContent).toContain('Connection to Cebab failed');
  });

  test('the actions sit outside the alert region', () => {
    render({ view: view({ reason: 'server_unreachable' }), onRetry: vi.fn(), onDismiss: vi.fn() });
    const message = container.querySelector('.connection-lost-message')!;
    expect(message.querySelectorAll('button')).toHaveLength(0);
    // ...and are still on screen, i.e. they moved out rather than vanished.
    expect(container.querySelectorAll('.connection-lost-actions button').length).toBeGreaterThan(2);
  });

  test('the overlay is exempt from a modal focus trap (U28)', () => {
    // `useModalSurface` inerts every sibling of an open modal, and this
    // overlay is one. Without the exemption, opening any dialog while the
    // connection is down kills Retry / Copy diagnostic / Dismiss outright.
    render({ view: view(), onDismiss: vi.fn() });
    const overlay = container.querySelector('.connection-lost-overlay');
    expect(overlay?.hasAttribute(INERT_EXEMPT_ATTR)).toBe(true);
  });
});
