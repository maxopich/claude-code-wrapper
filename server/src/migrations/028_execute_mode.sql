-- Per-session "Execute mode" opt-in for orchestrator-mode bus sessions.
--
-- By default a bus session runs in CONSULTANT mode: the consultant-mode prompt
-- in `server/src/bus/runtime.ts` (renderWorkerBriefing / renderRosterPrompt)
-- tells every worker to analyze/advise and NOT produce deliverable changes
-- unless the routed message explicitly relays a user-directed change. That
-- makes a whole session advice-only.
--
-- `execute_mode = 1` flips the orchestrator-mode briefings to permit each
-- worker to create/modify/delete files WITHIN ITS OWN PROJECT FOLDER to actually
-- do the work. Writes outside the worker's own folder are still discouraged by
-- the prompt and flagged post-hoc by `guardrail.ts` into the hash-chained
-- safety_audit log (workers run bypassPermissions, so this boundary is advisory
-- + detected, not hard-blocked — same posture as consultant mode).
--
-- Set at session start from the setup-screen checkbox (WS `start_multi_agent`
-- field `executeMode`), persisted via `setExecuteMode`, and read back on R-B
-- reconstruct so a post-restart session re-briefs workers in the same mode.
--
-- Default 0 keeps every pre-028 row and every un-opted session in the safe
-- consultant posture. INTEGER NOT NULL DEFAULT 0 side-steps a table rewrite
-- (SQLite ADD COLUMN with a DEFAULT is a metadata-only change). Does not touch
-- safety_audit, so no chain-reset marker is required.

ALTER TABLE multi_agent_sessions
  ADD COLUMN execute_mode INTEGER NOT NULL DEFAULT 0;
