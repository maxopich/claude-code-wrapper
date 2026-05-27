-- Cluster A Phase 1: notification inbox table.
--
-- Backs the sticky-operational + safety-mirror rows the WS notification
-- dispatcher persists when it emits. Non-sticky operational notifications
-- (e.g. info/success toasts) are NEVER inserted here — they exist purely as
-- transient WS envelopes; this table is the operator's "what did I miss"
-- inbox, replayed on every WS attach via `SELECT … WHERE acked_at IS NULL`.
--
-- Columns mirror the wire envelope (shared/src/protocol.ts NotificationEnvelope)
-- so the inbox row can be re-fanned into a fresh NotificationEnvelope without
-- a shape translation. `class` is the structural axis (operational vs safety)
-- that gates the audit dual-write — `severity` is the display-tier axis the
-- UI uses for colour and live-region.
--
-- For safety-class rows, `audit_row_id` points at the corresponding
-- safety_audit row (migration 015) so the inbox UI can deep-link to the
-- forensic record; `reason_code` carries the enumerated sub-code (see the
-- minimum vocabulary in critical/A-notification-surface.md §7) — operational
-- rows leave both NULL.
--
-- The three indexes cover the v1 query patterns:
--   - notifications_unacked: WS-attach replay of stuck sticky rows.
--   - notifications_dedupe:  fast LRU lookup for the operational-coalesce
--                            window in the dispatcher.
--   - notifications_session: future per-session inbox view (Phase 5).
CREATE TABLE notifications (
  id            TEXT PRIMARY KEY,
  ts            INTEGER NOT NULL,
  severity      TEXT NOT NULL,           -- 'info' | 'success' | 'warn' | 'error' | 'danger'
  class         TEXT NOT NULL,           -- 'operational' | 'safety'
  dedupe_key    TEXT NOT NULL,
  title         TEXT NOT NULL,
  message       TEXT,
  details_json  TEXT,
  session_id    TEXT,
  project_id    INTEGER,
  action_json   TEXT,                    -- serialized NotificationAction discriminated union
  sticky        INTEGER NOT NULL DEFAULT 0,
  audit_row_id  TEXT,                    -- soft FK to safety_audit.id (safety class only)
  reason_code   TEXT,                    -- enumerated sub-code (safety class only)
  acked_at      INTEGER,
  acked_by      TEXT,
  acked_reason  TEXT
);

CREATE INDEX notifications_unacked ON notifications(acked_at) WHERE acked_at IS NULL;
CREATE INDEX notifications_dedupe  ON notifications(dedupe_key);
CREATE INDEX notifications_session ON notifications(session_id);
