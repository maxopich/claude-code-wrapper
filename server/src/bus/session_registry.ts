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
 *     died). Nothing to re-attach to → the session is marked `crashed`
 *     (decision R-A: bus runs do not survive a server restart; single-agent
 *     resume is unaffected).
 *
 * This is the in-process analogue of `tmux has-session`.
 */
import type { BusEvent } from './runner.js';
import type { MultiAgentEndedReason } from './runtime.js';
import type { MultiAgentLifecycle } from '../repo/multi_agent.js';

/** The WS-facing sink. Swapped on reconnect, silenced on detach. Identical
 *  shape to the old `StartChainOpts.onEvent/onEnded` so the WS layer and the
 *  resume dispatcher need no signature changes. */
export type BusSink = {
  onEvent: (sessionId: string, ev: BusEvent, dbEventId: number) => void;
  onEnded: (sessionId: string, reason: MultiAgentEndedReason, iterationId: string | null) => void;
};

/** A sink that drops everything — installed by `detach()` so a still-running
 *  session keeps persisting/routing but stops forwarding to a dead WS. */
export const NOOP_SINK: BusSink = {
  onEvent: () => {},
  onEnded: () => {},
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

/** Live sessions, in registration order. */
export function listLiveSessions(): LiveBusSession[] {
  return [...live.values()];
}

export function hasLiveSession(sessionId: string): boolean {
  return live.has(sessionId);
}
