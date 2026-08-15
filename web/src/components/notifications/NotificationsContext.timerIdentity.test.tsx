// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { NotificationEnvelope } from '@cebab/shared/protocol';
import { NotificationStack } from './NotificationStack';
import { NotificationsProvider, useNotificationsActions } from './NotificationsContext';

/**
 * W05 — the toast dock's auto-dismiss timer must survive a stream of pushes.
 *
 * `dismiss` used to list `state.visible` / `state.queued` as `useCallback`
 * dependencies. Every push rebuilds those arrays (even a dedupe hit does
 * `visible.slice()`), so `dismiss` churned identity, so did the `actions`
 * memo, so did the `onDismiss` prop each `<Notification>` receives — and that
 * prop is a dependency of its auto-dismiss timer effect, whose cleanup clears
 * the pending timeout and re-arms a FULL-LENGTH one. Under any event stream
 * faster than the 5s info window, no toast ever reached its deadline.
 *
 * Every refusal below is paired with a control, because "the toast is gone at
 * 5s" and "the toast is still there at 4s" are both producible by more than
 * one mechanism — a frozen timer effect would satisfy the headline assertion
 * and break everything else. The controls are what separate "identity is
 * stable" from "timers no longer work".
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
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

type Actions = {
  push?: (n: NotificationEnvelope) => void;
  dismiss?: (id: string) => void;
  /** Every `dismiss` identity this render pass has seen, in order. */
  dismissSeen: unknown[];
};

function Capture({ actions }: { actions: Actions }) {
  const { push, dismiss } = useNotificationsActions();
  actions.push = push;
  if (actions.dismiss !== dismiss) actions.dismissSeen.push(dismiss);
  actions.dismiss = dismiss;
  return null;
}

function Harness({
  actions,
  onAck,
}: {
  actions: Actions;
  onAck?: (id: string, reason?: string) => void;
}) {
  return (
    <NotificationsProvider onAck={onAck}>
      <Capture actions={actions} />
      <NotificationStack />
    </NotificationsProvider>
  );
}

function mount(onAck?: (id: string, reason?: string) => void): Actions {
  const actions: Actions = { dismissSeen: [] };
  act(() => {
    root.render(<Harness actions={actions} onAck={onAck} />);
  });
  return actions;
}

function env(overrides: Partial<NotificationEnvelope> & { id: string }): NotificationEnvelope {
  return {
    ts: 0,
    severity: 'info',
    class: 'operational',
    dedupeKey: overrides.id,
    title: overrides.id,
    sticky: false,
    ...overrides,
  };
}

function titles(): string[] {
  return [...container.querySelectorAll('.notif-title')].map((n) => n.textContent ?? '');
}

describe('NotificationsContext — dismiss identity (W05)', () => {
  test('a toast still auto-dismisses at its own deadline while pushes keep arriving', () => {
    const actions = mount();
    act(() => actions.push?.(env({ id: 'first' })));
    expect(titles()).toContain('first');

    // A push every 2s. Before the fix each one re-armed `first`'s 5s timer,
    // so it survived indefinitely. MAX_VISIBLE is 4 and info toasts are
    // evictable, so these ids stay under the cap for the window measured.
    act(() => {
      vi.advanceTimersByTime(2000);
      actions.push?.(env({ id: 'noise-1' }));
    });
    act(() => {
      vi.advanceTimersByTime(2000);
      actions.push?.(env({ id: 'noise-2' }));
    });
    expect(titles()).toContain('first');

    // 5s after `first` arrived, it goes — regardless of the traffic since.
    act(() => vi.advanceTimersByTime(1000));
    expect(titles()).not.toContain('first');
    // ...and only it: the later toasts have not reached their own deadlines.
    expect(titles()).toContain('noise-2');
  });

  test('CONTROL: with no other traffic the same toast dismisses at 5s', () => {
    const actions = mount();
    act(() => actions.push?.(env({ id: 'lonely' })));
    act(() => vi.advanceTimersByTime(4999));
    expect(titles()).toContain('lonely');
    act(() => vi.advanceTimersByTime(2));
    expect(titles()).not.toContain('lonely');
  });

  test('`dismiss` keeps one identity across pushes', () => {
    const actions = mount();
    expect(actions.dismissSeen).toHaveLength(1);
    act(() => actions.push?.(env({ id: 'a' })));
    act(() => actions.push?.(env({ id: 'b' })));
    // A dedupe hit re-slices `visible` too — the case that made "push a
    // repeat" churn identity just as hard as a novel notification.
    act(() => actions.push?.(env({ id: 'a' })));
    expect(actions.dismissSeen).toHaveLength(1);
  });

  test('CONTROL: the timer still re-arms when the toast itself changes state', () => {
    const actions = mount();
    act(() => actions.push?.(env({ id: 'hovered' })));
    act(() => vi.advanceTimersByTime(4000));
    // Hover pauses; leaving re-arms a full window. If the effect had been
    // frozen (deps that never change) this would dismiss at 5s anyway.
    const toast = container.querySelector('.notif') as HTMLElement;
    act(() => toast.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    act(() => vi.advanceTimersByTime(4000));
    expect(titles()).toContain('hovered');
    act(() => toast.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
    act(() => vi.advanceTimersByTime(4999));
    expect(titles()).toContain('hovered');
    act(() => vi.advanceTimersByTime(2));
    expect(titles()).not.toContain('hovered');
  });

  test('CONTROL: dismiss reads live state — a sticky pushed after mount still acks', () => {
    const onAck = vi.fn();
    const actions = mount(onAck);
    // Pushed AFTER the provider mounted, so a `dismiss` that closed over the
    // initial (empty) state instead of reading through the ref would find no
    // target and silently skip the ack.
    act(() => actions.push?.(env({ id: 'sticky-1', sticky: true, severity: 'warn' })));
    act(() => actions.dismiss?.('sticky-1'));
    expect(onAck).toHaveBeenCalledWith('sticky-1');
  });

  test('CONTROL: dismiss reads live state — a queued sticky acks too', () => {
    const onAck = vi.fn();
    const actions = mount(onAck);
    // Fill every visible slot with non-evictable toasts so the next push is
    // queued rather than visible; `dismiss` must find it in `queued`.
    act(() => {
      for (let i = 0; i < 4; i++) actions.push?.(env({ id: `err-${i}`, severity: 'error' }));
      actions.push?.(env({ id: 'queued-sticky', severity: 'error', sticky: true }));
    });
    expect(titles()).not.toContain('queued-sticky');
    act(() => actions.dismiss?.('queued-sticky'));
    expect(onAck).toHaveBeenCalledWith('queued-sticky');
  });
});
