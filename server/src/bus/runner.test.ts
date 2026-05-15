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
});
