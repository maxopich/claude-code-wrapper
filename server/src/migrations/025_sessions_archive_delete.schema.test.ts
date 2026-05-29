import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';

// Cluster I Phase C5: schema-shape smoke for migration
// 025_sessions_archive_delete.sql.
//
// The bulk_session_op handler + sidebar Select-mode UI depend on the two
// new columns. A future migration that accidentally drops one would
// otherwise sneak past typecheck — pinning the shape here forces a
// deliberate review.

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-sessions-archive-delete-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb(); // applies 001..025
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('migration 025_sessions_archive_delete schema shape', () => {
  test('sessions.archived column exists with INTEGER NOT NULL DEFAULT 0', () => {
    const db = getDb();
    const cols = db
      .prepare<
        [],
        { name: string; type: string; notnull: number; dflt_value: string | null }
      >(`PRAGMA table_info('sessions')`)
      .all();
    const archived = cols.find((c) => c.name === 'archived');
    expect(archived).toBeDefined();
    expect(archived).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });
  });

  test('sessions.deleted_at column exists as nullable INTEGER', () => {
    const db = getDb();
    const cols = db
      .prepare<
        [],
        { name: string; type: string; notnull: number; dflt_value: string | null }
      >(`PRAGMA table_info('sessions')`)
      .all();
    const deletedAt = cols.find((c) => c.name === 'deleted_at');
    expect(deletedAt).toBeDefined();
    expect(deletedAt).toMatchObject({ type: 'INTEGER', notnull: 0, dflt_value: null });
  });

  test('sessions_archived_deleted_idx covers the two filter columns', () => {
    const db = getDb();
    const indexExists = db
      .prepare<
        [],
        { name: string }
      >(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'sessions_archived_deleted_idx'`)
      .get();
    expect(indexExists?.name).toBe('sessions_archived_deleted_idx');
    const columns = db
      .prepare<[], { name: string }>(`PRAGMA index_info('sessions_archived_deleted_idx')`)
      .all()
      .map((r) => r.name);
    expect(columns).toEqual(['archived', 'deleted_at']);
  });

  test('migration runner is idempotent — re-applying 025 does not throw', () => {
    closeDb();
    expect(() => getDb()).not.toThrow();
    const sm = getDb()
      .prepare<
        [],
        { n: number }
      >(`SELECT COUNT(*) AS n FROM schema_migrations WHERE filename = '025_sessions_archive_delete.sql'`)
      .get();
    expect(sm?.n).toBe(1);
  });

  test('pre-existing rows default archived=0 and deleted_at=NULL', async () => {
    // Insert a session via the canonical path (NOT specifying the new
    // columns) to confirm the DEFAULTs kick in.
    const { upsertProject } = await import('../repo/projects.js');
    const { createSession } = await import('../repo/sessions.js');
    const proj = upsertProject('p', '/tmp/p');
    createSession('s1', proj.id);
    const db = getDb();
    const row = db
      .prepare<
        [],
        { archived: number; deleted_at: number | null }
      >(`SELECT archived, deleted_at FROM sessions WHERE id = 's1'`)
      .get();
    expect(row).toEqual({ archived: 0, deleted_at: null });
  });
});
