import type { ControlReasonCode } from '@cebab/shared/protocol';
import { isControlReasonCode } from '@cebab/shared/protocol';
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

/**
 * Cluster C Phase 4e: recover a control verb's reasonCode + reasonText
 * from its most recent matching safety_audit row. R-B reconstruct uses
 * this to rehydrate the pause-expiry timer's `reasonCode` + `reasonText`
 * (which weren't persisted on `multi_agent_participants` itself — the
 * source of truth lives in safety_audit).
 *
 * Query is keyed by (sessionId, projectId, kind):
 *   - `sessionId` narrows to a session's audit rows
 *   - `kind` selects the verb ('agent_control.paused', etc.)
 *   - `json_extract(payload, '$.projectId')` selects the participant
 *     (we keyed by projectId in the payload for every Phase 4b/4c/4d
 *     audit writer)
 *
 * Returns the reason from the MOST RECENT matching row — operator can
 * re-pause with a different reason after resume, and we want the
 * currently-active pause's reason, not a stale historical one.
 *
 * `reasonText` is undefined when the payload's field is null or absent;
 * the audit writer encodes "no operator text" as `null`. The reseed
 * caller treats either as "no reasonText" the same way the original
 * pause path did.
 *
 * Returns undefined when no matching audit exists — the reseed caller
 * falls back to a conservative default reasonCode (and logs a warn).
 */
export function findLatestControlReason(
  sessionId: string,
  projectId: number,
  kind: 'agent_control.paused' | 'agent_control.muted' | 'agent_control.kicked',
): { reasonCode: ControlReasonCode; reasonText: string | undefined } | undefined {
  const row = getDb()
    .prepare<[string, string, number], { reason_code: string; reason_text: string | null }>(
      `SELECT reason_code, json_extract(payload_json, '$.reasonText') AS reason_text
       FROM safety_audit
       WHERE session_id = ?
         AND kind = ?
         AND json_extract(payload_json, '$.projectId') = ?
       ORDER BY rowid DESC
       LIMIT 1`,
    )
    .get(sessionId, kind, projectId);
  if (!row) return undefined;
  if (!isControlReasonCode(row.reason_code)) {
    // Corrupted or future-vocabulary reasonCode — bail rather than seed
    // the reseed with a value the typed handlers can't validate.
    return undefined;
  }
  return {
    reasonCode: row.reason_code,
    reasonText: row.reason_text ?? undefined,
  };
}
