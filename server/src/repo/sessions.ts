import type { SessionPermissionMode } from '@cebab/shared/protocol';
import { isSessionPermissionMode } from '@cebab/shared/protocol';
import { config } from '../config.js';
import { getDb } from '../db.js';

export type SessionRow = {
  id: string;
  project_id: number;
  title: string | null;
  created_at: number;
  last_event_at: number;
  total_cost_usd: number;
  permission_mode: string | null;
  /** Cluster G Phase 1 (A3): 1 iff this session was created under MOCK
   *  runtime mode. Stamped at INSERT time from `config.mock`; immutable
   *  after creation. The UI's MockBadge variants (deferred to Phase 2)
   *  read this so a historical session still shows the MOCK tag long
   *  after the server has been restarted under live mode. */
  mock: number;
  /** Cluster I Phase C5 (migration 025): 1 iff the operator has archived
   *  this session via `bulk_session_op { op: 'archive' }`. Excluded from
   *  the default `listSessionsForProject` query — the C5 UI slice will
   *  add an "Include archived" toggle for visibility. 0 for every
   *  pre-025 row + freshly-created session. */
  archived: number;
  /** Cluster I Phase C5 (migration 025): soft-delete timestamp (ms epoch).
   *  Stamped by `bulk_session_op { op: 'delete' }`. Excluded from the
   *  default `listSessionsForProject` query. The 7-day purge cron in
   *  `bulk_session_op.ts` hard-deletes rows where this is older than
   *  7d. NULL means "not soft-deleted" (the common case). */
  deleted_at: number | null;
};

export function createSession(
  id: string,
  projectId: number,
  title: string | null = null,
): SessionRow {
  const now = Date.now();
  // Read `config.mock` once at INSERT time. The flag is fixed at server
  // boot per R-G2 (we don't honor mid-process MOCK flips), so reading it
  // here is equivalent to reading at module load — but doing it here keeps
  // tests that mutate `config.mock` between `createSession` calls honest.
  const mock = config.mock ? 1 : 0;
  getDb()
    .prepare(
      'INSERT INTO sessions (id, project_id, title, created_at, last_event_at, total_cost_usd, mock) VALUES (?, ?, ?, ?, ?, 0, ?)',
    )
    .run(id, projectId, title, now, now, mock);
  return getSession(id)!;
}

export function getSession(id: string): SessionRow | undefined {
  return getDb().prepare<[string], SessionRow>('SELECT * FROM sessions WHERE id = ?').get(id);
}

/**
 * List sessions for a project, defaulting to the operator-visible set:
 * archived rows AND soft-deleted rows are excluded so the sidebar shows
 * the "active history" only. Pass `includeArchived: true` to also surface
 * archived rows (Cluster I C5 UI's "Include archived" toggle will use
 * this). Soft-deleted rows are NEVER surfaced through this function —
 * they're queryable via `listSoftDeletedSessions` for the purge cron's
 * use only, and a soft-deleted-with-undo recovery surface is deferred to
 * a future slice if operator demand materializes.
 *
 * Migration 025 added the `archived` + `deleted_at` columns; the WHERE
 * clause filters on both. Pre-025 rows have `archived = 0` and
 * `deleted_at = NULL` by column defaults, so they project unchanged.
 */
export function listSessionsForProject(
  projectId: number,
  opts?: { includeArchived?: boolean },
): SessionRow[] {
  const includeArchived = opts?.includeArchived === true;
  if (includeArchived) {
    return getDb()
      .prepare<
        [number],
        SessionRow
      >('SELECT * FROM sessions WHERE project_id = ? AND deleted_at IS NULL ORDER BY last_event_at DESC')
      .all(projectId);
  }
  return getDb()
    .prepare<
      [number],
      SessionRow
    >('SELECT * FROM sessions WHERE project_id = ? AND archived = 0 AND deleted_at IS NULL ORDER BY last_event_at DESC')
    .all(projectId);
}

/**
 * Cluster I Phase C5: flip a session's `archived` column to 1. Used by
 * the `bulk_session_op { op: 'archive' }` handler. Idempotent — a 0-row
 * UPDATE returns `false` but the caller treats both as success (operator
 * intent is satisfied).
 *
 * Does NOT touch `deleted_at` — archiving and soft-deleting are
 * orthogonal: an archived row can still be soft-deleted, and the purge
 * cron honors `deleted_at` regardless of `archived`. The dedicated
 * helpers below also leave the other column alone.
 *
 * Returns true iff the row existed AND was flipped 0→1.
 */
export function archiveSession(id: string): boolean {
  const result = getDb()
    .prepare<
      [string],
      unknown
    >('UPDATE sessions SET archived = 1 WHERE id = ? AND archived = 0 AND deleted_at IS NULL')
    .run(id);
  return result.changes > 0;
}

/**
 * Cluster I Phase C5: stamp `deleted_at` with the supplied timestamp
 * (default `Date.now()`). Used by the `bulk_session_op { op: 'delete' }`
 * handler — the row sticks around for the 7-day undo window, then the
 * purge cron hard-deletes it.
 *
 * The `ts` parameter exists so tests can pin a deterministic value; in
 * production, callers omit it and we use wall-clock now. Returns true
 * iff the row existed AND wasn't already soft-deleted (idempotent —
 * re-deleting an already-soft-deleted row is a no-op so the original
 * "deleted at" timestamp is preserved).
 */
export function softDeleteSession(id: string, ts: number = Date.now()): boolean {
  const result = getDb()
    .prepare<
      [number, string],
      unknown
    >('UPDATE sessions SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(ts, id);
  return result.changes > 0;
}

/**
 * Cluster I Phase C5: list session IDs whose `deleted_at` falls before
 * the supplied cutoff. Used by the purge cron only; returns just the
 * IDs (not full rows) because the only downstream operation is the
 * cascade hard-delete + JSONL rm.
 *
 * Sorted by `deleted_at ASC` so the cron processes the oldest first
 * (matters when the cron itself has a per-call cap and would otherwise
 * starve the longest-overdue rows).
 */
export function listSoftDeletedSessionsOlderThan(cutoffMs: number): string[] {
  return getDb()
    .prepare<[number], { id: string }>(
      'SELECT id FROM sessions WHERE deleted_at IS NOT NULL AND deleted_at < ? ORDER BY deleted_at ASC',
    )
    .all(cutoffMs)
    .map((r) => r.id);
}

/**
 * Cluster I Phase C5: hard-delete a session row + its events. The purge
 * cron calls this for each ID returned by `listSoftDeletedSessionsOlderThan`.
 * Wraps both deletes in a transaction so a half-finished purge can't
 * orphan events.
 *
 * The on-disk JSONL log at `~/.cebab/logs/<id>.jsonl` is NOT removed by
 * this helper — the cron does that separately (logs are a filesystem
 * concern, not a DB one; the file may also not exist if the session
 * never produced events, and we don't want an FS failure to roll back
 * the DB delete).
 *
 * Returns the number of session rows actually removed (0 or 1).
 *
 * IMPORTANT: this does NOT touch the `safety_audit` table. Audit rows
 * are append-only (BE-1 invariant) and explicitly survive session
 * deletion per spec §7 — the audit lineage is the only surviving record
 * after the purge fires.
 */
export function hardDeleteSession(id: string): number {
  const db = getDb();
  const tx = db.transaction((sessionId: string) => {
    db.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId);
    const info = db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return info.changes as number;
  });
  return tx(id) as number;
}

export function bumpSession(id: string, totalCostUsdDelta = 0): void {
  getDb()
    .prepare(
      'UPDATE sessions SET last_event_at = ?, total_cost_usd = total_cost_usd + ? WHERE id = ?',
    )
    .run(Date.now(), totalCostUsdDelta, id);
}

export function setSessionCost(id: string, totalCostUsd: number): void {
  getDb()
    .prepare('UPDATE sessions SET last_event_at = ?, total_cost_usd = ? WHERE id = ?')
    .run(Date.now(), totalCostUsd, id);
}

/** Read the user's last in-session mode preference, or null if unset. */
export function getSessionPermissionMode(id: string): SessionPermissionMode | null {
  const row = getSession(id);
  if (!row) return null;
  return isSessionPermissionMode(row.permission_mode) ? row.permission_mode : null;
}

/** Persist the user's in-session mode preference; survives across turns. */
export function setSessionPermissionMode(id: string, mode: SessionPermissionMode): void {
  getDb().prepare('UPDATE sessions SET permission_mode = ? WHERE id = ?').run(mode, id);
}

/**
 * Rename a session. Pass null to clear the title (UI then falls back to the
 * short session id). Caller is responsible for length/whitespace normalization
 * — we just write what we're given.
 */
export function setSessionTitle(id: string, title: string | null): void {
  getDb().prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id);
}
