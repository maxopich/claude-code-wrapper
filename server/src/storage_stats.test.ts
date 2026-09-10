import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ServerMsg } from '@cebab/shared';
import { config } from './config.js';
import { closeDb, getDb } from './db.js';
import { upsertProject } from './repo/projects.js';
import { createSession } from './repo/sessions.js';
import { setSetting } from './repo/settings.js';
import {
  LAST_AUTO_RECLAIM_AT_KEY,
  LAST_AUTO_RECLAIM_COUNT_KEY,
  LAST_PURGE_AT_KEY,
  LAST_PURGE_COUNT_KEY,
  SESSION_PURGE_AFTER_MS,
  SESSION_PURGE_INTERVAL_MS,
} from './bulk_session_op.js';
import {
  STORAGE_STAT_TABLES,
  computeDbSizeBytes,
  computeLogsDirSizeBytes,
  computeManagedAgentsSize,
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

// Cebab-6fax.43.3: the managed-agent trees under `<dataDir>/agents/` are the
// feature that deliberately makes gigabyte-scale copies, so their size is what
// an operator watches. A tree over the entry budget must report TRUNCATED (a
// floor), never a silently-smaller number; a control under the budget counts
// exactly.
describe('computeManagedAgentsSize', () => {
  function makeAgentFile(slug: string, rel: string, bytes: number): void {
    const abs = path.join(config.dataDir, 'agents', slug, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'x'.repeat(bytes));
  }

  test('sums every managed tree exactly when under the entry budget', async () => {
    makeAgentFile('alpha', 'a.txt', 100);
    makeAgentFile('alpha', 'src/b.txt', 50);
    makeAgentFile('beta', 'c.txt', 30);

    const res = await computeManagedAgentsSize();
    expect(res.truncated).toBe(false);
    expect(res.bytes).toBe(180);
  });

  test('reports 0 and not truncated when no managed agents exist', async () => {
    const res = await computeManagedAgentsSize();
    expect(res).toEqual({ bytes: 0, truncated: false });
  });

  test('a tree that exceeds the entry budget reports truncated, not a smaller number', async () => {
    // Six entries (two slug dirs + four files) against a budget of 2: the walk
    // stops early, so the reported byte total is a floor and `truncated` says so.
    for (let i = 0; i < 4; i++) makeAgentFile(`slug${i}`, `f${i}.txt`, 1000);

    const capped = await computeManagedAgentsSize(2);
    expect(capped.truncated).toBe(true);
    expect(capped.bytes).toBeLessThan(4000); // did not count the whole tree

    // Same tree under a generous budget counts every byte and is not truncated.
    const full = await computeManagedAgentsSize();
    expect(full.truncated).toBe(false);
    expect(full.bytes).toBe(4000);
  });
});

describe('executeStorageStats', () => {
  test('sends one storage_stats envelope with sizes, counts, and cadence echo', async () => {
    seedSessions(['s1', 's2']);
    insertEventRow('s1', 1);
    fs.writeFileSync(path.join(config.logsDir, 's1.jsonl'), 'z'.repeat(42));

    await executeStorageStats({ send: (m) => sent.push(m) });

    expect(sent).toHaveLength(1);
    const stats = lastStats();
    expect(stats.dbSizeBytes).toBeGreaterThan(0);
    expect(stats.logsDirSizeBytes).toBe(42);
    expect(stats.managedAgentsSizeBytes).toBe(0);
    expect(stats.managedAgentsSizeTruncated).toBe(false);
    expect(stats.purgeIntervalMs).toBe(SESSION_PURGE_INTERVAL_MS);
    expect(stats.purgeAfterMs).toBe(SESSION_PURGE_AFTER_MS);
    const byTable = Object.fromEntries(stats.tableStats.map((s) => [s.table, s.rows]));
    expect(byTable.sessions).toBe(2);
    expect(byTable.events).toBe(1);
  });

  test('passes the purge heartbeat through (null until the cron runs)', async () => {
    await executeStorageStats({ send: (m) => sent.push(m) });
    expect(lastStats().lastPurgeAt).toBeNull();
    expect(lastStats().lastPurgeCount).toBeNull();
    // The executor is async now BECAUSE it also walks the managed-agent trees
    // (Cebab-6fax.43.3); every envelope carries that size, so this test pins it
    // too — otherwise the `await` above would be a no-op the revert-check can't
    // distinguish from a test that never depended on the change.
    expect(lastStats().managedAgentsSizeBytes).toBe(0);

    sent = [];
    setSetting<number>(LAST_PURGE_AT_KEY, 1_700_000_000_000);
    setSetting<number>(LAST_PURGE_COUNT_KEY, 4);
    await executeStorageStats({ send: (m) => sent.push(m) });
    expect(lastStats().lastPurgeAt).toBe(1_700_000_000_000);
    expect(lastStats().lastPurgeCount).toBe(4);
  });
});

// P0-C part 2b: the autoReclaim block on the storage_stats reply reflects
// config.autoReclaimDays (env opt-in) + the reclaim heartbeat keys.
describe('executeStorageStats — autoReclaim (P0-C part 2b)', () => {
  let savedDays: number | null;
  beforeEach(() => {
    savedDays = config.autoReclaimDays;
  });
  afterEach(() => {
    config.autoReclaimDays = savedDays;
  });

  test('off when CEBAB_AUTO_RECLAIM_DAYS is unset (config null)', async () => {
    config.autoReclaimDays = null;
    await executeStorageStats({ send: (m) => sent.push(m) });
    expect(lastStats().autoReclaim).toEqual({
      enabled: false,
      idleDays: null,
      lastRunAt: null,
      lastCount: null,
    });
    // The async managed-agent walk is why this test now awaits — pin its field
    // so the dependency is real, not incidental (see the purge test above).
    expect(lastStats().managedAgentsSizeBytes).toBe(0);
  });

  test('on with idleDays + heartbeat passthrough when enabled', async () => {
    config.autoReclaimDays = 30;
    setSetting<number>(LAST_AUTO_RECLAIM_AT_KEY, 1_700_000_000_000);
    setSetting<number>(LAST_AUTO_RECLAIM_COUNT_KEY, 2);
    await executeStorageStats({ send: (m) => sent.push(m) });
    expect(lastStats().autoReclaim).toEqual({
      enabled: true,
      idleDays: 30,
      lastRunAt: 1_700_000_000_000,
      lastCount: 2,
    });
    // Same reason as the two tests above: the `await` is load-bearing only if
    // the envelope's managed-agent size is actually asserted.
    expect(lastStats().managedAgentsSizeBytes).toBe(0);
  });
});

// Cebab-6fax.43.3 validation: the edges the first version got wrong.
describe('managed-agents size: counts honestly at the edges', () => {
  function put(rel: string, bytes: number): void {
    const abs = path.join(config.dataDir, 'agents', rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'x'.repeat(bytes));
  }
  const deepChain = (): string =>
    path.join('deep', ...Array.from({ length: 14 }, (_, i) => `d${i}`), 'bottom.txt');

  test('exactly as many entries as the budget: counted in full, NOT truncated', async () => {
    // Reddens: reading truncation off `budget.entries <= 0` after the walk -- the
    // budget lands on exactly 0 with nothing skipped, and the UI then claimed the
    // real size was larger.
    put('solo/a.txt', 100);
    put('solo/b.txt', 50); // three entries: solo/, a.txt, b.txt
    expect(await computeManagedAgentsSize(3)).toEqual({ bytes: 150, truncated: false });
    // CONTROL: one entry fewer really does skip something.
    expect((await computeManagedAgentsSize(2)).truncated).toBe(true);
  });

  test('a too-deep subtree is flagged without zeroing its siblings', async () => {
    // Result, whatever the readdir order: the too-deep file is flagged, the
    // sibling is counted. The DETERMINISTIC guard against draining the budget is
    // the dirSizeBytes test in stray_session_folders.test.ts -- readdir order is
    // the filesystem's to choose, so this case alone cannot always see a drain.
    put(deepChain(), 500);
    put('zz/shallow.txt', 700);
    expect(await computeManagedAgentsSize()).toEqual({ bytes: 700, truncated: true });
  });

  test.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'an unreadable folder is flagged, never silently left out',
    async () => {
      // Reddens: treating EACCES like a vanished folder -- the total shrank and
      // `truncated` stayed false.
      put('a/ok.txt', 10);
      put('a/locked/secret.bin', 9000);
      const locked = path.join(config.dataDir, 'agents', 'a', 'locked');
      fs.chmodSync(locked, 0o000);
      try {
        expect(await computeManagedAgentsSize()).toEqual({ bytes: 10, truncated: true });
      } finally {
        fs.chmodSync(locked, 0o755);
      }
    },
  );

  test('the walked size and its flag reach the storage_stats message', async () => {
    // Reddens: an envelope that hardcodes 0 / false and never uses the walk.
    put('a/x.txt', 150);
    await executeStorageStats({ send: (m) => sent.push(m) });
    expect(lastStats().managedAgentsSizeBytes).toBe(150);
    expect(lastStats().managedAgentsSizeTruncated).toBe(false);
    sent = [];
    put(deepChain(), 1);
    await executeStorageStats({ send: (m) => sent.push(m) });
    expect(lastStats().managedAgentsSizeTruncated).toBe(true);
  });

  test('the walk never makes a synchronous fs call on the managed trees', async () => {
    // Reddens: a readdirSync/statSync walk. It would park the event loop on the
    // gigabyte trees this reading exists to measure, and every other test here
    // would still pass.
    put('a/x.txt', 1);
    put('a/sub/y.txt', 1);
    const root = path.join(config.dataDir, 'agents');
    const underRoot = (c: unknown[]): boolean => String(c[0]).startsWith(root);
    const rd = vi.spyOn(fs, 'readdirSync');
    const st = vi.spyOn(fs, 'statSync');
    try {
      await executeStorageStats({ send: (m) => sent.push(m) });
      expect(rd.mock.calls.filter(underRoot)).toEqual([]);
      expect(st.mock.calls.filter(underRoot)).toEqual([]);
    } finally {
      rd.mockRestore();
      st.mockRestore();
    }
  });
});
