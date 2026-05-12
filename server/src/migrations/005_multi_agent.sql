-- Multi-agent / bus runtime tables.
--
-- Co-exists with the existing `sessions` table — those are SDK-mode sessions
-- (one Claude subprocess per user message). The tables below describe the
-- separate bus runtime, where persistent TUI agents talk to each other over
-- a filesystem + tmux substrate. See the plan at
-- `~/.claude/plans/here-is-the-list-foamy-gem.md` for the full architecture.

CREATE TABLE multi_agent_sessions (
  id           TEXT PRIMARY KEY,
  mode         TEXT NOT NULL,                   -- 'chain' | 'orchestrator'
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  status       TEXT NOT NULL,                   -- 'running' | 'completed' | 'stopped' | 'crashed'
  tmux_session TEXT                             -- so Cebab can re-attach after reconnect
);

CREATE INDEX multi_agent_sessions_status_idx
  ON multi_agent_sessions(status, started_at DESC);

CREATE TABLE multi_agent_participants (
  session_id  TEXT NOT NULL REFERENCES multi_agent_sessions(id) ON DELETE CASCADE,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,                    -- 'orchestrator' | 'worker'
  chain_order INTEGER,                          -- NULL outside of chain mode
  PRIMARY KEY (session_id, project_id)
);

CREATE TABLE multi_agent_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES multi_agent_sessions(id) ON DELETE CASCADE,
  ts          INTEGER NOT NULL,
  source      TEXT NOT NULL,                    -- 'user' | 'orchestrator' | '<agent-name>'
  destination TEXT NOT NULL,                    -- 'user' | '<agent-name>'
  kind        TEXT NOT NULL,                    -- 'intro' | 'prompt' | 'reply' | 'final' | 'error'
  text        TEXT NOT NULL
);

CREATE INDEX multi_agent_events_session_ts_idx
  ON multi_agent_events(session_id, ts);

-- Project-level bus state. `bus_installed=1` means we have appended the
-- `@import` line to the project's CLAUDE.md and written its `.claude/settings.json`
-- shim. `bus_agent_name` is the slug used in the bus filesystem layout —
-- captured at install time so a later project rename does not orphan inboxes.
ALTER TABLE projects ADD COLUMN bus_installed   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN bus_agent_name  TEXT;
