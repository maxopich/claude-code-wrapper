import { createSdkMcpServer, tool, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../config.js';
import { makeBusToolServer } from '../bus/runner.js';
import {
  resolveBusFixture,
  resolveSdkMcpTool,
  runMock,
  substituteMockVars,
  type MockOptions,
} from './mock.js';

// F13: the mock runner could not execute a tool call, so no fixture in any
// format could produce a `bus_send` — which is the only way a multi-agent
// session advances. These cover the three pieces that changed: dispatching a
// replayed tool call to an in-process MCP server, consulting `canUseTool`
// first, and resolving which script a given (agent, turn) replays.

let originalInterval: number;

beforeEach(() => {
  originalInterval = config.mockIntervalMs;
  config.mockIntervalMs = 0;
});

afterEach(() => {
  config.mockIntervalMs = originalInterval;
});

async function drain(runner: AsyncIterable<SDKMessage>): Promise<SDKMessage[]> {
  const out: SDKMessage[] = [];
  for await (const m of runner) out.push(m);
  return out;
}

type ResultBlock = { type: string; tool_use_id: string; content: unknown; is_error?: boolean };

function toolResults(messages: SDKMessage[]): ResultBlock[] {
  return messages.flatMap((m) => {
    const um = m as { type?: string; message?: { content?: unknown } };
    if (um.type !== 'user' || !Array.isArray(um.message?.content)) return [];
    return (um.message.content as ResultBlock[]).filter((b) => b?.type === 'tool_result');
  });
}

/**
 * A second in-process server, to prove dispatch keys off the configured server
 * name rather than assuming Cebab's own.
 */
function spyServer(name: string, calls: unknown[]) {
  return createSdkMcpServer({
    name,
    version: '0.0.0',
    tools: [
      tool('echo', 'echo back', { text: z.string() }, async (args) => {
        calls.push(args);
        return { content: [{ type: 'text' as const, text: `echoed ${args.text}` }] };
      }),
    ],
  });
}

const CHAIN_VARS = { SELF: 'alpha', NEXT: 'beta', KIND: 'reply' };

function chainRun(over: Partial<MockOptions> = {}): MockOptions {
  return {
    cwd: '/tmp/mock',
    prompt: 'go',
    mockScenario: 'chain',
    mockAgent: 'alpha',
    mockTurn: 0,
    mockVars: CHAIN_VARS,
    ...over,
  };
}

describe('resolveSdkMcpTool', () => {
  test('[security] resolves bus_send from the real makeBusToolServer output', () => {
    // Pins the private `_registeredTools` shape this dispatch depends on. If an
    // Agent SDK upgrade changes it, this fails here rather than degrading every
    // bus replay into the silent do-nothing state F13 describes.
    const servers = { cebab_bus: makeBusToolServer('alpha', () => {}) };
    const resolved = resolveSdkMcpTool(servers, 'mcp__cebab_bus__bus_send');
    expect(typeof resolved?.handler).toBe('function');
    expect(typeof resolved?.inputSchema?.safeParse).toBe('function');
  });

  test('a tool on a server we did not inject is not ours to run', () => {
    const servers = { cebab_bus: makeBusToolServer('alpha', () => {}) };
    // Captured transcripts are full of these. Returning null keeps the
    // pre-existing contract that the fixture supplies its own tool_result.
    expect(resolveSdkMcpTool(servers, 'mcp__claude_ai_Gmail__search')).toBeNull();
    expect(resolveSdkMcpTool(undefined, 'mcp__cebab_bus__bus_send')).toBeNull();
    expect(resolveSdkMcpTool(servers, 'Bash')).toBeNull();
  });

  test('a missing tool on a server that IS ours throws', () => {
    const servers = { cebab_bus: makeBusToolServer('alpha', () => {}) };
    // A fixture naming a tool Cebab never injected is a fixture bug; failing
    // quietly here would look identical to a working replay.
    expect(() => resolveSdkMcpTool(servers, 'mcp__cebab_bus__bus_broadcast')).toThrow(
      /registers only \[bus_send\]/,
    );
  });

  test('an underscored server name is matched by key, not by splitting on __', () => {
    // `cebab_bus` contains an underscore; a regex that split `mcp__(.+?)__(.+)`
    // would read the server as `cebab` and the tool as `bus__bus_send`.
    const servers = { cebab_bus: makeBusToolServer('alpha', () => {}) };
    expect(resolveSdkMcpTool(servers, 'mcp__cebab__bus__bus_send')).toBeNull();
  });
});

describe('substituteMockVars', () => {
  test('substitutes known names and leaves unknown ones alone', () => {
    expect(substituteMockVars('to ${NEXT} as ${KIND}', CHAIN_VARS)).toBe('to beta as reply');
    // Fixture prose legitimately contains shell syntax; refusing to replay
    // because of it would be a worse failure than a literal placeholder.
    expect(substituteMockVars('cd ${HOME}', CHAIN_VARS)).toBe('cd ${HOME}');
    expect(substituteMockVars('${NEXT}', undefined)).toBe('${NEXT}');
  });

  test('[security] a value escapes into the JSON string it lands in', () => {
    const line = '{"recipient":"${NEXT}"}';
    const hostile = { NEXT: 'beta","kind":"final' };
    const out = substituteMockVars(line, hostile);
    // Substitution happens before parse, so an unescaped value would inject a
    // second field. The parsed object must have exactly the one key.
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['recipient']);
    expect(parsed.recipient).toBe('beta","kind":"final');
  });
});

describe('resolveBusFixture', () => {
  test('prefers the per-turn script, then the per-agent one', () => {
    expect(resolveBusFixture('orchestrator', 'orchestrator', 0)).toMatch(
      /orchestrator[\\/]orchestrator\.0\.jsonl$/,
    );
    // Turn 1 has no dedicated file, so the agent-wide script answers — that is
    // what makes the orchestrator finish on every hop after the first.
    expect(resolveBusFixture('orchestrator', 'orchestrator', 1)).toMatch(
      /orchestrator[\\/]orchestrator\.jsonl$/,
    );
  });

  test('falls through to _default for an agent the scenario cannot name', () => {
    // A shipped scenario never knows the operator's project slugs.
    expect(resolveBusFixture('orchestrator', 'some-operator-project', 3)).toMatch(
      /orchestrator[\\/]_default\.jsonl$/,
    );
    expect(resolveBusFixture('chain', 'whatever', 0)).toMatch(/chain[\\/]_default\.jsonl$/);
  });

  test('no match is an error that names every candidate', () => {
    // Never a silent fallback to hello.jsonl — that is the failure mode this
    // whole mechanism exists to remove.
    expect(() => resolveBusFixture('nope', 'alpha', 2)).toThrow(/alpha\.2\.jsonl/);
    expect(() => resolveBusFixture('nope', 'alpha', 2)).toThrow(/_default\.jsonl/);
  });
});

describe('runMock — in-process tool dispatch', () => {
  test('executes a replayed bus_send against the injected server', async () => {
    const events: unknown[] = [];
    const messages = await drain(
      runMock(
        chainRun({
          mcpServers: { cebab_bus: makeBusToolServer('alpha', (ev) => events.push(ev)) },
        }),
      ),
    );

    // The whole point: a fixture produced a real BusEvent, identity pinned to
    // the agent the runner registered — not to anything the fixture said.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: 'alpha',
      destination: 'beta',
      kind: 'reply',
    });

    const results = toolResults(messages);
    expect(results).toHaveLength(1);
    expect(results[0]!.is_error).toBeUndefined();
    // The synthesized user message is ordered after the assistant turn that
    // called the tool, the way the real stream is.
    const assistantIdx = messages.findIndex((m) => (m as { type?: string }).type === 'assistant');
    const resultIdx = messages.findIndex((m) => (m as { type?: string }).type === 'user');
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(resultIdx).toBeGreaterThan(assistantIdx);
  });

  test('a schema violation answers like the real MCP server would', async () => {
    const events: unknown[] = [];
    const messages = await drain(
      runMock(
        chainRun({
          mcpServers: { cebab_bus: makeBusToolServer('alpha', (ev) => events.push(ev)) },
          // `kind` is a zod enum; a fixture that drifts off it must surface as
          // a failed call, not as a message that silently never sends.
          mockVars: { ...CHAIN_VARS, KIND: 'not-a-kind' },
        }),
      ),
    );

    const results = toolResults(messages);
    expect(results).toHaveLength(1);
    expect(results[0]!.is_error).toBe(true);
    expect(String(results[0]!.content)).toMatch(/Input validation error/);
    expect(events).toEqual([]);
  });

  test('dispatch keys off the configured server name, not a hardcoded one', async () => {
    const calls: unknown[] = [];
    const events: unknown[] = [];
    const messages = await drain(
      runMock(
        chainRun({
          mcpServers: {
            cebab_bus: makeBusToolServer('alpha', (ev) => events.push(ev)),
            other: spyServer('other', calls),
          },
        }),
      ),
    );
    // Both servers are configured; only the one the fixture names runs.
    expect(events).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(toolResults(messages)).toHaveLength(1);
  });

  test('an allowed built-in is left to the fixture', async () => {
    // Captured transcripts already carry their own tool_result for Read/Bash;
    // synthesizing a second would corrupt every existing fixture.
    const messages = await drain(
      runMock({
        cwd: '/tmp/mock',
        prompt: 'hi',
        mcpServers: { cebab_bus: makeBusToolServer('alpha', () => {}) },
      }),
    );
    expect(toolResults(messages)).toEqual([]);
  });

  test('a bus participant gets a per-agent session id', async () => {
    // Otherwise every agent checkpoints the literal 'mock-session' and
    // `multi_agent_agent_sessions` holds N indistinguishable rows.
    const messages = await drain(
      runMock(
        chainRun({
          mockAgent: 'beta',
          mcpServers: { cebab_bus: makeBusToolServer('beta', () => {}) },
        }),
      ),
    );
    expect(new Set(messages.map((m) => (m as { session_id?: string }).session_id))).toEqual(
      new Set(['mock-beta']),
    );
  });
});

describe('runMock — canUseTool', () => {
  test('a deny returns the message as an is_error tool_result and never runs the tool', async () => {
    const events: unknown[] = [];
    const asked: string[] = [];
    const canUseTool = async (toolName: string) => {
      asked.push(toolName);
      return { behavior: 'deny' as const, message: 'User selected: Option B' };
    };
    const messages = await drain(
      runMock(
        chainRun({
          canUseTool,
          mcpServers: { cebab_bus: makeBusToolServer('alpha', (ev) => events.push(ev)) },
        }),
      ),
    );

    expect(asked).toEqual(['mcp__cebab_bus__bus_send']);
    // The bus depends on this exact shape: an AskUserQuestion answer comes
    // back to the model AS the tool result, flagged is_error.
    const results = toolResults(messages);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ is_error: true, content: 'User selected: Option B' });
    expect(events).toEqual([]);
  });

  test('an allow with updatedInput is what actually reaches the tool', async () => {
    const events: Array<{ destination?: string }> = [];
    const messages = await drain(
      runMock(
        chainRun({
          canUseTool: async (_name, input) => ({
            behavior: 'allow' as const,
            updatedInput: { ...input, recipient: 'rewritten' },
          }),
          mcpServers: { cebab_bus: makeBusToolServer('alpha', (ev) => events.push(ev)) },
        }),
      ),
    );
    expect(events[0]?.destination).toBe('rewritten');
    expect(toolResults(messages)).toHaveLength(1);
  });
});
