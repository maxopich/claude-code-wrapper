import type Database from 'better-sqlite3';
import { getDb } from '../db.js';

export type ProjectRow = {
  id: number;
  name: string;
  path: string;
  trusted: number;
  missing: number;
  created_at: number;
  last_used_at: number | null;
  /** 1 if this project has had bus integration installed (PR 1). */
  bus_installed: number;
  /** Filesystem-safe agent slug captured at install time. NULL if not installed. */
  bus_agent_name: string | null;
  /**
   * Cluster G Phase 4 (D6/D11): one-shot TOFU decision for the bus
   * install. NULL means "never asked" (first-seen path emits
   * `bus_auto_install_pending` and blocks). 'trusted' / 'denied' are
   * persistent; revocation back to NULL is operator action through the
   * Authority Panel (parallel to mcp_trust revocation). Migration 024
   * backfills 'trusted' for any project that was already
   * `bus_installed=1` at the time the gate was added, so pre-gate users
   * aren't re-prompted for a bus that has been running for them.
   */
  bus_trust_decision: BusTrustDecision | null;
};

/**
 * The two decisions the operator can persist for the bus install gate.
 * 'deny_once' is in-memory only (cleared on WS disconnect), so it never
 * appears as a column value.
 */
export type BusTrustDecision = 'trusted' | 'denied';

export function upsertProject(name: string, path: string): ProjectRow {
  const db = getDb();
  const existing = findProjectByPath(path);
  if (existing) {
    if (existing.missing === 1) {
      db.prepare('UPDATE projects SET missing = 0 WHERE id = ?').run(existing.id);
      return { ...existing, missing: 0 };
    }
    return existing;
  }
  const now = Date.now();
  const result = db
    .prepare(
      'INSERT INTO projects (name, path, trusted, missing, created_at, last_used_at) VALUES (?, ?, 0, 0, ?, NULL)',
    )
    .run(name, path, now);
  return getProject(Number(result.lastInsertRowid))!;
}

export function getProject(id: number): ProjectRow | undefined {
  return getDb().prepare<[number], ProjectRow>('SELECT * FROM projects WHERE id = ?').get(id);
}

export function findProjectByPath(path: string): ProjectRow | undefined {
  return getDb().prepare<[string], ProjectRow>('SELECT * FROM projects WHERE path = ?').get(path);
}

/** Lists only projects whose directories are still present on disk. */
export function listProjects(): ProjectRow[] {
  return getDb()
    .prepare<
      [],
      ProjectRow
    >('SELECT * FROM projects WHERE missing = 0 ORDER BY last_used_at DESC NULLS LAST, name ASC')
    .all();
}

export function markProjectsMissingByPaths(paths: string[]): void {
  if (paths.length === 0) return;
  const db = getDb();
  const stmt = db.prepare('UPDATE projects SET missing = 1 WHERE path = ?');
  db.transaction(() => {
    for (const p of paths) stmt.run(p);
  })();
}

export function listProjectPaths(): string[] {
  return getDb()
    .prepare<[], { path: string }>('SELECT path FROM projects')
    .all()
    .map((r) => r.path);
}

export function setProjectTrusted(id: number, trusted: boolean): void {
  getDb()
    .prepare('UPDATE projects SET trusted = ? WHERE id = ?')
    .run(trusted ? 1 : 0, id);
}

export function touchProject(id: number, db: Database.Database = getDb()): void {
  db.prepare('UPDATE projects SET last_used_at = ? WHERE id = ?').run(Date.now(), id);
}

/**
 * Cluster G Phase 4 (D6/D11): read the persisted bus-install trust decision.
 * Returns `null` for unknown projects (so callers don't need a second
 * existence check; a missing project will fail at the install step
 * anyway) and for projects that have never been asked.
 */
export function getProjectBusTrust(id: number): BusTrustDecision | null {
  const row = getDb()
    .prepare<[number], { bus_trust_decision: string | null }>(
      'SELECT bus_trust_decision FROM projects WHERE id = ?',
    )
    .get(id);
  if (!row) return null;
  if (row.bus_trust_decision === 'trusted' || row.bus_trust_decision === 'denied') {
    return row.bus_trust_decision;
  }
  return null;
}

/**
 * Cluster G Phase 4 (D6/D11): write the persisted bus-install trust decision.
 * Pass `null` to clear (operator revocation via the Authority Panel).
 * No-op for missing projects — the UPDATE silently matches 0 rows.
 */
export function setProjectBusTrust(id: number, decision: BusTrustDecision | null): void {
  getDb()
    .prepare('UPDATE projects SET bus_trust_decision = ? WHERE id = ?')
    .run(decision, id);
}
