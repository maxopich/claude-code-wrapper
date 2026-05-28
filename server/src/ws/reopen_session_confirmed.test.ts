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
import { executeReopenSessionConfirmed } from './server.js';

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
  };
  return {
    handle: handle as unknown as OrchestratorSessionHandle,
    mode,
    row,
    replayEvents: [],
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

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

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
