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

/**
 * Cluster A Phase 3: enumerated sub-codes for router-drop safety events.
 *
 * Each F2/F3 source-allowlist filter in `bus/orchestrator.ts` (and the
 * analogous chain-mode filters in `bus/chain.ts`) maps to exactly one of
 * these codes. They land in `safety_audit.reason_code` and on the wire as
 * the `RouterDropEvent.reasonCode` field — a forward-compat input to the
 * Phase 5 inbox panel's filter chip and Cluster B's D4 routing-trail
 * inspector.
 *
 * The drop site distinguishes per-row context (source/destination/kind) in
 * the audit row's payload; the reason code is the structural category.
 *
 * | code | semantics |
 * |---|---|
 * | `forged_source` | F3 — agent attempted to spoof `source=cebab` |
 * | `worker_to_user` | F2 — only the orchestrator may address `_user` |
 * | `worker_to_worker` | F2 — worker→worker reply bypasses the orchestrator |
 * | `unknown_source` | F2 round-2 — source name is not a known participant |
 */
export type RouterDropReasonCode =
  | 'forged_source'
  | 'worker_to_user'
  | 'worker_to_worker'
  | 'unknown_source';

/**
 * Cluster A Phase 6 — extended §7 vocabulary (subset that has source sites
 * today). These enums document the floor so future phases can wire the rest
 * additively without protocol churn. The dispatcher's `reasonCode` field
 * accepts any string (forward-compat); these types narrow the call-sites
 * that already exist.
 *
 * Where each code is emitted:
 *
 * - `ToolDeniedReasonCode` — `ws/server.ts` `permission_decision` deny path
 *   currently only emits `permission_required_not_granted`. The other
 *   sub-codes (allowlist_miss, denylist_hit, classifier_*) are reserved for
 *   a future SDK-classifier integration; they're listed here so the inbox
 *   filter chip and routing-trail diagnostics can be coded against the
 *   full enum without re-declaring later.
 *
 * - `SessionCrashedReasonCode` — `ws/server.ts` `wrapper_error` catch maps
 *   `WrapperErrorKind` ('process_crashed' / 'parse_error') to these codes.
 *   `unknown` is the safety-net bucket for any future kind that doesn't
 *   classify cleanly.
 *
 * - `AuthTransitionReasonCode` — overlaps with the env_scrub source already
 *   wired in Phase 3 (api/bedrock/vertex/foundry flag scrubs). Phase 6
 *   adds `auth_expired` from the wrapper_error catch. The `reauth_started`
 *   / `reauth_complete` / `subscription_forced` codes await Cluster D's
 *   re-auth flow.
 *
 * - `SessionRecoveredReasonCode` — `reconstructed` is wired in Phase 6 from
 *   `bus/reconstruct.ts`; `reconstruction_failed` rides the existing
 *   `chain_not_reconstructed` event (Phase 4); `superseded` /
 *   `swept_competing` are the same concept and both come from `bus/resume.ts`.
 *
 * - `RateLimitReasonCode` — splits the existing `rate_limit_event` into
 *   `hit` (a live limit, has a future `resetsAt`) vs `cleared` (an
 *   informational signal — limit just lifted or never applied).
 */
export type ToolDeniedReasonCode =
  | 'permission_required_not_granted'
  | 'allowlist_miss'
  | 'denylist_hit'
  | 'classifier_dangerous'
  | 'classifier_destructive';

export type SessionCrashedReasonCode = 'process_crash' | 'parse_error' | 'unknown';

export type AuthTransitionReasonCode =
  | 'subscription_forced'
  | 'api_key_scrubbed'
  | 'bedrock_flag_scrubbed'
  | 'vertex_flag_scrubbed'
  | 'foundry_flag_scrubbed'
  | 'auth_expired'
  | 'reauth_started'
  | 'reauth_complete';

export type SessionRecoveredReasonCode =
  | 'reconstructed'
  | 'reconstruction_failed'
  | 'superseded'
  | 'swept_competing';

export type RateLimitReasonCode = 'hit' | 'cleared';

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
      /**
       * PR-7: id of the saved template this run was started FROM, if any.
       * The server stamps it onto `multi_agent_sessions.template_id` so the
       * "Last run" rail can SELECT by template at list time. Absent for
       * ad-hoc runs that didn't go through Apply-Template — those rows have
       * `template_id IS NULL` and never feed a template's rail.
       */
      templateId?: string;
      /**
       * PR-7: per-run hop-budget override. When the operator applied a
       * template with `template.hopBudget` set, the client mirrors it here
       * so the resolver doesn't have to look it up again. Server-side
       * precedence: this value > template.hopBudget > DB setting >
       * `CEBAB_HOP_BUDGET` env > `DEFAULT_HOP_BUDGET`. Clamped server-side
       * to `>= 1`; absent on pre-PR-7 clients.
       */
      hopBudget?: number;
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
      /** PR-6: widened to include 'custom' for presentation-only freeform
       *  layouts. Bus routing for 'custom' follows orchestrator semantics. */
      mode: 'chain' | 'orchestrator' | 'custom';
      lifecycle: MultiAgentLifecycle;
      participants: number[];
      /**
       * Optional per-participant role/goal text, keyed by `String(projectId)`.
       * Absent on pre-roles clients; unknown/stale keys are ignored.
       */
      roles?: Record<string, string>;
      /** PR-6: optional hand-authored layout (presentation only). The
       *  server persists it as-is; the future editor enforces topology
       *  constraints before sending. Absent on chain/orchestrator saves. */
      layout?: CustomLayout;
      /**
       * PR-7: optional per-template hop budget override. When omitted, runs
       * started from this template use the global default precedence. The
       * save handler clamps to `>= 1` (sub-1 input is silently dropped) and
       * rejects non-finite numbers.
       */
      hopBudget?: number;
    }
  | {
      /** Delete a template by id. Reply: a fresh `templates` ServerMsg. */
      type: 'delete_template';
      id: string;
    }
  | {
      /**
       * Phase H: request a paginated chunk of the merged session log for a
       * multi-agent run. The server projects rows from `multi_agent_events`
       * (bus hops), `multi_agent_mutations` (classified writes), and the
       * per-agent SDK `events` table (joined via `multi_agent_agent_sessions`)
       * into a unified `LogRow[]` ordered by `ts ASC`. Reply: one or more
       * `session_log_chunk` ServerMsg messages.
       *
       * Pagination contract:
       *   - `offset`: skip the first N rows in the merged stream (after
       *     filtering, before chunk-cap slicing).
       *   - `limit`: hard cap on rows to return in this chunk. The server may
       *     return fewer when a ~2 MB byte budget trips first.
       *   - `revealSensitive`: when true, the dangerous-field redaction is
       *     loosened. Default false — even "Show raw" client-side keeps
       *     dangerous fields masked unless this flag explicitly fires.
       *
       * No filters travel on the wire — the client receives the unfiltered
       * stream and applies search + agent + kind filters in-memory. Volume
       * is bounded by the chunk cap; deeper filtering is purely a UX overlay.
       */
      type: 'load_session_log';
      sessionId: string;
      offset: number;
      limit: number;
      revealSensitive?: boolean;
    }
  | {
      /**
       * PR-6: ask the server for static facts about a project — its absolute
       * working directory and a short head of its root `CLAUDE.md` (if any).
       * Read-only and idempotent; safe to call without any active session.
       *
       * The handler reads CLAUDE.md fresh on each request (no server-side
       * cache); the client caches per-(projectId, modal-open) so a closed-and-
       * reopened modal always sees current on-disk state. Truncated to a small
       * head (~12 lines / ~2048 bytes) — the disclosure is "what's at the top"
       * not "the whole conventions file". Reply: `project_facts`.
       */
      type: 'read_project_facts';
      projectId: number;
    }
  | {
      /**
       * PR-7: ask the server for the most-recent persisted run started from
       * a given saved template. Read-only; safe to call without any active
       * session. The reply is a single `last_run_for_template` ServerMsg
       * carrying either the row (mapped to `TemplateLastRun`) or `null` when
       * the template has never been used (or only used by pre-013 runs whose
       * `template_id` column wasn't recorded).
       *
       * The templates UI calls this once per template card mount + once
       * after each `multi_agent_ended` carrying a matching templateId, so
       * the rail stays fresh without an aggressive polling loop.
       */
      type: 'get_last_run_for_template';
      templateId: string;
    }
  | {
      /**
       * Cluster A Phase 1: operator acknowledges a sticky notification.
       *
       * Sticky operational notifications (`error`) and ALL safety
       * notifications (`danger`) persist in the `notifications` table until
       * acked — the WS-attach replay re-fans them until this message arrives.
       *
       * `ackReason` is REQUIRED when the underlying safety event's
       * `reason_code` is one of the "highest sub-class" codes (per spec
       * BE-7): forged_source, defang.bypass_suspected, audit.tamper_detected.
       * Acks without a reason for those codes are rejected with a
       * wrapper_error; the UI must collect a one-line operator-typed reason
       * (the typed-acknowledgment affordance). Idempotent — re-acking an
       * already-acked or unknown id is a silent no-op.
       */
      type: 'ack_notification';
      id: string;
      ackReason?: string;
    }
  | {
      /**
       * Cluster A Phase 5: operator opened the inbox panel (bell icon) and
       * the client asks the server for a fresh snapshot of the persisted
       * `notifications` table — sticky-operational and ALL safety rows,
       * acked and unacked, most recent first. Replaces the previous
       * "fire-and-forget toast" model with persistent inbox replay.
       *
       * Filters are server-side so the wire stays small; an empty `filters`
       * (or omitted) returns the full inbox (capped at the floor per spec
       * §5: 200 most recent OR 7 days, whichever is larger). The server
       * sends an unsolicited `inbox_snapshot` on every WS attach as well,
       * so the bell badge populates without the panel being opened.
       *
       * `sessionId: null` filters to global-scoped notifications (rows whose
       * `session_id IS NULL`); `sessionId: '<sid>'` filters to a single
       * session. Omitting the key returns all sessions.
       */
      type: 'request_inbox_snapshot';
      filters?: {
        sessionId?: string | null;
        classes?: NotificationClass[];
        severities?: NotificationSeverity[];
        /** When true, include rows whose `acked_at IS NOT NULL`. */
        includeAcked?: boolean;
      };
    }
  | {
      /**
       * Cluster A Phase 5: bulk-ack of dismissed operational notifications.
       *
       * Marks every UNACKED operational row as acked (records `acked_at` +
       * `acked_by` from the server's `getOperatorId()`); safety rows are
       * UNTOUCHED — safety acknowledgment is per-row with operator typed
       * reasons (BE-7) and cannot be bulk-cleared.
       *
       * The server responds with a fresh `inbox_snapshot` so the panel
       * re-renders from authoritative state (vs the client guessing which
       * ids it cleared).
       */
      type: 'clear_dismissed_inbox';
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
      /**
       * Output from a slash command the CLI handled locally (e.g. `/context`,
       * `/compact`, `/skills`). Detected server-side by the synthetic-model
       * marker the SDK emits (`assistant.message.model === "<synthetic>"`).
       *
       * Rendered as a system-style card in the chat, not a regular Claude
       * reply — there was no model turn (cost $0, num_turns 0), and the
       * markdown is command output, not a conversation message.
       */
      type: 'command_output';
      sessionId: string;
      uuid: string;
      text: string;
    }
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
  | {
      /**
       * Phase H: paginated reply to `load_session_log`. The same multi-agent
       * session may produce multiple chunk messages for one request when the
       * server's ~2 MB byte budget trips before `limit` rows. The client
       * concatenates by `(sessionId, offset)` and stops requesting more when
       * `hasMore` is false.
       *
       * `total` is the unfiltered row count across the entire merged stream
       * — surfaced so the toolbar can show "1,234 entries" without scanning.
       * `revealedSensitive` echoes the request flag so a stale chunk can't
       * silently un-redact rows the client didn't ask to reveal.
       */
      type: 'session_log_chunk';
      sessionId: string;
      /** First row index this chunk covers (matches the request `offset`). */
      offset: number;
      rows: LogRow[];
      total: number;
      hasMore: boolean;
      revealedSensitive: boolean;
    }
  | {
      /**
       * PR-6: reply to `read_project_facts`. Carries the project's static
       * facts for the per-participant disclosure inside the template-preview
       * modal. Always emitted (even when the project has no readable
       * `CLAUDE.md`) so the client can resolve its pending request — the
       * head/size fields are simply absent in that case.
       *
       * `name` and `path` echo from the `projects` row; the client could read
       * those locally but echoing keeps the response self-contained for the
       * Modal's per-`(projectId, modalOpenedAt)` cache.
       */
      type: 'project_facts';
      projectId: number;
      facts: ProjectFacts;
    }
  | {
      /**
       * PR-7: reply to `get_last_run_for_template`. The `lastRun` payload is
       * `null` when no persisted row matches (template never used, or only
       * used by pre-013 sessions whose `template_id` column wasn't recorded).
       * The client renders the rail iff `lastRun !== null`.
       */
      type: 'last_run_for_template';
      templateId: string;
      lastRun: TemplateLastRun | null;
    }
  | { type: 'wrapper_error'; sessionId?: string; kind: WrapperErrorKind; message: string }
  | (NotificationEnvelope & { type: 'notification' })
  | {
      /**
       * Cluster A Phase 3 (B2): typed rate-limit signal lifted out of the
       * generic `system_event { subtype: 'rate_limit' }` fall-through in
       * `ws/translate.ts`. Carries the SDK's `rate_limit_info` payload so a
       * future per-session banner (Cluster D B2) can render a live
       * retry-after countdown; the operator-facing toast is fanned out
       * separately as a `notification` envelope by the dispatcher.
       */
      type: 'rate_limit_event';
      sessionId: string;
      /** SDK status enum, e.g. `'allowed_warning' | 'limited'`. */
      status?: string;
      /** Wall-clock ms the limit resets at; surfaced as a countdown. */
      resetsAt?: number;
      /** SDK's discriminator, e.g. `'subscription'`. */
      rateLimitType?: string;
      /** Raw payload from the SDK for forward-compat. */
      payload: unknown;
    }
  | {
      /**
       * Cluster A Phase 3 (D4): replaces the four `console.warn` drop
       * sites in `bus/orchestrator.ts:415-435` and the analogous chain
       * sites. Forward-compat surface for the Cluster B per-agent
       * routing-trail counter; the operator toast is fanned out separately
       * as a safety-class `notification` envelope by the dispatcher (which
       * also writes the `safety_audit` row before this event ships).
       *
       * `auditRowId` is the `safety_audit.id` of the row written for this
       * drop — a future inbox panel uses it to deep-link to the audit trail.
       */
      type: 'router_drop';
      sessionId: string;
      reasonCode: RouterDropReasonCode;
      source: string;
      destination: string;
      /** `BusEvent.kind` of the dropped event (e.g. `'reply'`, `'error'`). */
      kind: string;
      auditRowId: string;
    }
  | {
      /**
       * Cluster A Phase 3 (E1): names of env vars `runner/claude.ts`
       * stripped from the spawn env so a stray `ANTHROPIC_API_KEY` (etc.)
       * can't silently route a session through paid billing. Values are
       * NEVER on the wire (UX-5). Emitted once per WS attach so a
       * late-opening browser tab still sees it; the operator toast is
       * fanned out by the dispatcher as a sticky safety `notification`.
       */
      type: 'env_scrubbed';
      /** Names of the env vars present in `process.env` that were stripped. */
      vars: string[];
    }
  | {
      /**
       * Cluster A Phase 4 (D3): inverts the silent `markCrashedSilent` sweep
       * at `bus/resume.ts:117` — when a newer multi-agent session became
       * active while an older one was still marked `running` (e.g. a
       * mid-turn server restart followed by the operator starting a fresh
       * iteration), the older row is now reported on the wire alongside the
       * crashed marker so the operator can `Reopen` (will sweep the current
       * session) or `Archive` (acknowledge and move on) per UX-6.
       *
       * `supersedingSessionId` / `supersedingTs` identify which iteration
       * displaced this one — the toast's CTA needs them to disambiguate
       * "reopen this" from "reopen any prior crash".
       */
      type: 'session_superseded';
      /** The orphaned session that was just marked crashed. */
      sessionId: string;
      /** The session that displaced it (newest active row at resume time). */
      supersedingSessionId: string;
      /** Wall-clock ms of the displacing session's `started_at` row. */
      supersedingTs: number;
    }
  | {
      /**
       * Cluster A Phase 4 (D2 precursor): emitted from
       * `bus/reconstruct.ts` immediately BEFORE the chain-mode
       * fall-back to `multi_agent_ended { reason: 'crashed' }` (BE-11).
       *
       * Chain reconstruction is intentionally deferred (orchestrator R-B
       * only in v1), so a server restart over a `running` chain row
       * silently dropped it. This typed event surfaces the bail-out so the
       * operator dock can render a warn toast naming the affected session;
       * Cluster D's wider session-recovery surface will subsume it.
       */
      type: 'chain_not_reconstructed';
      sessionId: string;
      /** Human-readable bail reason (currently always "chain mode deferred"). */
      reason: string;
    }
  | {
      /**
       * Cluster A Phase 4 (D6/D11): split out of the
       * `multi_agent_participant_added` echo when
       * `busWasAlreadyInstalled === false`. The participant-added wire
       * already carried the boolean flag, but no operator-visible event
       * fired — the sidebar bus-installed dot just flipped silently. This
       * makes the auto-install observable as a typed event; the dispatcher
       * fans it out as an info-tier toast.
       *
       * Same project + agent identifiers as the participant_added echo so
       * a single deep-link inspector ("View install log" CTA in Phase 5)
       * can resolve back to both.
       */
      type: 'bus_auto_installed';
      sessionId: string;
      projectId: number;
      agentName: string;
    }
  | {
      /**
       * Cluster A Phase 5: server's response to `request_inbox_snapshot`
       * AND the unsolicited push on every WS attach (so the bell badge
       * populates without the operator opening the panel).
       *
       * `rows` is the filtered set of persisted notification envelopes
       * (sticky-operational + all safety), most recent first. The shape is
       * identical to `NotificationEnvelope` so the inbox panel can re-use
       * the same renderer the dock does — display-coalescing aside, an
       * inbox row IS a notification.
       *
       * `unackedCountBySession` lets the sidebar render per-session unread
       * badges without each session row issuing its own query (spec §5
       * "per-session badge on session list row"). Keyed by sessionId;
       * the empty string `""` carries global-scope rows whose
       * `session_id IS NULL` so the badge code can iterate uniformly.
       * `unackedGlobal` is the convenience total across all sessions.
       */
      type: 'inbox_snapshot';
      rows: NotificationEnvelope[];
      unackedCountBySession: Record<string, number>;
      unackedGlobal: number;
    }
  | {
      /**
       * Cluster A Phase 6: emitted when the operator rejects a permission
       * request (the `deny` branch of `permission_decision`). The existing
       * `permission_decided` event carries the decision for in-session UI
       * (the request card flips to "Denied"); `tool_denied` is the
       * dock/inbox-facing surface so a denial is visible even when the
       * operator switches tabs before the agent's next step lands.
       *
       * `reasonCode` is open enum (`ToolDeniedReasonCode`); Phase 6 only
       * emits `permission_required_not_granted`. The other sub-codes
       * (allowlist_miss, denylist_hit, classifier_*) are reserved for a
       * future SDK-classifier wiring — they're in the enum so the inbox
       * filter chip can be coded against the full vocabulary now.
       */
      type: 'tool_denied';
      sessionId: string;
      requestId: string;
      toolName: string;
      reasonCode: ToolDeniedReasonCode;
      /** Operator-supplied message if any (default: "User denied this action"). */
      message?: string;
    }
  | {
      /**
       * Cluster A Phase 6 (D2): success-side counterpart to
       * `chain_not_reconstructed`. Emitted from `bus/reconstruct.ts` after
       * `wireOrchestratorSession` returns and the row is back in the live
       * registry. Pairs with the existing `RECOVERY_BANNER` (which lands in
       * scrollback as a `multi_agent_events` row) by surfacing the recovery
       * in the dock too — the banner only shows to whoever is viewing the
       * session; the toast reaches the operator wherever they are.
       *
       * `reasonCode` is always `'reconstructed'` today; the field is typed
       * as the full `SessionRecoveredReasonCode` so the inbox filter can
       * group reconstructed/superseded/swept-competing under one chip.
       */
      type: 'session_reconstructed';
      sessionId: string;
      reasonCode: SessionRecoveredReasonCode;
    };

/**
 * Cluster A Phase 1: structurally distinct severity tier vs class.
 *
 * `NotificationSeverity` is the display axis the UI uses for colour, glyph,
 * live-region politeness, and dismiss timing — six visible tiers
 * (info/success/warn/error/danger). `progress` is collapsed into `info` on
 * the wire; the client opts into the indeterminate-spinner render via the
 * action discriminant. `NotificationClass` is the structural axis the
 * server enforces: `safety` writes a `safety_audit` row before emit (BE-1)
 * and is never coalesced at the recording layer (BE-2); `operational` is
 * coalesced by a tier-specific window. The visible severity of a safety
 * event MAY be `warn` for display ergonomics (per spec OQ-3), but its
 * class stays `safety` for audit semantics.
 */
export type NotificationSeverity = 'info' | 'success' | 'warn' | 'error' | 'danger';
export type NotificationClass = 'operational' | 'safety';

/**
 * Operator action a notification can offer alongside its text. Each variant
 * encodes both a label-implying intent (the client renders the appropriate
 * label per kind) and the parameters needed to execute it. The dispatcher
 * never sends free-text action strings; the UI's button copy is derived
 * from `kind` so localisation/relabelling lives in one place.
 *
 * v1 surface (extend additively in later phases): open-target navigations,
 * re-auth (auth-expired re-auth flow / Cluster D B3), session lifecycle
 * (resume/archive/reopen for the sweep + recovery surfaces), and per-agent
 * restart (process_crashed recovery / Cluster D B3).
 */
export type NotificationAction =
  | { kind: 'open_session'; sessionId: string }
  | { kind: 'open_logs'; sessionId: string; rowAnchor?: string }
  | { kind: 'open_settings' }
  | { kind: 'reauth' }
  | { kind: 'resume'; sessionId: string }
  | { kind: 'archive'; sessionId: string }
  | { kind: 'reopen'; sessionId: string }
  | { kind: 'restart_agent'; sessionId: string; agentName?: string };

/**
 * Server-minted notification envelope; stable across reconnect-replay so the
 * client can dedupe by `id` when a sticky row re-fans on WS attach. The
 * envelope shape mirrors the `notifications` table (migration 014) so the
 * sticky-replay path doesn't need a shape translation.
 *
 * `dedupeKey` is the server's operational-coalesce key; on the client it
 * doubles as the in-place update key (an arriving envelope whose key already
 * sits in the stack increments a `×N` badge instead of stacking). `class`
 * drives the audit + ack semantics described on `NotificationClass`.
 *
 * `auditRowId` and `reasonCode` are populated only for `class === 'safety'`
 * rows and let the inbox UI deep-link to the forensic record and (Phase 5)
 * filter by enumerated sub-code.
 */
export type NotificationEnvelope = {
  id: string;
  ts: number;
  severity: NotificationSeverity;
  class: NotificationClass;
  dedupeKey: string;
  title: string;
  message?: string;
  details?: unknown;
  sessionId?: string;
  projectId?: number;
  action?: NotificationAction;
  sticky: boolean;
  /** Safety class only. References safety_audit.id for deep-linking. */
  auditRowId?: string;
  /** Safety class only. Enumerated sub-code (see floor vocabulary). */
  reasonCode?: string;
  /**
   * Set by the dispatcher when an envelope coalesces over a prior in-window
   * emit with the same `dedupeKey`. Absent on the first emit; subsequent
   * coalesces increment it. The UI uses it for the `×N` badge.
   */
  count?: number;
};

/**
 * PR-6: static facts about a project for the per-participant disclosure.
 *
 * Fields that aren't currently knowable on this codebase (model, MCP servers,
 * tool count) are intentionally absent. The client renders only fields that
 * are present — no placeholders, no "—" rows — so adding a new field later
 * is a purely additive change.
 */
export type ProjectFacts = {
  /** Project display name (echo of `projects.name`). */
  name: string;
  /** Absolute working directory (echo of `projects.path`). */
  path: string;
  /**
   * Head of the project's root `CLAUDE.md` (up to ~12 lines / ~2048 bytes).
   * Absent when the file doesn't exist, isn't a regular file, or fails to
   * read. The server normalises line endings to `\n` and never throws.
   */
  claudeMdHead?: string;
  /**
   * Human label for the FULL on-disk file size (e.g. `1.2 KB`), not the
   * truncated head. Present whenever `claudeMdHead` is present.
   */
  claudeMdSizeLabel?: string;
};

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

/**
 * Phase H: discriminator for `LogRow.kind`. Each row in the merged session
 * log is one of these atomic spans:
 *   - `bus`      — an inter-agent hop (multi_agent_events row)
 *   - `tool`     — a `tool_use` block from an agent's SDK stream
 *   - `llm`      — an assistant text/turn boundary OR a `result` SDK message
 *   - `error`    — a synthetic `multi_agent_events` row with kind=error, or
 *                  a `tool_result` with `is_error=true`, or a wrapper error
 *   - `artifact` — a confirmed mutation (matches the Artifacts surface)
 *
 * Kept narrow on purpose — the UI's chip-color palette is finite, and any
 * stream-json oddity not covered above projects as `llm` (the catch-all).
 */
export type LogRowKind = 'tool' | 'bus' | 'llm' | 'error' | 'artifact';

export const LOG_ROW_KINDS: ReadonlySet<LogRowKind> = new Set([
  'tool',
  'bus',
  'llm',
  'error',
  'artifact',
]);

/**
 * Phase H: one projected, atomic entry in the merged session log. Produced
 * server-side by `buildLogRows` from `multi_agent_events`, `events` (per
 * per-agent CLI session), and `multi_agent_mutations`. Sent over the wire
 * inside `session_log_chunk`.
 *
 * Bidirectional links:
 *   - `laneRowId` matches a `multi_agent_events.id` so a "Open in Logs at
 *     this event" affordance on a lane row can scroll to / highlight the
 *     corresponding log row, and a log row can render a "Open lane row" link
 *     back to its bus hop.
 *   - `artifactId` matches a `multi_agent_mutations.id` so an artifact-table
 *     row can deep-link into the log at its production event.
 *
 * Redaction:
 *   - `summary` is always safe to render (server-classified; no raw input).
 *   - `raw` is the projected JSON payload for `Show raw`. Sensitive fields
 *     (paths matching `.env`, `credentials`, `secret`, etc.) are masked to
 *     the literal `'<redacted>'` UNLESS the request set `revealSensitive`.
 *   - `redactedFields` lists the field paths the server masked, so the UI
 *     can offer a per-row "Reveal sensitive" confirm with concrete labels.
 */
export type LogRow = {
  /** Stable composite id: `${source}:${tableRowId}`. Anchor for URL deep-links. */
  id: string;
  ts: number;
  /** Bus slug of the producing agent, or 'user'/'cebab'/'orchestrator'/'_sink'. */
  agent: string;
  kind: LogRowKind;
  /** One-line operator-readable summary (safe to render at any time). */
  summary: string;
  /** Optional wall-clock duration of the span, when known (tool calls, turns). */
  durationMs?: number;
  /** Optional discriminator for the kind chip — e.g. tool name, event kind. */
  status?: string;
  laneRowId?: number;
  artifactId?: number;
  /**
   * Mutation severity, surfaced as a top-level field (not nested in `raw`)
   * so it cannot be hidden behind the Show-raw toggle and is structurally
   * incapable of colliding with the redaction key list. Populated only for
   * mutation-derived rows (kinds `tool` / `artifact`); `'mutate'` for normal
   * writes, `'dangerous'` for `.env`/secrets/`.git/config`-class paths that
   * the artifact classifier flagged. The browser renders this as a `⚠
   * DANGEROUS` pill identical to the Mutations panel's badge, and as a
   * `Logs · ⚠ N` rollup on the Logs button.
   */
  severity?: 'mutate' | 'dangerous';
  /**
   * Server-projected detail JSON for the row drawer. Sensitive fields are
   * already masked at this layer; absent when there is nothing useful to
   * show (e.g. a bus hop whose `summary` already says everything).
   */
  raw?: unknown;
  /**
   * Dot-paths into `raw` that the server masked. Empty when nothing was
   * redacted. The Reveal-sensitive confirm uses these to tell the operator
   * *what* they're about to un-mask.
   */
  redactedFields?: string[];
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
  /**
   * Target file path for tools that write/edit a single file
   * (`Write` / `Edit` / `MultiEdit` / `NotebookEdit`). NULL for everything
   * else and for rows from pre-012 sessions. Surfaced so the lane and
   * artifact views can group writes by file without re-parsing inputs.
   */
  filePath: string | null;
  /**
   * Agent's working directory at the moment the tool fired (denormalized
   * from the participant row). NULL for pre-012 rows. Used by the artifact
   * promotion classifier to resolve `filePath` relative to the worktree
   * root before glob-matching.
   */
  cwd: string | null;
  /**
   * Wall-clock ms when the matching `tool_result` arrived. NULL until then
   * — a write whose result never lands (paused, aborted, errored
   * mid-flight) stays NULL forever and the UI badges it as provisional so
   * the operator isn't misled by a row that may not actually exist on disk.
   * The server re-emits `multi_agent_mutation` for the same `id` with
   * `confirmedAt` populated when the result arrives; the reducer dedupes
   * by `id` and replaces.
   */
  confirmedAt: number | null;
  /**
   * Phase E: set by `classifyArtifact` when the file passes the locked
   * promotion globs (plans/**, PLAN*.md, etc.). The artifacts query is a
   * flat `WHERE promoted = 1`; pre-012 / non-promoted rows stay `false`.
   */
  promoted: boolean;
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
 * PR-6 seam: hand-authored topology, stored alongside the template so the
 * future custom-mode editor (NOT shipped here) can save freeform positions
 * + edges. Coordinates are **viewBox units**, not pixels — the renderer
 * meet-scales the SVG to the stage. Keys in `positions` are
 * `String(projectId)`; stale keys (project since removed) are filtered at
 * render time, not at save time, so the operator can re-add the project
 * without losing the layout. `edges` is explicit so adding the field later
 * never requires a migration — orchestrator/chain modes ignore it.
 *
 * Topology constraints (enforced by the future editor, NOT by this type):
 *  - No worker→worker edges (F2 drops them in `orchestrator.ts`)
 *  - No worker→user edges (F2)
 *  - No self-loops
 *  - No edges to/from non-participants (F2)
 *  - No disconnected components
 *  - No "broadcast" edge type (broadcast is policy, not topology)
 *
 * See `validateCustomTopology` in `shared/src/topology.ts` for the runtime check.
 */
export type CustomLayout = {
  kind: 'custom';
  /** Per-participant position in viewBox units. Key = `String(projectId)`. */
  positions: Record<string, { x: number; y: number }>;
  /** Explicit edges so the schema is stable across future "edge kinds". */
  edges?: Array<{ from: number; to: number }>;
  /** Authoring canvas size in viewBox units (renderer meet-scales). */
  canvas?: { w: number; h: number };
};

/**
 * A saved multi-agent draft preset. Stores everything needed to refill the
 * draft EXCEPT the prompt — the operator always types a fresh first prompt.
 * Persisted server-side as a single JSON array under one `settings` row
 * (no dedicated table), mirroring the iterations browser's architecture.
 *
 * PR-6 widens `mode` to include `'custom'` and adds an optional `layout`
 * field. `'custom'` is presentation-only: the runtime still uses
 * orchestrator routing (the bus has no "custom mode"; the editor will
 * constrain freeform topologies to one of the runtime-valid presets).
 * Older clients with no knowledge of `'custom'` should fall back to
 * orchestrator rendering rather than treating the template as malformed.
 */
export type MultiAgentTemplate = {
  /** Stable server-minted id; the delete key. Names are mutable, ids aren't. */
  id: string;
  name: string;
  /** PR-6: 'custom' is presentation-only — bus routing follows orchestrator. */
  mode: 'chain' | 'orchestrator' | 'custom';
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
  /**
   * PR-6: optional hand-authored layout. Absent on every template saved
   * before PR-6 (and on every chain/orchestrator template — the layout
   * comes from the geometry rules in those modes). Present only when
   * `mode === 'custom'`; the future editor refuses to save `'custom'`
   * without a layout.
   */
  layout?: CustomLayout;
  /**
   * PR-7 (round-2 plan): optional per-template hop budget override. When set,
   * a run started from this template uses this value instead of the global
   * default (DB setting > `CEBAB_HOP_BUDGET` env > built-in `DEFAULT_HOP_BUDGET`).
   * Absent on templates saved before PR-7 — the renderer treats absent as
   * "no override" (operator sees the global default applied to that run).
   *
   * Sanity: positive integer. Sub-1 values are rejected at the save handler.
   */
  hopBudget?: number;
};

/**
 * PR-7 (round-2 plan): one past run for a given template, as surfaced to the
 * "Last run" rail under that template's card.
 *
 * The runtime status enum (`IterationSummary.status`) is preserved AS-IS;
 * the rail derives its render label ("ok" / "at cap" / "interrupted" /
 * "failed") at the boundary — no protocol-level widening. See the table
 * in PR-7's plan section for the mapping.
 */
export type TemplateLastRun = {
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  /** Same enum as `IterationSummary.status`. The client derives a label. */
  status: 'running' | 'completed' | 'stopped' | 'crashed';
  /** Final persisted hop count at teardown. `null` while still running. */
  hopsUsed: number | null;
  /** The hop budget that was in force for this run (post-resolution).
   *  `null` for pre-013 rows whose hop_budget column was never populated. */
  hopBudget: number | null;
  /** First operator-facing error text observed during the run (~200 chars).
   *  Used for the "failed · <excerpt>" line in the rail. Absent on clean
   *  runs and on pre-013 rows. */
  firstError?: string;
  /** Absolute path to the iteration directory — clicking the rail opens it. */
  artifactsDir?: string;
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
