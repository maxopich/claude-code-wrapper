import type {
  NotificationAction,
  NotificationClass,
  NotificationEnvelope,
  NotificationSeverity,
} from '@cebab/shared';
import { getDb } from '../db.js';
import { getOperatorId } from './operator.js';

/**
 * Cluster A Phase 5: inbox queries over the persisted `notifications` table.
 *
 * Separated from `dispatcher.ts` (which owns EMIT semantics — coalesce
 * windows, dual-write enforcement) because read/replay is structurally a
 * different concern: emit is one-shot per-event, list/clear is
 * batch-on-operator-action. Both modules touch the same table, but
 * splitting keeps each file focused on a single failure surface.
 *
 * Spec touchpoints (critical/A-notification-surface.md):
 *   - §5: "200 most recent OR 7 days, whichever larger" — `listInbox`
 *     implements the union: at least 7 days of history; if that's < 200
 *     rows, pad with older rows up to 200 total. Busy systems keep > 7
 *     days; quiet systems keep > 200 entries.
 *   - §5: "Clear all dismissed (danger entries excluded)" —
 *     `clearDismissedInbox` ONLY acks operational rows; safety
 *     acknowledgment is per-row + typed-reason (BE-7) and cannot be
 *     bulk-cleared.
 *   - §5: "per-session badge on session list row" —
 *     `countUnackedBySession` returns the per-session split so the sidebar
 *     can render badges without N+1 queries.
 */

/**
 * Hard cap on inbox depth to keep the wire snapshot small and the panel
 * responsive. v1 ships with 200 (matches the spec's "200 most recent"
 * floor); when the 7-day rule yields more, this is the upper bound the
 * server will ship. Operators looking further back will need the audit
 * log directly (Phase 6+ "view full history" affordance).
 */
const INBOX_HARD_CAP = 200;

/**
 * Rolling window that always survives the "200 newest" cap. If you ship
 * more than 200 notifications a week (≈ 28/day), the cap kicks in first
 * and you only see the most recent 200; that's an intentional ceiling on
 * panel-render cost. Adjustable here without protocol churn.
 */
const INBOX_WINDOW_DAYS = 7;

export type InboxFilters = {
  /**
   * - `undefined`: no session filter (all rows).
   * - `null`: global rows only (`session_id IS NULL`).
   * - `string`: that exact `session_id` only.
   */
  sessionId?: string | null;
  classes?: NotificationClass[];
  severities?: NotificationSeverity[];
  /** Default false — exclude already-acked rows. */
  includeAcked?: boolean;
};

/**
 * Raw row shape from `SELECT * FROM notifications`. Translated to
 * `NotificationEnvelope` by `rowToEnvelope` before going on the wire.
 */
type InboxRow = {
  id: string;
  ts: number;
  severity: NotificationSeverity;
  class: NotificationClass;
  dedupe_key: string;
  title: string;
  message: string | null;
  details_json: string | null;
  session_id: string | null;
  project_id: number | null;
  action_json: string | null;
  sticky: number;
  audit_row_id: string | null;
  reason_code: string | null;
};

function rowToEnvelope(row: InboxRow): NotificationEnvelope {
  return {
    id: row.id,
    ts: row.ts,
    severity: row.severity,
    class: row.class,
    dedupeKey: row.dedupe_key,
    title: row.title,
    message: row.message ?? undefined,
    details: row.details_json ? JSON.parse(row.details_json) : undefined,
    sessionId: row.session_id ?? undefined,
    projectId: row.project_id ?? undefined,
    action: row.action_json ? (JSON.parse(row.action_json) as NotificationAction) : undefined,
    sticky: row.sticky === 1,
    auditRowId: row.audit_row_id ?? undefined,
    reasonCode: row.reason_code ?? undefined,
  };
}

/**
 * Build the WHERE clause + parameter list for a filter object. An
 * `undefined` filters arg is normalized to `{}` so the default-exclude-
 * acked rule still fires — without that, `listInbox()` (no args) would
 * return ALL persisted rows including the historical acked ones, which
 * is the opposite of what the bell badge wants.
 */
function buildWhere(filters: InboxFilters | undefined): { sql: string; params: unknown[] } {
  const f = filters ?? {};
  const where: string[] = [];
  const params: unknown[] = [];

  if (f.sessionId === null) where.push('session_id IS NULL');
  else if (typeof f.sessionId === 'string') {
    where.push('session_id = ?');
    params.push(f.sessionId);
  }

  if (f.classes && f.classes.length > 0) {
    where.push(`class IN (${f.classes.map(() => '?').join(', ')})`);
    params.push(...f.classes);
  }

  if (f.severities && f.severities.length > 0) {
    where.push(`severity IN (${f.severities.map(() => '?').join(', ')})`);
    params.push(...f.severities);
  }

  if (!f.includeAcked) where.push('acked_at IS NULL');

  return {
    sql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
    params,
  };
}

/**
 * Return the inbox snapshot. The spec's "200 newest OR 7 days, whichever
 * larger" rule is implemented as: take all rows in the 7-day window; if
 * that count is below `INBOX_HARD_CAP`, top up with older rows to reach
 * the cap. Filters apply BEFORE the cap so per-session views aren't
 * starved by an unfiltered top-200 dominated by another session.
 */
export function listInbox(filters?: InboxFilters): NotificationEnvelope[] {
  const db = getDb();
  const { sql: whereSql, params } = buildWhere(filters);
  const windowMs = INBOX_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const windowStart = Date.now() - windowMs;

  // Step 1: rows within the 7-day window (filter-aware).
  const windowWhere = whereSql ? `${whereSql} AND ts >= ?` : 'WHERE ts >= ?';
  const recentRows = db
    .prepare<unknown[], InboxRow>(`SELECT * FROM notifications ${windowWhere} ORDER BY ts DESC`)
    .all(...params, windowStart);

  if (recentRows.length >= INBOX_HARD_CAP) {
    return recentRows.slice(0, INBOX_HARD_CAP).map(rowToEnvelope);
  }

  // Step 2: pad with older rows up to the cap.
  const allRows = db
    .prepare<
      unknown[],
      InboxRow
    >(`SELECT * FROM notifications ${whereSql} ORDER BY ts DESC LIMIT ?`)
    .all(...params, INBOX_HARD_CAP);
  return allRows.map(rowToEnvelope);
}

/**
 * Bulk-ack operational rows. Safety rows are NEVER touched — they require
 * per-row typed-reason ack (BE-7), and a bulk affordance would defeat
 * that policy. Returns the count of rows updated so the WS handler can
 * include it in a follow-up snapshot for telemetry / future undo.
 */
export function clearDismissedInbox(): number {
  const ackedAt = Date.now();
  const ackedBy = getOperatorId();
  const result = getDb()
    .prepare(
      `UPDATE notifications
       SET acked_at = ?, acked_by = ?
       WHERE acked_at IS NULL AND class = 'operational'`,
    )
    .run(ackedAt, ackedBy);
  return result.changes;
}

/**
 * Group unacked rows by session. The empty string `""` carries rows
 * whose `session_id IS NULL` so the client can iterate uniformly without
 * a JSON null-vs-undefined dance (JSON.stringify drops `undefined`
 * values, which would silently lose the global-scope bucket).
 *
 * Returns both the per-session map and the convenience total so the bell
 * badge doesn't sum on the client (saves a render pass on every snapshot).
 */
export function countUnackedBySession(): {
  bySession: Record<string, number>;
  total: number;
} {
  const rows = getDb()
    .prepare<unknown[], { session_id: string | null; n: number }>(
      `SELECT session_id, COUNT(*) AS n
       FROM notifications
       WHERE acked_at IS NULL
       GROUP BY session_id`,
    )
    .all();
  const bySession: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    const key = row.session_id ?? '';
    bySession[key] = row.n;
    total += row.n;
  }
  return { bySession, total };
}

/**
 * Compose the full snapshot a `request_inbox_snapshot` reply or an
 * on-attach push needs. Single call site for the WS handler so the two
 * paths can't drift in shape.
 */
export function buildInboxSnapshot(filters?: InboxFilters): {
  rows: NotificationEnvelope[];
  unackedCountBySession: Record<string, number>;
  unackedGlobal: number;
} {
  const rows = listInbox(filters);
  const { bySession, total } = countUnackedBySession();
  return { rows, unackedCountBySession: bySession, unackedGlobal: total };
}
