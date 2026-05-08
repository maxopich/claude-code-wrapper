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
};

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
