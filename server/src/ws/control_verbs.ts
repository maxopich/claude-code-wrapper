import type {
  ClientMsg,
  ControlReasonCode,
  ControllabilityFailureCode,
  KickMode,
  PauseExpiryAction,
  ServerMsg,
} from '@cebab/shared/protocol';
import { isControlReasonCode, isKickMode, isPauseExpiryAction } from '@cebab/shared/protocol';
import { appendSafetyAudit, type SafetyAuditInput } from '../notifications/safety_audit.js';
import { appendForensics } from '../repo/controllability_forensics.js';
import {
  captureMultiAgentForensics,
  toBusEventPreview,
} from '../notifications/forensic_snapshot.js';
import {
  getMultiAgentSession,
  listMultiAgentEvents,
  listMultiAgentMutations,
  listResolvedParticipants,
} from '../repo/multi_agent.js';
import {
  clearParticipantPause,
  getControlState,
  setParticipantKicked,
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
    | {
        setMute: (agentName: string, muted: boolean) => boolean;
        isMuted: (agentName: string) => boolean;
      }
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
export function probeIsMuted(args: { sessionId: string; projectId: number }): boolean {
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
  | {
      ok: true;
      auditId: string;
      pausedUntil: number;
      queuedDeliveries: number;
      /** Resolved bus agent slug — Phase 4c2 timer scheduling needs this
       *  without re-running listResolvedParticipants in the WS handler. */
      agentName: string;
    }
  | { ok: false; failureCode: ControllabilityFailureCode; message: string };

export type ExecuteResumeResult =
  | {
      ok: true;
      auditId: string;
      queuedDeliveries: number;
      /** Resolved bus agent slug — Phase 4c2 timer cancellation uses this
       *  for the singleton registry's cancel(sessionId, projectId) call
       *  (the projectId alone is sufficient for the key, but exposing the
       *  agent name keeps the executor's return shape symmetric with
       *  pause + kick). */
      agentName: string;
    }
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
  return {
    ok: true,
    auditId,
    pausedUntil,
    queuedDeliveries,
    agentName: participant.bus_agent_name,
  };
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
  return { ok: true, auditId, queuedDeliveries, agentName: participant.bus_agent_name };
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

// ---------- Cluster C Phase 4d: kick (drain) ----------
//
// Kick removes a participant from active routing. The drain semantics for
// v1 are:
//   - In-flight turn at kick time keeps running (the AgentRunner is NOT
//     told to abort). It's not surfaced to the operator as "still
//     running" though, because the router-side drops (orchestrator.ts
//     kickedSet check, both directions) make sure none of its outbound
//     bus_send calls reach a peer and none of the peers' replies wake a
//     new turn for it. The drain happens by-construction: the in-flight
//     turn's bus_send calls land in the router as `kicked_source` drops
//     (forensically visible), and no new turn ever starts because all
//     `ev.destination === <kicked>` events become `kicked_destination`
//     drops.
//   - Hard mode (per-agent AbortController to actively cancel the
//     in-flight turn) is deferred to v1.1 — the handler returns
//     `hard_kill_unsupported_v1` on `mode: 'hard'`.
//
// Topology guards (per spec §5.3 + §5.1 — Phase 4b's mute reused the
// `orchestrator_cannot_kick` failure code; kick's name is literal):
//   - Orchestrator target → `orchestrator_cannot_kick` (kicking the
//     orchestrator silently ends the whole session).
//   - Chain mode → `chain_topology_broken` (any chain participant
//     kicked orphans every downstream hop; v1 rejects all chain kicks).
//   - Already kicked → `participant_already_kicked` (idempotent ack
//     for a double-click; the DB column flip is irreversible so the
//     UPDATE WHERE kicked_at IS NULL returns 0 rows).
//   - Hard mode → `hard_kill_unsupported_v1`.
//   - Unknown participant or missing bus_agent_name →
//     `participant_not_found` (matches mute's posture).
//
// Like mute + pause, kick is dual-classed: writes a safety_audit row
// (`kind='agent_control.kicked'`) before the wire ack. The audit
// payload carries `mode` so a future hard-kick rollout can be
// distinguished forensically from the v1 drain rows.

export type ExecuteKickInput = {
  msg: Extract<ClientMsg, { type: 'kick_participant' }>;
  /**
   * Live orchestrator handle. Chain mode short-circuits with
   * `chain_topology_broken` before we ever consult the handle, so
   * `orchestratorHandle` may legitimately be undefined for orchestrator-
   * mode sessions that were torn down between resolving the live
   * registry and reaching this executor — we still write the DB column
   * + audit row but log the router-sync miss. R-A/R-B reconstruct
   * would later re-seed the in-memory mirror via the factory's
   * `initialKickedAgents` param.
   */
  orchestratorHandle:
    | { kickAgent: (agentName: string) => boolean; isKicked: (agentName: string) => boolean }
    | undefined;
  sessionMode: 'orchestrator' | 'chain' | null;
  appendAudit?: typeof appendSafetyAudit;
  /** Phase 4f: forensic-row writer seam. Production default = the real
   *  appendForensics from the repo. Tests inject a spy. */
  appendForensicsRow?: typeof appendForensics;
  now?: () => number;
};

export type ExecuteKickResult =
  | { ok: true; auditId: string; mode: KickMode; kickedAt: number }
  | { ok: false; failureCode: ControllabilityFailureCode; message: string };

export function executeKickParticipant(input: ExecuteKickInput): ExecuteKickResult {
  const { msg } = input;
  const appendAudit = input.appendAudit ?? appendSafetyAudit;
  const now = input.now ?? Date.now;

  // Wire validation: reasonCode + 'other' pairing. (Same shape as
  // mute/pause/resume; we don't share the helper because each verb's
  // failure-code fallback varies — kick's would prefer
  // `participant_already_kicked` for "bad reasonCode" if the enum had
  // a dedicated slot; in its absence we reuse `already_in_state` like
  // the sibling verbs.)
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
  // Mode validation — runs BEFORE session lookup so a misbehaving client
  // sending `mode='hard'` against an unknown session sees the more
  // accurate `hard_kill_unsupported_v1` rather than a misleading
  // `participant_not_found`. The check serves two purposes:
  //   (1) reject unknown wire values defensively, and
  //   (2) reject the valid-but-unsupported `'hard'` with the dedicated
  //       v1 code so the operator UI can phrase its rejection cleanly.
  if (!isKickMode(msg.mode)) {
    return {
      ok: false,
      failureCode: 'already_in_state',
      message: `invalid kick mode: ${JSON.stringify(msg.mode)}`,
    };
  }
  if (msg.mode === 'hard') {
    return {
      ok: false,
      failureCode: 'hard_kill_unsupported_v1',
      message:
        "kick mode='hard' is not supported in v1 (per-agent AbortController refactor required); use mode='drain'",
    };
  }

  // Session existence.
  const sessionRow = getMultiAgentSession(msg.sessionId);
  if (!sessionRow) {
    return {
      ok: false,
      failureCode: 'participant_not_found',
      message: `unknown multi-agent session ${msg.sessionId}`,
    };
  }
  // Chain mode: reject every kick. v1 chain ordering is baked at start
  // and the pipeline depends on each hop having a downstream target —
  // removing ANY chain participant orphans every hop after it. A future
  // v1.x slice could carve out a "tail kick" affordance (drop the last
  // hop with no cascade), but until that lands the broad rejection is
  // the only safe stance. The handler uses `chain_topology_broken`
  // even though strictly that name says "middle" — the underlying
  // intent ("this kick would break the chain") covers head/tail too.
  if (input.sessionMode === 'chain') {
    return {
      ok: false,
      failureCode: 'chain_topology_broken',
      message: 'kick is not supported in chain mode in v1 (would orphan downstream hops)',
    };
  }

  // Participant existence + role guard. Orchestrator self-kick is
  // rejected for the obvious reason: kicking the orchestrator removes
  // the only routing brain from the active set and silently ends the
  // session. The operator's intent is almost certainly "end the
  // session" — they should use Stop, not kick.
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
      message: 'cannot kick the orchestrator — use Stop to end the session',
    };
  }
  if (!participant.bus_agent_name) {
    return {
      ok: false,
      failureCode: 'participant_not_found',
      message: `participant ${msg.projectId} has no bus_agent_name — install bus integration first`,
    };
  }

  // DB flip — `setParticipantKicked` returns false when the row is
  // already kicked (UPDATE WHERE kicked_at IS NULL matches 0 rows).
  // Kick is irreversible per spec §5.1, so the handler's posture on a
  // double-click is "idempotent ack with the dedicated failure code"
  // — the operator's intent has already been honored; the second
  // click should not surface as a hard error.
  const kickedAt = now();
  const dbChanged = setParticipantKicked(msg.sessionId, msg.projectId, kickedAt, msg.mode);
  if (!dbChanged) {
    return {
      ok: false,
      failureCode: 'participant_already_kicked',
      message: `${participant.bus_agent_name} is already kicked`,
    };
  }

  // Sync the orchestrator router's in-memory kickedSet. Missing handle
  // (orchestrator-mode session torn down between live-registry read +
  // here): the DB column is the source of truth, R-B reconstruct
  // would re-seed via `initialKickedAgents` — log the divergence so
  // the operator can audit it.
  if (input.orchestratorHandle) {
    input.orchestratorHandle.kickAgent(participant.bus_agent_name);
  } else {
    console.warn(
      `[ws] executeKick(${msg.sessionId}/${msg.projectId}): no live orchestrator handle to update router kickedSet`,
    );
  }

  // safety_audit dual-write. Kind='agent_control.kicked'. The payload
  // carries `mode` so a future hard-mode rollout can be distinguished
  // forensically without schema migration.
  const auditInput: SafetyAuditInput = {
    ts: kickedAt,
    sessionId: msg.sessionId,
    agentId: participant.bus_agent_name,
    kind: 'agent_control.kicked',
    reasonCode: msg.reasonCode,
    payload: {
      projectId: msg.projectId,
      agentSlug: participant.bus_agent_name,
      reasonText: msg.reasonText ?? null,
      mode: msg.mode,
      kickedAt,
    },
  };
  let auditId: string;
  try {
    auditId = appendAudit(auditInput).id;
  } catch (err) {
    console.error(`[ws] executeKick safety_audit append failed for ${msg.sessionId}`, err);
    // DB + router are already aligned with the kicked state (irreversibly).
    // We surface the audit failure but don't roll back — same posture as
    // mute. A retry's `participant_already_kicked` short-circuit would skip
    // the DB step and only re-attempt the audit.
    return {
      ok: false,
      failureCode: 'already_in_state',
      message: `safety_audit append failed: ${(err as Error).message}`,
    };
  }

  // Cluster C Phase 4f: per-participant forensic bundle for the kick.
  // Best-effort: a failure inside the capture path is logged but
  // doesn't propagate — the audit row (the obligation) is already
  // written, and the operator's kick took effect. Skipping the bundle
  // is a loss of evidence depth, not a correctness break.
  persistKickForensics({
    sessionId: msg.sessionId,
    agentSlug: participant.bus_agent_name,
    projectCwd: participant.project_path,
    safetyAuditId: auditId,
    appendForensicsFn: input.appendForensicsRow ?? appendForensics,
    now,
  });

  return { ok: true, auditId, mode: msg.mode, kickedAt };
}

/**
 * Cluster C Phase 4f: capture per-participant forensic state + write a
 * `controllability_forensics` row keyed to the kick's safety_audit_id.
 * Shared between `executeKickParticipant` (operator-initiated kick) and
 * `executeExpireParticipant`'s `auto_kick` branch (expiry escalation).
 *
 * Best-effort by design (matching the C3 single-agent forensic
 * posture): a failure here is logged + swallowed so the audit row
 * stays intact. The forensic bundle is supplemental evidence; the
 * audit row is the operator's binding obligation.
 *
 * The bus event + mutation reads are filtered to the kicked agent's
 * slug — events where source OR destination matches the slug, all
 * mutations attributed to the slug. The forensic snapshot helper
 * caps both at 50 rows so a long-running session doesn't bloat the
 * persisted bundle.
 */
function persistKickForensics(args: {
  sessionId: string;
  agentSlug: string;
  projectCwd: string;
  safetyAuditId: string;
  appendForensicsFn: typeof appendForensics;
  now: () => number;
}): void {
  try {
    const allEvents = listMultiAgentEvents(args.sessionId);
    const agentEvents = allEvents
      .filter((e) => e.source === args.agentSlug || e.destination === args.agentSlug)
      .map(toBusEventPreview);
    const allMutations = listMultiAgentMutations(args.sessionId);
    const agentMutations = allMutations
      .filter((m) => m.agentName === args.agentSlug)
      .map((m) => ({
        id: m.id,
        ts: m.ts,
        toolName: m.toolName,
        category: m.category,
        summary: m.summary,
        filePath: m.filePath,
        confirmed: m.confirmedAt !== null,
      }));
    const bundle = captureMultiAgentForensics({
      sessionId: args.sessionId,
      agentSlug: args.agentSlug,
      projectCwd: args.projectCwd,
      agentBusEvents: agentEvents,
      agentMutations,
      totalSessionEvents: allEvents.length,
      now: args.now,
    });
    args.appendForensicsFn({
      ...bundle,
      safetyAuditId: args.safetyAuditId,
    });
  } catch (err) {
    console.error(`[ws] persistKickForensics failed for ${args.sessionId}/${args.agentSlug}`, err);
  }
}

/**
 * Build the wire-shape state-change echo for a successful kick. Kept
 * separate from the executor (mirroring the mute/pause builders) so
 * the WS dispatch site can build it after threading sessionId +
 * projectId + reasonCode through.
 */
export function buildParticipantKickedMsg(args: {
  sessionId: string;
  projectId: number;
  mode: KickMode;
  reasonCode: ControlReasonCode;
  reasonText?: string;
  ts: number;
}): Extract<ServerMsg, { type: 'participant_kicked' }> {
  return {
    type: 'participant_kicked',
    sessionId: args.sessionId,
    projectId: args.projectId,
    mode: args.mode,
    reasonCode: args.reasonCode,
    ...(args.reasonText !== undefined ? { reasonText: args.reasonText } : {}),
    actor: 'operator',
    ts: args.ts,
  };
}

// ---------- Cluster C Phase 4c2: pause expiry executor ----------
//
// When a pause's deadline elapses, the registered timer (in
// `ws/pause_expiry.ts`) fires this executor with the snapshot of the
// original pause. It does the safety-class audit + the action-specific
// side effect (auto_resume or auto_kick) inline, then returns a result
// the timer callback uses to drive the wire ServerMsg fan-out.
//
// Why a pure executor rather than putting the body inline in the timer
// callback:
//   - Testability: the timer callback is small (re-read DB, call this
//     executor, fan ServerMsgs). The complex branch logic lives here and
//     is unit-testable against a real SQLite + mocked router handle,
//     same shape as the sibling executors (mute/pause/resume/kick).
//   - Defensive re-check: the executor re-reads the per_agent_control
//     row so a race where the operator resumed/kicked between the
//     timer's scheduling and its fire is a clean no-op — the executor
//     returns `{ ok: false, divergedState: 'resumed' | 'kicked' }`
//     instead of redundantly trying to flip state that's already
//     converged.
//   - Single audit-write point: the safety `pause.expired_without_resume`
//     row writes here unconditionally (it's the trigger event,
//     forensically valuable even when the action no-ops on diverged
//     state) — so the operator can see "the pause WOULD have fired but
//     state had moved on" in the audit log.
//
// Audit shape (every expiry, regardless of action or diverged state):
//   safety_audit row with kind='pause.expired_without_resume',
//   reasonCode carried from original pause, payload includes
//   { expiryAction, pausedUntil, divergedState? } so the forensic
//   trail captures both the trigger and what actually happened.
//
// auto_resume branch:
//   - clearParticipantPause()
//   - handle.resumeAgent() (releases the AgentRunner pause gate)
//   - returns shape so the timer callback can emit
//     `participant_pause_changed` with pausedUntil=null
//
// auto_kick branch (escalation):
//   - setParticipantKicked(mode='drain') — same DB write as the operator-
//     kick path
//   - handle.kickAgent() — same router flip
//   - writes ADDITIONAL `agent_control.kicked` audit row so the kick
//     path's forensic shape stays consistent (the expiry audit is the
//     trigger; the kick audit is the resulting state change)
//   - returns shape so the timer callback can emit
//     `participant_kicked`
//
// Note: clearParticipantPause is called on the auto_kick path too —
// the DB layer's invariant is "pause and kick are orthogonal" but a
// kick should clear any standing pause so the row's state is
// consistent ("not paused, kicked").

export type ExecuteExpireInput = {
  /** Snapshot captured at schedule time; what the timer was scheduled for. */
  entry: {
    sessionId: string;
    projectId: number;
    agentName: string;
    pausedUntil: number;
    expiryAction: PauseExpiryAction;
    reasonCode: ControlReasonCode;
    reasonText: string | null;
  };
  /** Live orchestrator handle. Missing handle = session torn down
   *  between schedule and fire; the executor still writes audits +
   *  flips DB state (R-B reconstruct would consult those on next
   *  start), but can't update the router's in-memory mirror. */
  orchestratorHandle:
    | {
        resumeAgent: (agentName: string) => boolean;
        kickAgent: (agentName: string) => boolean;
      }
    | undefined;
  appendAudit?: typeof appendSafetyAudit;
  /** Phase 4f: forensic-row writer seam — only consulted on the
   *  `auto_kick` branch (auto_resume doesn't capture forensics, same
   *  as operator-resume). */
  appendForensicsRow?: typeof appendForensics;
  now?: () => number;
};

export type ExecuteExpireResult =
  | {
      ok: true;
      /** Which expiry path actually ran. May be 'noop_diverged' when
       *  the DB state moved on (resumed/kicked) between schedule and
       *  fire — in that case the trigger audit still wrote but no
       *  state-flipping side effect ran. */
      action: 'auto_resume' | 'auto_kick' | 'noop_diverged';
      triggerAuditId: string;
      /** Set only for `'auto_kick'` — the additional `agent_control.kicked`
       *  audit row, mirroring `executeKickParticipant`'s return shape. */
      kickAuditId?: string;
      kickedAt?: number;
      /** Why the trigger audit recorded a no-op, if applicable. */
      divergedState?: 'resumed' | 'kicked' | 'participant_missing';
    }
  | { ok: false; error: string };

export function executeExpireParticipant(input: ExecuteExpireInput): ExecuteExpireResult {
  const { entry } = input;
  const appendAudit = input.appendAudit ?? appendSafetyAudit;
  const now = input.now ?? Date.now;
  const ts = now();

  // Re-read durable state. This is the defense-in-depth re-check: the
  // operator may have resumed/kicked between schedule + fire (the
  // registry's cancel path catches the common case via clearTimeout,
  // but a fresh-server-restart that reseeds timers from the column
  // would never have seen the cancel; same for any future R-A reattach
  // path that imports timer state from durable storage).
  const state = getControlState(entry.sessionId, entry.projectId);
  let divergedState: 'resumed' | 'kicked' | 'participant_missing' | undefined;
  if (!state) {
    divergedState = 'participant_missing';
  } else if (state.kickedAt !== null) {
    divergedState = 'kicked';
  } else if (state.pausedUntil === null) {
    divergedState = 'resumed';
  }

  // Always write the trigger audit — it captures "the timer fired" as a
  // standalone event, regardless of what (if anything) the executor
  // does next.
  const triggerPayload = {
    projectId: entry.projectId,
    agentSlug: entry.agentName,
    reasonText: entry.reasonText,
    expiryAction: entry.expiryAction,
    pausedUntil: entry.pausedUntil,
    ...(divergedState !== undefined ? { divergedState } : {}),
  };
  let triggerAuditId: string;
  try {
    triggerAuditId = appendAudit({
      ts,
      sessionId: entry.sessionId,
      agentId: entry.agentName,
      kind: 'pause.expired_without_resume',
      reasonCode: entry.reasonCode,
      payload: triggerPayload,
    }).id;
  } catch (err) {
    console.error(
      `[ws] executeExpire trigger audit failed for ${entry.sessionId}/${entry.projectId}`,
      err,
    );
    return { ok: false, error: `trigger audit failed: ${(err as Error).message}` };
  }

  // Diverged state: trigger audit written; no further side effect.
  if (divergedState !== undefined) {
    return { ok: true, action: 'noop_diverged', triggerAuditId, divergedState };
  }

  if (entry.expiryAction === 'auto_resume') {
    // Clear the pause column + release the AgentRunner gate. We don't
    // also write `agent_control.resumed` here — the spec models
    // operator-initiated resume + auto-resume as the same logical
    // event for forensics (the trigger audit's `expiryAction` payload
    // disambiguates), and a second audit would double-count the
    // outcome.
    clearParticipantPause(entry.sessionId, entry.projectId);
    if (input.orchestratorHandle) {
      input.orchestratorHandle.resumeAgent(entry.agentName);
    } else {
      console.warn(
        `[ws] executeExpire(${entry.sessionId}/${entry.projectId}): no live orchestrator handle to release pause gate`,
      );
    }
    return { ok: true, action: 'auto_resume', triggerAuditId };
  }

  // auto_kick: irreversible escalation. Clear pause column FIRST so
  // the DB row is consistent ("not paused, kicked") before the kick
  // flag lands. Then mark kicked + sync router + write the kick audit.
  clearParticipantPause(entry.sessionId, entry.projectId);
  const kickedChanged = setParticipantKicked(entry.sessionId, entry.projectId, ts, 'drain');
  // kickedChanged should always be true here (we verified above that
  // kickedAt was NULL); the defensive false-branch covers a hard race
  // where another caller kicked between our state read + setParticipantKicked.
  if (!kickedChanged) {
    return {
      ok: true,
      action: 'noop_diverged',
      triggerAuditId,
      divergedState: 'kicked',
    };
  }
  if (input.orchestratorHandle) {
    input.orchestratorHandle.kickAgent(entry.agentName);
  } else {
    console.warn(
      `[ws] executeExpire(${entry.sessionId}/${entry.projectId}): no live orchestrator handle to apply auto-kick`,
    );
  }
  let kickAuditId: string;
  try {
    kickAuditId = appendAudit({
      ts,
      sessionId: entry.sessionId,
      agentId: entry.agentName,
      kind: 'agent_control.kicked',
      reasonCode: entry.reasonCode,
      payload: {
        projectId: entry.projectId,
        agentSlug: entry.agentName,
        reasonText: entry.reasonText,
        mode: 'drain',
        kickedAt: ts,
        // Marker so a forensic-trail query can distinguish operator-
        // kicked from expiry-auto-kicked rows without a JOIN against
        // the trigger audit.
        triggerKind: 'pause.expired_without_resume',
        triggerAuditId,
      },
    }).id;
  } catch (err) {
    console.error(
      `[ws] executeExpire kick audit failed for ${entry.sessionId}/${entry.projectId}`,
      err,
    );
    // DB + router are already aligned with the kicked state; the
    // operator can audit the divergence via the trigger row + the
    // missing kick row pair. Surface the failure to the caller so
    // they don't emit a participant_kicked envelope that has no audit
    // backing it.
    return { ok: false, error: `kick audit failed: ${(err as Error).message}` };
  }

  // Cluster C Phase 4f: capture forensics for the auto-kicked
  // participant, keyed to the kick audit row's id (NOT the trigger
  // audit — the forensic bundle describes the state at the moment of
  // the state-changing action). The expire executor doesn't carry
  // `project_path` on its entry; look it up here (single query, only
  // fires on auto_kick) so the bundle's workdir hash + cwd context
  // are populated. Best-effort: a missing participant row (race with
  // teardown) skips the forensic write but the audit stays.
  try {
    const participant = listResolvedParticipants(entry.sessionId).find(
      (p) => p.project_id === entry.projectId,
    );
    if (participant) {
      persistKickForensics({
        sessionId: entry.sessionId,
        agentSlug: entry.agentName,
        projectCwd: participant.project_path,
        safetyAuditId: kickAuditId,
        appendForensicsFn: input.appendForensicsRow ?? appendForensics,
        now,
      });
    } else {
      console.warn(
        `[ws] executeExpire forensics: no participant row for ${entry.sessionId}/${entry.projectId}; skipping bundle`,
      );
    }
  } catch (err) {
    console.error(
      `[ws] executeExpire forensics lookup failed for ${entry.sessionId}/${entry.projectId}`,
      err,
    );
  }

  return { ok: true, action: 'auto_kick', triggerAuditId, kickAuditId, kickedAt: ts };
}
