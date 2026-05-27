// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { Notification } from './Notification';
import type { DisplayNotification } from './notificationsReducer';

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

function makeNotification(overrides: Partial<DisplayNotification> = {}): DisplayNotification {
  return {
    id: 'n1',
    ts: 1000,
    severity: 'info',
    class: 'operational',
    dedupeKey: 'k1',
    title: 'Hello',
    sticky: false,
    count: 1,
    receivedAt: 1000,
    ...overrides,
  };
}

describe('Notification — UI-7 glyph + tier label', () => {
  test('renders both the SVG glyph AND a tier label (never color-only)', () => {
    const n = makeNotification({ severity: 'warn' });
    act(() => {
      root.render(<Notification notification={n} onDismiss={() => {}} />);
    });
    const svg = container.querySelector('.notif-glyph svg');
    const label = container.querySelector('.notif-tier-label');
    expect(svg).not.toBeNull();
    expect(label?.textContent).toBe('Warning');
  });

  test('renders count badge when count > 1 (UI-9)', () => {
    const n = makeNotification({ count: 7 });
    act(() => {
      root.render(<Notification notification={n} onDismiss={() => {}} />);
    });
    const badge = container.querySelector('.notif-count');
    expect(badge?.textContent).toBe('×7');
  });

  test('omits count badge when count is 1', () => {
    act(() => {
      root.render(<Notification notification={makeNotification()} onDismiss={() => {}} />);
    });
    expect(container.querySelector('.notif-count')).toBeNull();
  });
});

describe('Notification — UI-12 keyboard dismiss', () => {
  test('Escape on a focused (action-bearing) toast invokes onDismiss', () => {
    const onDismiss = vi.fn();
    const n = makeNotification({
      action: { kind: 'open_settings' },
    });
    act(() => {
      root.render(<Notification notification={n} onDismiss={onDismiss} />);
    });
    const host = container.querySelector('.notif') as HTMLElement;
    expect(host.getAttribute('tabindex')).toBe('0');
    act(() => {
      host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledWith('n1');
  });

  test('toast without actions has tabindex=-1 (UI-11 — not in natural tab order)', () => {
    act(() => {
      root.render(<Notification notification={makeNotification()} onDismiss={() => {}} />);
    });
    const host = container.querySelector('.notif') as HTMLElement;
    expect(host.getAttribute('tabindex')).toBe('-1');
  });
});

describe('Notification — close button + action click', () => {
  test('close button click invokes onDismiss', () => {
    const onDismiss = vi.fn();
    act(() => {
      root.render(<Notification notification={makeNotification()} onDismiss={onDismiss} />);
    });
    const close = container.querySelector('.notif-close') as HTMLButtonElement;
    act(() => close.click());
    expect(onDismiss).toHaveBeenCalledWith('n1');
  });

  test('action click invokes both onAction and onDismiss', () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    const n = makeNotification({ action: { kind: 'open_settings' } });
    act(() => {
      root.render(<Notification notification={n} onDismiss={onDismiss} onAction={onAction} />);
    });
    const btn = container.querySelector('.notif-action-btn') as HTMLButtonElement;
    expect(btn.textContent).toBe('Open settings');
    act(() => btn.click());
    expect(onAction).toHaveBeenCalledWith({ kind: 'open_settings' }, n);
    expect(onDismiss).toHaveBeenCalledWith('n1');
  });
});

describe('Notification — auto-dismiss timer', () => {
  test('info with no action auto-dismisses after 5s', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    act(() => {
      root.render(
        <Notification notification={makeNotification({ severity: 'info' })} onDismiss={onDismiss} />,
      );
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(onDismiss).toHaveBeenCalledWith('n1');
  });

  test('info WITH action uses the 8s extended window', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    act(() => {
      root.render(
        <Notification
          notification={makeNotification({ severity: 'info', action: { kind: 'open_settings' } })}
          onDismiss={onDismiss}
        />,
      );
    });
    act(() => {
      vi.advanceTimersByTime(5500);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(onDismiss).toHaveBeenCalled();
  });

  test('error / danger never auto-dismiss', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    act(() => {
      root.render(
        <Notification
          notification={makeNotification({ severity: 'danger' })}
          onDismiss={onDismiss}
        />,
      );
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test('sticky overrides severity defaults', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    act(() => {
      root.render(
        <Notification
          notification={makeNotification({ severity: 'info', sticky: true })}
          onDismiss={onDismiss}
        />,
      );
    });
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe('Notification — aria role mapping (UX-7)', () => {
  test('danger uses role=alertdialog', () => {
    act(() => {
      root.render(
        <Notification
          notification={makeNotification({ severity: 'danger' })}
          onDismiss={() => {}}
        />,
      );
    });
    expect(container.querySelector('.notif')?.getAttribute('role')).toBe('alertdialog');
  });

  test('error uses role=alert', () => {
    act(() => {
      root.render(
        <Notification
          notification={makeNotification({ severity: 'error' })}
          onDismiss={() => {}}
        />,
      );
    });
    expect(container.querySelector('.notif')?.getAttribute('role')).toBe('alert');
  });

  test('info uses role=status', () => {
    act(() => {
      root.render(<Notification notification={makeNotification()} onDismiss={() => {}} />);
    });
    expect(container.querySelector('.notif')?.getAttribute('role')).toBe('status');
  });
});
