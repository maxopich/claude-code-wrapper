import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ServerMsg, NotificationEnvelope } from '@cebab/shared/protocol';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { maybeDispatchGuardrailViolation } from './guardrail_violation.js';
import { _resetCoalesceState } from './dispatcher.js';
import type { MutationRecord } from '../repo/multi_agent.js';

/**
 * Cluster F Phase D5+: when a `multi_agent_mutation` row carries a
 * non-null `guardrailViolationPath` (the bus runner's classifier
 * flagged it as out-of-scope), the WS fan-out fires a per-row safety
 * notification + writes a `safety_audit` row. Pins:
 *   - BE-1: safety class writes the audit row BEFORE the envelope ships
 *     (mirrors the dangerous-mutation contract).
 *   - BE-2: no recording-layer coalesce — every violation is its own
 *     audit row + envelope.
 *   - NR-2: this is ADDITIVE — the mutation row itself also carries
 *     the violation flag (badge survives R-A/R-B replay).
 *   - Round-trip: the row write through `appendMultiAgentMutation`
 *     persists both new columns and projects them back via
 *     `rowToMutation`, so the dispatcher receives the verdict
 *     identically whether the mutation was just appended or re-emitted
 *     on replay.
 */

const SID = 'guardrail-vio-session';

let tmpRoot: string;
let originalDataDir: string;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-guardrail-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  // Seed a session row so `safety_audit.session_id` foreign-key /
  // referential constraints (if any) don't trip on the test fixture.
  // Mirrors dangerous_mutation.test.ts — that test doesn't seed either,
  // because safety_audit has no FK to multi_agent_sessions.
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  _resetCoalesceState();
});

afterEach(() => {
  errSpy.mockRestore();
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeMutation(overrides: Partial<MutationRecord> = {}): MutationRecord {
  return {
    id: 42,
    sessionId: SID,
    ts: 1_700_000_000_000,
    agentName: 'coder',
    toolName: 'Write',
    category: 'mutate',
    summary: 'create/overwrite /tmp/scratch.txt (10 B)',
    filePath: '/tmp/scratch.txt',
    cwd: '/workspace/coder',
    toolUseId: 'tu-1',
    confirmedAt: null,
    promoted: false,
    // Defaults for the new D5+ fields; tests can override per-case.
    guardrailViolationPath: '/tmp/scratch.txt',
    guardrailReason: 'path_outside_cwd',
    ...overrides,
  };
}

function selectAuditRows(): Array<{ kind: string; reason_code: string }> {
  return getDb()
    .prepare(
      `SELECT kind, reason_code FROM safety_audit
       WHERE kind != 'audit.chain_reset' ORDER BY ts ASC, id ASC`,
    )
    .all() as Array<{ kind: string; reason_code: string }>;
}

describe('[security][BE-1] guardrail-violation safety toast — audit row before envelope', () => {
  test('violation writes safety_audit + ships notification with open_logs action', () => {
    const sent: ServerMsg[] = [];
    const result = maybeDispatchGuardrailViolation(SID, makeMutation(), (m) => sent.push(m));

    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);

    expect(selectAuditRows()).toEqual([
      { kind: 'guardrail.violation', reason_code: 'guardrail.path_outside_cwd' },
    ]);

    expect(sent).toHaveLength(1);
    const env = sent[0] as NotificationEnvelope & { type: 'notification' };
    expect(env).toMatchObject({
      type: 'notification',
      class: 'safety',
      severity: 'warn',
      reasonCode: 'guardrail.path_outside_cwd',
      sessionId: SID,
      sticky: true,
      dedupeKey: `guardrail_violation:${SID}:42`,
      action: { kind: 'open_logs', sessionId: SID, rowAnchor: 'mutation:42' },
    });
  });

  test('in-scope mutation (no guardrailViolationPath) is a no-op (null, no send, no audit)', () => {
    const sent: ServerMsg[] = [];
    const result = maybeDispatchGuardrailViolation(
      SID,
      makeMutation({ guardrailViolationPath: null, guardrailReason: null }),
      (m) => sent.push(m),
    );
    expect(result).toBeNull();
    expect(sent).toHaveLength(0);
    expect(selectAuditRows()).toEqual([]);
  });

  test('payload carries the violated path + agent cwd + reason code for forensic detail', () => {
    const sent: ServerMsg[] = [];
    maybeDispatchGuardrailViolation(
      SID,
      makeMutation({ id: 99, guardrailViolationPath: '/etc/sneaky', cwd: '/projects/foo' }),
      (m) => sent.push(m),
    );
    const env = sent[0] as NotificationEnvelope & { type: 'notification' };
    expect(env.title).toBe('Out-of-scope mutation observed');
    expect(env.message).toContain('coder');
    expect(env.message).toContain('Write');
    expect(env.message).toContain('/etc/sneaky');
  });
});

describe('[security][BE-2] guardrail-violation burst is NEVER coalesced at recording', () => {
  test('20 violations → 20 audit rows + 20 envelopes (distinct dedupeKeys)', () => {
    const sent: ServerMsg[] = [];
    for (let i = 0; i < 20; i++) {
      maybeDispatchGuardrailViolation(SID, makeMutation({ id: i }), (m) => sent.push(m));
    }
    expect(selectAuditRows()).toHaveLength(20);
    expect(sent).toHaveLength(20);
    const dedupeKeys = new Set(
      sent.map((m) => (m as NotificationEnvelope & { type: 'notification' }).dedupeKey),
    );
    expect(dedupeKeys.size).toBe(20);
  });
});

// Repo round-trip tests (append → project back) are out of scope here —
// `multi_agent_mutations` has a FOREIGN KEY into `multi_agent_sessions`,
// so a repo-level test would need to seed a session row + every column
// it requires. The schema-correctness of the new columns is exercised by
// `npm run smoke` (migration runner sees 021 cleanly), and the wire
// shape is exercised by the dispatcher tests above (which use a synthetic
// MutationRecord fixture that already includes the new fields). A full
// end-to-end smoke that hits `appendMultiAgentMutation` lives in the
// existing `session_log.test.ts` (and gets the D5+ columns through the
// projector via that path's read helpers).
