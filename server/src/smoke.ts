// Smoke test: boot the DB, list applied migrations, exit.
// Verifies the migration runner is wired correctly without touching the network.
import { closeDb, getDb } from "./db.js";

const db = getDb();
const rows = db.prepare("SELECT filename, applied_at FROM schema_migrations ORDER BY filename").all();
console.log("applied migrations:", rows);

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log("tables:", tables);

closeDb();
