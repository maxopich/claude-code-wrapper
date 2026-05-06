import { getDb } from '../db.js';

export type SessionRow = {
  id: string;
  project_id: number;
  title: string | null;
  created_at: number;
  last_event_at: number;
  total_cost_usd: number;
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
