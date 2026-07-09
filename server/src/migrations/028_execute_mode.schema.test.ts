import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import {
  createMultiAgentSession,
  getMultiAgentSession,
  setExecuteMode,
} from '../repo/multi_agent.js';

// Migration 028_execute_mode.sql: adds multi_agent_sessions.execute_mode — the
// per-session opt-in that flips orchestrator-mode briefings from consultant
// (analyze-only) to execute (workers may change their own project). The prompt
// renderers (runtime.ts), the WS `multi_agent_started` envelope, and R-B
// reconstruct all read this column. Pinning the shape here forces a deliberate
// review if a future migration touches it, and proves the ADD COLUMN kept
// INTEGER NOT NULL DEFAULT 0 (a safe consultant default for every pre-028 row).

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-execute-mode-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb(); // applies 001..028
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('migration 028_execute_mode schema shape', () => {
  function cols() {
    return getDb()
      .prepare<
        [],
        { name: string; type: string; notnull: number; dflt_value: string | null }
      >(`PRAGMA table_info('multi_agent_sessions')`)
      .all();
  }

  test('execute_mode column exists with INTEGER NOT NULL DEFAULT 0', () => {
    const c = cols().find((x) => x.name === 'execute_mode');
    expect(c).toBeDefined();
    expect(c).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });
  });

  test('a fresh session defaults execute_mode = 0; setExecuteMode round-trips', () => {
    createMultiAgentSession('s-exec', 'orchestrator');
    expect(getMultiAgentSession('s-exec')!.execute_mode).toBe(0);
    setExecuteMode('s-exec', true);
    expect(getMultiAgentSession('s-exec')!.execute_mode).toBe(1);
    setExecuteMode('s-exec', false);
    expect(getMultiAgentSession('s-exec')!.execute_mode).toBe(0);
  });

  test('migration runner is idempotent — re-applying 028 does not throw', () => {
    closeDb();
    expect(() => getDb()).not.toThrow();
    const sm = getDb()
      .prepare<
        [],
        { n: number }
      >(`SELECT COUNT(*) AS n FROM schema_migrations WHERE filename = '028_execute_mode.sql'`)
      .get();
    expect(sm?.n).toBe(1);
  });
});
