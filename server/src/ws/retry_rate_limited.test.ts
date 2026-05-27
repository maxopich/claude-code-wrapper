import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import {
  appendRecoveryLog,
  listForSession,
  type FailureClass,
  type OperatorAction,
} from '../repo/recovery_log.js';
import { resolveRetryRateLimited } from './server.js';

// Cluster D Phase 4b (spec §4.2, BE-D4 / BE-D8): server-side coverage
// for the single-agent rate-limit retry path.
//
// Two layers:
//
//   1. `resolveRetryRateLimited` — pure validation, three-way branch
//      (no-held-prompt / in-flight / ok). Exercised directly with a
//      synthetic Map + minimal `{has}` stub.
//
//   2. `recovery_log` write contract — the dispatch site writes a row
//      with `failureClass: 'rate_limit'` + `operatorAction` driven by
//      the client's `auto` flag. Asserted against the real DB so the
//      spec §8.5 regression-gate queries actually see the rows.
//
// The runOneTurn re-invocation isn't unit-tested here — it shares the
// existing single-agent test surface (server.test.ts + the ci_smoke
// integration). What changes per Phase 4b is the cache + the validation
// + the log; those are the contracts the dispatch site depends on.

describe('resolveRetryRateLimited — validation contract', () => {
  test('ok path returns text + projectId from the captured entry', () => {
    const captured = new Map<string, { text: string; projectId: number }>([
      ['sess-1', { text: 'please retry me', projectId: 42 }],
    ]);
    const inFlight = { has: () => false };
    const res = resolveRetryRateLimited(captured, inFlight, 'sess-1');
    expect(res).toEqual({ kind: 'ok', text: 'please retry me', projectId: 42 });
  });

  test('no-held-prompt when the cache has no entry', () => {
    const captured = new Map<string, { text: string; projectId: number }>();
    const inFlight = { has: () => false };
    const res = resolveRetryRateLimited(captured, inFlight, 'sess-unknown');
    expect(res).toEqual({ kind: 'no-held-prompt' });
  });

  test('no-held-prompt when the cache has a DIFFERENT session id', () => {
    // Guards against a stale-key bug where the dispatch site might
    // accidentally key on a wrong id and still return a captured prompt
    // from another session.
    const captured = new Map<string, { text: string; projectId: number }>([
      ['sess-other', { text: 'unrelated', projectId: 99 }],
    ]);
    const inFlight = { has: () => false };
    const res = resolveRetryRateLimited(captured, inFlight, 'sess-target');
    expect(res).toEqual({ kind: 'no-held-prompt' });
  });

  test('in-flight wins when both checks would trigger', () => {
    // If a held prompt exists AND a run is in flight, the in-flight
    // guard fires first (a second retry click while one is running
    // would spawn parallel SDK turns on the same --resume id, which the
    // bus runner's serialization rationale forbids).
    const captured = new Map<string, { text: string; projectId: number }>([
      ['sess-1', { text: 'retry', projectId: 7 }],
    ]);
    const inFlight = { has: (id: string) => id === 'sess-1' };
    const res = resolveRetryRateLimited(captured, inFlight, 'sess-1');
    expect(res).toEqual({ kind: 'in-flight' });
  });

  test('in-flight check is per-session (other ids are not blocked)', () => {
    // A turn running for sess-A must not block a retry for sess-B.
    const captured = new Map<string, { text: string; projectId: number }>([
      ['sess-B', { text: 'B prompt', projectId: 2 }],
    ]);
    const inFlight = { has: (id: string) => id === 'sess-A' };
    const res = resolveRetryRateLimited(captured, inFlight, 'sess-B');
    expect(res).toEqual({ kind: 'ok', text: 'B prompt', projectId: 2 });
  });

  test('empty cache + empty in-flight short-circuits to no-held-prompt', () => {
    const res = resolveRetryRateLimited(new Map(), { has: () => false }, 'sess-x');
    expect(res).toEqual({ kind: 'no-held-prompt' });
  });
});

describe('recovery_log row contract for rate-limit retry (BE-D8 / spec §8.5)', () => {
  // Each test gets its own DB so the asserts are independent.
  let tmpRoot: string;
  let originalDataDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-rl-retry-log-'));
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

  // The dispatch site's appendRecoveryLog call is straight-line:
  //
  //   appendRecoveryLog({
  //     sessionId: msg.sessionId,
  //     failureClass: 'rate_limit',
  //     operatorAction: msg.auto ? 'auto_retry' : 'manual_retry',
  //   });
  //
  // Replay it here with both auto values to confirm the contract.

  test('manual retry (auto omitted) → operatorAction=manual_retry', () => {
    appendRecoveryLog({
      sessionId: 'sess-1',
      failureClass: 'rate_limit' satisfies FailureClass,
      operatorAction: 'manual_retry' satisfies OperatorAction,
    });
    const rows = listForSession('sess-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: 'sess-1',
      failure_class: 'rate_limit',
      operator_action: 'manual_retry',
    });
  });

  test('auto retry (auto: true on the wire) → operatorAction=auto_retry', () => {
    appendRecoveryLog({
      sessionId: 'sess-2',
      failureClass: 'rate_limit' satisfies FailureClass,
      operatorAction: 'auto_retry' satisfies OperatorAction,
    });
    const rows = listForSession('sess-2');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.failure_class).toBe('rate_limit');
    expect(rows[0]!.operator_action).toBe('auto_retry');
  });

  test('multiple retries on the same session accumulate (ordered by ts)', () => {
    // The spec §8.5 query for "rate-limit retry effectiveness over
    // time" filters by failure_class + ts; per-attempt rows must each
    // land so the histogram is right.
    appendRecoveryLog({
      sessionId: 'sess-3',
      failureClass: 'rate_limit',
      operatorAction: 'auto_retry',
      tsOverride: 1000,
    });
    appendRecoveryLog({
      sessionId: 'sess-3',
      failureClass: 'rate_limit',
      operatorAction: 'auto_retry',
      tsOverride: 2000,
    });
    appendRecoveryLog({
      sessionId: 'sess-3',
      failureClass: 'rate_limit',
      operatorAction: 'manual_retry',
      tsOverride: 3000,
    });
    const rows = listForSession('sess-3');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.operator_action)).toEqual([
      'auto_retry',
      'auto_retry',
      'manual_retry',
    ]);
    expect(rows.map((r) => r.ts)).toEqual([1000, 2000, 3000]);
  });
});
