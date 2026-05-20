// WebSocket protocol shared between server and web.
// Filled out incrementally as features land — start small.

import type { MutationCategory } from './mutation.js';

export type Project = {
  id: number;
  name: string;
  path: string;
  trusted: boolean;
  lastUsedAt: number | null;
  /**
   * True iff a `CLAUDE.md` file exists at the project root. The UI uses this
   * to visually distinguish actual agent projects from random subdirectories
   * that happen to live in the workspace folder.
   *
   * Computed fresh each time the project list is sent (via fs.existsSync),
   * not stored in the DB — cheap to recompute and always reflects on-disk
   * state without needing an explicit refresh.
   */
  hasClaudeMd: boolean;
  /**
   * True iff Cebab has installed its bus integration into this project.
   * Install is pure DB metadata — assigning a stable agent slug and flipping
   * this flag. Cebab writes nothing into the project (no CLAUDE.md @import,
   * no `.claude/settings.json` merge, no scripts, no Stop hook). Only
   * projects with this flag can participate in a multi-agent session.
   *
   * Stored in the DB (column `projects.bus_installed`). Toggled by
   * `install_bus_integration` / `uninstall_bus_integration` ClientMsgs.
   */
  busInstalled: boolean;
  /**
   * The filesystem-safe agent slug captured at install time (e.g. project
   * name "Cebab" → `cebab`). Used to address this project in `bus_send`
   * messages and bus events. Null when `busInstalled` is false.
   */
  busAgentName: string | null;
};

export type SessionSummary = {
  id: string;
  title: string | null;
  createdAt: number;
  lastEventAt: number;
  totalCostUsd: number;
};

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: 'thinking'; text: string };

export type StreamDelta =
  | { kind: 'text'; blockIndex: number; text: string }
  | { kind: 'input_json'; blockIndex: number; partialJson: string };

export type ResultSubtype =
  | 'success'
  | 'error_max_turns'
  | 'error_during_execution'
  | 'error_max_budget_usd'
  | 'error_max_structured_output_retries';

export const RESULT_SUBTYPES: ReadonlySet<ResultSubtype> = new Set([
  'success',
  'error_max_turns',
  'error_during_execution',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
]);

export type WrapperErrorKind =
  | 'claude_not_found'
  | 'auth_expired'
  | 'rate_limited'
  | 'process_crashed'
  | 'parse_error';

/** Per-session permission mode the wrapper exposes to the UI. */
export type SessionPermissionMode = 'default' | 'acceptEdits';

export const SESSION_PERMISSION_MODES: ReadonlySet<SessionPermissionMode> = new Set([
  'default',
  'acceptEdits',
]);

export function isSessionPermissionMode(v: unknown): v is SessionPermissionMode {
  return typeof v === 'string' && SESSION_PERMISSION_MODES.has(v as SessionPermissionMode);
}

// ---- Browser → Server ----
export type ClientMsg =
  | { type: 'list_projects' }
  | { type: 'open_project'; projectId: number }
  | { type: 'send_message'; projectId: number; sessionId?: string; text: string }
  | { type: 'interrupt'; sessionId: string }
  | {
      type: 'permission_decision';
      sessionId: string;
      requestId: string;
      decision: 'allow' | 'deny';
      /** Reserved for a future UI affordance to edit tool input before approving. */
      updatedInput?: Record<string, unknown>;
      message?: string;
    }
  | { type: 'set_trusted'; projectId: number; trusted: boolean }
  | { type: 'load_session'; projectId: number; sessionId: string }
  | { type: 'get_settings' }
  | { type: 'set_workspace_root'; path: string }
  | {
      /**
       * Persist a new default hop budget (cap on `multi_agent_events` rows
       * per session). Stored in `settings` keyed by `hop_budget`. The
       * server clamps to `value >= 1` and silently ignores non-finite
       * input. Takes effect on the next multi-agent session start (and on
       * R-B reconstruction); active sessions keep their resolved value.
       */
      type: 'set_default_hop_budget';
      value: number;
    }
  | { type: 'set_permission_mode'; sessionId: string; mode: SessionPermissionMode }
  | {
      /**
       * Rename a session (display label only — the session id is unchanged).
       * `title: null` clears the nickname and reverts the UI to the id slice.
       */
      type: 'rename_session';
      sessionId: string;
      title: string | null;
    }
  | {
      /**
       * Install bus integration for a project: pure DB metadata — assign a
       * stable agent slug and flip `projects.bus_installed`. Cebab writes
       * nothing into the project itself. Idempotent. Reply:
       * `bus_integration_changed` + refreshed `projects`.
       */
      type: 'install_bus_integration';
      projectId: number;
    }
  | {
      /**
       * Reverse of `install_bus_integration`: clear the `bus_installed`
       * flag (the agent slug is retained so a re-install is stable). Pure
       * DB metadata — there is nothing in the project to clean up.
       */
      type: 'uninstall_bus_integration';
      projectId: number;
    }
  | {
      /**
       * Start a multi-agent session. `participants` is an ordered list of
       * project ids; for chain mode the order is the hop order, for
       * orchestrator mode it's preserved cosmetically.
       *
       * `initialPrompt` is the seed input. In chain mode it rides the first
       * participant's opening turn and triggers the chain. In orchestrator
       * mode it's the first user prompt the orchestrator sees.
       *
       * `lifecycle` (optional, defaults server-side to 'persistent'):
       *   - 'persistent': session folder + bus installs survive End;
       *     resume works.
       *   - 'temp': on End the session folder is rm-rf'd and bus install
       *     is removed from each participant. Lets the operator run a
       *     one-off session without leaving residue.
       *
       * v1 supports one active multi-agent session at a time per connection.
       * Calling this while another is running yields a `wrapper_error`.
       */
      type: 'start_multi_agent';
      mode: 'chain' | 'orchestrator';
      participants: number[];
      initialPrompt: string;
      lifecycle?: MultiAgentLifecycle;
      /**
       * Opt-in to "pause-on-first-mutation": the first non-`read` tool call
       * from any worker (anywhere in the session) is gated by an
       * `awaiting_continue`-style banner before the SDK dispatches the tool.
       * Subsequent mutations auto-allow once the operator clicks Continue.
       * Default `false` (server-side resolution; absent on pre-Item-5 clients).
       * Persists in `multi_agent_sessions.pause_on_mutation`; survives R-B.
       */
      pauseOnMutation?: boolean;
    }
  | {
      /**
       * Stop a running multi-agent session. Aborts every agent's in-process
       * `query()`, unregisters it from the live registry, marks the DB row
       * `stopped`. Idempotent.
       */
      type: 'stop_multi_agent';
      sessionId: string;
    }
  | {
      /**
       * Manually re-attach to a multi-agent session that is still live in
       * the in-process registry (e.g. a row the single-active sweep marked
       * crashed while its agents kept running, or a dropped connection).
       * Pure re-attach: no agent respawn. Fails with `wrapper_error` if
       * another session is active or the session is no longer live (e.g.
       * after a Cebab server restart).
       */
      type: 'resume_multi_agent';
      sessionId: string;
    }
  | {
      /**
       * Continue a session that was reconstructed after a Cebab server
       * restart and re-attached READ-ONLY (R-B; `awaiting_continue`). Cebab
       * delivers a "you were interrupted — here is the bus activity since
       * your last action, continue" nudge to the orchestrator (which
       * resumes its real CLI session) and clears the awaiting flag.
       * Orchestrator mode only; this is the ONLY action that re-runs agents
       * after a restart-recovery (conservative: an interrupted turn's side
       * effects are not auto-replayed without this explicit operator click).
       * No-op / `wrapper_error` if the session isn't the active
       * awaiting-continue one.
       */
      type: 'continue_multi_agent';
      sessionId: string;
    }
  | {
      /**
       * Re-deliver the captured prompt of the worker named in this
       * session's pending-retry slot. Stateless: the server reads the
       * agent name + bytes from the persisted slot (avoids stale or
       * spoofed retry targets from the client). Idempotent — a second
       * click while the slot is already cleared is a no-op.
       *
       * The slot is cleared BEFORE re-delivery so a racing second click
       * sees the empty slot. If the retried turn fails again, the router
       * re-asserts the slot with a fresh reason and the banner re-emits.
       *
       * Also clears `awaiting_continue` (if both flags were set on a
       * reconstructed session): retrying implies acknowledging the
       * recovery context.
       */
      type: 'retry_worker';
      sessionId: string;
    }
  | {
      /**
       * Give up on the pending-retry slot and end the session as
       * `'stopped'`. Same teardown effect as `stop_multi_agent`, but a
       * distinct verb so post-hoc analytics can differentiate "operator
       * stopped a healthy run" from "operator abandoned after a failure"
       * if we want that later. Idempotent.
       */
      type: 'abandon_session';
      sessionId: string;
    }
  | {
      /**
       * Operator clicked Continue on the pause-on-first-mutation banner.
       * Server clears the `pending_mutation_id` slot, sets
       * `mutations_acknowledged=1` (so subsequent mutations in this session
       * auto-allow), clears `awaiting_continue`, and re-delivers the paused
       * worker's last captured prompt (briefing-and-rules preserved — same
       * bytes as PR #71's retry path). Idempotent: a second click with the
       * slot empty is a no-op.
       */
      type: 'continue_through_mutation';
      sessionId: string;
    }
  | {
      /**
       * Forward a user prompt to the active orchestrator-routed session.
       * Cebab delivers it as the orchestrator's next turn (`kind=prompt`,
       * `source=cebab`); the orchestrator then routes it to whichever
       * participant best fits.
       *
       * Only meaningful in orchestrator mode — chain sessions ignore this
       * with a `wrapper_error`. The first user prompt is delivered as part
       * of `start_multi_agent.initialPrompt`; subsequent prompts come
       * through this message.
       */
      type: 'multi_agent_user_prompt';
      sessionId: string;
      text: string;
    }
  | {
      /**
       * Ask the server for the list of past multi-agent runs (iterations).
       * Server replies with an `iterations` ServerMsg. Used by the
       * Multi-Agent tab's Iterations section.
       */
      type: 'list_iterations';
    }
  | {
      /**
       * Wipe the iterations browser: delete the DB rows (sessions, events,
       * participants) for every multi-agent session whose status is NOT
       * `'running'`. The active session — if any — is preserved so the
       * operator can't accidentally orphan a live run by clicking Clear.
       *
       * Disk artifacts under the per-session folders
       * (`<workspace>/.cebab-session-<id>/`) are intentionally left behind:
       * they're useful for post-mortem inspection (transcripts, iteration
       * files) and recreating them is not Cebab's job. The operator can
       * `rm -rf` those by hand if they want a full wipe.
       *
       * Server replies with a fresh `iterations` ServerMsg (the same shape
       * as for `list_iterations`), so the UI updates without a second
       * round-trip.
       */
      type: 'clear_iterations';
    }
  | {
      /**
       * Mutate the lifecycle of a running multi-agent session
       * (`persistent` ↔ `temp`). Only affects teardown behavior — the
       * session keeps running unchanged; on End/Stop the new value
       * decides whether to keep or rm-rf the session folder (and
       * uninstall bus from workers, for `temp`). Server-side this is
       * a single row update on `multi_agent_sessions` plus an
       * in-memory flip so the active router's teardown branch picks
       * the new value.
       *
       * Chain-mode sessions reject this with `wrapper_error` for now —
       * the chain handle doesn't expose lifecycle mutation in v1.
       */
      type: 'set_multi_agent_lifecycle';
      sessionId: string;
      lifecycle: MultiAgentLifecycle;
    }
  | {
      /**
       * Append a worker to an already-running orchestrator session.
       * The server resolves the project's agent name, auto-installs
       * bus integration if missing (pure DB metadata), registers a new
       * in-process agent with the AgentRunner and the router's F2 source
       * allowlist, persists a `multi_agent_participants` row, and delivers
       * an updated roster prompt as the orchestrator's next turn so it
       * knows the new agent is reachable.
       *
       * Chain-mode sessions reject this — chain ordering (`chain_order`)
       * is baked in at start and the pipeline depends on it.
       */
      type: 'add_multi_agent_participant';
      sessionId: string;
      projectId: number;
    }
  | {
      /** Ask the server for saved multi-agent templates. Reply: `templates`. */
      type: 'list_templates';
    }
  | {
      /**
       * Upsert a multi-agent draft preset by exact name. Saving an existing
       * name overwrites mode/lifecycle/participants but keeps the stored id;
       * a new name gets a fresh server-minted id. No prompt is stored — the
       * operator always types a fresh first prompt. Reply: a fresh
       * `templates` ServerMsg.
       */
      type: 'save_template';
      name: string;
      mode: 'chain' | 'orchestrator';
      lifecycle: MultiAgentLifecycle;
      participants: number[];
      /**
       * Optional per-participant role/goal text, keyed by `String(projectId)`.
       * Absent on pre-roles clients; unknown/stale keys are ignored.
       */
      roles?: Record<string, string>;
    }
  | {
      /** Delete a template by id. Reply: a fresh `templates` ServerMsg. */
      type: 'delete_template';
      id: string;
    };

// ---- Server → Browser ----
export type ServerMsg =
  | { type: 'projects'; projects: Project[] }
  | {
      type: 'project_opened';
      projectId: number;
      sessions: SessionSummary[];
      runningSessionIds: string[];
    }
  | { type: 'session_history_start'; projectId: number; sessionId: string }
  | { type: 'session_history_end'; projectId: number; sessionId: string }
  | { type: 'session_running'; projectId: number; sessionId: string; running: boolean }
  | {
      type: 'session_started';
      sessionId: string;
      projectId: number;
      model: string;
      tools: string[];
    }
  | { type: 'assistant_message'; sessionId: string; uuid: string; blocks: ContentBlock[] }
  | { type: 'user_message'; sessionId: string; uuid: string; blocks: ContentBlock[] }
  | { type: 'stream_delta'; sessionId: string; uuid: string; delta: StreamDelta }
  | {
      type: 'permission_request';
      requestId: string;
      sessionId: string;
      toolName: string;
      input: unknown;
      /**
       * Server-classified mutation category from `classifyToolCall`. Optional
       * so a replay of pre-Item-5 `permission_request` rows still renders via
       * the React JSON-fallback subcomponent.
       */
      category?: MutationCategory;
      /** Server-classified one-line operator-readable summary. */
      summary?: string;
      /** Absolute cwd the tool will run in (the project's `path`). Optional. */
      cwd?: string;
      /** Human-readable project name. Optional. */
      projectName?: string;
    }
  | {
      type: 'permission_decided';
      sessionId: string;
      requestId: string;
      decision: 'allow' | 'deny';
    }
  | {
      type: 'permission_mode_changed';
      sessionId: string;
      mode: SessionPermissionMode;
    }
  | {
      /** Echoed in response to `rename_session`; also broadcast for replays. */
      type: 'session_renamed';
      sessionId: string;
      projectId: number;
      title: string | null;
    }
  | { type: 'system_event'; sessionId: string; subtype: string; payload: unknown }
  | {
      type: 'result';
      sessionId: string;
      subtype: ResultSubtype;
      durationMs: number;
      totalCostUsd: number;
      result?: string;
      errors?: string[];
    }
  | {
      type: 'settings';
      /** Stored workspace root from the DB. `null` means the user hasn't set one yet. */
      workspaceRoot: string | null;
      /** True iff the *resolved* workspace root (stored OR default fallback) exists. */
      workspaceRootValid: boolean;
      defaultWorkspaceRoot: string;
      /** Resolved default hop budget (DB setting > `CEBAB_HOP_BUDGET` env >
       *  built-in `DEFAULT_HOP_BUDGET`). Always present; the Settings modal
       *  seeds its input from this value. */
      defaultHopBudget: number;
    }
  | {
      /**
       * Broadcast when a project's bus-integration state flips (install or
       * uninstall succeeded). The client updates its local `Project` cache;
       * a refreshed `projects` ServerMsg typically follows for completeness.
       */
      type: 'bus_integration_changed';
      projectId: number;
      installed: boolean;
      agentName: string | null;
    }
  | {
      /**
       * Multi-agent session has been started. Carries enough info for the
       * client to switch its Multi-Agent tab into "running" mode.
       *
       * `participantAgentNames` is the resolved bus slug for each participant
       * (in the same order as the start request); the client uses these to
       * tag events in the scrollback ("from: reviewer").
       *
       * `lifecycle` echoes back the persistent-vs-temp choice so the UI
       * can render the right End-button affordance (e.g. a confirm
       * dialog warning about cleanup for temp sessions).
       *
       * `sessionFolder` is the absolute on-disk path the session is
       * writing to — surfaced so the operator can copy/inspect.
       */
      type: 'multi_agent_started';
      sessionId: string;
      mode: 'chain' | 'orchestrator';
      participants: number[];
      participantAgentNames: string[];
      lifecycle: MultiAgentLifecycle;
      sessionFolder: string;
      /**
       * Hard cap on persisted hops for this session (cumulative
       * `multi_agent_events` rows). Server-resolved at start time from DB
       * setting > `CEBAB_HOP_BUDGET` env > `DEFAULT_HOP_BUDGET`; R-B
       * reconstruction re-resolves the same precedence on reconnect. The
       * UI reads `events.length / hopBudget` for the activity-bar chip
       * and the "Hop budget" row in Session info; the router emits a
       * synthetic `cebab → _sink kind=error` event when it trips and
       * tears down with `reason='stopped'`.
       */
      hopBudget: number;
      /**
       * True iff this session was reconstructed after a Cebab server
       * restart (R-B) and is re-attached READ-ONLY: nothing runs until the
       * operator sends `continue_multi_agent`. Absent/false for normal
       * starts and same-process live re-attaches. The scrollback also
       * carries a persisted cebab→user banner explaining the state and the
       * one caveat (an interrupted turn's side effects are not rolled back).
       */
      awaitingContinue?: boolean;
      /**
       * Populated when a worker's deliverTurn failed and the operator
       * hasn't yet retried or abandoned. Restored from the persisted
       * `pending_retry_*` columns on R-A re-attach + R-B reconstruct so
       * the Retry/Abandon banner survives reconnects and Cebab restarts.
       * Absent on fresh starts and after a successful retry. Co-exists
       * with `awaitingContinue` — the UI stacks both banners; clicking
       * Retry clears both flags. See `multi_agent_pending_retry` for the
       * standalone set/clear ServerMsg.
       */
      pendingRetry?: PendingRetryDescriptor;
      /**
       * Item #5: opt-in pause-on-first-mutation flag for this session
       * (`multi_agent_sessions.pause_on_mutation`). Set by the operator at
       * session start via the setup-screen checkbox. Survives R-B; the
       * banner reappears on reconstruct if a pause was pending.
       */
      pauseOnMutation: boolean;
      /**
       * True once the operator has clicked Continue on a pause-on-mutation
       * banner at least once during this session (or set explicitly on
       * subsequent sessions). When true, subsequent mutations auto-allow
       * without further pauses. Mirrors `multi_agent_sessions.mutations_acknowledged`.
       */
      mutationsAcknowledged: boolean;
      /**
       * Initial batch of recorded mutations for this session, ordered by `ts`
       * ascending. Empty on fresh starts; populated on R-A re-attach and R-B
       * reconstruct so the Session-info "Mutations" disclosure and the
       * activity-bar counter chip light up immediately. Subsequent mutations
       * arrive via the live `multi_agent_mutation` ServerMsg.
       */
      mutations: MultiAgentMutationView[];
      /**
       * Populated when a worker has been paused mid-turn by the
       * pause-on-first-mutation gate. Cleared once the operator clicks
       * Continue. Restored from the persisted `pending_mutation_id` slot on
       * R-A re-attach + R-B reconstruct so the banner survives reconnects
       * and Cebab restarts. Absent on fresh starts and after a successful
       * Continue. Co-exists with `awaitingContinue` and `pendingRetry`; the
       * UI stacks all three banners.
       */
      pendingMutation?: MultiAgentMutationView;
      /**
       * Item #7: server-derived recovery snapshot surfaced ONLY when the
       * session is in `awaiting_continue` state (R-B reconstruct, or a
       * pause-on-mutation banner that survived a Cebab restart). Powers the
       * "▾ Recovery details" disclosure inside the awaiting-continue banner.
       * Pure render-time derivation from `multi_agent_events` +
       * `multi_agent_agent_sessions`; not persisted. Absent on fresh starts
       * and on resumes that don't need the disclosure.
       */
      recoveryContext?: RecoveryContextView;
    }
  | {
      /**
       * One inter-agent (or briefing, or final) message observed on the bus.
       * Streamed live from the in-process router as each `bus_send` lands.
       * `kind` matches the DB enum.
       *
       * `destination` is either another agent's bus slug or one of the
       * sentinels: `user` (orchestrator → user, intercepted by Cebab) and
       * `_sink` (chain terminal — last participant's reply).
       */
      type: 'multi_agent_event';
      sessionId: string;
      eventId: number;
      ts: number;
      source: string;
      destination: string;
      kind: MultiAgentEventKind;
      text: string;
    }
  | {
      /**
       * EPHEMERAL liveness tick for one bus participant's in-flight turn.
       * Synthesized server-side by an observer on the existing per-turn
       * SDKMessage stream (no agent-side change). It is NOT persisted (the
       * `multi_agent_event` hop timeline is the durable record) and is NOT
       * replayed on resume. It is also NOT delivered across a live
       * re-attach — the original observer's emitter still points at the
       * closed socket; the activity bar degrades to the inferred active
       * agent and the next real hop re-syncs the spine.
       *
       *  - `working`: an SDKMessage arrived within the stall window.
       *  - `stalled`: no SDKMessage for the stall window (hung vs. slow).
       *  - `idle`:    the turn ended; clears the agent's live row.
       *
       * `currentTool` is the trailing `tool_use` block's name when the
       * agent is mid tool call (undefined for plain thinking/text).
       * `turnStartedAt` anchors elapsed; `lastActivityTs` is the most
       * recent SDKMessage's wall-clock ms.
       */
      type: 'agent_activity';
      sessionId: string;
      agentName: string;
      phase: AgentActivityPhase;
      currentTool?: string;
      lastActivityTs: number;
      turnStartedAt: number;
    }
  | {
      /**
       * Multi-agent session ended. `iterationId` is non-null on successful
       * chain completion (points at the iteration store directory).
       */
      type: 'multi_agent_ended';
      sessionId: string;
      reason: 'completed' | 'stopped' | 'crashed';
      iterationId: string | null;
    }
  | {
      /**
       * Live set/clear of the pending-retry slot. Emitted when a worker's
       * `deliverTurn` fails (set, with a descriptor) and again when the
       * operator clicks Retry or Abandon (cleared, `pending: null`). The
       * initial value on session attach travels on `multi_agent_started`;
       * this message is for in-session transitions only.
       *
       * `pending: null` is the explicit-clear signal — the reducer must
       * replace, not merge, so a stale descriptor never lingers after a
       * successful retry.
       */
      type: 'multi_agent_pending_retry';
      sessionId: string;
      pending: PendingRetryDescriptor | null;
    }
  | {
      /**
       * Item #5: one mutation observed on the bus, appended live to the
       * session's mutation log. Persisted into `multi_agent_mutations`; the
       * initial batch ships on `multi_agent_started.mutations` for R-A/R-B
       * replay. The reducer dedupes by `mutation.id` because the server may
       * resend on re-attach.
       */
      type: 'multi_agent_mutation';
      sessionId: string;
      mutation: MultiAgentMutationView;
    }
  | {
      /**
       * Item #5: live set/clear of the pause-on-first-mutation slot. Emitted
       * when a worker is about to mutate AND `pause_on_mutation=1` AND
       * `mutations_acknowledged=0` (set, with the offending mutation row),
       * and again when the operator clicks Continue (cleared,
       * `pending: null`). Initial value on attach travels on
       * `multi_agent_started.pendingMutation`; this is for in-session
       * transitions.
       */
      type: 'multi_agent_pending_mutation';
      sessionId: string;
      pending: MultiAgentMutationView | null;
    }
  | {
      /**
       * Reply to `list_iterations`. One entry per persisted multi-agent
       * session that has an iteration id (post-migration-006 rows).
       * `artifactsDir` is an absolute filesystem path to the on-disk
       * iteration directory; the client renders it for the operator to
       * copy or `cd` to.
       */
      type: 'iterations';
      items: IterationSummary[];
    }
  | {
      /**
       * Reply to `list_templates` / `save_template` / `delete_template`.
       * The full current template list — the client replaces its cache
       * wholesale (same contract as `iterations`).
       */
      type: 'templates';
      items: MultiAgentTemplate[];
    }
  | {
      /**
       * Echo of a successful `set_multi_agent_lifecycle`. The reducer
       * updates `MultiAgentRun.lifecycle` so the UI affordances
       * (End-button confirm dialog, settings panel) reflect the new
       * value immediately.
       */
      type: 'multi_agent_lifecycle_changed';
      sessionId: string;
      lifecycle: MultiAgentLifecycle;
    }
  | {
      /**
       * Echo of a successful `add_multi_agent_participant`. The reducer
       * appends `agentName` to `MultiAgentRun.participantAgentNames` so
       * the settings panel re-renders with the new worker visible.
       *
       * `busWasAlreadyInstalled` lets the UI decide whether to surface
       * "bus integration was installed for this project" as a side
       * effect of the add.
       */
      type: 'multi_agent_participant_added';
      sessionId: string;
      projectId: number;
      agentName: string;
      busWasAlreadyInstalled: boolean;
    }
  | { type: 'wrapper_error'; sessionId?: string; kind: WrapperErrorKind; message: string };

/**
 * One past multi-agent run, as surfaced to the Iterations browser UI.
 */
export type IterationSummary = {
  iterationId: string;
  sessionId: string;
  mode: 'chain' | 'orchestrator';
  status: 'running' | 'completed' | 'stopped' | 'crashed';
  startedAt: number;
  endedAt: number | null;
  /**
   * For chain mode: agent slugs in hop order. For orchestrator mode: the
   * worker slugs (orchestrator is implicit; the UI prepends it). The list
   * filters out participants whose project row has been deleted since the
   * session ran.
   */
  participantAgentNames: string[];
  /** Absolute path to the iteration directory under the session folder. */
  artifactsDir: string;
  /**
   * True iff this session can be brought back: either it is still live in
   * the in-process registry (same-process re-attach, no respawn), OR — for
   * an orchestrated run — it can be reconstructed from persisted state after
   * a Cebab server restart (R-B). Computed server-side at list time and
   * re-validated on the actual `resume_multi_agent`. Chain rows are only
   * resumable while still live (reconstruction is orchestrator-only for now).
   */
  resumable: boolean;
};

export type MultiAgentEventKind = 'intro' | 'prompt' | 'reply' | 'final' | 'error';

/**
 * Phase of the ephemeral `agent_activity` liveness tick. Not persisted;
 * see the `agent_activity` ServerMsg variant for the full contract.
 */
export type AgentActivityPhase = 'working' | 'stalled' | 'idle';

/**
 * Session lifecycle: 'persistent' sessions survive End and can be
 * resumed; 'temp' sessions clean up their folder + uninstall bus from
 * participants on End. Default in the server is 'persistent' so an
 * absent `lifecycle` field in `start_multi_agent` resolves safely.
 */
export type MultiAgentLifecycle = 'persistent' | 'temp';

/**
 * Pending-retry slot for a multi-agent session: which worker's last turn
 * failed, the exact bytes we last delivered to it (replayed verbatim on
 * Retry so the briefing isn't double-prepended), the operator-facing
 * failure reason, and the DB id of the synthetic `cebab → user kind=error`
 * event so the banner's "Jump to error" button can scroll to it.
 *
 * Carried on the `multi_agent_started` ServerMsg (R-A re-attach + R-B
 * reconstruction restore the banner from the persisted row) and on the
 * standalone `multi_agent_pending_retry` ServerMsg for live emission. The
 * client's `retry_worker` ClientMsg is stateless — the server reads the
 * agent name from the persisted slot, not from the client, to avoid stale
 * or spoofed retry targets.
 */
export type PendingRetryDescriptor = {
  agentName: string;
  reason: string;
  lastPrompt: string;
  ts: number;
  errorEventId: number;
};

/**
 * Item #5: one classified mutation observed on the bus, as surfaced to the
 * client. Rows live in `multi_agent_mutations`; the wire shape is denormalized
 * for direct rendering (no JOINs on the client). The `category` field is
 * always `'mutate'` or `'dangerous'` — read-only tool calls are not logged.
 */
export type MultiAgentMutationView = {
  /** DB row id; the dedupe key for live + replay reconciliation. */
  id: number;
  sessionId: string;
  /** Wall-clock ms when the `tool_use` block was observed. */
  ts: number;
  /** Bus slug of the agent whose turn produced this mutation. */
  agentName: string;
  /** SDK tool name (`'Write'`, `'Edit'`, `'Bash'`, …). */
  toolName: string;
  category: 'mutate' | 'dangerous';
  /** Operator-readable one-line summary from `classifyToolCall`. */
  summary: string;
};

/**
 * Item #7: per-agent recovery-time state. An agent is flagged as possibly
 * "interrupted" iff it emitted bus activity (a `multi_agent_events` row with
 * `source=agentName`) that wasn't followed by a successful SDK `result`
 * checkpoint write (`multi_agent_agent_sessions.updated_at`). False positives
 * are tolerable by design — the heuristic favors caution. False negatives are
 * not possible by construction: an interrupted turn's checkpoint never lands.
 */
export type RecoveryAgentEntry = {
  agentName: string;
  /** Wall-clock of the most recent `multi_agent_events` row where source=agentName. */
  lastEventTs: number;
  /** `updated_at` from `multi_agent_agent_sessions` for this agent, or null if
   *  the agent never reached a successful `result` (e.g. crashed during intro). */
  lastCheckpointTs: number | null;
};

/**
 * Item #7: snapshot computed at `emitResumedSession` time, surfaced ONLY when
 * the session is in `awaiting_continue` state. Carries the operator-facing
 * "what was happening when Cebab died?" answer for the awaiting-continue
 * banner's read-only Recovery details disclosure.
 */
export type RecoveryContextView = {
  /** Wall-clock of the most recent event of ANY source in this session.
   *  Anchors "last persisted activity" in the disclosure. */
  staleSinceTs: number;
  /** Server "now" at emit time. Reserved for future "stale for N seconds"
   *  hints; v1 clients may ignore. */
  reconstructedAtTs: number;
  /** Agents flagged as possibly interrupted (`lastEventTs > lastCheckpointTs`).
   *  Empty when all agents checkpointed cleanly. Sorted by `lastEventTs`
   *  descending (most-recently-active first). */
  interruptedAgents: RecoveryAgentEntry[];
};

/**
 * A saved multi-agent draft preset. Stores everything needed to refill the
 * draft EXCEPT the prompt — the operator always types a fresh first prompt.
 * Persisted server-side as a single JSON array under one `settings` row
 * (no dedicated table), mirroring the iterations browser's architecture.
 */
export type MultiAgentTemplate = {
  /** Stable server-minted id; the delete key. Names are mutable, ids aren't. */
  id: string;
  name: string;
  mode: 'chain' | 'orchestrator';
  lifecycle: MultiAgentLifecycle;
  /** Ordered project ids — same semantics as `start_multi_agent.participants`. */
  participants: number[];
  /**
   * Optional per-participant role/goal text, keyed by `String(projectId)`.
   * Shown next to each agent node in the expanded template card. Undefined
   * on templates saved before this field existed; read as `roles?.[id] ?? ''`.
   * Stale keys (project since removed) are harmless and ignored.
   */
  roles?: Record<string, string>;
};

export const MULTI_AGENT_EVENT_KINDS: ReadonlySet<MultiAgentEventKind> = new Set([
  'intro',
  'prompt',
  'reply',
  'final',
  'error',
]);

export function isMultiAgentEventKind(v: unknown): v is MultiAgentEventKind {
  return typeof v === 'string' && MULTI_AGENT_EVENT_KINDS.has(v as MultiAgentEventKind);
}
