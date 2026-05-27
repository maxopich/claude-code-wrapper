-- Cluster D Phase 1 (spec §8.5): queryable log of every recovery action.
--
-- Every recovery action — auto-retry on rate limit, manual retry, new
-- session vs in-session resume after auth, archive vs reopen of a swept
-- session, chain reconstruction continuation, hop-rewind — writes a row
-- here. The queries the spec calls out (sweep reopen rate, auth resume
-- choice ratio, chain reconstruction success rate, time-to-recovery
-- distributions) all hit this table; they feed regression gates so a new
-- release that silently worsens any of those signals is caught.
--
-- This is the foundation table; the per-class writers land in subsequent
-- phases (Phase 4 rate_limit, Phase 5 sweep, Phase 6 auth, Phase 7 chain).
-- Phase 1 just creates the shape + the repository module so the writers
-- have a stable API to call.
--
-- Per validation-report.md XCT-1: this table also carries `operator_id`
-- (defaults to 'local-user'; populated by the repo via getOperatorId() at
-- append time) and `parent_session_id` (nullable; for recovered/superseded
-- session lineage). Same precedent as safety_audit; multi-operator and
-- session-lineage forensics need them and the schema retrofit later is
-- painful.
--
-- Column notes:
--
--   failure_class           — enumerated; the high-level "what went wrong"
--                             bucket. Phase 4-7 each add a class label.
--   operator_action         — enumerated; what the operator (or
--                             auto-retry) did about it.
--   time_to_recovery_ms     — delta between the failure event and the
--                             recovery action; nullable for "the recovery
--                             action IS the failure event" (e.g. operator
--                             dismisses banner without choosing).
--   invariant_results_json  — per-invariant pass/fail/overridden record,
--                             populated by Phase 8's
--                             `server/src/recovery/invariants.ts`.
--                             Phase 1 leaves it nullable; Phase 8 mandates
--                             it for every Resume verb.
--   outcome                 — terminal status of the recovery (still_running
--                             until a result event lands). Backfilled by
--                             a follow-up update when the session reaches
--                             a terminal state.
--   forensics_id            — pointer into `controllability_forensics`
--                             (Cluster C). That table doesn't exist yet;
--                             we keep the column as a plain nullable
--                             INTEGER (no FK constraint) until Cluster C
--                             lands. Storing the integer now means
--                             back-population is a single UPDATE.

CREATE TABLE recovery_log (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                     INTEGER NOT NULL,
  session_id             TEXT,                                    -- nullable: some recoveries are process-level
  parent_session_id      TEXT,                                    -- XCT-1: lineage of recovered/superseded sessions
  operator_id            TEXT NOT NULL DEFAULT 'local-user',      -- XCT-1
  failure_class          TEXT NOT NULL,                           -- 'rate_limit'|'auth_expired'|'sweep'|'chain_crash'|'other'
  operator_action        TEXT NOT NULL,                           -- 'auto_retry'|'manual_retry'|'new_session'|'in_session_resume'|'archive'|'reopen'|'resume_from_hop'|'abort'
  time_to_recovery_ms    INTEGER,                                 -- delta failure→action; nullable
  invariant_results_json TEXT,                                    -- per-invariant pass/fail/overridden (Phase 8)
  outcome                TEXT,                                    -- 'reached_final'|'failed_again'|'still_running' (nullable; backfilled)
  forensics_id           INTEGER                                  -- Cluster C controllability_forensics(id); no FK yet
);

-- Two indexes match the queries spec §8.5 calls out:
--   - (failure_class, ts) → "rate-limit retry effectiveness over time"
--   - (session_id)        → "all recovery actions for this session"
CREATE INDEX recovery_log_class_idx   ON recovery_log(failure_class, ts);
CREATE INDEX recovery_log_session_idx ON recovery_log(session_id);
