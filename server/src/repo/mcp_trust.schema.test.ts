import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';

// Cluster B Phase 2: schema-shape smoke for migration 016_mcp_trust.sql.
//
// The Phase 4 repository (server/src/repo/mcp_trust.ts — not yet written)
// will wrap INSERT/SELECT in typed helpers. Phase 2 ships only the schema;
// these tests pin the columns, UNIQUE constraint, and index so a future
// schema migration that breaks them fails CI rather than silently bypassing
// the TOFU gate.
//
// References: critical/B-authority-transparency.md §4.4.

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-mcp-trust-schema-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb(); // applies 001..016
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('migration 016_mcp_trust schema shape', () => {
  test('mcp_trust table exists with the expected columns', () => {
    const db = getDb();
    const cols = db
      .prepare<
        [],
        { name: string; type: string; notnull: number; pk: number }
      >(`PRAGMA table_info('mcp_trust')`)
      .all();
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    // All declared columns present in exactly the right shape.
    expect(byName.id).toMatchObject({ type: 'INTEGER', pk: 1 });
    expect(byName.ts).toMatchObject({ type: 'INTEGER', notnull: 1 });
    expect(byName.server_name).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(byName.origin_path).toMatchObject({ type: 'TEXT', notnull: 1 });
    // binary_sha is nullable on purpose (npx, etc.).
    expect(byName.binary_sha).toMatchObject({ type: 'TEXT', notnull: 0 });
    expect(byName.decision).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(byName.operator).toMatchObject({ type: 'TEXT', notnull: 1 });
  });

  test('UNIQUE(server_name, origin_path, binary_sha) is enforced', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO mcp_trust (ts, server_name, origin_path, binary_sha, decision, operator)
        VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(1000, 'srv', '/etc/mcp.json', 'deadbeef', 'trusted', 'local-user');
    // Same triple → constraint violation.
    expect(() =>
      db
        .prepare(
          `INSERT INTO mcp_trust (ts, server_name, origin_path, binary_sha, decision, operator)
            VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(2000, 'srv', '/etc/mcp.json', 'deadbeef', 'denied_remember', 'local-user'),
    ).toThrowError(/UNIQUE constraint/);
  });

  test('different binary_sha for same (server_name, origin_path) is allowed', () => {
    // Hash-pinned trust on a binary that gets updated: the new sha is a
    // distinct row, the old (pre-update) sha row stays as historical proof.
    const db = getDb();
    db.prepare(
      `INSERT INTO mcp_trust (ts, server_name, origin_path, binary_sha, decision, operator)
        VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(1000, 'srv', '/etc/mcp.json', 'sha-v1', 'trusted_pinned_hash', 'local-user');
    db.prepare(
      `INSERT INTO mcp_trust (ts, server_name, origin_path, binary_sha, decision, operator)
        VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(2000, 'srv', '/etc/mcp.json', 'sha-v2', 'denied_remember', 'local-user');
    const rows = db
      .prepare<
        [],
        { binary_sha: string; decision: string }
      >(`SELECT binary_sha, decision FROM mcp_trust WHERE server_name = 'srv' ORDER BY ts`)
      .all();
    expect(rows).toEqual([
      { binary_sha: 'sha-v1', decision: 'trusted_pinned_hash' },
      { binary_sha: 'sha-v2', decision: 'denied_remember' },
    ]);
  });

  test('multiple NULL binary_sha rows for same (server_name, origin_path) are allowed (SQLite NULL UNIQUE semantics)', () => {
    // SQLite treats NULL as distinct in UNIQUE constraints — multiple
    // unresolvable-target rows (npx commands) can coexist. The Phase 4
    // repo's lookup logic handles "any matching name+origin with NULL sha"
    // as a separate path; this just pins SQLite's default behavior.
    const db = getDb();
    db.prepare(
      `INSERT INTO mcp_trust (ts, server_name, origin_path, binary_sha, decision, operator)
        VALUES (?, ?, ?, NULL, ?, ?)`,
    ).run(1000, 'srv', '/etc/mcp.json', 'trusted', 'local-user');
    expect(() =>
      db
        .prepare(
          `INSERT INTO mcp_trust (ts, server_name, origin_path, binary_sha, decision, operator)
            VALUES (?, ?, ?, NULL, ?, ?)`,
        )
        .run(2000, 'srv', '/etc/mcp.json', 'denied_remember', 'local-user'),
    ).not.toThrow();
    const count = db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM mcp_trust`).get();
    expect(count?.n).toBe(2);
  });

  test('index mcp_trust_server_origin exists', () => {
    const db = getDb();
    const idx = db
      .prepare<
        [],
        { name: string }
      >(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'mcp_trust' AND name = 'mcp_trust_server_origin'`)
      .get();
    expect(idx?.name).toBe('mcp_trust_server_origin');
  });

  test('migration runner is idempotent — closing and re-opening the DB does not throw or duplicate', () => {
    // The directory-scan migration runner in db.ts uses schema_migrations
    // to dedupe. Phase 2 must not regress that — if 016 ever inserts seed
    // data without guarding for re-application, this test catches it via
    // a second getDb() call (which re-runs applyMigrations against the
    // already-populated schema_migrations table).
    closeDb();
    expect(() => getDb()).not.toThrow();
    // Schema still intact, no duplicate table creation attempt.
    const tables = getDb()
      .prepare<
        [],
        { name: string }
      >(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mcp_trust'`)
      .all();
    expect(tables).toHaveLength(1);
    // schema_migrations row for 016 lands exactly once.
    const rows = getDb()
      .prepare<
        [],
        { n: number }
      >(`SELECT COUNT(*) AS n FROM schema_migrations WHERE filename = '016_mcp_trust.sql'`)
      .get();
    expect(rows?.n).toBe(1);
  });
});
