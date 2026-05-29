import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { WebSocket, WebSocketServer } from 'ws';
import {
  classifyToolCall,
  isSessionPermissionMode,
  type ClientMsg,
  type ServerMsg,
  type SessionPermissionMode,
} from '@cebab/shared';
import { config } from '../config.js';
import { getProject, setProjectTrusted, touchProject } from '../repo/projects.js';
import {
  createSession,
  getSession,
  getSessionPermissionMode,
  listSessionsForProject,
  setSessionPermissionMode,
  setSessionTitle,
} from '../repo/sessions.js';
import { listEvents, listEventsTail } from '../repo/events.js';
import { persistMessage } from '../runner/orchestrator.js';
import { closeLogger } from '../runner/logger.js';
import { pickRunner, type Runner } from '../runner/index.js';
import { registerQuery } from '../runner/lifecycle.js';
import { getSetting, setSetting } from '../repo/settings.js';
import { listTemplates, saveTemplate, deleteTemplate } from '../repo/templates.js';
import {
  resolveWorkspaceRoot,
  rowToProject,
  setWorkspaceRoot,
  syncWorkspaceProjects,
  workspaceRootValid,
} from '../workspace.js';
import type {
  AuthTransitionReasonCode,
  MultiAgentLifecycle,
  NotificationAction,
  NotificationEnvelope,
  NotificationSeverity,
  ReopenSessionFailureReason,
  RouterDropReasonCode,
  SessionCrashedReasonCode,
  WorkspaceDiff,
  WrapperErrorKind,
} from '@cebab/shared/protocol';
import { computeWorkspaceDiff } from '../workspace_diff.js';
import { cancelAuthRefresh, startAuthRefresh, type AuthRefreshCallbacks } from '../auth_refresh.js';
import { translate } from './translate.js';
import { resolveProjectAuthority } from '../repo/project_authority.js';
import { recordTrustDecision } from '../repo/mcp_trust.js';
import {
  awaitMcpTrustDecisions,
  makeTrustGateState,
  type TrustGateOutcome,
  type TrustGateState,
} from '../repo/mcp_trust_gate.js';
import {
  ACKNOWLEDGMENT_TRIGGER,
  awaitEnvInjectionAck,
  makeStartGateState,
  recordEnvInjectionAcknowledgment,
  type StartGateState,
} from '../repo/session_start_gate.js';
import { classifyError } from './errors.js';
import { shouldAutoAllow } from './permission.js';
import { buildSessionLogChunk } from './session_log.js';
import { InstallError, installBusForProject, uninstallBusForProject } from '../bus/install.js';
import {
  emit as emitNotification,
  getNotification,
  markNotificationAcked,
} from '../notifications/dispatcher.js';
import { getScrubbedEnvVars } from '../runner/claude.js';
import {
  appendSafetyAudit,
  appendSafetyAuditAck,
  HIGHEST_SUBCODES,
} from '../notifications/safety_audit.js';
import { getOperatorId } from '../notifications/operator.js';
import { appendForensics, getLatestForensicsForAgent } from '../repo/controllability_forensics.js';
import { _getSafetyAuditRow } from '../notifications/safety_audit.js';
import {
  isControlReasonCode,
  isKickMode,
  type ForensicBusEvent,
  type ForensicMutation,
  type KickForensicsSnapshot,
} from '@cebab/shared/protocol';
import {
  captureSingleAgentForensics,
  type CapturedPromptEntry,
  type PendingPermissionSummary,
  type SingleAgentEventRow,
} from '../notifications/forensic_snapshot.js';
import { findStoppedAuditIdForAckId } from '../repo/safety_audit_lookup.js';
import {
  aggregateByClass,
  appendRecoveryLog,
  authResumeChoiceRatio,
  listRecent,
  sweepReopenRate,
} from '../repo/recovery_log.js';
import { maybeDispatchDangerousMutation } from '../notifications/dangerous_mutation.js';
import { maybeDispatchGuardrailViolation } from '../notifications/guardrail_violation.js';
import { buildInboxSnapshot, clearDismissedInbox } from '../notifications/inbox.js';
import {
  resolveChainParticipants,
  startChainSession,
  type ChainSessionHandle,
} from '../bus/chain.js';
import {
  DEFAULT_HOP_BUDGET,
  resolveOrchestratorWorkers,
  startOrchestratorSession,
  type OrchestratorSessionHandle,
} from '../bus/orchestrator.js';
import type { ActivitySnapshot } from '../bus/activity.js';
import { ResolveAgentError, readProjectClaudeMdHead } from '../bus/runtime.js';
import {
  attemptResumeMultiAgent,
  resumeMultiAgentTarget,
  type ResumedSession,
  type ResumeCallbacks,
} from '../bus/resume.js';
import {
  archiveMultiAgentSession,
  clearFinishedMultiAgentSessions,
  computeRecoveryContext,
  endMultiAgentSession,
  getLastRunForTemplate,
  getMultiAgentSession,
  getPendingMutation,
  getPendingRetry,
  listMultiAgentEvents,
  listMultiAgentMutations,
  listMultiAgentSessionsWithIteration,
  listResolvedParticipants,
  setAwaitingContinue,
  unarchiveMultiAgentSession,
  type MutationRecord,
} from '../repo/multi_agent.js';
import { canReconstruct } from '../bus/reconstruct.js';
import { busIterationDir, sessionPathsFromFolder } from '../bus/paths.js';
import { getLiveSession, hasLiveSession } from '../bus/session_registry.js';
import {
  buildParticipantKickedMsg,
  buildParticipantMuteChangedMsg,
  buildParticipantPauseChangedMsg,
  executeExpireParticipant,
  executeKickParticipant,
  executeMuteParticipant,
  executePauseParticipant,
  executeResumeParticipant,
  executeUnmuteParticipant,
} from './control_verbs.js';
import { getPauseExpiryRegistry } from './pause_expiry.js';
import { ORCHESTRATOR_AGENT_NAME } from '../bus/orchestrator.js';
import type {
  IterationSummary,
  MultiAgentMutationView,
  PendingRetryDescriptor,
} from '@cebab/shared/protocol';
import { type MultiAgentEventKind, isMultiAgentEventKind } from '@cebab/shared/protocol';
import { buildAllowedOrigins, isAllowedHost } from '../origin.js';
import { verifyToken } from '../auth.js';

export type PendingPermission = {
  sessionId: string;
  resolve: (
    decision:
      | { behavior: 'allow'; updatedInput: Record<string, unknown> }
      | { behavior: 'deny'; message: string },
  ) => void;
  toolInput: Record<string, unknown>;
  /**
   * Cluster A Phase 6: persisted so the deny path can include the tool name
   * in the `tool_denied` ServerMsg + dispatcher notification. Set when the
   * canUseTool callback parks the Promise; read when the operator's
   * permission_decision arrives.
   */
  toolName: string;
};

/**
 * F12: drain pending permission Promises for a given session before
 *      abort/interrupt. Otherwise their entries leak in the map until WS
 *      close — functionally benign (the SDK's canUseTool callback is
 *      cancelled by abort) but unbounded under a burst of interrupts.
 *      Filter by sessionId so other concurrent sessions on the same WS
 *      connection aren't affected. Same pattern is used on WS close,
 *      with no sessionId filter (close drains everything).
 */
export function cleanupPendingPermissionsForSession(
  pending: Map<string, PendingPermission>,
  sessionId: string,
): void {
  for (const [requestId, p] of pending) {
    if (p.sessionId !== sessionId) continue;
    p.resolve({ behavior: 'deny', message: 'interrupted' });
    pending.delete(requestId);
  }
}

/**
 * Cluster C Phase 1 (spec §4.4 + §4.5): operator-initiated interrupt.
 *
 * Pulled out of the `case 'interrupt'` body so the side-effect-rich path
 * (runner.interrupt OR ac.abort fallback, plus the new
 * `session_interrupted` envelope emit) can be unit-tested without
 * standing up a WS server. Same testability pattern as
 * `executeArchiveSession`.
 *
 * Invariants:
 *   - Unknown sessionId (no inFlight) → silent no-op, no envelope.
 *     The handler ALSO ran `cleanupPendingPermissionsForSession`
 *     before calling us; that cleanup is safe even when there's no
 *     active turn to cancel (it's a filter over an unrelated map).
 *   - Either path (runner.interrupt OR ac.abort) emits exactly one
 *     `session_interrupted` envelope. `ackLatencyMs` is the wall-clock
 *     delta from the helper's entry to runner.interrupt() resolution
 *     (or to the synchronous abort if no runner.interrupt is exposed).
 *   - `runner.interrupt` rejection falls back to ac.abort + still
 *     emits the envelope — the operator's stop request was honored
 *     either way; the client gets a typed signal regardless.
 *   - Returns synchronously even if runner.interrupt() is async; the
 *     envelope ships on the .then continuation. Caller (case body)
 *     does not await this — it's fire-and-forget so the WS message
 *     queue doesn't back up while the runner tears down.
 *
 * The cleanupPendingPermissionsForSession call stays in the case body
 * (above this helper) so it runs synchronously before we yield to the
 * async runner cancel — F12's guarantee is that the permission map
 * doesn't leak even if the runner cancellation hangs.
 */
type InterruptInFlight = {
  runner: { interrupt?: () => Promise<void> };
  ac: AbortController;
};

export function executeInterrupt(args: {
  inFlight: InterruptInFlight | undefined;
  sessionId: string;
  send: (msg: ServerMsg) => void;
  /**
   * Cluster C Phase 2: store the freshly-minted `interruptAckId` so the
   * later `stop_reason` handler can validate it. Per-session — last id
   * wins for that session (Stops happen one-at-a-time per session in
   * the single-agent path; a fresh Stop invalidates a pending reason
   * for a previous Stop, which is the right semantics).
   *
   * Required when there IS an inFlight session — passed by the case
   * body wired to `conn.lastInterruptIds`. Tests can pass an own Map
   * or omit entirely (skip the side effect).
   */
  trackAckId?: (sessionId: string, ackId: string) => void;
  /**
   * Cluster C Phase 3 (spec §3 invariant 2 + BE-5 + BE-6): write parent
   * `session.stopped` safety_audit row + capture the forensic bundle
   * BEFORE the wire envelope ships. Invoked synchronously right after
   * the ack id is minted and tracked — that ordering is what guarantees
   * "every control action dual-writes to safety_audit before the wire
   * ack lands" (spec invariant 2): we run the persist step before the
   * runner.interrupt then-callback enqueues `emitAck`. The case body
   * passes a bound implementation that pulls conn state + db; tests can
   * omit (no audit row, just the wire envelope) or pass a spy.
   *
   * onStop is allowed to throw — caller wraps in try/catch + logs so a
   * forensics-write outage doesn't block the operator's Stop from
   * cancelling the runner (audit row IS the obligation; forensics is
   * evidence on top — see executeStoppedAudit for the split-failure
   * handling).
   */
  onStop?: (sessionId: string, interruptAckId: string) => void;
  /** Test seam: clock override for deterministic ackLatencyMs assertions. */
  now?: () => number;
  /** Test seam: ackId override for deterministic assertions. */
  generateAckId?: () => string;
}): void {
  const { inFlight, sessionId, send } = args;
  const now = args.now ?? Date.now;
  const generateAckId = args.generateAckId ?? randomUUID;
  if (!inFlight) return;
  const interruptStartedAt = now();
  // Mint the ack id eagerly so a fast-path emit (no runner.interrupt
  // exposed) still has a stable id to ship. Track it before the await
  // so a concurrent stop_reason that races the runner.interrupt
  // resolution doesn't see a stale id.
  const interruptAckId = generateAckId();
  args.trackAckId?.(sessionId, interruptAckId);
  // Cluster C Phase 3: persist the safety_audit + forensics BEFORE we
  // schedule the wire envelope. Synchronous on purpose — the
  // runner.interrupt().then(emitAck) is async, so this finishes first
  // even though emitAck is enqueued in the same tick.
  if (args.onStop) {
    try {
      args.onStop(sessionId, interruptAckId);
    } catch (err) {
      console.warn(
        `[ws] executeInterrupt: onStop hook threw for ${sessionId}; continuing with runner cancel`,
        err,
      );
    }
  }
  const emitAck = () => {
    send({
      type: 'session_interrupted',
      sessionId,
      ackLatencyMs: now() - interruptStartedAt,
      interruptAckId,
    });
  };
  if (inFlight.runner.interrupt) {
    inFlight.runner.interrupt().then(emitAck, (err) => {
      console.warn('[ws] runner.interrupt failed; falling back to abort', err);
      inFlight.ac.abort();
      emitAck();
    });
  } else {
    inFlight.ac.abort();
    emitAck();
  }
}

/**
 * Cluster C Phase 3 (spec §4.6 + BE-5/BE-6): for single-agent Stop, write
 * the parent `safety_audit { kind: 'session.stopped', reasonCode:
 * 'operator' }` row and the matched `controllability_forensics` bundle.
 *
 * Split-failure semantics: the audit row is the OBLIGATION (spec
 * invariant 2). If audit append throws, we re-throw to the caller so
 * executeInterrupt's try/catch can decide whether to surface — Phase 3
 * just logs (the runner cancel still completes; safety-log-unavailable
 * banner is BE-1 territory, deferred until Phase 1's caller refusal
 * pattern extends to the Stop path in a later phase). If audit succeeds
 * but forensics insert throws, we keep the audit row and log the
 * forensics failure — the bundle is best-effort evidence, not a gate.
 *
 * Exported for direct testability — the test surface exercises the audit
 * + forensics ordering against a real SQLite under a tmp dir, including
 * the partial-failure paths.
 */
export type ExecuteStoppedAuditInput = {
  sessionId: string;
  interruptAckId: string;
  capture: ReturnType<typeof captureSingleAgentForensics>;
  appendAudit?: typeof appendSafetyAudit;
  appendForensicsRow?: typeof appendForensics;
  now?: () => number;
};

export type ExecuteStoppedAuditResult = {
  auditId: string;
  /** True if the forensics bundle was persisted; false on a non-fatal forensics-write failure. */
  forensicsPersisted: boolean;
};

export function executeStoppedAudit(input: ExecuteStoppedAuditInput): ExecuteStoppedAuditResult {
  const appendAudit = input.appendAudit ?? appendSafetyAudit;
  const appendForensicsRow = input.appendForensicsRow ?? appendForensics;
  const now = input.now ?? Date.now;
  const ts = now();
  const auditResult = appendAudit({
    ts,
    sessionId: input.sessionId,
    kind: 'session.stopped',
    reasonCode: 'operator',
    payload: {
      interruptAckId: input.interruptAckId,
      source: 'single_agent_stop',
    },
  });
  let forensicsPersisted = true;
  try {
    appendForensicsRow({
      ...input.capture,
      safetyAuditId: auditResult.id,
    });
  } catch (err) {
    forensicsPersisted = false;
    console.warn(
      `[ws] executeStoppedAudit: forensics insert failed for audit ${auditResult.id}`,
      err,
    );
  }
  return { auditId: auditResult.id, forensicsPersisted };
}

/**
 * Cluster C Phase 3: assemble the inputs for the single-agent forensic
 * bundle from conn + db state, then call the pure capture helper. Lives
 * here (not in forensic_snapshot.ts) because it pulls multiple
 * server-side resolvers (sessions, projects, events) that the pure
 * capture helper deliberately stays free of.
 *
 * Returns undefined when the session-to-project resolve fails — that
 * happens for unknown / racing-cleanup session ids; the caller then
 * skips the audit + forensics step (the Stop itself still runs).
 */
export function buildSingleAgentForensicsInput(args: {
  sessionId: string;
  pendingPermissions: Map<string, PendingPermission>;
  capturedPrompts: Map<string, CapturedPromptEntry>;
  /** Test seams: optional fetchers so the orchestration is hermetic. */
  fetchEventsTail?: (sessionId: string, limit: number) => SingleAgentEventRow[];
  fetchSession?: (sessionId: string) => { project_id: number } | undefined;
  fetchProject?: (projectId: number) => { path: string; trusted: number } | undefined;
  fetchPermissionMode?: (sessionId: string) => SessionPermissionMode | null;
  now?: () => number;
}): ReturnType<typeof captureSingleAgentForensics> | undefined {
  const fetchEventsTail = args.fetchEventsTail ?? listEventsTail;
  const fetchSession = args.fetchSession ?? getSession;
  const fetchProject = args.fetchProject ?? getProject;
  const fetchPermissionMode = args.fetchPermissionMode ?? getSessionPermissionMode;

  const session = fetchSession(args.sessionId);
  if (!session) return undefined;
  const project = fetchProject(session.project_id);
  if (!project) return undefined;

  const pending: PendingPermissionSummary[] = [];
  for (const [requestId, p] of args.pendingPermissions) {
    if (p.sessionId !== args.sessionId) continue;
    pending.push({ requestId, toolName: p.toolName, toolInput: p.toolInput });
  }

  return captureSingleAgentForensics({
    sessionId: args.sessionId,
    recentEvents: fetchEventsTail(args.sessionId, 50),
    pendingPermissions: pending,
    capturedPrompt: args.capturedPrompts.get(args.sessionId),
    activePermissions: {
      trusted: project.trusted === 1,
      permissionMode: fetchPermissionMode(args.sessionId),
    },
    projectCwd: project.path,
    now: args.now,
  });
}

/**
 * Cluster C Phase 2 (spec §4.2 / §4.5): persist the operator's free-eval
 * reason for a Stop. Validates the inbound `interruptAckId` matches the
 * latest tracked id for the session, enforces the `'other' + reasonText`
 * pairing, and writes a `safety_audit` row.
 *
 * Drops (no-op + console log) instead of returning a `wrapper_error` —
 * the reason is post-hoc and Skip is the spec's "I don't want to
 * categorise" path, so a noisy rejection wouldn't be useful. The two
 * drop reasons (mismatched ack id, missing 'other' text) are diagnostic-
 * logged so a confused client can find the cause without firing a
 * generic error toast at the operator.
 *
 * Exported for testability — the unit test exercises the validator +
 * the audit-write side effect against a real SQLite under a tmp dir.
 */
export type ExecuteStopReasonInput = {
  msg: Extract<ClientMsg, { type: 'stop_reason' }>;
  /** The most recent `interruptAckId` for this session, or undefined if none tracked. */
  latestAckId: string | undefined;
  /** Test seam: override the audit append for hermetic tests. */
  appendAudit?: typeof appendSafetyAudit;
  /**
   * Cluster C Phase 3: test seam for the parent-row lookup. Returns the
   * parent `session.stopped` audit row's id for a given (sessionId,
   * interruptAckId) pair, or undefined when no parent exists (e.g. the
   * Stop was emitted before C3 wired the parent-row write, or the audit
   * write transiently failed). Defaults to the real DB lookup.
   */
  lookupParentAuditId?: (sessionId: string, interruptAckId: string) => string | undefined;
  /** Test seam: override Date.now() for deterministic ts assertions. */
  now?: () => number;
};

export function executeStopReason(input: ExecuteStopReasonInput): void {
  const { msg, latestAckId } = input;
  const append = input.appendAudit ?? appendSafetyAudit;
  const lookupParentAuditId = input.lookupParentAuditId ?? findStoppedAuditIdForAckId;
  const now = input.now ?? Date.now;
  // Validation 1: id binding. A stale reason (operator clicked the
  // prompt 30s after a fresh Stop already started) must not bind to
  // the new Stop's audit row. Silently drop.
  if (!latestAckId || latestAckId !== msg.interruptAckId) {
    console.log(
      `[stop_reason] dropping stale reason for ${msg.sessionId} (latest=${latestAckId ?? 'none'}, got=${msg.interruptAckId})`,
    );
    return;
  }
  // Validation 2: 'other' requires non-empty text. The client UI
  // enforces this, but a misbehaving client shouldn't be able to file
  // 'other' rows with no detail — they're useless for eval.
  if (msg.reasonCode === 'other') {
    const text = msg.reasonText?.trim();
    if (!text) {
      console.log(`[stop_reason] dropping 'other' reason without text for ${msg.sessionId}`);
      return;
    }
  }
  // Cluster C Phase 3: retroactive join — look up the parent session.stopped
  // row by interruptAckId so the reason addendum carries an explicit
  // reference back. parentAuditId may be undefined for legacy Stops or
  // when the parent-row write transiently failed; we still write the
  // addendum (operator's eval signal stays useful even without the join).
  const parentAuditId = lookupParentAuditId(msg.sessionId, msg.interruptAckId);
  try {
    append({
      ts: now(),
      sessionId: msg.sessionId,
      kind: 'session.stop_reason',
      reasonCode: msg.reasonCode,
      payload: {
        interruptAckId: msg.interruptAckId,
        reasonText: msg.reasonText ?? null,
        parentAuditId: parentAuditId ?? null,
      },
    });
  } catch (err) {
    console.error(`[stop_reason] safety_audit append failed for ${msg.sessionId}`, err);
  }
}

type InFlight = {
  ac: AbortController;
  projectId: number;
  runner: Runner;
  permissionMode: SessionPermissionMode;
};

/** Item #5: shape-equivalent translation from the DB row to the wire view.
 *  Migration 012 adds filePath / cwd / confirmedAt / promoted; `toolUseId`
 *  is server-internal (correlation key only) and is intentionally NOT
 *  surfaced on the wire. */
/**
 * Cluster A Phase 6: map a wrapper-error kind to the dispatcher knobs for
 * its dock notification. Centralised so the catch site in `runOneTurn`
 * doesn't carry a fat switch and the mapping is testable in isolation.
 *
 * `rate_limited` is intentionally absent — the live `rate_limit_event`
 * stream is the canonical surface for that signal (handled in the SDK
 * loop, separate from the exception catch).
 *
 * Severity choice: we treat both `auth_expired` and `process_crashed` as
 * `error` (the agent's turn died); `parse_error` is the same shape (the
 * SDK threw on a malformed message it couldn't recover from — UX-9
 * specifies that *recovered* parse errors don't notify, but the exception
 * path IS the turn-killing branch). `claude_not_found` is `error` here
 * too — spec §3 makes it `danger` for first-launch but that distinction
 * needs a boot-time path we don't have wired today; the subsequent-launch
 * `error` case fits the wrapper_error catch.
 */
type WrapperErrorDispatch = {
  severity: NotificationSeverity;
  title: string;
  reasonCode: SessionCrashedReasonCode | AuthTransitionReasonCode | 'claude_not_found';
  auditKind: string;
  action?: NotificationAction;
};

export function wrapperErrorDispatch(
  kind: WrapperErrorKind,
  sessionId: string,
): WrapperErrorDispatch {
  switch (kind) {
    case 'auth_expired':
      return {
        severity: 'error',
        title: 'Re-authentication required',
        reasonCode: 'auth_expired',
        auditKind: 'auth.transition',
        // UX-3: a Re-authenticate primary action; the client's
        // notifyFromServerMsg / dock translates the `reauth` kind to the
        // CTA copy and (Cluster D) wires the re-auth flow.
        action: { kind: 'reauth' },
      };
    case 'parse_error':
      return {
        severity: 'error',
        title: 'Turn failed: parse error',
        reasonCode: 'parse_error',
        auditKind: 'session.crashed',
      };
    case 'claude_not_found':
      return {
        severity: 'error',
        title: 'Claude CLI not found',
        reasonCode: 'claude_not_found',
        auditKind: 'session.crashed',
        action: { kind: 'open_settings' },
      };
    case 'rate_limited':
      // Handled separately via the live `rate_limit_event` stream; included
      // here for exhaustiveness so a future kind addition doesn't silently
      // fall through. If the catch ever reaches this branch (an error
      // classified as rate_limited that didn't ride the SDK event stream),
      // surface it as a normal warn so it's not lost.
      return {
        severity: 'warn',
        title: 'Rate limit',
        reasonCode: 'process_crash',
        auditKind: 'session.crashed',
      };
    case 'process_crashed':
    default:
      return {
        severity: 'error',
        title: 'Turn failed',
        reasonCode: 'process_crash',
        auditKind: 'session.crashed',
        action: { kind: 'restart_agent', sessionId },
      };
  }
}

/**
 * Cluster A Phase 6: classify a `rate_limit_event` payload as `hit` (an
 * active limit operator needs to wait out) vs `cleared` (an informational
 * signal — the SDK is back under the rate budget, or never crossed it).
 *
 * Heuristic:
 *   - resetsAt in the future → hit (warn)
 *   - resetsAt absent OR already in the past → cleared (info)
 *
 * The SDK's `status` string is forward-compat noise and may differ per
 * provider; relying on `resetsAt` keeps the branch resilient. Pure
 * function so the runOneTurn live-stream call site stays a thin wrapper
 * and this branch can be unit-tested without spinning up the WS stack.
 */
export type RateLimitDispatch = {
  subCode: 'hit' | 'cleared';
  severity: NotificationSeverity;
  title: string;
  message: string;
};

export function rateLimitDispatch(
  out: { status?: string; resetsAt?: number },
  now: number = Date.now(),
): RateLimitDispatch {
  const isActiveLimit = typeof out.resetsAt === 'number' && out.resetsAt > now;
  if (isActiveLimit && typeof out.resetsAt === 'number') {
    const resetText = ` Retry after ${new Date(out.resetsAt).toLocaleTimeString()}.`;
    return {
      subCode: 'hit',
      severity: 'warn',
      title: 'Rate limit',
      message: `${out.status ?? 'limited'}${resetText}`,
    };
  }
  return {
    subCode: 'cleared',
    severity: 'info',
    title: 'Rate limit cleared',
    message: out.status ?? 'limit lifted',
  };
}

/**
 * Cluster D Phase 4b (spec §4.2): pure validation for the
 * `retry_rate_limited` ClientMsg. Returns the resolution code the
 * dispatch site reacts to. Split out of the inline case body so unit
 * tests can exercise the three-way branch without spinning up a real
 * WS conn + SDK.
 *
 *   - `'no-held-prompt'` — `capturedPrompts` has no entry for
 *     `sessionId`. The held turn already cleared (success, hard
 *     failure, or duplicate click after the queue moved on).
 *   - `'in-flight'` — `inFlight.has(sessionId)` is true. A second
 *     retry click while the first one is still running would spawn
 *     parallel SDK turns on the same `--resume` id and wedge the
 *     session per the bus runner's serialization rationale.
 *   - `'ok'` — both checks pass; carries the bytes the dispatch site
 *     needs to re-invoke `runOneTurn` (text + projectId).
 *
 * `inFlight` is widened to a structural `{ has(id): boolean }` so the
 * test can pass a plain `{ has: () => false }` stub instead of
 * constructing a real Map.
 */
export type RetryRateLimitedResolution =
  | { kind: 'ok'; text: string; projectId: number }
  | { kind: 'no-held-prompt' }
  | { kind: 'in-flight' };

export function resolveRetryRateLimited(
  capturedPrompts: Map<string, { text: string; projectId: number }>,
  inFlight: { has(id: string): boolean },
  sessionId: string,
): RetryRateLimitedResolution {
  const captured = capturedPrompts.get(sessionId);
  if (!captured) return { kind: 'no-held-prompt' };
  if (inFlight.has(sessionId)) return { kind: 'in-flight' };
  return { kind: 'ok', text: captured.text, projectId: captured.projectId };
}

/**
 * Cluster D Phase 5 (spec §6.4 / BE-D22, BE-D23, BE-D24): pure-ish
 * implementation of the `archive_session` ClientMsg handler — exported so
 * the test surface can exercise it against a real DB without standing up
 * the WS scaffold. The case body in `processClientMsg` just calls this
 * with a `send` callback bound to `conn.ws`.
 *
 * Side effects:
 *   - DB: `archiveMultiAgentSession(sessionId)` flips `archived` 0→1.
 *   - DB: `appendRecoveryLog({failureClass:'sweep', operatorAction:'archive'})`
 *     (best-effort; a log failure doesn't block the success reply).
 *   - Filesystem (opt-in): `fsp.rm(session_folder, {recursive, force})`
 *     when `removeArtifacts === true`. Best-effort; log + continue on
 *     failure so a permission glitch can't strand the row half-archived.
 *   - WS: replies with `iteration_archived` on success, `wrapper_error`
 *     on guard violation (unknown id, still running).
 *
 * Ordering rationale: row flip BEFORE rm so a filesystem failure leaves
 * "row archived, folder still on disk" (operator can `rm -rf` by hand)
 * rather than "folder gone, row not archived" (confusing zombie).
 */
export async function executeArchiveSession(args: {
  sessionId: string;
  removeArtifacts: boolean;
  send: (msg: ServerMsg) => void;
}): Promise<void> {
  const { sessionId, removeArtifacts, send } = args;
  const row = getMultiAgentSession(sessionId);
  if (!row) {
    send({
      type: 'wrapper_error',
      sessionId,
      kind: 'process_crashed',
      message: `archive_session: no such multi-agent session ${sessionId}`,
    });
    return;
  }
  if (row.status === 'running') {
    send({
      type: 'wrapper_error',
      sessionId,
      kind: 'process_crashed',
      message: `archive_session: session is still running — Stop or End it first`,
    });
    return;
  }

  // Flip the row first (idempotent — repeat archive is a 0-row UPDATE,
  // returns false; caller still gets a success envelope so a duplicated
  // click from a stale toast resolves cleanly).
  archiveMultiAgentSession(sessionId);

  let removedArtifacts = false;
  if (removeArtifacts && row.session_folder) {
    try {
      await fsp.rm(row.session_folder, { recursive: true, force: true });
      removedArtifacts = true;
    } catch (err) {
      console.error(`[archive_session] rm ${row.session_folder} for ${sessionId} failed`, err);
    }
  }

  try {
    // Cluster D Phase 7: distinguish chain-mode crash archives from the
    // common sweep-archive case. The Iterations list's "chain session
    // couldn't be resumed" toast also routes through this handler (it
    // ships `archive_session` ClientMsg via App.tsx's notification
    // action handler), so the same operator action covers both failure
    // classes — but spec §8.5's aggregateByClass needs them tallied
    // separately. The mode + crashed-status pair is the cleanest
    // signal: chain-mode rows that were never auto-swept (no superseder)
    // and ended in crashed status are by definition chain_crash. Other
    // status combinations stay 'sweep' (the default for orchestrator
    // crashes too, since the operator may archive any crashed row).
    const failureClass = row.mode === 'chain' && row.status === 'crashed' ? 'chain_crash' : 'sweep';
    appendRecoveryLog({
      sessionId,
      failureClass,
      operatorAction: 'archive',
    });
  } catch (err) {
    console.error(`[archive_session] recovery_log append failed for ${sessionId}`, err);
  }

  send({ type: 'iteration_archived', sessionId, removedArtifacts });
}

/**
 * Cluster D Phase 8a (spec §8.5): pure-ish implementation of the
 * `get_recovery_log_snapshot` ClientMsg handler — exported so the test
 * surface can exercise it against a real DB without standing up the WS
 * scaffold. Same testability pattern as `executeArchiveSession`.
 *
 * Composes three named regression-gate queries + a recent-rows page into
 * one envelope (`recovery_log_snapshot`):
 *
 *   - `aggregateByClass()` — per-failure-class counts + reachedFinalRate
 *     + medianTimeToRecoveryMs. Classes that have never been recorded
 *     are absent (callers render "no data yet" rather than 0).
 *   - `sweepReopenRate()` — the spec-named "what fraction of swept rows
 *     get reopened" gauge; null when no sweeps have ever fired.
 *   - `authResumeChoiceRatio()` — paired "in-session-resume vs
 *     new-session" choice ratio for auth_expired recoveries; null
 *     when no auth_expired rows exist (which is always today —
 *     the writers for `auth_expired` land in a later phase).
 *   - `listRecent(clampedLimit)` — newest-first page sized by the
 *     request's `recentLimit` (clamped to [1, 100]).
 *
 * Read-only — no DB mutations, no events emitted aside from the reply.
 */
const RECOVERY_LOG_RECENT_LIMIT_MAX = 100;
const RECOVERY_LOG_RECENT_LIMIT_DEFAULT = 100;

export function executeRecoveryLogSnapshot(args: {
  recentLimit?: number;
  send: (msg: ServerMsg) => void;
}): void {
  const { send } = args;
  // Clamp: NaN / negative / non-finite / oversize all fall back to the
  // default. The handler is read-only but a malicious request asking for
  // limit=10_000_000 would still pull every row into memory — small
  // table today, but the discipline is the same as inbox_snapshot.
  let recentLimit = args.recentLimit ?? RECOVERY_LOG_RECENT_LIMIT_DEFAULT;
  if (!Number.isFinite(recentLimit) || recentLimit < 1) {
    recentLimit = RECOVERY_LOG_RECENT_LIMIT_DEFAULT;
  }
  if (recentLimit > RECOVERY_LOG_RECENT_LIMIT_MAX) {
    recentLimit = RECOVERY_LOG_RECENT_LIMIT_MAX;
  }
  // Integer-cast: SQLite's bound `?` parameter for LIMIT expects an
  // integer; the repo prepares with a `number` type but a fractional
  // value (e.g. 17.5) silently truncates. Make it explicit.
  recentLimit = Math.floor(recentLimit);

  const recent = listRecent(recentLimit).map((row) => ({
    id: row.id,
    ts: row.ts,
    sessionId: row.session_id,
    parentSessionId: row.parent_session_id,
    operatorId: row.operator_id,
    failureClass: row.failure_class,
    operatorAction: row.operator_action,
    timeToRecoveryMs: row.time_to_recovery_ms,
    outcome: row.outcome,
    forensicsId: row.forensics_id,
    invariantResultsJson: row.invariant_results_json,
  }));

  send({
    type: 'recovery_log_snapshot',
    aggregates: aggregateByClass().map((a) => ({
      failureClass: a.failureClass,
      count: a.count,
      reachedFinalRate: a.reachedFinalRate,
      medianTimeToRecoveryMs: a.medianTimeToRecoveryMs,
    })),
    sweepReopenRate: sweepReopenRate(),
    authResumeChoiceRatio: authResumeChoiceRatio(),
    recent,
  });
}

/**
 * Cluster C Phase 4g4 (spec §5.5, §6.4): executor for `get_kick_forensics`.
 * Reads the most-recent forensics row for (sessionId, agentSlug), parses
 * the JSON columns, joins kick provenance from the companion safety_audit
 * row, and sends `kick_forensics_snapshot`.
 *
 * Extracted from the WS handler for the same testability reason as
 * `executeRecoveryLogSnapshot`: the parser is the interesting bit
 * (mode/reason recovery from `payload_json`, defensive JSON parse with
 * undefined fallback) and the conn/ws plumbing is the boring bit.
 *
 * Always replies — `found: false` for the no-bundle case rather than
 * silence so the modal's loading state can resolve.
 */
export function executeKickForensicsSnapshot(args: {
  sessionId: string;
  agentSlug: string;
  send: (msg: ServerMsg) => void;
}): void {
  const { sessionId, agentSlug, send } = args;
  const row = getLatestForensicsForAgent(sessionId, agentSlug);
  if (!row) {
    send({
      type: 'kick_forensics_snapshot',
      sessionId,
      agentSlug,
      found: false,
      snapshot: null,
    });
    return;
  }

  // Join the companion safety_audit row for kick provenance. The
  // forensics FK guarantees the row exists; we still guard with
  // optional chaining + defensive parse because the payload shape is
  // by-convention, not schema-enforced.
  const auditRow = _getSafetyAuditRow(row.safety_audit_id);
  let kickReasonText: string | null = null;
  let kickMode: KickForensicsSnapshot['kickMode'] = null;
  let kickReasonCode: KickForensicsSnapshot['kickReasonCode'] = null;
  if (auditRow) {
    kickReasonCode = isControlReasonCode(auditRow.reason_code) ? auditRow.reason_code : null;
    try {
      const payload = JSON.parse(auditRow.payload_json) as Record<string, unknown>;
      if (typeof payload.reasonText === 'string') kickReasonText = payload.reasonText;
      if (isKickMode(payload.mode)) kickMode = payload.mode;
    } catch {
      // Malformed payload — leave fields null; the audit-row reasonCode
      // above already provides the safer of the two surfaces.
    }
  }

  const snapshot: KickForensicsSnapshot = {
    auditId: row.safety_audit_id,
    ts: row.ts,
    sessionId: row.session_id ?? sessionId,
    agentSlug: row.agent_slug ?? agentSlug,
    operatorId: row.operator_id,
    parentSessionId: row.parent_session_id,
    kickReasonCode,
    kickReasonText,
    kickMode,
    effectivePrompt: parseJsonOrUndefined(row.effective_prompt_json),
    busEvents: parseBusEvents(row.bus_inbox_outbox_json),
    mutations: parseMutations(row.mutation_rationale_json),
    pendingToolCalls: row.pending_tool_calls_json
      ? parseJsonOrUndefined(row.pending_tool_calls_json)
      : null,
    activePermissions: row.active_permissions_json
      ? parseJsonOrUndefined(row.active_permissions_json)
      : null,
    workdirTreeHash: row.workdir_tree_hash,
    snapshotFailedReason: row.snapshot_failed_reason,
  };

  send({
    type: 'kick_forensics_snapshot',
    sessionId,
    agentSlug,
    found: true,
    snapshot,
  });
}

// Defensive JSON parse — returns undefined on any throw so the caller
// can render an "unparseable" placeholder rather than crashing the WS
// turn. JSON.parse is fast enough that no caching is needed.
function parseJsonOrUndefined(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// Bus-event partition shape lives on the wire as a typed array; the
// stored column may be either `null` or a JSON array of objects with
// the captureMultiAgentForensics shape. We accept anything that looks
// like an array and validate each element; anything malformed becomes
// an empty array so the modal renders a "no events captured" hint
// rather than a JSON error.
function parseBusEvents(s: string | null): ForensicBusEvent[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    if (!Array.isArray(parsed)) return [];
    const out: ForensicBusEvent[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const ev = item as Record<string, unknown>;
      if (
        typeof ev.id !== 'number' ||
        typeof ev.ts !== 'number' ||
        typeof ev.source !== 'string' ||
        typeof ev.destination !== 'string' ||
        typeof ev.kind !== 'string' ||
        typeof ev.textPreview !== 'string'
      ) {
        continue;
      }
      out.push({
        id: ev.id,
        ts: ev.ts,
        source: ev.source,
        destination: ev.destination,
        kind: ev.kind,
        textPreview: ev.textPreview,
      });
    }
    return out;
  } catch {
    return [];
  }
}

// Same defensive-validate shape as parseBusEvents. mutation_rationale_json
// is wrapped in `{ recentMutations, totalMutations }` per C4f's
// captureMultiAgentForensics; we extract `recentMutations` and validate
// each row.
function parseMutations(s: string | null): ForensicMutation[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    if (!parsed || typeof parsed !== 'object') return [];
    const recent = (parsed as Record<string, unknown>).recentMutations;
    if (!Array.isArray(recent)) return [];
    const out: ForensicMutation[] = [];
    for (const item of recent) {
      if (!item || typeof item !== 'object') continue;
      const m = item as Record<string, unknown>;
      if (
        typeof m.id !== 'number' ||
        typeof m.ts !== 'number' ||
        typeof m.toolName !== 'string' ||
        typeof m.category !== 'string' ||
        typeof m.summary !== 'string' ||
        typeof m.confirmed !== 'boolean'
      ) {
        continue;
      }
      out.push({
        id: m.id,
        ts: m.ts,
        toolName: m.toolName,
        // Trust the category string — protocol's MutationCategory is open
        // enough that any string is forward-compat; client renders
        // unknowns as the raw label.
        category: m.category as ForensicMutation['category'],
        summary: m.summary,
        filePath: typeof m.filePath === 'string' ? m.filePath : null,
        confirmed: m.confirmed,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Cluster D Phase 5b (spec §6.3 / BE-D19): probe step of the swept-
 * session reopen flow. Validates the target is finalizable + has a
 * resolvable participant project, computes a workspace diff for that
 * project, replies with `reopen_session_confirm_required` for Phase 5c's
 * ReopenSessionModal to render.
 *
 * Does NOT swap the active session or reactivate the swept one — those
 * side effects belong to the `reopen_session_confirmed` handler that
 * lands in Phase 5c (where the modal's typed "reopen" confirmation
 * gates the commit).
 *
 * Project-path resolution: uses the lowest-chain_order participant for
 * chain mode, or the lowest-project_id participant for orchestrator
 * mode (the orchestrator agent itself isn't a participant row — only
 * workers are). This is one consistent diff per session even when the
 * session has multiple participants; if multi-participant diffs become
 * a UX requirement, Phase 5c can extend with a per-participant list.
 *
 * Archived rows ARE allowed — the operator can change their mind after
 * archiving, and Phase 5c's confirmed handler will unarchive as part
 * of the swap.
 */
export async function executeReopenSessionProbe(args: {
  sessionId: string;
  send: (msg: ServerMsg) => void;
  /** Test seam: override the diff computer for hermetic tests. */
  computeDiff?: (projectPath: string) => Promise<WorkspaceDiff>;
}): Promise<void> {
  const { sessionId, send } = args;
  const diff = args.computeDiff ?? computeWorkspaceDiff;

  const row = getMultiAgentSession(sessionId);
  if (!row) {
    send({
      type: 'reopen_session_failed',
      sessionId,
      reason: 'not_found',
      message: `No such multi-agent session ${sessionId}`,
    });
    return;
  }
  if (row.status === 'running') {
    // Reopening a live session would be a no-op at best, a swap-with-
    // self at worst. Reject explicitly so the modal can render
    // "session is already live" without falling through to a generic
    // error.
    send({
      type: 'reopen_session_failed',
      sessionId,
      reason: 'still_running',
      message: 'This session is still running — there is nothing to reopen.',
    });
    return;
  }

  const participants = listResolvedParticipants(sessionId);
  if (participants.length === 0) {
    // Either the session predates participant tracking (very old row)
    // OR every participant project has been deleted between session
    // start and now. Either way, we can't compute a meaningful diff —
    // surface as `no_participant` so the modal can prompt the operator
    // to archive instead.
    send({
      type: 'reopen_session_failed',
      sessionId,
      reason: 'no_participant',
      message: 'This session has no resolvable participant project to diff against.',
    });
    return;
  }

  // listResolvedParticipants already orders by (chain_order IS NULL)
  // ASC, chain_order ASC, project_id ASC — so participants[0] is the
  // canonical "first" project for both chain and orchestrator modes.
  const projectPath = participants[0]!.project_path;
  const workspaceDiff = await diff(projectPath);

  send({
    type: 'reopen_session_confirm_required',
    sessionId,
    projectPath,
    workspaceDiff,
  });
}

/**
 * Cluster D Phase 5c (spec §6.3 / BE-D20, BE-D21, BE-D24): commit step
 * of the swept-session reopen flow. Validates the operator's typed
 * "reopen" gate (re-running the workspace diff for safety against a
 * stale modal), detaches the current active session (if any) and marks
 * it crashed with a `session_superseded` notification carrying
 * `reasonCode: 'operator_reopen'`, unarchives the target if needed,
 * then reactivates it via the existing `resumeMultiAgentTarget` (R-B)
 * path. Writes a `recovery_log` row so the spec §8.5
 * `sweepReopenRate()` roll-up sees this case.
 *
 * The conn-bound concerns (detach + adopt) ride a small bridge object
 * (`detachCurrentActive` / `adoptResumed`) so the helper itself doesn't
 * need a Conn type — same testability pattern as
 * `executeArchiveSession` / `executeReopenSessionProbe`. The
 * `resumeCallbacks` field is a Pick of `ResumeCallbacks` with
 * `hopBudget` filled in.
 *
 * Chain mode handling: `resumeMultiAgentTarget` reconstructs only
 * orchestrator sessions via R-B. A chain-mode target whose live handle
 * is gone (server restarted) is unreopenable in v1 — we surface
 * `chain_reconstruction_unsupported` so the modal can render a
 * specific message rather than a generic "failed".
 */
export async function executeReopenSessionConfirmed(args: {
  sessionId: string;
  acknowledgedWorkspaceDiff: boolean;
  typedConfirmation?: string;
  currentActiveSessionId: string | null;
  detachCurrentActive: () => void;
  adoptResumed: (resumed: ResumedSession) => void;
  resumeCallbacks: Parameters<typeof resumeMultiAgentTarget>[1];
  send: (msg: ServerMsg) => void;
  /** Test seam: override the diff computer. */
  computeDiff?: (projectPath: string) => Promise<WorkspaceDiff>;
  /** Test seam: override the resume implementation (avoids needing a
   *  live session registry / R-B reconstruction in unit tests). */
  resumeTarget?: typeof resumeMultiAgentTarget;
}): Promise<void> {
  const {
    sessionId,
    acknowledgedWorkspaceDiff,
    typedConfirmation,
    currentActiveSessionId,
    detachCurrentActive,
    adoptResumed,
    resumeCallbacks: cbs,
    send,
  } = args;
  const diff = args.computeDiff ?? computeWorkspaceDiff;

  // ---- Step 1: target validation (mirrors probe; race-checks ----)
  const row = getMultiAgentSession(sessionId);
  if (!row) {
    send({
      type: 'reopen_session_failed',
      sessionId,
      reason: 'not_found',
      message: `No such multi-agent session ${sessionId}`,
    });
    return;
  }
  if (row.status === 'running') {
    // Race: between probe and confirm the row became running again
    // (operator hit Resume from another surface, or something else
    // reactivated it). Reject cleanly.
    send({
      type: 'reopen_session_failed',
      sessionId,
      reason: 'still_running',
      message: 'This session is already running.',
    });
    return;
  }

  const participants = listResolvedParticipants(sessionId);
  if (participants.length === 0) {
    send({
      type: 'reopen_session_failed',
      sessionId,
      reason: 'no_participant',
      message: 'This session has no resolvable participant project.',
    });
    return;
  }

  // ---- Step 2: typed-confirmation gate (BE-D21) ----
  if (!acknowledgedWorkspaceDiff) {
    send({
      type: 'reopen_session_failed',
      sessionId,
      reason: 'ack_required',
      message: 'Reopening requires explicit acknowledgment of the workspace diff.',
    });
    return;
  }

  // Re-compute the diff server-side so a stale modal can't lie. If the
  // freshly-computed diff has any changes OR we can't enumerate the
  // workspace, the typed gate fires.
  const projectPath = participants[0]!.project_path;
  const freshDiff = await diff(projectPath);
  const needsTypedGate = freshDiff.filesChanged > 0 || !freshDiff.fullDiffAvailable;
  if (needsTypedGate && typedConfirmation !== 'reopen') {
    send({
      type: 'reopen_session_failed',
      sessionId,
      reason: 'typed_confirmation_required',
      message: `Type "reopen" to confirm — the workspace has ${
        freshDiff.fullDiffAvailable
          ? `${freshDiff.filesChanged} uncommitted change(s)`
          : 'unknown state'
      }.`,
    });
    return;
  }

  // ---- Step 3: displace the current active (if any) ----
  // Same posture as the existing auto-sweep in bus/resume.ts — the
  // displaced row is marked crashed + a typed `session_superseded`
  // notification fires. Different here: the reasonCode is
  // `operator_reopen` (not `swept_competing`) so the inbox panel /
  // recovery_log can distinguish the two causes.
  if (currentActiveSessionId && currentActiveSessionId !== sessionId) {
    try {
      detachCurrentActive();
      endMultiAgentSession(currentActiveSessionId, 'crashed');
      send({
        type: 'session_superseded',
        sessionId: currentActiveSessionId,
        supersedingSessionId: sessionId,
        supersedingTs: Date.now(),
      });
      const notif = emitNotification(
        {
          class: 'operational',
          severity: 'warn',
          dedupeKey: `session_superseded:${currentActiveSessionId}`,
          title: 'A prior session was superseded',
          message: `Session ${currentActiveSessionId.slice(
            0,
            8,
          )} was crashed because you reopened an older one.`,
          sessionId: currentActiveSessionId,
          action: { kind: 'archive', sessionId: currentActiveSessionId },
          sticky: true,
          reasonCode: 'operator_reopen',
        },
        send,
      );
      if (!notif.ok) {
        console.error(
          '[reopen_session_confirmed] session_superseded dispatcher.emit failed',
          notif.error,
        );
      }
    } catch (err) {
      console.error(`[reopen_session_confirmed] failed to displace ${currentActiveSessionId}`, err);
      // Continue — the swap is still useful even if the displacement
      // notification didn't ship. The DB end-call is what matters; the
      // notification is best-effort.
    }
  }

  // ---- Step 4: unarchive if needed (operator changed their mind) ----
  if (row.archived === 1) {
    unarchiveMultiAgentSession(sessionId);
  }

  // ---- Step 5: reactivate via R-B / live re-attach ----
  const reactivate = args.resumeTarget ?? resumeMultiAgentTarget;
  let result: Awaited<ReturnType<typeof resumeMultiAgentTarget>>;
  try {
    result = await reactivate(sessionId, cbs);
  } catch (err) {
    console.error(`[reopen_session_confirmed] resumeMultiAgentTarget threw for ${sessionId}`, err);
    send({
      type: 'reopen_session_failed',
      sessionId,
      reason: 'reactivate_failed',
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (!result.ok) {
    // Map TargetResumeFailure → ReopenSessionFailureReason. The two
    // we expect here:
    //   - 'reattach-failed' for chain mode (R-B is orchestrator-only)
    //     OR a guard failure (folder missing, etc.). Mode-check
    //     against the row distinguishes them.
    //   - 'not-found' / 'already-running' shouldn't reach here (we
    //     guarded above), but map defensively.
    let reason: ReopenSessionFailureReason = 'reactivate_failed';
    let message = 'Failed to reactivate the session.';
    if (result.reason === 'reattach-failed' && row.mode === 'chain') {
      reason = 'chain_reconstruction_unsupported';
      message = 'Chain-mode reconstruction across a Cebab server restart is not supported in v1.';
    } else if (result.reason === 'already-running') {
      reason = 'still_running';
      message = 'This session is already running.';
    } else if (result.reason === 'not-found') {
      reason = 'not_found';
      message = 'Session vanished between confirm and reactivate.';
    }
    send({ type: 'reopen_session_failed', sessionId, reason, message });
    return;
  }

  // ---- Step 6: adopt + emit ----
  adoptResumed(result.resumed);

  // BE-D24: recovery_log entry. Best-effort — a log-write failure
  // shouldn't roll back the swap.
  try {
    appendRecoveryLog({
      sessionId,
      parentSessionId: currentActiveSessionId,
      failureClass: 'sweep',
      operatorAction: 'reopen',
    });
  } catch (err) {
    console.error(`[reopen_session_confirmed] recovery_log append failed for ${sessionId}`, err);
  }
}

function mutationRecordToView(m: MutationRecord): MultiAgentMutationView {
  return {
    id: m.id,
    sessionId: m.sessionId,
    ts: m.ts,
    agentName: m.agentName,
    toolName: m.toolName,
    category: m.category,
    summary: m.summary,
    filePath: m.filePath,
    cwd: m.cwd,
    confirmedAt: m.confirmedAt,
    promoted: m.promoted,
    // Cluster F Phase D5+: omit the field entirely when in-scope so the
    // wire stays narrow for the common case + the optional `?:` in the
    // type contract is honoured (forward-compat with older clients that
    // ignore unknown fields anyway, but stricter is cleaner).
    ...(m.guardrailViolationPath !== null
      ? {
          guardrailViolation: {
            violatedPath: m.guardrailViolationPath,
            agentCwd: m.cwd,
            reasonCode: m.guardrailReason ?? 'path_outside_cwd',
          },
        }
      : {}),
  };
}

/**
 * Cluster B Phase 3 (BE-B3): cached snapshot of the most recent
 * `session_started` per project for this WS connection — the effective-
 * state side of `ProjectAuthority`. Lifetime = lifetime of the WS conn
 * (per cebab-1's gotcha #3: never auto-fire a probe to refill this; only
 * the operator's explicit "Refresh" button does that, Phase 3b).
 *
 * Stored shape mirrors the relevant subset of the `session_started`
 * ServerMsg. Doesn't include sessionId because the AuthorityPanel is
 * project-scoped (per spec §6.1) and we only need ONE init snapshot per
 * project per connection — the most recent wins.
 */
type CachedSessionStarted = {
  capturedAt: number;
  model?: string;
  tools?: string[];
  cwd?: string;
  permissionMode?: string;
  apiKeySource?: string;
  mcpServers?: { name: string; status: string }[];
  slashCommands?: string[];
  skills?: string[];
  agents?: string[];
  plugins?: { name: string; path: string }[];
};

type Conn = {
  ws: WebSocket;
  pendingPermissions: Map<string, PendingPermission>;
  inFlight: Map<string, InFlight>;
  /** At most one active multi-agent session per connection in v1 (per the
   *  plan's "one active session at a time"). Cleared on completion, stop,
   *  crash, or WS close. Orchestrator sessions carry an extra
   *  `sendUserPrompt` method; the WS handler narrows via `'sendUserPrompt'
   *  in active` rather than carrying a separate mode discriminator here. */
  multiAgent: ChainSessionHandle | OrchestratorSessionHandle | null;
  /** Cluster B Phase 3: per-project authority cache; see CachedSessionStarted. */
  authorityCache: Map<number, CachedSessionStarted>;
  /**
   * Cluster B Phase 4b: TOFU spawn-gate state. Holds parked `pendingId`
   * promises (one per emitted `mcp_auto_install_pending`) and the per-session
   * deny_once set. Cleared implicitly on disconnect via Conn drop.
   */
  trustGate: TrustGateState;
  /**
   * Cluster B Phase 5: env-injection start-gate state. Holds parked
   * `pendingStartId` promises (one per emitted `session_start_gated`).
   * Cleared implicitly on disconnect.
   */
  startGate: StartGateState;
  /**
   * Cluster D Phase 4b (spec §4.2 / BE-D4): captured user prompt per
   * active session, holding the bytes Cebab last delivered into the
   * SDK turn that's now held by a rate-limit. The `retry_rate_limited`
   * handler reads this map to re-deliver the same prompt on the same
   * `--resume` session id (no fresh `system/init` quota burn).
   *
   * Lifecycle (single-agent only — bus participants own their own
   * captured-prompt state via `lastPromptOut` inside chain.ts):
   *
   *   - WRITE at `runOneTurn` entry, BEFORE the SDK starts.
   *   - DELETE on successful turn completion.
   *   - DELETE on non-rate-limit failure (auth_expired, process_crash,
   *     etc. — those need a different recovery flow, not a re-deliver).
   *   - KEEP on `wrapperKind === 'rate_limited'` so the
   *     `retry_rate_limited` handler can find the prompt.
   *
   * Lives on the Conn (not in module-level state) so a second operator
   * pane attaching to the same session doesn't inherit the first
   * pane's held-prompt — each pane manages its own retry intent.
   * Cleared implicitly on WS close.
   *
   * The map's existence-as-signal is also the "this session is held"
   * indicator that gates `runOneTurn`'s finally-block status flip.
   */
  capturedPrompts: Map<string, { text: string; projectId: number }>;
  /**
   * Cluster C Phase 2 (spec §4.5): most-recent `interruptAckId` per
   * session. The `stop_reason` handler reads this to validate that the
   * operator's reason binds to the latest Stop (a late reason for a
   * previous Stop is silently dropped). Last id wins per session: a
   * second Stop invalidates the pending reason for the first.
   * Cleared on disconnect via Conn drop; no cross-connection state.
   */
  lastInterruptIds: Map<string, string>;
};

export function startWsServer(server: HttpServer): WebSocketServer {
  const allowedOrigins = buildAllowedOrigins();
  const wss = new WebSocketServer({
    server,
    verifyClient: (info, cb) => {
      const req = info.req as IncomingMessage;
      const origin = String(req.headers.origin ?? '');
      const host = String(req.headers.host ?? '');
      // Empty Origin is allowed only for non-browser clients (smoke tests,
      // curl). Browsers ALWAYS set Origin on WS upgrades, so an absent
      // Origin can't be a Cross-Site WebSocket Hijack. The per-launch
      // auth token below is the real gate that closes worker→WS hijack —
      // Origin/Host are kept as a cheap label and early reject.
      if (origin && !allowedOrigins.has(origin)) {
        console.warn(`[ws] reject: bad origin ${JSON.stringify(origin)}`);
        cb(false, 403, 'forbidden origin');
        return;
      }
      if (!isAllowedHost(host)) {
        console.warn(`[ws] reject: bad host ${JSON.stringify(host)}`);
        cb(false, 403, 'forbidden host');
        return;
      }
      // F4: per-launch auth token. Workers under bypassPermissions can
      //     spoof Origin/Host from a Node WS client trivially, so the
      //     only real defense against a worker→WS hijack is requiring a
      //     secret they can't read (mode 0600 on ~/.cebab/auth-token).
      const u = new URL(req.url ?? '/', 'http://x');
      if (!verifyToken(u.searchParams.get('token'))) {
        console.warn('[ws] reject: bad token');
        cb(false, 401, 'unauthorized');
        return;
      }
      cb(true);
    },
  });
  wss.on('connection', (ws) => onConnection(ws));
  return wss;
}

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/**
 * Cluster B Phase 3 (BE-B3): update the per-Conn authority cache when a
 * `session_started` envelope is about to be sent. Latest snapshot per
 * project wins (the AuthorityPanel is project-scoped). Replay also hits
 * this — replaying an old session_started populates the cache with the
 * historical init, so `get_project_authority` against an idle project
 * returns *something* useful (last-known instead of always-null).
 *
 * BE-B2: `session_started` fires for EVERY turn, not just the first, so
 * this naturally tracks fresh effective state per turn without per-call
 * subscription.
 */
/**
 * Cluster B Phase 4b + 5 (§4.4 + §4.5): run all pre-spawn gates for every
 * unique project in `projectIds`, in declaration order. Each call:
 *
 *   1. Resolves the project's authority snapshot (declared MCPs + detected
 *      env injections + everything else from `project_authority`).
 *   2. (§4.4) Parks on `mcp_auto_install_pending` for each `first_seen` /
 *      `hash_changed` MCP server until the operator decides.
 *   3. (§4.5) If any credential-class env keys were detected in the
 *      project's settings.json, emits a single `session_start_gated` and
 *      parks until the operator types `'inject'` via `acknowledge_and_start`.
 *
 * Gates run in this order so the env prompt comes AFTER trust prompts —
 * the operator sees "trust these MCPs" first, then "you're injecting
 * credentials" — matching the spec's mental model of "first decide what
 * runs, then decide what credentials it sees."
 *
 * Duplicates are deduped here so a chain with `[A, A, B]` only re-prompts
 * once for A. Caller (`start_multi_agent` for bus, `runOneTurn` for
 * single-agent) MUST `await` this before calling `pickRunner` /
 * `startOrchestratorSession` / `startChainSession`. The await is the
 * structural block — if the operator never replies, the spawn never
 * happens.
 *
 * On a project_authority resolution miss (project row deleted mid-flight),
 * we skip silently — `getProject` upstream already rejected the start, so
 * this case is structurally unreachable in practice.
 */
async function gateProjectsForSpawn(conn: Conn, projectIds: number[]): Promise<void> {
  const seen = new Set<number>();
  for (const projectId of projectIds) {
    if (seen.has(projectId)) continue;
    seen.add(projectId);
    const cached = conn.authorityCache.get(projectId);
    const authority = resolveProjectAuthority({
      projectId,
      mode: 'cache',
      ...(cached !== undefined && { latestSessionStarted: cached }),
    });
    if (!authority) continue;
    await awaitMcpTrustDecisions({
      projectId,
      gate: conn.trustGate,
      send: (m) => send(conn.ws, m),
      servers: authority.mcpServers,
    });
    await awaitEnvInjectionAck({
      projectId,
      gate: conn.startGate,
      send: (m) => send(conn.ws, m),
      injections: authority.detectedEnvInjections,
    });
  }
}

function cacheSessionStartedIfNeeded(conn: Conn, out: ServerMsg): void {
  if (out.type !== 'session_started') return;
  const snapshot: CachedSessionStarted = { capturedAt: Date.now() };
  if (out.model !== undefined) snapshot.model = out.model;
  if (out.tools !== undefined) snapshot.tools = out.tools;
  if (out.cwd !== undefined) snapshot.cwd = out.cwd;
  if (out.permissionMode !== undefined) snapshot.permissionMode = out.permissionMode;
  if (out.apiKeySource !== undefined) snapshot.apiKeySource = out.apiKeySource;
  if (out.mcpServers !== undefined) snapshot.mcpServers = out.mcpServers;
  if (out.slashCommands !== undefined) snapshot.slashCommands = out.slashCommands;
  if (out.skills !== undefined) snapshot.skills = out.skills;
  if (out.agents !== undefined) snapshot.agents = out.agents;
  if (out.plugins !== undefined) snapshot.plugins = out.plugins;
  conn.authorityCache.set(out.projectId, snapshot);
}

function onConnection(ws: WebSocket): void {
  console.log('[ws] client connected');
  const conn: Conn = {
    ws,
    pendingPermissions: new Map(),
    inFlight: new Map(),
    multiAgent: null,
    authorityCache: new Map(),
    trustGate: makeTrustGateState(),
    startGate: makeStartGateState(),
    capturedPrompts: new Map(),
    lastInterruptIds: new Map(),
  };

  // Cluster A Phase 3 (E1, BE-10): tell the operator which auth-precedence
  // env vars `runner/claude.ts` stripped from this session's spawn env. Fires
  // on every attach (initial + reconnect) so a late-opening browser tab sees
  // the scrub; the dispatcher's safety dedupeKey (`env_scrubbed:boot`) is
  // shared across calls so the UI layer collapses repeats while the audit
  // row is written every time per BE-2 (safety never coalesces at recording).
  const scrubbedVars = getScrubbedEnvVars(process.env);
  if (scrubbedVars.length > 0) {
    const titlePieces = [`Cebab is using your Claude subscription`];
    const message = `Stripped from spawn env: ${scrubbedVars.join(', ')}.`;
    const result = emitNotification(
      {
        class: 'safety',
        severity: 'danger',
        dedupeKey: 'env_scrubbed:boot',
        title: titlePieces[0],
        message,
        reasonCode: 'api_key_scrubbed',
        auditKind: 'auth.transition',
        auditPayload: { vars: scrubbedVars },
      },
      (msg) => send(ws, msg),
    );
    if (!result.ok) {
      console.error('[ws] env_scrubbed dispatcher.emit failed', result.error);
    }
    // Forward-compat: also ship the typed event for any non-toast consumer
    // (Cluster B E1 inspector). The dispatcher fan-out above is what
    // drives the dock; this carries the var-names payload separately.
    send(ws, { type: 'env_scrubbed', vars: scrubbedVars });
  }

  // Cluster A Phase 5: seed the bell badge + inbox panel without
  // requiring the operator to open it first. Runs AFTER env_scrubbed so
  // the snapshot includes that just-written sticky safety row. The
  // unsolicited push uses an empty filter (all classes/severities/
  // sessions, unacked only) — the panel can re-`request_inbox_snapshot`
  // with narrower filters when the operator interacts with chips.
  const initialSnapshot = buildInboxSnapshot();
  send(ws, {
    type: 'inbox_snapshot',
    rows: initialSnapshot.rows,
    unackedCountBySession: initialSnapshot.unackedCountBySession,
    unackedGlobal: initialSnapshot.unackedGlobal,
  });

  ws.on('message', (raw) => {
    let parsed: ClientMsg;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      console.warn('[ws] bad client json');
      return;
    }
    handleClientMsg(conn, parsed).catch((err) => {
      console.error('[ws] handler error', err);
      send(ws, {
        type: 'wrapper_error',
        kind: 'process_crashed',
        message: err instanceof Error ? err.message : String(err),
      });
    });
  });

  ws.on('close', () => {
    console.log('[ws] client disconnected');
    for (const pending of conn.pendingPermissions.values()) {
      pending.resolve({ behavior: 'deny', message: 'client disconnected' });
    }
    conn.pendingPermissions.clear();
    for (const f of conn.inFlight.values()) f.ac.abort();
    conn.inFlight.clear();
    // Multi-agent: detach but DON'T tear down. The bus session keeps
    // running in-process (AgentRunner + router live in the session
    // registry); the DB row stays 'running'. A future WS connect (browser
    // refresh, second window) calls `attemptResumeMultiAgent` to re-attach
    // by swapping the WS sink. The Stop button is the only way an operator
    // intentionally tears a session down. (A Cebab server restart empties
    // the registry; an orchestrated run is then rebuilt from persisted
    // state and re-attached READ-ONLY — R-B — pending an operator Continue.)
    if (conn.multiAgent) {
      conn.multiAgent.detach();
      conn.multiAgent = null;
    }
  });

  // Attempt to re-attach to any pre-existing multi-agent session. Runs in
  // the background; we don't block the WS open. If a resume succeeds, the
  // browser receives a `multi_agent_started` + the persisted event replay
  // and its reducer transitions into the active-run view.
  void resumeOnConnect(conn);
}

/**
 * The onEvent/onEnded pair both the auto-resume sweep (`resumeOnConnect`)
 * and the manual `resume_multi_agent` handler feed into the bus runtime:
 * stream events to this WS and drop the active handle when it ends.
 */
function resumeCallbacks(
  conn: Conn,
): Pick<
  ResumeCallbacks,
  | 'onEvent'
  | 'onEnded'
  | 'onPendingRetry'
  | 'onMutation'
  | 'onPendingMutation'
  | 'sendNotification'
  | 'sendRouterDrop'
  | 'sendServerMsg'
> {
  return {
    onEvent: (sessionId, ev, dbEventId) => {
      const kind: MultiAgentEventKind = isMultiAgentEventKind(ev.kind) ? ev.kind : 'reply';
      send(conn.ws, {
        type: 'multi_agent_event',
        sessionId,
        eventId: dbEventId,
        ts: ev.ts,
        source: ev.source,
        destination: ev.destination,
        kind,
        text: ev.text,
      });
    },
    onEnded: (sessionId, reason, iterationId) => {
      // Cluster C Phase 4c2: cancel every pause-expiry timer for the
      // ending session. Any timer that fires after this point would
      // try to flip state on a row whose live session is gone; the
      // executor's defensive re-check would catch it (no-op-diverged),
      // but cancelling here is cheaper + cleaner.
      getPauseExpiryRegistry().clearSession(sessionId);
      send(conn.ws, { type: 'multi_agent_ended', sessionId, reason, iterationId });
      if (conn.multiAgent?.sessionId === sessionId) {
        conn.multiAgent = null;
      }
    },
    onPendingRetry: (sessionId, pending) => {
      send(conn.ws, { type: 'multi_agent_pending_retry', sessionId, pending });
    },
    onMutation: (sessionId, mutation) => {
      send(conn.ws, {
        type: 'multi_agent_mutation',
        sessionId,
        mutation: mutationRecordToView(mutation),
      });
      // Cluster A Phase 4 (UI-15): a `dangerous`-class mutation also fans a
      // sticky safety notification with an Open-in-Logs CTA. NR-2: the
      // LogsButton cumulative-count chip is unchanged — this toast is
      // point-in-time (additive).
      dispatchDangerousMutationForConn(sessionId, mutation, conn);
      // Cluster F Phase D5+: orthogonal safety signal — a mutation
      // whose resolved target path falls outside the agent's project
      // folder gets its own audit row + toast. Independent of severity
      // category; both signals can fire on the same row (e.g., an
      // out-of-scope `Write` to /tmp/foo is `mutate` + violation).
      dispatchGuardrailViolationForConn(sessionId, mutation, conn);
    },
    onPendingMutation: (sessionId, pending) => {
      send(conn.ws, {
        type: 'multi_agent_pending_mutation',
        sessionId,
        pending: pending ? mutationRecordToView(pending) : null,
      });
    },
    // Cluster A Phase 3 (D4): rebound on every reconnect so router-drop
    // safety toasts continue to reach the new WS sink. The dispatcher has
    // already written the audit row before this callback fires.
    sendNotification: (env) => {
      send(conn.ws, env);
    },
    sendRouterDrop: (drop) => {
      send(conn.ws, { type: 'router_drop', ...drop });
    },
    // Cluster A Phase 4: generic ServerMsg sender. Carries the new typed
    // events (`session_superseded`, `chain_not_reconstructed`,
    // `bus_auto_installed`, dangerous-mutation safety toast envelope) AND
    // dispatcher.emit notification envelopes originating from the bus
    // runtime (orchestrator/chain) in a reconstructed session.
    sendServerMsg: (msg) => {
      send(conn.ws, msg);
    },
  };
}

/**
 * Cluster A Phase 4 (UI-15): adapter for the extracted
 * `maybeDispatchDangerousMutation` helper — owns the WS send coupling and
 * the audit-write-failure logging policy. The dispatcher contract +
 * payload shape live in `notifications/dangerous_mutation.ts` so they
 * test without a `Conn`.
 */
function dispatchDangerousMutationForConn(
  sessionId: string,
  mutation: MutationRecord,
  conn: Conn,
): void {
  const result = maybeDispatchDangerousMutation(sessionId, mutation, (msg) => send(conn.ws, msg));
  if (result && !result.ok) {
    // BE-1: dispatcher refused (audit write failed). We can't roll back
    // the mutation (the SDK already dispatched the tool), so the
    // safety-log gap is logged for post-mortem. The wider mutation event
    // already shipped on the wire; only the safety toast is missing.
    console.error('[ws] dangerous mutation dispatcher.emit failed', result.error);
  }
}

/**
 * Cluster F Phase D5+: adapter for the `maybeDispatchGuardrailViolation`
 * helper — owns the WS send coupling for this Conn and the
 * audit-write-failure logging policy. Mirrors `dispatchDangerousMutationForConn`
 * — the orthogonal safety signal (path-scope violation) gets its own
 * audit row + dedicated notification toast independent of the mutation's
 * severity category. Both fan-out wrappers run on the same mutation row
 * sequentially, so a mutation that is both `dangerous` AND out-of-scope
 * surfaces both signals.
 */
function dispatchGuardrailViolationForConn(
  sessionId: string,
  mutation: MutationRecord,
  conn: Conn,
): void {
  const result = maybeDispatchGuardrailViolation(sessionId, mutation, (msg) => send(conn.ws, msg));
  if (result && !result.ok) {
    // BE-1: the dispatcher refused (audit write failed). The mutation
    // row itself still carries `guardrail_violation_path` so the UI
    // badge survives — only the notification toast is missing. Logged
    // for post-mortem; not fatal to the run.
    console.error('[ws] guardrail violation dispatcher.emit failed', result.error);
  }
}

/**
 * Adopt a freshly re-attached session into this Conn and bring the browser
 * up to date: emit `multi_agent_started` (the reducer clears the event list
 * to []), then replay persisted events in DB-id order so the scrollback
 * rebuilds before any live event from the re-attached tailer arrives.
 */
function emitResumedSession(conn: Conn, resumed: ResumedSession): void {
  conn.multiAgent = resumed.handle;
  // Fresh read: R-B reconstruction sets `awaiting_continue` AFTER the
  // resume sweep snapshots its `candidate` row, so `resumed.row` can be
  // stale. The DB is authoritative.
  const awaitingContinue = getMultiAgentSession(resumed.handle.sessionId)?.awaiting_continue === 1;
  // Item #4: hydrate the pending-retry banner descriptor from the persisted
  // columns. Survives both R-A (live re-attach — slot was set by an
  // onWorkerFailed in this process and lives in the DB) and R-B
  // (server restart — slot persisted in the prior process). Translate from
  // the DB `prompt` field to the wire `lastPrompt` field; both carry the
  // same bytes, just different names. The router's onPendingRetry callback
  // handles AFTER-attach transitions (a Continue+turn that re-fails, etc.).
  const pendingRow = getPendingRetry(resumed.handle.sessionId);
  const pendingRetry: PendingRetryDescriptor | undefined = pendingRow
    ? {
        agentName: pendingRow.agentName,
        reason: pendingRow.reason,
        lastPrompt: pendingRow.prompt,
        ts: pendingRow.ts,
        errorEventId: pendingRow.errorEventId,
      }
    : undefined;
  // Item #5: hydrate the pause-on-mutation overlay from the DB so the banner
  // restores after R-A re-attach (live registry still wired) and R-B
  // reconstruct (rebuilt session). All three reads (row, mutations list,
  // pending slot) are fast indexed reads — same posture as the awaiting /
  // pending-retry hydration above.
  const sessionRow = getMultiAgentSession(resumed.handle.sessionId);
  const pauseOnMutation = sessionRow?.pause_on_mutation === 1;
  const mutationsAcknowledged = sessionRow?.mutations_acknowledged === 1;
  const mutationsList = listMultiAgentMutations(resumed.handle.sessionId);
  const pendingMutationRow = getPendingMutation(resumed.handle.sessionId);
  const mutations: MultiAgentMutationView[] = mutationsList.map(mutationRecordToView);
  const pendingMutationView = pendingMutationRow
    ? mutationRecordToView(pendingMutationRow)
    : undefined;
  // Item #7: surface the per-agent recovery snapshot ONLY when the session
  // is in awaiting_continue state (R-B reconstruct or a pause-on-mutation
  // banner that survived a Cebab restart). When awaiting_continue is false
  // the recovery context is irrelevant — the banner isn't shown.
  const recoveryContext = awaitingContinue
    ? computeRecoveryContext(resumed.handle.sessionId)
    : null;
  send(conn.ws, {
    type: 'multi_agent_started',
    sessionId: resumed.handle.sessionId,
    mode: resumed.mode,
    // Original `participants` (project ids) only ride the start request,
    // not the DB row; the reducer doesn't use this field post-start.
    participants: [],
    participantAgentNames: resumed.handle.participantAgentNames,
    lifecycle: resumed.handle.lifecycle,
    sessionFolder: resumed.handle.sessionFolder,
    // R-A: re-attaches a live handle → use the original session's budget.
    // R-B: the resume path re-resolved the budget at reconstruct time and
    // the rebuilt handle carries it; both paths land here on the same field.
    hopBudget: resumed.handle.hopBudget,
    awaitingContinue,
    ...(pendingRetry ? { pendingRetry } : {}),
    pauseOnMutation,
    mutationsAcknowledged,
    mutations,
    ...(pendingMutationView ? { pendingMutation: pendingMutationView } : {}),
    ...(recoveryContext ? { recoveryContext } : {}),
  });
  for (const ev of resumed.replayEvents) {
    const kind: MultiAgentEventKind = isMultiAgentEventKind(ev.kind) ? ev.kind : 'reply';
    send(conn.ws, {
      type: 'multi_agent_event',
      sessionId: resumed.handle.sessionId,
      eventId: ev.dbEventId,
      ts: ev.ts,
      source: ev.source,
      destination: ev.destination,
      kind,
      text: ev.text,
    });
  }
}

/**
 * Async helper that runs after a WS connect: look up any active multi-agent
 * session in the DB, check the in-process registry, and re-attach if still
 * live. Catches its own errors so a failed resume doesn't leak into the WS
 * error handler.
 */
async function resumeOnConnect(conn: Conn): Promise<void> {
  try {
    const resumed = await attemptResumeMultiAgent({
      ...resumeCallbacks(conn),
      hopBudget: resolveHopBudget(),
      onResumeFailed: (sessionId) => {
        // Surface auto-resume failures as a wrapper_error toast so the
        // operator notices instead of "Cebab silently lost my session".
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId,
          kind: 'process_crashed',
          message: resumeFailureMessage(sessionId),
        });
      },
    });
    if (!resumed) return;
    emitResumedSession(conn, resumed);
  } catch (err) {
    console.error('[ws] resumeOnConnect failed', err);
  }
}

/**
 * Resolved hop budget for a new multi-agent session start (and for R-B
 * reconstruction). Precedence:
 *
 *   1. DB setting `hop_budget` (a positive integer) — what the operator set
 *      via the Settings modal.
 *   2. `CEBAB_HOP_BUDGET` env var — the operator's per-launch override.
 *   3. `DEFAULT_HOP_BUDGET` from `bus/orchestrator.ts` — the built-in floor.
 *
 * Always returns a finite integer ≥ 1. Re-read on every start/resume so a
 * Settings-modal change between runs takes effect immediately.
 */
function resolveHopBudget(): number {
  const stored = getSetting<number>('hop_budget');
  if (typeof stored === 'number' && Number.isFinite(stored) && stored >= 1) {
    return Math.floor(stored);
  }
  const env = parseInt(process.env.CEBAB_HOP_BUDGET ?? '', 10);
  if (Number.isFinite(env) && env >= 1) return env;
  return DEFAULT_HOP_BUDGET;
}

/**
 * Cluster F Phase A1a (UI-A1): resolve the effective MAX_TURNS for a
 * single-agent SDK spawn. Mirrors `resolveHopBudget` exactly — DB
 * setting > env > built-in — with one addition: an optional `override`
 * (the per-turn `send_message.maxTurns`) wins above everything when
 * present and >= 1. The override is the same value the client sends
 * for the "Extend +N" affordance: re-issue the prior user message
 * with a higher cap, where N is the bump amount the operator picked.
 *
 * Always returns a finite integer ≥ 1. Re-read on every send so a
 * Settings-modal change between turns takes effect immediately.
 *
 * **Exported** so tests can verify the precedence chain without
 * round-tripping through `emitSettings` or a WS connection.
 */
export function resolveMaxTurns(override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override >= 1) {
    return Math.floor(override);
  }
  const stored = getSetting<number>('max_turns');
  if (typeof stored === 'number' && Number.isFinite(stored) && stored >= 1) {
    return Math.floor(stored);
  }
  return config.maxTurns;
}

function emitSettings(conn: Conn): void {
  // Return the *raw* setting so the client can distinguish "user hasn't set
  // anything yet" (null) from "set, but pointing at a missing folder" (string
  // + workspaceRootValid=false). resolveWorkspaceRoot would mask the unset
  // case behind the env-var fallback.
  const stored = getSetting<string>('workspace_root');
  send(conn.ws, {
    type: 'settings',
    workspaceRoot: typeof stored === 'string' && stored.length > 0 ? stored : null,
    workspaceRootValid: workspaceRootValid(),
    defaultWorkspaceRoot: config.workspaceRootDefault,
    // Cluster E Phase 3 (A4): provenance of the fallback path.
    defaultWorkspaceRootSource: config.workspaceRootDefaultSource,
    defaultHopBudget: resolveHopBudget(),
    // Cluster F Phase A1a (UI-A1): surfaces the effective MAX_TURNS
    // so the F-A1b SettingsModal input and the future DraftView
    // Advanced expander can seed from server-truth.
    defaultMaxTurns: resolveMaxTurns(),
  });
}

/**
 * The user-facing message that ships in the `wrapper_error.message` field
 * when an auto-resume fails. Kept close to the WS layer so the wording (which
 * the operator sees in a toast) doesn't drift away from the symptom. With
 * R-B, an orchestrated run is reconstructed after a server restart; this
 * fires only when reconstruction is impossible — chain mode, or a guard
 * failed (no persisted session map for a pre-009 row, a deleted participant,
 * a missing session folder, …). The session id slice helps disambiguate
 * when the operator has run multiple multi-agent sessions in a row.
 */
function resumeFailureMessage(sessionId: string): string {
  const slug = sessionId.slice(0, 8);
  return `Couldn't resume multi-agent session ${slug}: the Cebab server was restarted and this run couldn't be reconstructed (chain-mode runs, or runs missing their persisted resume state, can't come back). Marked crashed. Single-agent chats are unaffected.`;
}

/**
 * Build the orchestrator "continue after restart" nudge for R-B. The
 * orchestrator is resumed with its full prior reasoning transcript intact
 * (its CLI session was seeded), so it only needs the bus activity that
 * landed after its last action — not the whole log. Excludes the
 * cebab→user recovery banner (operator-facing, not orchestrator input).
 */
function buildContinueNudge(sessionId: string): string {
  const events = listMultiAgentEvents(sessionId);
  let lastOrchIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.source === ORCHESTRATOR_AGENT_NAME) {
      lastOrchIdx = i;
      break;
    }
  }
  const since = events
    .slice(lastOrchIdx + 1)
    .filter((e) => !(e.source === 'cebab' && e.destination === 'user'));
  const log =
    since.length > 0
      ? since.map((e) => `- ${e.source} → ${e.destination} [${e.kind}]: ${e.text}`).join('\n')
      : '(no bus messages were recorded since your last action)';
  return [
    'The Cebab server was restarted while this session was running, so your',
    'turn was interrupted. You have been resumed with your full prior context',
    'intact. Bus activity since your last action:',
    '',
    log,
    '',
    'Continue the task from where you left off. If you had already dispatched',
    'work to a participant, wait for or re-request their reply as appropriate.',
    'Anything you wrote in the interrupted turn was not delivered — re-send it',
    'via bus_send. When you have the complete answer, bus_send(recipient="user",',
    'kind="final", ...).',
  ].join('\n');
}

/** Display-label cap. Long enough for "Refactor the WS upgrade handler", short
 * enough not to wreck the sidebar layout. */
const MAX_SESSION_TITLE_LEN = 80;

/**
 * Normalize a user-supplied title. Returns null when the input is empty after
 * trimming (the UI then falls back to the session id slice). Collapses CR/LF
 * to spaces so a pasted multi-line value can't break the row.
 */
function normalizeSessionTitle(raw: string | null): string | null {
  if (raw == null) return null;
  const collapsed = raw.replace(/[\r\n]+/g, ' ').trim();
  if (collapsed.length === 0) return null;
  return collapsed.slice(0, MAX_SESSION_TITLE_LEN);
}

/** Pick the permission mode for a (possibly resuming) turn. */
function seedPermissionMode(
  resumeSessionId: string | undefined,
  trusted: boolean,
): SessionPermissionMode {
  if (resumeSessionId) {
    const stored = getSessionPermissionMode(resumeSessionId);
    if (stored) return stored;
  }
  return trusted ? 'acceptEdits' : 'default';
}

/**
 * Build the iteration browser list from the DB. Exported for direct unit
 * testing without standing up a WS connection.
 *
 * artifactsDir resolution:
 *   - Post-007 rows (`session_folder` set) live under
 *     `<session_folder>/iterations/<id>/`.
 *   - Pre-007 rows (`session_folder` null) used the legacy global layout
 *     under `~/.cebab/bus/iterations/<id>/`.
 * Always emitting `busIterationDir(...)` collapsed both onto the legacy
 * path and broke per-session iteration browsing.
 */
export async function buildIterationsList(): Promise<IterationSummary[]> {
  const rows = listMultiAgentSessionsWithIteration();
  const out: IterationSummary[] = [];
  for (const row of rows) {
    const participants = listResolvedParticipants(row.id);
    const workerNames = participants
      .map((p) => p.bus_agent_name)
      .filter((n): n is string => n !== null);
    const participantAgentNames =
      row.mode === 'orchestrator' ? [ORCHESTRATOR_AGENT_NAME, ...workerNames] : workerNames;
    const artifactsDir =
      row.session_folder !== null
        ? sessionPathsFromFolder(row.session_folder).iterationDir(row.iteration_id!)
        : busIterationDir(row.iteration_id!);
    // Resumable if it's still live in THIS process's registry (same-process
    // re-attach) OR — for an orchestrated run — it can be reconstructed
    // from persisted state after a Cebab server restart (R-B). Chain rows
    // are only resumable while live. Re-validated on the actual resume.
    const resumable = hasLiveSession(row.id) || canReconstruct(row);
    out.push({
      iterationId: row.iteration_id!,
      sessionId: row.id,
      mode: row.mode as 'chain' | 'orchestrator',
      status: row.status as 'running' | 'completed' | 'stopped' | 'crashed',
      startedAt: row.started_at,
      endedAt: row.ended_at,
      participantAgentNames,
      // Absolute path so the browser can render it for clipboard / `cd`
      // use. The filesystem layout under iterations/NNN/ is the
      // operator's source of truth — Cebab doesn't proxy it.
      artifactsDir,
      resumable,
    });
  }
  return out;
}

async function handleClientMsg(conn: Conn, msg: ClientMsg): Promise<void> {
  switch (msg.type) {
    case 'list_projects': {
      const rows = await syncWorkspaceProjects();
      send(conn.ws, { type: 'projects', projects: rows.map(rowToProject) });
      return;
    }
    case 'get_settings': {
      emitSettings(conn);
      return;
    }
    case 'set_workspace_root': {
      try {
        setWorkspaceRoot(msg.path);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(conn.ws, { type: 'wrapper_error', kind: 'process_crashed', message });
        emitSettings(conn);
        return;
      }
      // Reading the resolved root is harmless; mostly here so console logs are useful.
      void resolveWorkspaceRoot();
      const rows = await syncWorkspaceProjects();
      emitSettings(conn);
      send(conn.ws, { type: 'projects', projects: rows.map(rowToProject) });
      return;
    }
    case 'set_default_hop_budget': {
      // Silently clamp invalid/non-finite/below-1 values to a no-op; the
      // client's number input is the validation surface for typo recovery.
      // Mirrors `set_workspace_root`'s "emit settings even on rejection so
      // the UI re-syncs" contract.
      if (Number.isFinite(msg.value) && msg.value >= 1) {
        setSetting('hop_budget', Math.floor(msg.value));
      }
      emitSettings(conn);
      return;
    }
    case 'set_default_max_turns': {
      // Cluster F Phase A1a (UI-A1): mirrors `set_default_hop_budget`
      // verbatim. Silent clamp + emitSettings re-sync on every call so
      // the SettingsModal stays consistent with server truth even when
      // the input is rejected.
      if (Number.isFinite(msg.value) && msg.value >= 1) {
        setSetting('max_turns', Math.floor(msg.value));
      }
      emitSettings(conn);
      return;
    }
    case 'open_project': {
      const project = getProject(msg.projectId);
      if (!project) return;
      const sessions = listSessionsForProject(project.id).map((s) => ({
        id: s.id,
        title: s.title,
        createdAt: s.created_at,
        lastEventAt: s.last_event_at,
        totalCostUsd: s.total_cost_usd,
      }));
      const runningSessionIds = [...conn.inFlight.entries()]
        .filter(([, f]) => f.projectId === project.id)
        .map(([sid]) => sid);
      send(conn.ws, {
        type: 'project_opened',
        projectId: project.id,
        sessions,
        runningSessionIds,
      });
      return;
    }
    case 'load_session': {
      await replaySession(conn, msg.projectId, msg.sessionId);
      return;
    }
    case 'set_trusted': {
      setProjectTrusted(msg.projectId, msg.trusted);
      const rows = await syncWorkspaceProjects();
      send(conn.ws, { type: 'projects', projects: rows.map(rowToProject) });
      return;
    }
    case 'permission_decision': {
      const pending = conn.pendingPermissions.get(msg.requestId);
      if (!pending) return;
      // Lie-detection: a decision must reference the same session that
      // produced the pending request. Otherwise something is confused.
      if (pending.sessionId !== msg.sessionId) {
        console.warn(
          `[ws] permission_decision sessionId mismatch: pending=${pending.sessionId} got=${msg.sessionId}`,
        );
        return;
      }
      conn.pendingPermissions.delete(msg.requestId);
      const toolName = pending.toolName;
      const denyMessage = msg.message ?? 'User denied this action';
      if (msg.decision === 'allow') {
        const updated = msg.updatedInput ?? pending.toolInput;
        pending.resolve({ behavior: 'allow', updatedInput: updated });
      } else {
        pending.resolve({
          behavior: 'deny',
          message: denyMessage,
        });
      }
      // Echo a permission_decided so the UI flips Allow/Deny → "decided" and
      // any other connection on the same session sees the outcome too.
      send(conn.ws, {
        type: 'permission_decided',
        sessionId: msg.sessionId,
        requestId: msg.requestId,
        decision: msg.decision,
      });
      // Persist so replay shows the resolution next to the request card.
      await persistMessage(msg.sessionId, {
        type: 'wrapper',
        subtype: 'permission_decided',
        session_id: msg.sessionId,
        uuid: randomUUID(),
        requestId: msg.requestId,
        decision: msg.decision,
      } as never);
      // Cluster A Phase 6: the denial is operator-driven (not a safety
      // violation), so we surface it as an operational warn toast — the
      // operator may be on another tab when they hit Deny and the agent's
      // next step lands; the dock makes the rejection visible there. The
      // in-session UI already shows the card flipping to "Denied" via the
      // permission_decided echo above; this is the cross-session/cross-tab
      // signal. Allow path stays silent (no notification on grant — that's
      // the common case and the tool_use block itself is the user-visible
      // signal that the tool ran).
      if (msg.decision === 'deny' && toolName) {
        send(conn.ws, {
          type: 'tool_denied',
          sessionId: msg.sessionId,
          requestId: msg.requestId,
          toolName,
          reasonCode: 'permission_required_not_granted',
          message: denyMessage,
        });
        emitNotification(
          {
            class: 'operational',
            severity: 'warn',
            // Dedup by tool name within the session — repeated denials of
            // the same tool ("Bash" again, "Edit" again) collapse to one
            // toast with a ×N badge instead of stacking.
            dedupeKey: `tool_denied:${msg.sessionId}:${toolName}`,
            title: `Denied: ${toolName}`,
            message: denyMessage,
            sessionId: msg.sessionId,
            reasonCode: 'permission_required_not_granted',
          },
          (out) => send(conn.ws, out),
        );
      }
      return;
    }
    case 'ack_notification': {
      // Cluster A Phase 1: operator acknowledges a sticky notification.
      // Idempotent: a re-ack (or an ack of an unknown id) is a silent
      // no-op so racing browsers / double-clicks don't surface errors.
      const row = getNotification(msg.id);
      if (!row || row.acked_at !== null) return;
      // BE-7: highest sub-class safety events require a typed reason. Without
      // it, the typed-ack affordance hasn't been collected — reject so the
      // UI can re-prompt rather than silently logging an empty acked_reason.
      if (
        row.class === 'safety' &&
        row.reason_code &&
        HIGHEST_SUBCODES.has(row.reason_code) &&
        (!msg.ackReason || msg.ackReason.trim() === '')
      ) {
        send(conn.ws, {
          type: 'wrapper_error',
          kind: 'process_crashed',
          message: `notification ${msg.id} requires an acknowledgment reason`,
        });
        return;
      }
      const ackedAt = Date.now();
      const ackedBy = getOperatorId();
      const reason = msg.ackReason?.trim() || null;
      if (row.class === 'safety' && row.audit_row_id) {
        appendSafetyAuditAck(row.audit_row_id, ackedAt, ackedBy, reason);
      }
      markNotificationAcked(msg.id, ackedAt, ackedBy, reason);
      // Cluster A Phase 5: push a fresh snapshot so the bell badge
      // decrements without the panel re-requesting. The panel's per-row
      // ack handler can also rely on this update for the unacked count.
      const ackedSnapshot = buildInboxSnapshot();
      send(conn.ws, {
        type: 'inbox_snapshot',
        rows: ackedSnapshot.rows,
        unackedCountBySession: ackedSnapshot.unackedCountBySession,
        unackedGlobal: ackedSnapshot.unackedGlobal,
      });
      return;
    }
    case 'request_inbox_snapshot': {
      // Cluster A Phase 5: panel-initiated snapshot request with filters.
      // Filters are server-side so the wire stays small (rows can be
      // hundreds; the full list isn't relevant when the operator narrows
      // by tier or session). The reply ALSO includes the unfiltered
      // per-session counts so the sidebar badges stay coherent regardless
      // of the panel's current filter.
      const snapshot = buildInboxSnapshot(msg.filters);
      send(conn.ws, {
        type: 'inbox_snapshot',
        rows: snapshot.rows,
        unackedCountBySession: snapshot.unackedCountBySession,
        unackedGlobal: snapshot.unackedGlobal,
      });
      return;
    }
    case 'clear_dismissed_inbox': {
      // Cluster A Phase 5: bulk-ack operational rows ONLY. Safety rows
      // are untouched (BE-7 typed-reason ack policy). After the update,
      // ship a fresh snapshot so the panel re-renders from authoritative
      // server state rather than the client guessing which ids it acked.
      clearDismissedInbox();
      const clearedSnapshot = buildInboxSnapshot();
      send(conn.ws, {
        type: 'inbox_snapshot',
        rows: clearedSnapshot.rows,
        unackedCountBySession: clearedSnapshot.unackedCountBySession,
        unackedGlobal: clearedSnapshot.unackedGlobal,
      });
      return;
    }
    case 'get_project_authority': {
      // Cluster B Phase 3 (BE-B3 / BE-B4): resolve and ship the authority
      // snapshot. Cache lookup first; the resolver merges in the file-read
      // scans (allow/deny attribution, env injections, hooks, declared MCP
      // servers) regardless of cache hit so pre-flight inspection of a
      // project that has never started a session in this WS connection
      // still returns useful data (just with empty effective tools/agents).
      //
      // Probe mode falls through to cache in Phase 3 (with an info log);
      // Phase 3b will spawn `maxTurns: 0` SDK runs here.
      const cached = conn.authorityCache.get(msg.projectId);
      const authority = resolveProjectAuthority({
        projectId: msg.projectId,
        mode: msg.mode,
        ...(cached !== undefined && { latestSessionStarted: cached }),
      });
      send(conn.ws, {
        type: 'project_authority',
        projectId: msg.projectId,
        authority,
      });
      return;
    }
    case 'mcp_trust_decision': {
      // Cluster B Phase 4 (§4.4): operator's TOFU decision. Two persisted
      // states (`trust` / `trust_pinned`) and two rejection states
      // (`deny_once` / `deny_remember`).
      //
      // Two entry paths:
      //   A) Gate-driven (`pendingId` present + parked): the spawn-gate
      //      (Phase 4b) is awaiting this decision before starting the
      //      session. We resolve the parked promise via the gate entry's
      //      `resolve(outcome)` callback — which itself runs the
      //      mcp_trust + safety_audit dual-write and unblocks the spawn.
      //   B) Operator-initiated (no `pendingId`, OR pendingId stale/unknown):
      //      decision came from the AuthorityPanel Trust/Deny affordance
      //      with no parked spawn. We persist directly here. trust_pinned
      //      still validates binarySha. deny_once with no parked gate is
      //      a no-op (in-memory state has no anchor without a project id;
      //      the next gate pass will re-prompt anyway).
      //
      // Path A always wins when both could apply — the parked spawn needs
      // to be unstuck before any other side effect, and the gate handles
      // the dual-write internally with the right project id + sessionKey.
      if (msg.pendingId) {
        const entry = conn.trustGate.pending.get(msg.pendingId);
        if (entry) {
          // trust_pinned requires binarySha — same guard as path B, surfaced
          // here so the parked spawn doesn't sit forever on a bad message.
          if (msg.decision === 'trust_pinned' && !msg.binarySha) {
            send(conn.ws, {
              type: 'wrapper_error',
              kind: 'process_crashed',
              message: `mcp_trust_decision: trust_pinned requires binarySha (server=${msg.serverName})`,
            });
            // Don't resolve — leave the gate awaiting; the operator can
            // re-send with the corrected payload. (UX-side this shouldn't
            // happen since the modal greys the affordance when sha is null.)
            return;
          }
          const outcome: TrustGateOutcome =
            msg.decision === 'trust'
              ? { kind: 'allow' }
              : msg.decision === 'trust_pinned'
                ? { kind: 'allow_pinned', binarySha: msg.binarySha as string }
                : msg.decision === 'deny_once'
                  ? { kind: 'deny_once' }
                  : { kind: 'deny_remember' };
          try {
            entry.resolve(outcome);
          } catch (err) {
            // The gate's internal applyDecision wraps in try/finally so the
            // spawn-promise always resolves; a throw here would only be the
            // safety_audit append going sideways. Surface it.
            const message = err instanceof Error ? err.message : String(err);
            send(conn.ws, { type: 'wrapper_error', kind: 'process_crashed', message });
          }
          return;
        }
        // pendingId given but not parked — fall through to path B. Common
        // case: the operator's client retried a decision after the gate
        // already resolved (or the spawn aborted upstream).
      }
      // Path B: operator-initiated persistence.
      if (msg.decision === 'deny_once') {
        // deny_once without a parked gate has nowhere to land (no project
        // anchor for the in-memory set). Log and acknowledge silently — the
        // operator's next start_session will re-prompt via the gate, and
        // they can deny_once at that point.
        console.log(
          `[mcp_trust] deny_once without parked gate for ${msg.serverName} @ ${msg.originPath} — no-op`,
        );
        return;
      }
      const persisted =
        msg.decision === 'trust'
          ? 'trusted'
          : msg.decision === 'trust_pinned'
            ? 'trusted_pinned_hash'
            : 'denied_remember';
      // trust_pinned without a binarySha is a UX bug (the client should
      // grey out the affordance) AND a meaningless lookup state — reject
      // explicitly so the operator gets a wrapper_error instead of a
      // silently-stored junk row.
      if (persisted === 'trusted_pinned_hash' && !msg.binarySha) {
        send(conn.ws, {
          type: 'wrapper_error',
          kind: 'process_crashed',
          message: `mcp_trust_decision: trust_pinned requires binarySha (server=${msg.serverName})`,
        });
        return;
      }
      try {
        recordTrustDecision({
          serverName: msg.serverName,
          originPath: msg.originPath,
          binarySha: msg.binarySha ?? null,
          decision: persisted,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(conn.ws, { type: 'wrapper_error', kind: 'process_crashed', message });
        return;
      }
      // Re-emit project_authority for every project this operator might
      // be inspecting, so the AuthorityPanel sees the new trust state on
      // the next render? Phase 4a is conservative: only the project that
      // owns the originPath needs a refresh, and the operator can just
      // re-trigger get_project_authority manually. Phase 6+ wires an
      // automatic re-fetch alongside the inspector.
      return;
    }
    case 'acknowledge_and_start': {
      // Cluster B Phase 5 (§4.5): operator's typed-acknowledgment reply to
      // a parked `session_start_gated`. Three guards before unblocking:
      //
      //   1. pendingStartId must match a live parked entry. A stale id —
      //      the operator clicked twice, or the WS reconnected and the
      //      pending Map cleared — is silently no-op'd; client either
      //      already proceeded OR will re-trigger on next start.
      //   2. typedAcknowledgment === 'inject' (case-sensitive). Anything
      //      else is wrapper_error; the gate stays parked so the operator
      //      can correct + retry without losing the spawn.
      //   3. The safety_audit append must succeed (BE-1). If it throws,
      //      wrapper_error is surfaced and the entry STAYS parked — same
      //      no-spawn semantics as a broken chain; the operator's choice
      //      didn't take, the run didn't start.
      //
      // Only after all three pass do we resolve the parked promise. The
      // entry is deleted FIRST to keep the Map clean even if a hypothetical
      // throw escaped the rest of the body.
      const entry = conn.startGate.pending.get(msg.pendingStartId);
      if (!entry) {
        // Idempotent no-op (mirrors `ack_notification` shape). Don't
        // wrapper_error a stale id — the operator's UI just resyncs.
        return;
      }
      if (msg.typedAcknowledgment !== ACKNOWLEDGMENT_TRIGGER) {
        send(conn.ws, {
          type: 'wrapper_error',
          kind: 'process_crashed',
          message: `acknowledge_and_start: typedAcknowledgment must be exactly ${JSON.stringify(
            ACKNOWLEDGMENT_TRIGGER,
          )}`,
        });
        return;
      }
      try {
        recordEnvInjectionAcknowledgment({
          projectId: entry.projectId,
          injections: entry.injections,
          ...(msg.reasonText !== undefined ? { reasonText: msg.reasonText } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(conn.ws, { type: 'wrapper_error', kind: 'process_crashed', message });
        // Don't resolve — keep parked so the operator can retry. A broken
        // audit chain is the kind of bug that needs operator visibility,
        // not a silent spawn-proceed.
        return;
      }
      conn.startGate.pending.delete(msg.pendingStartId);
      entry.resolve();
      return;
    }
    case 'set_permission_mode': {
      // Runtime validation: protocol type narrows to default|acceptEdits, but
      // a non-browser local client could try to send anything.
      if (!isSessionPermissionMode(msg.mode)) {
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message: `invalid permission mode: ${JSON.stringify(msg.mode)}`,
        });
        return;
      }
      const f = conn.inFlight.get(msg.sessionId);
      if (!f) return;
      try {
        await f.runner.setPermissionMode?.(msg.mode);
        f.permissionMode = msg.mode;
        // Persist so the next turn (and replay) seed from this preference.
        setSessionPermissionMode(msg.sessionId, msg.mode);
        send(conn.ws, {
          type: 'permission_mode_changed',
          sessionId: msg.sessionId,
          mode: msg.mode,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message,
        });
      }
      return;
    }
    case 'rename_session': {
      const row = getSession(msg.sessionId);
      if (!row) {
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message: `unknown session ${msg.sessionId}`,
        });
        return;
      }
      const normalized = normalizeSessionTitle(msg.title);
      setSessionTitle(msg.sessionId, normalized);
      send(conn.ws, {
        type: 'session_renamed',
        sessionId: msg.sessionId,
        projectId: row.project_id,
        title: normalized,
      });
      return;
    }
    case 'interrupt': {
      // Cluster C Phase 1: case body delegated to executeInterrupt
      // for testability (same pattern as executeArchiveSession). The
      // helper takes only what it needs — no Conn type — so the test
      // can pass synthetic runner shapes without standing up a full
      // WS server.
      //
      // Cluster C Phase 2: thread `trackAckId` so the freshly-minted
      // `interruptAckId` lands in `conn.lastInterruptIds` synchronously
      // — the operator's later `stop_reason` message binds against
      // this latest id.
      //
      // Cluster C Phase 3: thread `onStop` for the parent safety_audit
      // row + controllability_forensics bundle (spec invariant 2 +
      // BE-5 + BE-6). The hook runs synchronously inside
      // executeInterrupt right after the ack id is tracked, so the
      // audit row + bundle land BEFORE the wire envelope ships. Any
      // failure in here just logs — the runner.interrupt + ack
      // envelope still happen so the operator's Stop isn't blocked by
      // a forensics outage.
      cleanupPendingPermissionsForSession(conn.pendingPermissions, msg.sessionId);
      executeInterrupt({
        inFlight: conn.inFlight.get(msg.sessionId),
        sessionId: msg.sessionId,
        send: (m) => send(conn.ws, m),
        trackAckId: (sessionId, ackId) => conn.lastInterruptIds.set(sessionId, ackId),
        onStop: (sessionId, interruptAckId) => {
          const capture = buildSingleAgentForensicsInput({
            sessionId,
            pendingPermissions: conn.pendingPermissions,
            capturedPrompts: conn.capturedPrompts,
          });
          if (!capture) {
            console.warn(
              `[ws] interrupt onStop: no session/project for ${sessionId}; skipping audit+forensics`,
            );
            return;
          }
          executeStoppedAudit({ sessionId, interruptAckId, capture });
        },
      });
      return;
    }
    case 'stop_reason': {
      // Cluster C Phase 2 (spec §4.2 / §4.5): operator's free-eval
      // categorisation of why they Stopped. Validated against the
      // latest tracked `interruptAckId` for the session; mismatches
      // are silently dropped (a stale reason from a previous Stop
      // shouldn't bind to a fresher one). 'other' requires a
      // non-empty reasonText; mismatched pairs are also dropped.
      // Persisted as a standalone `safety_audit` row keyed by
      // (sessionId + interruptAckId) so C3's session.stopped
      // dual-write can later join them into a single audit history.
      executeStopReason({
        msg,
        latestAckId: conn.lastInterruptIds.get(msg.sessionId),
      });
      return;
    }
    case 'mute_participant':
    case 'unmute_participant': {
      // Cluster C Phase 4b (spec §5.2 + §5.10 + AE-1): orchestrator-mode
      // per-agent mute / unmute. Phase 4b ships mute only; pause + kick
      // get dedicated handler slices (4c, 4d). The handler validates,
      // flips the DB column (per_agent_control), updates the router's
      // in-memory mutedSet (handle.setMute), writes safety_audit, then
      // emits the participant_mute_changed state-change echo. Topology
      // failures (chain-mode, orchestrator target, unknown participant,
      // already-in-state) return as wrapper_error with a typed
      // ControllabilityFailureCode in the `message` field so the client
      // reducer can roll back the optimistic flip cleanly.
      const live = getLiveSession(msg.sessionId);
      const orchestratorHandle =
        live?.mode === 'orchestrator'
          ? (live.handle as unknown as OrchestratorSessionHandle)
          : undefined;
      const runner =
        msg.type === 'mute_participant' ? executeMuteParticipant : executeUnmuteParticipant;
      const result = runner({
        msg,
        orchestratorHandle,
        sessionMode: live?.mode ?? null,
      });
      if (!result.ok) {
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message: `${result.failureCode}: ${result.message}`,
        });
        return;
      }
      send(
        conn.ws,
        buildParticipantMuteChangedMsg({
          sessionId: msg.sessionId,
          projectId: msg.projectId,
          muted: msg.type === 'mute_participant',
          reasonCode: msg.reasonCode,
          reasonText: msg.reasonText,
          ts: Date.now(),
        }),
      );
      return;
    }
    case 'pause_participant': {
      // Cluster C Phase 4c (spec §5.2 + §5.6 + AE-4/5/6): orchestrator-mode
      // per-agent pause. Same orchestration shape as mute (validate → DB
      // flip → AgentRunner gate install → safety_audit dual-write →
      // state-change echo) but the echo carries `queuedDeliveries` so the
      // operator sees the pending-queue size growing while the agent is
      // paused (AE-5 [security] observability for runaway buildup).
      //
      // Cluster C Phase 4c2: after a successful pause, schedule the
      // expiry timer in the process-wide registry. Timer's fire
      // callback (built below) runs `executeExpireParticipant` to
      // either auto-resume or auto-kick per the operator's choice; we
      // then fan the appropriate `participant_pause_changed` /
      // `participant_kicked` envelope so the operator's UI reconciles
      // without needing a fresh round-trip.
      const live = getLiveSession(msg.sessionId);
      const orchestratorHandle =
        live?.mode === 'orchestrator'
          ? (live.handle as unknown as OrchestratorSessionHandle)
          : undefined;
      const result = executePauseParticipant({
        msg,
        orchestratorHandle,
        sessionMode: live?.mode ?? null,
      });
      if (!result.ok) {
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message: `${result.failureCode}: ${result.message}`,
        });
        return;
      }
      // Phase 4c2: register the expiry timer. The fire callback is
      // captured-by-closure so it can call back into the handler's
      // `conn.ws` for the state-change envelope. If the connection has
      // closed by fire time, `send(conn.ws, ...)` is a no-op — the DB
      // + audit writes still land (durable trail survives).
      getPauseExpiryRegistry().schedule(
        {
          sessionId: msg.sessionId,
          projectId: msg.projectId,
          agentName: result.agentName,
          pausedUntil: result.pausedUntil,
          expiryAction: msg.expiryAction,
          reasonCode: msg.reasonCode,
          reasonText: msg.reasonText ?? null,
        },
        (entry) => {
          // The fire-time orchestrator handle may differ from the
          // schedule-time one (R-A reattach swapped the live session
          // between bind and fire) — re-read at fire time.
          const liveAtFire = getLiveSession(entry.sessionId);
          const handleAtFire =
            liveAtFire?.mode === 'orchestrator'
              ? (liveAtFire.handle as unknown as OrchestratorSessionHandle)
              : undefined;
          const expireResult = executeExpireParticipant({
            entry,
            orchestratorHandle: handleAtFire,
          });
          if (!expireResult.ok) {
            console.error(
              `[ws] pause-expiry executor failed for ${entry.sessionId}/${entry.projectId}`,
              expireResult.error,
            );
            return;
          }
          // Diverged state (operator resumed/kicked between schedule +
          // fire): the trigger audit captured it; no state-change
          // envelope ships because the state had already moved on
          // and the operator's UI is already reconciled to the
          // post-move state from the prior verb's echo.
          if (expireResult.action === 'noop_diverged') return;
          const fireTs = entry.pausedUntil; // approximate; the audit row's ts is the authoritative
          if (expireResult.action === 'auto_resume') {
            send(
              conn.ws,
              buildParticipantPauseChangedMsg({
                sessionId: entry.sessionId,
                projectId: entry.projectId,
                pausedUntil: null,
                expiryAction: null,
                reasonCode: entry.reasonCode,
                ...(entry.reasonText !== null ? { reasonText: entry.reasonText } : {}),
                // No queued deliveries: the gate released, runner
                // drained the count to zero. Reporting 0 keeps the
                // wire shape consistent without re-querying the runner
                // (which the executor doesn't hold a handle to).
                queuedDeliveries: handleAtFire?.getPendingDeliveries(entry.agentName) ?? 0,
                ts: fireTs,
              }),
            );
            return;
          }
          // auto_kick: fan a `participant_kicked` envelope. The
          // operator's UI dispatches on the same type the operator-
          // kick path uses; the reasonCode is carried forward from
          // the pause.
          send(
            conn.ws,
            buildParticipantKickedMsg({
              sessionId: entry.sessionId,
              projectId: entry.projectId,
              mode: 'drain',
              reasonCode: entry.reasonCode,
              ...(entry.reasonText !== null ? { reasonText: entry.reasonText } : {}),
              ts: expireResult.kickedAt ?? fireTs,
            }),
          );
        },
      );
      send(
        conn.ws,
        buildParticipantPauseChangedMsg({
          sessionId: msg.sessionId,
          projectId: msg.projectId,
          pausedUntil: result.pausedUntil,
          expiryAction: msg.expiryAction,
          reasonCode: msg.reasonCode,
          reasonText: msg.reasonText,
          queuedDeliveries: result.queuedDeliveries,
          ts: Date.now(),
        }),
      );
      return;
    }
    case 'resume_participant': {
      // Cluster C Phase 4c: clear the AgentRunner pause gate + flip
      // paused_until/pause_expiry_action back to NULL. Queued
      // deliverTurn calls (registered while paused) fire in FIFO order
      // in the next microtask — the runner's existing turn-serialization
      // (tail chaining) preserves order.
      //
      // Phase 4c2: also cancel any scheduled expiry timer so the
      // operator's manual resume short-circuits the auto-action. A
      // false return from cancel just means no timer was scheduled
      // (e.g. resume without prior pause, or pause already expired)
      // — either is fine.
      const live = getLiveSession(msg.sessionId);
      const orchestratorHandle =
        live?.mode === 'orchestrator'
          ? (live.handle as unknown as OrchestratorSessionHandle)
          : undefined;
      const result = executeResumeParticipant({
        msg,
        orchestratorHandle,
        sessionMode: live?.mode ?? null,
      });
      if (!result.ok) {
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message: `${result.failureCode}: ${result.message}`,
        });
        return;
      }
      getPauseExpiryRegistry().cancel(msg.sessionId, msg.projectId);
      send(
        conn.ws,
        buildParticipantPauseChangedMsg({
          sessionId: msg.sessionId,
          projectId: msg.projectId,
          pausedUntil: null,
          expiryAction: null,
          reasonCode: msg.reasonCode,
          reasonText: msg.reasonText,
          queuedDeliveries: result.queuedDeliveries,
          ts: Date.now(),
        }),
      );
      return;
    }
    case 'kick_participant': {
      // Cluster C Phase 4d (spec §5.1 kick semantics + §5.3 topology
      // guards): orchestrator-mode per-agent kick (drain mode only).
      // Validates the kick (mode, reasonCode, topology, participant
      // exists, not orchestrator, not already kicked), flips the DB
      // column (per_agent_control), updates the router's in-memory
      // kickedSet so the next BusEvent involving the agent in either
      // direction is dropped (handle.kickAgent), writes safety_audit,
      // then emits `participant_kicked`. Hard-mode kick is rejected
      // with `hard_kill_unsupported_v1` until the per-agent
      // AbortController refactor lands (v1.1).
      //
      // The drain happens by-construction at the router: the in-flight
      // turn's bus_send calls become `kicked_source` drops and no
      // peer reply ever re-engages the agent (`kicked_destination`
      // drops). No AgentRunner interaction is needed for drain mode.
      const live = getLiveSession(msg.sessionId);
      const orchestratorHandle =
        live?.mode === 'orchestrator'
          ? (live.handle as unknown as OrchestratorSessionHandle)
          : undefined;
      const result = executeKickParticipant({
        msg,
        orchestratorHandle,
        sessionMode: live?.mode ?? null,
      });
      if (!result.ok) {
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message: `${result.failureCode}: ${result.message}`,
        });
        return;
      }
      // Phase 4c2: kick supersedes any standing pause-expiry timer.
      // Cancel before emitting so a freshly-fired timer can't race in
      // and double-emit a participant_kicked envelope.
      getPauseExpiryRegistry().cancel(msg.sessionId, msg.projectId);
      send(
        conn.ws,
        buildParticipantKickedMsg({
          sessionId: msg.sessionId,
          projectId: msg.projectId,
          mode: result.mode,
          reasonCode: msg.reasonCode,
          reasonText: msg.reasonText,
          ts: result.kickedAt,
        }),
      );
      return;
    }
    case 'install_bus_integration': {
      try {
        const result = await installBusForProject(msg.projectId);
        send(conn.ws, {
          type: 'bus_integration_changed',
          projectId: msg.projectId,
          installed: true,
          agentName: result.agentName,
        });
        // Refresh the whole project list so any client tab that renders the
        // `busInstalled` flag picks up the change in one place. Cheap on this
        // single-user app; the project list is bounded by workspace size.
        const rows = await syncWorkspaceProjects();
        send(conn.ws, { type: 'projects', projects: rows.map(rowToProject) });
      } catch (err) {
        const message =
          err instanceof InstallError
            ? `${err.code}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        send(conn.ws, { type: 'wrapper_error', kind: 'process_crashed', message });
      }
      return;
    }
    case 'uninstall_bus_integration': {
      try {
        await uninstallBusForProject(msg.projectId);
        send(conn.ws, {
          type: 'bus_integration_changed',
          projectId: msg.projectId,
          installed: false,
          agentName: null,
        });
        const rows = await syncWorkspaceProjects();
        send(conn.ws, { type: 'projects', projects: rows.map(rowToProject) });
      } catch (err) {
        const message =
          err instanceof InstallError
            ? `${err.code}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        send(conn.ws, { type: 'wrapper_error', kind: 'process_crashed', message });
      }
      return;
    }
    case 'start_multi_agent': {
      if (conn.multiAgent) {
        send(conn.ws, {
          type: 'wrapper_error',
          kind: 'process_crashed',
          message: `another multi-agent session is already running (${conn.multiAgent.sessionId}); stop it first.`,
        });
        return;
      }
      if (!Array.isArray(msg.participants) || msg.participants.length === 0) {
        send(conn.ws, {
          type: 'wrapper_error',
          kind: 'process_crashed',
          message: 'a multi-agent session needs at least one participant.',
        });
        return;
      }
      // Mode-specific minimum participant counts. Chain mode is a pipeline
      // (≥2 hops to be useful); orchestrator mode is hub-and-spoke (one
      // worker is degenerate but allowed for smoke testing).
      if (msg.mode === 'chain' && msg.participants.length < 2) {
        send(conn.ws, {
          type: 'wrapper_error',
          kind: 'process_crashed',
          message: 'chain mode requires at least two participants.',
        });
        return;
      }
      // Event forwarders shared between modes — translate BusLogEvent →
      // `multi_agent_event` ServerMsg. `sessionId` is passed by the runtime
      // as the callback's first arg (NOT closed over from a `const handle =
      // await ...` value), so callbacks firing DURING the await — which
      // happens routinely while the tailer picks up the briefings / roster
      // / initial-prompt writes during the 5s TUI warmup — don't hit TDZ.
      const onEvent = (
        sessionId: string,
        ev: { ts: number; source: string; destination: string; kind: string; text: string },
        dbEventId: number,
      ) => {
        const kind: MultiAgentEventKind = isMultiAgentEventKind(ev.kind) ? ev.kind : 'reply';
        send(conn.ws, {
          type: 'multi_agent_event',
          sessionId,
          eventId: dbEventId,
          ts: ev.ts,
          source: ev.source,
          destination: ev.destination,
          kind,
          text: ev.text,
        });
      };
      const onEnded = (
        sessionId: string,
        reason: 'completed' | 'stopped' | 'crashed',
        iterationId: string | null,
      ) => {
        send(conn.ws, {
          type: 'multi_agent_ended',
          sessionId,
          reason,
          iterationId,
        });
        if (conn.multiAgent?.sessionId === sessionId) {
          conn.multiAgent = null;
        }
      };
      // Ephemeral liveness pulse for the active run's in-flight turn. Not
      // persisted and not replayed: it is only meaningful to the connection
      // that started the run (see the `agent_activity` protocol JSDoc — a
      // live re-attach intentionally won't receive it; the spine re-syncs on
      // the next real hop).
      const onActivity = (sessionId: string, snap: ActivitySnapshot) => {
        send(conn.ws, {
          type: 'agent_activity',
          sessionId,
          agentName: snap.agentName,
          phase: snap.phase,
          currentTool: snap.currentTool,
          lastActivityTs: snap.lastActivityTs,
          turnStartedAt: snap.turnStartedAt,
        });
      };
      // Item #4: pending-retry set/clear → wire. Fresh starts never carry a
      // pending-retry slot on `multi_agent_started`; this callback is the
      // delta for transitions that happen later (a worker fails, the
      // operator retries, etc.).
      const onPendingRetry = (sessionId: string, pending: PendingRetryDescriptor | null) => {
        send(conn.ws, { type: 'multi_agent_pending_retry', sessionId, pending });
      };
      // Item #5: per-mutation live forwarding → `multi_agent_mutation`. Fires
      // for every classified non-'read' tool call observed during this
      // session. The initial batch on attach ships on `multi_agent_started`.
      // Cluster A Phase 4 (UI-15): dangerous-category mutations ALSO fan a
      // sticky safety toast with an Open-in-Logs CTA (additive — the
      // LogsButton cumulative-count chip stays per NR-2).
      const onMutation = (sessionId: string, mutation: MutationRecord) => {
        send(conn.ws, {
          type: 'multi_agent_mutation',
          sessionId,
          mutation: mutationRecordToView(mutation),
        });
        dispatchDangerousMutationForConn(sessionId, mutation, conn);
        // Cluster F Phase D5+: see the matching call in the start path
        // — orthogonal scope-violation signal fires its own audit row +
        // toast independent of the dangerous-category dispatch.
        dispatchGuardrailViolationForConn(sessionId, mutation, conn);
      };
      // Item #5: pause-on-mutation slot set/clear → wire. Fresh starts never
      // carry a pending slot on `multi_agent_started`; this is the delta.
      const onPendingMutation = (sessionId: string, pending: MutationRecord | null) => {
        send(conn.ws, {
          type: 'multi_agent_pending_mutation',
          sessionId,
          pending: pending ? mutationRecordToView(pending) : null,
        });
      };
      // Cluster A Phase 3 (D4): the orchestrator/chain router calls these
      // when an F2/F3 source-allowlist drop fires. The dispatcher has already
      // written the safety_audit row (BE-1) and shaped the envelope; the WS
      // layer just forwards it. The typed `router_drop` ServerMsg is
      // forward-compat for non-toast consumers (Cluster B routing-trail).
      const sendNotification = (env: NotificationEnvelope & { type: 'notification' }) => {
        send(conn.ws, env);
      };
      const sendRouterDrop = (drop: {
        sessionId: string;
        reasonCode: RouterDropReasonCode;
        source: string;
        destination: string;
        kind: string;
        auditRowId: string;
      }) => {
        send(conn.ws, { type: 'router_drop', ...drop });
      };
      // Cluster A Phase 4: generic ServerMsg sender. Threaded into the
      // bus runtime so the dispatcher.emit fan-out + new typed events
      // (`session_superseded`, `chain_not_reconstructed`,
      // `bus_auto_installed`, dangerous-mutation safety toast) reach the
      // browser without one bespoke callback per event.
      const sendServerMsg = (msg: ServerMsg) => {
        send(conn.ws, msg);
      };

      // Per-session folders live under the workspace root, so it must be
      // a valid existing directory. The Settings modal validates on save,
      // but a workspace that was deleted between then and now would slip
      // through — bail with a useful error.
      if (!workspaceRootValid()) {
        send(conn.ws, {
          type: 'wrapper_error',
          kind: 'process_crashed',
          message:
            'workspace root is not set or no longer exists; pick a workspace folder in Settings first.',
        });
        return;
      }
      const workspaceRoot = resolveWorkspaceRoot();
      // Lifecycle is optional on the wire; default 'persistent' here so
      // pre-007 clients (or any that forget to send it) get the safer
      // resumable behavior.
      const lifecycle: MultiAgentLifecycle = msg.lifecycle ?? 'persistent';

      // Resolve once per start so the wire's `hopBudget` matches what the
      // router was constructed with (Settings-modal saves between fetch and
      // start would otherwise risk a brief mismatch).
      //
      // PR-7 precedence: per-run override on the message > global default.
      // Per-template hopBudget is mirrored onto `msg.hopBudget` client-side
      // when the operator clicks Apply, so the server doesn't need to look
      // up the template here. Clamped to >= 1 defensively.
      const requestedHopBudget =
        typeof msg.hopBudget === 'number' && Number.isFinite(msg.hopBudget) && msg.hopBudget >= 1
          ? Math.floor(msg.hopBudget)
          : null;
      const hopBudget = requestedHopBudget ?? resolveHopBudget();

      if (msg.mode === 'orchestrator') {
        let workers;
        try {
          workers = resolveOrchestratorWorkers(msg.participants);
        } catch (err) {
          const message =
            err instanceof ResolveAgentError
              ? `${err.code}: ${err.message}`
              : err instanceof Error
                ? err.message
                : String(err);
          send(conn.ws, { type: 'wrapper_error', kind: 'process_crashed', message });
          return;
        }
        // Cluster B Phase 4b (§4.4): TOFU spawn-gate. Per unique worker
        // project, prompt the operator for any declared MCP server that
        // isn't currently 'trusted'. Awaiting blocks the spawn until every
        // decision arrives. The orchestrator itself runs from an empty
        // cwd (no MCPs to gate); only workers carry project-declared MCPs.
        await gateProjectsForSpawn(
          conn,
          workers.map((w) => w.projectId),
        );
        try {
          const handle = await startOrchestratorSession({
            workers,
            initialPrompt: msg.initialPrompt,
            workspaceRoot,
            lifecycle,
            onEvent,
            onEnded,
            onActivity,
            onPendingRetry,
            onMutation,
            onPendingMutation,
            sendNotification,
            sendRouterDrop,
            sendServerMsg,
            hopBudget,
            pauseOnMutation: msg.pauseOnMutation === true,
            // PR-7: stamp template provenance onto the row so the rail can
            // SELECT by template post-teardown. Absent on ad-hoc runs.
            templateId: typeof msg.templateId === 'string' ? msg.templateId : undefined,
          });
          conn.multiAgent = handle;
          send(conn.ws, {
            type: 'multi_agent_started',
            sessionId: handle.sessionId,
            mode: 'orchestrator',
            participants: msg.participants,
            participantAgentNames: handle.participantAgentNames,
            lifecycle: handle.lifecycle,
            sessionFolder: handle.sessionFolder,
            hopBudget: handle.hopBudget,
            // Item #5: fresh start — no mutations recorded yet, no pending,
            // ack flag false. `pauseOnMutation` echoes the operator's choice
            // so the UI mirrors its own setup checkbox.
            pauseOnMutation: handle.pauseOnMutation,
            mutationsAcknowledged: false,
            mutations: [],
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          send(conn.ws, { type: 'wrapper_error', kind: 'process_crashed', message });
        }
        return;
      }

      // Chain mode.
      let participants;
      try {
        participants = resolveChainParticipants(msg.participants);
      } catch (err) {
        const message =
          err instanceof ResolveAgentError
            ? `${err.code}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        send(conn.ws, { type: 'wrapper_error', kind: 'process_crashed', message });
        return;
      }
      // Cluster B Phase 4b (§4.4): TOFU spawn-gate, mirror of the
      // orchestrator path. Chain participants may repeat (e.g. [A, B, A])
      // and the helper dedupes on projectId so A is gated once.
      await gateProjectsForSpawn(
        conn,
        participants.map((p) => p.projectId),
      );
      try {
        const handle = await startChainSession({
          participants,
          initialPrompt: msg.initialPrompt,
          workspaceRoot,
          lifecycle,
          onEvent,
          onEnded,
          onActivity,
          onPendingRetry,
          onMutation,
          onPendingMutation,
          sendNotification,
          sendRouterDrop,
          sendServerMsg,
          hopBudget,
          pauseOnMutation: msg.pauseOnMutation === true,
          // PR-7: stamp template provenance onto the row.
          templateId: typeof msg.templateId === 'string' ? msg.templateId : undefined,
        });
        conn.multiAgent = handle;
        send(conn.ws, {
          type: 'multi_agent_started',
          sessionId: handle.sessionId,
          mode: 'chain',
          participants: msg.participants,
          participantAgentNames: handle.participantAgentNames,
          lifecycle: handle.lifecycle,
          sessionFolder: handle.sessionFolder,
          hopBudget: handle.hopBudget,
          pauseOnMutation: handle.pauseOnMutation,
          mutationsAcknowledged: false,
          mutations: [],
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(conn.ws, { type: 'wrapper_error', kind: 'process_crashed', message });
      }
      return;
    }
    case 'multi_agent_user_prompt': {
      const active = conn.multiAgent;
      if (!active || active.sessionId !== msg.sessionId) {
        // Either no active session or a different one. Drop silently — the
        // client may have raced a `multi_agent_ended` event.
        return;
      }
      if (!('sendUserPrompt' in active)) {
        // Chain mode doesn't accept mid-flight user prompts; it's fire-
        // and-forget after the initial input rides participant[0]'s first
        // turn. Surface as a wrapper_error so the operator gets feedback.
        send(conn.ws, {
          type: 'wrapper_error',
          kind: 'process_crashed',
          message: 'chain-mode sessions do not accept mid-flight user prompts.',
        });
        return;
      }
      try {
        await active.sendUserPrompt(msg.text);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(conn.ws, { type: 'wrapper_error', kind: 'process_crashed', message });
      }
      return;
    }
    case 'stop_multi_agent': {
      const active = conn.multiAgent;
      if (!active || active.sessionId !== msg.sessionId) {
        // Either no active session or one with a different id. Idempotent
        // no-op — the caller may have raced a `multi_agent_ended` event.
        return;
      }
      try {
        await active.stop('stopped');
      } catch (err) {
        console.error('[ws] stop_multi_agent failed', err);
        // onEnded won't fire if stop threw; emit a synthetic ended so the
        // client doesn't get stuck in 'running' state.
        send(conn.ws, {
          type: 'multi_agent_ended',
          sessionId: active.sessionId,
          reason: 'crashed',
          iterationId: null,
        });
        conn.multiAgent = null;
      }
      return;
    }
    case 'resume_multi_agent': {
      // Single-active invariant — same posture as start_multi_agent.
      if (conn.multiAgent) {
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message: 'Another multi-agent session is already running; stop it first.',
        });
        return;
      }
      try {
        const result = await resumeMultiAgentTarget(msg.sessionId, {
          ...resumeCallbacks(conn),
          hopBudget: resolveHopBudget(),
        });
        if (!result.ok) {
          const message =
            result.reason === 'not-found'
              ? 'That session no longer exists.'
              : result.reason === 'already-running'
                ? 'That session is already running.'
                : 'Failed to re-attach: the server restarted and this run could not be reconstructed (chain-mode, or missing persisted resume state).';
          send(conn.ws, {
            type: 'wrapper_error',
            sessionId: msg.sessionId,
            kind: 'process_crashed',
            message,
          });
          return;
        }
        emitResumedSession(conn, result.resumed);
      } catch (err) {
        console.error('[ws] resume_multi_agent failed', err);
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message: 'Failed to resume this session.',
        });
      }
      return;
    }
    case 'continue_multi_agent': {
      const active = conn.multiAgent;
      if (!active || active.sessionId !== msg.sessionId) {
        // Not the active session — drop (raced an ended, or never
        // re-attached). The browser only shows Continue on the active run.
        return;
      }
      if (!('sendUserPrompt' in active)) {
        // Chain handles have no sendUserPrompt — chain reconstruction is
        // out of scope, so this should be unreachable, but fail loud.
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message: 'Only orchestrator sessions can be continued.',
        });
        return;
      }
      const row = getMultiAgentSession(msg.sessionId);
      if (!row || row.awaiting_continue !== 1) {
        // Already continued (or never a recovered session). Idempotent
        // no-op so a double-click can't double-deliver the nudge.
        return;
      }
      try {
        // Clear the flag BEFORE delivering so a racing second click sees
        // awaiting_continue=0 and the guard above no-ops it.
        setAwaitingContinue(msg.sessionId, false);
        await active.sendUserPrompt(buildContinueNudge(msg.sessionId));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(conn.ws, { type: 'wrapper_error', kind: 'process_crashed', message });
      }
      return;
    }
    case 'retry_worker': {
      // Item #4: re-deliver the captured prompt of the worker named in the
      // session's persisted pending-retry slot. Stateless — the server reads
      // the agent name + bytes from the DB, never from the client. The
      // router clears the slot BEFORE re-delivery so a racing second click
      // sees the empty slot and no-ops.
      const active = conn.multiAgent;
      if (!active || active.sessionId !== msg.sessionId) {
        // Not the active session — drop. Idempotent.
        return;
      }
      const pending = getPendingRetry(msg.sessionId);
      if (!pending) {
        // No slot to retry; either never set or a racing second click won.
        return;
      }
      // If this session is also awaiting Continue (R-B reconstruct + a
      // failure that survived the restart), retrying implies acknowledging
      // the recovery context — clear awaiting_continue too so the banner
      // doesn't linger after the retried turn lands.
      try {
        const row = getMultiAgentSession(msg.sessionId);
        if (row?.awaiting_continue === 1) {
          setAwaitingContinue(msg.sessionId, false);
        }
      } catch (err) {
        console.error('[ws] clear awaiting_continue on retry failed', err);
      }
      try {
        await active.retry();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message,
        });
      }
      return;
    }
    case 'abandon_session': {
      // Item #4: give up on the pending-retry slot and end the session as
      // `'stopped'`. Same teardown as `stop_multi_agent`, distinct verb so
      // we can later differentiate post-hoc (analytics, iteration browser
      // labels) "operator stopped a healthy run" from "abandoned after a
      // failure". Handle.stop already clears pending-retry as part of its
      // teardown.
      const active = conn.multiAgent;
      if (!active || active.sessionId !== msg.sessionId) {
        return;
      }
      try {
        await active.stop('stopped');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message,
        });
      }
      return;
    }
    case 'continue_through_mutation': {
      // Item #5: operator clicked Continue on the pause-on-first-mutation
      // banner. Idempotent — the handle reads its own pending slot and no-ops
      // if cleared. Clearing `awaiting_continue` happens inside the handle's
      // `continueThroughMutation` (it set it on pause; clears it on resume).
      const active = conn.multiAgent;
      if (!active || active.sessionId !== msg.sessionId) {
        return;
      }
      try {
        await active.continueThroughMutation();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message,
        });
      }
      return;
    }
    case 'set_multi_agent_lifecycle': {
      const active = conn.multiAgent;
      if (!active || active.sessionId !== msg.sessionId) {
        // No active session or a different one — drop silently. The
        // client may have raced a `multi_agent_ended`.
        return;
      }
      if (!('setLifecycle' in active)) {
        // Chain handle doesn't expose setLifecycle in v1. Surface as
        // wrapper_error so the operator gets feedback rather than a
        // silent no-op.
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message: 'chain-mode sessions do not support lifecycle changes mid-run.',
        });
        return;
      }
      try {
        await active.setLifecycle(msg.lifecycle);
        send(conn.ws, {
          type: 'multi_agent_lifecycle_changed',
          sessionId: msg.sessionId,
          lifecycle: msg.lifecycle,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message: `set_multi_agent_lifecycle failed: ${message}`,
        });
      }
      return;
    }
    case 'add_multi_agent_participant': {
      const active = conn.multiAgent;
      if (!active || active.sessionId !== msg.sessionId) {
        return;
      }
      if (!('addWorker' in active)) {
        // Chain-mode handle has no addWorker — chain_order is baked in
        // at start. Surface as wrapper_error.
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message: 'chain-mode sessions do not support adding participants mid-run.',
        });
        return;
      }
      try {
        const result = await active.addWorker(msg.projectId);
        send(conn.ws, {
          type: 'multi_agent_participant_added',
          sessionId: msg.sessionId,
          projectId: msg.projectId,
          agentName: result.agentName,
          busWasAlreadyInstalled: result.busWasAlreadyInstalled,
        });
        // Project bus state may have changed via auto-install — notify
        // the sidebar so its bus-installed indicator updates. Matches
        // the `install_bus_integration` handler's two-message echo:
        // `bus_integration_changed` for the single project, plus a
        // refreshed `projects` list for any UI surface that reads the
        // wider state.
        if (!result.busWasAlreadyInstalled) {
          send(conn.ws, {
            type: 'bus_integration_changed',
            projectId: msg.projectId,
            installed: true,
            agentName: result.agentName,
          });
          const rows = await syncWorkspaceProjects();
          send(conn.ws, { type: 'projects', projects: rows.map(rowToProject) });
          // Cluster A Phase 4 (D6/D11): split out of the
          // `multi_agent_participant_added` echo so the auto-install side
          // effect is observable as a typed event + an info-tier dock
          // toast. The sidebar bus-installed indicator already flips via
          // `bus_integration_changed` above; this is the operator-visible
          // notification of WHY it flipped (adding a participant
          // implicitly enabled the bus for that project).
          send(conn.ws, {
            type: 'bus_auto_installed',
            sessionId: msg.sessionId,
            projectId: msg.projectId,
            agentName: result.agentName,
          });
          const notifResult = emitNotification(
            {
              class: 'operational',
              severity: 'info',
              dedupeKey: `bus_auto_installed:${msg.projectId}`,
              title: 'Bus integration auto-installed',
              message: `Project added to bus as ${result.agentName}.`,
              sessionId: msg.sessionId,
              projectId: msg.projectId,
            },
            (m) => send(conn.ws, m),
          );
          if (!notifResult.ok) {
            console.error('[ws] bus_auto_installed dispatcher.emit failed', notifResult.error);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message: `add_multi_agent_participant failed: ${message}`,
        });
      }
      return;
    }
    case 'list_iterations': {
      send(conn.ws, { type: 'iterations', items: await buildIterationsList() });
      return;
    }
    case 'clear_iterations': {
      // Delete finished DB rows + their events + their participants. Disk
      // artifacts under the per-session folder are left in place — useful
      // for post-mortem; the operator can `rm -rf` by hand. The pure-SDK
      // runtime has no out-of-process sessions to reap: a still-live run
      // is in the in-process registry with a `running` row (never cleared
      // here), and a server restart already ended every prior run.
      clearFinishedMultiAgentSessions();
      send(conn.ws, { type: 'iterations', items: await buildIterationsList() });
      return;
    }
    case 'archive_session': {
      // Cluster D Phase 5: see `executeArchiveSession` below — the case
      // body is intentionally thin so the validation + side-effects
      // (DB row flip, optional rm, recovery_log row, reply envelope)
      // can be unit-tested without standing up a WS server. Same
      // refactor pattern as `resolveRetryRateLimited` above.
      await executeArchiveSession({
        sessionId: msg.sessionId,
        removeArtifacts: msg.removeArtifacts === true,
        send: (m) => send(conn.ws, m),
      });
      return;
    }
    case 'get_recovery_log_snapshot': {
      // Cluster D Phase 8a (spec §8.5): read-only snapshot of the
      // recovery_log table for the Phase 8b RecoveryLogInspector. The
      // executor lives next to executeArchiveSession for the same
      // testability reason — the handler is thin, the side-effect-free
      // composition (aggregates + named gauges + recent page) is in
      // executeRecoveryLogSnapshot.
      executeRecoveryLogSnapshot({
        recentLimit: msg.recentLimit,
        send: (m) => send(conn.ws, m),
      });
      return;
    }
    case 'get_kick_forensics': {
      // Cluster C Phase 4g4 (spec §5.5, §6.4): fetch the multi-agent
      // forensic bundle captured at kick time for (sessionId, agentSlug)
      // and reply with `kick_forensics_snapshot`. Executor JSON-parses
      // the persisted columns + joins kick provenance from the
      // companion safety_audit row so the modal can render the full
      // bundle without a second round-trip.
      executeKickForensicsSnapshot({
        sessionId: msg.sessionId,
        agentSlug: msg.agentSlug,
        send: (m) => send(conn.ws, m),
      });
      return;
    }
    case 'reopen_session': {
      // Cluster D Phase 5b (spec §6.3): probe handler — validates the
      // target session is finalizable + has a resolvable participant
      // path, computes a workspace diff against that path, and replies
      // with `reopen_session_confirm_required` for the modal to render.
      // Does NOT swap or reconstruct — that's `reopen_session_confirmed`
      // below. Extracted into a testable async function for the same
      // reason as `executeArchiveSession`.
      await executeReopenSessionProbe({
        sessionId: msg.sessionId,
        send: (m) => send(conn.ws, m),
      });
      return;
    }
    case 'reopen_session_confirmed': {
      // Cluster D Phase 5c (spec §6.3 / BE-D20, BE-D21): commit step.
      // Body delegated to `executeReopenSessionConfirmed` for testability.
      // The conn-bound side effects (detach current active, set
      // `conn.multiAgent`) ride a small bridge object so the helper
      // doesn't need a full Conn type.
      await executeReopenSessionConfirmed({
        sessionId: msg.sessionId,
        acknowledgedWorkspaceDiff: msg.acknowledgedWorkspaceDiff === true,
        typedConfirmation: msg.typedConfirmation,
        currentActiveSessionId: conn.multiAgent?.sessionId ?? null,
        detachCurrentActive: () => {
          if (conn.multiAgent) {
            conn.multiAgent.detach();
            conn.multiAgent = null;
          }
        },
        adoptResumed: (resumed) => {
          emitResumedSession(conn, resumed);
        },
        resumeCallbacks: {
          ...resumeCallbacks(conn),
          hopBudget: resolveHopBudget(),
        },
        send: (m) => send(conn.ws, m),
      });
      return;
    }
    case 'list_templates': {
      send(conn.ws, { type: 'templates', items: listTemplates() });
      return;
    }
    case 'save_template': {
      const items = saveTemplate({
        name: msg.name,
        mode: msg.mode,
        lifecycle: msg.lifecycle,
        participants: msg.participants,
        roles: msg.roles,
        // PR-6: passthrough only — repo persists as-is, future editor
        // validates via shared/topology.ts before sending.
        layout: msg.layout,
        // PR-7: optional per-template hop budget. The repo clamps + drops
        // non-finite/sub-1 input; passing `undefined` keeps the template
        // on the global default (no override).
        hopBudget: msg.hopBudget,
      });
      send(conn.ws, { type: 'templates', items });
      return;
    }
    case 'delete_template': {
      send(conn.ws, { type: 'templates', items: deleteTemplate(msg.id) });
      return;
    }
    case 'load_session_log': {
      // Phase H: paginated merged log for a multi-agent session. Pure read
      // — no DB mutation, no side effects, no permission check beyond
      // session existence. `revealSensitive=true` requires the operator's
      // explicit confirm client-side (the WS message is enough server-side
      // because the connection is already bound to 127.0.0.1).
      const meta = getMultiAgentSession(msg.sessionId);
      if (!meta) {
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message: `load_session_log: no such multi-agent session ${msg.sessionId}`,
        });
        return;
      }
      const offset = Number.isFinite(msg.offset) ? Math.max(0, Math.floor(msg.offset)) : 0;
      const limit = Number.isFinite(msg.limit) ? Math.max(1, Math.floor(msg.limit)) : 200;
      const chunk = buildSessionLogChunk({
        sessionId: msg.sessionId,
        offset,
        limit,
        revealSensitive: msg.revealSensitive === true,
      });
      send(conn.ws, {
        type: 'session_log_chunk',
        sessionId: msg.sessionId,
        offset,
        rows: chunk.rows,
        total: chunk.total,
        hasMore: chunk.hasMore,
        revealedSensitive: chunk.revealedSensitive,
      });
      return;
    }
    case 'retry_rate_limited': {
      // Cluster D Phase 4b (spec §4.2, BE-D4 / BE-D8): re-deliver the
      // captured user prompt on the same `--resume` session id so the
      // SDK reuses its init quota. The retry trigger comes either
      // from the operator clicking "Retry now" in the RateLimitBanner
      // (Phase 4c) or from the client-scheduled auto-fire
      // (`{ auto: true }`); both paths land here.
      //
      // Validation is `resolveRetryRateLimited` — see its docstring for
      // the matrix of `no-held-prompt` vs `in-flight` vs `ok`. We split
      // it out for unit-testability since the rest of this case body
      // is integration-shaped (calls runOneTurn).
      const resolution = resolveRetryRateLimited(
        conn.capturedPrompts,
        conn.inFlight,
        msg.sessionId,
      );
      if (resolution.kind === 'no-held-prompt') {
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message:
            'No held prompt to retry — the session is not currently waiting on a rate-limit recovery.',
        });
        return;
      }
      if (resolution.kind === 'in-flight') {
        send(conn.ws, {
          type: 'wrapper_error',
          sessionId: msg.sessionId,
          kind: 'process_crashed',
          message: 'Retry already in flight for this session.',
        });
        return;
      }
      // Write the recovery_log row BEFORE re-running so the metric is
      // captured even if the retry's `runOneTurn` itself throws
      // synchronously. `auto` distinguishes operator-click
      // (`manual_retry`) from the client-side auto-scheduler
      // (`auto_retry`) — spec §8.5's regression-gate query separates
      // them so a release that silently leans on auto-retry instead of
      // fixing the underlying rate-limit budget is visible in the
      // metrics.
      try {
        appendRecoveryLog({
          sessionId: msg.sessionId,
          failureClass: 'rate_limit',
          operatorAction: msg.auto ? 'auto_retry' : 'manual_retry',
        });
      } catch (err) {
        console.error('[ws] appendRecoveryLog rate-limit retry failed', err);
      }
      // Re-invoke runOneTurn with the captured bytes; `runOneTurn` is
      // responsible for clearing or re-asserting `capturedPrompts`
      // based on the new turn's outcome.
      await runOneTurn(conn, {
        type: 'send_message',
        projectId: resolution.projectId,
        sessionId: msg.sessionId,
        text: resolution.text,
      });
      return;
    }
    case 'send_message': {
      await runOneTurn(conn, msg);
      return;
    }
    case 'get_last_run_for_template': {
      // PR-7: read the most-recent persisted row for this template id, map
      // to the wire shape, and reply. Always emits — `lastRun: null` when
      // no row matches (template never used, or only used by pre-013 runs
      // whose `template_id` was never recorded). Pure read; safe to call
      // outside an active session.
      if (typeof msg.templateId !== 'string' || msg.templateId.length === 0) {
        send(conn.ws, {
          type: 'last_run_for_template',
          templateId: typeof msg.templateId === 'string' ? msg.templateId : '',
          lastRun: null,
        });
        return;
      }
      const row = getLastRunForTemplate(msg.templateId);
      if (!row) {
        send(conn.ws, { type: 'last_run_for_template', templateId: msg.templateId, lastRun: null });
        return;
      }
      // Resolve artifactsDir from the iteration id + session_folder, mirroring
      // the pattern used by the iterations browser handler above. NULL on
      // pre-006 rows with no iteration_id, omitted entirely on the wire then.
      const artifactsDir = row.iteration_id
        ? row.session_folder
          ? sessionPathsFromFolder(row.session_folder).iterationDir(row.iteration_id)
          : busIterationDir(row.iteration_id)
        : undefined;
      send(conn.ws, {
        type: 'last_run_for_template',
        templateId: msg.templateId,
        lastRun: {
          sessionId: row.id,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          // SQLite has no enum — same `as` narrowing the iterations browser
          // uses above. Invalid stored statuses are impossible in practice
          // (the only writers are this server's typed code paths).
          status: row.status as 'running' | 'completed' | 'stopped' | 'crashed',
          hopsUsed: row.hops_used,
          hopBudget: row.hop_budget,
          ...(row.first_error ? { firstError: row.first_error } : {}),
          ...(artifactsDir ? { artifactsDir } : {}),
        },
      });
      return;
    }
    case 'read_project_facts': {
      // PR-6: pure-read RPC for the per-participant facts disclosure in the
      // template-preview modal. Always replies (even when the project row is
      // missing or there's no CLAUDE.md) so the client can resolve its
      // pending request and render whatever data IS available.
      const project = getProject(msg.projectId);
      if (!project) {
        // No matching project — emit a minimal stub so the disclosure shows
        // "(project unavailable)" rather than spinning forever. A wrapper_error
        // would be loud for what is, from the operator's POV, just stale
        // template data (a deleted project still referenced by a saved template).
        send(conn.ws, {
          type: 'project_facts',
          projectId: msg.projectId,
          facts: { name: `(deleted #${msg.projectId})`, path: '' },
        });
        return;
      }
      const head = readProjectClaudeMdHead(project.path);
      send(conn.ws, {
        type: 'project_facts',
        projectId: project.id,
        facts: {
          name: project.name,
          path: project.path,
          ...(head ? { claudeMdHead: head.head, claudeMdSizeLabel: head.sizeLabel } : {}),
        },
      });
      return;
    }
    case 'start_auth_refresh': {
      // Cluster D Phase 6b: spawn `claude login`. Module guarantees
      // single-flight process-wide; concurrent requests get
      // `auth_refresh_failed { reason: 'already_running' }` with the
      // existing runId so a second tab can re-attach its modal.
      //
      // We don't await the spawn — `startAuthRefresh` is synchronous
      // (returns immediately after spawn), and the subprocess streams
      // output via the callbacks we register here. The callbacks
      // capture `conn.ws` by reference; if the WS disconnects mid-
      // flow, `send()` becomes a no-op (it checks readyState ===
      // OPEN) so we don't accidentally write to a closed socket.
      // The subprocess itself continues running because the operator
      // may still complete OAuth in their browser.
      const callbacks: AuthRefreshCallbacks = {
        onStarted: ({ runId, pid }) => {
          send(conn.ws, { type: 'auth_refresh_started', runId, pid });
        },
        onOutput: ({ runId, stream, text }) => {
          send(conn.ws, { type: 'auth_refresh_output', runId, stream, text });
        },
        onCompleted: ({ runId, exitCode, success }) => {
          send(conn.ws, { type: 'auth_refresh_completed', runId, exitCode, success });
        },
      };
      const result = startAuthRefresh(callbacks);
      if (!result.ok) {
        if (result.reason === 'already_running') {
          send(conn.ws, {
            type: 'auth_refresh_failed',
            reason: 'already_running',
            existingRunId: result.existingRunId,
          });
        } else {
          send(conn.ws, {
            type: 'auth_refresh_failed',
            reason: 'spawn_failed',
            error: result.error,
          });
        }
      }
      return;
    }
    case 'cancel_auth_refresh': {
      // Cluster D Phase 6b: operator clicked Cancel in the modal. The
      // module kills the subprocess; child.on('exit') fires
      // onCompleted which sends the auth_refresh_completed envelope.
      // No reply needed for the cancel itself — the completed
      // envelope is the signal.
      //
      // Mismatched runId is a silent no-op (race-defense: a stale
      // Cancel after natural completion shouldn't kill a freshly-
      // started run).
      cancelAuthRefresh(msg.runId);
      return;
    }
  }
}

async function runOneTurn(
  conn: Conn,
  msg: Extract<ClientMsg, { type: 'send_message' }>,
): Promise<void> {
  const project = getProject(msg.projectId);
  if (!project) {
    send(conn.ws, {
      type: 'wrapper_error',
      kind: 'process_crashed',
      message: `unknown project ${msg.projectId}`,
    });
    return;
  }

  // F5: when the caller supplies an existing sessionId, verify it belongs
  //     to the supplied projectId. Without this check a client could
  //     resume project B's session with cwd=project A, mixing transcripts
  //     across projects. Pattern mirrors `replaySession` below.
  if (msg.sessionId) {
    const existing = getSession(msg.sessionId);
    if (!existing || existing.project_id !== project.id) {
      send(conn.ws, {
        type: 'wrapper_error',
        sessionId: msg.sessionId,
        kind: 'process_crashed',
        message: `unknown session ${msg.sessionId} for project ${project.id}`,
      });
      return;
    }
  }

  const sessionId = msg.sessionId ?? randomUUID();
  if (!msg.sessionId) createSession(sessionId, project.id);
  touchProject(project.id);

  // Cluster B Phase 4b (§4.4): TOFU spawn-gate. Same helper the bus
  // start-paths use, scoped to this single project. Fires per turn; when
  // every declared MCP is already 'trusted' it's a silent no-op (one
  // checkTrust lookup per row). On first_seen / hash_changed the operator
  // is prompted and the spawn awaits their decision before pickRunner.
  await gateProjectsForSpawn(conn, [project.id]);

  const ac = new AbortController();

  const trusted = project.trusted === 1;
  // Initial mode preserves the user's last in-session preference (persisted on
  // `sessions.permission_mode`) across turns. Falls back to the trust-derived
  // default for fresh sessions. Trust still drives `settingSources` either way.
  const permissionMode = seedPermissionMode(msg.sessionId, trusted);
  const settingSources = trusted ? (['user', 'project', 'local'] as const) : (['user'] as const);

  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<
    | { behavior: 'allow'; updatedInput: Record<string, unknown> }
    | { behavior: 'deny'; message: string }
  > => {
    // Read the live mode from `inFlight` (mutated by `set_permission_mode`).
    // The closure-captured `permissionMode` is the bootstrap fallback for the
    // narrow window before `inFlight.set(...)` runs below — in practice the SDK
    // doesn't emit tool calls before that, but be defensive.
    const liveMode = conn.inFlight.get(sessionId)?.permissionMode ?? permissionMode;
    if (shouldAutoAllow(trusted, liveMode, toolName)) {
      // Persist a silent record so replays can show "tool was auto-allowed"
      // without a card. We don't emit a ServerMsg — the tool_use block itself
      // is the user-visible signal that the tool ran.
      await persistMessage(sessionId, {
        type: 'wrapper',
        subtype: 'permission_auto_allowed',
        session_id: sessionId,
        uuid: randomUUID(),
        toolName,
        input,
        mode: liveMode,
      } as never);
      return { behavior: 'allow', updatedInput: input };
    }
    const requestId = randomUUID();
    // Item #5: classify server-side so the React card can pick the right
    // subcomponent (Bash / Edit / Write / …) + badge color without
    // re-running the classifier client-side. `category` / `summary` / `cwd`
    // / `projectName` are optional on the wire so pre-Item-5 replays still
    // render via the JSON-fallback subcomponent.
    const classification = classifyToolCall(toolName, input);
    send(conn.ws, {
      type: 'permission_request',
      requestId,
      sessionId,
      toolName,
      input,
      category: classification.category,
      summary: classification.summary,
      cwd: project.path,
      projectName: project.name,
    });
    await persistMessage(sessionId, {
      type: 'wrapper',
      subtype: 'permission_request',
      session_id: sessionId,
      uuid: requestId,
      requestId,
      toolName,
      input,
      category: classification.category,
      summary: classification.summary,
      cwd: project.path,
      projectName: project.name,
    } as never);
    return new Promise((resolve) => {
      conn.pendingPermissions.set(requestId, { sessionId, resolve, toolInput: input, toolName });
    });
  };

  // Cluster D Phase 4b (BE-D4): cache the user-prompt bytes BEFORE the
  // SDK turn starts so a hard rate-limit can offer the operator a
  // single-click retry that re-delivers the same prompt. The map is
  // cleared on success or non-rate-limit failure; the
  // `retry_rate_limited` handler reads it to look up the prompt + the
  // owning project (we keep both so the handler can re-invoke
  // `runOneTurn` without re-querying the sessions table). Pre-empt any
  // stale entry — a second send to the same session id is the operator
  // moving past a held rate-limit on their own.
  conn.capturedPrompts.set(sessionId, { text: msg.text, projectId: project.id });

  // Cluster F Phase A1b (UI-A1): capture the resolved cap + whether the
  // caller passed an explicit per-turn override. Both feed the result-
  // envelope decoration (`effectiveMaxTurns`) AND the safety_audit row
  // we emit on cap hit — `actor=operator` when the override was set
  // (the operator made this call themselves), `actor=system` when the
  // run fell back to the resolver's lower precedence steps.
  const effectiveMaxTurns = resolveMaxTurns(msg.maxTurns);
  const maxTurnsActor: 'operator' | 'system' =
    typeof msg.maxTurns === 'number' && Number.isFinite(msg.maxTurns) && msg.maxTurns >= 1
      ? 'operator'
      : 'system';
  const runner = pickRunner({
    cwd: project.path,
    prompt: msg.text,
    sessionId: msg.sessionId ? undefined : sessionId,
    resume: msg.sessionId,
    includePartialMessages: true,
    permissionMode,
    settingSources: [...settingSources],
    canUseTool,
    abortController: ac,
    // Cluster F Phase A1a (UI-A1): resolver picks the per-turn
    // override (msg.maxTurns) over the persisted setting over the env
    // default. Re-read on every send so a SettingsModal change between
    // turns takes effect immediately.
    maxTurns: effectiveMaxTurns,
  });
  const unregister = registerQuery(runner);

  conn.inFlight.set(sessionId, { ac, projectId: project.id, runner, permissionMode });
  // Persist the seed so subsequent runOneTurn calls (this same session) and
  // replay see it. This also covers brand-new sessions where the row was just
  // INSERTed with permission_mode = NULL.
  setSessionPermissionMode(sessionId, permissionMode);
  send(conn.ws, {
    type: 'session_running',
    projectId: project.id,
    sessionId,
    running: true,
  });
  send(conn.ws, {
    type: 'permission_mode_changed',
    sessionId,
    mode: permissionMode,
  });

  // Cluster D Phase 4b: `held` reflects "the turn ended due to a hard
  // rate-limit and the captured prompt is still in `conn.capturedPrompts`
  // waiting for a `retry_rate_limited`". The finally block reads it to
  // decide whether to attach `status: 'rate_limited'` to the
  // `session_running` flip — so the client knows this isn't a normal
  // turn end, the prompt is held and a retry-now affordance applies.
  let heldByRateLimit = false;

  try {
    for await (const sdkMsg of runner) {
      await persistMessage(sessionId, sdkMsg);
      // Cluster F Phase A1b (UI-A1): `out` is `let` (was `const`) so the
      // result-envelope decoration below can re-bind it with the
      // server-side `effectiveMaxTurns` snapshot. Every other branch
      // continues to use the translated envelope verbatim.
      let out = translate(sdkMsg, project.id);
      if (out) {
        cacheSessionStartedIfNeeded(conn, out);
        // Cluster F Phase A1b (UI-A1): decorate result envelopes with the
        // effective cap so the client doesn't have to guess (a SettingsModal
        // change mid-turn would otherwise produce a stale denominator on
        // the turn-counter chip / MaxTurnsResultCard).
        if (out.type === 'result') {
          out = { ...out, effectiveMaxTurns };
        }
        send(conn.ws, out);
        // Cluster F Phase A1b (UI-A1): dual-write safety_audit on cap hit
        // (BE-1: safety class). The audit row records WHO chose the cap
        // (`actor=operator` if msg.maxTurns was explicit, `'system'` if the
        // run fell through to the DB/env/built-in default) so post-hoc
        // analysis can distinguish "operator deliberately throttled and
        // hit it" from "no one chose this number and it tripped". The
        // operator-facing toast is fanned out by the dispatcher as a
        // sticky safety notification.
        if (out.type === 'result' && out.subtype === 'error_max_turns') {
          emitNotification(
            {
              class: 'safety',
              severity: 'warn',
              dedupeKey: `max_turns.hit:${sessionId}`,
              title: `Reached max-turns cap (${effectiveMaxTurns})`,
              message:
                maxTurnsActor === 'operator'
                  ? `The per-turn override of ${effectiveMaxTurns} was reached. Extend the cap or end the session.`
                  : `The default cap of ${effectiveMaxTurns} was reached. Extend the cap or raise the default in Settings.`,
              sessionId,
              reasonCode: 'max_turns_exceeded',
              auditKind: 'max_turns.hit',
              auditPayload: {
                effectiveMaxTurns,
                actor: maxTurnsActor,
                numTurns: out.numTurns ?? null,
                hadOverride: maxTurnsActor === 'operator',
              },
            },
            (m) => send(conn.ws, m),
          );
        }
        // Cluster A Phase 3 (B2): typed `rate_limit_event` also fans out as
        // an operational warn toast via the dispatcher. We do this only on
        // the live stream — `replaySession` deliberately doesn't toast
        // historical events.
        if (out.type === 'rate_limit_event') {
          // Cluster A Phase 6: dedupeKey carries the sub-code so a
          // hit→cleared transition produces two distinct envelopes (rather
          // than collapsing into one warn with stale countdown text).
          const dispatch = rateLimitDispatch(out);
          emitNotification(
            {
              class: 'operational',
              severity: dispatch.severity,
              dedupeKey: `rate_limit:${dispatch.subCode}:${sessionId}`,
              title: dispatch.title,
              message: dispatch.message,
              sessionId,
              reasonCode: dispatch.subCode,
            },
            (msg) => send(conn.ws, msg),
          );
          // Cluster D Phase 4b (BE-D2 / spec §4.1): hard rate-limit
          // flips `session_running.status` to `'rate_limited'`. The
          // turn is still in flight at this point (the SDK may yet
          // recover after the reset, or it may error out below); we
          // emit running=true with the status set so the operator
          // banner shows the countdown without waiting for the
          // finally-block running=false.
          if (out.status === 'hard') {
            send(conn.ws, {
              type: 'session_running',
              projectId: project.id,
              sessionId,
              running: true,
              status: 'rate_limited',
            });
          }
        }
      }
    }
  } catch (err) {
    const wrap = classifyError(err);
    send(conn.ws, { type: 'wrapper_error', sessionId, kind: wrap.kind, message: wrap.message });
    await persistMessage(sessionId, {
      type: 'wrapper',
      subtype: wrap.kind,
      session_id: sessionId,
      uuid: randomUUID(),
      message: wrap.message,
    } as never);
    // Cluster A Phase 6: fan out as an operational notification with a
    // typed reason-code so the dock + inbox surface session crashes /
    // auth lapses uniformly. The session-scoped MessageBlock status banner
    // already shows the wrapper_error inline (store.ts handles that), so
    // this is the dock + inbox path — the operator may be on another tab
    // when the turn dies. `rate_limited` is handled separately on the live
    // stream via the typed `rate_limit_event` path; we skip it here to
    // avoid double-toasting.
    if (wrap.kind !== 'rate_limited') {
      const dispatch = wrapperErrorDispatch(wrap.kind, sessionId);
      emitNotification(
        {
          class: 'operational',
          severity: dispatch.severity,
          dedupeKey: `${dispatch.auditKind}:${sessionId}`,
          title: dispatch.title,
          message: wrap.message,
          sessionId,
          sticky: true,
          reasonCode: dispatch.reasonCode,
          ...(dispatch.action ? { action: dispatch.action } : {}),
        },
        (out) => send(conn.ws, out),
      );
    }
    // Cluster D Phase 4b: rate-limited classification → keep the
    // captured prompt for `retry_rate_limited` to find. Other kinds
    // (auth_expired, process_crashed, parse_error) need a different
    // recovery flow (re-auth modal, restart, etc.); the prompt would
    // be stale data on those paths, so drop it.
    heldByRateLimit = wrap.kind === 'rate_limited';
  } finally {
    try {
      runner.close?.();
    } catch (err) {
      console.error('[ws] runner.close failed', err);
    }
    unregister();
    conn.inFlight.delete(sessionId);
    closeLogger(sessionId);
    // Cluster D Phase 4b: clear the captured prompt UNLESS the turn
    // ended held by a rate-limit. This is the only path that wants the
    // prompt to persist past the turn — every other end (success, non-
    // rate-limit failure) means the bytes are stale and the next user
    // input writes a fresh entry.
    if (!heldByRateLimit) {
      conn.capturedPrompts.delete(sessionId);
    }
    send(conn.ws, {
      type: 'session_running',
      projectId: project.id,
      sessionId,
      running: false,
      // When held, signal status so the client's reducer can keep the
      // banner mounted and the input-disabled overlay in place. Old
      // clients ignore the field; new clients (Phase 4c) reduce it.
      ...(heldByRateLimit && { status: 'rate_limited' as const }),
    });
  }
}

async function replaySession(conn: Conn, projectId: number, sessionId: string): Promise<void> {
  const session = getSession(sessionId);
  if (!session || session.project_id !== projectId) {
    send(conn.ws, {
      type: 'wrapper_error',
      sessionId,
      kind: 'process_crashed',
      message: `unknown session ${sessionId} for project ${projectId}`,
    });
    return;
  }
  send(conn.ws, { type: 'session_history_start', projectId, sessionId });
  for (const row of listEvents(sessionId)) {
    let parsed: SDKMessage;
    try {
      parsed = JSON.parse(row.raw) as SDKMessage;
    } catch {
      continue;
    }
    const out = translate(parsed, projectId);
    if (out) {
      cacheSessionStartedIfNeeded(conn, out);
      send(conn.ws, out);
    }
  }
  send(conn.ws, { type: 'session_history_end', projectId, sessionId });

  // Replay the persisted permission mode for past sessions too, so the toggle
  // UI doesn't lie about what was active. Live sessions overwrite this with
  // the in-memory mode below.
  const stored = getSessionPermissionMode(sessionId);
  if (stored) {
    send(conn.ws, { type: 'permission_mode_changed', sessionId, mode: stored });
  }

  const live = conn.inFlight.get(sessionId);
  if (live) {
    send(conn.ws, { type: 'session_running', projectId, sessionId, running: true });
    send(conn.ws, {
      type: 'permission_mode_changed',
      sessionId,
      mode: live.permissionMode,
    });
  }
}

export type { Conn };
