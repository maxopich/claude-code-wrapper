import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import type { ClientMsg, ServerMsg } from '@cebab/shared/protocol';
import type { MessageView, SessionView } from '../../store';
import { assistantReducer, PENDING_SESSION_ID } from './assistantReducer';

/**
 * Cebab-8x8.3.2: context for the floating assistant widget.
 *
 * Same `send` + `handlerRef` provider pair as {@link InboxProvider}
 * (App.tsx) — no new plumbing. App.tsx routes ServerMsgs into `handlerRef`
 * and the provider owns the assistant's state OUTSIDE the Redux store (its
 * project id is filtered out of `listProjects()`, so reducing its envelopes
 * in the main store would corrupt AppState — see `routesToAssistant`).
 *
 * State the provider tracks:
 *   - `assistantProjectId` — learned from the `settings` ServerMsg. The dock
 *     renders NOTHING until this is known; every `send_message` carries it.
 *   - `session` — the single assistant {@link SessionView}, produced by
 *     {@link assistantReducer}. Null before the first send / `session_started`.
 *
 * The provider dispatches EVERY ServerMsg through its wrapper reducer. A
 * `session_started` is gated on `projectId === assistantProjectId` (the only
 * assistant discriminator on the wire); all other messages are session-keyed
 * and self-gate inside `assistantReducer` on the adopted session id.
 */

let userSeq = 0;
function nextUserId(): string {
  userSeq += 1;
  return `assistant-user-${userSeq}`;
}

// Cebab-eo71: ids for the synthetic cancelled row a connection_lost appends.
// Monotonic + unique, the same way the reducer mints its own message ids.
let connLostSeq = 0;
function nextConnLostId(): string {
  connLostSeq += 1;
  return `assistant-connlost-${connLostSeq}`;
}

type ProviderState = {
  assistantProjectId?: number;
  session: SessionView | null;
};

type ProviderAction =
  | { type: 'server'; msg: ServerMsg }
  | { type: 'user_send'; text: string }
  /** Cebab-eo71: the socket dropped — end a running answer with the connection
   *  line. Not a ServerMsg: App.tsx fires it from the WS close handler. */
  | { type: 'connection_lost' }
  /** Cebab-eo71: start a fresh conversation. No-op while an answer is running. */
  | { type: 'reset' };

const initialState: ProviderState = { assistantProjectId: undefined, session: null };

function providerReducer(state: ProviderState, action: ProviderAction): ProviderState {
  if (action.type === 'user_send') {
    if (state.assistantProjectId === undefined) return state;
    // Optimistic echo of the operator's own message — the server never echoes
    // user text back (mirrors store.ts's `user_send` Action). When no session
    // exists yet, seed a pending one; `session_started` migrates it.
    const base: SessionView = state.session ?? {
      id: PENDING_SESSION_ID,
      projectId: state.assistantProjectId,
      status: 'running',
      messages: [],
      streamingText: '',
      runStartedAt: null,
      heldMessages: [],
    };
    const userMsg: MessageView = { kind: 'user', id: nextUserId(), text: action.text };
    return {
      ...state,
      session: {
        ...base,
        status: 'running',
        runStartedAt: Date.now(),
        streamingText: '',
        messages: [...base.messages, userMsg],
      },
    };
  }

  if (action.type === 'reset') {
    // Cebab-eo71: drop the session so the next send starts fresh with no
    // sessionId — a NEW conversation. Refuse while an answer is running: a
    // dropped in-flight session would strand the server turn with nothing on
    // screen. The button that fires this is disabled while running too; this is
    // the belt to that suspenders.
    if (state.session?.status === 'running') return state;
    if (state.session === null) return state;
    return { ...state, session: null };
  }

  if (action.type === 'connection_lost') {
    // Cebab-eo71: a running answer can never complete over a dead socket, so end
    // it with a neutral cancelled line rather than leaving the panel spinning
    // (App.tsx dispatches ws_close to the main store only, which never touches
    // the out-of-store assistant session). Nothing to do if idle.
    const s = state.session;
    if (!s || s.status !== 'running') return state;
    return {
      ...state,
      session: {
        ...s,
        status: 'done',
        runStartedAt: null,
        streamingText: '',
        messages: [
          ...s.messages,
          {
            kind: 'cancelled',
            id: nextConnLostId(),
            message: 'Connection lost. This answer was cut off; ask again once Cebab reconnects.',
          },
        ],
      },
    };
  }

  const { msg } = action;
  if (msg.type === 'settings') {
    // The only field we read; may be undefined (server without an assistant).
    if (msg.assistantProjectId === state.assistantProjectId) return state;
    return { ...state, assistantProjectId: msg.assistantProjectId };
  }
  // Gate session adoption by projectId; other messages self-gate by sessionId.
  // Cebab-eo71: session_running carries a projectId too, so it is gated the same
  // way session_started is — otherwise another project's framing envelope could
  // reach the assistant reducer.
  if (
    (msg.type === 'session_started' || msg.type === 'session_running') &&
    msg.projectId !== state.assistantProjectId
  ) {
    return state;
  }
  const nextSession = assistantReducer(state.session, msg);
  if (nextSession === state.session) return state;
  return { ...state, session: nextSession };
}

export type AssistantContextValue = {
  /** The assistant project's id, or undefined until the `settings` msg lands. */
  assistantProjectId?: number;
  /** The assistant session, or null before the first turn. */
  session: SessionView | null;
  /** Optimistically echo + ship a `send_message`. No-op on empty text, before
   *  `assistantProjectId` is known, or while an answer is running. */
  sendMessage: (text: string) => void;
  /** Cebab-eo71: true while the current answer is in flight. */
  running: boolean;
  /** Cebab-eo71: interrupt the running answer. Ships `{ type: 'interrupt',
   *  sessionId }` for the adopted id; a no-op before the server has handed one
   *  back (the pending placeholder). */
  stop: () => void;
  /** Cebab-eo71: drop the session so the next send opens a fresh conversation.
   *  A no-op while an answer is running. */
  reset: () => void;
};

const Ctx = createContext<AssistantContextValue | null>(null);

export type AssistantProviderProps = {
  children: ReactNode;
  /** ClientMsg sink (WS adapter). */
  send: (msg: ClientMsg) => void;
  /**
   * Bridge so App.tsx can route ServerMsgs into the provider's reducer
   * without prop-drilling. Provider populates the ref on mount, clears on
   * unmount — identical to {@link InboxProvider}'s handlerRef.
   */
  handlerRef?: MutableRefObject<((msg: ServerMsg) => void) | null>;
  /**
   * Cebab-eo71: second bridge, same pattern as {@link handlerRef}. App.tsx's WS
   * close handler calls this so a running help answer ends with the connection
   * line instead of spinning (ws_close reaches only the main store).
   */
  connLostRef?: MutableRefObject<(() => void) | null>;
};

export function AssistantProvider({
  children,
  send,
  handlerRef,
  connLostRef,
}: AssistantProviderProps) {
  const [state, dispatch] = useReducer(providerReducer, initialState);

  // Mirror state into a ref so `sendMessage` / `stop` read the current session
  // without re-creating their identity on every session update.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const handleServerMsg = useCallback((msg: ServerMsg) => {
    dispatch({ type: 'server', msg });
  }, []);

  useEffect(() => {
    if (!handlerRef) return;
    handlerRef.current = handleServerMsg;
    return () => {
      handlerRef.current = null;
    };
  }, [handleServerMsg, handlerRef]);

  const handleConnectionLost = useCallback(() => {
    dispatch({ type: 'connection_lost' });
  }, []);

  useEffect(() => {
    if (!connLostRef) return;
    connLostRef.current = handleConnectionLost;
    return () => {
      connLostRef.current = null;
    };
  }, [handleConnectionLost, connLostRef]);

  const sendMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const projectId = stateRef.current.assistantProjectId;
      if (projectId === undefined) return;
      // Cebab-eo71: the server refuses a second turn on a busy session with a
      // wrapper_error. Don't ship one — the composer swaps Send for Stop while
      // running, so this guards the programmatic path.
      if (stateRef.current.session?.status === 'running') return;
      // Read the adopted id BEFORE dispatching: `stateRef` still holds the
      // pre-dispatch state, which is what we want — the id the server handed
      // back on `session_started`, never the optimistic one seeded below.
      const sid = stateRef.current.session?.id;
      dispatch({ type: 'user_send', text: trimmed });
      // No `maxTurns` — the assistant's cap is server-side (ASSISTANT_MAX_TURNS).
      // `sessionId` IS sent once a real one exists. `runOneTurn` does
      // `msg.sessionId ?? randomUUID()` and passes `resume: msg.sessionId`
      // (ws/server.ts), so omitting it mints a NEW session and spawns without
      // `--resume`: the help agent would restart cold on every follow-up while
      // the panel still showed one continuous transcript. PENDING_SESSION_ID is
      // never sent — it is this component's placeholder, not a server id.
      send({
        type: 'send_message',
        projectId,
        text: trimmed,
        ...(sid && sid !== PENDING_SESSION_ID ? { sessionId: sid } : {}),
      });
    },
    [send],
  );

  const stop = useCallback(() => {
    const s = stateRef.current.session;
    // No-op before the server has handed back a real id: the pending
    // placeholder is never a server session, so there is nothing to interrupt.
    if (!s || s.id === PENDING_SESSION_ID) return;
    if (s.status !== 'running') return;
    send({ type: 'interrupt', sessionId: s.id });
  }, [send]);

  const reset = useCallback(() => {
    dispatch({ type: 'reset' });
  }, []);

  const running = state.session?.status === 'running';

  const value = useMemo<AssistantContextValue>(
    () => ({
      assistantProjectId: state.assistantProjectId,
      session: state.session,
      sendMessage,
      running,
      stop,
      reset,
    }),
    [state.assistantProjectId, state.session, sendMessage, running, stop, reset],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAssistant(): AssistantContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAssistant requires <AssistantProvider>');
  return ctx;
}
