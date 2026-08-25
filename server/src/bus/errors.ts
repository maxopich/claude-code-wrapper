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

/**
 * `Cebab-vie.17`. Thrown by the runner when a hop ends with the SDK's
 * `error_max_turns` result subtype — i.e. the per-hop turn cap Cebab now passes
 * (`AgentRunnerDeps.maxTurns`) stopped the agent mid-task.
 *
 * The other three non-success subtypes stay a plain `Error`, and the line is not
 * arbitrary: **a sentinel exists iff Cebab itself made the decision that stopped
 * the turn.** The pause gate, the fail-closed ledger, the stall watchdog and now
 * the cap are all Cebab saying no. `error_during_execution` is the remote saying
 * no, and its literal message is what `isTransientOverload` matches on, so a
 * class for it would darken the whole overload-absorption layer.
 *
 * The message is what the routers' `onWorkerFailed` renders verbatim into the
 * operator's `cebab → user kind=error` row, so it has to be honest about two
 * things at once: the turn was cut off mid-task, and nothing was lost — the
 * runner writes the hop's `--resume` checkpoint immediately BEFORE this throw
 * (see the `m.session_id` capture in `runOneAttempt`), so Retry genuinely
 * continues from where it stopped rather than restarting the hop.
 *
 * It interpolates NO agent-controlled bytes. That is not what makes it safe —
 * `isBusControlSignal` below is — but it means there is no second surface to
 * reason about, and the message stays a pure function of two integers.
 */
export class MaxTurnsReachedError extends Error {
  readonly __maxTurnsReached = true as const;
  readonly agentName: string;
  /** The cap that was in force for this hop. */
  readonly maxTurns: number;
  /**
   * SDK `result.num_turns` — how many model turns actually ran. Measured
   * live: this comes back ONE HIGHER than the cap (3 against a cap of 2), so
   * the wording says "cap of N (M ran)" rather than "M/N", which reads as a
   * broken fraction.
   */
  readonly numTurns: number;
  constructor(agentName: string, maxTurns: number, numTurns: number) {
    super(
      `reached the per-hop turn cap of ${maxTurns} model turns (${numTurns} ran) and stopped ` +
        `mid-task. ` +
        `Nothing was lost: this hop's checkpoint was written first, so Retry resumes the agent ` +
        `from exactly where it stopped. If it needs more room, raise "Default max turns" in ` +
        `Settings before retrying; if it is looping, Abandon instead.`,
    );
    this.name = 'MaxTurnsReachedError';
    this.agentName = agentName;
    this.maxTurns = maxTurns;
    this.numTurns = numTurns;
    Object.setPrototypeOf(this, MaxTurnsReachedError.prototype);
  }
}

export function isMaxTurnsReached(err: unknown): err is MaxTurnsReachedError {
  return err instanceof MaxTurnsReachedError;
}

/**
 * `Cebab-vie.11` / `Cebab-vie.1` [security]. Thrown by `AgentRunner.deliverTurn`
 * when the dequeue-time re-check refuses a turn that was already queued — today
 * that means the agent was kicked while its delivery sat behind another turn.
 *
 * The queue is the whole reason this class exists. Every other kick check runs
 * when a delivery is CREATED: the router drops events addressed to a kicked
 * agent, and `checkTurnRefused` gates the two operator replay seams. None of
 * them can see a delivery that passed those checks and then waited — and a
 * worker's turns are serialized, so waiting is the normal case, not the corner.
 * A kick landing during that wait used to start a brand-new tool-capable turn.
 *
 * It is a rejection rather than a quiet resolve because the two are not the
 * same statement. Resolving would run the routers' `.then`, i.e.
 * `onTurnSucceeded`, which clears the agent's pending-retry slot — recording a
 * success for a turn that never happened. The routers' `.catch` recognises this
 * class and returns without taking the worker-failed path either: a refusal is
 * not a failure, and parking a retry slot for a kicked agent would re-render
 * the Retry banner the kick was supposed to take away.
 *
 * The operator has ALREADY been told when this throws. `canStartTurn` writes
 * the `cebab → user kind=error` row as it refuses — the same contract
 * `checkTurnRefused` carries ("a non-null answer means the operator has already
 * been told"), so the catch stays silent instead of emitting a second row.
 *
 * The message is never rendered; it exists for logs. The operator-facing
 * sentence lives once, in `turnRefusalText` (`bus/turn_guard.ts`).
 */
export class TurnRefusedError extends Error {
  readonly __turnRefused = true as const;
  readonly agentName: string;
  constructor(agentName: string) {
    super(
      `queued turn for ${JSON.stringify(agentName)} refused at dequeue: the agent is no longer ` +
        `eligible to start a turn (kicked). Nothing was run.`,
    );
    this.name = 'TurnRefusedError';
    this.agentName = agentName;
    Object.setPrototypeOf(this, TurnRefusedError.prototype);
  }
}

export function isTurnRefused(err: unknown): err is TurnRefusedError {
  return err instanceof TurnRefusedError;
}

/**
 * `Cebab-vie.14` [security]: the classes above are Cebab's own control-flow
 * signals, not remote failures — whatever their text says.
 *
 * That distinction used to be carried by the text alone, and the text is partly
 * the worker's. `PausedForMutationError`'s message is ``paused before
 * ${row.summary}``, and for a `Bash` call the summary is the command plus the
 * model-written `description` verbatim. The runner's retry filter,
 * `isTransientOverload`, is three `String.includes` checks on `err.message`, so
 * a worker that put `Overloaded` anywhere in either half made its own pause
 * look like an API 5xx: the turn was retried, the replayed turn re-issued the
 * command, and `decidePauseForMutation` waved it through because that agent was
 * already halted. `rm -rf /important` with the description `retry after
 * Overloaded` was enough.
 *
 * So the category gets a name and a predicate, and the retry filter asks THIS
 * before it looks at any string. `TurnStalledError` is in the list for the same
 * reason even though nothing has exploited it: its message embeds the agent
 * name, so a participant whose project is called `Overloaded` would have been
 * the same bug wearing a different hat — immune by accident of text is not
 * immune.
 *
 * `MaxTurnsReachedError` (`Cebab-vie.17`) is the fourth, and it is here for the
 * category rather than for an exploit: a cap Cebab chose is Cebab stopping the
 * turn, so retrying it means three more full-length attempts against the same
 * wall — an unbounded retry loop wrapped around the bound that was just added.
 *
 * `TurnRefusedError` (`Cebab-vie.11`) is the fifth, and the rule picks it out
 * without needing a judgement call: a queued turn refused at dequeue is Cebab
 * declining to start it, so a retry would be Cebab arguing with itself.
 *
 * A SIXTH belongs here too. Adding one and forgetting this line is how the hole
 * comes back — which is why `errors.control_signal_registry.test.ts` now derives
 * the membership from this file instead of trusting this sentence.
 */
export function isBusControlSignal(err: unknown): boolean {
  return (
    isPausedForMutation(err) ||
    isMutationNotRecorded(err) ||
    isTurnStalled(err) ||
    isMaxTurnsReached(err) ||
    isTurnRefused(err)
  );
}
