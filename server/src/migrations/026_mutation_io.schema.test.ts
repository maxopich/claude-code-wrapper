import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';

// Migration 026_mutation_io.sql: full tool input/output columns on
// multi_agent_mutations. The bus taps (capture) + log projector (surface) both
// depend on these two columns; a future migration that accidentally dropped
// one would otherwise sneak past typecheck — pinning the shape here forces a
// deliberate review.

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-mutation-io-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb(); // applies 001..026
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('migration 026_mutation_io schema shape', () => {
  function cols() {
    return getDb()
      .prepare<
        [],
        { name: string; type: string; notnull: number; dflt_value: string | null }
      >(`PRAGMA table_info('multi_agent_mutations')`)
      .all();
  }

  test('tool_input_json column exists as nullable TEXT', () => {
    const c = cols().find((x) => x.name === 'tool_input_json');
    expect(c).toBeDefined();
    expect(c).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
  });

  test('tool_result_json column exists as nullable TEXT', () => {
    const c = cols().find((x) => x.name === 'tool_result_json');
    expect(c).toBeDefined();
    expect(c).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
  });

  test('migration runner is idempotent — re-applying 026 does not throw', () => {
    closeDb();
    expect(() => getDb()).not.toThrow();
    const sm = getDb()
      .prepare<
        [],
        { n: number }
      >(`SELECT COUNT(*) AS n FROM schema_migrations WHERE filename = '026_mutation_io.sql'`)
      .get();
    expect(sm?.n).toBe(1);
  });
});
