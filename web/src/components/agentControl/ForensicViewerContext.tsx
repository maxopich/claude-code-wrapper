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
import type { ClientMsg, KickForensicsSnapshot, ServerMsg } from '@cebab/shared/protocol';

/**
 * Cluster C Phase 4g4 (spec §5.5, §6.4): context for the
 * KickForensicsModal. Mirrors the Phase 8b RecoveryLogContext shape
 * (state vs actions split, handlerRef bridge for App.tsx's onMessage to
 * route the typed `kick_forensics_snapshot` ServerMsg into the
 * provider's reducer without prop-drilling).
 *
 * Distinct from RecoveryLog in that the snapshot is **keyed by
 * (sessionId, agentSlug)** — the operator can pop the modal for one
 * agent, close, and pop it for a different one without seeing stale
 * data flash. The reducer wipes the body whenever a new `open` action
 * targets a different key.
 *
 * State machine the modal renders against:
 *   - `kind: 'closed'`                — no modal mounted.
 *   - `kind: 'loading'`               — request sent, awaiting snapshot.
 *   - `kind: 'ready'`                 — snapshot landed (found or not).
 *   - `kind: 'error'`                 — reserved for future timeout/abort
 *                                       handling; today the WS round-trip
 *                                       always replies, so this is a
 *                                       forward-compat shape.
 */

export type ForensicViewerState =
  | { kind: 'closed' }
  | {
      kind: 'loading';
      sessionId: string;
      agentSlug: string;
    }
  | {
      kind: 'ready';
      sessionId: string;
      agentSlug: string;
      found: boolean;
      snapshot: KickForensicsSnapshot | null;
    }
  | {
      kind: 'error';
      sessionId: string;
      agentSlug: string;
      message: string;
    };

type ForensicViewerAction =
  | { type: 'open'; sessionId: string; agentSlug: string }
  | {
      type: 'snapshot';
      sessionId: string;
      agentSlug: string;
      found: boolean;
      snapshot: KickForensicsSnapshot | null;
    }
  | { type: 'close' };

export const initialForensicViewerState: ForensicViewerState = { kind: 'closed' };

export function forensicViewerReducer(
  state: ForensicViewerState,
  action: ForensicViewerAction,
): ForensicViewerState {
  switch (action.type) {
    case 'open':
      return {
        kind: 'loading',
        sessionId: action.sessionId,
        agentSlug: action.agentSlug,
      };
    case 'snapshot': {
      // Only land snapshots that match the currently-open key. A
      // late-arriving snapshot for a previously-requested (session,
      // slug) is silently dropped — the operator has moved on.
      if (state.kind === 'closed') return state;
      if (state.sessionId !== action.sessionId || state.agentSlug !== action.agentSlug) {
        return state;
      }
      return {
        kind: 'ready',
        sessionId: action.sessionId,
        agentSlug: action.agentSlug,
        found: action.found,
        snapshot: action.snapshot,
      };
    }
    case 'close':
      return { kind: 'closed' };
  }
}

export type ForensicViewerActions = {
  /**
   * Open the modal for (sessionId, agentSlug). Dispatches the
   * `get_kick_forensics` ClientMsg; the snapshot reply transitions the
   * state to `ready`.
   */
  open: (sessionId: string, agentSlug: string) => void;
  close: () => void;
};

const StateCtx = createContext<ForensicViewerState | null>(null);
const ActionsCtx = createContext<ForensicViewerActions | null>(null);

export type ForensicViewerProviderProps = {
  children: ReactNode;
  /** ClientMsg sink (WS adapter). */
  send: (msg: ClientMsg) => void;
  /**
   * Bridge so App.tsx can route `kick_forensics_snapshot` ServerMsgs
   * into the provider's reducer without prop-drilling. Provider
   * populates the ref on mount, clears on unmount.
   */
  handlerRef?: MutableRefObject<((msg: ServerMsg) => void) | null>;
};

export function ForensicViewerProvider({
  children,
  send,
  handlerRef,
}: ForensicViewerProviderProps) {
  const [state, dispatch] = useReducer(forensicViewerReducer, initialForensicViewerState);

  const handleServerMsg = useCallback((msg: ServerMsg) => {
    if (msg.type !== 'kick_forensics_snapshot') return;
    dispatch({
      type: 'snapshot',
      sessionId: msg.sessionId,
      agentSlug: msg.agentSlug,
      found: msg.found,
      snapshot: msg.snapshot,
    });
  }, []);

  useEffect(() => {
    if (!handlerRef) return;
    handlerRef.current = handleServerMsg;
    return () => {
      handlerRef.current = null;
    };
  }, [handleServerMsg, handlerRef]);

  const actions = useMemo<ForensicViewerActions>(
    () => ({
      open: (sessionId: string, agentSlug: string) => {
        dispatch({ type: 'open', sessionId, agentSlug });
        send({ type: 'get_kick_forensics', sessionId, agentSlug });
      },
      close: () => dispatch({ type: 'close' }),
    }),
    [send],
  );

  return (
    <StateCtx.Provider value={state}>
      <ActionsCtx.Provider value={actions}>{children}</ActionsCtx.Provider>
    </StateCtx.Provider>
  );
}

export function useForensicViewerState(): ForensicViewerState {
  const ctx = useContext(StateCtx);
  if (!ctx) throw new Error('useForensicViewerState requires <ForensicViewerProvider>');
  return ctx;
}

export function useForensicViewerActions(): ForensicViewerActions {
  const ctx = useContext(ActionsCtx);
  if (!ctx) throw new Error('useForensicViewerActions requires <ForensicViewerProvider>');
  return ctx;
}
