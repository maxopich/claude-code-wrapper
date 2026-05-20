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
  createMultiAgentSession,
  listMultiAgentEvents,
  setProjectBusInstalled,
} from '../repo/multi_agent.js';
import { upsertProject } from '../repo/projects.js';
import type { BusEvent } from './runner.js';
import type { Runner } from '../runner/index.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

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
  const paths = computeSessionPaths(SESSION_ID, workspace);
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
    expect(deliver).toHaveBeenCalledWith('coder', 'go');
  });

  test('worker→orchestrator delivers a turn to the orchestrator', () => {
    const { router, deliver } = setup();
    router.handleEvent(
      ev({ source: 'coder', destination: ORCHESTRATOR_AGENT_NAME, kind: 'reply', text: 'done' }),
    );
    expect(deliver).toHaveBeenCalledWith(ORCHESTRATOR_AGENT_NAME, 'done');
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
      },
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
  ) {
    const workspace = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const paths = computeSessionPaths(SESSION_ID, workspace);
    return wireOrchestratorSession({
      sessionId: SESSION_ID,
      iterationId: 'iter-1',
      lifecycle: 'persistent',
      paths,
      workers,
      onEvent: vi.fn(),
      onEnded: vi.fn(),
      briefedAgents,
      runnerFactory: fakeFactory(captured),
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
    const paths = computeSessionPaths(SESSION_ID, workspace);
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
});
