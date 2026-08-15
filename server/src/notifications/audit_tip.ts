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
 *   - Erasing the trail now takes two coordinated actions in two places.
 *   - Skipping the second is caught (`tail_truncated`); doing only the second
 *     is also caught (`tip_mirror_missing`), because the database records that
 *     mirroring was established.
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
