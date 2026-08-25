import type { ParticipantControlSnapshot } from '@cebab/shared/protocol';
import { listControlStates, type ControlState } from '../repo/per_agent_control.js';
import { findLatestControlReason } from '../repo/safety_audit_lookup.js';

/**
 * `Cebab-vie.6` / `Cebab-vie.4` — the per-participant control state a
 * re-attaching browser is told about.
 *
 * Mute, pause and kick were durable from the start and reseeded server-side on
 * restart; the missing half was the wire. `multi_agent_started` carried no
 * control state at all, so every attach — browser refresh, second window, R-B
 * reconstruct, reopen — handed the client an empty map while the server's mute
 * mirror, the runner's pause gate and the expiry timer all stayed in force.
 * The affordance that undoes a control renders from precisely the state that
 * had gone missing, so the operator lost the ability to unmute a muted worker
 * and to resume a paused one, and a kicked worker came back offering the full
 * live menu.
 *
 * This is the ONE place that answer is built. All three `multi_agent_started`
 * sites in `ws/server.ts` call it, including the two fresh-start ones where it
 * necessarily returns `[]` — same reasoning as `rosterAgentNames` (Cebab-74q)
 * and `sendProjects` (Cebab-ws0.6): a site free to hand-write `[]` is a site
 * that can be wrong while looking right, and here "wrong" is invisible,
 * because an empty array is exactly what a session with no controls sends.
 *
 * Its own module rather than a helper inside `ws/server.ts` so it can be
 * tested against a scratch DB without importing the server — the same reason
 * `control_verbs.ts` is its own file.
 */

/**
 * Does this participant row carry any control at all?
 *
 * `listControlStates` returns one row per PARTICIPANT, not per *controlled*
 * participant, so shipping it raw would put an entry in the client's map for
 * every agent in the roster — a different claim from the one the map makes
 * about itself ("presence of a row indicates this participant has had at least
 * one control verb applied this session"). An all-clear participant is omitted
 * instead; absence and all-clear already render identically on every surface
 * that reads the map (the pills return null, the counter chip skips it, the
 * menu offers Mute…/Pause…), so nothing is lost by not sending it.
 *
 * Deliberately clock-free. Whether a pause is still LIVE is a
 * `pausedUntil > Date.now()` question, and the client asks it in three places
 * already; a participant whose pause deadline has passed still belongs in this
 * array, carrying its raw deadline, so the client keeps making that call.
 */
function hasAnyControl(s: ControlState): boolean {
  return s.muted || s.pausedUntil !== null || s.kickedAt !== null;
}

export function buildParticipantControlSnapshots(sessionId: string): ParticipantControlSnapshot[] {
  const out: ParticipantControlSnapshot[] = [];
  for (const state of listControlStates(sessionId)) {
    if (!hasAnyControl(state)) continue;
    const snapshot: ParticipantControlSnapshot = {
      projectId: state.projectId,
      muted: state.muted,
      pausedUntil: state.pausedUntil,
      kickedAt: state.kickedAt,
    };
    // The participant row stores the flags; the REASONS live in the hash
    // chain, which is why this join exists at all. `reconstruct.ts` already
    // performs the same recovery for a paused participant after a restart —
    // reusing its helper is what makes a reloaded pill read the same as a live
    // one, reason text included.
    //
    // A miss is not fatal and must not drop the entry: `findLatestControlReason`
    // returns undefined for a participant with no audit row and for one whose
    // `reason_code` is outside the current vocabulary. Losing a reason costs a
    // tooltip; losing the entry costs the operator the control.
    if (state.muted) {
      const reason = findLatestControlReason(sessionId, state.projectId, 'agent_control.muted');
      if (reason) {
        snapshot.mutedReasonCode = reason.reasonCode;
        if (reason.reasonText !== undefined) snapshot.mutedReasonText = reason.reasonText;
      }
    }
    if (state.pausedUntil !== null) {
      if (state.pauseExpiryAction !== null) snapshot.pauseExpiryAction = state.pauseExpiryAction;
      const reason = findLatestControlReason(sessionId, state.projectId, 'agent_control.paused');
      if (reason) {
        snapshot.pauseReasonCode = reason.reasonCode;
        if (reason.reasonText !== undefined) snapshot.pauseReasonText = reason.reasonText;
      }
    }
    if (state.kickedAt !== null) {
      if (state.kickedMode !== null) snapshot.kickMode = state.kickedMode;
      const reason = findLatestControlReason(sessionId, state.projectId, 'agent_control.kicked');
      if (reason) {
        snapshot.kickReasonCode = reason.reasonCode;
        if (reason.reasonText !== undefined) snapshot.kickReasonText = reason.reasonText;
      }
    }
    out.push(snapshot);
  }
  return out;
}
