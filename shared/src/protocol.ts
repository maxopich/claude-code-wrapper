// WebSocket protocol shared between server and web.
// Filled out incrementally as features land — start small.

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
   * True iff Cebab has installed its bus integration into this project — i.e.
   * appended the `@import` line to its CLAUDE.md and merged a Stop hook +
   * pre-approved bash perms into its `.claude/settings.json`. Only projects
   * with this flag can participate in a multi-agent session.
   *
   * Stored in the DB (column `projects.bus_installed`). Toggled by
   * `install_bus_integration` / `uninstall_bus_integration` ClientMsgs.
   */
  busInstalled: boolean;
  /**
   * The filesystem-safe agent slug captured at install time (e.g. project
   * name "Cebab" → `cebab`). Used to address this project in bus.log entries
   * and in inter-agent messages. Null when `busInstalled` is false.
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
       * Install bus integration into a project: append `@import` to its
       * CLAUDE.md and merge Stop hook + scoped bash perms into its
       * `.claude/settings.json`. Operator content in both files is preserved.
       * Idempotent. Reply: `bus_integration_changed` + refreshed `projects`.
       */
      type: 'install_bus_integration';
      projectId: number;
    }
  | {
      /**
       * Reverse of `install_bus_integration`. Removes our additions only;
       * operator content stays. The bus directory entries (inboxes, archive,
       * comm.md) are intentionally left in place for debugging — uninstall
       * is logical, not destructive.
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
       * `initialPrompt` is the seed input. In chain mode it's written to the
       * first participant's inbox and triggers the chain. In orchestrator
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
    }
  | {
      /**
       * Stop a running multi-agent session. Kills the tmux session, stops
       * the bus log tailer, marks the DB row `stopped`. Idempotent.
       */
      type: 'stop_multi_agent';
      sessionId: string;
    }
  | {
      /**
       * Forward a user prompt to the active orchestrator-routed session.
       * Cebab writes the text to the orchestrator's bus inbox (`kind=prompt`,
       * `source=cebab`) and wakes its TUI; the orchestrator then routes it
       * to whichever participant best fits.
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
       * Disk artifacts under `~/.cebab/bus/iterations/` and per-session
       * folders (`<workspace>/.cebab-session-<id>/`) are intentionally
       * left behind: they're useful for post-mortem inspection (transcripts,
       * prompt/reply files) and recreating them is not Cebab's job. The
       * operator can `rm -rf` those by hand if they want a full wipe.
       *
       * Server replies with a fresh `iterations` ServerMsg (the same shape
       * as for `list_iterations`), so the UI updates without a second
       * round-trip.
       */
      type: 'clear_iterations';
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
      tmuxSession: string;
      lifecycle: MultiAgentLifecycle;
      sessionFolder: string;
    }
  | {
      /**
       * One inter-agent (or briefing, or final) message observed on the bus.
       * Streamed live from the bus log tailer. `kind` matches the DB enum.
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
       * Reply to `list_iterations`. One entry per persisted multi-agent
       * session that has an iteration id (post-migration-006 rows).
       * `artifactsDir` is an absolute filesystem path to the on-disk
       * iteration directory; the client renders it for the operator to
       * copy or `cd` to.
       */
      type: 'iterations';
      items: IterationSummary[];
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
  /** Absolute path to `~/.cebab/bus/iterations/<iterationId>/`. */
  artifactsDir: string;
};

export type MultiAgentEventKind = 'intro' | 'prompt' | 'reply' | 'final' | 'error';

/**
 * Session lifecycle: 'persistent' sessions survive End and can be
 * resumed; 'temp' sessions clean up their folder + uninstall bus from
 * participants on End. Default in the server is 'persistent' so an
 * absent `lifecycle` field in `start_multi_agent` resolves safely.
 */
export type MultiAgentLifecycle = 'persistent' | 'temp';

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
