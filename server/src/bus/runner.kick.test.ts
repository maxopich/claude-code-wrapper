import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AgentRunner } from './runner.js';
import { isBusControlSignal, isTurnRefused, TurnRefusedError } from './errors.js';
import type { Runner, RunOptions, MockOptions } from '../runner/index.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * `Cebab-vie.11` / `Cebab-ygu.3` [security]: kick reaches the turn QUEUE, not
 * only the router's event gate.
 *
 * Kick's whole enforcement used to be two `kickedSet` membership tests inside
 * the orchestrator router's `handleEvent`, which gate *bus events*. A delivery
 * that had already passed them and was waiting behind another turn was inside
 * the runner, and the runner knew nothing about kicks — so when the in-flight
 * turn settled, a kicked worker got a brand-new `claude --resume` with the bus
 * posture's auto-allow gate: unmediated Bash/Edit/MCP and that project's hooks,
 * under a UI reading "kicked". Its `bus_send` output was still dropped
 * (`kicked_source`), so the operator saw drop notices and nothing of what it
 * actually did.
 *
 * `orchestrator.kick.test.ts` could not have caught this: it builds a bare
 * router with no `AgentRunner` at all, so all of its cases assert `handleEvent`
 * drops. This file is the runner-side half.
 */

function resultMsg(sessionId: string): SDKMessage {
  return { type: 'result', subtype: 'success', session_id: sessionId } as unknown as SDKMessage;
}

function buildBlockingRunner() {
  const turnReleases: Array<() => void> = [];
  const turnStarted: Array<() => void> = [];
  const runnerFactory = vi.fn((_opts: RunOptions & Partial<MockOptions>): Runner => {
    void _opts;
    let release!: () => void;
    let onStart!: () => void;
    const blocker = new Promise<void>((res) => {
      release = res;
    });
    void new Promise<void>((res) => {
      onStart = res;
    });
    turnReleases.push(release);
    turnStarted.push(onStart);
    async function* gen(): AsyncGenerator<SDKMessage> {
      onStart();
      await blocker;
      yield resultMsg(`sess-${turnReleases.length}`);
    }
    const it = gen();
    return { [Symbol.asyncIterator]: () => it, close: () => {} };
  });
  return { runnerFactory, turnReleases, turnStarted };
}

async function pollUntil(predicate: () => boolean, maxTriesPer5ms = 200): Promise<void> {
  for (let i = 0; i < maxTriesPer5ms; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('pollUntil timed out waiting for predicate');
}

describe('[security] a queued delivery for a kicked agent never starts (Cebab-vie.11)', () => {
  let originalApiKey: string | undefined;
  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (originalApiKey !== undefined) process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  test('the delivery waiting behind an in-flight turn is refused, not run', async () => {
    const { runnerFactory, turnReleases, turnStarted } = buildBlockingRunner();
    const kicked = new Set<string>();
    const runner = new AgentRunner({
      onEvent: () => undefined,
      runnerFactory,
      canStartTurn: (name) => !kicked.has(name),
    });
    runner.register({ name: 'reviewer', cwd: '/tmp/reviewer' });

    // The bead's Path A: the orchestrator's turn called bus_send twice.
    const first = runner.deliverTurn('reviewer', 'analyze A');
    await turnStarted[0];
    const queued = runner.deliverTurn('reviewer', 'also check B');

    // The operator watches turn 1 and kicks.
    kicked.add('reviewer');

    // Drain semantics: the in-flight turn still finishes.
    turnReleases[0]!();
    await expect(first).resolves.toBeUndefined();

    // The queued one rejects with the sentinel and NEVER spawned a process —
    // the factory call count is the assertion that matters, because a resolve
    // would look identical from the promise alone.
    await expect(queued).rejects.toBeInstanceOf(TurnRefusedError);
    expect(runnerFactory).toHaveBeenCalledTimes(1);
    expect(runner.getPendingDeliveries('reviewer')).toBe(0);
  });

  test('a refusal is a rejection, not a quiet resolve', async () => {
    // Resolving would run the routers' `.then` — `onTurnSucceeded`, which
    // clears the agent's pending-retry slot. That records a success for a turn
    // that never happened.
    const { runnerFactory } = buildBlockingRunner();
    const kicked = new Set(['reviewer']);
    const runner = new AgentRunner({
      onEvent: () => undefined,
      runnerFactory,
      canStartTurn: (name) => !kicked.has(name),
    });
    runner.register({ name: 'reviewer', cwd: '/tmp/reviewer' });

    const err = await runner.deliverTurn('reviewer', 'go').then(
      () => null,
      (e: unknown) => e,
    );
    expect(isTurnRefused(err)).toBe(true);
    expect((err as TurnRefusedError).agentName).toBe('reviewer');
    expect(runnerFactory).not.toHaveBeenCalled();
  });

  test('TurnRefusedError is a bus control signal, so the overload loop cannot retry it', () => {
    // `isTransientOverload` matches on `err.message`, and a sentinel that is not
    // in this set falls back to being classified by its own text — the
    // `Cebab-vie.14` hole. Three more full-length attempts at a wall Cebab
    // itself put up is the specific failure here.
    expect(isBusControlSignal(new TurnRefusedError('reviewer'))).toBe(true);
  });

  test('other agents are unaffected — the check is per agent, not global', async () => {
    const { runnerFactory, turnReleases, turnStarted } = buildBlockingRunner();
    const kicked = new Set(['reviewer']);
    const runner = new AgentRunner({
      onEvent: () => undefined,
      runnerFactory,
      canStartTurn: (name) => !kicked.has(name),
    });
    runner.register({ name: 'reviewer', cwd: '/tmp/reviewer' });
    runner.register({ name: 'scribe', cwd: '/tmp/scribe' });

    await expect(runner.deliverTurn('reviewer', 'go')).rejects.toBeInstanceOf(TurnRefusedError);
    const ok = runner.deliverTurn('scribe', 'go');
    await pollUntil(() => turnStarted.length >= 1);
    turnReleases[0]!();
    await expect(ok).resolves.toBeUndefined();
    expect(runnerFactory).toHaveBeenCalledTimes(1);
  });

  test('with no canStartTurn dep (chain mode) behaviour is unchanged', async () => {
    // Chain refuses kick outright (`chain_topology_broken`), so `chain.ts` wires
    // no predicate. Absent must mean "every dequeued turn starts", not "none".
    const { runnerFactory, turnReleases, turnStarted } = buildBlockingRunner();
    const runner = new AgentRunner({ onEvent: () => undefined, runnerFactory });
    runner.register({ name: 'reviewer', cwd: '/tmp/reviewer' });

    const turn = runner.deliverTurn('reviewer', 'go');
    await pollUntil(() => turnStarted.length >= 1);
    turnReleases[0]!();
    await expect(turn).resolves.toBeUndefined();
  });
});

describe('[security] a kicked agent is not left stranded behind its own pause gate', () => {
  let originalApiKey: string | undefined;
  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (originalApiKey !== undefined) process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  test('releaseAllHolds sends a parked delivery back to the check, where it is refused', async () => {
    // The `auto_kick` expiry shape: pause expires without a resume, so
    // `executeExpire` clears the pause COLUMN and kicks — but never calls
    // `resumeAgent`. A delivery already inside `await gate.promise` cannot
    // notice the kick from in there, and nothing else would settle it: the
    // promise never resolves, `pendingDeliveries` never drains, and the
    // router's `onTurnStarted` is never balanced. The run looks busy forever.
    const { runnerFactory, turnReleases, turnStarted } = buildBlockingRunner();
    const kicked = new Set<string>();
    const runner = new AgentRunner({
      onEvent: () => undefined,
      runnerFactory,
      canStartTurn: (name) => !kicked.has(name),
    });
    runner.register({ name: 'reviewer', cwd: '/tmp/reviewer' });

    const first = runner.deliverTurn('reviewer', 'first');
    await turnStarted[0];
    const queued = runner.deliverTurn('reviewer', 'q1');
    runner.pause('reviewer');
    turnReleases[0]!();
    await first;

    // Parked on the gate, not refused yet.
    await new Promise((r) => setTimeout(r, 30));
    expect(runnerFactory).toHaveBeenCalledTimes(1);

    kicked.add('reviewer');
    expect(runner.releaseAllHolds('reviewer')).toBe(true);
    await expect(queued).rejects.toBeInstanceOf(TurnRefusedError);
    expect(runnerFactory).toHaveBeenCalledTimes(1);
    expect(runner.anyGateHeld()).toBe(false);
  });

  test('releaseAllHolds drops BOTH holders, not just the operator one', async () => {
    // `resume` and `releaseMutationHold` each drop exactly one holder, which is
    // what stops an operator Continue from lifting a standing pause. Kick is
    // the one case where both must go: nothing will run for this agent again,
    // so a surviving hold is in-memory state no banner explains.
    const { runnerFactory } = buildBlockingRunner();
    const runner = new AgentRunner({ onEvent: () => undefined, runnerFactory });
    runner.register({ name: 'reviewer', cwd: '/tmp/reviewer' });

    runner.pause('reviewer');
    runner.holdForMutation('reviewer');
    expect(runner.isPaused('reviewer')).toBe(true);
    expect(runner.anyGateHeld()).toBe(true);

    expect(runner.releaseAllHolds('reviewer')).toBe(true);
    expect(runner.isPaused('reviewer')).toBe(false);
    expect(runner.anyGateHeld()).toBe(false);
    // Idempotent: a second call finds no gate.
    expect(runner.releaseAllHolds('reviewer')).toBe(false);
  });

  test('a NEW delivery for a kicked agent is refused promptly even while a stale gate stands', async () => {
    // This is the case the `acquireHold` simplification is actually for. While
    // the gate was ALSO spliced into `turnTails`, a delivery enqueued after it
    // never reached its own `.then`, so `canStartTurn` never ran for it and it
    // waited on `releaseAllHolds` instead of being refused on arrival. Reading
    // the gate from the map at dequeue puts the refusal check first.
    const { runnerFactory } = buildBlockingRunner();
    const kicked = new Set(['reviewer']);
    const runner = new AgentRunner({
      onEvent: () => undefined,
      runnerFactory,
      canStartTurn: (name) => !kicked.has(name),
    });
    runner.register({ name: 'reviewer', cwd: '/tmp/reviewer' });

    runner.pause('reviewer');
    await expect(runner.deliverTurn('reviewer', 'late')).rejects.toBeInstanceOf(TurnRefusedError);
    expect(runnerFactory).not.toHaveBeenCalled();
  });
});
