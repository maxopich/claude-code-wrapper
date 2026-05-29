-- Cluster G Phase 1 (A3): persistence + audit-tagging for MOCK runtime mode.
--
-- The runner has had MOCK mode (`pickRunner()` in `runner/index.ts` routes
-- to `runner/mock.ts` when `config.mock === true`) since v1, but the
-- persistence path is identical between mock and live — every SDKMessage
-- still hits `persistMessage()`, every safety_audit append still writes
-- through the same code path, every multi-agent session row still lands in
-- the same `multi_agent_sessions` table. The on-disk transcript for a mock
-- session is indistinguishable from a live one once the operator scrolls
-- back through it. This is the "misconfigured demo silently mutates a real
-- repo" failure mode flagged by `agentic-reviewer` (per high/G-run-awareness
-- §7): visibility AND audit-tag both required, not either-or.
--
-- This migration adds:
--
--   1. `sessions.mock`              — single-agent session row tagged at
--                                     create time. Reads default to 0
--                                     (existing rows are live).
--   2. `multi_agent_sessions.mock`  — same, for bus sessions.
--   3. `safety_audit.mode`          — every audit row tagged 'mock'|'live'
--                                     at write time. Default 'live' (so
--                                     pre-023 rows remain semantically
--                                     correct — they were written before
--                                     MOCK existed as a tagged dimension,
--                                     and they were all live by definition).
--   4. Per-column indexes for the eval/forensics query "rows from real
--      sessions only" — the default filter is `WHERE mode='live'`, which
--      will scan otherwise.
--   5. A fresh `audit.chain_reset` marker — REQUIRED whenever
--      safety_audit's column set changes, per the contract in migration
--      015's header. The hash chain canonicalizes column-by-column, so
--      pre-023 rows with no `mode` column cannot be re-canonicalized to
--      match post-023 hash bytes. `verifyChain()` starts walking from the
--      most-recent reset marker forward, so the new marker bounds the
--      verifier to rows written with the new column layout.
--
-- Why **not** propagate `mode` from session→audit by JOIN at query time:
-- safety_audit rows are also written with `session_id = NULL` (process-
-- level events: env_scrubbed, tamper_detected, etc.). Storing `mode`
-- directly on the audit row keeps that classification meaningful for
-- process-level rows AND makes the per-row filter index-friendly.
--
-- Why DEFAULT 'live' (not nullable):
--   - SQLite ALTER TABLE ADD COLUMN with a NOT NULL non-DEFAULT new column
--     requires a table rewrite; the DEFAULT side-steps that.
--   - Forensics is a SAFETY surface — a nullable `mode` would invite query
--     authors to write `WHERE mode='live' OR mode IS NULL` and miss the
--     point.
--   - Pre-023 rows ARE live (mock had no audit-tag dimension yet); the
--     default value is the historically correct one for backfill.

ALTER TABLE sessions
  ADD COLUMN mock INTEGER NOT NULL DEFAULT 0;

ALTER TABLE multi_agent_sessions
  ADD COLUMN mock INTEGER NOT NULL DEFAULT 0;

ALTER TABLE safety_audit
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'live';

CREATE INDEX IF NOT EXISTS sessions_mock ON sessions(mock);
CREATE INDEX IF NOT EXISTS multi_agent_sessions_mock ON multi_agent_sessions(mock);
CREATE INDEX IF NOT EXISTS safety_audit_mode ON safety_audit(mode);

-- Fresh chain-reset marker — see migration 015's header for the contract.
-- The marker's `mode` defaults to 'live' (matching the surrounding rows
-- after the ALTER), `hash_self` is the fixed sentinel X'00', and
-- `hash_prev` is NULL so verifyChain treats this row as the new anchor.
--
-- Idempotency: this INSERT runs inside the transaction the `applyMigrations`
-- runner opens; the `schema_migrations` row written at the end of the same
-- transaction guarantees that on a second boot the whole migration (ALTERs
-- + INSERT) is skipped. There is no risk of a duplicate `chain-reset-023`.
INSERT INTO safety_audit (id, ts, kind, reason_code, payload_json, hash_prev, hash_self, mode)
VALUES (
  'chain-reset-023',
  0,
  'audit.chain_reset',
  'migration_023',
  '{"migration":"023_mock_flag","note":"mode column added; verifyChain anchors here"}',
  NULL,
  X'00',
  'live'
);
