import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import type { NotificationEnvelope } from '@cebab/shared/protocol';
import {
  initialNotificationsState,
  notificationsReducer,
  type NotificationsState,
} from './notificationsReducer';
import { isMuted } from './muteStore';

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

  /**
   * W05: the current state, mirrored so `dismiss` can read it without
   * *depending* on it. Same idiom as App.tsx's `stateRef`.
   *
   * The previous version read `state` from the closure and listed
   * `state.visible` / `state.queued` as `useCallback` deps. That read was
   * correct, and for the reason the old comment gave — `dismiss` is invoked
   * from event handlers, i.e. after render, so the captured arrays are
   * current. What it never weighed was the cost of the dependency that keeps
   * them current: every push rebuilds `visible` (even a dedupe hit does
   * `visible.slice()`), so `dismiss` got a new identity, so did the `actions`
   * memo below, so did the `onDismiss` prop each `<Notification>` receives —
   * and that prop is a dependency of its auto-dismiss timer effect. The
   * cleanup cleared the pending timeout and re-armed a FULL-LENGTH one, so
   * under any event stream faster than the 5s window no toast ever reached
   * its deadline. Reading through a ref keeps the read just as current and
   * costs nothing in identity.
   */
  const stateRef = useRef(state);
  stateRef.current = state;

  const push = useCallback((n: NotificationEnvelope) => {
    // Cluster A Phase 5: display-side mute. The server still persists
    // every sticky-operational / safety row to the inbox regardless of
    // client mute state — silencing here only suppresses the toast.
    // The inbox panel always shows all rows (a forgotten mute should
    // not hide history). `isMuted` already guards against muting
    // error/danger; defense-in-depth is in the helper.
    if (isMuted(n)) return;
    dispatch({ type: 'push', n, now: Date.now() });
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      // Look up before dispatching so we can read sticky off the envelope.
      // The reducer removes it on dispatch; we capture the metadata first.
      // Read through `stateRef` (see above) so this callback's identity does
      // not churn with every push.
      const current = stateRef.current;
      const target =
        current.visible.find((v) => v.id === id) ?? current.queued.find((q) => q.id === id);
      if (target && target.sticky && onAck) {
        try {
          onAck(id);
        } catch (err) {
          console.error('[notifications] onAck threw', err);
        }
      }
      dispatch({ type: 'dismiss', id });
    },
    [onAck],
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
