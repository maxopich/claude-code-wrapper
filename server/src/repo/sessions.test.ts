import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { upsertProject } from './projects.js';
import { appendForensics } from './controllability_forensics.js';
import { appendRecoveryLog } from './recovery_log.js';
import { _resetCoalesceState, emit } from '../notifications/dispatcher.js';
import { appendSafetyAudit } from '../notifications/safety_audit.js';
import {
  bumpSession,
  createSession,
  getSession,
  hardDeleteSession,
  listSessionsForProject,
} from './sessions.js';
import { createMultiAgentSession } from './multi_agent.js';

/**
 * Register C06: `sessions.ts` had twelve exported functions and no test file,
 * while its multi-agent twin (`multi_agent.test.ts`) has had one throughout.
 * The gap mattered most for the cost invariant migration 029 exists to repair.
 *
 * Register C05 is the other half: the only test that touched session cost
 * (`runner/persist.test.ts`) mocks `bumpSession` out entirely, then sums
 * the mock's own recorded arguments and asserts that sum — so the accumulation
 * these tests exercise, which lives in un-mocked SQL, ran nowhere. Reverting
 * `total_cost_usd = total_cost_usd + ?` to `= ?` left the suite green.
 *
 * Everything below therefore goes through a real SQLite file. The figures are
 * the ones from the captured transcript quoted in migration 029 and in
 * `bumpSession`'s docstring, so a failure here reads against the same numbers
 * the bug was originally diagnosed from.
 */

// Isolation scaffolding: each test gets its own ~/.cebab dir so DB writes
// don't leak across tests or out to the real home.

let tmpRoot: string;
let originalDataDir: string;
let projectId: number;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-sessions-repo-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  projectId = upsertProject('demo', path.join(tmpRoot, 'demo')).id;
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('bumpSession — the cost invariant migration 029 repairs', () => {
  test('a fresh session starts at zero', () => {
    createSession('s1', projectId);
    expect(getSession('s1')?.total_cost_usd).toBe(0);
  });

  test('successive turns ADD, they do not overwrite', () => {
    createSession('s1', projectId);
    // The two turns of a real captured session. Note they are not monotonic:
    // `result.total_cost_usd` is the cost of THAT invocation, so the second
    // figure being smaller is normal and is exactly what made absolute
    // assignment look plausible.
    bumpSession('s1', 0.42052775);
    bumpSession('s1', 0.057099);

    expect(getSession('s1')?.total_cost_usd).toBeCloseTo(0.47762675, 8);
    // The regression, stated as its own assertion: under absolute assignment
    // the session reported the smaller, later number instead of the sum.
    expect(getSession('s1')!.total_cost_usd).toBeGreaterThan(0.057099);
  });

  test('a trailing zero-cost result cannot wipe the total', () => {
    createSession('s1', projectId);
    bumpSession('s1', 0.03987175);
    // Slash commands close out with `num_turns: 0, total_cost_usd: 0`. Under
    // absolute assignment this set the session to exactly $0.00 — a real
    // observed case in captured transcripts, and the one 029 backfills.
    bumpSession('s1', 0);

    expect(getSession('s1')?.total_cost_usd).toBeCloseTo(0.03987175, 8);
  });

  test('the delta defaults to zero and still touches last_event_at', () => {
    const created = createSession('s1', projectId);
    bumpSession('s1', 0.25);
    const before = getSession('s1')!;

    bumpSession('s1');

    const after = getSession('s1')!;
    expect(after.total_cost_usd).toBeCloseTo(0.25, 8);
    expect(after.last_event_at).toBeGreaterThanOrEqual(before.last_event_at);
    expect(after.last_event_at).toBeGreaterThanOrEqual(created.created_at);
  });

  test('sessions accrue independently', () => {
    createSession('s1', projectId);
    createSession('s2', projectId);
    bumpSession('s1', 0.1);
    bumpSession('s2', 0.4);
    bumpSession('s1', 0.2);

    expect(getSession('s1')?.total_cost_usd).toBeCloseTo(0.3, 8);
    expect(getSession('s2')?.total_cost_usd).toBeCloseTo(0.4, 8);
  });

  test('bumping an unknown session id is a no-op, not a throw', () => {
    expect(() => bumpSession('nope', 1.5)).not.toThrow();
    expect(getSession('nope')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Register D31: the purge left three tables pointing at a session that no
// longer exists. `notifications`, `controllability_forensics` and
// `recovery_log` all carry `session_id TEXT` with no REFERENCES and no
// cascade, so nothing removed them — while `hardDeleteSession`'s own comment
// claimed the audit lineage was "the only surviving record after the purge".
//
// Both halves are load-bearing and both are asserted below: the dependents
// must GO, and `safety_audit` must STAY. A fix that deleted everything would
// break the hash chain for every row after the deleted one, which is a worse
// bug than the one being fixed.
// ---------------------------------------------------------------------------

describe('[security] hardDeleteSession — what a purge removes, and what it must not', () => {
  // `emit`'s coalesce map is MODULE-scoped and survives across tests, so a
  // repeated dedupeKey silently returns `sent: false` and persists nothing.
  // Reset it, and use a fresh key per call, so this file tests the purge
  // rather than the dispatcher's dedupe window.
  beforeEach(() => {
    _resetCoalesceState();
  });
  let seedSeq = 0;

  /** Seed one row in each dependent table plus one audit row, through the
   *  real repo helpers — a hand-rolled INSERT here would drift from the schema
   *  and, worse, could pass while omitting a column the production writer
   *  always sets. */
  function seedDependents(sessionId: string): void {
    seedSeq += 1;
    emit(
      {
        class: 'operational',
        severity: 'info',
        dedupeKey: `k-${sessionId}-${seedSeq}`,
        title: 'hello',
        sessionId,
        // `emit` persists an operational envelope ONLY when it is sticky
        // (`if (env.sticky) persistNotification(env)`). Without this the seed
        // writes no row, and every "the purge removed it" assertion below
        // passes against a table that was empty to begin with.
        sticky: true,
      },
      () => {},
    );
    appendRecoveryLog({
      sessionId,
      failureClass: 'chain_crash',
      operatorAction: 'in_session_resume',
      tsOverride: 1,
    });
    const audit = appendSafetyAudit({
      ts: 1,
      sessionId,
      kind: 'session.stopped',
      reasonCode: 'operator_stop',
      payload: null,
    });
    appendForensics({
      safetyAuditId: audit.id,
      ts: 1,
      sessionId,
      effectivePrompt: null,
      eventsLastN: [],
    });

    // Prove the seed seeded. Every assertion in this describe is of the form
    // "after the purge this count is 0", which is satisfied for free by a
    // table that was never written to — and one of these four writes silently
    // did nothing until this check was added.
    for (const table of TABLES) {
      expect(countFor(table, sessionId), `seed wrote nothing to ${table}`).toBe(1);
    }
  }

  const TABLES = [
    'notifications',
    'recovery_log',
    'controllability_forensics',
    'safety_audit',
  ] as const;

  function countFor(table: string, sessionId: string): number {
    return (
      getDb()
        .prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`)
        .get(sessionId)?.n ?? -1
    );
  }

  test('removes the three soft-FK dependents along with the session', () => {
    createSession('purge-me', projectId);
    seedDependents('purge-me');

    expect(hardDeleteSession('purge-me')).toBe(1);

    expect(getSession('purge-me')).toBeUndefined();
    expect(countFor('notifications', 'purge-me')).toBe(0);
    expect(countFor('recovery_log', 'purge-me')).toBe(0);
    expect(countFor('controllability_forensics', 'purge-me')).toBe(0);
  });

  test('LEAVES safety_audit intact — deleting a row would break the chain', () => {
    createSession('purge-me', projectId);
    seedDependents('purge-me');

    hardDeleteSession('purge-me');

    expect(countFor('safety_audit', 'purge-me')).toBe(1);
  });

  test('touches nothing belonging to another session', () => {
    createSession('keep-me', projectId);
    createSession('purge-me', projectId);
    seedDependents('keep-me');
    seedDependents('purge-me');

    hardDeleteSession('purge-me');

    expect(getSession('keep-me')).toBeDefined();
    expect(countFor('notifications', 'keep-me')).toBe(1);
    expect(countFor('recovery_log', 'keep-me')).toBe(1);
    expect(countFor('controllability_forensics', 'keep-me')).toBe(1);
  });

  test('is atomic — a failure inside the transaction leaves everything', () => {
    // The dependents are deleted before the session row, so a throw partway
    // through must roll the whole thing back rather than leave a session with
    // its notifications already gone.
    createSession('purge-me', projectId);
    seedDependents('purge-me');
    const db = getDb();
    let threw = false;
    try {
      db.transaction(() => {
        hardDeleteSession('purge-me');
        throw new Error('boom');
      })();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(getSession('purge-me')).toBeDefined();
    expect(countFor('notifications', 'purge-me')).toBe(1);
  });
});

/**
 * Cebab-ws0.8 — the sidebar's per-agent session list is NOT the multi-agent
 * session folders, and must keep rendering exactly as it does today.
 *
 * WHY THIS TEST EXISTS, since it looks like it is testing nothing. Two things
 * in this codebase are both called "sessions" and they are unrelated:
 *
 *   - the `sessions` table, listed under each agent in the sidebar via
 *     `project_opened` -> `listSessionsForProject`. Single-agent chats. These
 *     have never had an on-disk folder of their own.
 *   - `multi_agent_sessions.session_folder`, the bus's per-session artifact
 *     tree, which ws0.8 relocated from the operator's workspace into the data
 *     dir.
 *
 * Moving the second must not perturb the first, and the operator asked for that
 * guarantee by name. The insurance is not against ws0.8 — it is against a later
 * refactor that notices two lists with the same word in their names and
 * "unifies" them. Below, every multi-agent row points at a path that does not
 * exist; the sidebar list must not notice.
 */
describe('the sidebar session list is independent of bus session folders (ws0.8)', () => {
  test('listSessionsForProject is byte-identical with bus folders pointing nowhere', () => {
    const project = upsertProject('Agent', path.join(os.tmpdir(), 'agent-proj'));
    createSession('chat-1', project.id);
    createSession('chat-2', project.id);
    bumpSession('chat-2');

    const before = JSON.stringify(listSessionsForProject(project.id));

    // Bus rows whose folders are nowhere on disk — one legacy workspace-shaped
    // path, one data-dir-shaped, neither existing.
    createMultiAgentSession('bus-old', 'chain', '001', '/gone/.cebab-session-bus-old');
    createMultiAgentSession('bus-new', 'orchestrator', '001', '/gone/sessions/bus-new');

    expect(JSON.stringify(listSessionsForProject(project.id))).toBe(before);
    expect(
      listSessionsForProject(project.id)
        .map((s) => s.id)
        .sort(),
    ).toEqual(['chat-1', 'chat-2']);
  });
});
