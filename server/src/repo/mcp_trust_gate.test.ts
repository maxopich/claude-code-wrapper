import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { McpServerView, ServerMsg } from '@cebab/shared/protocol';
import { closeDb, getDb } from '../db.js';
import { config } from '../config.js';
import { _resetOperatorIdCache } from '../notifications/operator.js';
import { checkTrust, recordTrustDecision } from './mcp_trust.js';
import { awaitMcpTrustDecisions, denyOnceKey, makeTrustGateState } from './mcp_trust_gate.js';
import * as safetyAudit from '../notifications/safety_audit.js';

// Cluster B Phase 4b (§4.4): TOFU spawn-gate tests.
//
// What this file covers:
//   - The decision table (every cell of §4.4) wired through `awaitMcpTrustDecisions`:
//       trusted, cebab-injected         → silent pass
//       denied (persisted), deny_once   → silent refusal + audit row
//       pending_tofu, hash_changed      → emit pending + park promise + resolve
//   - `mcp_trust_decision` outcomes (allow / allow_pinned / deny_once / deny_remember)
//     write the correct mcp_trust state via the parked resolver
//   - hash_changed surfaces previousSha from the prior trusted_pinned_hash row
//   - per-session deny_once persists across the same gate state (a re-gate
//     against the same projectId+server short-circuits without re-prompting)
//   - new connection (fresh TrustGateState) re-prompts even after a deny_once
//     in another session
//   - BE-1: if `recordTrustDecision` throws (safety_audit chain broken),
//     the spawn-promise STILL resolves (gate doesn't freeze) but the
//     mcp_trust row is not written
//
// Tests run against an isolated DB (config.dataDir override) so the
// safety_audit chain and mcp_trust rows are scoped per-test.

let tmpRoot: string;
let originalDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cebab-mcp-gate-'));
  originalDataDir = config.dataDir;
  config.dataDir = path.join(tmpRoot, '.cebab');
  fs.mkdirSync(config.dataDir, { recursive: true });
  closeDb();
  _resetOperatorIdCache();
  getDb(); // apply migrations 001..016
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
  config.dataDir = originalDataDir;
  _resetOperatorIdCache();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---- helpers ----

function makeSink(): { sent: ServerMsg[]; send: (m: ServerMsg) => void } {
  const sent: ServerMsg[] = [];
  return { sent, send: (m: ServerMsg) => sent.push(m) };
}

function viewPending(name: string, originPath: string, command?: string): McpServerView {
  const view: McpServerView = {
    name,
    status: 'unknown',
    scope: 'project',
    originPath,
    tools: [],
    trust: 'pending_tofu',
  };
  if (command) view.config = { command };
  return view;
}

function viewTrusted(name: string, originPath: string): McpServerView {
  return {
    name,
    status: 'unknown',
    scope: 'project',
    originPath,
    tools: [],
    trust: 'trusted',
  };
}

function viewDenied(name: string, originPath: string): McpServerView {
  return {
    name,
    status: 'unknown',
    scope: 'project',
    originPath,
    tools: [],
    trust: 'denied',
  };
}

function viewHashChanged(name: string, originPath: string, binarySha: string): McpServerView {
  return {
    name,
    status: 'unknown',
    scope: 'project',
    originPath,
    tools: [],
    trust: 'hash_changed',
    binarySha,
  };
}

function viewCebabInjected(name: string): McpServerView {
  return {
    name,
    status: 'unknown',
    scope: 'cebab-injected',
    tools: [],
    trust: 'trusted',
  };
}

// ---- short-circuit cases (no pending emitted) ----

describe('awaitMcpTrustDecisions — silent short-circuits', () => {
  test('trusted server emits nothing and resolves immediately', async () => {
    const sink = makeSink();
    const gate = makeTrustGateState();
    const outcome = await awaitMcpTrustDecisions({
      projectId: 1,
      gate,
      send: sink.send,
      servers: [viewTrusted('git-mcp', '/u/proj/.claude/settings.json')],
    });
    expect(sink.sent).toEqual([]);
    expect(outcome.approvals).toBe(0);
    expect(outcome.persistedDenials).toBe(0);
    expect(outcome.refused).toEqual([]);
  });

  test('cebab-injected server is always trusted (no originPath needed)', async () => {
    const sink = makeSink();
    const gate = makeTrustGateState();
    const outcome = await awaitMcpTrustDecisions({
      projectId: 1,
      gate,
      send: sink.send,
      servers: [viewCebabInjected('cebab_bus')],
    });
    expect(sink.sent).toEqual([]);
    expect(outcome.refused).toEqual([]);
  });

  test('persisted-denied server writes a silent-refusal audit row and resolves', async () => {
    const sink = makeSink();
    const gate = makeTrustGateState();
    const outcome = await awaitMcpTrustDecisions({
      projectId: 1,
      gate,
      send: sink.send,
      servers: [viewDenied('shady-mcp', '/u/proj/.claude/settings.json')],
    });
    expect(sink.sent).toEqual([]); // no operator prompt
    expect(outcome.refused).toEqual([
      { serverName: 'shady-mcp', originPath: '/u/proj/.claude/settings.json', persisted: true },
    ]);
    // Audit row should land — we want forensic trace of every spawn past
    // a denial, since Cebab can't (today) prevent the SDK from loading it.
    const auditRows = getDb()
      .prepare(`SELECT kind, reason_code FROM safety_audit WHERE kind = ?`)
      .all('mcp.trust_silent_refusal') as Array<{ kind: string; reason_code: string }>;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.reason_code).toBe('denied_remember');
  });

  test('server without originPath skips silently (no anchor for decision)', async () => {
    const sink = makeSink();
    const gate = makeTrustGateState();
    const view: McpServerView = {
      name: 'orphan',
      status: 'unknown',
      scope: 'project',
      tools: [],
      trust: 'pending_tofu',
      // no originPath
    };
    const outcome = await awaitMcpTrustDecisions({
      projectId: 1,
      gate,
      send: sink.send,
      servers: [view],
    });
    expect(sink.sent).toEqual([]);
    expect(outcome.approvals).toBe(0);
  });
});

// ---- pending path: trust ----

describe('awaitMcpTrustDecisions — first_seen prompt + trust decision', () => {
  test('pending_tofu emits a first_seen envelope and parks the spawn', async () => {
    const sink = makeSink();
    const gate = makeTrustGateState();
    const view = viewPending('new-mcp', '/u/proj/.claude/settings.json', '/usr/local/bin/new-mcp');

    const gatePromise = awaitMcpTrustDecisions({
      projectId: 42,
      gate,
      send: sink.send,
      servers: [view],
    });

    // The pending envelope should have been sent synchronously.
    expect(sink.sent).toHaveLength(1);
    const env = sink.sent[0] as Extract<ServerMsg, { type: 'mcp_auto_install_pending' }>;
    expect(env.type).toBe('mcp_auto_install_pending');
    expect(env.serverName).toBe('new-mcp');
    expect(env.originPath).toBe('/u/proj/.claude/settings.json');
    expect(env.command).toBe('/usr/local/bin/new-mcp');
    expect(env.reason).toBe('first_seen');
    expect(env.previousSha).toBeUndefined();

    // The gate is parked — pendingId entry exists.
    expect(gate.pending.size).toBe(1);
    const entry = gate.pending.get(env.pendingId);
    expect(entry).toBeDefined();

    // Operator decides 'trust' → resolve the entry. The gate promise
    // should now resolve.
    entry!.resolve({ kind: 'allow' });
    const outcome = await gatePromise;

    expect(outcome.approvals).toBe(1);
    expect(outcome.refused).toEqual([]);
    expect(gate.pending.size).toBe(0); // entry cleaned up

    // mcp_trust row written.
    const lookup = checkTrust('new-mcp', '/u/proj/.claude/settings.json', null);
    expect(lookup.decision).toBe('trusted');
  });

  test('allow_pinned writes trusted_pinned_hash with the supplied sha', async () => {
    const sink = makeSink();
    const gate = makeTrustGateState();
    const view = viewPending('pinned-mcp', '/u/proj/.claude/settings.json', '/bin/x');
    const gatePromise = awaitMcpTrustDecisions({
      projectId: 1,
      gate,
      send: sink.send,
      servers: [view],
    });
    const env = sink.sent[0] as Extract<ServerMsg, { type: 'mcp_auto_install_pending' }>;
    const entry = gate.pending.get(env.pendingId)!;
    entry.resolve({ kind: 'allow_pinned', binarySha: 'abc123pinned' });
    await gatePromise;
    const lookup = checkTrust('pinned-mcp', '/u/proj/.claude/settings.json', 'abc123pinned');
    expect(lookup.decision).toBe('trusted_pinned_hash');
    expect(lookup.decision === 'trusted_pinned_hash' && lookup.binarySha).toBe('abc123pinned');
  });
});

// ---- pending path: deny_remember + deny_once ----

describe('awaitMcpTrustDecisions — deny outcomes', () => {
  test('deny_remember persists denied_remember and refuses', async () => {
    const sink = makeSink();
    const gate = makeTrustGateState();
    const view = viewPending('drop-mcp', '/u/proj/.claude/settings.json');
    const gatePromise = awaitMcpTrustDecisions({
      projectId: 7,
      gate,
      send: sink.send,
      servers: [view],
    });
    const env = sink.sent[0] as Extract<ServerMsg, { type: 'mcp_auto_install_pending' }>;
    const entry = gate.pending.get(env.pendingId)!;
    entry.resolve({ kind: 'deny_remember' });
    const outcome = await gatePromise;

    expect(outcome.persistedDenials).toBe(1);
    expect(outcome.refused).toEqual([
      { serverName: 'drop-mcp', originPath: '/u/proj/.claude/settings.json', persisted: true },
    ]);
    const lookup = checkTrust('drop-mcp', '/u/proj/.claude/settings.json', null);
    expect(lookup.decision).toBe('denied_remember');
  });

  test('deny_once populates the in-memory set, no mcp_trust row written', async () => {
    const sink = makeSink();
    const gate = makeTrustGateState();
    const view = viewPending('once-mcp', '/u/proj/.claude/settings.json');
    const gatePromise = awaitMcpTrustDecisions({
      projectId: 9,
      gate,
      send: sink.send,
      servers: [view],
    });
    const env = sink.sent[0] as Extract<ServerMsg, { type: 'mcp_auto_install_pending' }>;
    const entry = gate.pending.get(env.pendingId)!;
    entry.resolve({ kind: 'deny_once' });
    const outcome = await gatePromise;

    expect(outcome.refused).toEqual([
      { serverName: 'once-mcp', originPath: '/u/proj/.claude/settings.json', persisted: false },
    ]);
    expect(gate.denyOnce.has(denyOnceKey(9, 'once-mcp', '/u/proj/.claude/settings.json'))).toBe(
      true,
    );
    // No mcp_trust row — deny_once is in-memory.
    expect(checkTrust('once-mcp', '/u/proj/.claude/settings.json', null).decision).toBe(
      'first_seen',
    );
  });

  test('deny_once short-circuits the same gate state on a repeat pass (no re-prompt)', async () => {
    const sink = makeSink();
    const gate = makeTrustGateState();
    const view = viewPending('repeat-mcp', '/u/proj/.claude/settings.json');

    // First pass: operator deny_once.
    const first = awaitMcpTrustDecisions({
      projectId: 5,
      gate,
      send: sink.send,
      servers: [view],
    });
    const firstEnv = sink.sent[0] as Extract<ServerMsg, { type: 'mcp_auto_install_pending' }>;
    gate.pending.get(firstEnv.pendingId)!.resolve({ kind: 'deny_once' });
    await first;
    expect(sink.sent).toHaveLength(1);

    // Second pass: same gate state, same project+server. Should short-
    // circuit without prompting; outcome includes the silent refusal.
    const secondOutcome = await awaitMcpTrustDecisions({
      projectId: 5,
      gate,
      send: sink.send,
      servers: [view],
    });
    expect(sink.sent).toHaveLength(1); // no new pending envelope
    expect(secondOutcome.refused).toEqual([
      { serverName: 'repeat-mcp', originPath: '/u/proj/.claude/settings.json', persisted: false },
    ]);
  });

  test('fresh gate state (new connection) re-prompts even after deny_once on another gate', async () => {
    const view = viewPending('reset-mcp', '/u/proj/.claude/settings.json');

    // First connection: deny_once.
    const sinkA = makeSink();
    const gateA = makeTrustGateState();
    const promiseA = awaitMcpTrustDecisions({
      projectId: 1,
      gate: gateA,
      send: sinkA.send,
      servers: [view],
    });
    const envA = sinkA.sent[0] as Extract<ServerMsg, { type: 'mcp_auto_install_pending' }>;
    gateA.pending.get(envA.pendingId)!.resolve({ kind: 'deny_once' });
    await promiseA;

    // Second connection: fresh gate state. Should prompt again.
    const sinkB = makeSink();
    const gateB = makeTrustGateState();
    const promiseB = awaitMcpTrustDecisions({
      projectId: 1,
      gate: gateB,
      send: sinkB.send,
      servers: [view],
    });
    expect(sinkB.sent).toHaveLength(1); // new pending envelope!
    const envB = sinkB.sent[0] as Extract<ServerMsg, { type: 'mcp_auto_install_pending' }>;
    expect(envB.type).toBe('mcp_auto_install_pending');
    expect(envB.pendingId).not.toBe(envA.pendingId);
    gateB.pending.get(envB.pendingId)!.resolve({ kind: 'allow' });
    await promiseB;
  });
});

// ---- hash_changed flow ----

describe('awaitMcpTrustDecisions — hash_changed flow', () => {
  test('hash_changed envelope carries previousSha from the prior pinned row', async () => {
    // Pre-seed: pin a prior decision with sha 'oldsha'.
    recordTrustDecision({
      serverName: 'churn-mcp',
      originPath: '/u/proj/.claude/settings.json',
      binarySha: 'oldsha',
      decision: 'trusted_pinned_hash',
    });

    const sink = makeSink();
    const gate = makeTrustGateState();
    const view = viewHashChanged('churn-mcp', '/u/proj/.claude/settings.json', 'newsha');
    const gatePromise = awaitMcpTrustDecisions({
      projectId: 1,
      gate,
      send: sink.send,
      servers: [view],
    });
    const env = sink.sent[0] as Extract<ServerMsg, { type: 'mcp_auto_install_pending' }>;
    expect(env.reason).toBe('hash_changed');
    expect(env.previousSha).toBe('oldsha');
    expect(env.binarySha).toBe('newsha');

    // Operator re-pins with the new hash.
    gate.pending.get(env.pendingId)!.resolve({ kind: 'allow_pinned', binarySha: 'newsha' });
    await gatePromise;

    // Lookup with the new sha now returns trusted_pinned_hash.
    const lookup = checkTrust('churn-mcp', '/u/proj/.claude/settings.json', 'newsha');
    expect(lookup.decision).toBe('trusted_pinned_hash');
  });
});

// ---- multiple servers in one pass ----

describe('awaitMcpTrustDecisions — multiple servers', () => {
  test('mixed-state input: trusted bypassed, two pendings prompted, all resolve', async () => {
    const sink = makeSink();
    const gate = makeTrustGateState();
    const servers = [
      viewTrusted('ok-mcp', '/u/p/.claude/settings.json'),
      viewPending('a-mcp', '/u/p/.claude/settings.json'),
      viewPending('b-mcp', '/u/p/.claude/settings.json'),
      viewCebabInjected('cebab_bus'),
    ];
    const gatePromise = awaitMcpTrustDecisions({
      projectId: 1,
      gate,
      send: sink.send,
      servers,
    });
    expect(sink.sent).toHaveLength(2); // one envelope per pending
    expect(gate.pending.size).toBe(2);

    // Resolve in reverse order to confirm the gate isn't order-sensitive.
    const entries = [...gate.pending.values()];
    entries[1]!.resolve({ kind: 'allow' });
    entries[0]!.resolve({ kind: 'deny_remember' });
    const outcome = await gatePromise;

    expect(outcome.approvals).toBe(1);
    expect(outcome.persistedDenials).toBe(1);
  });
});

// ---- BE-1: audit-write failure ----

describe('awaitMcpTrustDecisions — [security] BE-1: audit-write failure', () => {
  test(
    'audit append throwing inside applyDecision does not freeze the gate',
    { tag: 'security' } as never,
    async () => {
      const sink = makeSink();
      const gate = makeTrustGateState();
      // Make the safety_audit append throw on the very first call. The
      // gate's try/finally MUST still resolve the spawn promise so the
      // caller doesn't hang forever — but the mcp_trust row should NOT
      // land (recordTrustDecision calls appendSafetyAudit BEFORE the
      // mcp_trust INSERT per BE-1, so the throw aborts the dual-write).
      vi.spyOn(safetyAudit, 'appendSafetyAudit').mockImplementation(() => {
        throw new Error('audit chain broken');
      });
      const view = viewPending('audit-fail-mcp', '/u/p/.claude/settings.json');
      const gatePromise = awaitMcpTrustDecisions({
        projectId: 1,
        gate,
        send: sink.send,
        servers: [view],
      });
      const env = sink.sent[0] as Extract<ServerMsg, { type: 'mcp_auto_install_pending' }>;
      // Resolve with 'allow' — applyDecision will try to recordTrustDecision,
      // which calls appendSafetyAudit which throws. The synchronous throw
      // escapes the resolve call by design (production handler catches it
      // and emits wrapper_error); we mirror that pattern here. The gate's
      // try/finally still resolves the spawn promise so the caller
      // doesn't hang.
      let caught: unknown;
      try {
        gate.pending.get(env.pendingId)!.resolve({ kind: 'allow' });
      } catch (err) {
        caught = err;
      }
      expect((caught as Error)?.message).toBe('audit chain broken');
      // The gate promise should still resolve (not hang).
      await gatePromise;
      expect(gate.pending.size).toBe(0); // entry cleaned up

      // mcp_trust row should NOT exist — BE-1's "audit first; if audit
      // throws, the persisted state isn't written" guarantee.
      const rowCount = (
        getDb().prepare(`SELECT COUNT(*) AS n FROM mcp_trust`).get() as { n: number }
      ).n;
      expect(rowCount).toBe(0);
    },
  );
});
