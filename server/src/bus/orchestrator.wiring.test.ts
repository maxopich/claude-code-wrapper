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
} from './orchestrator.js';
import { computeSessionPaths } from './paths.js';
import { CEBAB_SOURCE, USER_RECIPIENT } from './runtime.js';
import { registerLiveSession, unregisterLiveSession } from './session_registry.js';
import { createMultiAgentSession, listMultiAgentEvents } from '../repo/multi_agent.js';
import type { BusEvent } from './runner.js';

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
  createMultiAgentSession(SESSION_ID, 'orchestrator', 'label-1', 'iter-1');
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
    tmuxSessionName: 'label-1',
    paths,
    lifecycle: 'persistent',
    onEvent,
    onEnded,
    deliver,
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
      tmuxSession: 'label-1',
      participantAgentNames: [ORCHESTRATOR_AGENT_NAME, ...WORKERS],
      lifecycle: 'persistent' as const,
      sessionFolder: tmpRoot,
      stop: vi.fn(),
      detach: vi.fn(),
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
        tmuxSession: 'label-1',
        participantAgentNames: WORKERS,
        lifecycle: 'persistent',
        sessionFolder: tmpRoot,
        stop: vi.fn(),
        detach: vi.fn(),
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
