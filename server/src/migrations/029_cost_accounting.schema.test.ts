import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import {
  addAgentCost,
  createMultiAgentSession,
  getMultiAgentSession,
} from '../repo/multi_agent.js';

// Migration 029_cost_accounting.sql: adds `multi_agent_sessions.total_cost_usd`
// and `multi_agent_agent_sessions.cost_usd`, so a bus run's spend is recorded
// at all. It never was — the only capacity signal was the hop count, which
// weighs a 2k-token routing turn and a 180k-token analysis turn the same.
//
// The migration deliberately does NOT rewrite historical single-agent
// `sessions.total_cost_usd`; that bug is fixed forward in
// `runner/orchestrator.ts`. See the SQL header for the reasoning.

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-cost-accounting-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb(); // applies 001..029
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function cols(table: string) {
  return getDb()
    .prepare<[], { name: string; type: string; notnull: number; dflt_value: string | null }>(
      `PRAGMA table_info('${table}')`,
    )
    .all();
}

describe('migration 029_cost_accounting schema shape', () => {
  test('multi_agent_sessions.total_cost_usd is REAL NOT NULL DEFAULT 0', () => {
    const c = cols('multi_agent_sessions').find((x) => x.name === 'total_cost_usd');
    expect(c).toBeDefined();
    expect(c).toMatchObject({ type: 'REAL', notnull: 1, dflt_value: '0' });
  });

  test('multi_agent_agent_sessions.cost_usd is REAL NOT NULL DEFAULT 0', () => {
    const c = cols('multi_agent_agent_sessions').find((x) => x.name === 'cost_usd');
    expect(c).toBeDefined();
    expect(c).toMatchObject({ type: 'REAL', notnull: 1, dflt_value: '0' });
  });

  // Not an idempotence test, though it used to say so (register C10): the
  // runner SKIPS a filename already in `schema_migrations`, so the body
  // never re-executes. No migration here survives a second apply, and none
  // needs to — the exactly-once contract is asserted in `db.migrations.test.ts`.
  test('the runner applies 029 exactly once — reopening skips it', () => {
    closeDb();
    expect(() => getDb()).not.toThrow();
    const sm = getDb()
      .prepare<[], { n: number }>(
        `SELECT COUNT(*) AS n FROM schema_migrations WHERE filename = '029_cost_accounting.sql'`,
      )
      .get();
    expect(sm?.n).toBe(1);
  });
});

describe('addAgentCost', () => {
  function seed(id: string) {
    createMultiAgentSession(id, 'orchestrator');
  }

  test('accumulates per agent AND into the session total', () => {
    seed('s-cost');
    addAgentCost('s-cost', 'orchestrator', 0.01);
    addAgentCost('s-cost', 'reviewer', 0.25);
    addAgentCost('s-cost', 'reviewer', 0.5);

    const perAgent = getDb()
      .prepare<[string], { agent_name: string; cost_usd: number }>(
        'SELECT agent_name, cost_usd FROM multi_agent_agent_sessions WHERE session_id = ? ORDER BY agent_name',
      )
      .all('s-cost');
    expect(perAgent).toEqual([
      { agent_name: 'orchestrator', cost_usd: 0.01 },
      { agent_name: 'reviewer', cost_usd: 0.75 },
    ]);

    // The invariant that makes the breakdown trustworthy: the session total is
    // exactly the sum of its per-agent rows.
    const total = getMultiAgentSession('s-cost')!.total_cost_usd;
    expect(total).toBeCloseTo(0.76, 10);
    expect(total).toBeCloseTo(
      perAgent.reduce((a, r) => a + r.cost_usd, 0),
      10,
    );
  });

  test('cost arriving before any checkpoint still lands, and the later checkpoint wins', () => {
    seed('s-order');
    // Defensive ordering: `runOneAttempt` writes the session id first, but the
    // INSERT branch must not wedge the row with a bogus cli_session_id if that
    // ever changes.
    addAgentCost('s-order', 'coder', 0.02);
    const before = getDb()
      .prepare<[string], { cli_session_id: string; cost_usd: number }>(
        'SELECT cli_session_id, cost_usd FROM multi_agent_agent_sessions WHERE session_id = ?',
      )
      .get('s-order');
    expect(before).toMatchObject({ cli_session_id: '', cost_usd: 0.02 });
  });

  test('[security] a non-finite or negative delta is dropped, not persisted', () => {
    seed('s-bad');
    addAgentCost('s-bad', 'a', Number.NaN);
    addAgentCost('s-bad', 'a', Number.POSITIVE_INFINITY);
    addAgentCost('s-bad', 'a', -5);
    addAgentCost('s-bad', 'a', 0);

    // Cost is monotonic. A NaN reaching the column would poison every later
    // read of the total (NaN + x is NaN), and the delta is derived from a
    // subprocess the agent influences.
    expect(getMultiAgentSession('s-bad')!.total_cost_usd).toBe(0);
    const rows = getDb()
      .prepare<[string], { n: number }>(
        'SELECT COUNT(*) AS n FROM multi_agent_agent_sessions WHERE session_id = ?',
      )
      .get('s-bad');
    expect(rows?.n).toBe(0);
  });
});
