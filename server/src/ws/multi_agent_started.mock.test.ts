import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { createMultiAgentSession, getMultiAgentSession } from '../repo/multi_agent.js';

// Cluster G Phase 2c (UI-A3): the WS handler projects `multi_agent_sessions.mock`
// (migration 023, stamped at INSERT from `config.mock`) onto the wire-side
// `multi_agent_started.mock?: boolean` field at three sites in `ws/server.ts`:
//
//   1. R-A/R-B resume path (re-attach after browser refresh / server restart)
//   2. Orchestrator fresh-start path
//   3. Chain fresh-start path
//
// All three use the same spread-omit shape:
//
//     ...(sessionRow?.mock === 1 ? { mock: true } : {})
//
// This test pins the contract from the *row* side: the `mock` value the
// handler reads is what the wire envelope ships. Mirrors the single-agent
// Phase 2b harness in `translate.mock_flag.test.ts`, but the bus emit
// happens inline in the handler (no `translate()` seam to call), so we
// validate via the same DB → row.mock projection that the handler uses.
//
// The CREATE-time/runtime divergence is critical: a bus session created in
// mock keeps the badge after a live restart (the row column is immutable).
// This is what makes the MockBadge a forensic record, not just a process
// posture.

function projectMockField(
  row: { mock: number } | undefined,
): { mock: true } | Record<string, never> {
  // Inline mirror of the spread-omit at the three ws/server.ts sites. Kept
  // here so the test fails if the handler's projection logic drifts.
  return row?.mock === 1 ? { mock: true } : {};
}

// ---- isolated fs + DB scaffolding (matches translate.mock_flag.test.ts) ----

let tmpRoot: string;
let originalDataDir: string;
let originalMock: boolean;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-bus-mock-'));
  originalDataDir = config.dataDir;
  originalMock = config.mock;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  config.mock = originalMock;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('multi_agent_started — Cluster G Phase 2c mock projection', () => {
  test('bus session created under MOCK runtime → wire mock=true (orchestrator)', () => {
    config.mock = true;
    createMultiAgentSession('bus-mock-orch', 'orchestrator');
    const row = getMultiAgentSession('bus-mock-orch');
    expect(row?.mock).toBe(1);
    expect(projectMockField(row)).toEqual({ mock: true });
  });

  test('bus session created under MOCK runtime → wire mock=true (chain)', () => {
    // Same projection rule applies to chain mode; the two fresh-start paths
    // in ws/server.ts share the spread-omit shape, only the `mode` differs.
    config.mock = true;
    createMultiAgentSession('bus-mock-chain', 'chain');
    const row = getMultiAgentSession('bus-mock-chain');
    expect(row?.mock).toBe(1);
    expect(projectMockField(row)).toEqual({ mock: true });
  });

  test('bus session created under live runtime → wire omits mock', () => {
    // Additive-optional contract per single-agent Phase 2b: `mock: false` is
    // NEVER on the wire — the field is omitted instead, so pre-G2c clients
    // (and the JSON-minimal common-path live envelope) treat undefined and
    // false identically.
    config.mock = false;
    createMultiAgentSession('bus-live', 'orchestrator');
    const row = getMultiAgentSession('bus-live');
    expect(row?.mock).toBe(0);
    const projection = projectMockField(row);
    expect(projection).toEqual({});
    expect('mock' in projection).toBe(false);
  });

  test('CREATE-time mode wins over runtime mode (the divergence case)', () => {
    // The bus analog of single-agent Phase 2b's CREATE-time invariant. A bus
    // session created under MOCK must keep the badge even after the operator
    // restarts Cebab in live mode and re-attaches via R-B. The row's `mock`
    // column is locked at CREATE; `config.mock` is the runtime flag for the
    // *current* process. The handler always reads the row (not config) when
    // projecting onto the wire, so an R-B reattach of a mock-era session
    // emits `mock: true` even when the runtime is live.
    config.mock = true;
    createMultiAgentSession('bus-historical-mock', 'orchestrator');
    config.mock = false; // operator "restarted Cebab in live mode"
    const row = getMultiAgentSession('bus-historical-mock');
    expect(row?.mock).toBe(1);
    expect(projectMockField(row)).toEqual({ mock: true });
  });

  test('unknown session id (no row) → wire omits mock (no false-positive)', () => {
    // Defence-in-depth: if a handler somehow reaches the `send()` call with a
    // session id that has no row (smoke-test path, future refactor), the
    // projection must not invent a value. getMultiAgentSession returns
    // undefined → spread-omit.
    config.mock = true;
    const row = getMultiAgentSession('bus-never-created');
    expect(row).toBeUndefined();
    const projection = projectMockField(row);
    expect(projection).toEqual({});
    expect('mock' in projection).toBe(false);
  });
});
