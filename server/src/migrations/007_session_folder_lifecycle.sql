-- Per-session bus folder + lifecycle modes.
--
-- Two new columns on `multi_agent_sessions`:
--
--   * `session_folder` — absolute path to the per-session directory under
--     the operator's workspace root (e.g.
--     `~/agents/.cebab-session-<id>/`). Holds the orchestrator workspace
--     + live bus traffic (inboxes/, archive/, bus.log, iterations/).
--     Nullable for pre-007 rows; resume falls back to `~/.cebab/bus/`
--     for those so old sessions still re-attach.
--
--   * `lifecycle` — `'persistent'` (default) or `'temp'`. Persistent
--     sessions survive End so they can be resumed. Temp sessions auto-
--     clean on End: bus install is removed from each participant and
--     `session_folder` is rm-rf'd. Defaults to 'persistent' so existing
--     rows behave as before.
ALTER TABLE multi_agent_sessions ADD COLUMN session_folder TEXT;
ALTER TABLE multi_agent_sessions ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'persistent';
