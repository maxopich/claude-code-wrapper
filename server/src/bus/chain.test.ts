import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { createChainRouter, resumeChainSession, startChainSession } from './chain.js';
import { computeSessionPaths } from './paths.js';
import { CEBAB_SOURCE, SINK_RECIPIENT, type ResolvedAgent } from './runtime.js';
import {
  getLiveSession,
  hasLiveSession,
  registerLiveSession,
  unregisterLiveSession,
  type BusSink,
} from './session_registry.js';
import {
  createMultiAgentSession,
  getMultiAgentSession,
  listMultiAgentEvents,
} from '../repo/multi_agent.js';
import { upsertProject } from '../repo/projects.js';
import type { BusEvent } from './runner.js';
import type { Runner } from '../runner/index.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

let tmpRoot: string;
let originalDataDir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

const SESSION_ID = 'test-chain-wiring';
const AGENTS = ['coder', 'reviewer'];

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-chain-wiring-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  createMultiAgentSession(SESSION_ID, 'chain', 'iter-1');
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  closeDb();
  config.dataDir = originalDataDir;
  unregisterLiveSession(SESSION_ID);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function setup() {
  const workspace = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const paths = computeSessionPaths(SESSION_ID, workspace);
  fs.mkdirSync(paths.iterationDir('iter-1'), { recursive: true });
  const onEvent = vi.fn();
  const onEnded = vi.fn();
  const deliver = vi.fn();
  const router = createChainRouter({
    sessionId: SESSION_ID,
    iterationId: 'iter-1',
    agentNames: AGENTS,
    paths,
    onEvent,
    onEnded,
    deliver,
    // Generous cap so routing tests below don't accidentally trip on the
    // budget enforcement; the budget-specific test below overrides with a
    // tight value.
    hopBudget: 1000,
  });
  return { router, onEvent, onEnded, deliver, paths };
}

function ev(p: Partial<BusEvent>): BusEvent {
  return {
    ts: 1700000000000,
    source: 'coder',
    destination: 'reviewer',
    kind: 'reply',
    text: 'x',
    ...p,
  };
}

describe('createChainRouter routing', () => {
  test('participant→participant: persists, forwards, archives, wakes the destination', () => {
    const { router, onEvent, deliver, paths } = setup();
    router.handleEvent(ev({ source: 'coder', destination: 'reviewer', text: 'do review' }));

    expect(listMultiAgentEvents(SESSION_ID)).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith('reviewer', 'do review');
    // coder's hop archived (empty incoming prompt → reply.md = the text)
    expect(
      fs.readFileSync(path.join(paths.iterationDir('iter-1', 'coder'), 'reply.md'), 'utf8'),
    ).toBe('do review');
  });

  test('dest=_sink writes final.md and tears down as completed', () => {
    const { router, onEnded, deliver, paths } = setup();
    router.handleEvent(ev({ source: 'coder', destination: 'reviewer', text: 'work' }));
    router.handleEvent(
      ev({ source: 'reviewer', destination: SINK_RECIPIENT, kind: 'final', text: 'FINAL ANSWER' }),
    );

    expect(fs.readFileSync(path.join(paths.iterationDir('iter-1'), 'final.md'), 'utf8')).toBe(
      'FINAL ANSWER',
    );
    expect(onEnded).toHaveBeenCalledWith(SESSION_ID, 'completed', 'iter-1');
    expect(getMultiAgentSession(SESSION_ID)!.status).toBe('completed');
    // _sink is not a participant, so no extra wake past the terminal hop.
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  test('forwardCebabEvent persists + forwards but never routes', () => {
    const { router, onEvent, deliver } = setup();
    router.forwardCebabEvent({
      ts: 1,
      source: CEBAB_SOURCE,
      destination: 'coder',
      kind: 'intro',
      text: 'briefing',
    });
    expect(listMultiAgentEvents(SESSION_ID)).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
  });

  test('detach silences the WS sink but keeps persisting; rebind restores it', () => {
    const { router, onEvent } = setup();
    router.detach();
    router.handleEvent(ev({ source: 'coder', destination: 'reviewer', text: 'after detach' }));
    expect(listMultiAgentEvents(SESSION_ID)).toHaveLength(1); // still persisted
    expect(onEvent).not.toHaveBeenCalled(); // not forwarded

    const onEvent2 = vi.fn();
    router.rebind({ onEvent: onEvent2, onEnded: vi.fn() });
    router.handleEvent(ev({ source: 'coder', destination: 'reviewer', text: 'after rebind' }));
    expect(onEvent2).toHaveBeenCalledTimes(1);
  });
});

describe('createChainRouter — hop-budget enforcement', () => {
  function setupBudget(hopBudget: number) {
    const workspace = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const paths = computeSessionPaths(SESSION_ID, workspace);
    fs.mkdirSync(paths.iterationDir('iter-1'), { recursive: true });
    const onEvent = vi.fn();
    const onEnded = vi.fn();
    const deliver = vi.fn();
    const router = createChainRouter({
      sessionId: SESSION_ID,
      iterationId: 'iter-1',
      agentNames: AGENTS,
      paths,
      onEvent,
      onEnded,
      deliver,
      hopBudget,
    });
    return { router, onEvent, onEnded, deliver };
  }

  test('the Nth hop persists then refuses to wake the next agent (synthetic error appended)', () => {
    // Budget 3: hops 1 and 2 persist + deliver. Hop 3 persists (visible in
    // the trail) but its `deliver` is refused — the post-persist check
    // sees hopsCount=3 === budget and emits the synthetic error instead.
    const { router, onEvent, onEnded, deliver } = setupBudget(3);

    router.handleEvent(ev({ source: 'coder', destination: 'reviewer', text: 'h1' }));
    router.handleEvent(ev({ source: 'reviewer', destination: 'coder', text: 'h2' }));
    router.handleEvent(ev({ source: 'coder', destination: 'reviewer', text: 'h3' }));
    // Would be hop 4 — must not run; `ended` guard short-circuits handleEvent.
    router.handleEvent(ev({ source: 'reviewer', destination: 'coder', text: 'h4 (refused)' }));

    // 3 legitimate hops + 1 synthetic cebab→_sink error = 4 events on wire/DB.
    const persisted = listMultiAgentEvents(SESSION_ID);
    expect(persisted).toHaveLength(4);
    expect(persisted.at(-1)).toMatchObject({
      source: CEBAB_SOURCE,
      destination: SINK_RECIPIENT,
      kind: 'error',
    });
    expect(persisted.at(-1)!.text).toContain('Hop budget exhausted (3/3)');

    // sink.onEvent received the 3 hops + the synthetic error.
    expect(onEvent).toHaveBeenCalledTimes(4);

    // Hops 1 and 2 fired deliver; hop 3 was the boundary trip (its deliver
    // call was refused by the budget check), hop 4 was dropped by `ended`.
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenNthCalledWith(1, 'reviewer', 'h1');
    expect(deliver).toHaveBeenNthCalledWith(2, 'coder', 'h2');

    // Teardown ran exactly once with reason='stopped'.
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledWith(SESSION_ID, 'stopped', null);
    expect(getMultiAgentSession(SESSION_ID)!.status).toBe('stopped');
  });

  test('forwardCebabEvent rows count toward the budget', () => {
    // Briefings persisted before any agent hop should still count — the UI
    // shows `events.length / hopBudget` and the math has to match.
    const { router, onEnded, deliver } = setupBudget(2);
    router.forwardCebabEvent({
      ts: 1,
      source: CEBAB_SOURCE,
      destination: 'coder',
      kind: 'intro',
      text: 'briefing-1',
    });
    router.forwardCebabEvent({
      ts: 2,
      source: CEBAB_SOURCE,
      destination: 'reviewer',
      kind: 'intro',
      text: 'briefing-2',
    });
    // First agent hop would push count to 3 (over the cap) and trip the
    // synthetic error. Deliver to reviewer must not fire.
    router.handleEvent(ev({ source: 'coder', destination: 'reviewer', text: 'first work' }));

    expect(deliver).not.toHaveBeenCalled();
    expect(onEnded).toHaveBeenCalledWith(SESSION_ID, 'stopped', null);
    const persisted = listMultiAgentEvents(SESSION_ID);
    expect(persisted.at(-1)!.kind).toBe('error');
    expect(persisted.at(-1)!.text).toContain('Hop budget exhausted');
  });

  test('budget=Infinity-ish (1000) never trips on a short session', () => {
    const { router, onEnded, deliver } = setupBudget(1000);
    for (let i = 0; i < 10; i++) {
      router.handleEvent(
        ev({ source: i % 2 ? 'reviewer' : 'coder', destination: i % 2 ? 'coder' : 'reviewer' }),
      );
    }
    expect(deliver).toHaveBeenCalledTimes(10);
    expect(onEnded).not.toHaveBeenCalled();
    // No synthetic error event was emitted.
    const persisted = listMultiAgentEvents(SESSION_ID);
    expect(persisted.every((p) => p.kind !== 'error' || p.source !== CEBAB_SOURCE)).toBe(true);
  });
});

// --- Item #4: worker failure surfacing + pending-retry slot --------------
//
// onWorkerFailed is the router-side callback the `deliver` .catch fires
// when a worker's `deliverTurn` rejects (iterator throw OR non-success
// `result.subtype`). The change: don't teardown; instead persist a
// synthetic `cebab → user kind=error` event + write the pending-retry
// columns + emit `onPendingRetry`. The hop counter MUST NOT bump for the
// error event (matches the budget-exhaust precedent — the displayed
// ratio stays accurate).
describe('createChainRouter — onWorkerFailed (Item #4)', () => {
  function setupFail() {
    const workspace = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const paths = computeSessionPaths(SESSION_ID, workspace);
    fs.mkdirSync(paths.iterationDir('iter-1'), { recursive: true });
    const onEvent = vi.fn();
    const onEnded = vi.fn();
    const onPendingRetry = vi.fn();
    const deliver = vi.fn();
    const router = createChainRouter({
      sessionId: SESSION_ID,
      iterationId: 'iter-1',
      agentNames: AGENTS,
      paths,
      onEvent,
      onEnded,
      deliver,
      hopBudget: 1000,
      onPendingRetry,
    });
    return { router, onEvent, onEnded, onPendingRetry, deliver };
  }

  test('persists a cebab→user kind=error event, writes the slot, leaves session live', () => {
    const { router, onEvent, onEnded, onPendingRetry } = setupFail();
    router.onWorkerFailed('coder', 'do your work', new Error('SDK result subtype=error_max_turns'));

    const persisted = listMultiAgentEvents(SESSION_ID);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!).toMatchObject({
      source: CEBAB_SOURCE,
      destination: 'user',
      kind: 'error',
    });
    expect(persisted[0]!.text).toContain('`coder`');
    expect(persisted[0]!.text).toContain('SDK result subtype=error_max_turns');

    expect(onEvent).toHaveBeenCalledTimes(1);
    // Critical: the router does NOT tear down. The session stays running
    // until the operator retries or abandons.
    expect(onEnded).not.toHaveBeenCalled();
    expect(getMultiAgentSession(SESSION_ID)!.status).toBe('running');

    // The pending-retry callback fired with the descriptor matching the
    // persisted row (so the live wire and the post-restart DB hydrate to
    // the same banner).
    expect(onPendingRetry).toHaveBeenCalledTimes(1);
    const [sid, pending] = onPendingRetry.mock.calls[0]!;
    expect(sid).toBe(SESSION_ID);
    expect(pending).toMatchObject({
      agentName: 'coder',
      lastPrompt: 'do your work',
      errorEventId: persisted[0]!.id,
    });
    expect(pending!.reason).toContain('error_max_turns');

    // And the DB row reflects the same.
    const row = getMultiAgentSession(SESSION_ID)!;
    expect(row.pending_retry_agent).toBe('coder');
    expect(row.pending_retry_prompt).toBe('do your work');
    expect(row.pending_retry_error_event_id).toBe(persisted[0]!.id);
  });

  test('with an empty `prompt` (failed pre-deliver), falls back to teardown crashed', () => {
    // No bytes captured = nothing to retry. Collapse to the legacy crashed
    // teardown so the session ends with a legible status rather than
    // hanging in pending-retry forever.
    const { router, onEnded, onPendingRetry } = setupFail();
    router.onWorkerFailed('coder', '', new Error('boot failure'));

    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledWith(SESSION_ID, 'crashed', null);
    expect(onPendingRetry).not.toHaveBeenCalled();
    // The error event still persisted (operator sees the cause in the trail).
    const persisted = listMultiAgentEvents(SESSION_ID);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.kind).toBe('error');
  });

  test('does NOT bump the hop counter (budget-exhaust pattern parity)', () => {
    // Use a tight budget so a buggy increment would trip enforcement
    // immediately on a re-fail. Process one normal hop (hopsCount=1), then
    // a failure: budget=3 should still allow 2 more normal hops after.
    const workspace = path.join(tmpRoot, 'workspace2');
    fs.mkdirSync(workspace, { recursive: true });
    const paths = computeSessionPaths(SESSION_ID, workspace);
    fs.mkdirSync(paths.iterationDir('iter-1'), { recursive: true });
    const onEnded = vi.fn();
    const deliver = vi.fn();
    const router = createChainRouter({
      sessionId: SESSION_ID,
      iterationId: 'iter-1',
      agentNames: AGENTS,
      paths,
      onEvent: vi.fn(),
      onEnded,
      deliver,
      hopBudget: 3,
    });
    router.handleEvent(ev({ source: 'coder', destination: 'reviewer' })); // hopsCount=1
    router.onWorkerFailed('reviewer', 'work', new Error('boom')); // counter UNCHANGED
    router.handleEvent(ev({ source: 'reviewer', destination: 'coder' })); // hopsCount=2
    router.handleEvent(ev({ source: 'coder', destination: 'reviewer' })); // hopsCount=3 → next deliver refused
    // The 3rd hop persisted but its deliver was refused — budget would
    // have refused FOUR hops if the error event bumped the counter.
    expect(onEnded).toHaveBeenCalledWith(SESSION_ID, 'stopped', null);
    expect(deliver).toHaveBeenCalledTimes(2);
  });
});

describe('resumeChainSession (registry-based, R-A)', () => {
  test('returns null when the session is not live in this process', async () => {
    const handle = await resumeChainSession({
      sessionId: SESSION_ID,
      onEvent: vi.fn(),
      onEnded: vi.fn(),
    });
    expect(handle).toBeNull();
  });

  test('re-attaches a live chain session by swapping its sink, returns the original handle', async () => {
    let bound: BusSink | null = null;
    const originalHandle = {
      sessionId: SESSION_ID,
      iterationId: 'iter-1',
      participantAgentNames: AGENTS,
      lifecycle: 'persistent' as const,
      sessionFolder: tmpRoot,
      stop: vi.fn(),
      detach: vi.fn(),
      retry: vi.fn(),
      continueThroughMutation: vi.fn(),
    };
    registerLiveSession({
      sessionId: SESSION_ID,
      mode: 'chain',
      handle: originalHandle,
      rebind: (s) => {
        bound = s;
      },
    });

    const onEvent = vi.fn();
    const onEnded = vi.fn();
    const resumed = await resumeChainSession({ sessionId: SESSION_ID, onEvent, onEnded });

    expect(resumed).toBe(originalHandle);
    expect(bound).not.toBeNull();
    bound!.onEvent('s', { ts: 1, source: 'a', destination: 'b', kind: 'reply', text: 't' }, 9);
    expect(onEvent).toHaveBeenCalledWith('s', expect.objectContaining({ source: 'a' }), 9);
    expect(hasLiveSession(SESSION_ID)).toBe(true);
    expect(getLiveSession(SESSION_ID)!.mode).toBe('chain');
  });

  test('returns null for a live session of a different mode', async () => {
    registerLiveSession({
      sessionId: SESSION_ID,
      mode: 'orchestrator',
      handle: {
        sessionId: SESSION_ID,
        iterationId: 'iter-1',
        participantAgentNames: AGENTS,
        lifecycle: 'persistent',
        sessionFolder: tmpRoot,
        stop: vi.fn(),
        detach: vi.fn(),
        retry: vi.fn(),
        continueThroughMutation: vi.fn(),
      },
      rebind: vi.fn(),
    });
    expect(
      await resumeChainSession({ sessionId: SESSION_ID, onEvent: vi.fn(), onEnded: vi.fn() }),
    ).toBeNull();
  });
});

describe('startChainSession — project CLAUDE.md injection', () => {
  // Capture the prompt string that actually reaches the (faked) runner so we
  // can assert what participant[0] sees on its first turn.
  function fakeRunnerFactory(captured: string[]) {
    return (opts: { prompt: string }): Runner => {
      captured.push(opts.prompt);
      async function* gen(): AsyncGenerator<SDKMessage> {
        yield { type: 'result', subtype: 'success', session_id: 's1' } as unknown as SDKMessage;
      }
      const it = gen();
      return { [Symbol.asyncIterator]: () => it, close: () => {} };
    };
  }

  function participant(name: string, withClaudeMd: string | null): ResolvedAgent {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    if (withClaudeMd !== null) fs.writeFileSync(path.join(dir, 'CLAUDE.md'), withClaudeMd);
    const proj = upsertProject(name, dir);
    return { projectId: proj.id, agentName: name, cwd: dir, projectName: name };
  }

  test('participant[0] first turn gets the fenced CLAUDE.md; scrollback gets only a compact marker', async () => {
    const workspace = path.join(tmpRoot, 'ws');
    fs.mkdirSync(workspace, { recursive: true });
    const captured: string[] = [];
    const claudeMd = '# Coder rules\n\n- Run `npm test` before every reply\n- Never touch prod';
    const participants = [participant('coder', claudeMd), participant('reviewer', null)];

    const handle = await startChainSession({
      participants,
      initialPrompt: 'do the task',
      workspaceRoot: workspace,
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      runnerFactory: fakeRunnerFactory(captured),
    });
    // deliverTurn is fire-and-forget; flush the microtask + immediate queue.
    await new Promise((r) => setImmediate(r));

    // (a) coder's first delivered prompt carries the fenced, framed rules.
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain('<project_claude_md>');
    expect(captured[0]).toContain('- Run `npm test` before every reply');
    expect(captured[0]).toContain('AUTHORITATIVE project rules');
    // Order: bus protocol → rules → task.
    expect(captured[0]!.indexOf('bus_send')).toBeLessThan(
      captured[0]!.indexOf('<project_claude_md>'),
    );
    expect(captured[0]!.indexOf('<project_claude_md>')).toBeLessThan(
      captured[0]!.indexOf('do the task'),
    );

    // (b) scrollback: the protocol briefing + a ONE-LINE marker, never the body.
    const events = listMultiAgentEvents(handle.sessionId);
    const coderIntros = events.filter(
      (e) => e.source === CEBAB_SOURCE && e.destination === 'coder' && e.kind === 'intro',
    );
    const marker = coderIntros.find((e) => e.text.includes('Cebab injected coder/CLAUDE.md'));
    expect(marker).toBeDefined();
    expect(marker!.text).toMatch(/Cebab injected coder\/CLAUDE\.md \(\d+\.\d KB\) into coder/);
    // No persisted scrollback event leaks the actual rule text.
    expect(events.some((e) => e.text.includes('Never touch prod'))).toBe(false);

    unregisterLiveSession(handle.sessionId);
  });

  test('participant without a CLAUDE.md is briefed normally, no marker', async () => {
    const workspace = path.join(tmpRoot, 'ws2');
    fs.mkdirSync(workspace, { recursive: true });
    const captured: string[] = [];
    const participants = [participant('coder2', null), participant('reviewer2', null)];

    const handle = await startChainSession({
      participants,
      initialPrompt: 'task',
      workspaceRoot: workspace,
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      runnerFactory: fakeRunnerFactory(captured),
    });
    await new Promise((r) => setImmediate(r));

    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toContain('<project_claude_md>');
    const events = listMultiAgentEvents(handle.sessionId);
    expect(events.some((e) => e.text.includes('Cebab injected'))).toBe(false);

    unregisterLiveSession(handle.sessionId);
  });

  // Symmetric to orchestrator.wiring's onActivity test: chain uses the same
  // observer + onMessage-wrap + deliver `.finally`, so guard the chain path
  // explicitly (regression: a missing `.finally` would never emit `idle`).
  test('onActivity fires working then idle for the chain head turn', async () => {
    const workspace = path.join(tmpRoot, 'ws-act');
    fs.mkdirSync(workspace, { recursive: true });
    function actFactory() {
      return (): Runner => {
        async function* gen(): AsyncGenerator<SDKMessage> {
          yield {
            type: 'assistant',
            message: { content: [{ type: 'tool_use', name: 'Read' }] },
          } as unknown as SDKMessage;
          yield { type: 'result', subtype: 'success', session_id: 's1' } as unknown as SDKMessage;
        }
        const it = gen();
        return { [Symbol.asyncIterator]: () => it, close: () => {} };
      };
    }
    const onActivity = vi.fn();
    const handle = await startChainSession({
      participants: [participant('alpha', null), participant('bravo', null)],
      initialPrompt: 'go',
      workspaceRoot: workspace,
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      onActivity,
      runnerFactory: actFactory(),
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const calls = onActivity.mock.calls.map(
      (c) => [c[0], c[1] as { agentName: string; phase: string; currentTool?: string }] as const,
    );
    expect(calls.every(([sid]) => sid === handle.sessionId)).toBe(true);
    const seq = calls.map(([, s]) => s.phase);
    expect(seq[0]).toBe('working');
    expect(seq.at(-1)).toBe('idle');
    expect(calls.find(([, s]) => s.phase === 'working')![1]).toMatchObject({
      agentName: 'alpha',
      currentTool: 'Read',
    });

    unregisterLiveSession(handle.sessionId);
  });
});
