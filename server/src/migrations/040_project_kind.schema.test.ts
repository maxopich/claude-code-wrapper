// Schema pin for 040 (Cebab-8x8.1.1). Every migration since 023 ships one, and
// `npm run smoke` applies migrations but asserts nothing, so this file is the
// ONLY shape gate for the fail-closed `kind` discriminator.
//
// Two properties are load-bearing and each has a case below: the DEFAULT is
// 'workspace' (so every existing row keeps behaving as a workspace project),
// and `projects_kind_singleton` is a PARTIAL unique index (so many workspace
// rows coexist while any non-workspace kind is a singleton). Drop the DEFAULT
// and the migration fails on a non-empty table; drop the `WHERE` and every
// second workspace project collides.
import { beforeEach, describe, expect, test } from 'vitest';
import { closeDb, getDb } from '../db.js';
import { withTempDataDir } from '../test_support/temp_data_dir.js';

type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: string | null };

let seq = 0;
/** Insert a fresh project, letting the column default apply when `kind` is null. */
function insertProject(kind: string | null): void {
  seq += 1;
  if (kind === null) {
    getDb()
      .prepare('INSERT INTO projects (name, path, created_at) VALUES (?, ?, ?)')
      .run(`p${seq}`, `/tmp/p${seq}`, 1);
  } else {
    getDb()
      .prepare('INSERT INTO projects (name, path, kind, created_at) VALUES (?, ?, ?, ?)')
      .run(`p${seq}`, `/tmp/p${seq}`, kind, 1);
  }
}

describe('040_project_kind', () => {
  withTempDataDir('project-kind');
  beforeEach(() => {
    seq = 0;
  });

  test("kind column is TEXT NOT NULL DEFAULT 'workspace'", () => {
    const cols = getDb().prepare<[], ColumnInfo>('PRAGMA table_info(projects)').all();
    const kind = cols.find((c) => c.name === 'kind');
    expect(kind).toBeDefined();
    expect(kind!.type).toBe('TEXT');
    // NOT NULL: a row with no kind must be impossible, or the positive
    // `WHERE kind = 'workspace'` filters would silently drop it.
    expect(kind!.notnull).toBe(1);
    // The DEFAULT is what backfills every existing row to 'workspace'. Matched
    // with a regex because SQLite renders a text default with or without the
    // surrounding quotes depending on version.
    expect(kind!.dflt_value).toMatch(/^'workspace'$|^workspace$/);
  });

  test('a project inserted with no kind backfills to workspace', () => {
    insertProject(null);
    const row = getDb()
      .prepare<[], { kind: string }>('SELECT kind FROM projects ORDER BY id DESC LIMIT 1')
      .get();
    expect(row?.kind).toBe('workspace');
  });

  test('projects_kind_singleton is a UNIQUE PARTIAL index on kind', () => {
    const list = getDb()
      .prepare<[], { name: string; unique: number; partial: number }>(
        `PRAGMA index_list('projects')`,
      )
      .all();
    const idx = list.find((i) => i.name === 'projects_kind_singleton');
    expect(idx).toBeDefined();
    expect(idx!.unique).toBe(1);
    // Partial: without the WHERE it would index every row and the many
    // workspace projects would all collide on the first duplicate.
    expect(idx!.partial).toBe(1);

    const cols = getDb()
      .prepare<[], { name: string }>(`PRAGMA index_info('projects_kind_singleton')`)
      .all()
      .map((c) => c.name);
    expect(cols).toEqual(['kind']);

    // Pin the predicate itself: the exclusion of 'workspace' is exactly what
    // makes duplicate workspace rows legal while forbidding a duplicate anything
    // else. A future edit that broadened it would slip past the column check.
    const sql = getDb()
      .prepare<[], { sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'projects_kind_singleton'`,
      )
      .get()?.sql;
    expect(sql).toMatch(/where\s+kind\s*<>\s*'workspace'/i);
  });

  test('five workspace rows coexist but a second assistant row is refused', () => {
    for (let i = 0; i < 5; i++) expect(() => insertProject('workspace')).not.toThrow();
    expect(() => insertProject('assistant')).not.toThrow();
    // The partial singleton bites here: the assistant kind is unique.
    expect(() => insertProject('assistant')).toThrow(/UNIQUE constraint failed/);
  });

  // Not an idempotence test: the runner SKIPS a filename already in
  // `schema_migrations`, so the body never re-executes. Reopening must not
  // re-apply and must not throw.
  test('the runner applies 040 exactly once — reopening skips it', () => {
    closeDb();
    expect(() => getDb()).not.toThrow();
    const sm = getDb()
      .prepare<[], { n: number }>(
        `SELECT COUNT(*) AS n FROM schema_migrations WHERE filename = '040_project_kind.sql'`,
      )
      .get();
    expect(sm?.n).toBe(1);
  });
});
