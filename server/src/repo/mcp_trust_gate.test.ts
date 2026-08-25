import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { McpServerView, ServerMsg } from '@cebab/shared/protocol';
import { closeDb, getDb } from '../db.js';
import { config } from '../config.js';
import { _resetOperatorIdCache } from '../notifications/operator.js';
import { checkTrust, recordTrustDecision } from './mcp_trust.js';
import {
  awaitMcpTrustDecisions,
  denyOnceKey,
  makeTrustGateState,
  refuseUnapprovedForProbe,
} from './mcp_trust_gate.js';
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

/**
 * Cebab-rxg: the trust identity now includes the declaration, so a lookup has
 * to ask about the SAME command/args the gate recorded. `viewPending` with no
 * command produces a view with no `config`, and the gate records `''` / `[]`
 * for it — hence the defaults here.
 */
function look(
  name: string,
  originPath: string,
  candidateSha: string | null,
  command = '',
  candidateScriptShas: Record<string, string> | null = null,
) {
  return checkTrust({
    serverName: name,
    originPath,
    candidateSha,
    command,
    args: [],
    candidateScriptShas,
  });
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
    // The declaration is part of the identity (Cebab-rxg), so the lookup has
    // to name the command the gate just recorded. Asking with a different one
    // returns `declaration_changed` — which is the whole point, and is what
    // this line caught when it was first adapted.
    const lookup = look('new-mcp', '/u/proj/.claude/settings.json', null, '/usr/local/bin/new-mcp');
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
    const lookup = look('pinned-mcp', '/u/proj/.claude/settings.json', 'abc123pinned', '/bin/x');
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
    const lookup = look('drop-mcp', '/u/proj/.claude/settings.json', null);
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
    expect(look('once-mcp', '/u/proj/.claude/settings.json', null).decision).toBe('first_seen');
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
      // Same (empty) declaration the config-less `viewHashChanged` produces —
      // this case is about the HASH changing, so the declaration must not.
      command: '',
      args: [],
      binarySha: 'oldsha',
      scriptShas: null,
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
    const lookup = look('churn-mcp', '/u/proj/.claude/settings.json', 'newsha');
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

// ---------------------------------------------------------------------------
// Register H04: the refusal list is the gate's OUTPUT, not just bookkeeping.
//
// Before this, `outcome.refused` was written at four sites and read at none —
// grep confirmed zero consumers — and `gateProjectsForSpawn` returned `void`.
// The operator clicked Deny, Cebab wrote an audit row saying so, and the SDK
// loaded the binary regardless. These cases pin the contract that makes the
// decision bind: every refusal route must surface a server NAME the caller can
// hand to the spawn.
// ---------------------------------------------------------------------------
describe('[security] H04 — refusals reach the caller', () => {
  test('a persisted denial is reported, not just audited', async () => {
    const gate = makeTrustGateState();
    const sink = makeSink();
    const outcome = await awaitMcpTrustDecisions({
      projectId: 1,
      gate,
      send: sink.send,
      servers: [viewDenied('evil', '/p/.mcp.json')],
    });
    expect(outcome.refused).toEqual([
      { serverName: 'evil', originPath: '/p/.mcp.json', persisted: true },
    ]);
    // Silent: a persisted denial must not re-prompt.
    expect(sink.sent).toHaveLength(0);
  });

  test('a per-session deny_once is reported', async () => {
    const gate = makeTrustGateState();
    gate.denyOnce.add(denyOnceKey(1, 'evil', '/p/.mcp.json'));
    const outcome = await awaitMcpTrustDecisions({
      projectId: 1,
      gate,
      send: makeSink().send,
      servers: [viewPending('evil', '/p/.mcp.json')],
    });
    expect(outcome.refused.map((r) => r.serverName)).toEqual(['evil']);
    expect(outcome.refused[0]!.persisted).toBe(false);
  });

  test('a denial decided DURING this gate pass is reported', async () => {
    const gate = makeTrustGateState();
    const sink = makeSink();
    const p = awaitMcpTrustDecisions({
      projectId: 1,
      gate,
      send: sink.send,
      servers: [viewPending('evil', '/p/.mcp.json', '/usr/bin/evil')],
    });
    const env = sink.sent[0] as Extract<ServerMsg, { type: 'mcp_auto_install_pending' }>;
    gate.pending.get(env.pendingId)!.resolve({ kind: 'deny_remember' });
    const outcome = await p;
    // This is the case that matters most: the operator is looking at the
    // modal when they refuse, so this is the refusal they expect to bind.
    expect(outcome.refused.map((r) => r.serverName)).toEqual(['evil']);
    expect(outcome.persistedDenials).toBe(1);
  });

  test('an all-trusted project refuses nothing', async () => {
    const outcome = await awaitMcpTrustDecisions({
      projectId: 1,
      gate: makeTrustGateState(),
      send: makeSink().send,
      servers: [viewTrusted('fine', '/p/.mcp.json'), viewCebabInjected('cebab_bus')],
    });
    // The empty case has to stay empty — a spurious name here would strip a
    // legitimate server's tools from every run.
    expect(outcome.refused).toEqual([]);
  });

  test('the audit row records that the refusal was enforced', async () => {
    await awaitMcpTrustDecisions({
      projectId: 7,
      gate: makeTrustGateState(),
      send: makeSink().send,
      servers: [viewDenied('evil', '/p/.mcp.json')],
    });
    const row = getDb()
      .prepare(`SELECT payload_json FROM safety_audit WHERE kind = 'mcp.trust_silent_refusal'`)
      .get() as { payload_json: string } | undefined;
    expect(row).toBeDefined();
    const payload = JSON.parse(row!.payload_json) as { enforcement?: string };
    // Distinguishes post-H04 rows (denial applied) from the older rows that
    // recorded a refusal the spawn then ignored.
    expect(payload.enforcement).toBe('denied_mcp_servers+disallowed_tools');
  });
});

// ---- Cebab-rxg: declaration_changed flow ----

describe('[security] a rewritten declaration re-gates instead of passing silently', () => {
  const ORIGIN = '/u/proj/.mcp.json';

  /** A view shaped the way `enrichWithTrustState` shapes one, for a declared
   *  server whose trust state the resolver has already computed. */
  function view(trust: McpServerView['trust'], command: string, args: string[]): McpServerView {
    return {
      name: 'kitchen',
      status: 'unknown',
      scope: 'mcp-json',
      originPath: ORIGIN,
      tools: [],
      trust,
      config: { command, args },
    };
  }

  test('the operator is prompted, with what they approved before', async () => {
    // Step 1: the operator approves `node mcp/kitchen-server.mjs` through the
    // gate, exactly as the live repro did.
    const sinkA = makeSink();
    const gateA = makeTrustGateState();
    const promiseA = awaitMcpTrustDecisions({
      projectId: 7,
      gate: gateA,
      send: sinkA.send,
      servers: [view('pending_tofu', 'node', ['mcp/kitchen-server.mjs'])],
    });
    const envA = sinkA.sent[0] as Extract<ServerMsg, { type: 'mcp_auto_install_pending' }>;
    expect(envA.reason).toBe('first_seen');
    gateA.pending.get(envA.pendingId)!.resolve({ kind: 'allow' });
    await promiseA;

    // Step 2: `.mcp.json` is rewritten in place — same name, same command,
    // different script. This is what the resolver now computes for it.
    expect(
      checkTrust({
        serverName: 'kitchen',
        originPath: ORIGIN,
        candidateSha: null,
        candidateScriptShas: null,
        command: 'node',
        args: ['mcp/swapped-server.mjs'],
      }).decision,
    ).toBe('declaration_changed');

    // Step 3: the gate prompts rather than continuing. Before this change the
    // switch took `case 'trusted': continue` and the swapped script spawned
    // with no modal, no refusal and no audit row.
    const sinkB = makeSink();
    const gateB = makeTrustGateState();
    const promiseB = awaitMcpTrustDecisions({
      projectId: 7,
      gate: gateB,
      send: sinkB.send,
      servers: [view('declaration_changed', 'node', ['mcp/swapped-server.mjs'])],
    });
    expect(sinkB.sent).toHaveLength(1);
    const envB = sinkB.sent[0] as Extract<ServerMsg, { type: 'mcp_auto_install_pending' }>;
    expect(envB.reason).toBe('declaration_changed');
    // The operator cannot judge the change without both halves of it.
    expect(envB.previousCommand).toBe('node');
    expect(envB.previousArgs).toEqual(['mcp/kitchen-server.mjs']);
    expect(envB.command).toBe('node');
    expect(envB.args).toEqual(['mcp/swapped-server.mjs']);

    // And denying it keeps the swapped script out.
    gateB.pending.get(envB.pendingId)!.resolve({ kind: 'deny_remember' });
    const outcome = await promiseB;
    expect(outcome.persistedDenials).toBe(1);
  });

  test('approving the new declaration makes the NEXT spawn silent again', async () => {
    // Steady state has to come back, or every subsequent spawn re-prompts and
    // the gate becomes noise the operator clicks through.
    const sink = makeSink();
    const gate = makeTrustGateState();
    const promise = awaitMcpTrustDecisions({
      projectId: 7,
      gate,
      send: sink.send,
      servers: [view('declaration_changed', 'node', ['mcp/swapped-server.mjs'])],
    });
    const env = sink.sent[0] as Extract<ServerMsg, { type: 'mcp_auto_install_pending' }>;
    gate.pending.get(env.pendingId)!.resolve({ kind: 'allow' });
    await promise;

    expect(
      checkTrust({
        serverName: 'kitchen',
        originPath: ORIGIN,
        candidateSha: null,
        candidateScriptShas: null,
        command: 'node',
        args: ['mcp/swapped-server.mjs'],
      }).decision,
    ).toBe('trusted');
  });
});

// ---- Cebab-1af: script_changed flow ----

describe('[security] a rewritten script re-gates, and the prompt names the file', () => {
  const ORIGIN = '/u/proj/.mcp.json';
  const ARGS = ['mcp/kitchen-server.mjs'];
  const V1 = 'a'.repeat(64);
  const V2 = 'b'.repeat(64);

  /** A view shaped the way `enrichWithTrustState` shapes one once it has
   *  hashed the declaration's files. */
  function view(
    trust: McpServerView['trust'],
    scriptShas: Record<string, string>,
    scriptChanges?: McpServerView['scriptChanges'],
  ): McpServerView {
    return {
      name: 'kitchen',
      status: 'unknown',
      scope: 'mcp-json',
      originPath: ORIGIN,
      tools: [],
      trust,
      config: { command: 'node', args: ARGS },
      scriptShas,
      ...(scriptChanges ? { scriptChanges } : {}),
    };
  }

  test('the prompt carries the changed file and both hashes', async () => {
    // Step 1: approve `node mcp/kitchen-server.mjs` at V1 through the gate.
    const sinkA = makeSink();
    const gateA = makeTrustGateState();
    const promiseA = awaitMcpTrustDecisions({
      projectId: 9,
      gate: gateA,
      send: sinkA.send,
      servers: [view('pending_tofu', { [ARGS[0]]: V1 })],
    });
    gateA.pending
      .get((sinkA.sent[0] as Extract<ServerMsg, { type: 'mcp_auto_install_pending' }>).pendingId)!
      .resolve({ kind: 'allow' });
    await promiseA;

    // Step 2: the DECLARATION is untouched — only the file's bytes moved. This
    // is what the ledger now says about it, and it is the assertion that fails
    // if `applyDecision` did not persist the approved shas in step 1.
    const lookup = checkTrust({
      serverName: 'kitchen',
      originPath: ORIGIN,
      candidateSha: null,
      command: 'node',
      args: ARGS,
      candidateScriptShas: { [ARGS[0]]: V2 },
    });
    expect(lookup.decision).toBe('script_changed');

    // Step 3: the gate prompts. Reddens: leaving `script_changed` out of the
    // switch, where it would hit the exhaustiveness `default` and `continue` —
    // the swapped script spawning with no modal and no audit row.
    const sinkB = makeSink();
    const gateB = makeTrustGateState();
    const promiseB = awaitMcpTrustDecisions({
      projectId: 9,
      gate: gateB,
      send: sinkB.send,
      servers: [
        view('script_changed', { [ARGS[0]]: V2 }, [{ path: ARGS[0], previousSha: V1, sha: V2 }]),
      ],
    });
    expect(sinkB.sent).toHaveLength(1);
    const env = sinkB.sent[0] as Extract<ServerMsg, { type: 'mcp_auto_install_pending' }>;
    expect(env.reason).toBe('script_changed');
    // The declaration is identical on both sides, so this list is the ONLY
    // thing distinguishing the two spawns for the operator. Reddens: dropping
    // `changedScripts` from the envelope, which leaves a modal that says a
    // script changed and cannot say which.
    expect(env.changedScripts).toEqual([{ path: ARGS[0], previousSha: V1, sha: V2 }]);
    expect(env.command).toBe('node');
    expect(env.args).toEqual(ARGS);

    gateB.pending.get(env.pendingId)!.resolve({ kind: 'deny_remember' });
    expect((await promiseB).persistedDenials).toBe(1);
  });

  test('approving the new bytes makes the NEXT spawn silent again', async () => {
    // Steady state has to come back, or the gate re-prompts every spawn and
    // becomes noise the operator clicks through. Reddens: `applyDecision`
    // passing `scriptShas: null` — which persists a row that pins nothing, so
    // this lookup answers `trusted` for the wrong reason and the case after it
    // (a THIRD version) would never fire.
    const sink = makeSink();
    const gate = makeTrustGateState();
    const promise = awaitMcpTrustDecisions({
      projectId: 9,
      gate,
      send: sink.send,
      servers: [
        view('script_changed', { [ARGS[0]]: V2 }, [{ path: ARGS[0], previousSha: V1, sha: V2 }]),
      ],
    });
    const env = sink.sent[0] as Extract<ServerMsg, { type: 'mcp_auto_install_pending' }>;
    gate.pending.get(env.pendingId)!.resolve({ kind: 'allow' });
    await promise;

    const ask = (shas: Record<string, string>) =>
      checkTrust({
        serverName: 'kitchen',
        originPath: ORIGIN,
        candidateSha: null,
        command: 'node',
        args: ARGS,
        candidateScriptShas: shas,
      }).decision;
    expect(ask({ [ARGS[0]]: V2 })).toBe('trusted');
    // …and the new baseline is the approved bytes, not merely "something".
    expect(ask({ [ARGS[0]]: 'c'.repeat(64) })).toBe('script_changed');
  });
});

// ---- Cebab-ygu.6 / Cebab-ygu.17: what a probe is allowed to start ----

describe('[security] refuseUnapprovedForProbe — a probe starts only what is trusted', () => {
  const ORIGIN = '/u/proj/.mcp.json';

  function view(name: string, trust: McpServerView['trust'], over: Partial<McpServerView> = {}) {
    return {
      name,
      status: 'unknown',
      scope: 'mcp-json',
      originPath: ORIGIN,
      tools: [],
      trust,
      ...over,
    } as McpServerView;
  }

  function refusalRows(): Array<{ reason_code: string; payload_json: string }> {
    return getDb()
      .prepare<[], { reason_code: string; payload_json: string }>(
        `SELECT reason_code, payload_json FROM safety_audit
          WHERE kind = 'mcp.trust_silent_refusal' ORDER BY id`,
      )
      .all();
  }

  test('a denied server is refused AND the enforcement is recorded', () => {
    // The failure both beads describe: the operator answered "Deny & remember"
    // on a real turn, then landed on the project and the probe started the
    // binary anyway — no prompt, no refusal, no row.
    const refused = refuseUnapprovedForProbe(3, [view('payments', 'denied')]);
    expect(refused).toEqual(['payments']);
    const rows = refusalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason_code).toBe('denied_remember');
    expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({
      projectId: 3,
      serverName: 'payments',
      originPath: ORIGIN,
      enforcement: 'denied_mcp_servers+disallowed_tools',
    });
  });

  test('every not-yet-approved state is refused, with no audit row', () => {
    // Nothing was DECIDED for these, so there is no enforcement to record —
    // and a row per sidebar navigation would be noise in a chain that exists
    // to be read. The refusal itself is what matters.
    //
    // `rewritten` is Cebab-1af's state, and it needed no edit to this function
    // — the code is a whitelist of ONE, so a sixth trust state is refused by
    // construction. The case is here anyway, because the property that a new
    // state defaults to refused is only true while nobody turns the whitelist
    // into a list of known-bad values.
    const refused = refuseUnapprovedForProbe(3, [
      view('never-seen', 'pending_tofu'),
      view('rebuilt', 'hash_changed'),
      view('swapped', 'declaration_changed'),
      view('rewritten', 'script_changed'),
    ]);
    expect(refused).toEqual(['never-seen', 'rebuilt', 'swapped', 'rewritten']);
    expect(refusalRows()).toEqual([]);
  });

  test('a trusted server is NOT refused', () => {
    // The control. Without it "refuse everything" passes every case above, and
    // the panel would report nothing for anybody — the probe exists to read a
    // status that only exists because the server ran.
    expect(refuseUnapprovedForProbe(3, [view('approved', 'trusted')])).toEqual([]);
    expect(refusalRows()).toEqual([]);
  });

  test('cebab-injected and anchorless rows are skipped, matching the gate', () => {
    // Same two skips `awaitMcpTrustDecisions` makes. `cebab_bus` is pinned by
    // Cebab; a row with no originPath has no anchor for a decision, so naming
    // it here would refuse something no operator can ever approve.
    const refused = refuseUnapprovedForProbe(3, [
      view('cebab_bus', 'trusted', { scope: 'cebab-injected' }),
      view('no-anchor', 'unknown', { originPath: undefined }),
    ]);
    expect(refused).toEqual([]);
  });

  test('a mixed project refuses only the unapproved half', () => {
    const refused = refuseUnapprovedForProbe(3, [
      view('approved', 'trusted'),
      view('payments', 'denied'),
      view('never-seen', 'pending_tofu'),
    ]);
    expect(refused).toEqual(['payments', 'never-seen']);
    expect(refusalRows()).toHaveLength(1); // only the standing decision
  });
});
