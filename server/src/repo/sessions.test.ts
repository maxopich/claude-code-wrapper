import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { upsertProject } from './projects.js';
import { bumpSession, createSession, getSession } from './sessions.js';

/**
 * Register C06: `sessions.ts` had twelve exported functions and no test file,
 * while its multi-agent twin (`multi_agent.test.ts`) has had one throughout.
 * The gap mattered most for the cost invariant migration 029 exists to repair.
 *
 * Register C05 is the other half: the only test that touched session cost
 * (`runner/orchestrator.test.ts`) mocks `bumpSession` out entirely, then sums
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
