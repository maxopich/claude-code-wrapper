import { createHash, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { getOperatorId } from './operator.js';
import {
  appendAuditTip,
  clearMirrorLossPending,
  highWaterTipsPerAnchor,
  isMirrorEstablished,
  isMirrorLossPending,
  markMirrorEstablished,
  markMirrorLossPending,
  readAuditTipEntries,
  readLatestAuditTip,
  readMaxTipForAnchor,
  readTamperAck,
  recordTamperAck,
  type TamperAck,
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
 *
 * The tip mirror (`audit_tip.ts`) tolerates that fresh anchor: each mirror line
 * names the rowid of the anchor its count is relative to, and a migration's
 * marker is a NEW rowid even when it reuses the id, so the pre-migration
 * commitments do not count against it and `checkAgainstTipMirror` reports clean
 * rather than a false `tail_truncated`. See that function.
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
 * H14's `tail_truncated` and `tip_mirror_missing`, and now Cebab-lf1u's
 * `anchor_reseated`. Listing today's six would silently drop tomorrow's
 * seventh out of the typed-ack requirement — exactly the class of bug this
 * fixes. Matching the kind covers every present and future failure reason by
 * construction.
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
 *                       clean `{ ok: true, rowsChecked: 0 }`. NOT produced when
 *                       the mirrored tip merely fell BELOW a freshly-inserted
 *                       migration anchor (it still exists) — see
 *                       `checkAgainstTipMirror`.
 *   - `tip_mirror_missing` — the DB records that mirroring was established but
 *                       the mirror file is gone. Half of the two-step erasure
 *                       described in `audit_tip.ts`; on its own it is also
 *                       what a stray `rm ~/.cebab/audit-tip.jsonl` looks like.
 *   - `anchor_reseated` — Cebab-lf1u. The current top chain-reset anchor sits at
 *                       a rowid the mirror never committed under, yet the count
 *                       of markers has not risen above the mirror's high-water
 *                       commitment. A legitimate migration inserts a NEW marker
 *                       (the count rises); an attacker re-seating the anchor to a
 *                       new highest rowid moves an existing one (the count does
 *                       not), which used to shrink the verified range to nothing
 *                       and report `{ ok: true, rowsChecked: 0 }`. Now caught.
 *                       See `checkAnchorNotReseated`.
 */
export type VerifyChainFailureReason =
  | 'row_mismatch'
  | 'no_anchor'
  | 'forged_anchor'
  | 'tail_truncated'
  | 'tip_mirror_missing'
  | 'anchor_reseated';

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
    // Tag the commitment with the anchor GENERATION it counts against, so a
    // post-truncation append (which re-counts from the shortened table) cannot
    // lower the high-water mark `verifyChain` measures truncation against, and
    // a migration's fresh anchor does not inherit the old anchor's count. The
    // rowid, not the id, is the discriminator — a migration may reuse the id.
    anchorRowid: currentAnchorRowid() ?? undefined,
    // Cebab-lf1u: also commit WHICH anchor this is (its id). A migration inserts
    // a marker with a NEW id; a bare re-seat relocates an EXISTING one. So an
    // anchor id that reappears at a rowid the mirror never committed it at is a
    // relocation. Committing the id rather than a marker count resists an
    // attacker padding the tally with a junk marker. See `checkAnchorNotReseated`.
    anchorId: currentAnchorId() ?? undefined,
  });
  if (!isMirrorEstablished()) markMirrorEstablished();

  return result;
}

/**
 * Is this audit row a tamper finding — the class whose alert now persists?
 *
 * Matched on the KIND, exactly as `requiresTypedAckReason` does, and for the
 * same reason register H13 records: the reason code carries WHICH check failed
 * and that set grows, so enumerating today's reasons silently drops tomorrow's.
 */
export function isTamperAuditRow(auditRowId: string): boolean {
  return getSafetyAuditRow(auditRowId)?.kind === 'audit.tamper_detected';
}

/**
 * Record the operator's acceptance of the tamper state AS IT STANDS NOW.
 *
 * `Cebab-6fax.13` / `.15`. Called from the `ack_notification` handler, behind
 * the typed-reason gate. It reads the current anchor identity and the mirror's
 * presence rather than the audit row's payload, because what an operator
 * acknowledges is the state they were shown — and because a payload written at
 * detection time could name a state that has since changed, which would let one
 * ack silence a different, later finding.
 */
export function recordCurrentTamperAck(): void {
  const anchorId = currentAnchorId();
  const anchorRowid = currentAnchorRowid();
  const next: TamperAck = {};
  if (anchorId !== null && anchorRowid !== null) {
    next.anchorReseated = { anchorId, anchorRowid };
  }
  recordTamperAck(next);
  // The mirror-loss finding is a durable FLAG rather than an ack entry, because
  // the artifact it is about (the file) comes back on its own. Clearing it here
  // is the operator saying they have seen that one loss; a later deletion sets
  // it again.
  clearMirrorLossPending();
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
 * SQLite rowid of the newest chain-reset anchor — the generation a mirrored
 * `count` is relative to. Recorded on every mirror entry so `verifyChain` can
 * take the high-water count for the CURRENT anchor and ignore counts committed
 * under an earlier one. Returns `null` when there is no anchor (which
 * `verifyChain` reports as `no_anchor` on its own); like `countRowsSinceAnchor`
 * it must not throw inside the append path's best-effort mirror write.
 */
function currentAnchorRowid(): number | null {
  try {
    const row = getDb()
      .prepare<[string], { rowid: number | null }>(
        `SELECT MAX(rowid) AS rowid FROM safety_audit WHERE kind = ?`,
      )
      .get(CHAIN_RESET_KIND);
    return row?.rowid ?? null;
  } catch {
    return null;
  }
}

/**
 * The `id` of the newest chain-reset anchor — the datum Cebab-lf1u commits to
 * the mirror so a re-seat (an EXISTING id relocated to a new highest rowid) can
 * be told from a migration (a NEW id inserted). Mirror-write context, so it
 * must not throw: a failure yields `null`, which omits the tag on that one line
 * (the next append re-commits it) and can never manufacture a false alarm.
 */
function currentAnchorId(): string | null {
  try {
    const row = getDb()
      .prepare<[string], { id: string }>(
        `SELECT id FROM safety_audit WHERE kind = ? ORDER BY rowid DESC LIMIT 1`,
      )
      .get(CHAIN_RESET_KIND);
    return row?.id ?? null;
  } catch {
    return null;
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
  const truncation = checkAgainstTipMirror(rowsChecked, lastMarker.rowid, lastMarker.id);
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
 *
 * `anchorRowid` is the newest chain-reset marker's rowid. Two jobs:
 *   - the existence of ANY mirror line is what separates a benign upgrade from
 *     a deleted mirror (`tip_mirror_missing`), and
 *   - the HIGH-WATER count committed for THIS anchor's generation is the
 *     yardstick for truncation. Measuring against the newest line instead let a
 *     single post-truncation append (which re-counts from the already-shortened
 *     table) heal the chain over its own erasure — the defect Cebab-ygu.21
 *     closed. Scoping to the anchor rowid also tells a truncated tail apart from
 *     a fresh migration anchor whose first post-migration append has not landed:
 *     the pre-migration commitments name the OLD rowid, so this anchor has no
 *     commitment yet and there is nothing to fail against.
 */
function checkAgainstTipMirror(
  rowsChecked: number,
  anchorRowid: number,
  anchorId: string,
): VerifyChainResult | null {
  // Existence check first: a mirror that was established and is now gone is the
  // second half of the two-step erasure (`audit_tip.ts`'s header), independent
  // of any per-anchor count. `readLatestAuditTip` answers "is there any usable
  // line at all", which is exactly this question.
  if (!readLatestAuditTip()) {
    // No mirror. Benign on the first boot after upgrading to a build that has
    // one; suspicious once we know mirroring was live — the DB flag is what
    // separates those two, and an attacker has to find and clear it too.
    // Cebab-5y4t: NOT `&& rowsChecked > 0`. The flag is set by the first
    // append, which is also what writes the mirror, so "mirroring was
    // established and the file is gone" is already the whole signal — a fresh
    // install has the flag false and is covered without the conjunct. The count
    // added nothing legitimate and was load-bearing for the attacker: re-seating
    // the anchor drives `rowsChecked` to 0, which disarmed this branch and made
    // deleting the mirror the free second step of the erasure.
    if (isMirrorEstablished()) {
      // `Cebab-6fax.15`: RECORD the loss, do not merely report it. Raising this
      // alert leads to an audit append, and that append rewrites the mirror —
      // so by the next boot the file existed again, this branch was never
      // reached, and `verifyChain` reported health with the deletion intact.
      // One alert, then a system that positively says it is fine. Measured
      // 2026-09-08. The flag outlives the artifact; the operator's
      // acknowledgement is what clears it.
      markMirrorLossPending();
      return { ok: false, reason: 'tip_mirror_missing' };
    }
    return null;
  }

  // The mirror is present — but was it ever observed missing and not yet
  // acknowledged? This is the half that makes the detection durable: the file
  // being back proves nothing, because Cebab's own append is what puts it back.
  if (isMirrorLossPending()) {
    return { ok: false, reason: 'tip_mirror_missing' };
  }

  // High-water commitment for the CURRENT anchor generation. `null` means the
  // mirror holds no line for this anchor's rowid — either a fresh migration
  // anchor whose first post-migration append has not landed (the pre-migration
  // lines name the old rowid) or a legacy mirror predating anchor tagging.
  // Both are benign: nothing claims this anchor ever held more rows than it
  // does now, so there is nothing to be short of.
  const commitment = readMaxTipForAnchor(anchorRowid);

  // `<` and not `!==`: the chain legitimately grows between an append and a
  // verify, so only a SHORTER chain than the mirror's high-water mark for this
  // anchor is evidence of truncation. The max is what a post-truncation append
  // cannot lower — reading the newest line instead was the self-heal defect.
  if (commitment && rowsChecked < commitment.count) {
    return { ok: false, reason: 'tail_truncated', brokenAt: commitment.rowId };
  }

  // Cebab-5y4t: and whether or not THIS anchor has a commitment, the rows every
  // PRIOR generation committed to must still be here, unchanged. Run this FIRST
  // so a re-seat that ALSO erased or rewrote a committed tip reports the more
  // specific `tail_truncated` / `row_mismatch` (which names the row) rather than
  // the bare `anchor_reseated`.
  const survives = checkCommittedRowsSurvive();
  if (survives) return survives;

  // Cebab-lf1u: a BARE re-seat — the anchor moved to a new highest rowid with
  // nothing else touched — leaves every committed tip present and hashing
  // correctly, so `checkCommittedRowsSurvive` says nothing and the digest walk
  // covered zero rows.
  //
  // `Cebab-6fax.13`: this used to run only when `commitment === null`, i.e.
  // when no mirror line named the anchor's CURRENT rowid — and that guard is
  // exactly what made the detection one-shot. The first ordinary append after
  // a re-seat commits the anchor at its new position, `commitment` stops being
  // null, and this check was never called again: one alert, then a chain that
  // verifies clean forever with the rows below the anchor stranded and
  // editable. Measured 2026-09-08 by re-seating, appending once, and watching
  // `verifyChain` go green. It runs unconditionally now; the check itself
  // decides, from the append-only mirror, whether this anchor has ever been
  // committed somewhere it no longer sits.
  return checkAnchorNotReseated(anchorRowid, anchorId);
}

/**
 * Cebab-lf1u [security]: was the current top anchor RE-SEATED rather than added
 * by a migration?
 *
 * THE HOLE THIS CLOSES. `verifyChain` walks only rows above the newest
 * `audit.chain_reset` marker. Re-seating that marker to a new highest rowid
 * (`UPDATE ... SET rowid`, or an `INSERT OR REPLACE` reusing its id) puts every
 * real row BELOW it, so `rowsChecked` drops to 0 and — with the committed tips
 * still present and unchanged — `verifyChain` reported `{ ok: true }`. The rows
 * below the anchor also stop being digest-checked, so any of them that is not a
 * committed high-water tip could be edited undetected. Both follow from the same
 * move, and detecting the move closes both.
 *
 * THE DISCRIMINATOR (the residual Cebab-5y4t could not reach). On a snapshot a
 * re-seat and a legitimate migration look identical: both leave a chain-reset
 * marker at a new highest rowid with the real rows below it. The distinguishing
 * fact is one the mirror now records — WHICH anchor it is (`anchorId`). A
 * migration inserts a marker with a NEW id, never committed before; a re-seat
 * relocates an EXISTING id to a new rowid. So when the top anchor's id was
 * committed by some mirror line but NEVER at the rowid it now occupies, that
 * anchor was moved rather than a fresh one added.
 *
 * `commitment === null` (the caller's guard) already establishes that no line
 * names the current `(anchorId, anchorRowid)` pair; this function only has to
 * decide whether the id is nonetheless one the mirror committed elsewhere.
 *
 * WHY THE ID AND NOT A COUNT. A marker COUNT is attacker-controllable from
 * below: pad it with a junk `audit.chain_reset` row beneath the anchor and a
 * "count rose" test reads the re-seat as a migration. The id cannot be forged
 * up the same way — the relocated anchor keeps its id, and shuffling other
 * markers into the vacated rowid does not change that the top anchor's id now
 * sits somewhere it was never committed. Only relocating the anchor BACK to a
 * committed rowid clears the signal.
 *
 * LIMITS, stated because `audit_tip.ts`'s header must stay honest. This helps
 * only installs whose mirror already holds a line carrying `anchorId`: a legacy
 * mirror (or a first-ever append) has none, so the check abstains rather than
 * guess. And it does not beat an attacker who relocates the anchor back onto a
 * committed rowid, or who never let the mirror commit the id in the first
 * place — closing those needs a commitment the operator's own account cannot
 * rewrite, still out of scope for a single-user local tool. It raises the bar;
 * it does not end the game.
 *
 * Guarded on `isMirrorEstablished()` for the same reason its siblings are: a
 * fresh database beside an older operator's mirror must not be called tampered.
 */
function checkAnchorNotReseated(anchorRowid: number, anchorId: string): VerifyChainResult | null {
  if (!isMirrorEstablished()) return null;

  // ANY line committing this anchor id at a DIFFERENT rowid is the finding, and
  // a later line committing it at the current one does NOT cancel that
  // (`Cebab-6fax.13`). The previous version returned null the moment it saw a
  // matching rowid, which — together with the caller's old `commitment === null`
  // guard — is what made the detection one-shot: the first ordinary append after
  // a re-seat writes exactly such a line. The mirror is append-only, so the
  // earlier commitment stays, and so does the signal.
  const committedElsewhere = readAuditTipEntries().some(
    (entry) => entry.anchorId === anchorId && entry.anchorRowid !== anchorRowid,
  );
  if (!committedElsewhere) return null;

  // The operator was shown this exact state — this anchor, at this position —
  // and accepted it with a typed reason. Keyed to BOTH values on purpose: a
  // second re-seat moves the anchor again, does not match, and fires. An
  // acknowledgement is not a mute.
  const ack = readTamperAck().anchorReseated;
  if (ack && ack.anchorId === anchorId && ack.anchorRowid === anchorRowid) return null;

  // The current top anchor's id was committed by the mirror at a rowid it no
  // longer occupies — an existing anchor relocated, not a fresh one inserted. A
  // migration carries a NEW id, absent from every line, and returns benign
  // above. `brokenAt` is omitted: no single row is at fault, the anchor's
  // position is.
  //
  // KNOWN FALSE-POSITIVE PATH, stated so nobody debugs it twice: `safety_audit`
  // has a TEXT primary key, so its rowids are implicit and a hand-run `VACUUM`
  // renumbers them. Cebab never vacuums, but an operator with `sqlite3` can.
  // That reports as a re-seat, correctly per the evidence available, and is
  // what the acknowledgement path is for.
  return { ok: false, reason: 'anchor_reseated' };
}

/**
 * Cebab-5y4t [security]: do the rows the mirror committed to still exist, with
 * the digests it recorded?
 *
 * THE HOLE THIS CLOSES. `readMaxTipForAnchor` scopes the commitment to the
 * CURRENT anchor's rowid and yields `null` when no line names it — which was
 * read as benign, because that is what a fresh migration anchor looks like
 * before its first post-migration append. But `anchorRowid` is
 * `MAX(rowid) WHERE kind='audit.chain_reset'`, computed from the very database
 * the mirror exists to corroborate. Moving that row to a new highest rowid puts
 * every real row BELOW the anchor, so `rowsChecked` is 0, no line names the new
 * rowid, and `verifyChain` returned `{ ok: true, rowsChecked: 0 }`. Zero also
 * disarmed the `tip_mirror_missing` branch, which is guarded on
 * `rowsChecked > 0`, so the mirror could then be deleted too.
 *
 * MEASURED on the merged tree before this landed: five appends verify at
 * `rowsChecked: 5`; after `UPDATE ... SET rowid=(SELECT MAX(rowid)+1 ...)` on
 * the anchor, `{ ok: true, rowsChecked: 0 }`; after
 * `DELETE FROM safety_audit WHERE kind <> 'audit.chain_reset'`, still
 * `{ ok: true, rowsChecked: 0 }` with the mirror untouched on disk. That
 * falsified `audit_tip.ts`'s "erasing the trail now takes two coordinated
 * actions in two places" — it took two SQL statements in one place.
 *
 * THE DISCRIMINATOR. Not "does a line name the current anchor" — that is a fact
 * about attacker-controlled state. It is whether the rows PRIOR generations
 * committed to are still present and still hash to what was committed. A real
 * migration leaves them all in place (it inserts a marker, it deletes nothing);
 * an erasure does not.
 *
 * WHY A DIGEST AND NOT JUST EXISTENCE. Re-seating shrinks the verified range to
 * nothing, so rows below the anchor stop being digest-checked and could be
 * rewritten rather than removed. The committed tip's digest is RECOMPUTED from
 * the row's bytes and compared against what the mirror committed — comparing
 * the row's STORED `hash_self` instead would catch only a rewritten digest, and
 * the realistic edit changes `payload_json` and leaves `hash_self` alone, so the
 * row still matches itself. No chain walk is needed: each row stores the
 * `hash_prev` it was computed with.
 *
 * WHAT THIS DOES NOT CATCH, and what its sibling now does. This check is about
 * the SURVIVAL of committed rows, so a re-seat that removed or rewrote nothing
 * leaves it silent — and a row that is neither a committed high-water tip nor
 * above the anchor is not one it inspects. Cebab-lf1u closes both from the other
 * side: `checkAnchorNotReseated` reports `anchor_reseated` on the bare re-seat
 * itself, so a chain whose anchor was moved never verifies clean regardless of
 * what was done to the rows now stranded below it. What remains open is an
 * attacker who ALSO forges the migration (a fresh allowlisted marker, so the
 * count rises) — that needs a commitment the operator's account cannot rewrite,
 * out of scope for a single-user local tool.
 *
 * Guarded on `isMirrorEstablished()` for the same reason the missing-mirror
 * branch is: a fresh database beside an older operator's mirror would otherwise
 * report every commitment as erased.
 */
function checkCommittedRowsSurvive(): VerifyChainResult | null {
  if (!isMirrorEstablished()) return null;
  const highWater = highWaterTipsPerAnchor(readAuditTipEntries());
  if (highWater.length === 0) return null;

  const db = getDb();
  const lookup = db.prepare<[string], SafetyAuditRow>(
    `SELECT id, ts, session_id, parent_session_id, operator_id, agent_id, kind, reason_code,
            payload_json, hash_prev, hash_self, mode
     FROM safety_audit WHERE id = ?`,
  );
  for (const tip of highWater) {
    const row = lookup.get(tip.rowId);
    if (!row) {
      return { ok: false, reason: 'tail_truncated', brokenAt: tip.rowId };
    }
    // RECOMPUTED from the row's own bytes, not compared to its stored
    // `hash_self`. A stored-digest comparison catches only a rewritten digest;
    // the realistic edit changes `payload_json` and leaves `hash_self` alone,
    // and that row still matches itself. Recomputing against the digest the
    // MIRROR committed catches both, and needs no chain walk because each row
    // stores the `hash_prev` it was computed with.
    const recomputed = computeHashSelf(row, row.hash_prev).toString('hex');
    if (recomputed !== tip.hashSelf) {
      return { ok: false, reason: 'row_mismatch', brokenAt: tip.rowId };
    }
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
