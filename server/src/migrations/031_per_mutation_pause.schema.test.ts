import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';

// Migration 031_per_mutation_pause.sql: moves the pause-on-dangerous gate's
// state from multi_agent_sessions (one slot per session) onto
// multi_agent_mutations.pause_state (one per mutation, so per agent).
//
// Pinned here because the gate is a SAFETY boundary computed from this column:
// a default that isn't 0 would make every historical mutation look pending, and
// a missing index turns the per-call gate lookup into a scan of the hottest
// table in a bus run. Both are the kind of regression that typechecks fine.

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-per-mutation-pause-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb(); // applies 001..031
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('migration 031_per_mutation_pause schema shape', () => {
  function cols(table: string) {
    return getDb()
      .prepare<[], { name: string; type: string; notnull: number; dflt_value: string | null }>(
        `PRAGMA table_info('${table}')`,
      )
      .all();
  }

  test('pause_state exists with INTEGER NOT NULL DEFAULT 0', () => {
    const c = cols('multi_agent_mutations').find((x) => x.name === 'pause_state');
    expect(c).toBeDefined();
    expect(c).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });
  });

  test('the gate lookup is indexed on (session_id, agent_name, pause_state)', () => {
    const idx = getDb()
      .prepare<[], { name: string }>(`PRAGMA index_list('multi_agent_mutations')`)
      .all()
      .find((x) => x.name === 'idx_multi_agent_mutations_pause');
    expect(idx).toBeDefined();
    const cols_ = getDb()
      .prepare<[], { seqno: number; name: string }>(
        `PRAGMA index_info('idx_multi_agent_mutations_pause')`,
      )
      .all()
      .sort((a, b) => a.seqno - b.seqno)
      .map((x) => x.name);
    expect(cols_).toEqual(['session_id', 'agent_name', 'pause_state']);
  });

  test('the superseded session columns are left in place, not dropped', () => {
    // 031 deliberately does NOT drop them (see the migration header). If a
    // future migration reclaims them it should do both together and update
    // this expectation deliberately.
    const names = cols('multi_agent_sessions').map((x) => x.name);
    expect(names).toContain('pending_mutation_id');
    expect(names).toContain('mutations_acknowledged');
  });

  // Not an idempotence test, though it used to say so (register C10): the
  // runner SKIPS a filename already in `schema_migrations`, so the body
  // never re-executes. No migration here survives a second apply, and none
  // needs to — the exactly-once contract is asserted in `db.migrations.test.ts`.
  test('the runner applies 031 exactly once — reopening skips it', () => {
    closeDb();
    expect(() => getDb()).not.toThrow();
    const sm = getDb()
      .prepare<[], { n: number }>(
        `SELECT COUNT(*) AS n FROM schema_migrations WHERE filename = '031_per_mutation_pause.sql'`,
      )
      .get();
    expect(sm?.n).toBe(1);
  });
});
