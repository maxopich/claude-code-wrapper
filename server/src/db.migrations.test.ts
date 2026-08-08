import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from './config.js';
import { closeDb, getDb } from './db.js';

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
