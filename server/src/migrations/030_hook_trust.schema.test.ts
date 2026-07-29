import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';

// Migration 030_hook_trust.sql: the TOFU ledger for `.claude/settings*.json`
// hooks. Pins the shape a future migration would have to change deliberately —
// in particular the UNIQUE tuple, which IS the definition of "the same hook"
// and therefore of what does and does not re-prompt the operator.

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-hook-trust-schema-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb(); // applies 001..030
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('migration 030_hook_trust schema shape', () => {
  test('the table exists with the expected columns and nullability', () => {
    const cols = getDb()
      .prepare<[], { name: string; type: string; notnull: number }>(
        `PRAGMA table_info('hook_trust')`,
      )
      .all();
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect([...byName.keys()].sort()).toEqual([
      'args_json',
      'command',
      'first_seen_at',
      'hook_kind',
      'id',
      'last_seen_at',
      'origin_path',
      'project_id',
      'script_sha',
    ]);
    // `script_sha` is the only nullable column: a bare command or a pipeline
    // has no stable file to pin, and storing NULL is how the ledger says
    // "tracked, but no change detection" rather than pretending otherwise.
    expect(byName.get('script_sha')!.notnull).toBe(0);
    for (const required of ['hook_kind', 'origin_path', 'command', 'args_json', 'project_id']) {
      expect(byName.get(required)!.notnull).toBe(1);
    }
  });

  test('the UNIQUE tuple is (project, kind, origin, command, args)', () => {
    const idx = getDb()
      .prepare<[], { name: string; unique: number }>(`PRAGMA index_list('hook_trust')`)
      .all()
      .filter((i) => i.unique === 1);
    expect(idx).toHaveLength(1);
    const cols = getDb()
      .prepare<[], { name: string }>(`PRAGMA index_info('${idx[0]!.name}')`)
      .all()
      .map((c) => c.name);
    // Every element earns its place: drop `command` and an edited hook stops
    // re-prompting; drop `origin_path` and a sibling repo's settings.local.json
    // inherits trust granted to the project's own file; drop `args_json` and
    // `--dry-run` launders trust to `--apply`.
    expect(cols).toEqual(['project_id', 'hook_kind', 'origin_path', 'command', 'args_json']);
  });

  test('foreign key cascades from projects', () => {
    const fks = getDb()
      .prepare<[], { table: string; on_delete: string }>(`PRAGMA foreign_key_list('hook_trust')`)
      .all();
    expect(fks).toHaveLength(1);
    expect(fks[0]).toMatchObject({ table: 'projects', on_delete: 'CASCADE' });
  });

  test('migration runner is idempotent — re-applying 030 does not throw', () => {
    closeDb();
    expect(() => getDb()).not.toThrow();
    const sm = getDb()
      .prepare<[], { n: number }>(
        `SELECT COUNT(*) AS n FROM schema_migrations WHERE filename = '030_hook_trust.sql'`,
      )
      .get();
    expect(sm?.n).toBe(1);
  });
});
