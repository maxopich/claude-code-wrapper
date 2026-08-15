-- Make four indexes match the queries that actually run.
--
-- Four findings from the 1 Aug 2026 register, all measured with
-- EXPLAIN QUERY PLAN against this schema rather than argued from the DDL. The
-- pattern in every one of them is the same: an index exists, it looks
-- plausible, and the planner cannot use it for the query the code issues.
--
--   D30  `notifications_unacked` is ON notifications(acked_at)
--        WHERE acked_at IS NULL. The indexed column is CONSTANT inside its own
--        partial index, so it carries no information — the index degenerates
--        to a row-id list, and the inbox's `ORDER BY ts DESC` pays a
--        USE TEMP B-TREE FOR ORDER BY on every snapshot.
--
--        This one is paired with D13 (the same query had no LIMIT). Neither
--        fix works alone: a LIMIT cannot stop early when the planner must sort
--        the whole set first, and an ordered index does not help a query that
--        materialises every row into JavaScript anyway.
--
--   D14  multi_agent_events is indexed on (session_id, ts), but the replay
--        query is `WHERE session_id = ? AND id > ? ORDER BY id ASC`. The
--        planner uses the index for the session filter and then sorts —
--        another temp B-tree, on every attach replay and every reconstruct.
--
--   D15  safety_audit had no index on session_id or kind, so BOTH of its
--        lookup shapes were a full SCAN of a table this schema documents as
--        append-only and never pruned:
--          - (session_id, kind)  — safety_audit_lookup.ts, on reconstruct
--          - (kind)              — verifyChain's anchor lookup, ON EVERY BOOT
--        The register asked for the composite alone. That would have left the
--        boot-path query scanning: session_id is the leading column, so a
--        (session_id, kind) index cannot serve a bare `kind = ?`. Hence two
--        indexes, not one.
--
--   D23  `events` declares UNIQUE (session_id, seq) — which SQLite implements
--        with sqlite_autoindex_events_1 — and ALSO an explicit index on
--        exactly those columns. Two B-trees maintained on every insert into
--        the largest table, for one read benefit. Re-planned every events
--        query without the explicit index: all fall through to the autoindex,
--        two of them as COVERING searches. Nothing loses coverage.
--
-- Index names are not referenced from any TypeScript, so dropping and
-- recreating is safe; `032_query_coverage.schema.test.ts` pins the result.

-- D14. The (session_id, ts) index stays: it still serves `MAX(ts)` for the
-- recovery context as a COVERING index, which this one would not.
CREATE INDEX multi_agent_events_session_id_idx
  ON multi_agent_events(session_id, id);

-- D15, both shapes. Within a (session_id, kind) group SQLite orders index
-- entries by rowid, so `ORDER BY rowid DESC LIMIT 1` is served by walking the
-- index backwards rather than sorting.
CREATE INDEX safety_audit_session_kind ON safety_audit(session_id, kind);
CREATE INDEX safety_audit_kind         ON safety_audit(kind);

-- D23. `IF EXISTS` because a database created before 001 shipped this index is
-- not a case we need, but a re-run after a partial restore is.
DROP INDEX IF EXISTS events_session_seq_idx;

-- D30. Drop the acked_at key entirely — inside `WHERE acked_at IS NULL` it can
-- only ever hold NULL — and index the column the query orders by. The partial
-- predicate is unchanged, so every query that matched the old index still
-- matches this one.
DROP INDEX IF EXISTS notifications_unacked;
CREATE INDEX notifications_unacked
  ON notifications(ts DESC) WHERE acked_at IS NULL;
