import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ServerMsg } from '@cebab/shared';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import {
  appendRecoveryLog,
  updateRecoveryOutcome,
} from '../repo/recovery_log.js';
import { executeRecoveryLogSnapshot } from './server.js';

// Cluster D Phase 8a (spec §8.5): server-side coverage for the
// `get_recovery_log_snapshot` handler.
//
// Same testability pattern as `executeArchiveSession` —
// `executeRecoveryLogSnapshot` is the pure-ish helper the WS case body
// calls; we exercise it directly against a real SQLite under a tmp
// `~/.cebab`. Tests cover:
//
//   - empty table → envelope still ships (no rows, no aggregates, nulls)
//   - populated → aggregates / sweepReopenRate / authResumeChoiceRatio
//     all rebuilt from the same writer set the production code uses
//   - recent rows: newest-first, capped, includes process-level rows
//   - recentLimit clamping: NaN / negative / oversize all fall back
//   - the camelCased wire shape matches the protocol

let tmpRoot: string;
let originalDataDir: string;
let sent: ServerMsg[];

function captureSend(msg: ServerMsg): void {
  sent.push(msg);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-recovery-log-snapshot-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb(); // runs all migrations including 018
  sent = [];
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('executeRecoveryLogSnapshot — empty table', () => {
  test('returns envelope with empty aggregates + null gauges + empty recent', () => {
    executeRecoveryLogSnapshot({ send: captureSend });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'recovery_log_snapshot',
      aggregates: [],
      sweepReopenRate: null,
      authResumeChoiceRatio: null,
      recent: [],
    });
  });
});

describe('executeRecoveryLogSnapshot — populated', () => {
  test('aggregates carry per-class count + reachedFinalRate + median', () => {
    // Two sweep rows: one reached_final, one failed_again, both with
    // time_to_recovery_ms populated → reachedFinalRate=0.5, median=200.
    const a = appendRecoveryLog({
      sessionId: 'sweep-a',
      failureClass: 'sweep',
      operatorAction: 'archive',
      timeToRecoveryMs: 100,
      tsOverride: 100,
    });
    const b = appendRecoveryLog({
      sessionId: 'sweep-b',
      failureClass: 'sweep',
      operatorAction: 'reopen',
      timeToRecoveryMs: 300,
      tsOverride: 200,
    });
    updateRecoveryOutcome(a.id, 'reached_final');
    updateRecoveryOutcome(b.id, 'failed_again');

    // Plus one chain_crash row with no time/outcome — separate class entry.
    appendRecoveryLog({
      sessionId: 'chain-1',
      failureClass: 'chain_crash',
      operatorAction: 'archive',
      tsOverride: 300,
    });

    executeRecoveryLogSnapshot({ send: captureSend });

    const reply = sent[0]!;
    if (reply.type !== 'recovery_log_snapshot') throw new Error('wrong type');
    const sweep = reply.aggregates.find((agg) => agg.failureClass === 'sweep');
    expect(sweep).toMatchObject({
      failureClass: 'sweep',
      count: 2,
      reachedFinalRate: 0.5,
      medianTimeToRecoveryMs: 200, // (100+300)/2
    });
    const chain = reply.aggregates.find((agg) => agg.failureClass === 'chain_crash');
    expect(chain).toMatchObject({
      failureClass: 'chain_crash',
      count: 1,
      reachedFinalRate: null, // no rows with non-null outcome
      medianTimeToRecoveryMs: null,
    });
    // Aggregates are PRESENT only for observed classes; the snapshot
    // explicitly does NOT pad out the union with zero rows.
    expect(
      reply.aggregates.find((agg) => agg.failureClass === 'auth_expired'),
    ).toBeUndefined();
  });

  test('sweepReopenRate reports {rate, sweeps}', () => {
    appendRecoveryLog({ failureClass: 'sweep', operatorAction: 'archive' });
    appendRecoveryLog({ failureClass: 'sweep', operatorAction: 'archive' });
    appendRecoveryLog({ failureClass: 'sweep', operatorAction: 'reopen' });

    executeRecoveryLogSnapshot({ send: captureSend });

    const reply = sent[0]!;
    if (reply.type !== 'recovery_log_snapshot') throw new Error('wrong type');
    expect(reply.sweepReopenRate).toEqual({ rate: 1 / 3, sweeps: 3 });
  });

  test('sweepReopenRate is null when no sweep rows exist', () => {
    appendRecoveryLog({ failureClass: 'rate_limit', operatorAction: 'auto_retry' });

    executeRecoveryLogSnapshot({ send: captureSend });

    const reply = sent[0]!;
    if (reply.type !== 'recovery_log_snapshot') throw new Error('wrong type');
    expect(reply.sweepReopenRate).toBeNull();
  });

  test('authResumeChoiceRatio reports the in-session vs new-session split', () => {
    appendRecoveryLog({ failureClass: 'auth_expired', operatorAction: 'in_session_resume' });
    appendRecoveryLog({ failureClass: 'auth_expired', operatorAction: 'in_session_resume' });
    appendRecoveryLog({ failureClass: 'auth_expired', operatorAction: 'new_session' });

    executeRecoveryLogSnapshot({ send: captureSend });

    const reply = sent[0]!;
    if (reply.type !== 'recovery_log_snapshot') throw new Error('wrong type');
    expect(reply.authResumeChoiceRatio).toEqual({
      inSessionRate: 2 / 3,
      inSession: 2,
      newSession: 1,
    });
  });

  test('authResumeChoiceRatio is null when no auth_expired rows exist', () => {
    appendRecoveryLog({ failureClass: 'sweep', operatorAction: 'archive' });

    executeRecoveryLogSnapshot({ send: captureSend });

    const reply = sent[0]!;
    if (reply.type !== 'recovery_log_snapshot') throw new Error('wrong type');
    expect(reply.authResumeChoiceRatio).toBeNull();
  });
});

describe('executeRecoveryLogSnapshot — recent rows', () => {
  test('recent is newest-first; camelCased per protocol', () => {
    const r1 = appendRecoveryLog({
      sessionId: 's-1',
      parentSessionId: 'p-1',
      failureClass: 'rate_limit',
      operatorAction: 'auto_retry',
      timeToRecoveryMs: 50,
      tsOverride: 1000,
    });
    const r2 = appendRecoveryLog({
      sessionId: 's-2',
      failureClass: 'sweep',
      operatorAction: 'archive',
      tsOverride: 2000,
    });

    executeRecoveryLogSnapshot({ send: captureSend });

    const reply = sent[0]!;
    if (reply.type !== 'recovery_log_snapshot') throw new Error('wrong type');
    expect(reply.recent.map((row) => row.id)).toEqual([r2.id, r1.id]);
    expect(reply.recent[1]).toMatchObject({
      id: r1.id,
      sessionId: 's-1',
      parentSessionId: 'p-1',
      failureClass: 'rate_limit',
      operatorAction: 'auto_retry',
      timeToRecoveryMs: 50,
      ts: 1000,
      outcome: null,
      forensicsId: null,
      invariantResultsJson: null,
    });
    // operator_id is server-side derived; just confirm it's a non-empty string.
    expect(typeof reply.recent[1]?.operatorId).toBe('string');
    expect((reply.recent[1]?.operatorId ?? '').length).toBeGreaterThan(0);
  });

  test('recent includes process-level rows (sessionId=null)', () => {
    appendRecoveryLog({
      failureClass: 'other',
      operatorAction: 'abort',
      tsOverride: 500,
    });
    executeRecoveryLogSnapshot({ send: captureSend });

    const reply = sent[0]!;
    if (reply.type !== 'recovery_log_snapshot') throw new Error('wrong type');
    expect(reply.recent).toHaveLength(1);
    expect(reply.recent[0]?.sessionId).toBeNull();
  });

  test('recentLimit defaults to 100 when absent', () => {
    for (let i = 0; i < 110; i++) {
      appendRecoveryLog({
        failureClass: 'other',
        operatorAction: 'abort',
        tsOverride: i,
      });
    }
    executeRecoveryLogSnapshot({ send: captureSend });

    const reply = sent[0]!;
    if (reply.type !== 'recovery_log_snapshot') throw new Error('wrong type');
    expect(reply.recent).toHaveLength(100);
  });

  test('recentLimit honoured when explicit + within [1, 100]', () => {
    for (let i = 0; i < 10; i++) {
      appendRecoveryLog({
        failureClass: 'other',
        operatorAction: 'abort',
        tsOverride: i,
      });
    }
    executeRecoveryLogSnapshot({ recentLimit: 3, send: captureSend });

    const reply = sent[0]!;
    if (reply.type !== 'recovery_log_snapshot') throw new Error('wrong type');
    expect(reply.recent).toHaveLength(3);
  });

  test('recentLimit > 100 silently clamps to 100', () => {
    for (let i = 0; i < 150; i++) {
      appendRecoveryLog({
        failureClass: 'other',
        operatorAction: 'abort',
        tsOverride: i,
      });
    }
    executeRecoveryLogSnapshot({ recentLimit: 10_000, send: captureSend });

    const reply = sent[0]!;
    if (reply.type !== 'recovery_log_snapshot') throw new Error('wrong type');
    expect(reply.recent).toHaveLength(100);
  });

  test('recentLimit < 1 falls back to default 100', () => {
    for (let i = 0; i < 5; i++) {
      appendRecoveryLog({
        failureClass: 'other',
        operatorAction: 'abort',
        tsOverride: i,
      });
    }
    executeRecoveryLogSnapshot({ recentLimit: 0, send: captureSend });

    const reply = sent[0]!;
    if (reply.type !== 'recovery_log_snapshot') throw new Error('wrong type');
    expect(reply.recent).toHaveLength(5); // all 5 rows, default cap >= 5
  });

  test('non-finite recentLimit (NaN / Infinity) falls back to default', () => {
    appendRecoveryLog({
      failureClass: 'other',
      operatorAction: 'abort',
    });
    executeRecoveryLogSnapshot({ recentLimit: Number.NaN, send: captureSend });
    let reply = sent[0]!;
    if (reply.type !== 'recovery_log_snapshot') throw new Error('wrong type');
    expect(reply.recent).toHaveLength(1);

    sent.length = 0;
    executeRecoveryLogSnapshot({ recentLimit: Number.POSITIVE_INFINITY, send: captureSend });
    reply = sent[0]!;
    if (reply.type !== 'recovery_log_snapshot') throw new Error('wrong type');
    expect(reply.recent).toHaveLength(1);
  });

  test('fractional recentLimit is floored', () => {
    for (let i = 0; i < 10; i++) {
      appendRecoveryLog({
        failureClass: 'other',
        operatorAction: 'abort',
        tsOverride: i,
      });
    }
    executeRecoveryLogSnapshot({ recentLimit: 3.9, send: captureSend });

    const reply = sent[0]!;
    if (reply.type !== 'recovery_log_snapshot') throw new Error('wrong type');
    // 3.9 → 3 (floor) — guards against bound-param-type weirdness.
    expect(reply.recent).toHaveLength(3);
  });
});
