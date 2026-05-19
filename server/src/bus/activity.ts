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
  lastActivityTs: number;
  turnStartedAt: number;
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
  timer: ReturnType<typeof setTimeout> | null;
  lastEmittedPhase: AgentActivityPhase;
  lastEmittedTool: string | undefined;
  lastEmittedAt: number;
};

/**
 * Derive the tool the agent is currently in, mirroring web `pendingToolName`
 * / ws `translate` exactly: only an `assistant` SDKMessage carries content
 * blocks; a trailing `tool_use` block's `name` is the running tool, a
 * trailing text/thinking block means "reasoning, no tool". Every other
 * SDKMessage member (`stream_event`, `result`, `system`, `user`, …) is a
 * liveness tick that does not change the tool — so carry `prev` forward.
 * Defensive optional-chaining: the SDKMessage union has ~30 members, most
 * without a `message`.
 */
function toolFromMessage(msg: SDKMessage, prev: string | undefined): string | undefined {
  const any = msg as {
    type?: string;
    message?: { content?: Array<{ type?: string; name?: string }> };
  };
  if (any.type !== 'assistant') return prev;
  const blocks = any.message?.content;
  if (!Array.isArray(blocks) || blocks.length === 0) return prev;
  const last = blocks[blocks.length - 1];
  return last?.type === 'tool_use' ? last.name : undefined;
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
    slot.lastEmittedAt = Date.now();
    emit({
      agentName,
      phase,
      currentTool: slot.tool,
      lastActivityTs: slot.lastTs,
      turnStartedAt: slot.startedAt,
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
        timer: null,
        lastEmittedPhase: 'idle',
        lastEmittedTool: undefined,
        lastEmittedAt: 0,
      };
      slots.set(agentName, slot);
    }
    slot.lastTs = now;
    slot.tool = toolFromMessage(msg, slot.tool);
    armStall(agentName, slot);

    // Debounce: emit only on a state edge (was not `working`, or the tool
    // changed) or once the throttle window has elapsed. Without this the
    // per-token `stream_event` stream would emit hundreds of identical
    // ticks per turn.
    const phaseEdge = slot.lastEmittedPhase !== 'working';
    const toolEdge = slot.lastEmittedTool !== slot.tool;
    const throttled = now - slot.lastEmittedAt >= EMIT_THROTTLE_MS;
    if (phaseEdge || toolEdge || throttled) {
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
      lastActivityTs: slot.lastTs,
      turnStartedAt: slot.startedAt,
    });
  };

  const dispose = () => {
    for (const slot of slots.values()) clearTimer(slot);
    slots.clear();
  };

  return { onMessage, onTurnEnd, dispose };
}
