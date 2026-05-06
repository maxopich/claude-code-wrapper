import type {
  ContentBlock,
  Project,
  ServerMsg,
  SessionSummary,
  WrapperErrorKind,
} from '@cebab/shared/protocol';

export type MessageView =
  | { kind: 'user'; id: string; text: string }
  | {
      kind: 'assistant';
      id: string;
      blocks: ContentBlock[];
    }
  | { kind: 'system'; id: string; subtype: string; text: string }
  | {
      kind: 'result';
      id: string;
      subtype: string;
      cost: number;
      result?: string;
      errors?: string[];
    }
  | { kind: 'error'; id: string; errorKind: WrapperErrorKind; message: string }
  | {
      kind: 'permission_request';
      id: string;
      requestId: string;
      toolName: string;
      input: unknown;
      decided?: 'allow' | 'deny';
    };

export type SessionView = {
  id: string;
  projectId: number;
  status: 'idle' | 'running' | 'done' | 'error';
  messages: MessageView[];
  // Single rolling buffer for in-flight text deltas; cleared on assistant_message.
  streamingText: string;
};

export type AppState = {
  connected: boolean;
  projects: Project[];
  activeProjectId: number | null;

  // Loaded session views, keyed by [projectId][sessionId]. Multiple sessions
  // can be hydrated at once; the sidebar lets the user switch between them.
  sessionsByProject: Record<number, Record<string, SessionView>>;
  // The currently-shown session id per project (the chat view binds to this one).
  activeSessionByProject: Record<number, string | undefined>;
  // Pending optimistic session id per project (used before session_started arrives
  // for a brand-new conversation). Distinct because the user may also have a
  // hydrated past session active and start a new turn.
  pendingByProject: Record<number, string | undefined>;

  // sessionId → projectId, built from session_started and project_opened so we
  // can route incoming messages to the right project bucket.
  sessionToProject: Record<string, number>;

  // The known list of past sessions per project (from project_opened).
  knownSessions: Record<number, SessionSummary[]>;
  // Sessions currently running on this WebSocket connection.
  liveSessions: Record<string, true>;
};

export const initialState: AppState = {
  connected: false,
  projects: [],
  activeProjectId: null,
  sessionsByProject: {},
  activeSessionByProject: {},
  pendingByProject: {},
  sessionToProject: {},
  knownSessions: {},
  liveSessions: {},
};

let _id = 0;
const nextId = () => `m${++_id}`;

const PENDING_PREFIX = 'pending:';
const newPendingId = () => `${PENDING_PREFIX}${++_id}`;

function getActiveSessionId(state: AppState, projectId: number): string | undefined {
  return state.activeSessionByProject[projectId];
}

function putSession(
  state: AppState,
  projectId: number,
  sessionId: string,
  session: SessionView,
): AppState {
  const projectMap = state.sessionsByProject[projectId] ?? {};
  return {
    ...state,
    sessionsByProject: {
      ...state.sessionsByProject,
      [projectId]: { ...projectMap, [sessionId]: session },
    },
  };
}

function appendMessage(
  state: AppState,
  projectId: number,
  sessionId: string,
  message: MessageView,
): AppState {
  const session = state.sessionsByProject[projectId]?.[sessionId];
  if (!session) return state;
  return putSession(state, projectId, sessionId, {
    ...session,
    messages: [...session.messages, message],
  });
}

function projectFor(state: AppState, sessionId: string): number | null {
  const pid = state.sessionToProject[sessionId];
  return pid === undefined ? null : pid;
}

export type Action =
  | { type: 'ws_open' }
  | { type: 'ws_close' }
  | { type: 'server'; msg: ServerMsg }
  | { type: 'select_project'; projectId: number }
  | { type: 'select_session'; projectId: number; sessionId: string }
  | { type: 'new_session'; projectId: number }
  | { type: 'user_send'; text: string };

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'ws_open':
      return { ...state, connected: true };
    case 'ws_close':
      // Disconnect wipes liveness — any "running on this WS" claim is gone now.
      return { ...state, connected: false, liveSessions: {} };

    case 'select_project':
      return { ...state, activeProjectId: action.projectId };

    case 'select_session':
      return {
        ...state,
        activeProjectId: action.projectId,
        activeSessionByProject: {
          ...state.activeSessionByProject,
          [action.projectId]: action.sessionId,
        },
      };

    case 'new_session': {
      // Drop the active session id for this project so the next user_send
      // creates a fresh "pending:*" placeholder. We deliberately keep the
      // sessionsByProject map intact — the user might come back via the list.
      const next = { ...state.activeSessionByProject };
      delete next[action.projectId];
      const pending = { ...state.pendingByProject };
      delete pending[action.projectId];
      return {
        ...state,
        activeProjectId: action.projectId,
        activeSessionByProject: next,
        pendingByProject: pending,
      };
    }

    case 'user_send': {
      const projectId = state.activeProjectId;
      if (projectId === null) return state;
      let sessionId = getActiveSessionId(state, projectId);
      let session = sessionId ? state.sessionsByProject[projectId]?.[sessionId] : undefined;

      // No active session yet → spin up a pending one.
      if (!session) {
        sessionId = newPendingId();
        session = {
          id: sessionId,
          projectId,
          status: 'running',
          messages: [],
          streamingText: '',
        };
      }

      const next: SessionView = {
        ...session,
        status: 'running',
        messages: [...session.messages, { kind: 'user', id: nextId(), text: action.text }],
      };

      let s: AppState = putSession(state, projectId, sessionId!, next);
      s = {
        ...s,
        activeSessionByProject: {
          ...s.activeSessionByProject,
          [projectId]: sessionId,
        },
      };
      // Track the pending placeholder so we can rename it when session_started fires.
      if (sessionId!.startsWith(PENDING_PREFIX)) {
        s = {
          ...s,
          pendingByProject: { ...s.pendingByProject, [projectId]: sessionId },
        };
      }
      return s;
    }

    case 'server':
      return reduceServer(state, action.msg);
  }
}

function reduceServer(state: AppState, msg: ServerMsg): AppState {
  switch (msg.type) {
    case 'projects':
      return { ...state, projects: msg.projects };

    case 'project_opened': {
      const live: Record<string, true> = { ...state.liveSessions };
      const sessionToProject = { ...state.sessionToProject };
      for (const sid of msg.runningSessionIds) {
        live[sid] = true;
        sessionToProject[sid] = msg.projectId;
      }
      // Also remember sessionId → projectId for past sessions so a load_session
      // request can route history messages even before session_started replays.
      for (const s of msg.sessions) sessionToProject[s.id] = msg.projectId;
      return {
        ...state,
        knownSessions: { ...state.knownSessions, [msg.projectId]: msg.sessions },
        liveSessions: live,
        sessionToProject,
      };
    }

    case 'session_running': {
      const live: Record<string, true> = { ...state.liveSessions };
      if (msg.running) live[msg.sessionId] = true;
      else delete live[msg.sessionId];
      return {
        ...state,
        liveSessions: live,
        sessionToProject: {
          ...state.sessionToProject,
          [msg.sessionId]: msg.projectId,
        },
      };
    }

    case 'session_history_start': {
      // Reset the target session bucket so we can replay cleanly.
      const projectMap = { ...(state.sessionsByProject[msg.projectId] ?? {}) };
      projectMap[msg.sessionId] = {
        id: msg.sessionId,
        projectId: msg.projectId,
        status: 'running',
        messages: [],
        streamingText: '',
      };
      return {
        ...state,
        sessionsByProject: {
          ...state.sessionsByProject,
          [msg.projectId]: projectMap,
        },
        activeSessionByProject: {
          ...state.activeSessionByProject,
          [msg.projectId]: msg.sessionId,
        },
        sessionToProject: {
          ...state.sessionToProject,
          [msg.sessionId]: msg.projectId,
        },
      };
    }

    case 'session_history_end': {
      const session = state.sessionsByProject[msg.projectId]?.[msg.sessionId];
      if (!session) return state;
      // After replay, session is idle unless server signals it's still running.
      const stillRunning = state.liveSessions[msg.sessionId] === true;
      return putSession(state, msg.projectId, msg.sessionId, {
        ...session,
        status: stillRunning ? 'running' : session.status === 'running' ? 'done' : session.status,
      });
    }

    case 'session_started': {
      const projectId = msg.projectId;
      const projectMap = state.sessionsByProject[projectId] ?? {};
      const pendingId = state.pendingByProject[projectId];

      // Migrate the optimistic "pending:*" session into the real id, so the
      // user message we appended optimistically isn't lost.
      let session: SessionView;
      const nextProjectMap = { ...projectMap };
      if (pendingId && nextProjectMap[pendingId]) {
        session = {
          ...nextProjectMap[pendingId],
          id: msg.sessionId,
          status: 'running',
        };
        delete nextProjectMap[pendingId];
      } else if (nextProjectMap[msg.sessionId]) {
        session = { ...nextProjectMap[msg.sessionId], status: 'running' };
      } else {
        session = {
          id: msg.sessionId,
          projectId,
          status: 'running',
          messages: [],
          streamingText: '',
        };
      }

      session = {
        ...session,
        messages: [
          ...session.messages,
          {
            kind: 'system',
            id: nextId(),
            subtype: 'init',
            text: `session ${msg.sessionId.slice(0, 8)} • model ${msg.model} • ${msg.tools.length} tools`,
          },
        ],
      };
      nextProjectMap[msg.sessionId] = session;

      const knownList = state.knownSessions[projectId] ?? [];
      const alreadyKnown = knownList.some((s) => s.id === msg.sessionId);
      const knownNext = alreadyKnown
        ? knownList
        : [
            {
              id: msg.sessionId,
              title: null,
              createdAt: Date.now(),
              lastEventAt: Date.now(),
              totalCostUsd: 0,
            },
            ...knownList,
          ];

      const pendingNext = { ...state.pendingByProject };
      if (pendingNext[projectId] === pendingId) delete pendingNext[projectId];

      return {
        ...state,
        sessionsByProject: { ...state.sessionsByProject, [projectId]: nextProjectMap },
        activeSessionByProject: {
          ...state.activeSessionByProject,
          [projectId]: msg.sessionId,
        },
        pendingByProject: pendingNext,
        sessionToProject: { ...state.sessionToProject, [msg.sessionId]: projectId },
        knownSessions: { ...state.knownSessions, [projectId]: knownNext },
      };
    }

    case 'stream_delta': {
      if (msg.delta.kind !== 'text') return state;
      const projectId = projectFor(state, msg.sessionId);
      if (projectId === null) return state;
      const session = state.sessionsByProject[projectId]?.[msg.sessionId];
      if (!session) return state;
      return putSession(state, projectId, msg.sessionId, {
        ...session,
        streamingText: session.streamingText + msg.delta.text,
      });
    }

    case 'assistant_message': {
      const projectId = projectFor(state, msg.sessionId);
      if (projectId === null) return state;
      const session = state.sessionsByProject[projectId]?.[msg.sessionId];
      if (!session) return state;
      return putSession(state, projectId, msg.sessionId, {
        ...session,
        streamingText: '',
        messages: [...session.messages, { kind: 'assistant', id: msg.uuid, blocks: msg.blocks }],
      });
    }

    case 'user_message': {
      const projectId = projectFor(state, msg.sessionId);
      if (projectId === null) return state;
      const text = msg.blocks
        .map((b) => {
          if (b.type === 'tool_result') {
            const c = b.content;
            return typeof c === 'string' ? c : JSON.stringify(c);
          }
          return JSON.stringify(b);
        })
        .join('\n');
      return appendMessage(state, projectId, msg.sessionId, {
        kind: 'system',
        id: nextId(),
        subtype: 'tool_result',
        text,
      });
    }

    case 'permission_request': {
      const projectId = projectFor(state, msg.sessionId);
      if (projectId === null) return state;
      return appendMessage(state, projectId, msg.sessionId, {
        kind: 'permission_request',
        id: nextId(),
        requestId: msg.requestId,
        toolName: msg.toolName,
        input: msg.input,
      });
    }

    case 'system_event': {
      if (msg.subtype === 'status') return state;
      const projectId = projectFor(state, msg.sessionId);
      if (projectId === null) return state;
      return appendMessage(state, projectId, msg.sessionId, {
        kind: 'system',
        id: nextId(),
        subtype: msg.subtype,
        text: summarizeSystemEvent(msg.subtype, msg.payload),
      });
    }

    case 'result': {
      const projectId = projectFor(state, msg.sessionId);
      if (projectId === null) return state;
      const session = state.sessionsByProject[projectId]?.[msg.sessionId];
      if (!session) return state;
      return putSession(state, projectId, msg.sessionId, {
        ...session,
        status: msg.subtype === 'success' ? 'done' : 'error',
        messages: [
          ...session.messages,
          {
            kind: 'result',
            id: nextId(),
            subtype: msg.subtype,
            cost: msg.totalCostUsd,
            result: msg.result,
            errors: msg.errors,
          },
        ],
      });
    }

    case 'wrapper_error': {
      const projectId = msg.sessionId
        ? (projectFor(state, msg.sessionId) ?? state.activeProjectId)
        : state.activeProjectId;
      if (projectId === null) return state;
      const sessionId = msg.sessionId ?? getActiveSessionId(state, projectId) ?? newPendingId();
      const existing = state.sessionsByProject[projectId]?.[sessionId];
      const session: SessionView = existing ?? {
        id: sessionId,
        projectId,
        status: 'error',
        messages: [],
        streamingText: '',
      };
      return putSession(state, projectId, sessionId, {
        ...session,
        status: 'error',
        messages: [
          ...session.messages,
          {
            kind: 'error',
            id: nextId(),
            errorKind: msg.kind,
            message: msg.message,
          },
        ],
      });
    }
  }
}

function summarizeSystemEvent(subtype: string, payload: unknown): string {
  if (subtype === 'rate_limit' && typeof payload === 'object' && payload) {
    const p = payload as Record<string, unknown>;
    return `rate limit: ${p.status ?? '?'} (${p.rateLimitType ?? '?'})`;
  }
  if (subtype === 'api_retry' && typeof payload === 'object' && payload) {
    const p = payload as Record<string, unknown>;
    return `api retry ${p.attempt}/${p.max_retries} in ${p.retry_delay_ms}ms (${p.error})`;
  }
  return subtype;
}

export function activeSession(state: AppState): SessionView | null {
  if (state.activeProjectId === null) return null;
  const sid = state.activeSessionByProject[state.activeProjectId];
  if (!sid) return null;
  return state.sessionsByProject[state.activeProjectId]?.[sid] ?? null;
}

export function isSessionPending(sessionId: string): boolean {
  return sessionId.startsWith(PENDING_PREFIX);
}
