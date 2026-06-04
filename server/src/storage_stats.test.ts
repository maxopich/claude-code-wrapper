import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ServerMsg } from '@cebab/shared';
import { config } from './config.js';
import { closeDb, getDb } from './db.js';
import { upsertProject } from './repo/projects.js';
import { createSession } from './repo/sessions.js';
import { setSetting } from './repo/settings.js';
import {
  LAST_PURGE_AT_KEY,
  LAST_PURGE_COUNT_KEY,
  SESSION_PURGE_AFTER_MS,
  SESSION_PURGE_INTERVAL_MS,
} from './bulk_session_op.js';
import {
  STORAGE_STAT_TABLES,
  computeDbSizeBytes,
  computeLogsDirSizeBytes,
  computeTableStats,
  executeStorageStats,
} from './storage_stats.js';

// P0-C part 2 (retention VISIBILITY): coverage for the read-only storage-stats
// executor. Real SQLite under a tmp ~/.cebab so COUNT(*) + the DB-file stat run
// through production paths; JSONL files are written by hand to size the logs
// dir. Same temp-DB harness as bulk_session_op.test.ts.

let tmpRoot: string;
let originalDataDir: string;
let sent: ServerMsg[];

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-storage-stats-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.logsDir, { recursive: true });
  closeDb();
  getDb(); // applies migrations from scratch
  sent = [];
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function seedSessions(ids: string[]): void {
  const proj = upsertProject('p', path.join(tmpRoot, 'p'));
  for (const id of ids) createSession(id, proj.id);
}

function insertEventRow(sessionId: string, seq: number): void {
  getDb()
    .prepare(
      `INSERT INTO events (session_id, seq, ts, type, subtype, raw) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(sessionId, seq, seq, 'system', 'init', '{}');
}

function lastStats(): Extract<ServerMsg, { type: 'storage_stats' }> {
  const msg = sent.at(-1);
  if (!msg || msg.type !== 'storage_stats') throw new Error('no storage_stats reply captured');
  return msg;
}

describe('computeTableStats', () => {
  test('returns row counts for every allowlisted table in fixed order', () => {
    seedSessions(['s1', 's2', 's3']);
    insertEventRow('s1', 1);
    insertEventRow('s1', 2);

    const stats = computeTableStats();

    expect(stats.map((s) => s.table)).toEqual([...STORAGE_STAT_TABLES]);
    const byTable = Object.fromEntries(stats.map((s) => [s.table, s.rows]));
    expect(byTable.sessions).toBe(3);
    expect(byTable.events).toBe(2);
    expect(byTable.notifications).toBe(0);
  });
});

describe('computeDbSizeBytes', () => {
  test('is positive and at least the main DB file size', () => {
    seedSessions(['s1']);
    const dbSize = computeDbSizeBytes();
    expect(dbSize).toBeGreaterThan(0);
    // Sidecars (-wal/-shm) only add to the total, so the sum is never smaller
    // than the main file alone.
    expect(dbSize).toBeGreaterThanOrEqual(fs.statSync(config.dbPath).size);
  });
});

describe('computeLogsDirSizeBytes', () => {
  test('sums the per-session JSONL files', () => {
    fs.writeFileSync(path.join(config.logsDir, 'a.jsonl'), 'x'.repeat(100));
    fs.writeFileSync(path.join(config.logsDir, 'b.jsonl'), 'y'.repeat(50));
    expect(computeLogsDirSizeBytes()).toBe(150);
  });

  test('returns 0 when the logs dir does not exist', () => {
    fs.rmSync(config.logsDir, { recursive: true, force: true });
    expect(computeLogsDirSizeBytes()).toBe(0);
  });
});

describe('executeStorageStats', () => {
  test('sends one storage_stats envelope with sizes, counts, and cadence echo', () => {
    seedSessions(['s1', 's2']);
    insertEventRow('s1', 1);
    fs.writeFileSync(path.join(config.logsDir, 's1.jsonl'), 'z'.repeat(42));

    executeStorageStats({ send: (m) => sent.push(m) });

    expect(sent).toHaveLength(1);
    const stats = lastStats();
    expect(stats.dbSizeBytes).toBeGreaterThan(0);
    expect(stats.logsDirSizeBytes).toBe(42);
    expect(stats.purgeIntervalMs).toBe(SESSION_PURGE_INTERVAL_MS);
    expect(stats.purgeAfterMs).toBe(SESSION_PURGE_AFTER_MS);
    const byTable = Object.fromEntries(stats.tableStats.map((s) => [s.table, s.rows]));
    expect(byTable.sessions).toBe(2);
    expect(byTable.events).toBe(1);
  });

  test('passes the purge heartbeat through (null until the cron runs)', () => {
    executeStorageStats({ send: (m) => sent.push(m) });
    expect(lastStats().lastPurgeAt).toBeNull();
    expect(lastStats().lastPurgeCount).toBeNull();

    sent = [];
    setSetting<number>(LAST_PURGE_AT_KEY, 1_700_000_000_000);
    setSetting<number>(LAST_PURGE_COUNT_KEY, 4);
    executeStorageStats({ send: (m) => sent.push(m) });
    expect(lastStats().lastPurgeAt).toBe(1_700_000_000_000);
    expect(lastStats().lastPurgeCount).toBe(4);
  });
});
