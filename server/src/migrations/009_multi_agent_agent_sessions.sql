-- Per-agent CLI session ids for multi-agent (bus) runs + the conservative
-- post-restart recovery flag. Enables R-B (resume an orchestrated run after
-- a Cebab server restart); supersedes the R-A "mark crashed" behavior.
--
-- Background: each bus participant already gets its own `--resume`-able
-- claude CLI session id, captured per hop in `AgentRunner.sessions`. That
-- map lived only in process memory, so a Cebab server restart lost it and
-- the run was marked `crashed` (decision R-A). Persisting the map here is
-- the one missing ingredient that lets an orchestrated run be reconstructed
-- and re-attached after a restart.
--
--   * multi_agent_agent_sessions — (session_id, agent_name) → the last
--     COMPLETED claude session id for that agent, upserted every time
--     `AgentRunner` records a turn's `result`. `agent_name` is the bus slug
--     (or 'orchestrator'); it is intentionally NOT a project id — the
--     orchestrator has no `multi_agent_participants` row, and the runner is
--     keyed by slug. ON DELETE CASCADE mirrors _participants / _events.
--
--   * multi_agent_sessions.awaiting_continue — set to 1 when a session is
--     reconstructed after a server restart. The run is re-attached
--     READ-ONLY: nothing is auto-delivered until the operator explicitly
--     continues (so an interrupted turn's side effects can't be silently
--     re-applied). Cleared when the operator continues. Defaults to 0 so
--     pre-009 rows behave exactly as before.
CREATE TABLE multi_agent_agent_sessions (
  session_id     TEXT NOT NULL REFERENCES multi_agent_sessions(id) ON DELETE CASCADE,
  agent_name     TEXT NOT NULL,
  cli_session_id TEXT NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (session_id, agent_name)
);

ALTER TABLE multi_agent_sessions ADD COLUMN awaiting_continue INTEGER NOT NULL DEFAULT 0;
