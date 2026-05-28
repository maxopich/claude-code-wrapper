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
import type {
  ClientMsg,
  RecoveryClassAggregate,
  RecoveryLogEntry,
  ServerMsg,
} from '@cebab/shared/protocol';

/**
 * Cluster D Phase 8b: context for the RecoveryLogInspector popover.
 *
 * Mirrors the Phase 5 InboxContext shape (state vs actions split,
 * handlerRef bridge for App.tsx's onMessage to route the typed
 * `recovery_log_snapshot` ServerMsg without prop-drilling). The
 * provider owns:
 *
 *   - The latest snapshot envelope's fields (aggregates + per-class
 *     gauges + recent rows). Empty/null defaults until the first
 *     snapshot arrives so the panel can render a skeleton on first
 *     open.
 *   - A `loaded` flag distinguishing "never asked" from "asked, got
 *     zero rows". A fresh open should always re-request to avoid stale
 *     data after a long-running tab.
 *
 * Actions:
 *   - `requestSnapshot(recentLimit?)` — ships
 *     `get_recovery_log_snapshot { recentLimit }` ClientMsg. The
 *     server clamps the limit to [1, 100] regardless of input.
 *
 * Why a context (vs putting in the main store reducer): the snapshot
 * is short-lived inspector-scoped state; pushing it through the global
 * reducer would churn the whole component tree on every refresh of
 * what is fundamentally a debug panel. Same rationale as InboxContext.
 */

export type RecoveryLogState = {
  aggregates: RecoveryClassAggregate[];
  sweepReopenRate: { rate: number; sweeps: number } | null;
  authResumeChoiceRatio: {
    inSessionRate: number;
    inSession: number;
    newSession: number;
  } | null;
  recent: RecoveryLogEntry[];
  /**
   * False until the first `recovery_log_snapshot` lands. Lets the
   * inspector render a "loading…" skeleton instead of "no recovery
   * activity" on first paint — those two states look the same but
   * mean very different things to the operator.
   */
  loaded: boolean;
};

type RecoveryLogAction = {
  type: 'snapshot';
  aggregates: RecoveryClassAggregate[];
  sweepReopenRate: { rate: number; sweeps: number } | null;
  authResumeChoiceRatio: {
    inSessionRate: number;
    inSession: number;
    newSession: number;
  } | null;
  recent: RecoveryLogEntry[];
};

export const initialRecoveryLogState: RecoveryLogState = {
  aggregates: [],
  sweepReopenRate: null,
  authResumeChoiceRatio: null,
  recent: [],
  loaded: false,
};

export function recoveryLogReducer(
  state: RecoveryLogState,
  action: RecoveryLogAction,
): RecoveryLogState {
  switch (action.type) {
    case 'snapshot':
      return {
        aggregates: action.aggregates,
        sweepReopenRate: action.sweepReopenRate,
        authResumeChoiceRatio: action.authResumeChoiceRatio,
        recent: action.recent,
        loaded: true,
      };
  }
}

export type RecoveryLogActions = {
  /**
   * Re-request from the server. `recentLimit` is opt-in; the server
   * clamps to [1, 100]. Omit to take the server default (100).
   */
  requestSnapshot: (recentLimit?: number) => void;
};

const StateCtx = createContext<RecoveryLogState | null>(null);
const ActionsCtx = createContext<RecoveryLogActions | null>(null);

export type RecoveryLogProviderProps = {
  children: ReactNode;
  /** ClientMsg sink (WS adapter). */
  send: (msg: ClientMsg) => void;
  /**
   * Bridge so App.tsx can route `recovery_log_snapshot` ServerMsgs into
   * the provider's reducer without prop-drilling. Provider populates
   * the ref on mount, clears on unmount. Same shape as
   * InboxProvider.handlerRef.
   */
  handlerRef?: MutableRefObject<((msg: ServerMsg) => void) | null>;
};

export function RecoveryLogProvider({
  children,
  send,
  handlerRef,
}: RecoveryLogProviderProps) {
  const [state, dispatch] = useReducer(recoveryLogReducer, initialRecoveryLogState);

  const handleServerMsg = useCallback((msg: ServerMsg) => {
    if (msg.type !== 'recovery_log_snapshot') return;
    dispatch({
      type: 'snapshot',
      aggregates: msg.aggregates,
      sweepReopenRate: msg.sweepReopenRate,
      authResumeChoiceRatio: msg.authResumeChoiceRatio,
      recent: msg.recent,
    });
  }, []);

  useEffect(() => {
    if (!handlerRef) return;
    handlerRef.current = handleServerMsg;
    return () => {
      handlerRef.current = null;
    };
  }, [handleServerMsg, handlerRef]);

  const actions = useMemo<RecoveryLogActions>(
    () => ({
      requestSnapshot: (recentLimit?: number) => {
        send({ type: 'get_recovery_log_snapshot', recentLimit });
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

export function useRecoveryLogState(): RecoveryLogState {
  const ctx = useContext(StateCtx);
  if (!ctx) throw new Error('useRecoveryLogState requires <RecoveryLogProvider>');
  return ctx;
}

export function useRecoveryLogActions(): RecoveryLogActions {
  const ctx = useContext(ActionsCtx);
  if (!ctx) throw new Error('useRecoveryLogActions requires <RecoveryLogProvider>');
  return ctx;
}
