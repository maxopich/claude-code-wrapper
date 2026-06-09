import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';

// Migration 027_pause_on_dangerous.sql: renames multi_agent_sessions.
// pause_on_mutation → pause_on_dangerous (truth-in-naming; the gate has fired
// dangerous-only since #200). The pause gate (pause_gate.ts), R-B reconstruct,
// and the WS `multi_agent_started` envelope all read this column. Pinning the
// post-rename shape here forces a deliberate review if a future migration
// touches it — and proves the rename PRESERVED the column's INTEGER NOT NULL
// DEFAULT 0 (a RENAME COLUMN that silently dropped the constraint would slip
// past typecheck otherwise).

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-pause-on-dangerous-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb(); // applies 001..027
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('migration 027_pause_on_dangerous schema shape', () => {
  function cols() {
    return getDb()
      .prepare<
        [],
        { name: string; type: string; notnull: number; dflt_value: string | null }
      >(`PRAGMA table_info('multi_agent_sessions')`)
      .all();
  }

  test('pause_on_dangerous column exists with INTEGER NOT NULL DEFAULT 0', () => {
    const c = cols().find((x) => x.name === 'pause_on_dangerous');
    expect(c).toBeDefined();
    expect(c).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });
  });

  test('the old pause_on_mutation column no longer exists', () => {
    expect(cols().find((x) => x.name === 'pause_on_mutation')).toBeUndefined();
  });

  test('migration runner is idempotent — re-applying 027 does not throw', () => {
    closeDb();
    expect(() => getDb()).not.toThrow();
    const sm = getDb()
      .prepare<
        [],
        { n: number }
      >(`SELECT COUNT(*) AS n FROM schema_migrations WHERE filename = '027_pause_on_dangerous.sql'`)
      .get();
    expect(sm?.n).toBe(1);
  });
});
