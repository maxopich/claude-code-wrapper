import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { upsertProject } from './projects.js';
import {
  addParticipant,
  appendMultiAgentEvent,
  clearFinishedMultiAgentSessions,
  computeRecoveryContext,
  createMultiAgentSession,
  endMultiAgentSession,
  getLastRunForTemplate,
  listMultiAgentEvents,
  listMultiAgentSessions,
  listMultiAgentSessionsWithIteration,
  archiveMultiAgentSession,
  unarchiveMultiAgentSession,
  listParticipants,
  listResolvedParticipants,
  recordSessionTeardown,
  setProjectBusInstalled,
  appendMultiAgentMutation,
  confirmMutationByToolUseId,
  listMultiAgentMutations,
  capToolIoJson,
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
    const row = createMultiAgentSession('s1', 'chain', '042');
    expect(row.iteration_id).toBe('042');

    const rows = listMultiAgentSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.iteration_id).toBe('042');
  });

  test('iteration_id defaults to null when omitted', () => {
    const row = createMultiAgentSession('s2', 'chain');
    expect(row.iteration_id).toBeNull();
  });
});

describe('createMultiAgentSession + session_folder + lifecycle (migration 007)', () => {
  test('round-trips session_folder and lifecycle through insert + read', () => {
    // Both fields explicit.
    const folder = '/Users/test/workspace/.cebab-session-abcd1234';
    const row = createMultiAgentSession('s1', 'orchestrator', '001', folder, 'temp');
    expect(row.session_folder).toBe(folder);
    expect(row.lifecycle).toBe('temp');
  });

  test('session_folder defaults to null, lifecycle defaults to persistent', () => {
    // Mirrors a caller that doesn't supply the new fields.
    const row = createMultiAgentSession('s2', 'chain', '001');
    expect(row.session_folder).toBeNull();
    expect(row.lifecycle).toBe('persistent');
  });

  test('persisted lifecycle survives across reads (not a default-only quirk)', () => {
    createMultiAgentSession('s3', 'orchestrator', '001', '/somewhere', 'temp');
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
    createMultiAgentSession('with', 'chain', '001');
    createMultiAgentSession('without', 'chain', null);
    const filtered = listMultiAgentSessionsWithIteration();
    expect(filtered.map((r) => r.id)).toEqual(['with']);
  });

  test('orders by started_at descending (most recent first)', () => {
    // started_at is filled by now() at insert; insert with a delay to
    // guarantee distinct timestamps even on a fast machine.
    createMultiAgentSession('older', 'chain', '001');
    // Sleep just enough to force a different ms timestamp on the next insert.
    const t = Date.now();
    while (Date.now() === t) {
      /* spin */
    }
    createMultiAgentSession('newer', 'chain', '002');

    const rows = listMultiAgentSessionsWithIteration();
    expect(rows.map((r) => r.id)).toEqual(['newer', 'older']);
  });
});

describe('Cluster D Phase 1 — archive column (migration 017)', () => {
  test('archived defaults to 0 for new sessions', () => {
    const row = createMultiAgentSession('s1', 'chain', '001');
    expect(row.archived).toBe(0);
  });

  test('archiveMultiAgentSession flips 0→1; returns true', () => {
    createMultiAgentSession('s1', 'chain', '001');
    expect(archiveMultiAgentSession('s1')).toBe(true);
    const rows = listMultiAgentSessions();
    expect(rows[0]!.archived).toBe(1);
  });

  test('archive is idempotent — second archive returns false (no row changed)', () => {
    createMultiAgentSession('s1', 'chain', '001');
    archiveMultiAgentSession('s1');
    expect(archiveMultiAgentSession('s1')).toBe(false);
  });

  test('archive on unknown id returns false', () => {
    expect(archiveMultiAgentSession('nope')).toBe(false);
  });

  test('listMultiAgentSessionsWithIteration excludes archived by default', () => {
    createMultiAgentSession('a', 'chain', '001');
    createMultiAgentSession('b', 'chain', '002');
    archiveMultiAgentSession('a');
    const rows = listMultiAgentSessionsWithIteration();
    expect(rows.map((r) => r.id)).toEqual(['b']);
  });

  test('listMultiAgentSessionsWithIteration({ includeArchived: true }) surfaces archived rows', () => {
    createMultiAgentSession('a', 'chain', '001');
    // Force distinct started_at so the DESC sort is deterministic.
    const t = Date.now();
    while (Date.now() === t) {
      /* spin */
    }
    createMultiAgentSession('b', 'chain', '002');
    archiveMultiAgentSession('a');
    const rows = listMultiAgentSessionsWithIteration({ includeArchived: true });
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  test('unarchiveMultiAgentSession reverses archive; subsequent default-list includes the row', () => {
    createMultiAgentSession('a', 'chain', '001');
    archiveMultiAgentSession('a');
    expect(unarchiveMultiAgentSession('a')).toBe(true);
    const rows = listMultiAgentSessionsWithIteration();
    expect(rows.map((r) => r.id)).toEqual(['a']);
  });

  test('unarchive on a non-archived row returns false', () => {
    createMultiAgentSession('a', 'chain', '001');
    expect(unarchiveMultiAgentSession('a')).toBe(false);
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

    createMultiAgentSession('s1', 'chain', '001');
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

    createMultiAgentSession('orch', 'orchestrator', '002');
    // Add B before A so we can confirm the result is by project_id, not insert order.
    addParticipant('orch', b.id, 'worker', null);
    addParticipant('orch', a.id, 'worker', null);

    const rows = listResolvedParticipants('orch');
    expect(rows.map((r) => r.bus_agent_name)).toEqual(['a', 'b']);
  });
});

describe('endMultiAgentSession status transitions', () => {
  test('marks status + ended_at; affects status filter in listMultiAgentSessions', () => {
    createMultiAgentSession('s', 'chain', '001');
    let rows = listMultiAgentSessions();
    expect(rows[0]!.status).toBe('running');
    expect(rows[0]!.ended_at).toBeNull();

    endMultiAgentSession('s', 'completed');

    rows = listMultiAgentSessions();
    expect(rows[0]!.status).toBe('completed');
    expect(rows[0]!.ended_at).toBeGreaterThan(0);
  });
});

describe('clearFinishedMultiAgentSessions', () => {
  test('removes only sessions in a terminal status; running rows survive', () => {
    // Three sessions covering each interesting status: one still running
    // (must survive), one completed, one crashed (both must go).
    createMultiAgentSession('alive', 'chain', '001');
    createMultiAgentSession('done', 'chain', '002');
    createMultiAgentSession('boom', 'chain', '003');
    endMultiAgentSession('done', 'completed');
    endMultiAgentSession('boom', 'crashed');

    const removed = clearFinishedMultiAgentSessions();
    expect(removed).toBe(2);

    const remaining = listMultiAgentSessions().map((r) => r.id);
    expect(remaining).toEqual(['alive']);
  });

  test('also wipes events + participants for the deleted sessions (no orphans)', () => {
    // Build out a session with both children, then end + clear, then
    // assert nothing references the deleted session id anymore.
    createMultiAgentSession('s1', 'orchestrator', '001');
    const projPath = path.join(tmpRoot, 'p1');
    fs.mkdirSync(projPath);
    const proj = upsertProject('p1', projPath);
    setProjectBusInstalled(proj.id, true, 'p1');
    addParticipant('s1', proj.id, 'worker', null);
    appendMultiAgentEvent('s1', 'cebab', 'p1', 'prompt', 'hello');
    appendMultiAgentEvent('s1', 'p1', 'cebab', 'reply', 'world');

    // Sanity: rows are there pre-clear.
    expect(listParticipants('s1')).toHaveLength(1);
    expect(listMultiAgentEvents('s1')).toHaveLength(2);

    endMultiAgentSession('s1', 'stopped');
    clearFinishedMultiAgentSessions();

    expect(listMultiAgentSessions()).toHaveLength(0);
    expect(listParticipants('s1')).toHaveLength(0);
    expect(listMultiAgentEvents('s1')).toHaveLength(0);
  });

  test('returns 0 and no-ops when only running sessions exist', () => {
    createMultiAgentSession('alive', 'chain', '001');
    const removed = clearFinishedMultiAgentSessions();
    expect(removed).toBe(0);
    expect(listMultiAgentSessions()).toHaveLength(1);
  });

  test('keeps a running session intact even when finished siblings are wiped', () => {
    // Regression guard for the "operator clicks Clear mid-run" path: the
    // active session and its events/participants must survive cleanup.
    createMultiAgentSession('alive', 'orchestrator', '042');
    createMultiAgentSession('done', 'chain', '041');
    endMultiAgentSession('done', 'completed');

    const projPath = path.join(tmpRoot, 'live-proj');
    fs.mkdirSync(projPath);
    const proj = upsertProject('live', projPath);
    setProjectBusInstalled(proj.id, true, 'live');
    addParticipant('alive', proj.id, 'worker', null);
    appendMultiAgentEvent('alive', 'cebab', 'live', 'prompt', 'hi');

    clearFinishedMultiAgentSessions();

    expect(listMultiAgentSessions().map((r) => r.id)).toEqual(['alive']);
    expect(listParticipants('alive')).toHaveLength(1);
    expect(listMultiAgentEvents('alive')).toHaveLength(1);
  });
});

describe('computeRecoveryContext (Item #7)', () => {
  // `appendMultiAgentEvent` and `upsertAgentSession` both stamp Date.now()
  // internally, so for precise ordering we INSERT directly via getDb(). The
  // production heuristic only reads `ts` (event) and `updated_at` (agent
  // session) — both of which we can set explicitly here.
  function insertEventAt(sessionId: string, source: string, ts: number): void {
    getDb()
      .prepare(
        `INSERT INTO multi_agent_events (session_id, ts, source, destination, kind, text)
         VALUES (?, ?, ?, 'cebab', 'reply', '')`,
      )
      .run(sessionId, ts, source);
  }
  function upsertAgentAt(sessionId: string, agentName: string, updatedAt: number): void {
    getDb()
      .prepare(
        `INSERT INTO multi_agent_agent_sessions (session_id, agent_name, cli_session_id, updated_at)
         VALUES (?, ?, 'sdk-${agentName}', ?)
         ON CONFLICT (session_id, agent_name)
         DO UPDATE SET cli_session_id = excluded.cli_session_id,
                       updated_at     = excluded.updated_at`,
      )
      .run(sessionId, agentName, updatedAt);
  }

  test('returns null when no events exist', () => {
    createMultiAgentSession('s1', 'orchestrator', '001');
    expect(computeRecoveryContext('s1')).toBeNull();
  });

  test('flags agent as interrupted when lastEventTs > lastCheckpointTs', () => {
    createMultiAgentSession('s1', 'orchestrator', '001');
    upsertAgentAt('s1', 'workerA', 150);
    insertEventAt('s1', 'workerA', 200);

    const ctx = computeRecoveryContext('s1');
    expect(ctx).not.toBeNull();
    expect(ctx!.interruptedAgents).toEqual([
      { agentName: 'workerA', lastEventTs: 200, lastCheckpointTs: 150 },
    ]);
  });

  test('flags agent as interrupted when lastCheckpointTs is null (never checkpointed)', () => {
    createMultiAgentSession('s1', 'orchestrator', '001');
    // No upsertAgentAt — agent never checkpointed (e.g. crashed during intro).
    insertEventAt('s1', 'workerB', 300);

    const ctx = computeRecoveryContext('s1');
    expect(ctx).not.toBeNull();
    expect(ctx!.interruptedAgents).toEqual([
      { agentName: 'workerB', lastEventTs: 300, lastCheckpointTs: null },
    ]);
  });

  test('does NOT flag clean-completed agent (lastCheckpointTs >= lastEventTs)', () => {
    createMultiAgentSession('s1', 'orchestrator', '001');
    insertEventAt('s1', 'workerC', 100);
    upsertAgentAt('s1', 'workerC', 150);

    const ctx = computeRecoveryContext('s1');
    expect(ctx).not.toBeNull();
    expect(ctx!.interruptedAgents).toEqual([]);
  });

  test('excludes synthetic sources cebab and _sink from per-agent join', () => {
    createMultiAgentSession('s1', 'orchestrator', '001');
    // Synthetic sources have no agent_sessions row by design — they would be
    // flagged interrupted if not excluded. Real workerD checkpoints cleanly.
    insertEventAt('s1', 'cebab', 400);
    insertEventAt('s1', '_sink', 500);
    insertEventAt('s1', 'workerD', 150);
    upsertAgentAt('s1', 'workerD', 200);

    const ctx = computeRecoveryContext('s1');
    expect(ctx).not.toBeNull();
    expect(ctx!.interruptedAgents).toEqual([]);
    // But the synthetic event's ts still anchors staleSinceTs — the wall-clock
    // anchor reflects the most recent activity of any kind.
    expect(ctx!.staleSinceTs).toBe(500);
  });

  test('sorts interruptedAgents by lastEventTs descending (most recent first)', () => {
    createMultiAgentSession('s1', 'orchestrator', '001');
    // Three never-checkpointed agents, varying lastEventTs.
    insertEventAt('s1', 'alpha', 100);
    insertEventAt('s1', 'beta', 200);
    insertEventAt('s1', 'gamma', 150);

    const ctx = computeRecoveryContext('s1');
    expect(ctx!.interruptedAgents.map((a) => a.agentName)).toEqual(['beta', 'gamma', 'alpha']);
  });

  test('staleSinceTs reflects the highest event ts overall, even when synthetic', () => {
    createMultiAgentSession('s1', 'orchestrator', '001');
    insertEventAt('s1', 'workerE', 100);
    upsertAgentAt('s1', 'workerE', 150); // clean
    // A later cebab error event happens after workerE checkpointed cleanly.
    insertEventAt('s1', 'cebab', 600);

    const ctx = computeRecoveryContext('s1');
    expect(ctx!.staleSinceTs).toBe(600);
    expect(ctx!.interruptedAgents).toEqual([]);
  });

  test('uses MAX(ts) per agent (multiple events from one agent)', () => {
    createMultiAgentSession('s1', 'orchestrator', '001');
    // workerF emits three events in order; checkpoint lands between #2 and #3.
    insertEventAt('s1', 'workerF', 100);
    insertEventAt('s1', 'workerF', 200);
    upsertAgentAt('s1', 'workerF', 250);
    insertEventAt('s1', 'workerF', 300);

    const ctx = computeRecoveryContext('s1');
    // workerF's MAX(ts)=300 > checkpoint=250 → flagged.
    expect(ctx!.interruptedAgents).toEqual([
      { agentName: 'workerF', lastEventTs: 300, lastCheckpointTs: 250 },
    ]);
  });

  test('mixes interrupted + clean agents in one session', () => {
    createMultiAgentSession('s1', 'orchestrator', '001');
    insertEventAt('s1', 'clean', 100);
    upsertAgentAt('s1', 'clean', 200);
    insertEventAt('s1', 'dirty', 300);
    upsertAgentAt('s1', 'dirty', 250);

    const ctx = computeRecoveryContext('s1');
    expect(ctx!.interruptedAgents).toEqual([
      { agentName: 'dirty', lastEventTs: 300, lastCheckpointTs: 250 },
    ]);
  });
});

// ----------------------------------------------------------------------------
// PR-7 (migration 013): per-template hopBudget plumb + last-run health rail.
// ----------------------------------------------------------------------------

describe('createMultiAgentSession + PR-7 template_id / hop_budget', () => {
  test('round-trips templateId and hopBudget through insert + read', () => {
    const row = createMultiAgentSession('p7-s1', 'orchestrator', '001', '/folder', 'persistent', {
      templateId: 'tpl-abc',
      hopBudget: 25,
    });
    expect(row.template_id).toBe('tpl-abc');
    expect(row.hop_budget).toBe(25);

    // Belt: re-read from a fresh listing, confirm the column write
    // actually landed rather than just being the in-memory return.
    const rows = listMultiAgentSessions();
    const persisted = rows.find((r) => r.id === 'p7-s1');
    expect(persisted?.template_id).toBe('tpl-abc');
    expect(persisted?.hop_budget).toBe(25);
  });

  test('templateId and hopBudget both default to null when opts omitted', () => {
    // Mirrors a pre-PR-7 call site (orchestrator/chain modes that haven't
    // been updated yet would land here). The rail simply doesn't attribute
    // these rows to any template.
    const row = createMultiAgentSession('p7-s2', 'chain', '001', '/folder', 'persistent');
    expect(row.template_id).toBeNull();
    expect(row.hop_budget).toBeNull();
  });

  test('hops_used and first_error start null at create time', () => {
    // These are written by recordSessionTeardown at teardown — the
    // create row's view of them should be null even when the caller
    // passed templateId/hopBudget.
    const row = createMultiAgentSession('p7-s3', 'chain', '001', '/folder', 'persistent', {
      templateId: 't',
      hopBudget: 5,
    });
    expect(row.hops_used).toBeNull();
    expect(row.first_error).toBeNull();
  });
});

describe('recordSessionTeardown', () => {
  test('writes hops_used and first_error onto an existing row', () => {
    createMultiAgentSession('td-s1', 'orchestrator', '001', '/f', 'persistent', {
      templateId: 't',
      hopBudget: 12,
    });
    recordSessionTeardown('td-s1', { hopsUsed: 9, firstError: 'oops' });
    const row = listMultiAgentSessions().find((r) => r.id === 'td-s1');
    expect(row?.hops_used).toBe(9);
    expect(row?.first_error).toBe('oops');
    // Existing columns are untouched.
    expect(row?.template_id).toBe('t');
    expect(row?.hop_budget).toBe(12);
  });

  test('idempotent: a second call overwrites with the newer values', () => {
    createMultiAgentSession('td-s2', 'chain', '001', '/f', 'persistent');
    recordSessionTeardown('td-s2', { hopsUsed: 3 });
    recordSessionTeardown('td-s2', { hopsUsed: 7, firstError: 'late error' });
    const row = listMultiAgentSessions().find((r) => r.id === 'td-s2');
    expect(row?.hops_used).toBe(7);
    expect(row?.first_error).toBe('late error');
  });

  test('truncates firstError to 200 chars (defence in depth)', () => {
    createMultiAgentSession('td-s3', 'chain', '001', '/f', 'persistent');
    const big = 'x'.repeat(500);
    recordSessionTeardown('td-s3', { hopsUsed: 1, firstError: big });
    const row = listMultiAgentSessions().find((r) => r.id === 'td-s3');
    expect(row?.first_error?.length).toBe(200);
    expect(row?.first_error?.endsWith('x')).toBe(true);
  });

  test('empty / null firstError is stored as null (not "")', () => {
    createMultiAgentSession('td-s4', 'chain', '001', '/f', 'persistent');
    recordSessionTeardown('td-s4', { hopsUsed: 5, firstError: null });
    const r1 = listMultiAgentSessions().find((r) => r.id === 'td-s4');
    expect(r1?.first_error).toBeNull();
    recordSessionTeardown('td-s4', { hopsUsed: 5, firstError: '' });
    const r2 = listMultiAgentSessions().find((r) => r.id === 'td-s4');
    expect(r2?.first_error).toBeNull();
  });
});

describe('getLastRunForTemplate', () => {
  test('returns the most-recent row for the given template id', () => {
    // Three rows, two for tpl-A in different orders, one for tpl-B as noise.
    createMultiAgentSession('older-a', 'chain', '001', '/f', 'persistent', { templateId: 'tpl-A' });
    // Spin until the next ms ticks over so started_at strictly differs.
    const t1 = Date.now();
    while (Date.now() === t1) {
      /* spin */
    }
    createMultiAgentSession('newer-a', 'chain', '002', '/f', 'persistent', { templateId: 'tpl-A' });
    createMultiAgentSession('noise-b', 'chain', '003', '/f', 'persistent', { templateId: 'tpl-B' });

    const row = getLastRunForTemplate('tpl-A');
    expect(row?.id).toBe('newer-a');
  });

  test('returns undefined when no row matches', () => {
    createMultiAgentSession('noise', 'chain', '001', '/f', 'persistent', { templateId: 'tpl-X' });
    expect(getLastRunForTemplate('tpl-NONE')).toBeUndefined();
  });

  test('ignores rows with template_id = NULL (pre-013 / ad-hoc runs)', () => {
    // Ad-hoc run (no template) followed by a templated run; the rail
    // attributes the second one and silently drops the first.
    createMultiAgentSession('adhoc', 'chain', '001', '/f', 'persistent');
    createMultiAgentSession('tmpl', 'chain', '002', '/f', 'persistent', { templateId: 'tpl-keep' });
    const row = getLastRunForTemplate('tpl-keep');
    expect(row?.id).toBe('tmpl');
  });
});

describe('migration 026 — tool input/output capture', () => {
  test('appendMultiAgentMutation persists toolInput; listMultiAgentMutations reads it back', () => {
    createMultiAgentSession('io1', 'orchestrator', '001');
    const row = appendMultiAgentMutation('io1', 'worker', 'Write', 'mutate', 'create /x', {
      filePath: '/x',
      cwd: '/repo',
      toolUseId: 'toolu_1',
      toolInput: { file_path: '/x', content: 'hello' },
    });
    expect(row.toolInput).toEqual({ file_path: '/x', content: 'hello' });
    expect(row.toolResult).toBeNull();

    const listed = listMultiAgentMutations('io1');
    expect(listed).toHaveLength(1);
    expect(listed[0]!.toolInput).toEqual({ file_path: '/x', content: 'hello' });
  });

  test('confirmMutationByToolUseId writes toolResult on the matching row', () => {
    createMultiAgentSession('io2', 'orchestrator', '001');
    appendMultiAgentMutation('io2', 'worker', 'Bash', 'mutate', 'npm test', {
      filePath: null,
      cwd: '/repo',
      toolUseId: 'toolu_2',
      toolInput: { command: 'npm test' },
    });
    const confirmed = confirmMutationByToolUseId('io2', 'toolu_2', [
      { type: 'text', text: 'PASS' },
    ]);
    expect(confirmed?.confirmedAt).not.toBeNull();
    expect(confirmed?.toolResult).toEqual([{ type: 'text', text: 'PASS' }]);
  });

  test('confirm without a result leaves toolResult null (back-compat call shape)', () => {
    createMultiAgentSession('io3', 'orchestrator', '001');
    appendMultiAgentMutation('io3', 'worker', 'Edit', 'mutate', 'edit /y', {
      filePath: '/y',
      cwd: '/repo',
      toolUseId: 'toolu_3',
      toolInput: { file_path: '/y' },
    });
    const confirmed = confirmMutationByToolUseId('io3', 'toolu_3');
    expect(confirmed?.confirmedAt).not.toBeNull();
    expect(confirmed?.toolResult).toBeNull();
  });

  test('capToolIoJson caps oversized values to a truncated preview envelope', () => {
    const big = 'x'.repeat(80 * 1024);
    const capped = capToolIoJson({ content: big });
    expect(capped).not.toBeNull();
    const parsed = JSON.parse(capped!) as { truncated?: boolean; bytes?: number; preview?: string };
    expect(parsed.truncated).toBe(true);
    expect(parsed.bytes).toBeGreaterThan(64 * 1024);
    expect(parsed.preview!.length).toBeLessThanOrEqual(8 * 1024);
  });

  test('capToolIoJson returns null for nullish input and passes small values through', () => {
    expect(capToolIoJson(undefined)).toBeNull();
    expect(capToolIoJson(null)).toBeNull();
    expect(capToolIoJson({ a: 1 })).toBe('{"a":1}');
  });
});
