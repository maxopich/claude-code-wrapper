import type {
  AgentActivityPhase,
  ContentBlock,
  IterationSummary,
  MultiAgentEventKind,
  MultiAgentLifecycle,
  MultiAgentMutationView,
  MultiAgentTemplate,
  PendingRetryDescriptor,
  Project,
  ServerMsg,
  SessionPermissionMode,
  SessionSummary,
  WrapperErrorKind,
} from '@cebab/shared/protocol';
import type { MutationCategory } from '@cebab/shared';

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
      /** Item #5: server-classified category from `classifyToolCall`. Optional
       *  so a replay of a pre-Item-5 permission_request still renders via the
       *  JSON-fallback subcomponent. */
      category?: MutationCategory;
      /** Item #5: server-classified one-line summary. */
      summary?: string;
      /** Item #5: absolute cwd the tool will run in (the project's `path`). */
      cwd?: string;
      /** Item #5: human-readable project name. */
      projectName?: string;
    };

export type SessionView = {
  id: string;
  projectId: number;
  status: 'idle' | 'running' | 'done' | 'error';
  messages: MessageView[];
  // Single rolling buffer for in-flight text deltas; cleared on assistant_message.
  streamingText: string;
  // Epoch ms when the current turn started (the instant the user feels the
  // wait begin), or null when no turn is in flight. Anchors the thinking
  // indicator's elapsed timer. Set on send, cleared on result/error/replay.
  runStartedAt: number | null;
};

/**
 * One inter-agent event as shown in the multi-agent scrollback. Mirrors the
 * payload of the `multi_agent_event` ServerMsg with the runtime fields the
 * scrollback view needs.
 */
export type MultiAgentEventView = {
  eventId: number;
  ts: number;
  source: string;
  destination: string;
  kind: MultiAgentEventKind;
  text: string;
};

export type MultiAgentRunStatus = 'running' | 'completed' | 'stopped' | 'crashed';

/**
 * Latest ephemeral liveness tick for the run's in-flight turn. Mirrors the
 * `agent_activity` ServerMsg sans `sessionId`. NOT persisted and NOT
 * replayed: cleared to null on `idle`, on `multi_agent_ended`, and never
 * survives a reload (the spine re-syncs from the durable hop timeline).
 */
export type MultiAgentActivity = {
  agentName: string;
  /** 'working' | 'stalled' — `idle` is represented as `activity: null`. */
  phase: Exclude<AgentActivityPhase, 'idle'>;
  currentTool?: string;
  lastActivityTs: number;
  turnStartedAt: number;
};

/**
 * Live state for an in-progress (or just-finished) multi-agent session.
 * Cleared by the operator via `ma_dismiss_active` once they're done
 * reviewing — returns the tab to its draft view.
 */
export type MultiAgentRun = {
  sessionId: string;
  mode: 'chain' | 'orchestrator';
  participantAgentNames: string[];
  status: MultiAgentRunStatus;
  events: MultiAgentEventView[];
  /** Set when the chain completes successfully; points at the iteration
   *  directory under the session folder. */
  iterationId: string | null;
  /** Lifecycle mode echoed back from the server. Drives the End-button
   *  affordance (persistent → "Stop"; temp → "End & cleanup" with
   *  confirm dialog). */
  lifecycle: MultiAgentLifecycle;
  /** Absolute path to the on-disk session folder. Shown in the
   *  active-run header so the operator can copy/inspect. */
  sessionFolder: string;
  /** True when this run was reconstructed after a Cebab server restart
   *  (R-B) and is re-attached READ-ONLY. The UI shows a Continue banner
   *  instead of the prompt input until the operator continues; cleared
   *  optimistically on click (`ma_clear_awaiting`). */
  awaitingContinue: boolean;
  /** Ephemeral liveness of the in-flight turn (current tool, working vs.
   *  stalled). null = no turn computing / turn just ended. Drives the
   *  activity bar only; never persisted, reset on reload. */
  activity: MultiAgentActivity | null;
  /** Hard cap on persisted hops for this session (resolved server-side at
   *  start/reconstruct). Drives the activity-bar chip `events.length /
   *  hopBudget` and the "Hop budget" row in Session info; the actual
   *  enforcement happens in the router. */
  hopBudget: number;
  /** Item #4 pending-retry slot. Populated when a worker's deliverTurn
   *  failed and the operator hasn't yet retried or abandoned. Drives the
   *  Retry/Abandon banner above the prompt input and gates the
   *  UserPromptInput render (one decision at a time, mirroring how
   *  `awaitingContinue` does the same). Cleared optimistically on Retry
   *  click via `ma_clear_pending_retry` and authoritatively by
   *  `multi_agent_pending_retry { pending: null }` on success/abandon. */
  pendingRetry: PendingRetryDescriptor | null;
  /** Item #5: opt-in pause-on-first-mutation flag for this session. Reflects
   *  the operator's choice at session start. UI surfaces it as a read-only
   *  row in Session info (the toggle itself lives in setup). */
  pauseOnMutation: boolean;
  /** Item #5: true once the operator has clicked Continue at least once.
   *  When true, subsequent mutations auto-allow. Mirrored from server. */
  mutationsAcknowledged: boolean;
  /** Item #5: all classified non-'read' tool calls observed during this
   *  session, ordered by ts ascending. Drives the Session-info "Mutations"
   *  disclosure + activity-bar counter chip. Deduped by `mutation.id` so
   *  the live `multi_agent_mutation` ServerMsg + the initial replay on
   *  attach can both populate it without doubling rows. */
  mutations: MultiAgentMutationView[];
  /** Item #5: pause-on-first-mutation slot. Populated when a worker is
   *  about to mutate AND `pauseOnMutation && !mutationsAcknowledged`. Drives
   *  the pause banner; gates `UserPromptInput` (same one-decision-at-a-time
   *  pattern as `awaitingContinue` / `pendingRetry`). Cleared optimistically
   *  on Continue click and authoritatively by
   *  `multi_agent_pending_mutation { pending: null }`. */
  pendingMutation: MultiAgentMutationView | null;
};

/**
 * Multi-agent / bus runtime UI state. Lives alongside the existing
 * SDK-runtime state because the two runtimes are independent — the
 * operator can have a chat session open and a multi-agent draft being
 * assembled at the same time.
 */
export type MultiAgentState = {
  /** Which top-level main view is showing. The two multi-agent tabs ARE
   * the mode: 'multi-agent' = orchestrator-routed, 'chained-chat' = chain.
   * There is no separate mode field — the active tab is the source of truth. */
  view: 'chat' | 'multi-agent' | 'chained-chat';
  /** Currently selected lifecycle for the next start. Defaults to
   *  'persistent' (safer — folder survives End, can be resumed). The
   *  operator opts into 'temp' explicitly. */
  draftLifecycle: MultiAgentLifecycle;
  /** Ordered project ids currently in the Multi-Agent drop zone. Order
   * matters for chain mode and is preserved as-dropped for orchestrator
   * mode too (cosmetic but predictable). */
  draftParticipants: number[];
  /** The seed input the operator types before clicking Start. In chain
   *  mode it rides the first participant's opening turn. */
  draftPrompt: string;
  /** Item #5: setup-screen opt-in for pause-on-first-mutation. Persists
   *  during the session draft; sent on `start_multi_agent` as
   *  `pauseOnMutation`. Default false; the operator opts in explicitly. */
  draftPauseOnMutation: boolean;
  /** Non-null while a chain (or future orchestrator session) is running, and
   *  until the operator dismisses it. */
  active: MultiAgentRun | null;
  /**
   * Past iterations, populated by the `iterations` ServerMsg in response to
   * `list_iterations`. The Multi-Agent tab requests the list on mount and
   * after each `multi_agent_ended` event so the most-recent run shows up
   * without a manual refresh.
   *
   * `null` means "not yet fetched on this connection". An empty array
   * means "fetched, no iterations recorded".
   */
  iterations: IterationSummary[] | null;
  /**
   * Saved draft presets, populated by the `templates` ServerMsg. `null`
   * = not yet fetched on this connection; `[]` = fetched, none saved.
   * Same lazy-load contract as `iterations`.
   */
  templates: MultiAgentTemplate[] | null;
  /**
   * Count of participant ids dropped by the most recent template apply
   * because they're no longer in `projects` (deleted / workspace changed).
   * 0 = clean apply. Reset to 0 by the next apply or any manual participant
   * edit so a stale warning never lingers.
   */
  lastAppliedDropped: number;
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
  // Per-session permission mode (mirrors server-side state).
  permissionModeBySession: Record<string, SessionPermissionMode>;
  // Workspace settings reported by the server. `null` means we haven't asked yet.
  settings: SettingsView | null;
  // Monotonic counter bumped on every `wrapper_error`. Pending-state effects
  // key off it to clear stuck spinners when an async action fails — it's the
  // only generic "an error happened" signal (wrapper_error otherwise routes
  // into a chat session's message list, invisible to the multi-agent tab).
  wrapperErrorSeq: number;
  // Multi-agent draft + view state.
  multiAgent: MultiAgentState;
};

export type SettingsView = {
  workspaceRoot: string | null;
  workspaceRootValid: boolean;
  defaultWorkspaceRoot: string;
  /** Resolved default hop budget (DB > env > built-in). The Settings modal's
   *  input is seeded from this and shows the operator the current effective
   *  value regardless of which precedence step won. */
  defaultHopBudget: number;
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
  permissionModeBySession: {},
  settings: null,
  wrapperErrorSeq: 0,
  multiAgent: {
    view: 'chat',
    draftLifecycle: 'persistent',
    draftParticipants: [],
    draftPrompt: '',
    draftPauseOnMutation: false,
    active: null,
    iterations: null,
    templates: null,
    lastAppliedDropped: 0,
  },
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
  | { type: 'user_send'; text: string }
  | { type: 'ma_set_view'; view: 'chat' | 'multi-agent' | 'chained-chat' }
  | { type: 'ma_set_lifecycle'; lifecycle: MultiAgentLifecycle }
  | { type: 'ma_add_participant'; projectId: number }
  | { type: 'ma_remove_participant'; projectId: number }
  | { type: 'ma_reorder_participant'; projectId: number; direction: 'up' | 'down' }
  | { type: 'ma_set_draft_prompt'; text: string }
  | { type: 'ma_set_draft_pause_on_mutation'; value: boolean }
  | { type: 'ma_apply_template'; template: MultiAgentTemplate }
  | { type: 'ma_dismiss_active' }
  | { type: 'ma_clear_awaiting' }
  | { type: 'ma_clear_pending_retry' }
  | { type: 'ma_clear_pending_mutation' };

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
          runStartedAt: Date.now(),
        };
      }

      const next: SessionView = {
        ...session,
        status: 'running',
        // New turn begins now — anchor the elapsed timer at send time so it
        // counts the full wait, including the pre-first-token gap.
        runStartedAt: Date.now(),
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

    case 'ma_set_view':
      return { ...state, multiAgent: { ...state.multiAgent, view: action.view } };

    case 'ma_set_lifecycle':
      return {
        ...state,
        multiAgent: { ...state.multiAgent, draftLifecycle: action.lifecycle },
      };

    case 'ma_add_participant': {
      const cur = state.multiAgent.draftParticipants;
      // Drag-twice is a no-op. Order preserved by append-only.
      if (cur.includes(action.projectId)) return state;
      // Reject ids that aren't in the current project list — protects against
      // a stale drag payload (e.g. project deleted in another tab between
      // dragstart and drop).
      if (!state.projects.some((p) => p.id === action.projectId)) return state;
      return {
        ...state,
        multiAgent: {
          ...state.multiAgent,
          draftParticipants: [...cur, action.projectId],
          lastAppliedDropped: 0,
        },
      };
    }

    case 'ma_remove_participant':
      return {
        ...state,
        multiAgent: {
          ...state.multiAgent,
          draftParticipants: state.multiAgent.draftParticipants.filter(
            (id) => id !== action.projectId,
          ),
          lastAppliedDropped: 0,
        },
      };

    case 'ma_reorder_participant': {
      const list = state.multiAgent.draftParticipants;
      const idx = list.indexOf(action.projectId);
      if (idx === -1) return state;
      const swap = action.direction === 'up' ? idx - 1 : idx + 1;
      if (swap < 0 || swap >= list.length) return state;
      const next = list.slice();
      [next[idx], next[swap]] = [next[swap]!, next[idx]!];
      return {
        ...state,
        multiAgent: { ...state.multiAgent, draftParticipants: next, lastAppliedDropped: 0 },
      };
    }

    case 'ma_set_draft_prompt':
      return { ...state, multiAgent: { ...state.multiAgent, draftPrompt: action.text } };

    case 'ma_set_draft_pause_on_mutation':
      return {
        ...state,
        multiAgent: { ...state.multiAgent, draftPauseOnMutation: action.value },
      };

    case 'ma_apply_template': {
      // Atomic fill: lifecycle + participants in one transition. Mode is NOT
      // applied — the active tab is the mode, and template lists are filtered
      // to the tab's mode, so an applied template's mode always matches.
      // Reuse the `projects`-reducer staleness filter so a template that
      // references a since-deleted project degrades instead of erroring;
      // the dropped count drives a UI warning. draftPrompt is left alone.
      const knownIds = new Set(state.projects.map((p) => p.id));
      const filtered = action.template.participants.filter((id) => knownIds.has(id));
      return {
        ...state,
        multiAgent: {
          ...state.multiAgent,
          draftLifecycle: action.template.lifecycle,
          draftParticipants: filtered,
          lastAppliedDropped: action.template.participants.length - filtered.length,
        },
      };
    }

    case 'ma_dismiss_active':
      // Only allow dismissing an ended run; refusing to drop a live session
      // protects against an accidental click while events are still streaming.
      if (!state.multiAgent.active || state.multiAgent.active.status === 'running') return state;
      return { ...state, multiAgent: { ...state.multiAgent, active: null } };

    case 'ma_clear_awaiting': {
      // Optimistic: the operator clicked Continue. Drop the read-only gate
      // immediately so the prompt input returns; the server clears the DB
      // flag and streams the orchestrator's resumed turn.
      const active = state.multiAgent.active;
      if (!active || !active.awaitingContinue) return state;
      return {
        ...state,
        multiAgent: {
          ...state.multiAgent,
          active: { ...active, awaitingContinue: false },
        },
      };
    }

    case 'ma_clear_pending_retry': {
      // Optimistic: the operator clicked Retry. Drop the banner immediately
      // so the UI doesn't double-render between click and server echo. The
      // server clears the DB slot and replays the captured prompt; if the
      // retried turn fails again, the next `multi_agent_pending_retry`
      // ServerMsg re-asserts a new descriptor.
      const active = state.multiAgent.active;
      if (!active || !active.pendingRetry) return state;
      return {
        ...state,
        multiAgent: {
          ...state.multiAgent,
          active: { ...active, pendingRetry: null },
        },
      };
    }

    case 'ma_clear_pending_mutation': {
      // Item #5: optimistic clear on Continue click. Also sets
      // `mutationsAcknowledged: true` locally so subsequent mutations don't
      // re-pause the UI in the brief window before the server's
      // `multi_agent_pending_mutation { pending: null }` echo arrives.
      const active = state.multiAgent.active;
      if (!active || !active.pendingMutation) return state;
      return {
        ...state,
        multiAgent: {
          ...state.multiAgent,
          active: {
            ...active,
            pendingMutation: null,
            mutationsAcknowledged: true,
          },
        },
      };
    }

    case 'server':
      return reduceServer(state, action.msg);
  }
}

function reduceServer(state: AppState, msg: ServerMsg): AppState {
  switch (msg.type) {
    case 'projects': {
      // Prune any drafted multi-agent participants that vanished from the
      // refreshed list. Without this, a workspace switch would leave dangling
      // ids in the drop zone that no longer match any project. The order of
      // the remaining ids is preserved.
      const knownIds = new Set(msg.projects.map((p) => p.id));
      const prunedDraft = state.multiAgent.draftParticipants.filter((id) => knownIds.has(id));
      const draftChanged = prunedDraft.length !== state.multiAgent.draftParticipants.length;
      const nextMultiAgent = draftChanged
        ? { ...state.multiAgent, draftParticipants: prunedDraft }
        : state.multiAgent;

      // When a fresh project list arrives that no longer contains the
      // currently-active project (typical case: user changed the workspace
      // root), drop activeProjectId and the orphaned session state. Without
      // this, the sidebar shows the new projects but the chat pane keeps
      // rendering the previously-active session via activeSession(state),
      // and the user feels like "the list didn't refresh".
      const activeStillPresent =
        state.activeProjectId !== null && msg.projects.some((p) => p.id === state.activeProjectId);
      if (activeStillPresent) {
        return { ...state, projects: msg.projects, multiAgent: nextMultiAgent };
      }
      return {
        ...state,
        projects: msg.projects,
        activeProjectId: null,
        // The session-related state below is keyed by project id; without a
        // valid active project, none of it can render meaningfully. Clear it
        // so a future workspace switch starts clean (re-populated via
        // open_project / load_session when the user picks a new entry).
        activeSessionByProject: {},
        sessionsByProject: {},
        pendingByProject: {},
        sessionToProject: {},
        knownSessions: {},
        permissionModeBySession: {},
        multiAgent: nextMultiAgent,
      };
    }

    case 'bus_integration_changed': {
      // Defensive in-place update — the server also sends a refreshed
      // `projects` payload right after, but applying the targeted change
      // first keeps the UI snappy and idempotent under reordering. If the
      // project id isn't tracked (rare race; would be replaced by the
      // followup `projects` anyway), skip silently.
      const idx = state.projects.findIndex((p) => p.id === msg.projectId);
      if (idx === -1) return state;
      const next = state.projects.slice();
      next[idx] = {
        ...next[idx]!,
        busInstalled: msg.installed,
        busAgentName: msg.agentName,
      };
      return { ...state, projects: next };
    }

    case 'multi_agent_started': {
      // Transition the Multi-Agent tab into "running" mode. Clear any prior
      // run that the operator hadn't dismissed yet — a new Start is a
      // deliberate signal that we're moving on.
      return {
        ...state,
        multiAgent: {
          ...state.multiAgent,
          // Auto-switch to the matching tab so the operator sees the
          // scrollback even if the start was triggered from elsewhere.
          view: msg.mode === 'chain' ? 'chained-chat' : 'multi-agent',
          active: {
            sessionId: msg.sessionId,
            mode: msg.mode,
            participantAgentNames: msg.participantAgentNames,
            status: 'running',
            events: [],
            iterationId: null,
            lifecycle: msg.lifecycle,
            sessionFolder: msg.sessionFolder,
            awaitingContinue: msg.awaitingContinue ?? false,
            activity: null,
            hopBudget: msg.hopBudget,
            pendingRetry: msg.pendingRetry ?? null,
            // Item #5: hydrate pause-on-mutation overlay state from
            // `multi_agent_started`. Always populated (server resolves and
            // sends `false` + `[]` for fresh starts; reads DB for R-A/R-B).
            pauseOnMutation: msg.pauseOnMutation,
            mutationsAcknowledged: msg.mutationsAcknowledged,
            mutations: msg.mutations,
            pendingMutation: msg.pendingMutation ?? null,
          },
        },
      };
    }

    case 'multi_agent_event': {
      const active = state.multiAgent.active;
      if (!active || active.sessionId !== msg.sessionId) return state;
      // De-dupe by eventId. The server numbers events monotonically; in
      // practice we never see duplicates, but a defensive check costs ~O(N)
      // on an unbounded list. For a multi-agent session the event count is
      // small (dozens, not thousands), so the scan is fine. If this grows,
      // swap for a tail-only check or a Map<eventId, EventView>.
      if (active.events.some((e) => e.eventId === msg.eventId)) return state;
      return {
        ...state,
        multiAgent: {
          ...state.multiAgent,
          active: {
            ...active,
            events: [
              ...active.events,
              {
                eventId: msg.eventId,
                ts: msg.ts,
                source: msg.source,
                destination: msg.destination,
                kind: msg.kind,
                text: msg.text,
              },
            ],
          },
        },
      };
    }

    case 'agent_activity': {
      const active = state.multiAgent.active;
      if (!active || active.sessionId !== msg.sessionId) return state;
      // Ephemeral: 'idle' (turn ended) clears the live row; 'working' /
      // 'stalled' replace it wholesale. Never appended to `events` — the
      // durable timeline is the persisted hops, this is just the pulse.
      const activity: MultiAgentActivity | null =
        msg.phase === 'idle'
          ? null
          : {
              agentName: msg.agentName,
              phase: msg.phase,
              currentTool: msg.currentTool,
              lastActivityTs: msg.lastActivityTs,
              turnStartedAt: msg.turnStartedAt,
            };
      return {
        ...state,
        multiAgent: { ...state.multiAgent, active: { ...active, activity } },
      };
    }

    case 'multi_agent_ended': {
      const active = state.multiAgent.active;
      if (!active || active.sessionId !== msg.sessionId) return state;
      return {
        ...state,
        multiAgent: {
          ...state.multiAgent,
          active: {
            ...active,
            status: msg.reason,
            iterationId: msg.iterationId,
            activity: null,
            // Once the session ends, the pending-retry slot is moot — the
            // server clears its DB column as part of teardown, but the
            // client also drops the descriptor so the banner doesn't
            // linger on a stopped/crashed row.
            pendingRetry: null,
            // Item #5: same reasoning for pending-mutation; the row's pause
            // slot is no longer actionable once the session has ended.
            pendingMutation: null,
          },
        },
      };
    }

    case 'multi_agent_pending_retry': {
      // Item #4: set/clear the banner descriptor. `pending: null` is the
      // explicit clear (after a successful retry or abandon); a populated
      // value sets/replaces (a re-fail overwrites with the new reason).
      // The reducer replaces wholesale — never merge — so a stale field
      // can't survive a successful retry.
      const active = state.multiAgent.active;
      if (!active || active.sessionId !== msg.sessionId) return state;
      return {
        ...state,
        multiAgent: {
          ...state.multiAgent,
          active: { ...active, pendingRetry: msg.pending },
        },
      };
    }

    case 'multi_agent_mutation': {
      // Item #5: live mutation row arrived. Append to the session's list,
      // deduped by id. Server may resend on R-A reconnect (the initial batch
      // travels on `multi_agent_started.mutations`), so the dedupe matters.
      const active = state.multiAgent.active;
      if (!active || active.sessionId !== msg.sessionId) return state;
      if (active.mutations.some((m) => m.id === msg.mutation.id)) return state;
      return {
        ...state,
        multiAgent: {
          ...state.multiAgent,
          active: { ...active, mutations: [...active.mutations, msg.mutation] },
        },
      };
    }

    case 'multi_agent_pending_mutation': {
      // Item #5: pause slot set/clear. `pending: null` = operator-Continue;
      // a populated value = worker is paused awaiting Continue. Replaces
      // wholesale (never merge) for the same reason as pending_retry.
      const active = state.multiAgent.active;
      if (!active || active.sessionId !== msg.sessionId) return state;
      return {
        ...state,
        multiAgent: {
          ...state.multiAgent,
          active: { ...active, pendingMutation: msg.pending },
        },
      };
    }

    case 'iterations': {
      // Reply to `list_iterations`. Replace the cached list wholesale —
      // the server is the source of truth.
      return {
        ...state,
        multiAgent: { ...state.multiAgent, iterations: msg.items },
      };
    }

    case 'templates':
      // Reply to list/save/delete_template. Replace wholesale — the
      // server is the source of truth (same contract as `iterations`).
      return {
        ...state,
        multiAgent: { ...state.multiAgent, templates: msg.items },
      };

    case 'multi_agent_lifecycle_changed': {
      // Echo of `set_multi_agent_lifecycle`. Update the active run's
      // lifecycle so the settings panel toggle reflects the new value
      // and the End-button affordance (confirm dialog for temp) is
      // consistent with what teardown will actually do.
      const active = state.multiAgent.active;
      if (!active || active.sessionId !== msg.sessionId) return state;
      return {
        ...state,
        multiAgent: {
          ...state.multiAgent,
          active: { ...active, lifecycle: msg.lifecycle },
        },
      };
    }

    case 'multi_agent_participant_added': {
      // Echo of `add_multi_agent_participant`. Append the new worker
      // slug to the active run's participant list so the settings
      // panel re-renders with the new participant visible.
      const active = state.multiAgent.active;
      if (!active || active.sessionId !== msg.sessionId) return state;
      // Idempotency guard — server should only emit once but a future
      // resubscribe could replay.
      if (active.participantAgentNames.includes(msg.agentName)) return state;
      return {
        ...state,
        multiAgent: {
          ...state.multiAgent,
          active: {
            ...active,
            participantAgentNames: [...active.participantAgentNames, msg.agentName],
          },
        },
      };
    }

    case 'settings':
      return {
        ...state,
        settings: {
          workspaceRoot: msg.workspaceRoot,
          workspaceRootValid: msg.workspaceRootValid,
          defaultWorkspaceRoot: msg.defaultWorkspaceRoot,
          defaultHopBudget: msg.defaultHopBudget,
        },
      };

    case 'permission_mode_changed':
      return {
        ...state,
        permissionModeBySession: {
          ...state.permissionModeBySession,
          [msg.sessionId]: msg.mode,
        },
      };

    case 'session_renamed': {
      // Swap the title in knownSessions[projectId]. If the session somehow
      // isn't tracked yet (e.g. the user renames before opening the project on
      // this connection), the next project_opened will refresh from the DB
      // anyway — drop the message silently rather than fabricate an entry.
      const list = state.knownSessions[msg.projectId];
      if (!list) return state;
      const idx = list.findIndex((s) => s.id === msg.sessionId);
      if (idx === -1) return state;
      const nextList = list.slice();
      nextList[idx] = { ...list[idx], title: msg.title };
      return {
        ...state,
        knownSessions: { ...state.knownSessions, [msg.projectId]: nextList },
      };
    }

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
        // Replay is not a live wait — no elapsed timer for historical turns.
        runStartedAt: null,
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
          // Server announced a running session with no optimistic pending to
          // migrate (resume/attach) — anchor the timer now.
          runStartedAt: Date.now(),
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
        // Item #5: copy server-classified enrichment when present. Absent on
        // pre-Item-5 replays — the React card falls back to GenericPermissionCard.
        ...(msg.category !== undefined ? { category: msg.category } : {}),
        ...(msg.summary !== undefined ? { summary: msg.summary } : {}),
        ...(msg.cwd !== undefined ? { cwd: msg.cwd } : {}),
        ...(msg.projectName !== undefined ? { projectName: msg.projectName } : {}),
      });
    }

    case 'permission_decided': {
      const projectId = projectFor(state, msg.sessionId);
      if (projectId === null) return state;
      const session = state.sessionsByProject[projectId]?.[msg.sessionId];
      if (!session) return state;
      // Locate the matching permission_request card and mark it decided.
      // Idempotent — both the optimistic local dispatch and the server echo
      // produce the same final state.
      const messages = session.messages.map((mm) =>
        mm.kind === 'permission_request' && mm.requestId === msg.requestId
          ? { ...mm, decided: msg.decision }
          : mm,
      );
      return putSession(state, projectId, msg.sessionId, { ...session, messages });
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
        // Turn over — stop the elapsed timer.
        runStartedAt: null,
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
        runStartedAt: null,
      };
      return {
        ...putSession(state, projectId, sessionId, {
          ...session,
          status: 'error',
          // Turn aborted — stop the elapsed timer.
          runStartedAt: null,
          messages: [
            ...session.messages,
            {
              kind: 'error',
              id: nextId(),
              errorKind: msg.kind,
              message: msg.message,
            },
          ],
        }),
        wrapperErrorSeq: state.wrapperErrorSeq + 1,
      };
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

/**
 * Coarse activity phase of a single-agent session, derived purely from
 * existing store state (no extra server signal — the SDK emits none for
 * "thinking"). Drives the animated thinking indicator. First match wins.
 *
 * `isLive` is the server-confirmed liveness (`state.liveSessions[id]`); it
 * backstops the optimistic `status:'running'` set in `user_send`.
 */
export type SessionPhase =
  | 'idle'
  | 'thinking'
  | 'tool-running'
  | 'streaming'
  | 'awaiting-permission'
  | 'done'
  | 'error';

export function sessionPhase(s: SessionView, isLive: boolean): SessionPhase {
  if (s.status === 'error') return 'error';
  if (s.status === 'done') return 'done';
  if (s.status !== 'running' && !isLive) return 'idle';

  // Last interactive (non-system) message: an undecided permission card means
  // the agent is blocked on the user, not computing — the card is the
  // feedback, so the indicator stays out of the way.
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m.kind === 'system') continue;
    if (m.kind === 'permission_request' && !m.decided) return 'awaiting-permission';
    break;
  }

  if (s.streamingText.length > 0) return 'streaming';

  // Between an assistant `tool_use` block and its `tool_result` (a
  // `kind:'system', subtype:'tool_result'` message) the tool is executing.
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m.kind !== 'assistant') continue;
    const last = m.blocks[m.blocks.length - 1];
    if (last?.type === 'tool_use') {
      const resolved = s.messages
        .slice(i + 1)
        .some((x) => x.kind === 'system' && x.subtype === 'tool_result');
      if (!resolved) return 'tool-running';
    }
    break;
  }

  return 'thinking';
}

/**
 * Name of the tool currently executing (the trailing `tool_use` of the last
 * assistant message), for the indicator's "running <tool>…" label. Returns
 * undefined unless the session is in the `tool-running` shape.
 */
export function pendingToolName(s: SessionView): string | undefined {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m.kind !== 'assistant') continue;
    const last = m.blocks[m.blocks.length - 1];
    if (last?.type === 'tool_use') {
      const resolved = s.messages
        .slice(i + 1)
        .some((x) => x.kind === 'system' && x.subtype === 'tool_result');
      return resolved ? undefined : last.name;
    }
    break;
  }
  return undefined;
}

/**
 * Routing sentinels that are never a real participant: a `destination` of
 * `_sink`/`user` is a terminal hop (nobody is computing next) and `cebab` is
 * the injector source, never a destination.
 */
export const MA_SENTINELS: ReadonlySet<string> = new Set(['_sink', 'user', 'cebab']);

/**
 * Which bus participant is currently computing, inferred from the event tail.
 * Bus routing is strictly turn-based and serialized: each `bus_send` triggers
 * exactly one delivery, so the last event's `destination` (when a real agent)
 * is the agent now running. Correct for chain (linear handoff) and
 * orchestrator (re-activation is free — stateless over the tail).
 *
 * Callers must additionally gate on `!run.awaitingContinue` (an R-B
 * read-only recovered run is not actually executing) and `!run.pendingMutation`
 * (the pause-on-first-mutation gate has held the worker mid-turn).
 */
export function activeAgent(run: MultiAgentRun): string | null {
  if (run.status !== 'running') return null;
  if (run.awaitingContinue || run.pendingRetry || run.pendingMutation) return null;
  const evs = run.events;
  if (evs.length === 0) return null;
  const last = evs[evs.length - 1];
  if (last.kind === 'error') return null;
  if (MA_SENTINELS.has(last.destination)) return null;
  return last.destination;
}

/**
 * Whether a scrollback event renders BODY-collapsed by default. The row's
 * metadata header (source→dest, kind, ts, verified badge) is ALWAYS shown —
 * `EventRow` only gates `.event-text` on this — so "collapsed" means the
 * always-visible routing spine without the message body buried in between.
 *
 * Kind-driven (not mode-driven) so it applies to chain AND orchestrator: a
 * chain run previously returned `false` unconditionally, which left every
 * verbose intermediate hop body open and buried the routing spine. Now only
 * the events worth reading inline default open:
 *   - `final` — the answer, framed (1-second squint test);
 *   - `error` — never bury a failure;
 *   - `destination === 'user'` — the orchestrator's reply to the operator
 *     (the bus guarantees only the orchestrator can target `user`).
 * Everything else (intro/prompt/reply hops) is spine + collapsed body; the
 * operator expands a row to read it.
 *
 * `run` is kept in the signature (callers pass it; future per-mode tuning
 * may need it) though the rule is now mode-agnostic.
 */
export function eventDefaultCollapsed(run: MultiAgentRun, ev: MultiAgentEventView): boolean {
  if (ev.kind === 'final' || ev.kind === 'error') return false;
  if (ev.destination === 'user') return false;
  return true;
}
