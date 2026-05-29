/**
 * Cluster I Phase C5 (UI_Findings spec §4.3): handler for the
 * `bulk_session_op` ClientMsg + the 7-day soft-delete purge cron.
 *
 * Two operator surfaces converge here:
 *
 *   1. **`executeBulkSessionOp`** — invoked from `ws/server.ts` when the
 *      operator hits Archive / Delete on a multi-row selection in the
 *      sidebar (the C5 UI slice ships the selection mode). The handler
 *      validates each id (exists + not running), flips the row, writes
 *      a `safety_audit` entry per actual change, and replies with a
 *      `bulk_session_op_result` envelope listing succeeded + failed ids.
 *
 *   2. **`runSessionPurge`** — invoked from `index.ts` on boot AND on a
 *      6-hour interval. Hard-deletes rows whose `deleted_at` is older
 *      than 7 days (the operator's undo window), cascade-deletes their
 *      `events`, and rm-rf's the on-disk JSONL log per session. The
 *      `safety_audit` rows that the original delete wrote are NEVER
 *      touched — that's the spec §7 audit-preservation invariant: even
 *      after the row + the log are gone, the audit lineage survives.
 *
 * Audit pattern. Per-session `appendSafetyAudit` rows (not dispatcher
 * notifications). This matches the `control_verbs.ts` precedent for
 * operator-authority actions: the row gets written for forensics, but
 * we don't fan a sticky safety toast per session — the operator already
 * sees the single `bulk_session_op_result` reply. Toasting N times for
 * an N-session bulk op would be hostile UX.
 *
 * Idempotence. Re-archiving an already-archived row is a no-op success;
 * re-deleting an already-soft-deleted row likewise. The audit row is
 * only written when an actual state flip happens, so a duplicated
 * click from a stale UI doesn't double-stamp the audit.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ClientMsg, ServerMsg } from '@cebab/shared';
import { config } from './config.js';
import { snapshotInFlight } from './runner/lifecycle.js';
import { appendSafetyAudit } from './notifications/safety_audit.js';
import {
  archiveSession,
  getSession,
  hardDeleteSession,
  listSoftDeletedSessionsOlderThan,
  softDeleteSession,
} from './repo/sessions.js';

/**
 * 7-day soft-delete undo window per spec §4.3. Rows whose `deleted_at`
 * is older than this get hard-deleted by `runSessionPurge`. Exported so
 * tests can reach in + override via a re-export wrapper without monkey-
 * patching modules.
 */
export const SESSION_PURGE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Cadence for the boot + interval purge. 6 hours balances "purge runs
 * often enough that a row is gone within a quarter day of expiring its
 * undo window" against "we don't hammer SQLite for a low-traffic clean-
 * up task". The boot run + interval combination means a long-uptime
 * server still purges; a server that bounces frequently also purges on
 * each restart.
 */
export const SESSION_PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Build the path to a session's JSONL log under `~/.cebab/logs/`. The
 * same shape `session_log_export.ts` uses; we don't import that one to
 * keep this module's surface focused on the bulk-op concerns.
 */
function jsonlPathFor(sessionId: string): string {
  return path.join(config.logsDir, `${sessionId}.jsonl`);
}

/**
 * Reject a sessionId per the spec's enumerated reasons. Inline factory
 * keeps the result-building call sites readable.
 */
function rejection(
  sessionId: string,
  reason: 'running' | 'unknown' | 'already_archived' | 'already_deleted' | 'write_failed',
  message: string,
): {
  sessionId: string;
  reason: 'running' | 'unknown' | 'already_archived' | 'already_deleted' | 'write_failed';
  message: string;
} {
  return { sessionId, reason, message };
}

/**
 * Narrowing helper for the union member we care about. ws/server.ts's
 * case body uses the narrowed `msg` directly, but the executor needs to
 * extract just the bulk-op fields for testability without the full
 * ClientMsg envelope shape.
 */
export type BulkSessionOpInput = Extract<ClientMsg, { type: 'bulk_session_op' }>;

/**
 * Cluster I Phase C5: implement `bulk_session_op` per spec §4.3. Pure-
 * ish per the testability pattern from `executeArchiveSession`: side
 * effects are DB writes, optional fs rm, and the single `send` callback
 * that ships `bulk_session_op_result`.
 *
 * Behaviour:
 *
 *   - Empty `sessionIds`: replies with an empty success envelope. (The
 *     UI shouldn't send this, but defending against a stray empty
 *     selection keeps the handler resilient.)
 *
 *   - For each id, we check the in-flight registry FIRST so a still-
 *     running session can't be archived/deleted out from under itself.
 *     Then we check existence. Both rejections produce per-id `failed`
 *     entries; the rest of the batch proceeds (partial-success per
 *     spec §4.3).
 *
 *   - Op-specific:
 *      - `archive`: flips `archived = 1` via `archiveSession`. Already-
 *        archived rows resolve as succeeded (idempotent intent).
 *      - `delete`: stamps `deleted_at = now`. Already-soft-deleted rows
 *        resolve as succeeded (idempotent). When `removeArtifacts ===
 *        true`, the JSONL log at `~/.cebab/logs/<sid>.jsonl` is rm-rf'd
 *        BEST-EFFORT — an ENOENT/EACCES is logged but doesn't roll back
 *        the DB write (the row is the authoritative state).
 *
 *   - Audit row is appended via `appendSafetyAudit` ONLY when a real
 *     state flip occurs. Idempotent no-ops don't double-stamp. The row
 *     carries `kind: 'session.bulk_op'`, `reason_code: 'archive' |
 *     'delete'`, and a payload with the per-op metadata; the
 *     `operator_id` is resolved inside `appendSafetyAudit` from
 *     `getOperatorId()`.
 *
 *   - `removedArtifacts` in the reply is true iff at least one
 *     succeeded delete actually rm-rf'd a log (i.e. the file existed
 *     and was deletable). The C5 UI flips toast copy on this signal.
 */
export async function executeBulkSessionOp(args: {
  msg: BulkSessionOpInput;
  send: (msg: ServerMsg) => void;
}): Promise<void> {
  const { msg, send } = args;
  const op = msg.op;
  const removeArtifacts = msg.removeArtifacts === true && op === 'delete';

  // Build a set of currently-running session ids for O(1) lookups during
  // the per-id loop. snapshotInFlight() includes single-agent runs (kind:
  // 'single') AND bus runs (kind: 'bus-worker'/'orchestrator'); we filter
  // to single since this handler only operates on `sessions` rows, but
  // for safety we also reject bus session ids that happen to match (the
  // operator shouldn't be able to send a bus sid here, but defending
  // against a future client bug keeps the running invariant tight).
  const runningSet = new Set(snapshotInFlight().map((m) => m.sessionId));

  const succeededSessionIds: string[] = [];
  const failed: Array<ReturnType<typeof rejection>> = [];
  let removedArtifactsAny = false;
  const now = Date.now();

  for (const sessionId of msg.sessionIds) {
    if (runningSet.has(sessionId)) {
      failed.push(
        rejection(
          sessionId,
          'running',
          'Session is still running — Stop or End it first, then retry the bulk op.',
        ),
      );
      continue;
    }

    const row = getSession(sessionId);
    if (!row) {
      failed.push(rejection(sessionId, 'unknown', 'No such session.'));
      continue;
    }

    if (op === 'archive') {
      if (row.archived === 1) {
        // Idempotent: archive intent already satisfied. No audit row —
        // nothing changed.
        succeededSessionIds.push(sessionId);
        continue;
      }
      const flipped = archiveSession(sessionId);
      if (!flipped) {
        // Race: another conn (or a re-stamp via the C2 export) flipped
        // the row between our SELECT and our UPDATE. Either way the
        // operator's archive intent is satisfied — treat as success.
        succeededSessionIds.push(sessionId);
        continue;
      }
      try {
        appendSafetyAudit({
          ts: now,
          sessionId,
          parentSessionId: null,
          agentId: null,
          kind: 'session.bulk_op',
          reasonCode: 'archive',
          payload: {
            op: 'archive',
            count: msg.sessionIds.length,
            removeArtifacts: false,
          },
        });
      } catch (err) {
        // Audit append failure is logged but doesn't roll back the row
        // flip — the operator's intent has already executed. The
        // safety_audit table's chain remains intact (the failing append
        // doesn't write a partial row).
        console.error(`[bulk_session_op] safety_audit append failed for ${sessionId}`, err);
      }
      succeededSessionIds.push(sessionId);
      continue;
    }

    // op === 'delete'
    if (row.deleted_at !== null) {
      // Idempotent: already soft-deleted. No audit row — and skip
      // artifact-rm because the row's already in the purge queue.
      succeededSessionIds.push(sessionId);
      continue;
    }
    const flipped = softDeleteSession(sessionId, now);
    if (!flipped) {
      // Race; same posture as archive — succeed idempotently.
      succeededSessionIds.push(sessionId);
      continue;
    }

    if (removeArtifacts) {
      const logPath = jsonlPathFor(sessionId);
      try {
        // `unlink` (not `rm`) so ENOENT throws — we want the
        // "no file existed" path NOT to set `removedArtifactsAny`. The
        // wire flag means "the JSONL was actually deleted from disk", so
        // a session that never produced events (no JSONL on disk)
        // resolves with `removedArtifactsAny` left untouched. Toast
        // copy on the C5 UI side branches on this signal.
        await fsp.unlink(logPath);
        removedArtifactsAny = true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          // EACCES / EISDIR / other I/O — log + move on. The DB write
          // has succeeded; the row is in the soft-delete queue and the
          // purge cron will retry the unlink at the 7-day boundary if
          // the row sticks around (best-effort cleanup). Most often
          // the operator can resolve the permission issue out-of-band.
          console.error(`[bulk_session_op] unlink ${logPath} for ${sessionId} failed`, err);
        }
        // ENOENT is the common "session produced no events" path —
        // silent.
      }
    }

    try {
      appendSafetyAudit({
        ts: now,
        sessionId,
        parentSessionId: null,
        agentId: null,
        kind: 'session.bulk_op',
        reasonCode: 'delete',
        payload: {
          op: 'delete',
          count: msg.sessionIds.length,
          removeArtifacts,
        },
      });
    } catch (err) {
      console.error(`[bulk_session_op] safety_audit append failed for ${sessionId}`, err);
    }
    succeededSessionIds.push(sessionId);
  }

  send({
    type: 'bulk_session_op_result',
    op,
    succeededSessionIds,
    failed,
    removedArtifacts: removedArtifactsAny,
  });
}

/**
 * Cluster I Phase C5: hard-delete every session row whose `deleted_at`
 * fell more than `SESSION_PURGE_AFTER_MS` ago, cascade-deleting its
 * `events`, then rm the on-disk JSONL log. Returns the count of rows
 * actually removed for telemetry/observability.
 *
 * Two-stage: list IDs FIRST, then per-ID delete + fs rm. Doing it
 * piecewise lets a single bad row (permission issue on its log file)
 * fail in isolation rather than blocking the whole batch. The DB
 * delete is the source of truth — if it succeeds, the row is gone,
 * even if the subsequent fs rm fails (the cron will not re-attempt
 * because the row is no longer in the deleted-cutoff query).
 *
 * The `safety_audit` rows written when the soft-delete originally
 * happened survive this purge — that's the load-bearing invariant of
 * spec §7. We do NOT issue a `DELETE FROM safety_audit WHERE sessionId
 * IN (purged)`; the table is append-only by design.
 *
 * The optional `nowMs` parameter exists only so tests can pin a
 * deterministic cutoff; production callers omit it.
 */
export async function runSessionPurge(nowMs: number = Date.now()): Promise<number> {
  const cutoff = nowMs - SESSION_PURGE_AFTER_MS;
  const ids = listSoftDeletedSessionsOlderThan(cutoff);
  let purged = 0;
  for (const id of ids) {
    let rowsRemoved: number;
    try {
      rowsRemoved = hardDeleteSession(id);
    } catch (err) {
      // A SQLite-level error on the cascade delete (e.g. database busy
      // mid-write) leaves the row in place; the next cron tick will
      // retry. Log so the operator can correlate if this becomes a
      // pattern.
      console.error(`[bulk_session_op] hardDeleteSession failed for ${id}`, err);
      continue;
    }
    if (rowsRemoved === 0) {
      // Row vanished between list + delete (another cron instance? a
      // crash mid-purge?). Either way no work to do.
      continue;
    }
    purged += 1;
    // Fire-and-forget log rm — the DB row is the source of truth for
    // purge status, so a fs failure here doesn't re-queue the work.
    // We swallow ENOENT via `force: true` so the common "already
    // removed by the operator's removeArtifacts opt-in" path is silent.
    const logPath = jsonlPathFor(id);
    try {
      await fsp.rm(logPath, { force: true });
    } catch (err) {
      console.error(`[bulk_session_op] rm ${logPath} failed during purge`, err);
    }
  }
  return purged;
}

/**
 * Cluster I Phase C5: schedule the 7-day soft-delete purge as a
 * background heartbeat. Fires once on the next event-loop tick (so the
 * server's boot path is unblocked) AND every
 * `SESSION_PURGE_INTERVAL_MS` thereafter.
 *
 * Returns a disposer that stops the interval — the server's SIGINT/
 * SIGTERM handler can call it for a clean shutdown so the timer doesn't
 * keep the event loop alive past `closeAllQueries()`. The disposer is
 * idempotent: calling it after a previous stop is a no-op.
 *
 * The cron is `.unref()`'d so it doesn't pin the process if the server
 * is otherwise idle; the explicit disposer is the polite shutdown path,
 * `.unref()` is the rude one for when nobody calls dispose.
 */
export function startSessionPurgeCron(): () => void {
  // First tick: kick the purge once. Wrapped in `void` because the
  // Promise's resolution shape isn't part of the cron contract — the
  // result is the side effect on the DB.
  void runSessionPurge().catch((err) => {
    console.error('[bulk_session_op] boot purge failed', err);
  });

  const handle = setInterval(() => {
    void runSessionPurge().catch((err) => {
      console.error('[bulk_session_op] interval purge failed', err);
    });
  }, SESSION_PURGE_INTERVAL_MS);
  handle.unref();

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(handle);
  };
}
