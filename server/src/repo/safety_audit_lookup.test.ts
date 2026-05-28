import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { appendSafetyAudit } from '../notifications/safety_audit.js';
import { findStoppedAuditIdForAckId } from './safety_audit_lookup.js';

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
