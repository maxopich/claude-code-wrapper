-- Cluster B Phase 2: MCP server trust-on-first-use (TOFU) table.
--
-- Per critical/B-authority-transparency.md §4.4: every MCP server that the
-- bus or single-agent path is about to spawn must be checked against this
-- table BEFORE its binary executes. A `first_seen` entry blocks the spawn
-- and emits `mcp_auto_install_pending`; the operator's decision (Trust /
-- Trust & pin hash / Deny once / Deny & remember) writes a row here.
--
-- The spec calls this migration `019_mcp_trust.sql` because it assumed
-- other clusters had bumped the migration counter first. We're at 015 (the
-- Cluster A floor), so the next available number is 016 — the actual
-- spawn-gate code (Phase 4) reads from this table by name, not by number,
-- so the renumbering is purely cosmetic.
--
-- Spawn-gate decision table (Phase 4 wires it):
--
--   trusted              + hash matches    → silent, proceed
--   trusted_pinned_hash  + hash matches    → silent, proceed
--   trusted_pinned_hash  + hash mismatch   → mcp_auto_install_pending { reason: 'hash_changed' } + block
--   denied_remember      (any hash)        → silent refusal + safety_audit row
--   no row                                 → mcp_auto_install_pending { reason: 'first_seen' } + block
--
-- A `deny_once` decision is **not persisted** — it expires at session end
-- and the operator is re-prompted on the next spawn. Only persisted decision
-- values (`trusted`, `trusted_pinned_hash`, `denied_remember`) land here.
--
-- Schema notes (mirroring 015_safety_audit.sql conventions):
--
--   binary_sha   — sha256 of the resolved command target's bytes; NULL when
--                  the target is unresolvable (e.g. `npx <name>` resolves
--                  per-spawn from npm registry). Hash-pinned trust on an
--                  unresolvable target is meaningless, so the UI gates
--                  Trust-pinned-hash off in that case (Phase 4 enforces).
--   origin_path  — absolute path to the settings.json that declared the
--                  server (user vs project vs local scope). A server with
--                  the same name at a DIFFERENT origin path is a distinct
--                  row — operators trust per (name, origin, hash) tuple,
--                  not per name alone. Catches the case where a sibling
--                  project's `.claude/settings.local.json` redefines a
--                  trusted server name to point at a different binary.
--   operator     — author of the trust decision; populated from
--                  os.userInfo().username at decision time (same path as
--                  safety_audit.operator_id, with the same 'local-user'
--                  fallback). Future multi-operator install will rely on
--                  this for forensics.
--   decision     — enumerated; one of 'trusted', 'trusted_pinned_hash',
--                  'denied_remember'. Application-layer enforcement (Phase
--                  4 repository) refuses any other value at write time.
--
-- UNIQUE(server_name, origin_path, binary_sha) makes the table act as a
-- decision lookup: re-writing the same (name, origin, hash) triple is a
-- conflict (INSERT OR REPLACE in the repo Phase 4 ships). Multiple
-- decisions for the same name across different hashes (binary updated,
-- pinned-hash mismatch detected) are distinct rows — the lookup uses
-- (server_name, origin_path, binary_sha) directly, so the most recent
-- pinned-hash decision wins for that tuple.
CREATE TABLE mcp_trust (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  server_name  TEXT NOT NULL,
  origin_path  TEXT NOT NULL,
  binary_sha   TEXT,                                              -- nullable for unresolvable targets (npx, etc.)
  decision     TEXT NOT NULL,                                     -- 'trusted' | 'trusted_pinned_hash' | 'denied_remember'
  operator     TEXT NOT NULL,                                     -- from os.userInfo().username; 'local-user' fallback
  UNIQUE(server_name, origin_path, binary_sha)
);

CREATE INDEX mcp_trust_server_origin ON mcp_trust(server_name, origin_path);
