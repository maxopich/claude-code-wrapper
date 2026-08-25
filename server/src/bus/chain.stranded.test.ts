/**
 * `Cebab-vie.8`, chain mode.
 *
 * Chain has no mute verb, so the drop that strands it is a different one — a
 * participant addressing an agent that is not on the roster, or a non-terminal
 * participant reaching for `_sink`. The shape afterwards is identical to the
 * orchestrator's, including the false `X working` bar, which is why the
 * detector is shared rather than mute-specific.
 *
 * These drive `createChainRouter` standalone with an injected `deliver`, the
 * same way the router-drop coverage does; the real wiring's `onTurnStarted` /
 * `onTurnSettled` calls are exercised end to end by
 * `chain.security.test.ts`, which runs a whole `startChainSession`.
 */
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
import { _resetCoalesceState } from '../notifications/dispatcher.js';

const SESSION_ID = 'chain-stranded-session';
const AGENTS = ['coder', 'reviewer'];

let tmpRoot: string;
let originalDataDir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-chain-stranded-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  createMultiAgentSession(SESSION_ID, 'chain', 'iter-1');
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  _resetCoalesceState();
});

afterEach(() => {
  warnSpy.mockRestore();
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeRouter(opts: { anyGateHeld?: () => boolean } = {}) {
  const paths = computeSessionPaths(SESSION_ID);
  fs.mkdirSync(paths.iterationDir('iter-1'), { recursive: true });
  const deliver = vi.fn();
  const router = createChainRouter({
    sessionId: SESSION_ID,
    iterationId: 'iter-1',
    agentNames: AGENTS,
    paths,
    onEvent: vi.fn(),
    onEnded: vi.fn(),
    deliver,
    hopBudget: 1000,
    sendNotification: vi.fn(),
    ...(opts.anyGateHeld ? { isAnyGateHeld: opts.anyGateHeld } : {}),
  });
  return { router, deliver };
}

const strandedRows = () =>
  listMultiAgentEvents(SESSION_ID).filter(
    (e) =>
      e.source === CEBAB_SOURCE &&
      e.destination === USER_RECIPIENT &&
      e.text.includes('Nothing is running in this session'),
  );

describe('a chain hop that goes nowhere (Cebab-vie.8)', () => {
  test('a reply to an off-roster agent strands the run, and Cebab says so', () => {
    const { router } = makeRouter();
    // `coder` is woken by a persisted hop — this row is the tail the detector
    // and the activity bar both read.
    router.forwardCebabEvent({
      ts: Date.now(),
      source: CEBAB_SOURCE,
      destination: 'coder',
      kind: 'prompt',
      text: 'start the chain',
    });
    router.onTurnStarted();
    // `coder` hands off to a participant that is not on this chain's roster.
    // The event is persisted, then dropped at the routing branch — so nobody
    // is woken and the trail's last hop names an agent that will never reply.
    router.handleEvent({
      ts: Date.now(),
      source: 'coder',
      destination: 'ghost',
      kind: 'reply',
      text: 'over to you',
    });
    router.onTurnSettled('coder');

    const rows = strandedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toContain('unknown_destination');
    // The recovery sentence is the mode's own: a chain handle carries
    // `sendUserPrompt: null`, so there is no composer to point at.
    expect(rows[0]!.text).toContain('only way out');
    expect(rows[0]!.text).not.toContain('Send a prompt below');
  });

  test('a hop that WAS routed is not a stranded run', () => {
    // The positive control for the whole file: the same sequence with a real
    // roster member as the destination wakes the next participant, so nothing
    // is stranded and no row appears. Without this, every assertion above is
    // satisfied by a detector that reports any settle at all.
    const { router, deliver } = makeRouter();
    router.forwardCebabEvent({
      ts: Date.now(),
      source: CEBAB_SOURCE,
      destination: 'coder',
      kind: 'prompt',
      text: 'start the chain',
    });
    router.onTurnStarted();
    router.handleEvent({
      ts: Date.now(),
      source: 'coder',
      destination: 'reviewer',
      kind: 'reply',
      text: 'your turn',
    });
    // The real wiring's `deliver` starts the next turn; the stub does not, so
    // stand in for it exactly where the wiring would.
    expect(deliver).toHaveBeenCalledWith('reviewer', 'your turn', 'coder');
    router.onTurnStarted();
    router.onTurnSettled('coder');

    expect(strandedRows()).toHaveLength(0);
  });

  test('a held queue is not a stranded run', () => {
    let held = true;
    const { router } = makeRouter({ anyGateHeld: () => held });
    router.forwardCebabEvent({
      ts: Date.now(),
      source: CEBAB_SOURCE,
      destination: 'coder',
      kind: 'prompt',
      text: 'start the chain',
    });
    router.onTurnStarted();
    router.onTurnSettled('coder');
    expect(strandedRows()).toHaveLength(0);

    // Positive control on the premise — lift the hold and the same router
    // reports, so the silence above was the gate rather than a dead fixture.
    held = false;
    router.onTurnSettled('coder');
    expect(strandedRows()).toHaveLength(1);
  });
});
