import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import type { ClientMsg, NotificationEnvelope, ServerMsg } from '@cebab/shared/protocol';

/**
 * Cluster A Phase 5: context for the notification inbox panel.
 *
 * Mirrors the Phase 2 NotificationsContext split (state vs actions) so
 * the bell badge (which subscribes only to `useInboxState`) doesn't
 * rerender on action-fn identity churn, and so the inbox-action call
 * sites in App.tsx don't fire the bell.
 *
 * The provider owns the latest snapshot state (rows + per-session
 * unacked counts + total). New `inbox_snapshot` messages arrive via the
 * `handlerRef` bridge — App.tsx's WS onMessage calls
 * `handlerRef.current?.(msg)` after the main reducer dispatch (same
 * pattern as `notifPushRef`/`notifDismissRef` from Phase 2).
 *
 * `send` is the bridge to ClientMsgs (`request_inbox_snapshot` for
 * filtered queries when the operator interacts with chips,
 * `clear_dismissed_inbox` for the bulk-ack button).
 */

/**
 * Extract the inbox-filter shape from the protocol so we don't have to
 * duplicate it. Keeps types in sync with the server contract.
 */
export type InboxFilters = NonNullable<
  Extract<ClientMsg, { type: 'request_inbox_snapshot' }>['filters']
>;

export type InboxState = {
  rows: NotificationEnvelope[];
  unackedCountBySession: Record<string, number>;
  unackedGlobal: number;
  /**
   * False until the first `inbox_snapshot` lands. Lets the panel render
   * a skeleton state rather than "no notifications" flashing on first
   * paint.
   */
  loaded: boolean;
};

type InboxAction = {
  type: 'snapshot';
  rows: NotificationEnvelope[];
  unackedCountBySession: Record<string, number>;
  unackedGlobal: number;
};

export const initialInboxState: InboxState = {
  rows: [],
  unackedCountBySession: {},
  unackedGlobal: 0,
  loaded: false,
};

export function inboxReducer(state: InboxState, action: InboxAction): InboxState {
  switch (action.type) {
    case 'snapshot':
      return {
        rows: action.rows,
        unackedCountBySession: action.unackedCountBySession,
        unackedGlobal: action.unackedGlobal,
        loaded: true,
      };
  }
}

export type InboxActions = {
  /** Re-request from the server with optional filters. */
  requestSnapshot: (filters?: InboxFilters) => void;
  /** Bulk-ack operational rows (safety untouched). Server replies with a fresh snapshot. */
  clearDismissed: () => void;
};

const StateCtx = createContext<InboxState | null>(null);
const ActionsCtx = createContext<InboxActions | null>(null);

export type InboxProviderProps = {
  children: ReactNode;
  /** ClientMsg sink (WS adapter). */
  send: (msg: ClientMsg) => void;
  /**
   * Bridge so App.tsx can route `inbox_snapshot` ServerMsgs into the
   * provider's reducer without prop-drilling. Provider populates the
   * ref on mount, clears on unmount.
   */
  handlerRef?: MutableRefObject<((msg: ServerMsg) => void) | null>;
};

export function InboxProvider({ children, send, handlerRef }: InboxProviderProps) {
  const [state, dispatch] = useReducer(inboxReducer, initialInboxState);

  const handleServerMsg = useCallback((msg: ServerMsg) => {
    if (msg.type !== 'inbox_snapshot') return;
    dispatch({
      type: 'snapshot',
      rows: msg.rows,
      unackedCountBySession: msg.unackedCountBySession,
      unackedGlobal: msg.unackedGlobal,
    });
  }, []);

  useEffect(() => {
    if (!handlerRef) return;
    handlerRef.current = handleServerMsg;
    return () => {
      handlerRef.current = null;
    };
  }, [handleServerMsg, handlerRef]);

  const actions = useMemo<InboxActions>(
    () => ({
      requestSnapshot: (filters?: InboxFilters) => {
        send({ type: 'request_inbox_snapshot', filters });
      },
      clearDismissed: () => {
        send({ type: 'clear_dismissed_inbox' });
      },
    }),
    [send],
  );

  return (
    <StateCtx.Provider value={state}>
      <ActionsCtx.Provider value={actions}>{children}</ActionsCtx.Provider>
    </StateCtx.Provider>
  );
}

export function useInboxState(): InboxState {
  const ctx = useContext(StateCtx);
  if (!ctx) throw new Error('useInboxState requires <InboxProvider>');
  return ctx;
}

export function useInboxActions(): InboxActions {
  const ctx = useContext(ActionsCtx);
  if (!ctx) throw new Error('useInboxActions requires <InboxProvider>');
  return ctx;
}
