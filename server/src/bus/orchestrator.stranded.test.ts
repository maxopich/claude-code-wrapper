/**
 * `Cebab-vie.8` — muting a worker mid-delegation leaves the run with nobody
 * running, and Cebab now says so.
 *
 * These drive the real wiring rather than the decision function: the seam that
 * broke was not the predicate but the fact that nothing ever asked it. The
 * fake runner emits its `bus_send` from INSIDE the turn (between two yielded
 * SDKMessages), which is where a real one lands — `handleEvent` runs
 * synchronously on the sending agent's turn — so the ordering the detector
 * depends on is exercised rather than assumed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { ORCHESTRATOR_AGENT_NAME, wireOrchestratorSession } from './orchestrator.js';
import { computeSessionPaths } from './paths.js';
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

const SESSION_ID = 'test-orch-stranded';

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-orch-stranded-'));
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

const flush = async (times = 8) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
};

function makeWorker(name: string): ResolvedAgent {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const proj = upsertProject(name, dir);
  return { projectId: proj.id, agentName: name, cwd: dir, projectName: name };
}

/**
 * A runner whose turn N runs `perTurn[N]` (if present) between two yielded
 * messages, then completes. Indexed by call order rather than by agent so a
 * test can say "the worker replies, and the orchestrator's follow-up turn does
 * X" without threading agent names through the factory.
 */
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
 * The bead's sequence, driven through the real router.
 *
 * It starts at the ORCHESTRATOR's turn rather than at `deliver('coder', …)`,
 * and that is not ceremony: the delegation has to be a persisted
 * `orchestrator → coder prompt` row, because that row IS the tail the detector
 * reads and the tail the activity bar reads to say "coder working". Calling
 * `deliver` directly leaves the session with no events at all, which is a
 * different (and correctly un-reported) state.
 */
function wedgeScript(wiredRef: () => ReturnType<typeof wireOrchestratorSession>) {
  return {
    delegate: () =>
      wiredRef().router.handleEvent({
        ts: Date.now(),
        source: ORCHESTRATOR_AGENT_NAME,
        destination: 'coder',
        kind: 'prompt',
        text: 'ROUND 3 — MERGE',
      }),
    reply: (text: string) => () =>
      wiredRef().router.handleEvent({
        ts: Date.now(),
        source: 'coder',
        destination: ORCHESTRATOR_AGENT_NAME,
        kind: 'reply',
        text,
      }),
  };
}

const strandedRows = () =>
  listMultiAgentEvents(SESSION_ID).filter(
    (e) => e.source === CEBAB_SOURCE && e.destination === USER_RECIPIENT && e.kind === 'error',
  );

describe('a muted worker mid-delegation (Cebab-vie.8)', () => {
  /** Wire a session, mute `coder`, and run orchestrator-delegates →
   *  coder-replies. Returns the wiring so a test can drive further settles. */
  function runWedge(opts: { workers: string[]; hopBudget?: number; muted?: boolean }) {
    const workers = opts.workers.map(makeWorker);
    const script = wedgeScript(() => wired);
    const runnerFactory = scriptedRunner([
      // turn 0 — the orchestrator delegates; the prompt row is persisted and
      // `coder` is woken from inside this turn, exactly as a real hop does.
      script.delegate,
      // turn 1 — `coder` does the work and replies.
      script.reply('MERGED FINDINGS — 49 raw → 26 distinct'),
    ]);
    const wired: ReturnType<typeof wireOrchestratorSession> = wireOrchestratorSession({
      sessionId: SESSION_ID,
      iterationId: 'iter-1',
      lifecycle: 'persistent',
      paths: computeSessionPaths(SESSION_ID),
      workers,
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      runnerFactory,
      ...(opts.hopBudget === undefined ? {} : { hopBudget: opts.hopBudget }),
    });
    if (opts.muted !== false) expect(wired.router.setMute('coder', true)).toBe(true);
    return wired;
  }

  test('the run is left with nobody running, and a cebab → user row says so', async () => {
    const wired = runWedge({ workers: ['coder'] });
    wired.deliver(ORCHESTRATOR_AGENT_NAME, 'plan the round');
    await flush(16);

    // Premise first: the delegation really was persisted and really is the
    // tail. Without this the "one stranded row" below could be measuring a run
    // that never delegated.
    const evs = listMultiAgentEvents(SESSION_ID);
    const delegation = evs.find((e) => e.destination === 'coder' && e.kind === 'prompt');
    expect(delegation).toBeTruthy();

    const rows = strandedRows();
    expect(rows).toHaveLength(1);
    // The three facts the operator was denied: the agent is not working, the
    // reply is gone, and why. Asserted by content — "one more event landed" is
    // satisfied by any row at all.
    expect(rows[0]!.text).toContain('Nothing is running in this session');
    expect(rows[0]!.text).toContain('`coder`');
    expect(rows[0]!.text).toContain('muted_source');
    expect(rows[0]!.text).toContain('Send a prompt below');
    // The note reports the drop; it does not resurrect the message.
    expect(rows[0]!.text).not.toContain('MERGED FINDINGS');

    // The note is the LAST row, so the tail no longer awaits an agent — which
    // is what makes the web activity bar stop rendering `coder working`.
    expect(evs.length > 0).toBe(true);
    const after = listMultiAgentEvents(SESSION_ID);
    expect(after[after.length - 1]!.id).toBe(rows[0]!.id);

    // It labels the state; it does not end the run. Ending it would throw away
    // the rounds already done — the very thing that made Stop unacceptable.
    expect(getMultiAgentSession(SESSION_ID)?.status).toBe('running');
  });

  test('the note does not advance the hop counter', async () => {
    // Persisted directly rather than through `forwardCebabEvent`. A muted drop
    // is deliberately "as if it never happened" for the budget; Cebab's
    // explanation of the resulting silence is not a hop the run took either.
    // Reddens if the note is routed through `forwardCebabEvent`.
    //
    // Read via `teardown`, because `hops_used` is the router's in-memory
    // counter and only reaches the column at teardown — which is also the
    // number the templates rail renders, so this is the operator-visible one
    // rather than a proxy for it.
    const wired = runWedge({ workers: ['coder'], hopBudget: 50 });
    wired.deliver(ORCHESTRATOR_AGENT_NAME, 'plan the round');
    await flush(16);
    expect(strandedRows()).toHaveLength(1);

    await wired.router.teardown('stopped');
    // Exactly one hop really happened: the delegation. The reply was dropped
    // (drops never count) and the note is not a hop.
    expect(getMultiAgentSession(SESSION_ID)?.hops_used).toBe(1);
    const persisted = listMultiAgentEvents(SESSION_ID);
    // Premise: there ARE more rows than hops, so `1` is not simply the row
    // count agreeing with itself.
    expect(persisted.length).toBeGreaterThan(1);
  });

  test('reporting it once is enough, however many settles follow', async () => {
    // Self-limiting by construction rather than by a flag: the note's own row
    // is addressed to `user`, so the tail stops awaiting an agent the moment it
    // exists. A remembered "already told them" boolean would also pass this —
    // and would then never re-arm after a recovery, which the durable tail does
    // for free.
    const wired = runWedge({ workers: ['coder'] });
    wired.deliver(ORCHESTRATOR_AGENT_NAME, 'plan the round');
    await flush(16);
    expect(strandedRows()).toHaveLength(1);

    wired.router.onTurnSettled('coder');
    wired.router.onTurnSettled('coder');
    expect(strandedRows()).toHaveLength(1);
  });

  test('a held queue is not a stranded run', async () => {
    // The conjunct that keeps the detector safe on a paused run: a held agent
    // also ends its turn with the tail pointing at it, and the operator has a
    // Resume button. Holding a DIFFERENT agent is deliberate — the question is
    // "can anything still move this run", not "is the tail's agent held".
    const wired = runWedge({ workers: ['coder', 'reviewer'] });
    expect(wired.handle.pauseAgent('reviewer')).toBe(true);
    wired.deliver(ORCHESTRATOR_AGENT_NAME, 'plan the round');
    await flush(16);
    expect(strandedRows()).toHaveLength(0);

    // Positive control on the premise: lift the hold and the same run reports,
    // so the silence above was the gate and not a broken fixture.
    expect(wired.handle.resumeAgent('reviewer')).toBe(true);
    wired.router.onTurnSettled('coder');
    expect(strandedRows()).toHaveLength(1);
  });
});

describe('which drop gets the blame (Cebab-vie.8)', () => {
  test('a drop that a later turn superseded is not reported as the cause', async () => {
    // The recorded drop is cleared when a turn starts, because a turn starting
    // means the drop is no longer the last thing that happened. Without that
    // clear the note here would blame an `unknown_source` drop from the
    // orchestrator's own turn for a worker that simply finished quietly —
    // pointing the operator at forensics that have nothing to do with it.
    //
    // Reddens on removing `lastDrop = null` from `onTurnStarted`.
    const coder = makeWorker('coder');
    const runnerFactory = scriptedRunner([
      // turn 0 — the orchestrator sees a stray event dropped, THEN delegates.
      () => {
        wired.router.handleEvent({
          ts: Date.now(),
          source: 'ghost',
          destination: ORCHESTRATOR_AGENT_NAME,
          kind: 'reply',
          text: 'who am I',
        });
        wired.router.handleEvent({
          ts: Date.now(),
          source: ORCHESTRATOR_AGENT_NAME,
          destination: 'coder',
          kind: 'prompt',
          text: 'go',
        });
      },
      // turn 1 — `coder` ends without ever calling bus_send.
      undefined,
    ]);
    const wired: ReturnType<typeof wireOrchestratorSession> = wireOrchestratorSession({
      sessionId: SESSION_ID,
      iterationId: 'iter-1',
      lifecycle: 'persistent',
      paths: computeSessionPaths(SESSION_ID),
      workers: [coder],
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      runnerFactory,
    });

    wired.deliver(ORCHESTRATOR_AGENT_NAME, 'plan the round');
    await flush(16);

    const rows = strandedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toContain('ended without sending anything on the bus');
    // Premise: the drop really did happen, so this is a test about blame and
    // not about a drop that never occurred.
    expect(warnSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? '')).join('\n')).toContain(
      'drop event from non-participant source=ghost',
    );
    expect(rows[0]!.text).not.toContain('unknown_source');
    expect(rows[0]!.text).not.toContain('ghost');
  });
});

describe('runs that are idle for a reason the operator can already see', () => {
  test('an orchestrator answer to the operator is not a stranded run', async () => {
    // THE case that makes a general detector safe. Without the tail conjunct
    // every completed orchestrator run would end with a red row telling the
    // operator their finished session is broken.
    const coder = makeWorker('coder');
    const runnerFactory = scriptedRunner([
      // turn 0 — the worker replies, which wakes the orchestrator
      () =>
        wired.router.handleEvent({
          ts: Date.now(),
          source: 'coder',
          destination: ORCHESTRATOR_AGENT_NAME,
          kind: 'reply',
          text: 'here is my part',
        }),
      // turn 1 — the orchestrator answers the operator and stops
      () =>
        wired.router.handleEvent({
          ts: Date.now(),
          source: ORCHESTRATOR_AGENT_NAME,
          destination: USER_RECIPIENT,
          kind: 'final',
          text: 'all done',
        }),
    ]);
    const wired: ReturnType<typeof wireOrchestratorSession> = wireOrchestratorSession({
      sessionId: SESSION_ID,
      iterationId: 'iter-1',
      lifecycle: 'persistent',
      paths: computeSessionPaths(SESSION_ID),
      workers: [coder],
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      runnerFactory,
    });

    wired.deliver('coder', 'go');
    await flush(16);

    // Both turns ran and the answer landed — otherwise "no stranded row" would
    // be satisfied by a run that never got going.
    const evs = listMultiAgentEvents(SESSION_ID);
    expect(evs.some((e) => e.destination === USER_RECIPIENT && e.kind === 'final')).toBe(true);
    expect(strandedRows()).toHaveLength(0);
  });

  test('a failed worker turn is reported as a failure, not as a wedge', async () => {
    // `onWorkerFailed` already writes its own `cebab → user` row and parks a
    // Retry/Abandon slot. Reddens if `onTurnSettled` is moved ahead of the
    // `.catch` in the wiring, which would have the detector read the
    // pre-failure tail and report a recoverable failure as a wedged run.
    const coder = makeWorker('coder');
    const runnerFactory = (): Runner => {
      // The turn throws before it can yield — that IS the failure being
      // modelled, so the rule has nothing to say here.
      // eslint-disable-next-line require-yield
      async function* gen(): AsyncGenerator<SDKMessage> {
        throw new Error('worker exploded');
      }
      const it = gen();
      return { [Symbol.asyncIterator]: () => it, close: () => undefined };
    };
    const wired = wireOrchestratorSession({
      sessionId: SESSION_ID,
      iterationId: 'iter-1',
      lifecycle: 'persistent',
      paths: computeSessionPaths(SESSION_ID),
      workers: [coder],
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      runnerFactory,
    });

    wired.deliver('coder', 'go');
    await flush(16);

    const rows = strandedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toContain('worker exploded');
    expect(rows[0]!.text).not.toContain('Nothing is running in this session');
  });
});
