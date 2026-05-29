-- Cluster I Phase C5 (UI_Findings spec §4.3 / §4.5): extend single-agent
-- `sessions` with the same archive + soft-delete columns that
-- `multi_agent_sessions` already carries (017 = archived for bus rows).
--
-- Two new columns:
--   - `archived`   — flipped by the `bulk_session_op { op: 'archive' }`
--                    handler. Mirrors the bus precedent: "set aside; don't
--                    show in the default per-project session picker". The
--                    row + its events + its JSONL stay on disk for forensic
--                    inspection. A later "Include archived" toggle in the
--                    sidebar (deferred to the C5 UI slice) flips a filter
--                    flag; backend-side this just changes the WHERE clause.
--   - `deleted_at` — 7-day soft-delete window per spec §4.3. The
--                    `bulk_session_op { op: 'delete' }` handler stamps
--                    `Date.now()` here instead of issuing a hard DELETE;
--                    the per-boot + interval purge cron (in
--                    `server/src/bulk_session_op.ts`) hard-deletes rows
--                    where `deleted_at < now - 7d`. The 7d window is the
--                    operator's undo affordance; the safety_audit row
--                    written by the handler itself is NEVER deleted by the
--                    purge — audit lineage survives forensic cleanup
--                    (spec §7 invariant).
--
-- Why not extend `multi_agent_sessions` too in this migration. Multi-agent
-- already has `clear_iterations` (hard-clear for non-running rows) and
-- `archive_session` (Phase D5 individual archive); the bulk surface for
-- the bus iteration browser is a separate slice if/when operator demand
-- materializes. Keeping this migration single-table keeps the blast
-- radius small.
--
-- Idempotence: SQLite has no `ADD COLUMN IF NOT EXISTS`, but the
-- `schema_migrations` gate in `db.ts` ensures each file runs exactly once
-- per DB. Re-running the migration list at boot is a no-op.
--
-- The default `0` / NULL means: every pre-025 row stays visible (no
-- operator ever has to do a manual "un-archive my history" pass after
-- upgrading).

ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN deleted_at INTEGER;

-- Composite index covering the two filter modes:
--   - default sidebar query (`WHERE archived = 0 AND deleted_at IS NULL`)
--   - "include archived" query (`WHERE deleted_at IS NULL`)
--   - purge cron (`WHERE deleted_at IS NOT NULL AND deleted_at < ?`)
-- archived first because the default picker filter is the hot path.
CREATE INDEX sessions_archived_deleted_idx
  ON sessions(archived, deleted_at);
