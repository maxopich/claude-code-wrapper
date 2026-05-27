import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ServerMsg } from '@cebab/shared';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { _resetCoalesceState, emit, getNotification, markNotificationAcked } from './dispatcher.js';
import { _resetOperatorIdCache } from './operator.js';
import * as safetyAudit from './safety_audit.js';

// ---- isolated fs + DB scaffolding ----

let tmpRoot: string;
let originalDataDir: string;
let sent: ServerMsg[];

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-notif-dispatcher-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  _resetOperatorIdCache();
  _resetCoalesceState();
  getDb();
  sent = [];
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  _resetOperatorIdCache();
  _resetCoalesceState();
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function recorder(msg: ServerMsg): void {
  sent.push(msg);
}

// ---- operational coalesce ----

describe('emit (operational)', () => {
  test('first emit per key sends an envelope', () => {
    const r = emit(
      {
        class: 'operational',
        severity: 'info',
        dedupeKey: 'rate_limit:open',
        title: 'Rate limited',
      },
      recorder,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sent).toBe(true);
      expect(r.coalescedInto).toBeUndefined();
    }
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('notification');
  });

  test('subsequent emit within window coalesces (no envelope sent)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    emit({ class: 'operational', severity: 'info', dedupeKey: 'k1', title: 't' }, recorder);
    expect(sent).toHaveLength(1);
    const firstId = (sent[0] as { id: string }).id;

    vi.advanceTimersByTime(3000); // still inside the 10s info window
    const r = emit(
      { class: 'operational', severity: 'info', dedupeKey: 'k1', title: 't' },
      recorder,
    );
    expect(sent).toHaveLength(1);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sent).toBe(false);
      expect(r.coalescedInto).toBe(firstId);
    }
  });

  test('emit after window expiry sends a fresh envelope', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    emit({ class: 'operational', severity: 'info', dedupeKey: 'k1', title: 't' }, recorder);
    vi.advanceTimersByTime(11_000); // past the 10s info window
    emit({ class: 'operational', severity: 'info', dedupeKey: 'k1', title: 't' }, recorder);
    expect(sent).toHaveLength(2);
    expect((sent[0] as { id: string }).id).not.toBe((sent[1] as { id: string }).id);
  });

  test('different keys do not coalesce against each other', () => {
    emit({ class: 'operational', severity: 'warn', dedupeKey: 'k1', title: 't' }, recorder);
    emit({ class: 'operational', severity: 'warn', dedupeKey: 'k2', title: 't' }, recorder);
    expect(sent).toHaveLength(2);
  });

  test('per-tier windows (info=10s, success=5s, warn=5s, error=2s)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    // error: 2s window
    emit({ class: 'operational', severity: 'error', dedupeKey: 'e1', title: 't' }, recorder);
    vi.advanceTimersByTime(1500);
    emit({ class: 'operational', severity: 'error', dedupeKey: 'e1', title: 't' }, recorder);
    expect(sent.filter((m) => (m as { dedupeKey: string }).dedupeKey === 'e1')).toHaveLength(1);
    vi.advanceTimersByTime(1000); // total 2500 → past 2s window
    emit({ class: 'operational', severity: 'error', dedupeKey: 'e1', title: 't' }, recorder);
    expect(sent.filter((m) => (m as { dedupeKey: string }).dedupeKey === 'e1')).toHaveLength(2);

    // info: 10s window
    emit({ class: 'operational', severity: 'info', dedupeKey: 'i1', title: 't' }, recorder);
    vi.advanceTimersByTime(9000);
    emit({ class: 'operational', severity: 'info', dedupeKey: 'i1', title: 't' }, recorder);
    expect(sent.filter((m) => (m as { dedupeKey: string }).dedupeKey === 'i1')).toHaveLength(1);
  });

  test('sticky=true persists to notifications table; sticky=false does not', () => {
    emit(
      {
        class: 'operational',
        severity: 'info',
        dedupeKey: 'transient',
        title: 't',
        sticky: false,
      },
      recorder,
    );
    emit(
      {
        class: 'operational',
        severity: 'error',
        dedupeKey: 'persist',
        title: 't',
        sticky: true,
      },
      recorder,
    );
    const rows = getDb()
      .prepare<[], { dedupe_key: string }>(`SELECT dedupe_key FROM notifications`)
      .all();
    expect(rows.map((r) => r.dedupe_key)).toEqual(['persist']);
  });
});

// ---- safety class ----

describe('[security][A] emit (safety)', () => {
  test('writes safety_audit row BEFORE sending envelope', () => {
    const r = emit(
      {
        class: 'safety',
        severity: 'danger',
        dedupeKey: 'router_drop:forged_source',
        title: 'Forged source detected',
        reasonCode: 'forged_source',
        auditKind: 'router.drop',
        auditPayload: { from: 'worker-a', spoofed: 'cebab' },
      },
      recorder,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.id).toBeTruthy();

    // safety_audit row exists with correct sub-code
    const auditCount = getDb()
      .prepare<
        [],
        { c: number }
      >(`SELECT COUNT(*) AS c FROM safety_audit WHERE reason_code = 'forged_source'`)
      .get();
    expect(auditCount?.c).toBe(1);

    // envelope sent with auditRowId pointer
    expect(sent).toHaveLength(1);
    const env = sent[0] as { type: string; class: string; auditRowId: string; reasonCode: string };
    expect(env.type).toBe('notification');
    expect(env.class).toBe('safety');
    expect(env.reasonCode).toBe('forged_source');
    expect(env.auditRowId).toBeTruthy();
  });

  test('BE-1: audit-write failure returns failure and does NOT send envelope', () => {
    const spy = vi.spyOn(safetyAudit, 'appendSafetyAudit').mockImplementation(() => {
      throw new Error('disk full');
    });
    const r = emit(
      {
        class: 'safety',
        severity: 'danger',
        dedupeKey: 'router_drop:forged_source',
        title: 'Forged source detected',
        reasonCode: 'forged_source',
        auditKind: 'router.drop',
      },
      recorder,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('audit_write_failed');
    expect(sent).toHaveLength(0);
    expect(spy).toHaveBeenCalledOnce();
  });

  test('BE-2 + BE-3: safety NEVER coalesces — burst of 50 yields 50 envelopes + 50 audit rows', () => {
    for (let i = 0; i < 50; i++) {
      emit(
        {
          class: 'safety',
          severity: 'danger',
          dedupeKey: 'router_drop:forged_source', // identical key
          title: 'Forged source detected',
          reasonCode: 'forged_source',
          auditKind: 'router.drop',
          auditPayload: { i },
        },
        recorder,
      );
    }
    expect(sent).toHaveLength(50);
    const auditCount = getDb()
      .prepare<
        [],
        { c: number }
      >(`SELECT COUNT(*) AS c FROM safety_audit WHERE reason_code = 'forged_source'`)
      .get();
    expect(auditCount?.c).toBe(50);
  });

  test('safety defaults sticky=true (persists to notifications)', () => {
    emit(
      {
        class: 'safety',
        severity: 'danger',
        dedupeKey: 'k',
        title: 't',
        reasonCode: 'forged_source',
        auditKind: 'router.drop',
      },
      recorder,
    );
    const row = getDb()
      .prepare<
        [],
        { sticky: number; class: string }
      >(`SELECT sticky, class FROM notifications LIMIT 1`)
      .get();
    expect(row?.sticky).toBe(1);
    expect(row?.class).toBe('safety');
  });

  test('rejects safety emit missing reason_code', () => {
    const r = emit(
      {
        class: 'safety',
        severity: 'danger',
        dedupeKey: 'k',
        title: 't',
        auditKind: 'router.drop',
      },
      recorder,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('safety_missing_reason_code');
    expect(sent).toHaveLength(0);
  });

  test('rejects safety emit missing audit_kind', () => {
    const r = emit(
      {
        class: 'safety',
        severity: 'danger',
        dedupeKey: 'k',
        title: 't',
        reasonCode: 'forged_source',
      },
      recorder,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('safety_missing_audit_kind');
    expect(sent).toHaveLength(0);
  });
});

// ---- ack helpers ----

describe('getNotification / markNotificationAcked', () => {
  test('round-trips a safety notification with auditRowId', () => {
    const r = emit(
      {
        class: 'safety',
        severity: 'danger',
        dedupeKey: 'k',
        title: 't',
        reasonCode: 'forged_source',
        auditKind: 'router.drop',
      },
      recorder,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = getNotification(r.id);
    expect(row).toBeDefined();
    expect(row?.class).toBe('safety');
    expect(row?.reason_code).toBe('forged_source');
    expect(row?.audit_row_id).toBeTruthy();
    expect(row?.acked_at).toBeNull();

    markNotificationAcked(r.id, 12345, 'tester', 'investigated');
    const after = getNotification(r.id);
    expect(after?.acked_at).toBe(12345);
  });

  test('BE-6: markNotificationAcked is idempotent (UPDATE ... WHERE acked_at IS NULL)', () => {
    const r = emit(
      {
        class: 'operational',
        severity: 'error',
        dedupeKey: 'k',
        title: 't',
        sticky: true,
      },
      recorder,
    );
    if (!r.ok) throw new Error('precondition failed');
    markNotificationAcked(r.id, 100, 'first', 'reason-1');
    markNotificationAcked(r.id, 200, 'second', 'reason-2');
    const row = getDb()
      .prepare<
        [string],
        { acked_at: number; acked_by: string; acked_reason: string }
      >(`SELECT acked_at, acked_by, acked_reason FROM notifications WHERE id = ?`)
      .get(r.id)!;
    expect(row.acked_at).toBe(100); // first ack wins
    expect(row.acked_by).toBe('first');
  });
});
