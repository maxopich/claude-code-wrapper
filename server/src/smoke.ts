/**
 * Migration smoke: apply every migration to a BRAND NEW database and check
 * that all of them landed.
 *
 * Two things were wrong with this script, and they compounded (register C16).
 *
 * It opened `config.dataDir` — the operator's real `~/.cebab`. On CI that is
 * harmless because the runner is ephemeral, which is exactly why it went
 * unnoticed; run locally it migrated and mutated the developer's actual
 * database. That is not hypothetical: it is what moved this repo's real
 * `cebab.sqlite` ctime while the C16 fix was being written, with no other
 * trace, because SQLite's WAL files are created and removed again.
 *
 * And it asserted nothing — it printed the applied migrations and exited 0.
 * Against a database that had ALREADY been migrated by every previous run,
 * the interesting case (a migration that does not apply cleanly to a fresh
 * schema) could not arise: the runner skips anything already in
 * `schema_migrations`. So the check that existed to prove migrations apply
 * from scratch was, locally, structurally unable to do that.
 *
 * Now: a fresh temp directory per run, and an assertion that the number of
 * applied migrations equals the number of `.sql` files on disk. Adding a
 * migration that throws, or one the runner cannot see, fails the script.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Must be set BEFORE ./db.js is imported: config.ts reads CEBAB_DATA_DIR once,
// at module init. A static `import` would be hoisted above this assignment, so
// the db import below is deliberately dynamic.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-smoke-'));
process.env.CEBAB_DATA_DIR = path.join(tmpRoot, '.cebab');

const { closeDb, getDb } = await import('./db.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The migrations the runner will look for — same two-location lookup db.ts
 *  does, because tsx runs from src/ and the built output runs from dist/. */
function migrationFilesOnDisk(): string[] {
  const dirs = [
    path.join(__dirname, 'migrations'),
    path.join(__dirname, '..', 'src', 'migrations'),
  ];
  const dir = dirs.find((d) => fs.existsSync(d));
  if (!dir) throw new Error(`No migrations directory found. Tried: ${dirs.join(', ')}`);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

try {
  const db = getDb();
  const applied = db
    .prepare<[], { filename: string }>('SELECT filename FROM schema_migrations ORDER BY filename')
    .all()
    .map((r) => r.filename);
  const onDisk = migrationFilesOnDisk();

  // Anti-vacuity: an empty migrations directory would make the equality below
  // pass on nothing, which is the shape this whole rewrite exists to remove.
  if (onDisk.length === 0) {
    throw new Error('smoke: found zero migration files on disk — the lookup is wrong');
  }

  const missing = onDisk.filter((f) => !applied.includes(f));
  if (missing.length > 0) {
    throw new Error(
      `smoke: ${missing.length} migration(s) on disk were not applied: ${missing.join(', ')}`,
    );
  }
  if (applied.length !== onDisk.length) {
    throw new Error(
      `smoke: ${applied.length} migrations applied but ${onDisk.length} exist on disk ` +
        `(applied rows not on disk: ${applied.filter((f) => !onDisk.includes(f)).join(', ')})`,
    );
  }

  const tables = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    )
    .all()
    .map((r) => r.name);

  console.log(`smoke: ${applied.length}/${onDisk.length} migrations applied to a fresh database`);
  console.log(`smoke: ${tables.length} tables present`);
  closeDb();
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
