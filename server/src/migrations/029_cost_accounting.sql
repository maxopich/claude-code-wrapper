-- Cost accounting for the multi-agent bus.
--
-- An N-agent session recorded no cost anywhere. The only capacity signal was
-- the hop count, which weighs a 2k-token routing turn and a 180k-token
-- analysis turn identically, so "7/12 hops" told an operator nothing about
-- what the run actually spent.
--
-- The SDK reports it: every `result` message carries `total_cost_usd` for THAT
-- INVOCATION (not a running total — it equals `sum(modelUsage[*].costUSD)`,
-- which are per-invocation token counters, and observed sequences are not
-- monotonic: a session whose two turns cost $0.4205 and $0.0571 reports
-- exactly those, in that order). The bus simply never read the field. Now
-- `AgentRunner` forwards each hop's figure and `addAgentCost` accumulates it.
--
-- Two columns rather than one: the session total answers "what did this run
-- cost", the per-agent rows answer "which agent burned it" — and the second
-- question is the actionable one when a run overruns. The total is by
-- construction the sum of its per-agent rows (`addAgentCost` writes both in
-- one transaction).
--
-- NOT INCLUDED: any rewrite of the existing single-agent `sessions.total_cost_usd`.
-- The accounting bug there is fixed forward in `runner/orchestrator.ts` (it
-- assigned the latest turn's cost instead of adding it), but historical rows
-- are left alone — see that file's comment for why the observed data does not
-- match what the code would have produced, which is a discrepancy worth
-- understanding before rewriting anyone's records.
--
-- Both ADD COLUMNs use a literal DEFAULT, so SQLite treats them as
-- metadata-only (no table rewrite). Neither touches `safety_audit`, so no
-- chain-reset marker is required.

ALTER TABLE multi_agent_sessions
  ADD COLUMN total_cost_usd REAL NOT NULL DEFAULT 0;

-- Keyed the same way the runner is (bus slug, not project id — the
-- orchestrator has no `multi_agent_participants` row).
ALTER TABLE multi_agent_agent_sessions
  ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
