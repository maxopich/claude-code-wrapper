-- Trust-on-first-use ledger for `.claude/settings*.json` HOOKS.
--
-- MCP servers have had one since migration 016 (`mcp_trust`). Hooks never did,
-- and they are the more direct execution primitive: an MCP server is a process
-- the model must choose to call, whereas a `SessionStart` / `PreToolUse` /
-- `PostToolUse` / `Stop` hook is a shell command the CLI runs on its own
-- schedule, with no model decision and no tool-approval card in front of it.
--
-- The exposure widened in #260. Bus workers and chain participants now run with
-- `settingSources: ['user', 'project', 'local']`, so a participant project's
-- own hooks execute on EVERY bus hop for that participant — and bus agents
-- never see a permission prompt for anything except `AskUserQuestion`. Before
-- this table, that execution left no record anywhere: not in `safety_audit`,
-- not in the operator's notifications, nowhere.
--
-- IDENTITY is the tuple (project, hook kind, declaring settings file, command,
-- args). Any change to the command text is a DIFFERENT hook, not a mutation of
-- the existing one — a fresh row, reported as `first_seen`. That is deliberate:
-- rewriting the command is exactly the case an operator must re-read.
--
-- `script_sha` catches the case identity cannot: the command is untouched but
-- the file it points at was rewritten. `./`-relative and `$CLAUDE_PROJECT_DIR`
-- forms are resolved against the project root; anything unresolvable (a bare
-- `jq`, a pipeline, a missing file) stores NULL and simply gets no
-- change-detection — the same honest posture `mcp_trust.binary_sha` takes
-- for `npx <name>`.
--
-- What this migration does NOT do: block a spawn. `mcp_trust` has a gate
-- (`awaitMcpTrustDecisions`) that parks the run until the operator answers;
-- the hook equivalent needs its own operator prompt and is a separate change.
-- What lands here is detection: a durable ledger, a hash-chained
-- `safety_audit` row, and a live operator notification the first time a hook
-- is seen and every time its script changes underneath a stable command.
--
-- ON DELETE CASCADE mirrors every other project-scoped table: forgetting a
-- project forgets its hook history, and re-adding it re-prompts from scratch.
-- That is the correct default — a re-added project is not the same trust
-- context as the one that was removed.

CREATE TABLE hook_trust (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- 'SessionStart' | 'PreToolUse' | 'PostToolUse' | 'Stop' | any future key.
  -- Stored verbatim rather than enumerated: the CLI owns this vocabulary and
  -- an unrecognized kind must still be recorded, not dropped.
  hook_kind     TEXT NOT NULL,
  -- Absolute path to the settings file that declared it. Same reasoning as
  -- `mcp_trust.origin_path`: the same command at user scope and at a sibling
  -- project's `settings.local.json` are different trust questions.
  origin_path   TEXT NOT NULL,
  command       TEXT NOT NULL,
  -- JSON array, '[]' when absent. Part of the identity, so `guard.sh --dry-run`
  -- and `guard.sh --apply` are distinct rows.
  args_json     TEXT NOT NULL,
  -- sha256 of the resolved script file; NULL when unresolvable.
  script_sha    TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  UNIQUE (project_id, hook_kind, origin_path, command, args_json)
);

CREATE INDEX hook_trust_project_idx ON hook_trust(project_id);
