/**
 * Ephemeral per-turn liveness observer for bus participants.
 *
 * Cebab-owned, server-side, and entirely passive: it taps the existing
 * per-turn SDKMessage stream (the same `onMessage` the routers already use
 * for transcript writing) and turns it into a coarse "is this agent working
 * or hung?" signal. It changes NOTHING agent-side — no prompt, no tool, no
 * `bus_send`, no DB write. The durable record of who-did-what is the
 * persisted `multi_agent_event` hop timeline; this is only the live pulse
 * between hops, so a 4-minute worker turn is distinguishable from a hung one.
 *
 * Lifecycle, per agent (bus turns are serialized — one slot per agent):
 *   - first SDKMessage of a turn → `working` (+ derived `currentTool`),
 *     arm a stall timer;
 *   - each subsequent message → refresh, re-arm; emit is debounced so the
 *     per-token `stream_event` flood doesn't saturate the socket;
 *   - no message for `stallMs` → `stalled` (do not re-arm);
 *   - `onTurnEnd` → `idle`, slot cleared.
 *
 * Timers are `unref`'d so a liveness pulse never holds the process open;
 * `dispose()` clears everything on session teardown.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { classifyToolCall } from '@cebab/shared';
import type { AgentActivityPhase } from '@cebab/shared/protocol';

/** Default stall window. 25s + sub-second emit latency lands a stall label
 *  "within ~30s", the operator-facing target. */
export const DEFAULT_STALL_MS = 25_000;

/** Minimum gap between two `working` emits for the same unchanged
 *  (phase, tool) — throttles the per-token `stream_event` stream. */
const EMIT_THROTTLE_MS = 1_000;

export type ActivitySnapshot = {
  agentName: string;
  phase: AgentActivityPhase;
  currentTool?: string;
  /** `Cebab-ygu.48`: the operator-readable one-line summary `classifyToolCall`
   *  computes for the trailing `tool_use` block's (name, input) — e.g.
   *  `read src/module_07.js` or `grep "refundCharge" in src`. This is the
   *  "what is it working on" line: it distinguishes a 15-file Read loop tick by
   *  tick where `currentTool` (`Read`) stays constant. Undefined when the agent
   *  is reasoning with no tool in flight, or (with the tool name) on `idle`. */
  currentSummary?: string;
  lastActivityTs: number;
  turnStartedAt: number;
  /** `Cebab-ut7`: the SDK-reported model id for this turn, read from the
   *  `system/init` that opens the per-hop `query()` and carried forward on
   *  every later tick. Undefined until that init arrives. */
  model?: string;
};

export type ActivityEmit = (snap: ActivitySnapshot) => void;

export type AgentActivityObserver = {
  /** Feed every streamed SDKMessage here (wrap the router's `onMessage`). */
  onMessage: (agentName: string, msg: SDKMessage) => void;
  /** Call when `deliverTurn` settles (resolve OR reject) for this agent. */
  onTurnEnd: (agentName: string) => void;
  /** Clear all pending timers + slots (call on session teardown). */
  dispose: () => void;
};

type Slot = {
  startedAt: number;
  lastTs: number;
  tool: string | undefined;
  summary: string | undefined;
  model: string | undefined;
  timer: ReturnType<typeof setTimeout> | null;
  lastEmittedPhase: AgentActivityPhase;
  lastEmittedTool: string | undefined;
  lastEmittedSummary: string | undefined;
  lastEmittedAt: number;
};

/**
 * Derive what the agent is currently doing, mirroring web `pendingToolName`
 * / ws `translate` exactly: only an `assistant` SDKMessage carries content
 * blocks; a trailing `tool_use` block is the running tool, a trailing
 * text/thinking block means "reasoning, no tool". Every other SDKMessage
 * member (`stream_event`, `result`, `system`, `user`, …) is a liveness tick
 * that does not change the tool — so carry `prev` forward. Defensive
 * optional-chaining: the SDKMessage union has ~30 members, most without a
 * `message`.
 *
 * `Cebab-ygu.48`: alongside the tool NAME, derive the operator-readable
 * `summary` `classifyToolCall` already computes from the same (name, input)
 * the block carries — the runner throws it away for `read`-class calls, but it
 * is exactly the "what is it working on" line. Computed here (not at emit) so
 * it tracks the trailing block; `tool` and `summary` always move together.
 */
type ToolInfo = { tool: string | undefined; summary: string | undefined };

function toolInfoFromMessage(msg: SDKMessage, prev: ToolInfo): ToolInfo {
  const any = msg as {
    type?: string;
    message?: { content?: Array<{ type?: string; name?: string; input?: unknown }> };
  };
  if (any.type !== 'assistant') return prev;
  const blocks = any.message?.content;
  if (!Array.isArray(blocks) || blocks.length === 0) return prev;
  const last = blocks[blocks.length - 1];
  if (last?.type === 'tool_use' && typeof last.name === 'string') {
    return { tool: last.name, summary: classifyToolCall(last.name, last.input).summary };
  }
  // Trailing text/thinking (or a malformed tool_use) → reasoning, no tool.
  return { tool: undefined, summary: undefined };
}

/**
 * `Cebab-ut7`: extract the SDK-reported model id from a `system/init`
 * SDKMessage. Only that member carries it (the same field `translate()`
 * reads to build a single-agent `session_started`); every other member is a
 * liveness tick that leaves the model unchanged, so carry `prev` forward.
 * A non-string / empty model is treated as "not yet known" so a malformed
 * init can never overwrite a real value with a blank.
 */
function modelFromMessage(msg: SDKMessage, prev: string | undefined): string | undefined {
  const any = msg as { type?: string; subtype?: string; model?: unknown };
  if (any.type !== 'system' || any.subtype !== 'init') return prev;
  return typeof any.model === 'string' && any.model.length > 0 ? any.model : prev;
}

export function createAgentActivityObserver(
  emit: ActivityEmit,
  stallMs: number = DEFAULT_STALL_MS,
): AgentActivityObserver {
  const slots = new Map<string, Slot>();

  const clearTimer = (slot: Slot) => {
    if (slot.timer) {
      clearTimeout(slot.timer);
      slot.timer = null;
    }
  };

  const fire = (agentName: string, slot: Slot, phase: AgentActivityPhase) => {
    slot.lastEmittedPhase = phase;
    slot.lastEmittedTool = slot.tool;
    slot.lastEmittedSummary = slot.summary;
    slot.lastEmittedAt = Date.now();
    emit({
      agentName,
      phase,
      currentTool: slot.tool,
      currentSummary: slot.summary,
      lastActivityTs: slot.lastTs,
      turnStartedAt: slot.startedAt,
      model: slot.model,
    });
  };

  const armStall = (agentName: string, slot: Slot) => {
    clearTimer(slot);
    const t = setTimeout(() => {
      slot.timer = null;
      // Open turn, no SDKMessage for stallMs → hung vs. just slow. Do not
      // re-arm: one stall edge per silent gap; a later message re-arms and
      // re-emits `working` (recovery).
      fire(agentName, slot, 'stalled');
    }, stallMs);
    // Never hold the event loop open for a liveness pulse. Optional-chained
    // so fake-timer shims (vitest) that omit `unref` don't throw in tests.
    t.unref?.();
    slot.timer = t;
  };

  const onMessage = (agentName: string, msg: SDKMessage) => {
    const now = Date.now();
    let slot = slots.get(agentName);
    if (!slot) {
      slot = {
        startedAt: now,
        lastTs: now,
        tool: undefined,
        summary: undefined,
        model: undefined,
        timer: null,
        lastEmittedPhase: 'idle',
        lastEmittedTool: undefined,
        lastEmittedSummary: undefined,
        lastEmittedAt: 0,
      };
      slots.set(agentName, slot);
    }
    slot.lastTs = now;
    const info = toolInfoFromMessage(msg, { tool: slot.tool, summary: slot.summary });
    slot.tool = info.tool;
    slot.summary = info.summary;
    slot.model = modelFromMessage(msg, slot.model);
    armStall(agentName, slot);

    // Debounce: emit only on a state edge (was not `working`, the tool changed,
    // or the summary changed) or once the throttle window has elapsed. Without
    // this the per-token `stream_event` stream would emit hundreds of identical
    // ticks per turn. `summaryEdge` is what surfaces a same-tool progress step
    // promptly — a 15-file Read loop keeps `currentTool: 'Read'` throughout, so
    // without it each new file would wait out the throttle window.
    const phaseEdge = slot.lastEmittedPhase !== 'working';
    const toolEdge = slot.lastEmittedTool !== slot.tool;
    const summaryEdge = slot.lastEmittedSummary !== slot.summary;
    const throttled = now - slot.lastEmittedAt >= EMIT_THROTTLE_MS;
    if (phaseEdge || toolEdge || summaryEdge || throttled) {
      fire(agentName, slot, 'working');
    }
  };

  const onTurnEnd = (agentName: string) => {
    const slot = slots.get(agentName);
    if (!slot) return; // a turn that produced no messages — nothing to clear
    clearTimer(slot);
    slots.delete(agentName);
    emit({
      agentName,
      phase: 'idle',
      currentTool: undefined,
      currentSummary: undefined,
      lastActivityTs: slot.lastTs,
      turnStartedAt: slot.startedAt,
      model: slot.model,
    });
  };

  const dispose = () => {
    for (const slot of slots.values()) clearTimer(slot);
    slots.clear();
  };

  return { onMessage, onTurnEnd, dispose };
}
