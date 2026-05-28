import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ClientMsg } from '@cebab/shared';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { executeStopReason } from './server.js';
import { appendSafetyAudit } from '../notifications/safety_audit.js';

// Cluster C Phase 2 (spec §4.2 / §4.5): server-side coverage for
// `executeStopReason`. Tests run against a real SQLite under a tmp
// data dir so the safety_audit row write goes through the production
// hash-chain code.
//
// Coverage:
//   - happy path: matching ackId + valid reasonCode → safety_audit row
//   - 'other' reasonCode requires non-empty reasonText
//   - mismatched ackId → silently dropped (no row, no throw)
//   - missing tracked ackId → silently dropped
//   - non-'other' codes ignore reasonText
//   - testability seams (appendAudit override, now override) work

let tmpRoot: string;
let originalDataDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-stop-reason-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function stopReasonMsg(overrides: Partial<Extract<ClientMsg, { type: 'stop_reason' }>> = {}): Extract<
  ClientMsg,
  { type: 'stop_reason' }
> {
  return {
    type: 'stop_reason',
    sessionId: 'sess-1',
    interruptAckId: 'ack-1',
    reasonCode: 'incorrect_output',
    ...overrides,
  };
}

function countAuditRowsByKind(kind: string): number {
  return (
    getDb()
      .prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM safety_audit WHERE kind = ?')
      .get(kind)?.c ?? 0
  );
}

describe('executeStopReason — happy path', () => {
  test('matching ackId writes a safety_audit row with kind=session.stop_reason', () => {
    executeStopReason({
      msg: stopReasonMsg(),
      latestAckId: 'ack-1',
    });
    const row = getDb()
      .prepare<[string], { kind: string; reason_code: string; session_id: string; payload_json: string }>(
        'SELECT kind, reason_code, session_id, payload_json FROM safety_audit WHERE kind = ?',
      )
      .get('session.stop_reason');
    expect(row).toBeDefined();
    expect(row?.kind).toBe('session.stop_reason');
    expect(row?.reason_code).toBe('incorrect_output');
    expect(row?.session_id).toBe('sess-1');
    const payload = JSON.parse(row!.payload_json) as {
      interruptAckId: string;
      reasonText: string | null;
    };
    expect(payload.interruptAckId).toBe('ack-1');
    expect(payload.reasonText).toBeNull();
  });

  test("reasonCode='other' with non-empty reasonText writes the row", () => {
    executeStopReason({
      msg: stopReasonMsg({ reasonCode: 'other', reasonText: 'too verbose' }),
      latestAckId: 'ack-1',
    });
    const row = getDb()
      .prepare<[string], { reason_code: string; payload_json: string }>(
        'SELECT reason_code, payload_json FROM safety_audit WHERE kind = ?',
      )
      .get('session.stop_reason');
    expect(row?.reason_code).toBe('other');
    const payload = JSON.parse(row!.payload_json) as { reasonText: string };
    expect(payload.reasonText).toBe('too verbose');
  });

  test('non-other codes ignore reasonText silently (still write the row)', () => {
    // Operator could supply free text on any code; we don't reject — just
    // store it. The eval pipeline can use it as a tag if present.
    executeStopReason({
      msg: stopReasonMsg({ reasonCode: 'runaway_loop', reasonText: 'hot loop' }),
      latestAckId: 'ack-1',
    });
    const row = getDb()
      .prepare<[string], { payload_json: string }>(
        'SELECT payload_json FROM safety_audit WHERE kind = ?',
      )
      .get('session.stop_reason');
    const payload = JSON.parse(row!.payload_json) as { reasonText: string };
    expect(payload.reasonText).toBe('hot loop');
  });
});

describe('executeStopReason — validation drops', () => {
  test('mismatched ackId silently drops (no row)', () => {
    executeStopReason({
      msg: stopReasonMsg({ interruptAckId: 'ack-stale' }),
      latestAckId: 'ack-fresh',
    });
    expect(countAuditRowsByKind('session.stop_reason')).toBe(0);
    expect(logSpy).toHaveBeenCalled();
  });

  test('missing tracked ackId (no Stop ever happened) drops', () => {
    executeStopReason({
      msg: stopReasonMsg(),
      latestAckId: undefined,
    });
    expect(countAuditRowsByKind('session.stop_reason')).toBe(0);
    expect(logSpy).toHaveBeenCalled();
  });

  test("reasonCode='other' WITHOUT reasonText drops", () => {
    executeStopReason({
      msg: stopReasonMsg({ reasonCode: 'other', reasonText: undefined }),
      latestAckId: 'ack-1',
    });
    expect(countAuditRowsByKind('session.stop_reason')).toBe(0);
    expect(logSpy).toHaveBeenCalled();
  });

  test("reasonCode='other' with whitespace-only text drops", () => {
    executeStopReason({
      msg: stopReasonMsg({ reasonCode: 'other', reasonText: '   ' }),
      latestAckId: 'ack-1',
    });
    expect(countAuditRowsByKind('session.stop_reason')).toBe(0);
    expect(logSpy).toHaveBeenCalled();
  });
});

describe('executeStopReason — testability seams', () => {
  test('appendAudit seam intercepts the write', () => {
    const appendAudit = vi.fn(() => ({ id: 'fake', hash_self: Buffer.alloc(32) }));
    executeStopReason({
      msg: stopReasonMsg({ reasonCode: 'off_task' }),
      latestAckId: 'ack-1',
      appendAudit,
    });
    expect(appendAudit).toHaveBeenCalledTimes(1);
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'session.stop_reason',
        reasonCode: 'off_task',
        sessionId: 'sess-1',
      }),
    );
    // The seam intercepted, so the real DB write didn't happen.
    expect(countAuditRowsByKind('session.stop_reason')).toBe(0);
  });

  test('now seam controls the ts on the audit row', () => {
    const appendAudit = vi.fn(() => ({ id: 'x', hash_self: Buffer.alloc(32) }));
    executeStopReason({
      msg: stopReasonMsg(),
      latestAckId: 'ack-1',
      appendAudit,
      now: () => 1_700_000_000_000,
    });
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ ts: 1_700_000_000_000 }),
    );
  });

  test('audit append throw is swallowed (no crash)', () => {
    const appendAudit = vi.fn(() => {
      throw new Error('disk full');
    });
    expect(() =>
      executeStopReason({
        msg: stopReasonMsg(),
        latestAckId: 'ack-1',
        appendAudit,
      }),
    ).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('executeStopReason — parent session.stopped join (C3)', () => {
  test('embeds parentAuditId in payload when lookup succeeds', () => {
    const appendAudit = vi.fn<typeof import('../notifications/safety_audit.js').appendSafetyAudit>(
      () => ({ id: 'reason-row', hash_self: Buffer.alloc(32) }),
    );
    const lookupParentAuditId = vi.fn(() => 'parent-audit-7');
    executeStopReason({
      msg: stopReasonMsg(),
      latestAckId: 'ack-1',
      appendAudit,
      lookupParentAuditId,
    });
    expect(lookupParentAuditId).toHaveBeenCalledWith('sess-1', 'ack-1');
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'session.stop_reason',
        payload: expect.objectContaining({
          interruptAckId: 'ack-1',
          parentAuditId: 'parent-audit-7',
        }),
      }),
    );
  });

  test('parentAuditId is null in payload when lookup returns undefined', () => {
    const appendAudit = vi.fn<typeof import('../notifications/safety_audit.js').appendSafetyAudit>(
      () => ({ id: 'reason-row', hash_self: Buffer.alloc(32) }),
    );
    const lookupParentAuditId = vi.fn(() => undefined);
    executeStopReason({
      msg: stopReasonMsg(),
      latestAckId: 'ack-1',
      appendAudit,
      lookupParentAuditId,
    });
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ parentAuditId: null }),
      }),
    );
  });

  test('default lookup hits the real DB and resolves the parent across both rows', () => {
    // No seam overrides: write the parent session.stopped row through the
    // production append API so the hash chain stays valid, then call
    // executeStopReason and assert the resulting stop_reason row carries
    // the parentAuditId pointer it discovered via the JSON-extract lookup.
    const parent = appendSafetyAudit({
      ts: 1_700_000_000_000,
      sessionId: 'sess-1',
      kind: 'session.stopped',
      reasonCode: 'operator',
      payload: { interruptAckId: 'ack-1', source: 'single_agent_stop' },
    });
    executeStopReason({
      msg: stopReasonMsg({ reasonCode: 'runaway_loop' }),
      latestAckId: 'ack-1',
    });
    const row = getDb()
      .prepare<[string], { payload_json: string }>(
        "SELECT payload_json FROM safety_audit WHERE kind = 'session.stop_reason' AND session_id = ?",
      )
      .get('sess-1');
    const payload = JSON.parse(row!.payload_json) as { parentAuditId: string | null };
    expect(payload.parentAuditId).toBe(parent.id);
  });
});
