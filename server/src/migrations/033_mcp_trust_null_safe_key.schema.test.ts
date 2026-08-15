import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';

// Migration 033_mcp_trust_null_safe_key.sql: closes register D09.
//
// 016 declared UNIQUE(server_name, origin_path, binary_sha) and the repository
// writes through INSERT OR REPLACE, both on the understanding that re-deciding
// a server replaces its row. SQLite treats NULLs as distinct in a UNIQUE index,
// so for the unresolvable-target case (`npx <name>` — the reason the column is
// nullable at all) the conflict never fired and every decision appended.
//
// Pinned here because both halves of the migration are load-bearing and fail
// in opposite directions if they drift: the index is what makes the constraint
// real, and it must stay PARTIAL — a plain unique index on
// (server_name, origin_path) would satisfy the same behavioural test while
// forbidding a server from holding decisions at two different binary hashes,
// which the design explicitly supports.

const MIGRATIONS_DIR = path.dirname(fileURLToPath(import.meta.url));

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-mcp-trust-null-key-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb(); // applies 001..033
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('migration 033_mcp_trust_null_safe_key schema shape', () => {
  function indexList() {
    return getDb()
      .prepare<[], { name: string; unique: number; partial: number }>(
        `PRAGMA index_list('mcp_trust')`,
      )
      .all();
  }

  test('the index exists and is UNIQUE', () => {
    const idx = indexList().find((x) => x.name === 'mcp_trust_null_sha_key');
    expect(idx).toBeDefined();
    expect(idx?.unique).toBe(1);
  });

  test('the index is PARTIAL — this is what lets one server keep two shas', () => {
    // `partial: 1` is the whole design. Without the WHERE clause the index
    // would still be unique and the null-sha behaviour test would still pass,
    // while quietly collapsing per-binary trust decisions into one slot.
    const idx = indexList().find((x) => x.name === 'mcp_trust_null_sha_key');
    expect(idx?.partial).toBe(1);
  });

  test('it keys on (server_name, origin_path) — binary_sha is the WHERE, not a column', () => {
    const cols = getDb()
      .prepare<[], { seqno: number; name: string }>(`PRAGMA index_info('mcp_trust_null_sha_key')`)
      .all();
    expect(cols.map((c) => c.name)).toEqual(['server_name', 'origin_path']);
  });

  test("016's table-level UNIQUE is still there — 033 is additive", () => {
    // The implicit index SQLite mints for a table-level UNIQUE. If a future
    // change ever rebuilds this table, losing it would re-open the non-null
    // half of D09 while every behavioural test still passed.
    expect(indexList().some((x) => x.name.startsWith('sqlite_autoindex_mcp_trust'))).toBe(true);
  });
});

describe('migration 033 dedupe — an operator with existing duplicates can still start', () => {
  /**
   * Build 016's table in an isolated DB, seed the duplicates only the OLD code
   * could produce, then run 033's file contents.
   *
   * Both SQL bodies are read from disk rather than restated here. A copy would
   * pass forever after the real migration drifted — and the drift this guards
   * against is the one that matters: without the DELETE, `CREATE UNIQUE INDEX`
   * throws on any DB that already holds duplicates, which is a hard startup
   * failure for exactly the operators the migration exists for.
   */
  function readMigration(name: string): string {
    return fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
  }

  test('duplicates collapse to the newest, and the index then applies', () => {
    const db = new Database(':memory:');
    db.exec(readMigration('016_mcp_trust.sql'));

    const insert = db.prepare(
      `INSERT INTO mcp_trust (ts, server_name, origin_path, binary_sha, decision, operator)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    // Three decisions on one unresolvable server — what the pre-033 write path
    // produced, since INSERT OR REPLACE never conflicted at a NULL sha.
    insert.run(1000, 'npx-svr', '/p/settings.json', null, 'trusted', 'op');
    insert.run(1001, 'npx-svr', '/p/settings.json', null, 'denied_remember', 'op');
    insert.run(1002, 'npx-svr', '/p/settings.json', null, 'trusted', 'op');
    // A second server, and a real-sha row that must survive untouched.
    insert.run(900, 'other', '/p/settings.json', null, 'denied_remember', 'op');
    insert.run(950, 'npx-svr', '/p/settings.json', 'sha-real', 'trusted', 'op');
    expect(db.prepare(`SELECT count(*) AS n FROM mcp_trust`).get()).toEqual({ n: 5 });

    db.exec(readMigration('033_mcp_trust_null_safe_key.sql'));

    const rows = db
      .prepare<[], { server_name: string; binary_sha: string | null; ts: number }>(
        `SELECT server_name, binary_sha, ts FROM mcp_trust ORDER BY server_name, ts`,
      )
      .all();
    expect(rows).toEqual([
      { server_name: 'npx-svr', binary_sha: 'sha-real', ts: 950 },
      { server_name: 'npx-svr', binary_sha: null, ts: 1002 }, // newest of the three
      { server_name: 'other', binary_sha: null, ts: 900 }, // untouched
    ]);

    // And the constraint is live from here on.
    expect(() =>
      insert.run(1100, 'npx-svr', '/p/settings.json', null, 'denied_remember', 'op'),
    ).toThrow(/UNIQUE constraint failed/);
    db.close();
  });
});
