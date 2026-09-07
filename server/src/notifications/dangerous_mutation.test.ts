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

// Cebab-ygu.46: the toast title separates the two axes the model already
// tracks — WHAT the tool does vs HOW CONFIDENT the classifier is. A command
// held by the shell-/process-substitution rules is `dangerous` because it
// could not be ANALYSED, not because anything was observed to mutate. The DB
// category, audit row, dedupeKey and pause behaviour are unchanged; only the
// operator-facing copy is corrected.
describe('[security] dangerous-mutation toast title (Cebab-ygu.46)', () => {
  function titleOf(mutation: MutationRecord): string {
    const sent: ServerMsg[] = [];
    maybeDispatchDangerousMutation(SID, mutation, (m) => sent.push(m));
    const env = sent[0] as NotificationEnvelope & { type: 'notification' };
    return env.title;
  }

  test("shell-substitution rule → 'Unanalyzable command observed', not 'mutation'", () => {
    const title = titleOf(
      makeMutation({
        summary: 'wc -l $(find /subject/src -type f)',
        classifierReason: {
          rule: 'shell_substitution',
          detail: 'command contains shell-substitution',
          matched: '$(',
        },
      }),
    );
    expect(title).toBe('Unanalyzable command observed');
    expect(title).not.toMatch(/mutation/i);
  });

  test("process-substitution rule → 'Unanalyzable command observed'", () => {
    const title = titleOf(
      makeMutation({
        classifierReason: { rule: 'process_substitution', detail: 'proc-sub', matched: '<(' },
      }),
    );
    expect(title).toBe('Unanalyzable command observed');
  });

  test("a genuinely-destructive rule keeps 'Dangerous command observed'", () => {
    const title = titleOf(
      makeMutation({
        summary: 'rm -rf /tmp/risky',
        classifierReason: {
          rule: 'dangerous_first_token',
          detail: "first token 'rm' is always dangerous",
          matched: 'rm',
        },
      }),
    );
    expect(title).toBe('Dangerous command observed');
  });

  test("null reason (pre-022 row) → 'Dangerous command observed' — absence makes no new claim", () => {
    expect(titleOf(makeMutation({ classifierReason: null }))).toBe('Dangerous command observed');
  });

  test("no surface reads 'Dangerous mutation observed' any more", () => {
    expect(titleOf(makeMutation())).not.toBe('Dangerous mutation observed');
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
