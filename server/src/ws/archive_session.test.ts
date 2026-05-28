import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ServerMsg } from '@cebab/shared';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import {
  archiveMultiAgentSession,
  createMultiAgentSession,
  endMultiAgentSession,
  getMultiAgentSession,
} from '../repo/multi_agent.js';
import { listForSession } from '../repo/recovery_log.js';
import { executeArchiveSession } from './server.js';

// Cluster D Phase 5 (spec §6.4, BE-D22 / BE-D23 / BE-D24): server-side
// coverage for the `archive_session` handler.
//
// We exercise `executeArchiveSession` directly (the WS case body is a
// thin wrapper around it — same testability pattern as
// `resolveRetryRateLimited` for retry_rate_limited). The fixture spins
// up a real SQLite under a tmp `~/.cebab` so the archive helper +
// recovery_log writes go through the production code paths.

let tmpRoot: string;
let originalDataDir: string;
let sent: ServerMsg[];

function captureSend(msg: ServerMsg): void {
  sent.push(msg);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-archive-session-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb(); // runs all migrations including 017 + 018
  sent = [];
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('executeArchiveSession — happy path', () => {
  test('flips archived=1 + sends iteration_archived', async () => {
    createMultiAgentSession('sweep-1', 'orchestrator', '001');
    endMultiAgentSession('sweep-1', 'crashed');

    await executeArchiveSession({
      sessionId: 'sweep-1',
      removeArtifacts: false,
      send: captureSend,
    });

    // Row got flipped.
    const row = getMultiAgentSession('sweep-1');
    expect(row?.archived).toBe(1);

    // Reply envelope.
    expect(sent).toEqual([
      { type: 'iteration_archived', sessionId: 'sweep-1', removedArtifacts: false },
    ]);
  });

  test('orchestrator-mode crash archive writes recovery_log with failure_class=sweep', async () => {
    // Phase 7: the failure_class branch is mode-aware. An orchestrator
    // row in crashed status reads as "sweep-driven archive" — the
    // common case where a newer iteration auto-swept the older one.
    createMultiAgentSession('sweep-2', 'orchestrator', '002');
    endMultiAgentSession('sweep-2', 'crashed');

    await executeArchiveSession({
      sessionId: 'sweep-2',
      removeArtifacts: false,
      send: captureSend,
    });

    const rows = listForSession('sweep-2');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: 'sweep-2',
      failure_class: 'sweep',
      operator_action: 'archive',
    });
  });

  test('chain-mode crash archive writes recovery_log with failure_class=chain_crash', async () => {
    // Cluster D Phase 7: archiving a chain-mode row that ended in
    // 'crashed' status is by definition a chain-reconstruction-failure
    // archive (the operator hit Resume on a swept-restart chain row,
    // got the chain_not_reconstructed toast, and clicked its Archive
    // action). The recovery_log row uses failure_class='chain_crash'
    // so spec §8.5's aggregateByClass tallies chain crashes separately
    // from the common sweep-archive flow. The mode + crashed pair is
    // the cleanest signal — no protocol additions needed.
    createMultiAgentSession('chain-1', 'chain', '003');
    endMultiAgentSession('chain-1', 'crashed');

    await executeArchiveSession({
      sessionId: 'chain-1',
      removeArtifacts: false,
      send: captureSend,
    });

    const rows = listForSession('chain-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: 'chain-1',
      failure_class: 'chain_crash',
      operator_action: 'archive',
    });
  });

  test('chain-mode but COMPLETED status uses failure_class=sweep (not a crash)', async () => {
    // Defensive: the chain_crash discriminant is the (mode='chain' AND
    // status='crashed') AND. A chain that finished cleanly and the
    // operator just wants to archive doesn't count as a chain crash.
    createMultiAgentSession('chain-done', 'chain', '004');
    endMultiAgentSession('chain-done', 'completed');

    await executeArchiveSession({
      sessionId: 'chain-done',
      removeArtifacts: false,
      send: captureSend,
    });

    const rows = listForSession('chain-done');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: 'chain-done',
      failure_class: 'sweep',
      operator_action: 'archive',
    });
  });

  test('completed (not crashed) sessions are also archivable', async () => {
    // The spec ties archive to the swept-session toast, but the verb
    // itself is "remove a finished session from the iterations list"
    // — `completed` and `stopped` are equally valid candidates.
    createMultiAgentSession('done-1', 'chain', '003');
    endMultiAgentSession('done-1', 'completed');

    await executeArchiveSession({
      sessionId: 'done-1',
      removeArtifacts: false,
      send: captureSend,
    });

    expect(getMultiAgentSession('done-1')?.archived).toBe(1);
    expect(sent[0]).toMatchObject({ type: 'iteration_archived', sessionId: 'done-1' });
  });
});

describe('executeArchiveSession — guards', () => {
  test('unknown sessionId → wrapper_error, no DB change', async () => {
    await executeArchiveSession({
      sessionId: 'never-existed',
      removeArtifacts: false,
      send: captureSend,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'wrapper_error',
      sessionId: 'never-existed',
      kind: 'process_crashed',
    });
    // No recovery_log row was written for the failed call.
    expect(listForSession('never-existed')).toEqual([]);
  });

  test('running session → wrapper_error, row not archived', async () => {
    createMultiAgentSession('live-1', 'orchestrator', '004');
    // Status starts as 'running'; do NOT end it.
    expect(getMultiAgentSession('live-1')?.status).toBe('running');

    await executeArchiveSession({
      sessionId: 'live-1',
      removeArtifacts: false,
      send: captureSend,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'wrapper_error',
      sessionId: 'live-1',
      kind: 'process_crashed',
    });
    // Row stayed running + un-archived; no recovery_log row written.
    const row = getMultiAgentSession('live-1');
    expect(row?.status).toBe('running');
    expect(row?.archived).toBe(0);
    expect(listForSession('live-1')).toEqual([]);
  });

  test('already-archived session → still returns iteration_archived (idempotent)', async () => {
    createMultiAgentSession('dup-1', 'chain', '005');
    endMultiAgentSession('dup-1', 'crashed');
    archiveMultiAgentSession('dup-1');
    expect(getMultiAgentSession('dup-1')?.archived).toBe(1);

    await executeArchiveSession({
      sessionId: 'dup-1',
      removeArtifacts: false,
      send: captureSend,
    });

    // The repository helper's second-archive returns false (0 rows
    // changed), but the handler still ships the success envelope so a
    // duplicated client click resolves cleanly. The row is still
    // archived.
    expect(sent).toEqual([
      { type: 'iteration_archived', sessionId: 'dup-1', removedArtifacts: false },
    ]);
    expect(getMultiAgentSession('dup-1')?.archived).toBe(1);
  });
});

describe('executeArchiveSession — removeArtifacts', () => {
  test('removeArtifacts=true rm-rfs the session_folder + reports removedArtifacts:true', async () => {
    const folder = fs.mkdtempSync(path.join(tmpRoot, 'session-folder-'));
    fs.writeFileSync(path.join(folder, 'transcript.jsonl'), 'pretend transcript\n');
    expect(fs.existsSync(folder)).toBe(true);

    createMultiAgentSession('wipe-1', 'orchestrator', '006', folder, 'temp');
    endMultiAgentSession('wipe-1', 'crashed');

    await executeArchiveSession({
      sessionId: 'wipe-1',
      removeArtifacts: true,
      send: captureSend,
    });

    // Folder is gone, row is archived, envelope reports removedArtifacts:true.
    expect(fs.existsSync(folder)).toBe(false);
    expect(getMultiAgentSession('wipe-1')?.archived).toBe(1);
    expect(sent).toEqual([
      { type: 'iteration_archived', sessionId: 'wipe-1', removedArtifacts: true },
    ]);
  });

  test('removeArtifacts=true with null session_folder → no rm attempted, removedArtifacts:false', async () => {
    // Pre-007 rows (or chain sessions in some legacy paths) can have
    // session_folder=null. The handler must not throw — just return
    // removedArtifacts:false alongside the successful archive.
    createMultiAgentSession('no-folder', 'chain', '007', null);
    endMultiAgentSession('no-folder', 'crashed');

    await executeArchiveSession({
      sessionId: 'no-folder',
      removeArtifacts: true,
      send: captureSend,
    });

    expect(getMultiAgentSession('no-folder')?.archived).toBe(1);
    expect(sent).toEqual([
      { type: 'iteration_archived', sessionId: 'no-folder', removedArtifacts: false },
    ]);
  });

  test('removeArtifacts=false leaves the folder on disk', async () => {
    const folder = fs.mkdtempSync(path.join(tmpRoot, 'keep-folder-'));
    fs.writeFileSync(path.join(folder, 'transcript.jsonl'), 'preserve me\n');
    createMultiAgentSession('keep-1', 'orchestrator', '008', folder, 'persistent');
    endMultiAgentSession('keep-1', 'completed');

    await executeArchiveSession({
      sessionId: 'keep-1',
      removeArtifacts: false,
      send: captureSend,
    });

    // Default (removeArtifacts=false) leaves disk untouched — same
    // contract as `clear_iterations`. Row still flipped.
    expect(fs.existsSync(folder)).toBe(true);
    expect(fs.existsSync(path.join(folder, 'transcript.jsonl'))).toBe(true);
    expect(getMultiAgentSession('keep-1')?.archived).toBe(1);
    expect(sent[0]).toMatchObject({
      type: 'iteration_archived',
      sessionId: 'keep-1',
      removedArtifacts: false,
    });
  });

  test('removeArtifacts=true with non-existent folder → no throw, removedArtifacts:true (force flag)', async () => {
    // `force: true` on fsp.rm makes a missing target a no-op. The
    // handler reports removedArtifacts:true because the call completed
    // without error — there's nothing left on disk after the attempt,
    // which is the intent.
    const ghostFolder = path.join(tmpRoot, 'ghost-folder-does-not-exist');
    createMultiAgentSession('ghost-1', 'orchestrator', '009', ghostFolder, 'temp');
    endMultiAgentSession('ghost-1', 'crashed');

    await executeArchiveSession({
      sessionId: 'ghost-1',
      removeArtifacts: true,
      send: captureSend,
    });

    expect(getMultiAgentSession('ghost-1')?.archived).toBe(1);
    expect(sent[0]).toMatchObject({
      type: 'iteration_archived',
      sessionId: 'ghost-1',
      removedArtifacts: true,
    });
  });
});
