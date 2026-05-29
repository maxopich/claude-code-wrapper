import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { createMultiAgentSession, listMultiAgentSessions } from './multi_agent.js';
import { upsertProject } from './projects.js';
import { createSession } from './sessions.js';

// Cluster G Phase 1 (A3): persister stamping for the new `mock` column on
// sessions + multi_agent_sessions. The schema test (023_mock_flag.schema)
// pins the column shape; this test pins the WRITE behavior — that
// `createSession` and `createMultiAgentSession` actually consult
// `config.mock` at INSERT time and store the resulting 0/1 onto the row.
//
// We mutate `config.mock` directly between assertions because the per-test
// scaffolding already isolates the DB; the only state we're sharing across
// tests is the module-scoped `config` object, which we restore in
// `afterEach`.

let tmpRoot: string;
let originalDataDir: string;
let originalMock: boolean;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-mock-stamp-'));
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

describe('createSession + mock stamping', () => {
  test('stamps mock=0 when config.mock is false (live runtime)', () => {
    config.mock = false;
    const project = upsertProject('proj-live', '/tmp/proj-live');
    createSession('sess-live', project.id, null);
    const row = getDb()
      .prepare<[string], { mock: number }>(`SELECT mock FROM sessions WHERE id = ?`)
      .get('sess-live');
    expect(row?.mock).toBe(0);
  });

  test('stamps mock=1 when config.mock is true (MOCK runtime)', () => {
    config.mock = true;
    const project = upsertProject('proj-mock', '/tmp/proj-mock');
    createSession('sess-mock', project.id, null);
    const row = getDb()
      .prepare<[string], { mock: number }>(`SELECT mock FROM sessions WHERE id = ?`)
      .get('sess-mock');
    expect(row?.mock).toBe(1);
  });

  test('reads config.mock at INSERT time — flipping mid-test does not retroactively re-tag prior rows', () => {
    // Even though R-G2 says config.mock shouldn't flip mid-process, the
    // repo function's read-at-call-time contract is what makes the spec
    // implementable; tests asserting on a stable runtime should still
    // see per-row tagging even if the flag changes between calls.
    const project = upsertProject('proj-mixed', '/tmp/proj-mixed');
    config.mock = false;
    createSession('sess-a', project.id, null);
    config.mock = true;
    createSession('sess-b', project.id, null);
    config.mock = false;
    createSession('sess-c', project.id, null);
    const rows = getDb()
      .prepare<
        [],
        { id: string; mock: number }
      >(`SELECT id, mock FROM sessions ORDER BY id`)
      .all();
    expect(rows).toEqual([
      { id: 'sess-a', mock: 0 },
      { id: 'sess-b', mock: 1 },
      { id: 'sess-c', mock: 0 },
    ]);
  });
});

describe('createMultiAgentSession + mock stamping', () => {
  test('stamps mock=0 when config.mock is false (live runtime)', () => {
    config.mock = false;
    const row = createMultiAgentSession('bus-live', 'orchestrator');
    expect(row.mock).toBe(0);
  });

  test('stamps mock=1 when config.mock is true (MOCK runtime)', () => {
    config.mock = true;
    const row = createMultiAgentSession('bus-mock', 'orchestrator');
    expect(row.mock).toBe(1);
  });

  test('mock=1 round-trips through listMultiAgentSessions', () => {
    // The MockBadge UI mirror (Phase 2) reads this through the same list
    // call, so the round-trip via the row projector matters.
    config.mock = true;
    createMultiAgentSession('bus-mock-list', 'chain', '042');
    const rows = listMultiAgentSessions();
    const matched = rows.find((r) => r.id === 'bus-mock-list');
    expect(matched?.mock).toBe(1);
  });
});
