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
});
