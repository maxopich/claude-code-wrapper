/**
 * `Cebab-3nt`: the R-B "continue after restart" nudge must read the tail, not
 * the transcript.
 *
 * The orchestrator is resumed with its full prior reasoning intact — its CLI
 * session is seeded — so the nudge only has to tell it what landed on the bus
 * since it last acted. It used to compute that by loading every event for the
 * session and scanning backwards in JS for the last orchestrator row.
 *
 * `listMultiAgentEvents` has taken a `sinceId` since it was written and every
 * caller passed 0, so the seam was already there and unused. These cases pin
 * the OUTPUT (which must not change) and then the COST (which is the point).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { appendMultiAgentEvent, createMultiAgentSession } from '../repo/multi_agent.js';
import { buildContinueNudge } from './server.js';

const SESSION = 'nudge-1';
const ORCH = 'orchestrator';

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-nudge-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  createMultiAgentSession(SESSION, 'orchestrator');
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('buildContinueNudge', () => {
  test('reports only what landed after the orchestrator last acted', () => {
    appendMultiAgentEvent(SESSION, ORCH, 'worker-a', 'prompt', 'early instruction');
    appendMultiAgentEvent(SESSION, 'worker-a', ORCH, 'reply', 'early answer');
    appendMultiAgentEvent(SESSION, ORCH, 'worker-b', 'prompt', 'LAST ORCH ACTION');
    appendMultiAgentEvent(SESSION, 'worker-b', ORCH, 'reply', 'after one');
    appendMultiAgentEvent(SESSION, 'worker-a', ORCH, 'reply', 'after two');

    const nudge = buildContinueNudge(SESSION);
    expect(nudge).toContain('after one');
    expect(nudge).toContain('after two');
    expect(nudge).not.toContain('early instruction');
    expect(nudge).not.toContain('early answer');
    // The boundary row itself is the orchestrator's own last action — it is
    // already in the resumed transcript, so repeating it back would be noise.
    expect(nudge).not.toContain('LAST ORCH ACTION');
  });

  test('excludes the operator-facing recovery banner', () => {
    appendMultiAgentEvent(SESSION, ORCH, 'worker-a', 'prompt', 'orch acted');
    appendMultiAgentEvent(SESSION, 'cebab', 'user', 'reply', 'RECOVERY BANNER FOR THE OPERATOR');
    appendMultiAgentEvent(SESSION, 'worker-a', ORCH, 'reply', 'real bus traffic');

    const nudge = buildContinueNudge(SESSION);
    expect(nudge).toContain('real bus traffic');
    expect(nudge).not.toContain('RECOVERY BANNER FOR THE OPERATOR');
  });

  test('an orchestrator that never acted gets the whole bus history', () => {
    // `lastEventIdFromSource` returns 0 for an agent that has never spoken,
    // and `sinceId = 0` is "everything" — the same answer the backwards scan
    // gave when it found no orchestrator row. Getting this wrong would hand a
    // just-restarted orchestrator an empty briefing.
    appendMultiAgentEvent(SESSION, 'worker-a', ORCH, 'reply', 'first thing said');
    appendMultiAgentEvent(SESSION, 'worker-b', ORCH, 'reply', 'second thing said');

    const nudge = buildContinueNudge(SESSION);
    expect(nudge).toContain('first thing said');
    expect(nudge).toContain('second thing said');
  });

  test('nothing since the last action says so, rather than showing an empty list', () => {
    appendMultiAgentEvent(SESSION, ORCH, 'worker-a', 'prompt', 'orch acted last');
    expect(buildContinueNudge(SESSION)).toContain('no bus messages were recorded');
  });

  test('it reads the tail, not the transcript', () => {
    // The cost claim. 300 rows before the orchestrator's last action, 3 after:
    // the read must be bounded by the 3, and the only way to see that from
    // outside is to watch what is bound to the query.
    const db = getDb();
    const ins = db.prepare(
      `INSERT INTO multi_agent_events (session_id, ts, source, destination, kind, text)
       VALUES (?, ?, 'worker-a', 'orchestrator', 'reply', ?)`,
    );
    db.transaction(() => {
      for (let i = 0; i < 300; i++) ins.run(SESSION, 1_700_000_000_000 + i, `old ${i}`);
    })();
    appendMultiAgentEvent(SESSION, ORCH, 'worker-a', 'prompt', 'orch acted');
    for (let i = 0; i < 3; i++) {
      appendMultiAgentEvent(SESSION, 'worker-a', ORCH, 'reply', `new ${i}`);
    }

    const rowsRead: number[] = [];
    const original = db.prepare.bind(db);
    (db as unknown as { prepare: typeof original }).prepare = ((sql: string) => {
      const stmt = original(sql);
      if (sql.includes('FROM multi_agent_events WHERE session_id = ? AND id > ?')) {
        const all = stmt.all.bind(stmt);
        (stmt as unknown as { all: unknown }).all = (...args: unknown[]) => {
          const out = all(...(args as [string, number])) as unknown[];
          rowsRead.push(out.length);
          return out;
        };
      }
      return stmt;
    }) as typeof original;

    try {
      const nudge = buildContinueNudge(SESSION);
      expect(nudge).toContain('new 2');
      expect(nudge).not.toContain('old 299');
    } finally {
      (db as unknown as { prepare: typeof original }).prepare = original;
    }

    // Floor: the recorder must have seen the query at all, or the assertion
    // below passes on an empty array.
    expect(rowsRead.length).toBeGreaterThan(0);
    expect(Math.max(...rowsRead)).toBe(3);
  });
});
