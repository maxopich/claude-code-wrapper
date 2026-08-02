import { createHash, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { getOperatorId } from './operator.js';
import {
  appendAuditTip,
  isMirrorEstablished,
  markMirrorEstablished,
  readLatestAuditTip,
} from './audit_tip.js';

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
 * Ids of the chain-reset markers inserted by migrations. `verifyChain()`
 * requires the newest marker row to be one of these AND to carry the fixed
 * sentinel `hash_self`.
 *
 * Why an allowlist and not just `kind = 'audit.chain_reset'`: the anchor's
 * `hash_self` is trusted verbatim as the chain head (it is a sentinel, not a
 * computed digest), and the walk only covers rows AFTER it. So a process with
 * direct write access could append its own row with that `kind` and shrink the
 * verified range to zero while `verifyChain()` still reported `ok`. Pinning the
 * id turns the prose contract in `015_safety_audit.sql`'s header into something
 * the verifier actually checks.
 *
 * CONTRACT — every future migration that ALTERs `safety_audit` must do BOTH:
 *   1. insert a fresh `audit.chain_reset` marker (see 015's header), and
 *   2. append that marker's id here.
 * Skipping (2) makes every boot after that migration report `forged_anchor`.
 */
const KNOWN_CHAIN_RESET_IDS: ReadonlySet<string> = new Set([
  'chain-reset-015', // 015_safety_audit.sql — genesis
  'chain-reset-023', // 023_mock_flag.sql — added the `mode` column
]);

/**
 * The fixed anchor `hash_self` every marker migration writes (`X'00'`). Not a
 * digest — the marker is the trusted chain head, so its stored value is a
 * constant the verifier can assert rather than recompute.
 */
const CHAIN_RESET_SENTINEL = Buffer.from([0]);

/**
 * Safety REASON CODES that require a typed `ackReason` when the operator
 * acknowledges the corresponding notification (spec BE-7). The highest
 * sub-class, where a forensic "why I dismissed this" trail matters.
 *
 * Register H13: `audit.tamper_detected` used to sit in this set and never
 * matched. It is an audit KIND, not a reason code — the tamper emitter sets
 * `reasonCode: chainResult.reason` (`row_mismatch` / `no_anchor` / …) and
 * `auditKind: 'audit.tamper_detected'` — while the ack handler tests
 * membership against `notifications.reason_code`. So the single most severe
 * event Cebab can raise was the one dismissible with a bare click, while
 * lesser events demanded a justification. It now lives in
 * `HIGHEST_AUDIT_KINDS` below and is matched on the right field.
 *
 * `defang.bypass_suspected` is still forward-declared — no source emits it.
 * `forged_source` is emitted as a reason code (bus/chain.ts, orchestrator.ts)
 * and has always worked.
 *
 * The sets live here so the dispatcher and the ws ack handler can consult them
 * without a circular import.
 */
export const HIGHEST_SUBCODES: ReadonlySet<string> = new Set([
  'forged_source',
  'defang.bypass_suspected',
]);

/**
 * Register H13: safety AUDIT KINDS that require a typed `ackReason`, matched
 * against the `safety_audit` row behind `notifications.audit_row_id` rather
 * than against the notification's reason code.
 *
 * Kept as a separate set instead of folding the tamper reason codes into
 * `HIGHEST_SUBCODES` because the reason code carries WHICH integrity check
 * failed, and that varies: `row_mismatch`, `no_anchor`, `forged_anchor`, and
 * now H14's `tail_truncated` and `tip_mirror_missing`. Listing today's five
 * would silently drop tomorrow's sixth out of the typed-ack requirement —
 * exactly the class of bug this fixes. Matching the kind covers every present
 * and future failure reason by construction.
 */
export const HIGHEST_AUDIT_KINDS: ReadonlySet<string> = new Set(['audit.tamper_detected']);

/**
 * Runtime mode tagged on every audit row (Cluster G Phase 1 / migration
 * 023). 'live' for normal Cebab runs; 'mock' iff `config.mock === true`
 * at append time (operator launched with `MOCK=1`).
 *
 * Default forensics queries filter `WHERE mode='live'` so a misconfigured
 * demo doesn't pollute eval signal — but mock rows are still WRITTEN, so
 * the same demo can't pretend nothing happened. Callers do not pass this;
 * it's derived inside `appendSafetyAudit` from `config.mock`.
 */
export type SafetyAuditMode = 'live' | 'mock';

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
  /** Cluster G Phase 1 (A3, migration 023): runtime-mode tag. */
  mode: SafetyAuditMode;
};

/**
 * Why the chain failed to verify.
 *
 *   - `row_mismatch`  — a post-anchor row's recomputed digest differs from the
 *                       stored one. `brokenAt` names the first such row.
 *   - `no_anchor`     — no `audit.chain_reset` row exists at all. Impossible by
 *                       construction (markers are inserted by migrations gated
 *                       on `schema_migrations`), so absence means the table was
 *                       tampered with — NOT a healthy empty chain.
 *   - `forged_anchor` — the newest marker is not one this build knows about, or
 *                       its `hash_self` is not the sentinel. `brokenAt` names it.
 *   - `tail_truncated` — register H14. The rows still present all verify, but
 *                       the out-of-SQLite tip mirror commits to rows the chain
 *                       no longer holds. `brokenAt` names the last row the
 *                       mirror saw. This is the reason a blanket
 *                       `DELETE FROM safety_audit` now produces instead of a
 *                       clean `{ ok: true, rowsChecked: 0 }`.
 *   - `tip_mirror_missing` — the DB records that mirroring was established but
 *                       the mirror file is gone. Half of the two-step erasure
 *                       described in `audit_tip.ts`; on its own it is also
 *                       what a stray `rm ~/.cebab/audit-tip.jsonl` looks like.
 */
export type VerifyChainFailureReason =
  'row_mismatch' | 'no_anchor' | 'forged_anchor' | 'tail_truncated' | 'tip_mirror_missing';

export type VerifyChainResult =
  | { ok: true; rowsChecked: number }
  | { ok: false; reason: VerifyChainFailureReason; brokenAt?: string };

/**
 * Canonical byte representation of a row for hashing. Fields are in
 * declaration order from migration 015 + the migration 023 `mode` column
 * appended at the end; NULLs become empty strings; the NUL byte (0x00) is
 * the field delimiter (safe because operator-supplied strings — username,
 * UUIDs, enumerated kinds, payload JSON — cannot contain unescaped NUL).
 *
 * The `mode` column is appended to the parts array rather than inserted
 * mid-list because:
 *   - Migration 023 introduced a fresh chain-reset marker; verifyChain
 *     only walks rows AFTER that marker, all of which are written with
 *     the post-023 canonicalization (including `mode`). Pre-023 rows are
 *     bounded by the 015 reset marker and never re-canonicalized.
 *   - Appending keeps the diff against pre-023 canonicalization minimal,
 *     making the chain-reset contract auditable at review time.
 *
 * Any future ALTER that adds another column MUST follow the same pattern:
 * append the new field to the end of `parts` AND insert a fresh
 * `audit.chain_reset` marker in the same migration. See migration 015's
 * header for the full contract.
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
  mode: SafetyAuditMode;
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
    row.mode,
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
  // Cluster G Phase 1 (A3): runtime-mode tag, derived from `config.mock`
  // at append time. NOT a caller parameter — the caller doesn't know (or
  // shouldn't need to know) whether the runner that produced this event
  // is mock or live, but the audit row must record it for forensics. See
  // SafetyAuditMode comment for filter semantics.
  const mode: SafetyAuditMode = config.mock ? 'mock' : 'live';

  const insert = db.transaction((): { id: string; hash_self: Buffer } => {
    const tip = db
      .prepare<[], { hash_self: Buffer }>(
        'SELECT hash_self FROM safety_audit ORDER BY rowid DESC LIMIT 1',
      )
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
      mode,
    };
    const hashSelf = computeHashSelf(row, hashPrev);
    db.prepare(
      `INSERT INTO safety_audit
        (id, ts, session_id, parent_session_id, operator_id, agent_id, kind, reason_code, payload_json, hash_prev, hash_self, mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      row.mode,
    );
    return { id: row.id, hash_self: hashSelf };
  });

  const result = insert();

  // Register H14: commit the new tip outside SQLite, so a later
  // `DELETE FROM safety_audit` cannot leave the chain verifying clean.
  //
  // AFTER the transaction, deliberately. Inside it, a failed mirror write
  // would roll back the audit row itself — turning a disk problem into the
  // erasure this exists to detect. `appendAuditTip` never throws; the count is
  // read here rather than passed in so it reflects the committed state.
  appendAuditTip({
    ts: input.ts,
    rowId: result.id,
    hashSelf: result.hash_self.toString('hex'),
    count: countRowsSinceAnchor(),
  });
  if (!isMirrorEstablished()) markMirrorEstablished();

  return result;
}

/**
 * Rows strictly after the newest chain-reset anchor — the quantity tail
 * truncation reduces, and what the mirror commits to.
 *
 * Returns 0 when there is no anchor at all; `verifyChain` reports that case as
 * `no_anchor` on its own, and this helper must not throw inside the append
 * path's best-effort mirror write.
 */
function countRowsSinceAnchor(): number {
  try {
    const row = getDb()
      .prepare<[string], { n: number }>(
        `SELECT COUNT(*) AS n FROM safety_audit WHERE rowid > (SELECT MAX(rowid) FROM safety_audit WHERE kind = ?)`,
      )
      .get(CHAIN_RESET_KIND);
    return row?.n ?? 0;
  } catch {
    return 0;
  }
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
 * from the marker's hash_self normally. Because the anchor is trusted, its
 * IDENTITY is validated instead: it must be a marker this build knows about
 * (`KNOWN_CHAIN_RESET_IDS`) carrying the sentinel. Otherwise appending a
 * forged `audit.chain_reset` row would silently shrink the verified range.
 *
 * Fails CLOSED. A missing anchor is reported as tampering rather than as a
 * clean empty chain — "no marker" cannot happen on a migrated DB.
 *
 * TAIL TRUNCATION (register H14) — closed, partially. Deleting every row after
 * the anchor used to yield `{ ok: true, rowsChecked: 0 }`, indistinguishable
 * from a fresh DB, because each row's digest commits only to its predecessors
 * and never to its successors. No self-contained in-DB chain can detect that,
 * so the commitment now lives outside the sqlite file: `audit_tip.ts` mirrors
 * each new tip to `~/.cebab/audit-tip.jsonl`, and the check below reports
 * `tail_truncated` when the mirror describes more chain than the DB holds.
 * Read `audit_tip.ts`'s header for what that does and does not buy — an
 * attacker who deletes both still wins, and this must not be described as
 * making the log tamper-proof.
 *
 * COST. Walks every row after the anchor, recomputing one SHA-256 each. The
 * previous note here said "rows ≪ 1000"; that is already wrong — a real
 * install measured 1784 rows after 8 weeks (~32/day, ~12k/year), 99% of them
 * `project.trust_decided`. Still milliseconds, but it grows without bound, so
 * callers past boot (H07's attach hook) throttle rather than verifying on
 * every event.
 */
export function verifyChain(): VerifyChainResult {
  const db = getDb();
  const lastMarker = db
    .prepare<[string], { rowid: number; id: string; hash_self: Buffer }>(
      `SELECT rowid, id, hash_self FROM safety_audit WHERE kind = ? ORDER BY rowid DESC LIMIT 1`,
    )
    .get(CHAIN_RESET_KIND);
  if (!lastMarker) {
    return { ok: false, reason: 'no_anchor' };
  }
  if (
    !KNOWN_CHAIN_RESET_IDS.has(lastMarker.id) ||
    !CHAIN_RESET_SENTINEL.equals(lastMarker.hash_self)
  ) {
    return { ok: false, reason: 'forged_anchor', brokenAt: lastMarker.id };
  }
  const rows = db
    .prepare<[number], SafetyAuditRow>(
      `SELECT id, ts, session_id, parent_session_id, operator_id, agent_id, kind, reason_code,
              payload_json, hash_prev, hash_self, mode
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
      return { ok: false, reason: 'row_mismatch', brokenAt: row.id };
    }
    prevHash = row.hash_self;
    rowsChecked++;
  }

  // H14: the rows that ARE here all verify. That says nothing about rows that
  // are not — which is the whole point of the external mirror.
  const truncation = checkAgainstTipMirror(rows, rowsChecked);
  if (truncation) return truncation;

  return { ok: true, rowsChecked };
}

/**
 * H14: compare the chain against the out-of-SQLite tip mirror.
 *
 * Returns a failure when the mirror describes more chain than the database
 * holds, `null` when they agree or when there is nothing to compare.
 *
 * Ordering note: this runs AFTER the digest walk so a chain that is both
 * truncated and mutated still reports `row_mismatch` first. That is the more
 * specific finding — it names the offending row — and the operator needs the
 * row id more than they need to know the tail is also short.
 */
function checkAgainstTipMirror(
  rows: SafetyAuditRow[],
  rowsChecked: number,
): VerifyChainResult | null {
  const tip = readLatestAuditTip();

  if (!tip) {
    // No mirror. Benign on the first boot after upgrading to a build that has
    // one; suspicious once we know mirroring was live — the DB flag is what
    // separates those two, and an attacker has to find and clear it too.
    if (isMirrorEstablished() && rowsChecked > 0) {
      return { ok: false, reason: 'tip_mirror_missing' };
    }
    return null;
  }

  // The mirrored tip row is gone from the chain: the clearest signal, and the
  // one a blanket `DELETE FROM safety_audit` produces.
  if (!rows.some((r) => r.id === tip.rowId)) {
    return { ok: false, reason: 'tail_truncated', brokenAt: tip.rowId };
  }

  // The tip is still present but rows behind it were removed. `<` and not
  // `!==`: the chain legitimately grows between an append and a verify, so
  // only a SHORTER chain than the mirror committed to is evidence.
  if (rowsChecked < tip.count) {
    return { ok: false, reason: 'tail_truncated', brokenAt: tip.rowId };
  }

  return null;
}

/**
 * Full row fetch by id.
 *
 * Was named `getSafetyAuditRow` and documented "test-only: production code
 * does NOT need direct row reads". That stopped being true when kick forensics
 * shipped: `ws/server.ts`'s `executeKickForensicsSnapshot` joins the audit row
 * behind `controllability_forensics.safety_audit_id` to recover the kick's
 * `reason_code` and payload, which the notifications table does not mirror.
 * The underscore and the claim were both wrong, so both are gone.
 *
 * Read-only by construction — a SELECT cannot violate the append-only
 * invariant. This module still exports no UPDATE or DELETE, which is where
 * that invariant actually lives.
 */
export function getSafetyAuditRow(id: string): SafetyAuditRow | undefined {
  return getDb()
    .prepare<[string], SafetyAuditRow>(
      `SELECT id, ts, session_id, parent_session_id, operator_id, agent_id, kind, reason_code,
              payload_json, hash_prev, hash_self, mode
       FROM safety_audit WHERE id = ?`,
    )
    .get(id);
}
