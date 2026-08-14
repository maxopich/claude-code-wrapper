/**
 * Cebab-x1n.7.31. The migration runner keyed on FILENAME and never read the
 * file, so editing a shipped `.sql` split installs silently. These cases pin
 * the normalizer's contract, the corpus assumption it rests on, and the
 * adopt-then-protect behaviour of the ledger check.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import {
  checkAppliedMigrationHashes,
  describeMigrationDrift,
  hashMigrationSql,
  normalizeSql,
  runMigrationIntegrityBootCheck,
} from './migration_integrity.js';
import { getDb, resolveMigrationsDir } from './db.js';
import { withTempDataDir } from './test_support/temp_data_dir.js';

describe('normalizeSql', () => {
  test('a comment-only difference hashes EQUAL', () => {
    // The case that forced normalization over a byte hash: six shipped
    // migrations in this repo have been edited, and all six edits were
    // comment-only. A byte hash would have flagged every one.
    const a = 'CREATE TABLE t (id INTEGER);';
    const b = '-- a note added later\nCREATE TABLE t (id INTEGER); -- and a trailing one';
    expect(hashMigrationSql(a)).toBe(hashMigrationSql(b));
  });

  test('a whitespace-only difference hashes EQUAL', () => {
    const a = 'CREATE TABLE t (id INTEGER);';
    const b = '  CREATE   TABLE\n  t (id    INTEGER);  \n';
    expect(hashMigrationSql(a)).toBe(hashMigrationSql(b));
  });

  test('a changed column name hashes DIFFERENT', () => {
    const a = 'CREATE TABLE t (id INTEGER);';
    const b = 'CREATE TABLE t (identifier INTEGER);';
    expect(hashMigrationSql(a)).not.toBe(hashMigrationSql(b));
  });

  test('an ADDED statement hashes DIFFERENT', () => {
    const a = 'CREATE TABLE t (id INTEGER);';
    const b = 'CREATE TABLE t (id INTEGER);\nCREATE INDEX t_id ON t(id);';
    expect(hashMigrationSql(a)).not.toBe(hashMigrationSql(b));
  });

  test('a trailing comment is stripped without eating its statement', () => {
    // The obvious way to get this wrong is to drop the whole line.
    expect(normalizeSql('ALTER TABLE t ADD COLUMN c TEXT; -- why')).toBe(
      'ALTER TABLE t ADD COLUMN c TEXT;',
    );
  });

  test('CRLF and LF hash equal', () => {
    // Windows CI checks out CRLF for files with no .gitattributes rule; the
    // ledger must not report drift purely from a line ending.
    expect(hashMigrationSql('CREATE TABLE t (id INTEGER);\nCREATE INDEX i ON t(id);')).toBe(
      hashMigrationSql('CREATE TABLE t (id INTEGER);\r\nCREATE INDEX i ON t(id);'),
    );
  });
});

describe('the corpus assumption the simple normalizer rests on', () => {
  // `normalizeSql` does not tokenise SQL, so it would mis-handle a `--` inside
  // a string literal or a /* block */ comment. Neither exists today. This
  // asserts that over every file on disk, so the day one is written the
  // premise fails loudly rather than silently hashing the wrong thing.
  const dir = resolveMigrationsDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));

  test('there is a corpus to check', () => {
    // Anti-vacuity: an empty file list would make both cases below pass
    // without examining anything.
    expect(files.length).toBeGreaterThan(30);
  });

  test('no migration contains a block comment', () => {
    const offenders = files.filter((f) => {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      // Strip line comments first — `plans/**` inside a `--` comment is not a
      // block comment, and 012 contains exactly that.
      return /\/\*/.test(normalizeSql(sql));
    });
    expect(offenders).toEqual([]);
  });

  test('no migration contains a string literal holding --', () => {
    const offenders = files.filter((f) => {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      return /'[^'\n]*--[^'\n]*'/.test(normalizeSql(sql));
    });
    expect(offenders).toEqual([]);
  });
});

/**
 * A hand-built ledger over an in-memory database — no `getDb()`, no real data
 * dir, no migrations actually applied. The check only reads
 * `schema_migrations` and the files named in it, so this exercises exactly the
 * production path with a corpus the test controls.
 */
function ledgerDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE schema_migrations (
     filename    TEXT PRIMARY KEY,
     applied_at  INTEGER NOT NULL,
     content_sha TEXT
   )`);
  return db;
}

function writeMigration(dir: string, name: string, sql: string): void {
  fs.writeFileSync(path.join(dir, name), sql, 'utf8');
}

describe('checkAppliedMigrationHashes', () => {
  const ORIGINAL = 'CREATE TABLE widget (id INTEGER PRIMARY KEY);';

  function scratchDir(): string {
    // `os.tmpdir()`, not `process.env.TMPDIR`: TMPDIR is POSIX-only, so on
    // Windows this fell back to `/tmp` — a path that does not exist there —
    // and every case using it threw. Caught by CI on windows-2022 while
    // ubuntu stayed green.
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-ledger-'));
  }

  test('an untouched ledger reports nothing', () => {
    // THE CONTROL. Without it, the drift case below would also pass on a
    // checker that flagged everything.
    const dir = scratchDir();
    writeMigration(dir, '001_a.sql', ORIGINAL);
    const db = ledgerDb();
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(
      '001_a.sql',
      1,
      hashMigrationSql(ORIGINAL),
    );

    const r = checkAppliedMigrationHashes(db, dir);
    expect(r.drifted).toEqual([]);
    expect(r.missingOnDisk).toEqual([]);
    expect(r.verified).toBe(1);
  });

  test('a changed STATEMENT is reported as drift — the finding', () => {
    const dir = scratchDir();
    writeMigration(dir, '001_a.sql', ORIGINAL);
    const db = ledgerDb();
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(
      '001_a.sql',
      1,
      hashMigrationSql(ORIGINAL),
    );

    writeMigration(dir, '001_a.sql', 'CREATE TABLE widget (id INTEGER PRIMARY KEY, extra TEXT);');

    const r = checkAppliedMigrationHashes(db, dir);
    expect(r.drifted.map((d) => d.filename)).toEqual(['001_a.sql']);
    expect(r.verified).toBe(0);
  });

  test('a changed COMMENT is NOT reported — the measured design constraint', () => {
    // This is what keeps #303's and #327's edits legal, and it is the half a
    // byte hash would have failed.
    const dir = scratchDir();
    writeMigration(dir, '001_a.sql', ORIGINAL);
    const db = ledgerDb();
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(
      '001_a.sql',
      1,
      hashMigrationSql(ORIGINAL),
    );

    writeMigration(dir, '001_a.sql', `-- CORRECTION (register D09)\n${ORIGINAL}`);

    const r = checkAppliedMigrationHashes(db, dir);
    expect(r.drifted).toEqual([]);
    expect(r.verified).toBe(1);
  });

  test('a NULL hash ADOPTS the current one and does not warn', () => {
    const dir = scratchDir();
    writeMigration(dir, '001_a.sql', ORIGINAL);
    const db = ledgerDb();
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?, NULL)').run('001_a.sql', 1);

    const r = checkAppliedMigrationHashes(db, dir);
    expect(r.adopted).toEqual(['001_a.sql']);
    expect(r.drifted).toEqual([]);

    const row = db
      .prepare<[], { content_sha: string | null }>('SELECT content_sha FROM schema_migrations')
      .get();
    expect(row!.content_sha).toBe(hashMigrationSql(ORIGINAL));
  });

  test('after adopting, the NEXT check catches a statement edit', () => {
    // "Adopts silently" and "protects afterwards" are different claims, so
    // they get separate assertions. This is the second half.
    const dir = scratchDir();
    writeMigration(dir, '001_a.sql', ORIGINAL);
    const db = ledgerDb();
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?, NULL)').run('001_a.sql', 1);

    checkAppliedMigrationHashes(db, dir); // adopt
    writeMigration(dir, '001_a.sql', 'CREATE TABLE widget (id TEXT PRIMARY KEY);');

    const second = checkAppliedMigrationHashes(db, dir);
    expect(second.adopted).toEqual([]);
    expect(second.drifted.map((d) => d.filename)).toEqual(['001_a.sql']);
  });

  test('an applied file missing from disk is reported, never adopted', () => {
    const dir = scratchDir();
    const db = ledgerDb();
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?, NULL)').run('001_gone.sql', 1);

    const r = checkAppliedMigrationHashes(db, dir);
    expect(r.missingOnDisk).toEqual(['001_gone.sql']);
    // Adopting "no hash" for a deleted migration would hide a real problem.
    expect(r.adopted).toEqual([]);
  });

  test('drift in one file does not stop the others being checked', () => {
    const dir = scratchDir();
    writeMigration(dir, '001_a.sql', ORIGINAL);
    writeMigration(dir, '002_b.sql', 'CREATE TABLE gadget (id INTEGER);');
    const db = ledgerDb();
    const ins = db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)');
    ins.run('001_a.sql', 1, hashMigrationSql(ORIGINAL));
    ins.run('002_b.sql', 2, hashMigrationSql('CREATE TABLE gadget (id INTEGER);'));

    writeMigration(dir, '001_a.sql', 'CREATE TABLE widget (id TEXT);');

    const r = checkAppliedMigrationHashes(db, dir);
    expect(r.drifted.map((d) => d.filename)).toEqual(['001_a.sql']);
    expect(r.verified).toBe(1); // 002 still verified
  });
});

describe('describeMigrationDrift', () => {
  test('names the drifted files', () => {
    const msg = describeMigrationDrift({
      drifted: [{ filename: '016_mcp_trust.sql', recorded: 'aaa', onDisk: 'bbb' }],
      adopted: [],
      missingOnDisk: [],
      verified: 0,
    });
    expect(msg).toContain('016_mcp_trust.sql');
    expect(msg).toContain('same ledger');
  });

  test('a clean result describes nothing', () => {
    expect(
      describeMigrationDrift({ drifted: [], adopted: [], missingOnDisk: [], verified: 5 }),
    ).toBe('');
  });
});

/**
 * The boot path, driven against a REAL temp data dir. The emit is inline in
 * `runMigrationIntegrityBootCheck` (not injected) because the S10 gate reads
 * the `class:` literal at the call site — so the notification is asserted the
 * way it actually lands, by reading the table `emit()` writes to.
 */
describe('runMigrationIntegrityBootCheck — warn, do not refuse', () => {
  withTempDataDir('cebab-ledger-boot-');

  /** A copy of the real migrations dir, so one file can be edited safely. */
  function copyMigrations(): string {
    const src = resolveMigrationsDir();
    const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-migdir-'));
    for (const f of fs.readdirSync(src).filter((n) => n.endsWith('.sql'))) {
      fs.copyFileSync(path.join(src, f), path.join(dst, f));
    }
    return dst;
  }

  function driftRows(): number {
    return getDb()
      .prepare<[], { n: number }>(
        "SELECT COUNT(*) AS n FROM notifications WHERE dedupe_key = 'schema.migration_drift'",
      )
      .get()!.n;
  }

  test('a clean install logs ok and emits NOTHING', () => {
    // THE CONTROL. Without it, "emitted once" below would also pass on a check
    // that emitted on every boot regardless of state — a permanent false alarm.
    const r = runMigrationIntegrityBootCheck({
      db: getDb(),
      migrationsDir: resolveMigrationsDir(),
    });
    expect(r.drifted).toEqual([]);
    expect(r.verified).toBeGreaterThan(30);
    expect(driftRows()).toBe(0);
  });

  test('a STATEMENT edit emits one safety notification and DOES NOT THROW', () => {
    // The decision this bead asked to be recorded: warn, do not refuse to boot.
    // Asserted rather than left to a comment, because a later edit could
    // quietly turn this into a throw and nothing else would notice.
    const dir = copyMigrations();
    const victim = '001_init.sql';
    fs.appendFileSync(path.join(dir, victim), '\nCREATE TABLE injected (id INTEGER);\n', 'utf8');

    let result: ReturnType<typeof runMigrationIntegrityBootCheck> | undefined;
    expect(() => {
      result = runMigrationIntegrityBootCheck({ db: getDb(), migrationsDir: dir });
    }).not.toThrow();

    expect(result!.drifted.map((d) => d.filename)).toEqual([victim]);
    expect(driftRows()).toBe(1);

    const row = getDb()
      .prepare<[], { severity: string; class: string; reason_code: string; message: string }>(
        "SELECT severity, class, reason_code, message FROM notifications WHERE dedupe_key = 'schema.migration_drift'",
      )
      .get()!;
    expect(row.severity).toBe('danger');
    expect(row.class).toBe('safety');
    expect(row.reason_code).toBe('migration_content_drift');
    expect(row.message).toContain(victim);
  });

  test('the drift also lands in the hash-chained audit log', () => {
    // `emit()`'s safety contract is that the audit row is written BEFORE the
    // notification ships. Asserting only the notification would not show that
    // half happened.
    const dir = copyMigrations();
    fs.appendFileSync(path.join(dir, '001_init.sql'), '\nCREATE TABLE x (i INTEGER);\n', 'utf8');
    runMigrationIntegrityBootCheck({ db: getDb(), migrationsDir: dir });

    const audits = getDb()
      .prepare<[], { kind: string }>(
        "SELECT kind FROM safety_audit WHERE kind = 'schema.migration_drift'",
      )
      .all();
    expect(audits).toHaveLength(1);
  });

  test('a COMMENT edit emits nothing — the measured design constraint, end to end', () => {
    const dir = copyMigrations();
    fs.appendFileSync(path.join(dir, '001_init.sql'), '\n-- a later correction note\n', 'utf8');

    const r = runMigrationIntegrityBootCheck({ db: getDb(), migrationsDir: dir });
    expect(r.drifted).toEqual([]);
    expect(driftRows()).toBe(0);
  });
});
