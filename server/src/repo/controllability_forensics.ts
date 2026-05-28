import { getDb } from '../db.js';
import { getOperatorId } from '../notifications/operator.js';

/**
 * Cluster C Phase 3 (spec §5.5): repository for `controllability_forensics`
 * rows captured at every control action (single-agent Stop in Phase 3;
 * mute/pause/kick in the Part 2 phase). One row per audit event.
 *
 * Write surface is intentionally narrow:
 *   - `appendForensics()` — single insert keyed by safety_audit.id.
 * Read surface (audit-viewer / tests):
 *   - `getForensicsByAuditId(auditId)`
 *   - `getForensicsBySessionId(sessionId, limit?)` — most recent first.
 *
 * There is no UPDATE or DELETE export. Forensic bundles are immutable
 * post-write (the audit-row's hash chain transitively pins them — mutate a
 * forensics row and you've forged the operator's reconstruction trail
 * without breaking the audit chain itself, so we treat it as append-only
 * by code discipline).
 */

export type ForensicsInput = {
  safetyAuditId: string;
  ts: number;
  sessionId?: string | null;
  parentSessionId?: string | null;
  agentSlug?: string | null;
  effectivePrompt: unknown;
  eventsLastN: unknown;
  pendingToolCalls?: unknown;
  workdirTreeHash?: string | null;
  activePermissions?: unknown;
  busInboxOutbox?: unknown;
  mutationRationale?: unknown;
  snapshotFailedReason?: string | null;
};

export type ForensicsRow = {
  id: number;
  safety_audit_id: string;
  ts: number;
  session_id: string | null;
  parent_session_id: string | null;
  operator_id: string;
  agent_slug: string | null;
  effective_prompt_json: string;
  events_last_n_json: string;
  pending_tool_calls_json: string | null;
  workdir_tree_hash: string | null;
  active_permissions_json: string | null;
  bus_inbox_outbox_json: string | null;
  mutation_rationale_json: string | null;
  snapshot_failed_reason: string | null;
};

/**
 * Insert a forensic bundle row tied to a safety_audit event. The caller
 * (executeInterrupt + future mute/pause/kick handlers) has already written
 * the audit row and holds its id, so the FK link is satisfied at write
 * time. Throws on DB failure — callers swallow + log so a forensics-write
 * outage doesn't block the operator's Stop from taking effect (the audit
 * row is the obligation; forensics is the evidence pack on top).
 *
 * `nulls` for unset fields become SQL NULLs; the schema only requires
 * `effective_prompt_json` and `events_last_n_json` (per spec §5.5), so a
 * minimal "I have nothing to capture except the bare essentials" bundle is
 * representable.
 */
export function appendForensics(input: ForensicsInput): { id: number } {
  const db = getDb();
  const operatorId = getOperatorId();
  const result = db
    .prepare(
      `INSERT INTO controllability_forensics
        (safety_audit_id, ts, session_id, parent_session_id, operator_id, agent_slug,
         effective_prompt_json, events_last_n_json, pending_tool_calls_json,
         workdir_tree_hash, active_permissions_json, bus_inbox_outbox_json,
         mutation_rationale_json, snapshot_failed_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.safetyAuditId,
      input.ts,
      input.sessionId ?? null,
      input.parentSessionId ?? null,
      operatorId,
      input.agentSlug ?? null,
      JSON.stringify(input.effectivePrompt ?? null),
      JSON.stringify(input.eventsLastN ?? []),
      input.pendingToolCalls === undefined ? null : JSON.stringify(input.pendingToolCalls),
      input.workdirTreeHash ?? null,
      input.activePermissions === undefined ? null : JSON.stringify(input.activePermissions),
      input.busInboxOutbox === undefined ? null : JSON.stringify(input.busInboxOutbox),
      input.mutationRationale === undefined ? null : JSON.stringify(input.mutationRationale),
      input.snapshotFailedReason ?? null,
    );
  return { id: Number(result.lastInsertRowid) };
}

/** Fetch by the safety_audit row id this bundle was captured for. */
export function getForensicsByAuditId(auditId: string): ForensicsRow | undefined {
  return getDb()
    .prepare<[string], ForensicsRow>(
      `SELECT id, safety_audit_id, ts, session_id, parent_session_id, operator_id, agent_slug,
              effective_prompt_json, events_last_n_json, pending_tool_calls_json,
              workdir_tree_hash, active_permissions_json, bus_inbox_outbox_json,
              mutation_rationale_json, snapshot_failed_reason
       FROM controllability_forensics
       WHERE safety_audit_id = ?
       LIMIT 1`,
    )
    .get(auditId);
}

/**
 * Most-recent N forensic bundles for a session (Stop or mute/pause/kick).
 * Used by the eventual audit-viewer "see what state this session was in
 * when X was clicked" panel.
 */
export function getForensicsBySessionId(sessionId: string, limit = 20): ForensicsRow[] {
  return getDb()
    .prepare<[string, number], ForensicsRow>(
      `SELECT id, safety_audit_id, ts, session_id, parent_session_id, operator_id, agent_slug,
              effective_prompt_json, events_last_n_json, pending_tool_calls_json,
              workdir_tree_hash, active_permissions_json, bus_inbox_outbox_json,
              mutation_rationale_json, snapshot_failed_reason
       FROM controllability_forensics
       WHERE session_id = ?
       ORDER BY ts DESC
       LIMIT ?`,
    )
    .all(sessionId, limit);
}

/**
 * Cluster C Phase 4g4: most-recent forensic bundle captured for a specific
 * agent in a specific session. Used by the KickForensicsModal — the client
 * holds (sessionId, agentSlug) from the kicked-pill click and asks the
 * server to fetch the bundle.
 *
 * Returns undefined when no forensic row exists for the (sessionId,
 * agentSlug) pair. Multi-agent kick (C4f) writes one bundle per kick; this
 * returns the latest, which for a given live session is the kick bundle
 * (kick is terminal — there's no later capture for the same agent in the
 * same session).
 *
 * The (session_id, ts) index covers the WHERE+ORDER; the trailing agent_slug
 * filter is in-memory on the small result set. If sessions grow many
 * forensics rows per session this is fine — kick is rare per agent.
 */
export function getLatestForensicsForAgent(
  sessionId: string,
  agentSlug: string,
): ForensicsRow | undefined {
  return getDb()
    .prepare<[string, string], ForensicsRow>(
      `SELECT id, safety_audit_id, ts, session_id, parent_session_id, operator_id, agent_slug,
              effective_prompt_json, events_last_n_json, pending_tool_calls_json,
              workdir_tree_hash, active_permissions_json, bus_inbox_outbox_json,
              mutation_rationale_json, snapshot_failed_reason
       FROM controllability_forensics
       WHERE session_id = ? AND agent_slug = ?
       ORDER BY ts DESC
       LIMIT 1`,
    )
    .get(sessionId, agentSlug);
}
