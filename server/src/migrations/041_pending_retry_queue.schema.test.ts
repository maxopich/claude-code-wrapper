// Schema pin for 041 (Cebab-ygu.2). `npm run smoke` applies migrations but
// asserts nothing, so this file is the only shape gate for the per-agent
// pending-retry table that replaced the single session-scoped slot.
//
// The load-bearing property is the COMPOSITE primary key (session_id,
// agent_name): it is what lets two concurrent worker failures each keep their
// own slot instead of the second overwriting the first (the defect this
// migration fixes). Each case below reddens if that key regresses to
// session-only.
import { describe, expect, test } from 'vitest';
import { closeDb, getDb } from '../db.js';
import { createMultiAgentSession } from '../repo/multi_agent.js';
import { withTempDataDir } from '../test_support/temp_data_dir.js';

type ColumnInfo = { name: string; type: string; notnull: number; pk: number };

function seedSession(id: string): void {
  createMultiAgentSession(id, 'orchestrator', '001', `/tmp/${id}`, 'persistent');
}

function park(sessionId: string, agent: string, ts: number): void {
  getDb()
    .prepare(
      `INSERT INTO multi_agent_pending_retries
         (session_id, agent_name, prompt, reason, ts, error_event_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(sessionId, agent, `prompt-${agent}`, `reason-${agent}`, ts, 1);
}

describe('041_pending_retry_queue', () => {
  withTempDataDir('pending-retry-queue');

  test('table has NOT NULL columns and a composite (session_id, agent_name) PK', () => {
    const cols = getDb()
      .prepare<[], ColumnInfo>('PRAGMA table_info(multi_agent_pending_retries)')
      .all();
    const byName = new Map(cols.map((c) => [c.name, c]));
    for (const name of ['session_id', 'agent_name', 'prompt', 'reason', 'ts', 'error_event_id']) {
      expect(byName.get(name)?.notnull, `${name} NOT NULL`).toBe(1);
    }
    // The PK is what keys the slot per agent. `pk` is the 1-based position in a
    // composite key, so both parts are non-zero and nothing else is.
    expect(byName.get('session_id')!.pk).toBeGreaterThan(0);
    expect(byName.get('agent_name')!.pk).toBeGreaterThan(0);
    expect(byName.get('prompt')!.pk).toBe(0);
  });

  test('two agents in one session coexist; a third row for the same agent upserts', () => {
    seedSession('s-pk');
    expect(() => park('s-pk', 'reviewer', 40)).not.toThrow();
    // Different agent, same session — must NOT collide (the whole fix).
    expect(() => park('s-pk', 'editor', 55)).not.toThrow();
    // Same (session, agent) again — a bare INSERT collides on the PK, proving
    // the key is composite rather than session-only.
    expect(() => park('s-pk', 'reviewer', 99)).toThrow(/UNIQUE constraint failed/);

    const n = getDb()
      .prepare<[], { n: number }>(
        `SELECT COUNT(*) AS n FROM multi_agent_pending_retries WHERE session_id = 's-pk'`,
      )
      .get();
    expect(n?.n).toBe(2);
  });

  test('ON DELETE CASCADE drops the rows with their session', () => {
    seedSession('s-cascade');
    park('s-cascade', 'reviewer', 40);
    park('s-cascade', 'editor', 55);
    getDb().prepare(`DELETE FROM multi_agent_sessions WHERE id = 's-cascade'`).run();
    const n = getDb()
      .prepare<[], { n: number }>(
        `SELECT COUNT(*) AS n FROM multi_agent_pending_retries WHERE session_id = 's-cascade'`,
      )
      .get();
    expect(n?.n).toBe(0);
  });

  // Not an idempotence test: the runner SKIPS a filename already in
  // `schema_migrations`, so the body never re-executes. Reopening must not
  // re-apply and must not throw.
  test('the runner applies 041 exactly once — reopening skips it', () => {
    closeDb();
    expect(() => getDb()).not.toThrow();
    const sm = getDb()
      .prepare<[], { n: number }>(
        `SELECT COUNT(*) AS n FROM schema_migrations WHERE filename = '041_pending_retry_queue.sql'`,
      )
      .get();
    expect(sm?.n).toBe(1);
  });
});
