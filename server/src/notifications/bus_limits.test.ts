import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ServerMsg, NotificationEnvelope } from '@cebab/shared/protocol';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { MaxTurnsReachedError } from '../bus/errors.js';
import { hopBudgetExhaustedText } from '../bus/turn_guard.js';
import { dispatchBusMaxTurnsReached, dispatchHopBudgetExhausted } from './bus_limits.js';
import { _resetCoalesceState } from './dispatcher.js';

/**
 * `Cebab-vie.17` — the two bus runaway brakes and the rows they write.
 *
 * Shape-level pins, so a field rename cannot pass by being "still a safety
 * notification". The router-level cases (both `*.router_drop.test.ts` files)
 * assert that these fire at all; this file asserts they say the right thing.
 */

const SID = 'bus-limits-session';

let tmpRoot: string;
let originalDataDir: string;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-bus-limits-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  _resetCoalesceState();
});

afterEach(() => {
  errSpy.mockRestore();
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function selectAuditRows(): Array<{
  kind: string;
  reason_code: string;
  agent_id: string | null;
  payload_json: string;
}> {
  return getDb()
    .prepare(
      `SELECT kind, reason_code, agent_id, payload_json FROM safety_audit
       WHERE kind != 'audit.chain_reset' ORDER BY ts ASC, id ASC`,
    )
    .all() as Array<{
    kind: string;
    reason_code: string;
    agent_id: string | null;
    payload_json: string;
  }>;
}

describe('[security][BE-1] hop-budget exhaustion writes the chain row and the toast', () => {
  test('the audit row carries the counts and which router stopped', () => {
    const sent: ServerMsg[] = [];
    const result = dispatchHopBudgetExhausted({
      sessionId: SID,
      hopsCount: 30,
      hopBudget: 30,
      mode: 'orchestrator',
      send: (m) => sent.push(m),
    });

    expect(result.ok).toBe(true);
    const rows = selectAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'hop_budget.exhausted',
      reason_code: 'hop_budget_exhausted',
      // Session-level: no single agent is at fault for a budget stop.
      agent_id: null,
    });
    expect(JSON.parse(rows[0]!.payload_json)).toEqual({
      hopsCount: 30,
      hopBudget: 30,
      mode: 'orchestrator',
    });

    expect(sent).toHaveLength(1);
    const env = sent[0] as NotificationEnvelope & { type: 'notification' };
    expect(env).toMatchObject({
      type: 'notification',
      class: 'safety',
      // A control doing its job, not something that got past a control.
      severity: 'warn',
      reasonCode: 'hop_budget_exhausted',
      sessionId: SID,
      sticky: true,
      dedupeKey: `hop_budget.exhausted:${SID}`,
      title: 'Hop budget exhausted (30/30)',
    });
    // The toast and the persisted `cebab → _sink` row must be the SAME
    // sentence, or the audit log and the transcript disagree about why the
    // session stopped.
    expect(env.message).toBe(hopBudgetExhaustedText(30, 30));
    expect(env.auditRowId).toBeTruthy();
  });

  test('`mode` reaches the payload — the two routers are not interchangeable here', () => {
    const sent: ServerMsg[] = [];
    dispatchHopBudgetExhausted({
      sessionId: SID,
      hopsCount: 3,
      hopBudget: 3,
      mode: 'chain',
      send: (m) => sent.push(m),
    });
    expect(JSON.parse(selectAuditRows()[0]!.payload_json).mode).toBe('chain');
  });

  test('a broken chain is reported to the caller, not swallowed', () => {
    // What the routers' divergence from BE-1 depends on: they tear down
    // anyway, but only because `ok:false` reaches them to be logged.
    getDb().exec('DROP TABLE safety_audit');
    const sent: ServerMsg[] = [];
    const result = dispatchHopBudgetExhausted({
      sessionId: SID,
      hopsCount: 1,
      hopBudget: 1,
      mode: 'orchestrator',
      send: (m) => sent.push(m),
    });
    expect(result).toEqual({ ok: false, error: 'audit_write_failed' });
    expect(sent).toEqual([]);
  });
});

describe('[security][BE-1] a bus cap hit writes the SAME audit kind as the single-agent one', () => {
  test('kind, reason code and payload match the single-agent shape, split by `surface`', () => {
    const sent: ServerMsg[] = [];
    const err = new MaxTurnsReachedError('coder', 50, 50);
    const result = dispatchBusMaxTurnsReached({
      sessionId: SID,
      err,
      send: (m) => sent.push(m),
    });

    expect(result.ok).toBe(true);
    const rows = selectAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      // Deliberately the SAME pair `ws/server.ts` writes for a single-agent
      // cap hit. A bus-specific kind would turn one forensic query into two
      // and quietly falsify the parity this change is about.
      kind: 'max_turns.hit',
      reason_code: 'max_turns_exceeded',
      // Which participant is looping is the operator's first question.
      agent_id: 'coder',
    });
    expect(JSON.parse(rows[0]!.payload_json)).toEqual({
      effectiveMaxTurns: 50,
      actor: 'system',
      numTurns: 50,
      hadOverride: false,
      surface: 'bus',
    });

    const env = sent[0] as NotificationEnvelope & { type: 'notification' };
    expect(env).toMatchObject({
      class: 'safety',
      severity: 'warn',
      sticky: true,
      sessionId: SID,
      // Per-AGENT, unlike the single-agent key: with N workers a session-wide
      // key would collapse exactly the distinction the operator needs.
      dedupeKey: `max_turns.hit:${SID}:coder`,
      title: 'coder reached the turn cap (50)',
    });
    // One wording, one place — the sentinel's own message is also what the
    // transcript row shows.
    expect(env.message).toBe(err.message);
  });

  test('two different agents hitting the cap are two rows, not one', () => {
    const sent: ServerMsg[] = [];
    dispatchBusMaxTurnsReached({
      sessionId: SID,
      err: new MaxTurnsReachedError('coder', 50, 50),
      send: (m) => sent.push(m),
    });
    dispatchBusMaxTurnsReached({
      sessionId: SID,
      err: new MaxTurnsReachedError('scribe', 50, 50),
      send: (m) => sent.push(m),
    });
    // Sorted, not positional: two appends inside the same millisecond tie on
    // `ts`, and `id` is a nanoid rather than a counter, so the row ORDER is a
    // coin flip. What this test is about is that there are two distinct rows.
    expect(
      selectAuditRows()
        .map((r) => r.agent_id)
        .sort(),
    ).toEqual(['coder', 'scribe']);
    expect(sent).toHaveLength(2);
  });
});
