import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { _resetOperatorIdCache } from './operator.js';
import { appendSafetyAudit, recordCurrentTamperAck, verifyChain } from './safety_audit.js';
import {
  appendAuditTip,
  auditTipPath,
  isMirrorEstablished,
  readLatestAuditTip,
  readMaxTipForAnchor,
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

  test('a truncation is NOT healed by the next safety event (Cebab-ygu.21)', () => {
    // The self-heal defect. `readLatestAuditTip` consulted only the newest line,
    // so the first ordinary append after a truncation re-committed a `count`
    // recomputed from the already-shortened table (here 1). Reading only that
    // line found the surviving chain no shorter than its own post-truncation
    // commitment and reported clean — one DELETE plus one wait (or any trust
    // decision the attacker triggers themselves) erased the trail without ever
    // touching the mirror. The fix takes the HIGH-WATER count for the current
    // anchor, which a smaller later commitment cannot lower.
    appendRows(5);
    expect(verifyChain()).toMatchObject({ ok: true, rowsChecked: 5 });

    truncateTail();
    expect(verifyChain()).toMatchObject({ ok: false, reason: 'tail_truncated' });

    // The healing append: an ordinary safety event, count recomputed as 1.
    appendRows(1);
    const tail = readLatestAuditTip();
    expect(tail!.count).toBe(1); // the newest line really does commit to only 1
    // The mirror still holds the count:5 commitment for this anchor, so the
    // truncation is still caught rather than blessed.
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
    //
    // Cebab-lf1u note. A migration is now told from a re-seat by WHICH anchor
    // sits at the tip (`checkAnchorNotReseated`): a migration carries a NEW id
    // the mirror never committed, a re-seat relocates an existing one. So this
    // test must model a migration faithfully — a marker whose id the mirror has
    // not seen. The fresh DB already holds both allowlisted markers (015 + 023),
    // so to reach a state where inserting 023 is genuinely NEW to the mirror we
    // first delete 023 and append under the lone 015 anchor (committing
    // anchorId 015), then re-insert 023 at the tip. The committed lines name
    // 015, never 023, so the fresh 023 anchor reads as an add, not a relocation.
    // An `INSERT OR REPLACE` that reused an id the mirror HAD committed is now
    // (correctly) reported as a re-seat — see the Cebab-lf1u suite below.
    getDb().exec(`DELETE FROM safety_audit WHERE id = 'chain-reset-023'`);
    appendRows(5);
    expect(verifyChain()).toMatchObject({ ok: true, rowsChecked: 5 });

    getDb()
      .prepare(
        `INSERT INTO safety_audit
           (id, ts, kind, reason_code, payload_json, hash_prev, hash_self, mode)
         VALUES ('chain-reset-023', 0, 'audit.chain_reset', 'migration_023', '{}', NULL, X'00', 'live')`,
      )
      .run();

    // The mirror committed anchorId 015, never 023, so the fresh 023 anchor
    // reads as a migration, not a re-seat.
    // Before H14 the raw check returned { ok:false, reason:'tail_truncated' }.
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

describe('[security] re-seating the anchor cannot erase the log (Cebab-5y4t)', () => {
  /**
   * THE ATTACK, in the failure scenario's own two statements. `anchorRowid` is
   * `MAX(rowid) WHERE kind='audit.chain_reset'` — attacker-controlled state
   * inside the very database the mirror exists to corroborate. Moving that row
   * to a new highest rowid puts every real row BELOW the anchor.
   */
  function reseatAnchor(): void {
    getDb().exec(
      `UPDATE safety_audit SET rowid = (SELECT MAX(rowid) + 1 FROM safety_audit)
         WHERE rowid = (SELECT MAX(rowid) FROM safety_audit WHERE kind = 'audit.chain_reset')`,
    );
  }

  test('re-seat then erase every row is reported, not reported clean', () => {
    // Measured on the merged tree before the fix: this sequence returned
    // { ok: true, rowsChecked: 0 } with the mirror still untouched on disk —
    // every trust decision, kick and guardrail violation gone, no
    // audit.tamper_detected notification. The identity gate passed because the
    // anchor row was REUSED, not forged.
    appendRows(5);
    expect(verifyChain()).toMatchObject({ ok: true, rowsChecked: 5 });

    reseatAnchor();
    getDb().exec(`DELETE FROM safety_audit WHERE kind <> 'audit.chain_reset'`);

    const after = verifyChain();
    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.reason).toBe('tail_truncated');
  });

  test('the erasure is caught even though NO mirror line names the new anchor', () => {
    // The precise hole. `readMaxTipForAnchor` scopes the commitment to the
    // current anchor rowid and returns null when no line names it, which was
    // read as benign because that is also what a fresh migration anchor looks
    // like. So the check must not depend on a line naming this anchor.
    appendRows(3);
    reseatAnchor();
    getDb().exec(`DELETE FROM safety_audit WHERE kind <> 'audit.chain_reset'`);

    const anchorRowid = getDb()
      .prepare<[], { rowid: number }>(
        `SELECT MAX(rowid) AS rowid FROM safety_audit WHERE kind = 'audit.chain_reset'`,
      )
      .get()!.rowid;
    expect(readMaxTipForAnchor(anchorRowid)).toBeNull();
    expect(verifyChain().ok).toBe(false);
  });

  test('rowsChecked = 0 no longer disarms the missing-mirror branch by itself', () => {
    // `tip_mirror_missing` is guarded on `rowsChecked > 0`, so the re-seat also
    // bought the attacker a free mirror delete. With the rows gone the survival
    // check fires first, so the second step is no longer a way out.
    appendRows(4);
    reseatAnchor();
    getDb().exec(`DELETE FROM safety_audit WHERE kind <> 'audit.chain_reset'`);
    fs.rmSync(auditTipPath(), { force: true });

    // With the mirror gone nothing commits to the erased rows any more, so the
    // survival check has nothing to say and the established FLAG is what
    // answers. That flag lives in the DB's settings table, so the erasure now
    // costs a third action in a third place. `audit_tip.ts`'s header is still
    // right that a same-uid attacker who does all of it wins — this raises the
    // bar, it does not end the game.
    expect(verifyChain()).toMatchObject({ ok: false, reason: 'tip_mirror_missing' });
  });

  test('a committed tip rewritten below a re-seated anchor is reported', () => {
    // Re-seating shrinks the digest-checked range to nothing, so rows below the
    // anchor stop being verified and could be rewritten rather than removed.
    // The mirror already stores each tip's hashSelf, so comparing it costs
    // nothing and catches this for the committed tips.
    appendRows(3);
    reseatAnchor();
    getDb()
      .prepare(`UPDATE safety_audit SET payload_json = '{"tampered":true}' WHERE kind = ?`)
      .run('test.event');

    const after = verifyChain();
    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.reason).toBe('row_mismatch');
  });

  test('a fresh database beside an older mirror is NOT called erased', () => {
    // The false alarm the survival check could produce: an operator who deleted
    // cebab.sqlite but kept ~/.cebab/audit-tip.jsonl. The established flag lives
    // in the new DB's settings table and is false, which is the same guard the
    // missing-mirror branch already uses.
    appendAuditTip({ ts: 1, rowId: 'row-from-another-life', hashSelf: 'ff', count: 99 });
    expect(isMirrorEstablished()).toBe(false);
    expect(verifyChain()).toMatchObject({ ok: true, rowsChecked: 0 });
  });

  describe('[security] a bare re-seat no longer reports clean (Cebab-lf1u)', () => {
    test('re-seat alone, nothing else touched, is reported as anchor_reseated', () => {
      // The residual Cebab-5y4t left explicit. With the rows all still present
      // and hashing correctly, the survival check says nothing; before this the
      // whole verify returned { ok: true, rowsChecked: 0 } because the digest
      // walk covered zero rows. The mirror now records WHICH anchor each line
      // was committed under, and this re-seat put an already-committed anchor id
      // at a rowid it was never committed at, so it is caught.
      appendRows(5);
      expect(verifyChain()).toMatchObject({ ok: true, rowsChecked: 5 });

      reseatAnchor();

      const after = verifyChain();
      expect(after.ok).toBe(false);
      if (after.ok) return;
      expect(after.reason).toBe('anchor_reseated');
    });

    test('re-anchoring by REPLACING an existing marker id is a re-seat, not a migration', () => {
      // INSERT OR REPLACE on an existing marker id (what the old migration test
      // used as a stand-in) deletes the marker and re-inserts it at a higher
      // rowid: the SAME id reappears at a new rowid. A real migration carries a
      // NEW id the mirror never committed. So reusing an id now reads as a
      // re-seat — the same end state the bare `UPDATE ... SET rowid` produces.
      appendRows(4);
      getDb()
        .prepare(
          `INSERT OR REPLACE INTO safety_audit
             (id, ts, kind, reason_code, payload_json, hash_prev, hash_self, mode)
           VALUES ('chain-reset-023', 0, 'audit.chain_reset', 'migration_023', '{}', NULL, X'00', 'live')`,
        )
        .run();

      const after = verifyChain();
      expect(after.ok).toBe(false);
      if (after.ok) return;
      expect(after.reason).toBe('anchor_reseated');
    });

    test('a non-tip row stranded below a re-seated anchor cannot be edited undetected', () => {
      // The second clause of the residual: re-seating stops the rows below the
      // anchor from being digest-checked, so a row that is neither a committed
      // high-water tip nor above the anchor could be rewritten unseen. Editing
      // one no longer hides — the re-seat that stranded it is itself reported.
      appendRows(5);
      reseatAnchor();
      // Rewrite the SECOND-oldest row: not the committed high-water tip (the
      // last append), so `checkCommittedRowsSurvive` does not name it.
      getDb()
        .prepare(
          `UPDATE safety_audit SET payload_json = '{"tampered":true}'
             WHERE rowid = (
               SELECT rowid FROM safety_audit WHERE kind = 'test.event'
                ORDER BY rowid ASC LIMIT 1 OFFSET 1)`,
        )
        .run();

      expect(verifyChain().ok).toBe(false);
    });

    test('the anchorId tag is what catches the re-seat; a legacy mirror abstains', () => {
      // Positive control AND the documented limit in one case, so the assertion
      // is not vacuous. With the tag present a re-seat is caught — that half
      // reddens the moment the fix is reverted. Stripping `anchorId` from every
      // committed line (as a pre-Cebab-lf1u build wrote them) then leaves the
      // SAME re-seat indistinguishable from a migration, which is the honest
      // new-format-only limit of direction 1.
      appendRows(5);
      reseatAnchor();
      expect(verifyChain()).toMatchObject({ ok: false, reason: 'anchor_reseated' });

      const stripped = fs
        .readFileSync(auditTipPath(), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          const obj = JSON.parse(l) as Record<string, unknown>;
          delete obj.anchorId;
          return JSON.stringify(obj);
        })
        .join('\n');
      fs.writeFileSync(auditTipPath(), stripped + '\n');

      // No tagged commitment to measure against, so the check abstains — the
      // very same re-seated DB now reads clean.
      expect(verifyChain()).toMatchObject({ ok: true, rowsChecked: 0 });
    });
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

describe('[security] tamper detection survives the next append (Cebab-6fax.13, .15)', () => {
  // BOTH detections were ONE-SHOT, and neither test could see it because both
  // fixtures stopped before the step that mattered.
  //
  //   anchor_reseated  — cleared by the next ordinary append, which commits the
  //                      anchor at its NEW rowid; `verifyChain`'s outer guard
  //                      (`commitment === null`) then stopped calling the check
  //                      at all.
  //   tip_mirror_missing — cleared by the DETECTOR'S OWN append, which rewrites
  //                      the file whose absence was the evidence.
  //
  // Measured 2026-09-08 by re-running the reader's probes: re-seat → alert,
  // append once → CLEAN, with the rows below the anchor stranded and editable.
  // The fixture omitting that one append is `project_fixture_omits_the_bug_input`
  // exactly: the property held in the only scenario the test built.

  function reseatAnchor(): void {
    getDb().exec(
      `UPDATE safety_audit SET rowid = (SELECT MAX(rowid) + 1 FROM safety_audit)
         WHERE rowid = (SELECT MAX(rowid) FROM safety_audit WHERE kind = 'audit.chain_reset')`,
    );
  }

  test('a re-seat is still reported after an ordinary append', () => {
    appendRows(5);
    reseatAnchor();
    expect(verifyChain()).toMatchObject({ ok: false, reason: 'anchor_reseated' });

    // THE STEP THE OLD FIXTURE OMITTED. On a running machine this happens by
    // itself within minutes — every safety emission appends, and so does the
    // boot walk. An attacker need do nothing after the re-seat.
    appendRows(1);

    expect(verifyChain()).toMatchObject({ ok: false, reason: 'anchor_reseated' });
  });

  test('and after many appends — the mirror is append-only, so the signal is too', () => {
    appendRows(3);
    reseatAnchor();
    appendRows(10);
    expect(verifyChain()).toMatchObject({ ok: false, reason: 'anchor_reseated' });
  });

  test('a stranded row stays undetectable-free even after the blessing append', () => {
    // The consequence, restated as the property that actually matters: the rows
    // below a re-seated anchor are outside the digest walk, so the only thing
    // standing between them and an undetected edit is the re-seat report.
    appendRows(5);
    reseatAnchor();
    appendRows(1);
    getDb()
      .prepare(
        `UPDATE safety_audit SET payload_json = '{"tampered":true}'
           WHERE rowid = (
             SELECT rowid FROM safety_audit WHERE kind = 'test.event'
              ORDER BY rowid ASC LIMIT 1 OFFSET 1)`,
      )
      .run();

    expect(verifyChain().ok).toBe(false);
  });

  test('ANTI-VACUITY: an ordinary chain with no re-seat verifies clean', () => {
    // Without this, "always report anchor_reseated" would pass every case above
    // and break the product.
    appendRows(5);
    expect(verifyChain().ok).toBe(true);
  });

  test('ANTI-VACUITY: an acknowledged re-seat stays quiet through ordinary use', () => {
    // The other way "always report" could hide: an ack that only survives until
    // the next append would look like a working stop and be none.
    //
    // (A genuinely NEW migration anchor cannot be simulated here at all —
    // `KNOWN_CHAIN_RESET_IDS` is a closed set of the ids this build wrote, so a
    // fabricated one reports `forged_anchor`, correctly. The migration path's
    // benign-ness is covered by the existing suite's legacy-mirror case.)
    appendRows(5);
    reseatAnchor();
    recordCurrentTamperAck();
    appendRows(4);
    expect(verifyChain().ok).toBe(true);
  });

  test('a deleted mirror is still reported after the append that regenerates it', () => {
    appendRows(5);
    fs.rmSync(auditTipPath(), { force: true });
    expect(verifyChain()).toMatchObject({ ok: false, reason: 'tip_mirror_missing' });

    // Raising the alert itself appends, which rewrites the mirror. Before the
    // fix this is the point at which the system went back to reporting health.
    appendRows(1);
    expect(fs.existsSync(auditTipPath())).toBe(true);

    expect(verifyChain()).toMatchObject({ ok: false, reason: 'tip_mirror_missing' });
  });

  describe('acknowledgement stops it — and only for the state acknowledged', () => {
    // Persistence without a stop is alarm fatigue: every boot re-raises
    // something nobody can clear, and the operator learns to ignore the one
    // channel that must not be ignored. `recordCurrentTamperAck` is reached
    // only through the typed-reason gate in the ack handler.

    test('acking a re-seat clears it', () => {
      appendRows(5);
      reseatAnchor();
      expect(verifyChain().ok).toBe(false);

      recordCurrentTamperAck();

      expect(verifyChain().ok).toBe(true);
    });

    test('but a SECOND re-seat fires again — an ack is not a mute', () => {
      appendRows(5);
      reseatAnchor();
      recordCurrentTamperAck();
      expect(verifyChain().ok).toBe(true);

      // The anchor moves again. The ack names the position it was accepted at,
      // so it does not match this one.
      appendRows(2);
      reseatAnchor();

      expect(verifyChain()).toMatchObject({ ok: false, reason: 'anchor_reseated' });
    });

    test('acking a mirror loss clears it; a SECOND deletion is a fresh finding', () => {
      // The production sequence, in order. The boot walk detects the loss and
      // emits — and emitting APPENDS, which is what puts the file back. So by
      // the time the operator sees the notification the artifact is already
      // restored and only the flag remembers.
      appendRows(5);
      fs.rmSync(auditTipPath(), { force: true });
      expect(verifyChain()).toMatchObject({ ok: false, reason: 'tip_mirror_missing' });
      appendRows(1);
      expect(fs.existsSync(auditTipPath())).toBe(true);
      expect(verifyChain()).toMatchObject({ ok: false, reason: 'tip_mirror_missing' });

      recordCurrentTamperAck();
      expect(verifyChain().ok).toBe(true);

      fs.rmSync(auditTipPath(), { force: true });
      expect(verifyChain()).toMatchObject({ ok: false, reason: 'tip_mirror_missing' });
    });

    test('an ack does NOT pre-clear a loss that is still live', () => {
      // Acking before an append has restored the file must not silence the
      // fact that the mirror is, right now, gone. The flag is re-set by the
      // very next verify, because the condition is still true.
      appendRows(5);
      fs.rmSync(auditTipPath(), { force: true });
      expect(verifyChain()).toMatchObject({ ok: false, reason: 'tip_mirror_missing' });

      recordCurrentTamperAck();

      expect(verifyChain()).toMatchObject({ ok: false, reason: 'tip_mirror_missing' });
    });
  });
});
