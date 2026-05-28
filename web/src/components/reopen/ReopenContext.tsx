import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';
import type {
  ClientMsg,
  ReopenSessionFailureReason,
  ServerMsg,
  WorkspaceDiff,
} from '@cebab/shared/protocol';
import { ReopenSessionModal } from './ReopenSessionModal';

// Cluster D Phase 5d (spec §6.3, UI-D19/UI-D20/UI-D21): operator-visible
// surface for the swept-session reopen flow.
//
// The server side (Phase 5b probe + Phase 5c commit) is already there:
//   - `reopen_session` ClientMsg → server replies `reopen_session_confirm_required`
//     with a workspace diff
//   - `reopen_session_confirmed` ClientMsg → server validates the typed gate,
//     displaces the current active session, reactivates the target via R-B
//   - `reopen_session_failed` ServerMsg → enumerated failure reasons
//
// This file is the client state machine that drives the
// ReopenSessionModal through that round-trip. The state machine has
// FIVE positions:
//
//   - `idle`        — nothing in flight; the modal does not render.
//   - `probing`     — operator clicked Reopen; `reopen_session` is in
//                     flight; modal shows a spinner.
//   - `confirming`  — server replied with the diff; modal renders the
//                     workspace-diff + ack checkbox + typed input (when
//                     required); operator can Cancel or Reopen.
//   - `committing`  — operator clicked Reopen; `reopen_session_confirmed`
//                     is in flight; modal disables the form + spins.
//   - `failed`      — server returned `reopen_session_failed`; modal
//                     shows the error message + a Close button. From the
//                     `confirming` state, a `failed` reverts the form
//                     to re-editable so the operator can correct typed-
//                     gate input.
//
// Success (after `committing`) is signalled by a `multi_agent_started`
// envelope for the target sessionId — the existing reducer transitions
// the active-run view; this context just closes its modal.

// ---- types ----

type ReopenState =
  | { kind: 'idle' }
  | { kind: 'probing'; sessionId: string }
  | {
      kind: 'confirming';
      sessionId: string;
      projectPath: string;
      diff: WorkspaceDiff;
      /** Last failure shown above the form when a commit attempt failed
       *  validation. Cleared on the next submit. */
      lastFailureMessage?: string;
    }
  | {
      kind: 'committing';
      sessionId: string;
      projectPath: string;
      diff: WorkspaceDiff;
    }
  | {
      kind: 'failed';
      sessionId: string;
      reason: ReopenSessionFailureReason;
      message: string;
    };

type Action =
  | { type: 'open'; sessionId: string }
  | {
      type: 'confirm_required';
      sessionId: string;
      projectPath: string;
      diff: WorkspaceDiff;
    }
  | { type: 'commit_start'; sessionId: string }
  | {
      type: 'commit_failed_validation';
      sessionId: string;
      message: string;
    }
  | {
      type: 'failed';
      sessionId: string;
      reason: ReopenSessionFailureReason;
      message: string;
    }
  | { type: 'success'; sessionId: string }
  | { type: 'close' };

const initialState: ReopenState = { kind: 'idle' };

function reducer(state: ReopenState, action: Action): ReopenState {
  switch (action.type) {
    case 'open': {
      // Guard against re-open while a flow is in progress — operator
      // double-clicked or another surface fired. Drop the duplicate.
      if (state.kind !== 'idle') return state;
      return { kind: 'probing', sessionId: action.sessionId };
    }
    case 'confirm_required': {
      // Only transition if the reply matches the in-flight sessionId
      // (race-safety against a stale probe).
      if (state.kind !== 'probing' || state.sessionId !== action.sessionId) return state;
      return {
        kind: 'confirming',
        sessionId: action.sessionId,
        projectPath: action.projectPath,
        diff: action.diff,
      };
    }
    case 'commit_start': {
      if (state.kind !== 'confirming' || state.sessionId !== action.sessionId) return state;
      return {
        kind: 'committing',
        sessionId: state.sessionId,
        projectPath: state.projectPath,
        diff: state.diff,
      };
    }
    case 'commit_failed_validation': {
      // Validation failures (ack_required, typed_confirmation_required)
      // shown inline in the confirming form so the operator can fix +
      // re-submit. Reverts committing→confirming.
      if (action.sessionId !== currentSessionId(state)) return state;
      if (state.kind !== 'committing' && state.kind !== 'confirming') return state;
      const base =
        state.kind === 'committing'
          ? { kind: 'confirming' as const, ...stripCommitting(state) }
          : state;
      return { ...base, lastFailureMessage: action.message };
    }
    case 'failed': {
      // Hard failures (not_found, still_running, reactivate_failed,
      // chain_reconstruction_unsupported) replace the modal content with
      // a terminal error + Close button.
      if (action.sessionId !== currentSessionId(state)) return state;
      return {
        kind: 'failed',
        sessionId: action.sessionId,
        reason: action.reason,
        message: action.message,
      };
    }
    case 'success': {
      // `multi_agent_started` for the target arrives → adopt happened →
      // close. Match against current sessionId to avoid closing the
      // modal on an unrelated multi-agent start.
      if (action.sessionId !== currentSessionId(state)) return state;
      return initialState;
    }
    case 'close':
      return initialState;
  }
}

function currentSessionId(state: ReopenState): string | null {
  return state.kind === 'idle' ? null : state.sessionId;
}

function stripCommitting(s: Extract<ReopenState, { kind: 'committing' }>) {
  return {
    sessionId: s.sessionId,
    projectPath: s.projectPath,
    diff: s.diff,
  };
}

/**
 * Decide whether a `reopen_session_failed` reason is a soft-validation
 * failure (re-show form with inline error) or a hard failure (terminal
 * error state). The split mirrors the server-side reason taxonomy:
 *   - ack_required / typed_confirmation_required come from the typed
 *     gate; the operator can correct them in the form.
 *   - Everything else (not_found, still_running, no_participant,
 *     chain_reconstruction_unsupported, reactivate_failed) is a hard
 *     stop — re-prompting can't recover.
 */
export function isValidationFailure(reason: ReopenSessionFailureReason): boolean {
  return reason === 'ack_required' || reason === 'typed_confirmation_required';
}

// ---- context ----

type ActionsValue = {
  /** Operator clicked Reopen on a banner or notification. Opens the
   *  modal + sends the probe ClientMsg. */
  requestReopen: (sessionId: string) => void;
  /** Operator clicked Reopen in the modal (after typing confirmation
   *  if required). Sends the commit ClientMsg. */
  confirm: (args: { acknowledgedWorkspaceDiff: boolean; typedConfirmation?: string }) => void;
  /** Cancel / Close button or Esc — drops back to idle without
   *  notifying the server (no-op there; the gate was client-side). */
  close: () => void;
};

const StateCtx = createContext<ReopenState | null>(null);
const ActionsCtx = createContext<ActionsValue | null>(null);

export type ReopenProviderProps = {
  children: ReactNode;
  /** WS ClientMsg sink (App.tsx wraps wsRef.send). */
  send: (msg: ClientMsg) => void;
  /** App.tsx populates this ref so the WS message bridge can route
   *  reopen-related ServerMsgs into the provider — mirrors the
   *  GateModalsProvider / NotificationsBridge pattern. */
  handlerRef?: React.MutableRefObject<((msg: ServerMsg) => void) | null>;
};

export function ReopenProvider({ children, send, handlerRef }: ReopenProviderProps) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const requestReopen = useCallback<ActionsValue['requestReopen']>(
    (sessionId) => {
      // Guard duplicate clicks while a flow is in progress — operator
      // mashed the toast button or another surface fired. The reducer's
      // `open` case also drops these, but we mirror the guard here so a
      // duplicate ALSO doesn't ship a stray `reopen_session` ClientMsg
      // (which would still be benign on the server — the probe is
      // idempotent — but creates wire noise + log spam).
      if (state.kind !== 'idle') return;
      dispatch({ type: 'open', sessionId });
      send({ type: 'reopen_session', sessionId });
    },
    [send, state.kind],
  );

  const confirm = useCallback<ActionsValue['confirm']>(
    (args) => {
      // The reducer reads the in-flight sessionId from current state;
      // we don't need to thread it. But we DO need to read state to
      // know which sessionId to send — useReducer doesn't expose
      // current state inside a callback without a ref. Cheapest:
      // read via state closure on each render — useCallback re-binds
      // when state changes (state is in dep).
      const sid = currentSessionId(state);
      if (!sid) return;
      dispatch({ type: 'commit_start', sessionId: sid });
      send({
        type: 'reopen_session_confirmed',
        sessionId: sid,
        acknowledgedWorkspaceDiff: args.acknowledgedWorkspaceDiff,
        ...(args.typedConfirmation !== undefined
          ? { typedConfirmation: args.typedConfirmation }
          : {}),
      });
    },
    [send, state],
  );

  const close = useCallback<ActionsValue['close']>(() => {
    dispatch({ type: 'close' });
  }, []);

  // Bridge: route matching ServerMsgs from App.tsx into the provider.
  useEffect(() => {
    if (!handlerRef) return;
    handlerRef.current = (msg) => {
      if (msg.type === 'reopen_session_confirm_required') {
        dispatch({
          type: 'confirm_required',
          sessionId: msg.sessionId,
          projectPath: msg.projectPath,
          diff: msg.workspaceDiff,
        });
        return;
      }
      if (msg.type === 'reopen_session_failed') {
        if (isValidationFailure(msg.reason)) {
          dispatch({
            type: 'commit_failed_validation',
            sessionId: msg.sessionId,
            message: msg.message,
          });
        } else {
          dispatch({
            type: 'failed',
            sessionId: msg.sessionId,
            reason: msg.reason,
            message: msg.message,
          });
        }
        return;
      }
      if (msg.type === 'multi_agent_started') {
        // Server-side commit completed; emitResumedSession shipped the
        // standard envelope. Close our modal cleanly. (Match guarded
        // inside the reducer.)
        dispatch({ type: 'success', sessionId: msg.sessionId });
      }
    };
    return () => {
      handlerRef.current = null;
    };
  }, [handlerRef]);

  const actions = useMemo<ActionsValue>(
    () => ({ requestReopen, confirm, close }),
    [requestReopen, confirm, close],
  );

  return (
    <StateCtx.Provider value={state}>
      <ActionsCtx.Provider value={actions}>
        {children}
        <ReopenHost />
      </ActionsCtx.Provider>
    </StateCtx.Provider>
  );
}

// ---- hooks ----

export function useReopenState(): ReopenState {
  const ctx = useContext(StateCtx);
  if (!ctx) throw new Error('useReopenState requires <ReopenProvider>');
  return ctx;
}

export function useReopenActions(): ActionsValue {
  const ctx = useContext(ActionsCtx);
  if (!ctx) throw new Error('useReopenActions requires <ReopenProvider>');
  return ctx;
}

// ---- host ----

function ReopenHost() {
  const state = useReopenState();
  const { confirm, close } = useReopenActions();
  if (state.kind === 'idle') return null;
  return <ReopenSessionModal state={state} onConfirm={confirm} onClose={close} />;
}

export type { ReopenState };
