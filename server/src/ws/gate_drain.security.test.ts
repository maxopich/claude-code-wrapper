import { describe, expect, test, vi } from 'vitest';
import { withTempDataDir } from '../test_support/temp_data_dir.js';
import { getDb } from '../db.js';
import { upsertProject } from '../repo/projects.js';
import {
  abandonPendingMcpGates,
  awaitMcpTrustDecisions,
  makeTrustGateState,
} from '../repo/mcp_trust_gate.js';
import {
  abandonPendingStartGates,
  awaitEnvInjectionAck,
  makeStartGateState,
} from '../repo/session_start_gate.js';
import {
  abandonPendingBusGates,
  awaitBusTrustDecision,
  makeBusTrustGateState,
} from '../bus/install_trust_gate.js';
import { MAX_PENDING_GATES } from '../gate_abandon.js';
import type { McpServerView, ServerMsg } from '@cebab/shared/protocol';

/**
 * Register B20 + H15: a parked spawn gate must not outlive the operator who
 * was asked for the decision.
 *
 * Three gates block a spawn on an operator reply, and all three documented a
 * WS disconnect as the escape hatch — two of them as the ONLY one. None of it
 * worked: dropping the `Conn` does not settle a promise, so the awaiting
 * spawn stayed suspended forever and its async frame kept the `Conn` alive.
 *
 * The assertions below are all "the promise settled", which only measures
 * anything because before the drain it did NOT — every one of these tests
 * hangs to the vitest timeout against the un-drained code, which is the
 * revert-check direction and what makes them non-vacuous.
 */

withTempDataDir('cebab-gate-drain-');

/** Resolves true if `p` settles within `ms`, false if it is still pending. */
async function settlesWithin(p: Promise<unknown>, ms = 500): Promise<boolean> {
  const pending = Symbol('pending');
  const raced = await Promise.race([
    p.then(
      () => 'resolved',
      () => 'rejected',
    ),
    new Promise((r) => setTimeout(() => r(pending), ms)),
  ]);
  return raced !== pending;
}

function mcpServer(name: string): McpServerView {
  return {
    name,
    status: 'connected',
    originPath: '/proj/.claude/settings.json',
    scope: 'project',
    tools: [],
    trust: 'pending_tofu',
    config: { command: '/usr/bin/thing', args: [] },
    binarySha: 'abc123',
  };
}

describe('[security] a disconnect releases every parked MCP trust decision', () => {
  test('the awaiting spawn rejects instead of hanging forever', async () => {
    const gate = makeTrustGateState();
    const sent: ServerMsg[] = [];
    const p = awaitMcpTrustDecisions({
      projectId: 1,
      gate,
      send: (m) => sent.push(m),
      servers: [mcpServer('srv-a'), mcpServer('srv-b')],
    });
    // Both prompts are on the wire and both decisions are parked.
    expect(sent).toHaveLength(2);
    expect(gate.pending.size).toBe(2);
    expect(await settlesWithin(p, 50)).toBe(false);

    expect(abandonPendingMcpGates(gate, 'client disconnected')).toBe(2);
    await expect(p).rejects.toThrow(/mcp-trust gate abandoned/);
    expect(gate.pending.size).toBe(0);
  });

  test('the abandon error classifies as an abort, not a crash', async () => {
    // `ws/errors.ts` maps `name === 'AbortError'` to WrapperErrorKind
    // 'aborted' — register S02b's posture, that a deliberate end must not
    // surface to the operator as "Turn failed".
    const gate = makeTrustGateState();
    const p = awaitMcpTrustDecisions({
      projectId: 1,
      gate,
      send: () => undefined,
      servers: [mcpServer('srv-a')],
    });
    abandonPendingMcpGates(gate, 'client disconnected');
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('no trust decision is persisted — nobody decided anything', async () => {
    const gate = makeTrustGateState();
    const p = awaitMcpTrustDecisions({
      projectId: 1,
      gate,
      send: () => undefined,
      servers: [mcpServer('srv-a')],
    });
    abandonPendingMcpGates(gate, 'client disconnected');
    await expect(p).rejects.toThrow();

    const rows = getDb().prepare('SELECT COUNT(*) AS c FROM mcp_trust').get() as { c: number };
    expect(rows.c).toBe(0);
  });
});

describe('[security] a disconnect must NOT let an unacknowledged spawn proceed', () => {
  test('the env-injection start gate rejects — resolving it would spawn', async () => {
    // THE case where the mechanical repair is the regression. This gate has
    // no deny path: `resolve()` means "the operator typed the trigger, go".
    // Draining it the way the two trust gates drain — resolve with a refusal
    // — would start a session whose credential-injection acknowledgment
    // nobody gave.
    const gate = makeStartGateState();
    const sent: ServerMsg[] = [];
    const p = awaitEnvInjectionAck({
      projectId: 1,
      gate,
      send: (m) => sent.push(m),
      injections: [
        {
          envKey: 'ANTHROPIC_API_KEY',
          scope: 'project',
          scopePath: '/proj/.claude/settings.json',
          posture: 'subscription auth',
          isSet: true,
        },
      ],
    });
    expect(sent[0]).toMatchObject({ type: 'session_start_gated' });
    expect(await settlesWithin(p, 50)).toBe(false);

    expect(abandonPendingStartGates(gate, 'client disconnected')).toBe(1);
    await expect(p).rejects.toThrow(/session-start gate abandoned/);
  });

  test('no acknowledgment row is written for an operator who never answered', async () => {
    const gate = makeStartGateState();
    const p = awaitEnvInjectionAck({
      projectId: 1,
      gate,
      send: () => undefined,
      injections: [
        {
          envKey: 'ANTHROPIC_API_KEY',
          scope: 'project',
          scopePath: '/proj/.claude/settings.json',
          posture: 'subscription auth',
          isSet: true,
        },
      ],
    });
    abandonPendingStartGates(gate, 'client disconnected');
    await expect(p).rejects.toThrow();

    const rows = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM safety_audit WHERE kind = 'session.start_gated_override'`)
      .get() as { c: number };
    expect(rows.c).toBe(0);
  });
});

describe('[security] a disconnect releases every parked bus-install decision', () => {
  test('the awaiting install rejects instead of hanging forever', async () => {
    upsertProject('demo', '/tmp/demo');
    const gate = makeBusTrustGateState();
    const sent: ServerMsg[] = [];
    const p = awaitBusTrustDecision({
      projectId: 1,
      contextSessionId: null,
      gate,
      send: (m) => sent.push(m),
    });
    // Let the pre-park DB reads finish before asserting on the map.
    await new Promise((r) => setTimeout(r, 10));
    expect(sent[0]).toMatchObject({ type: 'bus_auto_install_pending' });
    expect(gate.pending.size).toBe(1);

    expect(abandonPendingBusGates(gate, 'client disconnected')).toBe(1);
    await expect(p).rejects.toThrow(/bus-trust gate abandoned/);
  });
});

describe('[security] the parked-decision ceiling fails closed', () => {
  test('MCP: past the cap, servers are refused rather than parked', async () => {
    const gate = makeTrustGateState();
    const servers = Array.from({ length: MAX_PENDING_GATES + 3 }, (_, i) => mcpServer(`srv-${i}`));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const p = awaitMcpTrustDecisions({
      projectId: 1,
      gate,
      send: () => undefined,
      servers,
    });

    // The map is bounded, and the overflow became refusals — not silent
    // approvals, which is the direction that would matter.
    expect(gate.pending.size).toBe(MAX_PENDING_GATES);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('already parked'));

    abandonPendingMcpGates(gate, 'client disconnected');
    await expect(p).rejects.toThrow();
    warn.mockRestore();
  });

  test('start gate: past the cap, the spawn is refused rather than parked', async () => {
    const gate = makeStartGateState();
    const parked: Array<Promise<unknown>> = [];
    for (let i = 0; i < MAX_PENDING_GATES; i += 1) {
      const p = awaitEnvInjectionAck({
        projectId: i + 1,
        gate,
        send: () => undefined,
        injections: [
          {
            envKey: 'ANTHROPIC_API_KEY',
            scope: 'project',
            scopePath: '/proj/.claude/settings.json',
            posture: 'subscription auth',
            isSet: true,
          },
        ],
      });
      p.catch(() => undefined);
      parked.push(p);
    }
    expect(gate.pending.size).toBe(MAX_PENDING_GATES);

    await expect(
      awaitEnvInjectionAck({
        projectId: 9999,
        gate,
        send: () => undefined,
        injections: [
          {
            envKey: 'ANTHROPIC_API_KEY',
            scope: 'project',
            scopePath: '/proj/.claude/settings.json',
            posture: 'subscription auth',
            isSet: true,
          },
        ],
      }),
    ).rejects.toThrow(/already parked/);

    abandonPendingStartGates(gate, 'test cleanup');
    await Promise.allSettled(parked);
  });
});

describe('[security] draining is safe to call when nothing is parked', () => {
  test('all three report zero and do not throw', () => {
    expect(abandonPendingMcpGates(makeTrustGateState(), 'x')).toBe(0);
    expect(abandonPendingBusGates(makeBusTrustGateState(), 'x')).toBe(0);
    expect(abandonPendingStartGates(makeStartGateState(), 'x')).toBe(0);
  });
});
