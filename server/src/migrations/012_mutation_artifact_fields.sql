-- Artifact-promotion infrastructure for the Agents / Artifacts per-lane view.
-- Widens `multi_agent_mutations` (added in 011) with the fields the lane
-- and artifact surfaces need to render each file-mutation as a first-class
-- artifact candidate rather than a flat tool-call log line:
--
--   1. file_path   — the target path the tool wrote/edited, relative or
--                    absolute as the SDK delivered it. NULL for tools that
--                    don't target a single file (Bash, Agent, etc.) so the
--                    artifact classifier can skip them cleanly.
--   2. cwd         — the agent's working directory at the moment the tool
--                    fired. Denormalized from the participant row on purpose:
--                    the artifact classifier resolves `file_path` relative
--                    to `cwd` (worktree root) without a JOIN, and the value
--                    is frozen at mutation time even if the participant row
--                    is later updated.
--   3. tool_use_id — the SDK's `tool_use.id` (`"toolu_..."`) so the matching
--                    `tool_result` on the next `user` message can flip
--                    `confirmed_at`. Indexed by (session_id, tool_use_id)
--                    because that's the UPDATE hot path; one tool_use_id is
--                    unique within a session.
--   4. confirmed_at — wall-clock ms when the matching `tool_result` landed.
--                    NULL until then. `confirmed_at IS NULL` is the canonical
--                    "provisional" signal — a Write whose tool_result never
--                    arrives (paused, aborted, errored mid-flight) stays
--                    provisional forever, and the UI renders it with a
--                    distinct badge so the operator isn't misled.
--   5. promoted    — 0/1 flag set by Phase E's `classifyArtifact` when the
--                    file passes the locked promotion globs (plans/**,
--                    PLAN*.md, etc.). Lets the artifacts query stay a flat
--                    `WHERE promoted = 1` instead of replaying the glob
--                    list across every read.
--
-- All five columns are nullable (or DEFAULT 0) so rows from migration 011
-- continue to project — older sessions render with "no artifacts" / no
-- per-file detail rather than erroring. No backfill: the cwd + tool_use_id
-- for pre-012 mutations are gone, and the artifact view is forward-looking.
ALTER TABLE multi_agent_mutations ADD COLUMN file_path    TEXT;
ALTER TABLE multi_agent_mutations ADD COLUMN cwd          TEXT;
ALTER TABLE multi_agent_mutations ADD COLUMN tool_use_id  TEXT;
ALTER TABLE multi_agent_mutations ADD COLUMN confirmed_at INTEGER;
ALTER TABLE multi_agent_mutations ADD COLUMN promoted     INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_multi_agent_mutations_tool_use
  ON multi_agent_mutations(session_id, tool_use_id);
