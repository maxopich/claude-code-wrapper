// Pure-SDK runtime wiring for orchestrator mode — complements the existing
// orchestrator.test.ts (workspace generator + F2/F3 + registerWorker +
// setLifecycle) with the AgentRunner-era routing: deliver(), sendUserPrompt,
// detach/rebind, and registry-based resume (decision R-A).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import {
  createOrchestratorRouter,
  ORCHESTRATOR_AGENT_NAME,
  resumeOrchestratorSession,
  wireOrchestratorSession,
} from './orchestrator.js';
import { computeSessionPaths } from './paths.js';
import { CEBAB_SOURCE, USER_RECIPIENT, type ResolvedAgent } from './runtime.js';
import { registerLiveSession, unregisterLiveSession } from './session_registry.js';
import {
  appendMultiAgentMutation,
  createMultiAgentSession,
  findUnconsumedApproval,
  getPendingRetry,
  getMultiAgentSession,
  listAgentSessions,
  listMultiAgentEvents,
  listMultiAgentMutations,
  listParticipants,
  listPendingMutations,
  setMutationPauseState,
  setPauseOnDangerous,
  setPendingRetry,
  setProjectBusInstalled,
} from '../repo/multi_agent.js';
import { setProjectModel, upsertProject } from '../repo/projects.js';
import { verifyChain } from '../notifications/safety_audit.js';
import type { BusEvent } from './runner.js';
import type { Runner } from '../runner/index.js';
import type { RunOptions } from '../runner/index.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { NotificationEnvelope } from '@cebab/shared/protocol';

let tmpRoot: string;
let originalDataDir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

const SESSION_ID = 'test-orch-wiring';
const WORKERS = ['coder', 'reviewer'];

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-orch-wiring-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  createMultiAgentSession(SESSION_ID, 'orchestrator', 'iter-1');
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
  const paths = computeSessionPaths(SESSION_ID);
  const onEvent = vi.fn();
  const onEnded = vi.fn();
  const deliver = vi.fn();
  const router = createOrchestratorRouter({
    sessionId: SESSION_ID,
    iterationId: 'iter-1',
    workerNames: WORKERS,
    paths,
    lifecycle: 'persistent',
    onEvent,
    onEnded,
    deliver,
    hopBudget: 1000,
  });
  return { router, onEvent, onEnded, deliver };
}

function ev(p: Partial<BusEvent>): BusEvent {
  return {
    ts: 1700000000000,
    source: ORCHESTRATOR_AGENT_NAME,
    destination: 'coder',
    kind: 'prompt',
    text: 'x',
    ...p,
  };
}

describe('orchestrator routing (AgentRunner era)', () => {
  test('orchestrator→worker delivers a turn to that worker', () => {
    const { router, onEvent, deliver } = setup();
    router.handleEvent(ev({ source: ORCHESTRATOR_AGENT_NAME, destination: 'coder', text: 'go' }));
    expect(listMultiAgentEvents(SESSION_ID)).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith('coder', 'go', ORCHESTRATOR_AGENT_NAME);
  });

  test('worker→orchestrator delivers a turn to the orchestrator', () => {
    const { router, deliver } = setup();
    router.handleEvent(
      ev({ source: 'coder', destination: ORCHESTRATOR_AGENT_NAME, kind: 'reply', text: 'done' }),
    );
    expect(deliver).toHaveBeenCalledWith(ORCHESTRATOR_AGENT_NAME, 'done', 'coder');
  });

  test('orchestrator→user persists + forwards but does not route', () => {
    const { router, onEvent, deliver } = setup();
    router.handleEvent(
      ev({
        source: ORCHESTRATOR_AGENT_NAME,
        destination: USER_RECIPIENT,
        kind: 'final',
        text: 'answer',
      }),
    );
    expect(listMultiAgentEvents(SESSION_ID)).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
  });

  test('sendUserPrompt forwards a cebab prompt and wakes the orchestrator', async () => {
    const { router, onEvent, deliver } = setup();
    await router.sendUserPrompt('new user ask');
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(listMultiAgentEvents(SESSION_ID)[0]).toMatchObject({
      source: CEBAB_SOURCE,
      destination: ORCHESTRATOR_AGENT_NAME,
      kind: 'prompt',
    });
    expect(deliver).toHaveBeenCalledWith(ORCHESTRATOR_AGENT_NAME, 'new user ask');
  });

  test('detach silences the sink but keeps persisting; rebind restores it', () => {
    const { router, onEvent } = setup();
    router.detach();
    router.handleEvent(ev({ source: ORCHESTRATOR_AGENT_NAME, destination: 'coder', text: 'a' }));
    expect(listMultiAgentEvents(SESSION_ID)).toHaveLength(1);
    expect(onEvent).not.toHaveBeenCalled();
    const onEvent2 = vi.fn();
    router.rebind({ onEvent: onEvent2, onEnded: vi.fn() });
    router.handleEvent(ev({ source: ORCHESTRATOR_AGENT_NAME, destination: 'coder', text: 'b' }));
    expect(onEvent2).toHaveBeenCalledTimes(1);
  });
});

describe('resumeOrchestratorSession (registry-based, R-A)', () => {
  test('null when not live in this process', async () => {
    expect(
      await resumeOrchestratorSession({
        sessionId: SESSION_ID,
        onEvent: vi.fn(),
        onEnded: vi.fn(),
      }),
    ).toBeNull();
  });

  test('re-attaches a live orchestrator session and returns the original handle', async () => {
    const originalHandle = {
      sessionId: SESSION_ID,
      iterationId: 'iter-1',
      participantAgentNames: [ORCHESTRATOR_AGENT_NAME, ...WORKERS],
      lifecycle: 'persistent' as const,
      sessionFolder: tmpRoot,
      stop: vi.fn(),
      detach: vi.fn(),
      retry: vi.fn(),
      continueThroughMutation: vi.fn(),
    };
    let bound = false;
    registerLiveSession({
      sessionId: SESSION_ID,
      mode: 'orchestrator',
      handle: originalHandle,
      rebind: () => {
        bound = true;
        return 1; // register B01: rebind mints a sink-ownership epoch
      },
      sendServerMsg: () => {},
    });
    const resumed = await resumeOrchestratorSession({
      sessionId: SESSION_ID,
      onEvent: vi.fn(),
      onEnded: vi.fn(),
    });
    expect(resumed).toBe(originalHandle);
    expect(bound).toBe(true);
  });

  test('null for a live session of a different mode', async () => {
    registerLiveSession({
      sessionId: SESSION_ID,
      mode: 'chain',
      handle: {
        sessionId: SESSION_ID,
        iterationId: 'iter-1',
        participantAgentNames: WORKERS,
        lifecycle: 'persistent',
        sessionFolder: tmpRoot,
        stop: vi.fn(),
        retry: vi.fn(),
        detach: vi.fn(),
        continueThroughMutation: vi.fn(),
      },
      rebind: vi.fn(),
      sendServerMsg: () => {},
    });
    expect(
      await resumeOrchestratorSession({
        sessionId: SESSION_ID,
        onEvent: vi.fn(),
        onEnded: vi.fn(),
      }),
    ).toBeNull();
  });
});

describe('wireOrchestratorSession — project CLAUDE.md injection', () => {
  // Capture {cwd, prompt} so we can attribute each faked turn to its agent.
  function fakeFactory(captured: Array<{ cwd: string; prompt: string }>) {
    return (opts: { cwd: string; prompt: string }): Runner => {
      captured.push({ cwd: opts.cwd, prompt: opts.prompt });
      async function* gen(): AsyncGenerator<SDKMessage> {
        yield { type: 'result', subtype: 'success', session_id: 's' } as unknown as SDKMessage;
      }
      const it = gen();
      return { [Symbol.asyncIterator]: () => it, close: () => {} };
    };
  }

  function worker(name: string, claudeMd: string | null): ResolvedAgent {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    if (claudeMd !== null) fs.writeFileSync(path.join(dir, 'CLAUDE.md'), claudeMd);
    const proj = upsertProject(name, dir);
    return { projectId: proj.id, agentName: name, cwd: dir, projectName: name };
  }

  function wire(
    workers: ResolvedAgent[],
    captured: Array<{ cwd: string; prompt: string }>,
    briefedAgents?: string[],
    executeMode?: boolean,
    budget?: { hopBudget: number; initialHopsCount?: number; onEnded?: () => void },
  ) {
    const workspace = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const paths = computeSessionPaths(SESSION_ID);
    return wireOrchestratorSession({
      sessionId: SESSION_ID,
      iterationId: 'iter-1',
      lifecycle: 'persistent',
      paths,
      workers,
      onEvent: vi.fn(),
      onEnded: budget?.onEnded ?? vi.fn(),
      briefedAgents,
      executeMode,
      runnerFactory: fakeFactory(captured),
      ...(budget ? { hopBudget: budget.hopBudget } : {}),
      ...(budget?.initialHopsCount !== undefined
        ? { initialHopsCount: budget.initialHopsCount }
        : {}),
    });
  }

  const flush = () => new Promise((r) => setImmediate(r));
  const markers = (agent: string) =>
    listMultiAgentEvents(SESSION_ID).filter(
      (e) =>
        e.source === CEBAB_SOURCE &&
        e.destination === agent &&
        e.text.includes(`Cebab injected ${agent}/CLAUDE.md`),
    );

  test('worker first turn gets fenced rules + a compact marker; orchestrator never does', async () => {
    const captured: Array<{ cwd: string; prompt: string }> = [];
    const coder = worker('coder', '# Coder\n\n- Always cite sources\n- Do not invent APIs');
    const { deliver } = wire([coder, worker('reviewer', null)], captured);

    deliver('coder', 'review this');
    deliver(ORCHESTRATOR_AGENT_NAME, 'orchestrate');
    await flush();

    const coderTurn = captured.find((c) => c.cwd === coder.cwd)!;
    expect(coderTurn.prompt).toContain('<project_claude_md>');
    expect(coderTurn.prompt).toContain('- Always cite sources');
    expect(coderTurn.prompt).toContain('AUTHORITATIVE project rules');
    // bus protocol → rules → task ordering.
    expect(coderTurn.prompt.indexOf('bus_send')).toBeLessThan(
      coderTurn.prompt.indexOf('<project_claude_md>'),
    );
    expect(coderTurn.prompt.indexOf('<project_claude_md>')).toBeLessThan(
      coderTurn.prompt.indexOf('review this'),
    );
    // Orchestrator gets the raw text only (never briefed, never rules).
    const orchTurn = captured.find((c) => c.prompt === 'orchestrate');
    expect(orchTurn).toBeDefined();

    expect(markers('coder')).toHaveLength(1);
    expect(markers('coder')[0]!.text).toMatch(
      /Cebab injected coder\/CLAUDE\.md \(\d+\.\d KB\) into coder/,
    );
    // The rule body is never echoed into scrollback.
    expect(
      listMultiAgentEvents(SESSION_ID).some((e) => e.text.includes('Do not invent APIs')),
    ).toBe(false);

    unregisterLiveSession(SESSION_ID);
  });

  test('second turn to the same worker does not re-inject and adds no second marker', async () => {
    const captured: Array<{ cwd: string; prompt: string }> = [];
    const coder = worker('coder', '# Coder rules');
    const { deliver } = wire([coder], captured);

    deliver('coder', 'turn one');
    await flush();
    deliver('coder', 'turn two');
    await flush();

    const turns = captured.filter((c) => c.cwd === coder.cwd);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.prompt).toContain('<project_claude_md>');
    expect(turns[1]!.prompt).not.toContain('<project_claude_md>');
    expect(turns[1]!.prompt).toBe('turn two');
    expect(markers('coder')).toHaveLength(1);

    unregisterLiveSession(SESSION_ID);
  });

  test("executeMode=true briefs the worker's first turn with the own-folder execute clause", async () => {
    const captured: Array<{ cwd: string; prompt: string }> = [];
    const coder = worker('coder', null);
    const { deliver } = wire([coder], captured, undefined, true);

    deliver('coder', 'implement the fix');
    await flush();

    const coderTurn = captured.find((c) => c.cwd === coder.cwd)!;
    expect(coderTurn.prompt).toContain('Execute mode');
    expect(coderTurn.prompt).toMatch(/within your own project folder/i);
    expect(coderTurn.prompt).not.toContain('Consultant mode');

    unregisterLiveSession(SESSION_ID);
  });

  test('default (no executeMode) briefs the worker in consultant mode', async () => {
    const captured: Array<{ cwd: string; prompt: string }> = [];
    const coder = worker('coder', null);
    const { deliver } = wire([coder], captured);

    deliver('coder', 'look at the fix');
    await flush();

    const coderTurn = captured.find((c) => c.cwd === coder.cwd)!;
    expect(coderTurn.prompt).toContain('Consultant mode');
    expect(coderTurn.prompt).not.toContain('Execute mode');

    unregisterLiveSession(SESSION_ID);
  });

  test('R-B: a worker pre-marked briefed (it spoke before the restart) is not re-injected', async () => {
    const captured: Array<{ cwd: string; prompt: string }> = [];
    const coder = worker('coder', '# Coder rules');
    const reviewer = worker('reviewer', '# Reviewer rules');
    // coder already spoke before the restart → in briefedAgents.
    const { deliver } = wire([coder, reviewer], captured, ['coder']);

    deliver('coder', 'resumed turn');
    deliver('reviewer', 'first turn');
    await flush();

    const coderTurn = captured.find((c) => c.cwd === coder.cwd)!;
    const reviewerTurn = captured.find((c) => c.cwd === reviewer.cwd)!;
    // coder: its resumed transcript already carries the rules → not re-sent.
    expect(coderTurn.prompt).toBe('resumed turn');
    expect(markers('coder')).toHaveLength(0);
    // reviewer: never spoke pre-restart → injected fresh on its first turn.
    expect(reviewerTurn.prompt).toContain('<project_claude_md>');
    expect(markers('reviewer')).toHaveLength(1);

    unregisterLiveSession(SESSION_ID);
  });

  test('addWorker: a mid-session participant gets its CLAUDE.md on its first turn', async () => {
    const captured: Array<{ cwd: string; prompt: string }> = [];
    const { handle, deliver } = wire([worker('coder', null)], captured);

    const dir = path.join(tmpRoot, 'newbie');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Newbie\n\n- Follow the house style');
    const proj = upsertProject('newbie', dir);
    setProjectBusInstalled(proj.id, true, 'newbie');

    await handle.addWorker(proj.id);
    deliver('newbie', 'your task');
    await flush();

    const newbieTurn = captured.find((c) => c.cwd === dir)!;
    expect(newbieTurn.prompt).toContain('<project_claude_md>');
    expect(newbieTurn.prompt).toContain('- Follow the house style');
    expect(markers('newbie')).toHaveLength(1);

    unregisterLiveSession(SESSION_ID);
  });

  // Register B14: `addWorker` was a hand-rolled copy of `sendUserPrompt` —
  // the same cebab→orchestrator prompt event followed by the same deliver —
  // minus its `ended` and hop-budget guards. Since `forwardCebabEvent` bumps
  // the counter, the roster update could be the very hop that reached the cap
  // and still wake the orchestrator, defeating the runaway brake.
  function addNewWorker(name: string) {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    const proj = upsertProject(name, dir);
    setProjectBusInstalled(proj.id, true, name);
    return proj.id;
  }

  test('addWorker at the hop cap refuses to wake the orchestrator', async () => {
    const captured: Array<{ cwd: string; prompt: string }> = [];
    const onEnded = vi.fn();
    // Seeded one hop below the cap: the roster event addWorker persists is
    // the hop that reaches it.
    const { handle } = wire([worker('coder', null)], captured, undefined, undefined, {
      hopBudget: 3,
      initialHopsCount: 2,
      onEnded,
    });

    await handle.addWorker(addNewWorker('newbie'));
    await flush();

    // Nothing was woken: no orchestrator turn ran.
    expect(captured.some((c) => c.prompt.includes('newbie'))).toBe(false);
    // …and the operator is told why, in the trail and on the wire.
    const persisted = listMultiAgentEvents(SESSION_ID);
    expect(persisted.at(-1)).toMatchObject({ source: CEBAB_SOURCE, kind: 'error' });
    expect(persisted.at(-1)!.text).toContain('Hop budget exhausted (3/3)');
    expect(onEnded).toHaveBeenCalledWith(SESSION_ID, 'stopped', 'iter-1');

    unregisterLiveSession(SESSION_ID);
  });

  test('CONTROL: below the cap, addWorker still wakes the orchestrator with the roster', async () => {
    const captured: Array<{ cwd: string; prompt: string }> = [];
    const onEnded = vi.fn();
    const { handle } = wire([worker('coder', null)], captured, undefined, undefined, {
      hopBudget: 50,
      onEnded,
    });

    await handle.addWorker(addNewWorker('newbie2'));
    await flush();

    const orchTurn = captured.find((c) => c.prompt.includes('newbie2'));
    expect(orchTurn).toBeDefined();
    expect(onEnded).not.toHaveBeenCalled();

    unregisterLiveSession(SESSION_ID);
  });

  test('the worker is registered either way — the refusal is about waking, not joining', async () => {
    const captured: Array<{ cwd: string; prompt: string }> = [];
    const { handle } = wire([worker('coder', null)], captured, undefined, undefined, {
      hopBudget: 3,
      initialHopsCount: 2,
    });

    const projectId = addNewWorker('newbie3');
    const result = await handle.addWorker(projectId);

    // The participant row and the roster event are durable before the check,
    // so returning early leaves consistent state rather than a half-join.
    // (`handle.participantAgentNames` is a start-time snapshot that does not
    // grow on addWorker — the DB is the roster of record.)
    expect(result.agentName).toBe('newbie3');
    expect(listParticipants(SESSION_ID).map((p) => p.project_id)).toContain(projectId);

    unregisterLiveSession(SESSION_ID);
  });
});

describe('wireOrchestratorSession — agent_activity liveness wiring', () => {
  // Yields one assistant-with-tool message then a result, so a delivered
  // turn produces a `working` tick (from onMessage) and an `idle` tick
  // (from deliver's .finally → activity.onTurnEnd).
  function activityFactory() {
    return (): Runner => {
      async function* gen(): AsyncGenerator<SDKMessage> {
        yield {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'go' },
              { type: 'tool_use', name: 'Bash' },
            ],
          },
        } as unknown as SDKMessage;
        yield { type: 'result', subtype: 'success', session_id: 's' } as unknown as SDKMessage;
      }
      const it = gen();
      return { [Symbol.asyncIterator]: () => it, close: () => {} };
    };
  }
  const flush = () => new Promise((r) => setImmediate(r));

  test('onActivity fires working then idle for a delivered worker turn', async () => {
    const dir = path.join(tmpRoot, 'coder');
    fs.mkdirSync(dir, { recursive: true });
    const proj = upsertProject('coder', dir);
    const coder: ResolvedAgent = {
      projectId: proj.id,
      agentName: 'coder',
      cwd: dir,
      projectName: 'coder',
    };
    const workspace = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const paths = computeSessionPaths(SESSION_ID);
    const onActivity = vi.fn();

    const { deliver } = wireOrchestratorSession({
      sessionId: SESSION_ID,
      iterationId: 'iter-1',
      lifecycle: 'persistent',
      paths,
      workers: [coder],
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      onActivity,
      runnerFactory: activityFactory(),
    });

    deliver('coder', 'do the thing');
    await flush();
    await flush();

    // Parity with the onEvent convention: sessionId is the first arg.
    const phases = onActivity.mock.calls.map(
      (c) => [c[0], (c[1] as { agentName: string; phase: string }).phase] as const,
    );
    expect(phases.every(([sid]) => sid === SESSION_ID)).toBe(true);
    const seq = phases.map(([, p]) => p);
    expect(seq[0]).toBe('working');
    expect(seq.at(-1)).toBe('idle');
    const working = onActivity.mock.calls
      .map((c) => c[1] as { agentName: string; phase: string; currentTool?: string })
      .find((s) => s.phase === 'working');
    expect(working).toMatchObject({ agentName: 'coder', currentTool: 'Bash' });

    unregisterLiveSession(SESSION_ID);
  });

  test('F7: a delivered worker turn bills the hop to the agent and the session', async () => {
    const dir = path.join(tmpRoot, 'coder-cost');
    fs.mkdirSync(dir, { recursive: true });
    const proj = upsertProject('coder-cost', dir);
    const coder: ResolvedAgent = {
      projectId: proj.id,
      agentName: 'coder-cost',
      cwd: dir,
      projectName: 'coder-cost',
    };
    const workspace = path.join(tmpRoot, 'workspace-cost');
    fs.mkdirSync(workspace, { recursive: true });
    const paths = computeSessionPaths(SESSION_ID);

    function costFactory() {
      return (): Runner => {
        async function* gen(): AsyncGenerator<SDKMessage> {
          yield {
            type: 'result',
            subtype: 'success',
            session_id: 's-c',
            total_cost_usd: 0.0625,
          } as unknown as SDKMessage;
        }
        const it = gen();
        return { [Symbol.asyncIterator]: () => it, close: () => {} };
      };
    }

    const { deliver } = wireOrchestratorSession({
      sessionId: SESSION_ID,
      iterationId: 'iter-1',
      lifecycle: 'persistent',
      paths,
      workers: [coder],
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      runnerFactory: costFactory(),
    });

    deliver('coder-cost', 'do the thing');
    await flush();
    await flush();

    const row = listAgentSessions(SESSION_ID).find((r) => r.agent_name === 'coder-cost');
    expect(row?.cost_usd).toBeCloseTo(0.0625, 10);
    expect(getMultiAgentSession(SESSION_ID)!.total_cost_usd).toBeCloseTo(0.0625, 10);

    unregisterLiveSession(SESSION_ID);
  });
});

describe('wireOrchestratorSession — delegation-only guardrail', () => {
  type Gate = (
    n: string,
    i: unknown,
    o: unknown,
  ) => Promise<{ behavior: 'allow' | 'deny'; message?: string }>;

  const flush = () => new Promise((r) => setImmediate(r));

  function worker(name: string): ResolvedAgent {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    const proj = upsertProject(name, dir);
    return { projectId: proj.id, agentName: name, cwd: dir, projectName: name };
  }

  function guardrailRows() {
    return getDb()
      .prepare(
        `SELECT kind, reason_code, agent_id, session_id FROM safety_audit
         WHERE kind = 'guardrail.orchestrator_tool_block' ORDER BY ts ASC, id ASC`,
      )
      .all() as Array<{
      kind: string;
      reason_code: string;
      agent_id: string | null;
      session_id: string;
    }>;
  }

  test('[security] a blocked orchestrator tool attempt denies + audits + notifies', async () => {
    const workspace = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const paths = computeSessionPaths(SESSION_ID);

    const captured: Array<{ cwd: string; canUseTool?: Gate }> = [];
    const notifications: NotificationEnvelope[] = [];

    const { deliver } = wireOrchestratorSession({
      sessionId: SESSION_ID,
      iterationId: 'iter-1',
      lifecycle: 'persistent',
      paths,
      workers: [worker('coder')],
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      sendNotification: (env) => notifications.push(env),
      runnerFactory: (opts: RunOptions) => {
        captured.push({ cwd: opts.cwd, canUseTool: opts.canUseTool as unknown as Gate });
        async function* gen(): AsyncGenerator<SDKMessage> {
          yield { type: 'result', subtype: 'success', session_id: 's' } as unknown as SDKMessage;
        }
        const it = gen();
        return { [Symbol.asyncIterator]: () => it, close: () => {} };
      },
    });

    deliver(ORCHESTRATOR_AGENT_NAME, 'do the work yourself');
    await flush();

    // The orchestrator turn ran under the interactive posture, so it has a
    // canUseTool gate — and its cwd is the empty Cebab orchestrator workspace.
    const orchTurn = captured.find((c) => c.cwd === paths.orchestratorWorkspace);
    expect(orchTurn?.canUseTool).toBeTypeOf('function');

    // Simulate the model reaching for a file tool instead of delegating.
    const res = await orchTurn!.canUseTool!(
      'Edit',
      {},
      {
        toolUseID: 'e1',
        signal: new AbortController().signal,
      },
    );
    expect(res.behavior).toBe('deny');
    expect(res.message).toContain('bus_send');

    // BE-1: the hash-chained audit row is written (before the WS notification),
    // and the chain still verifies after the append.
    const rows = guardrailRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'guardrail.orchestrator_tool_block',
      reason_code: 'orchestrator_non_delegation',
      agent_id: ORCHESTRATOR_AGENT_NAME,
      session_id: SESSION_ID,
    });
    expect(verifyChain()).toMatchObject({ ok: true });

    // The operator gets a safety notification for the blocked attempt.
    expect(
      notifications.some(
        (n) => n.class === 'safety' && n.reasonCode === 'orchestrator_non_delegation',
      ),
    ).toBe(true);

    unregisterLiveSession(SESSION_ID);
  });
});

describe('wireOrchestratorSession — per-project model (Cebab-ws0.3)', () => {
  // The orchestrator mirror of the chain wiring test. Same reason for
  // existing: `projectModelSpec` is unit-tested and `bus/runner.ts` is
  // asserted against a captured factory, but neither proves this file's
  // `runner.register` actually passes the spec through. Deleting that spread
  // leaves every other test green.
  //
  // The orchestrator's OWN spec is asserted here too, and it is the more
  // interesting half: it has no project, so it must carry no model. A wiring
  // that reached for "the session's model" rather than "this agent's project's
  // model" would put a worker's choice on the router.
  function captureModels(captured: Array<{ cwd: string; model?: string }>) {
    return (opts: { cwd: string; model?: string }): Runner => {
      captured.push(opts);
      async function* gen(): AsyncGenerator<SDKMessage> {
        yield { type: 'result', subtype: 'success', session_id: 's' } as unknown as SDKMessage;
      }
      const it = gen();
      return { [Symbol.asyncIterator]: () => it, close: () => {} };
    };
  }

  function workerWithModel(name: string, model: string | null): ResolvedAgent {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    const proj = upsertProject(name, dir);
    if (model !== null) setProjectModel(proj.id, model);
    return { projectId: proj.id, agentName: name, cwd: dir, projectName: name };
  }

  async function wireAndDeliver(model: string | null) {
    const workspace = path.join(tmpRoot, `ws-orch-${model ?? 'none'}`);
    fs.mkdirSync(workspace, { recursive: true });
    const captured: Array<{ cwd: string; model?: string }> = [];
    const worker = workerWithModel(`w-${model ?? 'none'}`, model);
    const { deliver } = wireOrchestratorSession({
      sessionId: SESSION_ID,
      iterationId: 'iter-model',
      lifecycle: 'persistent',
      paths: computeSessionPaths(SESSION_ID),
      workers: [worker],
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      runnerFactory: captureModels(captured),
    });
    deliver(worker.agentName, 'go');
    await new Promise((r) => setImmediate(r));
    return { captured, worker };
  }

  test("a worker's project model reaches its spawn options", async () => {
    const { captured, worker } = await wireAndDeliver('haiku');
    const workerCall = captured.find((c) => c.cwd === worker.cwd);
    expect(workerCall?.model).toBe('haiku');
  });

  test('a worker whose project has no model spawns with NO model key', async () => {
    const { captured, worker } = await wireAndDeliver(null);
    const workerCall = captured.find((c) => c.cwd === worker.cwd);
    expect(workerCall).toBeDefined();
    expect('model' in workerCall!).toBe(false);
  });
});

/**
 * `Cebab-vie.13` [security]: the pause-on-dangerous gate holds the agent's turn
 * QUEUE, not just the turn it halted.
 *
 * The halt is a `PausedForMutationError` thrown out of the mutation tap, which
 * kills the running turn and nothing else. The turn queue was untouched, so the
 * next delivery to that worker — a peer's `bus_send`, an orchestrator
 * follow-up, a retry — started a fresh turn, and `decidePauseForMutation`
 * waves an already-held agent through (`hasPendingPause` → `run`). Its next
 * dangerous command therefore ran with no approval, for as long as the
 * operator left the banner un-actioned.
 *
 * Driven through `wireOrchestratorSession` rather than through `applyPauseGate`
 * directly, because the defect is in the WIRING: the gate has to be handed the
 * runner's hold, and `continueThroughMutation` has to give it back.
 */
describe('wireOrchestratorSession — a held worker stays held (Cebab-vie.13) [security]', () => {
  /** Turn 1 for `dangerousAgent` emits an `rm -rf` tool_use; every other turn
   *  is an ordinary empty turn. Records one entry per turn actually STARTED —
   *  which is the whole measurement: a parked delivery never gets here. */
  function fakeFactory(
    captured: Array<{ cwd: string; prompt: string }>,
    dangerousCwd: string,
  ): (opts: { cwd: string; prompt: string }) => Runner {
    let dangerousTurns = 0;
    return (opts) => {
      captured.push({ cwd: opts.cwd, prompt: opts.prompt });
      const emitDanger = opts.cwd === dangerousCwd && dangerousTurns++ === 0;
      async function* gen(): AsyncGenerator<SDKMessage> {
        if (emitDanger) {
          yield {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'tu-danger-1',
                  name: 'Bash',
                  input: { command: 'rm -rf /tmp/x' },
                },
              ],
            },
          } as unknown as SDKMessage;
        }
        yield { type: 'result', subtype: 'success', session_id: 's' } as unknown as SDKMessage;
      }
      const it = gen();
      return { [Symbol.asyncIterator]: () => it, close: () => {} };
    };
  }

  function worker(name: string): ResolvedAgent {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    const proj = upsertProject(name, dir);
    return { projectId: proj.id, agentName: name, cwd: dir, projectName: name };
  }

  function wire(workers: ResolvedAgent[], captured: Array<{ cwd: string; prompt: string }>) {
    const workspace = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    return wireOrchestratorSession({
      sessionId: SESSION_ID,
      iterationId: 'iter-1',
      lifecycle: 'persistent',
      paths: computeSessionPaths(SESSION_ID),
      workers,
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      // Every worker has already spoken, so no briefing is prepended and the
      // captured prompts are the raw bytes each assertion below names.
      briefedAgents: workers.map((w) => w.agentName),
      runnerFactory: fakeFactory(captured, workers[0]!.cwd),
    });
  }

  /** Turns start on a promise chain, so "did anything start" needs the
   *  macrotask queue drained, not just one microtask flush. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 5));
  };

  test('a delivery arriving while a worker is held does not start a turn until Continue', async () => {
    setPauseOnDangerous(SESSION_ID, true);
    const captured: Array<{ cwd: string; prompt: string }> = [];
    const coder = worker('coder');
    const { handle, deliver } = wire([coder, worker('reviewer')], captured);

    // Turn 1 issues `rm -rf` → the gate halts it and holds the queue.
    deliver('coder', 'first task');
    await settle();
    const held = listPendingMutations(SESSION_ID);
    expect(held.map((m) => m.summary)).toEqual(['rm -rf /tmp/x']);
    expect(captured).toHaveLength(1);

    // A peer's reply lands for the same worker while the banner is up. THIS is
    // the bug: before the fix it started a turn immediately.
    deliver('coder', 'peer reply while held');
    await settle();
    expect(captured).toHaveLength(1);

    // Another worker is unaffected — the hold is per-agent, not a session stop.
    deliver('reviewer', 'unrelated work');
    await settle();
    expect(captured.map((c) => c.prompt)).toEqual(['first task', 'unrelated work']);

    // Operator clicks Continue → the queued delivery runs, and the replay
    // follows it (queued first, so delivered first).
    //
    // NOTE the fourth entry, and read it as a defect rather than a contract:
    // `continueThroughMutation` replays `lastPrompt`, which `deliver` rewrites
    // on every call, so the prompt whose turn was actually halted ("first
    // task") has been overwritten by the queued one. The command the operator
    // approved is therefore not necessarily re-issued. That is pre-existing
    // and independent of the hold — the same overwrite happened when the
    // queued delivery ran immediately — so it is filed separately
    // (`Cebab-vie.28`) rather than fixed here, and asserted as it is so the fix
    // has something to change.
    await handle.continueThroughMutation(held[0]!.id);
    await settle();
    expect(captured.map((c) => c.prompt)).toEqual([
      'first task',
      'unrelated work',
      'peer reply while held',
      'peer reply while held',
    ]);

    unregisterLiveSession(SESSION_ID);
  });

  test('CONTROL: with the gate disarmed, the same delivery runs straight away', async () => {
    setPauseOnDangerous(SESSION_ID, false);
    const captured: Array<{ cwd: string; prompt: string }> = [];
    const { deliver } = wire([worker('coder')], captured);

    deliver('coder', 'first task');
    await settle();
    deliver('coder', 'second task');
    await settle();

    // The `rm -rf` is still recorded — it is un-gated, not unlogged.
    expect(listMultiAgentMutations(SESSION_ID).map((m) => m.summary)).toEqual(['rm -rf /tmp/x']);
    expect(listPendingMutations(SESSION_ID)).toEqual([]);
    expect(captured.map((c) => c.prompt)).toEqual(['first task', 'second task']);

    unregisterLiveSession(SESSION_ID);
  });

  test('R-B: wiring a session that is already holding a mutation reinstalls the hold', async () => {
    // Exactly the state a restart leaves behind: the `pending` row is in
    // SQLite, the in-memory gate died with the old process. Register B04 does
    // this for the operator pause; without the same reseed here the operator
    // comes back to a worker shown as held whose next delegation is delivered.
    setPauseOnDangerous(SESSION_ID, true);
    const coder = worker('coder');
    const row = appendMultiAgentMutation(SESSION_ID, 'coder', 'Bash', 'dangerous', 'rm -rf /srv', {
      filePath: null,
      cwd: coder.cwd,
      toolUseId: null,
    });
    setMutationPauseState(row.id, 'pending');

    const captured: Array<{ cwd: string; prompt: string }> = [];
    const { handle, deliver } = wire([coder], captured);

    deliver('coder', 'delegation after the restart');
    await settle();
    expect(captured).toHaveLength(0);

    // Continue releases the reseeded hold and the delegation runs. It runs
    // twice for the `Cebab-vie.28` reason above — the queued delivery, then the
    // replay of the same captured prompt.
    await handle.continueThroughMutation(row.id);
    await settle();
    expect(captured.map((c) => c.prompt)).toEqual([
      'delegation after the restart',
      'delegation after the restart',
    ]);

    unregisterLiveSession(SESSION_ID);
  });
});

/**
 * `Cebab-vie.9` / `Cebab-vie.10` / `Cebab-vie.18` [security]: the two operator
 * replay seams start turns, and asked nothing before doing it.
 *
 * Every other turn in the bus begins as a `BusEvent` and is therefore already
 * downstream of the router's kick drops, its `ended` flag and its hop budget.
 * `retry()` and `continueThroughMutation()` do not begin as events, so that
 * enforcement was structurally absent: a kicked worker was resurrected with a
 * full tool-capable turn, and Continue's replay carried the one-shot approval
 * grant, i.e. re-issued the approved `rm -rf` PRE-APPROVED — while its
 * `bus_send` output was dropped as `kicked_source`, so the operator saw drop
 * notices and nothing about what the worker actually did.
 *
 * The measurement is the fake runner's captured list: it records one entry per
 * turn actually STARTED, so "nothing ran" is an empty array rather than an
 * inference.
 */
describe('wireOrchestratorSession — the replay seams refuse what the router would (Cebab-vie.9/.10/.18) [security]', () => {
  function fakeFactory(
    captured: Array<{ cwd: string; prompt: string }>,
    dangerousCwd?: string,
  ): (opts: { cwd: string; prompt: string }) => Runner {
    let dangerousTurns = 0;
    return (opts) => {
      captured.push({ cwd: opts.cwd, prompt: opts.prompt });
      const emitDanger = opts.cwd === dangerousCwd && dangerousTurns++ === 0;
      async function* gen(): AsyncGenerator<SDKMessage> {
        if (emitDanger) {
          yield {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'tu-danger-2',
                  name: 'Bash',
                  input: { command: 'rm -rf /tmp/x' },
                },
              ],
            },
          } as unknown as SDKMessage;
        }
        yield { type: 'result', subtype: 'success', session_id: 's' } as unknown as SDKMessage;
      }
      const it = gen();
      return { [Symbol.asyncIterator]: () => it, close: () => {} };
    };
  }

  function worker(name: string): ResolvedAgent {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    const proj = upsertProject(name, dir);
    return { projectId: proj.id, agentName: name, cwd: dir, projectName: name };
  }

  function wire(
    workers: ResolvedAgent[],
    captured: Array<{ cwd: string; prompt: string }>,
    opts: { dangerous?: boolean; hopBudget?: number } = {},
  ) {
    const workspace = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    return wireOrchestratorSession({
      sessionId: SESSION_ID,
      iterationId: 'iter-1',
      lifecycle: 'persistent',
      paths: computeSessionPaths(SESSION_ID),
      workers,
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      briefedAgents: workers.map((w) => w.agentName),
      runnerFactory: fakeFactory(captured, opts.dangerous ? workers[0]!.cwd : undefined),
      ...(opts.hopBudget !== undefined ? { hopBudget: opts.hopBudget } : {}),
    });
  }

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 5));
  };

  const errors = (): string[] =>
    listMultiAgentEvents(SESSION_ID)
      .filter((e) => e.kind === 'error' && e.source === CEBAB_SOURCE)
      .map((e) => e.text);

  test('Retry does not resurrect a kicked worker, and its banner goes with it', async () => {
    const captured: Array<{ cwd: string; prompt: string }> = [];
    const { handle, router } = wire([worker('coder')], captured);
    setPendingRetry(SESSION_ID, {
      agentName: 'coder',
      prompt: 'the failed task',
      reason: 'boom',
      ts: Date.now(),
      errorEventId: 0,
    });

    router.kickAgent('coder');
    await handle.retry();
    await settle();

    expect(captured).toEqual([]);
    // Kick is irreversible, so a banner offering a Retry that can never happen
    // must not outlive it.
    expect(getPendingRetry(SESSION_ID)).toBeNull();
    expect(errors().some((t) => t.includes('`coder` was removed from this session'))).toBe(true);

    unregisterLiveSession(SESSION_ID);
  });

  test('CONTROL: Retry still replays for a live worker', async () => {
    const captured: Array<{ cwd: string; prompt: string }> = [];
    const { handle } = wire([worker('coder')], captured);
    setPendingRetry(SESSION_ID, {
      agentName: 'coder',
      prompt: 'the failed task',
      reason: 'boom',
      ts: Date.now(),
      errorEventId: 0,
    });

    await handle.retry();
    await settle();

    expect(captured.map((c) => c.prompt)).toEqual(['the failed task']);
    expect(getPendingRetry(SESSION_ID)).toBeNull();

    unregisterLiveSession(SESSION_ID);
  });

  test('Continue does not resurrect a kicked worker, and leaves NO approval grant', async () => {
    setPauseOnDangerous(SESSION_ID, true);
    const captured: Array<{ cwd: string; prompt: string }> = [];
    const coder = worker('coder');
    const { handle, router, deliver } = wire([coder], captured, { dangerous: true });

    deliver('coder', 'first task');
    await settle();
    const held = listPendingMutations(SESSION_ID);
    expect(held).toHaveLength(1);
    expect(captured).toHaveLength(1);

    // The operator kicks the held worker, then clicks Continue on its banner.
    router.kickAgent('coder');
    await handle.continueThroughMutation(held[0]!.id);
    await settle();

    // No second turn: the `rm -rf` never runs.
    expect(captured).toHaveLength(1);
    // The banner resolves rather than lingering — kick is irreversible, so a
    // Continue that stays clickable would refuse forever.
    expect(listPendingMutations(SESSION_ID)).toEqual([]);
    // And no unspent grant is left behind. This is the sharp half of vie.10:
    // an `approved` row here would pre-authorise `rm -rf /tmp/x` for any later
    // turn by this agent, including one a reconstructed run starts.
    expect(findUnconsumedApproval(SESSION_ID, 'coder', 'Bash', 'rm -rf /tmp/x')).toBeNull();

    unregisterLiveSession(SESSION_ID);
  });

  test('CONTROL: Continue still replays for a live worker', async () => {
    setPauseOnDangerous(SESSION_ID, true);
    const captured: Array<{ cwd: string; prompt: string }> = [];
    const { handle, deliver } = wire([worker('coder')], captured, { dangerous: true });

    deliver('coder', 'first task');
    await settle();
    const held = listPendingMutations(SESSION_ID);
    await handle.continueThroughMutation(held[0]!.id);
    await settle();

    expect(captured.map((c) => c.prompt)).toEqual(['first task', 'first task']);
    expect(listPendingMutations(SESSION_ID)).toEqual([]);

    unregisterLiveSession(SESSION_ID);
  });

  test('Retry past the hop cap starts no turn and stops the session', async () => {
    const captured: Array<{ cwd: string; prompt: string }> = [];
    const { handle, router } = wire([worker('coder')], captured, { hopBudget: 1 });
    setPendingRetry(SESSION_ID, {
      agentName: 'coder',
      prompt: 'the failed task',
      reason: 'boom',
      ts: Date.now(),
      errorEventId: 0,
    });
    // `orchestrator → user` bumps the hop counter and returns before the
    // budget check, so the session sits AT the cap and still `running` — the
    // window a Retry click lands in with no resume dance required.
    router.handleEvent({
      ts: Date.now(),
      source: ORCHESTRATOR_AGENT_NAME,
      destination: USER_RECIPIENT,
      kind: 'reply',
      text: 'answering the operator',
    });

    await handle.retry();
    await settle();

    expect(captured).toEqual([]);
    expect(errors().some((t) => t.includes('Hop budget exhausted'))).toBe(true);

    unregisterLiveSession(SESSION_ID);
  });

  test('once the budget stop has landed, a second Retry is refused as `ended`', async () => {
    // The `ended` branch needs a torn-down session that still has something to
    // replay, and `handle.stop` is not it — stop clears the pending-retry slot,
    // clears pending mutations AND calls `runner.stop()`, so both seams no-op
    // on their own. The BUDGET teardown does none of that (`Cebab-vie.18`: the
    // row survives and the agents stay registered), which is exactly why a
    // click landing after it used to run a full turn.
    const captured: Array<{ cwd: string; prompt: string }> = [];
    const { handle, router } = wire([worker('coder')], captured, { hopBudget: 1 });
    setPendingRetry(SESSION_ID, {
      agentName: 'coder',
      prompt: 'the failed task',
      reason: 'boom',
      ts: Date.now(),
      errorEventId: 0,
    });
    router.handleEvent({
      ts: Date.now(),
      source: ORCHESTRATOR_AGENT_NAME,
      destination: USER_RECIPIENT,
      kind: 'reply',
      text: 'answering the operator',
    });

    await handle.retry(); // refused: budget — and tears the session down
    // The slot deliberately survives a non-kick refusal: teardown owns it, and
    // an operator who resumes the session should still see what failed.
    expect(getPendingRetry(SESSION_ID)).not.toBeNull();

    await handle.retry(); // refused again, now for the reason that outlives it
    await settle();

    expect(captured).toEqual([]);
    expect(errors().some((t) => t.includes('This session has ended'))).toBe(true);

    unregisterLiveSession(SESSION_ID);
  });
});
