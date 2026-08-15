import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { createMultiAgentSession } from '../repo/multi_agent.js';
import { createChainRouter } from './chain.js';
import { createOrchestratorRouter } from './orchestrator.js';
import { computeSessionPaths } from './paths.js';
import type { BusEvent } from './runner.js';
import type { BusSink } from './session_registry.js';

// Register B01 [security]. `detach()` used to do `sink = NOOP_SINK`
// unconditionally. With two browser windows on one session that is a trap:
// window B re-attaches (rebind), then window A's WS close fires detach and
// blanks B's live event stream — including `multi_agent_ended` — while B's UI
// still shows an active run. The operator is left watching a session that
// looks alive and reports nothing, with no signal that it went silent.
//
// The fix is an ownership epoch: `rebind` mints one, `detach(epoch)` honours
// it. Both routers own a copy of the closure, so both are driven here through
// their real exported factories rather than a hand-copied stand-in that could
// silently drift from the source.

const SESSION_ID = 'test-detach-ownership';

let tmpRoot: string;
let originalDataDir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-detach-own-'));
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
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function paths() {
  const workspace = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const p = computeSessionPaths(SESSION_ID, workspace);
  fs.mkdirSync(p.iterationDir('iter-1'), { recursive: true });
  return p;
}

/** Minimal sink that records which window received an event. */
function windowSink(name: string, seen: string[]): BusSink {
  return {
    onEvent: () => seen.push(name),
    onEnded: () => seen.push(`${name}:ended`),
  };
}

const EVENT: BusEvent = {
  ts: 1700000000000,
  source: 'cebab',
  destination: 'coder',
  kind: 'prompt',
  text: 'x',
};

/**
 * Both routers under one contract. `forwardCebabEvent` is the shortest path
 * from "an event happened" to "the bound sink saw it" — no routing rules, no
 * allowlist filters, just persist-then-forward.
 */
const ROUTERS = [
  {
    mode: 'chain' as const,
    make: (seen: string[]) => {
      createMultiAgentSession(SESSION_ID, 'chain', 'iter-1');
      const r = createChainRouter({
        sessionId: SESSION_ID,
        iterationId: 'iter-1',
        agentNames: ['coder', 'reviewer'],
        paths: paths(),
        onEvent: () => seen.push('A'),
        onEnded: () => seen.push('A:ended'),
        hopBudget: 1000,
      });
      return { rebind: r.rebind, detach: r.detach, fire: () => r.forwardCebabEvent(EVENT) };
    },
  },
  {
    mode: 'orchestrator' as const,
    make: (seen: string[]) => {
      createMultiAgentSession(SESSION_ID, 'orchestrator', 'iter-1');
      const r = createOrchestratorRouter({
        sessionId: SESSION_ID,
        iterationId: 'iter-1',
        workerNames: ['coder'],
        paths: paths(),
        lifecycle: 'temp',
        onEvent: () => seen.push('A'),
        onEnded: () => seen.push('A:ended'),
        hopBudget: 1000,
      });
      return { rebind: r.rebind, detach: r.detach, fire: () => r.forwardCebabEvent(EVENT) };
    },
  },
];

describe.each(ROUTERS)('$mode router — sink ownership epoch [security]', ({ make }) => {
  test('a stale window closing does not silence the window that re-attached', () => {
    const seen: string[] = [];
    const r = make(seen);
    const epochA = 0; // the window that started the run owns epoch 0

    const epochB = r.rebind(windowSink('B', seen));
    expect(epochB).toBe(1);

    // Window A closes and detaches with the epoch IT owns.
    r.detach(epochA);

    // B is still bound. This is the whole bug: before the fix the sink was
    // NOOP_SINK here and B's stream was dead while its UI showed a live run.
    r.fire();
    expect(seen).toEqual(['B']);
  });

  test('the owning window still silences its own sink on close', () => {
    const seen: string[] = [];
    const r = make(seen);

    r.detach(0); // epoch 0 is still current — this window owns it

    r.fire();
    expect(seen).toEqual([]);
  });

  test('a re-attached window can silence its own sink', () => {
    const seen: string[] = [];
    const r = make(seen);
    const epochB = r.rebind(windowSink('B', seen));

    r.detach(epochB);

    r.fire();
    expect(seen).toEqual([]);
  });

  test('a bare detach() is unconditional — the deliberate switch-away path', () => {
    // `executeReopenSessionConfirmed` detaches the active session because the
    // operator is opening a different one. That must silence regardless of
    // who rebound last, so it passes no epoch.
    const seen: string[] = [];
    const r = make(seen);
    r.rebind(windowSink('B', seen));

    r.detach();

    r.fire();
    expect(seen).toEqual([]);
  });

  test('epochs keep advancing, and only the current owner can silence', () => {
    const seen: string[] = [];
    const r = make(seen);
    const e1 = r.rebind(windowSink('B', seen));
    const e2 = r.rebind(windowSink('C', seen));
    const e3 = r.rebind(windowSink('D', seen));
    expect([e1, e2, e3]).toEqual([1, 2, 3]);

    // Every earlier window closes, in arbitrary order.
    r.detach(0);
    r.detach(e2);
    r.detach(e1);
    r.fire();
    expect(seen).toEqual(['D']);

    // …and the current owner still can.
    r.detach(e3);
    r.fire();
    expect(seen).toEqual(['D']);
  });

  test('a duplicate detach is idempotent', () => {
    // A WS 'close' plus an explicit teardown is routine; it must not throw or
    // re-bind anything.
    const seen: string[] = [];
    const r = make(seen);
    r.detach(0);
    expect(() => r.detach(0)).not.toThrow();
    r.fire();
    expect(seen).toEqual([]);
  });
});
