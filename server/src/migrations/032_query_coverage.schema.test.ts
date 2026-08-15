import { describe, expect, test } from 'vitest';
import { getDb } from '../db.js';
import { withTempDataDir } from '../test_support/temp_data_dir.js';

// Migration 032_query_coverage.sql: makes four indexes match the queries that
// actually run (register D14, D15, D23, D30).
//
// Pinned here because every one of these is invisible to typecheck, to lint,
// and to every behavioural test in the repo: a wrong index changes nothing but
// how long the answer takes. `query_plans.test.ts` asserts the planner USES
// them; this file asserts they exist in the shape that makes that possible.

describe('migration 032_query_coverage schema shape', () => {
  withTempDataDir('mig032');

  function indexes(table: string): { name: string; unique: number; partial: number }[] {
    return getDb()
      .prepare<[], { name: string; unique: number; partial: number }>(
        `PRAGMA index_list('${table}')`,
      )
      .all();
  }

  function indexColumns(name: string): string[] {
    return getDb()
      .prepare<[], { name: string | null }>(`PRAGMA index_info('${name}')`)
      .all()
      .map((r) => r.name ?? '<expr>');
  }

  /** The index's own DDL, which is where `DESC` and the partial `WHERE` live —
   *  `PRAGMA index_info` reports neither. */
  function indexSql(name: string): string {
    const row = getDb()
      .prepare<[string], { sql: string | null }>(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`,
      )
      .get(name);
    return row?.sql ?? '';
  }

  test('D14: multi_agent_events is indexed on (session_id, id)', () => {
    expect(indexColumns('multi_agent_events_session_id_idx')).toEqual(['session_id', 'id']);
  });

  test('D14: the (session_id, ts) index SURVIVES', () => {
    // Deliberately not replaced. It still serves `MAX(ts)` for the recovery
    // context as a COVERING index, which the (session_id, id) one cannot —
    // dropping it would trade one temp B-tree for another.
    expect(indexColumns('multi_agent_events_session_ts_idx')).toEqual(['session_id', 'ts']);
  });

  test('D15: safety_audit has BOTH the composite and the kind-only index', () => {
    expect(indexColumns('safety_audit_session_kind')).toEqual(['session_id', 'kind']);
    // The composite cannot serve a bare `kind = ?` — session_id is the leading
    // column — and that is the shape verifyChain's anchor lookup uses on every
    // boot. The register asked for the composite alone; one index would have
    // left the boot path scanning.
    expect(indexColumns('safety_audit_kind')).toEqual(['kind']);
  });

  test('D23: the redundant explicit index on events is gone', () => {
    const names = indexes('events').map((i) => i.name);
    expect(names).not.toContain('events_session_seq_idx');
  });

  test('D23: and the UNIQUE constraint that made it redundant is still there', () => {
    // The whole argument for dropping it. If the UNIQUE ever goes away, the
    // explicit index has to come back, and this is where that is noticed.
    const unique = indexes('events').filter((i) => i.unique === 1);
    expect(unique.length).toBeGreaterThanOrEqual(1);
    expect(unique.map((i) => indexColumns(i.name))).toContainEqual(['session_id', 'seq']);
  });

  test('D30: notifications_unacked is keyed on ts DESC, still partial', () => {
    expect(indexColumns('notifications_unacked')).toEqual(['ts']);
    const sql = indexSql('notifications_unacked');
    // DESC matters: the inbox reads newest-first, and an ASC index would be
    // walked backwards only if the planner chooses to — with DESC it is the
    // natural order.
    expect(sql).toMatch(/ts\s+DESC/i);
    // The partial predicate must be unchanged, or every query that matched the
    // old index silently stops matching this one.
    expect(sql).toMatch(/WHERE\s+acked_at\s+IS\s+NULL/i);
    // And acked_at must NOT be in the key — it is constant inside the
    // predicate, which is what made the old index useless.
    expect(indexColumns('notifications_unacked')).not.toContain('acked_at');
  });
});
