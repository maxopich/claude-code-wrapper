// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { NotificationEnvelope } from '@cebab/shared/protocol';
import { NotificationStack } from './NotificationStack';
import {
  NotificationsProvider,
  useNotificationsActions,
  useNotificationsState,
} from './NotificationsContext';

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

/** Test helper that exposes the actions to the test scope via a side-effect ref. */
function Harness({
  actionsRef,
  onAck,
}: {
  actionsRef: { push?: (n: NotificationEnvelope) => void; dismiss?: (id: string) => void };
  onAck?: (id: string, reason?: string) => void;
}) {
  return (
    <NotificationsProvider onAck={onAck}>
      <Capture actionsRef={actionsRef} />
      <NotificationStack />
    </NotificationsProvider>
  );
}

function Capture({
  actionsRef,
}: {
  actionsRef: { push?: (n: NotificationEnvelope) => void; dismiss?: (id: string) => void };
}) {
  const { push, dismiss } = useNotificationsActions();
  actionsRef.push = push;
  actionsRef.dismiss = dismiss;
  return null;
}

function StateCapture({
  stateRef,
}: {
  stateRef: { state?: ReturnType<typeof useNotificationsState> };
}) {
  stateRef.state = useNotificationsState();
  return null;
}

function env(overrides: Partial<NotificationEnvelope> & { id: string }): NotificationEnvelope {
  return {
    ts: 0,
    severity: 'info',
    class: 'operational',
    dedupeKey: overrides.id,
    title: overrides.title ?? 't',
    sticky: false,
    ...overrides,
  };
}

describe('NotificationStack — host scaffolding', () => {
  test('UI-1/UI-2: empty queue renders region scaffolding only — no .notif children', () => {
    const actions = {};
    act(() => {
      root.render(<Harness actionsRef={actions} />);
    });
    const region = container.querySelector('.notif-stack');
    expect(region).not.toBeNull();
    expect(region?.getAttribute('role')).toBe('region');
    expect(region?.getAttribute('aria-label')).toBe('Notifications');
    expect(region?.getAttribute('data-empty')).toBe('true');
    expect(container.querySelectorAll('.notif')).toHaveLength(0);
  });

  test('pushed envelope renders a toast', () => {
    const actions: { push?: (n: NotificationEnvelope) => void } = {};
    act(() => {
      root.render(<Harness actionsRef={actions} />);
    });
    act(() => {
      actions.push?.(env({ id: 'a', title: 'Hi' }));
    });
    expect(container.querySelectorAll('.notif')).toHaveLength(1);
    expect(container.querySelector('.notif-title')?.textContent).toBe('Hi');
    expect(container.querySelector('.notif-stack')?.getAttribute('data-empty')).toBe('false');
  });
});

/**
 * W06. Until this block existed, the whole of "live regions" was the
 * scaffolding test below: it asserted the two `<div>`s were in the DOM and
 * carried `sr-only`, and stopped. **Nothing had ever asserted that anything
 * was announced**, which is how the effect shipped setting the polite region,
 * returning, and leaving `assertiveText` unwritten for an error that arrived
 * in the same commit — while the loop above had already marked that error
 * announced, so no later render retried it. The urgent tier was the dropped
 * one.
 *
 * Reachability, stated honestly: two un-announced notifications must reach one
 * render, which needs two `push` calls in a single synchronous block. Every
 * production call site (App.tsx, `notifyFromServerMsg`) pushes once, and each
 * WS message is its own task, so no production path was found. `act()` batches
 * them, which is what these tests use. The fix is for the trap, and the tests
 * are for the hole that hid it.
 */
function regions() {
  return {
    polite: container.querySelector('.notif-stack > [aria-live="polite"]')?.textContent ?? null,
    assertive:
      container.querySelector('.notif-stack > [aria-live="assertive"]')?.textContent ?? null,
  };
}

describe('NotificationStack — sr-only live regions (UI-10)', () => {
  test('polite region scaffolding always present', () => {
    act(() => {
      root.render(<Harness actionsRef={{}} />);
    });
    const polite = container.querySelector('.notif-stack > [aria-live="polite"]');
    const assertive = container.querySelector('.notif-stack > [aria-live="assertive"]');
    expect(polite).not.toBeNull();
    expect(assertive).not.toBeNull();
    expect(polite?.classList.contains('sr-only')).toBe(true);
    expect(assertive?.classList.contains('sr-only')).toBe(true);
  });

  test('CONTROL: an info push announces politely, and only politely', () => {
    const actions: { push?: (n: NotificationEnvelope) => void } = {};
    act(() => {
      root.render(<Harness actionsRef={actions} />);
    });
    act(() => {
      actions.push?.(env({ id: 'i', severity: 'info', title: 'Saved', message: 'All good' }));
    });
    expect(regions()).toEqual({ polite: 'Saved. All good', assertive: '' });
  });

  test('CONTROL: an error push announces assertively, and only assertively', () => {
    // Paired with the case above so the W06 test cannot be satisfied by a
    // component that writes every announcement into both regions.
    const actions: { push?: (n: NotificationEnvelope) => void } = {};
    act(() => {
      root.render(<Harness actionsRef={actions} />);
    });
    act(() => {
      actions.push?.(env({ id: 'e', severity: 'error', title: 'Server error' }));
    });
    expect(regions()).toEqual({ polite: '', assertive: 'Server error' });
  });

  test('W06: an error arriving with an info still reaches the assertive region', () => {
    const actions: { push?: (n: NotificationEnvelope) => void } = {};
    act(() => {
      root.render(<Harness actionsRef={actions} />);
    });
    act(() => {
      // One `act`, so both reducer dispatches land in one commit and the
      // effect sees two un-announced notifications of different tiers.
      actions.push?.(env({ id: 'i', severity: 'info', title: 'Saved' }));
      actions.push?.(env({ id: 'e', severity: 'error', title: 'Server error' }));
    });
    expect(regions()).toEqual({ polite: 'Saved', assertive: 'Server error' });
  });
});

describe('NotificationStack — onAck wiring (BE-6 client side)', () => {
  test('dismissing a sticky notification invokes onAck with the envelope id', () => {
    const actions: { push?: (n: NotificationEnvelope) => void; dismiss?: (id: string) => void } =
      {};
    const onAck = vi.fn();
    act(() => {
      root.render(<Harness actionsRef={actions} onAck={onAck} />);
    });
    act(() => {
      actions.push?.(env({ id: 'sticky-1', sticky: true, severity: 'warn' }));
    });
    act(() => {
      actions.dismiss?.('sticky-1');
    });
    expect(onAck).toHaveBeenCalledWith('sticky-1');
  });

  test('dismissing a non-sticky notification does NOT invoke onAck', () => {
    const actions: { push?: (n: NotificationEnvelope) => void; dismiss?: (id: string) => void } =
      {};
    const onAck = vi.fn();
    act(() => {
      root.render(<Harness actionsRef={actions} onAck={onAck} />);
    });
    act(() => {
      actions.push?.(env({ id: 'transient-1' }));
    });
    act(() => {
      actions.dismiss?.('transient-1');
    });
    expect(onAck).not.toHaveBeenCalled();
  });
});

describe('NotificationStack — reducer integration via context', () => {
  test('coalesce in-place updates the visible toast count badge', () => {
    const actions: { push?: (n: NotificationEnvelope) => void } = {};
    const stateCapture: { state?: ReturnType<typeof useNotificationsState> } = {};
    act(() => {
      root.render(
        <NotificationsProvider>
          <Capture actionsRef={actions} />
          <StateCapture stateRef={stateCapture} />
          <NotificationStack />
        </NotificationsProvider>,
      );
    });
    act(() => {
      actions.push?.(env({ id: 'a', dedupeKey: 'same' }));
    });
    act(() => {
      actions.push?.(env({ id: 'b-ignored', dedupeKey: 'same' }));
    });
    act(() => {
      actions.push?.(env({ id: 'c-ignored', dedupeKey: 'same' }));
    });
    expect(container.querySelectorAll('.notif')).toHaveLength(1);
    expect(container.querySelector('.notif-count')?.textContent).toBe('×3');
    expect(stateCapture.state?.visible).toHaveLength(1);
  });
});
