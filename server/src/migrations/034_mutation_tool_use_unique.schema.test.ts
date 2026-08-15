import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';

// Migration 034_mutation_tool_use_unique.sql: closes register D20.
//
// 012 documented `(session_id, tool_use_id)` as unique within a session and
// then created a PLAIN index, so `confirmMutationByToolUseId` — written
// against the comment rather than the schema — confirmed every duplicate and
// returned an arbitrary one.
//
// Pinned here because all three properties of the index are load-bearing and
// fail in different directions if they drift: UNIQUE is what makes the
// constraint real, PARTIAL is what keeps the two supported NULL populations
// (pre-012 rows, and id-less `tool_use` blocks PR #337 deliberately records),
// and the dedupe is what keeps a real operator's database bootable at all.

const MIGRATIONS_DIR = path.dirname(fileURLToPath(import.meta.url));
const INDEX = 'multi_agent_mutations_tool_use_key';

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-mutation-tool-use-key-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb(); // applies 001..034
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('migration 034_mutation_tool_use_unique schema shape', () => {
  function indexList() {
    return getDb()
      .prepare<[], { name: string; unique: number; partial: number }>(
        `PRAGMA index_list('multi_agent_mutations')`,
      )
      .all();
  }

  test('the index exists and is UNIQUE', () => {
    const idx = indexList().find((x) => x.name === INDEX);
    expect(idx).toBeDefined();
    expect(idx?.unique).toBe(1);
  });

  test('the index is PARTIAL — this is what keeps id-less mutations recordable', () => {
    // Without `WHERE tool_use_id IS NOT NULL` the index would still be unique
    // and the duplicate-collapse test below would still pass, while asserting
    // a constraint over rows the design says have no identity to constrain.
    const idx = indexList().find((x) => x.name === INDEX);
    expect(idx?.partial).toBe(1);
  });

  test('it keys on (session_id, tool_use_id)', () => {
    const cols = getDb()
      .prepare<[], { seqno: number; name: string }>(`PRAGMA index_info('${INDEX}')`)
      .all();
    expect(cols.map((c) => c.name)).toEqual(['session_id', 'tool_use_id']);
  });

  test("012's plain index is still there — 034 is additive", () => {
    // 012 created it for the UPDATE hot path, which is a different job from
    // enforcement. If a future change rebuilt this table, dropping it would
    // regress the lookup while every behavioural test still passed.
    expect(indexList().some((x) => x.name === 'idx_multi_agent_mutations_tool_use')).toBe(true);
  });
});

describe('migration 034 dedupe — an operator with existing duplicates can still start', () => {
  /**
   * Apply 001..033 into an isolated in-memory database, seed the duplicates
   * only the pre-#337 write path could produce, then run 034's file contents.
   *
   * Every SQL body is read from disk rather than restated here. A copy would
   * pass forever after the real migration drifted — and the drift that matters
   * is the DELETE going missing, which turns `CREATE UNIQUE INDEX` into a hard
   * startup failure for exactly the databases this migration exists to repair.
   *
   * Parent sessions are seeded because 011's `session_id` carries a real
   * foreign key and better-sqlite3 enforces it here.
   */
  function dbThrough033(): Database.Database {
    const db = new Database(':memory:');
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql') && f < '034')
      .sort();
    // Anti-vacuity: an empty or truncated list would build a table that never
    // had the columns under test, and every expectation below would be
    // measuring a fixture instead of a migration.
    expect(files.length).toBeGreaterThan(30);
    for (const f of files) db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    const session = db.prepare(
      `INSERT INTO multi_agent_sessions (id, mode, started_at, status) VALUES (?, ?, ?, ?)`,
    );
    session.run('s1', 'orchestrator', 1, 'running');
    session.run('s2', 'orchestrator', 1, 'running');
    return db;
  }

  function apply034(db: Database.Database): void {
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, '034_mutation_tool_use_unique.sql'), 'utf8'));
  }

  function seed(db: Database.Database) {
    return db.prepare(
      `INSERT INTO multi_agent_mutations
         (session_id, ts, agent_name, tool_name, category, summary, tool_use_id, promoted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  test('duplicates collapse to the NEWEST row, and the index then applies', () => {
    const db = dbThrough033();
    const insert = seed(db);
    // Three appends of one call — what a pre-#337 overload retry produced.
    insert.run('s1', 1000, 'w', 'Bash', 'dangerous', 'delete a tree', 'toolu_a', 0);
    insert.run('s1', 1001, 'w', 'Bash', 'dangerous', 'delete a tree', 'toolu_a', 0);
    insert.run('s1', 1002, 'w', 'Bash', 'dangerous', 'delete a tree', 'toolu_a', 0);
    // A different call in the same session, and the same id in a DIFFERENT
    // session: both must survive untouched.
    insert.run('s1', 1003, 'w', 'Write', 'mutate', 'create x.ts', 'toolu_b', 0);
    insert.run('s2', 1004, 'w', 'Bash', 'dangerous', 'delete a tree', 'toolu_a', 0);
    expect(db.prepare(`SELECT count(*) AS n FROM multi_agent_mutations`).get()).toEqual({ n: 5 });

    apply034(db);

    const rows = db
      .prepare<[], { session_id: string; tool_use_id: string; ts: number }>(
        `SELECT session_id, tool_use_id, ts FROM multi_agent_mutations ORDER BY session_id, ts`,
      )
      .all();
    expect(rows).toEqual([
      { session_id: 's1', tool_use_id: 'toolu_a', ts: 1002 }, // newest of the three
      { session_id: 's1', tool_use_id: 'toolu_b', ts: 1003 },
      { session_id: 's2', tool_use_id: 'toolu_a', ts: 1004 }, // other session, untouched
    ]);

    // And the constraint is live from here on.
    expect(() =>
      insert.run('s1', 1100, 'w', 'Bash', 'dangerous', 'delete a tree', 'toolu_a', 0),
    ).toThrow(/UNIQUE constraint failed/);
    db.close();
  });

  test('a `promoted` flag sitting on a DOOMED duplicate survives on the keeper', () => {
    // `setMutationPromoted` was called with the id the arbitrary read-back
    // returned, so among duplicates the flag landed anywhere. Without step 1
    // of the migration, deleting the oldest rows would drop it and the
    // artifact view would silently lose a promotion.
    const db = dbThrough033();
    const insert = seed(db);
    insert.run('s1', 1000, 'w', 'Write', 'mutate', 'create PLAN.md', 'toolu_p', 1); // flag here
    insert.run('s1', 1001, 'w', 'Write', 'mutate', 'create PLAN.md', 'toolu_p', 0); // survivor

    apply034(db);

    expect(
      db
        .prepare<[], { ts: number; promoted: number }>(
          `SELECT ts, promoted FROM multi_agent_mutations`,
        )
        .all(),
    ).toEqual([{ ts: 1001, promoted: 1 }]);
    db.close();
  });

  test('rows with a NULL tool_use_id are NOT deduped', () => {
    // The partial predicate's whole job. Pre-012 rows and #337's id-less
    // blocks are legitimately repeatable; a non-partial index would have
    // collapsed these two into one and lost a real mutation.
    const db = dbThrough033();
    const insert = seed(db);
    insert.run('s1', 1000, 'w', 'Bash', 'dangerous', 'delete a tree', null, 0);
    insert.run('s1', 1001, 'w', 'Bash', 'dangerous', 'delete a tree', null, 0);

    apply034(db);

    expect(db.prepare(`SELECT count(*) AS n FROM multi_agent_mutations`).get()).toEqual({ n: 2 });
    // And they stay insertable afterwards.
    insert.run('s1', 1002, 'w', 'Bash', 'dangerous', 'delete a tree', null, 0);
    expect(db.prepare(`SELECT count(*) AS n FROM multi_agent_mutations`).get()).toEqual({ n: 3 });
    db.close();
  });

  test('a table with no duplicates at all migrates untouched', () => {
    // The common case. A dedupe that over-reaches would be invisible in the
    // tests above, where every group genuinely has a duplicate to remove.
    const db = dbThrough033();
    const insert = seed(db);
    insert.run('s1', 1000, 'w', 'Write', 'mutate', 'create a.ts', 'toolu_1', 0);
    insert.run('s1', 1001, 'w', 'Write', 'mutate', 'create b.ts', 'toolu_2', 1);

    apply034(db);

    expect(
      db
        .prepare<[], { tool_use_id: string; promoted: number }>(
          `SELECT tool_use_id, promoted FROM multi_agent_mutations ORDER BY ts`,
        )
        .all(),
    ).toEqual([
      { tool_use_id: 'toolu_1', promoted: 0 },
      { tool_use_id: 'toolu_2', promoted: 1 },
    ]);
    db.close();
  });
});
