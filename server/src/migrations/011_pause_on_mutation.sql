-- Item #5 — opt-in pause-on-first-mutation + persisted mutation log for bus
-- sessions. Bus participants run with `bypassPermissions`, so without this
-- there is no human-in-the-loop check between the consultant guardrail prompt
-- and silent disk mutations. Three columns + one new table:
--
--  1. multi_agent_sessions.pause_on_mutation — operator opt-in at session
--     start (UI: checkbox next to Lifecycle). When 1, the FIRST non-`read`
--     tool call from any worker triggers an awaiting_continue-style overlay;
--     operator clicks Continue (subsequent mutations auto-allow).
--
--  2. multi_agent_sessions.mutations_acknowledged — flipped 0→1 when the
--     operator clicks Continue on the pause banner. Persists across server
--     restart so an already-approved session doesn't re-pause on R-B.
--
--  3. multi_agent_sessions.pending_mutation_id — soft FK to the
--     multi_agent_mutations row that caused the current pause. NULL when no
--     pause active. No SQL FOREIGN KEY constraint (mirrors migration 010's
--     `pending_retry_error_event_id` pattern); the in-code helper joins.
--
--  4. multi_agent_mutations — parallel log of non-`read` tool calls observed
--     during the session. One row per classified mutation. Indexed by
--     session_id for the Session-info "Mutations" disclosure and R-B replay.
--     ON DELETE CASCADE from multi_agent_sessions so the rows drop with the
--     session (same lifecycle as _events / _participants).
CREATE TABLE multi_agent_mutations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT    NOT NULL REFERENCES multi_agent_sessions(id) ON DELETE CASCADE,
  ts         INTEGER NOT NULL,
  agent_name TEXT    NOT NULL,
  tool_name  TEXT    NOT NULL,
  category   TEXT    NOT NULL CHECK (category IN ('mutate', 'dangerous')),
  summary    TEXT    NOT NULL
);

CREATE INDEX idx_multi_agent_mutations_session ON multi_agent_mutations(session_id, ts);

ALTER TABLE multi_agent_sessions ADD COLUMN pause_on_mutation      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE multi_agent_sessions ADD COLUMN mutations_acknowledged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE multi_agent_sessions ADD COLUMN pending_mutation_id    INTEGER;
