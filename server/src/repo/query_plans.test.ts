/**
 * The hot queries must be served by an index, not by a scan-and-sort.
 *
 * WHY THIS EXISTS. An index that stops covering its query breaks nothing a
 * test can see. The rows come back, in the right order, with the right
 * contents — SQLite just reads the whole table and sorts it first. Four
 * findings in the 1 Aug 2026 register (D13, D14, D15, D23, D30) were exactly
 * that: indexes that looked right in the DDL and could not be used by the
 * statement the code issues. None of them failed a test; all of them were
 * found by reading `EXPLAIN QUERY PLAN`.
 *
 * So read `EXPLAIN QUERY PLAN`. Two assertions per query:
 *
 *   1. the plan names the index we expect, and
 *   2. the plan contains no `USE TEMP B-TREE` — the planner's own admission
 *      that it has to materialise and sort the whole result before it can
 *      return the first row, which is what makes a `LIMIT` useless.
 *
 * The SQL strings below are COPIES of the ones in the repo modules, not
 * imports — SQLite plans a statement, and there is no way to hand it a
 * prepared statement from elsewhere. The copies are the weak point of this
 * gate: a query that changes in its module and not here goes on being checked
 * in its old shape. `sameShapeAsSource` pins each one against the module file
 * so that drift fails instead of passing quietly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { getDb } from '../db.js';
import { withTempDataDir } from '../test_support/temp_data_dir.js';

const SERVER_SRC = path.join(import.meta.dirname, '..');

function plan(sql: string, params: unknown[] = []): string[] {
  return getDb()
    .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((r) => r.detail);
}

/**
 * Assert the copy above still resembles the statement in the module.
 *
 * Deliberately loose — it matches on the distinctive clause rather than the
 * whole statement, because whitespace and template interpolation differ. The
 * point is to catch a query being REWRITTEN, not reformatted.
 */
function sameShapeAsSource(relFile: string, fragment: string): void {
  const src = fs.readFileSync(path.join(SERVER_SRC, relFile), 'utf8');
  const normalised = src.replace(/\s+/g, ' ');
  expect(
    normalised.includes(fragment.replace(/\s+/g, ' ')),
    `${relFile} no longer contains: ${fragment}`,
  ).toBe(true);
}

describe('query plans — the hot paths are index-served', () => {
  withTempDataDir('queryplans');

  test('D13/D30: the inbox window uses the ts index and does not sort', () => {
    sameShapeAsSource(
      'notifications/inbox.ts',
      'SELECT * FROM notifications ${windowWhere} ORDER BY ts DESC LIMIT ?',
    );
    const p = plan(
      'SELECT * FROM notifications WHERE acked_at IS NULL AND ts >= ? ORDER BY ts DESC LIMIT ?',
      [0, 200],
    );
    expect(p.join(' ')).toContain('notifications_unacked');
    expect(p.join(' ')).not.toContain('USE TEMP B-TREE');
  });

  test('D14: the bus event replay uses (session_id, id) and does not sort', () => {
    sameShapeAsSource(
      'repo/multi_agent.ts',
      'SELECT * FROM multi_agent_events WHERE session_id = ? AND id > ? ORDER BY id ASC',
    );
    const p = plan(
      'SELECT * FROM multi_agent_events WHERE session_id = ? AND id > ? ORDER BY id ASC',
      ['s', 0],
    );
    expect(p.join(' ')).toContain('multi_agent_events_session_id_idx');
    expect(p.join(' ')).not.toContain('USE TEMP B-TREE');
  });

  test('D29: the recovery aggregate reads through an index, not the table', () => {
    sameShapeAsSource(
      'repo/multi_agent.ts',
      'SELECT MAX(ts) AS max_ts FROM multi_agent_events WHERE session_id = ?',
    );
    const p = plan('SELECT MAX(ts) AS max_ts FROM multi_agent_events WHERE session_id = ?', ['s']);
    expect(p.join(' ')).toContain('multi_agent_events_session_ts_idx');
    // No temp-B-tree assertion for the GROUP BY sibling: SQLite does sort the
    // GROUPS, and there is one group per agent. That is bounded by the roster,
    // not by the transcript, which is the whole point of the change.
  });

  test('D15: the audit session+kind lookup searches instead of scanning', () => {
    sameShapeAsSource(
      'repo/safety_audit_lookup.ts',
      "WHERE session_id = ? AND kind = 'session.stopped'",
    );
    const p = plan(
      `SELECT id FROM safety_audit WHERE session_id = ? AND kind = ? ORDER BY rowid DESC LIMIT 1`,
      ['s', 'k'],
    );
    expect(p.join(' ')).toContain('safety_audit_session_kind');
    expect(p.join(' ')).not.toContain('SCAN safety_audit');
    expect(p.join(' ')).not.toContain('USE TEMP B-TREE');
  });

  test('D15: and so does the anchor lookup that runs on every boot', () => {
    sameShapeAsSource(
      'notifications/safety_audit.ts',
      'FROM safety_audit WHERE kind = ? ORDER BY rowid DESC LIMIT 1',
    );
    const p = plan(
      'SELECT rowid, id, hash_self FROM safety_audit WHERE kind = ? ORDER BY rowid DESC LIMIT 1',
      ['k'],
    );
    // The composite alone could not serve this — session_id leads it. This is
    // the assertion that would have caught the register's suggested fix.
    expect(p.join(' ')).toContain('safety_audit_kind');
    expect(p.join(' ')).not.toContain('SCAN safety_audit');
  });

  test('D23: dropping the duplicate index cost the events table nothing', () => {
    // Every events query must still be index-served by the UNIQUE constraint's
    // automatic index. If one of these ever reports a SCAN, the explicit index
    // has to come back and this is where that shows up.
    for (const [label, sql] of [
      ['list by session', 'SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC'],
      ['max seq', 'SELECT MAX(seq) AS m FROM events WHERE session_id = ?'],
      ['delete by session', 'DELETE FROM events WHERE session_id = ?'],
    ] as const) {
      const p = plan(sql, ['s']).join(' ');
      expect(p, `${label}: ${p}`).toContain('sqlite_autoindex_events_1');
      expect(p, `${label}: ${p}`).not.toContain('USE TEMP B-TREE');
    }
  });

  test('the matcher can still see a bad plan — positive control', () => {
    // Anti-vacuity. Every assertion above is a NEGATIVE ("no temp B-tree",
    // "no scan"), and negatives pass for free if the plan text ever stops
    // arriving — an empty array satisfies all of them. So prove the matcher
    // can produce both strings, on a query nothing indexes.
    const p = plan('SELECT * FROM events WHERE raw = ? ORDER BY subtype', ['x']).join(' ');
    expect(p).toContain('SCAN');
    expect(p).toContain('USE TEMP B-TREE');
  });

  test('EXPLAIN QUERY PLAN returns detail rows at all — positive control', () => {
    // The other half: if `detail` were ever renamed or empty, every `toContain`
    // above would fail loudly, but every `not.toContain` would pass. This is
    // the cheapest possible assertion that the input is real.
    const p = plan('SELECT * FROM sessions WHERE id = ?', ['x']);
    expect(p.length).toBeGreaterThan(0);
    expect(p[0]!.length).toBeGreaterThan(0);
  });
});
