/**
 * In-process multi-agent runner — the pure-SDK replacement for the
 * tmux + bash-scripts + Stop-hook + file-IPC bus runtime.
 *
 * Each bus participant is an SDK `query()` (via the same `pickRunner` seam
 * the single-agent path uses, so the bus inherits mock-mode parity). Agents
 * exchange messages by calling an injected in-process `bus_send` tool — there
 * is no terminal to puppet, no `bus.log` to tail, no Stop hook to fire.
 *
 * Turn delivery (verified by the Phase 0 spike): one `query()` per hop with
 * `--resume <agent's last session id>` so context carries across hops. The
 * tool's `source` is pinned in a per-agent closure, so a worker can no longer
 * spoof its identity (the security win over the old `BUS_AGENT_NAME` env /
 * direct-inbox-write model).
 *
 * Phase 1 deliberately does NOT wire this into chain.ts / orchestrator.ts —
 * those routers consume it in Phases 2/3. The router calls `deliverTurn` to
 * "wake" a destination; the `bus_send` tool calls back `onEvent` in-process
 * (replacing the bus.log tailer as the router's input).
 */
import { createSdkMcpServer, tool, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { pickRunner, type MockOptions, type RunOptions, type Runner } from '../runner/index.js';
import type { SettingSource } from '../runner/claude.js';
import { registerQuery } from '../runner/lifecycle.js';
import { isValidBusRecipient } from './paths.js';

/** Message kinds the bus understands. Cebab writes `intro`/`prompt`;
 *  agents emit `reply`/`final`. Mirrors the old `--kind` values. */
export const BUS_KINDS = ['intro', 'prompt', 'reply', 'final'] as const;

/**
 * One bus message. Shape is intentionally identical to the old on-disk
 * `BusLogEvent` so the routers, `appendMultiAgentEvent`, the `onEvent`
 * callback, and the WS protocol need no signature changes when chain.ts /
 * orchestrator.ts are ported.
 */
export type BusEvent = {
  ts: number;
  source: string;
  destination: string;
  kind: string;
  text: string;
};

/** Minimal MCP tool-result shape (structurally a `CallToolResult`). */
type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function toolError(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Pure `bus_send` logic — no SDK, unit-testable in isolation.
 *
 * `source` is supplied by the caller (pinned per-agent in `makeBusToolServer`),
 * never by the agent: that is what makes identity unspoofable. The agent only
 * controls `recipient` / `kind` / `text`, all validated here before the event
 * is handed to the router. Invalid input returns an error result the agent can
 * read and correct, rather than throwing (a thrown tool error would abort the
 * turn).
 */
export function handleBusSend(
  source: string,
  args: { recipient: string; kind: string; text: string },
  onEvent: (ev: BusEvent) => void,
): ToolResult {
  if (!isValidBusRecipient(args.recipient)) {
    return toolError(`bus_send rejected: invalid recipient ${JSON.stringify(args.recipient)}`);
  }
  if (!(BUS_KINDS as readonly string[]).includes(args.kind)) {
    return toolError(
      `bus_send rejected: invalid kind ${JSON.stringify(args.kind)} (use one of ${BUS_KINDS.join(', ')})`,
    );
  }
  if (typeof args.text !== 'string' || args.text.length === 0) {
    return toolError('bus_send rejected: text must be a non-empty string');
  }
  const ev: BusEvent = {
    ts: Date.now(),
    source,
    destination: args.recipient,
    kind: args.kind,
    text: args.text,
  };
  onEvent(ev);
  return { content: [{ type: 'text', text: `delivered to ${args.recipient}` }] };
}

/**
 * Build the in-process MCP server exposing the single `bus_send` tool for
 * ONE agent. `agentName` is captured in the closure and stamped as the event
 * `source`; the agent cannot override it. Pass the returned config to
 * `RunOptions.mcpServers` keyed `bus` → the agent sees `mcp__bus__bus_send`.
 */
export function makeBusToolServer(agentName: string, onEvent: (ev: BusEvent) => void) {
  return createSdkMcpServer({
    name: 'bus',
    version: '0.0.0',
    tools: [
      tool(
        'bus_send',
        'Send a message to another participant on the multi-agent bus. ' +
          'Use this to reply, forward work, or deliver a final answer. ' +
          "recipient is an agent slug, or 'user' (operator-facing final) / '_sink' (chain end).",
        {
          recipient: z.string().describe("destination: an agent slug, or 'user' / '_sink'"),
          kind: z
            .enum(BUS_KINDS)
            .describe('reply = hand off / answer a peer; final = terminal answer'),
          text: z.string().min(1).describe('the message body'),
        },
        async (args) => handleBusSend(agentName, args, onEvent),
      ),
    ],
  });
}

/** A participant Cebab can run turns for. */
export type AgentSpec = {
  /** Bus slug (unspoofable identity stamped on this agent's events). */
  name: string;
  /** Working directory the agent's `claude` runs in. */
  cwd: string;
  /** settings.json scopes. Workers: project-trusted; orchestrator: ['user']. */
  settingSources?: SettingSource[];
};

export type AgentRunnerDeps = {
  /** Router input: called in-process whenever an agent emits `bus_send`. */
  onEvent: (ev: BusEvent) => void;
  /** Per-message hook for transcript persistence + WS live forwarding. */
  onMessage?: (agentName: string, msg: SDKMessage) => void;
  /**
   * Called the instant an agent's last-completed CLI session id changes
   * (a turn's `result`). chain.ts / orchestrator.ts wire this to a DB
   * upsert so the per-agent `--resume` checkpoint survives a Cebab restart
   * (R-B). Optional: unit tests and the single-agent path don't set it.
   */
  onSessionId?: (agentName: string, cliSessionId: string) => void;
  /** Injectable for tests; defaults to the real `pickRunner` (mock-aware). */
  runnerFactory?: (opts: RunOptions & Partial<MockOptions>) => Runner;
  /** Shared cancellation for the whole session's turns. */
  abortController?: AbortController;
};

/**
 * Owns the set of bus agents for one multi-agent session and runs their
 * turns. Replaces tmux session/window management + `send-keys` waking.
 *
 * `deliverTurn` is the "wake" primitive the routers call. It runs exactly one
 * `claude` turn for the agent (resuming its prior context), streaming every
 * SDK message to `onMessage`; any `bus_send` the agent makes during the turn
 * is surfaced synchronously via `onEvent`. The router must NOT await a
 * downstream `deliverTurn` from inside its `onEvent` (that would block the
 * sending agent's turn) — it dispatches the next hop fire-and-forget, exactly
 * as the old code did with `sendKeys(...).catch(...)`.
 */
export class AgentRunner {
  private readonly specs = new Map<string, AgentSpec>();
  /** agentName → last claude session id, for `--resume` on the next hop. */
  private readonly sessions = new Map<string, string>();
  /**
   * agentName → tail of that agent's turn queue. `deliverTurn` is
   * fire-and-forget from the routers (a `bus_send` must never block the
   * sending agent's turn), so when several workers reply to a broadcast
   * within the same instant the orchestrator gets several near-simultaneous
   * `deliverTurn` calls. Without this they would run as parallel
   * `claude --resume <same-id>` subprocesses, each forking the SAME prior
   * checkpoint and seeing only its own delivery — the orchestrator never
   * gets one turn that observes all replies, so it waits forever. Chaining
   * per agent serializes turns so each one resumes the lineage the previous
   * turn just checkpointed. Different agents stay fully parallel.
   */
  private readonly turnTails = new Map<string, Promise<void>>();

  constructor(private readonly deps: AgentRunnerDeps) {}

  register(spec: AgentSpec): void {
    this.specs.set(spec.name, spec);
  }

  has(name: string): boolean {
    return this.specs.has(name);
  }

  agentNames(): string[] {
    return [...this.specs.keys()];
  }

  /**
   * Pre-load an agent's last-completed CLI session id so the NEXT
   * `deliverTurn` resumes its real transcript instead of starting fresh.
   * Used by R-B reconstruction to rehydrate the in-memory map from the
   * persisted `multi_agent_agent_sessions` rows after a Cebab restart.
   * No-op semantics match `deliverTurn`'s read at `this.sessions.get`.
   */
  seedSession(agentName: string, cliSessionId: string): void {
    this.sessions.set(agentName, cliSessionId);
  }

  /**
   * Run one turn for `agentName` with `promptText` as its input. Resolves
   * when the turn's message stream ends; rejects if the agent is unknown or
   * the turn throws.
   *
   * Turns for the SAME agent are serialized (see `turnTails`): a call waits
   * for that agent's previous turn to settle before starting, so it resumes
   * the CLI session the previous turn checkpointed instead of forking a
   * stale one. Calls for DIFFERENT agents are unaffected (still parallel).
   */
  deliverTurn(agentName: string, promptText: string): Promise<void> {
    // Fast-fail an unknown agent without queuing it (programming error, and
    // it must not sit behind a possibly-long prior turn). Preserves the
    // original rejected-promise contract callers `.catch`.
    if (!this.specs.has(agentName)) {
      return Promise.reject(
        new Error(`deliverTurn: unknown agent ${JSON.stringify(agentName)}`),
      );
    }
    const tail = this.turnTails.get(agentName) ?? Promise.resolve();
    const result = tail.then(() => this.runOneTurn(agentName, promptText));
    // Advance the tail regardless of this turn's outcome so one failed or
    // aborted turn never wedges the agent's queue; the real result (incl.
    // rejection) still propagates to this call's own caller via `result`.
    this.turnTails.set(
      agentName,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  private async runOneTurn(agentName: string, promptText: string): Promise<void> {
    const spec = this.specs.get(agentName);
    if (!spec) throw new Error(`deliverTurn: unknown agent ${JSON.stringify(agentName)}`);

    const factory = this.deps.runnerFactory ?? pickRunner;
    // Read INSIDE the serialized turn (not when `deliverTurn` was called) so
    // this resumes the checkpoint the previous queued turn just wrote.
    const prior = this.sessions.get(agentName);

    const runner = factory({
      cwd: spec.cwd,
      prompt: promptText,
      ...(prior ? { resume: prior } : {}),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: spec.settingSources ?? ['user'],
      mcpServers: { bus: makeBusToolServer(agentName, this.deps.onEvent) },
      abortController: this.deps.abortController,
    });

    const unregister = registerQuery(runner);
    try {
      for await (const msg of runner) {
        this.deps.onMessage?.(agentName, msg);
        const m = msg as { type?: string; session_id?: string };
        if (m.type === 'result' && typeof m.session_id === 'string') {
          this.sessions.set(agentName, m.session_id);
          // Persist the checkpoint. A DB hiccup must never abort a turn —
          // same try/catch-and-log posture as the routers' persistence.
          try {
            this.deps.onSessionId?.(agentName, m.session_id);
          } catch (err) {
            console.error(`[runner] onSessionId(${agentName}) failed`, err);
          }
        }
      }
    } finally {
      unregister();
    }
  }

  /** Cancel all in-flight turns for this session. */
  stop(): void {
    this.deps.abortController?.abort();
  }
}
