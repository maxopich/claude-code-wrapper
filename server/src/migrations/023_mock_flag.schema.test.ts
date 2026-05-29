import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';

// Cluster G Phase 1 (A3): schema-shape smoke for migration 023_mock_flag.sql.
//
// Phase 1 adds three new columns + three indexes + one fresh chain-reset
// marker. Subsequent phases (MockBadge UI, audit-mode-filtered forensics
// queries, RunsBadge) depend on each piece. A future migration that
// accidentally drops one would otherwise pass typecheck — pinning the
// schema here forces a deliberate review.

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-mock-flag-schema-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb(); // applies 001..023
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('migration 023_mock_flag schema shape', () => {
  test('sessions.mock column exists with INTEGER NOT NULL DEFAULT 0', () => {
    const db = getDb();
    const cols = db
      .prepare<
        [],
        { name: string; type: string; notnull: number; dflt_value: string | null }
      >(`PRAGMA table_info('sessions')`)
      .all();
    const mock = cols.find((c) => c.name === 'mock');
    expect(mock).toBeDefined();
    expect(mock).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });
  });

  test('multi_agent_sessions.mock column exists with INTEGER NOT NULL DEFAULT 0', () => {
    const db = getDb();
    const cols = db
      .prepare<
        [],
        { name: string; type: string; notnull: number; dflt_value: string | null }
      >(`PRAGMA table_info('multi_agent_sessions')`)
      .all();
    const mock = cols.find((c) => c.name === 'mock');
    expect(mock).toBeDefined();
    expect(mock).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });
  });

  test("safety_audit.mode column exists with TEXT NOT NULL DEFAULT 'live'", () => {
    const db = getDb();
    const cols = db
      .prepare<
        [],
        { name: string; type: string; notnull: number; dflt_value: string | null }
      >(`PRAGMA table_info('safety_audit')`)
      .all();
    const mode = cols.find((c) => c.name === 'mode');
    expect(mode).toBeDefined();
    expect(mode).toMatchObject({ type: 'TEXT', notnull: 1 });
    // The DEFAULT clause is stored quoted in SQLite's catalog.
    expect(mode?.dflt_value).toMatch(/^'live'$|^live$/);
  });

  test('per-column indexes are created', () => {
    const db = getDb();
    const indexes = db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN
          ('sessions_mock', 'multi_agent_sessions_mock', 'safety_audit_mode')`,
      )
      .all()
      .map((r) => r.name)
      .sort();
    expect(indexes).toEqual(['multi_agent_sessions_mock', 'safety_audit_mode', 'sessions_mock']);
  });

  test('chain-reset-023 marker is inserted with mode=live and sentinel hash_self', () => {
    const db = getDb();
    const marker = db
      .prepare<
        [],
        { id: string; ts: number; kind: string; reason_code: string; mode: string; hash_self: Buffer; hash_prev: Buffer | null }
      >(
        `SELECT id, ts, kind, reason_code, mode, hash_self, hash_prev
         FROM safety_audit WHERE id = 'chain-reset-023'`,
      )
      .get();
    expect(marker).toBeDefined();
    expect(marker).toMatchObject({
      id: 'chain-reset-023',
      ts: 0,
      kind: 'audit.chain_reset',
      reason_code: 'migration_023',
      mode: 'live',
    });
    // Sentinel anchor — exactly one zero byte per the migration text.
    expect(marker?.hash_self).toEqual(Buffer.from([0]));
    expect(marker?.hash_prev).toBeNull();
  });

  test('migration runner is idempotent — re-applying 023 does not double-insert the marker', () => {
    closeDb();
    expect(() => getDb()).not.toThrow();
    const count = getDb()
      .prepare<
        [],
        { n: number }
      >(`SELECT COUNT(*) AS n FROM safety_audit WHERE id = 'chain-reset-023'`)
      .get();
    expect(count?.n).toBe(1);
    // schema_migrations row for 023 lands exactly once.
    const sm = getDb()
      .prepare<
        [],
        { n: number }
      >(`SELECT COUNT(*) AS n FROM schema_migrations WHERE filename = '023_mock_flag.sql'`)
      .get();
    expect(sm?.n).toBe(1);
  });
});
