import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PermissionMode, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import type { RunOptions } from './claude.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fixturesDir(): string {
  // src/runner/mock.ts → ../../../fixtures (or dist/runner/mock.js → ../../../fixtures)
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'fixtures'),
    path.resolve(__dirname, '..', '..', 'fixtures'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`fixtures dir not found, tried: ${candidates.join(', ')}`);
  return found;
}

export type MockOptions = RunOptions & {
  /** Fixture filename under fixtures/. Defaults to "hello.jsonl". */
  fixture?: string;
  /** Delay between yielded events in ms. Default `config.mockIntervalMs`. */
  intervalMs?: number;
  /**
   * Bus replay: scenario directory under `fixtures/bus/`. When set (and
   * `fixture` is not), the fixture is resolved per agent + turn — see
   * `resolveBusFixture`. Supplied by `AgentRunner`; `runClaude` ignores it.
   */
  mockScenario?: string;
  /** Bus replay: which participant's script to load within the scenario. */
  mockAgent?: string;
  /** Bus replay: 0-based turn index for this agent within the session. */
  mockTurn?: number;
  /**
   * `${NAME}` substitutions applied to the raw fixture text before it is
   * parsed. Lets one shipped script serve a topology whose agent slugs are
   * the operator's own project names — a chain fixture says
   * `"destination": "${NEXT}"` and the router supplies the value.
   */
  mockVars?: Record<string, string>;
};

/**
 * A tool registered on an in-process (`type: 'sdk'`) MCP server.
 *
 * PRIVATE SDK SHAPE, deliberately. `createSdkMcpServer` returns the live
 * `McpServer` instance and no public accessor for the tools registered on it;
 * the supported way to call one is to speak MCP over a transport, which means
 * an initialize handshake and a second copy of the MCP client just to reach a
 * function we ourselves registered two frames earlier.
 *
 * Reading `_registeredTools` instead is a bet that this internal survives SDK
 * upgrades. The bet is confined to MOCK MODE: production never reaches this
 * path, and `mock.bus.test.ts` resolves `bus_send` from the real
 * `makeBusToolServer` output, so an SDK that changes the shape fails that test
 * at upgrade time rather than silently degrading every replay.
 */
type RegisteredSdkTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
  inputSchema?: {
    safeParse?: (value: unknown) => {
      success: boolean;
      data?: unknown;
      error?: { issues?: Array<{ path?: unknown[]; message?: string }> };
    };
  };
};

/**
 * Resolve `mcp__<server>__<tool>` against the in-process MCP servers passed to
 * this run.
 *
 * Returns null when no CONFIGURED server owns the prefix — a captured
 * transcript is full of `mcp__claude_ai_Gmail__*` calls the mock has no
 * business executing, and those keep the pre-existing contract that the
 * fixture supplies its own `tool_result` line. Throws when the server IS ours
 * but the tool is not: that is a fixture naming a tool Cebab never injected,
 * and staying silent there looks exactly like a working replay.
 *
 * Matching walks the configured keys rather than splitting on `__`, because a
 * server name may itself contain underscores (`cebab_bus` does) — a regex
 * split guesses the boundary; key iteration knows it.
 */
export function resolveSdkMcpTool(
  servers: MockOptions['mcpServers'],
  toolName: string,
): RegisteredSdkTool | null {
  if (!servers) return null;
  for (const [serverName, serverConfig] of Object.entries(servers)) {
    const prefix = `mcp__${serverName}__`;
    if (!toolName.startsWith(prefix)) continue;
    const bare = toolName.slice(prefix.length);
    const instance = (serverConfig as { instance?: unknown }).instance as
      { _registeredTools?: Record<string, RegisteredSdkTool> } | undefined;
    const registered = instance?._registeredTools;
    if (!registered) {
      throw new Error(
        `[mock] MCP server ${JSON.stringify(serverName)} exposes no readable tool registry. ` +
          `The Agent SDK's in-process server shape changed; update resolveSdkMcpTool.`,
      );
    }
    const found = registered[bare];
    if (!found) {
      throw new Error(
        `[mock] fixture called ${toolName}, but server ${JSON.stringify(serverName)} registers ` +
          `only [${Object.keys(registered).join(', ')}]`,
      );
    }
    return found;
  }
  return null;
}

/**
 * Replace `${NAME}` with `vars[NAME]` in the raw fixture text.
 *
 * Applied BEFORE `JSON.parse`, so values are escaped for the JSON string
 * context they land in — an agent slug containing a quote or a backslash must
 * not be able to break out of its field.
 *
 * A `${...}` with no matching var is left verbatim rather than raising:
 * fixture text legitimately contains shell snippets (`${HOME}`), and a replay
 * that refused to run because an agent's message quoted one would be a worse
 * failure than a placeholder that stays a placeholder.
 */
export function substituteMockVars(text: string, vars: Record<string, string> | undefined): string {
  if (!vars || Object.keys(vars).length === 0) return text;
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (whole, name: string) => {
    const value = vars[name];
    if (value === undefined) return whole;
    // JSON.stringify then strip the surrounding quotes: escapes `"`, `\` and
    // control characters exactly as the enclosing JSON string requires.
    return JSON.stringify(value).slice(1, -1);
  });
}

/**
 * Fixture lookup for a bus participant, most specific first:
 *
 *   1. `<agent>.<turn>.jsonl`    — this agent, this hop
 *   2. `<agent>.jsonl`           — this agent, every hop (a worker that always
 *                                  answers the same way)
 *   3. `_default.<turn>.jsonl`   — any agent, this hop
 *   4. `_default.jsonl`          — any agent, any hop
 *
 * A SHIPPED scenario can only use 3/4 for participants, because their slugs
 * are the operator's own project names; 1/2 exist so a test (which chooses the
 * names) can script one participant specifically. The orchestrator is the
 * exception — its agent name is the fixed `orchestrator`, so a shipped
 * scenario addresses it by name.
 *
 * Nothing matched is an error, not a fallback to `hello.jsonl`: a silent
 * fallback is precisely the failure this change exists to remove — a replay
 * that looks alive and routes nothing.
 */
export function resolveBusFixture(scenario: string, agent: string, turn: number): string {
  const dir = path.join(fixturesDir(), 'bus', scenario);
  const candidates = [
    path.join(dir, `${agent}.${turn}.jsonl`),
    path.join(dir, `${agent}.jsonl`),
    path.join(dir, `_default.${turn}.jsonl`),
    path.join(dir, `_default.jsonl`),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      `[mock] no fixture for agent=${agent} turn=${turn} in scenario ${JSON.stringify(scenario)}; ` +
        `tried:\n  ${candidates.join('\n  ')}`,
    );
  }
  return found;
}

function fixturePathFor(opts: MockOptions): string {
  if (opts.fixture) return path.join(fixturesDir(), opts.fixture);
  if (opts.mockScenario) {
    return resolveBusFixture(opts.mockScenario, opts.mockAgent ?? '_default', opts.mockTurn ?? 0);
  }
  return path.join(fixturesDir(), 'hello.jsonl');
}

type ToolUseBlock = { type?: string; id?: string; name?: string; input?: unknown };

function toolUseBlocks(parsed: Record<string, unknown>): ToolUseBlock[] {
  if (parsed.type !== 'assistant') return [];
  const content = (parsed as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  return (content as ToolUseBlock[]).filter(
    (b) => b?.type === 'tool_use' && typeof b.name === 'string' && typeof b.id === 'string',
  );
}

/**
 * Async-iterable that mimics the real SDK Query but yields events from a fixture.
 *
 * The yielded objects have their `session_id` rewritten to match the active
 * session, so downstream persistence and WS forwarding work without surprises.
 *
 * Two things the replay does beyond echoing lines, both required for a bus
 * session to progress at all (see `fixtures/bus/README.md`):
 *
 *   - `canUseTool` is consulted for every replayed `tool_use`, so a fixture can
 *     exercise a permission gate instead of assuming one.
 *   - a `tool_use` naming an in-process MCP tool passed in `mcpServers` is
 *     really executed against that server's registered handler, so a fixture's
 *     `bus_send` reaches `handleBusSend` → `onEvent` → the router. Without
 *     this, no fixture in any format could move a multi-agent session forward.
 *
 * The mock synthesizes the follow-up `tool_result` only for calls it decided
 * (denied) or executed (in-process MCP). An allowed built-in — `Read`, `Bash`
 * — is left alone: captured transcripts already carry their own `tool_result`
 * line, and synthesizing a second would corrupt every existing fixture.
 */
export function runMock(opts: MockOptions): AsyncIterable<SDKMessage> & {
  close: () => void;
  interrupt: () => Promise<void>;
  setPermissionMode: (mode: PermissionMode) => Promise<void>;
} {
  const file = fixturePathFor(opts);
  if (!fs.existsSync(file)) throw new Error(`fixture not found: ${file}`);
  const intervalMs = opts.intervalMs ?? config.mockIntervalMs;
  // A bus participant gets a stable per-agent id when the caller supplied
  // neither `sessionId` nor `resume`: otherwise every agent checkpoints the
  // same literal 'mock-session', `multi_agent_agent_sessions` holds N
  // identical rows, and a mock reconstruction resumes the wrong lineage.
  const sessionId =
    opts.sessionId ?? opts.resume ?? (opts.mockAgent ? `mock-${opts.mockAgent}` : 'mock-session');

  const lines = substituteMockVars(fs.readFileSync(file, 'utf8'), opts.mockVars)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let cancelled = false;
  // Single listener for the whole run rather than one per sleep iteration —
  // long fixtures previously accumulated O(n) listeners on the signal.
  opts.abortController?.signal.addEventListener(
    'abort',
    () => {
      cancelled = true;
    },
    { once: true },
  );

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

  let synthesized = 0;

  /**
   * Run one replayed `tool_use` through the permission gate and, when it names
   * an injected in-process tool, through that tool's real handler. Returns the
   * `tool_result` block to hand back, or null to leave the call to the fixture.
   */
  async function settleToolUse(block: ToolUseBlock): Promise<Record<string, unknown> | null> {
    const toolName = block.name as string;
    const toolUseId = block.id as string;
    const rawInput = (block.input ?? {}) as Record<string, unknown>;

    let input = rawInput;
    if (opts.canUseTool) {
      const signal = opts.abortController?.signal ?? new AbortController().signal;
      const decision = await opts.canUseTool(toolName, rawInput, {
        signal,
        toolUseID: toolUseId,
        requestId: `mock-${toolUseId}`,
      });
      if (decision && decision.behavior === 'deny') {
        // Faithful to the SDK: a denial reaches the model AS the tool result,
        // flagged is_error. The bus depends on exactly this — an
        // AskUserQuestion answer comes back as a deny message.
        return {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: decision.message,
          is_error: true,
        };
      }
      if (decision && decision.behavior === 'allow' && decision.updatedInput) {
        input = decision.updatedInput;
      }
    }

    const tool = resolveSdkMcpTool(opts.mcpServers, toolName);
    if (!tool) return null;

    if (tool.inputSchema?.safeParse) {
      const parsed = tool.inputSchema.safeParse(input);
      if (!parsed.success) {
        // The real MCP server rejects the same way. Surfacing it keeps a
        // fixture that violates a tool's schema (an empty `text`, a missing
        // `destination`) visible instead of silently sending nothing.
        const detail = (parsed.error?.issues ?? [])
          .map((i) => `${(i.path ?? []).join('.') || '(root)'}: ${i.message ?? 'invalid'}`)
          .join('; ');
        return {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: `Input validation error: ${detail}`,
          is_error: true,
        };
      }
      input = (parsed.data ?? input) as Record<string, unknown>;
    }

    const result = (await tool.handler(input, { toolUseId })) as {
      content?: unknown;
      isError?: boolean;
    };
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: result?.content ?? [],
      ...(result?.isError ? { is_error: true } : {}),
    };
  }

  async function* iter(): AsyncGenerator<SDKMessage, void, unknown> {
    for (const line of lines) {
      if (cancelled) return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // tolerant: skip bad lines, the consumer's parse_error path is for SDK output
      }
      parsed.session_id = sessionId;
      yield parsed as unknown as SDKMessage;
      if (cancelled) return;

      const results: Record<string, unknown>[] = [];
      for (const block of toolUseBlocks(parsed)) {
        const settled = await settleToolUse(block);
        if (cancelled) return;
        if (settled) results.push(settled);
      }
      if (results.length > 0) {
        // One `user` message carrying every result from this assistant turn —
        // the shape the API itself uses, and the shape `deriveToolInFlight`
        // and the `onToolResult` tap in bus/runner.ts read.
        yield {
          type: 'user',
          session_id: sessionId,
          uuid: `mock-tool-result-${(synthesized += 1)}`,
          parent_tool_use_id: null,
          message: { role: 'user', content: results },
        } as unknown as SDKMessage;
        if (cancelled) return;
      }

      await sleep(intervalMs);
    }
  }

  const it = iter();
  return {
    [Symbol.asyncIterator]() {
      return it;
    },
    close() {
      cancelled = true;
    },
    async interrupt() {
      cancelled = true;
    },
    async setPermissionMode() {
      // no-op in mock; real Query forwards to the spawned claude
    },
  };
}
