import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import {
  __resetForTests,
  recentRejections,
  recordRejection,
  rejectionLogPath,
  REJECTION_RING_CAP,
  REJECTION_VISIBLE_WINDOW_MS,
} from './origin_rejections.js';

// Cluster G E3 (server-side): origin_rejections.ts is the dual-write
// store for the Origin/Host gate. These tests pin:
//
//   1. Ring buffer FIFO + cap behaviour.
//   2. Visible-window query (5-min cutoff, `now` is injected).
//   3. Disk log: one JSON line per call, append-only, survives multiple
//      writes.
//   4. Failure isolation: disk-write failure doesn't take down the ring.
//
// The module relies on `config.dataDir` for the log location; we swap
// it to a tmpdir per test so cases don't bleed across runs.

let originalDataDir: string;
let tmpRoot: string;

beforeEach(() => {
  originalDataDir = config.dataDir;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-rejections-'));
  config.dataDir = path.join(tmpRoot, '.cebab');
});

afterEach(() => {
  config.dataDir = originalDataDir;
  __resetForTests();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // tmpdir cleanup is best-effort; nothing else uses it.
  }
});

describe('recordRejection / ring buffer', () => {
  test('first call inserts a single entry visible via recentRejections', () => {
    recordRejection({
      origin: 'http://evil.example',
      host: '127.0.0.1:4319',
      reason: 'origin_not_allowed',
      channel: 'http',
    });
    const r = recentRejections();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      origin: 'http://evil.example',
      host: '127.0.0.1:4319',
      reason: 'origin_not_allowed',
      channel: 'http',
    });
    expect(typeof r[0]?.ts).toBe('number');
  });

  test('multiple calls preserve insertion order (FIFO ring)', () => {
    for (const channel of ['http', 'ws', 'http'] as const) {
      recordRejection({
        origin: `http://${channel}.test`,
        host: null,
        reason: 'origin_not_allowed',
        channel,
      });
    }
    const r = recentRejections();
    expect(r.map((x) => x.origin)).toEqual([
      'http://http.test',
      'http://ws.test',
      'http://http.test',
    ]);
  });

  test('ring caps at REJECTION_RING_CAP — earliest entries drop off the front', () => {
    // Inject monotonically increasing ts so we can identify which
    // entries survived without depending on insertion-time order alone.
    for (let i = 0; i < REJECTION_RING_CAP + 5; i++) {
      recordRejection({
        ts: 1_700_000_000_000 + i,
        origin: `http://h${i}.test`,
        host: null,
        reason: 'origin_not_allowed',
        channel: 'http',
      });
    }
    // Use a future `now` so the window check doesn't truncate further.
    const r = recentRejections(1_700_000_000_000 + REJECTION_RING_CAP + 5);
    expect(r).toHaveLength(REJECTION_RING_CAP);
    // First entry should be index 5 (the 5 oldest got popped).
    expect(r[0]?.origin).toBe('http://h5.test');
    expect(r[r.length - 1]?.origin).toBe(`http://h${REJECTION_RING_CAP + 4}.test`);
  });

  test('recentRejections returns defensive copies — mutating the result does not affect the ring', () => {
    recordRejection({
      origin: 'http://x.test',
      host: null,
      reason: 'origin_not_allowed',
      channel: 'http',
    });
    const a = recentRejections();
    a[0]!.reason = 'host_not_allowed';
    const b = recentRejections();
    expect(b[0]?.reason).toBe('origin_not_allowed');
  });
});

describe('recentRejections / visible window', () => {
  test('entries within REJECTION_VISIBLE_WINDOW_MS are returned; older are filtered', () => {
    const now = 1_700_000_000_000;
    // Just inside the window:
    recordRejection({
      ts: now - REJECTION_VISIBLE_WINDOW_MS + 1,
      origin: 'http://recent.test',
      host: null,
      reason: 'origin_not_allowed',
      channel: 'http',
    });
    // Just outside the window:
    recordRejection({
      ts: now - REJECTION_VISIBLE_WINDOW_MS - 1,
      origin: 'http://stale.test',
      host: null,
      reason: 'origin_not_allowed',
      channel: 'http',
    });
    const r = recentRejections(now);
    expect(r.map((x) => x.origin)).toEqual(['http://recent.test']);
  });

  test('empty ring → empty array (sentinel for "no toast")', () => {
    expect(recentRejections()).toEqual([]);
  });

  test('all-stale ring → empty array (window filters every entry)', () => {
    const now = 1_700_000_000_000;
    recordRejection({
      ts: now - REJECTION_VISIBLE_WINDOW_MS - 100,
      origin: 'http://stale.test',
      host: null,
      reason: 'origin_not_allowed',
      channel: 'http',
    });
    expect(recentRejections(now)).toEqual([]);
  });
});

describe('disk log', () => {
  test('every rejection appends one JSON line to origin_rejections.log', () => {
    recordRejection({
      origin: 'http://a.test',
      host: 'localhost:4319',
      reason: 'origin_not_allowed',
      channel: 'http',
    });
    recordRejection({
      origin: null,
      host: 'evil.example:80',
      reason: 'host_not_allowed',
      channel: 'ws',
    });
    const raw = fs.readFileSync(rejectionLogPath(), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]).toMatchObject({
      origin: 'http://a.test',
      host: 'localhost:4319',
      reason: 'origin_not_allowed',
      channel: 'http',
    });
    expect(parsed[1]).toMatchObject({
      origin: null,
      host: 'evil.example:80',
      reason: 'host_not_allowed',
      channel: 'ws',
    });
  });

  test('log file is created lazily — dataDir/logs/ is mkdir -p before the first write', () => {
    // No `logs/` subdir exists yet; the first recordRejection must
    // create it. This guards against a regression where the module
    // assumes someone else (server boot) mkdirp'd the directory.
    expect(fs.existsSync(path.join(config.dataDir, 'logs'))).toBe(false);
    recordRejection({
      origin: 'http://x.test',
      host: null,
      reason: 'origin_not_allowed',
      channel: 'http',
    });
    expect(fs.existsSync(rejectionLogPath())).toBe(true);
  });

  test('rejection survives in the ring even if disk write throws', () => {
    // Point dataDir at a path that exists as a FILE so mkdir + append
    // both fail (a regular file isn't a directory). The ring write
    // must still succeed and the entry must still be visible.
    config.dataDir = path.join(tmpRoot, 'notadir');
    fs.writeFileSync(config.dataDir, 'i am a file, not a directory');
    expect(() =>
      recordRejection({
        origin: 'http://x.test',
        host: null,
        reason: 'origin_not_allowed',
        channel: 'http',
      }),
    ).not.toThrow();
    expect(recentRejections()).toHaveLength(1);
  });
});
