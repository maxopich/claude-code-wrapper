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
import { classifyToolCall } from '@cebab/shared';
import { pickRunner, type MockOptions, type RunOptions, type Runner } from '../runner/index.js';
import type { SettingSource } from '../runner/claude.js';
import { registerQuery } from '../runner/lifecycle.js';
import { isValidBusRecipient } from './paths.js';
import { classifyMutationScope } from './guardrail.js';

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
 * `RunOptions.mcpServers` keyed `cebab_bus` → the agent sees
 * `mcp__cebab_bus__bus_send`. The key is deliberately namespaced (not `bus`)
 * so a project's own `.claude/settings*.json` defining `mcpServers.bus`
 * cannot collide with — or worse, clobber — this identity-pinned injection
 * once `settingSources` widens to `['user', 'project', 'local']` for
 * workers/chain participants.
 *
 * `serverName` parameterizes the MCP server's metadata `name:` so the helper
 * can build TWO instances at runtime — one for the canonical `cebab_bus` key
 * and one for the deprecation-shim `bus` key (see `runOneAttempt`). Defaults
 * to `'cebab_bus'` so existing callers stay unchanged.
 */
export function makeBusToolServer(
  agentName: string,
  onEvent: (ev: BusEvent) => void,
  serverName = 'cebab_bus',
) {
  return createSdkMcpServer({
    name: serverName,
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
   * Item #5: called for every classified non-`read` `tool_use` block observed
   * on an `assistant` SDKMessage, BEFORE the SDK dispatches the tool. Hooks:
   *   - persists a row into `multi_agent_mutations`,
   *   - emits a `multi_agent_mutation` ServerMsg via `sink.onMutation`,
   *   - when `pause_on_mutation=1` AND `mutations_acknowledged=0`, persists
   *     a pending-mutation slot, emits `multi_agent_pending_mutation`, and
   *     throws `PausedForMutationError` to abort the turn (best-effort —
   *     see the race-window risk in the plan).
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
    meta: { isError: boolean },
  ) => Promise<void> | void;
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
  /**
   * Cluster C Phase 4c (spec §5.2 + AE-4 + AE-5): per-agent pause gate.
   * `pause(name)` overwrites `turnTails.get(name)` with a never-resolving
   * promise so the NEXT `deliverTurn` chains off it and parks until
   * `resume(name)` flips the gate. The IN-FLIGHT turn (whose runOneTurn
   * promise was already in progress when pause arrived) is unaffected —
   * it completes naturally per the spec's "current in-flight turn NOT
   * cancelled" guarantee.
   *
   * Resume calls `release()` to fulfill the gate promise; queued
   * deliverTurn calls then proceed in FIFO order, each waiting for the
   * one before it to finish (the chained `turnTails.set` pattern that
   * predates pause already gives us that). Re-pause / re-resume return
   * false without state change — caller (WS handler) surfaces as
   * `already_in_state`.
   */
  private readonly pauseGates = new Map<
    string,
    { promise: Promise<void>; release: () => void }
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
      return Promise.reject(new Error(`deliverTurn: unknown agent ${JSON.stringify(agentName)}`));
    }
    // Cluster C Phase 4c: bump the queue counter on entry, decrement just
    // before runOneTurn fires. The window between bump + decrement is
    // exactly "queued but not running" — which matches the operator's
    // "stuck behind this agent" mental model for AE-5's queuedDeliveries.
    this.pendingDeliveries.set(
      agentName,
      (this.pendingDeliveries.get(agentName) ?? 0) + 1,
    );
    const tail = this.turnTails.get(agentName) ?? Promise.resolve();
    const result = tail.then(() => {
      this.pendingDeliveries.set(
        agentName,
        Math.max(0, (this.pendingDeliveries.get(agentName) ?? 1) - 1),
      );
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
   * Cluster C Phase 4c: install a never-resolving gate at the head of
   * `agentName`'s turn queue. Returns true if a fresh gate was installed,
   * false if the agent was already paused (idempotent re-pause is a no-op
   * so the WS handler can surface `already_in_state`).
   *
   * Semantics:
   *   - In-flight turn (the one whose `runOneTurn` is already executing
   *     when pause arrives) is NOT cancelled. The spec's §5.2 model is
   *     "current in-flight finishes; inbound queues" — `pause` here only
   *     installs the gate for the NEXT delivery onward.
   *   - The gate is composed via `tail.then(() => gatePromise)` so it
   *     waits for any currently-pending tail before the gate itself
   *     takes effect. That preserves the runner's serialization
   *     invariant (no two `--resume` subprocesses for the same agent at
   *     once).
   *   - `resume(agentName)` resolves the gate and clears the map entry,
   *     unblocking every queued delivery in FIFO order. The
   *     `turnTails`-chain pattern guarantees order.
   *
   * Caller responsibility: the WS handler MUST persist the pause to
   * `multi_agent_participants.paused_until` BEFORE calling
   * `runner.pause()`. The DB is the durable source-of-truth; this
   * in-memory gate is the hot-path mirror. Without that order, a
   * server-restart between the two would lose the operator's intent.
   */
  pause(agentName: string): boolean {
    if (!this.specs.has(agentName)) return false;
    if (this.pauseGates.has(agentName)) return false;
    let release!: () => void;
    const promise = new Promise<void>((res) => {
      release = res;
    });
    this.pauseGates.set(agentName, { promise, release });
    const prevTail = this.turnTails.get(agentName) ?? Promise.resolve();
    // Chain the gate AFTER the existing tail so the in-flight turn (if
    // any) completes first, then the gate parks subsequent calls.
    this.turnTails.set(
      agentName,
      prevTail.then(() => promise),
    );
    return true;
  }

  /**
   * Cluster C Phase 4c: release the pause gate for `agentName`. Returns
   * true iff a gate was actually cleared (`false` on re-resume / not-
   * paused). The release is synchronous from the gate's POV: queued
   * `deliverTurn` calls' `.then()` fire in the next microtask.
   */
  resume(agentName: string): boolean {
    const gate = this.pauseGates.get(agentName);
    if (!gate) return false;
    this.pauseGates.delete(agentName);
    gate.release();
    return true;
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

  /** Test-only probe: is the gate currently installed? */
  isPaused(agentName: string): boolean {
    return this.pauseGates.has(agentName);
  }

  private async runOneTurn(agentName: string, promptText: string): Promise<void> {
    const spec = this.specs.get(agentName);
    if (!spec) throw new Error(`deliverTurn: unknown agent ${JSON.stringify(agentName)}`);

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
    const backoffMs = this.deps.overloadBackoffMs ?? DEFAULT_OVERLOAD_BACKOFF_MS;
    const maxAttempts = backoffMs.length + 1;
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await this.runOneAttempt(agentName, promptText, spec);
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
        // non-transient error.
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

  private async runOneAttempt(
    agentName: string,
    promptText: string,
    spec: AgentSpec,
  ): Promise<void> {
    const factory = this.deps.runnerFactory ?? pickRunner;
    // Read INSIDE the serialized turn (not when `deliverTurn` was called) so
    // this resumes the checkpoint the previous queued turn just wrote, AND so
    // a transient-overload retry picks up the latest checkpoint written by the
    // failed attempt's pre-throw `m.session_id` capture.
    const prior = this.sessions.get(agentName);

    const runner = factory({
      cwd: spec.cwd,
      prompt: promptText,
      ...(prior ? { resume: prior } : {}),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: spec.settingSources ?? ['user'],
      mcpServers: {
        cebab_bus: makeBusToolServer(agentName, this.deps.onEvent),
        // Deprecation shim for the `bus` → `cebab_bus` MCP-server rename
        // (e04769e). A resumed CLI session whose JSONL history contains
        // `mcp__bus__bus_send` calls will keep calling that name by reflex;
        // without this alias the SDK returns "No such tool available" and the
        // agent falls back to plain assistant text — which the bus router
        // discards (only `bus_send` tool calls forward). Identity-pinning is
        // preserved: each registration captures `agentName` in its own
        // closure, so neither alias can be used to spoof a `source`. Remove
        // after one release once no in-flight resumed sessions reference the
        // old name.
        bus: makeBusToolServer(agentName, this.deps.onEvent, 'bus'),
      },
      abortController: this.deps.abortController,
    });

    const unregister = registerQuery(runner);
    try {
      for await (const msg of runner) {
        this.deps.onMessage?.(agentName, msg);

        // Item #5 mutation tap: every `tool_use` block on an `assistant`
        // SDKMessage represents a tool the SDK is about to dispatch.
        // Classify each; for non-`read` calls, fire `onMutation` BEFORE the
        // SDK runs the tool. The hook can throw `PausedForMutationError` to
        // abort the turn (pause-on-first-mutation gate). The cwd-side race
        // window — SDK may dispatch the tool before the throw lands — is
        // documented as a best-effort caveat in the plan.
        if (this.deps.onMutation) {
          const am = msg as {
            type?: string;
            message?: {
              content?: Array<{ type?: string; name?: string; id?: string; input?: unknown }>;
            };
          };
          if (am.type === 'assistant' && Array.isArray(am.message?.content)) {
            for (const block of am.message.content) {
              if (block?.type !== 'tool_use') continue;
              const toolName = typeof block.name === 'string' ? block.name : '';
              if (!toolName) continue;
              const cls = classifyToolCall(toolName, block.input);
              if (cls.category === 'read') continue;
              const toolUseId = typeof block.id === 'string' ? block.id : undefined;
              // Cluster F Phase D5+: classify path scope vs agent cwd. The
              // consultant-mode prompt forbids out-of-scope mutations; this
              // surfaces violations post-hoc (workers run with
              // bypassPermissions, so we can't deny at the SDK gate). The
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
                ...(cls.filePath !== undefined ? { filePath: cls.filePath } : {}),
                ...(toolUseId !== undefined ? { toolUseId } : {}),
                ...(guardrailViolation ? { guardrailViolation } : {}),
              });
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
              content?: Array<{ type?: string; tool_use_id?: string; is_error?: boolean }>;
            };
          };
          if (um.type === 'user' && Array.isArray(um.message?.content)) {
            for (const block of um.message.content) {
              if (block?.type !== 'tool_result') continue;
              if (typeof block.tool_use_id !== 'string') continue;
              try {
                await this.deps.onToolResult(agentName, block.tool_use_id, {
                  isError: block.is_error === true,
                });
              } catch (err) {
                console.error(`[runner] onToolResult(${agentName}) failed`, err);
              }
            }
          }
        }

        const m = msg as { type?: string; session_id?: string; subtype?: string };
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
            throw new Error(`SDK result subtype=${m.subtype}`);
          }
        }
      }
    } finally {
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
 * Permissive matching: a false positive retries a non-transient error
 * `MAX_RETRIES` times before giving up (annoying log noise, no correctness
 * impact). False negatives surface immediately as before.
 *
 * Exported for unit tests.
 */
export function isTransientOverload(err: unknown): boolean {
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
