-- Register D09: make `mcp_trust` the lookup that 016 and the repository both
-- already claim it is.
--
-- WHAT WAS WRONG. 016 declares `UNIQUE(server_name, origin_path, binary_sha)`
-- and `recordTrustDecision` writes through `INSERT OR REPLACE`, on the stated
-- understanding that re-deciding the same server replaces the prior row.
-- SQLite treats NULLs as DISTINCT in a UNIQUE index, so for
-- `binary_sha IS NULL` the conflict never fires and every decision appends.
--
-- That is not an edge case. It is the case the column is nullable FOR, spelled
-- out three lines above 016's UNIQUE: `npx <name>` and anything else whose
-- target cannot be resolved to a binary on disk. An operator who denied such a
-- server and later trusted it left two rows behind, and the table stopped
-- being a lookup and became an append log that only `ORDER BY ts DESC`
-- disambiguated.
--
-- WHY A PARTIAL INDEX RATHER THAN A NEW TABLE. A table-level UNIQUE creates an
-- implicit index that SQLite will not let us drop, so "fix the constraint"
-- means recreating `mcp_trust` and copying an operator's real trust decisions
-- across. A partial unique index covers exactly the gap the table-level one
-- misses, is additive, and leaves the non-null path — which already worked —
-- byte-for-byte alone.
--
-- WHY NOT ENFORCE IT IN THE REPOSITORY INSTEAD (delete-then-insert, the
-- register's other suggestion). It would work today and be bypassable
-- tomorrow: the guarantee would live in one function rather than in the
-- schema, and the next writer to this table would not inherit it. For a table
-- the spawn gate consults before an MCP binary executes, the constraint
-- belongs where it cannot be forgotten.

-- The dedupe is not optional: CREATE UNIQUE INDEX fails on a table that
-- already holds duplicates, so an operator with an existing `npx` decision
-- would hit a hard migration failure at startup without this.
--
-- Keyed on MAX(id), not MAX(ts). `id` is AUTOINCREMENT and `INSERT OR REPLACE`
-- mints a fresh one, so it is true write order; `ts` is `Date.now()` and is
-- precisely the value that ties when an operator corrects a misclick inside
-- one millisecond. Every decision deleted here survives in the hash-chained
-- `safety_audit` (`kind='mcp.trust_decided'`), which `recordTrustDecision`'s
-- own header already names as the complete forensic trail — this prunes the
-- lookup, not the record.
DELETE FROM mcp_trust
 WHERE binary_sha IS NULL
   AND id NOT IN (
     SELECT MAX(id) FROM mcp_trust
      WHERE binary_sha IS NULL
      GROUP BY server_name, origin_path
   );

-- Partial: `WHERE binary_sha IS NULL` is the whole point. Without it this
-- index would forbid a server holding decisions at two different binary
-- hashes, which is a case the design explicitly supports (binary updated,
-- pinned-hash mismatch detected) and 016 documents as distinct rows.
CREATE UNIQUE INDEX mcp_trust_null_sha_key
    ON mcp_trust(server_name, origin_path)
 WHERE binary_sha IS NULL;
