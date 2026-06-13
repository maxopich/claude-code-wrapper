/* eslint-disable require-yield --
 * Several test fixtures here use `async function*` generators that immediately
 * throw (simulating an SDK iterator that fails before yielding any messages).
 * That's intentional — the runner's retry / failure paths are what we're
 * exercising. require-yield otherwise flags every throw-only generator. */
import { describe, expect, test, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { MockOptions, RunOptions, Runner } from '../runner/index.js';
import {
  AgentRunner,
  BUS_KINDS,
  DEFAULT_OVERLOAD_BACKOFF_MS,
  handleBusSend,
  isTransientOverload,
  makeBusToolServer,
  type BusEvent,
} from './runner.js';
import { TurnStalledError } from './errors.js';

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

test('makeBusToolServer builds a `cebab_bus` MCP server by default', () => {
  const server = makeBusToolServer('alpha', () => {}) as { type: string; name: string };
  expect(server).toBeTruthy();
  expect(server.type).toBe('sdk');
  expect(server.name).toBe('cebab_bus');
  expect(BUS_KINDS).toEqual(['intro', 'prompt', 'reply', 'final']);
});

test('makeBusToolServer honors a custom server name (used for the `bus` deprecation shim)', () => {
  // runOneAttempt registers a second instance under the `bus` key to keep
  // resumed CLI sessions whose JSONL history calls `mcp__bus__bus_send`
  // resolving after PR #99 renamed the canonical key. The metadata `name`
  // must match the mcpServers key so the SDK advertises the prefix that
  // the resumed history references.
  const server = makeBusToolServer('alpha', () => {}, 'bus') as { type: string; name: string };
  expect(server.name).toBe('bus');
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
    // Canonical key is `cebab_bus` (the rename was deliberate so a worker's
    // own project-defined `mcpServers.bus` cannot collide with the identity-
    // pinned bus_send injection). `bus` is ALSO registered as a deprecation
    // shim so resumed CLI sessions whose JSONL history calls
    // `mcp__bus__bus_send` keep resolving — see the alias coverage below.
    expect(calls[0]!.mcpServers).toHaveProperty('cebab_bus');
    expect(calls[0]!.mcpServers).toHaveProperty('bus');
    expect(calls[1]!.resume).toBe('sess-7');
  });

  test('both `cebab_bus` and `bus` mcpServers expose identity-pinned bus_send (rename deprecation shim)', async () => {
    // Regression for the silent-stall bug seen on Cebab session
    // 67a5e371: PR #99 renamed `bus` → `cebab_bus`, and resumed CLI
    // sessions that still called `mcp__bus__bus_send` from their JSONL
    // history hit "No such tool available", fell back to plain assistant
    // text, and the router dropped the reply. Registering `bus` under the
    // same identity-pinned handler keeps those resumed turns working.
    //
    // The alias must remain identity-pinned: each registration is a
    // separately-built McpSdkServerConfigWithInstance with its own closure
    // capturing the agent name. They are NOT the same object reference, so
    // the two instances cannot share mutable state that an agent could
    // poison.
    const calls: (RunOptions & Partial<MockOptions>)[] = [];
    const runner = new AgentRunner({
      onEvent: () => {},
      runnerFactory: (opts) => {
        calls.push(opts);
        return fakeRunner([resultMsg('s-alias')]);
      },
    });
    runner.register({ name: 'alpha', cwd: '/tmp/alpha' });
    await runner.deliverTurn('alpha', 'go');

    const servers = calls[0]!.mcpServers as Record<string, { type: string; name: string }>;
    expect(servers.cebab_bus?.type).toBe('sdk');
    expect(servers.cebab_bus?.name).toBe('cebab_bus');
    expect(servers.bus?.type).toBe('sdk');
    expect(servers.bus?.name).toBe('bus');
    expect(servers.cebab_bus).not.toBe(servers.bus);
  });

  test('register passes the spec.settingSources through to the SDK', async () => {
    // Chain participants and orchestrator workers register with
    // ['user', 'project', 'local'] so their `.claude/settings*.json` (MCPs,
    // allowedTools, hooks) loads exactly as a standalone `claude` session
    // in the same cwd would. The orchestrator itself registers with
    // ['user'] because its cwd is Cebab-owned and empty. Both paths must
    // reach the SDK unchanged.
    const calls: (RunOptions & Partial<MockOptions>)[] = [];
    const runner = new AgentRunner({
      onEvent: () => {},
      runnerFactory: (opts) => {
        calls.push(opts);
        return fakeRunner([resultMsg('s-ws')]);
      },
    });
    runner.register({
      name: 'worker',
      cwd: '/tmp/worker',
      settingSources: ['user', 'project', 'local'],
    });
    runner.register({
      name: 'orchestrator',
      cwd: '/tmp/orch',
      settingSources: ['user'],
    });

    await runner.deliverTurn('worker', 'go');
    await runner.deliverTurn('orchestrator', 'go');

    expect(calls).toHaveLength(2);
    expect(calls[0]!.settingSources).toEqual(['user', 'project', 'local']);
    expect(calls[1]!.settingSources).toEqual(['user']);
  });

  test('register without settingSources defaults to ["user"]', async () => {
    // Defensive fallback in runOneAttempt: if a registration site forgets
    // to pass settingSources, the SDK runs with the narrowest scope rather
    // than silently inheriting CLI defaults.
    const calls: (RunOptions & Partial<MockOptions>)[] = [];
    const runner = new AgentRunner({
      onEvent: () => {},
      runnerFactory: (opts) => {
        calls.push(opts);
        return fakeRunner([resultMsg('s-default')]);
      },
    });
    runner.register({ name: 'no-spec', cwd: '/tmp/no-spec' });
    await runner.deliverTurn('no-spec', 'go');
    expect(calls[0]!.settingSources).toEqual(['user']);
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
      // Disable the transient-overload retry for this Item #4 unit test —
      // `error_during_execution` is on the retry heuristic so we'd otherwise
      // loop. The retry path has its own coverage in the "529 absorb" suite.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const runner = new AgentRunner({
        onEvent: () => {},
        overloadBackoffMs: [],
        runnerFactory: () => fakeRunner([resultWithSubtype('sess-x', subtype)]),
      });
      runner.register({ name: 'alpha', cwd: '/tmp/alpha' });
      await expect(runner.deliverTurn('alpha', 'go')).rejects.toThrow(
        `SDK result subtype=${subtype}`,
      );
      warnSpy.mockRestore();
    });

    test('the session-id checkpoint is persisted BEFORE the throw', async () => {
      // Without this ordering, a retry of the failed turn would start a
      // fresh CLI session (no --resume) and lose the agent's prior context.
      // Retry disabled here for the same reason as above.
      const onSessionId = vi.fn();
      const runner = new AgentRunner({
        onEvent: () => {},
        onSessionId,
        overloadBackoffMs: [],
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

  // --- Item #5: mutation tap on assistant `tool_use` blocks -------------
  //
  // The runner classifies every `tool_use` block via `classifyToolCall` and
  // fires `onMutation` for non-`read` results BEFORE the SDK would dispatch
  // the tool. A throw from `onMutation` (PausedForMutationError, in
  // production) propagates out of `deliverTurn`; the router's `.catch`
  // recognises the sentinel as a controlled pause.
  describe('mutation tap', () => {
    function assistantWithTool(name: string, input: unknown): SDKMessage {
      return {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'x', name, input }] },
      } as unknown as SDKMessage;
    }

    test('fires onMutation for non-read tool calls (Write, Bash mutate, Bash dangerous)', async () => {
      const seen: {
        agent: string;
        tool: string;
        cwd: string;
        category: string;
        summary: string;
        filePath?: string;
        toolUseId?: string;
      }[] = [];
      const runner = new AgentRunner({
        onEvent: () => {},
        onMutation: (agent, toolName, cwd, cls) => {
          seen.push({
            agent,
            tool: toolName,
            cwd,
            category: cls.category,
            summary: cls.summary,
            ...(cls.filePath !== undefined ? { filePath: cls.filePath } : {}),
            ...(cls.toolUseId !== undefined ? { toolUseId: cls.toolUseId } : {}),
          });
        },
        runnerFactory: () =>
          fakeRunner([
            assistantWithTool('Write', { file_path: '/foo', content: 'x' }),
            assistantWithTool('Bash', { command: 'git commit -m m' }),
            assistantWithTool('Bash', { command: 'rm -rf node_modules' }),
            resultMsg('sess-1'),
          ]),
      });
      runner.register({ name: 'coder', cwd: '/tmp/coder' });
      await runner.deliverTurn('coder', 'go');
      expect(seen).toHaveLength(3);
      expect(seen[0]!.tool).toBe('Write');
      expect(seen[0]!.category).toBe('mutate');
      // Migration 012: Write surfaces filePath; cwd is the agent's spec.cwd;
      // toolUseId is the SDK block's `id` field.
      expect(seen[0]!.cwd).toBe('/tmp/coder');
      expect(seen[0]!.filePath).toBe('/foo');
      expect(seen[0]!.toolUseId).toBe('x');
      expect(seen[1]!.category).toBe('mutate');
      // Bash has no single file_path → filePath is absent.
      expect(seen[1]!.filePath).toBeUndefined();
      expect(seen[2]!.category).toBe('dangerous');
      expect(seen[2]!.summary).toContain('rm -rf');
    });

    test('does NOT fire for read-only tool calls (Read, Grep, git status)', async () => {
      const seen: unknown[] = [];
      const runner = new AgentRunner({
        onEvent: () => {},
        onMutation: () => {
          seen.push(null);
        },
        runnerFactory: () =>
          fakeRunner([
            assistantWithTool('Read', { file_path: '/foo' }),
            assistantWithTool('Grep', { pattern: 'TODO' }),
            assistantWithTool('Bash', { command: 'git status' }),
            resultMsg('sess-1'),
          ]),
      });
      runner.register({ name: 'reviewer', cwd: '/tmp/r' });
      await runner.deliverTurn('reviewer', 'go');
      expect(seen).toEqual([]);
    });

    test('onMutation throwing propagates out of deliverTurn (pause gate path)', async () => {
      class PauseError extends Error {}
      const runner = new AgentRunner({
        onEvent: () => {},
        onMutation: () => {
          throw new PauseError('paused');
        },
        runnerFactory: () =>
          fakeRunner([
            assistantWithTool('Write', { file_path: '/foo', content: 'x' }),
            // The result that would follow never gets observed — the throw aborts the loop.
            resultMsg('sess-1'),
          ]),
      });
      runner.register({ name: 'coder', cwd: '/tmp/coder' });
      await expect(runner.deliverTurn('coder', 'go')).rejects.toBeInstanceOf(PauseError);
    });

    // Migration 012: tool_result tap fires onToolResult for every `tool_result`
    // block on a `user` SDKMessage, regardless of whether the originating
    // tool_use was classified as a mutation. The orchestrator/chain hook
    // narrows by tool_use_id when flipping `confirmed_at`.
    test('fires onToolResult for tool_result blocks on user messages', async () => {
      const seen: { agent: string; toolUseId: string; isError: boolean }[] = [];
      const userWithResult = (id: string, isError = false): SDKMessage =>
        ({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'ok' }],
          },
        }) as unknown as SDKMessage;
      const runner = new AgentRunner({
        onEvent: () => {},
        onToolResult: (agent, toolUseId, meta) => {
          seen.push({ agent, toolUseId, isError: meta.isError });
        },
        runnerFactory: () =>
          fakeRunner([
            assistantWithTool('Write', { file_path: '/foo', content: 'x' }),
            userWithResult('x'),
            assistantWithTool('Bash', { command: 'false' }),
            userWithResult('y', true),
            resultMsg('sess-1'),
          ]),
      });
      runner.register({ name: 'coder', cwd: '/tmp/coder' });
      await runner.deliverTurn('coder', 'go');
      expect(seen).toEqual([
        { agent: 'coder', toolUseId: 'x', isError: false },
        { agent: 'coder', toolUseId: 'y', isError: true },
      ]);
    });

    test('onMutation absent = no-op (back-compat with pre-Item-5 tests)', async () => {
      // Existing tests don't set `onMutation`; assistant messages with
      // tool_use blocks should not break them.
      const runner = new AgentRunner({
        onEvent: () => {},
        runnerFactory: () =>
          fakeRunner([
            assistantWithTool('Write', { file_path: '/foo', content: 'x' }),
            resultMsg('sess-1'),
          ]),
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

  // --- Transient overload retry-with-backoff ----------------------------
  //
  // Multi-agent bus turns hit "API Error: 529 Overloaded" from Anthropic
  // periodically. Without an absorb layer, each transient blip surfaces as
  // Item #4's worker-failure banner and the operator sees the run as
  // "every worker fails". The retry path catches the throw inside the
  // for-await loop, re-spawns a fresh runner (so the SDK's CLI subprocess
  // is also fresh), and re-runs the turn. The session_id checkpoint is
  // persisted BEFORE the throw on non-success result.subtype, so retries
  // resume from the same boundary.
  describe('transient overload retry (529 absorb)', () => {
    test('retries on 529 then succeeds on the next attempt', async () => {
      let n = 0;
      const runner = new AgentRunner({
        onEvent: () => {},
        overloadBackoffMs: [0, 0, 0], // skip real backoff in tests
        runnerFactory: () => {
          n++;
          if (n === 1) {
            async function* boom(): AsyncGenerator<SDKMessage> {
              yield { type: 'system', subtype: 'init' } as unknown as SDKMessage;
              throw new Error('Claude Code returned an error result: API Error: 529 Overloaded');
            }
            const it = boom();
            return { [Symbol.asyncIterator]: () => it, close: () => {} };
          }
          return fakeRunner([resultMsg('sess-success')]);
        },
      });
      runner.register({ name: 'coder', cwd: '/tmp/coder' });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await expect(runner.deliverTurn('coder', 'go')).resolves.toBeUndefined();
      expect(n).toBe(2); // spawned twice: one fail + one success
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toMatch(/coder hit transient overload/);
      warnSpy.mockRestore();
    });

    test('surfaces failure after MAX_RETRIES (backoffMs.length) exhausted', async () => {
      let n = 0;
      const runner = new AgentRunner({
        onEvent: () => {},
        overloadBackoffMs: [0, 0, 0],
        runnerFactory: () => {
          n++;
          async function* boom(): AsyncGenerator<SDKMessage> {
            throw new Error('API Error: 529 Overloaded');
          }
          const it = boom();
          return { [Symbol.asyncIterator]: () => it, close: () => {} };
        },
      });
      runner.register({ name: 'coder', cwd: '/tmp/coder' });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await expect(runner.deliverTurn('coder', 'go')).rejects.toThrow(/529 Overloaded/);
      expect(n).toBe(4); // initial + 3 retries
      warnSpy.mockRestore();
    });

    test('does NOT retry non-transient errors (e.g. ENOENT, unknown CLI failure)', async () => {
      let n = 0;
      const runner = new AgentRunner({
        onEvent: () => {},
        overloadBackoffMs: [0, 0, 0],
        runnerFactory: () => {
          n++;
          async function* boom(): AsyncGenerator<SDKMessage> {
            throw new Error('ENOENT: claude binary not found');
          }
          const it = boom();
          return { [Symbol.asyncIterator]: () => it, close: () => {} };
        },
      });
      runner.register({ name: 'coder', cwd: '/tmp/coder' });

      await expect(runner.deliverTurn('coder', 'go')).rejects.toThrow(/ENOENT/);
      expect(n).toBe(1); // no retries
    });

    test('retries on non-success result.subtype too (Item #4 synthetic Error path)', async () => {
      // The runner converts `m.subtype !== 'success'` to a thrown
      // `Error('SDK result subtype=error_during_execution')`. That string
      // ALSO matches the transient-overload heuristic, so the retry path
      // covers both raw SDK throws and the Item #4 synthetic shape.
      let n = 0;
      const runner = new AgentRunner({
        onEvent: () => {},
        overloadBackoffMs: [0, 0, 0],
        runnerFactory: () => {
          n++;
          if (n <= 2) {
            return fakeRunner([
              {
                type: 'result',
                subtype: 'error_during_execution',
                session_id: `sess-attempt-${n}`,
              } as unknown as SDKMessage,
            ]);
          }
          return fakeRunner([resultMsg('sess-finalized')]);
        },
      });
      runner.register({ name: 'coder', cwd: '/tmp/coder' });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await expect(runner.deliverTurn('coder', 'go')).resolves.toBeUndefined();
      expect(n).toBe(3); // 2 transient failures + 1 success
      warnSpy.mockRestore();
    });

    test('subsequent attempts resume from the prior attempts checkpoint', async () => {
      // When the SDK delivers result(subtype=error_during_execution,
      // session_id=...), the runner persists the session_id BEFORE throwing
      // so a retry can --resume the same boundary instead of forking a
      // fresh CLI session.
      const calls: (RunOptions & Partial<MockOptions>)[] = [];
      let n = 0;
      const runner = new AgentRunner({
        onEvent: () => {},
        overloadBackoffMs: [0, 0, 0],
        runnerFactory: (opts) => {
          calls.push(opts);
          n++;
          if (n === 1) {
            return fakeRunner([
              {
                type: 'result',
                subtype: 'error_during_execution',
                session_id: 'checkpoint-from-failed-attempt',
              } as unknown as SDKMessage,
            ]);
          }
          return fakeRunner([resultMsg('sess-success')]);
        },
      });
      runner.register({ name: 'coder', cwd: '/tmp/coder' });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await runner.deliverTurn('coder', 'go');
      expect(calls).toHaveLength(2);
      expect(calls[0]!.resume).toBeUndefined(); // first attempt: no prior
      expect(calls[1]!.resume).toBe('checkpoint-from-failed-attempt'); // retry resumes
      warnSpy.mockRestore();
    });

    test('aborted signal short-circuits the retry loop', async () => {
      const ac = new AbortController();
      let n = 0;
      const runner = new AgentRunner({
        onEvent: () => {},
        abortController: ac,
        overloadBackoffMs: [0, 0, 0],
        runnerFactory: () => {
          n++;
          async function* boom(): AsyncGenerator<SDKMessage> {
            // Abort before throwing — emulates an operator Stop click landing
            // mid-turn.
            ac.abort();
            throw new Error('API Error: 529 Overloaded');
          }
          const it = boom();
          return { [Symbol.asyncIterator]: () => it, close: () => {} };
        },
      });
      runner.register({ name: 'coder', cwd: '/tmp/coder' });

      await expect(runner.deliverTurn('coder', 'go')).rejects.toThrow(/529 Overloaded/);
      expect(n).toBe(1); // aborted → no retries
    });

    test('runner.close() is called for every attempt (per-attempt subprocess hygiene)', async () => {
      const closes: number[] = [];
      let n = 0;
      const runner = new AgentRunner({
        onEvent: () => {},
        overloadBackoffMs: [0, 0],
        runnerFactory: () => {
          n++;
          const attemptId = n;
          async function* boom(): AsyncGenerator<SDKMessage> {
            if (attemptId <= 2) throw new Error('Overloaded');
            yield resultMsg('sess-ok');
          }
          const it = boom();
          return {
            [Symbol.asyncIterator]: () => it,
            close: () => closes.push(attemptId),
          };
        },
      });
      runner.register({ name: 'coder', cwd: '/tmp/coder' });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await runner.deliverTurn('coder', 'go');
      // Three attempts → three close() calls, one per attempt.
      expect(closes).toEqual([1, 2, 3]);
      warnSpy.mockRestore();
    });

    test('runner.close throwing does not mask the underlying error', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const runner = new AgentRunner({
        onEvent: () => {},
        overloadBackoffMs: [],
        runnerFactory: () => {
          async function* boom(): AsyncGenerator<SDKMessage> {
            throw new Error('genuine failure');
          }
          const it = boom();
          return {
            [Symbol.asyncIterator]: () => it,
            close: () => {
              throw new Error('close fails');
            },
          };
        },
      });
      runner.register({ name: 'coder', cwd: '/tmp/coder' });
      await expect(runner.deliverTurn('coder', 'go')).rejects.toThrow(/genuine failure/);
      errSpy.mockRestore();
    });
  });

  // --- Cluster D Phase 4a: onAutoRetry observability hook (spec §4.2) ----
  //
  // The hook MUST fire once per retry attempt, BEFORE the backoff sleep,
  // with metadata that lets chain.ts / orchestrator.ts emit an `auto_retry`
  // ServerMsg + write a `recovery_log` row. `[security]` BE-D7: the hook
  // MUST NOT fire for non-transient errors (the trust boundary is the
  // existing `isTransientOverload(err)` branch, NOT the catch-all).
  describe('onAutoRetry hook (Cluster D Phase 4a)', () => {
    type AutoRetryCall = {
      agentName: string;
      attempt: number;
      maxAttempts: number;
      backoffMs: number;
      retryAt: number;
      reason: string;
    };

    test('fires once per retry attempt with the correct metadata', async () => {
      const calls: AutoRetryCall[] = [];
      let n = 0;
      const runner = new AgentRunner({
        onEvent: () => {},
        overloadBackoffMs: [10, 20, 30], // distinct delays per attempt
        onAutoRetry: (info) => {
          calls.push({
            agentName: info.agentName,
            attempt: info.attempt,
            maxAttempts: info.maxAttempts,
            backoffMs: info.backoffMs,
            retryAt: info.retryAt,
            reason: info.reason,
          });
        },
        runnerFactory: () => {
          n++;
          if (n < 3) {
            async function* boom(): AsyncGenerator<SDKMessage> {
              throw new Error('API Error: 529 Overloaded');
            }
            return { [Symbol.asyncIterator]: () => boom(), close: () => {} };
          }
          return fakeRunner([resultMsg('sess-ok')]);
        },
      });
      runner.register({ name: 'worker', cwd: '/tmp/w' });

      const before = Date.now();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await runner.deliverTurn('worker', 'go');
      const after = Date.now();
      warnSpy.mockRestore();

      // Two failed attempts → two onAutoRetry calls (attempts 2 and 3).
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({
        agentName: 'worker',
        attempt: 2, // 1-indexed; 1st attempt failed, retry attempt is 2
        maxAttempts: 4, // 3 backoff entries + 1 initial
        backoffMs: 10,
        reason: 'transient_overload',
      });
      expect(calls[1]).toMatchObject({
        agentName: 'worker',
        attempt: 3,
        backoffMs: 20,
      });
      // retryAt = Date.now() + backoffMs ≈ now + delay; we assert it's
      // within the test's wall-clock window with a tiny margin.
      expect(calls[0]!.retryAt).toBeGreaterThanOrEqual(before + 10);
      expect(calls[0]!.retryAt).toBeLessThanOrEqual(after + 10);
    });

    test('fires N times for N failures before success', async () => {
      const calls: AutoRetryCall[] = [];
      let n = 0;
      const runner = new AgentRunner({
        onEvent: () => {},
        overloadBackoffMs: [0, 0, 0],
        onAutoRetry: (info) =>
          calls.push({
            agentName: info.agentName,
            attempt: info.attempt,
            maxAttempts: info.maxAttempts,
            backoffMs: info.backoffMs,
            retryAt: info.retryAt,
            reason: info.reason,
          }),
        runnerFactory: () => {
          n++;
          if (n < 4) {
            async function* boom(): AsyncGenerator<SDKMessage> {
              throw new Error('Overloaded');
            }
            return { [Symbol.asyncIterator]: () => boom(), close: () => {} };
          }
          return fakeRunner([resultMsg('done')]);
        },
      });
      runner.register({ name: 'worker', cwd: '/tmp/w' });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await runner.deliverTurn('worker', 'go');
      warnSpy.mockRestore();

      expect(calls).toHaveLength(3); // 3 retries before success
      expect(calls.map((c) => c.attempt)).toEqual([2, 3, 4]);
    });

    test('also fires when max retries are exhausted (rejected turn)', async () => {
      const calls: AutoRetryCall[] = [];
      const runner = new AgentRunner({
        onEvent: () => {},
        overloadBackoffMs: [0, 0],
        onAutoRetry: (info) =>
          calls.push({
            agentName: info.agentName,
            attempt: info.attempt,
            maxAttempts: info.maxAttempts,
            backoffMs: info.backoffMs,
            retryAt: info.retryAt,
            reason: info.reason,
          }),
        runnerFactory: () => {
          async function* boom(): AsyncGenerator<SDKMessage> {
            throw new Error('API Error: 529 Overloaded');
          }
          return { [Symbol.asyncIterator]: () => boom(), close: () => {} };
        },
      });
      runner.register({ name: 'worker', cwd: '/tmp/w' });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      // 1 initial + 2 retries; the 3rd attempt's failure (no more retries)
      // does NOT fire onAutoRetry — there's no upcoming retry to announce.
      await expect(runner.deliverTurn('worker', 'go')).rejects.toThrow(/Overloaded/);
      warnSpy.mockRestore();

      expect(calls).toHaveLength(2);
      expect(calls[0]!.attempt).toBe(2);
      expect(calls[1]!.attempt).toBe(3);
    });

    test('[security] BE-D7: does NOT fire for non-transient errors', async () => {
      // ENOENT / wrapper-config errors must not silently spin up a retry
      // loop. The hook fires inside the `isTransientOverload(err)` branch
      // only; this test guards that the trust boundary holds.
      const calls: AutoRetryCall[] = [];
      const runner = new AgentRunner({
        onEvent: () => {},
        overloadBackoffMs: [0, 0, 0],
        onAutoRetry: (info) =>
          calls.push({
            agentName: info.agentName,
            attempt: info.attempt,
            maxAttempts: info.maxAttempts,
            backoffMs: info.backoffMs,
            retryAt: info.retryAt,
            reason: info.reason,
          }),
        runnerFactory: () => {
          async function* boom(): AsyncGenerator<SDKMessage> {
            throw new Error('ENOENT: claude binary not found');
          }
          return { [Symbol.asyncIterator]: () => boom(), close: () => {} };
        },
      });
      runner.register({ name: 'worker', cwd: '/tmp/w' });

      await expect(runner.deliverTurn('worker', 'go')).rejects.toThrow(/ENOENT/);
      expect(calls).toEqual([]); // no retry hooks fired
    });

    test('[security] does NOT fire when the abort signal short-circuits the retry', async () => {
      const ac = new AbortController();
      const calls: AutoRetryCall[] = [];
      const runner = new AgentRunner({
        onEvent: () => {},
        abortController: ac,
        overloadBackoffMs: [0, 0, 0],
        onAutoRetry: (info) =>
          calls.push({
            agentName: info.agentName,
            attempt: info.attempt,
            maxAttempts: info.maxAttempts,
            backoffMs: info.backoffMs,
            retryAt: info.retryAt,
            reason: info.reason,
          }),
        runnerFactory: () => {
          async function* boom(): AsyncGenerator<SDKMessage> {
            ac.abort();
            throw new Error('Overloaded');
          }
          return { [Symbol.asyncIterator]: () => boom(), close: () => {} };
        },
      });
      runner.register({ name: 'worker', cwd: '/tmp/w' });

      await expect(runner.deliverTurn('worker', 'go')).rejects.toThrow(/Overloaded/);
      // Abort happened before the retry decision — no `auto_retry`
      // ServerMsg should mislead the operator about a retry that won't
      // happen.
      expect(calls).toEqual([]);
    });

    test('absent hook is a silent no-op (old call sites still work)', async () => {
      // The bus runner predates onAutoRetry; pre-Phase-4a callers that
      // don't set the field must not crash on the optional-call.
      let n = 0;
      const runner = new AgentRunner({
        onEvent: () => {},
        overloadBackoffMs: [0, 0],
        // onAutoRetry NOT set
        runnerFactory: () => {
          n++;
          if (n === 1) {
            async function* boom(): AsyncGenerator<SDKMessage> {
              throw new Error('Overloaded');
            }
            return { [Symbol.asyncIterator]: () => boom(), close: () => {} };
          }
          return fakeRunner([resultMsg('ok')]);
        },
      });
      runner.register({ name: 'worker', cwd: '/tmp/w' });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await expect(runner.deliverTurn('worker', 'go')).resolves.toBeUndefined();
      warnSpy.mockRestore();
      expect(n).toBe(2);
    });
  });
});

describe('isTransientOverload (Item: 529 absorb)', () => {
  test('matches "API Error: 529" exactly', () => {
    expect(
      isTransientOverload(
        new Error('Claude Code returned an error result: API Error: 529 Overloaded'),
      ),
    ).toBe(true);
  });
  test('matches the bare "Overloaded" substring', () => {
    expect(isTransientOverload(new Error('Overloaded'))).toBe(true);
  });
  test('matches the Item #4 synthetic "SDK result subtype=error_during_execution"', () => {
    expect(isTransientOverload(new Error('SDK result subtype=error_during_execution'))).toBe(true);
  });
  test('does NOT match other non-success subtypes', () => {
    expect(isTransientOverload(new Error('SDK result subtype=error_max_turns'))).toBe(false);
    expect(isTransientOverload(new Error('SDK result subtype=error_max_budget_usd'))).toBe(false);
  });
  test('does NOT match unrelated errors', () => {
    expect(isTransientOverload(new Error('ENOENT'))).toBe(false);
    expect(isTransientOverload(new Error('unknown agent ghost'))).toBe(false);
    expect(isTransientOverload(new Error(''))).toBe(false);
  });
  test('handles non-Error values without throwing', () => {
    expect(isTransientOverload(null)).toBe(false);
    expect(isTransientOverload(undefined)).toBe(false);
    expect(isTransientOverload('Overloaded')).toBe(false); // string, not Error
    expect(isTransientOverload({ message: 'Overloaded' })).toBe(false); // plain object
  });
});

describe('DEFAULT_OVERLOAD_BACKOFF_MS', () => {
  test('matches the production tuning (1s/3s/10s = ~14s cumulative absorb)', () => {
    expect(DEFAULT_OVERLOAD_BACKOFF_MS).toEqual([1000, 3000, 10000]);
  });
});

describe('AgentRunner stalled-turn watchdog', () => {
  // A benign liveness tick (not a tool, not a result) — resets the idle clock.
  const streamMsg = (): SDKMessage => ({ type: 'stream_event' }) as unknown as SDKMessage;
  const toolUseMsg = (name: string): SDKMessage =>
    ({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name, id: 't1', input: {} }] },
    }) as unknown as SDKMessage;

  // Yields `initial`, then hangs until close()/interrupt() ends the generator —
  // models a wedged SDK stream that the watchdog's hard-abort tears down.
  function hangingRunner(initial: SDKMessage[]): Runner {
    let release: (() => void) | null = null;
    async function* gen(): AsyncGenerator<SDKMessage> {
      for (const m of initial) yield m;
      await new Promise<void>((res) => {
        release = res;
      });
    }
    const it = gen();
    return {
      [Symbol.asyncIterator]: () => it,
      close: () => release?.(),
      interrupt: () => release?.(),
    } as unknown as Runner;
  }

  // Push-driven runner: `push` emits a message mid-turn; `end` completes it.
  function controllableRunner() {
    const buffer: SDKMessage[] = [];
    let notify: (() => void) | null = null;
    let ended = false;
    async function* gen(): AsyncGenerator<SDKMessage> {
      for (;;) {
        if (buffer.length) {
          yield buffer.shift()!;
          continue;
        }
        if (ended) return;
        await new Promise<void>((res) => {
          notify = res;
        });
      }
    }
    const it = gen();
    const wake = () => {
      const n = notify;
      notify = null;
      n?.();
    };
    return {
      runner: {
        [Symbol.asyncIterator]: () => it,
        close: () => {
          ended = true;
          wake();
        },
      } as unknown as Runner,
      push: (m: SDKMessage) => {
        buffer.push(m);
        wake();
      },
      end: () => {
        ended = true;
        wake();
      },
    };
  }

  test('[security] auto-aborts a wedged turn (no activity) with TurnStalledError', async () => {
    vi.useFakeTimers();
    try {
      const onTurnStalled = vi.fn();
      const onTurnResumed = vi.fn();
      const runner = new AgentRunner({
        onEvent: () => {},
        onTurnStalled,
        onTurnResumed,
        stallNotifyMs: 1_000,
        stallAbortMs: 5_000,
        stallToolCeilingMs: 50_000,
        runnerFactory: () => hangingRunner([]), // yields nothing, then hangs
      });
      runner.register({ name: 'orchestrator', cwd: '/tmp/o' });
      const outcome = runner.deliverTurn('orchestrator', 'go').then(
        () => 'resolved',
        (e) => e,
      );
      await vi.advanceTimersByTimeAsync(1_100);
      expect(onTurnStalled).toHaveBeenCalledTimes(1);
      expect(onTurnStalled.mock.calls[0]![0]).toMatchObject({ agentName: 'orchestrator' });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await outcome).toBeInstanceOf(TurnStalledError);
      expect(onTurnResumed).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a turn that completes promptly never stalls or aborts', async () => {
    vi.useFakeTimers();
    try {
      const onTurnStalled = vi.fn();
      const runner = new AgentRunner({
        onEvent: () => {},
        onTurnStalled,
        stallNotifyMs: 1_000,
        stallAbortMs: 5_000,
        runnerFactory: () => fakeRunner([resultMsg('s-quick')]),
      });
      runner.register({ name: 'a', cwd: '/tmp/a' });
      const outcome = runner.deliverTurn('a', 'go').then(
        () => 'resolved',
        (e) => e,
      );
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await outcome).toBe('resolved');
      expect(onTurnStalled).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a late message clears the stall (onTurnResumed) and the turn finishes', async () => {
    vi.useFakeTimers();
    try {
      const onTurnStalled = vi.fn();
      const onTurnResumed = vi.fn();
      const { runner: r, push, end } = controllableRunner();
      const runner = new AgentRunner({
        onEvent: () => {},
        onTurnStalled,
        onTurnResumed,
        stallNotifyMs: 1_000,
        stallAbortMs: 60_000,
        runnerFactory: () => r,
      });
      runner.register({ name: 'a', cwd: '/tmp/a' });
      const outcome = runner.deliverTurn('a', 'go').then(
        () => 'resolved',
        (e) => e,
      );
      await vi.advanceTimersByTimeAsync(1_100);
      expect(onTurnStalled).toHaveBeenCalledTimes(1);
      push(streamMsg()); // activity → resume
      await vi.advanceTimersByTimeAsync(10);
      expect(onTurnResumed).toHaveBeenCalledTimes(1);
      end();
      await vi.advanceTimersByTimeAsync(10);
      expect(await outcome).toBe('resolved');
    } finally {
      vi.useRealTimers();
    }
  });

  test('a long tool in flight uses the lenient ceiling, not the no-tool abort threshold', async () => {
    vi.useFakeTimers();
    try {
      const onTurnStalled = vi.fn();
      let outcomeVal: unknown = '__pending__';
      const runner = new AgentRunner({
        onEvent: () => {},
        onTurnStalled,
        stallNotifyMs: 1_000,
        stallAbortMs: 5_000,
        stallToolCeilingMs: 60_000,
        runnerFactory: () => hangingRunner([toolUseMsg('Bash')]), // tool mid-flight, then hangs
      });
      runner.register({ name: 'w', cwd: '/tmp/w' });
      void runner.deliverTurn('w', 'go').then(
        () => (outcomeVal = 'resolved'),
        (e) => (outcomeVal = e),
      );
      // Past the no-tool abort threshold (5s) but within the tool ceiling (60s):
      // not aborted, and no stall alert while a tool is legitimately running.
      await vi.advanceTimersByTimeAsync(7_000);
      expect(outcomeVal).toBe('__pending__');
      expect(onTurnStalled).not.toHaveBeenCalled();
      // Past the tool ceiling → still bounded, even for a never-returning tool.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(outcomeVal).toBeInstanceOf(TurnStalledError);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a turn parked on AskUserQuestion is exempt from the stall watchdog', async () => {
    vi.useFakeTimers();
    try {
      const onTurnStalled = vi.fn();
      let answer: ((a: string) => void) | null = null;
      const onAskUserQuestion = () =>
        new Promise<string>((res) => {
          answer = res;
        });
      // The SDK invokes canUseTool('AskUserQuestion'), which parks the turn on
      // the operator; once answered, the turn completes.
      const askingRunner = (opts: RunOptions & Partial<MockOptions>): Runner => {
        async function* gen(): AsyncGenerator<SDKMessage> {
          await (
            opts.canUseTool as unknown as (n: string, i: unknown, o: unknown) => Promise<unknown>
          )('AskUserQuestion', {}, { toolUseID: 'q1', signal: new AbortController().signal });
          yield resultMsg('s-ask');
        }
        const it = gen();
        return { [Symbol.asyncIterator]: () => it, close: () => {} } as unknown as Runner;
      };
      const runner = new AgentRunner({
        onEvent: () => {},
        onTurnStalled,
        onAskUserQuestion,
        stallNotifyMs: 1_000,
        stallAbortMs: 3_000,
        runnerFactory: askingRunner,
      });
      runner.register({ name: 'a', cwd: '/tmp/a' });
      const outcome = runner.deliverTurn('a', 'go').then(
        () => 'resolved',
        (e) => e,
      );
      // Far past both thresholds while parked — the watchdog must stay silent.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(onTurnStalled).not.toHaveBeenCalled();
      expect(answer).not.toBeNull();
      answer!('User selected: X');
      await vi.advanceTimersByTimeAsync(10);
      expect(await outcome).toBe('resolved');
    } finally {
      vi.useRealTimers();
    }
  });
});
