// `Cebab-vie.29`: the operator's approval of a halted dangerous command is the
// one human decision in the whole bus, and it wrote nothing to the hash chain.
//
// Mirrors `execute_mode_grant.test.ts`, including its `auditRowsSince(baseline)`
// delta helper — filtering by kind would hide a SECOND, unexpected row written
// by the code under test, which is one of the things these exist to catch.
//
// These are unit tests on the module. The two CALL SITES are pinned separately
// and by source scan (`dangerous_continue_sites.test.ts`), because driving
// `continueThroughMutation` end-to-end needs a live session with a paused
// dangerous mutation and the existing chain harness mocks that method outright.
import { describe, expect, test, vi } from 'vitest';
import type { ServerMsg } from '@cebab/shared/protocol';
import { getDb } from '../db.js';
import * as safetyAudit from '../notifications/safety_audit.js';
import type { MutationRecord } from '../repo/multi_agent.js';
import { withTempDataDir } from '../test_support/temp_data_dir.js';
import { auditDangerousContinue } from './dangerous_continue_audit.js';

type AuditRow = { kind: string; reason_code: string; payload_json: string };

function auditRows(): AuditRow[] {
  return getDb()
    .prepare<[], AuditRow>(
      'SELECT kind, reason_code, payload_json FROM safety_audit ORDER BY rowid',
    )
    .all();
}
const auditRowsSince = (baseline: number) => auditRows().slice(baseline);

function held(over: Partial<MutationRecord> = {}): MutationRecord {
  return {
    id: 42,
    sessionId: 'dc-sess',
    ts: 1,
    agentName: 'coder',
    toolName: 'Bash',
    category: 'dangerous',
    summary: 'rm -rf /tmp/victim',
    filePath: null,
    cwd: '/work/coder',
    toolUseId: null,
    confirmedAt: null,
    ...(over as object),
  } as MutationRecord;
}

describe('auditDangerousContinue', () => {
  withTempDataDir('dangerous-continue-audit');

  test('records the approval as exactly one row, carrying the command', () => {
    const baseline = auditRows().length;
    const sent: ServerMsg[] = [];

    const r = auditDangerousContinue(
      { mode: 'orchestrator', sessionId: 'dc-sess', held: held() },
      (m) => sent.push(m),
    );

    expect(r).toEqual({ recorded: true });
    const rows = auditRowsSince(baseline);
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe('bus.dangerous_continue');
    expect(rows[0]!.reason_code).toBe('dangerous_continue_approved');
    // The command itself has to be IN the row. A row that says only "an
    // approval happened" cannot answer which command was approved, which is
    // the question the chain exists to answer.
    const payload = JSON.parse(rows[0]!.payload_json);
    expect(payload).toMatchObject({
      sessionId: 'dc-sess',
      mode: 'orchestrator',
      mutationId: 42,
      agentName: 'coder',
      toolName: 'Bash',
      category: 'dangerous',
      summary: 'rm -rf /tmp/victim',
    });
    expect(sent[0]).toMatchObject({ type: 'notification', class: 'safety' });
  });

  test('[security] a failing audit append refuses the approval and writes nothing', () => {
    // THE CONTRACT, and the direction that matters: if the approval cannot be
    // recorded the caller must not burn the grant. An unrecorded approval that
    // still runs the command is the exact state this bead exists to prevent.
    const baseline = auditRows().length;
    const spy = vi.spyOn(safetyAudit, 'appendSafetyAudit').mockImplementation(() => {
      throw new Error('audit chain broken');
    });
    try {
      const sent: ServerMsg[] = [];
      const r = auditDangerousContinue({ mode: 'chain', sessionId: 'dc-sess', held: held() }, (m) =>
        sent.push(m),
      );
      expect(r.recorded).toBe(false);
      expect(auditRowsSince(baseline)).toEqual([]);
      // Nothing announced either: a toast saying "approved" with no row is
      // worse than silence, for the same reason the row matters.
      expect(sent).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  test('ANTI-VACUITY: the refusal is caused by the broken append, not by the input', () => {
    // Without this, an implementation that returned `recorded: false` always
    // would pass the case above. The SAME input must succeed once the append
    // works — which the first test already shows, so this states the pairing
    // explicitly against one identical call.
    const baseline = auditRows().length;
    const input = { mode: 'chain' as const, sessionId: 'dc-sess', held: held({ id: 77 }) };

    const spy = vi.spyOn(safetyAudit, 'appendSafetyAudit').mockImplementation(() => {
      throw new Error('audit chain broken');
    });
    const refused = auditDangerousContinue(input, () => {});
    spy.mockRestore();

    const allowed = auditDangerousContinue(input, () => {});

    expect(refused.recorded).toBe(false);
    expect(allowed.recorded).toBe(true);
    expect(auditRowsSince(baseline).length).toBe(1);
  });

  test('a long agent-authored summary is capped, not stored whole', () => {
    // `summary` is the model's own description of the command. It is stored as
    // JSON and never re-injected into a prompt, so the prompt-quoting rules do
    // not apply — but it is unbounded, and an audit row is a poor place to find
    // that out.
    const baseline = auditRows().length;
    auditDangerousContinue(
      { mode: 'chain', sessionId: 'dc-sess', held: held({ summary: 'x'.repeat(5000) }) },
      () => {},
    );
    const payload = JSON.parse(auditRowsSince(baseline)[0]!.payload_json);
    expect(payload.summary.length).toBe(600);
  });
});
