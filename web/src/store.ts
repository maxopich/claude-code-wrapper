import type {
  AgentActivityPhase,
  ContentBlock,
  ControlReasonCode,
  IterationSummary,
  KickMode,
  MultiAgentEventKind,
  MultiAgentLifecycle,
  MultiAgentMutationView,
  MultiAgentTemplate,
  PauseExpiryAction,
  PendingRetryDescriptor,
  Project,
  RecoveryContextView,
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
  | { kind: 'command_output'; id: string; text: string }
  | {
      kind: 'result';
      id: string;
      subtype: string;
      cost: number;
      result?: string;
      errors?: string[];
      /**
       * Cluster F Phase A1b (UI-A1): the SDK's `result.num_turns` echoed
       * through translate.ts. Populated on every result envelope that
       * isn't a zero-turn synthetic command. Drives the chat-header
       * turn-counter chip ("42 / 50") and the MaxTurnsResultCard's
       * "reached the cap" body copy.
       */
      numTurns?: number;
      /**
       * Cluster F Phase A1b (UI-A1): the server's resolved `maxTurns`
       * for this specific turn (post-precedence). The MaxTurnsResultCard
       * uses it to compute Extend +N targets without re-querying the
       * settings store (the operator might have edited the default
       * between turns). The chat-header chip uses it as the denominator.
       */
      effectiveMaxTurns?: number;
      /**
       * Cluster H B5: wall-clock duration of the turn in milliseconds, taken
       * verbatim from the SDK's `result.duration_ms` (forwarded as
       * `result.durationMs` over the wire at `translate.ts:283`). Rendered
       * in the result-block footer next to subtype + cost so operators can
       * spot slow turns at a glance. Optional — older server payloads omit
       * it and the footer degrades to just `subtype · $cost`.
       */
      durationMs?: number;
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

/**
 * Cluster D Phase 4c (spec §4.1/§4.2/UI-D6/UI-D7): live state for the
 * rate-limit banner. Only present while the session is in a rate-limited
 * state — `undefined` (the absence-of-slice) is the "no banner, no
 * countdown" condition.
 *
 * Per-session because rate-limits are session-scoped: a five-hour cap hits
 * one session, not all of them. Lives on `SessionView` rather than a
 * sibling context because the banner is mounted inside the session-scoped
 * BannerStack (single-agent) or the orchestrator's run view (multi-agent)
 * — both of which already key off the per-session state slice, so a
 * separate context would just split the source of truth.
 *
 * Wire sources that populate this:
 *   - `rate_limit_event { status: 'hard', resetsAtMs, overage* }` → slice
 *     is created with countdown target + overage hints.
 *   - `session_running { status: 'rate_limited' }` → slice is preserved
 *     while the held turn waits.
 *   - `auto_retry { attempt, maxAttempts, backoffMs, retryAt }` → sets
 *     the `autoRetry` sub-field so the operator sees "attempt 2 of 5 in
 *     0:23" inside the banner.
 *
 * Sink that clears this:
 *   - `rate_limit_event { status: 'allowed' }` (the §7-floor "cleared"
 *     sub-code) → clears the slice.
 *   - `session_running { running: false }` with NO `status` field → the
 *     server signals the turn ended cleanly; clears the slice so the
 *     `heldMessages` drain effect can fire (see SessionView.heldMessages).
 *
 * `paused` lives on the client only (spec §4.2 explicitly: "cadence lives
 * on the client" so tab close + reopen doesn't lose pause state to the
 * wrong source of truth). The CountdownChip respects it; a paused
 * countdown still shows the time-until-reset but doesn't auto-fire the
 * `retry_rate_limited { auto: true }`.
 */
export type RateLimitState = {
  /** Wall-clock ms when the rate limit lifts. Drives the CountdownChip. */
  resetsAtMs?: number;
  /** SDK overage-pool reset (separate countdown when overage is in play). */
  overageResetsAtMs?: number;
  /** SDK overage status, e.g. `'allowed' | 'exceeded'`. */
  overageStatus?: string;
  /** True iff the current turn is consuming overage budget. */
  isUsingOverage?: boolean;
  /** Bus auto-retry context, if the server is auto-retrying for us. */
  autoRetry?: {
    attempt: number;
    maxAttempts: number;
    backoffMs: number;
    /** Wall-clock ms when the auto-retry will fire. */
    retryAt: number;
    reason: 'transient_overload' | 'rate_limit_hard';
    agentName?: string;
  };
  /** Operator-toggled auto-retry pause. Manual retry button still works. */
  paused: boolean;
  /** True while a `retry_rate_limited` ClientMsg is in flight (debounce
   *  the button + countdown to avoid double-fires). */
  retryInFlight: boolean;
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
  /**
   * Cluster D Phase 4c (UI-D7): operator messages composed while the
   * session is rate-limited. Capped at 3 per spec §4.2 — the 4th attempt
   * is rejected and the composer shows a "queue full" hint. Drained
   * automatically once `rateLimit` clears AND the session is not running
   * (a drain effect in App.tsx watches both fields and shifts one at a
   * time, sending each via the normal `send_message` / `multi_agent_user_
   * prompt` path).
   *
   * Lives outside `rateLimit` because the queue must survive the moment
   * of clearance: when `rateLimit` becomes `undefined`, the queue stays
   * populated so the drain effect has something to read. Once the drain
   * effect has shipped all items, the queue is empty again.
   */
  heldMessages: string[];
  /**
   * Cluster D Phase 4c: present iff the session has been observed under
   * rate-limit state. Absence ⇔ "no banner, no countdown".
   */
  rateLimit?: RateLimitState;
  /**
   * Cluster C Phase 2 (spec §4.2): metadata for the most recent Stop
   * the operator initiated on this session. Drives the inline
   * "Stopped by you · 42 ms" marker in scrollback + the non-blocking
   * reason-for-stop prompt that follows it. Cleared on the next
   * user_send (operator moved on) and on session_started (fresh
   * session). The `reasonSubmitted` flag flips when the prompt is
   * dismissed (submit OR skip both flip it so the prompt doesn't
   * re-appear after the operator chose not to categorise).
   */
  lastInterrupt?: {
    interruptAckId: string;
    ackLatencyMs: number;
    /** Epoch ms when the session_interrupted ServerMsg landed. */
    ts: number;
    reasonSubmitted: boolean;
  };
  /**
   * Cluster E Phase 1 (E1): SDK-discovered slash commands forwarded on
   * `session_started.slashCommands[]` (Cluster B Phase 2 widened the
   * envelope). Surfaced by `SlashCommandPalette` as the "Discovered
   * from session" group. Undefined means the SDK didn't ship the field
   * (older payloads) — the palette degrades to Cebab-local only.
   */
  slashCommands?: readonly string[];
  /**
   * Cluster E Phase 2 (E2 / B4): the SDK-reported model identifier
   * from the most recent `session_started` for this session. Surfaced
   * by `ModelChip` in the chat header so the operator can tell which
   * model produced a response (Opus vs Sonnet vs Haiku, version
   * bumps). Undefined before the first init lands or when older
   * payloads omit it; the chip renders "model: default" in that case.
   */
  model?: string;
  /**
   * Cluster G Phase 2b (UI-A3): per-session MOCK tag from
   * `session_started.mock` (server side projects from
   * `sessions.mock`). True iff this specific session was created
   * under MOCK runtime mode — survives independently of the global
   * `settings.mockMode` so a historical mock session opened under a
   * now-live process still carries the badge.
   *
   * Undefined while no `session_started` has landed yet AND for pre-G2
   * server payloads that omit the field. The ChatHeader's
   * `MockBadge` mount predicate uses strict `=== true` equality so
   * undefined/false both render nothing.
   */
  mock?: boolean;
};

/** Max number of messages the held-queue accepts before refusing new ones.
 *  Per spec §4.2 (UI-D7). Exported so the composer can compute "queue full"
 *  hints without re-asserting the constant. */
export const HELD_MESSAGES_CAP = 3;

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
  /** Item #7: server-derived recovery snapshot, populated ONLY while
   *  `awaitingContinue` is true (R-B reconstruct, or a pause-on-mutation
   *  banner that survived a Cebab restart). Drives the "▾ Recovery details"
   *  disclosure inside the awaiting-continue banner. Cleared optimistically
   *  on Continue click via `ma_clear_awaiting` — banner-bound lifetime. */
  recoveryContext: RecoveryContextView | null;
  /** Cluster B Phase 6d (D4 / UI-B24/B28): client-side accumulator of
   *  `router_drop` ServerMsgs received during this session. Drives the
   *  `RouterDropsCounter` chip in the activity bar + the `RouterDropsLog`
   *  modal.
   *
   *  The wire `router_drop` envelope (`shared/src/protocol.ts:1168`) has no
   *  timestamp — the orchestrator emits it synchronously with the audit
   *  write, no per-event ts on the wire. We tag the receive-time client-side
   *  for the UI's "N drops in last 60s" regime calibration (UI-B28). The
   *  server's `safety_audit` row IS the authoritative ts; this list is
   *  ephemeral (lost on WS disconnect, not replayed on re-attach — Phase 6d
   *  is best-effort; a future R-A enhancement could rehydrate from the
   *  audit query).
   *
   *  Deduped by `auditRowId` — the only stable id on the wire. */
  routerDrops: RouterDropView[];
  /**
   * Cluster C Phase 4g1: per-participant control state map (mute/pause/kick),
   * keyed by `projectId`. Populated from `participant_mute_changed` /
   * `participant_pause_changed` / `participant_kicked` ServerMsgs the
   * server already emits after the per_agent_control DB write succeeds.
   * The reducer overwrites the per-projectId row on each echo so the map
   * is always "current state" (last-writer-wins), matching how the server
   * treats per_agent_control as the source of truth.
   *
   * Empty `{}` on session start. NOT replayed across WS reconnect today —
   * a future R-A enhancement could push a snapshot. For now, R-B reseeds
   * the SERVER's in-memory mute/kick mirrors (Phase 4e) but the client
   * loses control state on reload; the operator's mental model is "what
   * I see is what's controlled SINCE my socket attached".
   */
  participantControls: Record<number, ParticipantControlView>;
  /**
   * Cluster E Phase 2.x (B4-1): per-participant model identifiers
   * captured from each `session_started` ServerMsg whose `projectId`
   * belongs to this run's participants. Keyed by `projectId`; value is
   * the raw model string from the SDK init.
   *
   * The bus doesn't carry a single "session model" on the wire —
   * each participant (chain hop or orchestrator/worker) runs its own
   * SDK query() with its project's resolved model. This client-side
   * aggregation lets `TopRunBar`'s ModelChip render a sensible
   * summary:
   *   - all values identical → that model
   *   - mixed values → "various"
   *   - empty → undefined → chip falls back to "default"
   *
   * Empty `{}` at session start; entries accumulate as participants'
   * SDK inits arrive. NOT replayed across WS reconnect — same caveat
   * as `participantControls`, the chip lights up once at least one
   * `session_started` lands post-reconnect.
   */
  modelsByProject: Record<number, string>;
  /**
   * Cluster D Phase 4d (B2 / spec §4.2): the bus's most recent in-flight
   * auto-retry attempt. Populated by `auto_retry` ServerMsg fired from
   * `bus/runner.ts`'s `isTransientOverload(err)` branch (see chain.ts +
   * orchestrator.ts wiring at Phase 4a); drives the multi-agent
   * RateLimit/AutoRetry banner.
   *
   * Lives on `MultiAgentRun` (not `SessionView`) because the bus session
   * id is not in `state.sessionToProject` / `sessionsByProject` — bus
   * sessions live in this slice, single-agent sessions in the per-
   * project map. Phase 4c's `SessionView.rateLimit` is the parallel
   * structure for the single-agent path.
   *
   * Observe-only: the bus owns the retry loop. There is no operator
   * "retry now" or "pause" button (those would race the bus). The
   * banner is informational — countdown to next attempt + agent name.
   * Cleared by either:
   *   - a new `auto_retry` arriving (attempt N+1; overwrites)
   *   - the `ma_clear_auto_retry` action (CountdownChip's onElapsed
   *     dispatches it when retryAt is reached — the retry has fired
   *     or is about to, so the banner unmounts; if attempt N+1 also
   *     fails the next auto_retry repopulates this slice)
   */
  autoRetry?: MultiAgentAutoRetry;
  /**
   * Cluster G Phase 2c (UI-A3): true iff this bus session was created
   * under MOCK runtime mode. Mirrors the wire's optional `multi_agent_started.mock`
   * field (locked at CREATE time, server-side projection from
   * `multi_agent_sessions.mock`). When true, the TopRunBar + ActivityBar
   * mount their `<MockBadge variant="inline" />` chips.
   *
   * Optional + strict-equality at the call site: pre-G2c servers omit the
   * field, and the live path's wire envelope also omits (additive-optional
   * contract) — both render nothing.
   */
  mock?: boolean;
};

/** Cluster D Phase 4d: bus auto-retry info (sub-slice of MultiAgentRun).
 *  Wire-mirror of the `auto_retry` ServerMsg minus the redundant
 *  `sessionId` (the run's own id). */
export type MultiAgentAutoRetry = {
  attempt: number;
  maxAttempts: number;
  backoffMs: number;
  /** Wall-clock ms when the retry fires. The CountdownChip ticks down to this. */
  retryAt: number;
  reason: 'transient_overload' | 'rate_limit_hard';
  agentName?: string;
};

/**
 * Cluster B Phase 6d (D4): client-side enriched view of a `router_drop`
 * ServerMsg. Adds `receivedAt` because the wire shape doesn't carry a ts —
 * see `MultiAgentRun.routerDrops` for rationale.
 */
export type RouterDropView = {
  auditRowId: string;
  // Cluster C Phase 4b adds `muted_source`; Phase 4d adds `kicked_source`
  // and `kicked_destination`. Keep this in sync with the server's
  // RouterDropReasonCode in shared/src/protocol.ts. Inline-list rather
  // than `import type` to keep the type fully local for the reducer.
  reasonCode:
    | 'forged_source'
    | 'worker_to_user'
    | 'worker_to_worker'
    | 'unknown_source'
    | 'muted_source'
    | 'kicked_source'
    | 'kicked_destination';
  source: string;
  destination: string;
  kind: string;
  receivedAt: number;
};

/**
 * Cluster C Phase 4g1: per-participant control state aggregated client-side
 * from the `participant_mute_changed` / `participant_pause_changed` /
 * `participant_kicked` ServerMsg envelopes. Keyed by `projectId` because
 * that is what the wire envelopes carry — `MultiAgentRun.participantAgentNames`
 * carries the bus slug per agent, and the consumer (activity bar, draft
 * cards) does the slug↔projectId join via `state.projects` when it wants
 * to render pills for a named agent.
 *
 * Fields mirror the union of state expressible across the three echoes:
 *   - `muted`: latest boolean from `participant_mute_changed`.
 *   - `pausedUntil`: epoch ms when the pause expires; `null` once `pause_changed`
 *     reports `pausedUntil: null` (resume) or once `participant_kicked` lands
 *     (kick supersedes pause).
 *   - `kickedAt`: timestamp once `participant_kicked` lands; never cleared
 *     (there is no "unkick" verb in v1).
 *
 * One row per participant; presence of a row indicates "this participant
 * has had at least one control verb applied this session". Absence means
 * "no controls touched". Selectors (`countControlled`, etc.) MUST treat a
 * row with `muted=false && pausedUntil=null && kickedAt=null` as "clear" —
 * a resume after a pause leaves a row behind with all flags clear.
 */
export type ParticipantControlView = {
  /** Project id this control state belongs to. Matches the projectId on
   *  every `participant_*_changed` envelope. Stored redundantly so a
   *  consumer holding only the value can identify its key. */
  projectId: number;
  /** Latest mute state. `true` while muted, `false` after unmute. */
  muted: boolean;
  /** Reason code from the most recent mute/unmute echo. Surfaces in the
   *  pill tooltip and the (future) detail panel. */
  mutedReasonCode?: ControlReasonCode;
  mutedReasonText?: string;
  /** Wall-clock ms of the last mute/unmute echo. */
  mutedTs?: number;
  /** Absolute epoch ms when the pause auto-expires. `null` when not paused
   *  (initial state or after a resume / kick supersedes). */
  pausedUntil: number | null;
  /** Action that will fire on pause expiry. Matches the wire enum. */
  pauseExpiryAction?: PauseExpiryAction;
  /** Reason code from the most recent pause echo. */
  pauseReasonCode?: ControlReasonCode;
  pauseReasonText?: string;
  /** AE-5 [security]: count of `deliverTurn` calls queued behind the pause
   *  gate. Surfaces "operator forgot they paused this" growth. */
  queuedDeliveries?: number;
  /** Wall-clock ms of the last pause/resume echo. */
  pausedTs?: number;
  /** Set once `participant_kicked` lands; never cleared (no unkick verb). */
  kickedAt: number | null;
  /** Kick mode (drain in v1; hard is forward-compat). */
  kickMode?: KickMode;
  /** Reason code from the kick echo. */
  kickReasonCode?: ControlReasonCode;
  kickReasonText?: string;
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
  /**
   * PR-7: set by `ma_apply_template` to the applied template's id, cleared
   * by any manual draft edit (participant add/remove/reorder, lifecycle
   * flip, ma_dismiss_active). The Start button mirrors this onto the
   * `start_multi_agent` payload's `templateId` so the persisted row knows
   * which template produced it — feeds the "Last run" rail.
   *
   * `null` for ad-hoc runs (operator built the participants list by hand
   * without applying a template).
   */
  draftTemplateId: string | null;
  /**
   * PR-7: set by `ma_apply_template` to the applied template's per-template
   * hop budget (if any), cleared by the same manual-edit signals as
   * `draftTemplateId`. Sent on `start_multi_agent` as `hopBudget` so the
   * router enforces the template's override instead of the global default.
   * `null` when the template doesn't have an override OR when the draft was
   * built by hand.
   */
  draftHopBudget: number | null;
  /**
   * Cluster F Phase D9: provenance of the current `draftHopBudget`.
   *   - `'template'` — populated by `ma_apply_template` from
   *     `template.hopBudget`; the DraftView input shows a
   *     "(from template)" annotation so the operator knows the
   *     value isn't theirs.
   *   - `'user'` — operator typed a value into the DraftView input
   *     (overrides any prior template-sourced value); annotation
   *     hidden so they don't see misleading attribution after they
   *     edited.
   *   - `null` — input is empty; server resolver falls back through
   *     DB setting → CEBAB_HOP_BUDGET → DEFAULT_HOP_BUDGET.
   *
   * Tracked on the store rather than in component state so the
   * provenance survives DraftView remounts (e.g. when tab switching).
   * Reset alongside `draftHopBudget` by the same manual-edit signals.
   */
  draftHopBudgetSource: 'template' | 'user' | null;
};

/**
 * Cluster D Phase 6 (spec §6.4 / UI-D22): top-level slice tracking the
 * "Claude subscription credentials look expired" condition. Populated
 * from `wrapper_error { kind: 'auth_expired' }` arrivals; cleared when
 * a subsequent `session_started` ServerMsg lands (the SDK only emits
 * that after the OAuth handshake succeeds, so it's the cleanest
 * positive-signal "credentials work again" marker).
 *
 * App-wide, not per-session. The subscription is process-level state —
 * if it expires, every session is affected; if it renews (operator
 * runs `claude login` in a terminal), every session is unblocked. The
 * banner mounts in App.tsx outside any session container.
 *
 * `dismissed` is a soft hide: the operator may dismiss the banner to
 * clear visual clutter while they go re-authenticate, but the next
 * `auth_expired` observation re-shows it (the reducer flips it back
 * to false on each populate). The slice itself is only cleared by the
 * positive signal — dismissal is just a visibility toggle.
 */
export type AuthExpiredState = {
  /** ms timestamp of the first auth_expired this process lifetime. */
  firstSeenMs: number;
  /** ms timestamp of the most recent observation. */
  lastSeenMs: number;
  /** How many times observed (each WS-arrived wrapper_error bumps it). */
  count: number;
  /** The wrapper's error message (already a human-readable string). */
  lastMessage: string;
  /** Operator clicked Dismiss on the banner. Reset to false on the
   *  next populate so a fresh failure re-surfaces the banner. */
  dismissed?: boolean;
};

/**
 * Cluster G Phase 3 (G1): a single row of the active-runs snapshot. The
 * wire shape (`shared/src/protocol.ts` → `active_runs` arm) is mirrored
 * 1:1 here so the dropdown can render straight from the slice with no
 * intermediate transform; optional fields stay optional and use the
 * spread-omit pattern from the wire (the reducer never re-introduces
 * `undefined` for absent fields).
 *
 * `elapsedMs` is server-computed at emit time; the dropdown advances it
 * with the browser's wall clock from `startedAt`. That's why we keep
 * `startedAt` even though `elapsedMs` is also present — without it a
 * stale snapshot would show a frozen number.
 */
export type ActiveRunView = {
  sessionId: string;
  projectId?: number;
  projectName?: string;
  kind: 'single' | 'bus-worker' | 'orchestrator';
  startedAt: number;
  elapsedMs: number;
  activeAgentName?: string;
  currentActivity?: string;
};

/**
 * Cluster G E3 UI: app-wide connection-lost slice. Populated when the
 * WS closes without a reopen OR the initial `/auth-token` fetch fails.
 * `ConnectionLostOverlay` mounts iff this slice is defined; the overlay
 * unmounts on a successful `ws_open` (which clears the slice as part of
 * the same reducer step).
 *
 * Per spec §5 E3: "Layout: centered card in main pane, sidebar remains
 * functional." The slice is app-wide (not per-session) because a closed
 * WS means *every* session is unreachable; one overlay covers the
 * scenario.
 *
 * `reason` decides the copy variant the overlay renders; `diagnostic`
 * is the metadata block the "Copy diagnostic" button serialises. Both
 * are kept verbatim across re-renders so the operator's screenshot /
 * paste captures the actual failure rather than a refreshed one.
 */
export type ConnectionLostReasonValue =
  | 'origin_not_allowed'
  | 'host_not_allowed'
  | 'auth_token_invalid'
  | 'session_revoked'
  | 'server_unreachable'
  | 'unknown';

export type ConnectionLostView = {
  reason: ConnectionLostReasonValue;
  /** Metadata captured at the moment of failure — `ts`, optional `url`,
   *  optional `rejectReason` (from `X-Cebab-Reject-Reason` HTTP header
   *  on the 403 response), optional `closeCode` (from WS CloseEvent for
   *  Channel B). Shape mirrors `ConnectionLostDiagnostic` in
   *  `components/connectionLost/connectionLostReason.ts`. */
  diagnostic: {
    ts: number;
    url?: string;
    rejectReason?: string;
    closeCode?: number;
    wasClean?: boolean;
  };
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
  /** Cluster D Phase 6: app-wide auth-expired slice. See AuthExpiredState
   *  JSDoc for the lifecycle. Undefined when no auth lapse has been
   *  observed this process lifetime. */
  authExpired?: AuthExpiredState;
  /**
   * Cluster G Phase 3b (G1 UI): app-wide active-runs snapshot. Sourced
   * entirely from server `active_runs` ServerMsg envelopes — initial
   * snapshot on WS attach, 200ms-debounced after lifecycle mutations,
   * 10s heartbeat. The reducer replaces the array verbatim on each
   * envelope (full snapshot, not incremental), which is also what
   * clears the slice on disconnect (the connection-lost handler
   * resets it to [] alongside `liveSessions`).
   *
   * Default `[]` so the RunsBadge mount predicate (`length > 0`)
   * never sees `undefined`.
   */
  activeRuns: ActiveRunView[];
  /**
   * Cluster G E3 UI: app-wide connection-lost overlay state. Populated
   * by `ws_close` (when the close has actionable diagnostic info) and
   * by the dedicated `connection_lost` action (used from App.tsx's
   * auth-token fetch failure path). Cleared on `ws_open`.
   *
   * Mount predicate is `connectionLost !== undefined`. The overlay
   * itself decides what copy to render based on the `reason`.
   */
  connectionLost?: ConnectionLostView;
  /**
   * Cluster G Phase 4 (D6/D11): per-project timestamp of the most
   * recent `bus_integration_changed { installed: true }` event observed
   * during this WS session. Drives the `BusInstalledBadge` 30-second
   * highlight on the participant row.
   *
   * Anti-pattern guard (per agentic-reviewer): the badge must NOT
   * appear unless a corresponding `bus.trust_decided` audit row exists.
   * The structural guarantee here is that every `bus_integration_changed`
   * with `installed:true` is preceded by the server's
   * `install_trust_gate.ts` writing the audit row — so an entry in this
   * map IS the proof that an audit row exists for that install. A
   * project that was already `bus_installed=1` at page load (e.g. via
   * the migration 024 backfill of pre-gate installs) emits no
   * `bus_integration_changed` event and therefore gets no badge.
   *
   * Cleared on:
   *   - `bus_integration_changed { installed: false }` for that project
   *   - WS disconnect (`ws_close`) — a reconnect starts fresh; we don't
   *     want a stale 31-minute-old timestamp from a prior session to
   *     accidentally highlight on reattach.
   */
  lastBusInstallAt: Record<number, number>;
};

export type SettingsView = {
  workspaceRoot: string | null;
  workspaceRootValid: boolean;
  defaultWorkspaceRoot: string;
  /**
   * Cluster E Phase 3 (A4): provenance of `defaultWorkspaceRoot`. `'env'`
   * = the server resolved it from the `WORKSPACE_ROOT` env var; `'builtin'`
   * = the server fell back to the hard-coded `~/agents`. Undefined for
   * older server payloads (forward-compat).
   */
  defaultWorkspaceRootSource?: 'env' | 'builtin';
  /** Resolved default hop budget (DB > env > built-in). The Settings modal's
   *  input is seeded from this and shows the operator the current effective
   *  value regardless of which precedence step won. */
  defaultHopBudget: number;
  /**
   * Cluster F Phase A1a (UI-A1): resolved default MAX_TURNS for
   * single-agent runs. Precedence mirrors `defaultHopBudget`:
   * DB setting (`max_turns`) > `MAX_TURNS` env > built-in 50.
   * Optional for forward-compat — older servers omit and the F-A1b
   * SettingsModal input falls back to placeholder copy without a
   * known value.
   */
  defaultMaxTurns?: number;
  /**
   * Cluster G Phase 2a (A3): MOCK runtime tag from the server. `true`
   * iff Cebab was launched with `MOCK=1` (fixed at server boot per
   * R-G2). The sidebar-header `MockBadge` mounts when this is true;
   * the (deferred) per-session and TopRunBar mirror chips will key off
   * the per-session `mock` flag instead (a session can predate the
   * current process's MOCK setting).
   *
   * Undefined while no `settings` ServerMsg has landed yet OR when the
   * server is pre-G1 (older payloads omit the field). The badge mount
   * predicate is `mockMode === true` — strict equality so neither
   * undefined nor false renders the chip.
   */
  mockMode?: boolean;
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
  // Cluster D Phase 6: starts undefined; populated when wrapper_error
  // with kind='auth_expired' lands. Cleared on next session_started.
  authExpired: undefined,
  // Cluster G Phase 3b (G1 UI): empty until the first `active_runs`
  // ServerMsg lands (the dispatcher emits one on every WS attach,
  // even when the snapshot is empty, so the badge clears stale state
  // from a prior connection).
  activeRuns: [],
  // Cluster G Phase 4 (D6/D11): empty until the first observed
  // `bus_integration_changed { installed: true }` event in this WS
  // session. See the AppState field's JSDoc for the anti-pattern guard.
  lastBusInstallAt: {},
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
    draftTemplateId: null,
    draftHopBudget: null,
    draftHopBudgetSource: null,
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
  /**
   * Cluster F Phase D9 (D9-1..D9-4): operator sets the hop budget override
   * for the next start. `value === null` clears it (input cleared → server
   * default applies). Action is the only path that flips
   * `draftHopBudgetSource` to `'user'`.
   */
  | { type: 'ma_set_draft_hop_budget'; value: number | null }
  | { type: 'ma_apply_template'; template: MultiAgentTemplate }
  | { type: 'ma_dismiss_active' }
  | { type: 'ma_clear_awaiting' }
  | { type: 'ma_clear_pending_retry' }
  | { type: 'ma_clear_pending_mutation' }
  /** Cluster D Phase 4d: drop the bus auto-retry slice (the CountdownChip's
   *  onElapsed fires this — the retry has fired, banner should unmount.
   *  If attempt N+1 also fails, the next `auto_retry` ServerMsg
   *  repopulates the slice with the fresh countdown). */
  | { type: 'ma_clear_auto_retry' }
  // ---- Cluster D Phase 4c (UI-D7 + spec §4.2) -----------------------------
  // Client-side rate-limit transitions. The server is stateless about retry
  // cadence (per spec rationale: client owns it so pause survives tab close);
  // these actions are the per-pane local edits the banner + composer make.
  /** Composer captured a message while session is rate-limited. */
  | { type: 'rl_enqueue_held'; sessionId: string; text: string }
  /** Drop a single queued message (per spec UI-D7: operator can prune). */
  | { type: 'rl_drop_held'; sessionId: string; index: number }
  /** Pop the head of the queue after the drain effect ws-sent it. */
  | { type: 'rl_drain_one'; sessionId: string }
  /** Toggle auto-retry pause (manual retry still works while paused). */
  | { type: 'rl_set_paused'; sessionId: string; paused: boolean }
  /** Optimistically mark retryInFlight=true on operator/auto click; the
   *  banner uses this to disable the retry button until the next
   *  session_running echo. */
  | { type: 'rl_retry_sent'; sessionId: string }
  /** Cluster D Phase 6: operator clicked Dismiss on the AuthExpiredBanner.
   *  Sets `authExpired.dismissed = true` (the slice stays — count + first/
   *  last timestamps remain useful for tooltips). The next `wrapper_error
   *  { kind: 'auth_expired' }` observation flips dismissed back to false
   *  so a fresh failure re-surfaces the banner. */
  | { type: 'auth_expired_dismissed' }
  /**
   * Cluster C Phase 2: operator submitted OR skipped the reason-for-stop
   * prompt. Either way the prompt should disappear (skip ⇒ ship nothing
   * but the inline UI is dismissed). Flips `lastInterrupt.reasonSubmitted`
   * to true. The full `lastInterrupt` slice is cleared on next user_send
   * / session_started; this action just removes the prompt without
   * losing the marker metadata (the "■ Stopped by you" line stays).
   */
  | { type: 'stop_reason_dismissed'; sessionId: string }
  /**
   * Cluster G E3 UI: populate the connection-lost overlay with a
   * specific failure variant. Fired from App.tsx's auth-token fetch
   * failure path (`reason: 'origin_not_allowed' | 'host_not_allowed' |
   * 'server_unreachable' | 'unknown'`) and also wired into the
   * `ws_close` path when the close info carries a structured code
   * (4001/4002/1006). Cleared on `ws_open` so a successful reconnect
   * unmounts the overlay automatically.
   *
   * The action takes the full populated view (reason + diagnostic) so
   * the reducer doesn't need to know about ws.ts internals — the
   * caller does the close-code → reason mapping via
   * `resolveFromCloseInfo`.
   */
  | { type: 'connection_lost'; view: ConnectionLostView }
  /**
   * Cluster G E3 UI: operator clicked Dismiss / closed the overlay
   * manually. We intentionally don't auto-clear on close — the
   * operator should explicitly acknowledge the failure (and copy the
   * diagnostic if needed) before the overlay goes away. A subsequent
   * `ws_open` also clears the slice as a positive signal.
   */
  | { type: 'connection_lost_dismissed' };

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'ws_open':
      // Cluster G E3 UI: a successful (re-)open is the positive signal
      // that clears the connection-lost overlay. We do this even if
      // the overlay was dismissed manually — being connected again
      // makes any prior failure irrelevant.
      return { ...state, connected: true, connectionLost: undefined };
    case 'ws_close':
      // Disconnect wipes liveness — any "running on this WS" claim is gone now.
      // Cluster G Phase 3b (G1 UI): also clear `activeRuns`. The snapshot is
      // per-connection (the dispatcher re-emits on the next attach), so a
      // stale dropdown would mislead the operator into thinking runs are
      // still alive when they're really just orphaned in the prior session.
      //
      // Note: we do NOT populate `connectionLost` here. The host
      // (App.tsx onClose) decides whether the close is operator-facing
      // and dispatches `connection_lost` with the resolved view — a
      // page-unload close (code 1000 with intent to navigate) should
      // not light up an overlay the user is about to leave.
      return {
        ...state,
        connected: false,
        liveSessions: {},
        activeRuns: [],
        // Cluster G Phase 4 (D6/D11): clear the in-session install
        // timestamps too. A stale 25-second-old entry would otherwise
        // briefly relight the badge on reconnect for an install that
        // happened before the connection dropped.
        lastBusInstallAt: {},
      };

    case 'connection_lost':
      // Caller (App.tsx auth-token fetch failure OR onClose with
      // structured code) hands over the fully-resolved view. We replace
      // any prior overlay state — most-recent failure wins. Operators
      // who copy the diagnostic before a fresh failure overwrites still
      // get the data they need; the typical case is one failure at a
      // time anyway.
      return { ...state, connectionLost: action.view };
    case 'connection_lost_dismissed':
      // Soft-clear. The overlay unmounts because the operator
      // acknowledged the failure. A subsequent attach also clears
      // (via ws_open), so dismiss + reconnect doesn't leak stale
      // state through the rest of the session.
      return { ...state, connectionLost: undefined };

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
          heldMessages: [],
        };
      }

      const next: SessionView = {
        ...session,
        status: 'running',
        // New turn begins now — anchor the elapsed timer at send time so it
        // counts the full wait, including the pre-first-token gap.
        runStartedAt: Date.now(),
        messages: [...session.messages, { kind: 'user', id: nextId(), text: action.text }],
        // Cluster C Phase 2: operator moved on — the previous Stop's
        // marker + reason prompt should no longer hang around in the
        // scrollback once a fresh turn starts.
        lastInterrupt: undefined,
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
        multiAgent: {
          ...state.multiAgent,
          draftLifecycle: action.lifecycle,
          // PR-7: a manual lifecycle flip dissociates the draft from the
          // template it was applied from — the next Start is now an ad-hoc
          // run with the operator's settings, not the template's.
          draftTemplateId: null,
          draftHopBudget: null,
          draftHopBudgetSource: null,
        },
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
          // PR-7: same dissociation rationale as ma_set_lifecycle above.
          draftTemplateId: null,
          draftHopBudget: null,
          draftHopBudgetSource: null,
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
          draftTemplateId: null,
          draftHopBudget: null,
          draftHopBudgetSource: null,
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
        multiAgent: {
          ...state.multiAgent,
          draftParticipants: next,
          lastAppliedDropped: 0,
          // PR-7: a reorder is a manual edit → drop template provenance.
          draftTemplateId: null,
          draftHopBudget: null,
          draftHopBudgetSource: null,
        },
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
          // PR-7: stash template provenance + hop budget override so the
          // next Start sends them on the wire. Any manual edit (participant
          // add/remove/reorder, lifecycle flip, ma_dismiss_active) clears
          // these — see the corresponding cases below.
          draftTemplateId: action.template.id,
          draftHopBudget:
            typeof action.template.hopBudget === 'number' &&
            Number.isFinite(action.template.hopBudget) &&
            action.template.hopBudget >= 1
              ? Math.floor(action.template.hopBudget)
              : null,
          // Cluster F Phase D9: tag the source so the DraftView input can
          // render "(from template)" attribution. Null when the template
          // has no hopBudget override; 'template' when populated.
          draftHopBudgetSource:
            typeof action.template.hopBudget === 'number' &&
            Number.isFinite(action.template.hopBudget) &&
            action.template.hopBudget >= 1
              ? 'template'
              : null,
        },
      };
    }

    case 'ma_set_draft_hop_budget': {
      // Cluster F Phase D9: user-typed value from the DraftView Run options
      // hop-budget input. `value === null` means the input is empty — the
      // server resolver falls back through DB > env > built-in. Any positive
      // integer is forwarded verbatim; the server re-clamps to >= 1.
      //
      // Setting source='user' (even when the value happens to match the
      // template's) means the DraftView annotation hides — the operator
      // touched the input, so attributing the value to the template would
      // be misleading.
      return {
        ...state,
        multiAgent: {
          ...state.multiAgent,
          draftHopBudget: action.value,
          draftHopBudgetSource: action.value === null ? null : 'user',
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
      //
      // Item #7: also zero `recoveryContext` (banner-bound lifetime — the
      // disclosure lives inside the awaiting-continue banner and is no longer
      // relevant once the operator has acknowledged the recovery).
      const active = state.multiAgent.active;
      if (!active || !active.awaitingContinue) return state;
      return {
        ...state,
        multiAgent: {
          ...state.multiAgent,
          active: { ...active, awaitingContinue: false, recoveryContext: null },
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

    case 'auth_expired_dismissed': {
      // Cluster D Phase 6: soft hide. The slice persists (count + first/
      // last timestamps remain useful for tooltips and accurate re-surface
      // on re-fire); only `dismissed` flips. Identity preserved when
      // nothing to dismiss (the banner gating already checks `!dismissed`,
      // but bailing here keeps re-renders honest).
      if (!state.authExpired || state.authExpired.dismissed) return state;
      return {
        ...state,
        authExpired: { ...state.authExpired, dismissed: true },
      };
    }

    case 'stop_reason_dismissed': {
      // Cluster C Phase 2: flip lastInterrupt.reasonSubmitted so the
      // inline prompt unmounts. The marker metadata (interruptAckId,
      // ackLatencyMs, ts) stays so the "■ Stopped by you · 42 ms"
      // line remains visible until the next user_send. No-op when
      // there's nothing to dismiss (no lastInterrupt OR already
      // submitted).
      const projectId = projectFor(state, action.sessionId);
      if (projectId === null) return state;
      const existing = state.sessionsByProject[projectId]?.[action.sessionId];
      if (!existing?.lastInterrupt || existing.lastInterrupt.reasonSubmitted) return state;
      return putSession(state, projectId, action.sessionId, {
        ...existing,
        lastInterrupt: { ...existing.lastInterrupt, reasonSubmitted: true },
      });
    }

    case 'ma_clear_auto_retry': {
      // Cluster D Phase 4d: the CountdownChip's onElapsed fires this. The
      // retry has fired; the banner unmounts. If attempt N+1 also fails,
      // a fresh `auto_retry` ServerMsg from the bus repopulates the slice.
      const active = state.multiAgent.active;
      if (!active || !active.autoRetry) return state;
      const { autoRetry: _drop, ...rest } = active;
      void _drop;
      return {
        ...state,
        multiAgent: {
          ...state.multiAgent,
          active: rest,
        },
      };
    }

    // ---- Cluster D Phase 4c rate-limit client-driven transitions ---------

    case 'rl_enqueue_held': {
      const pid = projectFor(state, action.sessionId);
      if (pid === null) return state;
      const session = state.sessionsByProject[pid]?.[action.sessionId];
      if (!session) return state;
      // Cap at HELD_MESSAGES_CAP (spec §4.2 / UI-D7). The composer also
      // refuses past the cap, so this is defense-in-depth — silently
      // drop overflow rather than throw.
      if (session.heldMessages.length >= HELD_MESSAGES_CAP) return state;
      return putSession(state, pid, action.sessionId, {
        ...session,
        heldMessages: [...session.heldMessages, action.text],
      });
    }

    case 'rl_drop_held': {
      const pid = projectFor(state, action.sessionId);
      if (pid === null) return state;
      const session = state.sessionsByProject[pid]?.[action.sessionId];
      if (!session) return state;
      if (action.index < 0 || action.index >= session.heldMessages.length) return state;
      const next = session.heldMessages.slice();
      next.splice(action.index, 1);
      return putSession(state, pid, action.sessionId, {
        ...session,
        heldMessages: next,
      });
    }

    case 'rl_drain_one': {
      // The drain effect in App.tsx / MultiAgentTab.tsx has just ws-sent
      // the head of the queue (via the normal `send_message` or
      // `multi_agent_user_prompt` path). Pop it from the queue. Idempotent
      // on an empty queue so a double-fire effect can't NRE.
      const pid = projectFor(state, action.sessionId);
      if (pid === null) return state;
      const session = state.sessionsByProject[pid]?.[action.sessionId];
      if (!session || session.heldMessages.length === 0) return state;
      return putSession(state, pid, action.sessionId, {
        ...session,
        heldMessages: session.heldMessages.slice(1),
      });
    }

    case 'rl_set_paused': {
      const pid = projectFor(state, action.sessionId);
      if (pid === null) return state;
      const session = state.sessionsByProject[pid]?.[action.sessionId];
      if (!session || !session.rateLimit) return state;
      if (session.rateLimit.paused === action.paused) return state;
      return putSession(state, pid, action.sessionId, {
        ...session,
        rateLimit: { ...session.rateLimit, paused: action.paused },
      });
    }

    case 'rl_retry_sent': {
      const pid = projectFor(state, action.sessionId);
      if (pid === null) return state;
      const session = state.sessionsByProject[pid]?.[action.sessionId];
      if (!session || !session.rateLimit) return state;
      if (session.rateLimit.retryInFlight) return state;
      return putSession(state, pid, action.sessionId, {
        ...session,
        rateLimit: { ...session.rateLimit, retryInFlight: true },
      });
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
      // Cluster G Phase 4 (D6/D11): track the install timestamp so the
      // `BusInstalledBadge` can light up for 30 seconds next to the
      // `.participant-bus-tag.installed` chip. We only record on
      // `installed: true` and clear on `installed: false`; the badge
      // component reads `lastBusInstallAt[projectId]` and hides itself
      // after the 30-second window elapses. See AppState['lastBusInstallAt']
      // JSDoc for the anti-pattern guard rationale.
      let nextLastBusInstallAt = state.lastBusInstallAt;
      if (msg.installed) {
        nextLastBusInstallAt = { ...state.lastBusInstallAt, [msg.projectId]: Date.now() };
      } else if (msg.projectId in state.lastBusInstallAt) {
        nextLastBusInstallAt = { ...state.lastBusInstallAt };
        delete nextLastBusInstallAt[msg.projectId];
      }
      return { ...state, projects: next, lastBusInstallAt: nextLastBusInstallAt };
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
            // Item #7: server includes `recoveryContext` only when
            // `awaitingContinue=true` (R-B reconstruct or a pause-on-mutation
            // banner that survived a restart). Null in every other case;
            // banner-bound lifetime.
            recoveryContext: msg.recoveryContext ?? null,
            // Phase 6d: drops are client-accumulated; always empty at start.
            // A future R-A enhancement could rehydrate from the server's
            // safety_audit table.
            routerDrops: [],
            // Phase 4g1: per-participant control state accumulates from
            // the three `participant_*_changed` ServerMsgs. Empty at
            // start; a future R-A enhancement could rehydrate by reading
            // back from the server's per_agent_control table.
            participantControls: {},
            // Phase E2.x: per-participant model identifiers accumulate
            // from each session_started for a participant project.
            // Same R-A caveat — empty until at least one participant's
            // SDK init arrives post-attach.
            modelsByProject: {},
            // Cluster G Phase 2c (UI-A3): per-session MOCK posture, projected
            // from `multi_agent_sessions.mock` server-side. Spread-omit when
            // the wire field is absent (pre-G2c server, or a live session)
            // so the run state mirrors the wire — strict `=== true` mount
            // predicates downstream then collapse {undefined, false} to "no".
            ...(msg.mock !== undefined ? { mock: msg.mock } : {}),
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
            // Item #7: a stopped/crashed session can't be continued, so the
            // recovery disclosure (banner-bound) is moot. Drop it for the
            // same reason.
            recoveryContext: null,
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

    case 'iteration_archived': {
      // Cluster D Phase 5 (spec §6.4 / BE-D22): reply to
      // `archive_session`. The server already flipped `archived = 1`
      // on the row and writes a `recovery_log` entry; the client just
      // needs to drop the row from the iterations cache so the
      // IterationsList no longer renders it. `list_archived_iterations`
      // (later phase) will provide an opt-in surface for browsing
      // archived rows.
      //
      // Defensive on `iterations === null` (the cache hasn't been
      // populated yet, possible if the operator archives via the toast
      // before opening the iterations panel) — nothing to drop, no-op.
      //
      // `removedArtifacts` from the envelope is intentionally ignored
      // here: the iteration cache doesn't surface disk state, so the
      // boolean is purely confirmation for the operator (logged via
      // the dispatcher's normal envelope flow if/when a future phase
      // wires a follow-up toast).
      const existing = state.multiAgent.iterations;
      if (existing === null) return state;
      const next = existing.filter((it) => it.sessionId !== msg.sessionId);
      // Identity-preserve when nothing matched — keeps useReducer from
      // forcing a no-op re-render in the IterationsList children.
      if (next.length === existing.length) return state;
      return {
        ...state,
        multiAgent: { ...state.multiAgent, iterations: next },
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
          // Cluster E Phase 3 (A4): forward provenance of the fallback
          // path so the SettingsModal can label it. Optional on the wire
          // — older servers omit, the modal degrades to a neutral
          // "(default fallback)" label without the source attribution.
          ...(msg.defaultWorkspaceRootSource !== undefined
            ? { defaultWorkspaceRootSource: msg.defaultWorkspaceRootSource }
            : {}),
          defaultHopBudget: msg.defaultHopBudget,
          // Cluster F Phase A1a (UI-A1): forward the server-resolved
          // MAX_TURNS so the F-A1b SettingsModal input seeds from
          // server truth. Optional for forward-compat.
          ...(msg.defaultMaxTurns !== undefined ? { defaultMaxTurns: msg.defaultMaxTurns } : {}),
          // Cluster G Phase 2a (A3): forward the MOCK runtime flag so
          // the sidebar-header MockBadge can mount. Optional for
          // forward-compat — pre-G1 servers omit it, and the badge
          // mount predicate (`mockMode === true`) renders nothing in
          // that case.
          ...(msg.mockMode !== undefined ? { mockMode: msg.mockMode } : {}),
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

      // Cluster D Phase 4c (spec §4.2): rate-limit slice lifecycle.
      //
      //  - status: 'rate_limited' arrives twice per held turn (once on the
      //    hard rate_limit_event, once again on the finally-block running:
      //    false echo). On either, ensure the slice exists so the banner
      //    renders even before the typed `rate_limit_event` arrives
      //    (defensive — `rate_limit_event` is the canonical countdown
      //    source, but session_running is a useful flag-only fallback).
      //  - status undefined (or 'thinking') indicates a normal running
      //    transition. If a slice was in flight, it has now cleared — drop
      //    it so the banner unmounts. Held messages stay queued; the
      //    drain effect in App.tsx will ship them on the next tick.
      //  - status: 'awaiting_continue' / 'paused' don't touch the
      //    rate-limit slice (those belong to other recovery surfaces).
      let sessions = state.sessionsByProject;
      const projectMap = sessions[msg.projectId];
      const existing = projectMap?.[msg.sessionId];
      if (existing) {
        const status = msg.status;
        let nextRL: RateLimitState | undefined = existing.rateLimit;
        if (status === 'rate_limited') {
          // Preserve any prior countdown data; if the slice didn't exist
          // yet (the typed rate_limit_event lost the race), seed a stub
          // so the banner still mounts.
          nextRL = nextRL ?? { paused: false, retryInFlight: false };
          // Any in-flight retry has now been observed by the server (the
          // running:true echo confirms the new run); clear the debounce.
          nextRL = { ...nextRL, retryInFlight: false };
        } else if (status === undefined || status === 'thinking') {
          // Turn is back to normal — banner goes away.
          nextRL = undefined;
        }
        if (nextRL !== existing.rateLimit) {
          let updatedSession: SessionView;
          if (nextRL === undefined) {
            // Drop the `rateLimit` key entirely — `rateLimit: undefined`
            // would type-narrow the same way but its lingering presence
            // mucks up `Object.hasOwn` tests + JSON snapshot diffs.
            const { rateLimit: dropped, ...rest } = existing;
            void dropped;
            updatedSession = rest as SessionView;
          } else {
            updatedSession = { ...existing, rateLimit: nextRL };
          }
          sessions = {
            ...sessions,
            [msg.projectId]: {
              ...projectMap!,
              [msg.sessionId]: updatedSession,
            },
          };
        }
      }
      return {
        ...state,
        liveSessions: live,
        sessionsByProject: sessions,
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
        heldMessages: [],
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
          heldMessages: [],
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
        // Cluster E Phase 1: capture SDK-discovered slash commands for
        // the palette. Cluster B Phase 2 forwards this field on every
        // session_started; old payloads (no Phase 2) ship undefined and
        // the palette degrades to Cebab-local only.
        ...(msg.slashCommands !== undefined ? { slashCommands: msg.slashCommands } : {}),
        // Cluster E Phase 2 (B4): capture the SDK-reported model
        // identifier for the ChatHeader's ModelChip. `msg.model` is
        // required on the wire (`session_started.model: string`), so
        // we always store it — undefined-checks guard against future
        // protocol changes that make it optional.
        ...(msg.model !== undefined ? { model: msg.model } : {}),
        // Cluster G Phase 2b (UI-A3): capture the per-session MOCK
        // flag so the ChatHeader's `MockBadge` (mounted after ModelChip)
        // mirrors the sidebar chip whenever the operator is in a
        // mock-era session — even when the global runtime is now live.
        // Spread-omit when absent so undefined stays as undefined
        // (avoids re-overwriting a previously-stamped true with undefined
        // if a later session_started for the same id omits the field).
        ...(msg.mock !== undefined ? { mock: msg.mock } : {}),
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
              // Cluster G Phase 2b (UI-A3): stamp MOCK on the freshly-
              // synthesized known-sessions entry too, so the ProjectList
              // row badge appears immediately for a session whose first
              // ServerMsg we just observed (no full `open_project`
              // refresh needed).
              ...(msg.mock !== undefined ? { mock: msg.mock } : {}),
            },
            ...knownList,
          ];

      const pendingNext = { ...state.pendingByProject };
      if (pendingNext[projectId] === pendingId) delete pendingNext[projectId];

      // Cluster E Phase 2.x: if this session_started belongs to a bus
      // participant of the currently-active MultiAgentRun, also push
      // the model into `multiAgent.active.modelsByProject` so the
      // TopRunBar's ModelChip can summarize across participants.
      //
      // Participant detection: a project belongs to the active bus
      // session iff its `busAgentName` matches one of the run's
      // `participantAgentNames`. Single-agent sessions (no bus run, or
      // a project that isn't a participant) leave the map untouched.
      let multiAgentNext = state.multiAgent;
      const activeRun = state.multiAgent.active;
      if (activeRun && msg.model !== undefined) {
        const proj = state.projects.find((p) => p.id === projectId);
        const slug = proj?.busAgentName ?? null;
        if (slug !== null && activeRun.participantAgentNames.includes(slug)) {
          // Already cached identical value? Skip the spread to keep
          // referential equality on the noop case (this reducer fires
          // every turn — the model rarely changes mid-session).
          if (activeRun.modelsByProject[projectId] !== msg.model) {
            multiAgentNext = {
              ...state.multiAgent,
              active: {
                ...activeRun,
                modelsByProject: {
                  ...activeRun.modelsByProject,
                  [projectId]: msg.model,
                },
              },
            };
          }
        }
      }

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
        // Cluster D Phase 6: positive auth signal. The SDK only emits
        // `session_started` after the OAuth handshake succeeds (auth must
        // be valid for the spawn to reach init), so any prior auth_expired
        // slice is now stale — drop it. Identity-preserving when there's
        // nothing to clear (undefined === undefined for shallow equality).
        authExpired: undefined,
        multiAgent: multiAgentNext,
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

    case 'command_output': {
      // Slash-command output (e.g. /context, /compact). Closes out the turn
      // — clear the streaming buffer + drop the runStartedAt anchor so the
      // thinking indicator stops. Result rows are suppressed server-side
      // (num_turns: 0), so the command_output card is the turn's only echo.
      const projectId = projectFor(state, msg.sessionId);
      if (projectId === null) return state;
      const session = state.sessionsByProject[projectId]?.[msg.sessionId];
      if (!session) return state;
      return putSession(state, projectId, msg.sessionId, {
        ...session,
        status: 'done',
        runStartedAt: null,
        streamingText: '',
        messages: [...session.messages, { kind: 'command_output', id: msg.uuid, text: msg.text }],
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
            // Cluster F Phase A1b (UI-A1): persist turn-count + effective
            // cap onto the message so MaxTurnsResultCard can render both
            // without prop-drilling session state. Omit when absent
            // (older server payloads pre-A1b).
            ...(msg.numTurns !== undefined ? { numTurns: msg.numTurns } : {}),
            ...(msg.effectiveMaxTurns !== undefined
              ? { effectiveMaxTurns: msg.effectiveMaxTurns }
              : {}),
            // Cluster H B5: stash wall-clock duration alongside cost so the
            // result-block footer can render "subtype · $cost · 2.4s" without
            // re-querying turn metadata. `result` ServerMsg's `durationMs`
            // is always populated on the wire today (translate.ts:283), but
            // we still gate the spread for forward-compat with replays of
            // older persisted envelopes.
            ...(typeof msg.durationMs === 'number' && Number.isFinite(msg.durationMs)
              ? { durationMs: msg.durationMs }
              : {}),
          },
        ],
      });
    }

    case 'session_log_chunk': {
      // Phase H: the logs modal manages its own ephemeral chunk state via a
      // side-channel subscription on the WS layer. The reducer doesn't store
      // log rows — they'd bloat AppState for a transient modal — so this is
      // a deliberate no-op. The narrowing exists so the switch stays
      // exhaustive; if a future change wants to project last-N tail rows
      // into AppState for an out-of-modal "new entries" badge, this is
      // where it'd live.
      return state;
    }

    case 'project_facts': {
      // PR-6: the template-preview modal manages its own per-modal-open
      // cache for facts replies via a side-channel subscription (same
      // pattern as session_log_chunk above). The reducer doesn't store
      // them in AppState because (a) the cache invalidates on modal
      // close+reopen, and (b) facts are read-only static project metadata
      // the operator already sees in the sidebar. Deliberate no-op.
      return state;
    }

    case 'last_run_for_template': {
      // PR-7: the templates rail manages its own per-template cache via a
      // side-channel subscription (same pattern as project_facts above).
      // The rail's freshness is driven by `multi_agent_ended` events
      // (refresh affected templates after each end), so storing rail rows
      // in AppState would just duplicate the invalidation logic. The
      // exhaustiveness narrowing keeps the switch honest. Deliberate no-op.
      return state;
    }

    case 'notification':
      // Cluster A Phase 2: notification envelopes are dispatched OUTSIDE the
      // store via App.tsx's onMessage call to `notifyFromServerMsg` — a
      // separate slice owned by `<NotificationsProvider>`. The store keeps
      // a no-op case here so the union exhaustiveness check passes and so
      // that future cross-references (e.g. dispatching session state on
      // safety events that ALSO update a session) have a place to land.
      return state;

    case 'router_drop': {
      // Cluster B Phase 6d (D4 / UI-B24): accumulate drops onto the active
      // MultiAgentRun for the RouterDropsCounter chip. The dispatcher still
      // fans the same envelope into a `notification` envelope server-side
      // (the inbox/toast path); this case adds the per-run client state.
      //
      // We only accumulate when the envelope's sessionId matches the active
      // run — drops on stale/dismissed sessions are ignored.
      const active = state.multiAgent.active;
      if (!active || active.sessionId !== msg.sessionId) return state;
      // Dedupe by auditRowId. Server may re-emit on attach in a future phase;
      // today the only dup path is double-render, but the guard is cheap.
      if (active.routerDrops.some((d) => d.auditRowId === msg.auditRowId)) return state;
      const drop: RouterDropView = {
        auditRowId: msg.auditRowId,
        reasonCode: msg.reasonCode,
        source: msg.source,
        destination: msg.destination,
        kind: msg.kind,
        receivedAt: Date.now(),
      };
      return {
        ...state,
        multiAgent: {
          ...state.multiAgent,
          active: { ...active, routerDrops: [...active.routerDrops, drop] },
        },
      };
    }

    case 'rate_limit_event': {
      // Cluster D Phase 4c (spec §4.1, B2): the typed rate_limit_event
      // populates / updates / clears the per-session `rateLimit` slice
      // that the RateLimitBanner reads. The dispatcher ALSO fans the
      // same envelope into a `notification` (see server/src/notifications/
      // dispatcher.ts) — UI-D6's banner↔toast dedup lives in
      // `notifyFromServerMsg.ts`, which checks whether the banner is
      // visible for this session and suppresses the duplicate toast.
      //
      // Status vocabulary (spec §4.1):
      //   - 'hard'        → mount/refresh banner; carry countdown + overage.
      //   - 'approaching' → leave banner alone (preview-only; not a held
      //                     turn). The dispatcher's `cleared`/`hit` toast
      //                     path covers operator visibility today.
      //   - 'allowed'     → cleared. Drop the slice so the banner unmounts.
      //
      // Forward-compat: any unknown status leaves the slice as-is; the
      // server stays the source of truth via session_running echoes.
      const projectId = projectFor(state, msg.sessionId);
      if (projectId === null) return state;
      const session = state.sessionsByProject[projectId]?.[msg.sessionId];
      if (!session) return state;
      if (msg.status === 'allowed') {
        if (!session.rateLimit) return state;
        const { rateLimit: _drop, ...rest } = session;
        void _drop;
        return putSession(state, projectId, msg.sessionId, rest as SessionView);
      }
      if (msg.status !== 'hard') return state;
      const prev = session.rateLimit ?? { paused: false, retryInFlight: false };
      const next: RateLimitState = {
        ...prev,
        resetsAtMs: msg.resetsAtMs ?? prev.resetsAtMs,
        overageStatus: msg.overageStatus ?? prev.overageStatus,
        overageResetsAtMs: msg.overageResetsAtMs ?? prev.overageResetsAtMs,
        isUsingOverage: msg.isUsingOverage ?? prev.isUsingOverage,
        // Any in-flight retry is observed; new hard event means the retry
        // was rejected at the same wall — clear the debounce.
        retryInFlight: false,
      };
      return putSession(state, projectId, msg.sessionId, {
        ...session,
        rateLimit: next,
      });
    }

    case 'auto_retry': {
      // Cluster D Phase 4d: multi-agent bus auto-retry routes to
      // `MultiAgentRun.autoRetry`. The bus session id is `multiAgent.
      // active.sessionId`; the bus runner's `onAutoRetry` callback
      // (chain.ts + orchestrator.ts wiring in Phase 4a) emits the
      // ServerMsg with that id. Bus sessions don't appear in
      // `sessionToProject` / `sessionsByProject`, so the single-agent
      // path below would silently no-op — handle the bus case first.
      const active = state.multiAgent.active;
      if (active && active.sessionId === msg.sessionId) {
        return {
          ...state,
          multiAgent: {
            ...state.multiAgent,
            active: {
              ...active,
              autoRetry: {
                attempt: msg.attempt,
                maxAttempts: msg.maxAttempts,
                backoffMs: msg.backoffMs,
                retryAt: msg.retryAt,
                reason: msg.reason,
                ...(msg.agentName !== undefined ? { agentName: msg.agentName } : {}),
              },
            },
          },
        };
      }
      // Cluster D Phase 4c: single-agent path. Populates the rateLimit
      // slice's `autoRetry` sub-field so the banner can render "attempt
      // 2 of 5 in 0:23". Single-agent auto-retry (reason: 'rate_limit_
      // hard') is forward-declared by the protocol but Phase 4b/c keep
      // the single-agent client-driven (the CountdownChip fires
      // `retry_rate_limited { auto: true }` on elapse); this case ALSO
      // accepts that variant so a future server-driven single-agent
      // auto-retry path Just Works without further reducer changes.
      const projectId = projectFor(state, msg.sessionId);
      if (projectId === null) return state;
      const session = state.sessionsByProject[projectId]?.[msg.sessionId];
      if (!session) return state;
      const prev = session.rateLimit ?? { paused: false, retryInFlight: false };
      const next: RateLimitState = {
        ...prev,
        autoRetry: {
          attempt: msg.attempt,
          maxAttempts: msg.maxAttempts,
          backoffMs: msg.backoffMs,
          retryAt: msg.retryAt,
          reason: msg.reason,
          ...(msg.agentName !== undefined ? { agentName: msg.agentName } : {}),
        },
      };
      return putSession(state, projectId, msg.sessionId, {
        ...session,
        rateLimit: next,
      });
    }

    case 'active_runs':
      // Cluster G Phase 3b (G1 UI): replace the slice with the server's
      // snapshot verbatim. The wire is the full set of in-flight runs
      // each time — no incremental merge, no per-row reconciliation — so
      // a stale row from a previously-seen snapshot can't survive. The
      // spread-omit pattern from the wire (`projectId?`, `projectName?`,
      // `activeAgentName?`, `currentActivity?`) is preserved by copying
      // only the fields the message carries; this matches Cluster G
      // Phase 2c's `multi_agent_started.mock` precedent and keeps the
      // state shape identical to the wire shape for the snapshot test.
      return {
        ...state,
        activeRuns: msg.runs.map(
          (r): ActiveRunView => ({
            sessionId: r.sessionId,
            ...(r.projectId !== undefined ? { projectId: r.projectId } : {}),
            ...(r.projectName !== undefined ? { projectName: r.projectName } : {}),
            kind: r.kind,
            startedAt: r.startedAt,
            elapsedMs: r.elapsedMs,
            ...(r.activeAgentName !== undefined ? { activeAgentName: r.activeAgentName } : {}),
            ...(r.currentActivity !== undefined ? { currentActivity: r.currentActivity } : {}),
          }),
        ),
      };

    case 'env_scrubbed':
    case 'session_superseded':
    case 'chain_not_reconstructed':
    case 'bus_auto_installed':
    case 'tool_denied':
    case 'session_reconstructed':
    case 'recent_rejections':
      // Cluster G E3 (server-side): `recent_rejections` lands as a no-op
      // here in this PR — the UI overlay + Cluster A toast wiring ships in
      // the next slice. The server emits the envelope on every WS attach
      // when the in-process ring has entries within the 5-min window;
      // dropping it on the client side keeps the wire shape stable and
      // observed-by-the-typed-reducer exhaustiveness check until the
      // ConnectionLostOverlay PR consumes it.
      //
      // Cluster A Phase 3+4+6: the dispatcher fans every one of these into a
      // matching `notification` envelope (see `server/src/notifications/
      // dispatcher.ts`); the dock owns the operator-facing surface. The
      // typed events themselves are kept on the wire for forward-compat
      // non-toast consumers (E1 ignored-variables inspector, Cluster D
      // session-recovery surface for `session_superseded` /
      // `chain_not_reconstructed` / `session_reconstructed`, Phase 5
      // install inspector for `bus_auto_installed`, future tool-policy
      // diagnostics for `tool_denied`) — when those land, they'll consume
      // the typed event here and dispatch session/banner state. No reducer
      // state changes for now. (`router_drop` exited this list in Phase 6d
      // — it now accumulates onto `active.routerDrops` for the counter
      // chip in the activity bar; `rate_limit_event` / `auto_retry`
      // exited in Phase 4c — see above.)
      return state;

    case 'project_authority':
    case 'mcp_auto_install_pending':
    case 'session_start_gated':
    case 'bus_auto_install_pending':
      // Cluster B Phase 3+4+5 + Cluster G Phase 4 (D6/D11): AuthorityPanel +
      // McpTofuModal + EnvInjectionGateModal + BusTofuModal (the latter
      // ships in the next D6/D11 UI slice) will own their own context-like
      // slices for these — all are project-scoped + modal-triggered, and
      // the main store shouldn't re-render on every refresh / pending.
      // The pattern matches inbox_snapshot. Exhaustiveness no-op for now.
      return state;

    case 'reopen_session_confirm_required':
    case 'reopen_session_failed':
      // Cluster D Phase 5b: ReopenSessionModal (Phase 5c) will own these
      // via a sibling context — same modal-triggered pattern as the
      // McpTofu/EnvInjection gates above. The handler echoes the
      // workspace-diff envelope; the modal mounts to render it and
      // collect the typed "reopen" confirmation. Reducer no-op keeps the
      // exhaustiveness check honest until that context lands.
      return state;

    case 'auth_refresh_started':
    case 'auth_refresh_output':
    case 'auth_refresh_completed':
    case 'auth_refresh_failed':
      // Cluster D Phase 6b: the AuthRefreshModal (Phase 6c, follow-up)
      // will own these via a sibling AuthRefreshContext — the modal
      // shows live `claude login` subprocess output. Same pattern as
      // the McpTofu / EnvInjection / Reopen gates above. Reducer no-op
      // keeps the union exhaustive until the context lands; the
      // matching ClientMsgs (start_auth_refresh / cancel_auth_refresh)
      // ship the spawn directly via wsRef.send from the banner action.
      return state;

    case 'recovery_log_snapshot':
      // Cluster D Phase 8a: the RecoveryLogInspector (Phase 8b) will own
      // this via a sibling context (the snapshot is short-lived inspector
      // state — no need to live in the main store and churn the whole
      // tree on every refresh). Same pattern as inbox_snapshot above.
      // Reducer no-op keeps the union exhaustive until that context
      // lands; the matching ClientMsg (get_recovery_log_snapshot) ships
      // the request directly via wsRef.send from the inspector button.
      return state;

    case 'kick_forensics_snapshot':
      // Cluster C Phase 4g4: the KickForensicsModal owns this via a
      // sibling context (ForensicViewerContext) — same pattern as
      // recovery_log_snapshot. Snapshot is short-lived inspector state;
      // no need to live in the main store. The matching ClientMsg
      // (get_kick_forensics) ships from the View forensics… menu item.
      return state;

    case 'session_interrupted': {
      // Cluster C Phase 2: stash the latest Stop metadata on the
      // session so the reason-for-stop prompt + Stopped marker can
      // render. The companion stop_reason_dismissed action below
      // flips reasonSubmitted; user_send + session_started clear the
      // whole field. Unknown session → silent no-op (could happen if
      // the session is being recovered or just unmounted; harmless).
      const projectId = projectFor(state, msg.sessionId);
      if (projectId === null) return state;
      const existing = state.sessionsByProject[projectId]?.[msg.sessionId];
      if (!existing) return state;
      return putSession(state, projectId, msg.sessionId, {
        ...existing,
        lastInterrupt: {
          interruptAckId: msg.interruptAckId,
          ackLatencyMs: msg.ackLatencyMs,
          ts: Date.now(),
          reasonSubmitted: false,
        },
      });
    }

    case 'inbox_snapshot':
      // Cluster A Phase 5: the inbox panel (`<NotificationInbox/>`) owns
      // this state via a sibling context (`InboxContext`) so the main
      // store doesn't churn on every sticky-replay snapshot. The context
      // subscribes directly via App.tsx's onMessage side-channel. Reducer
      // exhaustiveness keeps the union honest; the side-effect path is
      // where the bell badge + panel actually update.
      return state;

    case 'log_row_appended':
      // Cluster H D12 backend: the LogsModal's tail-mode (D12 client
      // slice, follow-up) will own consumption of these via the existing
      // `subscribeServerMsg` side-channel inside `useLogStream` — same
      // pattern as `session_log_chunk` (handled above). Putting the row
      // in the main store would churn the whole tree on every bus hop
      // while the operator isn't even watching the log; the side-channel
      // subscriber only fires when the inspector is open. Reducer no-op
      // keeps the discriminated union exhaustive until that wiring lands.
      return state;

    case 'search_results':
      // Cluster I Phase C4 backend: the `search_sessions` reply. The C4 UI
      // slice (SessionSearchModal + Cmd/Ctrl+P) owns consumption via a
      // dedicated `useSessionSearch` hook + `subscribeServerMsg` side-channel
      // — same posture as `session_log_chunk` / `recovery_log_snapshot`:
      // search results are modal-local, ephemeral, and query-versioned, so
      // routing them through the main store would churn the tree for a
      // surface that isn't even mounted most of the time. Reducer no-op keeps
      // the discriminated union exhaustive until that UI slice lands.
      return state;

    case 'bulk_session_op_result': {
      // Cluster I Phase C5 UI: the server has archived or soft-deleted the
      // `succeededSessionIds`. Drop them from every per-project cache so the
      // sidebar rows vanish immediately (the same posture as
      // `iteration_archived` for the bus iteration browser). Both archive
      // and delete remove the row from the DEFAULT listing — archived rows
      // would need the (not-yet-built) "Include archived" toggle to
      // resurface, and soft-deleted rows are never re-listed — so for the
      // sidebar's purposes both ops mean "stop showing this row".
      //
      // The `failed[]` entries are surfaced by the toast (notifyFromServerMsg),
      // not the reducer — those rows simply stay put, which is correct.
      const dropped = new Set(msg.succeededSessionIds);
      if (dropped.size === 0) return state;

      // knownSessions: filter each project's summary list.
      let knownChanged = false;
      const knownSessions: Record<number, SessionSummary[]> = {};
      for (const [pidStr, list] of Object.entries(state.knownSessions)) {
        const next = list.filter((s) => !dropped.has(s.id));
        if (next.length !== list.length) knownChanged = true;
        knownSessions[Number(pidStr)] = next;
      }

      // sessionsByProject: drop the hydrated SessionView entries.
      let sbpChanged = false;
      const sessionsByProject: Record<number, Record<string, SessionView>> = {};
      for (const [pidStr, map] of Object.entries(state.sessionsByProject)) {
        let mapChanged = false;
        const nextMap: Record<string, SessionView> = {};
        for (const [sid, view] of Object.entries(map)) {
          if (dropped.has(sid)) {
            mapChanged = true;
            continue;
          }
          nextMap[sid] = view;
        }
        sessionsByProject[Number(pidStr)] = mapChanged ? nextMap : map;
        if (mapChanged) sbpChanged = true;
      }

      // sessionToProject: drop the routing entries.
      let stpChanged = false;
      const sessionToProject = { ...state.sessionToProject };
      for (const sid of dropped) {
        if (sid in sessionToProject) {
          delete sessionToProject[sid];
          stpChanged = true;
        }
      }

      // activeSessionByProject: if the currently-shown session in a project
      // was dropped, clear it so the chat pane falls back to the empty /
      // new-chat state rather than rendering an orphaned session.
      let asbpChanged = false;
      const activeSessionByProject = { ...state.activeSessionByProject };
      for (const [pidStr, activeSid] of Object.entries(state.activeSessionByProject)) {
        if (activeSid && dropped.has(activeSid)) {
          activeSessionByProject[Number(pidStr)] = undefined;
          asbpChanged = true;
        }
      }

      if (!knownChanged && !sbpChanged && !stpChanged && !asbpChanged) return state;
      return {
        ...state,
        knownSessions: knownChanged ? knownSessions : state.knownSessions,
        sessionsByProject: sbpChanged ? sessionsByProject : state.sessionsByProject,
        sessionToProject: stpChanged ? sessionToProject : state.sessionToProject,
        activeSessionByProject: asbpChanged ? activeSessionByProject : state.activeSessionByProject,
      };
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
        heldMessages: [],
      };
      // Cluster D Phase 6: ALSO promote `auth_expired` into the top-level
      // slice so the app-wide AuthExpiredBanner can mount. Per-session
      // inline rendering (the chat message-list 'error' entry below) and
      // the toast notification (already routed by the dispatcher) stay
      // independent; this slice is the durable in-page signal.
      const now = Date.now();
      const nextAuthExpired =
        msg.kind === 'auth_expired'
          ? {
              firstSeenMs: state.authExpired?.firstSeenMs ?? now,
              lastSeenMs: now,
              count: (state.authExpired?.count ?? 0) + 1,
              lastMessage: msg.message,
              // Re-surface the banner on every fresh observation — the
              // operator may have dismissed it, then attempted another
              // message, so the dismiss should not silence the second
              // failure.
              dismissed: false,
            }
          : state.authExpired;
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
        authExpired: nextAuthExpired,
      };
    }

    case 'participant_mute_changed': {
      // Cluster C Phase 4g1: route the per-agent mute echo onto the
      // active MultiAgentRun's participantControls map. Server has
      // already written per_agent_control + the safety_audit row by
      // the time this lands; the echo is the canonical "this state is
      // now true" signal.
      //
      // Only accumulates when the envelope's sessionId matches the
      // active run — drops on stale/dismissed sessions are ignored
      // (same guard as router_drop / mutations above).
      const active = state.multiAgent.active;
      if (!active || active.sessionId !== msg.sessionId) return state;
      const prior = active.participantControls[msg.projectId];
      const next: ParticipantControlView = {
        ...(prior ?? {
          projectId: msg.projectId,
          muted: false,
          pausedUntil: null,
          kickedAt: null,
        }),
        muted: msg.muted,
        mutedReasonCode: msg.reasonCode,
        mutedReasonText: msg.reasonText,
        mutedTs: msg.ts,
      };
      return {
        ...state,
        multiAgent: {
          ...state.multiAgent,
          active: {
            ...active,
            participantControls: {
              ...active.participantControls,
              [msg.projectId]: next,
            },
          },
        },
      };
    }

    case 'participant_pause_changed': {
      // Cluster C Phase 4g1: route the pause/resume echo onto
      // participantControls. `pausedUntil: null` = resume (clears the
      // pause but leaves any prior mute alone); `pausedUntil: <ts>` =
      // active pause with expiryAction telling us what fires at the
      // deadline.
      const active = state.multiAgent.active;
      if (!active || active.sessionId !== msg.sessionId) return state;
      const prior = active.participantControls[msg.projectId];
      const next: ParticipantControlView = {
        ...(prior ?? {
          projectId: msg.projectId,
          muted: false,
          pausedUntil: null,
          kickedAt: null,
        }),
        pausedUntil: msg.pausedUntil,
        pauseExpiryAction: msg.expiryAction ?? undefined,
        pauseReasonCode: msg.reasonCode,
        pauseReasonText: msg.reasonText,
        queuedDeliveries: msg.queuedDeliveries,
        pausedTs: msg.ts,
      };
      return {
        ...state,
        multiAgent: {
          ...state.multiAgent,
          active: {
            ...active,
            participantControls: {
              ...active.participantControls,
              [msg.projectId]: next,
            },
          },
        },
      };
    }

    case 'participant_kicked': {
      // Cluster C Phase 4g1: kick is terminal (no unkick verb in v1).
      // Sets kickedAt and clears pausedUntil because the server treats
      // kick as a superseding action (see executeExpireParticipant's
      // auto_kick branch and Phase 4d's drain semantics).
      // The mute flag is preserved so the UI can show the prior reason
      // alongside the kick pill if both were set.
      const active = state.multiAgent.active;
      if (!active || active.sessionId !== msg.sessionId) return state;
      const prior = active.participantControls[msg.projectId];
      const next: ParticipantControlView = {
        ...(prior ?? {
          projectId: msg.projectId,
          muted: false,
          pausedUntil: null,
          kickedAt: null,
        }),
        pausedUntil: null,
        kickedAt: msg.ts,
        kickMode: msg.mode,
        kickReasonCode: msg.reasonCode,
        kickReasonText: msg.reasonText,
      };
      return {
        ...state,
        multiAgent: {
          ...state.multiAgent,
          active: {
            ...active,
            participantControls: {
              ...active.participantControls,
              [msg.projectId]: next,
            },
          },
        },
      };
    }
  }
}

/**
 * Cluster C Phase 4g1: derive an active-control count from a
 * MultiAgentRun's participantControls map. A participant is counted as
 * "controlled" if they are currently muted OR currently paused OR have
 * been kicked. Returns 0 when `run` is null (caller shouldn't render the
 * chip in that case anyway).
 *
 * The `now` arg lets callers pass a consistent timestamp across multiple
 * derivations in the same render; default is `Date.now()`. We compare
 * `pausedUntil > now` so an expired pause that hasn't yet been echoed
 * back as `pausedUntil: null` doesn't inflate the count.
 */
export function countControlledParticipants(
  run: MultiAgentRun | null,
  now: number = Date.now(),
): number {
  if (!run) return 0;
  let n = 0;
  for (const ctrl of Object.values(run.participantControls)) {
    if (ctrl.muted) {
      n += 1;
      continue;
    }
    if (ctrl.kickedAt !== null) {
      n += 1;
      continue;
    }
    if (ctrl.pausedUntil !== null && ctrl.pausedUntil > now) {
      n += 1;
    }
  }
  return n;
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
 * Item #6: derive the chat-header chip's effective auto-allow scope from the
 * trust toggle and the session's permission mode. Mirrors the server-side
 * `shouldAutoAllow` decision (server/src/ws/permission.ts:26-33), but viewed
 * from the operator's vantage: WHAT auto-allows under the current pair of
 * gates, not whether a given tool call does.
 *
 *   trusted=true                       → 'trusted-all'     (auto-allow ALL)
 *   trusted=false, mode='acceptEdits'  → 'untrusted-edits' (auto-allow Edit/Write/NotebookEdit)
 *   trusted=false, mode='default'      → 'untrusted-ask'   (ask every tool)
 */
export type TrustChipState = 'trusted-all' | 'untrusted-edits' | 'untrusted-ask';

export function trustChipState(trusted: boolean, mode: SessionPermissionMode): TrustChipState {
  if (trusted) return 'trusted-all';
  if (mode === 'acceptEdits') return 'untrusted-edits';
  return 'untrusted-ask';
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
