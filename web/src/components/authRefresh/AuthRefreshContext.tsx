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
import { AuthRefreshModal } from './AuthRefreshModal';

// Cluster D Phase 6c (spec §6.4 / UI-D22 follow-up): operator-visible
// surface for the in-Cebab `claude login` flow that Phase 6b shipped
// server-side. The AuthExpiredBanner's "Re-authenticate" primary
// action (added in this PR) opens this modal, which:
//
//   - sends `start_auth_refresh` ClientMsg
//   - shows live stdout/stderr output (terminal-style)
//   - lets the operator Cancel mid-flow
//   - surfaces success/failure on completion
//
// The five-state machine handles the round-trip cleanly:
//
//   - `idle`       — nothing in flight; modal does not render.
//   - `spawning`   — start_auth_refresh sent; awaiting the
//                    `auth_refresh_started` reply (usually <50ms).
//   - `running`    — subprocess spawned; output chunks accumulating.
//   - `completed`  — server emitted `auth_refresh_completed`.
//                    Modal shows success/failure result + Close.
//   - `failed`     — start-time failure (`auth_refresh_failed`):
//                    already_running OR spawn_failed. Modal shows the
//                    reason + Close (no Cancel — nothing to cancel).
//
// Race-safety: every server-msg reducer transition validates the
// `runId` matches the in-flight one (defensive against a stale tab
// receiving the wrong tab's completed envelope). The exception is the
// initial `auth_refresh_started` envelope: any in-flight `spawning`
// state accepts it (there's only ever one outstanding start request
// per tab because the reducer drops duplicates).

// ---- types ----

type AuthRefreshState =
  | { kind: 'idle' }
  | { kind: 'spawning' }
  | {
      kind: 'running';
      runId: string;
      pid: number;
      /** Accumulated output across stdout + stderr chunks. We render
       *  as plain text in the modal (terminal-style), so a single
       *  string is enough — no need to track which stream each chunk
       *  came from at the state-machine level (the modal still uses
       *  per-chunk metadata if present for colorizing). */
      output: string;
    }
  | {
      kind: 'completed';
      runId: string;
      exitCode: number | null;
      success: boolean;
      /** Output captured up to completion. Retained so the operator
       *  can scroll through the result before closing. */
      output: string;
    }
  | {
      kind: 'failed';
      reason: 'already_running' | 'spawn_failed';
      existingRunId?: string;
      error?: string;
    };

type Action =
  | { type: 'request_start' }
  | { type: 'started'; runId: string; pid: number }
  | { type: 'output'; runId: string; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'completed'; runId: string; exitCode: number | null; success: boolean }
  | {
      type: 'failed';
      reason: 'already_running' | 'spawn_failed';
      existingRunId?: string;
      error?: string;
    }
  | { type: 'close' };

const initialState: AuthRefreshState = { kind: 'idle' };

function reducer(state: AuthRefreshState, action: Action): AuthRefreshState {
  switch (action.type) {
    case 'request_start': {
      // Guard duplicate clicks. Operator may double-click the banner
      // button; only the first transitions to spawning.
      if (state.kind !== 'idle') return state;
      return { kind: 'spawning' };
    }
    case 'started': {
      // Accept the started envelope from spawning state. If we're not
      // spawning (e.g. closed mid-roundtrip then re-opened), it's a
      // late envelope for a prior run — drop it.
      if (state.kind !== 'spawning') return state;
      return { kind: 'running', runId: action.runId, pid: action.pid, output: '' };
    }
    case 'output': {
      if (state.kind !== 'running') return state;
      // Race-safety: only accept chunks for our runId. A second tab's
      // run would emit envelopes our handlerRef can see, but the
      // single-flight guarantee means only one runId is alive — so
      // mismatches indicate a stale/cross-tab envelope to ignore.
      if (state.runId !== action.runId) return state;
      return { ...state, output: state.output + action.text };
    }
    case 'completed': {
      // Accept completion from running. The runId guard handles the
      // race where a Cancel raced the natural exit (both fire
      // completed envelopes with the same runId; the second is a
      // no-op via the kind check).
      if (state.kind !== 'running') return state;
      if (state.runId !== action.runId) return state;
      return {
        kind: 'completed',
        runId: action.runId,
        exitCode: action.exitCode,
        success: action.success,
        output: state.output,
      };
    }
    case 'failed': {
      // Failed only fires from start-time rejection
      // (auth_refresh_failed ServerMsg). Only meaningful while
      // spawning; ignore if we're already in another terminal state.
      if (state.kind !== 'spawning') return state;
      return {
        kind: 'failed',
        reason: action.reason,
        ...(action.existingRunId !== undefined ? { existingRunId: action.existingRunId } : {}),
        ...(action.error !== undefined ? { error: action.error } : {}),
      };
    }
    case 'close':
      return initialState;
  }
}

// ---- context ----

type ActionsValue = {
  /** Operator clicked Re-authenticate. Opens the modal + ships the
   *  `start_auth_refresh` ClientMsg. */
  requestStart: () => void;
  /** Operator clicked Cancel in the modal while a run is live.
   *  Ships `cancel_auth_refresh { runId }`. The server's onCompleted
   *  callback will fire an `auth_refresh_completed` with success=false
   *  + exitCode=null, which transitions us to `completed` (NOT idle —
   *  the operator may still want to read the output). They click
   *  Close to dismiss. */
  cancel: () => void;
  /** Close / Esc — drops back to idle without notifying the server
   *  (no-op there; the subprocess if still running may continue). */
  close: () => void;
};

const StateCtx = createContext<AuthRefreshState | null>(null);
const ActionsCtx = createContext<ActionsValue | null>(null);

export type AuthRefreshProviderProps = {
  children: ReactNode;
  /** WS ClientMsg sink (App.tsx wraps wsRef.send). */
  send: (msg: ClientMsg) => void;
  /** App.tsx populates this ref so the WS message bridge can route
   *  auth-refresh-related ServerMsgs into the provider — mirrors the
   *  ReopenProvider / GateModalsProvider pattern. */
  handlerRef?: React.MutableRefObject<((msg: ServerMsg) => void) | null>;
};

export function AuthRefreshProvider({ children, send, handlerRef }: AuthRefreshProviderProps) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const requestStart = useCallback<ActionsValue['requestStart']>(() => {
    // Mirror the reducer's guard to avoid a stray ClientMsg if the
    // operator double-clicks. The server's single-flight would also
    // reject, but skipping the network round-trip is cleaner.
    if (state.kind !== 'idle') return;
    dispatch({ type: 'request_start' });
    send({ type: 'start_auth_refresh' });
  }, [send, state.kind]);

  const cancel = useCallback<ActionsValue['cancel']>(() => {
    // Only meaningful from the running state; ignore otherwise.
    if (state.kind !== 'running') return;
    send({ type: 'cancel_auth_refresh', runId: state.runId });
    // We don't dispatch a local state change — the server's
    // onCompleted callback fires auth_refresh_completed which
    // transitions us to `completed`. Keeping the optimistic UI off
    // means the modal correctly shows the natural exit if the user
    // hit Cancel after OAuth already completed in their browser.
  }, [send, state]);

  const close = useCallback<ActionsValue['close']>(() => {
    dispatch({ type: 'close' });
  }, []);

  // Bridge: route matching ServerMsgs from App.tsx into the provider.
  useEffect(() => {
    if (!handlerRef) return;
    handlerRef.current = (msg) => {
      if (msg.type === 'auth_refresh_started') {
        dispatch({ type: 'started', runId: msg.runId, pid: msg.pid });
        return;
      }
      if (msg.type === 'auth_refresh_output') {
        dispatch({
          type: 'output',
          runId: msg.runId,
          stream: msg.stream,
          text: msg.text,
        });
        return;
      }
      if (msg.type === 'auth_refresh_completed') {
        dispatch({
          type: 'completed',
          runId: msg.runId,
          exitCode: msg.exitCode,
          success: msg.success,
        });
        return;
      }
      if (msg.type === 'auth_refresh_failed') {
        dispatch({
          type: 'failed',
          reason: msg.reason,
          ...(msg.existingRunId !== undefined ? { existingRunId: msg.existingRunId } : {}),
          ...(msg.error !== undefined ? { error: msg.error } : {}),
        });
      }
    };
    return () => {
      handlerRef.current = null;
    };
  }, [handlerRef]);

  const actions = useMemo<ActionsValue>(
    () => ({ requestStart, cancel, close }),
    [requestStart, cancel, close],
  );

  return (
    <StateCtx.Provider value={state}>
      <ActionsCtx.Provider value={actions}>
        {children}
        <AuthRefreshHost />
      </ActionsCtx.Provider>
    </StateCtx.Provider>
  );
}

// ---- hooks ----

export function useAuthRefreshState(): AuthRefreshState {
  const ctx = useContext(StateCtx);
  if (!ctx) throw new Error('useAuthRefreshState requires <AuthRefreshProvider>');
  return ctx;
}

export function useAuthRefreshActions(): ActionsValue {
  const ctx = useContext(ActionsCtx);
  if (!ctx) throw new Error('useAuthRefreshActions requires <AuthRefreshProvider>');
  return ctx;
}

// ---- host ----

function AuthRefreshHost() {
  const state = useAuthRefreshState();
  const { cancel, close } = useAuthRefreshActions();
  if (state.kind === 'idle') return null;
  return <AuthRefreshModal state={state} onCancel={cancel} onClose={close} />;
}

export type { AuthRefreshState };
