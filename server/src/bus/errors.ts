/**
 * Sentinel errors thrown by the bus runtime to coordinate cross-layer
 * behaviour without leaking them as crash signals.
 */

/**
 * Thrown by the runner's `onMutation` hook when the pause-on-first-mutation
 * gate fires. The router's `deliver()` `.catch` recognises this class and
 * does NOT take the worker-failed path: this is a controlled pause, not a
 * crash. The pause state (DB row + wire) is persisted before the throw, so
 * the operator sees the banner without any further action by the catch.
 */
export class PausedForMutationError extends Error {
  readonly __pausedForMutation = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'PausedForMutationError';
    Object.setPrototypeOf(this, PausedForMutationError.prototype);
  }
}

export function isPausedForMutation(err: unknown): err is PausedForMutationError {
  return err instanceof PausedForMutationError;
}

/**
 * Thrown by the runner's stalled-turn watchdog when a turn produces no
 * SDKMessage for the hard threshold (and no tool is mid-flight). The runner
 * aborts the in-flight `Query` and throws this so the routers' `deliver()`
 * `.catch` recovers via the normal worker-failed / pending-retry path
 * (operator re-issue) instead of the turn hanging silently until a server
 * restart. It is NOT a transient overload, so `runOneTurn` rethrows it
 * immediately (no backoff retries).
 */
export class TurnStalledError extends Error {
  readonly __turnStalled = true as const;
  readonly agentName: string;
  /** Observed idle duration (ms with no SDKMessage) that tripped the abort. */
  readonly stallMs: number;
  constructor(agentName: string, stallMs: number) {
    super(
      `turn for ${JSON.stringify(agentName)} auto-aborted after ${stallMs}ms with no activity (stalled)`,
    );
    this.name = 'TurnStalledError';
    this.agentName = agentName;
    this.stallMs = stallMs;
    Object.setPrototypeOf(this, TurnStalledError.prototype);
  }
}

export function isTurnStalled(err: unknown): err is TurnStalledError {
  return err instanceof TurnStalledError;
}
