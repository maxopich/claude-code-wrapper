-- Cluster C Phase 4a (Part 2 backend foundation, spec §5.4): per-agent
-- control state columns on multi_agent_participants. Persistence-only
-- slice — the router/runner enforcement and the operator-facing
-- handlers land in Phase 4b. Lands now so the next slice can rely on a
-- stable schema + repo surface.
--
-- The columns are sized for the spec's verb model (§5.1):
--   muted               1 if router suppresses outbound where ev.source = this; 0 otherwise.
--                        Default 0. Even a paused or kicked participant is "not muted"
--                        unless an explicit mute action set it (orthogonal verbs).
--   paused_until        Epoch ms at which auto-expiry fires; NULL when not paused.
--                        Per spec §5.6 the WIRE LEVEL requires `timeoutMs` on every
--                        pause_participant ClientMsg (NOT NULL constraint at the wire
--                        validator). Schema stays nullable to model the "not paused"
--                        state without a sentinel value.
--   pause_expiry_action 'auto_resume' | 'auto_kick' (validated app-side). NULL when
--                        not paused. Determines what fires when paused_until passes
--                        without operator intervention.
--   kicked_at           Epoch ms of the kick action; NULL when participant is active.
--                        Non-NULL = kicked (regardless of drain completion state).
--   kicked_mode         'drain' (v1: soft drain) | 'hard' (v1.1: per-agent
--                        AbortController). Wire carries the field; v1 server rejects
--                        'hard' with wrapper_error per spec §5.2.
--
-- R-A (reattach) + R-B (server-restart reconstruct) read these columns into
-- the in-memory OrchestratorRouter sets on session resume — without this,
-- a Cebab restart would silently unmute a muted worker (the spec's
-- AE-14 safety regression).
--
-- All five columns are nullable / default-0 so existing rows from sessions
-- written before this migration get sensible "no control state ever applied"
-- defaults. The ALTER TABLE statements are idempotent under SQLite's
-- schema_migrations dedupe; PRAGMA is not needed because better-sqlite3
-- runs the file in a transaction and the IF EXISTS-style guard happens at
-- the application layer.
--
-- Cross-cluster note: a future ALTER on safety_audit (per spec R-A3) would
-- require a chain-reset marker; this migration touches only
-- multi_agent_participants, which is not hash-chained — no marker needed.

ALTER TABLE multi_agent_participants ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE multi_agent_participants ADD COLUMN paused_until INTEGER;
ALTER TABLE multi_agent_participants ADD COLUMN pause_expiry_action TEXT;
ALTER TABLE multi_agent_participants ADD COLUMN kicked_at INTEGER;
ALTER TABLE multi_agent_participants ADD COLUMN kicked_mode TEXT;

-- Lookups for the router's "is this source muted?" / "is this participant
-- paused or kicked?" hot paths run per-event during a bus turn. Composite
-- index on the three state-flag columns lets WHERE-by-session-id queries
-- short-circuit without scanning every participant row.
CREATE INDEX multi_agent_participants_control_state
  ON multi_agent_participants(session_id, muted, paused_until, kicked_at);
