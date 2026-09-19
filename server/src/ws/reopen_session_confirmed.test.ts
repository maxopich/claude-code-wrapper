import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ServerMsg, WorkspaceDiff } from '@cebab/shared/protocol';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import {
  addParticipant,
  archiveMultiAgentSession,
  createMultiAgentSession,
  endMultiAgentSession,
  getMultiAgentSession,
} from '../repo/multi_agent.js';
import { listForSession } from '../repo/recovery_log.js';
import { upsertProject } from '../repo/projects.js';
import type { ResumedSession } from '../bus/resume.js';
import type { OrchestratorSessionHandle } from '../bus/orchestrator.js';
import {
  getLiveSession,
  hasLiveSession,
  registerLiveSession,
  unregisterLiveSession,
  type LiveBusSession,
} from '../bus/session_registry.js';
import { executeReopenSessionConfirmed } from './server.js';
import { closeLogger } from '../runner/logger.js';

// Cluster D Phase 5c (spec §6.3, BE-D20 / BE-D21 / BE-D24): coverage
// for the `reopen_session_confirmed` commit handler.
//
// The handler is exercised directly with a stubbed `resumeTarget` so
// tests don't need to stand up a real session registry or R-B
// reconstruction — those paths are already covered in resume.ts tests.

let tmpRoot: string;
let originalDataDir: string;
let sent: ServerMsg[];

function captureSend(msg: ServerMsg): void {
  sent.push(msg);
}

const EMPTY_DIFF: WorkspaceDiff = {
  filesChanged: 0,
  filesAdded: 0,
  filesDeleted: 0,
  sampleChanges: [],
  fullDiffAvailable: true,
};

const DIRTY_DIFF: WorkspaceDiff = {
  filesChanged: 3,
  filesAdded: 1,
  filesDeleted: 0,
  sampleChanges: ['a.txt', 'b.txt', 'c.txt'],
  fullDiffAvailable: true,
};

const NO_GIT_DIFF: WorkspaceDiff = {
  filesChanged: 0,
  filesAdded: 0,
  filesDeleted: 0,
  sampleChanges: [],
  fullDiffAvailable: false,
};

/** Build a stubbed ResumedSession reply for the resumeTarget seam. */
function makeStubbedResumed(sessionId: string, mode: 'chain' | 'orchestrator'): ResumedSession {
  const row = getMultiAgentSession(sessionId)!;
  // Minimal handle shape — emitResumedSession would touch many fields,
  // but our test bypasses that helper via `adoptResumed`.
  const handle = {
    sessionId,
    mode,
    participantAgentNames: [] as string[],
    lifecycle: row.lifecycle ?? 'persistent',
    sessionFolder: row.session_folder ?? null,
    hopBudget: 1000,
    maxTurns: 50,
  };
  return {
    handle: handle as unknown as OrchestratorSessionHandle,
    mode,
    row,
    replayEvents: [],
    sinkEpoch: 1, // register B01: whoever resumed owns this sink generation
  };
}

const stubResumeOk = vi.fn(async (sessionId: string) => ({
  ok: true as const,
  resumed: makeStubbedResumed(sessionId, 'orchestrator'),
}));

const stubResumeReattachFailed = vi.fn(async () => ({
  ok: false as const,
  reason: 'reattach-failed' as const,
}));

const stubResumeNotFound = vi.fn(async () => ({
  ok: false as const,
  reason: 'not-found' as const,
}));

const dummyResumeCallbacks = {
  onEvent: vi.fn(),
  onEnded: vi.fn(),
  hopBudget: 1000,
  maxTurns: 50,
  // Test stand-in: the no-op required gate (never a production value).
  gateParticipants: async () => new Map<number, readonly string[]>(),
};

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-reopen-confirmed-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  sent = [];
  stubResumeOk.mockClear();
  stubResumeReattachFailed.mockClear();
  stubResumeNotFound.mockClear();
});

afterEach(async () => {
  // The live registry is a process singleton — a test that registers an
  // incumbent must not leak it into the next test's `claimSessionStart`.
  unregisterLiveSession('incumbent');
  closeDb();
  config.dataDir = originalDataDir;
  await closeLogger();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** A fake live session whose `stop` mimics a real router teardown: it
 *  unregisters itself from the process registry (as chain/orchestrator
 *  `teardown` does via `unregisterLiveSession`). Hoisted to module scope
 *  (Cebab-r833) so both the Cebab-1tty and Cebab-r833 describes can reuse it. */
function registerFakeLive(sessionId: string): { stop: ReturnType<typeof vi.fn> } {
  const stop = vi.fn(async (reason: string) => {
    void reason;
    unregisterLiveSession(sessionId);
  });
  const fake = {
    sessionId,
    mode: 'orchestrator' as const,
    handle: { sessionId, stop },
    rebind: vi.fn(() => 1),
    sendServerMsg: vi.fn(),
  };
  registerLiveSession(fake as unknown as LiveBusSession);
  return { stop };
}

describe('executeReopenSessionConfirmed — happy paths', () => {
  test('clean workspace + ack → reactivates without typed gate; adopts + recovery_log written', async () => {
    const proj = upsertProject('P', '/projects/p');
    createMultiAgentSession('target', 'orchestrator', '001');
    endMultiAgentSession('target', 'crashed');
    addParticipant('target', proj.id, 'worker', null);

    const detach = vi.fn();
    const adopt = vi.fn();

    await executeReopenSessionConfirmed({
      sessionId: 'target',
      acknowledgedWorkspaceDiff: true,
      typedConfirmation: undefined,
      currentActiveSessionId: null,
      detachCurrentActive: detach,
      adoptResumed: adopt,
      resumeCallbacks: dummyResumeCallbacks,
      send: captureSend,
      computeDiff: async () => EMPTY_DIFF,
      resumeTarget: stubResumeOk,
    });

    expect(stubResumeOk).toHaveBeenCalledWith('target', dummyResumeCallbacks);
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(detach).not.toHaveBeenCalled(); // no current active to detach
    expect(sent).toHaveLength(0); // emitResumedSession is the adopt path

    const log = listForSession('target');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      session_id: 'target',
      failure_class: 'sweep',
      operator_action: 'reopen',
      parent_session_id: null,
    });
  });

  test('swap path: detaches + marks current active crashed + emits session_superseded', async () => {
    const proj = upsertProject('P', '/projects/p');

    // Current active session
    createMultiAgentSession('current', 'orchestrator', '100');
    // Don't end it — leave status='running'

    // Target swept session
    createMultiAgentSession('target', 'orchestrator', '101');
    endMultiAgentSession('target', 'crashed');
    addParticipant('target', proj.id, 'worker', null);

    const detach = vi.fn();
    const adopt = vi.fn();

    await executeReopenSessionConfirmed({
      sessionId: 'target',
      acknowledgedWorkspaceDiff: true,
      typedConfirmation: undefined,
      currentActiveSessionId: 'current',
      detachCurrentActive: detach,
      adoptResumed: adopt,
      resumeCallbacks: dummyResumeCallbacks,
      send: captureSend,
      computeDiff: async () => EMPTY_DIFF,
      resumeTarget: stubResumeOk,
    });

    // Current was detached + crashed
    expect(detach).toHaveBeenCalledTimes(1);
    expect(getMultiAgentSession('current')?.status).toBe('crashed');

    // session_superseded ServerMsg was emitted for the displaced one
    const superseded = sent.find((m) => m.type === 'session_superseded');
    expect(superseded).toMatchObject({
      type: 'session_superseded',
      sessionId: 'current',
      supersedingSessionId: 'target',
    });

    // Notification envelope with operator_reopen reasonCode
    const notif = sent.find((m) => m.type === 'notification');
    expect(notif).toMatchObject({
      type: 'notification',
      class: 'operational',
      severity: 'warn',
      sessionId: 'current',
      action: { kind: 'archive', sessionId: 'current' },
      reasonCode: 'operator_reopen',
    });

    // Adopted
    expect(adopt).toHaveBeenCalledTimes(1);

    // recovery_log row references the swap lineage via parent_session_id
    const log = listForSession('target');
    expect(log[0]).toMatchObject({
      operator_action: 'reopen',
      parent_session_id: 'current',
    });
  });

  test('archived target is unarchived as part of the swap', async () => {
    const proj = upsertProject('P', '/projects/p');
    createMultiAgentSession('arch', 'orchestrator', '001');
    endMultiAgentSession('arch', 'crashed');
    archiveMultiAgentSession('arch');
    addParticipant('arch', proj.id, 'worker', null);
    expect(getMultiAgentSession('arch')?.archived).toBe(1);

    await executeReopenSessionConfirmed({
      sessionId: 'arch',
      acknowledgedWorkspaceDiff: true,
      typedConfirmation: undefined,
      currentActiveSessionId: null,
      detachCurrentActive: vi.fn(),
      adoptResumed: vi.fn(),
      resumeCallbacks: dummyResumeCallbacks,
      send: captureSend,
      computeDiff: async () => EMPTY_DIFF,
      resumeTarget: stubResumeOk,
    });

    expect(getMultiAgentSession('arch')?.archived).toBe(0);
  });

  test('dirty workspace + ack + typed "reopen" → reactivates', async () => {
    const proj = upsertProject('P', '/projects/p');
    createMultiAgentSession('target', 'orchestrator', '001');
    endMultiAgentSession('target', 'crashed');
    addParticipant('target', proj.id, 'worker', null);

    await executeReopenSessionConfirmed({
      sessionId: 'target',
      acknowledgedWorkspaceDiff: true,
      typedConfirmation: 'reopen',
      currentActiveSessionId: null,
      detachCurrentActive: vi.fn(),
      adoptResumed: vi.fn(),
      resumeCallbacks: dummyResumeCallbacks,
      send: captureSend,
      computeDiff: async () => DIRTY_DIFF,
      resumeTarget: stubResumeOk,
    });

    expect(stubResumeOk).toHaveBeenCalled();
    expect(sent.find((m) => m.type === 'reopen_session_failed')).toBeUndefined();
  });
});

describe('executeReopenSessionConfirmed — gate failures', () => {
  test('missing acknowledgedWorkspaceDiff → ack_required + no reactivation', async () => {
    const proj = upsertProject('P', '/projects/p');
    createMultiAgentSession('target', 'orchestrator', '001');
    endMultiAgentSession('target', 'crashed');
    addParticipant('target', proj.id, 'worker', null);

    await executeReopenSessionConfirmed({
      sessionId: 'target',
      acknowledgedWorkspaceDiff: false,
      typedConfirmation: 'reopen',
      currentActiveSessionId: null,
      detachCurrentActive: vi.fn(),
      adoptResumed: vi.fn(),
      resumeCallbacks: dummyResumeCallbacks,
      send: captureSend,
      computeDiff: async () => EMPTY_DIFF,
      resumeTarget: stubResumeOk,
    });

    expect(sent).toEqual([
      {
        type: 'reopen_session_failed',
        sessionId: 'target',
        reason: 'ack_required',
        message: 'Reopening requires explicit acknowledgment of the workspace diff.',
      },
    ]);
    expect(stubResumeOk).not.toHaveBeenCalled();
  });

  test('dirty workspace + ack but no typed confirmation → typed_confirmation_required', async () => {
    const proj = upsertProject('P', '/projects/p');
    createMultiAgentSession('target', 'orchestrator', '001');
    endMultiAgentSession('target', 'crashed');
    addParticipant('target', proj.id, 'worker', null);

    await executeReopenSessionConfirmed({
      sessionId: 'target',
      acknowledgedWorkspaceDiff: true,
      typedConfirmation: undefined,
      currentActiveSessionId: null,
      detachCurrentActive: vi.fn(),
      adoptResumed: vi.fn(),
      resumeCallbacks: dummyResumeCallbacks,
      send: captureSend,
      computeDiff: async () => DIRTY_DIFF,
      resumeTarget: stubResumeOk,
    });

    expect(sent[0]).toMatchObject({
      type: 'reopen_session_failed',
      reason: 'typed_confirmation_required',
    });
    expect(stubResumeOk).not.toHaveBeenCalled();
  });

  test('dirty workspace + ack + wrong typed string → typed_confirmation_required', async () => {
    const proj = upsertProject('P', '/projects/p');
    createMultiAgentSession('target', 'orchestrator', '001');
    endMultiAgentSession('target', 'crashed');
    addParticipant('target', proj.id, 'worker', null);

    await executeReopenSessionConfirmed({
      sessionId: 'target',
      acknowledgedWorkspaceDiff: true,
      typedConfirmation: 'REOPEN', // wrong case
      currentActiveSessionId: null,
      detachCurrentActive: vi.fn(),
      adoptResumed: vi.fn(),
      resumeCallbacks: dummyResumeCallbacks,
      send: captureSend,
      computeDiff: async () => DIRTY_DIFF,
      resumeTarget: stubResumeOk,
    });

    expect(sent[0]).toMatchObject({ reason: 'typed_confirmation_required' });
    expect(stubResumeOk).not.toHaveBeenCalled();
  });

  test('non-git workspace requires typed gate (safe-by-default)', async () => {
    const proj = upsertProject('P', '/projects/p');
    createMultiAgentSession('target', 'orchestrator', '001');
    endMultiAgentSession('target', 'crashed');
    addParticipant('target', proj.id, 'worker', null);

    await executeReopenSessionConfirmed({
      sessionId: 'target',
      acknowledgedWorkspaceDiff: true,
      typedConfirmation: undefined,
      currentActiveSessionId: null,
      detachCurrentActive: vi.fn(),
      adoptResumed: vi.fn(),
      resumeCallbacks: dummyResumeCallbacks,
      send: captureSend,
      computeDiff: async () => NO_GIT_DIFF,
      resumeTarget: stubResumeOk,
    });

    expect(sent[0]).toMatchObject({ reason: 'typed_confirmation_required' });
    expect(stubResumeOk).not.toHaveBeenCalled();
  });
});

describe('executeReopenSessionConfirmed — target validation', () => {
  test('unknown sessionId → not_found', async () => {
    await executeReopenSessionConfirmed({
      sessionId: 'gone',
      acknowledgedWorkspaceDiff: true,
      typedConfirmation: 'reopen',
      currentActiveSessionId: null,
      detachCurrentActive: vi.fn(),
      adoptResumed: vi.fn(),
      resumeCallbacks: dummyResumeCallbacks,
      send: captureSend,
      computeDiff: async () => EMPTY_DIFF,
      resumeTarget: stubResumeOk,
    });

    expect(sent).toEqual([
      {
        type: 'reopen_session_failed',
        sessionId: 'gone',
        reason: 'not_found',
        message: 'No such multi-agent session gone',
      },
    ]);
  });

  test('running target → still_running (race between probe and confirm)', async () => {
    createMultiAgentSession('running-1', 'orchestrator', '001');
    // Keep status='running'

    await executeReopenSessionConfirmed({
      sessionId: 'running-1',
      acknowledgedWorkspaceDiff: true,
      typedConfirmation: 'reopen',
      currentActiveSessionId: null,
      detachCurrentActive: vi.fn(),
      adoptResumed: vi.fn(),
      resumeCallbacks: dummyResumeCallbacks,
      send: captureSend,
      computeDiff: async () => EMPTY_DIFF,
      resumeTarget: stubResumeOk,
    });

    expect(sent[0]).toMatchObject({ reason: 'still_running' });
    expect(stubResumeOk).not.toHaveBeenCalled();
  });

  test('no participants → no_participant (no diff path available)', async () => {
    createMultiAgentSession('orphan', 'orchestrator', '001');
    endMultiAgentSession('orphan', 'crashed');

    await executeReopenSessionConfirmed({
      sessionId: 'orphan',
      acknowledgedWorkspaceDiff: true,
      typedConfirmation: 'reopen',
      currentActiveSessionId: null,
      detachCurrentActive: vi.fn(),
      adoptResumed: vi.fn(),
      resumeCallbacks: dummyResumeCallbacks,
      send: captureSend,
      computeDiff: async () => EMPTY_DIFF,
      resumeTarget: stubResumeOk,
    });

    expect(sent[0]).toMatchObject({ reason: 'no_participant' });
    expect(stubResumeOk).not.toHaveBeenCalled();
  });
});

describe('executeReopenSessionConfirmed — reactivation failures', () => {
  test('chain mode + reattach-failed → chain_reconstruction_unsupported', async () => {
    const proj = upsertProject('P', '/projects/p');
    createMultiAgentSession('chain-tgt', 'chain', '001');
    endMultiAgentSession('chain-tgt', 'crashed');
    addParticipant('chain-tgt', proj.id, 'worker', 0);

    await executeReopenSessionConfirmed({
      sessionId: 'chain-tgt',
      acknowledgedWorkspaceDiff: true,
      typedConfirmation: undefined,
      currentActiveSessionId: null,
      detachCurrentActive: vi.fn(),
      adoptResumed: vi.fn(),
      resumeCallbacks: dummyResumeCallbacks,
      send: captureSend,
      computeDiff: async () => EMPTY_DIFF,
      resumeTarget: stubResumeReattachFailed,
    });

    expect(sent.find((m) => m.type === 'reopen_session_failed')).toMatchObject({
      reason: 'chain_reconstruction_unsupported',
    });
  });

  test('orchestrator mode + reattach-failed → reactivate_failed (generic)', async () => {
    const proj = upsertProject('P', '/projects/p');
    createMultiAgentSession('orch-tgt', 'orchestrator', '001');
    endMultiAgentSession('orch-tgt', 'crashed');
    addParticipant('orch-tgt', proj.id, 'worker', null);

    await executeReopenSessionConfirmed({
      sessionId: 'orch-tgt',
      acknowledgedWorkspaceDiff: true,
      typedConfirmation: undefined,
      currentActiveSessionId: null,
      detachCurrentActive: vi.fn(),
      adoptResumed: vi.fn(),
      resumeCallbacks: dummyResumeCallbacks,
      send: captureSend,
      computeDiff: async () => EMPTY_DIFF,
      resumeTarget: stubResumeReattachFailed,
    });

    expect(sent.find((m) => m.type === 'reopen_session_failed')).toMatchObject({
      reason: 'reactivate_failed',
    });
  });

  test('resumeTarget throws → reactivate_failed with the error message', async () => {
    const proj = upsertProject('P', '/projects/p');
    createMultiAgentSession('boom', 'orchestrator', '001');
    endMultiAgentSession('boom', 'crashed');
    addParticipant('boom', proj.id, 'worker', null);

    const throwingResume = vi.fn(async () => {
      throw new Error('reconstruction blew up');
    });

    await executeReopenSessionConfirmed({
      sessionId: 'boom',
      acknowledgedWorkspaceDiff: true,
      typedConfirmation: undefined,
      currentActiveSessionId: null,
      detachCurrentActive: vi.fn(),
      adoptResumed: vi.fn(),
      resumeCallbacks: dummyResumeCallbacks,
      send: captureSend,
      computeDiff: async () => EMPTY_DIFF,
      resumeTarget: throwingResume,
    });

    expect(sent[0]).toMatchObject({
      type: 'reopen_session_failed',
      reason: 'reactivate_failed',
      message: 'reconstruction blew up',
    });
  });
});

// Cebab-1tty: displacing a LIVE incumbent must actually tear it down, not just
// silence its sink. `detachCurrentActive` is a bare sink swap, and nothing else
// in this handler clears the live registry — so before the fix the displaced
// run stayed live in-process forever while its row read `crashed`, which is
// what refused a managed-agent delete, no-op'd stop, and wedged the next start.
describe('executeReopenSessionConfirmed — a displaced LIVE incumbent is torn down (Cebab-1tty)', () => {
  test('reopening B while A is live leaves A absent from the live registry', async () => {
    const proj = upsertProject('P', '/projects/p');
    createMultiAgentSession('incumbent', 'orchestrator', '100'); // stays running
    createMultiAgentSession('target', 'orchestrator', '101');
    endMultiAgentSession('target', 'crashed');
    addParticipant('target', proj.id, 'worker', null);

    const { stop } = registerFakeLive('incumbent');
    expect(hasLiveSession('incumbent')).toBe(true);

    await executeReopenSessionConfirmed({
      sessionId: 'target',
      acknowledgedWorkspaceDiff: true,
      typedConfirmation: undefined,
      currentActiveSessionId: 'incumbent',
      detachCurrentActive: vi.fn(),
      adoptResumed: vi.fn(),
      resumeCallbacks: dummyResumeCallbacks,
      send: captureSend,
      computeDiff: async () => EMPTY_DIFF,
      resumeTarget: stubResumeOk,
    });

    // The handle was stopped for real, so the registry no longer holds A. A
    // managed agent that took part in A can now be deleted (the delete refusal
    // keys on exactly this registry being non-empty), stop is no longer a
    // no-op, and claimSessionStart is un-wedged.
    expect(stop).toHaveBeenCalledWith('crashed');
    expect(hasLiveSession('incumbent')).toBe(false);
    expect(getLiveSession('incumbent')).toBeUndefined();
    // And the swap still completed: row crashed, superseded notice sent.
    expect(getMultiAgentSession('incumbent')?.status).toBe('crashed');
    expect(sent.find((m) => m.type === 'session_superseded')).toBeDefined();
  });

  test('a stop that THROWS still clears the registry — the swallow must not re-create the leak', async () => {
    // The catch exists so a broken teardown cannot leave the row `running`.
    // Swallowing alone would be the original defect back again: the throw can
    // land before `unregisterLiveSession`, and then the entry outlives a row
    // that says `crashed` — exactly the state this bead is about. So the catch
    // clears the entry itself.
    const proj = upsertProject('P2', '/projects/p2');
    createMultiAgentSession('incumbent2', 'orchestrator', '200');
    createMultiAgentSession('target2', 'orchestrator', '201');
    endMultiAgentSession('target2', 'crashed');
    addParticipant('target2', proj.id, 'worker', null);

    const stop = vi.fn(async (reason: string) => {
      void reason;
      // Throws BEFORE any unregister, which is the only ordering that matters.
      throw new Error('teardown blew up');
    });
    registerLiveSession({
      sessionId: 'incumbent2',
      mode: 'orchestrator' as const,
      handle: { sessionId: 'incumbent2', stop },
      rebind: vi.fn(() => 1),
      sendServerMsg: vi.fn(),
    } as unknown as LiveBusSession);
    expect(hasLiveSession('incumbent2')).toBe(true);

    await executeReopenSessionConfirmed({
      sessionId: 'target2',
      acknowledgedWorkspaceDiff: true,
      typedConfirmation: undefined,
      currentActiveSessionId: 'incumbent2',
      detachCurrentActive: vi.fn(),
      adoptResumed: vi.fn(),
      resumeCallbacks: dummyResumeCallbacks,
      send: captureSend,
      computeDiff: async () => EMPTY_DIFF,
      resumeTarget: stubResumeOk,
    });

    expect(stop).toHaveBeenCalledWith('crashed');
    expect(hasLiveSession('incumbent2')).toBe(false);
    // The row is still marked, and the reopen still went through — a failing
    // teardown must not take the operator's reopen down with it.
    expect(getMultiAgentSession('incumbent2')?.status).toBe('crashed');
  });

  // The not-live incumbent path — where `getLiveSession` returns undefined and
  // the handler falls through to the redundant `endMultiAgentSession` — is
  // already covered by the "swap path" test above, which registers nothing
  // live. A duplicate here would pass with or without this change (there is no
  // handle to stop), so it is deliberately omitted rather than written as a
  // non-reddening case.
});

// Register S09: a reopen that fails must not have cost the operator the session
// they already had.
//
// WHY THESE CASES DID NOT EXIST. Every reactivation-failure case above passes
// `currentActiveSessionId: null`, so the handler skipped the displacement block
// entirely and the bug had no way to show. The assertions were fine; the
// FIXTURE omitted the one input the failure needs. Each case here is one of
// those tests with a live incumbent supplied.
//
// The displacement is now the LAST thing the handler does, after the target is
// provably back — so "not called" is the whole contract.
describe('executeReopenSessionConfirmed — a failed reopen keeps the incumbent (S09)', () => {
  /** Seed a live incumbent + a crashed, reopenable target. */
  function seedSwap(targetId: string, mode: 'chain' | 'orchestrator' = 'orchestrator'): void {
    const proj = upsertProject('P', '/projects/p');
    createMultiAgentSession('incumbent', 'orchestrator', '100');
    // Left running on purpose — this is the session the operator is working in.
    createMultiAgentSession(targetId, mode, '101');
    endMultiAgentSession(targetId, 'crashed');
    addParticipant(targetId, proj.id, 'worker', mode === 'chain' ? 0 : null);
  }

  test('reattach-failed → incumbent is still running, never detached', async () => {
    seedSwap('orch-tgt');
    const detach = vi.fn();

    await executeReopenSessionConfirmed({
      sessionId: 'orch-tgt',
      acknowledgedWorkspaceDiff: true,
      typedConfirmation: undefined,
      currentActiveSessionId: 'incumbent',
      detachCurrentActive: detach,
      adoptResumed: vi.fn(),
      resumeCallbacks: dummyResumeCallbacks,
      send: captureSend,
      computeDiff: async () => EMPTY_DIFF,
      resumeTarget: stubResumeReattachFailed,
    });

    expect(sent.find((m) => m.type === 'reopen_session_failed')).toMatchObject({
      reason: 'reactivate_failed',
    });
    // The operator keeps what they had: sink attached, row still running, and
    // no supersede notice for a supersede that never happened.
    expect(detach).not.toHaveBeenCalled();
    expect(getMultiAgentSession('incumbent')?.status).toBe('running');
    expect(sent.find((m) => m.type === 'session_superseded')).toBeUndefined();
  });

  test('chain target → incumbent survives the unsupported-reconstruction path', async () => {
    seedSwap('chain-tgt', 'chain');
    const detach = vi.fn();

    await executeReopenSessionConfirmed({
      sessionId: 'chain-tgt',
      acknowledgedWorkspaceDiff: true,
      typedConfirmation: undefined,
      currentActiveSessionId: 'incumbent',
      detachCurrentActive: detach,
      adoptResumed: vi.fn(),
      resumeCallbacks: dummyResumeCallbacks,
      send: captureSend,
      computeDiff: async () => EMPTY_DIFF,
      resumeTarget: stubResumeReattachFailed,
    });

    expect(sent.find((m) => m.type === 'reopen_session_failed')).toMatchObject({
      reason: 'chain_reconstruction_unsupported',
    });
    expect(detach).not.toHaveBeenCalled();
    expect(getMultiAgentSession('incumbent')?.status).toBe('running');
  });

  test('resumeTarget throws → incumbent survives the fourth failure route', async () => {
    seedSwap('boom');
    const detach = vi.fn();

    await executeReopenSessionConfirmed({
      sessionId: 'boom',
      acknowledgedWorkspaceDiff: true,
      typedConfirmation: undefined,
      currentActiveSessionId: 'incumbent',
      detachCurrentActive: detach,
      adoptResumed: vi.fn(),
      resumeCallbacks: dummyResumeCallbacks,
      send: captureSend,
      computeDiff: async () => EMPTY_DIFF,
      resumeTarget: vi.fn(async () => {
        throw new Error('reconstruction blew up');
      }),
    });

    expect(sent[0]).toMatchObject({ type: 'reopen_session_failed' });
    expect(detach).not.toHaveBeenCalled();
    expect(getMultiAgentSession('incumbent')?.status).toBe('running');
  });

  test('a gate rejection also leaves the incumbent alone (it never reached resume)', async () => {
    // The control for the three above: they must pass because the SWAP was
    // withheld, not because this handler never displaces anything. This case
    // fails before `reactivate` is even reached, and the same assertions hold —
    // so it is only the pair that distinguishes "withheld on failure" from
    // "never happens".
    seedSwap('dirty-tgt');
    const detach = vi.fn();

    await executeReopenSessionConfirmed({
      sessionId: 'dirty-tgt',
      acknowledgedWorkspaceDiff: true,
      typedConfirmation: 'not-the-word',
      currentActiveSessionId: 'incumbent',
      detachCurrentActive: detach,
      adoptResumed: vi.fn(),
      resumeCallbacks: dummyResumeCallbacks,
      send: captureSend,
      computeDiff: async () => DIRTY_DIFF,
      resumeTarget: stubResumeOk,
    });

    expect(sent.find((m) => m.type === 'reopen_session_failed')).toMatchObject({
      reason: 'typed_confirmation_required',
    });
    expect(stubResumeOk).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
    expect(getMultiAgentSession('incumbent')?.status).toBe('running');
  });
});

// Cebab-r833: the displacement is resolved PROCESS-WIDE, not from
// `currentActiveSessionId` (which is only `conn.multiAgent?.sessionId`). A run
// live on ANOTHER connection — the reopening window connected before it started
// — used to be neither stopped nor unregistered, so the reopen brought the
// target live BESIDE it: two live sessions, and every subsequent start blocked.
describe('executeReopenSessionConfirmed — a cross-connection live run is displaced (Cebab-r833)', () => {
  test('7a: currentActiveSessionId null — a cross-connection live run is torn down; the reopened target is spared', async () => {
    // The reverse-check case. `currentActiveSessionId: null` is the input every
    // existing displacement case omits, and is exactly what the old
    // `if (currentActiveSessionId && …)` gate skipped on. A fixture with a
    // non-null incumbent would pass on unfixed code and prove nothing. Reverting
    // item 2 skips the whole block, so the incumbent's `stop` is never called and
    // this reddens.
    //
    // This case also CARRIES the guard-rail (was a separate 7c): the reopened
    // target, which step 4 put in the live registry so it too appears in
    // `listLiveSessionIds()`, must be EXCLUDED from the displaced set. On its own
    // "target not stopped" does NOT redden on revert — the old code never
    // displaced the target either — so a standalone case would be a
    // pass-on-revert test the revert-check rightly flags as vacuous (cf. the
    // Cebab-1tty block above, which documents its non-reddening case in a comment
    // for the same reason). Folded here it rides inside a case that does redden,
    // while still failing against a "displace everything live" regression.
    const proj = upsertProject('P', '/projects/p');
    // A real `running` row for the incumbent (no endMultiAgentSession), so the
    // crashed-row assertion is meaningful.
    createMultiAgentSession('incumbent', 'orchestrator', '100');
    createMultiAgentSession('target', 'orchestrator', '101');
    endMultiAgentSession('target', 'crashed');
    addParticipant('target', proj.id, 'worker', null);

    // 'incumbent' is live on a DIFFERENT connection than the one reopening
    // (reused id so the module afterEach unregisters it), so the reopening
    // conn's `conn.multiAgent` is null. 'target' is live because step 4 would
    // have re-registered it; we register it by hand since the stubbed
    // `resumeTarget` skips `resumeMultiAgentTarget`.
    const { stop } = registerFakeLive('incumbent');
    const { stop: targetStop } = registerFakeLive('target');
    expect(hasLiveSession('incumbent')).toBe(true);
    expect(hasLiveSession('target')).toBe(true);

    const detach = vi.fn();

    await executeReopenSessionConfirmed({
      sessionId: 'target',
      acknowledgedWorkspaceDiff: true,
      typedConfirmation: undefined,
      currentActiveSessionId: null, // the reopening connection owns nothing
      detachCurrentActive: detach,
      adoptResumed: vi.fn(),
      resumeCallbacks: dummyResumeCallbacks,
      send: captureSend,
      computeDiff: async () => EMPTY_DIFF,
      resumeTarget: stubResumeOk,
    });

    // The other connection's live run was really torn down…
    expect(stop).toHaveBeenCalledWith('crashed');
    expect(hasLiveSession('incumbent')).toBe(false);
    expect(getMultiAgentSession('incumbent')?.status).toBe('crashed');
    // …and its supersede notice was sent…
    const superseded = sent.find(
      (m) => m.type === 'session_superseded' && m.sessionId === 'incumbent',
    );
    expect(superseded).toBeDefined();
    // …while the reopening conn, which owns nothing, is never detached…
    expect(detach).not.toHaveBeenCalled();
    // …and the target the operator just reopened is spared, though it is live
    // (guard-rail against a "displace everything live" regression).
    expect(targetStop).not.toHaveBeenCalled();
    expect(hasLiveSession('target')).toBe(true);

    // afterEach only clears 'incumbent'; clean up 'target' too so the
    // process-global registry does not leak into a later test.
    unregisterLiveSession('target');
  });

  test('7b: the displaced incumbent is stopped BEFORE the conn sink is detached', async () => {
    // Ordering pin for the emit-`multi_agent_ended` decision: `stop` must run
    // while the router still holds the real sink, so its teardown broadcasts the
    // end. Detaching first swaps the sink to NOOP_SINK and the broadcast is lost.
    // Reverting to detach-first makes `detachedAtStop` true and reddens this.
    const proj = upsertProject('P', '/projects/p');
    createMultiAgentSession('incumbent', 'orchestrator', '100'); // stays running
    createMultiAgentSession('target', 'orchestrator', '101');
    endMultiAgentSession('target', 'crashed');
    addParticipant('target', proj.id, 'worker', null);

    let detached = false;
    let detachedAtStop: boolean | null = null;
    const detach = vi.fn(() => {
      detached = true;
    });
    const stop = vi.fn(async (reason: string) => {
      void reason;
      detachedAtStop = detached; // observe the sink state at stop time
      unregisterLiveSession('incumbent');
    });
    registerLiveSession({
      sessionId: 'incumbent',
      mode: 'orchestrator' as const,
      handle: { sessionId: 'incumbent', stop },
      rebind: vi.fn(() => 1),
      sendServerMsg: vi.fn(),
    } as unknown as LiveBusSession);

    await executeReopenSessionConfirmed({
      sessionId: 'target',
      acknowledgedWorkspaceDiff: true,
      typedConfirmation: undefined,
      currentActiveSessionId: 'incumbent', // same connection owns the incumbent
      detachCurrentActive: detach,
      adoptResumed: vi.fn(),
      resumeCallbacks: dummyResumeCallbacks,
      send: captureSend,
      computeDiff: async () => EMPTY_DIFF,
      resumeTarget: stubResumeOk,
    });

    expect(stop).toHaveBeenCalledWith('crashed');
    expect(detach).toHaveBeenCalledTimes(1);
    // The whole point: stop ran while the sink was still attached.
    expect(detachedAtStop).toBe(false);
  });
});
