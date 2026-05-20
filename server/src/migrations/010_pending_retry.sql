-- Worker failure surfacing + manual retry. Adds DB-backed pending-retry state
-- to `multi_agent_sessions` so an operator can re-issue a failed worker's last
-- turn (chain or orchestrator mode), and so a Cebab server restart preserves
-- the Retry/Abandon affordance via R-B reconstruction.
--
-- Background: today both routers' deliverTurn .catch() collapses every worker
-- failure into `teardown('crashed')` and the operator sees only a red "Lost"
-- status pill — no agent name, no reason, no way to recover. With these five
-- columns, a failed deliverTurn writes a synthetic `cebab→user kind=error`
-- event + persists the pending-retry slot here; the UI shows a Retry/Abandon
-- banner above the prompt input (precedent: the R-B Continue banner gated by
-- the `awaiting_continue` column added in migration 009).
--
-- Columns vs. child table: the row is 1:1 with the session, only one worker
-- can be in the pending-retry slot at a time (next failure overwrites, success
-- clears), and there's no historical query value — exactly the shape that
-- fits as columns rather than a child table.
--
--   * pending_retry_agent          — bus slug whose turn failed.
--   * pending_retry_prompt         — the EXACT bytes last delivered to that
--                                    agent (post-briefing + project-rules
--                                    prefix). Replayed verbatim on retry so
--                                    the briefing isn't double-prepended.
--   * pending_retry_reason         — operator-facing failure summary, e.g.
--                                    "`reviewer`'s last turn failed: SDK
--                                    result subtype=error_during_execution".
--   * pending_retry_ts             — wall-clock ms of the failure.
--   * pending_retry_error_event_id — multi_agent_events.id of the synthetic
--                                    cebab→user kind=error row, so the
--                                    "Jump to error" button in the banner
--                                    can trail-scroll to it.
--
-- All five columns are nullable and move together (a single transactional
-- setter writes all five or clears all five). Status column stays 'running'
-- while paused — mirrors `awaiting_continue`'s overlay shape.
ALTER TABLE multi_agent_sessions ADD COLUMN pending_retry_agent          TEXT;
ALTER TABLE multi_agent_sessions ADD COLUMN pending_retry_prompt         TEXT;
ALTER TABLE multi_agent_sessions ADD COLUMN pending_retry_reason         TEXT;
ALTER TABLE multi_agent_sessions ADD COLUMN pending_retry_ts             INTEGER;
ALTER TABLE multi_agent_sessions ADD COLUMN pending_retry_error_event_id INTEGER;
