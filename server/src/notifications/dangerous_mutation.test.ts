import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ServerMsg, NotificationEnvelope } from '@cebab/shared/protocol';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { maybeDispatchDangerousMutation } from './dangerous_mutation.js';
import { _resetCoalesceState } from './dispatcher.js';
import type { MutationRecord } from '../repo/multi_agent.js';

// Cluster A Phase 4 (UI-15 / spec §3): a `dangerous`-category
// `multi_agent_mutation` MUST fan a sticky safety notification with an
// "Open in logs" deep-link. Pins:
//   - BE-1: safety class writes the audit row BEFORE the envelope ships;
//     audit-write failure → ok:false, no send.
//   - BE-2: safety NEVER coalesces at the recording layer — a burst of
//     N dangerous mutations produces N audit rows + N envelopes.
//   - NR-2: this is ADDITIVE — only the toast layer; the LogsButton chip
//     is unchanged (not part of this test, but enforced by leaving the
//     mutation event ship path alone).

const SID = 'dang-mut-session';

let tmpRoot: string;
let originalDataDir: string;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-dang-mut-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
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
    toolName: 'Bash',
    category: 'dangerous',
    summary: 'rm -rf /tmp/risky',
    filePath: null,
    cwd: '/workspace/coder',
    toolUseId: 'tu-1',
    confirmedAt: null,
    promoted: 0,
    artifactPath: null,
    ...overrides,
  } as MutationRecord;
}

function selectAuditRows(): Array<{ kind: string; reason_code: string }> {
  return getDb()
    .prepare(
      `SELECT kind, reason_code FROM safety_audit
       WHERE kind != 'audit.chain_reset' ORDER BY ts ASC, id ASC`,
    )
    .all() as Array<{ kind: string; reason_code: string }>;
}

describe('[security][BE-1] dangerous-mutation safety toast — audit row before envelope', () => {
  test('dangerous mutation writes safety_audit + ships notification with open_logs action', () => {
    const sent: ServerMsg[] = [];
    const result = maybeDispatchDangerousMutation(SID, makeMutation(), (m) => sent.push(m));

    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);

    const rows = selectAuditRows();
    expect(rows).toEqual([{ kind: 'mutation.dangerous', reason_code: 'classifier_dangerous' }]);

    expect(sent).toHaveLength(1);
    const env = sent[0] as NotificationEnvelope & { type: 'notification' };
    expect(env).toMatchObject({
      type: 'notification',
      class: 'safety',
      severity: 'danger',
      reasonCode: 'classifier_dangerous',
      sessionId: SID,
      sticky: true,
      dedupeKey: `dangerous_mutation:${SID}:42`,
      action: { kind: 'open_logs', sessionId: SID, rowAnchor: 'mutation:42' },
    });
  });

  test('mutate-category mutation is a no-op (returns null, no send, no audit)', () => {
    const sent: ServerMsg[] = [];
    const result = maybeDispatchDangerousMutation(SID, makeMutation({ category: 'mutate' }), (m) =>
      sent.push(m),
    );
    expect(result).toBeNull();
    expect(sent).toHaveLength(0);
    expect(selectAuditRows()).toEqual([]);
  });
});

describe('[security][BE-2] dangerous-mutation burst is NEVER coalesced at recording', () => {
  test('20 dangerous mutations → 20 audit rows + 20 envelopes (distinct ids)', () => {
    const sent: ServerMsg[] = [];
    for (let i = 0; i < 20; i++) {
      maybeDispatchDangerousMutation(SID, makeMutation({ id: i }), (m) => sent.push(m));
    }
    expect(selectAuditRows()).toHaveLength(20);
    expect(sent).toHaveLength(20);
    // Per-row dedupeKey: each envelope has its own key (the UI may fold
    // for display via the row id, but the wire layer never does).
    const dedupeKeys = new Set(
      sent.map((m) => (m as NotificationEnvelope & { type: 'notification' }).dedupeKey),
    );
    expect(dedupeKeys.size).toBe(20);
  });
});
