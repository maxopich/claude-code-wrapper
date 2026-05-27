import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';
import type { ClientMsg, ProjectAuthority, ServerMsg } from '@cebab/shared/protocol';

// Cluster B Phase 6b: AuthorityProvider — the state slice + WS plumbing for
// every <AuthorityPanel/> in the app.
//
// Why a sibling context (rather than the main `store.ts` reducer):
//   - The reducer is keyed by session, but `project_authority` is keyed by
//     project; folding it in would force every consumer of `state` to
//     re-render on every authority refresh.
//   - The AuthorityPanel mounts in three different chrome locations
//     (preflight modal, in-session disclosure, post-run review). A context
//     lets each location consume the snapshot without prop-drilling and
//     without each location re-issuing its own probe.
//   - Mirrors the InboxProvider / GateModalsProvider shape from Cluster A
//     Phase 5 + Cluster B Phase 6a — same handlerRef bridge so App.tsx's
//     onMessage doesn't need to know about authority-specific routing.
//
// Wire contract (per Phase 3 protocol):
//   - request: `get_project_authority { projectId, mode: 'cache' | 'probe' }`
//   - reply:   `project_authority { projectId, authority: ProjectAuthority | null }`
//
// Phase 3's BE-B3 returns `authority: null` if no session has started for
// the project on the current WS connection. The provider stores that as a
// distinct `'cache-miss'` state so the panel can show a "click Refresh to
// probe" CTA rather than a deceptive empty snapshot.

// ---- types ----

export type AuthoritySlot =
  | { status: 'idle' }
  | { status: 'requesting'; mode: 'cache' | 'probe'; since: number }
  | {
      status: 'ready';
      authority: ProjectAuthority;
      // The mode that PRODUCED this snapshot — handy for the panel header
      // ("Cached from last session" vs "Live probe N seconds ago").
      lastFetchedMode: 'cache' | 'probe';
      receivedAt: number;
    }
  | { status: 'cache-miss'; receivedAt: number };

type State = {
  byProject: Record<number, AuthoritySlot>;
};

type Action =
  | { type: 'request'; projectId: number; mode: 'cache' | 'probe'; now: number }
  | { type: 'receive'; projectId: number; authority: ProjectAuthority | null; now: number }
  | { type: 'reset'; projectId: number };

const initialState: State = { byProject: {} };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'request': {
      const prev = state.byProject[action.projectId];
      // Preserve the previous snapshot during a re-probe — the panel can
      // keep rendering stale data with a spinner overlay instead of
      // flashing empty.
      const next: AuthoritySlot =
        prev && prev.status === 'ready'
          ? prev // keep the ready data; status flag is in the panel header
          : { status: 'requesting', mode: action.mode, since: action.now };
      return { byProject: { ...state.byProject, [action.projectId]: next } };
    }
    case 'receive': {
      const prev = state.byProject[action.projectId];
      const lastMode: 'cache' | 'probe' =
        prev && prev.status === 'requesting'
          ? prev.mode
          : prev && prev.status === 'ready'
            ? prev.lastFetchedMode
            : 'cache';
      const slot: AuthoritySlot = action.authority
        ? {
            status: 'ready',
            authority: action.authority,
            lastFetchedMode: lastMode,
            receivedAt: action.now,
          }
        : { status: 'cache-miss', receivedAt: action.now };
      return { byProject: { ...state.byProject, [action.projectId]: slot } };
    }
    case 'reset': {
      if (!state.byProject[action.projectId]) return state;
      const { [action.projectId]: _drop, ...rest } = state.byProject;
      void _drop;
      return { byProject: rest };
    }
  }
}

// ---- contexts ----

type ActionsValue = {
  /**
   * Ask the server for an authority snapshot for `projectId`. `mode: 'cache'`
   * returns whatever the resolver has cached from the last `session_started`;
   * `mode: 'probe'` will (Phase 3b) spawn a `maxTurns: 0` SDK run for live
   * state. Today both return the cache shape — the spec's "Refresh" button
   * passes 'probe' so the wire shape is forward-compatible.
   */
  request: (projectId: number, mode: 'cache' | 'probe') => void;
  /** Drop the cached slot — used on project rename / close (Phase 6e). */
  reset: (projectId: number) => void;
};

const StateCtx = createContext<State | null>(null);
const ActionsCtx = createContext<ActionsValue | null>(null);

// ---- provider ----

export type AuthorityProviderProps = {
  children: ReactNode;
  /** WS ClientMsg sink. Same shape as InboxProvider's `send`. */
  send: (msg: ClientMsg) => void;
  /**
   * Bridge for App.tsx's WS message bridge: assign this ref on mount and
   * the provider routes `project_authority` envelopes into the reducer.
   * Mirrors NotificationsBridge / InboxProvider / GateModalsProvider — keeps
   * the provider untangled from App.tsx's onMessage plumbing.
   */
  handlerRef?: React.MutableRefObject<((msg: ServerMsg) => void) | null>;
};

export function AuthorityProvider({ children, send, handlerRef }: AuthorityProviderProps) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const request = useCallback<ActionsValue['request']>(
    (projectId, mode) => {
      dispatch({ type: 'request', projectId, mode, now: Date.now() });
      send({ type: 'get_project_authority', projectId, mode });
    },
    [send],
  );

  const reset = useCallback<ActionsValue['reset']>((projectId) => {
    dispatch({ type: 'reset', projectId });
  }, []);

  // Bridge: route project_authority envelopes from the WS into the reducer.
  useEffect(() => {
    if (!handlerRef) return;
    handlerRef.current = (msg) => {
      if (msg.type !== 'project_authority') return;
      dispatch({
        type: 'receive',
        projectId: msg.projectId,
        authority: msg.authority,
        now: Date.now(),
      });
    };
    return () => {
      handlerRef.current = null;
    };
  }, [handlerRef]);

  const actions = useMemo<ActionsValue>(() => ({ request, reset }), [request, reset]);

  return (
    <StateCtx.Provider value={state}>
      <ActionsCtx.Provider value={actions}>{children}</ActionsCtx.Provider>
    </StateCtx.Provider>
  );
}

// ---- hooks ----

/**
 * Read the AuthoritySlot for a project. Returns `{ status: 'idle' }` if the
 * project has never been queried — the panel uses that to render an
 * initial-load CTA before firing its first request.
 */
export function useAuthoritySlot(projectId: number): AuthoritySlot {
  const ctx = useContext(StateCtx);
  if (!ctx) throw new Error('useAuthoritySlot requires <AuthorityProvider>');
  return ctx.byProject[projectId] ?? { status: 'idle' };
}

export function useAuthorityActions(): ActionsValue {
  const ctx = useContext(ActionsCtx);
  if (!ctx) throw new Error('useAuthorityActions requires <AuthorityProvider>');
  return ctx;
}
