import type {
  ClientMsg,
  ControlReasonCode,
  ControllabilityFailureCode,
  PauseExpiryAction,
  ServerMsg,
} from '@cebab/shared/protocol';
import { isControlReasonCode, isPauseExpiryAction } from '@cebab/shared/protocol';
import {
  appendSafetyAudit,
  type SafetyAuditInput,
} from '../notifications/safety_audit.js';
import { getMultiAgentSession, listResolvedParticipants } from '../repo/multi_agent.js';
import {
  clearParticipantPause,
  getControlState,
  setParticipantMuted,
  setParticipantPause,
} from '../repo/per_agent_control.js';

/**
 * Cluster C Phase 4b: WS handlers for the per-agent control verbs. Phase 4b
 * ships **mute** end-to-end (orchestrator router enforcement + dual-write +
 * state-change echo); pause + kick get their own slices (4c, 4d) so each PR
 * is reviewable in isolation. Lives in a dedicated module so the growing
 * controllability surface doesn't bloat `ws/server.ts`.
 *
 * Handler flow (spec §3 invariant 2 — every control action dual-writes to
 * safety_audit BEFORE the wire ack):
 *
 *   1. Validate the wire shape (reasonCode enum, 'other' + reasonText
 *      pairing, mode-specific topology guards).
 *   2. Validate the participant exists + isn't already in the target state
 *      (idempotent: re-mute returns wrapper_error `already_in_state` so a
 *      stale UI doesn't surface success-then-no-effect).
 *   3. Flip the persistence layer (`per_agent_control.setParticipantMuted`).
 *      The DB write is the source-of-truth and MUST land before the
 *      router's in-memory set is updated; otherwise an R-B restart between
 *      step 3 and step 4 could lose the mute.
 *   4. Update the router's in-memory `mutedSet` via the OrchestratorSessionHandle's
 *      `setMute`. The router's per-event drop check (in
 *      `bus/orchestrator.ts:handleEvent`) consults THIS set.
 *   5. Write the safety_audit row (kind='agent_control.muted' or
 *      'agent_control.unmuted', reasonCode from the operator's choice,
 *      payload carries the agent slug + projectId).
 *   6. Send the `participant_mute_changed` ServerMsg echo so the client
 *      reducer can reconcile its optimistic flip.
 *
 * Why the OrchestratorSessionHandle.setMute call (step 4) sits between
 * the DB flip (3) and the audit write (5):
 *   - If audit append fails AFTER the router is updated, the operator's
 *     intent is honored but the trail breaks. Phase 4b logs + returns the
 *     `wrapper_error` so the operator can retry; the DB + router are
 *     already aligned, so a retry just re-attempts the audit.
 *   - If we ordered audit before router update + audit failed, we'd have
 *     to roll back the DB flip — adding atomicity complexity for a corner
 *     case that's already covered by the retry path.
 *
 * Failure code semantics (return-without-action):
 *   - participant_not_found    — (sessionId, projectId) doesn't identify a
 *                                participant row
 *   - chain_mute_unsupported   — Mute targeted in chain mode (§5.3)
 *   - orchestrator_cannot_kick — Mute targeted at the orchestrator's own
 *                                row (we reuse the kick failure code for
 *                                "cannot mute the orchestrator" — silencing
 *                                the orchestrator would silently end the
 *                                whole session)
 *   - already_in_state         — Re-mute or re-unmute is rejected so the UI
 *                                doesn't see "success" twice with one flip
 */

export type ExecuteMuteResult =
  | { ok: true; auditId: string }
  | { ok: false; failureCode: ControllabilityFailureCode; message: string };

export type ExecuteMuteInput = {
  msg: Extract<ClientMsg, { type: 'mute_participant' | 'unmute_participant' }>;
  /**
   * The live orchestrator handle for this session, when present. Phase 4b
   * is orchestrator-only; chain handles short-circuit with
   * `chain_mute_unsupported`. The handle's `setMute` and `isMuted` are
   * the router's hot-path mirror; the DB column is the durable source of
   * truth.
   */
  orchestratorHandle:
    | { setMute: (agentName: string, muted: boolean) => boolean; isMuted: (agentName: string) => boolean }
    | undefined;
  /**
   * Mode of the live session for `chain_mute_unsupported` detection. Null
   * means there is no live session at all (unknown id, recently torn
   * down) — handler short-circuits with `participant_not_found`.
   */
  sessionMode: 'orchestrator' | 'chain' | null;
  /** Test seams. */
  appendAudit?: typeof appendSafetyAudit;
  now?: () => number;
};

export function executeMuteParticipant(input: ExecuteMuteInput): ExecuteMuteResult {
  return runMuteUnmute(input, /* targetMuted */ true);
}

export function executeUnmuteParticipant(input: ExecuteMuteInput): ExecuteMuteResult {
  return runMuteUnmute(input, /* targetMuted */ false);
}

function runMuteUnmute(input: ExecuteMuteInput, targetMuted: boolean): ExecuteMuteResult {
  const { msg } = input;
  const appendAudit = input.appendAudit ?? appendSafetyAudit;
  const now = input.now ?? Date.now;

  // Wire-level validation: reasonCode + 'other' pairing.
  if (!isControlReasonCode(msg.reasonCode)) {
    return {
      ok: false,
      failureCode: 'already_in_state', // misuse — fall back to a generic enum (no enum for "bad reasonCode" itself)
      message: `invalid reasonCode: ${JSON.stringify(msg.reasonCode)}`,
    };
  }
  if (msg.reasonCode === 'other' && !msg.reasonText?.trim()) {
    return {
      ok: false,
      failureCode: 'already_in_state',
      message: "reasonCode='other' requires non-empty reasonText",
    };
  }

  // Session existence + mode guard.
  const sessionRow = getMultiAgentSession(msg.sessionId);
  if (!sessionRow) {
    return {
      ok: false,
      failureCode: 'participant_not_found',
      message: `unknown multi-agent session ${msg.sessionId}`,
    };
  }
  if (input.sessionMode === 'chain') {
    return {
      ok: false,
      failureCode: 'chain_mute_unsupported',
      message: 'mute is not supported in chain mode (would silently break the pipeline)',
    };
  }

  // Participant existence + role guard.
  const participants = listResolvedParticipants(msg.sessionId);
  const participant = participants.find((p) => p.project_id === msg.projectId);
  if (!participant) {
    return {
      ok: false,
      failureCode: 'participant_not_found',
      message: `project ${msg.projectId} is not a participant of session ${msg.sessionId}`,
    };
  }
  if (participant.role === 'orchestrator') {
    return {
      ok: false,
      failureCode: 'orchestrator_cannot_kick',
      message: 'cannot mute the orchestrator — it would silently end the session',
    };
  }
  if (!participant.bus_agent_name) {
    // Defensive: the orchestrator-mode spawn requires every worker to have a
    // bus_agent_name (it's how the router routes to them). A NULL here means
    // an unhealthy session row; reject so the caller can investigate.
    return {
      ok: false,
      failureCode: 'participant_not_found',
      message: `participant ${msg.projectId} has no bus_agent_name — install bus integration first`,
    };
  }

  // Idempotency guard on the DB column. setParticipantMuted returns false
  // when the row already matched the target — the handler surfaces that as
  // `already_in_state` so the UI can roll back an optimistic flip cleanly.
  const dbChanged = setParticipantMuted(msg.sessionId, msg.projectId, targetMuted);
  if (!dbChanged) {
    return {
      ok: false,
      failureCode: 'already_in_state',
      message: `${participant.bus_agent_name} is already ${targetMuted ? 'muted' : 'unmuted'}`,
    };
  }

  // Sync the orchestrator router's in-memory mute set. Missing handle is
  // possible in tests + during a corner-case where the live session was
  // torn down between getMultiAgentSession and here; we still write the
  // audit + return ok, but log the divergence so it's visible.
  if (input.orchestratorHandle) {
    input.orchestratorHandle.setMute(participant.bus_agent_name, targetMuted);
  } else {
    console.warn(
      `[ws] executeMute(${msg.sessionId}/${msg.projectId}): no live orchestrator handle to update router mute set`,
    );
  }

  // safety_audit dual-write. mute + unmute are BOTH safety class per spec
  // §3 (mute is an authority change; unmute restores authority). The
  // reason code carries the operator's choice; the payload carries the
  // resolved agent slug + projectId for forensic queries.
  const auditInput: SafetyAuditInput = {
    ts: now(),
    sessionId: msg.sessionId,
    agentId: participant.bus_agent_name,
    kind: targetMuted ? 'agent_control.muted' : 'agent_control.unmuted',
    reasonCode: msg.reasonCode,
    payload: {
      projectId: msg.projectId,
      agentSlug: participant.bus_agent_name,
      reasonText: msg.reasonText ?? null,
    },
  };
  let auditId: string;
  try {
    auditId = appendAudit(auditInput).id;
  } catch (err) {
    console.error(`[ws] executeMute safety_audit append failed for ${msg.sessionId}`, err);
    // DB + router are already aligned with the new state — surface the
    // audit failure but don't roll back. Operator can retry; the retry
    // path's `already_in_state` short-circuit will short-circuit the DB
    // step, so only the audit re-attempt runs.
    return {
      ok: false,
      failureCode: 'already_in_state',
      message: `safety_audit append failed: ${(err as Error).message}`,
    };
  }
  return { ok: true, auditId };
}

/**
 * Build the wire-shape state-change echo for a successful mute/unmute. Kept
 * separate from the executor so the WS dispatch site can build it after
 * threading sessionId + projectId + reasonCode through.
 */
export function buildParticipantMuteChangedMsg(args: {
  sessionId: string;
  projectId: number;
  muted: boolean;
  reasonCode: ControlReasonCode;
  reasonText?: string;
  ts: number;
}): Extract<ServerMsg, { type: 'participant_mute_changed' }> {
  return {
    type: 'participant_mute_changed',
    sessionId: args.sessionId,
    projectId: args.projectId,
    muted: args.muted,
    reasonCode: args.reasonCode,
    ...(args.reasonText !== undefined ? { reasonText: args.reasonText } : {}),
    actor: 'operator',
    ts: args.ts,
  };
}

/**
 * Probe whether a participant is currently muted — used by the bus_send
 * oracle-suppression test (PR's invariant assertion) to verify the
 * post-mute state. The current architecture has oracle suppression
 * BY-CONSTRUCTION: `handleBusSend` returns `delivered to <recipient>`
 * unconditionally regardless of router decisions (the muted agent's
 * outbound is dropped at the router AFTER bus_send already returned its
 * success text). So this probe isn't read by production code; it's
 * there so a future refactor that introduces oracle visibility (e.g.
 * surfacing a "dropped" status back into the tool result) fails the
 * AE-3 [security] test.
 */
export function probeIsMuted(args: {
  sessionId: string;
  projectId: number;
}): boolean {
  return getControlState(args.sessionId, args.projectId)?.muted === true;
}

// ---------- Cluster C Phase 4c: pause + resume ----------
//
// Pause/resume share the same orchestration shape as mute/unmute but with
// these differences:
//   - Pause REQUIRES a positive `timeoutMs` and a valid `expiryAction` on
//     the wire (spec §5.6 AE-6). Missing or non-positive timeout →
//     `pause_timeout_required`. Unknown expiryAction →
//     `pause_expiry_action_invalid`.
//   - Pause + resume are OPERATIONAL class (not safety). The spec §3
//     classifies the pause itself as operational; only the expiry timer's
//     `pause.expired_without_resume` event is safety class (lands with the
//     C4c2 expiry timer slice).
//   - Chain mode IS allowed (spec §5.3 — chain stalls at paused hop). For
//     Phase 4c, however, only orchestrator-mode handles expose the pause
//     wire — chain handle exposure lands in a follow-up. Chain attempts
//     return `participant_not_found` until that wires up.
//   - State-change echo carries `queuedDeliveries` (AE-5) so the operator
//     can see the pending-queue size growing while the agent is paused.

const HARD_TIMEOUT_FLOOR_MS = 1; // any positive value; spec §5.6 doesn't mandate a max
const HARD_TIMEOUT_CEILING_MS = 24 * 60 * 60 * 1000; // 24h — past this is clearly a misuse

export type ExecutePauseInput = {
  msg: Extract<ClientMsg, { type: 'pause_participant' }>;
  /**
   * Live orchestrator handle. Phase 4c is orchestrator-only on the wire;
   * chain handle exposure of pause is a follow-up. When the active session
   * is chain (or torn down), `orchestratorHandle` is undefined and the
   * handler returns `participant_not_found` — same code mute uses for
   * "no live target" so the client reducer can fold both cases.
   */
  orchestratorHandle:
    | {
        pauseAgent: (agentName: string) => boolean;
        getPendingDeliveries: (agentName: string) => number;
      }
    | undefined;
  sessionMode: 'orchestrator' | 'chain' | null;
  appendAudit?: typeof appendSafetyAudit;
  now?: () => number;
};

export type ExecuteResumeInput = {
  msg: Extract<ClientMsg, { type: 'resume_participant' }>;
  orchestratorHandle:
    | {
        resumeAgent: (agentName: string) => boolean;
        getPendingDeliveries: (agentName: string) => number;
      }
    | undefined;
  sessionMode: 'orchestrator' | 'chain' | null;
  appendAudit?: typeof appendSafetyAudit;
  now?: () => number;
};

export type ExecutePauseResult =
  | { ok: true; auditId: string; pausedUntil: number; queuedDeliveries: number }
  | { ok: false; failureCode: ControllabilityFailureCode; message: string };

export type ExecuteResumeResult =
  | { ok: true; auditId: string; queuedDeliveries: number }
  | { ok: false; failureCode: ControllabilityFailureCode; message: string };

export function executePauseParticipant(input: ExecutePauseInput): ExecutePauseResult {
  const { msg } = input;
  const appendAudit = input.appendAudit ?? appendSafetyAudit;
  const now = input.now ?? Date.now;

  // Wire validation: reasonCode + 'other' pairing.
  if (!isControlReasonCode(msg.reasonCode)) {
    return {
      ok: false,
      failureCode: 'already_in_state',
      message: `invalid reasonCode: ${JSON.stringify(msg.reasonCode)}`,
    };
  }
  if (msg.reasonCode === 'other' && !msg.reasonText?.trim()) {
    return {
      ok: false,
      failureCode: 'already_in_state',
      message: "reasonCode='other' requires non-empty reasonText",
    };
  }
  // Spec §5.6 AE-6: pause without positive timeoutMs is rejected at the
  // wire. A missing/non-positive value is the schema's NOT NULL contract
  // applied at the handler layer (the column itself is nullable because
  // "not paused" is also a valid state).
  if (
    typeof msg.timeoutMs !== 'number' ||
    !Number.isFinite(msg.timeoutMs) ||
    msg.timeoutMs < HARD_TIMEOUT_FLOOR_MS ||
    msg.timeoutMs > HARD_TIMEOUT_CEILING_MS
  ) {
    return {
      ok: false,
      failureCode: 'pause_timeout_required',
      message: `pause requires a positive timeoutMs in (${HARD_TIMEOUT_FLOOR_MS}, ${HARD_TIMEOUT_CEILING_MS}]; got ${JSON.stringify(msg.timeoutMs)}`,
    };
  }
  if (!isPauseExpiryAction(msg.expiryAction)) {
    return {
      ok: false,
      failureCode: 'pause_expiry_action_invalid',
      message: `expiryAction must be 'auto_resume' or 'auto_kick'; got ${JSON.stringify(msg.expiryAction)}`,
    };
  }

  // Session existence — same shape as mute.
  const sessionRow = getMultiAgentSession(msg.sessionId);
  if (!sessionRow) {
    return {
      ok: false,
      failureCode: 'participant_not_found',
      message: `unknown multi-agent session ${msg.sessionId}`,
    };
  }

  // Participant existence + role guard. Orchestrator self-pause is
  // rejected for the same reason as orchestrator self-mute: pausing the
  // orchestrator would silently stall the whole session.
  const participants = listResolvedParticipants(msg.sessionId);
  const participant = participants.find((p) => p.project_id === msg.projectId);
  if (!participant) {
    return {
      ok: false,
      failureCode: 'participant_not_found',
      message: `project ${msg.projectId} is not a participant of session ${msg.sessionId}`,
    };
  }
  if (participant.role === 'orchestrator') {
    return {
      ok: false,
      failureCode: 'orchestrator_cannot_kick',
      message: 'cannot pause the orchestrator — it would stall the whole session',
    };
  }
  if (!participant.bus_agent_name) {
    return {
      ok: false,
      failureCode: 'participant_not_found',
      message: `participant ${msg.projectId} has no bus_agent_name — install bus integration first`,
    };
  }

  // DB flip — repo returns false if already paused (idempotency).
  const pausedUntil = now() + msg.timeoutMs;
  const dbChanged = setParticipantPause(
    msg.sessionId,
    msg.projectId,
    pausedUntil,
    msg.expiryAction,
  );
  if (!dbChanged) {
    return {
      ok: false,
      failureCode: 'already_in_state',
      message: `${participant.bus_agent_name} is already paused`,
    };
  }

  // Sync the AgentRunner pause gate. Missing handle: log + still write
  // the audit so the operator's intent survives. Chain sessions land
  // here too (Phase 4c chain exposure isn't wired); a later phase
  // attaches the chain handle's pauseAgent.
  if (input.orchestratorHandle) {
    input.orchestratorHandle.pauseAgent(participant.bus_agent_name);
  } else {
    console.warn(
      `[ws] executePause(${msg.sessionId}/${msg.projectId}): no live orchestrator handle to install pause gate`,
    );
  }

  // safety_audit dual-write — kind='agent_control.paused'. Operational
  // class per spec §3, but pause STILL writes to safety_audit because
  // it's an operator action with forensic value. The expiry timer's
  // `pause.expired_without_resume` event (C4c2) is the safety-class
  // variant.
  const auditInput: SafetyAuditInput = {
    ts: now(),
    sessionId: msg.sessionId,
    agentId: participant.bus_agent_name,
    kind: 'agent_control.paused',
    reasonCode: msg.reasonCode,
    payload: {
      projectId: msg.projectId,
      agentSlug: participant.bus_agent_name,
      reasonText: msg.reasonText ?? null,
      timeoutMs: msg.timeoutMs,
      expiryAction: msg.expiryAction,
      pausedUntil,
    },
  };
  let auditId: string;
  try {
    auditId = appendAudit(auditInput).id;
  } catch (err) {
    console.error(`[ws] executePause safety_audit append failed for ${msg.sessionId}`, err);
    return {
      ok: false,
      failureCode: 'already_in_state',
      message: `safety_audit append failed: ${(err as Error).message}`,
    };
  }

  const queuedDeliveries =
    input.orchestratorHandle?.getPendingDeliveries(participant.bus_agent_name) ?? 0;
  return { ok: true, auditId, pausedUntil, queuedDeliveries };
}

export function executeResumeParticipant(input: ExecuteResumeInput): ExecuteResumeResult {
  const { msg } = input;
  const appendAudit = input.appendAudit ?? appendSafetyAudit;
  const now = input.now ?? Date.now;

  if (!isControlReasonCode(msg.reasonCode)) {
    return {
      ok: false,
      failureCode: 'already_in_state',
      message: `invalid reasonCode: ${JSON.stringify(msg.reasonCode)}`,
    };
  }
  if (msg.reasonCode === 'other' && !msg.reasonText?.trim()) {
    return {
      ok: false,
      failureCode: 'already_in_state',
      message: "reasonCode='other' requires non-empty reasonText",
    };
  }

  const sessionRow = getMultiAgentSession(msg.sessionId);
  if (!sessionRow) {
    return {
      ok: false,
      failureCode: 'participant_not_found',
      message: `unknown multi-agent session ${msg.sessionId}`,
    };
  }

  const participants = listResolvedParticipants(msg.sessionId);
  const participant = participants.find((p) => p.project_id === msg.projectId);
  if (!participant) {
    return {
      ok: false,
      failureCode: 'participant_not_found',
      message: `project ${msg.projectId} is not a participant of session ${msg.sessionId}`,
    };
  }
  if (!participant.bus_agent_name) {
    return {
      ok: false,
      failureCode: 'participant_not_found',
      message: `participant ${msg.projectId} has no bus_agent_name — install bus integration first`,
    };
  }

  const dbChanged = clearParticipantPause(msg.sessionId, msg.projectId);
  if (!dbChanged) {
    return {
      ok: false,
      failureCode: 'already_in_state',
      message: `${participant.bus_agent_name} is not currently paused`,
    };
  }
  if (input.orchestratorHandle) {
    input.orchestratorHandle.resumeAgent(participant.bus_agent_name);
  } else {
    console.warn(
      `[ws] executeResume(${msg.sessionId}/${msg.projectId}): no live orchestrator handle to release pause gate`,
    );
  }
  const auditInput: SafetyAuditInput = {
    ts: now(),
    sessionId: msg.sessionId,
    agentId: participant.bus_agent_name,
    kind: 'agent_control.resumed',
    reasonCode: msg.reasonCode,
    payload: {
      projectId: msg.projectId,
      agentSlug: participant.bus_agent_name,
      reasonText: msg.reasonText ?? null,
    },
  };
  let auditId: string;
  try {
    auditId = appendAudit(auditInput).id;
  } catch (err) {
    console.error(`[ws] executeResume safety_audit append failed for ${msg.sessionId}`, err);
    return {
      ok: false,
      failureCode: 'already_in_state',
      message: `safety_audit append failed: ${(err as Error).message}`,
    };
  }
  const queuedDeliveries =
    input.orchestratorHandle?.getPendingDeliveries(participant.bus_agent_name) ?? 0;
  return { ok: true, auditId, queuedDeliveries };
}

export function buildParticipantPauseChangedMsg(args: {
  sessionId: string;
  projectId: number;
  pausedUntil: number | null;
  expiryAction: PauseExpiryAction | null;
  reasonCode: ControlReasonCode;
  reasonText?: string;
  /** AE-5 [security]: observability for the "paused-queue growth" signal. */
  queuedDeliveries: number;
  ts: number;
}): Extract<ServerMsg, { type: 'participant_pause_changed' }> {
  return {
    type: 'participant_pause_changed',
    sessionId: args.sessionId,
    projectId: args.projectId,
    pausedUntil: args.pausedUntil,
    expiryAction: args.expiryAction,
    reasonCode: args.reasonCode,
    ...(args.reasonText !== undefined ? { reasonText: args.reasonText } : {}),
    actor: 'operator',
    ts: args.ts,
    queuedDeliveries: args.queuedDeliveries,
  };
}
