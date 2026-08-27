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
import { assistantReducer } from './assistantReducer';

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

/** Placeholder id for the optimistic session created by a first send, before
 *  the server's `session_started` hands back the real id. `assistantReducer`
 *  migrates it (keeping scrollback) on that message. */
const PENDING_SESSION_ID = 'assistant-pending';

let userSeq = 0;
function nextUserId(): string {
  userSeq += 1;
  return `assistant-user-${userSeq}`;
}

type ProviderState = {
  assistantProjectId?: number;
  session: SessionView | null;
};

type ProviderAction = { type: 'server'; msg: ServerMsg } | { type: 'user_send'; text: string };

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

  const { msg } = action;
  if (msg.type === 'settings') {
    // The only field we read; may be undefined (server without an assistant).
    if (msg.assistantProjectId === state.assistantProjectId) return state;
    return { ...state, assistantProjectId: msg.assistantProjectId };
  }
  // Gate session adoption by projectId; other messages self-gate by sessionId.
  if (msg.type === 'session_started' && msg.projectId !== state.assistantProjectId) {
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
  /** Optimistically echo + ship a `send_message`. No-op on empty text or
   *  before `assistantProjectId` is known. */
  sendMessage: (text: string) => void;
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
};

export function AssistantProvider({ children, send, handlerRef }: AssistantProviderProps) {
  const [state, dispatch] = useReducer(providerReducer, initialState);

  // Mirror state into a ref so `sendMessage` reads the current projectId
  // without re-creating its identity on every session update.
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

  const sendMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const projectId = stateRef.current.assistantProjectId;
      if (projectId === undefined) return;
      dispatch({ type: 'user_send', text: trimmed });
      // Exactly these three fields — no `maxTurns`, no `sessionId`. The server
      // resolves the assistant's session from the projectId.
      send({ type: 'send_message', projectId, text: trimmed });
    },
    [send],
  );

  const value = useMemo<AssistantContextValue>(
    () => ({ assistantProjectId: state.assistantProjectId, session: state.session, sendMessage }),
    [state.assistantProjectId, state.session, sendMessage],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAssistant(): AssistantContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAssistant requires <AssistantProvider>');
  return ctx;
}
