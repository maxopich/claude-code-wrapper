-- PR-7 (round-2 plan): per-template hopBudget plumb + last-run health rail.
--
-- Widens `multi_agent_sessions` with four columns so the templates UI can
-- render a "Last run: 7 / 12 hops · ok" rail under each saved template:
--
--   1. template_id   — soft FK to MultiAgentTemplate.id (JSON-stored in the
--                      `settings` table, no SQL FK). NULL for runs that
--                      weren't started from a template (the ad-hoc "type
--                      participants by hand" path), and NULL for every row
--                      that predates this migration — those sessions never
--                      recorded which template they came from, so the rail
--                      simply shows "no last run" until the next post-013
--                      run lands. Indexed because the rail's query is
--                      `WHERE template_id = ? ORDER BY started_at DESC
--                      LIMIT 1`.
--   2. hop_budget    — the effective hop budget RESOLVED at session start
--                      (per-template override → per-run override → DB
--                      setting → CEBAB_HOP_BUDGET env → DEFAULT_HOP_BUDGET).
--                      Persisted so the rail can render `X / hop_budget`
--                      without re-resolving precedence — the value at start
--                      is the value the run actually enforced. NULL on
--                      pre-013 rows.
--   3. hops_used     — final count of persisted `multi_agent_events` rows
--                      for this session at teardown time. Written by the
--                      orchestrator's `teardown()` (and chain's symmetric
--                      path). The rail uses this for the "X / Y hops"
--                      display AND to derive the "ok" vs "at cap" label
--                      (`hops_used === hop_budget` → yellow chip). NULL
--                      until teardown lands; NULL on pre-013 rows.
--   4. first_error   — the FIRST operator-facing error text observed
--                      during the run, truncated to ~200 chars at write
--                      time. Captures the synthetic budget-exhausted
--                      error, a worker crash reason, etc. Populated by the
--                      orchestrator's teardown (after the synthetic error
--                      event is appended). NULL when the run ended cleanly
--                      AND on pre-013 rows.
--
-- The four columns are all nullable so rows from 012 keep projecting
-- cleanly — the templates UI then renders those template_id=NULL rows as
-- "no last run for this template" (silent absence, not an error row). No
-- backfill: pre-013 sessions never recorded which template they came from,
-- and the operator hasn't asked for a "guess the template by participant
-- list" heuristic (which would be wrong as soon as a template's participant
-- list was edited).
ALTER TABLE multi_agent_sessions ADD COLUMN template_id  TEXT;
ALTER TABLE multi_agent_sessions ADD COLUMN hop_budget   INTEGER;
ALTER TABLE multi_agent_sessions ADD COLUMN hops_used    INTEGER;
ALTER TABLE multi_agent_sessions ADD COLUMN first_error  TEXT;

CREATE INDEX idx_multi_agent_sessions_template
  ON multi_agent_sessions(template_id, started_at DESC);
