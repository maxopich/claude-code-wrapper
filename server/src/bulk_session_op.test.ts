import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ServerMsg } from '@cebab/shared';
import { config } from './config.js';
import { closeDb, getDb } from './db.js';
import { upsertProject } from './repo/projects.js';
import {
  createSession,
  getSession,
  listSessionsForProject,
  listSoftDeletedSessionsOlderThan,
} from './repo/sessions.js';
import { registerQuery } from './runner/lifecycle.js';
import {
  executeBulkSessionOp,
  runSessionPurge,
  SESSION_PURGE_AFTER_MS,
} from './bulk_session_op.js';

// Cluster I Phase C5 (UI_Findings spec §4.3): server-side coverage for
// the `bulk_session_op` handler + the 7-day soft-delete purge cron.
//
// We hit `executeBulkSessionOp` directly (the WS case body is a thin
// delegate — same testability pattern as `executeArchiveSession`).
// The fixture spins a real SQLite under a tmp `~/.cebab` so the
// `archive_session` / `soft_delete_session` / `safety_audit` writes
// all flow through production code paths.

let tmpRoot: string;
let originalDataDir: string;
let sent: ServerMsg[];

function captureSend(msg: ServerMsg): void {
  sent.push(msg);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-bulk-session-op-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  // The handler reads `config.logsDir` (a getter off dataDir) so the
  // overridden dataDir cascades automatically. Make sure the dir
  // exists so the rm path doesn't fail on the parent missing — `fs.rm`
  // with `force: true` swallows ENOENT on the file itself but a missing
  // parent directory is a different (and rarer) failure.
  fs.mkdirSync(config.logsDir, { recursive: true });
  closeDb();
  getDb(); // applies 001..025
  sent = [];
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function setupProjectWithSessions(ids: string[]): number {
  const proj = upsertProject('p', path.join(tmpRoot, 'p'));
  for (const id of ids) createSession(id, proj.id);
  return proj.id;
}

// ---- archive ----

describe('executeBulkSessionOp — archive', () => {
  test('flips archived=1 for all ids + replies with succeededSessionIds', async () => {
    setupProjectWithSessions(['s1', 's2', 's3']);

    await executeBulkSessionOp({
      msg: { type: 'bulk_session_op', sessionIds: ['s1', 's2', 's3'], op: 'archive' },
      send: captureSend,
    });

    expect(getSession('s1')?.archived).toBe(1);
    expect(getSession('s2')?.archived).toBe(1);
    expect(getSession('s3')?.archived).toBe(1);
    expect(sent).toEqual([
      {
        type: 'bulk_session_op_result',
        op: 'archive',
        succeededSessionIds: ['s1', 's2', 's3'],
        failed: [],
        removedArtifacts: false,
      },
    ]);
  });

  test('archived rows drop out of default listSessionsForProject', async () => {
    const projectId = setupProjectWithSessions(['s1', 's2']);

    await executeBulkSessionOp({
      msg: { type: 'bulk_session_op', sessionIds: ['s1'], op: 'archive' },
      send: captureSend,
    });

    const remaining = listSessionsForProject(projectId).map((r) => r.id);
    expect(remaining).toEqual(['s2']);
    const includingArchived = listSessionsForProject(projectId, { includeArchived: true }).map(
      (r) => r.id,
    );
    expect(includingArchived.sort()).toEqual(['s1', 's2']);
  });

  test('writes one safety_audit row per actual flip (kind=session.bulk_op, reason_code=archive)', async () => {
    setupProjectWithSessions(['s1', 's2']);

    await executeBulkSessionOp({
      msg: { type: 'bulk_session_op', sessionIds: ['s1', 's2'], op: 'archive' },
      send: captureSend,
    });

    const audits = getDb()
      .prepare<[], { session_id: string; kind: string; reason_code: string; payload_json: string }>(
        `SELECT session_id, kind, reason_code, payload_json
         FROM safety_audit
         WHERE kind = 'session.bulk_op'
         ORDER BY session_id ASC`,
      )
      .all();
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      session_id: 's1',
      kind: 'session.bulk_op',
      reason_code: 'archive',
    });
    const payload = JSON.parse(audits[0]!.payload_json) as Record<string, unknown>;
    expect(payload).toMatchObject({ op: 'archive', count: 2, removeArtifacts: false });
  });

  test('idempotent: already-archived sessions succeed without a new audit row', async () => {
    setupProjectWithSessions(['s1']);
    // First archive — writes one audit row.
    await executeBulkSessionOp({
      msg: { type: 'bulk_session_op', sessionIds: ['s1'], op: 'archive' },
      send: captureSend,
    });
    sent = [];
    // Second archive — must be silent at the audit layer + succeed.
    await executeBulkSessionOp({
      msg: { type: 'bulk_session_op', sessionIds: ['s1'], op: 'archive' },
      send: captureSend,
    });

    expect(sent[0]).toMatchObject({
      type: 'bulk_session_op_result',
      op: 'archive',
      succeededSessionIds: ['s1'],
      failed: [],
    });
    const audits = getDb()
      .prepare<
        [],
        { n: number }
      >(`SELECT COUNT(*) AS n FROM safety_audit WHERE kind = 'session.bulk_op'`)
      .get();
    expect(audits?.n).toBe(1);
  });
});

// ---- soft-delete ----

describe('executeBulkSessionOp — delete', () => {
  test('stamps deleted_at + reply contains succeededSessionIds', async () => {
    setupProjectWithSessions(['s1', 's2']);

    const before = Date.now();
    await executeBulkSessionOp({
      msg: { type: 'bulk_session_op', sessionIds: ['s1', 's2'], op: 'delete' },
      send: captureSend,
    });
    const after = Date.now();

    const s1 = getSession('s1');
    const s2 = getSession('s2');
    expect(s1?.deleted_at).not.toBeNull();
    expect(s2?.deleted_at).not.toBeNull();
    expect(s1!.deleted_at!).toBeGreaterThanOrEqual(before);
    expect(s1!.deleted_at!).toBeLessThanOrEqual(after);
    expect(sent[0]).toMatchObject({
      type: 'bulk_session_op_result',
      op: 'delete',
      succeededSessionIds: ['s1', 's2'],
      failed: [],
      removedArtifacts: false,
    });
  });

  test('soft-deleted rows drop out of listSessionsForProject (incl. includeArchived)', async () => {
    const projectId = setupProjectWithSessions(['s1', 's2']);

    await executeBulkSessionOp({
      msg: { type: 'bulk_session_op', sessionIds: ['s1'], op: 'delete' },
      send: captureSend,
    });

    const def = listSessionsForProject(projectId).map((r) => r.id);
    const inc = listSessionsForProject(projectId, { includeArchived: true }).map((r) => r.id);
    expect(def).toEqual(['s2']);
    // Soft-deleted is excluded even from the includeArchived list — there
    // is intentionally no recovery surface from the listing path.
    expect(inc).toEqual(['s2']);
  });

  test('removeArtifacts:true rm-rfs the JSONL log + replies removedArtifacts:true', async () => {
    setupProjectWithSessions(['s1']);
    const logPath = path.join(config.logsDir, 's1.jsonl');
    fs.writeFileSync(logPath, '{"some":"line"}\n');

    await executeBulkSessionOp({
      msg: {
        type: 'bulk_session_op',
        sessionIds: ['s1'],
        op: 'delete',
        removeArtifacts: true,
      },
      send: captureSend,
    });

    expect(fs.existsSync(logPath)).toBe(false);
    expect(sent[0]).toMatchObject({ op: 'delete', removedArtifacts: true });
  });

  test('removeArtifacts:true with a missing log file is silent + still flips DB', async () => {
    setupProjectWithSessions(['s1']);
    // No JSONL written — emulates the "session never produced events" path.

    await executeBulkSessionOp({
      msg: {
        type: 'bulk_session_op',
        sessionIds: ['s1'],
        op: 'delete',
        removeArtifacts: true,
      },
      send: captureSend,
    });

    // The soft-delete still landed; `removedArtifacts` is false because
    // no file existed to rm (fs.rm with force:true returns silently).
    expect(getSession('s1')?.deleted_at).not.toBeNull();
    expect(sent[0]).toMatchObject({ op: 'delete', removedArtifacts: false });
  });

  test('writes safety_audit row carrying removeArtifacts in payload', async () => {
    setupProjectWithSessions(['s1']);
    const logPath = path.join(config.logsDir, 's1.jsonl');
    fs.writeFileSync(logPath, 'x\n');

    await executeBulkSessionOp({
      msg: {
        type: 'bulk_session_op',
        sessionIds: ['s1'],
        op: 'delete',
        removeArtifacts: true,
      },
      send: captureSend,
    });

    const payload = JSON.parse(
      getDb()
        .prepare<
          [],
          { payload_json: string }
        >(`SELECT payload_json FROM safety_audit WHERE kind = 'session.bulk_op' LIMIT 1`)
        .get()!.payload_json,
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({ op: 'delete', count: 1, removeArtifacts: true });
  });

  test('idempotent: re-deleting an already-soft-deleted row succeeds without a new audit', async () => {
    setupProjectWithSessions(['s1']);
    await executeBulkSessionOp({
      msg: { type: 'bulk_session_op', sessionIds: ['s1'], op: 'delete' },
      send: captureSend,
    });
    sent = [];
    await executeBulkSessionOp({
      msg: { type: 'bulk_session_op', sessionIds: ['s1'], op: 'delete' },
      send: captureSend,
    });

    expect(sent[0]).toMatchObject({
      op: 'delete',
      succeededSessionIds: ['s1'],
      failed: [],
    });
    const audits = getDb()
      .prepare<
        [],
        { n: number }
      >(`SELECT COUNT(*) AS n FROM safety_audit WHERE kind = 'session.bulk_op'`)
      .get();
    expect(audits?.n).toBe(1);
  });

  test('removeArtifacts is ignored for op=archive (archive never touches disk)', async () => {
    setupProjectWithSessions(['s1']);
    const logPath = path.join(config.logsDir, 's1.jsonl');
    fs.writeFileSync(logPath, 'x\n');

    await executeBulkSessionOp({
      msg: {
        type: 'bulk_session_op',
        sessionIds: ['s1'],
        op: 'archive',
        // The wire carries removeArtifacts even on archive — server
        // ignores it for the archive op.
        removeArtifacts: true,
      },
      send: captureSend,
    });

    expect(fs.existsSync(logPath)).toBe(true);
    expect(sent[0]).toMatchObject({ op: 'archive', removedArtifacts: false });
  });
});

// ---- guards ----

describe('executeBulkSessionOp — guards', () => {
  test('running session is rejected with reason="running"', async () => {
    setupProjectWithSessions(['s1', 's2']);
    // Pretend s1 is mid-turn — register a fake query carrying that id.
    const unregister = registerQuery(
      {},
      { sessionId: 's1', kind: 'single', startedAt: Date.now() },
    );

    try {
      await executeBulkSessionOp({
        msg: { type: 'bulk_session_op', sessionIds: ['s1', 's2'], op: 'archive' },
        send: captureSend,
      });
    } finally {
      unregister();
    }

    const reply = sent[0] as Extract<ServerMsg, { type: 'bulk_session_op_result' }>;
    expect(reply.succeededSessionIds).toEqual(['s2']);
    expect(reply.failed).toHaveLength(1);
    expect(reply.failed[0]).toMatchObject({ sessionId: 's1', reason: 'running' });
    // s1 was NOT archived.
    expect(getSession('s1')?.archived).toBe(0);
    expect(getSession('s2')?.archived).toBe(1);
  });

  test('unknown session id is rejected with reason="unknown"', async () => {
    setupProjectWithSessions(['s1']);

    await executeBulkSessionOp({
      msg: { type: 'bulk_session_op', sessionIds: ['unknown', 's1'], op: 'delete' },
      send: captureSend,
    });

    const reply = sent[0] as Extract<ServerMsg, { type: 'bulk_session_op_result' }>;
    expect(reply.succeededSessionIds).toEqual(['s1']);
    expect(reply.failed).toHaveLength(1);
    expect(reply.failed[0]).toMatchObject({ sessionId: 'unknown', reason: 'unknown' });
    // No safety_audit row was written for the unknown id.
    const audits = getDb()
      .prepare<
        [],
        { n: number }
      >(`SELECT COUNT(*) AS n FROM safety_audit WHERE kind = 'session.bulk_op'`)
      .get();
    expect(audits?.n).toBe(1);
  });

  test('empty sessionIds replies with empty success envelope', async () => {
    setupProjectWithSessions(['s1']);

    await executeBulkSessionOp({
      msg: { type: 'bulk_session_op', sessionIds: [], op: 'archive' },
      send: captureSend,
    });

    expect(sent[0]).toEqual({
      type: 'bulk_session_op_result',
      op: 'archive',
      succeededSessionIds: [],
      failed: [],
      removedArtifacts: false,
    });
    // No row was archived.
    expect(getSession('s1')?.archived).toBe(0);
  });
});

// ---- purge cron ----

describe('runSessionPurge', () => {
  test('hard-deletes rows whose deleted_at is older than 7d, leaves recent ones', async () => {
    setupProjectWithSessions(['old', 'recent', 'never-deleted']);
    const now = Date.now();
    // Manually stamp deleted_at so we don't have to wait 7 days.
    getDb()
      .prepare(`UPDATE sessions SET deleted_at = ? WHERE id = ?`)
      .run(now - SESSION_PURGE_AFTER_MS - 1000, 'old');
    getDb()
      .prepare(`UPDATE sessions SET deleted_at = ? WHERE id = ?`)
      .run(now - 60_000, 'recent');

    const purged = await runSessionPurge(now);

    expect(purged).toBe(1);
    expect(getSession('old')).toBeUndefined();
    expect(getSession('recent')).toBeDefined();
    expect(getSession('never-deleted')).toBeDefined();
  });

  test('cascade-deletes events for purged rows, leaves events of survivors', async () => {
    setupProjectWithSessions(['old', 'recent']);
    const db = getDb();
    db.prepare(
      `INSERT INTO events (session_id, seq, ts, type, subtype, raw) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('old', 1, 1, 'system', 'init', '{}');
    db.prepare(
      `INSERT INTO events (session_id, seq, ts, type, subtype, raw) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('recent', 1, 1, 'system', 'init', '{}');
    const now = Date.now();
    db.prepare(`UPDATE sessions SET deleted_at = ? WHERE id = ?`).run(
      now - SESSION_PURGE_AFTER_MS - 1000,
      'old',
    );

    await runSessionPurge(now);

    const oldEvents = db
      .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM events WHERE session_id = 'old'`)
      .get();
    const recentEvents = db
      .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM events WHERE session_id = 'recent'`)
      .get();
    expect(oldEvents?.n).toBe(0);
    expect(recentEvents?.n).toBe(1);
  });

  test('purge rm-rfs the JSONL log if present, silent on missing', async () => {
    setupProjectWithSessions(['old', 'no-log']);
    const oldLog = path.join(config.logsDir, 'old.jsonl');
    fs.writeFileSync(oldLog, 'something\n');
    const now = Date.now();
    getDb()
      .prepare(`UPDATE sessions SET deleted_at = ? WHERE id = ?`)
      .run(now - SESSION_PURGE_AFTER_MS - 1000, 'old');
    getDb()
      .prepare(`UPDATE sessions SET deleted_at = ? WHERE id = ?`)
      .run(now - SESSION_PURGE_AFTER_MS - 1000, 'no-log');

    const purged = await runSessionPurge(now);

    expect(purged).toBe(2);
    expect(fs.existsSync(oldLog)).toBe(false);
  });

  test('purge PRESERVES safety_audit rows (spec §7 invariant)', async () => {
    // Soft-delete via the handler so audit rows actually get written.
    setupProjectWithSessions(['s1']);
    await executeBulkSessionOp({
      msg: { type: 'bulk_session_op', sessionIds: ['s1'], op: 'delete' },
      send: captureSend,
    });
    // Re-stamp deleted_at to make it eligible for purge.
    const now = Date.now();
    getDb()
      .prepare(`UPDATE sessions SET deleted_at = ? WHERE id = ?`)
      .run(now - SESSION_PURGE_AFTER_MS - 1000, 's1');

    await runSessionPurge(now);

    // Session is gone but the audit row survives.
    expect(getSession('s1')).toBeUndefined();
    const audits = getDb()
      .prepare<
        [],
        { n: number }
      >(`SELECT COUNT(*) AS n FROM safety_audit WHERE session_id = 's1' AND kind = 'session.bulk_op'`)
      .get();
    expect(audits?.n).toBe(1);
  });

  test('listSoftDeletedSessionsOlderThan returns ids sorted by deleted_at ASC', () => {
    setupProjectWithSessions(['middle', 'newest', 'oldest']);
    const now = Date.now();
    getDb()
      .prepare(`UPDATE sessions SET deleted_at = ? WHERE id = ?`)
      .run(now - 1000, 'newest');
    getDb()
      .prepare(`UPDATE sessions SET deleted_at = ? WHERE id = ?`)
      .run(now - 100_000, 'middle');
    getDb()
      .prepare(`UPDATE sessions SET deleted_at = ? WHERE id = ?`)
      .run(now - 999_999, 'oldest');

    const ids = listSoftDeletedSessionsOlderThan(now);
    expect(ids).toEqual(['oldest', 'middle', 'newest']);
  });
});
