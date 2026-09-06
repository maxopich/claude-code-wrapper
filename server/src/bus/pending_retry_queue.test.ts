/**
 * Migration 041 turned the pending-retry slot into a per-agent QUEUE, and both
 * routers were left asking single-slot questions of it.
 *
 * `Cebab-mnba` — the orchestrator's `onTurnSucceeded` guarded its reap on "is
 * this agent the FRONT?", so a recovering agent behind the front kept a row it
 * had already invalidated. `Cebab-6c1m` — chain never moved off the single-slot
 * API at all: it emitted the just-failed agent while the wire's one descriptor
 * must carry the front, and cleared with `setPendingRetry(sessionId, null)`,
 * which is a session-wide DELETE.
 *
 * The harm is the same on both sides and it is not cosmetic. A pending-retry
 * row holds the POST-BRIEFING bytes captured from a failed turn — the only
 * thing that makes that turn replayable — and Retry runs a full tool-capable
 * turn with the bus's auto-allow posture. So a stale row offers to re-run work
 * that already landed (duplicate Edits/Bash, duplicate `bus_send`, hops off the
 * budget), and a session-wide clear destroys a sibling's bytes outright.
 *
 * Two rows is reachable in BOTH modes. Chain's `deliver` is fire-and-forget
 * (`void runner.deliverTurn`), so A's turn is still live once its `bus_send`
 * has woken B and both can fail.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { createChainRouter, startChainSession } from './chain.js';
import { createOrchestratorRouter } from './orchestrator.js';
import { computeSessionPaths } from './paths.js';
import type { ResolvedAgent } from './runtime.js';
import { unregisterLiveSession } from './session_registry.js';
import {
  createMultiAgentSession,
  getPendingRetry,
  listPendingRetries,
  setPendingRetry,
} from '../repo/multi_agent.js';
import { upsertProject } from '../repo/projects.js';
import type { Runner } from '../runner/index.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const SESSION_ID = 'pending-retry-queue';

let tmpRoot: string;
let originalDataDir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-pending-retry-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  closeDb();
  config.dataDir = originalDataDir;
  unregisterLiveSession(SESSION_ID);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Agent names of every parked row, front (oldest) first. */
function queue(sessionId: string): string[] {
  return listPendingRetries(sessionId).map((p) => p.agentName);
}

// ---------------------------------------------------------------------------
// Cebab-mnba — orchestrator
// ---------------------------------------------------------------------------

describe('[Cebab-mnba] orchestrator onTurnSucceeded reaps behind the front', () => {
  function buildRouter() {
    const paths = computeSessionPaths(SESSION_ID);
    createMultiAgentSession(SESSION_ID, 'orchestrator', '001', paths.folder, 'persistent');
    const onPendingRetry = vi.fn();
    const router = createOrchestratorRouter({
      sessionId: SESSION_ID,
      iterationId: '001',
      workerNames: ['reviewer', 'editor'],
      paths,
      lifecycle: 'persistent',
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      deliver: vi.fn(),
      hopBudget: 1000,
      onPendingRetry,
    });
    return { router, onPendingRetry };
  }

  /** reviewer fails first, editor second — so editor is BEHIND the front. */
  function twoFailures(router: ReturnType<typeof buildRouter>['router']) {
    router.onWorkerFailed('reviewer', 'review this', new Error('boom'));
    router.onWorkerFailed('editor', 'edit this', new Error('boom'));
    expect(queue(SESSION_ID)).toEqual(['reviewer', 'editor']);
  }

  test('the recovering agent behind the front loses its row', () => {
    const { router } = buildRouter();
    twoFailures(router);

    router.onTurnSucceeded('editor');

    // Pre-fix this returned early — `front.agentName !== 'editor'` — and left
    // a row for a worker that had just delivered. `clearPendingRetry` is a
    // keyed delete and never needed the front check.
    expect(queue(SESSION_ID)).toEqual(['reviewer']);
  });

  test('and the wire stays quiet, because the front did not move', () => {
    const { router, onPendingRetry } = buildRouter();
    twoFailures(router);
    onPendingRetry.mockClear();

    router.onTurnSucceeded('editor');

    // One descriptor on the wire means only the front is renderable. Re-
    // emitting an unchanged banner is noise, so the reap is silent — but the
    // row is still gone, which the case above is what proves.
    expect(onPendingRetry).not.toHaveBeenCalled();
    expect(getPendingRetry(SESSION_ID)!.agentName).toBe('reviewer');
  });

  test('CONTROL: a front reap still promotes the next row onto the wire', () => {
    const { router, onPendingRetry } = buildRouter();
    twoFailures(router);
    onPendingRetry.mockClear();

    router.onTurnSucceeded('reviewer');

    expect(queue(SESSION_ID)).toEqual(['editor']);
    expect(onPendingRetry).toHaveBeenCalledTimes(1);
    expect(onPendingRetry.mock.calls[0]![1]).toMatchObject({ agentName: 'editor' });
  });

  test('CONTROL: the last row leaving still emits the null clear', () => {
    const { router, onPendingRetry } = buildRouter();
    router.onWorkerFailed('reviewer', 'review this', new Error('boom'));
    onPendingRetry.mockClear();

    router.onTurnSucceeded('reviewer');

    expect(queue(SESSION_ID)).toEqual([]);
    expect(onPendingRetry).toHaveBeenCalledWith(SESSION_ID, null);
  });
});

// ---------------------------------------------------------------------------
// Cebab-6c1m — chain
// ---------------------------------------------------------------------------

describe('[Cebab-6c1m] chain surfaces the front, not the newest failure', () => {
  function setupFail() {
    const paths = computeSessionPaths(SESSION_ID);
    createMultiAgentSession(SESSION_ID, 'chain', 'iter-1', paths.folder, 'persistent');
    fs.mkdirSync(paths.iterationDir('iter-1'), { recursive: true });
    const onPendingRetry = vi.fn();
    const router = createChainRouter({
      sessionId: SESSION_ID,
      iterationId: 'iter-1',
      agentNames: ['coder', 'reviewer'],
      paths,
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      deliver: vi.fn(),
      hopBudget: 1000,
      onPendingRetry,
    });
    return { router, onPendingRetry };
  }

  test('a second failure leaves the FIRST failure on the banner', () => {
    const { router, onPendingRetry } = setupFail();
    router.onWorkerFailed('coder', 'coder bytes', new Error('first'));
    router.onWorkerFailed('reviewer', 'reviewer bytes', new Error('second'));

    // Both parked (migration 041's per-agent upsert), and the operator is
    // still looking at the failure they were already looking at.
    expect(queue(SESSION_ID)).toEqual(['coder', 'reviewer']);
    expect(onPendingRetry).toHaveBeenCalledTimes(2);
    expect(onPendingRetry.mock.calls[1]![1]).toMatchObject({
      agentName: 'coder',
      lastPrompt: 'coder bytes',
    });
  });

  test('CONTROL: a lone failure is its own front and still reaches the wire', () => {
    const { router, onPendingRetry } = setupFail();
    router.onWorkerFailed('coder', 'coder bytes', new Error('first'));

    expect(onPendingRetry).toHaveBeenCalledTimes(1);
    expect(onPendingRetry.mock.calls[0]![1]).toMatchObject({ agentName: 'coder' });
  });

  test('a stalled-drop park behind an existing failure also emits the front', () => {
    // The park written in `onTurnSucceeded` (Cebab-wsq) is chain's SECOND
    // writer of a pending-retry row, and it had the same single-slot emit.
    // A one-row session cannot tell the two apart — the parked agent IS the
    // front — so this needs an earlier failure standing.
    const { router, onPendingRetry } = setupFail();
    router.onWorkerFailed('coder', 'coder bytes', new Error('first'));
    onPendingRetry.mockClear();

    // reviewer's `bus_send` names nobody, so the chain has no next turn; the
    // park is deferred to the end of reviewer's own turn, which is production
    // ordering rather than a test convenience.
    router.handleEvent({
      ts: 1_700_000_000_000,
      source: 'reviewer',
      destination: 'nobody',
      kind: 'prompt',
      text: 'x',
    });
    router.onTurnSucceeded('reviewer');

    expect(queue(SESSION_ID)).toEqual(['coder', 'reviewer']);
    expect(onPendingRetry).toHaveBeenLastCalledWith(
      SESSION_ID,
      expect.objectContaining({ agentName: 'coder' }),
    );
  });

  test('onTurnSucceeded reaps only the recovering agent, not the session', () => {
    const { router, onPendingRetry } = setupFail();
    router.onWorkerFailed('coder', 'coder bytes', new Error('first'));
    router.onWorkerFailed('reviewer', 'reviewer bytes', new Error('second'));
    onPendingRetry.mockClear();

    router.onTurnSucceeded('reviewer');

    // Pre-fix, the front check said "not reviewer" and the row survived; had
    // reviewer BEEN the front, `setPendingRetry(null)` would have taken
    // coder's bytes with it. Both halves are the same single-slot API.
    expect(queue(SESSION_ID)).toEqual(['coder']);
    // And chain's half of the front-unchanged silence. Without this line the
    // guard is unobservable here — measured: forcing the branch open reddened
    // the orchestrator's twin and nothing on this side.
    expect(onPendingRetry).not.toHaveBeenCalled();
  });

  test('a front recovery promotes the sibling instead of wiping it', () => {
    const { router, onPendingRetry } = setupFail();
    router.onWorkerFailed('coder', 'coder bytes', new Error('first'));
    router.onWorkerFailed('reviewer', 'reviewer bytes', new Error('second'));
    onPendingRetry.mockClear();

    router.onTurnSucceeded('coder');

    expect(queue(SESSION_ID)).toEqual(['reviewer']);
    expect(onPendingRetry).toHaveBeenLastCalledWith(
      SESSION_ID,
      expect.objectContaining({ agentName: 'reviewer', lastPrompt: 'reviewer bytes' }),
    );
  });
});

describe('[Cebab-6c1m] chain Retry runs the front and keeps the rest', () => {
  test('the retried agent is the front, and the sibling row survives', async () => {
    const workspace = path.join(tmpRoot, 'ws-retry');
    fs.mkdirSync(workspace, { recursive: true });
    const mk = (name: string): ResolvedAgent => {
      const dir = path.join(tmpRoot, `retry-${name}`);
      fs.mkdirSync(dir, { recursive: true });
      const proj = upsertProject(name, dir);
      return { projectId: proj.id, agentName: name, cwd: dir, projectName: name };
    };

    // A turn that never resolves: `retry` re-delivers, and letting that
    // delivery finish would fire `onTurnSucceeded` and reap the very row the
    // assertions are about.
    const hangingRunnerFactory = (): Runner => {
      async function* gen(): AsyncGenerator<SDKMessage> {
        await new Promise<void>(() => {});
        // Unreachable — the await never settles. Present so this is a
        // generator (`require-yield`) rather than a plain async function.
        yield undefined as unknown as SDKMessage;
      }
      const it = gen();
      return { [Symbol.asyncIterator]: () => it, close: () => {} };
    };

    const onPendingRetry = vi.fn();
    const handle = await startChainSession({
      participants: [mk('head'), mk('tail')],
      initialPrompt: 'go',
      workspaceRoot: workspace,
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      onPendingRetry,
      runnerFactory: hangingRunnerFactory,
    });
    await new Promise((r) => setImmediate(r));

    // Seed the queue directly: two rows is production-reachable (see the file
    // header) but takes two real failed turns to reach, and this test is about
    // what Retry does with the queue, not how it fills.
    setPendingRetry(handle.sessionId, {
      agentName: 'head',
      prompt: 'head bytes',
      reason: 'head failed first',
      ts: 1000,
      errorEventId: 1,
    });
    setPendingRetry(handle.sessionId, {
      agentName: 'tail',
      prompt: 'tail bytes',
      reason: 'tail failed second',
      ts: 1200,
      errorEventId: 2,
    });
    onPendingRetry.mockClear();

    await handle.retry();

    // Pre-fix: `setPendingRetry(sessionId, null)` deleted BOTH rows and emitted
    // null, so tail's captured bytes — the only copy — were gone, and the
    // banner said there was nothing left to retry.
    expect(queue(handle.sessionId)).toEqual(['tail']);
    expect(onPendingRetry).toHaveBeenLastCalledWith(
      handle.sessionId,
      expect.objectContaining({ agentName: 'tail', lastPrompt: 'tail bytes' }),
    );

    await handle.stop('stopped');
    unregisterLiveSession(handle.sessionId);
  });
});
