import { getDb } from '../db.js';
import { getOperatorId } from '../notifications/operator.js';

// Cluster D Phase 1 (spec §8.5): repository for `recovery_log` rows.
//
// The high-level contract: every recovery action (auto-retry on rate
// limit, manual retry, new session vs in-session resume after auth,
// archive vs reopen of a swept session, chain reconstruction continuation,
// hop-rewind) writes one row through `appendRecoveryLog()`. The reads
// happen at two cadences:
//
//   - per-session lookups for the AuthorityPanel / RecoveryDisclosure
//     timelines (low-volume; `listForSession()`).
//   - aggregate rollups for the regression-gate queries the spec calls
//     out (sweep reopen rate, time-to-recovery distributions, etc.).
//     `aggregateByClass()` covers the at-a-glance numbers; richer
//     statistics can run ad-hoc SQL against the indexes 018 declares.
//
// The writers in Phases 4-7 (rate_limit, sweep, auth, chain) all share
// this API. Phase 1 ships the module + tests with no writers wired yet;
// every later phase imports `appendRecoveryLog` from here.

// ---- Enum mirrors ----
//
// SQLite has no enum type — the constraint is enforced by the writers
// passing one of these literals. Keeping the union types here (rather
// than in shared/protocol.ts) lets the repo own the canonical names; the
// wire envelope for `recovery_log_entry` will land in a later phase once
// the operator UI surfaces these rows.

export type FailureClass = 'rate_limit' | 'auth_expired' | 'sweep' | 'chain_crash' | 'other';

export type OperatorAction =
  | 'auto_retry'
  | 'manual_retry'
  | 'new_session'
  | 'in_session_resume'
  | 'archive'
  | 'reopen'
  | 'resume_from_hop'
  | 'abort';

export type RecoveryOutcome = 'reached_final' | 'failed_again' | 'still_running';

export type RecoveryLogRow = {
  id: number;
  ts: number;
  session_id: string | null;
  parent_session_id: string | null;
  operator_id: string;
  failure_class: FailureClass;
  operator_action: OperatorAction;
  time_to_recovery_ms: number | null;
  invariant_results_json: string | null;
  outcome: RecoveryOutcome | null;
  forensics_id: number | null;
};

export type AppendRecoveryLogInput = {
  /** Owning session id; null for process-level recoveries. */
  sessionId?: string | null;
  /** Origin session id when the recovery rebuilt/replaced one (XCT-1 lineage). */
  parentSessionId?: string | null;
  /** Defaults to getOperatorId(); override only in test paths. */
  operatorId?: string;
  failureClass: FailureClass;
  operatorAction: OperatorAction;
  /** Delta failure→action; null when the recovery action IS the failure event. */
  timeToRecoveryMs?: number | null;
  /** Per-invariant pass/fail/overridden (Phase 8). Caller supplies JSON-stringified value. */
  invariantResultsJson?: string | null;
  /** Terminal status; nullable — backfilled by `updateRecoveryOutcome` once known. */
  outcome?: RecoveryOutcome | null;
  /** Cluster C controllability_forensics(id); null until that table lands. */
  forensicsId?: number | null;
  /** Wall-clock override for tests; defaults to Date.now(). */
  tsOverride?: number;
};

/**
 * Insert one recovery_log row. Returns the autoincrement id so callers
 * that want to backfill `outcome` later can hold onto it.
 *
 * The repository never silently mutates a row — `updateRecoveryOutcome`
 * is the only post-insert path, and it only touches `outcome`. Other
 * columns are immutable per the append-only convention shared with
 * `safety_audit`.
 */
export function appendRecoveryLog(input: AppendRecoveryLogInput): { id: number } {
  const ts = input.tsOverride ?? Date.now();
  const operatorId = input.operatorId ?? getOperatorId();
  const row = getDb()
    .prepare<
      [
        number,
        string | null,
        string | null,
        string,
        FailureClass,
        OperatorAction,
        number | null,
        string | null,
        RecoveryOutcome | null,
        number | null,
      ],
      { id: number }
    >(
      `INSERT INTO recovery_log (
         ts, session_id, parent_session_id, operator_id, failure_class,
         operator_action, time_to_recovery_ms, invariant_results_json, outcome, forensics_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      ts,
      input.sessionId ?? null,
      input.parentSessionId ?? null,
      operatorId,
      input.failureClass,
      input.operatorAction,
      input.timeToRecoveryMs ?? null,
      input.invariantResultsJson ?? null,
      input.outcome ?? null,
      input.forensicsId ?? null,
    );
  // RETURNING is supported by better-sqlite3's `.get()`. We assert the
  // result rather than `!` so the test suite gets a useful error if the
  // insert silently fails (it shouldn't — the only way is a constraint
  // violation, and we don't have any beyond NOT NULL).
  if (!row) throw new Error('recovery_log insert returned no id');
  return { id: row.id };
}

/**
 * Backfill `outcome` once the recovery's session reaches a terminal state.
 * No-op (returns false) when the row doesn't exist; idempotent when the
 * outcome is already populated to the same value.
 */
export function updateRecoveryOutcome(id: number, outcome: RecoveryOutcome): boolean {
  const result = getDb()
    .prepare<[RecoveryOutcome, number], unknown>('UPDATE recovery_log SET outcome = ? WHERE id = ?')
    .run(outcome, id);
  return result.changes > 0;
}

/**
 * All recovery rows for one session, oldest first. The
 * RecoveryDisclosure UI (later phase) renders this as a timeline.
 */
export function listForSession(sessionId: string): RecoveryLogRow[] {
  return getDb()
    .prepare<
      [string],
      RecoveryLogRow
    >('SELECT * FROM recovery_log WHERE session_id = ? ORDER BY ts ASC')
    .all(sessionId);
}

/**
 * Aggregate roll-up keyed by failure_class — the at-a-glance numbers
 * the spec's regression-gate queries consume:
 *
 *   - `count`            — total recoveries in this class
 *   - `reachedFinalRate` — fraction whose outcome backfilled to
 *                          'reached_final' (NULL outcome excluded from
 *                          both numerator and denominator)
 *   - `medianTimeToRecoveryMs` — null when no rows have a populated time
 *
 * Returns one entry per class observed. Classes with zero rows are
 * absent — callers must default to "no data yet" rather than zero.
 */
export type ClassAggregate = {
  failureClass: FailureClass;
  count: number;
  reachedFinalRate: number | null;
  medianTimeToRecoveryMs: number | null;
};

export function aggregateByClass(): ClassAggregate[] {
  // Pull just the columns we need; aggregate in JS so the median calc
  // doesn't need SQLite's window-function support (which is enabled but
  // verbose for this small dataset).
  type Row = {
    failure_class: FailureClass;
    outcome: RecoveryOutcome | null;
    time_to_recovery_ms: number | null;
  };
  const rows = getDb()
    .prepare<[], Row>('SELECT failure_class, outcome, time_to_recovery_ms FROM recovery_log')
    .all();
  const byClass = new Map<FailureClass, Row[]>();
  for (const r of rows) {
    const arr = byClass.get(r.failure_class) ?? [];
    arr.push(r);
    byClass.set(r.failure_class, arr);
  }
  const out: ClassAggregate[] = [];
  for (const [failureClass, rs] of byClass.entries()) {
    const outcomes = rs.filter((r) => r.outcome !== null);
    const reachedFinal = outcomes.filter((r) => r.outcome === 'reached_final').length;
    const reachedFinalRate = outcomes.length > 0 ? reachedFinal / outcomes.length : null;
    const times = rs
      .map((r) => r.time_to_recovery_ms)
      .filter((t): t is number => typeof t === 'number')
      .sort((a, b) => a - b);
    const medianTimeToRecoveryMs = times.length === 0 ? null : computeMedian(times);
    out.push({
      failureClass,
      count: rs.length,
      reachedFinalRate,
      medianTimeToRecoveryMs,
    });
  }
  return out;
}

function computeMedian(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * One specific roll-up the spec §8.5 names: "sweep reopen rate" —
 * proportion of `failure_class='sweep'` rows whose `operator_action`
 * was `'reopen'` (vs `'archive'`). Returns null when the operator has
 * never been swept (no denominator).
 */
export function sweepReopenRate(): { rate: number; sweeps: number } | null {
  // SQLite returns NULL (not 0) from SUM(CASE WHEN ...) over an empty
  // table. Coerce via `?? 0` so the "no sweeps recorded" branch resolves
  // cleanly to null below.
  const row = getDb()
    .prepare<[], { sweeps: number | null; reopens: number | null }>(
      `SELECT
         SUM(CASE WHEN failure_class = 'sweep' THEN 1 ELSE 0 END) AS sweeps,
         SUM(CASE WHEN failure_class = 'sweep' AND operator_action = 'reopen' THEN 1 ELSE 0 END) AS reopens
       FROM recovery_log`,
    )
    .get();
  const sweeps = row?.sweeps ?? 0;
  const reopens = row?.reopens ?? 0;
  if (sweeps === 0) return null;
  return { rate: reopens / sweeps, sweeps };
}

/**
 * "Auth resume choice ratio" — for `failure_class='auth_expired'`,
 * the fraction that chose `in_session_resume` (vs `new_session`). The
 * spec calls out both numbers; we return the ratio + the absolute counts
 * so the caller can render "47% in-session (×120 of ×255)".
 */
export function authResumeChoiceRatio(): {
  inSessionRate: number;
  inSession: number;
  newSession: number;
} | null {
  // Same NULL caveat as sweepReopenRate: SUM over an empty filter returns
  // NULL, not 0. `?? 0` lifts both branches.
  const row = getDb()
    .prepare<[], { in_session: number | null; new_session: number | null }>(
      `SELECT
         SUM(CASE WHEN operator_action = 'in_session_resume' THEN 1 ELSE 0 END) AS in_session,
         SUM(CASE WHEN operator_action = 'new_session'        THEN 1 ELSE 0 END) AS new_session
       FROM recovery_log
       WHERE failure_class = 'auth_expired'`,
    )
    .get();
  const inSession = row?.in_session ?? 0;
  const newSession = row?.new_session ?? 0;
  const total = inSession + newSession;
  if (total === 0) return null;
  return {
    inSessionRate: inSession / total,
    inSession,
    newSession,
  };
}
