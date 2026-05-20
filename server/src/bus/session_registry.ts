/**
 * Process-level registry of LIVE in-process multi-agent sessions.
 *
 * The tmux bus kept agent state OUTSIDE Cebab (tmux survived restarts), so
 * resume rebuilt a router by reading tmux. The pure-SDK bus keeps agent state
 * IN this process (the `AgentRunner` + router closures). So:
 *
 *   - browser close / refresh / second window  → the session must survive,
 *     and a reconnect re-attaches by swapping the WS sink (`rebind`). No
 *     respawn, no DB rebuild — the live objects are right here.
 *   - Cebab server restart                      → this map is empty (process
 *     died). Nothing to re-attach to here. An *orchestrated* run is then
 *     rebuilt from persisted state by `reconstruct.ts` and re-registered
 *     READ-ONLY (R-B); a chain run (reconstruction deferred) is marked
 *     `crashed` (the old R-A behavior). Single-agent resume is a different
 *     path and is unaffected either way.
 *
 * This is the in-process analogue of `tmux has-session`.
 */
import type { BusEvent } from './runner.js';
import type { MultiAgentEndedReason } from './runtime.js';
import type { MultiAgentLifecycle, MutationRecord } from '../repo/multi_agent.js';
import type { PendingRetryDescriptor } from '@cebab/shared/protocol';

/** The WS-facing sink. Swapped on reconnect, silenced on detach. Identical
 *  shape to the old `StartChainOpts.onEvent/onEnded` so the WS layer and the
 *  resume dispatcher need no signature changes.
 *
 *  Optional callbacks (`onPendingRetry`, `onMutation`, `onPendingMutation`)
 *  let test sinks and pre-feature callers stay slim — the routers always
 *  null-check before invoking. */
export type BusSink = {
  onEvent: (sessionId: string, ev: BusEvent, dbEventId: number) => void;
  onEnded: (sessionId: string, reason: MultiAgentEndedReason, iterationId: string | null) => void;
  onPendingRetry?: (sessionId: string, pending: PendingRetryDescriptor | null) => void;
  /** Item #5: a new mutation row appended to `multi_agent_mutations`. Live
   *  forwarding for the Session-info disclosure + activity-bar counter. */
  onMutation?: (sessionId: string, mutation: MutationRecord) => void;
  /** Item #5: pause-on-first-mutation slot set (with the offending row) or
   *  cleared (`pending: null`). Mirrors `onPendingRetry`'s shape. */
  onPendingMutation?: (sessionId: string, pending: MutationRecord | null) => void;
};

/** A sink that drops everything — installed by `detach()` so a still-running
 *  session keeps persisting/routing but stops forwarding to a dead WS. */
export const NOOP_SINK: BusSink = {
  onEvent: () => {},
  onEnded: () => {},
  onPendingRetry: () => {},
  onMutation: () => {},
  onPendingMutation: () => {},
};

/**
 * The handle surface both Chain and Orchestrator handles satisfy. Stored in
 * the registry so a reconnect returns the ORIGINAL authoritative handle
 * (real `stop`/`detach`, real `iterationId`) with only its WS sink swapped.
 * Declared here (not imported from chain/orchestrator) to avoid a type cycle.
 */
export type BusSessionHandle = {
  sessionId: string;
  iterationId: string;
  participantAgentNames: string[];
  lifecycle: MultiAgentLifecycle;
  sessionFolder: string;
  stop: (reason: MultiAgentEndedReason) => Promise<void>;
  detach: () => void;
  /**
   * Re-deliver the captured prompt of the worker named in this session's
   * persisted pending-retry slot. No-op when the slot is empty (idempotent
   * — a racing second click sees the cleared slot). Implemented by both
   * chain and orchestrator handles via the shared `setPendingRetry(null)
   * → deliver` flow; the slot is cleared FIRST so a re-fail can re-assert
   * a fresh descriptor.
   */
  retry: () => Promise<void>;
  /**
   * Item #5: operator clicked Continue on the pause-on-first-mutation
   * banner. Clears the pending-mutation slot, sets
   * `mutations_acknowledged=1`, clears `awaiting_continue`, and re-delivers
   * the paused worker's last captured prompt. Subsequent mutations in this
   * session auto-allow. No-op when no pause is active (idempotent).
   */
  continueThroughMutation: () => Promise<void>;
};

export type LiveBusSession = {
  sessionId: string;
  mode: 'chain' | 'orchestrator';
  handle: BusSessionHandle;
  /** Swap the live WS sink (reconnect) or silence it (detach). */
  rebind: (sink: BusSink) => void;
};

const live = new Map<string, LiveBusSession>();

export function registerLiveSession(s: LiveBusSession): void {
  live.set(s.sessionId, s);
}

export function getLiveSession(sessionId: string): LiveBusSession | undefined {
  return live.get(sessionId);
}

export function unregisterLiveSession(sessionId: string): void {
  live.delete(sessionId);
}

export function hasLiveSession(sessionId: string): boolean {
  return live.has(sessionId);
}
