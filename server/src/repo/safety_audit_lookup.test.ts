import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { appendSafetyAudit } from '../notifications/safety_audit.js';
import { findLatestControlReason, findStoppedAuditIdForAckId } from './safety_audit_lookup.js';

// Cluster C Phase 3: lookup-by-interruptAckId. Tests run against real SQLite
// so the json_extract path is exercised end-to-end.

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-audit-lookup-'));
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

describe('findStoppedAuditIdForAckId', () => {
  test('finds the matching session.stopped row by interruptAckId', () => {
    const audit = appendSafetyAudit({
      ts: 1_700_000_000_000,
      sessionId: 'sess-1',
      kind: 'session.stopped',
      reasonCode: 'operator',
      payload: { interruptAckId: 'ack-A', source: 'single_agent_stop' },
    });
    const found = findStoppedAuditIdForAckId('sess-1', 'ack-A');
    expect(found).toBe(audit.id);
  });

  test('returns undefined when no row matches (wrong ackId)', () => {
    appendSafetyAudit({
      ts: 1_700_000_000_000,
      sessionId: 'sess-1',
      kind: 'session.stopped',
      reasonCode: 'operator',
      payload: { interruptAckId: 'ack-A', source: 'single_agent_stop' },
    });
    expect(findStoppedAuditIdForAckId('sess-1', 'ack-NOPE')).toBeUndefined();
  });

  test('returns undefined when session has no session.stopped rows', () => {
    expect(findStoppedAuditIdForAckId('sess-empty', 'ack-x')).toBeUndefined();
  });

  test('scoped by sessionId: same ackId in another session does not match', () => {
    appendSafetyAudit({
      ts: 1_700_000_000_000,
      sessionId: 'sess-1',
      kind: 'session.stopped',
      reasonCode: 'operator',
      payload: { interruptAckId: 'ack-shared' },
    });
    appendSafetyAudit({
      ts: 1_700_000_001_000,
      sessionId: 'sess-2',
      kind: 'session.stopped',
      reasonCode: 'operator',
      payload: { interruptAckId: 'ack-shared' },
    });
    const fromOne = findStoppedAuditIdForAckId('sess-1', 'ack-shared');
    const fromTwo = findStoppedAuditIdForAckId('sess-2', 'ack-shared');
    expect(fromOne).toBeDefined();
    expect(fromTwo).toBeDefined();
    expect(fromOne).not.toBe(fromTwo);
  });

  test('ignores other audit kinds (e.g. stop_reason) even if payload has interruptAckId', () => {
    appendSafetyAudit({
      ts: 1_700_000_000_000,
      sessionId: 'sess-1',
      kind: 'session.stop_reason',
      reasonCode: 'incorrect_output',
      payload: { interruptAckId: 'ack-B' },
    });
    expect(findStoppedAuditIdForAckId('sess-1', 'ack-B')).toBeUndefined();
  });

  test('when two session.stopped rows share an ackId (pathological), latest wins', () => {
    // Real flow won't produce this — interruptAckIds are randomUUID-generated
    // per Stop — but the lookup must be deterministic if it ever happens.
    appendSafetyAudit({
      ts: 1000,
      sessionId: 'sess-1',
      kind: 'session.stopped',
      reasonCode: 'operator',
      payload: { interruptAckId: 'ack-dup' },
    });
    const second = appendSafetyAudit({
      ts: 2000,
      sessionId: 'sess-1',
      kind: 'session.stopped',
      reasonCode: 'operator',
      payload: { interruptAckId: 'ack-dup' },
    });
    expect(findStoppedAuditIdForAckId('sess-1', 'ack-dup')).toBe(second.id);
  });
});

// Cluster C Phase 4e: control-verb reason recovery — R-B reconstruct
// uses this to rehydrate the pause-expiry timer's reasonCode + reasonText
// that weren't persisted on the participant row.

describe('findLatestControlReason', () => {
  test('returns most recent agent_control.paused row for (sessionId, projectId)', () => {
    appendSafetyAudit({
      ts: 1_000,
      sessionId: 'sess-1',
      kind: 'agent_control.paused',
      reasonCode: 'off_task',
      payload: { projectId: 42, agentSlug: 'alpha', reasonText: 'first pause' },
    });
    appendSafetyAudit({
      ts: 2_000,
      sessionId: 'sess-1',
      kind: 'agent_control.paused',
      reasonCode: 'cost_ceiling',
      payload: { projectId: 42, agentSlug: 'alpha', reasonText: 'second pause' },
    });
    const result = findLatestControlReason('sess-1', 42, 'agent_control.paused');
    expect(result).toEqual({ reasonCode: 'cost_ceiling', reasonText: 'second pause' });
  });

  test('returns undefined when no matching row exists', () => {
    expect(findLatestControlReason('sess-x', 99, 'agent_control.paused')).toBeUndefined();
  });

  test('reasonText is undefined when payload field is null', () => {
    appendSafetyAudit({
      ts: 1_000,
      sessionId: 'sess-1',
      kind: 'agent_control.paused',
      reasonCode: 'off_task',
      payload: { projectId: 42, agentSlug: 'alpha', reasonText: null },
    });
    const result = findLatestControlReason('sess-1', 42, 'agent_control.paused');
    expect(result).toEqual({ reasonCode: 'off_task', reasonText: undefined });
  });

  test('scoped by projectId: another participant in the same session does not match', () => {
    appendSafetyAudit({
      ts: 1_000,
      sessionId: 'sess-1',
      kind: 'agent_control.paused',
      reasonCode: 'off_task',
      payload: { projectId: 42, agentSlug: 'alpha' },
    });
    appendSafetyAudit({
      ts: 2_000,
      sessionId: 'sess-1',
      kind: 'agent_control.paused',
      reasonCode: 'runaway_loop',
      payload: { projectId: 99, agentSlug: 'beta' },
    });
    expect(findLatestControlReason('sess-1', 42, 'agent_control.paused')?.reasonCode).toBe(
      'off_task',
    );
    expect(findLatestControlReason('sess-1', 99, 'agent_control.paused')?.reasonCode).toBe(
      'runaway_loop',
    );
  });

  test('kind filter: other kinds in same session do not match', () => {
    appendSafetyAudit({
      ts: 1_000,
      sessionId: 'sess-1',
      kind: 'agent_control.muted',
      reasonCode: 'runaway_loop',
      payload: { projectId: 42, agentSlug: 'alpha' },
    });
    // No paused row — should return undefined despite a muted row existing.
    expect(findLatestControlReason('sess-1', 42, 'agent_control.paused')).toBeUndefined();
    // Muted lookup finds the row.
    expect(findLatestControlReason('sess-1', 42, 'agent_control.muted')?.reasonCode).toBe(
      'runaway_loop',
    );
  });

  test('returns undefined when reason_code is corrupted to a non-enum value', () => {
    appendSafetyAudit({
      ts: 1_000,
      sessionId: 'sess-1',
      kind: 'agent_control.paused',
      // Cast through unknown to allow the corrupted value at the test layer.
      reasonCode: 'nope-not-an-enum-value' as unknown as 'off_task',
      payload: { projectId: 42, agentSlug: 'alpha' },
    });
    expect(findLatestControlReason('sess-1', 42, 'agent_control.paused')).toBeUndefined();
  });

  test('also works for agent_control.kicked rows', () => {
    appendSafetyAudit({
      ts: 1_000,
      sessionId: 'sess-1',
      kind: 'agent_control.kicked',
      reasonCode: 'topology_repair',
      payload: { projectId: 42, agentSlug: 'alpha' },
    });
    const result = findLatestControlReason('sess-1', 42, 'agent_control.kicked');
    expect(result?.reasonCode).toBe('topology_repair');
  });
});
