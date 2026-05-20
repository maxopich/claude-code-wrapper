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
  getMultiAgentSession,
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
    // Generous cap so unrelated tests don't accidentally trip on the
    // budget enforcement; the budget-specific tests below override.
    hopBudget: 1000,
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

describe('createOrchestratorRouter — hop-budget enforcement', () => {
  function buildBudgetRouter(hopBudget: number, initialHopsCount?: number) {
    const sessionId = `s-${Math.random().toString(36).slice(2, 10)}`;
    const iterationId = '001';
    const paths = computeSessionPaths(sessionId, path.join(tmpRoot, 'workspace'));
    createMultiAgentSession(sessionId, 'orchestrator', iterationId, paths.folder, 'persistent');
    const onEvent = vi.fn();
    const onEnded = vi.fn();
    const deliver = vi.fn();
    const router = createOrchestratorRouter({
      sessionId,
      iterationId,
      workerNames: ['reviewer', 'editor'],
      paths,
      lifecycle: 'persistent',
      onEvent,
      onEnded,
      deliver,
      hopBudget,
      initialHopsCount,
    });
    return { router, sessionId, onEvent, onEnded, deliver };
  }

  test('budget=3: the 3rd persisted hop trips a synthetic error + tears down stopped', () => {
    const { router, sessionId, onEvent, onEnded, deliver } = buildBudgetRouter(3);

    // 3 worker→orchestrator hops persist; the 3rd's would-be deliver fires
    // because the check sits AFTER persist+sink — wait, re-check…
    // Actually `checkBudgetExhausted()` runs BEFORE deliver. After hop 3
    // persists, `hopsCount === 3 === budget` → refuse the next deliver.
    // The 3rd hop's deliver (which would wake the orchestrator) is the
    // one that gets refused, NOT the 3rd hop's persist.
    router.handleEvent(
      makeEvent({ source: 'reviewer', destination: ORCHESTRATOR_AGENT_NAME, text: 'r1' }),
    );
    router.handleEvent(
      makeEvent({ source: 'editor', destination: ORCHESTRATOR_AGENT_NAME, text: 'e1' }),
    );
    router.handleEvent(
      makeEvent({ source: 'reviewer', destination: ORCHESTRATOR_AGENT_NAME, text: 'r2' }),
    );
    // 4th attempt is dropped at the `ended` guard.
    router.handleEvent(
      makeEvent({ source: 'editor', destination: ORCHESTRATOR_AGENT_NAME, text: 'e2 refused' }),
    );

    const persisted = listMultiAgentEvents(sessionId);
    // 3 worker hops + 1 synthetic cebab→_sink error = 4 events.
    expect(persisted).toHaveLength(4);
    expect(persisted.at(-1)).toMatchObject({
      source: CEBAB_SOURCE,
      kind: 'error',
    });
    expect(persisted.at(-1)!.text).toContain('Hop budget exhausted (3/3)');

    expect(onEvent).toHaveBeenCalledTimes(4);
    // Only the first 2 hops fired deliver; hop 3 was the boundary trip and
    // its deliver call was refused by `checkBudgetExhausted()`.
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenNthCalledWith(1, ORCHESTRATOR_AGENT_NAME, 'r1');
    expect(deliver).toHaveBeenNthCalledWith(2, ORCHESTRATOR_AGENT_NAME, 'e1');

    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledWith(sessionId, 'stopped', '001');
  });

  test('orchestrator → user is exempt from triggering the budget refusal', () => {
    // `orchestrator → user` does not wake another agent (the operator is
    // not a participant), so the post-persist budget check is skipped on
    // that path — a final-to-user right at the boundary should NOT emit a
    // synthetic error.
    const { router, sessionId, onEnded, deliver } = buildBudgetRouter(2);
    router.handleEvent(
      makeEvent({ source: 'reviewer', destination: ORCHESTRATOR_AGENT_NAME, text: 'r1' }),
    );
    router.handleEvent(
      makeEvent({
        source: ORCHESTRATOR_AGENT_NAME,
        destination: USER_RECIPIENT,
        kind: 'final',
        text: 'final answer',
      }),
    );
    const persisted = listMultiAgentEvents(sessionId);
    // 2 legitimate events, no synthetic error appended.
    expect(persisted).toHaveLength(2);
    expect(persisted.every((p) => p.kind !== 'error' || p.source !== CEBAB_SOURCE)).toBe(true);
    expect(onEnded).not.toHaveBeenCalled();
    // Only the 1st hop's deliver fires (waking orchestrator); the final →
    // user does not call deliver.
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  test('sendUserPrompt enforces budget after exhaustion (no orchestrator wake)', async () => {
    // After the cap trips, a follow-up user prompt must NOT wake the
    // orchestrator; the router is `ended` so even the persist short-
    // circuits inside `forwardCebabEvent`.
    const { router, deliver } = buildBudgetRouter(1);

    router.handleEvent(
      makeEvent({ source: 'reviewer', destination: ORCHESTRATOR_AGENT_NAME, text: 'h1' }),
    );
    expect(deliver).toHaveBeenCalledTimes(0); // 1st hop already tripped the cap

    await router.sendUserPrompt('follow-up after exhaustion');
    expect(deliver).toHaveBeenCalledTimes(0); // never woke orchestrator
  });

  test('initialHopsCount seeds the counter (R-B reconstruction parity)', () => {
    // R-B path: reconstruct.ts reads `listMultiAgentEvents(...).length` and
    // passes it as `initialHopsCount` so a session at 29/30 resumed after a
    // restart trips on the next hop, not 30 hops later.
    const { router, sessionId, onEnded, deliver } = buildBudgetRouter(3, 2);
    router.handleEvent(
      makeEvent({ source: 'reviewer', destination: ORCHESTRATOR_AGENT_NAME, text: 'post-resume' }),
    );
    // Initial 2 + this hop's 1 = 3 → at-cap, refuse deliver, emit synthetic.
    expect(deliver).not.toHaveBeenCalled();
    const persisted = listMultiAgentEvents(sessionId);
    expect(persisted.at(-1)).toMatchObject({ source: CEBAB_SOURCE, kind: 'error' });
    expect(persisted.at(-1)!.text).toContain('Hop budget exhausted (3/3)');
    expect(onEnded).toHaveBeenCalledWith(sessionId, 'stopped', '001');
  });

  test('budget=1000 never trips on a short session', () => {
    const { router, onEnded, deliver } = buildBudgetRouter(1000);
    for (let i = 0; i < 10; i++) {
      router.handleEvent(
        makeEvent({
          source: i % 2 ? 'reviewer' : ORCHESTRATOR_AGENT_NAME,
          destination: i % 2 ? ORCHESTRATOR_AGENT_NAME : 'reviewer',
        }),
      );
    }
    expect(deliver).toHaveBeenCalledTimes(10);
    expect(onEnded).not.toHaveBeenCalled();
  });
});

// --- Item #4: worker failure surfacing + pending-retry slot --------------
//
// Symmetric to the chain.test.ts coverage. `onWorkerFailed` is the
// router-level entry the orchestrator deliver() .catch fires on a
// failed deliverTurn. Same invariants: persist a synthetic `cebab → user
// kind=error` event, write the pending-retry columns, emit
// `onPendingRetry`, do NOT teardown, do NOT bump the hop counter.
describe('createOrchestratorRouter — onWorkerFailed (Item #4)', () => {
  function buildFailRouter() {
    const sessionId = `s-${Math.random().toString(36).slice(2, 10)}`;
    const iterationId = '001';
    const paths = computeSessionPaths(sessionId, path.join(tmpRoot, 'workspace'));
    createMultiAgentSession(sessionId, 'orchestrator', iterationId, paths.folder, 'persistent');
    const onEvent = vi.fn();
    const onEnded = vi.fn();
    const onPendingRetry = vi.fn();
    const deliver = vi.fn();
    const router = createOrchestratorRouter({
      sessionId,
      iterationId,
      workerNames: ['reviewer', 'editor'],
      paths,
      lifecycle: 'persistent',
      onEvent,
      onEnded,
      deliver,
      hopBudget: 1000,
      onPendingRetry,
    });
    return { router, sessionId, onEvent, onEnded, onPendingRetry, deliver };
  }

  test('persists a cebab→user kind=error event, writes the slot, leaves session live', () => {
    const { router, sessionId, onEvent, onEnded, onPendingRetry } = buildFailRouter();
    router.onWorkerFailed(
      'reviewer',
      'review this draft',
      new Error('SDK result subtype=error_during_execution'),
    );

    const persisted = listMultiAgentEvents(sessionId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!).toMatchObject({
      source: CEBAB_SOURCE,
      destination: USER_RECIPIENT,
      kind: 'error',
    });
    expect(persisted[0]!.text).toContain('`reviewer`');
    expect(persisted[0]!.text).toContain('SDK result subtype=error_during_execution');
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEnded).not.toHaveBeenCalled();

    expect(onPendingRetry).toHaveBeenCalledTimes(1);
    const [sid, pending] = onPendingRetry.mock.calls[0]!;
    expect(sid).toBe(sessionId);
    expect(pending).toMatchObject({
      agentName: 'reviewer',
      lastPrompt: 'review this draft',
      errorEventId: persisted[0]!.id,
    });

    const row = getMultiAgentSession(sessionId)!;
    expect(row.pending_retry_agent).toBe('reviewer');
    expect(row.pending_retry_prompt).toBe('review this draft');
  });

  test('with empty prompt (failed pre-deliver), falls back to teardown crashed', () => {
    const { router, sessionId, onEnded, onPendingRetry } = buildFailRouter();
    router.onWorkerFailed('reviewer', '', new Error('boot failed'));
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledWith(sessionId, 'crashed', '001');
    expect(onPendingRetry).not.toHaveBeenCalled();
  });

  test('does NOT bump the hop counter (budget pattern parity)', () => {
    // budget=2: one hop + one failure + one more hop should still allow
    // the second hop's deliver. A buggy increment would refuse it.
    const sessionId = `s-${Math.random().toString(36).slice(2, 10)}`;
    const paths = computeSessionPaths(sessionId, path.join(tmpRoot, 'workspace'));
    createMultiAgentSession(sessionId, 'orchestrator', '001', paths.folder, 'persistent');
    const deliver = vi.fn();
    const onEnded = vi.fn();
    const router = createOrchestratorRouter({
      sessionId,
      iterationId: '001',
      workerNames: ['reviewer', 'editor'],
      paths,
      lifecycle: 'persistent',
      onEvent: vi.fn(),
      onEnded,
      deliver,
      hopBudget: 2,
      onPendingRetry: vi.fn(),
    });
    router.handleEvent(
      makeEvent({ source: 'reviewer', destination: ORCHESTRATOR_AGENT_NAME, text: 'r1' }),
    ); // hopsCount=1
    router.onWorkerFailed(ORCHESTRATOR_AGENT_NAME, 'do', new Error('boom')); // unchanged
    router.handleEvent(
      makeEvent({ source: 'reviewer', destination: ORCHESTRATOR_AGENT_NAME, text: 'r2' }),
    ); // hopsCount=2 → next deliver refused
    expect(deliver).toHaveBeenCalledTimes(1); // hop 1 only; hop 2 was boundary trip
    expect(onEnded).toHaveBeenCalledWith(sessionId, 'stopped', '001');
  });
});
