import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { precreateDbFile, secureMkdir } from './data_perms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

let _db: Database.Database | null = null;

/**
 * The operator's real data directory — the one thing a test must never open.
 *
 * Recomputed from `os.homedir()` rather than captured, so a test that swaps
 * `HOME`/`USERPROFILE` (as `ci_smoke.ts` does) is judged against the home it
 * is actually running under.
 */
function realDataDir(): string {
  return path.join(os.homedir(), '.cebab');
}

/**
 * Case-insensitive on Windows, where `os.homedir()` reads `USERPROFILE` and
 * the same directory can arrive as `C:\Users\x` or `c:\users\x`. A
 * case-sensitive compare there would pass while pointing at the real database
 * — the failure mode this guard exists to prevent, so it must not be the one
 * the guard ships with.
 */
function samePath(a: string, b: string): boolean {
  const [x, y] = [path.resolve(a), path.resolve(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * Fail closed when a test would open the operator's real `~/.cebab`.
 *
 * WHY THIS IS A RUNTIME GUARD AND NOT A LINT RULE. `config.dataDir` is
 * mutable module state and the swap is a per-file convention, so a test can
 * reach `getDb()` INDIRECTLY — through `translate`, a repo helper, a
 * notification dispatch — without ever naming `getDb` or `config.dataDir`.
 * That is how it happened before (PR #280): one file quietly opened, migrated
 * and read the real database on every full-suite run, and the only trace was
 * a changed ctime. No grep over test sources can find that shape; the call
 * itself is the only place that knows.
 *
 * `test/setup-data-dir.mjs` already points every worker at a temp dir, so in
 * practice this never fires. That is the point: the setup file is the
 * default, and this is what makes it an invariant rather than a habit —
 * it catches a deleted setup line, a test that assigns `dataDir` back to the
 * home path, and any indirect reach that arrives before the swap.
 */
let realDataDirDeclared = false;

/**
 * Declare that this process is entitled to open the operator's real `~/.cebab`.
 *
 * Exactly one caller: `index.ts`, the server. Everything else — a smoke
 * script, a benchmark, a one-off `tsx` file — must point `CEBAB_DATA_DIR` at a
 * scratch directory instead, and `assertNotRealDataDir` below refuses if it
 * did not.
 *
 * WHY AN EXPLICIT OPT-IN rather than sniffing the entry point: "am I the
 * server" is not a question a module can answer honestly. `require.main`,
 * `argv[1]` and `process.title` are all wrong under `tsx watch`, under a
 * bundler, and in a worker. A declaration is one line in the one place that
 * knows the answer.
 */
export function declareRealDataDirIntent(): void {
  realDataDirDeclared = true;
}

/**
 * Test-only: withdraw the declaration.
 *
 * Module state outlives a case, and a leaked declaration would silently switch
 * this guard off for every later test in the same worker — the guard being off
 * is precisely the condition it exists to catch, so it must not be reachable
 * by forgetting a cleanup. The `VITEST` branch above fires first under vitest,
 * so a leak is not exploitable today; this keeps that from being the only
 * thing standing between a stray call and a disabled guard.
 */
export function __resetRealDataDirIntentForTests(): void {
  realDataDirDeclared = false;
}

/**
 * Fail closed when something that is not the server would open the operator's
 * real `~/.cebab`.
 *
 * WHY THIS IS A RUNTIME GUARD AND NOT A LINT RULE. `config.dataDir` is
 * mutable module state and the swap is a per-file convention, so a caller can
 * reach `getDb()` INDIRECTLY — through `translate`, a repo helper, a
 * notification dispatch — without ever naming `getDb` or `config.dataDir`.
 * That is how it happened before (PR #280): one test file quietly opened,
 * migrated and read the real database on every full-suite run, and the only
 * trace was a changed ctime.
 *
 * WHY IT COVERS MORE THAN TESTS NOW. This used to return early unless
 * `process.env.VITEST` was set, so it only ever watched vitest. On 2026-08-13
 * a one-off `tsx` benchmark wrote 20,000 synthetic rows into the operator's
 * real database: it assigned `process.env.CEBAB_DATA_DIR` at the top of the
 * file, but **ESM hoists `import` above executable statements**, so
 * `config.ts` had already read the variable and resolved `~/.cebab`. The
 * script was not a test, so nothing stopped it.
 *
 * `smoke.ts` shows the shape that works and says why: set the variable, then
 * `await import('./db.js')` dynamically. This guard is what makes that a rule
 * rather than a thing one file happens to remember.
 */
function assertNotRealDataDir(): void {
  if (!samePath(config.dataDir, realDataDir())) return;
  if (process.env.VITEST) {
    throw new Error(
      `[db] refusing to open the real data directory (${realDataDir()}) from a test.\n` +
        `This test reached getDb() with config.dataDir still pointing at your actual ~/.cebab, ` +
        `which would migrate and mutate your real database.\n` +
        `Fix: use withTempDataDir() from server/src/test_support/temp_data_dir.ts, or set ` +
        `config.dataDir to a temp directory in beforeEach.\n` +
        `If you are seeing this on EVERY test, test/setup-data-dir.mjs is no longer wired ` +
        `into vitest.config.ts's setupFiles.`,
    );
  }
  if (realDataDirDeclared) return;
  throw new Error(
    `[db] refusing to open the real data directory (${realDataDir()}) from a process that ` +
      `did not declare it.\n` +
      `Only the server opens the operator's real database. A script, benchmark or probe must ` +
      `point CEBAB_DATA_DIR at a scratch directory FIRST.\n` +
      `Fix: set process.env.CEBAB_DATA_DIR and then load db.js with a DYNAMIC import — ` +
      `\`const { getDb } = await import('./db.js')\` — because a top-level \`import\` is ` +
      `hoisted above your assignment and config.ts will already have read the old value. ` +
      `server/src/smoke.ts is the worked example.\n` +
      `If you really are the server, call declareRealDataDirIntent() at boot.`,
  );
}

export function getDb(): Database.Database {
  if (_db) return _db;
  assertNotRealDataDir();
  // H01: 0700 directory, and the database file pre-created 0600 so SQLite
  // opens an already-tight file. The pre-create must happen BEFORE the WAL
  // pragma below — SQLite derives the `-wal`/`-shm` permissions from the main
  // database file, so this one call covers all three.
  secureMkdir(config.dataDir);
  precreateDbFile(config.dbPath);
  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureMigrationsTable(db);
  applyMigrations(db);
  _db = db;
  return db;
}

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
}

function applyMigrations(db: Database.Database): void {
  const applied = new Set(
    db
      .prepare<[], { filename: string }>('SELECT filename FROM schema_migrations')
      .all()
      .map((r) => r.filename),
  );

  // tsx runs from src/, tsc-built code runs from dist/. The migrations dir is
  // copied next to the build output, but during dev we read from src/.
  const dirs = [MIGRATIONS_DIR, path.join(__dirname, '..', 'src', 'migrations')];
  const migrationsDir = dirs.find((d) => fs.existsSync(d));
  if (!migrationsDir) {
    throw new Error(`No migrations directory found. Tried: ${dirs.join(', ')}`);
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const insert = db.prepare('INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)');
    db.transaction(() => {
      db.exec(sql);
      insert.run(file, Date.now());
    })();
    console.log(`[db] applied ${file}`);
  }
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
