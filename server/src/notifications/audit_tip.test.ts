import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { _resetOperatorIdCache } from './operator.js';
import { appendSafetyAudit, verifyChain } from './safety_audit.js';
import {
  appendAuditTip,
  auditTipPath,
  isMirrorEstablished,
  readLatestAuditTip,
} from './audit_tip.js';

// [security] Register H14 — tail truncation of the hash-chained audit log.
//
// THE DEFECT. Each row's `hash_self` commits to its predecessors and never to
// its successors, so `DELETE FROM safety_audit WHERE rowid > anchor` left
// `verifyChain()` returning `{ ok: true, rowsChecked: 0 }` — the identical
// answer a freshly-migrated database gives. An agent runs as the operator's
// uid; it could issue that DELETE and leave verification reporting healthy.
// `safety_audit.ts` documented the gap and named the fix; `audit_tip.ts` is it.
//
// WHAT THIS SUITE IS NOT. It does not claim the log is tamper-proof. The
// mirror is a file the same user can delete — see `audit_tip.ts`'s header. The
// cases below pin what the mirror actually buys: the realistic attack (SQL
// against the DB) stops verifying clean, and removing the mirror instead is
// itself reported.

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-audit-tip-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  _resetOperatorIdCache();
  getDb();
});

afterEach(() => {
  vi.restoreAllMocks();
  // closeDb before rm: Windows cannot unlink an open SQLite file.
  closeDb();
  config.dataDir = originalDataDir;
  _resetOperatorIdCache();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function appendRows(n: number): void {
  for (let i = 0; i < n; i++) {
    appendSafetyAudit({ ts: 1000 + i, kind: 'test.event', reasonCode: 'r', payload: { i } });
  }
}

/** The attack: drop everything after the anchor, leaving the anchor intact. */
function truncateTail(): void {
  getDb()
    .prepare(
      `DELETE FROM safety_audit
        WHERE rowid > (SELECT MAX(rowid) FROM safety_audit WHERE kind = 'audit.chain_reset')`,
    )
    .run();
}

describe('[security] tail truncation is detected', () => {
  test('erasing the whole tail no longer verifies clean', () => {
    appendRows(5);
    expect(verifyChain()).toMatchObject({ ok: true, rowsChecked: 5 });

    truncateTail();

    // Before H14 this returned { ok: true, rowsChecked: 0 } — the single most
    // important assertion in this file.
    const after = verifyChain();
    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.reason).toBe('tail_truncated');
  });

  test('deleting only the most recent rows is detected', () => {
    // The subtler attack: keep a plausible-looking chain, drop the incriminating
    // tail. The surviving rows still hash correctly, so the digest walk passes.
    appendRows(6);
    getDb()
      .prepare(
        `DELETE FROM safety_audit WHERE rowid IN (
           SELECT rowid FROM safety_audit
            WHERE kind != 'audit.chain_reset' ORDER BY rowid DESC LIMIT 2)`,
      )
      .run();

    const after = verifyChain();
    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.reason).toBe('tail_truncated');
  });

  test('a fresh migration anchor above the mirrored tip is not truncation', () => {
    // The false-alarm-in-the-other-direction that the raw `!rows.some(...)`
    // check produced. Any future migration that ALTERs safety_audit inserts a
    // fresh `audit.chain_reset` anchor at the tip (mandatory per this module's
    // contract). On the first boot after it `verifyChain()` walks only rows
    // AFTER the new anchor — an empty set — so the mirrored pre-migration tip is
    // not among them. It must NOT read as tamper: the tip row still exists in
    // the DB, just below the new anchor, and the mirror re-commits at the next
    // append. Left unfixed this fires a non-dismissible `danger` alarm once per
    // such migration on every healthy install.
    appendRows(5);
    expect(verifyChain()).toMatchObject({ ok: true, rowsChecked: 5 });

    // Simulate the migration's fresh marker: re-anchor above the current tip.
    // INSERT OR REPLACE deletes the old anchor row and inserts a new one at a
    // higher rowid — exactly what a migration's fresh marker does relative to
    // the rows already present. (This is the reproduction the finding's probe
    // used.)
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO safety_audit
           (id, ts, kind, reason_code, payload_json, hash_prev, hash_self, mode)
         VALUES ('chain-reset-023', 0, 'audit.chain_reset', 'migration_023', '{}', NULL, X'00', 'live')`,
      )
      .run();

    // Before the fix this returned { ok:false, reason:'tail_truncated' }.
    expect(verifyChain()).toMatchObject({ ok: true, rowsChecked: 0 });
  });

  test('a genuinely fresh database stays clean — no false alarm', () => {
    // The failure mode in the other direction. A new install has an anchor,
    // zero rows and no mirror; crying tamper there would train operators to
    // ignore the alarm.
    const result = verifyChain();
    expect(result).toMatchObject({ ok: true, rowsChecked: 0 });
  });

  test('normal growth between append and verify is not truncation', () => {
    // The mirror commits to a count that is a floor, not an equality: rows keep
    // arriving. `!==` here instead of `<` would fire on every healthy install.
    appendRows(3);
    expect(verifyChain().ok).toBe(true);
    appendRows(2);
    expect(verifyChain()).toMatchObject({ ok: true, rowsChecked: 5 });
  });

  test('a mutated row still reports row_mismatch, not truncation', () => {
    // Ordering matters: `row_mismatch` names the offending row, which is more
    // actionable than "the tail is short". A chain that is both must report the
    // specific finding.
    appendRows(3);
    getDb()
      .prepare(`UPDATE safety_audit SET payload_json = '{"tampered":true}' WHERE kind = ?`)
      .run('test.event');
    const after = verifyChain();
    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.reason).toBe('row_mismatch');
  });
});

describe('[security] the mirror itself', () => {
  test('first boot seeds silently — an upgrade is not an alarm', () => {
    // Before the first append there is no mirror and no flag. Reporting
    // tampering here would make every upgrade to this build look like an attack.
    expect(readLatestAuditTip()).toBeNull();
    expect(isMirrorEstablished()).toBe(false);
    expect(verifyChain().ok).toBe(true);
  });

  test('appending establishes the mirror and the flag together', () => {
    appendRows(1);
    expect(isMirrorEstablished()).toBe(true);
    const tip = readLatestAuditTip();
    expect(tip).not.toBeNull();
    expect(tip!.count).toBe(1);
    expect(tip!.hashSelf).toMatch(/^[0-9a-f]{64}$/);
  });

  test('deleting the mirror is reported once it was known to exist', () => {
    // The other half of the two-step erasure. On its own it is also what a
    // stray `rm ~/.cebab/audit-tip.jsonl` looks like — either way the operator
    // should hear that deletion detection has stopped working.
    appendRows(3);
    fs.rmSync(auditTipPath());

    const after = verifyChain();
    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.reason).toBe('tip_mirror_missing');
  });

  test('a torn final line is tolerated, not treated as tampering', () => {
    // A crash mid-append leaves a partial line. That is a crash artifact;
    // calling it tampering would cry wolf.
    appendRows(3);
    fs.appendFileSync(auditTipPath(), '{"ts":1,"rowId":"trunc');
    const tip = readLatestAuditTip();
    expect(tip).not.toBeNull();
    expect(tip!.count).toBe(3);
    expect(verifyChain().ok).toBe(true);
  });

  test('the mirror is append-only across writes', () => {
    appendRows(3);
    const lines = fs
      .readFileSync(auditTipPath(), 'utf8')
      .split('\n')
      .filter((l) => l.trim());
    // History is retained, so a rewritten tail is not enough to hide a
    // truncation from a human reading the file.
    expect(lines).toHaveLength(3);
  });

  test('a failing mirror write does NOT fail the audit append', () => {
    // Deliberately the opposite of the dispatcher's dual-write. Refusing to
    // record would turn a full disk into the erasure this exists to detect.
    const spy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => appendRows(1)).not.toThrow();

    const n = (
      getDb().prepare(`SELECT COUNT(*) AS n FROM safety_audit WHERE kind = 'test.event'`).get() as {
        n: number;
      }
    ).n;
    expect(n).toBe(1);
    // Loud, so an operator can notice the protection stopped working.
    expect(errSpy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('mirroring does not perturb any row hash', () => {
    // A changed digest would invalidate every existing chain on upgrade. The
    // mirror must be pure bookkeeping alongside the chain, never inside it.
    appendRows(4);
    const before = getDb().prepare(`SELECT hash_self FROM safety_audit ORDER BY rowid`).all() as {
      hash_self: Buffer;
    }[];
    expect(verifyChain()).toMatchObject({ ok: true, rowsChecked: 4 });
    const after = getDb().prepare(`SELECT hash_self FROM safety_audit ORDER BY rowid`).all() as {
      hash_self: Buffer;
    }[];
    expect(after.map((r) => r.hash_self.toString('hex'))).toEqual(
      before.map((r) => r.hash_self.toString('hex')),
    );
  });

  test('appendAuditTip never throws on an unwritable path', () => {
    config.dataDir = path.join(tmpRoot, 'nope', '\0invalid');
    expect(() =>
      appendAuditTip({ ts: 1, rowId: 'x', hashSelf: 'a'.repeat(64), count: 1 }),
    ).not.toThrow();
  });
});
