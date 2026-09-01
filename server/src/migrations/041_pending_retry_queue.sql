-- Move the pending-retry slot from the SESSION onto a per-AGENT row.
--
-- Migration 010 put five `pending_retry_*` columns on multi_agent_sessions and
-- justified them (its own comment) with "only one worker can be in the
-- pending-retry slot at a time (next failure overwrites, success clears)".
-- That premise is false in orchestrator mode. Different agents run genuinely in
-- parallel (bus/runner.ts: same-agent turns are serialized, "Calls for
-- DIFFERENT agents are unaffected (still parallel)"), and `renderRosterPrompt`
-- Step 1 mandates the orchestrator bus_send an intro to EACH participant, so
-- every session with >=2 workers opens with an N-way concurrent fan-out. If two
-- of those turns fail, the second `onWorkerFailed`'s single UPDATE overwrites
-- the first worker's row — the operator gets one Retry banner instead of two,
-- and the first worker's exact replay bytes are destroyed.
--
-- This is the same shape migration 031 fixed for the pause-on-dangerous gate:
-- a session-scoped slot that "worker B" clobbers while "worker A" is still
-- pending (register B06). The fix is the same — key the state on the agent.
--
-- `multi_agent_pending_retries` holds at most one pending retry per
-- (session, agent). `setPendingRetry` upserts by agent (no cross-agent
-- overwrite); `getPendingRetry` returns the FRONT (oldest by ts) so the wire
-- keeps carrying one descriptor and the banner surfaces the queued retries one
-- at a time; `clearPendingRetry(session, agent)` reaps exactly the one an
-- operator retried or an agent recovered from, promoting the next; a `null`
-- `setPendingRetry` clears the whole session on teardown. ON DELETE CASCADE so
-- the rows drop with the session, same lifecycle as _events / _mutations.
--
-- The five superseded columns on multi_agent_sessions are LEFT IN PLACE and are
-- no longer read or written — dropping a column rewrites the table on older
-- SQLite builds (same call migration 031 made). Any row that still held a live
-- pending retry at upgrade time is backfilled into the new table below so an
-- in-flight run keeps its banner across the migration.
CREATE TABLE multi_agent_pending_retries (
  session_id     TEXT    NOT NULL REFERENCES multi_agent_sessions(id) ON DELETE CASCADE,
  agent_name     TEXT    NOT NULL,
  prompt         TEXT    NOT NULL,
  reason         TEXT    NOT NULL,
  ts             INTEGER NOT NULL,
  error_event_id INTEGER NOT NULL,
  PRIMARY KEY (session_id, agent_name)
);

-- The hot read is "front of queue" = oldest pending retry for a session.
CREATE INDEX idx_multi_agent_pending_retries_front
  ON multi_agent_pending_retries(session_id, ts);

INSERT INTO multi_agent_pending_retries
  (session_id, agent_name, prompt, reason, ts, error_event_id)
SELECT id,
       pending_retry_agent,
       pending_retry_prompt,
       pending_retry_reason,
       pending_retry_ts,
       pending_retry_error_event_id
  FROM multi_agent_sessions
 WHERE pending_retry_agent          IS NOT NULL
   AND pending_retry_prompt         IS NOT NULL
   AND pending_retry_reason         IS NOT NULL
   AND pending_retry_ts             IS NOT NULL
   AND pending_retry_error_event_id IS NOT NULL;
