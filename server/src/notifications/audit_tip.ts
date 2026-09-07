import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';
import { getSetting, setSetting } from '../repo/settings.js';

/**
 * Register H14: an out-of-SQLite commitment to the audit chain's tip.
 *
 * WHY THIS EXISTS. `verifyChain()` walks forward from the newest chain-reset
 * anchor and recomputes every row's digest, so mutating a row is detected.
 * Deleting the tail is not: each row's hash commits to its PREDECESSORS and
 * never to its successors, so `DELETE FROM safety_audit WHERE rowid > anchor`
 * leaves `{ ok: true, rowsChecked: 0 }` — byte-for-byte the same answer a
 * freshly-migrated database gives. An agent runs as the operator's uid, so it
 * can issue that DELETE against `~/.cebab/cebab.sqlite` and leave verification
 * reporting healthy. `safety_audit.ts` documented this as a known gap and
 * named the fix; this module is it.
 *
 * The fix is a commitment kept somewhere the DELETE does not reach. On every
 * append we add one line to `~/.cebab/audit-tip.jsonl` naming the new tip row
 * and how many rows the chain then held. At verification time a mirror that
 * describes MORE chain than the database contains is truncation.
 *
 * ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
 * It does not make the audit log tamper-proof, and nothing here should be read
 * as claiming that. The mirror is a file owned by the same user as the
 * database; an agent that knows about it can delete or rewrite it too. What
 * changes is the cost and the noise:
 *
 *   - The realistic attack — SQL against `cebab.sqlite`, or swapping the file
 *     out — no longer verifies clean.
 *   - Erasing the trail takes three coordinated actions: the rows, this file,
 *     and the `settings` flag that records mirroring was ever established.
 *   - Doing only the rows is caught (`tail_truncated`); doing only this file is
 *     caught (`tip_mirror_missing`), because of that flag.
 *
 * Cebab-5y4t is why the third is named. That sentence used to say two actions
 * in two places, and it was false: `verifyChain` scoped its commitment to the
 * CURRENT anchor's rowid, which is `MAX(rowid) WHERE kind='audit.chain_reset'`
 * — a value inside the database being corroborated. Moving that row to a new
 * highest rowid put every real row below it, so nothing was verified, no line
 * named the new anchor, and the whole log could then be deleted while
 * verification reported healthy. Worse, the resulting `rowsChecked: 0` also
 * disarmed the `tip_mirror_missing` branch, so this file could be deleted for
 * free afterwards. `verifyChain` now requires the rows every PRIOR generation
 * committed to to still be present and to still hash to what was committed, and
 * the missing-mirror branch no longer consults `rowsChecked` at all.
 *
 * Cebab-lf1u closed the residual Cebab-5y4t left explicit: a BARE re-seat, with
 * nothing removed or rewritten, still verified clean because the survival check
 * finds every committed row intact and the digest walk covers nothing. Each
 * mirror line now also records the anchor's ID (`anchorId`) — a migration
 * inserts a marker with a NEW id, a re-seat relocates an EXISTING one — and
 * `verifyChain` reports `anchor_reseated` when the current top anchor's id was
 * committed by some line but never at the rowid it now occupies. It helps only
 * installs whose mirror already holds a tagged line, and does not beat an
 * attacker who relocates the anchor back to a committed rowid.
 *
 * A determined same-uid attacker who does both, in the right order, still
 * wins. Closing that needs a commitment the operator's own account cannot
 * rewrite — a remote witness, an append-only device, an OS-enforced log — all
 * of which are out of scope for a single-user local tool. This raises the bar;
 * it does not end the game.
 *
 * ── THE UPGRADE BOUNDARY ───────────────────────────────────────────────────
 * An install that predates this module has rows but no mirror, and the first
 * commitment it writes describes whatever the chain holds AT THAT MOMENT. So
 * a truncation performed before the first post-upgrade audit event is blessed
 * rather than caught, and the window closes at the next safety event (measured
 * ~32/day, so typically under an hour). Nothing here can do better: the
 * evidence for "rows used to exist" is exactly what the mirror was introduced
 * to create, and it cannot be created retroactively.
 */

/** Marks that mirroring has been established, so a later absence is a signal
 *  rather than an upgrade artifact. Lives in the `settings` table (no
 *  migration needed — the table predates this). */
const MIRROR_ESTABLISHED_KEY = 'safety_audit.tip_mirror_established';

/** One JSON object per line, newest last. Append-only by construction: this
 *  module opens it with 'a' and exports nothing that truncates or rewrites. */
export function auditTipPath(): string {
  return path.join(config.dataDir, 'audit-tip.jsonl');
}

/** One mirrored commitment. `count` is rows strictly after the anchor at the
 *  moment of the append — the quantity truncation reduces. */
export type AuditTipEntry = {
  ts: number;
  rowId: string;
  hashSelf: string;
  count: number;
  /**
   * SQLite rowid of the chain-reset anchor this `count` is relative to, at the
   * moment of the append. It scopes the count to one anchor GENERATION: a
   * migration inserts a fresh marker (a NEW rowid, even when it reuses the
   * marker's `id`, e.g. `chain-reset-023`) and the count legitimately restarts
   * near zero under it. `verifyChain` takes the maximum count for the CURRENT
   * anchor's rowid, so a post-truncation append cannot lower that high-water
   * mark and a re-anchor cannot inherit the old anchor's. Absent on entries
   * written before this field existed — see `readMaxTipForAnchor`.
   */
  anchorRowid?: number;
  /**
   * Cebab-lf1u [security]: the `id` of the chain-reset anchor this line was
   * committed under (the marker at `anchorRowid`). This is the datum
   * `anchorRowid` alone could not supply — the mirror recorded WHERE the anchor
   * was but not WHICH anchor it was, so "a marker was added" (a legitimate
   * migration, always a NEW id) could not be told from "a marker moved" (a
   * re-seat: the SAME id relocated to a new highest rowid). `verifyChain`
   * reports `anchor_reseated` when the current top anchor's id was committed by
   * some mirror line but never at the rowid it now occupies — i.e. an existing
   * anchor was relocated rather than a fresh one inserted. Committing the id
   * rather than a count resists padding the marker tally with a junk row and
   * shuffling other markers into the vacated rowid; only relocating the anchor
   * BACK undoes the signal. Absent on entries written before this field
   * existed; an install whose mirror holds no tagged line cannot be protected
   * this way (the documented "new format only" limit of Cebab-lf1u).
   */
  anchorId?: string;
};

/**
 * Append one commitment. Never throws.
 *
 * Best-effort ON PURPOSE, and the opposite of the dispatcher's dual-write
 * (where a failed audit append aborts the caller). There, refusing to proceed
 * protects the record. Here, refusing would DESTROY it: a full disk or a
 * read-only home directory would turn every safety event into a hard failure
 * and Cebab would stop recording anything at all. The row in SQLite is the
 * obligation; this mirror is the corroboration, so it fails loud and open —
 * the same posture `forensic_snapshot.ts` takes for the same reason.
 */
export function appendAuditTip(entry: AuditTipEntry): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    // POSIX-only: `mode: 0o600` keeps the mirror owner-readable, matching
    // `auth.ts`'s treatment of the auth token. Windows ignores POSIX mode bits
    // (Node maps only the write bit to the read-only attribute), so it carries
    // no ACL guarantee there — a documented residual, not an enforcement.
    // Either way this is CONFIDENTIALITY, not integrity: it does not stop a
    // same-uid write, which is exactly the attacker this module cannot beat.
    const opts = process.platform === 'win32' ? {} : ({ mode: 0o600 } as const);
    fs.appendFileSync(auditTipPath(), JSON.stringify(entry) + '\n', opts);
  } catch (err) {
    // Loud: a silently-unwritten mirror would leave the operator believing in
    // a protection that stopped working.
    console.error('[audit_tip] could not append chain tip mirror', err);
  }
}

/**
 * Read the newest commitment, or `null` if there is no usable mirror.
 *
 * Reads the whole file — at the observed rate (~32 audit rows/day) a year is
 * roughly 12k short lines, well under a megabyte. Tolerates a torn final line
 * (a crash mid-append) by scanning backwards for the last parseable entry
 * rather than failing the whole read: a partial write is a crash artifact, not
 * evidence of tampering, and treating it as tampering would cry wolf.
 */
export function readLatestAuditTip(): AuditTipEntry | null {
  let text: string;
  try {
    text = fs.readFileSync(auditTipPath(), 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as AuditTipEntry;
      if (typeof parsed?.rowId === 'string' && typeof parsed?.count === 'number') return parsed;
    } catch {
      // Torn or garbage line — keep walking back.
    }
  }
  return null;
}

/**
 * The largest commitment the mirror holds for a given anchor — the entry with
 * the greatest `count` among lines tagged with `anchorRowid`, or `null` when
 * the mirror names no commitment for this anchor.
 *
 * WHY THE MAX, NOT THE NEWEST LINE. `readLatestAuditTip` returns only the last
 * line, which a tail truncation defeats: delete the tail, and the next ordinary
 * safety event appends a fresh commitment whose `count` was recomputed from the
 * already-shortened table — a small number. Comparing the surviving chain
 * against only that line finds it no shorter than its own post-truncation
 * commitment and reports clean, so the chain self-heals over its own erasure.
 * The high-water mark across every line for THIS anchor cannot be lowered by
 * appending a smaller one, so the earlier, larger commitment still catches it.
 *
 * WHY PER ANCHOR (BY ROWID). A migration inserts a fresh chain-reset marker and
 * the count legitimately restarts near zero under it; a plain repo-wide max
 * would read the pre-migration high-water mark as a permanent truncation. The
 * discriminator is the anchor's ROWID, not its id: a migration may reuse the
 * marker id (`chain-reset-023`) at a new, higher rowid, and only the rowid tells
 * the new generation from the old.
 *
 * Legacy entries lacking `anchorRowid` are skipped rather than counted against
 * the current anchor — attributing them to an anchor they were not written
 * under is exactly the false alarm this guards against. That reopens the
 * documented upgrade window (see the header) for one anchor generation, until
 * the first append under the new build re-commits with a tagged line.
 */
/**
 * Every commitment the mirror holds, in file order, torn or garbage lines
 * skipped. One parse implementation for all three readers — `readLatestAuditTip`
 * and `readMaxTipForAnchor` both used to carry their own copy of the same
 * validation, which is two more places for "what counts as a usable line" to
 * drift apart.
 *
 * Returns `[]` when the mirror is absent or unreadable; callers separate
 * "no mirror" from "mirror disagrees" themselves, because those mean different
 * things (see `checkAgainstTipMirror`).
 */
export function readAuditTipEntries(): AuditTipEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(auditTipPath(), 'utf8');
  } catch {
    return [];
  }
  const out: AuditTipEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as AuditTipEntry;
      if (typeof parsed?.rowId === 'string' && typeof parsed?.count === 'number') out.push(parsed);
    } catch {
      // Torn or garbage line — a crash artifact, not evidence of tampering.
    }
  }
  return out;
}

/**
 * The high-water commitment for each anchor GENERATION the mirror has seen —
 * the entry with the greatest `count` per distinct `anchorRowid`, with legacy
 * untagged entries grouped under their own key.
 *
 * Cebab-5y4t: these are the rows the mirror asserts once existed, across every
 * generation rather than only the current one. `verifyChain` requires each to
 * still be present and unchanged, which is what makes re-seating the anchor
 * stop being a way to shrink the verified range to nothing and then erase what
 * fell outside it.
 */
export function highWaterTipsPerAnchor(entries: readonly AuditTipEntry[]): AuditTipEntry[] {
  const best = new Map<string, AuditTipEntry>();
  for (const e of entries) {
    // `undefined` is its own generation, not a wildcard: a legacy untagged line
    // must not be attributed to a tagged anchor it was not written under.
    const key = e.anchorRowid === undefined ? 'legacy' : String(e.anchorRowid);
    const prev = best.get(key);
    if (!prev || e.count > prev.count) best.set(key, e);
  }
  return [...best.values()];
}

export function readMaxTipForAnchor(anchorRowid: number): AuditTipEntry | null {
  let best: AuditTipEntry | null = null;
  for (const entry of readAuditTipEntries()) {
    if (entry.anchorRowid !== anchorRowid) continue;
    if (best === null || entry.count > best.count) best = entry;
  }
  return best;
}

/** Whether this installation has ever written a mirror. */
export function isMirrorEstablished(): boolean {
  return getSetting<boolean>(MIRROR_ESTABLISHED_KEY) === true;
}

/** Record that mirroring is live, so a later missing file is suspicious. */
export function markMirrorEstablished(): void {
  setSetting(MIRROR_ESTABLISHED_KEY, true);
}

/** Test-only: forget the flag so a case can exercise the first-boot path. */
export const _testing = { MIRROR_ESTABLISHED_KEY };
