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
} from '../repo/multi_agent.js';
import { upsertProject } from '../repo/projects.js';
import { executeReopenSessionProbe } from './server.js';

// Cluster D Phase 5b (spec §6.3, BE-D19): coverage for the
// `reopen_session` probe handler.
//
// We exercise `executeReopenSessionProbe` directly (same pattern as
// `executeArchiveSession` for Phase 5). The fixture spins up a real
// SQLite under a tmp `~/.cebab` and uses a synthetic diff stub so the
// tests don't depend on git or filesystem state — those paths are
// covered separately in workspace_diff.test.ts.

let tmpRoot: string;
let originalDataDir: string;
let sent: ServerMsg[];

function captureSend(msg: ServerMsg): void {
  sent.push(msg);
}

const STUB_DIFF: WorkspaceDiff = {
  filesChanged: 3,
  filesAdded: 1,
  filesDeleted: 1,
  sampleChanges: ['a.txt', 'b.txt', 'c.txt'],
  fullDiffAvailable: true,
};
const stubComputeDiff = vi.fn(async () => STUB_DIFF);

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-reopen-session-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  sent = [];
  stubComputeDiff.mockClear();
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('executeReopenSessionProbe — happy path', () => {
  test('replies with reopen_session_confirm_required + projectPath + diff', async () => {
    const proj = upsertProject('My Project', '/projects/my-project');
    createMultiAgentSession('swept-1', 'orchestrator', '001');
    endMultiAgentSession('swept-1', 'crashed');
    addParticipant('swept-1', proj.id, 'worker', null);

    await executeReopenSessionProbe({
      sessionId: 'swept-1',
      send: captureSend,
      computeDiff: stubComputeDiff,
    });

    expect(stubComputeDiff).toHaveBeenCalledWith('/projects/my-project');
    expect(sent).toEqual([
      {
        type: 'reopen_session_confirm_required',
        sessionId: 'swept-1',
        projectPath: '/projects/my-project',
        workspaceDiff: STUB_DIFF,
      },
    ]);
  });

  test('chain mode uses lowest chain_order participant', async () => {
    const a = upsertProject('A', '/projects/a');
    const b = upsertProject('B', '/projects/b');
    createMultiAgentSession('chain-1', 'chain', '002');
    endMultiAgentSession('chain-1', 'stopped');
    // Insert in REVERSE chain order; the query ordering should still
    // pick chain_order=0 as the first participant.
    addParticipant('chain-1', b.id, 'worker', 1);
    addParticipant('chain-1', a.id, 'worker', 0);

    await executeReopenSessionProbe({
      sessionId: 'chain-1',
      send: captureSend,
      computeDiff: stubComputeDiff,
    });

    expect(stubComputeDiff).toHaveBeenCalledWith('/projects/a');
    expect(sent[0]).toMatchObject({
      type: 'reopen_session_confirm_required',
      projectPath: '/projects/a',
    });
  });

  test('archived sessions ARE allowed to reopen', async () => {
    // Operator changed their mind after archiving. The probe must not
    // reject — Phase 5c's confirmed handler will unarchive as part of
    // the swap.
    const proj = upsertProject('P', '/projects/p');
    createMultiAgentSession('a-1', 'orchestrator', '003');
    endMultiAgentSession('a-1', 'crashed');
    archiveMultiAgentSession('a-1');
    addParticipant('a-1', proj.id, 'worker', null);

    await executeReopenSessionProbe({
      sessionId: 'a-1',
      send: captureSend,
      computeDiff: stubComputeDiff,
    });

    expect(sent[0]?.type).toBe('reopen_session_confirm_required');
  });

  test('completed sessions are reopenable too (not just crashed)', async () => {
    // The verb is "bring this finished session back to active" — the
    // operator might want to resume a completed run with a follow-up.
    const proj = upsertProject('Done', '/projects/done');
    createMultiAgentSession('done-1', 'orchestrator', '004');
    endMultiAgentSession('done-1', 'completed');
    addParticipant('done-1', proj.id, 'worker', null);

    await executeReopenSessionProbe({
      sessionId: 'done-1',
      send: captureSend,
      computeDiff: stubComputeDiff,
    });

    expect(sent[0]?.type).toBe('reopen_session_confirm_required');
  });
});

describe('executeReopenSessionProbe — failure cases', () => {
  test('unknown sessionId → reopen_session_failed reason:not_found', async () => {
    await executeReopenSessionProbe({
      sessionId: 'never-existed',
      send: captureSend,
      computeDiff: stubComputeDiff,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'reopen_session_failed',
      sessionId: 'never-existed',
      reason: 'not_found',
      message: 'No such multi-agent session never-existed',
    });
    expect(stubComputeDiff).not.toHaveBeenCalled();
  });

  test('running session → reopen_session_failed reason:still_running', async () => {
    const proj = upsertProject('Live', '/projects/live');
    createMultiAgentSession('live-1', 'orchestrator', '005');
    addParticipant('live-1', proj.id, 'worker', null);
    // Status stays 'running'.

    await executeReopenSessionProbe({
      sessionId: 'live-1',
      send: captureSend,
      computeDiff: stubComputeDiff,
    });

    expect(sent).toEqual([
      {
        type: 'reopen_session_failed',
        sessionId: 'live-1',
        reason: 'still_running',
        message: 'This session is still running — there is nothing to reopen.',
      },
    ]);
    expect(stubComputeDiff).not.toHaveBeenCalled();
  });

  test('session with no participants → reopen_session_failed reason:no_participant', async () => {
    // Could happen for pre-participant-tracking rows or after every
    // project gets deleted between session start and now.
    createMultiAgentSession('orphan-1', 'orchestrator', '006');
    endMultiAgentSession('orphan-1', 'crashed');

    await executeReopenSessionProbe({
      sessionId: 'orphan-1',
      send: captureSend,
      computeDiff: stubComputeDiff,
    });

    expect(sent[0]).toMatchObject({
      type: 'reopen_session_failed',
      sessionId: 'orphan-1',
      reason: 'no_participant',
    });
    expect(stubComputeDiff).not.toHaveBeenCalled();
  });

  test('session with all participant projects deleted → no_participant', async () => {
    // Add a participant, then delete the project row. The resolved
    // participants query JOINs projects; missing project rows drop the
    // participant from the result.
    const proj = upsertProject('Doomed', '/projects/doomed');
    createMultiAgentSession('orph-2', 'orchestrator', '007');
    endMultiAgentSession('orph-2', 'crashed');
    addParticipant('orph-2', proj.id, 'worker', null);
    // Hard-delete the project row.
    getDb().prepare('DELETE FROM projects WHERE id = ?').run(proj.id);

    await executeReopenSessionProbe({
      sessionId: 'orph-2',
      send: captureSend,
      computeDiff: stubComputeDiff,
    });

    expect(sent[0]?.type).toBe('reopen_session_failed');
    expect((sent[0] as { reason: string }).reason).toBe('no_participant');
  });
});

describe('executeReopenSessionProbe — diff forwarding', () => {
  test('non-git project surfaces fullDiffAvailable:false through to the reply', async () => {
    // Real downstream consumers (the modal) gate the typed-confirmation
    // requirement on either filesChanged>0 OR !fullDiffAvailable — so
    // the handler MUST forward the latter unchanged.
    const proj = upsertProject('Nogit', '/tmp/no-git');
    createMultiAgentSession('ng-1', 'orchestrator', '008');
    endMultiAgentSession('ng-1', 'crashed');
    addParticipant('ng-1', proj.id, 'worker', null);

    const emptyDiff: WorkspaceDiff = {
      filesChanged: 0,
      filesAdded: 0,
      filesDeleted: 0,
      sampleChanges: [],
      fullDiffAvailable: false,
    };
    const stub = vi.fn(async () => emptyDiff);

    await executeReopenSessionProbe({
      sessionId: 'ng-1',
      send: captureSend,
      computeDiff: stub,
    });

    expect(sent[0]).toMatchObject({
      type: 'reopen_session_confirm_required',
      workspaceDiff: { fullDiffAvailable: false, filesChanged: 0 },
    });
  });

  test('uses the default computeWorkspaceDiff when no override supplied', async () => {
    // Defensive: the handler must fall back to the real implementation
    // when no test stub is injected. We point it at a /tmp path (which
    // is not a git repo) so the real computer returns fullDiffAvailable:false
    // without flaking on the host's git state.
    const realPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-reopen-real-'));
    const proj = upsertProject('Real', realPath);
    createMultiAgentSession('real-1', 'orchestrator', '009');
    endMultiAgentSession('real-1', 'crashed');
    addParticipant('real-1', proj.id, 'worker', null);

    await executeReopenSessionProbe({
      sessionId: 'real-1',
      send: captureSend,
      // no computeDiff override — exercises the real export
    });

    expect(sent[0]?.type).toBe('reopen_session_confirm_required');
    expect((sent[0] as { workspaceDiff: WorkspaceDiff }).workspaceDiff.fullDiffAvailable).toBe(
      false,
    );

    fs.rmSync(realPath, { recursive: true, force: true });
  });
});
