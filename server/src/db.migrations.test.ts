import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from './config.js';
import { closeDb, getDb, resolveMigrationsDir } from './db.js';
import { checkAppliedMigrationHashes, hashMigrationSql } from './migration_integrity.js';

/**
 * The migration runner's contract, which eight `*.schema.test.ts` files lean on
 * without stating (register C10).
 *
 * Each of those has a test that reopens the database and asserts it does not
 * throw, under the name "migration runner is idempotent". It is not testing
 * idempotence: `applyMigrations` skips any filename already in
 * `schema_migrations`, so reopening never re-executes the migration body. The
 * test could not fail for the reason its name gives.
 *
 * AND THE PROPERTY IT NAMED IS NOT ONE THIS CODEBASE HAS. Measured while fixing
 * C10: applying all 31 migrations to a fresh database and then re-applying each
 * one directly, ZERO survive — `duplicate column name`, `table already exists`.
 * SQLite's `ALTER TABLE … ADD COLUMN` cannot be made conditional in plain DDL,
 * so migrations are not written to be re-runnable and should not be. C10's
 * suggested fix — delete the bookkeeping row, then reopen — would have turned
 * all eight tests red with nothing to repair.
 *
 * The real contract is EXACTLY-ONCE, and it is what makes non-re-runnable
 * migrations safe. That is what this file asserts, in the one place it belongs
 * rather than eight times in files about individual schemas.
 */

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-migrations-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

type MigrationRow = { filename: string; applied_at: number };

function ledger(): MigrationRow[] {
  return getDb()
    .prepare<[], MigrationRow>(
      'SELECT filename, applied_at FROM schema_migrations ORDER BY filename',
    )
    .all();
}

describe('migration runner — applied exactly once', () => {
  test('reopening the database applies nothing and rewrites nothing', () => {
    const before = ledger();
    // Anti-vacuity: if discovery ever broke, `before` would be empty and every
    // comparison below would trivially hold. It must contain a real ledger.
    expect(before.length).toBeGreaterThan(20);

    closeDb();
    expect(() => getDb()).not.toThrow();

    const after = ledger();
    // Same filenames AND the same `applied_at` stamps. The timestamps are the
    // load-bearing half: a re-applied migration would either throw inside the
    // transaction or re-INSERT with a fresh stamp, and only comparing names
    // would miss the second.
    expect(after).toEqual(before);
  });

  test('reopening repeatedly stays a no-op', () => {
    const before = ledger();
    for (let i = 0; i < 3; i += 1) {
      closeDb();
      getDb();
    }
    expect(ledger()).toEqual(before);
  });

  test('every .sql file on disk is recorded, and nothing else is', () => {
    // The skip is keyed on the filename, so a file that never got recorded
    // would be re-applied on every single open — the failure mode this
    // contract exists to prevent.
    const dir = path.join(__dirname, 'migrations');
    const onDisk = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(onDisk.length).toBeGreaterThan(20);
    expect(ledger().map((r) => r.filename)).toEqual(onDisk);
  });

  test('the ledger key rejects a duplicate record', () => {
    // The primary key is the mechanism behind exactly-once. If it were ever
    // relaxed to a plain column, a double-apply would record silently instead
    // of failing loudly.
    const first = ledger()[0]!;
    expect(() =>
      getDb()
        .prepare('INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)')
        .run(first.filename, first.applied_at + 1),
    ).toThrow(/UNIQUE|PRIMARY KEY|constraint/i);
  });
});

/**
 * Cebab-x1n.7.31 — the ledger now records WHAT it applied, not just that it
 * applied something. Exactly-once (above) is what makes non-re-runnable
 * migrations safe; this is what makes the record of them honest.
 */
describe('migration runner — the ledger records content, not just a filename', () => {
  function shas(): Array<{ filename: string; content_sha: string | null }> {
    return getDb()
      .prepare<[], { filename: string; content_sha: string | null }>(
        'SELECT filename, content_sha FROM schema_migrations ORDER BY filename',
      )
      .all();
  }

  test('every applied migration records a content hash', () => {
    const rows = shas();
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.filter((r) => r.content_sha === null)).toEqual([]);
  });

  test('the recorded hash matches the file the runner actually read', () => {
    // Not a tautology check of hashMigrationSql against itself: this reads the
    // bytes off disk independently and confirms the ledger agrees.
    const dir = resolveMigrationsDir();
    for (const row of shas()) {
      const sql = fs.readFileSync(path.join(dir, row.filename), 'utf8');
      expect(row.content_sha, row.filename).toBe(hashMigrationSql(sql));
    }
  });

  test('the shipped corpus reports no drift against itself', () => {
    // The control for the whole feature: a fresh, untouched install must be
    // clean. If this ever goes red on main, a migration was edited after
    // shipping and that is exactly what the check is for.
    const result = checkAppliedMigrationHashes(getDb(), resolveMigrationsDir());
    expect(result.drifted).toEqual([]);
    expect(result.missingOnDisk).toEqual([]);
    expect(result.adopted).toEqual([]); // fresh install records on apply, never adopts
    expect(result.verified).toBe(shas().length);
  });

  test('reopening the database does not rewrite the hashes', () => {
    const before = shas();
    closeDb();
    getDb();
    expect(shas()).toEqual(before);
  });

  test('the column is added to a pre-existing two-column ledger, and adopted', () => {
    // The upgrade path, end to end: a database created before this shipped has
    // the old two-column table and no hashes at all. Rebuild exactly that
    // shape — keeping every filename, so the runner still skips all 33 and we
    // are testing the upgrade rather than a re-apply — then reopen.
    const db = getDb();
    const names = db
      .prepare<[], { filename: string }>('SELECT filename FROM schema_migrations')
      .all()
      .map((r) => r.filename);
    db.exec('DROP TABLE schema_migrations');
    db.exec(
      'CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
    );
    const ins = db.prepare('INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)');
    for (const n of names) ins.run(n, 1);
    closeDb();

    // Reopening runs ensureMigrationsTable against the old shape.
    const cols = getDb()
      .prepare<[string], { name: string }>('SELECT name FROM pragma_table_info(?)')
      .all('schema_migrations')
      .map((c) => c.name);
    expect(cols).toContain('content_sha');

    // Every row is NULL at this point — the runner records on APPLY, and these
    // were all skipped. That is precisely the population adopt-on-first-sight
    // exists for.
    expect(shas().every((r) => r.content_sha === null)).toBe(true);

    const adopt = checkAppliedMigrationHashes(getDb(), resolveMigrationsDir());
    expect(adopt.adopted.length).toBe(names.length);
    expect(adopt.drifted).toEqual([]);

    // And the second pass verifies rather than re-adopting.
    const second = checkAppliedMigrationHashes(getDb(), resolveMigrationsDir());
    expect(second.adopted).toEqual([]);
    expect(second.verified).toBe(names.length);
  });
});
