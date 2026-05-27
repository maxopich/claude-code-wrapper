import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { getOperatorId } from './operator.js';

/**
 * Cluster A Phase 1: append-only hash-chained safety_audit repository.
 *
 * This module is the ONLY supported codepath for writing or reading
 * safety_audit rows. There is no UPDATE/DELETE export and no transitive
 * helper that lets a caller bypass `appendSafetyAudit()`. SQLite has no
 * GRANT system, so the discipline is application-layer — enforced by
 * design (no escape hatch) and by tests (direct-DB mutation must be
 * detectable via verifyChain()).
 *
 * Tamper detection: each row stores hash_self = sha256(canonical(row) ||
 * hash_prev) where hash_prev is the previous row's hash_self. Mutating any
 * row's content invalidates that row's hash AND every subsequent row's
 * cascade — verifyChain() walks the post-genesis tail and reports the
 * first mismatch.
 *
 * Chain reset markers: rows with kind='audit.chain_reset' are anchors;
 * verifyChain() starts from the most recent marker forward. The genesis
 * marker is inserted by migration 015. Future migrations that ALTER
 * safety_audit MUST insert a fresh marker so old rows with now-invalid
 * canonical forms don't trip the verifier.
 */

const CHAIN_RESET_KIND = 'audit.chain_reset';

/**
 * Safety sub-codes that require a typed `ackReason` when the operator
 * acknowledges the corresponding notification (spec BE-7). These are the
 * highest-sub-class events where a forensic "why I acked this" trail
 * matters: forged source identity, defang-bypass regression alarm, and
 * audit-chain tamper detection itself.
 *
 * Phase 1 set is forward-declared — no source emits these yet (sources
 * land in Phase 3). The set lives here so the dispatcher + ws/server.ts
 * ack handler can consult it without a circular import.
 */
export const HIGHEST_SUBCODES: ReadonlySet<string> = new Set([
  'forged_source',
  'defang.bypass_suspected',
  'audit.tamper_detected',
]);

export type SafetyAuditInput = {
  ts: number;
  sessionId?: string | null;
  parentSessionId?: string | null;
  agentId?: string | null;
  kind: string;
  reasonCode: string;
  payload: unknown;
};

export type SafetyAuditRow = {
  id: string;
  ts: number;
  session_id: string | null;
  parent_session_id: string | null;
  operator_id: string;
  agent_id: string | null;
  kind: string;
  reason_code: string;
  payload_json: string;
  hash_prev: Buffer | null;
  hash_self: Buffer;
};

export type VerifyChainResult = { ok: true; rowsChecked: number } | { ok: false; brokenAt: string };

/**
 * Canonical byte representation of a row for hashing. Fields are in
 * declaration order from migration 015; NULLs become empty strings; the
 * NUL byte (0x00) is the field delimiter (safe because operator-supplied
 * strings — username, UUIDs, enumerated kinds, payload JSON — cannot
 * contain unescaped NUL).
 */
function canonicalRowBytes(row: {
  id: string;
  ts: number;
  session_id: string | null;
  parent_session_id: string | null;
  operator_id: string;
  agent_id: string | null;
  kind: string;
  reason_code: string;
  payload_json: string;
}): Buffer {
  const parts = [
    row.id,
    String(row.ts),
    row.session_id ?? '',
    row.parent_session_id ?? '',
    row.operator_id,
    row.agent_id ?? '',
    row.kind,
    row.reason_code,
    row.payload_json,
  ];
  return Buffer.from(parts.join('\x00'), 'utf8');
}

function computeHashSelf(
  row: Parameters<typeof canonicalRowBytes>[0],
  hashPrev: Buffer | null,
): Buffer {
  const h = createHash('sha256');
  h.update(canonicalRowBytes(row));
  if (hashPrev) h.update(hashPrev);
  return h.digest();
}

/**
 * Append a row to safety_audit. The hash chain is updated atomically: the
 * tip is read inside the same transaction as the insert, so two concurrent
 * appends can't both anchor on the same hash_prev.
 *
 * Returns the new row's `id` and `hash_self` so the caller (typically the
 * dispatcher) can stamp `auditRowId` onto the notification envelope before
 * sending it. Throws on DB failure — the dispatcher catches and reports
 * `audit_write_failed` to its caller, which is required by BE-1 to refuse
 * proceeding with the safety event.
 */
export function appendSafetyAudit(input: SafetyAuditInput): { id: string; hash_self: Buffer } {
  const db = getDb();
  const id = randomUUID();
  const operatorId = getOperatorId();
  const payloadJson = JSON.stringify(input.payload ?? null);
  const sessionId = input.sessionId ?? null;
  const parentSessionId = input.parentSessionId ?? null;
  const agentId = input.agentId ?? null;

  const insert = db.transaction((): { id: string; hash_self: Buffer } => {
    const tip = db
      .prepare<
        [],
        { hash_self: Buffer }
      >('SELECT hash_self FROM safety_audit ORDER BY rowid DESC LIMIT 1')
      .get();
    const hashPrev = tip?.hash_self ?? null;
    const row = {
      id,
      ts: input.ts,
      session_id: sessionId,
      parent_session_id: parentSessionId,
      operator_id: operatorId,
      agent_id: agentId,
      kind: input.kind,
      reason_code: input.reasonCode,
      payload_json: payloadJson,
    };
    const hashSelf = computeHashSelf(row, hashPrev);
    db.prepare(
      `INSERT INTO safety_audit
        (id, ts, session_id, parent_session_id, operator_id, agent_id, kind, reason_code, payload_json, hash_prev, hash_self)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.ts,
      row.session_id,
      row.parent_session_id,
      row.operator_id,
      row.agent_id,
      row.kind,
      row.reason_code,
      row.payload_json,
      hashPrev,
      hashSelf,
    );
    return { id: row.id, hash_self: hashSelf };
  });

  return insert();
}

/**
 * Record operator acknowledgment for a safety_audit row. Idempotent:
 * INSERT OR IGNORE on the PRIMARY KEY means the first ack wins; later
 * acks for the same audit_id are silent no-ops (so the original ts and
 * reason aren't overwritten by a follow-up click).
 */
export function appendSafetyAuditAck(
  auditId: string,
  ackedAt: number,
  ackedBy: string,
  ackedReason?: string | null,
): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO safety_audit_ack (audit_id, acked_at, acked_by, acked_reason)
     VALUES (?, ?, ?, ?)`,
  ).run(auditId, ackedAt, ackedBy, ackedReason ?? null);
}

/**
 * Walk the chain from the most recent chain_reset marker forward,
 * recomputing each row's hash_self and comparing to the stored value.
 * Returns the first mismatching row's id on failure; otherwise reports
 * how many rows passed.
 *
 * The genesis marker itself is trusted as the anchor — its hash_self is
 * a fixed sentinel (X'00') and is not recomputed. Subsequent rows chain
 * from the marker's hash_self normally.
 *
 * Cheap enough to call on server boot in Phase 1 (rows ≪ 1000); Phase 3
 * will additionally call it on every WS attach once safety sources start
 * emitting at scale.
 */
export function verifyChain(): VerifyChainResult {
  const db = getDb();
  const lastMarker = db
    .prepare<
      [string],
      { rowid: number; hash_self: Buffer }
    >(`SELECT rowid, hash_self FROM safety_audit WHERE kind = ? ORDER BY rowid DESC LIMIT 1`)
    .get(CHAIN_RESET_KIND);
  if (!lastMarker) {
    return { ok: true, rowsChecked: 0 };
  }
  const rows = db
    .prepare<[number], SafetyAuditRow>(
      `SELECT id, ts, session_id, parent_session_id, operator_id, agent_id, kind, reason_code,
              payload_json, hash_prev, hash_self
       FROM safety_audit
       WHERE rowid > ?
       ORDER BY rowid ASC`,
    )
    .all(lastMarker.rowid);
  let prevHash: Buffer = lastMarker.hash_self;
  let rowsChecked = 0;
  for (const row of rows) {
    const expected = computeHashSelf(row, prevHash);
    if (!expected.equals(row.hash_self)) {
      return { ok: false, brokenAt: row.id };
    }
    prevHash = row.hash_self;
    rowsChecked++;
  }
  return { ok: true, rowsChecked };
}

/**
 * Test-only: full row fetch by id. Production code does NOT need direct
 * row reads — the dispatcher receives the id at append time and the
 * notifications table mirrors the relevant fields. Exported strictly so
 * tests can assert canonical-form behavior without re-implementing
 * canonicalRowBytes.
 */
export function _getSafetyAuditRow(id: string): SafetyAuditRow | undefined {
  return getDb()
    .prepare<[string], SafetyAuditRow>(
      `SELECT id, ts, session_id, parent_session_id, operator_id, agent_id, kind, reason_code,
              payload_json, hash_prev, hash_self
       FROM safety_audit WHERE id = ?`,
    )
    .get(id);
}
