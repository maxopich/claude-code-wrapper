-- Cluster D Phase 1 (spec §6.4 — D3 sweep recovery foundation).
--
-- Adds `archived` to `multi_agent_sessions` so that "set aside" sessions
-- (swept by the Phase 5 reopen flow, or operator-archived from the
-- SweptSessionBanner) can be filtered out of the default iteration list
-- without losing the row + transcript.
--
-- Spec §6.4 motivation: an operator who starts a fresh session that sweeps
-- the prior active one needs to be able to "archive" the swept session as
-- a one-click acknowledgement that they're done with it. The row stays
-- (queryable from `list_archived_iterations`) so a later forensic dive
-- can still inspect what ran, but the everyday session picker doesn't
-- surface it.
--
-- We deliberately do NOT add an `archived_at` timestamp in this phase —
-- the multi_agent_sessions table already carries `started_at`/`ended_at`
-- which the operator-visible timeline uses; archive-vs-not is a binary
-- visibility filter, not a third lifecycle state. If a future phase needs
-- to query "archived in last 7 days" it can add `archived_at` then.
--
-- The default 0 means: every pre-existing row stays visible (no operator
-- ever has to do a manual "unarchive my history" pass after upgrading).
-- The Phase 5 `archive_session` ClientMsg flips this column to 1.
--
-- Idempotence: SQLite has no `ADD COLUMN IF NOT EXISTS`. The
-- schema_migrations gate in `db.ts` ensures this file only ever runs once
-- per database file; re-running the migration list at boot is a no-op.

ALTER TABLE multi_agent_sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

-- A partial index so the (common) "list non-archived" query stays as cheap
-- as it was before this column was added. Archived rows are the long tail;
-- the active set is what the session picker reads on every project click.
CREATE INDEX multi_agent_sessions_archived_idx
  ON multi_agent_sessions(archived, started_at DESC);
