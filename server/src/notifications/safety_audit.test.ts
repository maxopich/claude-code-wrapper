import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import {
  HIGHEST_SUBCODES,
  _getSafetyAuditRow,
  appendSafetyAudit,
  appendSafetyAuditAck,
  verifyChain,
} from './safety_audit.js';
import { _resetOperatorIdCache } from './operator.js';

// ---- isolated fs + DB scaffolding ----

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-safety-audit-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  _resetOperatorIdCache();
  getDb(); // applies migrations 001..015
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  _resetOperatorIdCache();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---- genesis marker ----

describe('safety_audit genesis marker', () => {
  test('migration 015 inserts a chain-reset marker', () => {
    const db = getDb();
    const row = db
      .prepare<
        [],
        { id: string; kind: string; reason_code: string }
      >(`SELECT id, kind, reason_code FROM safety_audit WHERE kind = 'audit.chain_reset'`)
      .get();
    expect(row).toBeDefined();
    expect(row?.id).toBe('chain-reset-015');
    expect(row?.reason_code).toBe('migration_015');
  });

  test('verifyChain returns ok with rowsChecked=0 on a fresh DB (marker only)', () => {
    const result = verifyChain();
    expect(result).toEqual({ ok: true, rowsChecked: 0 });
  });
});

// ---- append + chain integrity ----

describe('appendSafetyAudit', () => {
  test('first append chains from the genesis marker', () => {
    const { id, hash_self } = appendSafetyAudit({
      ts: 1_000_000,
      kind: 'router.drop',
      reasonCode: 'worker_to_worker',
      payload: { from: 'a', to: 'b' },
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(hash_self).toBeInstanceOf(Buffer);
    expect(hash_self.length).toBe(32); // sha256 = 32 bytes

    const row = _getSafetyAuditRow(id)!;
    expect(row.kind).toBe('router.drop');
    expect(row.reason_code).toBe('worker_to_worker');
    expect(row.operator_id).toBeTruthy(); // populated from os.userInfo() or 'local-user'
    expect(row.parent_session_id).toBeNull();
    // The first real row's hash_prev should equal the genesis marker's
    // hash_self sentinel (X'00').
    expect(row.hash_prev?.equals(Buffer.from([0]))).toBe(true);
    expect(JSON.parse(row.payload_json)).toEqual({ from: 'a', to: 'b' });
  });

  test('second append chains from the first real row', () => {
    const first = appendSafetyAudit({
      ts: 1,
      kind: 'router.drop',
      reasonCode: 'forged_source',
      payload: {},
    });
    const second = appendSafetyAudit({
      ts: 2,
      kind: 'router.drop',
      reasonCode: 'unknown_recipient',
      payload: {},
    });
    const secondRow = _getSafetyAuditRow(second.id)!;
    expect(secondRow.hash_prev?.equals(first.hash_self)).toBe(true);
  });

  test('XCT-1: operator_id defaults from os.userInfo() (or local-user fallback)', () => {
    const { id } = appendSafetyAudit({
      ts: 1,
      kind: 'env_scrubbed',
      reasonCode: 'api_key_scrubbed',
      payload: { vars: ['ANTHROPIC_API_KEY'] },
    });
    const row = _getSafetyAuditRow(id)!;
    // Cannot pin to a literal username (varies by environment), but the
    // column must be populated and non-empty.
    expect(row.operator_id.length).toBeGreaterThan(0);
  });

  test('XCT-1: parent_session_id round-trips when provided', () => {
    const { id } = appendSafetyAudit({
      ts: 1,
      sessionId: 'sess-new',
      parentSessionId: 'sess-parent',
      kind: 'session.recovered',
      reasonCode: 'superseded',
      payload: { sweep: true },
    });
    const row = _getSafetyAuditRow(id)!;
    expect(row.session_id).toBe('sess-new');
    expect(row.parent_session_id).toBe('sess-parent');
  });
});

// ---- verifyChain ----

describe('[security][A] verifyChain', () => {
  test('passes after a clean burst of appends', () => {
    for (let i = 0; i < 50; i++) {
      appendSafetyAudit({
        ts: 1000 + i,
        kind: 'router.drop',
        reasonCode: 'worker_to_worker',
        payload: { i },
      });
    }
    const result = verifyChain();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rowsChecked).toBe(50);
  });

  test('detects payload tampering (direct UPDATE)', () => {
    const { id } = appendSafetyAudit({
      ts: 1,
      kind: 'router.drop',
      reasonCode: 'worker_to_worker',
      payload: { msg: 'original' },
    });
    // Red-team: mutate a row's payload directly bypassing the repository.
    getDb()
      .prepare(`UPDATE safety_audit SET payload_json = ? WHERE id = ?`)
      .run(JSON.stringify({ msg: 'tampered' }), id);
    const result = verifyChain();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.brokenAt).toBe(id);
  });

  test('cascade: mutating an early row breaks every subsequent row', () => {
    const first = appendSafetyAudit({ ts: 1, kind: 'k', reasonCode: 'r', payload: {} });
    appendSafetyAudit({ ts: 2, kind: 'k', reasonCode: 'r', payload: {} });
    appendSafetyAudit({ ts: 3, kind: 'k', reasonCode: 'r', payload: {} });
    getDb().prepare(`UPDATE safety_audit SET kind = 'fake' WHERE id = ?`).run(first.id);
    const result = verifyChain();
    expect(result.ok).toBe(false);
    // brokenAt should be the FIRST mismatching row — the mutated one.
    if (!result.ok) expect(result.brokenAt).toBe(first.id);
  });

  test('detects hash_self tampering even when content is intact', () => {
    const { id } = appendSafetyAudit({
      ts: 1,
      kind: 'router.drop',
      reasonCode: 'worker_to_worker',
      payload: {},
    });
    // Red-team: rewrite hash_self with garbage.
    getDb().prepare(`UPDATE safety_audit SET hash_self = X'deadbeef' WHERE id = ?`).run(id);
    const result = verifyChain();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.brokenAt).toBe(id);
  });
});

// ---- ack ----

describe('appendSafetyAuditAck', () => {
  test('first ack wins (INSERT OR IGNORE)', () => {
    const { id: auditId } = appendSafetyAudit({
      ts: 1,
      kind: 'defang.bypass_suspected',
      reasonCode: 'defang.bypass_suspected',
      payload: { variant: 'unicode-bidi' },
    });
    appendSafetyAuditAck(auditId, 100, 'alice', 'investigating');
    appendSafetyAuditAck(auditId, 200, 'bob', 'never mind');

    const row = getDb()
      .prepare<
        [string],
        { acked_at: number; acked_by: string; acked_reason: string }
      >(`SELECT acked_at, acked_by, acked_reason FROM safety_audit_ack WHERE audit_id = ?`)
      .get(auditId)!;
    expect(row.acked_at).toBe(100);
    expect(row.acked_by).toBe('alice');
    expect(row.acked_reason).toBe('investigating');
  });
});

// ---- HIGHEST_SUBCODES enum stability ----

describe('HIGHEST_SUBCODES', () => {
  test('Phase 1 set is forged_source / defang.bypass_suspected / audit.tamper_detected', () => {
    expect(HIGHEST_SUBCODES.has('forged_source')).toBe(true);
    expect(HIGHEST_SUBCODES.has('defang.bypass_suspected')).toBe(true);
    expect(HIGHEST_SUBCODES.has('audit.tamper_detected')).toBe(true);
    expect(HIGHEST_SUBCODES.has('worker_to_worker')).toBe(false);
    expect(HIGHEST_SUBCODES.has('api_key_scrubbed')).toBe(false);
  });
});
