-- Register D20: make (session_id, tool_use_id) the unique key that migration
-- 012 already says it is.
--
-- WHAT WAS WRONG. 012 introduced `tool_use_id` and documented it in its own
-- header: "Indexed by (session_id, tool_use_id) because that is the UPDATE hot
-- path; one tool_use_id is unique within a session." The very next statement
-- creates a PLAIN index. The asserted invariant was enforced by nothing, and
-- `confirmMutationByToolUseId` was written against the assertion rather than
-- against the schema: its UPDATE has no row limit, so a duplicate had
-- `confirmed_at` flipped on every copy, and both of its read-backs were
-- single-row `.get()` calls over a predicate that could match several rows,
-- returning an arbitrary one to the wire.
--
-- This is 016/D09 one table over, and it gets D09's remedy for D09's reason: a
-- rule that lives in one repository function is not inherited by the next
-- writer, so for a table the pause-on-dangerous gate reads before a
-- destructive command is allowed to proceed, the constraint belongs in the
-- schema where it cannot be forgotten.
--
-- PR #337 closed the two writers that minted duplicates (a delegate-only
-- agent's denied call, and an overload retry re-emitting a `tool_use` id the
-- tap had already fired for). This closes the schema half. Existing rows were
-- never cleaned up by that PR, so the dedupe below is not optional.

-- STEP 1 of 3. Roll `promoted` onto the row step 2 is about to keep.
--
-- `promoted` is the one column that can legitimately sit on a row this
-- migration deletes. It is written by `setMutationPromoted(confirmed.id)`,
-- where `confirmed` came from the arbitrary read-back described above, so
-- among duplicates it landed on whichever row SQLite happened to return.
-- `confirmed_at` and `tool_result_json` need no such rescue: the un-limited
-- UPDATE wrote them to every duplicate, so the survivor already has them.
UPDATE multi_agent_mutations
   SET promoted = 1
 WHERE tool_use_id IS NOT NULL
   AND promoted = 0
   AND id IN (
     SELECT MAX(id) FROM multi_agent_mutations
      WHERE tool_use_id IS NOT NULL
      GROUP BY session_id, tool_use_id
   )
   AND EXISTS (
     SELECT 1 FROM multi_agent_mutations d
      WHERE d.session_id  = multi_agent_mutations.session_id
        AND d.tool_use_id = multi_agent_mutations.tool_use_id
        AND d.promoted = 1
   );

-- STEP 2 of 3. Dedupe. Not optional: CREATE UNIQUE INDEX fails on a table that
-- already holds duplicates, which would be a hard startup failure for exactly
-- the operators whose databases this migration exists to repair.
--
-- KEEPING MAX(id), NOT MIN(id), and the reason is operator state rather than
-- symmetry with 033. `applyPauseGate` calls `setMutationPauseState(row.id, ...)`
-- with the row the append just returned, which is always the NEWEST duplicate.
-- Keeping the oldest would therefore delete the pause_state of a session that
-- is halted awaiting a human click at the moment this migration runs during a
-- restart, which is precisely the R-B case Cebab supports. `id` is
-- AUTOINCREMENT (011), so MAX(id) is true write order, not a timestamp that
-- ties.
--
-- What is lost is the earliest `ts` of a repeat that was recorded milliseconds
-- apart, which only affects display ordering. What is preserved is a live
-- gate. Every deleted row also survives in the hash-chained `safety_audit`
-- trail, so this prunes the ledger the gate queries, not the record.
DELETE FROM multi_agent_mutations
 WHERE tool_use_id IS NOT NULL
   AND id NOT IN (
     SELECT MAX(id) FROM multi_agent_mutations
      WHERE tool_use_id IS NOT NULL
      GROUP BY session_id, tool_use_id
   );

-- STEP 3 of 3. Partial, and the WHERE clause is the whole point.
--
-- NULL tool_use_id is not an edge case, it is two supported populations: rows
-- written before 012 added the column at all, and `tool_use` blocks that
-- arrive with no id, which PR #337 deliberately keeps recording because an
-- unidentifiable call cannot be recognised as a repeat and over-recording is
-- the safer error for a ledger the pause gate reads. SQLite treats NULLs as
-- distinct in a unique index, so those rows would not collide today in any
-- case, but stating the predicate makes the intent enforceable rather than
-- incidental, and it is what lets step 2 above leave them alone.
CREATE UNIQUE INDEX multi_agent_mutations_tool_use_key
    ON multi_agent_mutations(session_id, tool_use_id)
 WHERE tool_use_id IS NOT NULL;
