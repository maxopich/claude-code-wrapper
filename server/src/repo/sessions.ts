import type { SessionPermissionMode } from '@cebab/shared/protocol';
import { isSessionPermissionMode } from '@cebab/shared/protocol';
import { getDb } from '../db.js';

export type SessionRow = {
  id: string;
  project_id: number;
  title: string | null;
  created_at: number;
  last_event_at: number;
  total_cost_usd: number;
  permission_mode: string | null;
};

export function createSession(
  id: string,
  projectId: number,
  title: string | null = null,
): SessionRow {
  const now = Date.now();
  getDb()
    .prepare(
      'INSERT INTO sessions (id, project_id, title, created_at, last_event_at, total_cost_usd) VALUES (?, ?, ?, ?, ?, 0)',
    )
    .run(id, projectId, title, now, now);
  return getSession(id)!;
}

export function getSession(id: string): SessionRow | undefined {
  return getDb().prepare<[string], SessionRow>('SELECT * FROM sessions WHERE id = ?').get(id);
}

export function listSessionsForProject(projectId: number): SessionRow[] {
  return getDb()
    .prepare<
      [number],
      SessionRow
    >('SELECT * FROM sessions WHERE project_id = ? ORDER BY last_event_at DESC')
    .all(projectId);
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
