import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import {
  aggregateByClass,
  appendRecoveryLog,
  authResumeChoiceRatio,
  listForSession,
  listRecent,
  sweepReopenRate,
  updateRecoveryOutcome,
} from './recovery_log.js';

// Cluster D Phase 1 (spec §8.5): recovery_log repository tests.
//
// Coverage:
//   - migration 018 applies and the table is queryable
//   - append() returns the new row id; row round-trips through listForSession
//   - operator_id defaults to getOperatorId(); explicit override honoured
//   - parent_session_id (XCT-1 lineage) round-trips
//   - updateRecoveryOutcome backfills the column; idempotent on missing id
//   - aggregateByClass returns per-class roll-ups with correct counts +
//     reachedFinalRate + median
//   - sweepReopenRate / authResumeChoiceRatio return the spec's named
//     metrics; null when no denominator

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-recovery-log-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('migration 018 — recovery_log table exists', () => {
  test('table is queryable after migrations run', () => {
    const tables = getDb()
      .prepare<
        [],
        { name: string }
      >(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recovery_log'`)
      .all();
    expect(tables.map((t) => t.name)).toEqual(['recovery_log']);
  });

  test('indexes are in place', () => {
    const idx = getDb()
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'recovery_log'`,
      )
      .all()
      .map((r) => r.name)
      .sort();
    expect(idx).toContain('recovery_log_class_idx');
    expect(idx).toContain('recovery_log_session_idx');
  });
});

describe('appendRecoveryLog', () => {
  test('returns the new row id; row round-trips through listForSession', () => {
    const { id } = appendRecoveryLog({
      sessionId: 's-1',
      failureClass: 'rate_limit',
      operatorAction: 'auto_retry',
      timeToRecoveryMs: 1500,
    });
    expect(id).toBeTypeOf('number');
    const rows = listForSession('s-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      session_id: 's-1',
      failure_class: 'rate_limit',
      operator_action: 'auto_retry',
      time_to_recovery_ms: 1500,
      outcome: null,
    });
  });

  test('operator_id defaults to getOperatorId() — non-empty string', () => {
    appendRecoveryLog({
      sessionId: 's-2',
      failureClass: 'other',
      operatorAction: 'abort',
    });
    const row = listForSession('s-2')[0]!;
    expect(typeof row.operator_id).toBe('string');
    expect(row.operator_id.length).toBeGreaterThan(0);
  });

  test('operator_id override is honoured (test-only override path)', () => {
    appendRecoveryLog({
      sessionId: 's-3',
      failureClass: 'other',
      operatorAction: 'abort',
      operatorId: 'test-rig',
    });
    expect(listForSession('s-3')[0]!.operator_id).toBe('test-rig');
  });

  test('parent_session_id (XCT-1 lineage) round-trips', () => {
    appendRecoveryLog({
      sessionId: 's-child',
      parentSessionId: 's-parent',
      failureClass: 'sweep',
      operatorAction: 'reopen',
    });
    expect(listForSession('s-child')[0]!.parent_session_id).toBe('s-parent');
  });

  test('null sessionId is allowed (process-level recoveries)', () => {
    const { id } = appendRecoveryLog({
      failureClass: 'auth_expired',
      operatorAction: 'in_session_resume',
    });
    const row = getDb()
      .prepare<
        [number],
        { session_id: string | null }
      >('SELECT session_id FROM recovery_log WHERE id = ?')
      .get(id);
    expect(row?.session_id).toBeNull();
  });

  test('invariant_results_json + forensics_id pass through verbatim', () => {
    const json = JSON.stringify({ promptHash: 'pass', wdHash: 'overridden:operator_acknowledged' });
    appendRecoveryLog({
      sessionId: 's-inv',
      failureClass: 'chain_crash',
      operatorAction: 'resume_from_hop',
      invariantResultsJson: json,
      forensicsId: 42,
    });
    const row = listForSession('s-inv')[0]!;
    expect(row.invariant_results_json).toBe(json);
    expect(row.forensics_id).toBe(42);
  });
});

describe('updateRecoveryOutcome', () => {
  test('backfills the outcome column; returns true on success', () => {
    const { id } = appendRecoveryLog({
      sessionId: 's-out',
      failureClass: 'rate_limit',
      operatorAction: 'manual_retry',
    });
    expect(updateRecoveryOutcome(id, 'reached_final')).toBe(true);
    expect(listForSession('s-out')[0]!.outcome).toBe('reached_final');
  });

  test('returns false for unknown id (no-op)', () => {
    expect(updateRecoveryOutcome(999999, 'failed_again')).toBe(false);
  });

  test('subsequent calls overwrite the prior outcome', () => {
    const { id } = appendRecoveryLog({
      sessionId: 's-out2',
      failureClass: 'other',
      operatorAction: 'abort',
    });
    updateRecoveryOutcome(id, 'still_running');
    updateRecoveryOutcome(id, 'failed_again');
    expect(listForSession('s-out2')[0]!.outcome).toBe('failed_again');
  });
});

describe('aggregateByClass', () => {
  test('returns empty list when table is empty', () => {
    expect(aggregateByClass()).toEqual([]);
  });

  test('groups by failure_class with counts + median time + reached-final rate', () => {
    // rate_limit class: 3 rows, 2 with outcome (1 reached_final, 1 failed_again)
    const r1 = appendRecoveryLog({
      sessionId: 's',
      failureClass: 'rate_limit',
      operatorAction: 'auto_retry',
      timeToRecoveryMs: 100,
    });
    const r2 = appendRecoveryLog({
      sessionId: 's',
      failureClass: 'rate_limit',
      operatorAction: 'auto_retry',
      timeToRecoveryMs: 200,
    });
    appendRecoveryLog({
      sessionId: 's',
      failureClass: 'rate_limit',
      operatorAction: 'manual_retry',
      timeToRecoveryMs: 300,
    });
    updateRecoveryOutcome(r1.id, 'reached_final');
    updateRecoveryOutcome(r2.id, 'failed_again');
    // sweep class: 1 row, no time, no outcome → counts but null medians/rate
    appendRecoveryLog({ sessionId: 's', failureClass: 'sweep', operatorAction: 'archive' });

    const agg = aggregateByClass();
    const rl = agg.find((a) => a.failureClass === 'rate_limit')!;
    const sw = agg.find((a) => a.failureClass === 'sweep')!;

    expect(rl.count).toBe(3);
    expect(rl.medianTimeToRecoveryMs).toBe(200);
    // 2 outcomes seen, 1 reached_final → 0.5
    expect(rl.reachedFinalRate).toBe(0.5);

    expect(sw.count).toBe(1);
    expect(sw.medianTimeToRecoveryMs).toBeNull();
    expect(sw.reachedFinalRate).toBeNull();
  });

  test('median for an even count averages the two middle values', () => {
    appendRecoveryLog({
      failureClass: 'rate_limit',
      operatorAction: 'auto_retry',
      timeToRecoveryMs: 100,
    });
    appendRecoveryLog({
      failureClass: 'rate_limit',
      operatorAction: 'auto_retry',
      timeToRecoveryMs: 300,
    });
    const rl = aggregateByClass().find((a) => a.failureClass === 'rate_limit')!;
    expect(rl.medianTimeToRecoveryMs).toBe(200);
  });
});

describe('sweepReopenRate', () => {
  test('null when no sweeps recorded', () => {
    expect(sweepReopenRate()).toBeNull();
  });

  test('returns reopen / total ratio when sweeps exist', () => {
    appendRecoveryLog({ failureClass: 'sweep', operatorAction: 'archive' });
    appendRecoveryLog({ failureClass: 'sweep', operatorAction: 'archive' });
    appendRecoveryLog({ failureClass: 'sweep', operatorAction: 'reopen' });
    const r = sweepReopenRate();
    expect(r).not.toBeNull();
    expect(r!.sweeps).toBe(3);
    expect(r!.rate).toBeCloseTo(1 / 3, 5);
  });
});

describe('authResumeChoiceRatio', () => {
  test('null when no auth recoveries recorded', () => {
    expect(authResumeChoiceRatio()).toBeNull();
  });

  test('returns in-session / total ratio + absolute counts', () => {
    appendRecoveryLog({ failureClass: 'auth_expired', operatorAction: 'in_session_resume' });
    appendRecoveryLog({ failureClass: 'auth_expired', operatorAction: 'in_session_resume' });
    appendRecoveryLog({ failureClass: 'auth_expired', operatorAction: 'new_session' });
    const r = authResumeChoiceRatio();
    expect(r).not.toBeNull();
    expect(r!.inSession).toBe(2);
    expect(r!.newSession).toBe(1);
    expect(r!.inSessionRate).toBeCloseTo(2 / 3, 5);
  });

  test('ignores auth recoveries with non-resume actions (e.g. abort)', () => {
    appendRecoveryLog({ failureClass: 'auth_expired', operatorAction: 'abort' });
    expect(authResumeChoiceRatio()).toBeNull();
  });
});

describe('listRecent', () => {
  test('returns empty list when table has no rows', () => {
    expect(listRecent(50)).toEqual([]);
  });

  test('returns rows in newest-first order (ts DESC)', () => {
    // Three rows with explicit ts overrides so ordering is deterministic.
    const r1 = appendRecoveryLog({
      sessionId: 's-old',
      failureClass: 'rate_limit',
      operatorAction: 'auto_retry',
      tsOverride: 1000,
    });
    const r2 = appendRecoveryLog({
      sessionId: 's-mid',
      failureClass: 'sweep',
      operatorAction: 'archive',
      tsOverride: 2000,
    });
    const r3 = appendRecoveryLog({
      sessionId: 's-new',
      failureClass: 'chain_crash',
      operatorAction: 'archive',
      tsOverride: 3000,
    });
    const rows = listRecent(50);
    expect(rows.map((r) => r.id)).toEqual([r3.id, r2.id, r1.id]);
  });

  test('honours the limit cap', () => {
    for (let i = 0; i < 5; i++) {
      appendRecoveryLog({
        sessionId: `s-${i}`,
        failureClass: 'other',
        operatorAction: 'abort',
        tsOverride: i,
      });
    }
    expect(listRecent(3)).toHaveLength(3);
    expect(listRecent(1)).toHaveLength(1);
  });

  test('includes process-level rows (session_id=null)', () => {
    appendRecoveryLog({
      // No sessionId — repo writes null
      failureClass: 'other',
      operatorAction: 'abort',
      tsOverride: 1000,
    });
    appendRecoveryLog({
      sessionId: 's-bound',
      failureClass: 'sweep',
      operatorAction: 'archive',
      tsOverride: 2000,
    });
    const rows = listRecent(50);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.session_id === null)).toBeDefined();
    expect(rows.find((r) => r.session_id === 's-bound')).toBeDefined();
  });

  test('ties on ts break on id DESC (total order)', () => {
    // Two rows inserted with the same ts override — listRecent must
    // still return them in a deterministic order (newer id first).
    const r1 = appendRecoveryLog({
      failureClass: 'sweep',
      operatorAction: 'archive',
      tsOverride: 1234,
    });
    const r2 = appendRecoveryLog({
      failureClass: 'sweep',
      operatorAction: 'archive',
      tsOverride: 1234,
    });
    const rows = listRecent(10);
    expect(rows.map((r) => r.id)).toEqual([r2.id, r1.id]);
  });
});

describe('migration 018 idempotence', () => {
  test('running migrations a second time is a no-op (db.ts gates by schema_migrations)', () => {
    // Two-phase: close, reopen — the second open re-runs applyMigrations()
    // and must not throw on 017 or 018 being already-applied.
    appendRecoveryLog({ failureClass: 'other', operatorAction: 'abort' });
    closeDb();
    getDb();
    // Row still there → migration didn't drop/recreate the table.
    const count = getDb()
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM recovery_log')
      .get();
    expect(count?.c).toBe(1);
  });
});
