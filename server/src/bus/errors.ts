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
