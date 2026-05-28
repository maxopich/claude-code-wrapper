import { getDb } from '../db.js';

/**
 * Cluster C Phase 3: read-only lookup against safety_audit for the
 * retroactive stop_reason → session.stopped join. Lives outside
 * `notifications/safety_audit.ts` so that module stays the narrow
 * append-only write API; queries that hit safety_audit go through here.
 *
 * The join is by JSON-extract on the payload's `interruptAckId` field —
 * the parent `session.stopped` row carries it in its payload (written by
 * the executeStoppedAudit helper). We don't add a column to safety_audit
 * because that would require an ALTER + chain-reset marker per the spec's
 * R-A3 mitigation, and a JSON extract is cheap on a session-scoped row.
 *
 * Returns at most one id; if a session somehow has two `session.stopped`
 * rows with the same interruptAckId (impossible under normal flow — ack
 * ids are uuids), the most recent one wins.
 */
export function findStoppedAuditIdForAckId(
  sessionId: string,
  interruptAckId: string,
): string | undefined {
  const row = getDb()
    .prepare<[string, string], { id: string }>(
      `SELECT id FROM safety_audit
       WHERE session_id = ?
         AND kind = 'session.stopped'
         AND json_extract(payload_json, '$.interruptAckId') = ?
       ORDER BY rowid DESC
       LIMIT 1`,
    )
    .get(sessionId, interruptAckId);
  return row?.id;
}
