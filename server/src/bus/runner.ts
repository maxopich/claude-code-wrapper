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
import { BUS_SEND_TOOL, classifyToolCall } from '@cebab/shared';
import type { AskUserQuestionOption, AskUserQuestionView } from '@cebab/shared/protocol';
import { config } from '../config.js';
import { pickRunner, type MockOptions, type RunOptions, type Runner } from '../runner/index.js';
import type { SettingSource } from '../runner/claude.js';
import { registerQuery } from '../runner/lifecycle.js';
import { isValidBusDestination } from './paths.js';
import { classifyMutationScope } from './guardrail.js';
import {
  isBusControlSignal,
  MaxTurnsReachedError,
  TurnRefusedError,
  TurnStalledError,
} from './errors.js';

/**
 * Stalled-turn watchdog thresholds (ms). A turn that yields no SDKMessage for
 * `DEFAULT_STALL_NOTIFY_MS` fires `onTurnStalled` (operator alert); one that
 * stays silent for `DEFAULT_STALL_ABORT_MS` with no tool mid-flight is
 * auto-aborted (the wedged-generation case — e.g. the orchestrator silently
 * hung composing a reply). While a tool is mid-flight (between `tool_use` and
 * its `tool_result`, e.g. a long `npm test`) the abort uses the much more
 * lenient `DEFAULT_STALL_TOOL_CEILING_MS` so a legitimately slow tool isn't
 * killed, while a tool that never returns is still bounded. All three are
 * overridable via `AgentRunnerDeps` (tests pass tiny values).
 */
export const DEFAULT_STALL_NOTIFY_MS = 60_000;
export const DEFAULT_STALL_ABORT_MS = 300_000;
export const DEFAULT_STALL_TOOL_CEILING_MS = 900_000;

/**
 * Built-in tools removed from a `'delegate-only'` agent's context (SDK
 * `disallowedTools`) so the orchestrator never even sees a file/shell/analysis
 * tool to reach for. This is the "remove from context" layer; the authoritative
 * boundary is the default-deny in `makeCanUseTool` (which also catches any
 * future built-in not listed here). `bus_send` (an MCP tool) and
 * `AskUserQuestion` are intentionally NOT here — those are the only two tools a
 * delegation-only agent may use.
 */
export const DELEGATE_ONLY_DISALLOWED: readonly string[] = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Read',
  'Glob',
  'Grep',
  'Task',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
];

/**
 * The single MCP tool Cebab injects, under the namespaced `cebab_bus` key.
 *
 * Defined in `@cebab/shared` and re-exported here, where every caller already
 * looks for it: `classifyToolCall` has to recognise the same string this file
 * registers, and when the two were written out separately they disagreed —
 * the classifier matched a bare `bus_send` the SDK never sends (register D06).
 */
export { BUS_SEND_TOOL };

/**
 * The only tools a `'delegate-only'` agent (the orchestrator) may call:
 * `AskUserQuestion` (parked for the operator) and the injected `bus_send` MCP
 * tool.
 *
 * Matched by exact name. The previous `endsWith('__bus_send')` test dated from
 * when Cebab registered the tool under two server keys (`cebab_bus` + the `bus`
 * deprecation alias); with the alias gone there is exactly one legitimate name,
 * and a suffix match would also admit `mcp__<anything>__bus_send` from an
 * operator's own user-scope MCP config — i.e. a second, unpinned bus reachable
 * by the one agent whose entire containment is "you may only call bus_send".
 */
export function isDelegationAllowedTool(toolName: string): boolean {
  return toolName === 'AskUserQuestion' || toolName === BUS_SEND_TOOL;
}

/**
 * Track whether a tool call is mid-flight for the watchdog: an `assistant`
 * message whose last content block is a `tool_use` means the SDK is about to
 * (or is) running a tool; the matching `tool_result` on a later `user` message
 * clears it. Every other SDKMessage (`stream_event`, `result`, …) carries the
 * prior state forward. Mirrors the tool derivation in `bus/activity.ts`.
 */
function deriveToolInFlight(msg: SDKMessage, prev: boolean): boolean {
  const m = msg as { type?: string; message?: { content?: Array<{ type?: string }> } };
  if (m.type === 'assistant' && Array.isArray(m.message?.content) && m.message.content.length > 0) {
    return m.message.content[m.message.content.length - 1]?.type === 'tool_use';
  }
  if (
    m.type === 'user' &&
    Array.isArray(m.message?.content) &&
    m.message.content.some((b) => (b as { type?: string }).type === 'tool_result')
  ) {
    return false;
  }
  return prev;
}

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

/**
 * One content block off a raw `assistant` SDKMessage, narrowed only as far as
 * the mutation tap needs. Deliberately loose — `type` is checked at use, and a
 * block that is not a `tool_use` is skipped rather than rejected, because this
 * narrows an SDK shape the runner does not own.
 *
 * Named (`Cebab-vie.16`) because it is now the parameter type of an extracted
 * method and the element type of the deferred-replay array, not just an inline
 * cast at one site.
 */
type ToolUseBlock = { type?: string; name?: string; id?: string; input?: unknown };

function toolError(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Hard cap on one `bus_send` body, in UTF-8 bytes.
 *
 * Every bus message is three things at once: a row in `multi_agent_events`, a
 * WS frame to the browser, and — the one that matters — the *prompt* for the
 * recipient's next turn. Nothing else bounds that third use: the sender writes
 * it, Cebab forwards it verbatim, and the recipient pays for it in context. A
 * worker that dumps a whole file (or loops appending to its reply) otherwise
 * silently burns the peer's context window and the operator's quota.
 *
 * 128 KiB ≈ 32k tokens — far above any legitimate hand-written hop (the longest
 * real replies observed are a few KB) and far below "a repo pasted into a
 * message". Measured in bytes, not codepoints, because the DB row and the WS
 * frame are what the ceiling protects.
 *
 * Over-limit is REJECTED, not truncated: truncation loses the tail silently and
 * can cut a code block mid-fence, whereas the error result is readable by the
 * model, names the actual size, and lets it resend something shorter.
 */
export const BUS_SEND_TEXT_MAX_BYTES = 128 * 1024;

/**
 * Pure `bus_send` logic — no SDK, unit-testable in isolation.
 *
 * `source` is supplied by the caller (pinned per-agent in `makeBusToolServer`),
 * never by the agent: that is what makes identity unspoofable. The agent only
 * controls `destination` / `kind` / `text`, all validated here before the event
 * is handed to the router. Invalid input returns an error result the agent can
 * read and correct, rather than throwing (a thrown tool error would abort the
 * turn).
 *
 * `destination` is the SAME word the `BusEvent` field, the router comparisons,
 * the DB column, and the WS protocol use (register N20): the tool schema, this
 * handler, and the wire no longer disagree, so grepping one word finds all of
 * the routing code.
 */
export function handleBusSend(
  source: string,
  args: { destination: string; kind: string; text: string },
  onEvent: (ev: BusEvent) => void,
): ToolResult {
  if (!isValidBusDestination(args.destination)) {
    return toolError(`bus_send rejected: invalid destination ${JSON.stringify(args.destination)}`);
  }
  if (!(BUS_KINDS as readonly string[]).includes(args.kind)) {
    return toolError(
      `bus_send rejected: invalid kind ${JSON.stringify(args.kind)} (use one of ${BUS_KINDS.join(', ')})`,
    );
  }
  if (typeof args.text !== 'string' || args.text.length === 0) {
    return toolError('bus_send rejected: text must be a non-empty string');
  }
  const textBytes = Buffer.byteLength(args.text, 'utf8');
  if (textBytes > BUS_SEND_TEXT_MAX_BYTES) {
    return toolError(
      `bus_send rejected: text is ${textBytes} bytes, over the ${BUS_SEND_TEXT_MAX_BYTES}-byte ` +
        `limit for one message. Summarize, or split the work across several messages — do not ` +
        `paste file contents you could point at by path instead.`,
    );
  }
  const ev: BusEvent = {
    ts: Date.now(),
    source,
    destination: args.destination,
    kind: args.kind,
    text: args.text,
  };
  onEvent(ev);
  return { content: [{ type: 'text', text: `delivered to ${args.destination}` }] };
}

/**
 * Build the in-process MCP server exposing the single `bus_send` tool for
 * ONE agent. `agentName` is captured in the closure and stamped as the event
 * `source`; the agent cannot override it. Pass the returned config to
 * `RunOptions.mcpServers` keyed `cebab_bus` → the agent sees
 * `mcp__cebab_bus__bus_send`. The key is deliberately namespaced (not `bus`)
 * so a project's own `.claude/settings*.json` defining `mcpServers.bus`
 * cannot collide with — or worse, clobber — this identity-pinned injection
 * once `settingSources` widens to `['user', 'project', 'local']` for
 * workers/chain participants.
 */
export function makeBusToolServer(agentName: string, onEvent: (ev: BusEvent) => void) {
  return createSdkMcpServer({
    name: 'cebab_bus',
    version: '0.0.0',
    tools: [
      tool(
        'bus_send',
        'Send a message to another participant on the multi-agent bus. ' +
          'Use this to reply, forward work, or deliver a final answer. ' +
          "destination is an agent slug, or 'user' (operator-facing final) / '_sink' (chain end).",
        {
          destination: z.string().describe("destination: an agent slug, or 'user' / '_sink'"),
          kind: z
            .enum(BUS_KINDS)
            .describe('reply = hand off / answer a peer; final = terminal answer'),
          text: z
            .string()
            .min(1)
            .describe(
              `the message body (max ${BUS_SEND_TEXT_MAX_BYTES} bytes — summarize or split ` +
                `rather than pasting large files)`,
            ),
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
  /**
   * settings.json scopes the SDK should layer for this agent's turns.
   * Workers and chain participants: `['user', 'project', 'local']` — so a
   * participant's own `.claude/settings*.json` (MCP servers, allowed/
   * disallowed tools, env injectors, hooks) loads exactly as it would in a
   * standalone `claude` session. Orchestrator: `['user']` — its cwd is an
   * empty Cebab-owned workspace, so widening scope is a no-op and pinning
   * it here documents that invariant. Defaults to `['user']` if a caller
   * forgets to pass one (defensive narrow fallback).
   */
  settingSources?: SettingSource[];
  /**
   * Cluster G Phase 3 (G1): the project this agent is rooted in. Threaded
   * onto the lifecycle registry's `InFlightMeta` so the `active_runs`
   * ServerMsg can name the project for the sidebar dropdown row.
   *
   * Optional because tests construct minimal AgentSpecs without a project
   * (runner.test.ts, runner.pause.test.ts) and the orchestrator's own spec
   * has no project (its cwd is the Cebab-owned `<sessionFolder>/orchestrator/`).
   * Absence is fine — the registry entry just drops `projectId` from the
   * snapshot, which the dropdown row renders as "no project" gracefully.
   */
  projectId?: number;
  /**
   * Tool posture for this agent. `'delegate-only'` hard-locks the agent to a
   * pure router: its ONLY tools are `bus_send` (delegate work / deliver the
   * final answer) and `AskUserQuestion` — every file/shell/analysis tool is
   * both removed from the model's context (`disallowedTools`, see
   * `DELEGATE_ONLY_DISALLOWED`) AND denied by `makeCanUseTool` as the
   * authoritative default-deny boundary. Used for the orchestrator, which must
   * route work to workers rather than act itself. Absent (the default) =
   * unrestricted, the worker/chain posture (byte-identical to before).
   */
  toolPolicy?: 'delegate-only';
  /**
   * Cebab-ws0.3: the model this agent's turns ask for, read from its project's
   * `projects.model`. Absent (the default) = no model key on the options
   * object, i.e. byte-identical to before this existed.
   *
   * The ORCHESTRATOR has no project of its own — its cwd is the Cebab-owned
   * session folder — so it has no model here and runs on the CLI default. That
   * is correct rather than an oversight: routing is not the work, and the
   * operator's model choice belongs to the project doing the work.
   *
   * KNOWN GAP, stated so the next reader does not have to discover it: the bus
   * emits no `session_started`, so nothing on the wire reports which model a
   * participant ACTUALLY ran on (Register W13). A participant therefore changes
   * model here with no surface confirming it. Cebab-ut7 tracks putting that
   * signal on the wire; until it lands, this setting is write-only from the
   * operator's point of view.
   */
  model?: string;
  /**
   * Register H04: MCP server names the operator denied for this agent's
   * project at the TOFU gate. Read fresh from the spec on every turn, so
   * `applyMcpDenials` can tighten a live session (mid-run `addWorker`, or a
   * `continue_multi_agent` after a restart re-gates the participants) without
   * re-registering the agent.
   *
   * Absent (the default) = no denials, and the run options are byte-identical
   * to before this existed.
   */
  deniedMcpServers?: string[];
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
  /**
   * F7: called with one completed hop's `result.total_cost_usd` — the cost of
   * THAT invocation, not a running total (it equals `sum(modelUsage[*].costUSD)`,
   * which are per-invocation counters), so the receiver accumulates.
   *
   * chain.ts / orchestrator.ts wire this to `addAgentCost`, which is the only
   * cost signal the bus has: a hop count treats a 2k-token routing turn and a
   * 180k-token analysis turn identically. Optional — unit tests omit it.
   *
   * Fires even when the turn failed (`subtype !== 'success'`), and before the
   * throw that normalizes that into a router-visible error: a turn that burned
   * quota and then errored still cost money, and dropping it would make the
   * total silently under-report exactly the runs an operator most wants to
   * account for.
   */
  onTurnCost?: (agentName: string, costUsd: number) => void;
  /**
   * Item #5: called for every classified non-`read` `tool_use` block observed
   * on an `assistant` SDKMessage, BEFORE the SDK dispatches the tool. Hooks:
   *   - persists a row into `multi_agent_mutations`,
   *   - emits a `multi_agent_mutation` ServerMsg via `sink.onMutation`,
   *   - when `pause_on_dangerous=1` and this agent has neither a live pause
   *     nor an unspent Continue grant for this exact call, flips the row to
   *     `pause_state='pending'`, emits `multi_agent_pending_mutations`,
   *     takes a `holdForMutation` on this agent's turn queue, and
   *     throws `PausedForMutationError` to abort the turn (best-effort —
   *     see the race-window risk in the plan). The hold is what makes the
   *     halt outlive the turn (`Cebab-vie.13`); the router releases it on
   *     Continue.
   *
   * Throwing PROPAGATES out of `deliverTurn`; the router's `.catch`
   * recognises `PausedForMutationError` and does NOT teardown. Any other
   * throw is treated as a normal turn failure (worker-failed path).
   *
   * Migration 012 widened the `classification` carrier: `filePath` is the
   * target file the tool will mutate (Write/Edit/MultiEdit/NotebookEdit;
   * undefined for everything else); `toolUseId` is the SDK's `tool_use.id`
   * so the matching `tool_result` can flip `confirmed_at` later. `cwd` is
   * the agent's working directory at mutation time (denormalized onto the
   * row so the artifact classifier can resolve `filePath` relative to the
   * worktree root without a JOIN).
   */
  onMutation?: (
    agentName: string,
    toolName: string,
    cwd: string,
    classification: {
      category: 'mutate' | 'dangerous';
      summary: string;
      filePath?: string;
      toolUseId?: string;
      /** Cluster F Phase D5+: server-side path classifier verdict. Set
       *  when the mutation's resolved target path falls outside the
       *  agent's project folder (consultant-mode guardrail violation).
       *  Undefined for in-scope mutations and for tools with no
       *  canonical file path (Bash, Task). The hook routes this into
       *  the persisted mutation row + the safety_audit dispatcher. */
      guardrailViolation?: {
        violatedPath: string;
        reasonCode: string;
      };
      /** Cluster F Phase F3: for Bash mutations, the classifier rule
       *  that pinned the category + the matched fragment that fired
       *  it. Undefined for non-Bash mutations (the tool name is the
       *  rationale: `Write` writes, `Edit` edits) and for any tool
       *  whose classifyToolCall output happened to omit a reason
       *  (none today, but defensive). The orchestrator/chain sink
       *  persists this on the mutation row for the UI tooltip. */
      classifierReason?: {
        rule: string;
        detail: string;
        matched: string;
      };
      /** Migration 026: the raw `tool_use.input` for this call. Routed into
       *  the persisted mutation row (capped at the repo boundary) so the Logs
       *  drawer can show the full command/args, not just the one-line summary. */
      toolInput?: unknown;
    },
  ) => Promise<void> | void;
  /**
   * Migration 012: called for every `tool_result` block on a `user`
   * SDKMessage. Hook flips `confirmed_at` on the matching mutation row
   * (keyed by `tool_use_id`) so the artifact view can distinguish a
   * provisional Write (tool fired but never reported back — paused,
   * aborted, errored mid-flight) from a confirmed one. Best-effort: failure
   * is logged but never aborts the turn.
   */
  onToolResult?: (
    agentName: string,
    toolUseId: string,
    meta: { isError: boolean; content?: unknown },
  ) => Promise<void> | void;
  /**
   * Interactive AskUserQuestion. When wired, `runOneAttempt` switches the SDK
   * query to `permissionMode:'default'` + a `canUseTool` that auto-allows every
   * tool EXCEPT `AskUserQuestion`, which it routes here. The returned Promise
   * resolves with the operator's answer string — the runner returns it to the
   * SDK as a `deny` message, which the model receives as the tool result
   * (marked is_error, but it reads + uses it) and the SAME turn resumes.
   * Rejecting denies with a generic dismissal. The runner blocks the in-flight
   * SDK turn on this Promise, so the agent genuinely pauses until answered.
   * Absent (the default) → headless bypass posture, unchanged.
   */
  onAskUserQuestion?: (
    agentName: string,
    toolUseId: string,
    questions: AskUserQuestionView[],
  ) => Promise<string>;
  /**
   * Called when a `'delegate-only'` agent (the orchestrator) attempts a tool it
   * is structurally barred from — i.e. anything other than `bus_send` /
   * `AskUserQuestion`. The call has already been denied by `makeCanUseTool`
   * (the model receives a nudge to delegate); this hook is the observability
   * side-channel. orchestrator.ts wires it to the safety dispatcher so the
   * attempt lands in the hash-chained audit log + an operator notification.
   * Fire-and-forget: the runner never awaits it and a throw must not affect the
   * turn (the deny already happened). Absent (the default) → no-op.
   */
  onGuardrailViolation?: (agentName: string, toolName: string) => void;
  /**
   * `Cebab-vie.11` [security]: may `agentName` start a turn RIGHT NOW? Asked at
   * DEQUEUE time — immediately before a queued delivery would become a real
   * `claude` process — not when that delivery was enqueued.
   *
   * The distinction is the whole point. A worker's turns are serialized, so a
   * delivery routed while the previous turn is still running waits; everything
   * the operator does during that wait (kick, most sharply) happens after every
   * check the delivery already passed. The router's `kickedSet` drops gate
   * EVENTS and `checkTurnRefused` gates the two replay seams — neither can see a
   * delivery that is already inside the runner.
   *
   * Returning false must be accompanied by telling the operator: the runner
   * throws `TurnRefusedError`, and the routers' `.catch` deliberately stays
   * silent on it. Same contract as `checkTurnRefused`, and stated in both
   * places because breaking it produces either silence or a doubled row.
   *
   * Optional. `chain.ts` omits it — chain mode refuses kick outright
   * (`chain_topology_broken`), so there is no state for it to read. Absent means
   * every dequeued turn starts, which is byte-identical to the behaviour before
   * this existed.
   */
  canStartTurn?: (agentName: string) => boolean;
  /** Injectable for tests; defaults to the real `pickRunner` (mock-aware). */
  runnerFactory?: (opts: RunOptions & Partial<MockOptions>) => Runner;
  /** Shared cancellation for the whole session's turns. */
  abortController?: AbortController;
  /**
   * Override the transient-overload backoff schedule. Each entry is the ms
   * to sleep BEFORE the next retry attempt; length defines `MAX_RETRIES`.
   * Production default: `DEFAULT_OVERLOAD_BACKOFF_MS` (1 s / 3 s / 10 s).
   * Tests pass `[0, 0, 0]` to keep the retry path testable in fake time.
   */
  overloadBackoffMs?: readonly number[];
  /**
   * Cluster D Phase 4a (spec §4.2 BE-D5): observability hook for the
   * transient-overload retry path. Called BEFORE each backoff sleep with
   * the next-attempt metadata so the orchestrator/chain wiring can:
   *
   *   - emit an `auto_retry` ServerMsg (live operator-facing signal,
   *     drives the RateLimitBanner countdown in Phase 4c), and
   *   - write a `recovery_log` row (`failureClass='other'`,
   *     `operatorAction='auto_retry'`) — the durable record the
   *     regression-gate queries (spec §8.5) consume.
   *
   * The hook fires for `'transient_overload'` reasons only; single-agent
   * `'rate_limit_hard'` retries (Phase 4b) live on a different code path
   * and use this same reason-code vocabulary but a different emit site.
   *
   * `[security]` BE-D7: the hook fires *only* from inside the existing
   * `isTransientOverload(err)` branch — never on generic errors. The
   * branch is the trust boundary; this hook is downstream of it.
   *
   * Optional: unit tests and code paths that don't need the wire signal
   * leave it unset (the `console.warn` log line is preserved as a
   * complementary debug breadcrumb regardless).
   */
  onAutoRetry?: (info: {
    agentName: string;
    attempt: number; // 1-indexed; the attempt about to fire after backoff
    maxAttempts: number; // attempts + retries inclusive
    backoffMs: number;
    retryAt: number; // wall-clock ms when the retry will fire
    reason: 'transient_overload';
    error: unknown;
  }) => void;
  /**
   * Stalled-turn watchdog (silent-stale-state fix). Fired when an in-flight
   * turn has produced no SDKMessage for `stallNotifyMs` and is NOT mid-tool
   * and NOT parked on an AskUserQuestion — i.e. a genuine generation/SDK
   * wedge. chain.ts / orchestrator.ts wire this to a sticky operator
   * notification so a stall is loud, not a silent gap. Fires once per silent
   * gap; `onTurnResumed` follows if the turn recovers.
   */
  onTurnStalled?: (info: { agentName: string; idleMs: number; turnStartedAt: number }) => void;
  /** Fired when a turn that previously fired `onTurnStalled` produces a
   *  message again — the wiring clears the sticky stall notification. */
  onTurnResumed?: (agentName: string) => void;
  /** Watchdog soft (notify) threshold; default `DEFAULT_STALL_NOTIFY_MS`. */
  stallNotifyMs?: number;
  /** Watchdog hard (auto-abort) threshold with no tool mid-flight;
   *  default `DEFAULT_STALL_ABORT_MS`. */
  stallAbortMs?: number;
  /** Watchdog hard (auto-abort) threshold while a tool is mid-flight;
   *  default `DEFAULT_STALL_TOOL_CEILING_MS` (lenient so a slow tool isn't
   *  killed, but a never-returning one is still bounded). */
  stallToolCeilingMs?: number;
  /**
   * `Cebab-vie.17`: hard cap on model turns for ONE hop.
   *
   * This used to be absent entirely, so every worker and chain participant ran
   * with no `maxTurns` at all while the single-agent path passed one. The hop
   * budget counts MESSAGES between agents; it never counted the work inside a
   * hop, so one `bus_send` bought an unbounded agent turn — no turn cap, no
   * wall-clock cap, an idle-only stall watchdog, and a tool gate that
   * auto-allows everything but `AskUserQuestion`.
   *
   * Resolved by the caller (`resolveMaxTurns()` in `ws/server.ts`: DB
   * `max_turns` > `MAX_TURNS` env > `config.maxTurns`), re-read at every
   * session start and resume, exactly like `hopBudget`. Optional here for the
   * same reason `hopBudget` is optional on the routers' start opts — the test
   * harnesses construct an `AgentRunner` directly — but ABSENT DOES NOT MEAN
   * UNBOUNDED: it falls back to `config.maxTurns` at the spawn. Unboundedness
   * is the bug, so it is the one value that must not be expressible.
   */
  maxTurns?: number;
  /**
   * Cluster G Phase 3 (G1): the BUS session id this AgentRunner belongs to.
   * Stamped onto every per-hop `registerQuery` call so the lifecycle
   * snapshot rows have the operator-facing session id (NOT the per-hop CLI
   * session id which changes every turn). Absent in tests and in the
   * single-agent path (which uses its own `registerQuery` call site with
   * the single-agent sessionId).
   */
  sessionId?: string;
  /**
   * MOCK MODE ONLY — the scenario directory under `fixtures/bus/` that
   * `runMock` replays for this session's participants. `runClaude` ignores
   * both this and the per-turn hints derived from it, so it is forwarded
   * unconditionally rather than behind a `config.mock` branch: one code path
   * for both runners, and a test that flips `config.mock` needs no other
   * change.
   *
   * A bus session cannot replay from a single fixture the way a single-agent
   * turn can — each participant has to say something different, and which
   * hop it is decides whether it hands off or finishes. `runMock` therefore
   * resolves a file per (agent, turn); the runner supplies both halves.
   */
  mockScenario?: string;
  /**
   * MOCK MODE ONLY — `${NAME}` values for the agent's fixture text. A shipped
   * scenario cannot name the operator's projects, so it writes
   * `"destination": "${NEXT}"` and the router (which owns the topology) fills
   * in the slug. Called once per turn.
   */
  mockVars?: (agentName: string) => Record<string, string>;
};

/**
 * Who is holding an agent's turn queue. `operator` is the mute/pause/kick
 * `pause` verb; `mutation` is the pause-on-dangerous gate (`Cebab-vie.13`).
 * They share one gate promise but claim it independently — see `pauseGates`.
 */
type GateHolder = 'operator' | 'mutation';

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
  /**
   * agentName → count of AskUserQuestion prompts currently parked for the
   * operator. While > 0 the turn is legitimately blocked waiting on a human
   * (no SDKMessage flows), so the stalled-turn watchdog must NOT fire — it
   * would otherwise alert/abort a turn that is correctly awaiting an answer.
   * A counter (not a boolean) tolerates the pathological case of overlapping
   * parks within one turn.
   */
  private readonly parked = new Map<string, number>();
  /**
   * Cluster C Phase 4c (spec §5.2 + AE-4 + AE-5): per-agent pause gate.
   * `pause(name)` records a never-resolving promise here; every turn checks
   * this map on its way OUT of the queue (`deliverTurn`) and waits on the
   * promise if one is present, until `resume(name)` flips the gate. The
   * IN-FLIGHT turn (whose `runOneTurn` was already executing when pause
   * arrived) is unaffected — it is already past the check, which is the spec's
   * "current in-flight turn NOT cancelled" guarantee.
   *
   * `Cebab-vie.1` [security] moved that check. The gate used to splice itself
   * into `turnTails` as `prevTail.then(() => gatePromise)`, i.e. BEHIND every
   * delivery already queued, so pausing an agent with N waiting deliveries let
   * all N run first — full, unattended, auto-allow-everything turns, while the
   * `agent_control.paused` audit row said the agent was paused from the moment
   * of the click and `queuedDeliveries: N` presented that same count to the
   * operator as the number being held back. Reading the map at dequeue instead
   * makes "in flight" mean what it says, rather than "in flight or anywhere in
   * the queue".
   *
   * Resume calls `release()` to fulfill the gate promise; parked deliveries
   * then proceed in FIFO order, each waiting for the one before it to finish
   * (the chained `turnTails.set` pattern that predates pause still gives us
   * that — a parked delivery holds the tail, so nothing overtakes it).
   * Re-pause / re-resume return false without state change — caller (WS
   * handler) surfaces as `already_in_state`.
   *
   * **Two holders, one gate** (`Cebab-vie.13`). The pause-on-dangerous brake
   * needs the same queue hold, and reusing `pause`/`resume` for it would make
   * each verb release the OTHER's hold: an operator Continue would lift a
   * standing operator pause, and a pause-expiry `auto_resume` would lift the
   * hold on a worker still sitting at an unapproved `rm -rf`. Both widen
   * privilege, which is the wrong direction for this file — so the gate
   * carries a holder SET and `release()` fires only when it empties. The
   * public verbs are per-holder wrappers whose return value still means "did
   * THIS holder's state change", which is what the WS `already_in_state`
   * reply is derived from.
   */
  private readonly pauseGates = new Map<
    string,
    { promise: Promise<void>; release: () => void; holders: Set<GateHolder> }
  >();
  /**
   * Cluster C Phase 4c (spec AE-5 [security]): count of deliverTurn calls
   * the agent has queued but not yet started (i.e. waiting on the tail).
   * Reported on `participant_pause_changed.queuedDeliveries` so the
   * operator can see "this paused worker is sitting on N pending
   * inbound messages — growth is the runaway-buildup signal." Includes
   * the queue parked behind a pause gate AND the queue behind a slow
   * in-flight turn — operator's mental model is "how many calls are
   * stuck behind this agent right now."
   */
  private readonly pendingDeliveries = new Map<string, number>();
  /**
   * agentName → hops taken so far. Mock-mode fixture routing only: it selects
   * which script in the scenario the next turn replays, so a participant can
   * hand off on its first hop and finish on its second. Counted per HOP, not
   * per attempt — a transient-overload retry re-runs the same turn and must
   * replay the same script.
   */
  private readonly turnCounts = new Map<string, number>();

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
   * Register H04: apply the operator's MCP denials to every registered agent
   * rooted in `projectId`. Takes effect on that agent's NEXT turn.
   *
   * Exists because two spawn paths re-gate a session that is already running —
   * `addWorker` (mid-run participant) and `continue_multi_agent` (R-B
   * reconstruction, where a participant's `.mcp.json` may have changed across
   * the restart). Re-`register()`ing to carry the denial would clobber the
   * rest of a live spec, so denials are merged in place instead.
   *
   * Union, never replace: a server denied earlier in the session stays denied
   * even if a later gate pass does not re-report it (a `deny_once` is scoped
   * to the connection, and forgetting it mid-session would silently re-admit
   * a server the operator refused).
   */
  applyMcpDenials(projectId: number, serverNames: readonly string[]): void {
    if (serverNames.length === 0) return;
    for (const [name, spec] of this.specs.entries()) {
      if (spec.projectId !== projectId) continue;
      const merged = new Set([...(spec.deniedMcpServers ?? []), ...serverNames]);
      this.specs.set(name, { ...spec, deniedMcpServers: [...merged] });
    }
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
      return Promise.reject(new Error(`deliverTurn: unknown agent ${JSON.stringify(agentName)}`));
    }
    // Cluster C Phase 4c: bump the queue counter on entry, decrement just
    // before runOneTurn fires. The window between bump + decrement is
    // exactly "queued but not running" — which matches the operator's
    // "stuck behind this agent" mental model for AE-5's queuedDeliveries.
    this.pendingDeliveries.set(agentName, (this.pendingDeliveries.get(agentName) ?? 0) + 1);
    const tail = this.turnTails.get(agentName) ?? Promise.resolve();
    const result = tail.then(async () => {
      // `Cebab-vie.1` / `Cebab-vie.11` [security]: re-read the agent's control
      // state HERE, at the moment this delivery would become a real process —
      // not when it was enqueued. Everything upstream (the router's kicked/muted
      // drops, `checkTurnRefused`, the operator's Pause click) ran while this
      // call was still waiting behind another turn, and a worker's turns are
      // serialized, so waiting is the ordinary case. Reading once on the way in
      // is what let a kick and a pause both arrive too late to stop anything.
      //
      // A loop, and in this order:
      //   - refusal BEFORE the gate, so a kicked agent is never parked behind a
      //     promise that may never resolve (`releaseAllHolds` covers the case
      //     where the kick lands while it is already parked);
      //   - re-check AFTER each wait, because pause → resume → pause installs a
      //     NEW gate, and because a kick can land while parked.
      try {
        for (;;) {
          if (this.deps.canStartTurn && !this.deps.canStartTurn(agentName)) {
            throw new TurnRefusedError(agentName);
          }
          const gate = this.pauseGates.get(agentName);
          if (!gate) break;
          await gate.promise;
        }
      } finally {
        // Decremented AFTER the gate clears, not before it: a delivery parked
        // on the gate is still queued, and `getPendingDeliveries` is documented
        // as "the queue parked behind a pause gate AND the queue behind a slow
        // in-flight turn" — the AE-5 `queuedDeliveries` figure the operator
        // reads as "stuck behind this agent right now".
        //
        // In a `finally` because the loop now has TWO exits and both leave the
        // queue. A refusal that skipped this would pin the counter at its
        // pre-refusal value for the rest of the session, which is the same
        // class of stale-state bug this whole change is about.
        this.pendingDeliveries.set(
          agentName,
          Math.max(0, (this.pendingDeliveries.get(agentName) ?? 1) - 1),
        );
      }
      return this.runOneTurn(agentName, promptText);
    });
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

  /**
   * Cluster C Phase 4c: hold `agentName`'s turn queue behind a never-resolving
   * gate at the operator's request. Returns true if the operator's hold is
   * new, false if the agent was already operator-paused (idempotent re-pause
   * is a no-op so the WS handler can surface `already_in_state`).
   *
   * Semantics:
   *   - In-flight turn (the one whose `runOneTurn` is already executing
   *     when pause arrives) is NOT cancelled. The spec's §5.2 model is
   *     "current in-flight finishes; inbound queues" — and `inbound queues`
   *     covers a delivery that has arrived and not yet started, which is why
   *     the gate binds every turn that has not entered `runOneTurn` rather
   *     than only ones that arrive after the click (`Cebab-vie.1`).
   *   - The gate is READ at dequeue, in `deliverTurn`. It is not spliced into
   *     `turnTails`; splicing put it behind the existing queue, which is
   *     exactly the delivery set it most needed to hold. Serialization is
   *     unaffected — the tail chain still orders turns, and a delivery waiting
   *     on the gate holds the tail, so there is still never a second
   *     `--resume` subprocess for the same agent.
   *   - `resume(agentName)` drops the operator's hold, and — if no other
   *     holder remains — resolves the gate and clears the map entry,
   *     unblocking every parked delivery in FIFO order. The
   *     `turnTails`-chain pattern guarantees order.
   *
   * Caller responsibility: the WS handler MUST persist the pause to
   * `multi_agent_participants.paused_until` BEFORE calling
   * `runner.pause()`. The DB is the durable source-of-truth; this
   * in-memory gate is the hot-path mirror. Without that order, a
   * server-restart between the two would lose the operator's intent.
   */
  pause(agentName: string): boolean {
    return this.acquireHold(agentName, 'operator');
  }

  /**
   * `Cebab-vie.13`: hold `agentName`'s queue because the pause-on-dangerous
   * gate halted it at an unapproved `dangerous` command. Same mechanism as
   * `pause` — see the `pauseGates` header for why they are separate holders
   * of one gate rather than one shared flag.
   *
   * Called from `applyPauseGate`, so the two routers install it identically.
   * Released by `releaseMutationHold` when the operator clicks Continue; a
   * standing operator pause is unaffected either way.
   */
  holdForMutation(agentName: string): boolean {
    return this.acquireHold(agentName, 'mutation');
  }

  /** `Cebab-vie.13`: release the mutation hold (operator clicked Continue). */
  releaseMutationHold(agentName: string): boolean {
    return this.releaseHold(agentName, 'mutation');
  }

  /**
   * Install (or join) the gate at the head of `agentName`'s queue on behalf of
   * `holder`. Returns true iff THIS holder's state changed — a second holder
   * joining an existing gate returns true too (its hold is new), while a
   * repeat from the same holder returns false so the WS handler can surface
   * `already_in_state`.
   */
  private acquireHold(agentName: string, holder: GateHolder): boolean {
    if (!this.specs.has(agentName)) return false;
    const existing = this.pauseGates.get(agentName);
    if (existing) {
      // A gate is already parking this agent's queue. Adding a holder is the
      // whole change: installing a second gate would chain a promise behind
      // one that is not going to resolve, and the release bookkeeping below
      // would then have to unwind two of them in the right order.
      if (existing.holders.has(holder)) return false;
      existing.holders.add(holder);
      return true;
    }
    let release!: () => void;
    const promise = new Promise<void>((res) => {
      release = res;
    });
    this.pauseGates.set(agentName, { promise, release, holders: new Set([holder]) });
    // `Cebab-vie.1` [security]: recording the gate is the WHOLE operation. It
    // used to also splice itself into the turn queue as
    // `prevTail.then(() => promise)` — which chains it AFTER everything already
    // enqueued, so N deliveries waiting at the moment of the click ran N full
    // unattended turns and only the N+1th was ever held. The intent was "the
    // in-flight turn finishes", and that is still true, but it was implemented
    // as "everything already queued finishes", which is a different and much
    // larger promise.
    //
    // `deliverTurn` now reads this map at dequeue instead, so a gate installed
    // at any point before a turn actually starts holds it.
    //
    // Measured, because it is easy to assume otherwise: putting the chaining
    // BACK does not reintroduce the bug — the dequeue read still parks those
    // deliveries, so the two mechanisms agree and the whole pause suite stays
    // green either way. It is removed because it is now a second spelling of
    // one rule, and because it is not entirely inert: while a gate stands, a
    // chained delivery never reaches its `.then`, so `canStartTurn` never runs
    // for it. That is the paused-THEN-kicked case, where the chaining turns a
    // prompt refusal into a wait for `releaseAllHolds` — see the kick suite.
    return true;
  }

  /**
   * `Cebab-vie.11` [security]: drop every holder's claim at once and let the
   * queue drain, whatever it was being held for.
   *
   * Only kick calls this, and only because kick is terminal. A delivery parked
   * at `deliverTurn`'s `await gate.promise` is inside the wait — it cannot
   * notice the kick until something settles that promise. Nothing would: the
   * `auto_kick` expiry path clears the pause COLUMN and never calls
   * `resumeAgent`, so the gate outlives the pause that justified it. The
   * delivery's promise never settles, its `pendingDeliveries` slot never
   * drains, and the router's `onTurnStarted` is never balanced by
   * `onTurnSettled` — the run looks busy forever.
   *
   * Releasing sends those deliveries back around the loop, where `canStartTurn`
   * refuses them. Nothing runs; the difference is between refused and stranded.
   * The same reasoning is already written down for the mutation holder, where
   * `continueThroughMutation`'s kicked branch releases it because "a kicked
   * agent has no queue worth holding, and leaving it standing would keep
   * in-memory state that no banner explains."
   *
   * Deliberately NOT a public verb for anything else: `resume` and
   * `releaseMutationHold` release exactly one holder each, which is what stops
   * an operator Continue from lifting a standing operator pause.
   */
  releaseAllHolds(agentName: string): boolean {
    const gate = this.pauseGates.get(agentName);
    if (!gate) return false;
    this.pauseGates.delete(agentName);
    gate.holders.clear();
    gate.release();
    return true;
  }

  /**
   * Drop `holder`'s claim on `agentName`'s gate. Returns true iff this holder
   * actually held it. The queue only drains once the LAST holder lets go —
   * that is the whole point of the set, and reverting it to an unconditional
   * `release()` is what lets one verb lift another's hold.
   */
  private releaseHold(agentName: string, holder: GateHolder): boolean {
    const gate = this.pauseGates.get(agentName);
    if (!gate) return false;
    if (!gate.holders.delete(holder)) return false;
    if (gate.holders.size > 0) return true;
    this.pauseGates.delete(agentName);
    gate.release();
    return true;
  }

  /**
   * Cluster C Phase 4c: drop the OPERATOR's hold on `agentName`. Returns
   * true iff the operator was holding it (`false` on re-resume / not-
   * paused). The release is synchronous from the gate's POV: queued
   * `deliverTurn` calls' `.then()` fire in the next microtask — but only
   * once the pause-on-dangerous hold is gone too, if one is also standing.
   * Resuming a worker does not approve the command it was halted at.
   */
  resume(agentName: string): boolean {
    return this.releaseHold(agentName, 'operator');
  }

  /**
   * Cluster C Phase 4c (AE-5): observability hook for the WS handler's
   * `participant_pause_changed.queuedDeliveries` field. Returns the
   * current "queued but not started" count for the agent. Includes calls
   * waiting on a pause gate AND calls waiting on a slow in-flight turn —
   * the operator's mental model doesn't distinguish (and shouldn't have
   * to).
   */
  getPendingDeliveries(agentName: string): number {
    return this.pendingDeliveries.get(agentName) ?? 0;
  }

  /**
   * `Cebab-vie.8`: is ANY agent's turn queue held, by any holder?
   *
   * The stranded-run detector needs this because a held queue is the one way a
   * run can have zero turns running and still not be stuck: the pause-on-
   * dangerous gate ends the worker's turn by throwing
   * `PausedForMutationError`, leaving the event tail pointing at the worker it
   * held, and an operator pause does the same to whatever is delivered next.
   * Both hand the operator a Continue/Resume affordance, so neither is a run
   * that needs telling it has stopped.
   *
   * Holder-agnostic on purpose. The detector's question is "is something going
   * to move this run again", and both holders answer it the same way — asking
   * per holder would be a distinction with no consequence here, and one more
   * place to forget a third holder.
   *
   * A gate entry only exists while it is held: `releaseHold` deletes the map
   * entry when the last holder lets go, so a non-empty map already means a live
   * hold. The per-entry `holders.size` check below is therefore redundant
   * against that invariant, and kept anyway — it costs nothing and it is what
   * stops this returning true forever if a future holder ever leaves an empty
   * gate behind.
   */
  anyGateHeld(): boolean {
    for (const gate of this.pauseGates.values()) {
      if (gate.holders.size > 0) return true;
    }
    return false;
  }

  /** Test-only probe: is the OPERATOR holding this agent's queue? */
  isPaused(agentName: string): boolean {
    return this.pauseGates.get(agentName)?.holders.has('operator') === true;
  }

  /** Test-only probe: is the pause-on-dangerous gate holding this agent's queue? */
  isHeldForMutation(agentName: string): boolean {
    return this.pauseGates.get(agentName)?.holders.has('mutation') === true;
  }

  private async runOneTurn(agentName: string, promptText: string): Promise<void> {
    const spec = this.specs.get(agentName);
    if (!spec) throw new Error(`deliverTurn: unknown agent ${JSON.stringify(agentName)}`);

    // Claimed once per hop, before the retry loop, so every attempt of this
    // turn replays the same mock script (see `turnCounts`).
    const turnIndex = this.turnCounts.get(agentName) ?? 0;
    this.turnCounts.set(agentName, turnIndex + 1);

    // B15: same lifetime as `turnIndex`, and for the same reason. A retry
    // re-runs THIS turn, so a `tool_use` id the tap already fired for is a
    // repeat of a call already recorded — not a second call.
    //
    // Per-HOP rather than per-runner because this set is only the cheap
    // in-memory half. Holding every id a long bus run ever saw would grow
    // without bound, and it would still miss the cross-restart case, where a
    // rebuilt router starts with an empty set. The durable half is migration
    // 034's unique index on `(session_id, tool_use_id)`, which absorbs a
    // repeat from ANY hop or process (register D20). An id reappearing on a
    // later hop is a repeat there too — distinct tool calls carry distinct
    // ids — so it is silently absorbed rather than recorded twice.
    const tappedToolUseIds = new Set<string>();

    // Retry-with-backoff for transient API overloads ("API Error: 529",
    // "Overloaded"). The interactive CLI absorbs these internally; the SDK
    // propagates them raw to our iterator. Without this layer, Item #4's
    // worker-failure banner fires on every transient blip, and once the
    // bus starts seeing them at a few-percent rate, every orchestrator
    // turn looks broken even though the underlying account is healthy.
    //
    // `prior` is RE-READ inside the loop because a prior attempt may have
    // persisted a checkpoint via `m.type === 'result'` BEFORE throwing
    // (this happens when the SDK delivers a result with a non-success
    // subtype). The next attempt then `--resume`s the same boundary.
    //
    // Errors that are NOT transient overloads (mutation pause sentinel,
    // unknown CLI failures, abort) propagate immediately — no retries.
    // `Cebab-vie.14`: that was a claim about the sentinel's message text until
    // `isTransientOverload` started class-checking, and the text is partly the
    // worker's. The guard lives in the predicate rather than here so there is
    // one place to get it right; a copy at this call site would be a second
    // place to forget it.
    const backoffMs = this.deps.overloadBackoffMs ?? DEFAULT_OVERLOAD_BACKOFF_MS;
    const maxAttempts = backoffMs.length + 1;
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await this.runOneAttempt(agentName, promptText, spec, turnIndex, tappedToolUseIds);
        return; // success
      } catch (err) {
        lastErr = err;
        const aborted = this.deps.abortController?.signal.aborted === true;
        if (aborted || !isTransientOverload(err) || attempt >= backoffMs.length) {
          throw err;
        }
        const delay = backoffMs[attempt]!;
        // Cluster D Phase 4a (BE-D5): the console.warn debug breadcrumb
        // stays — it's cheap and useful in raw server logs — but we ALSO
        // fire onAutoRetry so the wired callers (chain.ts /
        // orchestrator.ts) can emit an `auto_retry` ServerMsg + write a
        // recovery_log row. `[security]` BE-D7: we're already inside the
        // `isTransientOverload(err)` branch — the hook can't fire on a
        // non-transient error. `Cebab-vie.14`: true since that predicate
        // started class-checking, and false before it — a gate pause reached
        // here and was reported to the operator, and written to
        // `recovery_log`, as `reason: 'transient_overload'`.
        console.warn(
          `[runner] ${agentName} hit transient overload (attempt ${attempt + 1}/${maxAttempts}): ${(err as Error).message}. Backing off ${delay}ms before retry.`,
        );
        // 1-indexed attempt # of the retry that's about to fire (NOT the
        // attempt that just failed). e.g. failed-1st-try → attempt=2.
        const nextAttempt = attempt + 2;
        this.deps.onAutoRetry?.({
          agentName,
          attempt: nextAttempt,
          maxAttempts,
          backoffMs: delay,
          retryAt: Date.now() + delay,
          reason: 'transient_overload',
          error: err,
        });
        await sleep(delay);
      }
    }
    // Unreachable: loop body either returns or throws on the final attempt.
    throw lastErr;
  }

  /**
   * Build the `canUseTool` gate for one agent's query (interactive
   * AskUserQuestion path). For an unrestricted agent it auto-allows every tool
   * to preserve the bus's no-human-gate posture; for `AskUserQuestion` it parks
   * via `onAskUserQuestion` and returns the operator's answer as a `deny`
   * message — the SDK delivers that to the model as the tool result (validated
   * spike: the model reads "User selected: X" and continues).
   *
   * For a `'delegate-only'` agent (the orchestrator) this is the AUTHORITATIVE
   * boundary: every tool except `bus_send` / `AskUserQuestion` is denied with a
   * nudge to delegate, and the attempt is reported via `onGuardrailViolation`.
   * This backstops the `disallowedTools` context-removal layer (catching e.g. a
   * future built-in not in `DELEGATE_ONLY_DISALLOWED`) and never depends on the
   * SDK's tool-filtering behaviour.
   */
  private makeCanUseTool(agentName: string): NonNullable<RunOptions['canUseTool']> {
    const onAsk = this.deps.onAskUserQuestion;
    const delegateOnly = this.specs.get(agentName)?.toolPolicy === 'delegate-only';
    return async (toolName, input, { toolUseID }) => {
      if (delegateOnly && !isDelegationAllowedTool(toolName)) {
        // Fire-and-forget observability; must not affect the (already-decided)
        // deny. A throwing hook is swallowed so a bad sink can't wedge the turn.
        try {
          this.deps.onGuardrailViolation?.(agentName, toolName);
        } catch (err) {
          console.error('[bus] onGuardrailViolation threw', err);
        }
        return {
          behavior: 'deny',
          message:
            `You are the orchestrator and cannot use \`${toolName}\`. You have no ` +
            `file, shell, or analysis tools — your only actions are \`bus_send\` ` +
            `(to delegate to a worker, or deliver the final answer to \`user\`) and ` +
            `\`AskUserQuestion\`. Route this work to the appropriate worker via ` +
            `bus_send instead of doing it yourself.`,
        };
      }
      // `Cebab-vie.16` [security]: an agent halted at an unapproved dangerous
      // command dispatches nothing else.
      //
      // A pause stops the turn by throwing out of the mutation tap, and the
      // tap runs per BLOCK — so the second `tool_use` of the same assistant
      // message was never Cebab's to stop: the throw had already left the
      // block loop, and whether the CLI dispatched it was a race the parent
      // only sometimes wins (`Cebab-vie.15`). This is the seam that decides
      // that race, because it is the one thing the CLI asks BEFORE dispatch.
      //
      // The `'mutation'` holder specifically, never `'operator'`. An operator
      // pause is documented as a turn-SCHEDULING gate that does not touch the
      // running turn — `Cebab-vie.2` is open on exactly that, and quietly
      // half-closing it here would change what the Pause button means in a
      // change about something else. `holders` is the distinction; `pauseGates`
      // membership is not.
      //
      // Free and exact: `applyPauseGate` installs the hold BEFORE the pending
      // write, the sink and the throw, deliberately ("so the hold cannot be
      // missed by any path that gives up between here and the throw"), so by
      // the time a sibling's control request arrives the Map already says so.
      // No DB read on a per-tool-call path.
      //
      // MEASURED, because this seam is not a universal gate and a deny here
      // could have been decoration — `src/bus_pause_gate_smoke.ts`, 2026-08-25:
      // an in-cwd Read is resolved by the CLI and never reaches this callback,
      // but an in-cwd `Bash` and an in-cwd `Write` are both consulted, and a
      // deny returned here stops the command from running. The bypassed class
      // is reads; the gate only ever fires on `dangerous`; they do not overlap.
      //
      // The Continue path is unaffected: `continueThroughMutation` calls
      // `releaseMutationHold` BEFORE re-delivering, so the replayed turn's
      // first tool call finds no hold.
      if (this.pauseGates.get(agentName)?.holders.has('mutation')) {
        return {
          behavior: 'deny',
          message:
            `Cebab has paused you at a dangerous command that is waiting for operator ` +
            `approval, so \`${toolName}\` was not run. Stop issuing tool calls and end ` +
            `your turn; the operator will decide whether the paused command proceeds.`,
        };
      }
      if (toolName !== 'AskUserQuestion' || !onAsk) {
        return { behavior: 'allow', updatedInput: input };
      }
      // Suspend the stalled-turn watchdog while the operator is being asked:
      // the turn is intentionally blocked on a human, not wedged.
      this.parked.set(agentName, (this.parked.get(agentName) ?? 0) + 1);
      try {
        const answer = await onAsk(agentName, toolUseID, parseAskUserQuestions(input));
        return { behavior: 'deny', message: answer };
      } catch {
        return {
          behavior: 'deny',
          message: 'The user dismissed the question without answering.',
        };
      } finally {
        const remaining = (this.parked.get(agentName) ?? 1) - 1;
        if (remaining <= 0) this.parked.delete(agentName);
        else this.parked.set(agentName, remaining);
      }
    };
  }

  /**
   * Tap ONE `tool_use` block: classify it, skip what the policy would deny or
   * the ledger already has, attach the guardrail verdict, and hand it to the
   * mutation hook — which persists it, emits it, and may throw to halt the
   * turn (the pause-on-dangerous gate).
   *
   * Extracted from the message loop for `Cebab-vie.16`. It has two callers now
   * and they differ only in what they do with a throw: the loop stashes the
   * blocks after this one and lets it propagate; the deferred replay in the
   * `finally` logs and moves on, because the turn is already over by then. One
   * body rather than two means the replayed block gets the identical treatment
   * — same classifier, same dedupe, same guardrail verdict, same hook payload
   * — which is the whole point. A record-only shortcut for the deferred path
   * would have been a second, thinner spelling of the ledger, and the thinner
   * one is the one nobody reads until it is wrong.
   */
  private async tapToolUseBlock(
    agentName: string,
    spec: AgentSpec,
    delegateOnly: boolean,
    tappedToolUseIds: Set<string>,
    block: ToolUseBlock,
  ): Promise<void> {
    if (!this.deps.onMutation) return;
    if (block?.type !== 'tool_use') return;
    const toolName = typeof block.name === 'string' ? block.name : '';
    if (!toolName) return;
    // B10: this block says the SDK is ABOUT to dispatch — not that it
    // will. For a `delegate-only` agent, `makeCanUseTool` denies
    // everything outside `isDelegationAllowedTool` when the SDK asks,
    // which is AFTER this message. Without this check the orchestrator
    // writing a stray `Bash` gets a dangerous mutation row, and can
    // trip the pause-on-dangerous gate and halt the session, for a
    // command that never ran.
    //
    // Deliberately the SAME predicate the gate uses rather than a
    // copy: two spellings of "what may the orchestrator call" would
    // drift, and the copy that drifts is the one nobody is testing.
    if (delegateOnly && !isDelegationAllowedTool(toolName)) return;
    const cls = classifyToolCall(toolName, block.input);
    if (cls.category === 'read') return;
    const toolUseId = typeof block.id === 'string' ? block.id : undefined;
    // B15: a retry re-runs this turn with the same prompt and may
    // `--resume` the failed attempt's checkpoint, so a block seen
    // once can arrive again. Fire once per id per hop.
    //
    // An id-less block always fires: it cannot be recognised as a
    // repeat, and silently dropping it would lose a real mutation.
    // Over-recording an unidentifiable call is the safer error for a
    // ledger the pause gate reads.
    //
    // `Cebab-vie.16`: the deferred replay shares this set with the loop that
    // stashed the block, so a block recorded there is not recorded twice.
    if (toolUseId !== undefined) {
      if (tappedToolUseIds.has(toolUseId)) return;
      tappedToolUseIds.add(toolUseId);
    }
    // Cluster F Phase D5+: classify path scope vs agent cwd. The
    // consultant-mode prompt forbids out-of-scope mutations; this
    // surfaces violations post-hoc rather than denying them. (Not
    // because there is no gate — `makeCanUseTool` above IS live on
    // every production turn; it allows everything for agents without
    // `toolPolicy: 'delegate-only'`. See guardrail.ts's header for
    // why turning that seam into enforcement is not free.) The
    // verdict rides on the hook payload — the orchestrator/chain
    // sink persists it on the mutation row and the WS broadcast
    // fan-out fires the safety_audit dispatcher. In-scope
    // mutations (the common case) carry no `guardrailViolation`
    // field, so existing tests / sinks that don't look at the
    // field continue to behave identically.
    const scope = classifyMutationScope({
      agentCwd: spec.cwd,
      filePath: cls.filePath,
    });
    const guardrailViolation = scope.inScope
      ? undefined
      : { violatedPath: scope.resolvedPath, reasonCode: scope.reasonCode };
    // Awaited so the gate can persist + emit + throw before the
    // loop yields back to the SDK. A throw propagates.
    await this.deps.onMutation(agentName, toolName, spec.cwd, {
      category: cls.category,
      summary: cls.summary,
      // Migration 026: capture the full tool input so the Logs
      // drawer shows the complete command/args (repo caps the size).
      toolInput: block.input,
      ...(cls.filePath !== undefined ? { filePath: cls.filePath } : {}),
      ...(toolUseId !== undefined ? { toolUseId } : {}),
      ...(guardrailViolation ? { guardrailViolation } : {}),
      // Cluster F Phase F3: Bash mutations carry the rule that
      // pinned the category. Non-Bash mutations leave `reason`
      // undefined (the tool name is the rationale).
      ...(cls.reason ? { classifierReason: cls.reason } : {}),
    });
  }

  private async runOneAttempt(
    agentName: string,
    promptText: string,
    spec: AgentSpec,
    turnIndex: number,
    /**
     * B15: `tool_use` ids the mutation tap has already fired for during THIS
     * hop. Owned by `runOneTurn` and shared across its retry attempts, for the
     * same reason `turnIndex` is claimed once per hop — a retry replays the
     * same turn, so anything it re-emits is a repeat, not a new call.
     */
    tappedToolUseIds: Set<string>,
  ): Promise<void> {
    const factory = this.deps.runnerFactory ?? pickRunner;
    // Read INSIDE the serialized turn (not when `deliverTurn` was called) so
    // this resumes the checkpoint the previous queued turn just wrote, AND so
    // a transient-overload retry picks up the latest checkpoint written by the
    // failed attempt's pre-throw `m.session_id` capture.
    const prior = this.sessions.get(agentName);

    // Interactive AskUserQuestion: when the ask-gate hook is wired we run under
    // 'default' permission mode with a canUseTool that auto-allows every tool
    // EXCEPT AskUserQuestion (which it parks for the operator). Without the
    // hook we keep the original headless posture — bypass everything, no gate —
    // so callers/tests that don't wire it stay byte-identical to before.
    const askGate = this.deps.onAskUserQuestion
      ? { permissionMode: 'default' as const, canUseTool: this.makeCanUseTool(agentName) }
      : { permissionMode: 'bypassPermissions' as const, allowDangerouslySkipPermissions: true };

    // Delegation-only agents (the orchestrator) get the file/shell/analysis
    // built-ins stripped from the model's context entirely — the "remove from
    // view" layer complementing the authoritative default-deny in
    // `makeCanUseTool`. Works in either permission posture.
    const delegateOnly = spec.toolPolicy === 'delegate-only';
    const toolLock = delegateOnly ? { disallowedTools: [...DELEGATE_ONLY_DISALLOWED] } : {};

    // H04: MCP servers this agent's operator denied. Read from `this.specs`
    // at turn time (not captured at register time) so a denial applied
    // mid-session takes effect on the very next hop.
    const denied = this.specs.get(agentName)?.deniedMcpServers ?? spec.deniedMcpServers;
    const mcpDenial = denied && denied.length > 0 ? { deniedMcpServers: [...denied] } : {};

    // Resolved once so the value that goes to the SDK and the value the cap-hit
    // sentinel reports are the same number by construction, not by two call
    // sites agreeing.
    const effectiveMaxTurns = this.deps.maxTurns ?? config.maxTurns;

    const runner = factory({
      cwd: spec.cwd,
      prompt: promptText,
      ...(prior ? { resume: prior } : {}),
      ...askGate,
      ...toolLock,
      ...mcpDenial,
      ...(spec.model ? { model: spec.model } : {}),
      settingSources: spec.settingSources ?? ['user'],
      // `Cebab-vie.17`. UNCONDITIONAL, deliberately breaking the
      // conditional-spread rule that governs `model` and `deniedMcpServers`
      // above. That rule exists because absence there has a distinct correct
      // meaning (the CLI's own default / no denials). Here absence means "an
      // unbounded agent turn", which is precisely the bug this closes — so
      // `'maxTurns' in opts` is true on every bus hop and is an assertable
      // invariant rather than something a future call site has to remember.
      //
      // The floor is `config.maxTurns`, NOT `resolveMaxTurns()`: the runner
      // cannot import `ws/server.ts`. Every production path goes through a WS
      // handler that passes the resolved value, so the floor is only reached
      // by direct construction (i.e. tests) — a path that then loses the DB
      // setting, never the bound.
      maxTurns: effectiveMaxTurns,
      mcpServers: {
        // Sole registration. The `bus` alias that shimmed the
        // `bus` → `cebab_bus` rename (e04769e, 2026-05-25) is gone: it only
        // ever mattered for a CLI session resumed across that commit, and it
        // cost more than it bought — Cebab's registration under the bare `bus`
        // key CLOBBERED any `mcpServers.bus` a participant declares in its own
        // `.claude/settings*.json`, which is precisely the collision the
        // namespaced key was introduced to avoid.
        cebab_bus: makeBusToolServer(agentName, this.deps.onEvent),
      },
      abortController: this.deps.abortController,
      // Mock-mode fixture routing. Inert under `runClaude`, which reads only
      // the RunOptions fields above.
      ...(this.deps.mockScenario !== undefined
        ? {
            mockScenario: this.deps.mockScenario,
            mockAgent: agentName,
            mockTurn: turnIndex,
            ...(this.deps.mockVars ? { mockVars: this.deps.mockVars(agentName) } : {}),
          }
        : {}),
    });

    // Cluster G Phase 3 (G1): tag the lifecycle entry with bus-run metadata
    // when the caller (chain.ts / orchestrator.ts) provided a sessionId in
    // deps. Absent in tests, in which case the query is still tracked for
    // shutdown but is invisible to the `active_runs` snapshot — that's the
    // right default for the runner test harnesses (they don't simulate a
    // real bus session id).
    const meta =
      this.deps.sessionId !== undefined
        ? {
            sessionId: this.deps.sessionId,
            ...(spec.projectId !== undefined ? { projectId: spec.projectId } : {}),
            kind: 'bus-worker' as const,
            startedAt: Date.now(),
          }
        : undefined;
    const unregister = registerQuery(runner, meta);

    // --- Stalled-turn watchdog ------------------------------------------------
    // Reset on every SDKMessage. No message for `stallNotifyMs` (and not
    // mid-tool, not parked on a question) → fire `onTurnStalled` once (operator
    // alert). No message for the hard threshold → abort the Query and surface a
    // `TurnStalledError` so a wedged turn can't hang silently until a server
    // restart. The abort relies on `Query.close()`/`interrupt()` ending the
    // stream — the same primitive the single-agent interrupt path uses.
    const stallNotifyMs = this.deps.stallNotifyMs ?? DEFAULT_STALL_NOTIFY_MS;
    const stallAbortMs = this.deps.stallAbortMs ?? DEFAULT_STALL_ABORT_MS;
    const stallToolCeilingMs = this.deps.stallToolCeilingMs ?? DEFAULT_STALL_TOOL_CEILING_MS;
    const turnStartedAt = Date.now();
    let lastMsgAt = turnStartedAt;
    // `Cebab-vie.16`: the `tool_use` blocks of the assistant message that was
    // being tapped when the mutation hook threw. Non-empty only on that path —
    // one message's tail at most, since the throw leaves the `for await`
    // immediately.
    let deferredBlocks: ToolUseBlock[] = [];
    let toolInFlight = false;
    let softNotified = false;
    let stalledAbort = false;
    let stalledAbortMs = 0;
    let softTimer: ReturnType<typeof setTimeout> | null = null;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    const isParked = () => (this.parked.get(agentName) ?? 0) > 0;
    const clearStallTimers = () => {
      if (softTimer) clearTimeout(softTimer);
      if (hardTimer) clearTimeout(hardTimer);
      softTimer = null;
      hardTimer = null;
    };
    const armSoft = (ms: number) => {
      softTimer = setTimeout(
        () => {
          const idle = Date.now() - lastMsgAt;
          // Parked-on-question or mid-tool → working, not wedged: re-check later.
          if (isParked() || toolInFlight) return armSoft(stallNotifyMs);
          if (idle < stallNotifyMs) return armSoft(stallNotifyMs - idle);
          if (!softNotified) {
            softNotified = true;
            try {
              this.deps.onTurnStalled?.({ agentName, idleMs: idle, turnStartedAt });
            } catch (e) {
              console.error(`[runner] onTurnStalled(${agentName}) threw`, e);
            }
          }
          armSoft(stallNotifyMs);
        },
        Math.max(ms, 0),
      );
      softTimer.unref?.();
    };
    const armHard = (ms: number) => {
      hardTimer = setTimeout(
        () => {
          const idle = Date.now() - lastMsgAt;
          if (isParked()) return armHard(stallNotifyMs);
          const ceiling = toolInFlight ? stallToolCeilingMs : stallAbortMs;
          if (idle < ceiling) return armHard(ceiling - idle);
          stalledAbort = true;
          stalledAbortMs = idle;
          clearStallTimers();
          // Hard-close the wedged Query to end the stream; the `for await` then
          // completes (inputStream.done()) and the catch/finally below normalizes
          // to TurnStalledError.
          //
          // We deliberately do NOT call `interrupt()` first. `interrupt()` parks a
          // control-request promise inside the SDK, and the `close()` below
          // immediately rejects it with "Query closed before response received".
          // That rejection is fire-and-forget (no catch), and the try/catch here
          // only guards *synchronous* throws — so it escaped as an unhandled
          // rejection and crashed the whole server: the exact opposite of
          // "auto-recover instead of silent hang". A wedged turn can't be
          // interrupted gracefully anyway; the hard close reliably reaps it. The
          // process-level `unhandledRejection` guard in index.ts is the backstop
          // for any in-flight SDK promise this close() still rejects.
          try {
            runner.close?.();
          } catch {
            /* best effort */
          }
        },
        Math.max(ms, 0),
      );
      hardTimer.unref?.();
    };
    armSoft(stallNotifyMs);
    armHard(stallAbortMs);

    try {
      for await (const msg of runner) {
        // Watchdog liveness: a message means the turn is progressing. Reset the
        // idle clock, clear a prior stall (operator "resumed"), track tools.
        lastMsgAt = Date.now();
        if (softNotified) {
          softNotified = false;
          try {
            this.deps.onTurnResumed?.(agentName);
          } catch (e) {
            console.error(`[runner] onTurnResumed(${agentName}) threw`, e);
          }
        }
        toolInFlight = deriveToolInFlight(msg, toolInFlight);

        this.deps.onMessage?.(agentName, msg);

        // Item #5 mutation tap: every `tool_use` block on an `assistant`
        // SDKMessage represents a tool the SDK is about to dispatch.
        // Classify each; for non-`read` calls, fire `onMutation` BEFORE the
        // SDK runs the tool. The hook can throw `PausedForMutationError` to
        // abort the turn (pause-on-dangerous gate). The cwd-side race
        // window — SDK may dispatch the tool before the throw lands — is
        // documented as a best-effort caveat in the plan.
        //
        // `Cebab-vie.16`: a throw from the hook ends the TURN, and it used to
        // end this loop with it — so every block after the one that paused was
        // never classified, never persisted, never given a guardrail verdict
        // and never audited. A worker that emitted `rm -rf /a` and `rm -rf /b`
        // in one message left Cebab's ledgers holding only the first, while
        // whether the CLI already dispatched the second is a race
        // (`Cebab-vie.15`). The remaining blocks are stashed here and replayed
        // below — see `deferredBlocks` at the `finally` for why not inline.
        if (this.deps.onMutation) {
          const am = msg as {
            type?: string;
            message?: { content?: ToolUseBlock[] };
          };
          if (am.type === 'assistant' && Array.isArray(am.message?.content)) {
            const blocks = am.message.content;
            for (let i = 0; i < blocks.length; i++) {
              try {
                await this.tapToolUseBlock(
                  agentName,
                  spec,
                  delegateOnly,
                  tappedToolUseIds,
                  blocks[i]!,
                );
              } catch (tapErr) {
                deferredBlocks = blocks.slice(i + 1);
                throw tapErr;
              }
            }
          }
        }

        // Migration 012 tool-result tap: every `tool_result` block on a
        // `user` SDKMessage flips the matching `multi_agent_mutations` row
        // from provisional to confirmed (keyed by `tool_use_id`). Best-effort:
        // the hook itself is wrapped in try/catch downstream — failure here
        // never aborts the turn.
        if (this.deps.onToolResult) {
          const um = msg as {
            type?: string;
            message?: {
              content?: Array<{
                type?: string;
                tool_use_id?: string;
                is_error?: boolean;
                content?: unknown;
              }>;
            };
          };
          if (um.type === 'user' && Array.isArray(um.message?.content)) {
            for (const block of um.message.content) {
              if (block?.type !== 'tool_result') continue;
              if (typeof block.tool_use_id !== 'string') continue;
              try {
                await this.deps.onToolResult(agentName, block.tool_use_id, {
                  isError: block.is_error === true,
                  // Migration 026: forward the result payload so the matching
                  // mutation row stores the full tool output.
                  content: block.content,
                });
              } catch (err) {
                console.error(`[runner] onToolResult(${agentName}) failed`, err);
              }
            }
          }
        }

        const m = msg as {
          type?: string;
          session_id?: string;
          subtype?: string;
          total_cost_usd?: number;
          // snake_case, because this narrows the RAW `SDKMessage`. The
          // single-agent site reads `numTurns` only because `translate()`
          // camel-cases it first; `m.numTurns` would compile here under the
          // cast and be `undefined` forever.
          num_turns?: number;
        };
        // F7: bill the hop. Deliberately NOT nested inside the session_id
        // branch below — a result without a session id still cost money, and
        // deliberately above the non-success throw, so a turn that burned
        // quota and then errored is still counted.
        if (m.type === 'result' && typeof m.total_cost_usd === 'number') {
          try {
            this.deps.onTurnCost?.(agentName, m.total_cost_usd);
          } catch (err) {
            console.error(`[runner] onTurnCost(${agentName}) failed`, err);
          }
        }
        if (m.type === 'result' && typeof m.session_id === 'string') {
          this.sessions.set(agentName, m.session_id);
          // Persist the checkpoint. A DB hiccup must never abort a turn —
          // same try/catch-and-log posture as the routers' persistence.
          try {
            this.deps.onSessionId?.(agentName, m.session_id);
          } catch (err) {
            console.error(`[runner] onSessionId(${agentName}) failed`, err);
          }
          // SDK signals a turn-level failure via a non-success `result.subtype`
          // (`error_during_execution`, `error_max_turns`, `error_max_budget_usd`,
          // `error_max_structured_output_retries`). The bus layer used to
          // silently move on; now we unify with the iterator-throw path so
          // both router .catch handlers see the same shape. The checkpoint
          // write above is intentionally BEFORE the throw — retry resumes
          // from the same SDK boundary the failed turn saw, not the prior one.
          if (typeof m.subtype === 'string' && m.subtype !== 'success') {
            // `Cebab-vie.17`: the cap Cebab now passes gets a CLASS, because a
            // cap hit is Cebab's own decision and must never be swallowed by
            // the overload-retry loop — see `isBusControlSignal`. The other
            // three keep the generic shape on purpose: `error_during_execution`
            // is matched BY THIS STRING in `isTransientOverload`, and the two
            // `error_max_*` siblings are unreachable (Cebab sets no cost cap
            // and requests no structured output).
            if (m.subtype === 'error_max_turns') {
              throw new MaxTurnsReachedError(agentName, effectiveMaxTurns, m.num_turns ?? 0);
            }
            throw new Error(`SDK result subtype=${m.subtype}`);
          }
        }
      }
      // Watchdog hard-abort, clean-iterator-return shape: the abort closed the
      // Query and the iterator finished. Surface it as a stalled turn.
      if (stalledAbort) throw new TurnStalledError(agentName, stalledAbortMs);
    } catch (loopErr) {
      // Watchdog hard-abort, iterator-rejection shape: closing the Query made
      // the stream throw. Normalize both shapes to TurnStalledError so the
      // routers' `.catch` recognises the stall uniformly (vs. a generic SDK
      // abort error). A non-abort error propagates unchanged.
      if (stalledAbort) {
        throw loopErr instanceof TurnStalledError
          ? loopErr
          : new TurnStalledError(agentName, stalledAbortMs);
      }
      throw loopErr;
    } finally {
      clearStallTimers();
      // Close the per-attempt SDK Query / claude subprocess BEFORE the next
      // attempt spawns its own. Matches the single-agent pattern at
      // ws/server.ts:1547. The prior bus runner only called `unregister()`,
      // which left the subprocess to be GC'd whenever the SDK happened to
      // tear it down — a window that could overlap with a retry's spawn or
      // a sibling agent's spawn. Wrap the close in try/catch so a runner
      // implementation that doesn't expose close() (or that throws on
      // close) can't leak past unregister.
      try {
        runner.close?.();
      } catch (closeErr) {
        console.error(`[runner] close(${agentName}) failed`, closeErr);
      }
      unregister();
      // `Cebab-vie.16`: the tapped message's remaining blocks, recorded now
      // that the turn is dead and the subprocess is closed.
      //
      // AFTER the close, deliberately, and the obvious edit is the wrong one.
      // Recording them inline before rethrowing would delay the throw — and the
      // throw plus the `close()` above is what may reap the subprocess before
      // the CLI dispatches the sibling, which is the only thing standing
      // between a paused `rm -rf /b` and a run one (`Cebab-vie.15`: the parent
      // sometimes wins that race, and cannot be made to always win). Killing is
      // safety and recording is forensics: a row written two milliseconds later
      // is worth exactly the same, and a command killed two milliseconds later
      // is not.
      //
      // Full hook, gate included, rather than a record-only shortcut. With a
      // pending pause already standing `decidePauseForMutation` answers `run`,
      // so no second banner and no second throw; and on the
      // `MutationNotRecordedError` path — where no pending row exists — a
      // dangerous sibling whose own INSERT succeeds correctly installs its hold
      // and banner before throwing. Either way the FIRST error is the one that
      // reaches the router, so a throw from here is logged and dropped.
      for (const block of deferredBlocks) {
        try {
          await this.tapToolUseBlock(agentName, spec, delegateOnly, tappedToolUseIds, block);
        } catch (deferErr) {
          console.error(
            `[runner] deferred mutation tap for ${agentName} failed (the turn had already ended)`,
            deferErr,
          );
        }
      }
    }
  }

  /** Cancel all in-flight turns for this session. */
  stop(): void {
    this.deps.abortController?.abort();
  }
}

/**
 * Default exponential-ish backoff for transient API overloads. Three retries
 * = up to 14 s of cumulative absorb time before surfacing the failure as a
 * worker-failure banner. Length of the array also defines MAX_RETRIES.
 *
 * The values are tuned for "absorb a few-percent 529 rate without making the
 * user think the session is hung". 1 s feels instant; 10 s is the longest a
 * single absorb step can take before the operator suspects something is off.
 */
export const DEFAULT_OVERLOAD_BACKOFF_MS: readonly number[] = [1000, 3000, 10000];

/**
 * True when `err` looks like a transient Anthropic API overload (5xx-class).
 * Matches both the raw SDK iterator throw form ("Claude Code returned an
 * error result: API Error: 529 Overloaded...") and the synthetic Item #4
 * wrapper ("SDK result subtype=error_during_execution") — both of which the
 * bus has been seeing during the regression.
 *
 * **Cebab's own control signals are answered `false` before any string is read**
 * (`Cebab-vie.14` [security]). The substring matching below is permissive by
 * design, and its cost used to be described as "annoying log noise, no
 * correctness impact" — which held only for errors nobody writes. A
 * `PausedForMutationError` carries the paused command's summary, and for `Bash`
 * that summary is the model's own command and description verbatim, so a worker
 * could put `Overloaded` in either half and have its pause retried: the
 * replayed turn re-issued the command and the gate waved it through, because
 * that agent was already halted. Class first, text second — see
 * `isBusControlSignal`.
 *
 * Permissive matching otherwise stands: a false positive on a genuine remote
 * error retries it `MAX_RETRIES` times before giving up, which is noise. False
 * negatives surface immediately as before.
 *
 * Exported for unit tests.
 */
export function isTransientOverload(err: unknown): boolean {
  if (isBusControlSignal(err)) return false;
  if (!(err instanceof Error)) return false;
  const m = err.message;
  return (
    m.includes('API Error: 529') ||
    m.includes('Overloaded') ||
    m.includes('SDK result subtype=error_during_execution')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tolerant coercion of an `AskUserQuestion` tool input into the wire
 * `AskUserQuestionView[]`. The SDK input is a union of fixed-length option
 * tuples; we flatten to plain arrays and drop anything malformed so the card
 * always renders *something* rather than throwing inside the permission gate.
 * Exported for unit testing.
 */
export function parseAskUserQuestions(input: Record<string, unknown>): AskUserQuestionView[] {
  const rawQuestions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(rawQuestions)) return [];
  const out: AskUserQuestionView[] = [];
  for (const q of rawQuestions) {
    if (!q || typeof q !== 'object') continue;
    const o = q as Record<string, unknown>;
    const question = typeof o.question === 'string' ? o.question : '';
    const header = typeof o.header === 'string' ? o.header : '';
    const multiSelect = o.multiSelect === true;
    const options: AskUserQuestionOption[] = [];
    if (Array.isArray(o.options)) {
      for (const op of o.options) {
        if (!op || typeof op !== 'object') continue;
        const oo = op as Record<string, unknown>;
        const label = typeof oo.label === 'string' ? oo.label : '';
        if (!label) continue;
        const description = typeof oo.description === 'string' ? oo.description : undefined;
        options.push(description !== undefined ? { label, description } : { label });
      }
    }
    out.push({ question, header, options, multiSelect });
  }
  return out;
}
