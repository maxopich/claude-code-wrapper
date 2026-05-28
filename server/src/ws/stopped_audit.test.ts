import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { captureSingleAgentForensics } from '../notifications/forensic_snapshot.js';
import { getForensicsByAuditId } from '../repo/controllability_forensics.js';
import {
  buildSingleAgentForensicsInput,
  executeInterrupt,
  executeStoppedAudit,
  type PendingPermission,
} from './server.js';

// Cluster C Phase 3: integration tests for the Stop forensic-bundle path.
// - executeStoppedAudit: writes session.stopped row + forensics row in
//   the correct order; tolerates a forensics-write failure.
// - executeInterrupt with onStop: onStop runs BEFORE emitAck (spec
//   invariant 2 — audit row lands before wire envelope).
// - buildSingleAgentForensicsInput: returns undefined when session/project
//   resolves fail; otherwise hands a populated bundle to the capture.

let tmpRoot: string;
let originalDataDir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-stopped-audit-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeMinimalCapture() {
  return captureSingleAgentForensics({
    sessionId: 'sess-1',
    recentEvents: [],
    pendingPermissions: [],
    capturedPrompt: undefined,
    activePermissions: { trusted: false, permissionMode: null },
    projectCwd: undefined,
    now: () => 1_700_000_000_000,
  });
}

describe('executeStoppedAudit — happy path', () => {
  test('writes session.stopped audit row with interruptAckId in payload', () => {
    const { auditId } = executeStoppedAudit({
      sessionId: 'sess-1',
      interruptAckId: 'ack-1',
      capture: makeMinimalCapture(),
      now: () => 1_700_000_000_001,
    });
    expect(auditId).toBeDefined();
    const row = getDb()
      .prepare<
        [string],
        { kind: string; reason_code: string; payload_json: string; ts: number; session_id: string }
      >('SELECT kind, reason_code, payload_json, ts, session_id FROM safety_audit WHERE id = ?')
      .get(auditId);
    expect(row).toBeDefined();
    expect(row?.kind).toBe('session.stopped');
    expect(row?.reason_code).toBe('operator');
    expect(row?.session_id).toBe('sess-1');
    expect(row?.ts).toBe(1_700_000_000_001);
    const payload = JSON.parse(row!.payload_json) as { interruptAckId: string; source: string };
    expect(payload.interruptAckId).toBe('ack-1');
    expect(payload.source).toBe('single_agent_stop');
  });

  test('writes controllability_forensics row keyed to the audit id', () => {
    const { auditId, forensicsPersisted } = executeStoppedAudit({
      sessionId: 'sess-1',
      interruptAckId: 'ack-1',
      capture: makeMinimalCapture(),
    });
    expect(forensicsPersisted).toBe(true);
    const fr = getForensicsByAuditId(auditId);
    expect(fr).toBeDefined();
    expect(fr?.safety_audit_id).toBe(auditId);
    expect(fr?.session_id).toBe('sess-1');
    expect(fr?.agent_slug).toBeNull();
  });
});

describe('executeStoppedAudit — partial-failure semantics', () => {
  test('audit append throw bubbles (caller must catch)', () => {
    const appendAudit = vi.fn(() => {
      throw new Error('disk full');
    });
    expect(() =>
      executeStoppedAudit({
        sessionId: 'sess-1',
        interruptAckId: 'ack-1',
        capture: makeMinimalCapture(),
        appendAudit,
      }),
    ).toThrow('disk full');
  });

  test('forensics insert throw is swallowed; audit row stays + forensicsPersisted=false', () => {
    const appendForensicsRow = vi.fn(() => {
      throw new Error('forensics table missing');
    });
    const result = executeStoppedAudit({
      sessionId: 'sess-1',
      interruptAckId: 'ack-1',
      capture: makeMinimalCapture(),
      appendForensicsRow,
    });
    expect(result.forensicsPersisted).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    // Audit row still landed even though forensics failed.
    const auditRow = getDb()
      .prepare<[string], { kind: string }>('SELECT kind FROM safety_audit WHERE id = ?')
      .get(result.auditId);
    expect(auditRow?.kind).toBe('session.stopped');
  });
});

describe('executeInterrupt with onStop — ordering invariant', () => {
  test('onStop fires BEFORE emitAck (audit row precedes wire envelope)', async () => {
    const order: string[] = [];
    const onStop = vi.fn(() => {
      order.push('onStop');
    });
    const send = vi.fn(() => {
      order.push('emitAck');
    });
    let resolveInterrupt = (): void => undefined;
    const interruptPromise = new Promise<void>((res) => {
      resolveInterrupt = res;
    });
    const inFlight = {
      runner: { interrupt: () => interruptPromise },
      ac: new AbortController(),
    };
    executeInterrupt({
      inFlight,
      sessionId: 'sess-1',
      send,
      onStop,
      generateAckId: () => 'fixed-ack',
    });
    // onStop is synchronous, so it must have fired by now.
    expect(order).toEqual(['onStop']);
    // Resolve the runner cancel → emitAck fires next.
    resolveInterrupt();
    await interruptPromise;
    // Microtask flush so the .then(emitAck) runs
    await Promise.resolve();
    expect(order).toEqual(['onStop', 'emitAck']);
    expect(onStop).toHaveBeenCalledWith('sess-1', 'fixed-ack');
  });

  test('onStop throw is swallowed; emitAck still fires', async () => {
    const send = vi.fn();
    const onStop = vi.fn(() => {
      throw new Error('audit write failed');
    });
    const inFlight = {
      runner: { interrupt: () => Promise.resolve() },
      ac: new AbortController(),
    };
    executeInterrupt({
      inFlight,
      sessionId: 'sess-1',
      send,
      onStop,
      generateAckId: () => 'fixed-ack',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session_interrupted',
        sessionId: 'sess-1',
        interruptAckId: 'fixed-ack',
      }),
    );
    expect(warnSpy).toHaveBeenCalled();
  });

  test('no onStop → existing single-agent path unchanged (no audit, just emit)', async () => {
    const send = vi.fn();
    const inFlight = {
      runner: { interrupt: () => Promise.resolve() },
      ac: new AbortController(),
    };
    executeInterrupt({
      inFlight,
      sessionId: 'sess-1',
      send,
      generateAckId: () => 'fixed-ack',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    // No audit row was written (no onStop)
    const cnt = getDb()
      .prepare<[], { c: number }>(
        "SELECT COUNT(*) AS c FROM safety_audit WHERE kind = 'session.stopped'",
      )
      .get();
    expect(cnt?.c).toBe(0);
  });
});

describe('buildSingleAgentForensicsInput — orchestration seam', () => {
  test('happy path: assembles bundle from injected fetchers', () => {
    const pending: Map<string, PendingPermission> = new Map();
    pending.set('req-1', {
      sessionId: 'sess-1',
      resolve: () => undefined,
      toolInput: { file: '/x' },
      toolName: 'Edit',
    });
    pending.set('req-other', {
      sessionId: 'sess-OTHER',
      resolve: () => undefined,
      toolInput: {},
      toolName: 'Bash',
    });
    const capturedPrompts = new Map([['sess-1', { text: 'held', projectId: 7 }]]);
    const result = buildSingleAgentForensicsInput({
      sessionId: 'sess-1',
      pendingPermissions: pending,
      capturedPrompts,
      fetchSession: () => ({ project_id: 7 }),
      fetchProject: () => ({ path: tmpRoot, trusted: 1 }),
      fetchEventsTail: () => [
        { id: 1, session_id: 'sess-1', seq: 1, ts: 1, type: 'user_message', subtype: null, raw: '{"text":"x"}' },
      ],
      fetchPermissionMode: () => 'acceptEdits',
      now: () => 1_700_000_000_001,
    });
    expect(result).toBeDefined();
    expect(result?.sessionId).toBe('sess-1');
    expect(result?.effectivePrompt).toEqual({
      source: 'captured',
      text: 'held',
      projectId: 7,
    });
    // Only sess-1's pending permission flows through (sess-OTHER filtered)
    expect(result?.pendingToolCalls).toEqual([
      { requestId: 'req-1', toolName: 'Edit', toolInput: { file: '/x' } },
    ]);
    expect(result?.activePermissions).toEqual({
      trusted: true,
      permissionMode: 'acceptEdits',
    });
    // tmpRoot exists → hash computed
    expect(result?.workdirTreeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('unknown session → undefined (caller short-circuits)', () => {
    const result = buildSingleAgentForensicsInput({
      sessionId: 'sess-missing',
      pendingPermissions: new Map(),
      capturedPrompts: new Map(),
      fetchSession: () => undefined,
    });
    expect(result).toBeUndefined();
  });

  test('unknown project (session known but project gone) → undefined', () => {
    const result = buildSingleAgentForensicsInput({
      sessionId: 'sess-1',
      pendingPermissions: new Map(),
      capturedPrompts: new Map(),
      fetchSession: () => ({ project_id: 99 }),
      fetchProject: () => undefined,
    });
    expect(result).toBeUndefined();
  });

  test('trusted=0 maps to false; null permission mode passes through', () => {
    const result = buildSingleAgentForensicsInput({
      sessionId: 'sess-1',
      pendingPermissions: new Map(),
      capturedPrompts: new Map(),
      fetchSession: () => ({ project_id: 1 }),
      fetchProject: () => ({ path: tmpRoot, trusted: 0 }),
      fetchEventsTail: () => [],
      fetchPermissionMode: () => null,
    });
    expect(result?.activePermissions).toEqual({ trusted: false, permissionMode: null });
  });
});
