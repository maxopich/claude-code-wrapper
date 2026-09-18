// Cebab-vie.21: the execute-mode grant's BE-1 dual-write, actually checked.
//
// Mirrors `project_start_mode.test.ts` — including its `auditRowsSince(baseline)`
// delta helper, so a SECOND, unexpected row is visible rather than filtered
// away. These are UNIT tests on the module: they redden by import error before
// the module exists, so the behavioural reds for the start paths live in
// `chain.test.ts` (the operator-reachable path was actually orchestrator-only,
// but the chain harness is the cheap end-to-end one) and `mock_replay.test.ts`.
import { describe, expect, test, vi } from 'vitest';
import type { ServerMsg } from '@cebab/shared/protocol';
import { getDb } from '../db.js';
import * as safetyAudit from '../notifications/safety_audit.js';
import { createMultiAgentSession, getMultiAgentSession } from '../repo/multi_agent.js';
import { withTempDataDir } from '../test_support/temp_data_dir.js';
import { applyExecuteModeGrant } from './execute_mode_grant.js';

type AuditRow = { kind: string; reason_code: string; payload_json: string };

/**
 * Every audit row in write order. Includes the migrations' genesis
 * `audit.chain_reset` markers — filtering by kind would hide a second,
 * unexpected row written by the code under test, which is exactly what these
 * assertions exist to catch. A delta from a baseline is immune to that.
 */
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

describe('applyExecuteModeGrant', () => {
  withTempDataDir('execute-mode-grant');

  test('a successful grant appends exactly one row and flips the column', () => {
    createMultiAgentSession('emg-ok', 'orchestrator');
    const baseline = auditRows().length;
    const sent: ServerMsg[] = [];

    const r = applyExecuteModeGrant(
      {
        sessionId: 'emg-ok',
        mode: 'orchestrator',
        projects: [
          { projectId: 7, agentName: 'coder' },
          { projectId: 9, agentName: 'reviewer' },
        ],
      },
      (m) => sent.push(m),
    );

    expect(r).toEqual({ granted: true });
    expect(getMultiAgentSession('emg-ok')!.execute_mode).toBe(1);

    // Exactly one row, named in full — a second would surface here.
    const rows = auditRowsSince(baseline);
    expect(rows.map((row) => row.kind)).toEqual(['bus.execute_mode_decided']);
    expect(rows[0]!.reason_code).toBe('execute_mode_granted');
    // The payload carries the transition AND the blast radius — the projects
    // whose files agents may now write. Without the projects the row would be
    // strictly weaker than the narrower `project.start_mode_decided` it copies.
    expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({
      sessionId: 'emg-ok',
      mode: 'orchestrator',
      from: false,
      to: true,
      projects: [
        { projectId: 7, agentName: 'coder' },
        { projectId: 9, agentName: 'reviewer' },
      ],
    });

    // The WS envelope was sent too (a notification, class safety).
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'notification', class: 'safety' });
  });

  test('[security] a failing audit append leaves the column at 0 and appends no row', () => {
    // The contract, and the direction that matters: the privilege must NOT go
    // live if it cannot be recorded. Breaking the append is the only way to see
    // the ordering — mirrors `project_start_mode.test.ts`'s BE-1 test through
    // this same dispatcher.
    createMultiAgentSession('emg-broken', 'chain');
    const baseline = auditRows().length;
    const spy = vi.spyOn(safetyAudit, 'appendSafetyAudit').mockImplementation(() => {
      throw new Error('audit chain broken');
    });
    try {
      const sent: ServerMsg[] = [];
      const r = applyExecuteModeGrant(
        {
          sessionId: 'emg-broken',
          mode: 'chain',
          projects: [{ projectId: 3, agentName: 'head' }],
        },
        (m) => sent.push(m),
      );

      expect(r.granted).toBe(false);
      // The session runs consultant: column untouched, and nothing was
      // announced (a toast saying "granted" while the column reads 0 is worse
      // than silence).
      expect(getMultiAgentSession('emg-broken')!.execute_mode).toBe(0);
      expect(sent).toEqual([]);
      expect(auditRowsSince(baseline)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
