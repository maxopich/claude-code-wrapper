// Cebab-ws0.4: the BE-1 dual-write contract, actually checked.
//
// "Audit before the state change, and refuse the change if the audit fails" is
// stated in several places in this repo and asserted in one
// (`repo/mcp_trust.test.ts`). `set_trusted` — the closest sibling to this
// handler — has no such test at all, because its body is inline in a
// module-private switch. This file is the reason that decision was pulled into
// its own module.
import { describe, expect, test, vi } from 'vitest';
import type { ServerMsg } from '@cebab/shared/protocol';
import { getDb } from './db.js';
import * as safetyAudit from './notifications/safety_audit.js';
import { getProject, setProjectStartPermissionMode, upsertProject } from './repo/projects.js';
import { withTempDataDir } from './test_support/temp_data_dir.js';
import { applyProjectStartPermissionMode } from './project_start_mode.js';

type AuditRow = { kind: string; reason_code: string; payload_json: string };

/**
 * Every audit row in write order. `ORDER BY rowid` rather than `ts` — `ts` is
 * `Date.now()` and ties, and `id` is a random UUID, so rowid is the only key
 * that means "the order these were appended".
 *
 * Includes migration 015's genesis `audit.chain_reset` marker. Filtering it out
 * here would be convenient and wrong: an assertion that only ever looks at rows
 * matching the kind under test cannot notice this code appending a SECOND,
 * unexpected row.
 */
function auditRows(): AuditRow[] {
  return getDb()
    .prepare<[], AuditRow>(
      'SELECT kind, reason_code, payload_json FROM safety_audit ORDER BY rowid',
    )
    .all();
}

/**
 * Rows appended AFTER a baseline taken at the top of the test.
 *
 * Not `.filter(kind !== 'audit.chain_reset')`: a fresh database already holds
 * TWO of those markers (migrations 015 and 023, and the scheme invites more —
 * 015's header says any future ALTER of the table adds one). Filtering by kind
 * would drift as that count grows AND would hide a second, unexpected row
 * written by the code under test, which is the thing these assertions exist to
 * catch. A delta is immune to both.
 */
function auditRowsSince(baseline: number): AuditRow[] {
  return auditRows().slice(baseline);
}

describe('applyProjectStartPermissionMode', () => {
  withTempDataDir('project-start-mode');

  test('writes the column and one audit row naming the transition', () => {
    const id = upsertProject('psm-a', '/tmp/psm-a').id;
    const baseline = auditRows().length;
    const sent: ServerMsg[] = [];

    const r = applyProjectStartPermissionMode(id, 'default', (m) => sent.push(m));

    expect(r).toEqual({ ok: true, from: null, to: 'default' });
    expect(getProject(id)?.start_permission_mode).toBe('default');

    // Exactly one row, named in full — a second would show here rather than
    // being filtered away.
    const rows = auditRowsSince(baseline);
    expect(rows.map((r) => r.kind)).toEqual(['project.start_mode_decided']);
    expect(rows[0]!.reason_code).toBe('project_start_mode_set');
    // The FROM value is what makes the row a transition rather than a
    // snapshot — without it the log says what the setting became and never
    // what it was, which is the half a forensic reader needs.
    expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({
      projectId: id,
      from: null,
      to: 'default',
    });
  });

  test('records the previous value on a change, and null on a clear', () => {
    const id = upsertProject('psm-b', '/tmp/psm-b').id;
    const baseline = auditRows().length;
    const sink = () => {};
    applyProjectStartPermissionMode(id, 'acceptEdits', sink);
    applyProjectStartPermissionMode(id, 'default', sink);
    applyProjectStartPermissionMode(id, null, sink);

    expect(getProject(id)?.start_permission_mode).toBe(null);
    const transitions = auditRowsSince(baseline).map((r) => {
      const p = JSON.parse(r.payload_json) as { from: unknown; to: unknown };
      return [p.from, p.to];
    });
    expect(transitions).toEqual([
      [null, 'acceptEdits'],
      ['acceptEdits', 'default'],
      ['default', null],
    ]);
  });

  test('[security] a failing audit append leaves the column UNCHANGED', () => {
    // The contract. Ordering is invisible when both writes succeed — the only
    // way to see it is to break one, and this is the direction that matters:
    // a state change nobody recorded. Mirrors the shape of
    // `repo/mcp_trust.test.ts`'s BE-1 test.
    const id = upsertProject('psm-c', '/tmp/psm-c').id;
    setProjectStartPermissionMode(id, 'acceptEdits');
    const baseline = auditRows().length;

    const spy = vi.spyOn(safetyAudit, 'appendSafetyAudit').mockImplementation(() => {
      throw new Error('audit chain broken');
    });
    try {
      const sent: ServerMsg[] = [];
      const r = applyProjectStartPermissionMode(id, 'default', (m) => sent.push(m));

      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.error).toBe('audit_write_failed');
      // The operator's click did not land, and the previous choice survives
      // intact — not cleared, not half-applied.
      expect(getProject(id)?.start_permission_mode).toBe('acceptEdits');
      // Nothing was announced either: a toast saying the mode changed while
      // the column still holds the old value is worse than silence.
      expect(sent).toEqual([]);
      // …and no row landed either.
      expect(auditRowsSince(baseline)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  test('control: with the append working, the same call DOES change the column', () => {
    // Positive control for the test above. Without it, an implementation that
    // never wrote the column at all would satisfy the failure case perfectly.
    const id = upsertProject('psm-d', '/tmp/psm-d').id;
    setProjectStartPermissionMode(id, 'acceptEdits');
    applyProjectStartPermissionMode(id, 'default', () => {});
    expect(getProject(id)?.start_permission_mode).toBe('default');
  });

  test('a project that no longer exists still audits rather than throwing', () => {
    // The row can vanish between the operator opening the modal and clicking.
    // Recording an attempt against a missing project is more useful than a
    // crashed handler, and the payload carries `path: null` to say so.
    const baseline = auditRows().length;
    const sent: ServerMsg[] = [];
    const r = applyProjectStartPermissionMode(999_999, 'default', (m) => sent.push(m));
    expect(r.ok).toBe(true);
    const written = auditRowsSince(baseline);
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!.payload_json)).toMatchObject({ path: null });
  });
});
