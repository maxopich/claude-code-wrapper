import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { emit as emitNotification } from '../notifications/dispatcher.js';
import { buildRouterDropSnapshots } from './router_drop_snapshot.js';

// `Cebab-vie.33`: what a re-attaching browser is told about the router drops
// this session has recorded, so a refresh stops emptying the RouterDropsCounter
// chip while the router keeps dropping.
//
// Driven through the REAL dispatcher emit — the exact call `dispatchRouterDrop`
// makes in both routers (class:'safety', auditKind:'router.drop', the payload
// shape, the RouterDropReasonCode) — rather than hand-writing safety_audit
// rows. A fixture that INSERTed rows directly would be a second copy of the
// write contract; if the payload key names drifted, this test would keep
// passing against its own private shape while the builder read the real one.

const SID = 'sess-drops';

let tmpRoot: string;
let originalDataDir: string;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-router-drop-snapshot-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  getDb();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errSpy.mockRestore();
  closeDb();
  config.dataDir = originalDataDir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Record one router drop exactly as `dispatchRouterDrop` does, and return the
 * `safety_audit.id` the live envelope would carry as `auditRowId`.
 */
function drop(params: {
  sessionId?: string;
  reasonCode: string;
  source: string;
  destination: string;
  kind: string;
}): string {
  const result = emitNotification(
    {
      class: 'safety',
      severity: 'danger',
      dedupeKey: `router_drop:${params.reasonCode}:${params.sessionId ?? SID}`,
      title: 'router drop',
      message: 'a drop',
      sessionId: params.sessionId ?? SID,
      reasonCode: params.reasonCode,
      auditKind: 'router.drop',
      auditPayload: {
        source: params.source,
        destination: params.destination,
        kind: params.kind,
      },
    },
    () => undefined,
  );
  if (!result.ok) throw new Error(`emit failed: ${result.error}`);
  return result.id;
}

describe('buildRouterDropSnapshots — the drop history a refresh used to discard', () => {
  test('a session with no drops yields nothing', () => {
    expect(buildRouterDropSnapshots(SID)).toEqual([]);
  });

  test('a recorded drop comes back with the audit id, payload and ts', () => {
    const id = drop({
      reasonCode: 'muted_source',
      source: 'alpha',
      destination: 'cebab',
      kind: 'reply',
    });
    const snaps = buildRouterDropSnapshots(SID);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      auditRowId: id,
      reasonCode: 'muted_source',
      source: 'alpha',
      destination: 'cebab',
      kind: 'reply',
    });
    expect(typeof snaps[0]!.ts).toBe('number');
    expect(snaps[0]!.ts).toBeGreaterThan(0);
  });

  test('every drop is a row — a muted worker replying eleven times yields eleven', () => {
    // The whole point of the bead: the operator can see alpha is muted (vie.6)
    // and must also see that eleven of its replies were discarded. The count is
    // the signal, so the list is NOT capped.
    for (let i = 0; i < 11; i++) {
      drop({ reasonCode: 'muted_source', source: 'alpha', destination: 'cebab', kind: 'reply' });
    }
    expect(buildRouterDropSnapshots(SID)).toHaveLength(11);
  });

  test('drops come back in append order (matches the client accumulation order)', () => {
    const first = drop({
      reasonCode: 'forged_source',
      source: 'alpha',
      destination: 'cebab',
      kind: 'reply',
    });
    const second = drop({
      reasonCode: 'worker_to_user',
      source: 'beta',
      destination: '_user',
      kind: 'reply',
    });
    expect(buildRouterDropSnapshots(SID).map((s) => s.auditRowId)).toEqual([first, second]);
  });

  test('only the requested session is answered for', () => {
    drop({ reasonCode: 'muted_source', source: 'alpha', destination: 'cebab', kind: 'reply' });
    drop({
      sessionId: 'sess-other',
      reasonCode: 'forged_source',
      source: 'gamma',
      destination: 'cebab',
      kind: 'reply',
    });
    expect(buildRouterDropSnapshots(SID)).toHaveLength(1);
    expect(buildRouterDropSnapshots('sess-other')).toHaveLength(1);
    expect(buildRouterDropSnapshots(SID)[0]!.source).toBe('alpha');
  });

  test('a row whose reason_code is outside the vocabulary is skipped, not shipped raw', () => {
    drop({ reasonCode: 'muted_source', source: 'alpha', destination: 'cebab', kind: 'reply' });
    // A corrupt / future-vocabulary code the typed client reducer could not
    // render. `findLatestControlReason` bails on the same case; here we skip the
    // row rather than ship an unvalidated string. Rewritten in place — the hash
    // chain is verified on boot, not on read, so the row still answers the query.
    getDb()
      .prepare(`UPDATE safety_audit SET reason_code = 'from_a_future_release' WHERE kind = ?`)
      .run('router.drop');
    expect(buildRouterDropSnapshots(SID)).toEqual([]);
  });

  test('non-router safety rows in the same session are not mistaken for drops', () => {
    // A different safety kind sharing the session must not leak into the list —
    // the query is keyed on kind='router.drop', not on session alone.
    emitNotification(
      {
        class: 'safety',
        severity: 'warn',
        dedupeKey: `env_scrub:${SID}`,
        title: 'env scrubbed',
        sessionId: SID,
        reasonCode: 'api',
        auditKind: 'env.scrubbed',
        auditPayload: { vars: ['ANTHROPIC_API_KEY'] },
      },
      () => undefined,
    );
    drop({ reasonCode: 'muted_source', source: 'alpha', destination: 'cebab', kind: 'reply' });
    const snaps = buildRouterDropSnapshots(SID);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.reasonCode).toBe('muted_source');
  });
});
