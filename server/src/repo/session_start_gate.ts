import { randomUUID } from 'node:crypto';
import type { EnvInjection, ServerMsg } from '@cebab/shared/protocol';
import { appendSafetyAudit } from '../notifications/safety_audit.js';
import { getOperatorId } from '../notifications/operator.js';
import { abandonPendingGates, GateAbandonedError, MAX_PENDING_GATES } from '../gate_abandon.js';

// Cluster B Phase 5 (§4.5): Env-injection session-start gate.
//
// Phase 3 built the detector (`detectEnvInjections` in project_authority.ts)
// + the EnvInjection wire type. The detector flags credential-class env
// keys declared in any `.claude/settings*.json` `env:` block — the SDK
// loads these for trusted projects, which BYPASSES Cebab's
// `subscriptionOnlyEnv()` strip path (the whole reason that strip exists).
//
// Phase 5 wires the gate: at every session-start (`start_multi_agent` /
// `runOneTurn`), if the resolver returned any detectedEnvInjections for the
// project, emit `session_start_gated` and park the spawn. The operator
// must type `'inject'` (server-validated, case-sensitive) via
// `acknowledge_and_start` to release. Every override lands an audit row
// with the operator's optional `reasonText`.
//
// This is the symmetric counterpart to the MCP TOFU gate (Phase 4b) — same
// per-Conn pending-state pattern, same await-the-promise spawn-blocker,
// same BE-1 dual-write (audit first, then unblock). Differences:
//
//   - No "deny" path. The operator either acknowledges or never replies
//     (closing the modal at the client just leaves it parked; a WS
//     disconnect is what releases it, by rejecting — see StartGateState).
//   - One pending per project, not one per detected key — the modal
//     enumerates all keys at once and a single `acknowledge_and_start`
//     covers the whole project's injection set.
//   - The audit row's reasonCode is `env_injection_acknowledged`; payload
//     carries the operator's optional free-text reason for forensics
//     ("CI sync, expected" / "deploy gate").

/**
 * Per-connection gate state. Lives on `Conn` (in ws/server.ts), whose
 * `ws.on('close')` calls `abandonPendingStartGates` — a half-typed
 * acknowledgment dies with the operator's window and the next reconnect
 * re-prompts.
 *
 * Register B20: this used to say the map "clears on disconnect", which it did
 * not — dropping the `Conn` leaves the parked promise unsettled and its
 * awaiting spawn suspended forever. **And this gate is the one where the
 * mechanical repair is the regression**: `resolve()` here means *the operator
 * acknowledged, proceed*, so draining it the way the two trust gates drain
 * (resolve with a deny) would spawn a session whose credential-injection
 * acknowledgment nobody gave. It rejects instead. See `gate_abandon.ts`.
 */
export type StartGateState = {
  pending: Map<string, PendingStartEntry>;
};

export type PendingStartEntry = {
  pendingStartId: string;
  projectId: number;
  /** Snapshot of the injections shown to the operator — recorded into the
   *  audit payload on acknowledgment so the row is self-describing even if
   *  settings.json mutates between gate and ack. */
  injections: EnvInjection[];
  /** Called by the `acknowledge_and_start` handler after the typed string
   *  validates AND the audit row writes. Resolving unblocks the parked
   *  start_session caller — i.e. resolving MEANS "acknowledged, spawn". */
  resolve: () => void;
  /**
   * Register B20: the parked promise's `reject`, used only by
   * `abandonPendingStartGates`. It exists because `resolve` cannot serve as
   * the drain here — see the note on `StartGateState`.
   */
  abandon: (err: Error) => void;
};

export function makeStartGateState(): StartGateState {
  return { pending: new Map() };
}

/**
 * Spec §4.5: the case-sensitive trigger string. The handler validates the
 * operator's `typedAcknowledgment` against this constant; anything else is
 * a wrapper_error and the gate stays parked.
 */
export const ACKNOWLEDGMENT_TRIGGER = 'inject';

export type AwaitGateInput = {
  projectId: number;
  gate: StartGateState;
  send: (msg: ServerMsg) => void;
  /** Snapshot from `resolveProjectAuthority().detectedEnvInjections`. Empty
   *  array → silent no-op (the resolver already filtered to credential
   *  keys; nothing to gate means nothing risky was declared). */
  injections: EnvInjection[];
};

/**
 * Walk the resolver's env-injection list. If empty, return immediately —
 * silent no-op for the common case where settings.json has no credential
 * keys. Otherwise emit a single `session_start_gated` envelope, park a
 * promise keyed by `pendingStartId`, and resolve only when the
 * `acknowledge_and_start` handler validates the typed string + writes the
 * audit row + calls `entry.resolve()`.
 *
 * No timeout, no auto-cancel: if the operator never replies, the spawn never
 * happens. The escape hatch is a WS disconnect, which runs
 * `abandonPendingStartGates` and rejects the parked promise so the spawn
 * unwinds instead of hanging. (Register B20: the disconnect used to be
 * described as clearing the map by itself. It did not.)
 *
 * BE-1 (Cluster A): the audit row writes inside the handler (after
 * validation) before the resolve fires; if the audit append throws, the
 * handler surfaces wrapper_error and leaves the gate parked. No spawn
 * proceeds past a broken-chain ack.
 */
export async function awaitEnvInjectionAck(input: AwaitGateInput): Promise<void> {
  if (input.injections.length === 0) return;
  // H15: fail closed rather than park an unbounded number of prompts. This
  // gate parks one per project, so the ceiling is only reachable by a client
  // starting sessions far faster than a human answers — and throwing is the
  // fail-closed direction, since the alternative is spawning unacknowledged.
  if (input.gate.pending.size >= MAX_PENDING_GATES) {
    throw new GateAbandonedError(
      'session-start',
      `${MAX_PENDING_GATES} acknowledgments already parked on this connection`,
    );
  }
  const pendingStartId = randomUUID();
  const promise = new Promise<void>((resolveSpawn, rejectSpawn) => {
    input.gate.pending.set(pendingStartId, {
      pendingStartId,
      projectId: input.projectId,
      injections: input.injections,
      resolve: resolveSpawn,
      abandon: rejectSpawn,
    });
  });
  input.send({
    type: 'session_start_gated',
    pendingStartId,
    projectId: input.projectId,
    reason: 'env_injection_detected',
    detectedInjections: input.injections,
  });
  await promise;
}

/**
 * Register B20: reject every acknowledgment still parked on this connection.
 * Called from `ws.on('close')`. Returns how many were released.
 *
 * No audit row: `session.start_gated_override` records that an operator DID
 * acknowledge, and nobody did here. The absence of a row for a
 * `session_start_gated` envelope is itself the accurate trail — the question
 * was asked and never answered.
 */
export function abandonPendingStartGates(gate: StartGateState, reason: string): number {
  return abandonPendingGates(gate.pending, 'session-start', reason);
}

/**
 * Persist the operator's acknowledgment to safety_audit. Called by the
 * `acknowledge_and_start` handler AFTER the typed string validates. Audit
 * row carries the projects's injection set + operator's optional reasonText
 * so a forensic walker can reconstruct exactly what credentials were
 * declared at override time. Returns void; throw propagates.
 *
 * BE-B12 [security] preserved: the payload mirrors `EnvInjection` which is
 * keys + posture + isSet only — never the env value. The wire never has
 * carried values, and neither does the audit row.
 */
export function recordEnvInjectionAcknowledgment(args: {
  projectId: number;
  injections: EnvInjection[];
  reasonText?: string;
}): void {
  appendSafetyAudit({
    ts: Date.now(),
    kind: 'session.start_gated_override',
    reasonCode: 'env_injection_acknowledged',
    payload: {
      projectId: args.projectId,
      operator: getOperatorId(),
      injections: args.injections,
      ...(args.reasonText ? { reasonText: args.reasonText } : {}),
    },
  });
}
