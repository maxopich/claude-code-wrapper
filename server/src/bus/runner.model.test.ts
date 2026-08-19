// Cebab-ws0.3 on the bus path.
//
// The operator's model choice reaches bus participants too, which means the
// absent-vs-undefined rule has a SECOND site to get wrong. `bus/runner.ts`
// composes its options by conditional spread, so `...(spec.model ? {model} : {})`
// and `model: spec.model` look equally plausible at the call site and differ in
// exactly the way that matters. Asserted here against the same captured
// `runnerFactory` the rest of runner.test.ts uses.
import { describe, expect, test } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { MockOptions, RunOptions } from '../runner/index.js';
import { AgentRunner } from './runner.js';

function fakeRunner(msgs: SDKMessage[]) {
  const it = msgs[Symbol.iterator]();
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        const n = it.next();
        return n.done
          ? { done: true as const, value: undefined }
          : { done: false as const, value: n.value };
      },
    }),
    close: () => {},
  };
}

function capture() {
  const calls: (RunOptions & Partial<MockOptions>)[] = [];
  const runner = new AgentRunner({
    onEvent: () => {},
    runnerFactory: (opts) => {
      calls.push(opts);
      return fakeRunner([
        { type: 'result', subtype: 'success', session_id: 's-1' } as unknown as SDKMessage,
      ]);
    },
  });
  return { runner, calls };
}

describe('bus participant model', () => {
  test('a spec with no model produces options with NO model key', async () => {
    const { runner, calls } = capture();
    runner.register({ name: 'alpha', cwd: '/tmp/alpha' });
    await runner.deliverTurn('alpha', 'go');
    // The byte-identical guarantee, on the bus path. `in`, not
    // `toBeUndefined()` — the latter passes on `{ model: undefined }`, which
    // is the bug.
    expect('model' in calls[0]!).toBe(false);
  });

  test('a spec with a model passes it through verbatim', async () => {
    const { runner, calls } = capture();
    runner.register({ name: 'alpha', cwd: '/tmp/alpha', model: 'opus[1m]' });
    await runner.deliverTurn('alpha', 'go');
    expect(calls[0]!.model).toBe('opus[1m]');
  });

  test('the model is per-agent, not per-runner', async () => {
    // Two participants from different projects must be able to disagree. A
    // model hoisted to runner-level config would pass the two tests above and
    // fail this one.
    const { runner, calls } = capture();
    runner.register({ name: 'alpha', cwd: '/tmp/alpha', model: 'sonnet' });
    runner.register({ name: 'beta', cwd: '/tmp/beta' });
    await runner.deliverTurn('alpha', 'go');
    await runner.deliverTurn('beta', 'go');
    expect(calls[0]!.model).toBe('sonnet');
    expect('model' in calls[1]!).toBe(false);
  });

  test('the model survives across hops of the same agent', async () => {
    const { runner, calls } = capture();
    runner.register({ name: 'alpha', cwd: '/tmp/alpha', model: 'haiku' });
    await runner.deliverTurn('alpha', 'first');
    await runner.deliverTurn('alpha', 'second');
    expect(calls.map((c) => c.model)).toEqual(['haiku', 'haiku']);
  });
});
