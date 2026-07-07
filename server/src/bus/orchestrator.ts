/**
 * Canonical orchestrator workspace directory.
 *
 * The orchestrator is Cebab's own bus agent — used in orchestrator-routed
 * mode to receive user prompts, route them to participant workers, and
 * reply back to the user. Its bus name is always `orchestrator`.
 *
 * Unlike worker projects (operator-owned), the orchestrator workspace is
 * Cebab-owned — but it is just an (empty) directory used as the orchestrator
 * SDK `query()`'s `cwd`. Cebab writes NO files into it: the orchestrator runs
 * with `settingSources: ['user']`, so a workspace `CLAUDE.md` / `comm.md` /
 * `settings.json` would never be loaded by the SDK. The orchestrator learns
 * the bus protocol entirely from the per-turn roster prompt
 * (`renderRosterPrompt` in runtime.ts) — the only prompt it actually sees.
 * (A static CLAUDE.md template + generated comm.md used to live here; both
 * were dead under `settingSources: ['user']` and have been removed.)
 *
 * The legacy global `~/.cebab/orchestrator/` path is the default `targetDir`
 * for callers that don't pass one (pre-007 backwards compat + unit tests).
 * Post-007 sessions pass `<sessionFolder>/orchestrator/` so each session has
 * its own orchestrator workspace directory.
 *
 * The runtime half (below the generator) is the pure-SDK orchestrator: each
 * participant — and the orchestrator itself — is an in-process SDK `query()`
 * driven by the shared `AgentRunner`. No tmux, no TUI, no Stop hook, no file
 * IPC. The routing brain (`createOrchestratorRouter`) keeps its F2/F3 source-
 * allowlist filters verbatim; only its I/O boundary changed (in-process
 * `bus_send` in, `deliver()` out — see chain.ts for the symmetric story).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  appendMultiAgentEvent,
  appendMultiAgentMutation,
  addParticipant,
  confirmMutationByToolUseId,
  createMultiAgentSession,
  endMultiAgentSession,
  getMultiAgentSession,
  getPendingMutation,
  getPendingRetry,
  getProjectBusState,
  recordSessionTeardown,
  setAwaitingContinue,
  setMultiAgentSessionLifecycle,
  setMutationsAcknowledged,
  setMutationPromoted,
  setPauseOnDangerous,
  setPendingMutation,
  setPendingRetry,
  upsertAgentSession,
  type EventKind,
  type MultiAgentLifecycle,
  type MutationRecord,
} from '../repo/multi_agent.js';
import { classifyArtifact } from '@cebab/shared';
import type { BashClassifierReason } from '@cebab/shared';
import type {
  NotificationEnvelope,
  PendingRetryDescriptor,
  RouterDropReasonCode,
} from '@cebab/shared/protocol';
import { emit as emitNotification } from '../notifications/dispatcher.js';
import { appendRecoveryLog } from '../repo/recovery_log.js';
import { PausedForMutationError, isPausedForMutation, isTurnStalled } from './errors.js';
import { shouldPauseForMutation } from './pause_gate.js';
import { computeSessionPaths, orchestratorWorkspaceDir, type SessionPaths } from './paths.js';
import { installBusForProject, uninstallBusForProject } from './install.js';
import {
  CEBAB_SOURCE,
  nextIterationId,
  prepareIterationDir,
  readProjectClaudeMd,
  renderRosterPrompt,
  renderRosterUpdate,
  renderWorkerBriefing,
  resolveAgent,
  SINK_RECIPIENT,
  USER_RECIPIENT,
  type MultiAgentEndedReason,
  type ProjectRules,
  type ResolvedAgent,
} from './runtime.js';
import { AgentRunner, type AgentRunnerDeps, type BusEvent } from './runner.js';
import { parkQuestion, rejectQuestionsForSession } from './pending_questions.js';
import { createAgentActivityObserver, type ActivitySnapshot } from './activity.js';
import {
  getLiveSession,
  NOOP_SINK,
  registerLiveSession,
  unregisterLiveSession,
  type BusSink,
} from './session_registry.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** Bus agent name for the orchestrator. Reserved; no project may use it. */
export const ORCHESTRATOR_AGENT_NAME = 'orchestrator';

/**
 * Hard cap on total persisted hops (`multi_agent_events` rows) per session,
 * cumulative across user prompts. When `events.length` reaches the budget
 * inside `createOrchestratorRouter` / `createChainRouter`, the router
 * appends a synthetic `cebab → _sink kind=error` event explaining the
 * stop and tears down with `reason='stopped'`. The orchestrator's roster
 * prompt also surfaces this number so the LLM can self-pace.
 *
 * Default 30 is sized for a typical 2-3 worker orchestrator session
 * (5-worker handshakes need ~10 hops just to collect capability replies,
 * so 8 — the original value — was too tight in practice). Operators with
 * larger rosters bump via Settings or the `CEBAB_HOP_BUDGET` env var.
 */
export const DEFAULT_HOP_BUDGET = 30;

/**
 * Ensure the orchestrator workspace directory exists.
 *
 * It is only a `cwd` for the orchestrator's SDK `query()` — Cebab writes
 * nothing into it. The orchestrator runs with `settingSources: ['user']`,
 * so a workspace `CLAUDE.md` / `comm.md` / `settings.json` would never be
 * loaded; the bus protocol reaches it solely via the per-turn roster prompt
 * (`renderRosterPrompt`). Idempotent (`recursive: true`).
 *
 * `targetDir` is the per-session `<sessionFolder>/orchestrator/`; callers
 * that omit it (pre-007 / unit tests) get the legacy global path.
 */
export function ensureOrchestratorWorkspace(targetDir?: string): void {
  const wsDir = targetDir ?? orchestratorWorkspaceDir();
  fs.mkdirSync(wsDir, { recursive: true });
}

// ============================================================================
// Orchestrator-routed session runtime (Pattern A) — pure-SDK.
// ============================================================================
//
// The orchestrator is itself an AgentRunner participant (cwd = its Cebab-
// generated workspace). Workers are participants too. Routing:
//   - dest=user         → forwarded to the operator's chat (sink.onEvent);
//                          only the orchestrator may address the user.
//   - dest=orchestrator → deliver a turn to the orchestrator.
//   - dest=worker       → deliver a turn to that worker.
//   - dest=_sink        → not used in orchestrator mode (warn).
// The initial roster prompt + user prompt are delivered as the
// orchestrator's first turn (was: written to its inbox; the Stop hook is
// gone). Mid-run user prompts and added-worker roster updates take the same
// path via `sendUserPrompt` / `addWorker`.

export type StartOrchestratorOpts = {
  workers: ResolvedAgent[];
  initialPrompt: string;
  workspaceRoot: string;
  lifecycle?: MultiAgentLifecycle;
  onEvent: (sessionId: string, ev: BusEvent, dbEventId: number) => void;
  onEnded: (sessionId: string, reason: MultiAgentEndedReason, iterationId: string | null) => void;
  /** Ephemeral per-turn liveness tick → `agent_activity` ServerMsg.
   *  `sessionId` explicit (same convention as `onEvent`). Optional: the
   *  resume/reconstruct paths don't pass it (heartbeat resumes on the next
   *  fresh start; see the `agent_activity` protocol JSDoc). */
  onActivity?: (sessionId: string, snap: ActivitySnapshot) => void;
  /** Hard cap on total persisted hops (cumulative `multi_agent_events`
   *  rows) for this session. When reached, the router persists a synthetic
   *  `cebab → _sink kind=error` event explaining the stop and tears down
   *  with `reason='stopped'`. Caller resolves precedence (DB setting >
   *  `CEBAB_HOP_BUDGET` env > `DEFAULT_HOP_BUDGET`); omit to use the
   *  default. */
  hopBudget?: number;
  /** Per-session pending-retry slot change → `multi_agent_pending_retry`
   *  ServerMsg. Fires when a worker's deliverTurn fails (set) and after a
   *  successful retry or abandon (clear). Optional; the router null-checks
   *  before invoking. */
  onPendingRetry?: (sessionId: string, pending: PendingRetryDescriptor | null) => void;
  /**
   * Item #5: opt-in pause-on-first-mutation. When `true`, the bus runner's
   * mutation tap fires `awaiting_continue` + a banner before the first
   * non-`read` tool call from any worker. Persisted into
   * `multi_agent_sessions.pause_on_dangerous` at session start; survives R-B.
   * Default `false` (resolved at `start_multi_agent` handler from
   * `msg.pauseOnDangerous`).
   */
  pauseOnDangerous?: boolean;
  /**
   * Item #5: per-mutation hook → `multi_agent_mutation` ServerMsg. Fires for
   * every non-`read` tool call observed on the bus, AFTER the row is
   * persisted into `multi_agent_mutations`. Optional; the wire layer
   * null-checks before invoking.
   */
  onMutation?: (sessionId: string, mutation: MutationRecord) => void;
  /**
   * Item #5: per-session pending-mutation slot change → `multi_agent_pending_mutation`
   * ServerMsg. Fires when a worker is paused (set, with the offending
   * mutation row) and when the operator clicks Continue (cleared,
   * `pending: null`). Optional; the wire layer null-checks.
   */
  onPendingMutation?: (sessionId: string, pending: MutationRecord | null) => void;
  /**
   * Cluster A Phase 3 (D4): dispatcher notification fan-out — the orchestrator
   * router calls this on every F2/F3 source-allowlist drop AFTER the
   * `safety_audit` row is written (BE-1). The WS layer wires it to
   * `send(conn.ws, env)`; `attemptResumeMultiAgent` rebinds it on reconnect.
   */
  sendNotification?: BusSink['sendNotification'];
  /** Cluster A Phase 3 (D4): forward-compat typed `router_drop` ServerMsg
   *  fan-out for non-toast consumers. */
  sendRouterDrop?: BusSink['sendRouterDrop'];
  /** Cluster A Phase 4: generic ServerMsg sender for new typed events
   *  (dangerous-mutation safety toast, future bus-runtime events) and
   *  dispatcher.emit. Threaded into the router's BusSink. */
  sendServerMsg?: BusSink['sendServerMsg'];
  /** PR-7: the saved-template id this run was started from, if any. Stamped
   *  onto the row so the templates UI's "Last run" rail can SELECT by
   *  template later. Absent for ad-hoc runs. */
  templateId?: string;
};

export type ResumeOrchestratorOpts = {
  sessionId: string;
  onEvent: StartOrchestratorOpts['onEvent'];
  onEnded: StartOrchestratorOpts['onEnded'];
  /** Cluster A Phase 3: rebind sink callbacks on reconnect so router drops
   *  continue to reach the new WS sink. Optional for tests + legacy callers. */
  sendNotification?: BusSink['sendNotification'];
  sendRouterDrop?: BusSink['sendRouterDrop'];
  /** Cluster A Phase 4: generic ServerMsg sender for the rebound sink. */
  sendServerMsg?: BusSink['sendServerMsg'];
};

export type AddWorkerResult = {
  agentName: string;
  busWasAlreadyInstalled: boolean;
};

export type OrchestratorSessionHandle = {
  sessionId: string;
  iterationId: string;
  participantAgentNames: string[];
  lifecycle: MultiAgentLifecycle;
  sessionFolder: string;
  /** Resolved hop budget for this session. Surfaced so the WS layer can put
   *  it on the wire in `multi_agent_started`; UI reads `events.length /
   *  hopBudget` for the activity-bar chip. */
  hopBudget: number;
  /** Item #5: resolved pause-on-first-mutation flag for this session. */
  pauseOnDangerous: boolean;
  stop: (reason: MultiAgentEndedReason) => Promise<void>;
  sendUserPrompt: (text: string) => Promise<void>;
  detach: () => void;
  addWorker: (projectId: number) => Promise<AddWorkerResult>;
  setLifecycle: (lifecycle: MultiAgentLifecycle) => Promise<void>;
  getCurrentWorkerNames: () => readonly string[];
  getCurrentLifecycle: () => MultiAgentLifecycle;
  /** Re-deliver the captured prompt of the worker named in this session's
   *  pending-retry slot. No-op when the slot is empty (idempotent). The
   *  slot is cleared BEFORE re-delivery so a racing second click no-ops. */
  retry: () => Promise<void>;
  /**
   * Item #5: operator clicked Continue on the pause-on-first-mutation
   * banner. Clears the pending-mutation slot, sets
   * `mutations_acknowledged=1`, clears `awaiting_continue`, re-delivers the
   * paused worker's last captured prompt. No-op when no pause is active.
   */
  continueThroughMutation: () => Promise<void>;
  /**
   * Cluster C Phase 4b: flip the orchestrator router's in-memory mute set
   * for an agent. Returns the router's `setMute` result — true iff the
   * set changed. The WS handler calls this AFTER persisting the DB flip
   * (per_agent_control.setParticipantMuted) so the durable source of
   * truth and the hot-path mirror stay aligned.
   *
   * isMuted is a read-only probe — used by the bus_send oracle-suppression
   * branch (`bus/runner.ts`) to decide whether to short-circuit with the
   * "delivered to <recipient>" white lie.
   */
  setMute: (agentName: string, muted: boolean) => boolean;
  isMuted: (agentName: string) => boolean;
  /**
   * Cluster C Phase 4c: install / release the per-agent pause gate in
   * the AgentRunner. The WS handler calls these AFTER persisting the
   * pause to `multi_agent_participants.paused_until` so the durable
   * source-of-truth is in place if the process dies mid-pause (R-B
   * reconstruct rehydrates from the column).
   *
   * Returns true iff the gate state changed (re-pause / re-resume return
   * false). The handler surfaces false as `already_in_state`.
   *
   * `getPendingDeliveries` is the AE-5 observability hook — the
   * `participant_pause_changed` ServerMsg carries this count so the
   * operator can see "this paused worker is sitting on N pending
   * inbound messages."
   */
  pauseAgent: (agentName: string) => boolean;
  resumeAgent: (agentName: string) => boolean;
  getPendingDeliveries: (agentName: string) => number;
  /**
   * Cluster C Phase 4d: flip the orchestrator router's in-memory kicked set.
   * Returns true iff the set changed (re-kick returns false — handler
   * surfaces as `participant_already_kicked`).
   *
   * Kick is BIDIRECTIONAL: the router drops events where the kicked agent
   * is `ev.source` (drain in progress; bus_send calls from the in-flight
   * turn) AND where it's `ev.destination` (stale routing attempts at the
   * kicked agent). Mute is one-way (source only); kick removes the
   * participant from active routing entirely.
   *
   * Drain semantics (drain mode, the only v1-supported mode):
   *   - In-flight turn at kick time keeps running — `AgentRunner` is NOT
   *     told to abort. The router-side drops are the only enforcement.
   *   - bus_send calls the draining turn issues return their "delivered to
   *     <recipient>" white lie (same oracle-suppression pattern as mute,
   *     by-construction in `bus/runner.ts:handleBusSend`).
   *   - No new turns ever start for the kicked agent because the router
   *     drops every event addressed to it before the `deliver?.()` call.
   *
   * The WS handler calls this AFTER persisting the DB flip
   * (per_agent_control.setParticipantKicked) so the durable source-of-
   * truth is in place before the in-memory hot-path mirror flips.
   *
   * Hard-mode kick (per-agent AbortController) is out of v1 — handler
   * returns `hard_kill_unsupported_v1` for `mode='hard'`.
   */
  kickAgent: (agentName: string) => boolean;
  isKicked: (agentName: string) => boolean;
};

type OrchestratorRouter = {
  teardown: (reason: MultiAgentEndedReason) => Promise<void>;
  handleEvent: (ev: BusEvent) => void;
  forwardCebabEvent: (ev: BusEvent) => void;
  sendUserPrompt: (text: string) => Promise<void>;
  detach: () => void;
  rebind: (sink: BusSink) => void;
  registerWorker: (agentName: string) => void;
  getWorkerNames: () => readonly string[];
  setLifecycle: (lifecycle: MultiAgentLifecycle) => void;
  getLifecycle: () => MultiAgentLifecycle;
  /** Called by `deliver`'s .catch when a worker's `deliverTurn` rejects
   *  (iterator throw OR non-success `result.subtype` — the runner unifies
   *  both). Persists a synthetic `cebab → user kind=error` event, writes
   *  the pending-retry slot, and emits `onPendingRetry`. Does NOT teardown
   *  — the session stays `running` waiting for Retry or Abandon. */
  onWorkerFailed: (agentName: string, prompt: string, err: unknown) => void;
  /** Called by `deliver`'s .then when an agent's `deliverTurn` resolves. If a
   *  pending-retry slot is currently owned by that agent, it is stale (the
   *  agent just recovered) — clear it and emit `onPendingRetry(null)`. This is
   *  the "success clears" half documented in migration 010, without which a
   *  transient-error banner survives even after the agent delivers a `final`. */
  onTurnSucceeded: (agentName: string) => void;
  /**
   * Cluster C Phase 4b: flip the in-memory mute set. Returns true iff the
   * set changed (re-mute / re-unmute are no-ops returning false — handler
   * uses this to decide whether to fan the state-change ServerMsg).
   *
   * Caller MUST have already flipped `multi_agent_participants.muted` (the
   * source of truth) before invoking this — the in-memory set is a hot-
   * path mirror. R-A/R-B reconstruct passes the seed via the factory's
   * `initialMutedAgents` param instead of calling setMute per agent.
   */
  setMute: (agentName: string, muted: boolean) => boolean;
  /** Snapshot of currently muted agent slugs. Used by tests + the
   *  forensic-bundle multi-agent path (a future C4f slice). */
  isMuted: (agentName: string) => boolean;
  /**
   * Cluster C Phase 4d: flip the in-memory kicked set. Returns true iff
   * the set changed; the WS handler treats false as a no-op idempotent
   * acknowledgment of a re-kick (the DB column is already kicked).
   *
   * Caller MUST have already flipped `multi_agent_participants.kicked_at`
   * (the source of truth) before invoking this — the in-memory set is a
   * hot-path mirror. R-A/R-B reconstruct passes the seed via the
   * factory's `initialKickedAgents` param instead of calling kickAgent
   * per agent (matches mute's reseed pattern).
   */
  kickAgent: (agentName: string) => boolean;
  /** Probe for tests + multi-agent forensic bundle (C4f follow-up). */
  isKicked: (agentName: string) => boolean;
};

/**
 * Build the orchestrator event router. Pure routing/persistence — does NOT
 * own the AgentRunner (security tests construct it standalone). `deliver` is
 * the injected AgentRunner-backed wake; omitted in unit tests, which only
 * drive the F2/F3 drop + allowlist paths.
 */
export function createOrchestratorRouter(params: {
  sessionId: string;
  iterationId: string;
  workerNames: string[];
  paths: SessionPaths;
  lifecycle: MultiAgentLifecycle;
  onEvent: StartOrchestratorOpts['onEvent'];
  onEnded: StartOrchestratorOpts['onEnded'];
  onTeardown?: (reason: MultiAgentEndedReason) => Promise<void>;
  /** Always-run finalizer (stop/crash/completion), independent of
   *  `onTeardown`'s temp/crashed gating and of sink detach/rebind. Disposes
   *  the liveness observer. */
  onFinalize?: () => void;
  deliver?: (agentName: string, text: string) => void;
  /** Hard cap on persisted hops. Required so the router enforces the
   *  ceiling; the caller resolves precedence. */
  hopBudget: number;
  /** R-B reconstruction seed: the number of persisted hops already in the
   *  DB for this session before this router started. Defaults to 0 (fresh
   *  start). `wireOrchestratorSession` reads it from the persisted events
   *  table so the budget check accounts for hops that landed in the prior
   *  process. */
  initialHopsCount?: number;
  /** Optional pending-retry set/clear sink (Item #4). Threaded onto
   *  `BusSink.onPendingRetry` so rebind/detach honor the plumbing. */
  onPendingRetry?: StartOrchestratorOpts['onPendingRetry'];
  /** Cluster A Phase 3 (D4): dispatcher notification fan-out for router
   *  drops (and any other bus-runtime-originated toast). Threaded onto
   *  `BusSink.sendNotification` so the rebind/detach plumbing is shared. */
  sendNotification?: BusSink['sendNotification'];
  /** Cluster A Phase 3 (D4): forward-compat typed `router_drop` ServerMsg
   *  for non-toast consumers. Threaded onto `BusSink.sendRouterDrop`. */
  sendRouterDrop?: BusSink['sendRouterDrop'];
  /** Cluster A Phase 4: generic ServerMsg sender. Threaded onto
   *  `BusSink.sendServerMsg` so the rebound sink keeps shipping the
   *  dangerous-mutation safety toast + future bus-runtime events. */
  sendServerMsg?: BusSink['sendServerMsg'];
  /**
   * Cluster C Phase 4b: seed the in-memory `mutedSet` from durable state.
   * Used by R-A (browser reattach) + R-B (server restart) so a muted
   * worker stays muted across resumption. The WS handler is responsible
   * for keeping the DB column + this set in sync at mute/unmute time
   * via `setMute()`; this param is the one-shot reseed.
   */
  initialMutedAgents?: readonly string[];
  /**
   * Cluster C Phase 4d: seed the in-memory `kickedSet` from durable state.
   * Parallel to `initialMutedAgents` — R-A (browser reattach) + R-B
   * (server restart) read every participant's
   * `multi_agent_participants.kicked_at IS NOT NULL` rows and pass the
   * agent slugs here so kicked workers stay kicked across resumption.
   * The WS handler keeps the column + this set in sync via `kickAgent`;
   * this param is the one-shot reseed.
   *
   * v1 wireOrchestratorSession callers don't read this yet (matches the
   * mute reseed pattern from C4b — both reseed paths land together in
   * a future R-A/R-B-control-state slice).
   */
  initialKickedAgents?: readonly string[];
}): OrchestratorRouter {
  const {
    sessionId,
    iterationId,
    workerNames,
    onTeardown,
    onFinalize,
    deliver,
    hopBudget,
    initialHopsCount,
  } = params;
  const workerNamesMut: string[] = [...workerNames];
  const workerSet = new Set(workerNamesMut);
  let lifecycleRef: MultiAgentLifecycle = params.lifecycle;
  /**
   * Cluster C Phase 4b (spec §3 invariant 1 + AE-1): set of agent slugs the
   * operator has muted. Router drops every BusEvent where `ev.source` is
   * a member; `ev.destination` traffic still routes through (mute is a
   * one-way authority change — the muted agent keeps receiving, just
   * can't be heard). Per spec §5.4 the source of truth is the
   * `multi_agent_participants.muted` column; this in-memory set is the
   * hot-path mirror so the router doesn't hit SQLite per event. The
   * caller (WS handler) flips the column FIRST, then calls `setMute`
   * to update this set — so a server restart followed by R-B
   * reconstruction can reseed from the DB without losing operator
   * intent.
   */
  const mutedSet: Set<string> = new Set(params.initialMutedAgents ?? []);
  /**
   * Cluster C Phase 4d (spec §3 invariant 1 + §5.1 kick semantics): set of
   * agent slugs the operator has kicked. Unlike `mutedSet` (one-way: drop
   * when `ev.source` matches), the router consults this set for BOTH
   * directions — drop where `ev.source` is a kicked agent (drain-in-
   * progress outbound) AND where `ev.destination` is a kicked agent
   * (stale routing attempts that would re-engage the participant).
   *
   * Source of truth: `multi_agent_participants.kicked_at IS NOT NULL`
   * column. This in-memory set is the hot-path mirror so the router
   * doesn't hit SQLite per event. The WS handler flips the column FIRST
   * (irreversibly — no `unkick`), then calls `kickAgent` to update
   * this set. A server restart + R-B reconstruction reseeds via the
   * factory's `initialKickedAgents` param (matches the mute reseed
   * pattern; the read path lands in a future R-A/R-B-control-state
   * slice).
   */
  const kickedSet: Set<string> = new Set(params.initialKickedAgents ?? []);

  let sink: BusSink = {
    onEvent: params.onEvent,
    onEnded: params.onEnded,
    onPendingRetry: params.onPendingRetry,
    sendNotification: params.sendNotification,
    sendRouterDrop: params.sendRouterDrop,
    sendServerMsg: params.sendServerMsg,
  };
  let ended = false;
  // Cumulative count of persisted `multi_agent_events` rows for this session.
  // Bumped on every successful append (both `handleEvent` and
  // `forwardCebabEvent`) so it stays in lockstep with `run.events.length` as
  // the UI sees it. The synthetic budget-exhausted event is written inline
  // below and intentionally does NOT bump this counter (it lives in DB/wire
  // as event N+1 while the displayed ratio reads `hopBudget/hopBudget` at
  // the moment of refusal). On R-B reconstruction this is seeded from the
  // DB so the budget check carries over from the prior process — without
  // that, a near-cap session resumed after a server restart would silently
  // re-open the floodgates.
  let hopsCount = initialHopsCount ?? 0;
  // PR-7: first error captured during this session, surfaced post-teardown
  // on the "Last run" rail (red chip + excerpt). Sources: (a) the synthetic
  // budget-exhausted error appended in `checkBudgetExhausted`, (b) any
  // kind='error' bus event observed in `handleEvent`, (c) a worker-failed
  // path that takes the `crashed` branch. Truncated to 200 chars at capture
  // time so an enormous stack trace doesn't bloat memory; the repo helper
  // re-truncates defensively at write time too.
  let firstError: string | null = null;
  const captureError = (text: string) => {
    if (firstError !== null) return; // only the FIRST error sticks
    firstError = text.slice(0, 200);
  };

  const teardown = async (reason: MultiAgentEndedReason) => {
    if (ended) return;
    ended = true;
    // First: kill any pending liveness timer so it can't fire a spurious
    // `stalled` mid-teardown. Always runs, exactly once (ended-guarded).
    try {
      onFinalize?.();
    } catch (err) {
      console.error('[orchestrator] onFinalize failed', err);
    }
    try {
      endMultiAgentSession(sessionId, reason === 'completed' ? 'completed' : reason);
    } catch (err) {
      console.error('[orchestrator] endMultiAgentSession failed', err);
    }
    // PR-7: record final hops_used + first_error so the templates UI's
    // "Last run" rail can render hops_used/hop_budget + the "at cap" /
    // "failed · <excerpt>" chips. Wrapped in try/catch so a stale row id
    // (e.g. session row was cleared mid-teardown by a racing migration)
    // can't break the teardown sequence.
    try {
      recordSessionTeardown(sessionId, { hopsUsed: hopsCount, firstError });
    } catch (err) {
      console.error('[orchestrator] recordSessionTeardown failed', err);
    }
    if (onTeardown && reason !== 'crashed' && lifecycleRef === 'temp') {
      try {
        await onTeardown(reason);
      } catch (err) {
        console.error('[orchestrator] onTeardown failed', err);
      }
    }
    unregisterLiveSession(sessionId);
    sink.onEnded(sessionId, reason, iterationId);
  };

  // Hop-budget enforcement: returns true iff we have hit (or are past) the
  // cap and the caller should refuse to wake the next agent. Side effect on
  // first true: appends a synthetic `cebab → _sink kind=error` event so the
  // trail explains the stop, then calls `teardown('stopped')`. Persist+wire
  // inline (NOT via `forwardCebabEvent`) so the count doesn't also bump for
  // the error itself — the displayed ratio reads exactly
  // `hopBudget/hopBudget` at the moment of refusal. F3 normally drops
  // `source=cebab` in `handleEvent`; bypassing here mirrors the same
  // pattern `forwardCebabEvent` uses for legitimate Cebab traffic.
  const checkBudgetExhausted = (): boolean => {
    if (hopsCount < hopBudget) return false;
    if (ended) return true; // already torn down by a previous trip; just block
    const reasonText = `Hop budget exhausted (${hopsCount}/${hopBudget}). The session was stopped to prevent a runaway loop. Raise the limit in Settings or via the CEBAB_HOP_BUDGET env var to extend.`;
    // PR-7: the budget-exhausted text IS this session's first error.
    // Capturing here (not inside teardown) makes the source explicit and
    // covers the case where `firstError` is still null because no earlier
    // worker-emitted error tripped.
    captureError(reasonText);
    try {
      const row = appendMultiAgentEvent(
        sessionId,
        CEBAB_SOURCE,
        SINK_RECIPIENT,
        'error',
        reasonText,
      );
      sink.onEvent(
        sessionId,
        {
          ts: Date.now(),
          source: CEBAB_SOURCE,
          destination: SINK_RECIPIENT,
          kind: 'error',
          text: reasonText,
        },
        row.id,
      );
    } catch (err) {
      console.error('[orchestrator] persist budget-exhausted event failed', err);
    }
    void teardown('stopped');
    return true;
  };

  /**
   * Cluster A Phase 3 (D4): on every F2/F3 router-drop, write a safety_audit
   * row + fan an operator-facing safety notification. The console.warn lines
   * below were the silent-async source the new dock + audit log close. The
   * dispatcher enforces BE-1 (audit row written BEFORE the WS envelope ships)
   * and BE-2 (safety class never coalesces at the recording layer — 200 drops
   * = 200 audit rows even though the UI may collapse them to "×200" via
   * dedupeKey).
   *
   * `console.warn` is kept as a developer-facing breadcrumb (operators rarely
   * tail server logs) — the source of truth is the audit row + dock toast.
   */
  const dispatchRouterDrop = (params: {
    reasonCode: RouterDropReasonCode;
    source: string;
    destination: string;
    kind: string;
    title: string;
    message: string;
  }) => {
    const result = emitNotification(
      {
        class: 'safety',
        severity: 'danger',
        dedupeKey: `router_drop:${params.reasonCode}:${sessionId}`,
        title: params.title,
        message: params.message,
        sessionId,
        reasonCode: params.reasonCode,
        auditKind: 'router.drop',
        auditPayload: {
          source: params.source,
          destination: params.destination,
          kind: params.kind,
        },
      },
      (msg) => {
        if (msg.type === 'notification') {
          sink.sendNotification?.(msg as NotificationEnvelope & { type: 'notification' });
        }
      },
    );
    if (result.ok) {
      sink.sendRouterDrop?.({
        sessionId,
        reasonCode: params.reasonCode,
        source: params.source,
        destination: params.destination,
        kind: params.kind,
        auditRowId: result.id,
      });
    } else {
      // BE-1: audit write failed — the dispatcher refuses to emit and we log
      // so an operator tailing the server has a chance to notice. The agent
      // action that triggered the drop is already being refused (we return
      // early from handleEvent below regardless).
      console.error('[orchestrator] router_drop dispatcher.emit failed', result.error);
    }
  };

  const handleEvent = (ev: BusEvent) => {
    if (ended) return;
    // F3: source=cebab arriving through an agent is a forgery (Cebab routes
    //     its own traffic in-process via forwardCebabEvent).
    if (ev.source === CEBAB_SOURCE) {
      console.warn(
        `[orchestrator] drop forged source=cebab dest=${ev.destination} kind=${ev.kind}`,
      );
      dispatchRouterDrop({
        reasonCode: 'forged_source',
        source: ev.source,
        destination: ev.destination,
        kind: ev.kind,
        title: 'Forged source=cebab dropped',
        message: `dest=${ev.destination} kind=${ev.kind}`,
      });
      return;
    }
    // F2: only the orchestrator may address the user.
    if (ev.destination === USER_RECIPIENT && ev.source !== ORCHESTRATOR_AGENT_NAME) {
      console.warn(`[orchestrator] drop dest=user from non-orchestrator source=${ev.source}`);
      dispatchRouterDrop({
        reasonCode: 'worker_to_user',
        source: ev.source,
        destination: ev.destination,
        kind: ev.kind,
        title: 'Worker tried to address user directly',
        message: `from=${ev.source}`,
      });
      return;
    }
    // F2: workers must reply via the orchestrator — no worker→worker.
    if (workerSet.has(ev.source) && workerSet.has(ev.destination)) {
      console.warn(`[orchestrator] drop worker→worker ${ev.source}→${ev.destination}`);
      dispatchRouterDrop({
        reasonCode: 'worker_to_worker',
        source: ev.source,
        destination: ev.destination,
        kind: ev.kind,
        title: 'Worker→worker bypass dropped',
        message: `${ev.source} → ${ev.destination}`,
      });
      return;
    }
    // F2 round-2: source must be the orchestrator or a known worker.
    if (ev.source !== ORCHESTRATOR_AGENT_NAME && !workerSet.has(ev.source)) {
      console.warn(`[orchestrator] drop event from non-participant source=${ev.source}`);
      dispatchRouterDrop({
        reasonCode: 'unknown_source',
        source: ev.source,
        destination: ev.destination,
        kind: ev.kind,
        title: 'Unknown source on bus',
        message: `source=${ev.source}`,
      });
      return;
    }
    // Cluster C Phase 4d (spec §5.1 kick semantics): kick drop. Runs
    // BEFORE the mute drop so a participant that is both muted AND
    // kicked surfaces the more-severe kick reason code in the
    // router_drop forensics. The order doesn't change the routing
    // outcome — both checks return — but it keeps the operator's view
    // accurate ("this drop is because the participant was kicked, not
    // because it was earlier muted").
    //
    // Bidirectional: drop where `ev.source` is kicked (drain-in-
    // progress outbound from the dying in-flight turn) OR where
    // `ev.destination` is kicked (stale routing attempt that would
    // re-engage the participant). Source check runs first so the
    // drop-row carries the cleaner reason — "this is the kicked
    // agent talking" vs "someone tried to talk to the kicked agent."
    //
    // Same oracle-suppression invariant as mute: the kicked agent's
    // `bus_send` returns the white-lie "delivered to <recipient>"
    // by-construction at `bus/runner.ts:handleBusSend`, so the
    // draining turn has no visible signal that its outbound was
    // dropped. AE-3 [security] still holds.
    if (kickedSet.has(ev.source)) {
      console.warn(
        `[orchestrator] drop kicked source=${ev.source} dest=${ev.destination} kind=${ev.kind}`,
      );
      dispatchRouterDrop({
        reasonCode: 'kicked_source',
        source: ev.source,
        destination: ev.destination,
        kind: ev.kind,
        title: `Kicked ${ev.source} tried to emit ${ev.kind}`,
        message: `${ev.source} → ${ev.destination}: ${ev.text.slice(0, 80)}`,
      });
      return;
    }
    if (kickedSet.has(ev.destination)) {
      console.warn(
        `[orchestrator] drop event to kicked dest=${ev.destination} source=${ev.source} kind=${ev.kind}`,
      );
      dispatchRouterDrop({
        reasonCode: 'kicked_destination',
        source: ev.source,
        destination: ev.destination,
        kind: ev.kind,
        title: `Stale routing to kicked ${ev.destination}`,
        message: `${ev.source} → ${ev.destination}: ${ev.text.slice(0, 80)}`,
      });
      return;
    }
    // Cluster C Phase 4b (spec §3 invariant 1 + AE-1): mute drop. Runs
    // AFTER the F2/F3 forgery + topology checks (those are defense-in-
    // depth that should fire on any pathological event regardless of
    // mute state) and BEFORE the persist + sink.onEvent below — a muted
    // event is conceptually "as if it never happened" from the routing
    // perspective, so it doesn't bump hopsCount and doesn't render in
    // the operator's transcript. The router_drop dispatch + safety_audit
    // addendum DO fire so the operator can still see "muted X tried to
    // emit a kind=reply" in the forensics view, but the muted agent's
    // bus_send call returns the "delivered to <recipient>" white lie
    // (oracle suppression — spec AE-3 [security]) so the agent itself
    // has no signal that its outbound was dropped. That separation
    // lives in `bus/runner.ts`'s bus_send wiring — this handler is just
    // the routing-layer drop point.
    if (mutedSet.has(ev.source)) {
      console.warn(
        `[orchestrator] drop muted source=${ev.source} dest=${ev.destination} kind=${ev.kind}`,
      );
      dispatchRouterDrop({
        reasonCode: 'muted_source',
        source: ev.source,
        destination: ev.destination,
        kind: ev.kind,
        title: `Muted ${ev.source} tried to emit ${ev.kind}`,
        message: `${ev.source} → ${ev.destination}: ${ev.text.slice(0, 80)}`,
      });
      return;
    }

    let dbId = 0;
    try {
      const row = appendMultiAgentEvent(
        sessionId,
        ev.source,
        ev.destination,
        ev.kind as EventKind,
        ev.text,
      );
      dbId = row.id;
      hopsCount += 1;
    } catch (err) {
      console.error('[orchestrator] persist event failed', err);
    }
    // PR-7: capture kind='error' events as the run's first_error. F2/F3
    // filters above have already dropped forged source=cebab and bad
    // routing — anything reaching this point is a legitimate participant
    // error worth surfacing on the rail.
    if (ev.kind === 'error') {
      captureError(ev.text);
    }
    try {
      sink.onEvent(sessionId, ev, dbId);
    } catch (err) {
      console.error('[orchestrator] onEvent callback threw', err);
    }

    if (ev.destination === USER_RECIPIENT) {
      // The orchestrator's final-to-user happens without waking another
      // agent. Don't trip the budget here — the session keeps going (the
      // operator may send a follow-up). The next deliver path (user prompt
      // or worker reply) is where enforcement kicks in.
      return;
    }
    if (ev.destination === SINK_RECIPIENT) {
      console.warn(`[orchestrator] unexpected destination=_sink from ${ev.source}`);
      return;
    }
    if (checkBudgetExhausted()) return;
    if (ev.destination === ORCHESTRATOR_AGENT_NAME) {
      deliver?.(ORCHESTRATOR_AGENT_NAME, ev.text);
      return;
    }
    if (workerSet.has(ev.destination)) {
      deliver?.(ev.destination, ev.text);
      return;
    }
    console.warn(`[orchestrator] event for unknown destination: ${ev.destination}`);
  };

  // Cebab-originated events (briefings, roster prompts, user prompts):
  // persist + forward. Bumps `hopsCount` on successful persist so the
  // counter stays in lockstep with `run.events.length`.
  const forwardCebabEvent = (ev: BusEvent) => {
    if (ended) return;
    let dbId = 0;
    try {
      const row = appendMultiAgentEvent(
        sessionId,
        ev.source,
        ev.destination,
        ev.kind as EventKind,
        ev.text,
      );
      dbId = row.id;
      hopsCount += 1;
    } catch (err) {
      console.error('[orchestrator] persist cebab event failed', err);
    }
    try {
      sink.onEvent(sessionId, ev, dbId);
    } catch (err) {
      console.error('[orchestrator] cebab onEvent threw', err);
    }
  };

  const sendUserPrompt = async (text: string) => {
    if (ended) return;
    forwardCebabEvent({
      ts: Date.now(),
      source: CEBAB_SOURCE,
      destination: ORCHESTRATOR_AGENT_NAME,
      kind: 'prompt',
      text,
    });
    // The user's prompt just landed as a persisted hop; check the cap
    // before waking the orchestrator for it.
    if (checkBudgetExhausted()) return;
    deliver?.(ORCHESTRATOR_AGENT_NAME, text);
  };

  const detach = () => {
    sink = NOOP_SINK;
  };
  const rebind = (next: BusSink) => {
    sink = next;
  };
  const registerWorker = (agentName: string) => {
    if (workerSet.has(agentName)) return;
    workerSet.add(agentName);
    workerNamesMut.push(agentName);
  };
  const getWorkerNames = (): readonly string[] => workerNamesMut;
  const setLifecycle = (next: MultiAgentLifecycle) => {
    lifecycleRef = next;
  };
  const getLifecycle = (): MultiAgentLifecycle => lifecycleRef;

  // Worker failure handler (Item #4). The deliver() .catch in
  // wireOrchestratorSession calls this when a worker's deliverTurn rejects
  // (iterator throw OR non-success result.subtype). Persist a synthetic
  // `cebab → user kind=error` event so the trail explains the stop, write
  // the pending-retry slot so the operator (and a post-restart R-B
  // reconstruction) can resume from it, and stay live. Bypasses
  // `forwardCebabEvent` so the error event does NOT bump hopsCount —
  // consistent with the budget-exhaust pattern at `checkBudgetExhausted`.
  // If no last prompt is known (the agent failed before `deliver` was ever
  // called), fall back to crashed teardown — there's nothing to retry.
  const onWorkerFailed = (agentName: string, prompt: string, err: unknown) => {
    if (ended) return;
    const errMessage =
      err instanceof Error ? err.message : typeof err === 'string' ? err : String(err);
    const reasonText = `\`${agentName}\`'s last turn failed: ${errMessage}`;
    // PR-7: a worker failure is a strong "first error" signal. Capture even
    // if the persist below fails — the rail's purpose is to surface failure,
    // and a DB write hiccup shouldn't hide it.
    captureError(reasonText);
    let errorEventId = 0;
    let eventTs = Date.now();
    try {
      const row = appendMultiAgentEvent(
        sessionId,
        CEBAB_SOURCE,
        USER_RECIPIENT,
        'error',
        reasonText,
      );
      errorEventId = row.id;
      eventTs = row.ts;
      try {
        sink.onEvent(
          sessionId,
          {
            ts: eventTs,
            source: CEBAB_SOURCE,
            destination: USER_RECIPIENT,
            kind: 'error',
            text: reasonText,
          },
          row.id,
        );
      } catch (sinkErr) {
        console.error('[orchestrator] worker-failed onEvent threw', sinkErr);
      }
    } catch (persistErr) {
      console.error('[orchestrator] persist worker-failed event failed', persistErr);
    }
    if (!prompt) {
      console.warn(`[orchestrator] worker ${agentName} failed pre-deliver; ending crashed`);
      void teardown('crashed');
      return;
    }
    const descriptor: PendingRetryDescriptor = {
      agentName,
      reason: reasonText,
      lastPrompt: prompt,
      ts: eventTs,
      errorEventId,
    };
    try {
      setPendingRetry(sessionId, {
        agentName,
        prompt,
        reason: reasonText,
        ts: eventTs,
        errorEventId,
      });
    } catch (dbErr) {
      console.error('[orchestrator] persist pending-retry failed', dbErr);
    }
    try {
      sink.onPendingRetry?.(sessionId, descriptor);
    } catch (sinkErr) {
      console.error('[orchestrator] onPendingRetry callback threw', sinkErr);
    }
  };

  // "success clears" (migration 010): a resolved turn means the agent recovered,
  // so a pending-retry slot it OWNS is stale. Symmetric with onWorkerFailed and
  // uses the same `sink.onPendingRetry` channel so the clear reaches whichever
  // client is currently attached. Fully guarded: a DB/callback hiccup here must
  // never bubble into `deliver`'s .catch and be mis-reported as a turn failure.
  const onTurnSucceeded = (agentName: string) => {
    if (ended) return;
    try {
      const pending = getPendingRetry(sessionId);
      if (!pending || pending.agentName !== agentName) return;
      setPendingRetry(sessionId, null);
      try {
        sink.onPendingRetry?.(sessionId, null);
      } catch (sinkErr) {
        console.error('[orchestrator] turn-succeeded onPendingRetry-null threw', sinkErr);
      }
    } catch (err) {
      console.error('[orchestrator] clear pending-retry on success failed', err);
    }
  };

  const setMute = (agentName: string, muted: boolean): boolean => {
    const was = mutedSet.has(agentName);
    if (muted === was) return false;
    if (muted) {
      mutedSet.add(agentName);
    } else {
      mutedSet.delete(agentName);
    }
    return true;
  };
  const isMuted = (agentName: string): boolean => mutedSet.has(agentName);

  // Cluster C Phase 4d: kick is irreversible (no `unkick`), so this is
  // an add-only operation. Returns false on re-kick so the WS handler
  // can surface the `participant_already_kicked` idempotent ack. We
  // accept a boolean for symmetry with `setMute` so a future
  // forensics-replay path that wants to "unkick" the in-memory mirror
  // (for an audit-log scrubbing tool, say) has a place to plug in —
  // production paths only ever pass `true`.
  const setKick = (agentName: string, kicked: boolean): boolean => {
    const was = kickedSet.has(agentName);
    if (kicked === was) return false;
    if (kicked) {
      kickedSet.add(agentName);
    } else {
      kickedSet.delete(agentName);
    }
    return true;
  };
  const isKicked = (agentName: string): boolean => kickedSet.has(agentName);

  return {
    teardown,
    handleEvent,
    forwardCebabEvent,
    sendUserPrompt,
    detach,
    rebind,
    registerWorker,
    getWorkerNames,
    setLifecycle,
    getLifecycle,
    onWorkerFailed,
    onTurnSucceeded,
    setMute,
    isMuted,
    kickAgent: (agentName) => setKick(agentName, true),
    isKicked,
  };
}

function writeTranscript(paths: SessionPaths, iterationId: string, agent: string, msg: SDKMessage) {
  try {
    const dir = paths.iterationDir(iterationId, agent);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'transcript.log'), JSON.stringify(msg) + '\n');
  } catch (err) {
    console.error('[orchestrator] transcript write failed', err);
  }
}

/**
 * Shared wiring for an orchestrator session: AgentRunner + router + handle +
 * live-registry registration. Both a fresh start and an R-B reconstruction
 * go through this ONE function so the F2/F3 routing filters and the
 * handle/closure shape can never drift between the two paths.
 *
 * It does NOT create the DB session/participant rows, allocate an iteration,
 * or deliver any prompt — those differ between start (fresh) and reconstruct
 * (read-only) and are the caller's responsibility.
 *
 * R-B hooks:
 *   - `seededSessions`: pre-load each agent's last-completed CLI session id
 *     so its next turn `--resume`s its real transcript.
 *   - `briefedAgents`: workers that already consumed their one-time briefing
 *     in the prior process (their resumed transcript still contains it) —
 *     don't re-prefix it.
 */
export function wireOrchestratorSession(p: {
  sessionId: string;
  iterationId: string;
  lifecycle: MultiAgentLifecycle;
  paths: SessionPaths;
  workers: ResolvedAgent[];
  onEvent: StartOrchestratorOpts['onEvent'];
  onEnded: StartOrchestratorOpts['onEnded'];
  onActivity?: StartOrchestratorOpts['onActivity'];
  onPendingRetry?: StartOrchestratorOpts['onPendingRetry'];
  onMutation?: StartOrchestratorOpts['onMutation'];
  onPendingMutation?: StartOrchestratorOpts['onPendingMutation'];
  /** Cluster A Phase 3 (D4): dispatcher notification fan-out. */
  sendNotification?: StartOrchestratorOpts['sendNotification'];
  /** Cluster A Phase 3 (D4): typed router_drop fan-out. */
  sendRouterDrop?: StartOrchestratorOpts['sendRouterDrop'];
  /** Cluster A Phase 4: generic ServerMsg sender threaded into the router. */
  sendServerMsg?: StartOrchestratorOpts['sendServerMsg'];
  seededSessions?: ReadonlyArray<{ agentName: string; cliSessionId: string }>;
  briefedAgents?: ReadonlyArray<string>;
  /** Injectable for tests; threaded into the AgentRunner. Defaults to the
   *  real (mock-aware) `pickRunner` when omitted. */
  runnerFactory?: AgentRunnerDeps['runnerFactory'];
  /** Hop budget for this session (caller resolves precedence; omit to use
   *  `DEFAULT_HOP_BUDGET`). */
  hopBudget?: number;
  /** R-B seed: number of persisted hops already in the DB for this
   *  session before this wiring call. The router's in-memory `hopsCount`
   *  starts from this value so enforcement carries over a server restart.
   *  Defaults to 0 (fresh start). */
  initialHopsCount?: number;
  /** Item #5: opt-in pause-on-first-mutation. Surfaced on the handle; read
   *  inside the `onMutation` hook to decide whether to gate. Default false. */
  pauseOnDangerous?: boolean;
  /**
   * Cluster C Phase 4e (R-B reseed): bus_agent_name slugs the operator
   * previously muted, hydrated from `multi_agent_participants.muted` at
   * reconstruct time. Forwarded into `createOrchestratorRouter` so the
   * rebuilt router's `mutedSet` is in sync with durable state from the
   * first event after restart — without this seed, a router_drop filter
   * that depended on operator-set mute state would silently re-enable
   * a muted agent until the next operator action.
   *
   * Fresh-start callers (start_multi_agent) omit this — the router
   * starts with an empty mutedSet.
   */
  initialMutedAgents?: readonly string[];
  /**
   * Cluster C Phase 4e (R-B reseed): bus_agent_name slugs the operator
   * previously kicked. Same shape as `initialMutedAgents` — forwarded
   * into `createOrchestratorRouter` so the rebuilt router's `kickedSet`
   * is restored from `multi_agent_participants.kicked_at IS NOT NULL`
   * rows. Kick is irreversible at the DB layer, so any non-null
   * kicked_at row stays in the seed permanently.
   */
  initialKickedAgents?: readonly string[];
}): {
  handle: OrchestratorSessionHandle;
  router: OrchestratorRouter;
  deliver: (agentName: string, text: string) => void;
} {
  const { sessionId, iterationId, lifecycle, paths } = p;
  const hopBudget = p.hopBudget ?? DEFAULT_HOP_BUDGET;
  const workerNames = p.workers.map((w) => w.agentName);
  const participantAgentNames = [ORCHESTRATOR_AGENT_NAME, ...workerNames];
  const workerProjectIds = p.workers.map((w) => w.projectId);
  const workerProjectNames = new Map<string, string>(
    p.workers.map((w) => [w.agentName, w.projectName]),
  );
  // Each worker's own root CLAUDE.md, read here and injected once on the
  // worker's first turn (see `deliver`). The SDK now also auto-loads it
  // because workers run with `settingSources: ['user', 'project', 'local']`;
  // the explicit injection survives so the bytes show up in the on-disk
  // transcript and the operator's chat (the SDK's load is system-context
  // and doesn't surface). Recomputed automatically on R-B resume since
  // `reconstructOrchestratorSession` rebuilds `p.workers` with
  // each `cwd` and re-enters this function. The orchestrator itself is never
  // in this map — its cwd is the Cebab workspace, not a target project.
  const workerProjectRules = new Map<string, ProjectRules | null>(
    p.workers.map((w) => [w.agentName, readProjectClaudeMd(w.cwd)]),
  );

  const onTeardown = async () => {
    for (const projectId of workerProjectIds) {
      try {
        await uninstallBusForProject(projectId);
      } catch (err) {
        console.warn(`[orchestrator] temp-cleanup uninstall failed for ${projectId}`, err);
      }
    }
    try {
      fs.rmSync(paths.folder, { recursive: true, force: true });
    } catch (err) {
      console.warn('[orchestrator] temp-cleanup rmSync failed', err);
    }
  };

  const abortController = new AbortController();

  // Passive liveness tap on the existing per-turn SDKMessage stream (same
  // observer chain.ts uses). Pure Cebab-side; no agent/prompt/DB change.
  const activity = createAgentActivityObserver((snap) => p.onActivity?.(sessionId, snap));

  // Item #5: per-agent last delivered prompt — captured by `deliver` AFTER
  // the briefing/rules prefix is applied, so the pause-resume path replays
  // the exact wire bytes without double-prepending the briefing. Parallel to
  // PR #71's pending-retry capture for chain mode.
  const lastPrompt = new Map<string, string>();

  // Forward-declared: router ↔ deliver ↔ runner construction cycle (same
  // shape as chain.ts). Reassigned exactly once below.
  // eslint-disable-next-line prefer-const
  let router: OrchestratorRouter;

  // Item #5: mutation tap closure. Fired by the runner's stream tap for every
  // classified non-`read` `tool_use` block, BEFORE the SDK dispatches the
  // tool. Persists the row, fires the live `multi_agent_mutation` sink, and
  // — when pause-on-first-mutation is armed and not yet acknowledged — sets
  // the pending slot, emits `multi_agent_pending_mutation`, and throws
  // `PausedForMutationError` to abort the turn cleanly.
  const onMutationHook: AgentRunnerDeps['onMutation'] = async (agentName, toolName, cwd, cls) => {
    let row: MutationRecord;
    try {
      row = appendMultiAgentMutation(sessionId, agentName, toolName, cls.category, cls.summary, {
        filePath: cls.filePath ?? null,
        cwd,
        toolUseId: cls.toolUseId ?? null,
        // Migration 026: persist the full tool input (capped in the repo) so
        // the Logs drawer can show the complete command/args.
        toolInput: cls.toolInput,
        // Cluster F Phase D5+: persist the guardrail-violation verdict
        // alongside the mutation so R-A/R-B replays show the badge.
        // Both fields are NULL when in-scope — `?? null` on both keeps
        // the column write symmetric.
        guardrailViolationPath: cls.guardrailViolation?.violatedPath ?? null,
        guardrailReason: cls.guardrailViolation?.reasonCode ?? null,
        // Cluster F Phase F3: persist the Bash classifier rationale so
        // the MutationsDisclosure tooltip survives R-A/R-B replay. NULL
        // for non-Bash mutations (the tool name is the rationale). Cast
        // narrows `rule: string` from the runner-hook payload back to
        // the BashClassifierReason discriminated union expected by the
        // repo; the rule strings come from `classifyToolCall` so they
        // are always in the union.
        classifierReason: cls.classifierReason
          ? {
              rule: cls.classifierReason.rule as BashClassifierReason['rule'],
              detail: cls.classifierReason.detail,
              matched: cls.classifierReason.matched,
            }
          : null,
      });
    } catch (err) {
      console.error('[orchestrator] persist mutation failed', err);
      return;
    }
    try {
      p.onMutation?.(sessionId, row);
    } catch (err) {
      console.error('[orchestrator] onMutation sink threw', err);
    }
    // Pause gate — fires only on `dangerous`-category mutations (see
    // `shouldPauseForMutation`). MCP calls and ordinary edits classify as
    // `mutate` and run free. Fresh DB read each time — handles the operator
    // flipping `mutations_acknowledged` mid-turn via Continue, and R-B
    // reconstructed sessions where the in-memory closure has no value to read.
    const session = getMultiAgentSession(sessionId);
    if (shouldPauseForMutation(cls.category, session)) {
      try {
        setPendingMutation(sessionId, row.id);
        setAwaitingContinue(sessionId, true);
      } catch (err) {
        console.error('[orchestrator] persist pending-mutation failed', err);
      }
      try {
        p.onPendingMutation?.(sessionId, row);
      } catch (err) {
        console.error('[orchestrator] onPendingMutation sink threw', err);
      }
      throw new PausedForMutationError(`paused before ${cls.summary}`);
    }
  };

  // Migration 012: tool-result tap. Flips `confirmed_at` on the matching
  // mutation row when the SDK delivers the result, then re-emits
  // `multi_agent_mutation` with the same `id` so the wire-reducer
  // (dedupe-by-id, replace) surfaces the confirmation to the lane / artifact
  // UI. Failures here are logged and swallowed — a missed confirmation just
  // leaves the row as provisional, which is the safe-default render.
  //
  // Phase E: after confirmation we also run the artifact classifier. If the
  // file passes the locked promotion globs, flip `promoted=1` and re-emit
  // again with the promotion flag set — the reducer dedupes by id so this
  // looks like a single state transition to the client.
  const onToolResultHook: AgentRunnerDeps['onToolResult'] = (_agentName, toolUseId, meta) => {
    let confirmed: MutationRecord | null;
    try {
      // Migration 026: also persist the tool output (result content) so the
      // Logs drawer shows what the call returned, not just that it confirmed.
      confirmed = confirmMutationByToolUseId(sessionId, toolUseId, meta.content);
    } catch (err) {
      console.error('[orchestrator] confirm mutation failed', err);
      return;
    }
    if (!confirmed) return;

    let finalRow = confirmed;
    if (confirmed.filePath) {
      try {
        const kind = classifyArtifact(confirmed.filePath, confirmed.cwd);
        if (kind === 'promoted' && !confirmed.promoted) {
          const promoted = setMutationPromoted(confirmed.id, true);
          if (promoted) finalRow = promoted;
        }
      } catch (err) {
        console.error('[orchestrator] classify/promote mutation failed', err);
      }
    }

    try {
      p.onMutation?.(sessionId, finalRow);
    } catch (err) {
      console.error('[orchestrator] onMutation sink (confirm re-emit) threw', err);
    }
  };

  // Interactive AskUserQuestion: a worker (or the orchestrator) called
  // AskUserQuestion. Emit the card to the operator and park the turn — the
  // runner blocks the in-flight SDK query on this Promise until the operator
  // answers (resolved by the WS `multi_agent_ask_user_answer` handler) or it's
  // drained on stop/interrupt. `p.sendServerMsg` is the live, rebind-aware sink
  // (same one `onAutoRetry` uses), so the card survives an R-A re-attach.
  const onAskUserQuestionHook: AgentRunnerDeps['onAskUserQuestion'] = (
    agentName,
    toolUseId,
    questions,
  ) => {
    try {
      p.sendServerMsg?.({
        type: 'multi_agent_ask_user_question',
        sessionId,
        agent: agentName,
        toolUseId,
        questions,
      });
    } catch (err) {
      console.error('[orchestrator] sendServerMsg ask_user_question threw', err);
    }
    return parkQuestion(sessionId, { agent: agentName, toolUseId, questions });
  };

  const runner = new AgentRunner({
    // Cluster G Phase 3 (G1): bus session id for the lifecycle registry's
    // per-hop snapshot. Same value for every orchestrator + worker hop.
    sessionId,
    onEvent: (ev) => router.handleEvent(ev),
    onMessage: (agent, msg) => {
      writeTranscript(paths, iterationId, agent, msg);
      activity.onMessage(agent, msg);
    },
    onSessionId: (agent, cli) => {
      // Persist each agent's `--resume` checkpoint so this session can be
      // reconstructed after a Cebab server restart (R-B). Covers the
      // orchestrator itself and every worker, including mid-run addWorker.
      try {
        upsertAgentSession(sessionId, agent, cli);
      } catch (err) {
        console.error('[orchestrator] persist agent session failed', err);
      }
    },
    onMutation: onMutationHook,
    onToolResult: onToolResultHook,
    onAskUserQuestion: onAskUserQuestionHook,
    abortController,
    runnerFactory: p.runnerFactory,
    // Cluster D Phase 4a (BE-D5 / BE-D8 / spec §4.2): mirror the chain.ts
    // wiring — every transient-overload retry emits an `auto_retry`
    // ServerMsg + writes a `recovery_log` row. Identical shape; both
    // bus topologies need the same observability so the regression-gate
    // queries don't have a hole for orchestrator runs.
    onAutoRetry: (info) => {
      try {
        p.sendServerMsg?.({
          type: 'auto_retry',
          sessionId,
          attempt: info.attempt,
          maxAttempts: info.maxAttempts,
          backoffMs: info.backoffMs,
          reason: info.reason,
          retryAt: info.retryAt,
          agentName: info.agentName,
        });
      } catch (err) {
        console.error('[orchestrator] sendServerMsg auto_retry threw', err);
      }
      try {
        appendRecoveryLog({
          sessionId,
          failureClass: 'other',
          operatorAction: 'auto_retry',
          timeToRecoveryMs: info.backoffMs,
        });
      } catch (err) {
        console.error('[orchestrator] appendRecoveryLog auto_retry threw', err);
      }
    },
    // Stalled-turn watchdog (silent-stale-state fix): a soft stall raises a
    // sticky operator alert so a wedged turn (e.g. the orchestrator silently
    // hung composing a reply) is loud, not a 24-minute gap. The hard abort is
    // surfaced separately via the TurnStalledError → deliver().catch path
    // below. `sticky` so the alert persists + replays if the operator's
    // browser was detached when it fired (R-A).
    onTurnStalled: (info) => {
      const result = emitNotification(
        {
          class: 'operational',
          severity: 'warn',
          dedupeKey: `agent_stalled:${sessionId}:${info.agentName}`,
          title: `${info.agentName} stalled`,
          message: `\`${info.agentName}\` has produced no activity for ${Math.round(
            info.idleMs / 1000,
          )}s. If it stays wedged it will be auto-recovered.`,
          sessionId,
          sticky: true,
        },
        (msg) => {
          if (msg.type === 'notification') {
            p.sendNotification?.(msg as NotificationEnvelope & { type: 'notification' });
          }
        },
      );
      if (!result.ok) {
        console.error('[orchestrator] agent_stalled dispatcher.emit failed', result.error);
      }
    },
    onTurnResumed: (agentName) => {
      const result = emitNotification(
        {
          class: 'operational',
          severity: 'info',
          dedupeKey: `agent_stalled:${sessionId}:${agentName}`,
          title: `${agentName} resumed`,
          message: `\`${agentName}\` is producing activity again.`,
          sessionId,
        },
        (msg) => {
          if (msg.type === 'notification') {
            p.sendNotification?.(msg as NotificationEnvelope & { type: 'notification' });
          }
        },
      );
      if (!result.ok) {
        console.error('[orchestrator] agent_resumed dispatcher.emit failed', result.error);
      }
    },
  });
  // Orchestrator stays narrow: its cwd is the empty Cebab-owned
  // <sessionFolder>/orchestrator/ workspace — no `.claude/settings*.json`,
  // no CLAUDE.md, nothing to load — so widening would be a no-op. Pinning
  // `['user']` here documents the invariant.
  runner.register({
    name: ORCHESTRATOR_AGENT_NAME,
    cwd: paths.orchestratorWorkspace,
    settingSources: ['user'],
  });
  // Workers load their project's full settings stack — MCPs,
  // allowedTools/disallowedTools, env injectors, hooks — exactly as a
  // standalone `claude` session in the same cwd would. Combined with
  // `permissionMode: 'bypassPermissions'` (no human gate), this means a
  // worker's project-defined hooks auto-execute on every bus turn for that
  // worker; the consultant-mode guardrail in `runtime.ts` is the only
  // behavioral brake.
  for (const w of p.workers) {
    runner.register({
      name: w.agentName,
      cwd: w.cwd,
      settingSources: ['user', 'project', 'local'],
      // Cluster G Phase 3 (G1): see chain.ts mirror — per-participant
      // project for the active-runs registry snapshot.
      projectId: w.projectId,
    });
  }

  // R-B: rehydrate each agent's `--resume` checkpoint from the persisted
  // map so its next turn continues its real CLI transcript. Rows for
  // unknown agents are ignored; an agent with no row stays fresh (correct —
  // it never completed a turn before the restart).
  for (const s of p.seededSessions ?? []) {
    if (runner.has(s.agentName)) runner.seedSession(s.agentName, s.cliSessionId);
  }

  // Worker briefing, prepended once to each worker's first turn (mirrors
  // chain.ts). The orchestrator is NEVER prefixed — it learns the protocol
  // from the roster prompt (`renderRosterPrompt`), the only prompt it sees
  // (its workspace is just an empty cwd; `settingSources: ['user']` means a
  // workspace CLAUDE.md would never load). Without this briefing,
  // orchestrator-mode workers have the bus_send tool but no instruction to
  // use it, so their replies are emitted as plain turn text and lost (the
  // install collapse removed the per-project comm.md that used to carry
  // this).
  //
  // R-B: a worker that already spoke in the prior process consumed this
  // briefing (its resumed transcript still has it), so it is pre-marked
  // here and `deliver` won't duplicate it.
  const briefed = new Set<string>(p.briefedAgents ?? []);
  const deliver = (agentName: string, text: string) => {
    let prompt = text;
    if (agentName !== ORCHESTRATOR_AGENT_NAME && !briefed.has(agentName)) {
      briefed.add(agentName);
      // Order: bus protocol → project rules → task (same as chain mode).
      const brief = renderWorkerBriefing({ selfAgent: agentName });
      const pr = workerProjectRules.get(agentName) ?? null;
      prompt = pr ? `${brief}\n\n${pr.framed}\n\n${text}` : `${brief}\n\n${text}`;
      if (pr) {
        // Compact scrollback marker only — the full CLAUDE.md is in the
        // delivered prompt + the on-disk iteration transcript, not echoed
        // into the operator's chat. `router` is always assigned before any
        // `deliver` call (same forward-decl pattern as `addWorker`).
        router.forwardCebabEvent({
          ts: Date.now(),
          source: CEBAB_SOURCE,
          destination: agentName,
          kind: 'intro',
          text: `Cebab injected ${workerProjectNames.get(agentName) ?? agentName}/CLAUDE.md (${pr.sizeLabel}) into ${agentName}'s first turn`,
        });
      }
    }
    // Capture the post-briefing-and-rules bytes so the .catch can hand them
    // to onWorkerFailed for the pending-retry slot, AND so the pause-on-
    // mutation `continueThroughMutation` resume can replay the same exact
    // wire bytes (no double briefing). The `briefed` Set above is already
    // populated, so a re-use never re-prefixes. Applies to the orchestrator
    // itself too — its briefing comes via `renderRosterPrompt` upstream of
    // this call, so `prompt` here IS the wire bytes regardless of who the
    // agent is.
    const deliveredPrompt = prompt;
    lastPrompt.set(agentName, deliveredPrompt);
    void runner
      .deliverTurn(agentName, prompt)
      .then(() => {
        // The turn resolved cleanly — clear any stale pending-retry slot this
        // agent owned. `.then` runs only on resolution, so a rejection skips
        // straight to `.catch`; `onTurnSucceeded` is self-guarded and never
        // throws, so it can't leak into the failure path.
        router.onTurnSucceeded(agentName);
      })
      .catch((err) => {
        // Item #5: PausedForMutationError is a sentinel from the mutation
        // tap; it is NOT a worker failure. The pause state (DB + wire) is
        // already persisted inside `onMutationHook` before the throw; do
        // nothing further so the session stays `running` waiting for
        // Continue.
        if (isPausedForMutation(err)) return;
        if (isTurnStalled(err)) {
          // The watchdog auto-aborted a wedged turn. Record the recovery
          // (closes the forensic gap a stalled turn used to leave) and fall
          // through to onWorkerFailed, which frees the agent's queue and parks
          // a pending-retry slot so the operator can re-issue the same prompt.
          try {
            appendRecoveryLog({
              sessionId,
              failureClass: 'other',
              operatorAction: 'abort',
              timeToRecoveryMs: err.stallMs,
            });
          } catch (logErr) {
            console.error('[orchestrator] appendRecoveryLog stall-abort threw', logErr);
          }
        }
        console.error(`[orchestrator] deliverTurn(${agentName}) failed`, err);
        router.onWorkerFailed(agentName, deliveredPrompt, err);
      })
      .finally(() => activity.onTurnEnd(agentName));
  };

  router = createOrchestratorRouter({
    sessionId,
    iterationId,
    workerNames,
    paths,
    lifecycle,
    onEvent: p.onEvent,
    onEnded: p.onEnded,
    onTeardown,
    onFinalize: () => {
      // Interactive AskUserQuestion: drain any parked questions so a
      // stopped/ended session doesn't leave a canUseTool Promise dangling.
      rejectQuestionsForSession(sessionId, 'session ended');
      activity.dispose();
    },
    deliver,
    hopBudget,
    initialHopsCount: p.initialHopsCount,
    onPendingRetry: p.onPendingRetry,
    sendNotification: p.sendNotification,
    sendRouterDrop: p.sendRouterDrop,
    sendServerMsg: p.sendServerMsg,
    // Phase 4e: forward R-B reseed of mute + kick sets into the router.
    initialMutedAgents: p.initialMutedAgents,
    initialKickedAgents: p.initialKickedAgents,
  });

  async function addWorker(projectId: number): Promise<AddWorkerResult> {
    if (workerProjectIds.includes(projectId)) {
      throw new Error(`project ${projectId} is already a participant in this session`);
    }
    const busBefore = getProjectBusState(projectId);
    const busWasAlreadyInstalled = busBefore.installed;
    if (!busBefore.installed) {
      await installBusForProject(projectId);
    }
    const newAgent = resolveAgent(projectId);
    runner.register({
      name: newAgent.agentName,
      cwd: newAgent.cwd,
      settingSources: ['user', 'project', 'local'],
      // Cluster G Phase 3 (G1): same projectId threading as the
      // initial-workers loop so mid-run added workers also appear in the
      // active-runs snapshot with the right project.
      projectId,
    });
    router.registerWorker(newAgent.agentName);
    addParticipant(sessionId, projectId, 'worker', null);
    workerProjectIds.push(projectId);
    workerProjectNames.set(newAgent.agentName, newAgent.projectName);
    // Read the new participant's CLAUDE.md so its first delivered turn
    // injects + marks it via the same `deliver`/`briefed` path as a
    // start-time worker.
    workerProjectRules.set(newAgent.agentName, readProjectClaudeMd(newAgent.cwd));
    const currentWorkers = router.getWorkerNames().map((agentName) => ({
      agentName,
      projectName: workerProjectNames.get(agentName) ?? agentName,
    }));
    const rosterText = renderRosterUpdate({
      newWorker: { agentName: newAgent.agentName, projectName: newAgent.projectName },
      currentWorkers,
      hopBudget,
    });
    router.forwardCebabEvent({
      ts: Date.now(),
      source: CEBAB_SOURCE,
      destination: ORCHESTRATOR_AGENT_NAME,
      kind: 'prompt',
      text: rosterText,
    });
    deliver(ORCHESTRATOR_AGENT_NAME, rosterText);
    return { agentName: newAgent.agentName, busWasAlreadyInstalled };
  }

  async function setLifecycleHandle(next: MultiAgentLifecycle): Promise<void> {
    setMultiAgentSessionLifecycle(sessionId, next);
    router.setLifecycle(next);
  }

  const handle: OrchestratorSessionHandle = {
    sessionId,
    iterationId,
    participantAgentNames,
    lifecycle,
    sessionFolder: paths.folder,
    hopBudget,
    pauseOnDangerous: p.pauseOnDangerous ?? false,
    async stop(reason) {
      // Clear any pending-retry / pause-on-dangerous slot so the teardown
      // leaves a clean row — a crashed-but-with-non-null-pending row is
      // dead data that R-B reconstruction can't usefully act on.
      try {
        setPendingRetry(sessionId, null);
      } catch (err) {
        console.error('[orchestrator] clear pending-retry on stop failed', err);
      }
      try {
        setPendingMutation(sessionId, null);
      } catch (err) {
        console.error('[orchestrator] clear pending-mutation on stop failed', err);
      }
      runner.stop();
      await router.teardown(reason);
    },
    sendUserPrompt: (text) => router.sendUserPrompt(text),
    detach() {
      router.detach();
    },
    addWorker,
    setLifecycle: setLifecycleHandle,
    getCurrentWorkerNames: () => router.getWorkerNames(),
    getCurrentLifecycle: () => router.getLifecycle(),
    async retry() {
      const pending = getPendingRetry(sessionId);
      if (!pending) return;
      // Clear the slot BEFORE re-delivery so a racing second click sees the
      // empty slot. A re-fail re-enters `onWorkerFailed`, which re-asserts
      // a fresh descriptor and re-emits the `multi_agent_pending_retry`
      // ServerMsg.
      try {
        setPendingRetry(sessionId, null);
      } catch (err) {
        console.error('[orchestrator] clear pending-retry on retry failed', err);
      }
      try {
        p.onPendingRetry?.(sessionId, null);
      } catch (err) {
        console.error('[orchestrator] retry onPendingRetry-null callback threw', err);
      }
      // Re-call `deliver` so the activity observer / liveness ticks see
      // the new turn. The agent's `briefed` Set is already populated by
      // the failed delivery (or, on R-B reconstruct, by `briefedAgents`
      // seeding), so re-feeding `pending.prompt` (which IS the
      // post-briefing bytes) does not double-prepend the briefing. For
      // the orchestrator itself, briefed never applied — the captured
      // prompt is the rendered roster/user-prompt text, replay is just
      // re-delivering the same wire bytes.
      deliver(pending.agentName, pending.prompt);
    },
    async continueThroughMutation() {
      // Item #5: idempotent operator-Continue path. Slot is read by id so a
      // racing second click returns null and no-ops.
      const pending = getPendingMutation(sessionId);
      if (!pending) return;
      try {
        setPendingMutation(sessionId, null);
        setMutationsAcknowledged(sessionId, true);
        setAwaitingContinue(sessionId, false);
      } catch (err) {
        console.error('[orchestrator] persist continue-through-mutation failed', err);
      }
      try {
        p.onPendingMutation?.(sessionId, null);
      } catch (err) {
        console.error('[orchestrator] continue onPendingMutation-null callback threw', err);
      }
      const replayPrompt = lastPrompt.get(pending.agentName);
      if (!replayPrompt) {
        console.warn(
          `[orchestrator] continue-through-mutation: no captured prompt for ${pending.agentName}`,
        );
        return;
      }
      // Same idempotency rules as `retry()`: re-deliver the captured
      // post-briefing bytes. A second mutation in the same session does NOT
      // re-pause because `mutations_acknowledged=1` is read inside
      // `onMutationHook`.
      deliver(pending.agentName, replayPrompt);
    },
    setMute: (agentName, muted) => router.setMute(agentName, muted),
    isMuted: (agentName) => router.isMuted(agentName),
    pauseAgent: (agentName) => runner.pause(agentName),
    resumeAgent: (agentName) => runner.resume(agentName),
    getPendingDeliveries: (agentName) => runner.getPendingDeliveries(agentName),
    kickAgent: (agentName) => router.kickAgent(agentName),
    isKicked: (agentName) => router.isKicked(agentName),
  };

  registerLiveSession({
    sessionId,
    mode: 'orchestrator',
    handle,
    rebind: (s) => router.rebind(s),
  });

  return { handle, router, deliver };
}

export async function startOrchestratorSession(
  opts: StartOrchestratorOpts,
): Promise<OrchestratorSessionHandle> {
  if (opts.workers.length < 1) {
    throw new Error('orchestrator mode requires at least one worker participant');
  }
  if (!fs.existsSync(opts.workspaceRoot)) {
    throw new Error(`workspaceRoot does not exist: ${opts.workspaceRoot}`);
  }

  const sessionId = crypto.randomUUID();
  const lifecycle: MultiAgentLifecycle = opts.lifecycle ?? 'persistent';
  const participantAgentNames = [ORCHESTRATOR_AGENT_NAME, ...opts.workers.map((w) => w.agentName)];

  const paths = computeSessionPaths(sessionId, opts.workspaceRoot);
  fs.mkdirSync(paths.folder, { recursive: true });
  ensureOrchestratorWorkspace(paths.orchestratorWorkspace);

  const iterationId = nextIterationId(paths);

  // PR-7: stamp template provenance + effective hop budget at session start.
  // The rail relies on `template_id` to attribute the row and `hop_budget`
  // to render `hops_used / hop_budget` after teardown.
  const effectiveHopBudget = opts.hopBudget ?? DEFAULT_HOP_BUDGET;
  createMultiAgentSession(sessionId, 'orchestrator', iterationId, paths.folder, lifecycle, {
    templateId: opts.templateId ?? null,
    hopBudget: effectiveHopBudget,
  });
  opts.workers.forEach((w) => addParticipant(sessionId, w.projectId, 'worker', null));
  prepareIterationDir(iterationId, participantAgentNames, paths);

  // Item #5: persist the opt-in pause-on-dangerous flag at session start so
  // the bus runner's mutation tap can read it from DB on every gate check.
  if (opts.pauseOnDangerous) {
    try {
      setPauseOnDangerous(sessionId, true);
    } catch (err) {
      console.error('[orchestrator] persist pause_on_dangerous failed', err);
    }
  }

  const { handle, router, deliver } = wireOrchestratorSession({
    sessionId,
    iterationId,
    lifecycle,
    paths,
    workers: opts.workers,
    onEvent: opts.onEvent,
    onEnded: opts.onEnded,
    onActivity: opts.onActivity,
    onPendingRetry: opts.onPendingRetry,
    onMutation: opts.onMutation,
    onPendingMutation: opts.onPendingMutation,
    sendNotification: opts.sendNotification,
    sendRouterDrop: opts.sendRouterDrop,
    sendServerMsg: opts.sendServerMsg,
    hopBudget: opts.hopBudget,
    pauseOnDangerous: opts.pauseOnDangerous,
  });

  // Roster prompt + initial user prompt → UI/DB parity, then delivered as
  // the orchestrator's first turn (was: two inbox messages drained by the
  // Stop hook; now concatenated into one prompt). Prompt's hop-budget
  // framing must match what the router actually enforces — use the
  // resolved value from the handle, not the literal `DEFAULT_HOP_BUDGET`.
  const rosterText = renderRosterPrompt({
    workers: opts.workers.map((w) => ({ agentName: w.agentName, projectName: w.projectName })),
    hopBudget: handle.hopBudget,
  });
  router.forwardCebabEvent({
    ts: Date.now(),
    source: CEBAB_SOURCE,
    destination: ORCHESTRATOR_AGENT_NAME,
    kind: 'prompt',
    text: rosterText,
  });
  router.forwardCebabEvent({
    ts: Date.now(),
    source: CEBAB_SOURCE,
    destination: ORCHESTRATOR_AGENT_NAME,
    kind: 'prompt',
    text: opts.initialPrompt,
  });
  deliver(ORCHESTRATOR_AGENT_NAME, `${rosterText}\n\n${opts.initialPrompt}`);

  return handle;
}

/**
 * Re-attach to a still-live orchestrator session (browser reconnect, same
 * process). Returns null when not live — e.g. after a Cebab server restart.
 * That is NOT the end of the story for orchestrated runs: the resume
 * dispatcher (`resume.ts`) then rebuilds the session from persisted state
 * via `reconstruct.ts` (R-B) and re-attaches it READ-ONLY. This function
 * itself is the pure same-process re-attach; it never respawns agents.
 */
export async function resumeOrchestratorSession(
  opts: ResumeOrchestratorOpts,
): Promise<OrchestratorSessionHandle | null> {
  const live = getLiveSession(opts.sessionId);
  if (!live || live.mode !== 'orchestrator') return null;
  live.rebind({
    onEvent: opts.onEvent,
    onEnded: opts.onEnded,
    sendNotification: opts.sendNotification,
    sendRouterDrop: opts.sendRouterDrop,
    sendServerMsg: opts.sendServerMsg,
  });
  return live.handle as unknown as OrchestratorSessionHandle;
}

/** Resolve worker project ids to ResolvedAgents. Unchanged. */
export function resolveOrchestratorWorkers(projectIds: number[]): ResolvedAgent[] {
  return projectIds.map((id) => resolveAgent(id));
}
