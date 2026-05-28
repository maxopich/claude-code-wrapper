import { getDb } from '../db.js';

/**
 * Cluster C Phase 4a (Part 2 backend foundation, spec §5.4): per-agent
 * control-state repository. This file owns reads + writes of the columns
 * added by migration 020 on `multi_agent_participants` — muting, pausing,
 * and kicking. The Phase 4a slice is persistence-only; the router /
 * runner enforcement and the operator-facing WS handlers land in Phase
 * 4b.
 *
 * Why a separate module instead of growing `multi_agent.ts`:
 *   - The control-state surface has its own contract (every write pairs
 *     with a safety_audit dual-write at the handler layer; reads feed
 *     the bus/orchestrator's hot path). Isolating it makes both the
 *     write tests + the future "is this path still the only writer"
 *     audit easier.
 *   - When Phase 4b wires `bus/orchestrator.ts:handleEvent`'s mute
 *     filter and `bus/runner.ts:deliverTurn`'s pause gate, the imports
 *     point at this file — clearer than a broad `multi_agent.ts` mixin.
 *
 * State semantics (spec §5.1):
 *   - muted: router suppresses outbound where `ev.source` is this
 *     participant. Agent keeps consuming budget; mute is independent of
 *     pause + kick (a kicked agent is also no longer routed but for a
 *     different reason — the row carries both flags).
 *   - paused: runner holds new turn delivery; in-flight finishes;
 *     inbound queues. Expiry timer fires `pause_expiry_action`
 *     ('auto_resume' or 'auto_kick'). Wire-level guard (Phase 4b)
 *     enforces non-NULL `timeoutMs`.
 *   - kicked: removed from active routing immediately; in-flight turn
 *     drains in background; drained events are discarded. `kicked_mode`
 *     records 'drain' (v1) vs 'hard' (v1.1 — server rejects in v1).
 *
 * All three are orthogonal — the operator can pause then kick, or mute
 * then pause, etc. Resume clears `paused_until` + `pause_expiry_action`
 * but leaves muted/kicked untouched (the verbs unbundle).
 */

export type ControlState = {
  sessionId: string;
  projectId: number;
  muted: boolean;
  pausedUntil: number | null;
  pauseExpiryAction: PauseExpiryAction | null;
  kickedAt: number | null;
  kickedMode: KickMode | null;
};

export type PauseExpiryAction = 'auto_resume' | 'auto_kick';
export type KickMode = 'drain' | 'hard';

const PAUSE_EXPIRY_ACTIONS: ReadonlySet<string> = new Set(['auto_resume', 'auto_kick']);
const KICK_MODES: ReadonlySet<string> = new Set(['drain', 'hard']);

export function isPauseExpiryAction(v: unknown): v is PauseExpiryAction {
  return typeof v === 'string' && PAUSE_EXPIRY_ACTIONS.has(v);
}

export function isKickMode(v: unknown): v is KickMode {
  return typeof v === 'string' && KICK_MODES.has(v);
}

type ControlRow = {
  session_id: string;
  project_id: number;
  muted: number;
  paused_until: number | null;
  pause_expiry_action: string | null;
  kicked_at: number | null;
  kicked_mode: string | null;
};

function rowToControlState(row: ControlRow): ControlState {
  return {
    sessionId: row.session_id,
    projectId: row.project_id,
    muted: row.muted === 1,
    pausedUntil: row.paused_until,
    pauseExpiryAction: isPauseExpiryAction(row.pause_expiry_action)
      ? row.pause_expiry_action
      : null,
    kickedAt: row.kicked_at,
    kickedMode: isKickMode(row.kicked_mode) ? row.kicked_mode : null,
  };
}

/**
 * Fetch one participant's full control state. Returns undefined when
 * (sessionId, projectId) doesn't identify a participant row — the caller
 * (Phase 4b's handler) is expected to short-circuit with a wrapper_error.
 */
export function getControlState(sessionId: string, projectId: number): ControlState | undefined {
  const row = getDb()
    .prepare<[string, number], ControlRow>(
      `SELECT session_id, project_id, muted, paused_until, pause_expiry_action,
              kicked_at, kicked_mode
       FROM multi_agent_participants
       WHERE session_id = ? AND project_id = ?`,
    )
    .get(sessionId, projectId);
  return row ? rowToControlState(row) : undefined;
}

/**
 * Fetch every participant's control state for a session. Used by R-A
 * (browser reattach) + R-B (server restart) to rebuild the in-memory
 * mute/pause/kick sets without an N+1 query per participant.
 */
export function listControlStates(sessionId: string): ControlState[] {
  return getDb()
    .prepare<[string], ControlRow>(
      `SELECT session_id, project_id, muted, paused_until, pause_expiry_action,
              kicked_at, kicked_mode
       FROM multi_agent_participants
       WHERE session_id = ?
       ORDER BY project_id ASC`,
    )
    .all(sessionId)
    .map(rowToControlState);
}

/**
 * Flip muted 0 → 1 for a participant. Returns true if a row changed.
 * Idempotent: re-muting an already-muted participant returns false (no
 * row change) and the caller is expected to either short-circuit or log.
 * Doesn't read the audit/forensics path — that's the handler's job.
 */
export function setParticipantMuted(sessionId: string, projectId: number, muted: boolean): boolean {
  const newVal = muted ? 1 : 0;
  const info = getDb()
    .prepare(
      `UPDATE multi_agent_participants
       SET muted = ?
       WHERE session_id = ? AND project_id = ? AND muted != ?`,
    )
    .run(newVal, sessionId, projectId, newVal);
  return info.changes > 0;
}

/**
 * Begin a pause: set `paused_until` and `pause_expiry_action`. Throws
 * (or returns false) if the participant is already paused — the caller
 * decides whether re-pause is an error (typical) or an extension
 * (potential future v1.1 affordance). Phase 4a: returns false on a
 * no-op so Phase 4b's handler can wrap with wrapper_error for the
 * "already paused" case.
 *
 * `pausedUntil` is the absolute epoch ms — caller computes
 * `Date.now() + timeoutMs` and passes it. Resume clears with
 * `clearParticipantPause`.
 */
export function setParticipantPause(
  sessionId: string,
  projectId: number,
  pausedUntil: number,
  expiryAction: PauseExpiryAction,
): boolean {
  const info = getDb()
    .prepare(
      `UPDATE multi_agent_participants
       SET paused_until = ?, pause_expiry_action = ?
       WHERE session_id = ? AND project_id = ? AND paused_until IS NULL`,
    )
    .run(pausedUntil, expiryAction, sessionId, projectId);
  return info.changes > 0;
}

/**
 * Resume: clear paused_until + pause_expiry_action. Returns true iff a
 * pause was actually cleared (so the caller can distinguish a real
 * resume from an "already resumed" no-op). Leaves muted + kicked
 * untouched — the verbs are orthogonal per §5.1.
 */
export function clearParticipantPause(sessionId: string, projectId: number): boolean {
  const info = getDb()
    .prepare(
      `UPDATE multi_agent_participants
       SET paused_until = NULL, pause_expiry_action = NULL
       WHERE session_id = ? AND project_id = ? AND paused_until IS NOT NULL`,
    )
    .run(sessionId, projectId);
  return info.changes > 0;
}

/**
 * Mark participant kicked. One-way: there is no `unkick` (the spec's
 * verb model says kicks are irreversible — to re-include an agent the
 * operator runs the add-participant flow). Returns false on a no-op
 * (already kicked); Phase 4b's handler wraps that as an idempotent
 * acknowledgment so a double-click from a stale UI doesn't surface as
 * an error.
 */
export function setParticipantKicked(
  sessionId: string,
  projectId: number,
  kickedAt: number,
  mode: KickMode,
): boolean {
  const info = getDb()
    .prepare(
      `UPDATE multi_agent_participants
       SET kicked_at = ?, kicked_mode = ?
       WHERE session_id = ? AND project_id = ? AND kicked_at IS NULL`,
    )
    .run(kickedAt, mode, sessionId, projectId);
  return info.changes > 0;
}

// ---------- Cluster C Phase 4e: R-B reseed read helpers ----------
//
// Reconstruct (bus/reconstruct.ts) needs the agent slug (bus_agent_name)
// keyed reseed payload, not the raw per_agent_control rows — the router's
// in-memory sets are keyed by slug. The helpers below JOIN with the
// projects table so the reseed path doesn't need a second query per
// participant.
//
// Filtering policy:
//   - mute/kick: only include participants whose `bus_agent_name` is
//     populated. A NULL slug means an unhealthy participant row (the
//     foreign key never linked); we'd have no way to address it on the
//     router anyway, so skipping the seed is correct.
//   - pause: include only `paused_until IS NOT NULL` rows; the timer
//     scheduler does its own past-deadline handling (fires immediately
//     when `pausedUntil <= now()`), so we don't filter expired rows
//     here.
//
// All three helpers narrow to bus_agent_name + project_id so the
// reconstruct caller can build the seed arrays without a follow-up
// query.

type AgentNameRow = { project_id: number; bus_agent_name: string };

/**
 * Phase 4e: agent slugs of every currently-muted participant for the
 * session. The reconstruct path passes this into `wireOrchestratorSession`
 * as `initialMutedAgents` so the rebuilt router's `mutedSet` is in sync
 * with durable state from the first event after restart.
 */
export function listMutedAgentNames(sessionId: string): string[] {
  return getDb()
    .prepare<[string], AgentNameRow>(
      `SELECT p.project_id, pr.bus_agent_name
       FROM multi_agent_participants p
       JOIN projects pr ON pr.id = p.project_id
       WHERE p.session_id = ?
         AND p.muted = 1
         AND pr.bus_agent_name IS NOT NULL
         AND pr.bus_agent_name != ''`,
    )
    .all(sessionId)
    .map((r) => r.bus_agent_name);
}

/**
 * Phase 4e: agent slugs of every kicked participant for the session.
 * Mirrors `listMutedAgentNames`. Kick is irreversible at the DB layer
 * (no `unkick`), so any non-null `kicked_at` is a permanent kick — the
 * reseed always includes them.
 */
export function listKickedAgentNames(sessionId: string): string[] {
  return getDb()
    .prepare<[string], AgentNameRow>(
      `SELECT p.project_id, pr.bus_agent_name
       FROM multi_agent_participants p
       JOIN projects pr ON pr.id = p.project_id
       WHERE p.session_id = ?
         AND p.kicked_at IS NOT NULL
         AND pr.bus_agent_name IS NOT NULL
         AND pr.bus_agent_name != ''`,
    )
    .all(sessionId)
    .map((r) => r.bus_agent_name);
}

/**
 * Phase 4e: full pause-state snapshot for every actively-paused
 * participant in the session. The reconstruct path uses this to
 * re-schedule pause expiry timers via `getPauseExpiryRegistry().schedule()`.
 *
 * The returned shape carries everything the timer scheduler needs
 * EXCEPT the original pause's `reasonCode` / `reasonText` — those
 * weren't persisted on the participant row (the persistence model is
 * "DB columns capture the durable state; reasons live in safety_audit").
 * The reconstruct caller queries `findLatestControlAudit` to recover
 * those before scheduling.
 *
 * `pauseExpiryAction` is narrowed via the `isPauseExpiryAction` guard;
 * a row with a corrupted column is skipped (and warn-logged at the
 * call site). Returning a strict union shape protects the scheduler
 * from having to defend against schema corruption.
 */
export type ActivePauseEntry = {
  projectId: number;
  agentName: string;
  pausedUntil: number;
  pauseExpiryAction: PauseExpiryAction;
};

type PauseEntryRow = {
  project_id: number;
  bus_agent_name: string;
  paused_until: number;
  pause_expiry_action: string;
};

export function listActivePauseEntries(sessionId: string): ActivePauseEntry[] {
  return getDb()
    .prepare<[string], PauseEntryRow>(
      `SELECT p.project_id, pr.bus_agent_name, p.paused_until, p.pause_expiry_action
       FROM multi_agent_participants p
       JOIN projects pr ON pr.id = p.project_id
       WHERE p.session_id = ?
         AND p.paused_until IS NOT NULL
         AND p.pause_expiry_action IS NOT NULL
         AND pr.bus_agent_name IS NOT NULL
         AND pr.bus_agent_name != ''`,
    )
    .all(sessionId)
    .filter((r): r is PauseEntryRow & { pause_expiry_action: PauseExpiryAction } =>
      isPauseExpiryAction(r.pause_expiry_action),
    )
    .map((r) => ({
      projectId: r.project_id,
      agentName: r.bus_agent_name,
      pausedUntil: r.paused_until,
      pauseExpiryAction: r.pause_expiry_action,
    }));
}
