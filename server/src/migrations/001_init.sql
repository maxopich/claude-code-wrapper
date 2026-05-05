CREATE TABLE projects (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  path         TEXT NOT NULL UNIQUE,
  trusted      INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title           TEXT,
  created_at      INTEGER NOT NULL,
  last_event_at   INTEGER NOT NULL,
  total_cost_usd  REAL NOT NULL DEFAULT 0
);

CREATE INDEX sessions_project_idx ON sessions(project_id, last_event_at DESC);

CREATE TABLE events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  ts           INTEGER NOT NULL,
  raw          TEXT NOT NULL,
  type         TEXT NOT NULL,
  subtype      TEXT,
  UNIQUE (session_id, seq)
);

CREATE INDEX events_session_seq_idx ON events(session_id, seq);
