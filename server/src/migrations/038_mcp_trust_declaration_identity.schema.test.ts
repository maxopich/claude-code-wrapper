import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';

// Schema pin for 038 (Cebab-rxg). Every migration since 023 ships one.
//
// This one is a TABLE REBUILD, which is the migration shape with the most ways
// to go quietly wrong: a dropped column, a lost index, a UNIQUE that no longer
// covers what the lookup keys on. The cases below pin each of those, and the
// last one pins the carry-over posture — pre-038 rows arrive with a NULL
// declaration on purpose, because that is what makes them re-prompt once
// instead of silently matching every future declaration.

type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: string | null };
type IndexInfo = { name: string; unique: number; partial: number };

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-mcp-trust-038-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb(); // applies 001..038
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('[security] 038_mcp_trust_declaration_identity', () => {
  test('command and args_json exist, nullable, with no default', () => {
    // Nullable is the design: NULL means "decided before 038 tracked the
    // declaration". A `NOT NULL DEFAULT ''` would apply cleanly and then claim
    // every pre-existing decision had approved an empty command — which the
    // gate writes for a config-less server, so it is a REAL matchable value
    // and cannot double as the sentinel.
    const cols = getDb().prepare<[], ColumnInfo>('PRAGMA table_info(mcp_trust)').all();
    for (const name of ['command', 'args_json'] as const) {
      const col = cols.find((c) => c.name === name);
      expect({ name, found: col !== undefined }).toEqual({ name, found: true });
      expect({ name, type: col?.type }).toEqual({ name, type: 'TEXT' });
      expect({ name, notnull: col?.notnull }).toEqual({ name, notnull: 0 });
      expect({ name, dflt: col?.dflt_value }).toEqual({ name, dflt: null });
    }
  });

  test('the rebuild kept every pre-038 column', () => {
    // A table rebuild that silently drops a column would pass every behavioural
    // test that does not read it.
    const names = getDb()
      .prepare<[], ColumnInfo>('PRAGMA table_info(mcp_trust)')
      .all()
      .map((c) => c.name)
      .sort();
    expect(names).toEqual(
      [
        'args_json',
        'binary_sha',
        'command',
        'decision',
        'id',
        'operator',
        'origin_path',
        'server_name',
        'ts',
      ].sort(),
    );
  });

  test('the UNIQUE identity covers the declaration', () => {
    // The whole finding in one assertion: an identity that omits command/args
    // is one an attacker can re-use by rewriting the entry.
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
    const full = covered.find((cols) => cols.includes('binary_sha'));
    expect(full).toBeDefined();
    expect(full!.sort()).toEqual(
      ['args_json', 'binary_sha', 'command', 'origin_path', 'server_name'].sort(),
    );
  });

  test("register D09's partial null-sha index survived, widened", () => {
    // 033 exists because SQLite treats NULLs as distinct in a UNIQUE index, so
    // the table constraint never fires for `npx <name>` — the common case.
    // Losing it in the rebuild would bring back a row per decision.
    const db = getDb();
    const partial = db
      .prepare<[], IndexInfo>(`SELECT name, "unique", partial FROM pragma_index_list('mcp_trust')`)
      .all()
      .find((i) => i.partial === 1 && i.unique === 1);
    expect(partial?.name).toBe('mcp_trust_null_sha_key');
    const cols = db
      .prepare<[], { name: string }>(`SELECT name FROM pragma_index_info('mcp_trust_null_sha_key')`)
      .all()
      .map((c) => c.name)
      .sort();
    expect(cols).toEqual(['args_json', 'command', 'origin_path', 'server_name'].sort());
  });

  test('the lookup index on (server_name, origin_path) survived', () => {
    const names = getDb()
      .prepare<[], IndexInfo>(`SELECT name, "unique", partial FROM pragma_index_list('mcp_trust')`)
      .all()
      .map((i) => i.name);
    expect(names).toContain('mcp_trust_server_origin');
  });

  test('a row can be inserted with a NULL declaration — the carry-over shape', () => {
    // Pre-038 decisions arrive this way. If the rebuild had made the columns
    // NOT NULL, the migration itself would have failed on any machine with
    // trust history, which no test on a FRESH database would ever catch.
    const db = getDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO mcp_trust (ts, server_name, origin_path, command, args_json, binary_sha, decision, operator)
           VALUES (?, 'legacy', '/p/.mcp.json', NULL, NULL, NULL, 'trusted', 'op')`,
        )
        .run(Date.now()),
    ).not.toThrow();
  });
});

const MIGRATIONS_DIR = path.dirname(fileURLToPath(import.meta.url));

describe('[security] 038 carry-over — an operator with trust history keeps it, re-prompted once', () => {
  /**
   * The case a fresh-database test can never reach, and the one that decides
   * whether this migration is safe to ship: an operator who has already
   * approved MCP servers. Their rows must survive the rebuild, and must arrive
   * in the shape that re-prompts (NULL declaration) rather than the shape that
   * silently matches anything.
   *
   * The SQL bodies are read from disk, not restated — the same reason 033's
   * equivalent gives: a copy passes forever after the real migration drifts.
   */
  function readMigration(name: string): string {
    return fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
  }

  test('every pre-038 decision survives, with a NULL declaration', () => {
    const db = new Database(':memory:');
    db.exec(readMigration('016_mcp_trust.sql'));
    db.exec(readMigration('033_mcp_trust_null_safe_key.sql'));

    const insert = db.prepare(
      `INSERT INTO mcp_trust (ts, server_name, origin_path, binary_sha, decision, operator)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run(1000, 'npx-svr', '/p/.mcp.json', null, 'trusted', 'op');
    insert.run(1100, 'pinned-svr', '/p/.mcp.json', 'sha-real', 'trusted_pinned_hash', 'op');
    insert.run(1200, 'nope-svr', '/p/settings.json', null, 'denied_remember', 'op');

    db.exec(readMigration('038_mcp_trust_declaration_identity.sql'));

    const rows = db
      .prepare<
        [],
        {
          server_name: string;
          command: string | null;
          args_json: string | null;
          binary_sha: string | null;
          decision: string;
          ts: number;
        }
      >(
        `SELECT server_name, command, args_json, binary_sha, decision, ts
           FROM mcp_trust ORDER BY ts`,
      )
      .all();
    expect(rows).toEqual([
      {
        server_name: 'npx-svr',
        command: null,
        args_json: null,
        binary_sha: null,
        decision: 'trusted',
        ts: 1000,
      },
      {
        server_name: 'pinned-svr',
        command: null,
        args_json: null,
        binary_sha: 'sha-real',
        decision: 'trusted_pinned_hash',
        ts: 1100,
      },
      {
        server_name: 'nope-svr',
        command: null,
        args_json: null,
        binary_sha: null,
        decision: 'denied_remember',
        ts: 1200,
      },
    ]);
  });

  test('the rebuild does not renumber ids', () => {
    // `INSERT OR REPLACE` mints fresh ids and every recency tie-break in the
    // repository reads `id DESC` as true write order. Renumbering would not
    // fail anything visibly; it would just quietly reorder decisions made in
    // the same millisecond.
    const db = new Database(':memory:');
    db.exec(readMigration('016_mcp_trust.sql'));
    db.exec(readMigration('033_mcp_trust_null_safe_key.sql'));
    const insert = db.prepare(
      `INSERT INTO mcp_trust (id, ts, server_name, origin_path, binary_sha, decision, operator)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(41, 1000, 'a', '/p/.mcp.json', null, 'trusted', 'op');
    insert.run(97, 1001, 'b', '/p/.mcp.json', null, 'trusted', 'op');

    db.exec(readMigration('038_mcp_trust_declaration_identity.sql'));

    const ids = db
      .prepare<[], { id: number }>(`SELECT id FROM mcp_trust ORDER BY id`)
      .all()
      .map((r) => r.id);
    expect(ids).toEqual([41, 97]);
  });
});
