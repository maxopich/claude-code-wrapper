import { describe, expect, test, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { MockOptions, RunOptions, Runner } from '../runner/index.js';
import {
  AgentRunner,
  BUS_KINDS,
  handleBusSend,
  makeBusToolServer,
  type BusEvent,
} from './runner.js';

describe('handleBusSend', () => {
  test('valid send stamps the caller-supplied source and forwards the event', () => {
    const events: BusEvent[] = [];
    const res = handleBusSend('alpha', { recipient: 'beta', kind: 'reply', text: 'hi' }, (e) =>
      events.push(e),
    );
    expect(res.isError).toBeFalsy();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: 'alpha',
      destination: 'beta',
      kind: 'reply',
      text: 'hi',
    });
    expect(typeof events[0]!.ts).toBe('number');
  });

  test('accepts the user and _sink sentinels as recipients', () => {
    const events: BusEvent[] = [];
    handleBusSend('orchestrator', { recipient: 'user', kind: 'final', text: 'done' }, (e) =>
      events.push(e),
    );
    handleBusSend('last', { recipient: '_sink', kind: 'final', text: 'end' }, (e) =>
      events.push(e),
    );
    expect(events.map((e) => e.destination)).toEqual(['user', '_sink']);
  });

  test('rejects invalid recipient without forwarding', () => {
    const onEvent = vi.fn();
    const res = handleBusSend(
      'alpha',
      { recipient: '../../etc', kind: 'reply', text: 'x' },
      onEvent,
    );
    expect(res.isError).toBe(true);
    expect(onEvent).not.toHaveBeenCalled();
  });

  test('rejects unknown kind and empty text without forwarding', () => {
    const onEvent = vi.fn();
    expect(handleBusSend('a', { recipient: 'b', kind: 'gossip', text: 'x' }, onEvent).isError).toBe(
      true,
    );
    expect(handleBusSend('a', { recipient: 'b', kind: 'reply', text: '' }, onEvent).isError).toBe(
      true,
    );
    expect(onEvent).not.toHaveBeenCalled();
  });

  test('[security] an agent cannot forge its source identity', () => {
    // The agent only controls recipient/kind/text. Even if it injects a
    // `source` (or `from`) field, the signature drops it — the stamped
    // source is the per-agent closure value, never agent-controlled.
    const events: BusEvent[] = [];
    handleBusSend(
      'worker-trusted',
      { recipient: 'user', kind: 'final', text: 'pwn', source: 'orchestrator' } as unknown as {
        recipient: string;
        kind: string;
        text: string;
      },
      (e) => events.push(e),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.source).toBe('worker-trusted');
  });
});

test('makeBusToolServer builds a "bus" MCP server', () => {
  const server = makeBusToolServer('alpha', () => {});
  expect(server).toBeTruthy();
  expect(BUS_KINDS).toEqual(['intro', 'prompt', 'reply', 'final']);
});

// --- AgentRunner ---------------------------------------------------------

function fakeRunner(messages: SDKMessage[]): Runner {
  async function* gen(): AsyncGenerator<SDKMessage> {
    for (const m of messages) yield m;
  }
  const it = gen();
  return {
    [Symbol.asyncIterator]: () => it,
    close: () => {},
  };
}

function resultMsg(sessionId: string): SDKMessage {
  return { type: 'result', subtype: 'success', session_id: sessionId } as unknown as SDKMessage;
}

describe('AgentRunner', () => {
  test('first turn has no resume; the next reuses the captured session id', async () => {
    const calls: (RunOptions & Partial<MockOptions>)[] = [];
    const runner = new AgentRunner({
      onEvent: () => {},
      runnerFactory: (opts) => {
        calls.push(opts);
        return fakeRunner([resultMsg('sess-7')]);
      },
    });
    runner.register({ name: 'alpha', cwd: '/tmp/alpha' });

    await runner.deliverTurn('alpha', 'first');
    await runner.deliverTurn('alpha', 'second');

    expect(calls).toHaveLength(2);
    expect(calls[0]!.resume).toBeUndefined();
    expect(calls[0]!.prompt).toBe('first');
    expect(calls[0]!.permissionMode).toBe('bypassPermissions');
    expect(calls[0]!.allowDangerouslySkipPermissions).toBe(true);
    expect(calls[0]!.mcpServers).toHaveProperty('bus');
    expect(calls[1]!.resume).toBe('sess-7');
  });

  test('[R-B] onSessionId fires with the captured session id on result', async () => {
    const captured: { agent: string; cli: string }[] = [];
    const runner = new AgentRunner({
      onEvent: () => {},
      onSessionId: (agent, cli) => captured.push({ agent, cli }),
      runnerFactory: () => fakeRunner([resultMsg('sess-42')]),
    });
    runner.register({ name: 'alpha', cwd: '/tmp/alpha' });
    await runner.deliverTurn('alpha', 'go');
    expect(captured).toEqual([{ agent: 'alpha', cli: 'sess-42' }]);
  });

  test('[R-B] a thrown onSessionId never aborts the turn', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const runner = new AgentRunner({
      onEvent: () => {},
      onSessionId: () => {
        throw new Error('db down');
      },
      runnerFactory: () => fakeRunner([resultMsg('s1')]),
    });
    runner.register({ name: 'a', cwd: '/tmp/a' });
    await expect(runner.deliverTurn('a', 'go')).resolves.toBeUndefined();
    errSpy.mockRestore();
  });

  test('[R-B] seedSession makes the next turn --resume the seeded id', async () => {
    const calls: (RunOptions & Partial<MockOptions>)[] = [];
    const runner = new AgentRunner({
      onEvent: () => {},
      runnerFactory: (opts) => {
        calls.push(opts);
        return fakeRunner([resultMsg('new-sess')]);
      },
    });
    runner.register({ name: 'orchestrator', cwd: '/tmp/o' });
    // Reconstruction rehydrates the in-memory map from the persisted row…
    runner.seedSession('orchestrator', 'pre-restart-sess');
    await runner.deliverTurn('orchestrator', 'continue');
    // …so the very first post-restart turn resumes the real transcript.
    expect(calls[0]!.resume).toBe('pre-restart-sess');
  });

  test('onMessage receives every message tagged with the agent name', async () => {
    const seen: { agent: string; type: string }[] = [];
    const runner = new AgentRunner({
      onEvent: () => {},
      onMessage: (agent, msg) => seen.push({ agent, type: (msg as { type: string }).type }),
      runnerFactory: () =>
        fakeRunner([{ type: 'system', subtype: 'init' } as unknown as SDKMessage, resultMsg('s1')]),
    });
    runner.register({ name: 'beta', cwd: '/tmp/beta' });
    await runner.deliverTurn('beta', 'go');
    expect(seen).toEqual([
      { agent: 'beta', type: 'system' },
      { agent: 'beta', type: 'result' },
    ]);
  });

  test('deliverTurn throws for an unknown agent', async () => {
    const runner = new AgentRunner({ onEvent: () => {}, runnerFactory: () => fakeRunner([]) });
    await expect(runner.deliverTurn('ghost', 'x')).rejects.toThrow(/unknown agent/);
  });

  test('stop() aborts the shared controller', () => {
    const ac = new AbortController();
    const runner = new AgentRunner({
      onEvent: () => {},
      abortController: ac,
      runnerFactory: () => fakeRunner([]),
    });
    runner.stop();
    expect(ac.signal.aborted).toBe(true);
  });

  // --- Item #4: non-success SDK `result.subtype` becomes a throw ---------
  //
  // Before Item #4, the bus runner silently swallowed `result.subtype !=
  // 'success'` — the session_id checkpoint was persisted and the loop just
  // ended, so the router never saw a failure. The single-agent path
  // (`translate.ts`) handled these subtypes; the bus path was blind. The
  // change converts the non-success result into a throw INSIDE the loop so
  // the router's existing `.catch` (now `onWorkerFailed`) sees the same
  // shape it gets from an iterator throw. The session-id write happens
  // BEFORE the throw — retry resumes from the boundary the failed turn saw.
  describe('non-success result.subtype', () => {
    function resultWithSubtype(sessionId: string, subtype: string): SDKMessage {
      return { type: 'result', subtype, session_id: sessionId } as unknown as SDKMessage;
    }

    test.each([
      ['error_during_execution'],
      ['error_max_turns'],
      ['error_max_budget_usd'],
      ['error_max_structured_output_retries'],
    ])('throws for subtype=%s', async (subtype) => {
      const runner = new AgentRunner({
        onEvent: () => {},
        runnerFactory: () => fakeRunner([resultWithSubtype('sess-x', subtype)]),
      });
      runner.register({ name: 'alpha', cwd: '/tmp/alpha' });
      await expect(runner.deliverTurn('alpha', 'go')).rejects.toThrow(
        `SDK result subtype=${subtype}`,
      );
    });

    test('the session-id checkpoint is persisted BEFORE the throw', async () => {
      // Without this ordering, a retry of the failed turn would start a
      // fresh CLI session (no --resume) and lose the agent's prior context.
      const onSessionId = vi.fn();
      const runner = new AgentRunner({
        onEvent: () => {},
        onSessionId,
        runnerFactory: () => fakeRunner([resultWithSubtype('sess-9', 'error_during_execution')]),
      });
      runner.register({ name: 'alpha', cwd: '/tmp/alpha' });
      await expect(runner.deliverTurn('alpha', 'go')).rejects.toThrow();
      expect(onSessionId).toHaveBeenCalledWith('alpha', 'sess-9');
    });

    test('a result without `subtype` is unaffected (back-compat)', async () => {
      // Some SDK paths emit a `result` with only `session_id` (no
      // `subtype`). Don't throw — only the explicit non-success subtypes
      // are failures.
      const runner = new AgentRunner({
        onEvent: () => {},
        runnerFactory: () =>
          fakeRunner([{ type: 'result', session_id: 'sess-untyped' } as unknown as SDKMessage]),
      });
      runner.register({ name: 'a', cwd: '/tmp/a' });
      await expect(runner.deliverTurn('a', 'go')).resolves.toBeUndefined();
    });
  });
});

describe('AgentRunner — per-agent turn serialization', () => {
  const flush = () => new Promise((r) => setImmediate(r));

  test('same-agent turns serialize; the 2nd resumes the 1st checkpoint (orchestrator-race regression)', async () => {
    const order: string[] = [];
    const calls: (RunOptions & Partial<MockOptions>)[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((res) => {
      releaseFirst = res;
    });
    const runner = new AgentRunner({
      onEvent: () => {},
      runnerFactory: (opts) => {
        calls.push(opts);
        const idx = calls.length;
        order.push(`start${idx}`);
        async function* gen(): AsyncGenerator<SDKMessage> {
          if (idx === 1) await firstGate; // hold turn 1 open
          yield resultMsg(`sess-${idx}`);
          order.push(`end${idx}`);
        }
        const it = gen();
        return { [Symbol.asyncIterator]: () => it, close: () => {} };
      },
    });
    runner.register({ name: 'orchestrator', cwd: '/tmp/o' });

    // Two near-simultaneous deliveries — the "5 workers reply to the intro
    // broadcast at once" case. Not awaited between calls.
    const p1 = runner.deliverTurn('orchestrator', 'reply-1');
    const p2 = runner.deliverTurn('orchestrator', 'reply-2');

    await flush();
    // Turn 2 must not have started while turn 1 is still open. (Pre-fix this
    // would be calls.length === 2, both with resume === undefined.)
    expect(calls).toHaveLength(1);
    expect(order).toEqual(['start1']);

    releaseFirst();
    await Promise.all([p1, p2]);

    expect(order).toEqual(['start1', 'end1', 'start2', 'end2']);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.resume).toBeUndefined();
    expect(calls[1]!.resume).toBe('sess-1'); // resumed the lineage turn 1 wrote
  });

  test('different agents are NOT serialized against each other', async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const runner = new AgentRunner({
      onEvent: () => {},
      runnerFactory: (opts) => {
        started.push(opts.prompt!);
        async function* gen(): AsyncGenerator<SDKMessage> {
          await gate;
          yield resultMsg('s');
        }
        const it = gen();
        return { [Symbol.asyncIterator]: () => it, close: () => {} };
      },
    });
    runner.register({ name: 'a', cwd: '/tmp/a' });
    runner.register({ name: 'b', cwd: '/tmp/b' });

    const pa = runner.deliverTurn('a', 'A');
    const pb = runner.deliverTurn('b', 'B');
    await flush();
    // Both started even though neither finished — cross-agent parallelism is
    // preserved (only same-agent turns queue).
    expect([...started].sort()).toEqual(['A', 'B']);

    release();
    await Promise.all([pa, pb]);
  });

  test('a failed turn does not wedge the agent queue', async () => {
    let n = 0;
    const runner = new AgentRunner({
      onEvent: () => {},
      runnerFactory: () => {
        n++;
        if (n === 1) {
          async function* bad(): AsyncGenerator<SDKMessage> {
            // Stream one message, then fail mid-turn (closer to a real
            // deliverTurn rejection than a synchronous factory throw).
            yield { type: 'system', subtype: 'init' } as unknown as SDKMessage;
            throw new Error('turn 1 boom');
          }
          const it = bad();
          return { [Symbol.asyncIterator]: () => it, close: () => {} };
        }
        return fakeRunner([resultMsg('s2')]);
      },
    });
    runner.register({ name: 'orchestrator', cwd: '/tmp/o' });

    const p1 = runner.deliverTurn('orchestrator', 'one');
    const p2 = runner.deliverTurn('orchestrator', 'two');
    await expect(p1).rejects.toThrow(/turn 1 boom/);
    await expect(p2).resolves.toBeUndefined(); // queue advanced past the failure
  });

  test('unknown agent still fast-fails (not queued behind prior turns)', async () => {
    const runner = new AgentRunner({ onEvent: () => {}, runnerFactory: () => fakeRunner([]) });
    await expect(runner.deliverTurn('ghost', 'x')).rejects.toThrow(/unknown agent/);
  });
});
