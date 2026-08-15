/**
 * Sentinel errors thrown by the bus runtime to coordinate cross-layer
 * behaviour without leaking them as crash signals.
 */

/**
 * Thrown by the runner's `onMutation` hook when the pause-on-dangerous
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

/**
 * Cebab-aqd. Thrown by a router's mutation tap when persisting a `dangerous`
 * mutation failed while the pause-on-dangerous gate was armed.
 *
 * The tap used to log such a failure and `return` — and that `return` is
 * upstream of `applyPauseGate`, so a failed INSERT silently disarmed the
 * operator's only mechanical brake and the command ran. Failing closed means
 * throwing, and the class matters as much as the throw: this deliberately is
 * NOT a `PausedForMutationError`, because the routers' `deliver().catch`
 * recognises that class and returns quietly. A pause is quiet because the row
 * and the banner are already persisted; here neither exists, so quiet would
 * strand the agent with nothing for the operator to act on.
 *
 * Falling through to `onWorkerFailed` instead reuses the recovery that already
 * exists: a pending-retry slot, a `cebab → user kind=error` event, and the
 * Retry / Abandon controls, with the session left `running`.
 */
export class MutationNotRecordedError extends Error {
  readonly __mutationNotRecorded = true as const;
  readonly toolName: string;
  constructor(toolName: string, summary: string) {
    super(
      `halted before ${summary}: the pause-on-dangerous gate is armed but this ${toolName} call ` +
        `could not be recorded, so it could not be put in front of you. Nothing was run.`,
    );
    this.name = 'MutationNotRecordedError';
    this.toolName = toolName;
    Object.setPrototypeOf(this, MutationNotRecordedError.prototype);
  }
}

export function isMutationNotRecorded(err: unknown): err is MutationNotRecordedError {
  return err instanceof MutationNotRecordedError;
}
