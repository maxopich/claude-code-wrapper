import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ServerMsg } from '@cebab/shared/protocol';

import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { _resetOperatorIdCache } from '../notifications/operator.js';
import { appendSafetyAudit } from '../notifications/safety_audit.js';
import { describeChainFailure, reverifyChainOnAttach } from './server.js';

// [security] Register H07 — chain verification ran once, at boot, and never
// again.
//
// `verifyChain()` had exactly ONE call site: `index.ts` at startup. A Cebab
// instance that stays up for weeks — the normal case — would never re-check,
// so tampering during a long uptime went unnoticed until the next restart.
//
// It still FAILS OPEN by design: this reports and continues. `index.ts`
// reasons that refusing to run on suspected tamper "bricks the whole app over
// a stale marker allowlist", and locking the operator out of their own tool
// because a migration forgot to register its chain-reset id would be the worse
// failure. The fix is that detection happens more than once, not that
// detection starts blocking.

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-reverify-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  _resetOperatorIdCache();
  getDb();
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  _resetOperatorIdCache();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function sink(): { sent: ServerMsg[]; send: (m: ServerMsg) => void } {
  const sent: ServerMsg[] = [];
  return { sent, send: (m) => sent.push(m) };
}

function breakTheChain(): void {
  appendSafetyAudit({ ts: 1, kind: 'test.event', reasonCode: 'r', payload: {} });
  getDb()
    .prepare(`UPDATE safety_audit SET payload_json = '{"tampered":1}' WHERE kind = 'test.event'`)
    .run();
}

/** Monotonically increasing clock, well past the throttle window each call. */
let clock = 10_000_000;
function laterThanThrottle(): number {
  clock += 120_000;
  return clock;
}

describe('[security] chain re-verification on attach', () => {
  test('a chain broken during uptime is reported without a restart', () => {
    breakTheChain();
    const s = sink();

    reverifyChainOnAttach(s.send, laterThanThrottle());

    const notif = s.sent.find((m) => m.type === 'notification');
    expect(notif).toBeDefined();
    expect(JSON.stringify(notif)).toContain('Safety audit chain failed verification');
  });

  test('the alarm is recorded in the audit log, not only pushed to the socket', () => {
    // The audit row is the obligation — a browser may not be attached, and a
    // notification nobody received is not a record.
    breakTheChain();
    reverifyChainOnAttach(sink().send, laterThanThrottle());

    const n = (
      getDb()
        .prepare(`SELECT COUNT(*) AS n FROM safety_audit WHERE kind = 'audit.tamper_detected'`)
        .get() as { n: number }
    ).n;
    expect(n).toBeGreaterThan(0);
  });

  test('a healthy chain is silent', () => {
    // Attach happens on every reload; an alarm here would be constant noise.
    appendSafetyAudit({ ts: 1, kind: 'test.event', reasonCode: 'r', payload: {} });
    const s = sink();
    reverifyChainOnAttach(s.send, laterThanThrottle());
    expect(s.sent.filter((m) => m.type === 'notification')).toHaveLength(0);
  });

  test('the throttle suppresses a reconnect storm', () => {
    // `verifyChain` walks every row after the anchor with one SHA-256 each, and
    // a measured install had 1784 rows after 8 weeks. Several tabs reloading in
    // a loop must not re-walk a growing chain on every socket.
    breakTheChain();
    const s = sink();
    const t = laterThanThrottle();

    reverifyChainOnAttach(s.send, t);
    reverifyChainOnAttach(s.send, t + 1_000);
    reverifyChainOnAttach(s.send, t + 59_000);

    expect(s.sent.filter((m) => m.type === 'notification')).toHaveLength(1);
  });

  test('past the window it verifies again', () => {
    // The throttle must not become a mute button: tampering after the window
    // still has to surface.
    breakTheChain();
    const s = sink();
    const t = laterThanThrottle();

    reverifyChainOnAttach(s.send, t);
    reverifyChainOnAttach(s.send, t + 61_000);

    expect(s.sent.filter((m) => m.type === 'notification')).toHaveLength(2);
  });

  test('it fails open — a broken chain does not throw at the attach site', () => {
    // onConnection calls this before building the Conn. Throwing here would
    // take the whole UI down over a diagnostic.
    breakTheChain();
    expect(() => reverifyChainOnAttach(sink().send, laterThanThrottle())).not.toThrow();
  });
});

describe('[security] chain failure copy', () => {
  test('every failure reason gets its own operator-facing sentence', () => {
    // Shared by boot and attach so the two cannot describe the same condition
    // differently. A reason that fell through to the default would tell the
    // operator a row hash mismatched when rows had actually been deleted.
    const reasons = [
      'row_mismatch',
      'no_anchor',
      'forged_anchor',
      'tail_truncated',
      'tip_mirror_missing',
    ];
    const messages = reasons.map((r) => describeChainFailure(r, 'row-42'));
    expect(new Set(messages).size).toBe(reasons.length);
    for (const m of messages) expect(m.length).toBeGreaterThan(20);
  });

  test('the truncation message says rows were deleted, not that a hash mismatched', () => {
    const msg = describeChainFailure('tail_truncated', 'row-42');
    expect(msg).toContain('deleted');
    expect(msg).toContain('row-42');
  });
});
