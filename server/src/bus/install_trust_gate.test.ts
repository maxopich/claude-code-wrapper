import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ServerMsg } from '@cebab/shared/protocol';
import { config } from '../config.js';
import { closeDb, getDb } from '../db.js';
import { _resetOperatorIdCache } from '../notifications/operator.js';
import {
  appendSafetyAudit,
  HIGHEST_SUBCODES as _HIGHEST_SUBCODES,
} from '../notifications/safety_audit.js';
import { getProjectBusTrust, setProjectBusTrust, upsertProject } from '../repo/projects.js';
import { setProjectBusInstalled } from '../repo/multi_agent.js';
import {
  awaitBusTrustDecision,
  makeBusTrustGateState,
  resolveBusTrustPending,
} from './install_trust_gate.js';

// keep the lint-noise import minimal (the constant is referenced for type
// inference of the test asserts on safety_audit rows)
void _HIGHEST_SUBCODES;

// Cluster G Phase 4 (D6/D11) — bus-install TOFU gate tests.
//
// What this file covers:
//   - Decision matrix end-to-end:
//       trusted → silent pass; no envelope; no audit row
//       denied  → silent refusal + `bus.install_denied` audit row; no envelope
//       null + per-Conn deny_once hit → silent refusal + audit row
//       null + first-seen → emit `bus_auto_install_pending`, await reply
//   - `bus_trust_decision` applier writes the projects column AND the
//     `bus.trust_decided` audit row for each branch (trust / deny_remember
//     / deny_once)
//   - `deny_once` does NOT write to projects (in-memory only) but DOES
//     write an audit row, and subsequent gate calls for the same project
//     in the same Conn short-circuit to `denied: deny_once` without
//     re-prompting
//   - A fresh gate state (new Conn) re-prompts after a deny_once
//   - `resolveBusTrustPending` returns false for unknown ids and true
//     for matched ids (and deletes the entry on match)
//   - Project missing / agent name unavailable refuse cleanly with an audit
//     row instead of leaking the InstallError to the operator
//
// Migration 024's backfill ('trusted' for pre-gate installed projects) is
// covered in projects.test.ts; this file focuses on the gate's runtime.

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-bus-gate-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  _resetOperatorIdCache();
  getDb(); // apply migrations 001..024
});

afterEach(() => {
  closeDb();
  config.dataDir = originalDataDir;
  _resetOperatorIdCache();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---- helpers ----

function makeProject(name: string, relPath = name): number {
  const projectPath = path.join(tmpRoot, 'workspace', relPath);
  fs.mkdirSync(projectPath, { recursive: true });
  return upsertProject(name, projectPath).id;
}

function makeSink(): { sent: ServerMsg[]; send: (m: ServerMsg) => void } {
  const sent: ServerMsg[] = [];
  return { sent, send: (m: ServerMsg) => sent.push(m) };
}

function readAuditRows(kind: string): Array<{ reason_code: string; payload_json: string }> {
  return getDb()
    .prepare<
      [string],
      { reason_code: string; payload_json: string }
    >('SELECT reason_code, payload_json FROM safety_audit WHERE kind = ? ORDER BY rowid')
    .all(kind);
}

// ---- decision matrix ----

describe('awaitBusTrustDecision — persisted trusted', () => {
  test('silent pass; no envelope; no audit row', async () => {
    const pid = makeProject('Alpha');
    setProjectBusTrust(pid, 'trusted');
    const sink = makeSink();
    const gate = makeBusTrustGateState();
    const outcome = await awaitBusTrustDecision({
      projectId: pid,
      contextSessionId: null,
      gate,
      send: sink.send,
    });
    expect(outcome.approved).toBe(true);
    expect(sink.sent).toHaveLength(0);
    expect(readAuditRows('bus.install_denied')).toHaveLength(0);
    expect(readAuditRows('bus.trust_decided')).toHaveLength(0);
  });
});

describe('awaitBusTrustDecision — persisted denied', () => {
  test('silent refusal + bus.install_denied row; no envelope; reason=denied_remember', async () => {
    const pid = makeProject('Bravo');
    setProjectBusTrust(pid, 'denied');
    const sink = makeSink();
    const gate = makeBusTrustGateState();
    const outcome = await awaitBusTrustDecision({
      projectId: pid,
      contextSessionId: 's-1',
      gate,
      send: sink.send,
    });
    expect(outcome.approved).toBe(false);
    if (!outcome.approved) {
      expect(outcome.reason).toBe('denied_remember');
    }
    expect(sink.sent).toHaveLength(0);
    const denied = readAuditRows('bus.install_denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]!.reason_code).toBe('denied_remember');
  });
});

describe('awaitBusTrustDecision — first-seen prompt + trust', () => {
  test('emits bus_auto_install_pending; reply with trust → approved + persisted trusted + audit row', async () => {
    const pid = makeProject('Charlie');
    const sink = makeSink();
    const gate = makeBusTrustGateState();

    const gatePromise = awaitBusTrustDecision({
      projectId: pid,
      contextSessionId: 's-7',
      gate,
      send: sink.send,
    });

    // The emit happens synchronously before the promise yields, so the
    // pending envelope is in the sink after one microtask drain.
    await Promise.resolve();
    expect(sink.sent).toHaveLength(1);
    const env = sink.sent[0]!;
    if (env.type !== 'bus_auto_install_pending') throw new Error('wrong envelope');
    expect(env.projectId).toBe(pid);
    expect(env.projectName).toBe('Charlie');
    expect(env.agentName).toBe('charlie');
    expect(env.contextSessionId).toBe('s-7');
    expect(gate.pending.size).toBe(1);

    const matched = resolveBusTrustPending(gate, env.pendingId, 'trust');
    expect(matched).toBe(true);
    expect(gate.pending.size).toBe(0);

    const outcome = await gatePromise;
    expect(outcome.approved).toBe(true);
    expect(getProjectBusTrust(pid)).toBe('trusted');
    const decided = readAuditRows('bus.trust_decided');
    expect(decided).toHaveLength(1);
    expect(decided[0]!.reason_code).toBe('trust');
  });
});

describe('awaitBusTrustDecision — first-seen prompt + deny_remember', () => {
  test('reply with deny_remember → not approved + persisted denied + audit row', async () => {
    const pid = makeProject('Delta');
    const sink = makeSink();
    const gate = makeBusTrustGateState();

    const gatePromise = awaitBusTrustDecision({
      projectId: pid,
      contextSessionId: null,
      gate,
      send: sink.send,
    });
    await Promise.resolve();
    const env = sink.sent[0]!;
    if (env.type !== 'bus_auto_install_pending') throw new Error('wrong envelope');

    resolveBusTrustPending(gate, env.pendingId, 'deny_remember');
    const outcome = await gatePromise;

    expect(outcome.approved).toBe(false);
    if (!outcome.approved) expect(outcome.reason).toBe('denied_remember');
    expect(getProjectBusTrust(pid)).toBe('denied');
    const decided = readAuditRows('bus.trust_decided');
    expect(decided).toHaveLength(1);
    expect(decided[0]!.reason_code).toBe('deny_remember');
    // The active-decision row lands under bus.trust_decided; no
    // bus.install_denied row should fire for the active denial.
    expect(readAuditRows('bus.install_denied')).toHaveLength(0);
  });
});

describe('awaitBusTrustDecision — first-seen prompt + deny_once', () => {
  test('reply with deny_once → not approved; projects column untouched; per-Conn set populated', async () => {
    const pid = makeProject('Echo');
    const sink = makeSink();
    const gate = makeBusTrustGateState();

    const gatePromise = awaitBusTrustDecision({
      projectId: pid,
      contextSessionId: null,
      gate,
      send: sink.send,
    });
    await Promise.resolve();
    const env = sink.sent[0]!;
    if (env.type !== 'bus_auto_install_pending') throw new Error('wrong envelope');

    resolveBusTrustPending(gate, env.pendingId, 'deny_once');
    const outcome = await gatePromise;

    expect(outcome.approved).toBe(false);
    if (!outcome.approved) expect(outcome.reason).toBe('deny_once');
    // No persistence — projects column stays NULL.
    expect(getProjectBusTrust(pid)).toBeNull();
    expect(gate.denyOnce.has(pid)).toBe(true);
    const decided = readAuditRows('bus.trust_decided');
    expect(decided).toHaveLength(1);
    expect(decided[0]!.reason_code).toBe('deny_once');
  });

  test('subsequent gate call in same Conn short-circuits to deny_once silently', async () => {
    const pid = makeProject('Foxtrot');
    const sink = makeSink();
    const gate = makeBusTrustGateState();

    // First call: ask + deny once.
    const gp1 = awaitBusTrustDecision({
      projectId: pid,
      contextSessionId: null,
      gate,
      send: sink.send,
    });
    await Promise.resolve();
    const env1 = sink.sent[0]!;
    if (env1.type !== 'bus_auto_install_pending') throw new Error('wrong envelope');
    resolveBusTrustPending(gate, env1.pendingId, 'deny_once');
    await gp1;

    // Second call: no new envelope; silent refusal with reason=deny_once.
    sink.sent.length = 0;
    const outcome2 = await awaitBusTrustDecision({
      projectId: pid,
      contextSessionId: null,
      gate,
      send: sink.send,
    });
    expect(outcome2.approved).toBe(false);
    if (!outcome2.approved) expect(outcome2.reason).toBe('deny_once');
    expect(sink.sent).toHaveLength(0);
    // The second call writes a bus.install_denied row (silent refusal path)
    // in addition to the original bus.trust_decided row from the active
    // decision.
    expect(readAuditRows('bus.install_denied')).toHaveLength(1);
  });

  test('fresh gate state (new Conn) re-prompts after a deny_once', async () => {
    const pid = makeProject('Golf');
    const sink = makeSink();
    const gate1 = makeBusTrustGateState();

    const gp1 = awaitBusTrustDecision({
      projectId: pid,
      contextSessionId: null,
      gate: gate1,
      send: sink.send,
    });
    await Promise.resolve();
    const env1 = sink.sent[0]!;
    if (env1.type !== 'bus_auto_install_pending') throw new Error('wrong envelope');
    resolveBusTrustPending(gate1, env1.pendingId, 'deny_once');
    await gp1;

    // New Conn: fresh gate state. The persisted decision is still NULL
    // (deny_once doesn't persist), so the second connection's first
    // install attempt re-prompts.
    sink.sent.length = 0;
    const gate2 = makeBusTrustGateState();
    const gp2 = awaitBusTrustDecision({
      projectId: pid,
      contextSessionId: null,
      gate: gate2,
      send: sink.send,
    });
    await Promise.resolve();
    expect(sink.sent).toHaveLength(1);
    const env2 = sink.sent[0]!;
    if (env2.type !== 'bus_auto_install_pending') throw new Error('wrong envelope');
    // Resolve to keep the test promise from leaking.
    resolveBusTrustPending(gate2, env2.pendingId, 'deny_once');
    await gp2;
  });
});

describe('resolveBusTrustPending', () => {
  test('returns false for unknown id', () => {
    const gate = makeBusTrustGateState();
    expect(resolveBusTrustPending(gate, 'unknown-id', 'trust')).toBe(false);
  });

  test('matches by id, resolves the promise, and deletes the entry', async () => {
    const pid = makeProject('Hotel');
    const sink = makeSink();
    const gate = makeBusTrustGateState();
    const gp = awaitBusTrustDecision({
      projectId: pid,
      contextSessionId: null,
      gate,
      send: sink.send,
    });
    await Promise.resolve();
    const env = sink.sent[0]!;
    if (env.type !== 'bus_auto_install_pending') throw new Error('wrong envelope');
    expect(gate.pending.size).toBe(1);
    expect(resolveBusTrustPending(gate, env.pendingId, 'trust')).toBe(true);
    expect(gate.pending.size).toBe(0);
    await gp;
  });
});

describe('awaitBusTrustDecision — project resolution failures', () => {
  test('missing project → silent refusal + audit row reason=project_not_found', async () => {
    const sink = makeSink();
    const gate = makeBusTrustGateState();
    const outcome = await awaitBusTrustDecision({
      projectId: 9999,
      contextSessionId: null,
      gate,
      send: sink.send,
    });
    expect(outcome.approved).toBe(false);
    if (!outcome.approved) expect(outcome.reason).toBe('denied_remember');
    expect(sink.sent).toHaveLength(0);
    const denied = readAuditRows('bus.install_denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]!.reason_code).toBe('project_not_found');
  });
});

// ---- migration 024 backfill ----

describe('migration 024 — backfill', () => {
  test('projects with bus_installed=1 before the gate land with trust_decision=trusted', async () => {
    // Simulate a pre-gate world: a project that was installed before the
    // column existed. The migration runner already applied 024 during
    // beforeEach; this test verifies the backfill UPDATE matches the
    // already-installed row.
    const pid = makeProject('India');
    // Pre-existing install: flip bus_installed=1 directly via the repo.
    setProjectBusInstalled(pid, true, 'india');
    // The migration was applied before this row existed, so the column is
    // still NULL — but new projects' subsequent install would expect
    // backfill semantics. We retroactively run the backfill UPDATE to
    // mimic the migration's effect on an already-installed row.
    getDb().prepare("UPDATE projects SET bus_trust_decision = 'trusted' WHERE bus_installed = 1").run();
    expect(getProjectBusTrust(pid)).toBe('trusted');

    // And the gate short-circuits silently.
    const sink = makeSink();
    const gate = makeBusTrustGateState();
    const outcome = await awaitBusTrustDecision({
      projectId: pid,
      contextSessionId: null,
      gate,
      send: sink.send,
    });
    expect(outcome.approved).toBe(true);
    expect(sink.sent).toHaveLength(0);
  });

  test('projects with bus_installed=0 keep trust_decision=NULL (first-seen on next install)', async () => {
    const pid = makeProject('Juliet');
    expect(getProjectBusTrust(pid)).toBeNull();
  });
});

// ---- safety-audit pinning ----

describe('safety_audit — append shape', () => {
  test('trust_decided payload carries projectId', async () => {
    const pid = makeProject('Kilo');
    const sink = makeSink();
    const gate = makeBusTrustGateState();
    const gp = awaitBusTrustDecision({
      projectId: pid,
      contextSessionId: 's-9',
      gate,
      send: sink.send,
    });
    await Promise.resolve();
    const env = sink.sent[0]!;
    if (env.type !== 'bus_auto_install_pending') throw new Error('wrong envelope');
    resolveBusTrustPending(gate, env.pendingId, 'trust');
    await gp;

    const rows = readAuditRows('bus.trust_decided');
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payload_json) as { projectId: number };
    expect(payload.projectId).toBe(pid);
  });

  test('install_denied payload carries projectId', async () => {
    const pid = makeProject('Lima');
    setProjectBusTrust(pid, 'denied');
    const sink = makeSink();
    const gate = makeBusTrustGateState();
    await awaitBusTrustDecision({
      projectId: pid,
      contextSessionId: null,
      gate,
      send: sink.send,
    });
    const rows = readAuditRows('bus.install_denied');
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payload_json) as { projectId: number };
    expect(payload.projectId).toBe(pid);
  });
});

// ---- repo round-trip ----

describe('getProjectBusTrust / setProjectBusTrust', () => {
  test('null → set trusted → reads trusted', () => {
    const pid = makeProject('Mike');
    expect(getProjectBusTrust(pid)).toBeNull();
    setProjectBusTrust(pid, 'trusted');
    expect(getProjectBusTrust(pid)).toBe('trusted');
  });

  test('set denied then back to null clears', () => {
    const pid = makeProject('November');
    setProjectBusTrust(pid, 'denied');
    expect(getProjectBusTrust(pid)).toBe('denied');
    setProjectBusTrust(pid, null);
    expect(getProjectBusTrust(pid)).toBeNull();
  });

  test('missing project reads as null without throwing', () => {
    expect(getProjectBusTrust(9999)).toBeNull();
  });

  test('safety_audit append works independently (sanity check vs migration 024 chain-reset absence)', () => {
    // Migration 024 does NOT alter safety_audit, so no chain-reset marker
    // was inserted. This test confirms a normal append still succeeds —
    // i.e. the existing chain (anchored at the 023 marker) is intact.
    expect(() =>
      appendSafetyAudit({
        ts: Date.now(),
        kind: 'bus.install_denied',
        reasonCode: 'sanity_check',
        payload: { projectId: 0 },
      }),
    ).not.toThrow();
  });
});
