/**
 * `Cebab-v85` — the activity bar's hop chip counted Cebab's own rows and the
 * brake did not, so "25 / 70 HOPS" reconciled with nothing on the server.
 *
 * THE SHAPE OF THE DEFECT, because it decides what these tests assert. There
 * were three answers to "how many hops has this session taken":
 *
 *   1. the router's `hopsCount`      — what the budget brake enforces on
 *   2. `multi_agent_events` row count — what the chip rendered, AND what
 *                                       `reconstruct` re-seeded (1) from
 *   3. the `hops_used` column         — written as (1), documented as (2)
 *
 * (2) is strictly larger: five row classes are persisted directly, bypassing
 * `forwardCebabEvent`, and so never bump the counter. That made the chip read
 * high by a growing amount — and made a session come back from an R-B restart
 * with LESS budget than it had been enforcing, silently.
 *
 * So every test here asserts against a session where the two numbers actually
 * DIFFER. A fixture with no Cebab-authored rows would pass on the old code
 * too, which is the whole way this defect survived: the counts agree on the
 * happy path and diverge exactly when something has gone wrong.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { ORCHESTRATOR_AGENT_NAME, wireOrchestratorSession } from './orchestrator.js';
import { computeSessionPaths } from './paths.js';
import { resolveInitialHopsCount } from './reconstruct.js';
import { CEBAB_SOURCE, USER_RECIPIENT, type ResolvedAgent } from './runtime.js';
import { unregisterLiveSession } from './session_registry.js';
import {
  createMultiAgentSession,
  getMultiAgentSession,
  listMultiAgentEvents,
} from '../repo/multi_agent.js';
import { upsertProject } from '../repo/projects.js';
import type { Runner } from '../runner/index.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

let tmpRoot: string;
let originalDataDir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

const SESSION_ID = 'test-hop-counter';

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-hop-counter-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  createMultiAgentSession(SESSION_ID, 'orchestrator', 'iter-1');
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  unregisterLiveSession(SESSION_ID);
  warnSpy.mockRestore();
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const flush = async (times = 16) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
};

function makeWorker(name: string): ResolvedAgent {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const proj = upsertProject(name, dir);
  return { projectId: proj.id, agentName: name, cwd: dir, projectName: name };
}

/** Turn N runs `perTurn[N]` between two yielded messages, as a real hop does. */
function scriptedRunner(perTurn: Array<(() => void) | undefined>) {
  let turn = 0;
  return (): Runner => {
    const mine = turn++;
    async function* gen(): AsyncGenerator<SDKMessage> {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'thinking' }] },
      } as unknown as SDKMessage;
      perTurn[mine]?.();
      yield { type: 'result', subtype: 'success', session_id: `s${mine}` } as unknown as SDKMessage;
    }
    const it = gen();
    return { [Symbol.asyncIterator]: () => it, close: () => undefined };
  };
}

/**
 * Drive a run to the divergent state: one real delegation hop, then a muted
 * reply that strands the run so Cebab writes its own explanatory row.
 *
 * This is the `Cebab-vie.8` wedge, reused because it is the cheapest way to
 * produce a session whose row count and hop count genuinely disagree — and
 * disagreement is the precondition for every assertion below.
 */
function runWedge(onEvent = vi.fn()) {
  const workers = [makeWorker('coder')];
  const wired: ReturnType<typeof wireOrchestratorSession> = wireOrchestratorSession({
    sessionId: SESSION_ID,
    iterationId: 'iter-1',
    lifecycle: 'persistent',
    paths: computeSessionPaths(SESSION_ID),
    workers,
    onEvent,
    onEnded: vi.fn(),
    hopBudget: 50,
    runnerFactory: scriptedRunner([
      () =>
        wired.router.handleEvent({
          ts: Date.now(),
          source: ORCHESTRATOR_AGENT_NAME,
          destination: 'coder',
          kind: 'prompt',
          text: 'do the thing',
        }),
      () =>
        wired.router.handleEvent({
          ts: Date.now(),
          source: 'coder',
          destination: ORCHESTRATOR_AGENT_NAME,
          kind: 'reply',
          text: 'done',
        }),
    ]),
  });
  expect(wired.router.setMute('coder', true)).toBe(true);
  return { wired, onEvent };
}

describe('the router persists its hop counter as the run advances', () => {
  test('hops_used is correct MID-RUN, and is not the event-row count', async () => {
    // Reddens if `bumpHops` stops persisting: `hops_used` goes back to NULL
    // until teardown, which is the hole `reconstruct` used to fill with the
    // wrong number.
    const { wired } = runWedge();
    wired.deliver(ORCHESTRATOR_AGENT_NAME, 'plan the round');
    await flush();

    const rows = listMultiAgentEvents(SESSION_ID);
    const stranded = rows.filter(
      (e) => e.source === CEBAB_SOURCE && e.destination === USER_RECIPIENT && e.kind === 'error',
    );
    // PREMISE. Without a Cebab-authored row the two numbers agree and this
    // test would pass on the old code — a green with nothing behind it.
    expect(stranded).toHaveLength(1);
    expect(rows.length).toBeGreaterThan(1);

    // NO teardown. This is the point: the column is right while the run lives.
    expect(getMultiAgentSession(SESSION_ID)?.hops_used).toBe(1);
    expect(getMultiAgentSession(SESSION_ID)?.hops_used).not.toBe(rows.length);
  });

  test('the wire carries the router counter, not a row count', async () => {
    // The chip's numerator now arrives from the server. Reddens if a forwarder
    // stops passing `hopsCount` (the 4th arg) or passes something derived.
    const { wired, onEvent } = runWedge();
    wired.deliver(ORCHESTRATOR_AGENT_NAME, 'plan the round');
    await flush();

    // Key on the EVENTS rather than on the tail. Asserting "the last call
    // carried 1" passed with every forwarder mutated to a constant, because
    // the last call is the stranded-run note, which is emitted from a site the
    // mutation did not reach. Naming the two events makes the check bind to
    // the counter each one was actually forwarded with.
    const seen = (match: (ev: { source: string; destination: string; kind: string }) => boolean) =>
      onEvent.mock.calls.filter((c) => match(c[1])).map((c) => c[3]);

    // The one real hop: the delegation. Its forwarded count is the counter
    // AFTER it, so 1. Reddens if any forwarder passes a constant, a stale
    // value, or a row count.
    expect(seen((ev) => ev.destination === 'coder' && ev.kind === 'prompt')).toEqual([1]);
    // Cebab's own row lands with the count UNCHANGED beside it — which is what
    // tells the client "a row arrived, the budget did not move". Reddens if
    // the stranded note is ever routed through `forwardCebabEvent`.
    expect(seen((ev) => ev.source === CEBAB_SOURCE && ev.destination === USER_RECIPIENT)).toEqual([
      1,
    ]);
    // PREMISE: more rows than hops, so `1` above is not the row count agreeing
    // with itself.
    expect(listMultiAgentEvents(SESSION_ID).length).toBeGreaterThan(1);
  });
});

describe('resolveInitialHopsCount — what an R-B restart re-seeds the brake with', () => {
  test('prefers the persisted counter over the event-row count', () => {
    // The defect: a session that had taken 3 hops and accumulated 2 Cebab rows
    // came back seeded at 5, so the brake silently lost 2 hops of budget.
    // Reddens the moment the seed goes back to `allEvents.length`.
    expect(resolveInitialHopsCount(3, 5)).toBe(3);
  });

  test('zero is a value, not a missing one', () => {
    // `0 || rows` would take the fallback here. A session that has persisted
    // rows but taken no counted hop is exactly the reconstruct-of-a-stranded-
    // run case, so this is reachable, not hypothetical.
    expect(resolveInitialHopsCount(0, 4)).toBe(0);
  });

  test('falls back to the row count for a pre-Cebab-v85 row', () => {
    // `hops_used` was teardown-only, so live rows from before this shipped
    // have NULL and their router count is unrecoverable. Between two wrong
    // answers take the larger: it under-grants budget rather than letting a
    // restart extend a run past the operator's cap.
    expect(resolveInitialHopsCount(null, 7)).toBe(7);
    expect(resolveInitialHopsCount(undefined, 7)).toBe(7);
  });

  test('a non-finite column value is treated as missing', () => {
    // The column is unconstrained INTEGER; a hand-edited or corrupt value
    // must not become the budget seed.
    expect(resolveInitialHopsCount(Number.NaN, 6)).toBe(6);
  });
});
