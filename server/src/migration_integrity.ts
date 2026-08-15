/**
 * Does the migration on disk still match the one this database applied?
 *
 * WHAT WAS MISSING. `applyMigrations` skips a file when its FILENAME is in
 * `schema_migrations`. Nothing read the content. So editing a shipped `.sql`
 * produced a silent, permanent split: existing installs keep the old schema
 * forever (the filename is recorded, so the runner skips it), fresh installs
 * get the new one, and both report an identical ledger. The symptom is a bug
 * report that only reproduces on one machine, with nothing anywhere to explain
 * why.
 *
 * WHY THE HASH IS OVER NORMALIZED SQL AND NOT OVER BYTES. Six shipped
 * migrations in this repo have already been edited — 011, 015, 016, 021, 027,
 * 028 — and **every one of those edits was comment-only** (five in #303
 * correcting stale bus-safety claims, one in #327 appending a D09 correction
 * note). A byte hash would have flagged all six on every existing install the
 * day it shipped, for edits that were deliberate and changed no schema. It
 * would also outlaw the practice that produced them: #327 deliberately left
 * 016's SQL alone and appended a pointer note, which is the right way to
 * correct a migration whose comment has gone stale. Comments are free; a
 * changed statement is not.
 *
 * SCOPE, STATED HONESTLY. Adoption is on first sight (see
 * `checkAppliedMigrationHashes`), so an edit made BEFORE this shipped cannot be
 * detected — the pre-edit bytes are gone and no hash of them was ever recorded.
 * This protects the future, not the past.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { emit as emitNotification } from './notifications/dispatcher.js';

/**
 * Strip `--` comments to end of line, collapse all whitespace runs to one
 * space, trim. Two files differing only in commentary or indentation hash
 * equal; any change to a statement does not.
 *
 * DELIBERATELY SIMPLE, AND THE SIMPLIFICATION IS GUARDED. This does not
 * tokenise SQL, so it would mis-handle a `--` inside a string literal or a
 * `/* *\/` block comment. Neither exists anywhere in the current corpus — it
 * was checked, not assumed — and `migration_integrity.test.ts` asserts that
 * over every `.sql` file on disk, so the day someone writes one the premise
 * fails loudly instead of quietly hashing the wrong thing.
 */
export function normalizeSql(sql: string): string {
  return sql
    .split(/\r?\n/)
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/** sha256 of the normalized SQL, hex. Same primitive as `hook_trust` / `mcp_trust`. */
export function hashMigrationSql(sql: string): string {
  return createHash('sha256').update(normalizeSql(sql), 'utf8').digest('hex');
}

export type MigrationDrift = {
  filename: string;
  /** The hash recorded when this database applied the file. */
  recorded: string;
  /** The hash of the file as it is on disk now. */
  onDisk: string;
};

export type MigrationIntegrityResult = {
  /** Files whose recorded hash no longer matches disk. Empty is the good case. */
  drifted: MigrationDrift[];
  /** Applied rows that had no recorded hash and just adopted the current one. */
  adopted: string[];
  /** Applied rows whose `.sql` is no longer on disk — reported, never adopted. */
  missingOnDisk: string[];
  /** How many applied rows carried a hash and matched. */
  verified: number;
};

/**
 * Compare every applied migration's recorded hash against the file on disk.
 *
 * ADOPT ON FIRST SIGHT. A row with a NULL hash is one applied before this
 * check existed. We record the current hash rather than warning: warning would
 * fire once for every migration on every existing install, which is noise that
 * teaches the operator to ignore the check — the failure mode #329 was about.
 * Adoption gives that database a baseline from this boot onward. The honest
 * limitation is in the module header: an edit made before adoption is
 * undetectable.
 *
 * A file that is applied but no longer on disk is reported separately and
 * never adopted — that is a different problem (a deleted migration) and
 * silently recording "no hash" for it would hide it.
 *
 * Pure apart from the reads and the adoption write; the caller decides what a
 * drift means, exactly as `verifyChain` leaves the reporting to `index.ts`.
 */
export function checkAppliedMigrationHashes(
  db: Database.Database,
  migrationsDir: string,
): MigrationIntegrityResult {
  const rows = db
    .prepare<[], { filename: string; content_sha: string | null }>(
      'SELECT filename, content_sha FROM schema_migrations ORDER BY filename',
    )
    .all();

  const drifted: MigrationDrift[] = [];
  const adopted: string[] = [];
  const missingOnDisk: string[] = [];
  let verified = 0;

  const record = db.prepare('UPDATE schema_migrations SET content_sha = ? WHERE filename = ?');

  for (const row of rows) {
    const full = path.join(migrationsDir, row.filename);
    let sql: string;
    try {
      sql = fs.readFileSync(full, 'utf8');
    } catch {
      missingOnDisk.push(row.filename);
      continue;
    }
    const onDisk = hashMigrationSql(sql);
    if (row.content_sha === null) {
      record.run(onDisk, row.filename);
      adopted.push(row.filename);
      continue;
    }
    if (row.content_sha === onDisk) {
      verified += 1;
      continue;
    }
    drifted.push({ filename: row.filename, recorded: row.content_sha, onDisk });
  }

  return { drifted, adopted, missingOnDisk, verified };
}

/**
 * The whole boot-time behaviour behind one call, mirroring
 * `runDataPermsBootCheck` — `main()` is not reachable from a unit test, and a
 * sequence written inline there could silently lose a step.
 *
 * WARN, DO NOT REFUSE, and the precedent is the check this sits beside:
 * `verifyChain` reports a broken audit chain — a strictly more alarming
 * condition — and still boots. Refusing here would lock a single-user local
 * app out of its own transcripts with no in-app recovery, and would fire on
 * anyone who legitimately hand-patched their database. The operator is the
 * only person who can act on this; taking the app away from them is not how
 * to tell them.
 *
 * The emit is inline and NOT injected, matching `reportInsecureDataDir`. The
 * S10 gate in `safety_emit_result.test.ts` classifies every dispatcher call by
 * reading the `class:` literal beside it and deliberately FAILS rather than
 * skips one it cannot classify; taking the dispatcher as a parameter would
 * move that literal out of its sight, which the gate would be right to reject.
 * Tests drive this against a real temp data dir instead.
 */
export function runMigrationIntegrityBootCheck(args: {
  db: Database.Database;
  migrationsDir: string;
}): MigrationIntegrityResult {
  const result = checkAppliedMigrationHashes(args.db, args.migrationsDir);

  if (result.adopted.length > 0) {
    // First boot after this shipped: rows applied before the check existed had
    // no hash and just took the current one. Not a problem — but it is also
    // the moment those files stop being checkable retroactively, so say it.
    console.log(`[cebab] migration ledger: adopted ${result.adopted.length} baseline hash(es)`);
  }

  if (result.drifted.length === 0 && result.missingOnDisk.length === 0) {
    console.log(`[cebab] migration ledger ok (${result.verified} verified)`);
    return result;
  }

  const message = describeMigrationDrift(result);
  console.error(`[cebab] migration ledger DRIFT — ${message}`);
  const emitted = emitNotification(
    {
      severity: 'danger',
      class: 'safety',
      dedupeKey: 'schema.migration_drift',
      title: 'A migration on disk differs from the one this database applied',
      message,
      reasonCode: 'migration_content_drift',
      auditKind: 'schema.migration_drift',
      auditPayload: { drifted: result.drifted, missingOnDisk: result.missingOnDisk },
    },
    () => {},
  );
  if (!emitted.ok) {
    console.error(`[cebab] could not record migration drift: ${emitted.error}`);
  }
  return result;
}

/**
 * One operator-facing sentence per problem. Kept next to the check (rather
 * than in `index.ts`) for the reason `describeChainFailure` is shared: the
 * boot path and any future re-verify surface must not describe the same
 * condition differently.
 */
export function describeMigrationDrift(result: MigrationIntegrityResult): string {
  const parts: string[] = [];
  if (result.drifted.length > 0) {
    const names = result.drifted.map((d) => d.filename).join(', ');
    parts.push(
      `${result.drifted.length} applied migration(s) differ from the file on disk (${names}). ` +
        `This database kept the schema those files had when it applied them; a fresh install ` +
        `would get the current ones. The two are now different databases reporting the same ledger.`,
    );
  }
  if (result.missingOnDisk.length > 0) {
    parts.push(
      `${result.missingOnDisk.length} applied migration(s) are no longer on disk ` +
        `(${result.missingOnDisk.join(', ')}).`,
    );
  }
  return parts.join(' ');
}
