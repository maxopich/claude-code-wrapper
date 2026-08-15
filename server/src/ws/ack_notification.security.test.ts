import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { _resetOperatorIdCache } from '../notifications/operator.js';
import { emit, getNotification, type NotificationRow } from '../notifications/dispatcher.js';
import { requiresTypedAckReason } from './server.js';

// [security] Register H13 — BE-7's typed-acknowledgment requirement.
//
// THE DEFECT. The ack handler tested `HIGHEST_SUBCODES.has(row.reason_code)`,
// and `audit.tamper_detected` sat in that set. But it is an audit KIND, not a
// reason code: the tamper emitter puts the specific failure (`row_mismatch`,
// `no_anchor`, and now H14's `tail_truncated`) in `reasonCode` and the kind in
// `auditKind`. The membership test could therefore never match, so the single
// most severe event Cebab raises was dismissible with one bare click while
// lesser events demanded a written justification.
//
// `ack_notification` had NO test coverage at all before this file, which is
// how a set with a name in the wrong field survived.

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-ack-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  _resetOperatorIdCache();
  getDb();
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  _resetOperatorIdCache();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Emit through the real dispatcher so the audit row + `audit_row_id` link
 *  exist exactly as they do in production, then read the row back. */
function emitAndRead(input: {
  cls: 'safety' | 'operational';
  reasonCode: string;
  auditKind?: string;
}): NotificationRow {
  const res = emit(
    {
      class: input.cls,
      severity: 'danger',
      dedupeKey: `test:${input.reasonCode}`,
      title: 't',
      message: 'm',
      reasonCode: input.reasonCode,
      // Operational notifications are only persisted when sticky, and only a
      // persisted row can be acked at all.
      sticky: true,
      ...(input.auditKind ? { auditKind: input.auditKind, auditPayload: {} } : {}),
    },
    () => {},
  );
  if (!res.ok) throw new Error(`emit failed: ${res.error}`);
  const row = getNotification(res.id);
  if (!row) throw new Error('notification not persisted');
  return row;
}

describe('[security] typed-ack requirement', () => {
  test('the tamper alarm requires a reason — every failure mode of it', () => {
    // Each of these is a real `VerifyChainFailureReason`. None appears in any
    // subcode set; they are covered because the AUDIT KIND is matched. That is
    // what makes the requirement survive a new failure mode being added.
    for (const reason of [
      'row_mismatch',
      'no_anchor',
      'forged_anchor',
      'tail_truncated',
      'tip_mirror_missing',
    ]) {
      const row = emitAndRead({
        cls: 'safety',
        reasonCode: reason,
        auditKind: 'audit.tamper_detected',
      });
      expect(requiresTypedAckReason(row), `reason ${reason}`).toBe(true);
    }
  });

  test('forged_source still requires one — no regression on the case that worked', () => {
    const row = emitAndRead({
      cls: 'safety',
      reasonCode: 'forged_source',
      auditKind: 'bus.forged_source',
    });
    expect(requiresTypedAckReason(row)).toBe(true);
  });

  test('an ordinary safety event does not require one', () => {
    // The requirement is for the HIGHEST sub-class only. Demanding prose for
    // every trust decision would train operators to type junk.
    const row = emitAndRead({
      cls: 'safety',
      reasonCode: 'denied_remember',
      auditKind: 'mcp.trust_silent_refusal',
    });
    expect(requiresTypedAckReason(row)).toBe(false);
  });

  test('operational notifications never require one', () => {
    const row = emitAndRead({ cls: 'operational', reasonCode: 'auth_expired' });
    expect(requiresTypedAckReason(row)).toBe(false);
  });

  test('a safety row whose audit row is gone does not crash the ack', () => {
    // Defensive: `audit_row_id` points at a row a truncation may have removed
    // (register H14's attack). Failing the lookup must not throw — the operator
    // needs to be able to clear their inbox even mid-incident.
    const row = emitAndRead({
      cls: 'safety',
      reasonCode: 'row_mismatch',
      auditKind: 'audit.tamper_detected',
    });
    getDb().prepare(`DELETE FROM safety_audit WHERE id = ?`).run(row.audit_row_id);
    expect(() => requiresTypedAckReason(row)).not.toThrow();
    expect(requiresTypedAckReason(row)).toBe(false);
  });

  test('reason code alone is not enough to demote a tamper alarm', () => {
    // The inverse of the original bug: a caller that emits the tamper KIND with
    // some unrecognised reason code must still be gated. Matching on the kind
    // is what guarantees that.
    const row = emitAndRead({
      cls: 'safety',
      reasonCode: 'something_new_nobody_listed',
      auditKind: 'audit.tamper_detected',
    });
    expect(requiresTypedAckReason(row)).toBe(true);
  });
});
