/**
 * `Cebab-ormv`: the live MCP slice — what this project's MCP servers are doing
 * NOW, and the operator's four actions on them.
 *
 * WHY IT IS ITS OWN CONTEXT rather than a slot in `store.ts`, same two reasons
 * `AuthorityContext` gives plus one of its own. It is project-scoped and
 * operator-initiated, so routing it through the main reducer would re-render
 * every chat row each time someone clicks Reconnect. And an `authenticate`
 * reply carries an `authUrl` that embeds the operator's organization id — the
 * main store is what the debug surfaces read, and that envelope must not settle
 * there.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: poll. Serving one request spawns a `claude`
 * process and runs the project's `SessionStart` hooks under its own Trust. It
 * costs no model turn — measured — but "free of tokens" is not "free", and a
 * panel that refreshed itself on a timer would be running the operator's hooks
 * on a timer. Every request here traces to a click.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';
import type { ClientMsg, McpControlOp, ServerMsg } from '@cebab/shared/protocol';
import type { McpServerLive } from '@cebab/shared';

/** Which row, if any, has an action in flight. Per-row rather than per-panel so
 *  one server's reconnect does not grey out the rest. */
export type McpBusy = { serverName: string; op: McpControlOp } | null;

/**
 * An `authenticate` that produced a URL the operator has not acted on yet.
 *
 * Held here and nowhere else — never in the main store, never logged. Cleared
 * as soon as any further op runs for the project, because the most likely next
 * op is the re-check that makes it stale.
 */
export type PendingAuth = { serverName: string; authUrl: string } | null;

export type McpSlot =
  | { status: 'idle' }
  | { status: 'loading' }
  | {
      status: 'ready';
      servers: McpServerLive[];
      receivedAt: number;
      /** A read is in flight over already-rendered data. Keeps the rows on
       *  screen instead of flashing empty — the property `AuthoritySlot`'s
       *  `refreshing` flag exists for, for the same reason. */
      refreshing?: boolean;
      busy?: McpBusy;
      /** The last op's failure, verbatim from the CLI. Sits beside the rows
       *  rather than replacing them: a refused reconnect is exactly when the
       *  operator most needs to see the list. */
      error?: string;
      pendingAuth?: PendingAuth;
      /** The last op hit the OAuth-callback arm Cebab does not implement. */
      callbackUnsupported?: boolean;
    }
  /** The READ failed — `servers: null` on the wire. Distinct from a `ready`
   *  slot holding an empty array, which means this project genuinely loads no
   *  MCP servers. */
  | { status: 'failed'; error: string; receivedAt: number };

type State = { byProject: Record<number, McpSlot> };

type Action =
  | { type: 'request'; projectId: number; op: McpControlOp; serverName?: string }
  | {
      type: 'receive';
      projectId: number;
      op: McpControlOp;
      serverName?: string;
      servers: McpServerLive[] | null;
      authUrl?: string;
      callbackUnsupported?: boolean;
      error?: string;
      now: number;
    }
  | { type: 'reset'; projectId: number };

const initialState: State = { byProject: {} };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'request': {
      const prev = state.byProject[action.projectId];
      const busy: McpBusy =
        action.serverName !== undefined ? { serverName: action.serverName, op: action.op } : null;
      const next: McpSlot =
        prev && prev.status === 'ready'
          ? // Keep the rows. A request must be OBSERVABLE, though — returning
            // `prev` untouched is the bug `AuthoritySlot.refreshing` was added
            // to fix, where nothing downstream could tell "already asked" from
            // "never asked".
            {
              ...prev,
              refreshing: true,
              busy,
              // The previous op's outcome is not this op's outcome. Clearing
              // here rather than on receive means the operator never sees a
              // stale error sitting under a spinner.
              error: undefined,
              pendingAuth: null,
              callbackUnsupported: false,
            }
          : { status: 'loading' };
      return { byProject: { ...state.byProject, [action.projectId]: next } };
    }
    case 'receive': {
      if (action.servers === null) {
        return {
          byProject: {
            ...state.byProject,
            [action.projectId]: {
              status: 'failed',
              error: action.error ?? 'the MCP read failed',
              receivedAt: action.now,
            },
          },
        };
      }
      const slot: McpSlot = {
        status: 'ready',
        servers: action.servers,
        receivedAt: action.now,
        busy: null,
        ...(action.error !== undefined ? { error: action.error } : {}),
        ...(action.authUrl !== undefined && action.serverName !== undefined
          ? { pendingAuth: { serverName: action.serverName, authUrl: action.authUrl } }
          : {}),
        ...(action.callbackUnsupported ? { callbackUnsupported: true } : {}),
      };
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

type ActionsValue = {
  /** Read the live list. The only op with no side effect beyond the spawn. */
  refresh: (projectId: number) => void;
  /**
   * Act on one server.
   *
   * `reconnect` CANNOT clear `needs-auth` — measured; the CLI refuses it — so
   * callers must not offer it there. `mcpActionsFor` below is what decides,
   * so no call site has to remember.
   */
  act: (projectId: number, op: McpControlOp, serverName: string, enabled?: boolean) => void;
  reset: (projectId: number) => void;
};

const StateCtx = createContext<State | null>(null);
const ActionsCtx = createContext<ActionsValue | null>(null);

export type McpControlProviderProps = {
  children: ReactNode;
  send: (msg: ClientMsg) => void;
  /** Bridge for App.tsx's WS message plumbing, exactly as AuthorityProvider
   *  and GateModalsProvider take one. */
  handlerRef?: React.MutableRefObject<((msg: ServerMsg) => void) | null>;
};

export function McpControlProvider({ children, send, handlerRef }: McpControlProviderProps) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const refresh = useCallback<ActionsValue['refresh']>(
    (projectId) => {
      dispatch({ type: 'request', projectId, op: 'status' });
      send({ type: 'mcp_control', projectId, op: 'status' });
    },
    [send],
  );

  const act = useCallback<ActionsValue['act']>(
    (projectId, op, serverName, enabled) => {
      dispatch({ type: 'request', projectId, op, serverName });
      send({
        type: 'mcp_control',
        projectId,
        op,
        serverName,
        ...(enabled !== undefined ? { enabled } : {}),
      });
    },
    [send],
  );

  const reset = useCallback<ActionsValue['reset']>((projectId) => {
    dispatch({ type: 'reset', projectId });
  }, []);

  useEffect(() => {
    if (!handlerRef) return;
    handlerRef.current = (msg) => {
      if (msg.type !== 'mcp_control_result') return;
      dispatch({
        type: 'receive',
        projectId: msg.projectId,
        op: msg.op,
        ...(msg.serverName !== undefined ? { serverName: msg.serverName } : {}),
        servers: msg.servers,
        ...(msg.authUrl !== undefined ? { authUrl: msg.authUrl } : {}),
        ...(msg.callbackUnsupported ? { callbackUnsupported: true } : {}),
        ...(msg.error !== undefined ? { error: msg.error } : {}),
        now: Date.now(),
      });
    };
    return () => {
      handlerRef.current = null;
    };
  }, [handlerRef]);

  const actions = useMemo<ActionsValue>(() => ({ refresh, act, reset }), [refresh, act, reset]);

  return (
    <StateCtx.Provider value={state}>
      <ActionsCtx.Provider value={actions}>{children}</ActionsCtx.Provider>
    </StateCtx.Provider>
  );
}

export function useMcpSlot(projectId: number): McpSlot {
  const ctx = useContext(StateCtx);
  if (!ctx) throw new Error('useMcpSlot must be used inside <McpControlProvider>');
  return ctx.byProject[projectId] ?? { status: 'idle' };
}

export function useMcpActions(): ActionsValue {
  const ctx = useContext(ActionsCtx);
  if (!ctx) throw new Error('useMcpActions must be used inside <McpControlProvider>');
  return ctx;
}

/**
 * Which actions are honest for a server in this state.
 *
 * ONE FUNCTION DECIDES, and that is the point rather than a tidiness
 * preference. The measured rule is narrow and easy to get wrong in the
 * dangerous direction: `reconnect` against a `needs-auth` server does not
 * re-authenticate it — the CLI throws `Server status: needs-auth` — so a
 * Reconnect button there is a button that cannot work. Offering the right
 * action per status is the difference between this feature and the "Retry that
 * quietly does nothing" the MCP banner refused to ship.
 *
 * `connected` still offers `clear_auth`, because signing out is how an operator
 * re-authenticates as somebody else; it is not a repair action.
 */
export function mcpActionsFor(status: string): McpControlOp[] {
  switch (status) {
    case 'needs-auth':
      // NOT 'reconnect'. See above.
      return ['authenticate'];
    case 'failed':
    case 'pending':
      return ['reconnect'];
    case 'connected':
      return ['clear_auth'];
    case 'disabled':
      return ['toggle'];
    default:
      // An unknown status is a status Cebab has not measured. Offer the one
      // action that cannot make things worse and cannot mislead: try again.
      // The same instinct `mcp_status.ts` applies to naming a status — do not
      // invent a meaning for a value nobody has seen.
      return ['reconnect'];
  }
}
