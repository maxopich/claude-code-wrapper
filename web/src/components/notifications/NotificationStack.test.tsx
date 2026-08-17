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

/**
 * Cebab-mbu. The mirror is cleared one rAF after it is written, so that a later
 * notification rendering to the SAME string is a real DOM change and therefore
 * a fresh announcement. The effect's cleanup used to cancel that frame — and
 * its deps (`state.visible`, `state.queued`) change on every push, dismissal
 * and auto-dismiss, so any of those arriving inside one frame cancelled the
 * clear. The mirror then kept the old string, the next identical text was a
 * no-op `setState`, React bailed out, and nothing was announced.
 *
 * The sequence below is the smallest deterministic reproduction: write, let
 * something else re-run the effect, flush the frame, write the same text again.
 * Real `requestAnimationFrame` is replaced by a queue these tests drain by
 * hand — jsdom has one, but a test that waits for a real frame would be timing-
 * dependent, and the whole defect is about what happens between two frames.
 */
describe('NotificationStack — identical text re-announces (Cebab-mbu)', () => {
  let pending: Map<number, FrameRequestCallback>;
  let nextFrameId: number;
  let cancelledIds: number[];

  beforeEach(() => {
    pending = new Map();
    nextFrameId = 1;
    cancelledIds = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = nextFrameId++;
      pending.set(id, cb);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      cancelledIds.push(id);
      pending.delete(id);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Run every queued frame callback, as the browser would at the next paint. */
  function flushFrames() {
    const due = [...pending.values()];
    pending.clear();
    act(() => {
      for (const cb of due) cb(0);
    });
  }

  test('a second notification with the same text announces again', () => {
    const actions: { push?: (n: NotificationEnvelope) => void } = {};
    act(() => {
      root.render(<Harness actionsRef={actions} />);
    });

    act(() => {
      actions.push?.(env({ id: 'first', title: 'Saved' }));
    });
    expect(regions().polite, 'the first push announces').toBe('Saved');

    // Anything that re-runs the effect before the frame lands. An error push
    // touches only the assertive region, so a polite region that changes here
    // would mean something other than this bug.
    act(() => {
      actions.push?.(env({ id: 'noise', severity: 'error', title: 'Unrelated' }));
    });

    flushFrames();
    // THE ASSERTION. Pre-fix the cleanup cancelled the clear when the effect
    // re-ran above, so the mirror still read 'Saved' here.
    expect(regions().polite, 'the mirror is cleared once the frame lands').toBe('');

    act(() => {
      actions.push?.(env({ id: 'second', title: 'Saved' }));
    });
    // '' -> 'Saved' is a real DOM change, which is what an aria-live region
    // announces. Pre-fix this was 'Saved' -> 'Saved': React bails out, the DOM
    // never changes, and a screen reader says nothing.
    expect(regions().polite, 'the identical text is announced a second time').toBe('Saved');
  });

  test('CONTROL: a DIFFERENT string announces whether or not the mirror was cleared', () => {
    // Without this, a component that never clears — or one that clears
    // everything on every render — could satisfy the test above by accident.
    // This case must pass against both the fix and the bug.
    const actions: { push?: (n: NotificationEnvelope) => void } = {};
    act(() => {
      root.render(<Harness actionsRef={actions} />);
    });
    act(() => {
      actions.push?.(env({ id: 'a', title: 'Saved' }));
    });
    act(() => {
      actions.push?.(env({ id: 'b', title: 'Something else' }));
    });
    expect(regions().polite).toBe('Something else');
  });

  test('CONTROL: a pending frame is still cancelled on unmount', () => {
    // The cleanup moved, it was not deleted. If it had simply been dropped this
    // passes only by accident of `pending` being empty, so assert the id that
    // was outstanding is the id that got cancelled.
    const actions: { push?: (n: NotificationEnvelope) => void } = {};
    act(() => {
      root.render(<Harness actionsRef={actions} />);
    });
    act(() => {
      actions.push?.(env({ id: 'x', title: 'Saved' }));
    });
    const outstanding = [...pending.keys()];
    expect(outstanding, 'a clear frame is genuinely pending').toHaveLength(1);

    act(() => {
      root.unmount();
    });
    expect(cancelledIds).toEqual(outstanding);

    // The shared afterEach unmounts again; re-create so it has a live root.
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
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
