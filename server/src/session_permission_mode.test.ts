// `Cebab-6fax.40`: the per-session permission pill was the one
// privilege-widening act in Cebab that wrote no audit row.
//
// The same dual-write contract `project_start_mode.test.ts` checks for the
// project-scoped setting, applied to the session-scoped one — and this is the
// sharper of the two, because it flips the posture of a process that is
// already running, mid-turn, on a project the operator may never have trusted.
import { describe, expect, test, vi } from 'vitest';
import type { ServerMsg } from '@cebab/shared/protocol';
import { getDb } from './db.js';
import * as safetyAudit from './notifications/safety_audit.js';
import { upsertProject } from './repo/projects.js';
import { createSession, getSession, setSessionPermissionMode } from './repo/sessions.js';
import { withTempDataDir } from './test_support/temp_data_dir.js';
import { applySessionPermissionMode } from './session_permission_mode.js';

type AuditRow = { kind: string; reason_code: string; payload_json: string };

/** Every audit row in write order, including the migrations' genesis markers —
 *  see `project_start_mode.test.ts` for why they are not filtered out. */
function auditRows(): AuditRow[] {
  return getDb()
    .prepare<[], AuditRow>(
      'SELECT kind, reason_code, payload_json FROM safety_audit ORDER BY rowid',
    )
    .all();
}

function auditRowsSince(baseline: number): AuditRow[] {
  return auditRows().slice(baseline);
}

function seed(name: string): { projectId: number; sessionId: string } {
  const projectId = upsertProject(name, `/tmp/${name}`).id;
  const sessionId = `sess-${name}`;
  createSession(sessionId, projectId);
  return { projectId, sessionId };
}

describe('applySessionPermissionMode', () => {
  withTempDataDir('session-permission-mode');

  test('writes the column and one audit row naming the transition', () => {
    const { projectId, sessionId } = seed('spm-a');
    const baseline = auditRows().length;
    const sent: ServerMsg[] = [];

    const r = applySessionPermissionMode({
      sessionId,
      projectId,
      from: 'default',
      to: 'acceptEdits',
      send: (m) => sent.push(m),
    });

    expect(r).toEqual({ ok: true });
    expect(getSession(sessionId)?.permission_mode).toBe('acceptEdits');

    const rows = auditRowsSince(baseline);
    expect(rows.map((r) => r.kind)).toEqual(['session.permission_mode_decided']);
    expect(rows[0]!.reason_code).toBe('session_mode_widened');
    // FROM as well as TO: without it the log says what the posture became and
    // never what it was, so a reader cannot tell how long the wider one was
    // live — which is the question this row exists to answer.
    expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({
      sessionId,
      projectId,
      from: 'default',
      to: 'acceptEdits',
    });
  });

  test('the narrowing direction is recorded too, with its own reason code', () => {
    // Both edges or neither. A chain that logged only the widening would show
    // a session entering auto-allow and never leaving it.
    const { projectId, sessionId } = seed('spm-b');
    setSessionPermissionMode(sessionId, 'acceptEdits');
    const baseline = auditRows().length;

    applySessionPermissionMode({
      sessionId,
      projectId,
      from: 'acceptEdits',
      to: 'default',
      send: () => {},
    });

    const rows = auditRowsSince(baseline);
    expect(rows.map((r) => r.reason_code)).toEqual(['session_mode_narrowed']);
    expect(getSession(sessionId)?.permission_mode).toBe('default');
  });

  test('[security] a failing audit append leaves the column UNCHANGED', () => {
    // The contract. Ordering is invisible when both writes succeed; the only
    // way to see it is to break one, and this is the direction that matters —
    // a widened posture nobody recorded.
    const { projectId, sessionId } = seed('spm-c');
    setSessionPermissionMode(sessionId, 'default');
    const baseline = auditRows().length;

    const spy = vi.spyOn(safetyAudit, 'appendSafetyAudit').mockImplementation(() => {
      throw new Error('audit chain broken');
    });
    try {
      const sent: ServerMsg[] = [];
      const r = applySessionPermissionMode({
        sessionId,
        projectId,
        from: 'default',
        to: 'acceptEdits',
        send: (m) => sent.push(m),
      });

      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.error).toBe('audit_write_failed');
      expect(getSession(sessionId)?.permission_mode).toBe('default');
      // Nothing announced either — a toast saying the session went auto-allow
      // while the column still says ask-first is worse than silence.
      expect(sent).toEqual([]);
      expect(auditRowsSince(baseline)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  test('control: with the append working, the same call DOES change the column', () => {
    // Without this, an implementation that never wrote the column would
    // satisfy the failure case perfectly.
    const { projectId, sessionId } = seed('spm-d');
    setSessionPermissionMode(sessionId, 'default');
    applySessionPermissionMode({
      sessionId,
      projectId,
      from: 'default',
      to: 'acceptEdits',
      send: () => {},
    });
    expect(getSession(sessionId)?.permission_mode).toBe('acceptEdits');
  });
});
