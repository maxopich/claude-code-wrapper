import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';

// Schema pin for 039 (Cebab-1af). Every migration since 023 ships one.
//
// A plain ADD COLUMN, where 038 needed a table rebuild — so the ways this one
// goes wrong are different from its neighbour's. The two that matter:
//
//   - the column ending up in the UNIQUE identity. It is the COMPARISON
//     payload, like `binary_sha` on a pinned row and `hook_trust.script_sha`
//     next door. In the key, every byte change becomes a NEW ROW rather than a
//     changed one, `INSERT OR REPLACE` stops replacing, and nothing ever
//     mismatches — the mechanism would look installed and detect nothing.
//   - a DEFAULT. `''` or `'{}'` would claim every pre-039 decision approved a
//     specific (empty) set of files, and the whole no-backfill argument in the
//     .sql header turns on NULL meaning "this row pinned nothing".

type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: string | null };
type IndexInfo = { name: string; unique: number; partial: number };

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-mcp-trust-039-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb(); // applies 001..039
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('[security] 039_mcp_trust_script_shas', () => {
  test('script_shas_json exists, TEXT, nullable, with no default', () => {
    const col = getDb()
      .prepare<[], ColumnInfo>('PRAGMA table_info(mcp_trust)')
      .all()
      .find((c) => c.name === 'script_shas_json');
    expect(col).toBeDefined();
    expect({ type: col!.type, notnull: col!.notnull, dflt: col!.dflt_value }).toEqual({
      type: 'TEXT',
      notnull: 0,
      dflt: null,
    });
  });

  test('the column is NOT part of any UNIQUE identity', () => {
    // Reddens: adding it to 038's table constraint or to the partial null-sha
    // index. Either makes a rewritten script a new row instead of a changed
    // one, which is silent by construction.
    const db = getDb();
    const uniques = db
      .prepare<[], IndexInfo>(`SELECT name, "unique", partial FROM pragma_index_list('mcp_trust')`)
      .all()
      .filter((i) => i.unique === 1);
    expect(uniques.length).toBeGreaterThan(0); // the assertion below is vacuous with none
    for (const idx of uniques) {
      const cols = db
        .prepare<[string], { name: string }>(`SELECT name FROM pragma_index_info(?)`)
        .all(idx.name)
        .map((c) => c.name);
      expect({ index: idx.name, pinned: cols.includes('script_shas_json') }).toEqual({
        index: idx.name,
        pinned: false,
      });
    }
  });

  test("038's identity and register D09's partial index both survived the ADD COLUMN", () => {
    const db = getDb();
    const uniques = db
      .prepare<[], IndexInfo>(`SELECT name, "unique", partial FROM pragma_index_list('mcp_trust')`)
      .all()
      .filter((i) => i.unique === 1);
    const covered = uniques.map((i) =>
      db
        .prepare<[string], { name: string }>(`SELECT name FROM pragma_index_info(?)`)
        .all(i.name)
        .map((c) => c.name),
    );
    expect(covered.find((c) => c.includes('binary_sha'))!.sort()).toEqual(
      ['args_json', 'binary_sha', 'command', 'origin_path', 'server_name'].sort(),
    );
    expect(uniques.some((i) => i.name === 'mcp_trust_null_sha_key' && i.partial === 1)).toBe(true);
  });

  test('a row that predates 039 carries NULL — the migration backfills nothing', () => {
    // The posture the .sql header argues for: a backfill would hash whatever is
    // on disk at upgrade time and record it as approved, which launders the
    // swap this migration exists to catch if it already happened.
    //
    // Applied to a database that already HAS a decision, which a fresh-DB test
    // cannot show: the ADD COLUMN has to land on populated rows.
    const dbPath = path.join(config.dataDir, 'cebab.sqlite');
    closeDb();
    const raw = new Database(dbPath);
    raw.prepare('DELETE FROM schema_migrations WHERE filename LIKE ?').run('039_%');
    raw.prepare('ALTER TABLE mcp_trust DROP COLUMN script_shas_json').run();
    raw
      .prepare(
        `INSERT INTO mcp_trust (ts, server_name, origin_path, command, args_json, binary_sha, decision, operator)
         VALUES (?, 'legacy', '/p/.mcp.json', 'node', '["s.mjs"]', NULL, 'trusted', 'op')`,
      )
      .run(Date.now());
    raw.close();

    getDb(); // re-applies 039 over the populated table
    const row = getDb()
      .prepare<[], { script_shas_json: string | null }>(
        `SELECT script_shas_json FROM mcp_trust WHERE server_name = 'legacy'`,
      )
      .get();
    expect(row).toEqual({ script_shas_json: null });
  });
});
