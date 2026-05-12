import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { upsertProject } from './projects.js';
import {
  addParticipant,
  createMultiAgentSession,
  endMultiAgentSession,
  listMultiAgentSessions,
  listMultiAgentSessionsWithIteration,
  listResolvedParticipants,
  setProjectBusInstalled,
} from './multi_agent.js';

// Isolation scaffolding: each test gets its own ~/.cebab dir so DB writes
// don't leak across tests or out to the real home.

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-multi-agent-repo-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb(); // runs migrations including 005 + 006
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('createMultiAgentSession + iteration_id', () => {
  test('round-trips iteration_id through insert + getMultiAgentSession', () => {
    const row = createMultiAgentSession('s1', 'chain', 'cebab-bus-s1', '042');
    expect(row.iteration_id).toBe('042');

    const rows = listMultiAgentSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.iteration_id).toBe('042');
  });

  test('iteration_id defaults to null when omitted', () => {
    const row = createMultiAgentSession('s2', 'chain', 'cebab-bus-s2');
    expect(row.iteration_id).toBeNull();
  });
});

describe('createMultiAgentSession + session_folder + lifecycle (migration 007)', () => {
  test('round-trips session_folder and lifecycle through insert + read', () => {
    // Both fields explicit.
    const folder = '/Users/test/workspace/.cebab-session-abcd1234';
    const row = createMultiAgentSession(
      's1',
      'orchestrator',
      'cebab-bus-s1',
      '001',
      folder,
      'temp',
    );
    expect(row.session_folder).toBe(folder);
    expect(row.lifecycle).toBe('temp');
  });

  test('session_folder defaults to null, lifecycle defaults to persistent', () => {
    // Mirrors a pre-007 caller that doesn't supply the new fields.
    const row = createMultiAgentSession('s2', 'chain', 'cebab-bus-s2', '001');
    expect(row.session_folder).toBeNull();
    expect(row.lifecycle).toBe('persistent');
  });

  test('persisted lifecycle survives across reads (not a default-only quirk)', () => {
    createMultiAgentSession('s3', 'orchestrator', 'cebab-bus-s3', '001', '/somewhere', 'temp');
    // Re-read from a fresh list — confirms the column write actually
    // landed, not just that the in-memory return is fabricated.
    const rows = listMultiAgentSessions();
    const s3 = rows.find((r) => r.id === 's3');
    expect(s3?.lifecycle).toBe('temp');
    expect(s3?.session_folder).toBe('/somewhere');
  });
});

describe('listMultiAgentSessionsWithIteration', () => {
  test('returns only rows with iteration_id (drops pre-006 / null rows)', () => {
    createMultiAgentSession('with', 'chain', 'tx-with', '001');
    createMultiAgentSession('without', 'chain', 'tx-without', null);
    const filtered = listMultiAgentSessionsWithIteration();
    expect(filtered.map((r) => r.id)).toEqual(['with']);
  });

  test('orders by started_at descending (most recent first)', () => {
    // started_at is filled by now() at insert; insert with a delay to
    // guarantee distinct timestamps even on a fast machine.
    createMultiAgentSession('older', 'chain', 'tx-older', '001');
    // Sleep just enough to force a different ms timestamp on the next insert.
    const t = Date.now();
    while (Date.now() === t) {
      /* spin */
    }
    createMultiAgentSession('newer', 'chain', 'tx-newer', '002');

    const rows = listMultiAgentSessionsWithIteration();
    expect(rows.map((r) => r.id)).toEqual(['newer', 'older']);
  });
});

describe('listResolvedParticipants', () => {
  test('joins multi_agent_participants with projects to return slug + name + path', () => {
    // Setup: two real projects + a session referencing them as workers.
    const reviewerPath = path.join(tmpRoot, 'workspace', 'reviewer');
    const evalPath = path.join(tmpRoot, 'workspace', 'evaluator');
    fs.mkdirSync(reviewerPath, { recursive: true });
    fs.mkdirSync(evalPath, { recursive: true });
    const reviewer = upsertProject('Reviewer', reviewerPath);
    const evaluator = upsertProject('Evaluator', evalPath);
    setProjectBusInstalled(reviewer.id, true, 'reviewer');
    setProjectBusInstalled(evaluator.id, true, 'evaluator');

    createMultiAgentSession('s1', 'chain', 'tx-s1', '001');
    addParticipant('s1', reviewer.id, 'worker', 0);
    addParticipant('s1', evaluator.id, 'worker', 1);

    const rows = listResolvedParticipants('s1');
    expect(rows).toHaveLength(2);
    // Ordered by chain_order ASC.
    expect(rows[0]!.bus_agent_name).toBe('reviewer');
    expect(rows[0]!.project_name).toBe('Reviewer');
    expect(rows[0]!.project_path).toBe(reviewerPath);
    expect(rows[1]!.bus_agent_name).toBe('evaluator');
  });

  test('preserves order for orchestrator-mode participants (chain_order is NULL)', () => {
    // Orchestrator-mode workers have chain_order=null. The ORDER BY in
    // listResolvedParticipants puts null after non-null, then breaks ties
    // by project_id ASC — verify the project_id fallback is deterministic.
    const aPath = path.join(tmpRoot, 'workspace', 'agent-a');
    const bPath = path.join(tmpRoot, 'workspace', 'agent-b');
    fs.mkdirSync(aPath, { recursive: true });
    fs.mkdirSync(bPath, { recursive: true });
    const a = upsertProject('AgentA', aPath);
    const b = upsertProject('AgentB', bPath);
    setProjectBusInstalled(a.id, true, 'a');
    setProjectBusInstalled(b.id, true, 'b');

    createMultiAgentSession('orch', 'orchestrator', 'tx-orch', '002');
    // Add B before A so we can confirm the result is by project_id, not insert order.
    addParticipant('orch', b.id, 'worker', null);
    addParticipant('orch', a.id, 'worker', null);

    const rows = listResolvedParticipants('orch');
    expect(rows.map((r) => r.bus_agent_name)).toEqual(['a', 'b']);
  });
});

describe('endMultiAgentSession status transitions', () => {
  test('marks status + ended_at; affects status filter in listMultiAgentSessions', () => {
    createMultiAgentSession('s', 'chain', 'tx', '001');
    let rows = listMultiAgentSessions();
    expect(rows[0]!.status).toBe('running');
    expect(rows[0]!.ended_at).toBeNull();

    endMultiAgentSession('s', 'completed');

    rows = listMultiAgentSessions();
    expect(rows[0]!.status).toBe('completed');
    expect(rows[0]!.ended_at).toBeGreaterThan(0);
  });
});
