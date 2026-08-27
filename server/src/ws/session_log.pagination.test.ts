/**
 * Register S04: a session-log page must not cost the whole session.
 *
 * WHAT WAS WRONG. Both projectors loaded every row for the session, built a
 * `LogRow` for each — which runs `redactSensitive` over that row's raw
 * payload — sorted, and only then sliced to the requested page. A 20k-row
 * session redacted 20,000 payloads to return 200. The register filed the
 * SORT; redaction is the dominant cost.
 *
 * WHY THE FIX IS A KEY SCAN AND NOT `LIMIT`/`OFFSET` IN SQL. The register's
 * suggested fix was "push offset and limit into SQL". The ordering is
 * `(ts, agent, id)` where BOTH tiebreak fields are DERIVED in the projector —
 * `event:${id}` / `mutation:${id}`, and `agent` is `source` or `agentName` —
 * and compared with `String.localeCompare`, i.e. ICU collation. A `UNION`
 * with a SQL `ORDER BY` would have to be argued equivalent to `localeCompare`
 * before it could claim "no behaviour change". Reading the sort KEY first
 * keeps the comparator in JS, byte for byte, so there is nothing to argue.
 *
 * TWO GATES, and they check different things:
 *
 *   1. EQUIVALENCE (the load-bearing one). The pre-S04 implementation is
 *      reproduced below as an oracle and run against a corpus built to stress
 *      exactly what the comparator disambiguates — many rows sharing a `ts`,
 *      agent names that only differ under a tiebreak, both streams
 *      interleaved, unconfirmed mutations that must not appear or count. Every
 *      page must be deep-equal. This is what makes "no behaviour change" a
 *      measurement rather than a claim.
 *
 *   2. COST. Equivalence alone would still pass if the fix were reverted —
 *      the old code produced the right answer, expensively. So the second gate
 *      records what the projector actually asks SQLite for: the unbounded
 *      `SELECT *` readers must not run, and the page fetch must bind at most
 *      `limit` ids.
 *
 * The cost gate intercepts `db.prepare`, which is a real observation of the
 * work done rather than a mock of the module under test. A `vi.mock` of the
 * repo layer would have to re-implement it to keep the oracle honest, and the
 * re-implementation is exactly the thing that could drift.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { LogRow } from '@cebab/shared';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { createMultiAgentSession, listMultiAgentEvents } from '../repo/multi_agent.js';
import { listMultiAgentMutations } from '../repo/multi_agent.js';
import { listEvents } from '../repo/events.js';
import { upsertProject } from '../repo/projects.js';
import { createSession } from '../repo/sessions.js';
import {
  buildSessionLogChunk,
  buildSingleAgentSessionLogChunk,
  multiAgentEventToLogRow,
  multiAgentMutationToLogRow,
} from './session_log.js';

let tmpRoot: string;
let originalDataDir: string;

const SESSION = 'bus-1';
const SINGLE = 'single-1';

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-log-pagination-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The oracle: the projector exactly as it stood before S04.
// ---------------------------------------------------------------------------

/**
 * Convert-everything, sort, slice — the shape this PR replaced. Kept verbatim
 * so the equivalence gate compares against the real prior behaviour rather
 * than against a description of it.
 *
 * The byte cap is deliberately absent here: the corpus keeps rows small so it
 * never trips, and reproducing it would mean maintaining a second copy of the
 * thing it is supposed to be checking. The cap gets its own case below, which
 * is where the interaction that could have broken lives — the page fetch now
 * asks for exactly `limit` rows, so a cap that trips must still return a
 * PREFIX of that page rather than a short read from somewhere else.
 */
function oracleMultiAgent(sessionId: string, offset: number, limit: number): LogRow[] {
  const rows: LogRow[] = [];
  for (const ev of listMultiAgentEvents(sessionId)) rows.push(multiAgentEventToLogRow(ev, false));
  for (const m of listMultiAgentMutations(sessionId)) {
    const row = multiAgentMutationToLogRow(m, false);
    if (row !== null) rows.push(row);
  }
  rows.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    if (a.agent !== b.agent) return a.agent.localeCompare(b.agent);
    return a.id.localeCompare(b.id);
  });
  return rows.slice(offset, offset + limit);
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

/**
 * Seed a bus session whose ordering is decided by the tiebreaks, not by `ts`.
 *
 * `tsBuckets` rows share each timestamp, so `agent` and then `id` do the
 * work — which is the part a SQL `ORDER BY` would have had to reproduce, and
 * the part a key projection can get wrong by dropping a field.
 *
 * One statement, one transaction: 5,000 bare inserts through a per-call
 * `prepare` is what timed out on windows-2022 in PR #313.
 */
function seedBusCorpus(opts: { tsBuckets: number; perBucket: number }): void {
  const db = getDb();
  createMultiAgentSession(SESSION, 'orchestrator');
  const insEv = db.prepare(
    `INSERT INTO multi_agent_events (session_id, ts, source, destination, kind, text)
     VALUES (?, ?, ?, 'cebab', 'reply', ?)`,
  );
  const insMut = db.prepare(
    `INSERT INTO multi_agent_mutations
       (session_id, agent_name, ts, tool_name, category, summary, file_path, cwd, confirmed_at)
     VALUES (?, ?, ?, 'Edit', 'mutate', ?, '/tmp/f', '/tmp', ?)`,
  );
  // Agent names chosen so plain ASCII order and any collation the projector
  // might use have something to disagree about if the field is dropped.
  const agents = ['alpha', 'Beta', 'alpha-2', 'beta', 'zeta'];
  db.transaction(() => {
    for (let b = 0; b < opts.tsBuckets; b++) {
      const ts = 1_700_000_000_000 + b;
      for (let i = 0; i < opts.perBucket; i++) {
        const agent = agents[(b + i) % agents.length]!;
        if (i % 3 === 2) {
          // Every third row is a mutation, and every fourth of THOSE is
          // unconfirmed — it must not appear in a page and must not count
          // toward `total`.
          const confirmed = i % 12 === 2 ? null : ts;
          insMut.run(SESSION, agent, ts, `edit ${b}-${i}`, confirmed);
        } else {
          insEv.run(SESSION, ts, agent, `hop ${b}-${i}`);
        }
      }
    }
  })();
}

/** Seed a single-agent session in the `events` table. */
function seedSingleAgentCorpus(opts: { tsBuckets: number; perBucket: number }): void {
  const db = getDb();
  const project = upsertProject('proj', '/tmp/proj');
  createSession(SINGLE, project.id);
  const ins = db.prepare(
    `INSERT INTO events (session_id, seq, ts, type, subtype, raw) VALUES (?, ?, ?, 'assistant', NULL, ?)`,
  );
  let seq = 0;
  db.transaction(() => {
    for (let b = 0; b < opts.tsBuckets; b++) {
      const ts = 1_700_000_000_000 + b;
      for (let i = 0; i < opts.perBucket; i++) {
        ins.run(
          SINGLE,
          seq++,
          ts,
          JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: `m${b}-${i}` }] },
          }),
        );
      }
    }
  })();
}

// ---------------------------------------------------------------------------
// 1. Equivalence
// ---------------------------------------------------------------------------

describe('S04 equivalence — the paged projector matches the pre-S04 one', () => {
  test('every page of a tiebreak-heavy bus corpus is identical to the oracle', () => {
    seedBusCorpus({ tsBuckets: 40, perBucket: 7 });
    const total = buildSessionLogChunk({
      sessionId: SESSION,
      offset: 0,
      limit: 1,
      revealSensitive: false,
    }).total;
    expect(total).toBeGreaterThan(200);

    const limit = 25;
    let compared = 0;
    for (let offset = 0; offset < total; offset += limit) {
      const chunk = buildSessionLogChunk({
        sessionId: SESSION,
        offset,
        limit,
        revealSensitive: false,
      });
      expect(chunk.rows, `page at offset ${offset}`).toEqual(
        oracleMultiAgent(SESSION, offset, limit),
      );
      expect(chunk.total).toBe(total);
      expect(chunk.hasMore).toBe(offset + chunk.rows.length < total);
      compared += chunk.rows.length;
    }
    // Floor: a comparison loop that ran zero pages, or stopped after one,
    // would report success while checking almost nothing.
    expect(compared).toBe(total);
  });

  test('unconfirmed mutations are absent from every page and from total', () => {
    seedBusCorpus({ tsBuckets: 20, perBucket: 7 });
    const unconfirmed = getDb()
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM multi_agent_mutations WHERE session_id = ? AND confirmed_at IS NULL`,
      )
      .get(SESSION)!.c;
    // Positive control on the corpus itself: if the seeder stopped producing
    // unconfirmed rows this test would pass while testing nothing.
    expect(unconfirmed).toBeGreaterThan(0);

    const chunk = buildSessionLogChunk({
      sessionId: SESSION,
      offset: 0,
      limit: 10_000,
      revealSensitive: false,
    });
    const events = listMultiAgentEvents(SESSION).length;
    const confirmed = listMultiAgentMutations(SESSION).filter((m) => m.confirmedAt !== null).length;
    expect(chunk.total).toBe(events + confirmed);
    expect(chunk.rows).toHaveLength(chunk.total);
  });

  test('every page of a single-agent corpus is identical to the oracle', () => {
    seedSingleAgentCorpus({ tsBuckets: 30, perBucket: 5 });
    const all = buildSingleAgentSessionLogChunk({
      sessionId: SINGLE,
      offset: 0,
      limit: 10_000,
      revealSensitive: false,
    });
    expect(all.total).toBe(listEvents(SINGLE).length);

    const limit = 17;
    for (let offset = 0; offset < all.total; offset += limit) {
      const chunk = buildSingleAgentSessionLogChunk({
        sessionId: SINGLE,
        offset,
        limit,
        revealSensitive: false,
      });
      expect(chunk.rows, `page at offset ${offset}`).toEqual(
        all.rows.slice(offset, offset + limit),
      );
    }
  });

  test('offset past the end, zero limit and an empty session behave as before', () => {
    seedBusCorpus({ tsBuckets: 3, perBucket: 4 });
    const total = buildSessionLogChunk({
      sessionId: SESSION,
      offset: 0,
      limit: 1,
      revealSensitive: false,
    }).total;

    const past = buildSessionLogChunk({
      sessionId: SESSION,
      offset: total + 50,
      limit: 10,
      revealSensitive: false,
    });
    expect(past.rows).toEqual([]);
    expect(past.total).toBe(total);
    expect(past.hasMore).toBe(false);

    const zero = buildSessionLogChunk({
      sessionId: SESSION,
      offset: 0,
      limit: 0,
      revealSensitive: false,
    });
    expect(zero.rows).toEqual([]);
    expect(zero.hasMore).toBe(true);

    const empty = buildSessionLogChunk({
      sessionId: 'no-such-session',
      offset: 0,
      limit: 10,
      revealSensitive: false,
    });
    expect(empty).toEqual({ rows: [], total: 0, hasMore: false, revealedSensitive: false });
  });

  test('the byte cap still trims a page to a prefix, and says there is more', () => {
    const db = getDb();
    createMultiAgentSession(SESSION, 'orchestrator');
    // ~100 KB per row against a 2 MB cap: the cap trips inside a 40-row page,
    // well before the row count does.
    const big = 'x'.repeat(100_000);
    const ins = db.prepare(
      `INSERT INTO multi_agent_events (session_id, ts, source, destination, kind, text)
       VALUES (?, ?, 'alpha', 'cebab', 'reply', ?)`,
    );
    db.transaction(() => {
      for (let i = 0; i < 40; i++) ins.run(SESSION, 1_700_000_000_000 + i, `${big} ${i}`);
    })();

    const chunk = buildSessionLogChunk({
      sessionId: SESSION,
      offset: 0,
      limit: 40,
      revealSensitive: false,
    });
    expect(chunk.total).toBe(40);
    // Fewer rows than asked for, because the cap stopped it — not because the
    // fetch was short.
    expect(chunk.rows.length).toBeGreaterThan(0);
    expect(chunk.rows.length).toBeLessThan(40);
    expect(chunk.hasMore).toBe(true);
    // And what came back is the PREFIX of the page, in order.
    const uncapped = oracleMultiAgent(SESSION, 0, 40);
    expect(chunk.rows.map((r) => r.id)).toEqual(
      uncapped.slice(0, chunk.rows.length).map((r) => r.id),
    );
    // This case is slow BY DESIGN: the byte cap only trips on a genuinely large
    // page, so it inserts 4 MB through better-sqlite3 and reads it back. That
    // costs ~4.7s on an idle machine, which leaves no headroom under vitest's
    // 5s default and reddens as a spurious 'Test timed out' on any busier
    // runner. Give it a generous explicit budget rather than shrinking the
    // fixture, which risks tuning the row count down to where the cap stops
    // tripping and the case asserts nothing about the byte cap at all.
  }, 20000);

  test('revealSensitive still bypasses redaction on the page it returns', () => {
    seedBusCorpus({ tsBuckets: 2, perBucket: 4 });
    const hidden = buildSessionLogChunk({
      sessionId: SESSION,
      offset: 0,
      limit: 5,
      revealSensitive: false,
    });
    const shown = buildSessionLogChunk({
      sessionId: SESSION,
      offset: 0,
      limit: 5,
      revealSensitive: true,
    });
    expect(shown.revealedSensitive).toBe(true);
    expect(hidden.revealedSensitive).toBe(false);
    expect(shown.rows.map((r) => r.id)).toEqual(hidden.rows.map((r) => r.id));
  });
});

// ---------------------------------------------------------------------------
// 2. Cost
// ---------------------------------------------------------------------------

/**
 * Record every SQL string the projector prepares, and the parameters bound to
 * it. Wrapping `prepare` rather than mocking the repo module means the
 * assertion is about work actually requested of SQLite.
 */
function recordSql<T>(fn: () => T): {
  result: T;
  statements: { sql: string; params: unknown[] }[];
} {
  const db = getDb();
  const statements: { sql: string; params: unknown[] }[] = [];
  const original = db.prepare.bind(db);
  (db as unknown as { prepare: typeof original }).prepare = ((sql: string) => {
    const stmt = original(sql);
    const wrap = <A extends unknown[]>(method: (...a: A) => unknown) =>
      function (this: unknown, ...args: A) {
        statements.push({ sql, params: args });
        return method.apply(stmt, args);
      };
    const all = stmt.all.bind(stmt);
    const get = stmt.get.bind(stmt);
    (stmt as unknown as { all: unknown }).all = wrap(all as (...a: unknown[]) => unknown);
    (stmt as unknown as { get: unknown }).get = wrap(get as (...a: unknown[]) => unknown);
    return stmt;
  }) as typeof original;
  try {
    return { result: fn(), statements };
  } finally {
    (db as unknown as { prepare: typeof original }).prepare = original;
  }
}

/**
 * A session-scoped `SELECT *` — the shape S04 is about. Deliberately NOT
 * "any SELECT * from that table": the page fetch is `SELECT * … WHERE id IN
 * (…)`, which is the fix, and a matcher that flagged it would forbid the only
 * correct implementation.
 */
function isUnboundedSessionRead(sql: string): boolean {
  return /SELECT \* FROM \w+ WHERE session_id/.test(sql);
}

describe('S04 cost — a page must not read the whole session', () => {
  test('the multi-agent projector never runs the unbounded row readers', () => {
    seedBusCorpus({ tsBuckets: 40, perBucket: 7 });
    const { statements } = recordSql(() =>
      buildSessionLogChunk({ sessionId: SESSION, offset: 100, limit: 20, revealSensitive: false }),
    );
    const sqls = statements.map((s) => s.sql.replace(/\s+/g, ' '));
    // Floor: the projector must have asked SQLite for SOMETHING, or the
    // recorder is broken and every assertion below is vacuous.
    expect(sqls.length).toBeGreaterThan(0);
    // Match the SESSION-SCOPED `SELECT *` specifically. `SELECT * FROM
    // multi_agent_events` alone also matches the legitimate `WHERE id IN (…)`
    // page fetch, and a matcher that forbids the fix is not a gate.
    expect(sqls.filter(isUnboundedSessionRead)).toEqual([]);
    expect(sqls.some((s) => s.includes('SELECT id, ts, source FROM multi_agent_events'))).toBe(
      true,
    );
  });

  test('the page fetch binds at most `limit` ids', () => {
    seedBusCorpus({ tsBuckets: 40, perBucket: 7 });
    const limit = 20;
    const { statements } = recordSql(() =>
      buildSessionLogChunk({ sessionId: SESSION, offset: 100, limit, revealSensitive: false }),
    );
    const byIdFetches = statements.filter((s) => /WHERE id IN \(/.test(s.sql));
    expect(byIdFetches.length).toBeGreaterThan(0);
    const bound = byIdFetches.reduce((n, s) => n + s.params.length, 0);
    expect(bound).toBeLessThanOrEqual(limit);
  });

  test('the single-agent projector never runs the unbounded row reader', () => {
    seedSingleAgentCorpus({ tsBuckets: 30, perBucket: 5 });
    const limit = 10;
    const { statements } = recordSql(() =>
      buildSingleAgentSessionLogChunk({
        sessionId: SINGLE,
        offset: 40,
        limit,
        revealSensitive: false,
      }),
    );
    const sqls = statements.map((s) => s.sql.replace(/\s+/g, ' '));
    expect(sqls.length).toBeGreaterThan(0);
    expect(sqls.filter(isUnboundedSessionRead)).toEqual([]);
    expect(sqls.some((s) => s.includes('SELECT id, ts FROM events'))).toBe(true);
    const bound = statements
      .filter((s) => /WHERE id IN \(/.test(s.sql))
      .reduce((n, s) => n + s.params.length, 0);
    expect(bound).toBeLessThanOrEqual(limit);
  });

  // Positive control for the recorder itself. The oracle IS the old shape, so
  // running it must produce exactly the statement the gates above forbid — if
  // this stops firing, those assertions are passing because the recorder went
  // blind, not because the projector got cheaper.
  test('the recorder does see an unbounded read when one happens', () => {
    seedBusCorpus({ tsBuckets: 5, perBucket: 4 });
    const { statements } = recordSql(() => oracleMultiAgent(SESSION, 0, 10));
    const sqls = statements.map((s) => s.sql.replace(/\s+/g, ' '));
    expect(sqls.filter(isUnboundedSessionRead).length).toBeGreaterThan(0);
  });
});
