import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ServerMsg } from '@cebab/shared';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { appendSafetyAudit } from '../notifications/safety_audit.js';
import { appendForensics } from '../repo/controllability_forensics.js';
import { executeKickForensicsSnapshot } from './server.js';

// Cluster C Phase 4g4: server-side coverage for `get_kick_forensics`.
// Exercises `executeKickForensicsSnapshot` directly against a real SQLite
// (same testability pattern as `executeRecoveryLogSnapshot`).
//
// Coverage:
//   - no row → `found: false`, no snapshot
//   - happy path with parsed JSON columns
//   - kick provenance joined from companion safety_audit row
//   - malformed JSON in optional columns degrades gracefully
//   - snapshotFailedReason surfaces verbatim

let tmpRoot: string;
let originalDataDir: string;
let sent: ServerMsg[];

function captureSend(msg: ServerMsg): void {
  sent.push(msg);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-kick-forensics-snapshot-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb(); // runs all migrations including 019
  sent = [];
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function seedKickAudit(opts: {
  sessionId: string;
  agentSlug: string;
  reasonCode: string;
  reasonText?: string;
  mode?: string;
  ts?: number;
}): string {
  return appendSafetyAudit({
    ts: opts.ts ?? 1_700_000_000_000,
    sessionId: opts.sessionId,
    agentId: opts.agentSlug,
    kind: 'agent_control.kicked',
    reasonCode: opts.reasonCode,
    payload: {
      projectId: 42,
      agentSlug: opts.agentSlug,
      reasonText: opts.reasonText ?? null,
      mode: opts.mode ?? 'drain',
      kickedAt: opts.ts ?? 1_700_000_000_000,
    },
  }).id;
}

describe('executeKickForensicsSnapshot — no row', () => {
  test('returns found:false envelope when no bundle exists', () => {
    executeKickForensicsSnapshot({
      sessionId: 'sess-empty',
      agentSlug: 'worker-a',
      send: captureSend,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'kick_forensics_snapshot',
      sessionId: 'sess-empty',
      agentSlug: 'worker-a',
      found: false,
      snapshot: null,
    });
  });
});

describe('executeKickForensicsSnapshot — happy path', () => {
  test('found:true with parsed bundle + joined kick provenance', () => {
    const auditId = seedKickAudit({
      sessionId: 'sess-1',
      agentSlug: 'worker-a',
      reasonCode: 'tool_misuse',
      reasonText: 'leaked credential',
    });
    appendForensics({
      safetyAuditId: auditId,
      ts: 1_700_000_001_000,
      sessionId: 'sess-1',
      agentSlug: 'worker-a',
      effectivePrompt: { kind: 'last-bus-inbox', source: 'orchestrator', text: 'check it' },
      eventsLastN: [],
      busInboxOutbox: [
        {
          id: 7,
          ts: 1_700_000_000_500,
          source: 'orchestrator',
          destination: 'worker-a',
          kind: 'prompt',
          textPreview: 'check it',
        },
      ],
      mutationRationale: {
        recentMutations: [
          {
            id: 99,
            ts: 1_700_000_000_700,
            toolName: 'Bash',
            category: 'dangerous',
            summary: 'rm -rf /tmp/foo',
            filePath: null,
            confirmed: false,
          },
        ],
        totalMutations: 1,
      },
      workdirTreeHash: 'sha256:abc',
    });

    executeKickForensicsSnapshot({
      sessionId: 'sess-1',
      agentSlug: 'worker-a',
      send: captureSend,
    });

    expect(sent).toHaveLength(1);
    const msg = sent[0];
    expect(msg.type).toBe('kick_forensics_snapshot');
    if (msg.type !== 'kick_forensics_snapshot') return;
    expect(msg.found).toBe(true);
    expect(msg.snapshot).not.toBeNull();
    const snap = msg.snapshot!;
    expect(snap.auditId).toBe(auditId);
    expect(snap.kickReasonCode).toBe('tool_misuse');
    expect(snap.kickReasonText).toBe('leaked credential');
    expect(snap.kickMode).toBe('drain');
    expect(snap.workdirTreeHash).toBe('sha256:abc');
    expect(snap.busEvents).toHaveLength(1);
    expect(snap.busEvents[0]).toMatchObject({
      source: 'orchestrator',
      destination: 'worker-a',
      kind: 'prompt',
    });
    expect(snap.mutations).toHaveLength(1);
    expect(snap.mutations[0]).toMatchObject({
      toolName: 'Bash',
      category: 'dangerous',
      summary: 'rm -rf /tmp/foo',
      confirmed: false,
    });
  });
});

describe('executeKickForensicsSnapshot — degraded inputs', () => {
  test('null mutationRationale / busInboxOutbox become empty arrays', () => {
    const auditId = seedKickAudit({
      sessionId: 'sess-2',
      agentSlug: 'worker-x',
      reasonCode: 'topology_repair',
    });
    appendForensics({
      safetyAuditId: auditId,
      ts: 1_700_000_002_000,
      sessionId: 'sess-2',
      agentSlug: 'worker-x',
      effectivePrompt: null,
      eventsLastN: [],
      // bus and mutation fields intentionally omitted
    });
    executeKickForensicsSnapshot({
      sessionId: 'sess-2',
      agentSlug: 'worker-x',
      send: captureSend,
    });
    const msg = sent[0];
    if (msg.type !== 'kick_forensics_snapshot') return;
    expect(msg.snapshot?.busEvents).toEqual([]);
    expect(msg.snapshot?.mutations).toEqual([]);
  });

  test('snapshotFailedReason propagates to the wire', () => {
    const auditId = seedKickAudit({
      sessionId: 'sess-3',
      agentSlug: 'worker-y',
      reasonCode: 'forensics',
    });
    appendForensics({
      safetyAuditId: auditId,
      ts: 1_700_000_003_000,
      sessionId: 'sess-3',
      agentSlug: 'worker-y',
      effectivePrompt: null,
      eventsLastN: [],
      snapshotFailedReason: 'capture_threw: EACCES',
    });
    executeKickForensicsSnapshot({
      sessionId: 'sess-3',
      agentSlug: 'worker-y',
      send: captureSend,
    });
    const msg = sent[0];
    if (msg.type !== 'kick_forensics_snapshot') return;
    expect(msg.snapshot?.snapshotFailedReason).toBe('capture_threw: EACCES');
  });

  test('non-control reasonCode in audit row degrades to null kickReasonCode', () => {
    // Should never happen in practice — the executor only writes kick
    // audits with ControlReasonCode — but tests pin the isControlReasonCode
    // type-guard so a future schema drift fails loud.
    const auditId = appendSafetyAudit({
      ts: 1_700_000_004_000,
      sessionId: 'sess-4',
      agentId: 'worker-z',
      kind: 'agent_control.kicked',
      reasonCode: 'made_up_code',
      payload: { projectId: 1, mode: 'drain' },
    }).id;
    appendForensics({
      safetyAuditId: auditId,
      ts: 1_700_000_004_000,
      sessionId: 'sess-4',
      agentSlug: 'worker-z',
      effectivePrompt: null,
      eventsLastN: [],
    });
    executeKickForensicsSnapshot({
      sessionId: 'sess-4',
      agentSlug: 'worker-z',
      send: captureSend,
    });
    const msg = sent[0];
    if (msg.type !== 'kick_forensics_snapshot') return;
    expect(msg.snapshot?.kickReasonCode).toBeNull();
    expect(msg.snapshot?.kickMode).toBe('drain');
  });
});
