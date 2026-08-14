/**
 * Read `safety_audit` rows in WRITE order, for tests that assert a sequence.
 *
 * WHY THIS EXISTS (register Cebab-34l). `safety_audit.ts` stamps `ts` with
 * `Date.now()` and `id` with `randomUUID()`. Two rows written back-to-back —
 * which is exactly what a trigger-plus-consequence pair is — routinely land in
 * the same millisecond, and under `vi.useFakeTimers()` they tie *by
 * construction* because the clock is frozen. So:
 *
 *   ORDER BY ts        → ties broken however the query plan feels
 *   ORDER BY ts, id    → ties broken by a RANDOM uuid
 *   ORDER BY id        → ordering is purely random whenever >1 row matches
 *
 * `rowid` is SQLite's insertion order and is the only key here that means
 * "the order these were written". Most of the repo already uses it
 * (`install_trust_gate.test.ts`, `query_plans.test.ts`, and
 * `mcp_trust.test.ts` since #327); this centralises it so the next
 * sequence-asserting test inherits the right key instead of re-deriving it.
 *
 * The failure mode this prevents is not only flakiness. A frozen-clock test
 * that passes today passes because the plan happens to return rowid order —
 * it will flip silently when an index changes, and it will never flake first
 * to warn anyone.
 */
import { getDb } from '../db.js';

/** Nullability mirrors migration 011's `safety_audit` DDL exactly. */
export type AuditOrderRow = {
  kind: string;
  reason_code: string;
  payload_json: string;
  session_id: string | null;
  agent_id: string | null;
};

/**
 * Rows matching `whereSql` (a fragment WITHOUT the `WHERE` keyword), in write
 * order. Params are bound positionally, same as a raw `prepare().all()`.
 *
 * Pass no filter to read the whole table.
 */
export function auditRowsInWriteOrder(whereSql?: string, ...params: unknown[]): AuditOrderRow[] {
  const where = whereSql ? `WHERE ${whereSql}` : '';
  return getDb()
    .prepare<unknown[], AuditOrderRow>(
      `SELECT kind, reason_code, payload_json, session_id, agent_id
         FROM safety_audit ${where}
        ORDER BY rowid`,
    )
    .all(...params);
}

/** The common case: just the `kind` column, in write order. */
export function auditKindsInWriteOrder(whereSql?: string, ...params: unknown[]): string[] {
  return auditRowsInWriteOrder(whereSql, ...params).map((r) => r.kind);
}
