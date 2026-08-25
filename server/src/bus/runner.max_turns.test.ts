// `Cebab-vie.17` — the per-hop turn cap, on the bus path.
//
// The bus passed no `maxTurns` at all while the single-agent path passed one,
// so a hop was an unbounded agent turn: the hop budget counts MESSAGES between
// agents and has never counted the work inside one. Asserted here against the
// same captured `runnerFactory` `runner.model.test.ts` uses, and for the same
// reason it has to be: `runMock` type-accepts `maxTurns` and ignores it, so no
// replay can ever produce a real `error_max_turns` — the captured options
// object is the only honest witness that the value reaches a spawn.
import { describe, expect, test, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import type { MockOptions, RunOptions, Runner } from '../runner/index.js';
import { AgentRunner, type AgentRunnerDeps } from './runner.js';
import { MaxTurnsReachedError } from './errors.js';

function fakeRunner(msgs: SDKMessage[]): Runner {
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

function capture(deps: Partial<AgentRunnerDeps> = {}) {
  const calls: (RunOptions & Partial<MockOptions>)[] = [];
  const runner = new AgentRunner({
    onEvent: () => {},
    ...deps,
    runnerFactory: (opts) => {
      calls.push(opts);
      return fakeRunner([
        { type: 'result', subtype: 'success', session_id: 's-1' } as unknown as SDKMessage,
      ]);
    },
  });
  return { runner, calls };
}

describe('bus per-hop turn cap', () => {
  test('a runner with NO maxTurns dep still spawns with a cap', async () => {
    // The anti-vacuity partner of the next case. A suite that only checks
    // "deps.maxTurns = 7 produces 7" goes green while every production spawn
    // that forgot to pass one stays unbounded — which was the bug.
    //
    // `in`, not `toBeUndefined()`: the latter passes on `{ maxTurns: undefined }`,
    // and `buildSdkOptions` guards on `!== undefined`, so that object would
    // reach the SDK with no cap at all.
    const { runner, calls } = capture();
    runner.register({ name: 'alpha', cwd: '/tmp/alpha' });
    await runner.deliverTurn('alpha', 'go');
    expect('maxTurns' in calls[0]!).toBe(true);
    expect(calls[0]!.maxTurns).toBe(config.maxTurns);
  });

  test('the dep value reaches every agent of the session', async () => {
    // Non-default on purpose: 50 would be satisfied by the floor above, so a
    // regression that dropped the dep entirely would still pass.
    const { runner, calls } = capture({ maxTurns: 7 });
    runner.register({ name: 'alpha', cwd: '/tmp/alpha' });
    runner.register({ name: 'beta', cwd: '/tmp/beta' });
    await runner.deliverTurn('alpha', 'go');
    await runner.deliverTurn('beta', 'go');
    expect(calls.map((c) => c.maxTurns)).toEqual([7, 7]);
  });

  test('an agent registered mid-run inherits the session cap', async () => {
    // The orchestrator's `addWorker` path. A per-SPEC field would have to
    // remember this fourth `register()` site; a per-session dep cannot forget.
    const { runner, calls } = capture({ maxTurns: 7 });
    runner.register({ name: 'alpha', cwd: '/tmp/alpha' });
    await runner.deliverTurn('alpha', 'go');
    runner.register({ name: 'gamma', cwd: '/tmp/gamma' });
    await runner.deliverTurn('gamma', 'go');
    expect(calls[1]!.maxTurns).toBe(7);
  });

  test('a transient-overload retry re-spawns with the same cap', async () => {
    // The cap is resolved per ATTEMPT, inside the retry loop. Resolving it
    // outside would still pass the three cases above.
    const calls: (RunOptions & Partial<MockOptions>)[] = [];
    let n = 0;
    const runner = new AgentRunner({
      onEvent: () => {},
      maxTurns: 7,
      overloadBackoffMs: [0],
      runnerFactory: (opts) => {
        calls.push(opts);
        n += 1;
        if (n === 1) {
          // eslint-disable-next-line require-yield -- the point is that it throws
          async function* boom(): AsyncGenerator<SDKMessage> {
            throw new Error('Overloaded');
          }
          return { [Symbol.asyncIterator]: () => boom(), close: () => {} };
        }
        return fakeRunner([
          { type: 'result', subtype: 'success', session_id: 's-1' } as unknown as SDKMessage,
        ]);
      },
    });
    runner.register({ name: 'alpha', cwd: '/tmp/alpha' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await runner.deliverTurn('alpha', 'go');
    warnSpy.mockRestore();
    expect(calls.map((c) => c.maxTurns)).toEqual([7, 7]);
  });
});

describe('bus cap hit', () => {
  function capResult(sessionId: string, numTurns: number): SDKMessage {
    // `num_turns`, snake_case — this narrows the RAW SDKMessage. `numTurns`
    // here would compile, read `undefined` forever, and make this whole file
    // agree with a broken implementation.
    return {
      type: 'result',
      subtype: 'error_max_turns',
      session_id: sessionId,
      num_turns: numTurns,
    } as unknown as SDKMessage;
  }

  test('error_max_turns throws the typed sentinel carrying the cap and the count', async () => {
    const runner = new AgentRunner({
      onEvent: () => {},
      maxTurns: 7,
      overloadBackoffMs: [],
      runnerFactory: () => fakeRunner([capResult('sess-x', 7)]),
    });
    runner.register({ name: 'alpha', cwd: '/tmp/alpha' });
    const err = await runner.deliverTurn('alpha', 'go').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MaxTurnsReachedError);
    const cap = err as MaxTurnsReachedError;
    expect(cap.agentName).toBe('alpha');
    expect(cap.maxTurns).toBe(7);
    expect(cap.numTurns).toBe(7);
    // The operator-facing half. `onWorkerFailed` renders this verbatim, so
    // "reads like an SDK enum" is a real regression and not a style note.
    expect(cap.message).toContain('cap of 7 model turns (7 ran)');
    expect(cap.message).toContain('Retry');
    expect(cap.message).not.toContain('subtype=');
  });

  test('the cap the sentinel reports is the cap that was spawned', async () => {
    // One resolution feeding both, so the two can only disagree by an edit
    // that reintroduces a second `?? config.maxTurns`.
    const calls: (RunOptions & Partial<MockOptions>)[] = [];
    const runner = new AgentRunner({
      onEvent: () => {},
      overloadBackoffMs: [],
      runnerFactory: (opts) => {
        calls.push(opts);
        return fakeRunner([capResult('sess-x', 50)]);
      },
    });
    runner.register({ name: 'alpha', cwd: '/tmp/alpha' });
    const err = (await runner
      .deliverTurn('alpha', 'go')
      .catch((e: unknown) => e)) as MaxTurnsReachedError;
    expect(err.maxTurns).toBe(calls[0]!.maxTurns);
  });

  test('a cap hit is spawned exactly once, even with the retry loop armed', async () => {
    // Not the vie.14 control — the message carries no trigger substring, so
    // this passes even with the `isBusControlSignal` registration missing.
    // It pins the outcome; `runner.test.ts` pins the reason.
    let n = 0;
    const runner = new AgentRunner({
      onEvent: () => {},
      maxTurns: 7,
      overloadBackoffMs: [0, 0, 0],
      runnerFactory: () => {
        n += 1;
        return fakeRunner([capResult('sess-x', 7)]);
      },
    });
    runner.register({ name: 'alpha', cwd: '/tmp/alpha' });
    await expect(runner.deliverTurn('alpha', 'go')).rejects.toBeInstanceOf(MaxTurnsReachedError);
    expect(n).toBe(1);
  });

  test('the checkpoint is persisted BEFORE the cap throw', async () => {
    // The sentinel's own message promises "Retry resumes from where it
    // stopped". That is only true if the `--resume` id was written first.
    const onSessionId = vi.fn();
    const runner = new AgentRunner({
      onEvent: () => {},
      onSessionId,
      maxTurns: 7,
      overloadBackoffMs: [],
      runnerFactory: () => fakeRunner([capResult('sess-cap', 7)]),
    });
    runner.register({ name: 'alpha', cwd: '/tmp/alpha' });
    await expect(runner.deliverTurn('alpha', 'go')).rejects.toBeInstanceOf(MaxTurnsReachedError);
    expect(onSessionId).toHaveBeenCalledWith('alpha', 'sess-cap');
  });
});
