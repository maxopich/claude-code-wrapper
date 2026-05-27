import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ServerMsg } from '@cebab/shared';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { _resetCoalesceState, emit } from './dispatcher.js';
import { _resetOperatorIdCache } from './operator.js';
import {
  buildInboxSnapshot,
  clearDismissedInbox,
  countUnackedBySession,
  listInbox,
} from './inbox.js';

// Cluster A Phase 5 (inbox replay): exercises the persisted-row query
// layer that backs the bell badge + panel. Pins:
//   - listInbox respects the filter shape (sessionId null vs undefined,
//     classes, severities, includeAcked) and the "200 newest OR 7 days,
//     whichever larger" floor.
//   - clearDismissedInbox bulk-acks ONLY operational rows; safety rows
//     are untouched (BE-7 — operator-typed-reason policy can't be
//     bulk-defaulted).
//   - countUnackedBySession buckets correctly, with `""` for global
//     (session_id IS NULL) so JSON round-trip preserves the bucket.

let tmpRoot: string;
let originalDataDir: string;
const sent: ServerMsg[] = [];
function recorder(msg: ServerMsg): void {
  sent.push(msg);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-inbox-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  _resetOperatorIdCache();
  _resetCoalesceState();
  getDb();
  sent.length = 0;
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  _resetOperatorIdCache();
  _resetCoalesceState();
  vi.useRealTimers();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function emitOp(
  sessionId: string | undefined,
  dedupeKey: string,
  severity: 'info' | 'warn' | 'error' = 'warn',
  sticky = true,
): string {
  // dedupeKey must be UNIQUE per call to bypass the coalesce window —
  // operational dedupe would otherwise suppress sends and skip persistence.
  const r = emit(
    {
      class: 'operational',
      severity,
      dedupeKey,
      title: `Test ${dedupeKey}`,
      sessionId,
      sticky,
    },
    recorder,
  );
  if (!r.ok) throw new Error(`emit failed: ${r.error}`);
  return r.id;
}

function emitSafety(sessionId: string | undefined, dedupeKey: string): string {
  const r = emit(
    {
      class: 'safety',
      severity: 'danger',
      dedupeKey,
      title: `Safety ${dedupeKey}`,
      reasonCode: 'classifier_dangerous',
      auditKind: 'mutation.dangerous',
      auditPayload: {},
      sessionId,
    },
    recorder,
  );
  if (!r.ok) throw new Error(`safety emit failed: ${r.error}`);
  return r.id;
}

describe('listInbox', () => {
  test('returns rows newest-first', () => {
    // Fake timers so the three inserts get distinct `ts` values. SQLite
    // `ORDER BY ts DESC` is otherwise unstable when multiple rows share a
    // millisecond — the production contract only promises "newest first",
    // not a tiebreak for same-ts rows.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    emitOp('s1', 'op:a');
    vi.advanceTimersByTime(10);
    emitOp('s2', 'op:b');
    vi.advanceTimersByTime(10);
    emitOp(undefined, 'op:c');

    const rows = listInbox();
    expect(rows.length).toBe(3);
    expect(rows[0].dedupeKey).toBe('op:c');
    expect(rows[2].dedupeKey).toBe('op:a');
  });

  test('sessionId filter — string narrows to that session', () => {
    emitOp('s1', 'op:1');
    emitOp('s2', 'op:2');
    emitOp(undefined, 'op:global');

    const rows = listInbox({ sessionId: 's1' });
    expect(rows.length).toBe(1);
    expect(rows[0].sessionId).toBe('s1');
  });

  test('sessionId filter — null returns global rows only', () => {
    emitOp('s1', 'op:1');
    emitOp(undefined, 'op:global1');
    emitOp(undefined, 'op:global2');

    const rows = listInbox({ sessionId: null });
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.sessionId === undefined)).toBe(true);
  });

  test('sessionId filter — undefined means no filter (all rows)', () => {
    emitOp('s1', 'op:1');
    emitOp(undefined, 'op:global');

    const rows = listInbox({ sessionId: undefined });
    expect(rows.length).toBe(2);
  });

  test('classes filter narrows to operational or safety', () => {
    emitOp('s1', 'op:1');
    emitSafety('s1', 'safety:1');

    const opOnly = listInbox({ classes: ['operational'] });
    expect(opOnly.length).toBe(1);
    expect(opOnly[0].class).toBe('operational');

    const safetyOnly = listInbox({ classes: ['safety'] });
    expect(safetyOnly.length).toBe(1);
    expect(safetyOnly[0].class).toBe('safety');
  });

  test('severities filter narrows by tier', () => {
    emitOp('s1', 'op:warn', 'warn');
    emitOp('s1', 'op:error', 'error');
    emitSafety('s1', 'safety:danger');

    const onlyWarn = listInbox({ severities: ['warn'] });
    expect(onlyWarn.length).toBe(1);
    expect(onlyWarn[0].severity).toBe('warn');

    const dangerAndError = listInbox({ severities: ['error', 'danger'] });
    expect(dangerAndError.length).toBe(2);
  });

  test('includeAcked=false (default) hides acked rows', () => {
    const id = emitOp('s1', 'op:1');
    // Ack the row directly via the underlying SQL (the test doesn't
    // exercise the WS ack path — that's covered by dispatcher.test.ts).
    getDb()
      .prepare(`UPDATE notifications SET acked_at = ?, acked_by = ? WHERE id = ?`)
      .run(Date.now(), 'test-user', id);

    expect(listInbox().length).toBe(0);
    expect(listInbox({ includeAcked: true }).length).toBe(1);
  });

  test('non-sticky operational rows are not persisted and not returned', () => {
    // Dispatcher's "sticky operational + ALL safety persist" rule (BE-4).
    emitOp('s1', 'op:not-sticky', 'info', false);
    expect(listInbox().length).toBe(0);
  });
});

describe('clearDismissedInbox', () => {
  test('acks only operational rows; safety rows untouched', () => {
    const opId = emitOp('s1', 'op:1');
    const safetyId = emitSafety('s1', 'safety:1');

    const cleared = clearDismissedInbox();
    expect(cleared).toBe(1);

    const opRow = getDb()
      .prepare<
        [string],
        { acked_at: number | null; class: string }
      >(`SELECT acked_at, class FROM notifications WHERE id = ?`)
      .get(opId);
    expect(opRow?.acked_at).not.toBeNull();

    const safetyRow = getDb()
      .prepare<
        [string],
        { acked_at: number | null; class: string }
      >(`SELECT acked_at, class FROM notifications WHERE id = ?`)
      .get(safetyId);
    expect(safetyRow?.acked_at).toBeNull();
  });

  test('idempotent — second call returns 0 (no rows left to ack)', () => {
    emitOp('s1', 'op:1');
    emitOp('s2', 'op:2');
    expect(clearDismissedInbox()).toBe(2);
    expect(clearDismissedInbox()).toBe(0);
  });

  test('records operator id on acked rows', () => {
    const id = emitOp('s1', 'op:1');
    clearDismissedInbox();
    const row = getDb()
      .prepare<
        [string],
        { acked_by: string | null }
      >(`SELECT acked_by FROM notifications WHERE id = ?`)
      .get(id);
    expect(row?.acked_by).toBeTruthy();
    expect(typeof row?.acked_by).toBe('string');
  });
});

describe('countUnackedBySession', () => {
  test('buckets per-session unacked rows', () => {
    emitOp('s1', 'op:1');
    emitOp('s1', 'op:2');
    emitOp('s2', 'op:3');
    emitOp(undefined, 'op:global');

    const { bySession, total } = countUnackedBySession();
    expect(bySession.s1).toBe(2);
    expect(bySession.s2).toBe(1);
    expect(bySession['']).toBe(1);
    expect(total).toBe(4);
  });

  test('excludes acked rows', () => {
    const id = emitOp('s1', 'op:1');
    emitOp('s2', 'op:2');
    getDb()
      .prepare(`UPDATE notifications SET acked_at = ?, acked_by = ? WHERE id = ?`)
      .run(Date.now(), 'test', id);

    const { bySession, total } = countUnackedBySession();
    expect(bySession.s1).toBeUndefined();
    expect(bySession.s2).toBe(1);
    expect(total).toBe(1);
  });

  test('uses empty-string key for null session_id', () => {
    // JSON round-trip preserves "" but drops `undefined`; the "" sentinel
    // is the contract with the client.
    emitOp(undefined, 'op:global');

    const { bySession } = countUnackedBySession();
    expect(Object.prototype.hasOwnProperty.call(bySession, '')).toBe(true);
    expect(bySession['']).toBe(1);
  });
});

describe('buildInboxSnapshot', () => {
  test('composes rows + counts in one call', () => {
    emitOp('s1', 'op:1');
    emitSafety('s2', 'safety:1');

    const snap = buildInboxSnapshot();
    expect(snap.rows.length).toBe(2);
    expect(snap.unackedGlobal).toBe(2);
    expect(snap.unackedCountBySession.s1).toBe(1);
    expect(snap.unackedCountBySession.s2).toBe(1);
  });

  test('filter passes through to listInbox', () => {
    emitOp('s1', 'op:1');
    emitOp('s2', 'op:2');

    const snap = buildInboxSnapshot({ sessionId: 's1' });
    expect(snap.rows.length).toBe(1);
    // Counts are NOT filtered — they always reflect the global state so
    // the sidebar per-session badges stay coherent regardless of the
    // panel's current filter.
    expect(snap.unackedGlobal).toBe(2);
  });
});
