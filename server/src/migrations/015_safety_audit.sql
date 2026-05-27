-- Cluster A Phase 1: append-only hash-chained safety audit.
--
-- The structural-distinction commitment from critical/A-notification-surface.md
-- §3: every `class='safety'` dispatcher emit MUST land here BEFORE the WS
-- envelope is sent. If the append fails, the caller refuses to proceed and a
-- top-level "safety log unavailable" banner fires (BE-1). The notifications
-- table (014) is the operator surface; this table is the obligation.
--
-- Tamper detection: each row's `hash_self` = sha256(canonical(row without
-- hash_self) || hash_prev). Mutating any row breaks the chain at that row,
-- detected by the repository's verifyChain() on server boot and (Phase 3+)
-- on every WS attach. A broken chain emits an `audit.tamper_detected` danger
-- notification and the dispatcher refuses further safety emissions until
-- acknowledged.
--
-- Per validation-report.md XCT-1 (cross-cluster amendment, applied here as
-- precedent for the matching forensics/recovery tables in Clusters C & D):
--
--   operator_id        — author of the action being audited. Defaults to
--                        'local-user'; the repository populates it from
--                        os.userInfo().username at append time (with
--                        'local-user' fallback if userInfo() throws). Even
--                        in single-user-local v1, the schema retrofit later
--                        is painful, so we lock it in now.
--   parent_session_id  — lineage pointer for sessions that descend from
--                        another (R-B recovery, sweep-superseded, future
--                        chain reconstruction). Multi-operator forensics +
--                        session-lineage queries are impossible without it,
--                        and a nullable TEXT column is free.
--
-- Append-only enforcement is application-layer: the repository module
-- (notifications/safety_audit.ts) only exposes append() and verifyChain();
-- no UPDATE/DELETE codepath exists. SQLite has no GRANT, so this is a code
-- discipline — caught at test time via direct-DB-write red-team checks.
CREATE TABLE safety_audit (
  id                 TEXT PRIMARY KEY,
  ts                 INTEGER NOT NULL,
  session_id         TEXT,                                       -- null for process-level events
  parent_session_id  TEXT,                                       -- XCT-1: session lineage
  operator_id        TEXT NOT NULL DEFAULT 'local-user',         -- XCT-1: author of action
  agent_id           TEXT,                                       -- bus agent slug; null pre-routing
  kind               TEXT NOT NULL,                              -- e.g. 'router.drop'
  reason_code        TEXT NOT NULL,                              -- enumerated sub-code (see §7 floor)
  payload_json       TEXT NOT NULL,
  hash_prev          BLOB,                                       -- sha256 of previous row's hash_self
  hash_self          BLOB NOT NULL                               -- sha256(canonical(this) || hash_prev)
);

CREATE INDEX safety_audit_ts ON safety_audit(ts);

-- Sibling ack table — append-only chain stays untouchable by an ack writing
-- back. Operator identity + reason (where required by sub-class) land here
-- when the UI's ack_notification ClientMsg arrives (Phase 2+).
CREATE TABLE safety_audit_ack (
  audit_id      TEXT PRIMARY KEY REFERENCES safety_audit(id),
  acked_at      INTEGER NOT NULL,
  acked_by      TEXT NOT NULL,
  acked_reason  TEXT
);

-- Genesis chain-reset marker (per spec R-5 / plan R-A3).
--
-- verifyChain() walks rows starting from the most recent `audit.chain_reset`
-- marker — the marker itself is the anchor and is trusted as the chain head
-- (its hash_self is a fixed sentinel, NOT a computed digest). Subsequent
-- appends compute hash_self = sha256(canonical(row) || hash_prev) where the
-- first real row's hash_prev = this sentinel.
--
-- Why a marker at all: future migrations that ALTER safety_audit (column
-- additions, type widenings) would invalidate any digest computed from row
-- columns alone — recomputing hash_self at read-time would mismatch the
-- stored bytes and verifyChain would fire false-positive tampering alarms.
-- The mitigation: any future ALTER inserts a fresh `audit.chain_reset`
-- marker; verifyChain only walks the post-marker tail. Documented as a
-- contract for whoever writes migration 0NN_alter_safety_audit.sql.
--
-- The marker's ts=0 is deterministic; the migration is idempotent because
-- the surrounding schema_migrations dedupe in db.ts gates re-application.
INSERT INTO safety_audit (id, ts, kind, reason_code, payload_json, hash_prev, hash_self)
VALUES (
  'chain-reset-015',
  0,
  'audit.chain_reset',
  'migration_015',
  '{"migration":"015_safety_audit","note":"genesis marker; verifyChain anchors here"}',
  NULL,
  X'00'
);
