import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { appendSafetyAudit } from '../notifications/safety_audit.js';
import {
  appendForensics,
  getForensicsByAuditId,
  getForensicsBySessionId,
} from './controllability_forensics.js';

// Cluster C Phase 3: controllability_forensics repository + migration 019.
// Real SQLite under a tmp data dir so the FK reference to safety_audit
// actually bites at write time.

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-forensics-repo-'));
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

function seedParentAudit(sessionId = 'sess-1', interruptAckId = 'ack-1'): string {
  return appendSafetyAudit({
    ts: 1_700_000_000_000,
    sessionId,
    kind: 'session.stopped',
    reasonCode: 'operator',
    payload: { interruptAckId, source: 'single_agent_stop' },
  }).id;
}

describe('migration 019 — schema shape', () => {
  test('controllability_forensics table exists with the expected columns', () => {
    // pragma_table_info works as a table-valued function in newer SQLite,
    // but our build doesn't expose it as a SELECT source — use the PRAGMA
    // form directly.
    type ColInfo = {
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    };
    const cols = getDb().pragma('table_info(controllability_forensics)') as ColInfo[];
    const colMap = new Map(cols.map((c) => [c.name, c]));
    // Spot-check the required columns from spec §5.5
    expect(colMap.has('id')).toBe(true);
    expect(colMap.has('safety_audit_id')).toBe(true);
    expect(colMap.get('safety_audit_id')?.notnull).toBe(1);
    expect(colMap.has('ts')).toBe(true);
    expect(colMap.has('effective_prompt_json')).toBe(true);
    expect(colMap.get('effective_prompt_json')?.notnull).toBe(1);
    expect(colMap.has('events_last_n_json')).toBe(true);
    expect(colMap.get('events_last_n_json')?.notnull).toBe(1);
    expect(colMap.has('pending_tool_calls_json')).toBe(true);
    expect(colMap.has('workdir_tree_hash')).toBe(true);
    expect(colMap.has('active_permissions_json')).toBe(true);
    expect(colMap.has('bus_inbox_outbox_json')).toBe(true);
    expect(colMap.has('mutation_rationale_json')).toBe(true);
    expect(colMap.has('snapshot_failed_reason')).toBe(true);
    // XCT-1 columns
    expect(colMap.has('operator_id')).toBe(true);
    expect(colMap.get('operator_id')?.notnull).toBe(1);
    expect(colMap.has('parent_session_id')).toBe(true);
    expect(colMap.has('agent_slug')).toBe(true);
  });

  test('migration is idempotent (re-running applyMigrations does not crash)', () => {
    // Re-open the DB → applyMigrations runs again via getDb().
    closeDb();
    expect(() => getDb()).not.toThrow();
  });

  test('the safety_audit_id and session_id indexes exist', () => {
    const idx = getDb()
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'controllability_forensics'",
      )
      .all();
    const names = new Set(idx.map((r) => r.name));
    expect(names.has('controllability_forensics_audit')).toBe(true);
    expect(names.has('controllability_forensics_session_ts')).toBe(true);
  });
});

describe('appendForensics — happy path', () => {
  test('inserts a row with operator_id from getOperatorId fallback', () => {
    const auditId = seedParentAudit();
    const { id } = appendForensics({
      safetyAuditId: auditId,
      ts: 1_700_000_001_000,
      sessionId: 'sess-1',
      effectivePrompt: { source: 'captured', text: 'hi', projectId: 1 },
      eventsLastN: [{ seq: 1, type: 'user_message' }],
    });
    expect(id).toBeGreaterThan(0);
    const row = getForensicsByAuditId(auditId);
    expect(row).toBeDefined();
    expect(row?.safety_audit_id).toBe(auditId);
    expect(row?.ts).toBe(1_700_000_001_000);
    expect(row?.session_id).toBe('sess-1');
    expect(row?.operator_id).toBeTypeOf('string'); // os.userInfo().username or 'local-user'
    expect(row?.operator_id.length).toBeGreaterThan(0);
    // JSON round-trips through SQL TEXT
    const ep = JSON.parse(row!.effective_prompt_json) as { source: string };
    expect(ep.source).toBe('captured');
    // Optional fields default to null
    expect(row?.pending_tool_calls_json).toBeNull();
    expect(row?.workdir_tree_hash).toBeNull();
    expect(row?.bus_inbox_outbox_json).toBeNull();
    expect(row?.snapshot_failed_reason).toBeNull();
  });

  test('serialises all optional JSON fields when supplied', () => {
    const auditId = seedParentAudit('sess-2', 'ack-2');
    appendForensics({
      safetyAuditId: auditId,
      ts: 1_700_000_002_000,
      sessionId: 'sess-2',
      agentSlug: null,
      effectivePrompt: { source: 'none' },
      eventsLastN: [],
      pendingToolCalls: [{ requestId: 'r1', toolName: 'Edit', toolInput: { path: '/p' } }],
      workdirTreeHash: 'a'.repeat(64),
      activePermissions: { trusted: true, permissionMode: 'acceptEdits' },
    });
    const row = getForensicsByAuditId(auditId);
    expect(row?.workdir_tree_hash).toBe('a'.repeat(64));
    const ap = JSON.parse(row!.active_permissions_json!) as { trusted: boolean };
    expect(ap.trusted).toBe(true);
    const ptc = JSON.parse(row!.pending_tool_calls_json!) as Array<{ toolName: string }>;
    expect(ptc[0]?.toolName).toBe('Edit');
  });

  test('snapshotFailedReason persists when supplied', () => {
    const auditId = seedParentAudit('sess-3', 'ack-3');
    appendForensics({
      safetyAuditId: auditId,
      ts: 1_700_000_003_000,
      sessionId: 'sess-3',
      effectivePrompt: { source: 'none' },
      eventsLastN: [],
      snapshotFailedReason: 'workdir_hash_failed: EACCES',
    });
    const row = getForensicsByAuditId(auditId);
    expect(row?.snapshot_failed_reason).toBe('workdir_hash_failed: EACCES');
  });
});

describe('appendForensics — FK enforcement', () => {
  test('insert with unknown safety_audit_id throws (FK violation)', () => {
    // applyMigrations turns foreign_keys ON; insert should reject.
    expect(() =>
      appendForensics({
        safetyAuditId: 'audit-does-not-exist',
        ts: 1_700_000_000_000,
        sessionId: 'sess-x',
        effectivePrompt: { source: 'none' },
        eventsLastN: [],
      }),
    ).toThrow();
  });
});

describe('getForensicsBySessionId — chronological queries', () => {
  test('returns rows newest first, capped to limit', () => {
    const a1 = seedParentAudit('sess-q', 'ack-q1');
    const a2 = seedParentAudit('sess-q', 'ack-q2');
    const a3 = seedParentAudit('sess-q', 'ack-q3');
    appendForensics({
      safetyAuditId: a1,
      ts: 1000,
      sessionId: 'sess-q',
      effectivePrompt: { source: 'none' },
      eventsLastN: [],
    });
    appendForensics({
      safetyAuditId: a2,
      ts: 2000,
      sessionId: 'sess-q',
      effectivePrompt: { source: 'none' },
      eventsLastN: [],
    });
    appendForensics({
      safetyAuditId: a3,
      ts: 3000,
      sessionId: 'sess-q',
      effectivePrompt: { source: 'none' },
      eventsLastN: [],
    });
    const rows = getForensicsBySessionId('sess-q', 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.ts).toBe(3000);
    expect(rows[1]?.ts).toBe(2000);
  });

  test('other sessions are excluded', () => {
    const a = seedParentAudit('sess-a', 'ack-a');
    const b = seedParentAudit('sess-b', 'ack-b');
    appendForensics({
      safetyAuditId: a,
      ts: 100,
      sessionId: 'sess-a',
      effectivePrompt: { source: 'none' },
      eventsLastN: [],
    });
    appendForensics({
      safetyAuditId: b,
      ts: 200,
      sessionId: 'sess-b',
      effectivePrompt: { source: 'none' },
      eventsLastN: [],
    });
    expect(getForensicsBySessionId('sess-a')).toHaveLength(1);
    expect(getForensicsBySessionId('sess-b')).toHaveLength(1);
  });
});
