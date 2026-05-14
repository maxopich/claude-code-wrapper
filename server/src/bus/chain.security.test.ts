import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { createChainRouter } from './chain.js';
import { computeSessionPaths } from './paths.js';
import { CEBAB_SOURCE, USER_RECIPIENT } from './runtime.js';
import { createMultiAgentSession, listMultiAgentEvents } from '../repo/multi_agent.js';
import type { BusLogEvent } from './log_tailer.js';

// F2 / F3 regression coverage for chain-mode handleEvent drops at
// chain.ts:237-260. The chain participant allowlist differs slightly
// from orchestrator's: chain mode legitimately allows worker→next-worker
// traffic (that's the pipeline), but dest=user is NEVER legitimate
// (chain terminates at _sink), and the source must be a known
// participant — so non-participant sources are dropped, mirroring the
// orchestrator's round-2 filter.

let tmpRoot: string;
let originalDataDir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

const SESSION_ID = 'test-chain-session';
const AGENTS = ['coder', 'reviewer'];

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-chain-security-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  createMultiAgentSession(SESSION_ID, 'chain', 'tmux-test', 'iter-1');
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeRouter() {
  const workspace = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const paths = computeSessionPaths(SESSION_ID, workspace);
  fs.mkdirSync(path.dirname(paths.busLog), { recursive: true });
  fs.writeFileSync(paths.busLog, '');
  const onEvent = vi.fn();
  const onEnded = vi.fn();
  const router = createChainRouter({
    sessionId: SESSION_ID,
    iterationId: 'iter-1',
    agentNames: AGENTS,
    tmuxSessionName: 'tmux-test',
    paths,
    onEvent,
    onEnded,
  });
  return { router, onEvent, onEnded };
}

function ev(partial: Partial<BusLogEvent>): BusLogEvent {
  return {
    ts: 1700000000000,
    source: 'coder',
    destination: 'reviewer',
    kind: 'prompt',
    text: 'x',
    ...partial,
  };
}

describe('[security][F3] chain drops forged source=cebab events', () => {
  test('disk-side source=cebab is dropped — Cebab routes via forwardCebabEvent in-process', () => {
    const { router, onEvent } = makeRouter();

    router.handleEvent(ev({ source: CEBAB_SOURCE, destination: 'reviewer' }));

    expect(onEvent).not.toHaveBeenCalled();
    expect(listMultiAgentEvents(SESSION_ID)).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('drop forged source=cebab'));
  });
});

describe('[security][F2] chain drops dest=user (chain terminates at _sink, never at user)', () => {
  test('any source with dest=user is dropped — chain has no user-bound traffic', () => {
    const { router, onEvent } = makeRouter();

    router.handleEvent(
      ev({ source: 'coder', destination: USER_RECIPIENT, kind: 'final', text: 'spoof' }),
    );

    expect(onEvent).not.toHaveBeenCalled();
    expect(listMultiAgentEvents(SESSION_ID)).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('drop dest=user from coder'));
  });
});

describe('[security][F2] chain drops events from non-participant sources', () => {
  test('source not in agentNames is dropped — closes the BUS_AGENT_NAME=<unknown> bypass', () => {
    const { router, onEvent } = makeRouter();

    router.handleEvent(
      ev({ source: 'ghost', destination: 'reviewer', kind: 'prompt', text: 'forged' }),
    );

    expect(onEvent).not.toHaveBeenCalled();
    expect(listMultiAgentEvents(SESSION_ID)).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('drop event from non-participant source=ghost'),
    );
  });
});
