import type Database from "better-sqlite3";
import { getDb } from "../db.js";

export type ProjectRow = {
  id: number;
  name: string;
  path: string;
  trusted: number;
  created_at: number;
  last_used_at: number | null;
};

export function upsertProject(name: string, path: string): ProjectRow {
  const db = getDb();
  const existing = findProjectByPath(path);
  if (existing) return existing;
  const now = Date.now();
  const result = db
    .prepare(
      "INSERT INTO projects (name, path, trusted, created_at, last_used_at) VALUES (?, ?, 0, ?, NULL)",
    )
    .run(name, path, now);
  return getProject(Number(result.lastInsertRowid))!;
}

export function getProject(id: number): ProjectRow | undefined {
  return getDb().prepare<[number], ProjectRow>("SELECT * FROM projects WHERE id = ?").get(id);
}

export function findProjectByPath(path: string): ProjectRow | undefined {
  return getDb()
    .prepare<[string], ProjectRow>("SELECT * FROM projects WHERE path = ?")
    .get(path);
}

export function listProjects(): ProjectRow[] {
  return getDb()
    .prepare<[], ProjectRow>("SELECT * FROM projects ORDER BY last_used_at DESC NULLS LAST, name ASC")
    .all();
}

export function setProjectTrusted(id: number, trusted: boolean): void {
  getDb().prepare("UPDATE projects SET trusted = ? WHERE id = ?").run(trusted ? 1 : 0, id);
}

export function touchProject(id: number, db: Database.Database = getDb()): void {
  db.prepare("UPDATE projects SET last_used_at = ? WHERE id = ?").run(Date.now(), id);
}
