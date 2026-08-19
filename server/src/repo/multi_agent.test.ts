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
  appendMultiAgentMutation,
  archiveMultiAgentSession,
  capToolIoJson,
  clearFinishedMultiAgentSessions,
  computeRecoveryContext,
  confirmMutationByToolUseId,
  createMultiAgentSession,
  endMultiAgentSession,
  getLastRunForTemplate,
  getMultiAgentSession,
  listMultiAgentEvents,
  listMultiAgentMutations,
  listMultiAgentSessions,
  listMultiAgentSessionsWithIteration,
  listParticipants,
  listResolvedParticipants,
  reactivateMultiAgentSession,
  recordSessionTeardown,
  setMultiAgentSessionLifecycle,
  setProjectBusInstalled,
  unarchiveMultiAgentSession,
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

  /**
   * A5 (Cebab-ws0.8). `session_folder` is WRITE-ONCE, at INSERT, and this is
   * the invariant the whole ws0.8 cutover rests on: because the stored path is
   * absolute and never rewritten, moving where NEW folders are created leaves
   * every existing row resolving to the folder its artifacts are actually in.
   *
   * It had no test. The property held only because no `UPDATE ... SET
   * session_folder` had been written yet — which is not a guarantee, it is an
   * absence. This makes it one: any future statement that rewrites the column
   * turns a silent orphaning of pre-move sessions into a red test.
   *
   * The legacy workspace-shaped path is deliberate. This row is what a session
   * created BEFORE the move looks like, and it must survive untouched.
   */
  test('session_folder is write-once — no lifecycle transition rewrites it', () => {
    const legacy = path.join('/Users/test/workspace', '.cebab-session-abcd1234');
    createMultiAgentSession('s4', 'orchestrator', '001', legacy, 'persistent');

    const unchanged = (label: string): void => {
      expect(getMultiAgentSession('s4')?.session_folder, label).toBe(legacy);
    };
    unchanged('after insert');

    endMultiAgentSession('s4', 'done');
    unchanged('after end');

    reactivateMultiAgentSession('s4');
    unchanged('after reactivate');

    setMultiAgentSessionLifecycle('s4', 'temp');
    unchanged('after lifecycle change');

    archiveMultiAgentSession('s4');
    unchanged('after archive');

    unarchiveMultiAgentSession('s4');
    unchanged('after unarchive');
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

  test('[security] D29: an agent buried under thousands of newer events is still reported', () => {
    // The register's suggested fix for D29 was "accept and apply a row cap".
    // This is the case that makes it wrong. `quiet` is interrupted, and its
    // one event is the OLDEST of 5,001 — any newest-N cap smaller than that
    // drops it, and the disclosure then tells the operator nothing needs
    // re-checking. The docstring's "false negatives are not possible by
    // construction" is the invariant at stake, so it gets a test rather than a
    // promise.
    createMultiAgentSession('s1', 'orchestrator', '001');
    insertEventAt('s1', 'quiet', 1);
    // Bulk-insert the noise WITHOUT the per-row helper. Two costs scale with
    // the row count and both are removable: `insertEventAt` re-`prepare`s its
    // statement every call, and a bare INSERT is its own implicit transaction
    // and therefore its own commit. Measured locally, 5,000 rows: 59ms
    // prepare-per-call+bare, 3ms cached+batched. Locally that never mattered;
    // on the windows-2022 runner the first form exceeded vitest's 5s timeout,
    // which is how this test first failed in CI. The row count IS the point of
    // the case, so bound the cost rather than the count.
    const db = getDb();
    const insert = db.prepare(
      `INSERT INTO multi_agent_events (session_id, ts, source, destination, kind, text)
       VALUES (?, ?, 'chatty', 'cebab', 'reply', '')`,
    );
    db.transaction(() => {
      for (let i = 0; i < 5000; i++) insert.run('s1', 1000 + i);
    })();
    upsertAgentAt('s1', 'chatty', 999_999); // clean
    // `quiet` never checkpointed.

    const ctx = computeRecoveryContext('s1');
    expect(ctx).not.toBeNull();
    expect(ctx!.interruptedAgents).toEqual([
      { agentName: 'quiet', lastEventTs: 1, lastCheckpointTs: null },
    ]);
    expect(ctx!.staleSinceTs).toBe(5999);
  });

  test('D29: a session whose only events are back-dated still resolves its max', () => {
    // The aggregate reads MAX(ts), not "the last row by id". Insertion order
    // and ts order diverge in tests (and after a clock step), and the old
    // loop-over-every-row computed the max explicitly for exactly that reason
    // — moving to SQL must not quietly become "take the last row".
    createMultiAgentSession('s1', 'orchestrator', '001');
    insertEventAt('s1', 'workerX', 900);
    insertEventAt('s1', 'workerX', 100); // inserted later, older ts
    const ctx = computeRecoveryContext('s1');
    expect(ctx!.staleSinceTs).toBe(900);
    expect(ctx!.interruptedAgents).toEqual([
      { agentName: 'workerX', lastEventTs: 900, lastCheckpointTs: null },
    ]);
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

  // ---- Register D32: the cap is named for BYTES; it used to count UTF-16 ----

  test('capToolIoJson caps on BYTES, not UTF-16 units', () => {
    // 30k three-byte codepoints is ~90 KB of UTF-8 but only ~30k `.length`,
    // so the old comparison let it straight through — well past the 64 KB
    // budget the cap exists to hold the WS frame inside.
    const wide = '中'.repeat(30 * 1024);
    const capped = capToolIoJson({ content: wide });
    expect(capped).not.toBeNull();
    const parsed = JSON.parse(capped!) as { truncated?: boolean; bytes?: number; preview?: string };
    expect(parsed.truncated).toBe(true);
    // And the reported size is the real one, not the code-unit count.
    expect(parsed.bytes).toBe(Buffer.byteLength(JSON.stringify({ content: wide }), 'utf8'));
    expect(parsed.bytes).toBeGreaterThan(80 * 1024);
  });

  test('capToolIoJson preview is bounded in bytes and never split mid-codepoint', () => {
    const wide = '中'.repeat(30 * 1024);
    const parsed = JSON.parse(capToolIoJson({ content: wide })!) as { preview: string };
    expect(Buffer.byteLength(parsed.preview, 'utf8')).toBeLessThanOrEqual(8 * 1024);
    // A byte-wise cut through a 3-byte character would decode to U+FFFD, and a
    // preview that ends in a replacement char reads as corruption rather than
    // as truncation.
    expect(parsed.preview).not.toContain('\uFFFD'); // U+FFFD REPLACEMENT CHARACTER
  });

  test('capToolIoJson still passes an ASCII payload just under the cap', () => {
    // Anti-vacuity: switching to byte counting must not start rejecting the
    // plain-ASCII values that make up almost every real row.
    const body = 'x'.repeat(60 * 1024);
    const out = capToolIoJson({ content: body });
    expect(out).not.toBeNull();
    expect(JSON.parse(out!)).toEqual({ content: body });
  });
});

describe('migration 034 / register D20 — (session_id, tool_use_id) is unique', () => {
  test('re-appending the same tool_use id returns the EXISTING row and adds none', () => {
    createMultiAgentSession('d20a', 'orchestrator', '001');
    const first = appendMultiAgentMutation('d20a', 'worker', 'Write', 'mutate', 'create /x', {
      filePath: '/x',
      cwd: '/repo',
      toolUseId: 'toolu_dup',
      toolInput: { file_path: '/x' },
    });
    const second = appendMultiAgentMutation('d20a', 'worker', 'Write', 'mutate', 'create /x', {
      filePath: '/x',
      cwd: '/repo',
      toolUseId: 'toolu_dup',
      toolInput: { file_path: '/x' },
    });

    expect(second.id).toBe(first.id);
    expect(listMultiAgentMutations('d20a')).toHaveLength(1);
  });

  test('the repeat does NOT throw — the caller path past it must stay reachable', () => {
    // Both bus call sites catch a persist error and `return` BEFORE
    // `applyPauseGate`, so an append that throws is a dangerous mutation with
    // no operator gate. Enforcing uniqueness by letting the INSERT raise would
    // have been a worse bug than the duplicate row it removed.
    createMultiAgentSession('d20b', 'orchestrator', '001');
    const args = ['d20b', 'worker', 'Bash', 'dangerous', 'delete a tree'] as const;
    const extra = { filePath: null, cwd: '/repo', toolUseId: 'toolu_same' };
    appendMultiAgentMutation(...args, extra);
    expect(() => appendMultiAgentMutation(...args, extra)).not.toThrow();
  });

  test('control: two DIFFERENT tool_use ids still make two rows', () => {
    // Anti-vacuity for the case above — an append that silently dropped
    // everything would satisfy it.
    createMultiAgentSession('d20c', 'orchestrator', '001');
    const a = appendMultiAgentMutation('d20c', 'worker', 'Write', 'mutate', 'create /x', {
      filePath: '/x',
      cwd: '/repo',
      toolUseId: 'toolu_1',
    });
    const b = appendMultiAgentMutation('d20c', 'worker', 'Write', 'mutate', 'create /y', {
      filePath: '/y',
      cwd: '/repo',
      toolUseId: 'toolu_2',
    });
    expect(b.id).not.toBe(a.id);
    expect(listMultiAgentMutations('d20c')).toHaveLength(2);
  });

  test('control: the same tool_use id in a DIFFERENT session still makes a row', () => {
    // The key is the pair. Collapsing on `tool_use_id` alone would silently
    // drop one session's mutation because another session saw the same id.
    createMultiAgentSession('d20d', 'orchestrator', '001');
    createMultiAgentSession('d20e', 'orchestrator', '002');
    appendMultiAgentMutation('d20d', 'worker', 'Write', 'mutate', 'create /x', {
      filePath: '/x',
      cwd: '/repo',
      toolUseId: 'toolu_shared',
    });
    appendMultiAgentMutation('d20e', 'worker', 'Write', 'mutate', 'create /x', {
      filePath: '/x',
      cwd: '/repo',
      toolUseId: 'toolu_shared',
    });
    expect(listMultiAgentMutations('d20d')).toHaveLength(1);
    expect(listMultiAgentMutations('d20e')).toHaveLength(1);
  });

  test('control: repeated NULL tool_use ids still make separate rows', () => {
    // What the partial predicate is for. PR #337 deliberately keeps recording
    // `tool_use` blocks that arrive without an id, because an unidentifiable
    // call cannot be recognised as a repeat.
    createMultiAgentSession('d20f', 'orchestrator', '001');
    for (let i = 0; i < 3; i++) {
      appendMultiAgentMutation('d20f', 'worker', 'Bash', 'dangerous', 'delete a tree', {
        filePath: null,
        cwd: '/repo',
        toolUseId: null,
      });
    }
    expect(listMultiAgentMutations('d20f')).toHaveLength(3);
  });

  test('the absorbed repeat returns the row for ITS OWN key, not the last insert', () => {
    // `lastInsertRowid` survives a DO NOTHING unchanged, so reading the
    // returned row by it would hand back whichever row this connection
    // inserted most recently — a different mutation entirely.
    createMultiAgentSession('d20g', 'orchestrator', '001');
    const target = appendMultiAgentMutation('d20g', 'worker', 'Write', 'mutate', 'create /x', {
      filePath: '/x',
      cwd: '/repo',
      toolUseId: 'toolu_target',
    });
    // A DIFFERENT mutation lands in between, so it owns `lastInsertRowid`.
    appendMultiAgentMutation('d20g', 'worker', 'Write', 'mutate', 'create /y', {
      filePath: '/y',
      cwd: '/repo',
      toolUseId: 'toolu_other',
    });

    const repeat = appendMultiAgentMutation('d20g', 'worker', 'Write', 'mutate', 'create /x', {
      filePath: '/x',
      cwd: '/repo',
      toolUseId: 'toolu_target',
    });
    expect(repeat.id).toBe(target.id);
    expect(repeat.filePath).toBe('/x');
  });

  test('confirmMutationByToolUseId returns the same row on the already-confirmed path', () => {
    // The `changes === 0` branch reads back independently of the UPDATE, so it
    // needs its own case — it is the one a duplicate used to make arbitrary.
    createMultiAgentSession('d20h', 'orchestrator', '001');
    const appended = appendMultiAgentMutation('d20h', 'worker', 'Write', 'mutate', 'create /x', {
      filePath: '/x',
      cwd: '/repo',
      toolUseId: 'toolu_conf',
    });
    const first = confirmMutationByToolUseId('d20h', 'toolu_conf', [{ type: 'text', text: 'ok' }]);
    const again = confirmMutationByToolUseId('d20h', 'toolu_conf');

    expect(first?.id).toBe(appended.id);
    expect(again?.id).toBe(appended.id);
    expect(again?.confirmedAt).toBe(first?.confirmedAt);
    expect(again?.toolResult).toEqual([{ type: 'text', text: 'ok' }]);
  });
});
