import { createContext, useCallback, useContext, useMemo, useReducer, type ReactNode } from 'react';
import type { NotificationEnvelope } from '@cebab/shared/protocol';
import {
  initialNotificationsState,
  notificationsReducer,
  type NotificationsState,
} from './notificationsReducer';

/**
 * Cluster A Phase 2: context for the notification dock.
 *
 * The provider owns the reducer state; consumers get either the current
 * visible/queued lists (`useNotificationsState`) or a stable `push` /
 * `dismiss` pair (`useNotificationsActions`). The split keeps the host
 * (which re-renders on every state change) from forcing rerenders on the
 * App.tsx call sites that only ever fire actions.
 *
 * `onAck` is a one-way escape hatch: when the user dismisses a notification
 * whose envelope expects server acknowledgment (currently: sticky), the
 * provider invokes the callback so App.tsx can send `ack_notification`
 * over the WS. The context itself is WS-agnostic — keeps this file
 * unit-testable without a live socket.
 */

type ActionsValue = {
  push: (n: NotificationEnvelope) => void;
  dismiss: (id: string) => void;
};

const StateCtx = createContext<NotificationsState | null>(null);
const ActionsCtx = createContext<ActionsValue | null>(null);

export type NotificationsProviderProps = {
  children: ReactNode;
  /**
   * Invoked when a sticky notification is dismissed. The provider has no
   * direct WS coupling; this callback is where `ack_notification` flows.
   * Non-sticky dismisses do not invoke this — they're transient.
   */
  onAck?: (id: string, ackReason?: string) => void;
};

export function NotificationsProvider({ children, onAck }: NotificationsProviderProps) {
  const [state, dispatch] = useReducer(notificationsReducer, initialNotificationsState);

  const push = useCallback((n: NotificationEnvelope) => {
    dispatch({ type: 'push', n, now: Date.now() });
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      // Look up before dispatching so we can read sticky off the envelope.
      // The reducer removes it on dispatch; we capture the metadata first.
      // We intentionally re-read state via a closure capture rather than via
      // a ref — React batches dispatch/effect, and reading `state` here is
      // fine for this single read because dismiss is invoked from event
      // handlers (post-render).
      const target =
        state.visible.find((v) => v.id === id) ?? state.queued.find((q) => q.id === id);
      if (target && target.sticky && onAck) {
        try {
          onAck(id);
        } catch (err) {
          console.error('[notifications] onAck threw', err);
        }
      }
      dispatch({ type: 'dismiss', id });
    },
    [onAck, state.visible, state.queued],
  );

  const actions = useMemo<ActionsValue>(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <StateCtx.Provider value={state}>
      <ActionsCtx.Provider value={actions}>{children}</ActionsCtx.Provider>
    </StateCtx.Provider>
  );
}

export function useNotificationsState(): NotificationsState {
  const ctx = useContext(StateCtx);
  if (!ctx) throw new Error('useNotificationsState requires <NotificationsProvider>');
  return ctx;
}

export function useNotificationsActions(): ActionsValue {
  const ctx = useContext(ActionsCtx);
  if (!ctx) throw new Error('useNotificationsActions requires <NotificationsProvider>');
  return ctx;
}

/** Re-export for component callers so they don't need a second import. */
export type { DisplayNotification } from './notificationsReducer';
