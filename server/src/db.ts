import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(config.dataDir, { recursive: true });
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
