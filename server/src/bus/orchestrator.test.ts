import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import {
  ORCHESTRATOR_AGENT_NAME,
  createOrchestratorRouter,
  ensureOrchestratorWorkspace,
} from './orchestrator.js';
import { computeSessionPaths, orchestratorWorkspaceDir } from './paths.js';
import { CEBAB_SOURCE, USER_RECIPIENT, type MultiAgentEndedReason } from './runtime.js';
import {
  createMultiAgentSession,
  listMultiAgentEvents,
  type MultiAgentLifecycle,
} from '../repo/multi_agent.js';
import type { BusEvent } from './runner.js';

// Same isolation scaffolding as install.test.ts — each test gets its own
// tmp ~/.cebab so writes don't leak across tests or out to the real home.

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-orchestrator-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  // ensureOrchestratorWorkspace doesn't actually need the DB — but other
  // bus modules it imports do, and getDb is the only way to apply
  // migration 005 against this fresh tmp dir.
  getDb();
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ensureOrchestratorWorkspace', () => {
  test('creates the workspace dir and writes NO files (settingSources:[user])', () => {
    ensureOrchestratorWorkspace();
    const wsDir = orchestratorWorkspaceDir();
    expect(fs.existsSync(wsDir)).toBe(true);
    // The orchestrator runs settingSources:['user'], so a workspace
    // CLAUDE.md / comm.md / settings.json would never be loaded by the
    // SDK — Cebab generates none. The bus protocol reaches the
    // orchestrator solely via renderRosterPrompt (the only prompt it sees).
    expect(fs.existsSync(path.join(wsDir, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(wsDir, '.cebab', 'comm.md'))).toBe(false);
    expect(fs.existsSync(path.join(wsDir, '.claude', 'settings.json'))).toBe(false);
  });

  test('honors a per-session target dir and is idempotent', () => {
    // Post-007 callers pass `<sessionFolder>/orchestrator/`. The legacy
    // global default must NOT be created when a target dir is given.
    const customDir = path.join(tmpRoot, 'session-folder', 'orchestrator');
    ensureOrchestratorWorkspace(customDir);
    ensureOrchestratorWorkspace(customDir); // second call: no throw
    expect(fs.existsSync(customDir)).toBe(true);
    expect(fs.existsSync(orchestratorWorkspaceDir())).toBe(false);
  });
});

// Router regression tests for the round-2 + round-3 security batch. The
// helper builds a real router against the test DB (no tmux, no tailer) so
// we can drive `handleEvent` / `forwardCebabEvent` directly and observe
// the persist + onEvent surface in isolation.
function buildRouter(
  opts: {
    workerNames?: string[];
    lifecycle?: MultiAgentLifecycle;
    onTeardown?: (reason: MultiAgentEndedReason) => Promise<void>;
  } = {},
) {
  const workerNames = opts.workerNames ?? ['reviewer', 'editor'];
  const lifecycle = opts.lifecycle ?? 'persistent';
  const sessionId = `s-${Math.random().toString(36).slice(2, 10)}`;
  const iterationId = '001';
  const paths = computeSessionPaths(sessionId, path.join(tmpRoot, 'workspace'));
  // appendMultiAgentEvent has a foreign-key constraint on multi_agent_sessions;
  // seed the row before any handleEvent / forwardCebabEvent call.
  createMultiAgentSession(sessionId, 'orchestrator', iterationId, paths.folder, lifecycle);
  const onEvent = vi.fn();
  const onEnded = vi.fn();
  const router = createOrchestratorRouter({
    sessionId,
    iterationId,
    workerNames,
    paths,
    lifecycle,
    onEvent,
    onEnded,
    onTeardown: opts.onTeardown,
  });
  return { router, sessionId, onEvent, onEnded };
}

function makeEvent(overrides: Partial<BusEvent> = {}): BusEvent {
  return {
    ts: Date.now(),
    source: 'reviewer',
    destination: ORCHESTRATOR_AGENT_NAME,
    kind: 'reply',
    text: 'sample payload',
    ...overrides,
  };
}

describe('createOrchestratorRouter — F2 source allowlist', () => {
  // Regression for the round-2 finding where the orchestrator router lacked
  // a default-deny on unknown sources. A worker setting BUS_AGENT_NAME=ghost
  // (or any other unrecognized slug) could otherwise be routed to its
  // claimed destination since the prior three filters only covered the
  // cebab / user-dest / worker→worker cases.
  test.each([
    { name: 'unknown slug', source: 'ghost', destination: 'reviewer' },
    {
      name: 'unknown slug → orchestrator',
      source: 'attacker',
      destination: ORCHESTRATOR_AGENT_NAME,
    },
    { name: 'unknown slug → user', source: 'spoofer', destination: USER_RECIPIENT },
  ])('drops event with non-participant source ($name)', ({ source, destination }) => {
    const { router, sessionId, onEvent } = buildRouter();
    router.handleEvent(makeEvent({ source, destination }));
    expect(listMultiAgentEvents(sessionId)).toHaveLength(0);
    expect(onEvent).not.toHaveBeenCalled();
  });

  test('accepts legitimate worker → orchestrator reply (sanity positive)', () => {
    // Catches an over-tightening regression — if the allowlist mistakenly
    // dropped a real worker, this test would fail.
    const { router, sessionId, onEvent } = buildRouter();
    router.handleEvent(
      makeEvent({ source: 'reviewer', destination: ORCHESTRATOR_AGENT_NAME, text: 'real reply' }),
    );
    expect(listMultiAgentEvents(sessionId)).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  test('drops forged source=cebab from the tailer', () => {
    // F3 disk-side drop. Any cebab-attributed line on disk is a forgery —
    // Cebab routes its own writes in-process via forwardCebabEvent.
    const { router, sessionId, onEvent } = buildRouter();
    router.handleEvent(makeEvent({ source: CEBAB_SOURCE, destination: 'reviewer' }));
    expect(listMultiAgentEvents(sessionId)).toHaveLength(0);
    expect(onEvent).not.toHaveBeenCalled();
  });

  test('drops worker→worker traffic (orchestrator mode is hub-and-spoke)', () => {
    const { router, sessionId, onEvent } = buildRouter();
    router.handleEvent(makeEvent({ source: 'reviewer', destination: 'editor' }));
    expect(listMultiAgentEvents(sessionId)).toHaveLength(0);
    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe('createOrchestratorRouter — F3 forwardCebabEvent round-trip', () => {
  // Regression for the round-2 silent bug: when the disk-side `source=cebab`
  // drop was added without an in-process forwarding helper, every Cebab-
  // originated event (rosters, briefings, sendUserPrompt) was swallowed —
  // never persisted, never reached the WS scrollback. forwardCebabEvent
  // closes the loop; this test pins that contract.
  test('persists + forwards a Cebab event exactly once', () => {
    const { router, sessionId, onEvent } = buildRouter();
    router.forwardCebabEvent(
      makeEvent({ source: CEBAB_SOURCE, destination: 'reviewer', kind: 'prompt', text: 'go' }),
    );
    expect(listMultiAgentEvents(sessionId)).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  test('tailer re-read of the same event is dropped (no double-persist)', () => {
    // Simulates the in-process write (forwardCebabEvent) followed by the
    // tailer observing the same bus.log line on disk and calling
    // handleEvent. The disk-side drop swallows it; total stays at 1.
    const { router, sessionId, onEvent } = buildRouter();
    const ev = makeEvent({ source: CEBAB_SOURCE, destination: 'reviewer', kind: 'prompt' });
    router.forwardCebabEvent(ev);
    router.handleEvent(ev);
    expect(listMultiAgentEvents(sessionId)).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});

describe('createOrchestratorRouter — registerWorker (mid-run worker add)', () => {
  // Pins the contract that `addWorker` on the session handle relies on:
  // after registerWorker(slug), inbound events from `slug` pass F2's
  // source allowlist (which would otherwise drop them as forgeries).
  test('newly-registered slug passes the F2 source allowlist', () => {
    const { router, sessionId, onEvent } = buildRouter();
    // Before registration: a `newbie` source is dropped as non-participant.
    router.handleEvent(
      makeEvent({ source: 'newbie', destination: ORCHESTRATOR_AGENT_NAME, kind: 'reply' }),
    );
    expect(listMultiAgentEvents(sessionId)).toHaveLength(0);
    expect(onEvent).not.toHaveBeenCalled();

    // After registration: same event is accepted.
    router.registerWorker('newbie');
    router.handleEvent(
      makeEvent({
        source: 'newbie',
        destination: ORCHESTRATOR_AGENT_NAME,
        kind: 'reply',
        text: 'hello',
      }),
    );
    expect(listMultiAgentEvents(sessionId)).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  test('is idempotent (re-registering an existing slug is a no-op)', () => {
    const { router } = buildRouter({ workerNames: ['reviewer'] });
    expect(router.getWorkerNames()).toEqual(['reviewer']);
    router.registerWorker('reviewer');
    router.registerWorker('reviewer');
    expect(router.getWorkerNames()).toEqual(['reviewer']);
    router.registerWorker('editor');
    expect(router.getWorkerNames()).toEqual(['reviewer', 'editor']);
  });
});

describe('createOrchestratorRouter — setLifecycle (mid-run lifecycle flip)', () => {
  // The router gates the onTeardown invocation on the CURRENT
  // lifecycleRef + reason !== 'crashed'. setLifecycle must mutate that
  // ref so a session started 'persistent' but flipped to 'temp' mid-run
  // cleans up at end, and vice versa.
  test('persistent → temp: onTeardown runs at teardown', async () => {
    const onTeardown = vi.fn().mockResolvedValue(undefined);
    const { router } = buildRouter({ lifecycle: 'persistent', onTeardown });
    expect(router.getLifecycle()).toBe('persistent');
    router.setLifecycle('temp');
    expect(router.getLifecycle()).toBe('temp');
    await router.teardown('stopped');
    expect(onTeardown).toHaveBeenCalledTimes(1);
  });

  test('temp → persistent: onTeardown does NOT run at teardown', async () => {
    const onTeardown = vi.fn().mockResolvedValue(undefined);
    const { router } = buildRouter({ lifecycle: 'temp', onTeardown });
    router.setLifecycle('persistent');
    await router.teardown('stopped');
    expect(onTeardown).not.toHaveBeenCalled();
  });

  test('onTeardown is skipped on `crashed` even when temp', async () => {
    // Crash means the operator wants to inspect artifacts; lifecycle
    // doesn't matter — never run the rm-rf + uninstall.
    const onTeardown = vi.fn().mockResolvedValue(undefined);
    const { router } = buildRouter({ lifecycle: 'temp', onTeardown });
    await router.teardown('crashed');
    expect(onTeardown).not.toHaveBeenCalled();
  });
});
