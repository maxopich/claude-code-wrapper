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
  /**
   * Cluster G Phase 2b (UI-A3): 1 iff this session was created under MOCK
   * runtime mode (the `sessions.mock` column from migration 023). Surfaced
   * so the ProjectList session row can render its `MockBadge` even when
   * the row predates the current process's MOCK setting — the operator
   * may have launched the server in mock mode last week, then restarted
   * live; the historical session still carries the MOCK tag.
   *
   * Optional for forward-compat: pre-G2 server payloads omit; the row
   * mount predicate uses strict equality on === true so undefined (and
   * false) both render nothing.
   */
  mock?: boolean;
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
  | 'unknown_source'
  /**
   * Cluster C Phase 4b: operator muted this participant; router drops every
   * BusEvent where `ev.source === <agent>`. This is the spec's §3 invariant 1
   * enforcement point — mute MUST drop at the router, not UI-only, otherwise
   * the agent's outbound still reaches its recipient and the "silent safety"
   * regression returns. The mute itself wrote the parent safety_audit row at
   * handler time; the per-event router_drop addendum keeps the operator's
   * "what did the muted agent try to say?" forensics view populated.
   */
  | 'muted_source'
  /**
   * Cluster C Phase 4d: operator kicked this participant (drain mode). Router
   * drops every BusEvent where `ev.source === <agent>` — kicked agents are
   * removed from active routing, but the in-flight turn keeps running so
   * `bus_send` calls it issues while draining land here as forensic
   * drop-rows. Distinct from `muted_source` so the operator can tell apart
   * "operator silenced this worker, but it's still doing valid work" from
   * "this worker was kicked and the in-flight turn is draining out."
   */
  | 'kicked_source'
  /**
   * Cluster C Phase 4d: complement of `kicked_source` — router drops every
   * BusEvent where `ev.destination === <kicked agent>`. Unlike mute (which
   * is one-way and lets the muted agent keep receiving), kick is
   * bidirectional: a kicked worker is removed from routing in both
   * directions, so a stale orchestrator reply addressed at a kicked worker
   * never wakes a fresh turn. The drop-row is forensically useful (it
   * answers "did the orchestrator try to talk to the kicked worker after
   * the kick?") without re-engaging the participant.
   */
  | 'kicked_destination';

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

/**
 * Cluster C Phase 2 (spec §4.2 / §4.5): enumerated reason for a
 * single-agent Stop. Captured via the inline non-blocking prompt
 * after the Stopped marker; the operator may also Skip (no
 * `stop_reason` message ships in that case). `'other'` is the
 * escape hatch and REQUIRES a non-empty `reasonText`; the server
 * rejects mismatched pairs (no-op + logs).
 *
 * Kept narrow on purpose. Bus-side mute/pause/kick reasons (spec
 * §3 "reason code enum") share the same identifier space but cover
 * more states (`forensics`, `topology_repair`, etc.); those are
 * defined alongside the Part 2 ClientMsgs in a later cluster phase.
 * For single-agent Stop these six codes suffice and map to the
 * agentic-reviewer recommendation in §4.2.
 */
export type StopReasonCode =
  | 'incorrect_output'
  | 'runaway_loop'
  | 'off_task'
  | 'cost'
  | 'done_early'
  | 'other';

export const STOP_REASON_CODES: ReadonlySet<StopReasonCode> = new Set([
  'incorrect_output',
  'runaway_loop',
  'off_task',
  'cost',
  'done_early',
  'other',
]);

export function isStopReasonCode(v: unknown): v is StopReasonCode {
  return typeof v === 'string' && STOP_REASON_CODES.has(v as StopReasonCode);
}

/**
 * Cluster C Phase 4a (Part 2 backend foundation, spec §3 "Reason code
 * enum"): enumerated reason codes for the per-agent control verbs
 * (mute/unmute/pause/resume/kick). This is the SUPERSET of the
 * single-agent `StopReasonCode` from §4.2 — Stop's `done_early`
 * doesn't make sense for mute/kick of one of N workers in an
 * orchestrator session, so it's intentionally absent here.
 *
 * `other` requires a non-empty `reasonText` supplement (Phase 4b
 * handler enforces the pairing, same shape as `stop_reason`). `cost`
 * is renamed to `cost_ceiling` per the spec's verb-side enum — the
 * single-agent enum's bare `cost` was the older shorthand.
 */
export type ControlReasonCode =
  | 'runaway_loop'
  | 'off_task'
  | 'cost_ceiling'
  | 'tool_misuse'
  | 'incorrect_output'
  | 'forensics'
  | 'topology_repair'
  | 'other';

export const CONTROL_REASON_CODES: ReadonlySet<ControlReasonCode> = new Set([
  'runaway_loop',
  'off_task',
  'cost_ceiling',
  'tool_misuse',
  'incorrect_output',
  'forensics',
  'topology_repair',
  'other',
]);

export function isControlReasonCode(v: unknown): v is ControlReasonCode {
  return typeof v === 'string' && CONTROL_REASON_CODES.has(v as ControlReasonCode);
}

/**
 * Cluster C Phase 4a: kick variants. v1 server accepts only `'drain'`
 * (soft kick: stop routing, let in-flight turn drain). `'hard'` is
 * carried on the wire so the client-side enum is forward-compatible,
 * but Phase 4b's handler returns `wrapper_error` with code
 * `hard_kill_unsupported_v1` until the per-agent AbortController
 * refactor (spec §5.2 "kick (hard)") lands.
 */
export type KickMode = 'drain' | 'hard';

export const KICK_MODES: ReadonlySet<KickMode> = new Set(['drain', 'hard']);

export function isKickMode(v: unknown): v is KickMode {
  return typeof v === 'string' && KICK_MODES.has(v as KickMode);
}

/**
 * Cluster C Phase 4a: pause-expiry actions. `auto_resume` lets the
 * paused participant pick back up where it left off; `auto_kick`
 * escalates to a kick (drain mode) on expiry — used for the operator
 * who's setting a deadline ("if I haven't come back in 10m, get this
 * worker out of the session"). The expiry handler itself (timer +
 * dispatch) lands in Phase 4c with the dedicated pause-timeout work.
 */
export type PauseExpiryAction = 'auto_resume' | 'auto_kick';

export const PAUSE_EXPIRY_ACTIONS: ReadonlySet<PauseExpiryAction> = new Set([
  'auto_resume',
  'auto_kick',
]);

export function isPauseExpiryAction(v: unknown): v is PauseExpiryAction {
  return typeof v === 'string' && PAUSE_EXPIRY_ACTIONS.has(v as PauseExpiryAction);
}

/**
 * Cluster C Phase 4a: failure codes the Phase 4b handlers may return
 * via `wrapper_error` to reject a control verb. These are NOT safety
 * audit `reasonCode`s — they're operator-facing diagnostic codes.
 *
 *   - chain_mute_unsupported    — Mute requested in chain mode (spec §5.3)
 *   - chain_topology_broken     — Kick of a chain-middle participant
 *   - hard_kill_unsupported_v1  — Kick mode='hard' before AbortController refactor
 *   - already_in_state          — Mute on muted / pause on paused / etc.
 *   - participant_not_found     — Unknown (sessionId, projectId) pair
 *   - participant_already_kicked — Operating on a kicked participant
 *   - orchestrator_cannot_kick  — Kick targeted at the orchestrator row
 *   - pause_timeout_required    — `timeoutMs` missing or non-positive
 *   - pause_expiry_action_invalid — `expiryAction` not one of PAUSE_EXPIRY_ACTIONS
 */
export type ControllabilityFailureCode =
  | 'chain_mute_unsupported'
  | 'chain_topology_broken'
  | 'hard_kill_unsupported_v1'
  | 'already_in_state'
  | 'participant_not_found'
  | 'participant_already_kicked'
  | 'orchestrator_cannot_kick'
  | 'pause_timeout_required'
  | 'pause_expiry_action_invalid';

export const CONTROLLABILITY_FAILURE_CODES: ReadonlySet<ControllabilityFailureCode> = new Set([
  'chain_mute_unsupported',
  'chain_topology_broken',
  'hard_kill_unsupported_v1',
  'already_in_state',
  'participant_not_found',
  'participant_already_kicked',
  'orchestrator_cannot_kick',
  'pause_timeout_required',
  'pause_expiry_action_invalid',
]);

export function isControllabilityFailureCode(v: unknown): v is ControllabilityFailureCode {
  return (
    typeof v === 'string' && CONTROLLABILITY_FAILURE_CODES.has(v as ControllabilityFailureCode)
  );
}

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
  | {
      type: 'send_message';
      projectId: number;
      sessionId?: string;
      text: string;
      /**
       * Cluster F Phase A1a (UI-A1): per-turn MAX_TURNS override. When
       * present, the server's resolver uses this value instead of the
       * stored `max_turns` setting (or the env / built-in default).
       *
       * Used today by the (future) Extend +N affordance: an `error_max_turns`
       * result lets the operator re-issue the same prompt with a higher
       * cap. The SDK has no mid-turn cap-raise — the "extend" is structurally
       * a continuation send_message with a higher maxTurns. v1 keeps the
       * per-turn override optional; the UI's number input lands in F-A1b.
       *
       * Server-side semantics: any positive integer is accepted; clamped to
       * >= 1; non-finite values are ignored (resolver falls through).
       */
      maxTurns?: number;
    }
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
  | {
      /**
       * Cluster F Phase A1a (UI-A1): persist a new default MAX_TURNS cap
       * for single-agent runs. Stored in `settings` keyed by `max_turns`.
       * Mirrors `set_default_hop_budget` semantics exactly: clamp to
       * `value >= 1`, ignore non-finite. Takes effect on the next
       * `send_message` that doesn't carry its own `maxTurns` override;
       * active in-flight turns keep their resolved value.
       *
       * The full server resolver precedence: per-turn `send_message.maxTurns`
       * > this DB setting > `MAX_TURNS` env > built-in default (50).
       */
      type: 'set_default_max_turns';
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
       * Cluster D Phase 5 (spec §6.4 / BE-D22): archive a single
       * multi-agent session so it no longer appears in the default
       * iterations browser. The row is preserved (`archived = 1` on
       * `multi_agent_sessions`); a later `list_archived_iterations`
       * surface (not in v1) can resurface it on demand. The dispatcher's
       * `session_superseded` toast carries an Archive action that fires
       * this exact verb — the operator's one-click "yes, I'm aware the
       * older row was crashed because a newer iteration took over;
       * stop reminding me" affordance.
       *
       * `removeArtifacts` is opt-in: default false leaves the per-session
       * folder on disk for post-mortem inspection (consistent with
       * `clear_iterations` which never touches disk). Setting it to true
       * rm-rfs the folder after the row flip succeeds — useful when the
       * operator wants to drop a swept temp session entirely. Per BE-D23
       * the handler honors the flag only when the field is explicitly
       * `true`; any other value (including absent) is treated as false.
       *
       * Rejects with `wrapper_error` when:
       *   - the session id doesn't exist (no row to flip),
       *   - the session is still `running` (active sessions are not
       *     archivable — operator must Stop or End first).
       * Already-archived rows return success silently (the UPDATE matches
       * 0 rows, but the operator's intent is satisfied — idempotent).
       *
       * Server replies with `iteration_archived` carrying the flipped
       * `sessionId` + a `removedArtifacts: boolean` confirming whether
       * disk artifacts were actually wiped. The reducer uses that to
       * drop the row from the iterations cache without a second
       * round-trip.
       *
       * Writes one `recovery_log` row per call (BE-D24):
       *   { failure_class: 'sweep', operator_action: 'archive' }.
       */
      type: 'archive_session';
      sessionId: string;
      /** Default false; true rm-rfs the per-session folder after the flip. */
      removeArtifacts?: boolean;
    }
  | {
      /**
       * Cluster D Phase 5b (spec §6.3 / BE-D19): step 1 of the swept-session
       * reopen flow. The operator clicks "Reopen" on a SweptSessionBanner
       * (Phase 5c web) — Cebab needs to surface a workspace-diff confirmation
       * before doing anything destructive, so this ClientMsg is a PROBE:
       * the server validates the target session is finalizable + computes a
       * workspace diff for the operator to acknowledge, and replies with
       * `reopen_session_confirm_required` carrying the diff payload.
       *
       * It does NOT swap the active session or reactivate the swept one —
       * that's `reopen_session_confirmed` (Phase 5c). Splitting probe vs
       * commit lets the modal render the diff before risking any state
       * change; the typed "reopen" gate (BE-D21) lives entirely client-side
       * in the modal, since the modal is the only surface that sees the diff.
       *
       * Rejects with `reopen_session_failed` when:
       *   - the session id doesn't exist,
       *   - the session is still `running` (only finalized rows can be
       *     reopened — the operator would never reopen a live session),
       *   - the session has no resolvable participant project (orphan;
       *     can't compute a diff path).
       *
       * Archived rows ARE allowed to reopen (the operator can change their
       * mind after archiving); Phase 5c's confirmed handler will also
       * unarchive them as part of the swap.
       */
      type: 'reopen_session';
      sessionId: string;
    }
  | {
      /**
       * Cluster D Phase 5c (spec §6.3 / BE-D20, BE-D21): step 2 of the
       * swept-session reopen flow. After `reopen_session` returns
       * `reopen_session_confirm_required` and the modal renders the diff,
       * the operator clicks "Reopen" (typing "reopen" when the workspace
       * had any changes); this message commits the swap.
       *
       * Validation (server re-runs the diff for safety — the modal could
       * stale-render if the operator left the dialog open for a long
       * time + something changed on disk):
       *   - `acknowledgedWorkspaceDiff` MUST be true (forces the modal
       *     code path to deliberately set the flag).
       *   - When the server's freshly-computed diff has
       *     `filesChanged > 0` OR `!fullDiffAvailable`, `typedConfirmation`
       *     MUST be the literal string `'reopen'`. (Spec BE-D21 — typed
       *     gate on any uncertainty about workspace state. Empty diff +
       *     fullDiffAvailable means "we are confident the workspace
       *     hasn't moved"; only that path skips the typed gate.)
       *
       * Side effects on success:
       *   - If the connection has an active multi-agent session, it is
       *     detached and marked `crashed` (no operator data loss — the
       *     events are persisted; same posture as the existing single-
       *     active sweep). A `session_superseded` notification fires for
       *     the displaced session (`reasonCode: 'operator_reopen'`).
       *   - The target session is unarchived (if archived) and
       *     reactivated via the existing R-B reconstruction path.
       *   - `recovery_log` row written
       *     ({ failureClass: 'sweep', operatorAction: 'reopen' }) so the
       *     spec §8.5 sweepReopenRate roll-up sees this case.
       *   - The browser receives the standard `multi_agent_started` +
       *     event replay (same envelopes `resume_multi_agent` already
       *     ships) so the reducer transitions cleanly into the active-run
       *     view.
       *
       * Rejects with `reopen_session_failed` when:
       *   - The target session is unknown OR has become running between
       *     probe and confirm (race).
       *   - The typed gate fails (acknowledgedWorkspaceDiff=false OR
       *     typedConfirmation missing when required).
       *   - Reactivation itself fails (chain mode without a live handle,
       *     or R-B reconstruction couldn't bring the row back).
       */
      type: 'reopen_session_confirmed';
      sessionId: string;
      acknowledgedWorkspaceDiff: boolean;
      typedConfirmation?: string;
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
    }
  | {
      /**
       * Cluster B Phase 3 (BE-B3 / BE-B4): operator asks for the current
       * authority snapshot of a project (effective tools + MCP servers +
       * allow/deny attribution + env-injection scan + hooks scan). The
       * answer rides `project_authority`.
       *
       * `mode: 'cache'` — return whatever the server has cached from the
       * most recent `session_started` for any session in this project; if
       * the project has never started a session in this WS connection,
       * returns `authority: null`. Cheap, synchronous.
       *
       * `mode: 'probe'` — Phase 3b will spawn a `maxTurns: 0` SDK run with
       * `subscriptionOnlyEnv` and the project's Trust-derived `settingSources`
       * so the inspector shows live state without waiting for the next real
       * turn. Phase 3 falls through to cache behavior with a `[project_authority]`
       * info log; no UI consumes the probe path yet (Phase 7 preflight modal
       * wires the "Refresh" button — spec §10).
       */
      type: 'get_project_authority';
      projectId: number;
      mode: 'cache' | 'probe';
    }
  | {
      /**
       * Cluster B Phase 4 (§4.4): operator's TOFU decision for an MCP server
       * about to be (or previously) spawned by the SDK from a project's
       * `settings*.json`. Two trigger paths:
       *
       *   1. **Operator-initiated** (Phase 7 UI, available now):
       *      AuthorityPanel offers Trust/Deny actions per MCP server card;
       *      the client ships this message with `pendingId` absent.
       *      The server records the decision in `mcp_trust` + `safety_audit`
       *      so the next session's resolver JOIN reflects it.
       *
       *   2. **Gate-initiated** (Phase 4b): a `mcp_auto_install_pending`
       *      ServerMsg parks a pre-spawn block and waits for this reply
       *      with the matching `pendingId`. Trust/trust_pinned releases
       *      the block; deny_once/deny_remember rejects.
       *
       * Decisions persisted:
       *   - `trust`         → mcp_trust row (decision='trusted')
       *   - `trust_pinned`  → mcp_trust row (decision='trusted_pinned_hash');
       *                       requires `binarySha` (UI greys out the affordance
       *                       when the target is unresolvable, e.g. npx)
       *   - `deny_remember` → mcp_trust row (decision='denied_remember')
       *   - `deny_once`     → NO mcp_trust row; per-session in-memory deny
       *                       (Phase 4b session-state). Operator re-prompted
       *                       on the next spawn.
       *
       * Operator identity is resolved server-side via `getOperatorId()`
       * (matches Cluster A's ack pattern) — not from the client, which can't
       * be trusted to report it accurately.
       */
      type: 'mcp_trust_decision';
      pendingId?: string;
      serverName: string;
      originPath: string;
      binarySha?: string;
      decision: 'trust' | 'trust_pinned' | 'deny_once' | 'deny_remember';
    }
  | {
      /**
       * Cluster B Phase 5 (§4.5): operator's typed-acknowledgment reply to a
       * parked `session_start_gated`. The server validates
       * `typedAcknowledgment === 'inject'` (case-sensitive) BEFORE resolving
       * the gate — a mistyped string is a wrapper_error, the spawn stays
       * parked, and the operator can retry. This deliberately matches the
       * UX intent: the modal makes the operator type the word "inject"
       * before the credential-injecting session proceeds.
       *
       * `reasonText` is optional free-form context the operator can type
       * ("CI sync, expected this") — persisted into the safety_audit row
       * payload so the forensic trail captures the why, not just the click.
       *
       * Operator identity is resolved server-side via `getOperatorId()` per
       * Cluster A convention; not on the wire.
       */
      type: 'acknowledge_and_start';
      pendingStartId: string;
      typedAcknowledgment: string;
      reasonText?: string;
    }
  | {
      /**
       * Cluster D Phase 4 (spec §4.2, BE-D4): "Retry now" trigger for a
       * held single-agent turn that hit a rate-limit. The server
       * re-delivers the captured user message on the same SDK session
       * via `--resume <sessionId>`, so no fresh `system/init` quota
       * burn happens.
       *
       * Phase 4a forward-declared the discriminant; Phase 4b ships the
       * message-capture machinery + the server handler + the
       * `recovery_log` row.
       *
       * `auto` distinguishes operator-click (default, `false`) from a
       * client-side auto-scheduled retry (the `<CountdownChip>` in
       * Phase 4c ticks down and fires `{ auto: true }` when it hits
       * zero). The server uses this to tag the `recovery_log` row's
       * `operatorAction` as `'manual_retry'` vs `'auto_retry'` — the
       * spec §8.5 regression-gate query distinguishes which path
       * recovered the session.
       *
       * Why the cadence lives on the client (and not the server):
       * pause / resume is a per-operator-pane decision; the server
       * staying stateless about retry timing means a tab close +
       * reopen doesn't lose pause state to the wrong source of truth,
       * and a second operator opening the same session doesn't see a
       * countdown someone else paused.
       *
       * Idempotency: while a retry is in flight, a second
       * `retry_rate_limited` for the same sessionId is a
       * `wrapper_error` ("retry already in flight"); once the retry
       * resolves (success or new error), a fresh click is accepted.
       * Idempotency is keyed by sessionId — a session has at most one
       * held turn at a time.
       */
      type: 'retry_rate_limited';
      sessionId: string;
      /** Client-scheduled auto-fire (default false = operator click). */
      auto?: boolean;
    }
  | {
      /**
       * Cluster D Phase 6b (spec §6.4 / UI-D22 follow-up): operator
       * clicked the AuthRefreshModal's "Re-authenticate" primary
       * action. Server spawns `claude login` as a subprocess (the
       * official auth flow — opens a browser to OAuth, listens on a
       * local port for the callback, writes new credentials to
       * `~/.claude/.credentials.json`).
       *
       * Process-wide single-flight: only one `claude login` runs at a
       * time. A concurrent request gets `auth_refresh_failed` with
       * reason `'already_running'`. The credentials file is global
       * shared state; racing spawns would produce undefined behavior.
       *
       * Subscription-only env applies (same `subscriptionOnlyEnv()`
       * helper as the runner's main spawn path) so a stray
       * `ANTHROPIC_API_KEY` in the operator's shell rc can't poison
       * the OAuth flow.
       *
       * Reply pattern: `auth_refresh_started` (on successful spawn) →
       * many `auth_refresh_output` (stdout/stderr chunks) →
       * `auth_refresh_completed` (terminal). On start-time failure
       * (already_running / spawn_failed): single `auth_refresh_failed`.
       */
      type: 'start_auth_refresh';
    }
  | {
      /**
       * Cluster D Phase 6b: operator clicked Cancel inside the live
       * AuthRefreshModal. Server kills the active subprocess (if it
       * matches `runId`); a synthetic `auth_refresh_completed` follows
       * with `success: false` so the modal exits its running state.
       *
       * `runId` is the same opaque uuid the server emitted in
       * `auth_refresh_started` — mismatches are silent no-ops
       * (defensive race-guard: a second cancel-after-completion
       * shouldn't kill a freshly-started run).
       */
      type: 'cancel_auth_refresh';
      runId: string;
    }
  | {
      /**
       * Cluster D Phase 8a (spec §8.5): operator request for a snapshot of
       * the `recovery_log` table. The reply (`recovery_log_snapshot`)
       * carries the per-class aggregates the regression-gate queries name
       * (sweep reopen rate, auth resume choice ratio, count + reachedFinal
       * + median time-to-recovery per failure class) plus the N most-recent
       * rows for the inspector's "recent activity" list.
       *
       * `recentLimit` is opt-in; the server defaults to 100 when absent.
       * Values are clamped server-side to [1, 100] so a buggy/malicious
       * client can't pull every row in one request. Pagination is left
       * for a future cursor field — the Phase 8b inspector renders one
       * page only.
       *
       * No auth gate — `recovery_log` is local-operator forensics.
       */
      type: 'get_recovery_log_snapshot';
      recentLimit?: number;
    }
  | {
      /**
       * Cluster C Phase 4g4 (spec §5.5, §6.4): operator request for the
       * forensic bundle captured at the moment a specific agent was kicked
       * in a specific session. The reply (`kick_forensics_snapshot`) carries
       * the parsed bundle ready for the KickForensicsModal — no second
       * round-trip needed.
       *
       * Resolution: server runs `getLatestForensicsForAgent(sessionId,
       * agentSlug)`; for live sessions where kick is terminal, this returns
       * the kick-time bundle. The companion safety_audit row's reason is
       * looked up + included so the modal can render "kicked: tool_misuse —
       * leaked credential" without a second query.
       *
       * Returns `kick_forensics_snapshot { found: false }` when no bundle
       * exists (e.g. the operator opens the viewer before kick completes
       * the forensic write, or the row was lost in a server crash before
       * persist).
       *
       * No auth gate — local-operator forensics, same posture as
       * `recovery_log_snapshot`.
       */
      type: 'get_kick_forensics';
      sessionId: string;
      agentSlug: string;
    }
  | {
      /**
       * Cluster C Phase 2 (spec §4.2, §4.5): operator's after-the-fact
       * categorisation of why they Stopped a single-agent turn. The
       * UI's inline non-blocking prompt under the Stopped marker
       * dispatches this ClientMsg on submit; Skip is allowed and ships
       * nothing (no `stop_reason` message in that case — the
       * "unspecified" outcome is the absence of an event).
       *
       * Bound to a specific Stop via `interruptAckId`, which the
       * server emitted in the matching `session_interrupted` envelope.
       * The server validates the id against the latest tracked Stop
       * for the session and silently drops mismatched messages — a
       * late reason from a previous Stop should not bind to a fresher
       * one. The drop is logged but not surfaced to the operator;
       * the reason was lost-to-time, not malicious.
       *
       * `reasonCode = 'other'` REQUIRES a non-empty `reasonText`. The
       * server logs + drops a mismatched pair; the client's prompt
       * also enforces this client-side via a required text input that
       * appears when "Other" is selected.
       *
       * Server side-effect: writes a `safety_audit` row with
       * `kind = 'session.stop_reason'`. Phase C3 will convert this
       * standalone row into an addendum to the parent
       * `session.stopped` audit row (which lands in C3 alongside the
       * full forensic bundle).
       */
      type: 'stop_reason';
      sessionId: string;
      interruptAckId: string;
      reasonCode: StopReasonCode;
      reasonText?: string;
    }
  /**
   * Cluster C Phase 4a (Part 2 backend foundation, spec §5.1): per-agent
   * mute / unmute / pause / resume / kick. These ClientMsgs define the
   * wire shape for the operator's per-worker control verbs in
   * orchestrator + chain bus sessions. The Phase 4a slice ships the
   * shape + the persistence layer; the WS handlers and the
   * router/runner enforcement land in Phase 4b.
   *
   * Wire identity = (sessionId, projectId) — same composite key the
   * multi_agent_participants table uses. `sessionId` is the bus
   * session's `multi_agent_sessions.id`; `projectId` identifies the
   * specific participant within that session's roster.
   *
   * Every action requires an enumerated `reasonCode` (the §3 enum)
   * plus an optional `reasonText` ('other' requires it, validated at
   * the wire). The reason becomes part of the safety_audit row that
   * the Phase 4b handler dual-writes before the wire ack.
   *
   * Topology guards (Phase 4b enforces, codes defined in
   * `ControllabilityFailureCode` above):
   *   - Mute in chain mode → `chain_mute_unsupported`
   *   - Kick of chain-middle participant → `chain_topology_broken`
   *   - Kick mode='hard' (v1) → `hard_kill_unsupported_v1`
   *   - Kick of orchestrator row → `orchestrator_cannot_kick`
   */
  | {
      type: 'mute_participant';
      sessionId: string;
      projectId: number;
      reasonCode: ControlReasonCode;
      reasonText?: string;
    }
  | {
      type: 'unmute_participant';
      sessionId: string;
      projectId: number;
      reasonCode: ControlReasonCode;
      reasonText?: string;
    }
  | {
      /**
       * Pause: hold scheduling for this participant. `timeoutMs` is
       * REQUIRED per spec §5.6 — the wire validator (Phase 4b) rejects
       * a missing or non-positive value with `pause_timeout_required`.
       * `expiryAction` determines auto-behavior on expiry: resume
       * silently or auto-kick with the pause's `reasonCode` carried
       * forward.
       */
      type: 'pause_participant';
      sessionId: string;
      projectId: number;
      reasonCode: ControlReasonCode;
      reasonText?: string;
      timeoutMs: number;
      expiryAction: PauseExpiryAction;
    }
  | {
      type: 'resume_participant';
      sessionId: string;
      projectId: number;
      reasonCode: ControlReasonCode;
      reasonText?: string;
    }
  | {
      /**
       * Remove a participant from the active routing set. v1 server
       * accepts only `mode: 'drain'` (soft kick — drop routing
       * immediately, drain in-flight turn in background). `'hard'`
       * returns wrapper_error until per-agent AbortController lands.
       */
      type: 'kick_participant';
      sessionId: string;
      projectId: number;
      reasonCode: ControlReasonCode;
      reasonText?: string;
      mode: KickMode;
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
  | {
      type: 'session_running';
      projectId: number;
      sessionId: string;
      running: boolean;
      /**
       * Cluster D Phase 4 (spec §4.2): additive sub-status surfaced when the
       * UI needs to distinguish "actively producing tokens" from secondary
       * waits — rate-limit backoff, post-restart awaiting-continue, operator
       * pause. Old clients reading just `running` continue to work; new
       * clients (RateLimitBanner, SweptSessionBanner, AuthExpiredBanner)
       * key off `status` to render their tier + countdown + actions.
       *
       * Wire semantics:
       *   - `'thinking'` — running=true, no banner state. The default when
       *     status is omitted; included here only so the discriminant union
       *     stays exhaustive.
       *   - `'rate_limited'` — running=true logically (the turn is held, not
       *     dead) but no tokens are being produced; the operator sees the
       *     RateLimitBanner countdown. Flipped on hard `rate_limit_event`.
       *   - `'awaiting_continue'` — R-B reconstruction state; running=false
       *     until the operator clicks Continue.
       *   - `'paused'` — operator-initiated pause of auto-retry (Phase 4b's
       *     `pause_auto_retry` ClientMsg).
       *
       * Phase 4a ships the type slot; Phase 4b wires the actual flips.
       */
      status?: 'thinking' | 'rate_limited' | 'awaiting_continue' | 'paused';
    }
  | {
      type: 'session_started';
      sessionId: string;
      projectId: number;
      model: string;
      tools: string[];
      // Cluster B Phase 2 (BE-B1, B1 / F1 / E1 / agentic-reviewer §11):
      // The SDK init payload (SDKSystemMessage subtype 'init') is rich —
      // cwd, permissionMode, apiKeySource, slash_commands, skills, agents,
      // plugins, mcp_servers (with status), output_style, fast_mode_state,
      // memory_paths — but Cebab was forwarding only model + tools and
      // silently dropping the rest. The B1 "data on wire, nothing rendered"
      // audit (critical/B-authority-transparency.md §1) names this as the
      // single biggest gap.
      //
      // All new fields are OPTIONAL so old clients ignore them and the
      // translator can omit anything the SDK doesn't ship (forward-compat:
      // SDK adds a new init field → we surface nothing for it until protocol
      // catches up; CI doesn't break). The translator at server/src/ws/
      // translate.ts is the only producer; it mirrors the SDK shape verbatim
      // and the AuthorityPanel (Phase 6+) is the only consumer.
      //
      // Wire cost: a few hundred bytes per turn — accepted (spec R-B5).
      // Persistence: the most recent init lands in Conn.inFlight per session
      // so `get_project_authority { mode: 'cache' }` (Phase 3) can return
      // the snapshot without re-spawning the SDK.
      cwd?: string;
      permissionMode?:
        | 'default'
        | 'acceptEdits'
        | 'bypassPermissions'
        | 'plan'
        | 'dontAsk'
        | 'auto';
      apiKeySource?: 'user' | 'project' | 'org' | 'temporary' | 'oauth';
      claudeCodeVersion?: string;
      outputStyle?: string;
      fastModeState?: 'off' | 'cooldown' | 'on';
      memoryPaths?: { auto?: string; [k: string]: string | undefined };
      mcpServers?: { name: string; status: string }[];
      slashCommands?: string[];
      skills?: string[];
      agents?: string[];
      plugins?: { name: string; path: string }[];
      /**
       * Cluster G Phase 2b (UI-A3): 1 iff this session was created under
       * MOCK runtime mode. Per-session truth — the global runtime flag is
       * carried on the `settings.mockMode` field, but each session row
       * locks its own `mock` value at creation (a session created in mock
       * stays mock even after a live restart).
       *
       * Surfaced so the in-chat ChatHeader `MockBadge` (mounted after the
       * ModelChip) can fire when the operator opens a historical mock
       * session under a now-live process. Optional for forward-compat —
       * pre-G2 servers omit; the mount predicate uses strict `=== true`
       * so undefined and false both render nothing.
       */
      mock?: boolean;
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
      /**
       * Cluster F Phase A1b (UI-A1): the SDK's `result.num_turns` echoed
       * verbatim so the client can render a "turns used / cap" chip and the
       * MaxTurnsResultCard can name the exact count that hit the cap.
       * Optional — older servers omit; older clients ignore.
       */
      numTurns?: number;
      /**
       * Cluster F Phase A1b (UI-A1): the `maxTurns` value the server actually
       * passed to the SDK for this turn (post-resolver). Snapshotted into
       * the envelope so the MaxTurnsResultCard can compute Extend +N
       * without re-querying the settings store (which may have changed
       * mid-turn). The 80% warn chip uses it as the denominator. Optional
       * for forward-compat.
       */
      effectiveMaxTurns?: number;
    }
  | {
      type: 'settings';
      /** Stored workspace root from the DB. `null` means the user hasn't set one yet. */
      workspaceRoot: string | null;
      /** True iff the *resolved* workspace root (stored OR default fallback) exists. */
      workspaceRootValid: boolean;
      defaultWorkspaceRoot: string;
      /**
       * Cluster E Phase 3 (A4): provenance of `defaultWorkspaceRoot` so the
       * UI can attribute the fallback path. `'env'` means the `WORKSPACE_ROOT`
       * environment variable was set at server boot; `'builtin'` means the
       * server fell back to the hard-coded `~/agents`. Optional for
       * forward-compat — older clients ignore it.
       *
       * Surfaced in the SettingsModal's "(default fallback)" annotation and
       * in the empty-state copy so the operator can see whether their stray
       * `WORKSPACE_ROOT=...` export in the shell is leaking through.
       */
      defaultWorkspaceRootSource?: 'env' | 'builtin';
      /** Resolved default hop budget (DB setting > `CEBAB_HOP_BUDGET` env >
       *  built-in `DEFAULT_HOP_BUDGET`). Always present; the Settings modal
       *  seeds its input from this value. */
      defaultHopBudget: number;
      /**
       * Cluster F Phase A1a (UI-A1): resolved default MAX_TURNS for
       * single-agent runs. Precedence mirrors `defaultHopBudget`:
       * DB setting (`max_turns`) > `MAX_TURNS` env > built-in `50`.
       * Optional for forward-compat — older clients ignore the field
       * and continue running unaware that a default exists.
       *
       * Surfaced by the F-A1b SettingsModal numeric input + by the
       * future DraftView Advanced expander. Per-turn override on
       * `send_message.maxTurns` (also added in F-A1a) takes precedence
       * over this value for the in-flight turn.
       */
      defaultMaxTurns?: number;
      /**
       * Cluster G Phase 1 (A3): MOCK runtime mode. `true` iff the server
       * was launched with `MOCK=1` (read once at boot from `process.env`;
       * the flag does not flip mid-process — see R-G2). Surfaced on every
       * `settings` emission so the client doesn't need to side-channel a
       * separate query.
       *
       * Optional for forward-compat — older clients ignore it; the
       * (deferred) MockBadge UI host treats `undefined` as `false`.
       *
       * The audit-tag dimension (`safety_audit.mode='mock'|'live'`) is the
       * forensics counterpart of this UI signal; the spec requires both —
       * visual presence in 4 surfaces + persisted audit tag — because a
       * misconfigured demo identical to a real session in scrollback is
       * the failure mode this guards against.
       */
      mockMode?: boolean;
      /**
       * Optional name of the default MOCK fixture replayed when no
       * per-session fixture is specified. Reserved for forward-compat —
       * the runner doesn't read it yet (`runner/mock.ts` derives its
       * fixture from per-session metadata); broadcasting it now means
       * future "which replay am I watching" UI doesn't need a new
       * settings round-trip.
       */
      mockFixture?: string;
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
      /**
       * Cluster G Phase 2c (UI-A3): true iff this bus session was created
       * under MOCK runtime mode (`multi_agent_sessions.mock = 1`). Mirrors
       * the per-session truth that single-agent `session_started.mock`
       * carries — locked at CREATE time, so a session started in MOCK keeps
       * the badge even after the operator restarts Cebab in live mode.
       *
       * Surfaced so the multi-agent `TopRunBar` and `MultiAgentActivityBar`
       * mount their `<MockBadge variant="inline" />` chips. The mount
       * predicate uses strict `=== true` so pre-G2c servers (omit) and
       * live sessions (omit on the wire — additive-optional contract)
       * both render nothing.
       */
      mock?: boolean;
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
       * Cluster D Phase 5 (spec §6.4 / BE-D22, BE-D23): reply to
       * `archive_session`. Carries the flipped `sessionId` so the client
       * reducer can drop the matching `iterations` cache entry without a
       * second `list_iterations` round-trip, and `removedArtifacts` to
       * confirm whether disk wipe was actually executed (the operator
       * asked for `removeArtifacts: true` AND the folder existed and
       * was deletable).
       *
       * Always fires on a successful archive — including the idempotent
       * "already archived" case (the client treats both the same: drop
       * from cache). Failures (running session, unknown id) come back as
       * `wrapper_error` instead, never this envelope.
       *
       * Forward-compat note: when reopen/unarchive lands in Phase 5b,
       * the unarchive surface will get its own paired ServerMsg
       * (`iteration_unarchived`) — these stay distinct so a single
       * dispatch table entry can't mishandle one as the other.
       */
      type: 'iteration_archived';
      sessionId: string;
      /** True iff the per-session folder was actually rm-rf'd. */
      removedArtifacts: boolean;
    }
  | {
      /**
       * Cluster D Phase 5b (spec §6.3): reply to `reopen_session`. Carries
       * a workspace diff for the operator to acknowledge — Phase 5c's
       * ReopenSessionModal renders the changes + gates the "Reopen"
       * button behind a typed confirmation when `workspaceDiff.filesChanged > 0`
       * (BE-D21).
       *
       * The `workspaceDiff` is computed from a `git status --porcelain`
       * over the resolved participant's project path; when the path
       * isn't a git repo OR git isn't on PATH, `fullDiffAvailable: false`
       * is set and the counts are 0. The modal handles that as "we
       * couldn't enumerate changes — assume the worst and require typed
       * confirmation" (spec OQ resolution: prefer safe-by-default over
       * silently-disabled gate).
       *
       * Sample paths are capped at 10 (per spec §6.3) so a noisy
       * workspace can't blow up the envelope size.
       */
      type: 'reopen_session_confirm_required';
      sessionId: string;
      /**
       * The path the diff was computed against — surfaced so the modal
       * can show "comparing against <path>" and the operator isn't
       * confused if multi-participant sessions trail other workspaces.
       */
      projectPath: string;
      workspaceDiff: WorkspaceDiff;
    }
  | {
      /**
       * Cluster D Phase 5b (spec §6.3): reply when `reopen_session`
       * can't even ship the diff — the request is rejected up-front
       * (unknown id, still-running, no resolvable participant). Distinct
       * from `wrapper_error` so the modal can render a specific message
       * + dismiss itself cleanly instead of falling through to the
       * generic error toast surface.
       *
       * `reason` is a narrow enumeration so the client can switch over
       * it for tailored copy without parsing free text.
       */
      type: 'reopen_session_failed';
      sessionId: string;
      reason: ReopenSessionFailureReason;
      /** Human-readable explanation; copy hint for the modal. */
      message: string;
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
       * `ws/translate.ts`. The per-session RateLimitBanner (Cluster D Phase
       * 4c) renders the countdown; the operator-facing toast is fanned out
       * separately as a `notification` envelope by the dispatcher.
       *
       * Cluster D Phase 4a extensions (spec §4.1):
       *   - `resetsAtMs` is the converted wall-clock-ms timestamp. The
       *     SDK's raw `resetsAt` is in **seconds** (not ms — a real-world
       *     bite-back spec §4.1 explicitly calls out). The translator
       *     multiplies by 1000 at the boundary so every consumer can
       *     compare against `Date.now()` without conversion. The legacy
       *     `resetsAt` field is preserved as raw-from-SDK seconds for
       *     forward-compat and back-fill; new consumers should prefer
       *     `resetsAtMs`.
       *   - `overageStatus` / `overageResetsAtMs` / `isUsingOverage`
       *     capture the SDK's overage-pool fields so the banner can
       *     distinguish "hard limit hit but overage available" from
       *     "fully exhausted".
       *
       * Status vocabulary (spec §4.1): `'allowed' | 'approaching' | 'hard'`.
       * Kept as `string` here for forward-compat with future SDK enum
       * additions; the translator passes through whatever the SDK ships.
       */
      type: 'rate_limit_event';
      sessionId: string;
      /** Spec §4.1: `'allowed' | 'approaching' | 'hard'` (string for fwd-compat). */
      status?: string;
      /** RAW from SDK (seconds since epoch). Prefer `resetsAtMs` in new code. */
      resetsAt?: number;
      /** Cluster D Phase 4a: SDK seconds × 1000. Use this for countdowns. */
      resetsAtMs?: number;
      /** SDK's discriminator, e.g. `'five_hour' | 'weekly' | 'subscription'`. */
      rateLimitType?: string;
      /** SDK overage-pool status, e.g. `'allowed' | 'exceeded'`. */
      overageStatus?: string;
      /** SDK seconds × 1000 for overage reset. */
      overageResetsAtMs?: number;
      /** True iff the SDK reports the turn is consuming overage budget. */
      isUsingOverage?: boolean;
      /** Raw payload from the SDK for forward-compat. */
      payload: unknown;
    }
  | {
      /**
       * Cluster D Phase 4a (spec §4.2): emitted before each backoff sleep
       * when an SDK turn is being auto-retried. Two reason codes:
       *
       *   - `'transient_overload'` — bus turns retrying 529/Overloaded
       *     (replaces the existing `console.warn` at `bus/runner.ts`).
       *   - `'rate_limit_hard'` — single-agent auto-retry after a hard
       *     rate_limit_event (Phase 4b adds the source site; Phase 4a
       *     forward-declares the reason code).
       *
       * The accompanying `recovery_log` row (`failureClass:'rate_limit'` or
       * `'other'`, `operatorAction:'auto_retry'`) is the durable record
       * — `auto_retry` is a live WS signal for the operator-facing banner
       * (it lets the countdown UI show "attempt 3 of 5" without waiting
       * for the next SDK message). One `auto_retry` ⇄ one recovery_log
       * row written by the same emit site.
       *
       * `[security]` BE-D7: the emit site MUST pin retries to
       * `isTransientOverload(err)` (bus) or `wrapperKind === 'rate_limited'`
       * (single-agent) — never to a generic catch-all — so a malformed
       * tool call or an OAuth failure does not silently spin up a retry
       * loop that exhausts the SDK quota.
       */
      type: 'auto_retry';
      sessionId: string;
      /** 1-indexed; the attempt about to fire. */
      attempt: number;
      /** Inclusive of the attempt that already failed plus all retries. */
      maxAttempts: number;
      /** Delay before the next attempt fires, in ms. */
      backoffMs: number;
      reason: 'transient_overload' | 'rate_limit_hard';
      /** Wall-clock ms when the retry will fire (`Date.now() + backoffMs`). */
      retryAt: number;
      /** Optional sub-agent identifier (bus participant name); omitted in
       * the single-agent case where the session id is sufficient. */
      agentName?: string;
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
       * Cluster G Phase 3 (G1): snapshot of in-flight runs spending tokens
       * for THIS Cebab process — surfaced so the sidebar `RunsBadge` /
       * dropdown can show "▶ N active" without the operator scrolling the
       * ProjectList.
       *
       * Emitted on:
       *   - WS attach (initial snapshot, even if `runs` is empty so the
       *     client clears stale state from a prior connection).
       *   - 200ms-debounced after any add/remove in `runner/lifecycle.ts`'s
       *     in-flight registry (collapses bursts during chain hops).
       *   - 10s heartbeat (catches the rare desync where a listener was
       *     dropped or a meta-less query is the only inhabitant).
       *
       * Cross-tab: per-connection in v1 — each WS Conn gets its own
       * snapshot. Cluster A §5's broadcast plan moves this to fan-out in
       * v1.1 multi-window.
       *
       * Persistence: none. The registry is in-memory; a Cebab restart
       * empties it (and the bus reconstruction path doesn't re-register the
       * recovered sessions until the operator clicks Continue). The
       * envelope is purely a real-time signal.
       */
      type: 'active_runs';
      runs: Array<{
        /**
         * The OPERATOR-facing session id (single-agent's `session.id` or
         * `multi_agent_sessions.id`), NOT the per-hop CLI session that the
         * bus participant happens to be on. The client uses this to dedupe
         * and to wire the "[Jump to session]" row action.
         */
        sessionId: string;
        /**
         * Optional: the project the run is rooted in. Single-agent always
         * has this; bus-worker has it when the runner thread can resolve
         * the participant's project. Absent for runs that don't yet have a
         * resolved project (rare; defensive).
         */
        projectId?: number;
        /**
         * Optional: cache of the project name at WS emit time so the
         * dropdown can render without a second round-trip. Computed
         * server-side from `projects.name` keyed by `projectId`.
         */
        projectName?: string;
        /**
         * `'single'` for a single-agent runOneTurn; `'bus-worker'` for any
         * bus participant per-hop query; `'orchestrator'` is reserved for
         * the orchestrator's own per-hop query when the runner site is
         * refined to distinguish it (Phase 4 work; the protocol carries
         * the slot now so the client doesn't need a re-handshake later).
         */
        kind: 'single' | 'bus-worker' | 'orchestrator';
        /** Wall-clock ms when the query was registered. */
        startedAt: number;
        /**
         * Server-computed elapsed-since-startedAt at emit time. Sent so
         * the UI can render the initial "running for Ns" without a clock
         * skew between server and browser. The client's countdown ticker
         * then advances from this value using its own clock.
         */
        elapsedMs: number;
        /**
         * Multi-agent only: the currently-active participant's bus slug,
         * when known. Absent for single-agent runs and for bus runs where
         * the active agent hasn't been resolved yet (between hops).
         */
        activeAgentName?: string;
        /**
         * Reserved for v1.x: short label for the in-flight tool call (e.g.
         * `"Read(README.md)"`). Currently always absent — the snapshot is
         * coarse-grained per-run, not per-tool. The slot is in the
         * protocol so a future tap on `agent_activity` can populate it
         * without a client re-handshake.
         */
        currentActivity?: string;
      }>;
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
    }
  | {
      /**
       * Cluster B Phase 3 (BE-B3): reply to `get_project_authority`. Carries
       * the resolved snapshot — effective tools + MCP servers + allow/deny
       * attribution + env-injection detection + hooks — or `null` if the
       * project has never started a session in this WS connection (cache
       * miss) and probe is not implemented yet.
       *
       * Per critical/B-authority-transparency.md §3 (load-bearing invariant
       * #1: declared ≠ effective): the resolver merges the cached SDK
       * `session_started` snapshot (= effective state at runner boundary)
       * with file-read scans of `.claude/settings*.json` (= declared
       * provenance). The two sources are clearly tagged in the response so
       * the AuthorityPanel (Phase 6+) can render "Effective" as the primary
       * column with `▾ configured sources` disclosure (UI-B4 / §6.4).
       */
      type: 'project_authority';
      projectId: number;
      authority: ProjectAuthority | null;
    }
  | {
      /**
       * Cluster B Phase 4 (§4.4): TOFU spawn-gate ServerMsg. Fires BEFORE
       * an MCP binary spawns when the resolver finds an unfamiliar server
       * (`first_seen`) or a previously-pinned server whose binary sha
       * changed (`hash_changed`). The client opens a Trust-this-server
       * modal; the operator's `mcp_trust_decision` reply with the matching
       * `pendingId` releases the block (trust / trust_pinned) or rejects
       * it (deny_once / deny_remember).
       *
       * Phase 4a ships the protocol but does not yet emit this message —
       * Phase 4b wires the gate into the start-session paths (after
       * project-authority resolution finds untrusted declared MCPs).
       * Until then this discriminant is reserved + reducer-exhausted.
       *
       * `binarySha` is absent for unresolvable targets (e.g. `npx <name>`,
       * bare commands without an absolute path). In that case the client's
       * Trust-pinned-hash affordance must be greyed out — a pinned hash on
       * a target whose hash isn't computable is meaningless.
       *
       * `previousSha` is set only when `reason === 'hash_changed'`; the
       * operator needs both the old and new hashes to decide whether the
       * change looks like a legitimate upgrade.
       */
      type: 'mcp_auto_install_pending';
      pendingId: string;
      serverName: string;
      originPath: string;
      command: string;
      args?: string[];
      binarySha?: string;
      reason: 'first_seen' | 'hash_changed';
      previousSha?: string;
    }
  | {
      /**
       * Cluster B Phase 5 (§4.5): env-injection start-gate ServerMsg. Fires
       * BEFORE pickRunner / startSession when the resolver detects any
       * credential-class env var declared in the project's `.claude/
       * settings*.json` `env:` block (returned by `detectEnvInjections`).
       *
       * Why it matters: `subscriptionOnlyEnv()` strips `ANTHROPIC_API_KEY` +
       * friends from `process.env` so a stray shell export can't redirect
       * the operator through paid billing. But the SDK separately layers in
       * `env:` from settings.json for trusted projects, and that
       * re-injection bypasses the scrub. The gate makes the bypass visible
       * + audited before a single token-using turn fires.
       *
       * Discharge contract: the client opens a modal with `[Refuse & edit]`
       * focused by default + a typed-acknowledgment field. The operator's
       * `acknowledge_and_start` reply with `typedAcknowledgment === 'inject'`
       * (case-sensitive, server-validated) releases the parked spawn. A
       * `safety_audit` row lands on every override.
       *
       * `detectedInjections` repeats the resolver's `EnvInjection[]` so the
       * modal can render the per-key posture without a second round-trip.
       * BE-B12 [security]: the wire never carries env *values* — only key
       * names, scope, source path, posture hint, and `isSet`.
       *
       * `projectId` is set so the client can correlate the gate with the
       * specific project (a chain run may park multiple `session_start_gated`
       * envelopes in flight, one per participant project with injections).
       */
      type: 'session_start_gated';
      pendingStartId: string;
      projectId: number;
      reason: 'env_injection_detected';
      detectedInjections: EnvInjection[];
    }
  | {
      /**
       * Cluster D Phase 6b: server successfully spawned `claude login`.
       * Sent once at the start of the flow. The `runId` is an opaque
       * uuid the client uses to correlate subsequent `auth_refresh_
       * output` and `auth_refresh_completed` envelopes — and to pass
       * to `cancel_auth_refresh` if the operator clicks Cancel.
       *
       * `pid` is informational only (operator may want to inspect it
       * via `ps`). The client should not use it for any flow control.
       */
      type: 'auth_refresh_started';
      runId: string;
      pid: number;
    }
  | {
      /**
       * Cluster D Phase 6b: a chunk of output from the running
       * `claude login` subprocess. `stream` distinguishes stdout vs
       * stderr so the modal can colorize accordingly (`claude login`
       * prints the auth URL to stdout; warnings/errors to stderr).
       *
       * `text` is the raw chunk as received from the pipe (already
       * decoded as UTF-8). Multiple envelopes per logical line are
       * possible — the modal should concatenate and let line wrapping
       * happen naturally in the terminal-style display.
       */
      type: 'auth_refresh_output';
      runId: string;
      stream: 'stdout' | 'stderr';
      text: string;
    }
  | {
      /**
       * Cluster D Phase 6b: `claude login` subprocess exited.
       *
       * `success: true` means `exitCode === 0` — credentials were
       * (presumably) written; the operator's next session_started
       * should clear the AuthExpiredBanner's slice.
       *
       * `success: false` covers: non-zero exit code (auth failed or
       * cancelled by user), operator-initiated cancel (`cancel_auth_
       * refresh` ClientMsg), or timeout (5 min default — long enough
       * for the operator to complete OAuth in their browser).
       *
       * `exitCode` is null when the subprocess was killed before
       * exiting normally (cancel or timeout).
       */
      type: 'auth_refresh_completed';
      runId: string;
      exitCode: number | null;
      success: boolean;
    }
  | {
      /**
       * Cluster D Phase 6b: `start_auth_refresh` failed before a
       * subprocess could be spawned. The reason discriminates:
       *
       *   - `'already_running'` — another `claude login` is in
       *     flight. `existingRunId` is set so the client can re-
       *     attach its modal to the existing run if it has lost the
       *     prior `auth_refresh_started` envelope (e.g. tab reload).
       *   - `'spawn_failed'` — the OS rejected the spawn (binary
       *     not found, permission denied, etc.). `error` carries
       *     the Node `child_process` error message verbatim.
       */
      type: 'auth_refresh_failed';
      reason: 'already_running' | 'spawn_failed';
      existingRunId?: string;
      error?: string;
    }
  | {
      /**
       * Cluster D Phase 8a (spec §8.5): reply to `get_recovery_log_snapshot`.
       * Composes the three named regression-gate queries + the recent
       * activity log into one envelope so the Phase 8b inspector renders
       * the full panel without a second round-trip.
       *
       * `aggregates` — one entry per failure_class observed; classes that
       * have never been recorded are absent (callers render a "no data
       * yet" placeholder rather than 0). `count` includes still-running
       * rows; `reachedFinalRate` excludes them from BOTH numerator and
       * denominator.
       *
       * `sweepReopenRate` — null when no `failure_class='sweep'` rows
       * exist. `rate` is `reopens / sweeps`; `sweeps` is the absolute
       * denominator so the UI can show "47% reopened (×6 of ×13)".
       *
       * `authResumeChoiceRatio` — null when no `failure_class='auth_expired'`
       * rows exist. Phase 6 doesn't yet write these (the in-session resume
       * path is wired Phase 6+ but operator_action='in_session_resume' is
       * not emitted today); the field is reserved + always-present so the
       * Phase 8b inspector can render the placeholder uniformly.
       *
       * `recent` — newest-first, capped at the request's `recentLimit`
       * (server-clamped to [1, 100]; defaults to 100). Includes every
       * column the inspector renders: failure class, operator action,
       * outcome, time-to-recovery, session lineage, operator id.
       *
       * Always succeeds — the table is local SQLite and read errors
       * surface as `wrapper_error` instead.
       */
      type: 'recovery_log_snapshot';
      aggregates: RecoveryClassAggregate[];
      sweepReopenRate: { rate: number; sweeps: number } | null;
      authResumeChoiceRatio: {
        inSessionRate: number;
        inSession: number;
        newSession: number;
      } | null;
      recent: RecoveryLogEntry[];
    }
  | {
      /**
       * Cluster C Phase 4g4: reply to `get_kick_forensics`. Found+snapshot
       * shape so the modal can distinguish "no bundle yet — try again" from
       * "bundle empty/error — show the meta + snapshotFailedReason".
       *
       * When `found: false`, the modal renders a placeholder with the
       * requested (sessionId, agentSlug) and a hint that capture may still
       * be in flight or the row was never persisted.
       *
       * No auth gate — local-operator forensics.
       */
      type: 'kick_forensics_snapshot';
      sessionId: string;
      agentSlug: string;
      found: boolean;
      snapshot: KickForensicsSnapshot | null;
    }
  | {
      /**
       * Cluster C Phase 1 (spec §4.5): server acknowledgment that the
       * operator's `interrupt` ClientMsg was processed and the runner's
       * cancellation handle resolved. Fired AFTER `runner.interrupt()`
       * (or the fallback `ac.abort()`) returns; carries the elapsed
       * delta so the client can render a precise "Stopped (in 42ms)"
       * marker rather than guessing from the absence of a `result`.
       *
       * Why a separate envelope (not just `session_running { running:
       * false }`): the running-false signal fires for every turn
       * terminal — natural completion, crash, AND operator stop — so
       * the UI can't distinguish "I asked for this" from "it finished
       * on its own" without a heuristic. This envelope lets the toast
       * + scrollback marker render "Stopped by you" verbatim.
       *
       * Always paired with a subsequent `session_running { running:
       * false }`; the order is: `session_interrupted` first (when the
       * runner's cancel resolves) → `session_running { running: false }`
       * (when the runOneTurn loop's `finally` cleanup runs). A client
       * that misses one and sees the other is safe — both indicate
       * the turn is terminating.
       *
       * No `session.stopped` safety_audit dual-write yet (Phase C3
       * wires that with the full forensic bundle). Phase C2 added the
       * `interruptAckId` so the operator's free-eval reason
       * (`stop_reason` ClientMsg) can bind unambiguously to THIS stop;
       * a late reason from a previous stop won't be applied to the
       * wrong audit row when the dual-write lands. C2 records the
       * reason as a standalone safety_audit row keyed by this id; C3
       * converts it to an addendum to the parent stop row.
       */
      type: 'session_interrupted';
      sessionId: string;
      /** Milliseconds from interrupt handler entry to runner.interrupt() resolution. */
      ackLatencyMs: number;
      /**
       * Cluster C Phase 2 (spec §4.5): server-generated UUID that
       * uniquely identifies this specific Stop. The companion
       * `stop_reason` ClientMsg echoes it back so late reasons (the
       * operator clicked Skip then changed their mind 30s later)
       * can't bind to a different Stop. The server tracks the latest
       * id per session in `Conn.lastInterruptIds` and rejects
       * `stop_reason` messages with a mismatched id.
       */
      interruptAckId: string;
    }
  /**
   * Cluster C Phase 4a (Part 2 backend foundation, spec §5.7 + §5.9):
   * state-change echoes for the per-agent control verbs. One envelope
   * per verb so the client reducer (Phase 4d) can dispatch on `type`
   * without unpacking a union sub-tag. Server emits AFTER the
   * per_agent_control DB write succeeds AND after the safety_audit
   * dual-write (Phase 4b's handler order); the client treats the echo
   * as the canonical "this state is now true" signal and reconciles
   * any optimistic flip.
   *
   * `actor` field is a forward-compat hook (always 'operator' in v1).
   * Multi-operator forensics (XCT-1) reads it for "who muted X?" but
   * the wire shape doesn't need a separate enum yet.
   */
  | {
      type: 'participant_mute_changed';
      sessionId: string;
      projectId: number;
      muted: boolean;
      reasonCode: ControlReasonCode;
      reasonText?: string;
      actor: 'operator';
      /** Server epoch ms of the state flip. */
      ts: number;
    }
  | {
      type: 'participant_pause_changed';
      sessionId: string;
      projectId: number;
      /** Absolute epoch ms when auto-expiry will fire; null for resume. */
      pausedUntil: number | null;
      /** Action to fire on expiry when paused; null on resume. */
      expiryAction: PauseExpiryAction | null;
      reasonCode: ControlReasonCode;
      reasonText?: string;
      actor: 'operator';
      ts: number;
      /**
       * Cluster C Phase 4c (spec AE-5 [security]): observability for the
       * pause-queue growth signal. Count of `deliverTurn` calls the agent
       * has queued but not yet started — includes both the queue parked
       * behind the pause gate and the queue behind a slow in-flight turn.
       * Operator's mental model is "how many calls are stuck behind this
       * agent right now"; the spec calls this out as a security signal
       * because unbounded queue growth on a paused agent is the
       * "operator forgot they paused this" failure mode.
       */
      queuedDeliveries: number;
    }
  | {
      type: 'participant_kicked';
      sessionId: string;
      projectId: number;
      mode: KickMode;
      reasonCode: ControlReasonCode;
      reasonText?: string;
      actor: 'operator';
      ts: number;
    };

/**
 * Cluster B Phase 3 (BE-B1 / §4.2): per-tool view used by the AuthorityPanel
 * to show effective tool availability with provenance.
 *
 * `source` distinguishes the three plug-in points:
 *   - 'builtin'        — Cebab/SDK-supplied (Bash, Read, Edit, etc.)
 *   - 'mcp'            — exposed via an MCP server; `mcpServer` names the
 *                        owner so a `needs-auth` server can cascade
 *                        effectively-unavailable into its tools (BE-B6).
 *   - 'cebab-injected' — bus_send and any other in-process MCP Cebab pins
 *                        per-agent (`server/src/bus/runner.ts`).
 *
 * `rulingScope` is the WIN of the allow/deny merge — the layer whose entry
 * decided this tool's `allowed`/`denied` flags. `'default'` means no
 * explicit allow OR deny rule matched, so the SDK applied its built-in
 * fallback. Catches the agentic-reviewer §6.4 divergence "tool denied by
 * SDK not in any visible deny list" — that's the rulingScope=default + denied
 * case the inspector flags.
 *
 * `calledCount` / `deniedCount` are populated by the v1.x usage-diff
 * pipeline (spec §4.8); Phase 3 leaves them undefined. The 3-column
 * "Used vs Available vs Attempted-but-denied" view lands in Phase 10.
 */
export type ToolView = {
  name: string;
  source: 'builtin' | 'mcp' | 'cebab-injected';
  mcpServer?: string;
  allowed: boolean;
  denied: boolean;
  rulingScope: 'user' | 'project' | 'local' | 'default';
  calledCount?: number;
  deniedCount?: number;
};

/**
 * Cluster B Phase 3 (BE-B5 / §4.2): MCP server view in the AuthorityPanel.
 *
 * `scope` attributes which `settings*.json` layer declared the server (Cebab
 * applies project > local > user precedence; see resolver §4.3). The
 * `'cebab-injected'` scope is reserved for the bus_send MCP that Cebab pins
 * per-agent from `bus/runner.ts` — distinct from operator-declared MCPs so
 * the UI can mark it as "Cebab-managed, not editable here".
 *
 * `status` is the SDK's `mcp_servers[i].status` string verbatim
 * (`'connected' | 'needs-auth' | 'failed' | 'disabled' | 'unknown'` in the
 * current SDK; we accept any string for forward-compat with new SDK
 * statuses — the AuthorityPanel renders unknown statuses as "unknown" per
 * UI-B15). When `status: 'needs-auth'`, the SDK refuses to call the
 * server's tools — Phase 3's `resolveToolAuthority` cascades that into
 * `ToolView.allowed = false` for any `mcp__<name>__*` tool (BE-B6).
 *
 * `trust`, `binarySha`, `firstSeenAt`, `lastSeenAt` are TOFU plumbing
 * resolved against the `mcp_trust` table (migration 016). Phase 3 marks
 * everything `trust: 'unknown'` because the gate isn't wired yet; Phase 4
 * fills them in by JOIN against `mcp_trust`. Leaving the fields here in
 * Phase 3 means Phase 4 is a pure server-side change — no protocol churn.
 */
export type McpServerView = {
  name: string;
  status: string;
  scope: 'user' | 'project' | 'local' | 'cebab-injected';
  originPath?: string;
  tools: string[];
  config?: {
    command?: string;
    args?: string[];
    /** NAMES only — the spec's BE-B12 [security] invariant: never values. */
    envKeys?: string[];
  };
  trust: 'trusted' | 'pending_tofu' | 'hash_changed' | 'denied' | 'unknown';
  binarySha?: string;
  firstSeenAt?: number;
  lastSeenAt?: number;
};

/**
 * Cluster B Phase 3 (§4.2 + agentic-reviewer §11.1): a single declared
 * hook from any `.claude/settings*.json` layer.
 *
 * Why every project should care: a project-local hook (scope `'local'`)
 * defined in `.claude/settings.local.json` runs with the operator's
 * permissions on every matching SDK event — `PreToolUse` hooks can mutate
 * tool input or refuse the call, `Stop` hooks can spawn arbitrary
 * subprocesses post-session. The inspector lets the operator see what's
 * been pre-wired before committing to a session start (UI-B40 force-expands
 * project-local hooks).
 *
 * `hookKind` is `string` rather than a narrow enum — the SDK declares ~29
 * hook event names (`HOOK_EVENTS` in @anthropic-ai/claude-agent-sdk) and
 * adds more across versions; pinning a narrow union here would force a
 * protocol bump on every SDK upgrade. The AuthorityPanel renders the kind
 * verbatim.
 *
 * `binarySha` is the sha256 of the resolved hook command's binary target
 * (when resolvable; absent for shell-builtin or relative-path commands).
 * Phase 4's TOFU gate JOINs against this same shape for MCP servers.
 */
export type HookView = {
  hookKind: string;
  scope: 'user' | 'project' | 'local';
  scopePath: string;
  command: string;
  args?: string[];
  binarySha?: string;
};

/**
 * Cluster B Phase 3 (§4.2 + §4.5 + E1): a credential-class env key the
 * resolver found declared in any `.claude/settings*.json` layer's `env:`
 * block.
 *
 * Why this exists: `subscriptionOnlyEnv()` in `server/src/runner/claude.ts`
 * strips `ANTHROPIC_API_KEY` + friends from `process.env` so a stray
 * `export` in `~/.zshrc` can't reroute the operator through paid billing —
 * but the SDK separately layers in `env:` from project `settings.json` for
 * trusted projects, and that re-injection bypasses `subscriptionOnlyEnv()`.
 * The detection is the prerequisite for the Phase 5 `session_start_gated`
 * refuse-and-edit flow.
 *
 * BE-B12 [security]: this view carries NAMES + posture hints, NEVER values.
 * `isSet` reflects whether `process.env[envKey]` is currently populated
 * (so the operator can distinguish "declared but unset" from "actively
 * being injected") — but we never expose the value itself, not even as a
 * length or prefix. A screenshot of the AuthorityPanel must not leak the
 * operator's token.
 */
export type EnvInjection = {
  envKey: string;
  scope: 'user' | 'project' | 'local';
  scopePath: string;
  /**
   * Human-readable hint about why this key is credential-class — Phase 3
   * ships a small fixed table ("subscription auth", "bedrock backend",
   * etc.); v1.1 may expand.
   */
  posture: string;
  isSet: boolean;
};

/**
 * Cluster B Phase 3 (BE-B3 / §4.2): the top-level snapshot the
 * AuthorityPanel renders. Merges:
 *   1. Effective state (model, tools, mcp_servers, slash_commands, skills,
 *      agents, plugins) sourced from the cached `session_started` — what
 *      the SDK actually sees at the runner boundary.
 *   2. Declared provenance (allow/deny attribution per scope, env
 *      injections, hooks) sourced from file-read scans of
 *      `.claude/settings*.json`.
 *
 * `capturedAt` is the wall-clock ts of the snapshot; `fromProbe: false`
 * means the cached `session_started` was used as-is (cache mode or Phase 3
 * fall-through), `true` means Phase 3b spawned a fresh probe.
 *
 * `settingSourcesUsed` reflects the SDK's actual `settingSources` for the
 * cached session — trusted projects see `['user', 'project', 'local']`,
 * untrusted see `['user']`. The AuthorityPanel uses this to know which
 * layers it should display (e.g. don't render "project" allow/deny rules
 * for an untrusted project even if a sibling has declared them).
 */
export type ProjectAuthority = {
  projectId: number;
  capturedAt: number;
  fromProbe: boolean;
  model?: string;
  apiKeySource?: string;
  permissionMode?: string;
  cwd?: string;
  settingSourcesUsed: ('user' | 'project' | 'local')[];
  tools: ToolView[];
  mcpServers: McpServerView[];
  slashCommands: string[];
  skills: string[];
  agents: string[];
  plugins: { name: string; path: string }[];
  hooks: HookView[];
  detectedEnvInjections: EnvInjection[];
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
 * Cluster D Phase 5b (spec §6.3): workspace-diff payload carried by
 * `reopen_session_confirm_required`. Surfaces "what's different about
 * this project since the swept session last ran" so the operator can
 * decide whether reopening is safe.
 *
 * Computed server-side via `git status --porcelain` over the resolved
 * participant's project path; non-git repos OR missing git get
 * `fullDiffAvailable: false` + zeroed counts. The modal interprets
 * `!fullDiffAvailable` as "we couldn't enumerate — require typed
 * confirmation anyway" (safe-by-default).
 *
 * `sampleChanges` is capped at 10 paths to keep the envelope bounded;
 * the operator can `cd` to `projectPath` for the full diff if needed.
 */
export type WorkspaceDiff = {
  /** Modified-since-HEAD file count (M, A, D, R, etc. in porcelain output). */
  filesChanged: number;
  /** Added (untracked or staged-as-added). */
  filesAdded: number;
  /** Deleted (D in porcelain). */
  filesDeleted: number;
  /** Up to 10 file paths from the porcelain output, useful for "looks like…". */
  sampleChanges: string[];
  /** False when we couldn't run git in this path; counts are 0 in that case. */
  fullDiffAvailable: boolean;
};

/**
 * Cluster D Phase 5b: enumerated reason codes for `reopen_session_failed`.
 * Kept narrow so the modal's switch over them stays exhaustive (the union
 * doubles as the client-side i18n key). New reasons must add a matching
 * UI branch.
 */
export type ReopenSessionFailureReason =
  | 'not_found'
  | 'still_running'
  | 'no_participant'
  // Cluster D Phase 5c — `reopen_session_confirmed`-specific reasons:
  /** acknowledgedWorkspaceDiff was missing/false. Modal should re-prompt. */
  | 'ack_required'
  /** typedConfirmation was missing or != 'reopen' when diff required it. */
  | 'typed_confirmation_required'
  /** Chain-mode session whose live handle is gone — R-B is orchestrator-only. */
  | 'chain_reconstruction_unsupported'
  /** R-B reconstruction failed for some other reason (folder missing, etc.). */
  | 'reactivate_failed';

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
  /**
   * Cluster F Phase D5+ (UI-D5+): server-side guardrail-violation
   * verdict, populated when the bus runner's path classifier flagged
   * this mutation as targeting a file outside the agent's project
   * folder. Absent (`undefined`) for in-scope mutations and for rows
   * from pre-021 sessions — the UI reducer treats absence as in-scope
   * and renders no badge.
   *
   * Persisted on the mutation row (`multi_agent_mutations.guardrail_*`)
   * so R-A re-attach / R-B reconstruct surface the badge on past rows.
   * The dispatcher ALSO emits a separate `safety_audit` row + sticky
   * notification per violation — this field on the mutation row is the
   * UI-side render hook, the audit row is the durable forensic
   * record.
   */
  guardrailViolation?: {
    /** Absolute (resolved) path the tool targeted, after relative + ~
     *  expansion against the agent's cwd. Shown verbatim in the badge
     *  tooltip + the safety_audit payload. */
    violatedPath: string;
    /** The agent's cwd at the moment of the mutation (already on
     *  `cwd` above, repeated here so the reducer/UI doesn't need to
     *  read two fields to render the "out of scope: X (cwd was Y)"
     *  message). */
    agentCwd: string | null;
    /** Stable reason code; `'path_outside_cwd'` today (open-ended
     *  TEXT for future sub-cases like `'system_path'` or
     *  `'sibling_project'` without a wire-shape break). */
    reasonCode: string;
  };
  /**
   * Cluster F Phase F3 (UI-F3): for `Bash` mutations, the rule that
   * pinned the category (and the matched fragment that triggered it).
   * Surfaced in the `MutationsDisclosure` badge tooltip so operators
   * can tell *why* the classifier rated a command `mutate` vs
   * `dangerous` — a `git push` looks the same as `git push --force`
   * until you see the `dangerous_subcommand` rule + matched fragment.
   *
   * Absent (`undefined`) for non-Bash mutations (the tool name itself
   * is the rationale: `Write` writes, `Edit` edits) and for rows from
   * pre-022 sessions. The reducer treats absence as "no rationale to
   * surface" and the UI falls back to the existing badge-only render.
   *
   * Persisted on the mutation row (`multi_agent_mutations.classifier_reason_json`)
   * so R-A re-attach / R-B reconstruct surface the same tooltip on
   * past rows; not coupled to safety_audit (the badge is informational,
   * the `mutate`/`dangerous` category alone drives any audit emit).
   */
  classifierReason?: {
    /** Stable rule ID; see `BashClassifierRule` in
     *  `shared/src/mutation.ts`. Kept as `string` on the wire to avoid
     *  a tight coupling — adding a new rule classifier-side ships
     *  without a protocol bump, and old clients render the existing
     *  fallback rather than a TS exhaustiveness error. */
    rule: string;
    /** Operator-readable explanation. Render verbatim. */
    detail: string;
    /** The matched fragment that triggered the rule (the first
     *  dangerous token, the subcommand pair, the redirect target, …). */
    matched: string;
  };
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

/**
 * Cluster D Phase 8a (spec §8.5): enumerated failure_class column for the
 * recovery_log table. Restated on the wire so the Phase 8b client doesn't
 * have to import the server repo to discriminate the categories.
 *
 *   - 'rate_limit'   — upstream rate-limit retry (bus auto or single-agent)
 *   - 'auth_expired' — operator chose to refresh auth then resume / start new
 *   - 'sweep'        — operator archived or reopened a swept iteration
 *   - 'chain_crash'  — chain mode crash that couldn't be reconstructed (Phase 7)
 *   - 'other'        — escape hatch; new writers should bias toward extending
 *                      this union rather than reusing 'other' silently.
 */
export type RecoveryFailureClass =
  | 'rate_limit'
  | 'auth_expired'
  | 'sweep'
  | 'chain_crash'
  | 'other';

/**
 * Cluster D Phase 8a: enumerated operator_action column. Mirrors the
 * server repo's union — see `server/src/repo/recovery_log.ts` for the
 * write-site semantics of each one.
 */
export type RecoveryOperatorAction =
  | 'auto_retry'
  | 'manual_retry'
  | 'new_session'
  | 'in_session_resume'
  | 'archive'
  | 'reopen'
  | 'resume_from_hop'
  | 'abort';

/**
 * Cluster D Phase 8a: nullable outcome column. The row lands with
 * `outcome=null` then later code backfills via `updateRecoveryOutcome`
 * once the session reaches a terminal state. The wire entry carries the
 * null faithfully so the inspector can render "still running" distinct
 * from "we never recorded an outcome".
 */
export type RecoveryOutcomeStatus = 'reached_final' | 'failed_again' | 'still_running';

/**
 * Cluster D Phase 8a: single `recovery_log` row in wire form. CamelCase
 * column names; null preserved where the column is nullable. The Phase 8b
 * inspector renders one of these per row in the activity timeline.
 *
 * `invariantResultsJson` is reserved for Phase 8's invariants pipeline
 * (spec §8.4) and renders as opaque JSON for now; no writer populates it
 * yet so it will typically be null in current snapshots.
 */
export type RecoveryLogEntry = {
  id: number;
  ts: number;
  sessionId: string | null;
  parentSessionId: string | null;
  operatorId: string;
  failureClass: RecoveryFailureClass;
  operatorAction: RecoveryOperatorAction;
  timeToRecoveryMs: number | null;
  outcome: RecoveryOutcomeStatus | null;
  forensicsId: number | null;
  invariantResultsJson: string | null;
};

/**
 * Cluster D Phase 8a: per-failure-class rollup carried by
 * `recovery_log_snapshot`. Mirrors the server-side `ClassAggregate`
 * returned by `repo/recovery_log.aggregateByClass()` so the inspector
 * can render the regression-gate aggregates the spec §8.5 names without
 * doing its own math.
 *
 * `count` includes still-running rows; `reachedFinalRate` and
 * `medianTimeToRecoveryMs` exclude them (the rate denominator is
 * "rows with a non-null outcome"; the median only sees rows with a
 * non-null time-to-recovery). Both inner fields are nullable when the
 * filtered subset is empty.
 */
export type RecoveryClassAggregate = {
  failureClass: RecoveryFailureClass;
  count: number;
  reachedFinalRate: number | null;
  medianTimeToRecoveryMs: number | null;
};

/**
 * Cluster C Phase 4g4 (spec §5.5, §6.4): wire shape for one bus event in
 * the forensic bundle. Mirrors the server-side `MultiAgentBusEvent` from
 * `server/src/notifications/forensic_snapshot.ts` so the KickForensicsModal
 * can render the per-event row without extra mapping.
 *
 * `textPreview` is truncated server-side to 240 chars + ellipsis when
 * longer; clients render verbatim.
 */
export type ForensicBusEvent = {
  id: number;
  ts: number;
  source: string;
  destination: string;
  kind: string;
  textPreview: string;
};

/**
 * Cluster C Phase 4g4: wire shape for one mutation attributed to the
 * agent in the forensic bundle. Mirrors `MultiAgentMutationSummary`.
 *
 * `confirmed` is `true` once the operator clicked through the pause-on-
 * mutation pre-flight (or the session ran with no pre-flight enabled
 * and the mutation auto-confirmed). `filePath` is the affected path
 * when the classifier resolved one.
 */
export type ForensicMutation = {
  id: number;
  ts: number;
  toolName: string;
  category: MutationCategory;
  summary: string;
  filePath: string | null;
  confirmed: boolean;
};

/**
 * Cluster C Phase 4g4: parsed bundle reply for `get_kick_forensics`.
 * Server JSON-parses the persisted columns (`effective_prompt_json`,
 * `events_last_n_json`, `mutation_rationale_json`) so the client
 * doesn't need a parser. NULL-able fields stay nullable on the wire.
 *
 * `kickReasonCode` + `kickReasonText` are joined from the companion
 * `safety_audit` row at fetch time so the modal can render the kick
 * provenance ("kicked: tool_misuse — leaked credential") without a
 * second round-trip. `kickMode` is also joined.
 *
 * `pendingToolCalls`, `activePermissions`, `workdirTreeHash`, and
 * `parentSessionId` are exposed for inspector parity with the single-
 * agent Stop bundle viewer (a future surface); the kick modal renders
 * them only when present (NULL for multi-agent bus kicks today —
 * documented in C4f as out-of-scope for the initial helper).
 *
 * `snapshotFailedReason` is non-null when the capture itself threw
 * (the audit row still exists; the bundle is a "we tried" placeholder).
 * The modal renders an error banner in that case rather than the
 * normal sections.
 */
export type KickForensicsSnapshot = {
  auditId: string;
  ts: number;
  sessionId: string;
  agentSlug: string;
  operatorId: string;
  parentSessionId: string | null;
  kickReasonCode: ControlReasonCode | null;
  kickReasonText: string | null;
  kickMode: KickMode | null;
  effectivePrompt: unknown;
  busEvents: ForensicBusEvent[];
  mutations: ForensicMutation[];
  pendingToolCalls: unknown;
  activePermissions: unknown;
  workdirTreeHash: string | null;
  snapshotFailedReason: string | null;
};
