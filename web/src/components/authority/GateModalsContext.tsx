import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';
import type { ClientMsg, ServerMsg } from '@cebab/shared/protocol';
import { McpTofuModal } from './McpTofuModal';
import { EnvInjectionGateModal } from './EnvInjectionGateModal';

// Cluster B Phase 6a: UI surface for the pre-spawn gates.
//
// Phases 4b + 5 built the backend gates: when the SDK is about to spawn an
// untrusted MCP server or load a project with credential-class env keys,
// the server emits `mcp_auto_install_pending` or `session_start_gated` and
// awaits the operator's `mcp_trust_decision` / `acknowledge_and_start`.
// Without UI, those envelopes hit the wire and nothing visible happens —
// the spawn silently hangs.
//
// This file is that UI:
//
//   - `GateModalsProvider` is the root provider. Owns a FIFO queue of
//     pending gate envelopes and a single `<GateModalHost>` that renders
//     the head of the queue (one modal at a time, to avoid the UX confusion
//     of multiple stacked gates competing for the operator's attention).
//   - `useGateModalsActions().enqueue(env)` is called from App.tsx's WS
//     message bridge when either envelope arrives.
//   - Each modal owns its decision UI; on submit it sends the matching
//     ClientMsg via the provider's `send` callback and dispatches `dismiss`
//     so the next queued entry surfaces.
//
// The provider is WS-agnostic — `send` is injected by App.tsx (same shape
// as InboxProvider's `send`). Tests can mock it freely.

// ---- types ----

type Pending =
  | (Extract<ServerMsg, { type: 'mcp_auto_install_pending' }> & { kind: 'mcp' })
  | (Extract<ServerMsg, { type: 'session_start_gated' }> & { kind: 'env' });

type State = {
  queue: Pending[];
};

type Action = { type: 'enqueue'; pending: Pending } | { type: 'dismiss-head'; matchKey: string };

const initialState: State = { queue: [] };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'enqueue': {
      // De-dupe by the gate-specific id so a re-emitted envelope (e.g. WS
      // reconnect mid-pending) doesn't queue a second modal for the same
      // pending.
      const key = pendingKey(action.pending);
      if (state.queue.some((p) => pendingKey(p) === key)) return state;
      return { queue: [...state.queue, action.pending] };
    }
    case 'dismiss-head': {
      // Only dismiss if the head's key matches — guards against a race where
      // a stale dismiss arrives after a new head has surfaced.
      if (state.queue.length === 0) return state;
      const head = state.queue[0]!;
      if (pendingKey(head) !== action.matchKey) return state;
      return { queue: state.queue.slice(1) };
    }
  }
}

function pendingKey(p: Pending): string {
  return p.kind === 'mcp' ? `mcp:${p.pendingId}` : `env:${p.pendingStartId}`;
}

// ---- context ----

type ActionsValue = {
  /** Called by App.tsx when a gate envelope arrives over the WS. */
  enqueue: (
    env: Extract<ServerMsg, { type: 'mcp_auto_install_pending' | 'session_start_gated' }>,
  ) => void;
  /** Dismisses the head of the queue if it matches `matchKey`. Called
   *  from the modal after the operator submits/closes. */
  dismissHead: (matchKey: string) => void;
  /** Outbound WS sink; modals call this to ship their decision ClientMsg. */
  send: (msg: ClientMsg) => void;
};

const StateCtx = createContext<State | null>(null);
const ActionsCtx = createContext<ActionsValue | null>(null);

export type GateModalsProviderProps = {
  children: ReactNode;
  /** WS ClientMsg sink. Modals call this to send mcp_trust_decision /
   *  acknowledge_and_start. */
  send: (msg: ClientMsg) => void;
  /** App.tsx populates this ref so the WS message bridge can route
   *  matching envelopes into the provider without prop-drilling. Mirror of
   *  the NotificationsBridge / InboxProvider pattern from Cluster A. */
  handlerRef?: React.MutableRefObject<((msg: ServerMsg) => void) | null>;
};

export function GateModalsProvider({ children, send, handlerRef }: GateModalsProviderProps) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const enqueue = useCallback<ActionsValue['enqueue']>((env) => {
    const pending: Pending =
      env.type === 'mcp_auto_install_pending' ? { ...env, kind: 'mcp' } : { ...env, kind: 'env' };
    dispatch({ type: 'enqueue', pending });
  }, []);

  const dismissHead = useCallback<ActionsValue['dismissHead']>((matchKey) => {
    dispatch({ type: 'dismiss-head', matchKey });
  }, []);

  // Bridge: route matching ServerMsgs from App.tsx into the provider. The
  // handlerRef pattern keeps the provider untangled from the WS plumbing
  // (App.tsx assigns the ref on mount, calls it for every ServerMsg).
  useEffect(() => {
    if (!handlerRef) return;
    handlerRef.current = (msg) => {
      if (msg.type === 'mcp_auto_install_pending' || msg.type === 'session_start_gated') {
        enqueue(msg);
      }
    };
    return () => {
      handlerRef.current = null;
    };
  }, [handlerRef, enqueue]);

  const actions = useMemo<ActionsValue>(
    () => ({ enqueue, dismissHead, send }),
    [enqueue, dismissHead, send],
  );

  return (
    <StateCtx.Provider value={state}>
      <ActionsCtx.Provider value={actions}>
        {children}
        <GateModalHost />
      </ActionsCtx.Provider>
    </StateCtx.Provider>
  );
}

// ---- hooks ----

export function useGateModalsState(): State {
  const ctx = useContext(StateCtx);
  if (!ctx) throw new Error('useGateModalsState requires <GateModalsProvider>');
  return ctx;
}

export function useGateModalsActions(): ActionsValue {
  const ctx = useContext(ActionsCtx);
  if (!ctx) throw new Error('useGateModalsActions requires <GateModalsProvider>');
  return ctx;
}

// ---- host ----

/**
 * Renders the head of the gate queue, if any. One-at-a-time policy: the
 * operator finishes (or refuses) the current gate before the next one
 * appears. Each modal calls `dismissHead` after submitting; the host
 * re-renders, and the next pending surfaces if any.
 */
function GateModalHost() {
  const { queue } = useGateModalsState();
  const { dismissHead, send } = useGateModalsActions();
  const head = queue[0];
  if (!head) return null;
  const matchKey = pendingKey(head);
  const onClose = () => dismissHead(matchKey);
  if (head.kind === 'mcp') {
    return <McpTofuModal pending={head} send={send} onClose={onClose} />;
  }
  return <EnvInjectionGateModal pending={head} send={send} onClose={onClose} />;
}
