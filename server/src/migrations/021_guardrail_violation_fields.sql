-- Cluster F Phase D5+: per-mutation guardrail-violation fields on
-- multi_agent_mutations. Phase D5 surfaced the always-on consultant-mode
-- guardrail in the UI; this phase adds *detection* — server-side
-- classification of every mutation tool call against the agent's cwd, so
-- a write whose target path falls outside the agent's project folder is
-- visible as a violation in the mutation row itself.
--
-- The detection is post-hoc — bus workers run with bypassPermissions, so
-- canUseTool is never called and we can't deny at the SDK gate. The
-- mutation has already happened by the time we record it. The signal here
-- is forensic: operator sees the violation in the MutationsDisclosure +
-- a safety_audit row carries the durable record of which path was
-- targeted and which agent did it. Enforcement-by-deny is a future slice
-- and would require a different permission posture for bus workers.
--
-- Why two columns:
--   guardrail_violation_path  Absolute (resolved) path the agent attempted to
--                             write. NULL when the mutation is in-scope (the
--                             common case) OR when the tool has no file path
--                             (Bash, Task, spawn). The presence of a non-NULL
--                             value IS the "violation observed" signal — UI
--                             reducers gate on `row.guardrail_violation_path
--                             !== null` to render the badge.
--
--   guardrail_reason          Enumerated reason code:
--                               'path_outside_cwd' — target path resolves to
--                                 outside the agent's project folder.
--                             Defined as an open-ended TEXT so future
--                             sub-cases (e.g. system path detection,
--                             dotfile target) can extend without a
--                             migration. Validated app-side at write time.
--
-- Both columns are NULLABLE with no default — pre-021 rows project as
-- "in-scope" (NULL = no signal), and writes from runner.ts populate them
-- only when the classifier flags a violation. Rows written by the bus
-- runner BEFORE the runner wiring lands (between this migration applying
-- and the wiring deploying) will naturally read as in-scope; that's fine
-- because the wiring is what produces the signal, the schema just
-- provides the persistence slot.
--
-- Re-application: the migration runner gates on `schema_migrations`, so
-- this file is applied at most once per DB. The plain `ALTER TABLE ADD
-- COLUMN` would fail on a re-run if it slipped past the gate, but the
-- runner doesn't expose that path — same pattern as every other ALTER
-- migration in this directory.

ALTER TABLE multi_agent_mutations
  ADD COLUMN guardrail_violation_path TEXT;

ALTER TABLE multi_agent_mutations
  ADD COLUMN guardrail_reason TEXT;

-- Indexing note: not indexed in v1. The UI queries
-- listMultiAgentMutations by session_id (already covered by the existing
-- per-session index) and filters guardrail rows client-side. A
-- cross-session "show me all guardrail violations" query would benefit
-- from `CREATE INDEX … WHERE guardrail_violation_path IS NOT NULL`, but
-- there's no such surface in v1 — safety_audit is the cross-session
-- forensic store, and the dispatcher's audit row already carries the
-- structured payload for offline analysis.
