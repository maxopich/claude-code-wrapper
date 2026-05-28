-- Cluster C Phase 3 (spec §5.5 / §4.6): forensic bundle table for control
-- actions. Phase 3 captures bundles for single-agent Stop (§4.6 BE-6);
-- Cluster C Part 2 (mute/pause/kick, separate phase) reuses the same
-- table — that's why this lands now, even though only the `session.stopped`
-- caller exists today.
--
-- Linkage: each forensics row points at exactly one `safety_audit` row via
-- `safety_audit_id`. The inverse direction (safety_audit → forensics_id) is
-- intentionally not added: that would require an UPDATE on the append-only
-- chain, breaking the hash. Lookups in the audit-viewer go forensics ←
-- safety_audit_id, which the index below covers.
--
-- Why TEXT for safety_audit_id: safety_audit.id is TEXT (randomUUID). The
-- FK reference enforces the link at write time; ON DELETE is left default
-- (RESTRICT) because deleting an audit row is forbidden by the append-only
-- policy anyway. SQLite needs PRAGMA foreign_keys=ON for the constraint to
-- bite — applyMigrations() sets that pragma at boot in db.ts (see schema
-- pragma block).
--
-- Per validation-report.md XCT-1, the same operator_id + parent_session_id
-- pattern from safety_audit also lives here so future multi-operator
-- forensics queries don't need a JOIN through safety_audit just to attribute
-- the snapshot's author. operator_id defaults to 'local-user'; the
-- repository sets it from getOperatorId() at append time.
--
-- Field rationale (matches spec §5.5):
--   effective_prompt_json   — the prompt the agent would have run on its
--                              next turn, including any held-queue text and
--                              currently-injected modifiers. For single-agent
--                              Stop in Phase 3, we capture conn.capturedPrompts
--                              when present (rate-limit hold state) and the
--                              session's last user message otherwise.
--   events_last_n_json      — most-recent 50 wire events for the session,
--                              from the events table (raw column). Used by
--                              the audit-viewer for "what was the agent doing
--                              when Stopped" context.
--   pending_tool_calls_json — tool calls awaiting permission at Stop time.
--                              For single-agent: snapshot of
--                              conn.pendingPermissions filtered to the
--                              session. NULL when none.
--   workdir_tree_hash       — sha256 of shallow {path,size,mtime} listing of
--                              the project cwd, capped to top 200 entries.
--                              The hash is for incident-reconstruction
--                              fingerprinting ("did the workdir change since
--                              the snapshot?"), not for diffing — so a
--                              shallow shape is enough.
--   active_permissions_json — effective trust + permissionMode at Stop time
--                              plus, when known, the project's allow/deny
--                              lists (currently a stub for Phase 3; the
--                              project_authority resolver covers more in a
--                              later refinement).
--   bus_inbox_outbox_json   — NULL for single-agent (bus is multi-agent
--                              only). Reserved for Part 2.
--   mutation_rationale_json — NULL for single-agent (mutation classifier is
--                              orchestrator-side). Reserved for Part 2.
--   snapshot_failed_reason  — populated when capture itself failed (e.g. fs
--                              walk threw). The audit row still got written
--                              with reasonCode='snapshot_failed', so the
--                              chain is intact and the failure is visible.
CREATE TABLE controllability_forensics (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  safety_audit_id          TEXT NOT NULL REFERENCES safety_audit(id),
  ts                       INTEGER NOT NULL,
  session_id               TEXT,                    -- for fast session-scoped queries
  parent_session_id        TEXT,                    -- XCT-1: lineage
  operator_id              TEXT NOT NULL DEFAULT 'local-user',  -- XCT-1
  agent_slug               TEXT,                    -- NULL for session-level (single-agent Stop)
  effective_prompt_json    TEXT NOT NULL,
  events_last_n_json       TEXT NOT NULL,
  pending_tool_calls_json  TEXT,
  workdir_tree_hash        TEXT,
  active_permissions_json  TEXT,
  bus_inbox_outbox_json    TEXT,
  mutation_rationale_json  TEXT,
  snapshot_failed_reason   TEXT
);

CREATE INDEX controllability_forensics_audit ON controllability_forensics(safety_audit_id);
CREATE INDEX controllability_forensics_session_ts ON controllability_forensics(session_id, ts);
