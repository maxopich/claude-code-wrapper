/**
 * Autonomous loop — stage transitions.
 *
 * PURE. `next()` decides where the iteration goes; `loop.mjs` performs the
 * effects. That split is the whole reason this is testable without a repo, a
 * network or a model: every branch below — CI never started, gate red twice,
 * guard breach, halt at each of the eight boundaries — is reachable from a
 * plain object literal.
 *
 * HALT IS CHECKED FIRST, AT EVERY BOUNDARY, and routes straight to DONE with
 * `halted`. It deliberately does NOT run HARVEST: §8.4's usage-limit path
 * specifies that a halted bead has its status restored by the driver's
 * teardown, not by the harvest stage, so a halt that skipped teardown-side
 * bookkeeping would strand the bead `in_progress`. Teardown owns that; this
 * function only says "stop here".
 *
 * WHY A QUEUED MERGE IS ITS OWN DISPOSITION. `gh pr merge --auto` does not
 * merge; its own help says it "automatically merge[s] only after necessary
 * requirements are met". Recording it as MERGED closes the bead on a
 * PREDICTION — and if the queued merge later fails, the bead stays closed with
 * nothing merged, no park, no label and no evidence, while the ledger row says
 * `land.merged: true`. `merge_queued` is neither a success nor a failure: the
 * loop did everything right and the outcome is not knowable yet, so the bead
 * stays claimed with a note and a human finishes it.
 *
 * WHY `guard_withheld` IS NOT A PARK. A park means the loop could not land the
 * bead and a human has to look. A withhold means everything worked and LAND
 * was deliberately not taken — `--merge` absent, or the guard flagged the diff
 * — leaving a green PR open for review. Conflating them would trip the
 * three-strike breaker after three successful no-merge iterations, which is
 * the default configuration.
 */

export const STAGE = Object.freeze({
  SELECT: 'SELECT',
  CLAIM: 'CLAIM',
  BUILD: 'BUILD',
  GATE: 'GATE',
  PUBLISH: 'PUBLISH',
  WATCH: 'WATCH',
  LAND: 'LAND',
  HARVEST: 'HARVEST',
  DONE: 'DONE',
});

/** The eight stages an iteration walks, in order. DONE is terminal, not a stage. */
export const STAGE_ORDER = Object.freeze([
  STAGE.SELECT,
  STAGE.CLAIM,
  STAGE.BUILD,
  STAGE.GATE,
  STAGE.PUBLISH,
  STAGE.WATCH,
  STAGE.LAND,
  STAGE.HARVEST,
]);

export const DISPOSITION = Object.freeze({
  MERGED: 'merged',
  MERGE_QUEUED: 'merge_queued',
  PARKED: 'parked',
  GUARD_WITHHELD: 'guard_withheld',
  NO_CHANGE: 'no_change_needed',
  HALTED: 'halted',
  DRY_RUN: 'dry_run',
});

/** Park reasons that reach the bead body and the ledger. Named, not free text. */
export const REASON = Object.freeze({
  NEEDS_HUMAN: 'needs_human',
  BUILD_FAILED: 'build_failed',
  MAX_TURNS: 'max_turns',
  BLOCKED: 'blocked',
  GATE_FAILED: 'gate_failed',
  LOCKFILE_DRIFT: 'lockfile_drift',
  PUSH_FAILED: 'push_failed',
  CRASHED: 'crashed',
  CI_RED: 'ci_red',
  CI_NEVER_STARTED: 'ci_never_started',
  CI_TIMEOUT: 'ci_timeout',
  MERGE_FAILED: 'merge_failed',
  MERGE_QUEUED: 'merge_queued',
  STALE_MAIN: 'stale_main',
  CLAIM_FAILED: 'claim_failed',
  USAGE_LIMIT: 'usage_limit',
  MERGE_DISABLED: 'merge_disabled',
  GUARD_BREACH: 'guard_breach',
});

const halted = (reason) => ({ stage: STAGE.DONE, disposition: DISPOSITION.HALTED, reason });
const park = (reason) => ({ stage: STAGE.HARVEST, disposition: DISPOSITION.PARKED, reason });

/**
 * @param {string} stage    current stage
 * @param {object} result   what the stage produced
 * @param {object} ctx      { halt, merge, dryRun, attempt, maxRepairs, guardPassed }
 * @returns {{stage: string, disposition?: string, reason?: string}}
 */
export function next(stage, result = {}, ctx = {}) {
  if (ctx.halt) return halted(result.haltReason);

  switch (stage) {
    case STAGE.SELECT:
      // Nothing selectable is a clean stop, not an iteration: there is no bead
      // to write a ledger record about.
      if (!result.bead) return { stage: STAGE.DONE, drained: true };
      return { stage: STAGE.CLAIM };

    case STAGE.CLAIM:
      if (result.ok === false) return park(REASON.CLAIM_FAILED);
      return { stage: STAGE.BUILD };

    case STAGE.BUILD: {
      // A usage limit is not a bead failure and must never be recorded as one,
      // nor count toward the breaker (§8.4 Layer 3).
      if (result.usageLimit) return halted(REASON.USAGE_LIMIT);
      // Non-zero exit, schema violation or timeout: park. BUILD is not retried
      // on its own failure — repairs exist for a red GATE or a red CI, where
      // there is a specific failing step to hand back.
      //
      // A turn-cap exhaustion parks too, but under its OWN reason, because the
      // remedy is the opposite of every other build failure: raise `maxTurns`
      // or split the bead, rather than debug a crash. Recorded as a generic
      // `build_failed` the two were indistinguishable in the ledger.
      if (result.ok === false) {
        if (result.failure === 'max_turns') return cappedBuild(result, ctx);
        return park(REASON.BUILD_FAILED);
      }

      const verdict = result.verdict ?? {};
      if (verdict.needs_human === true) return park(REASON.NEEDS_HUMAN);
      if (verdict.outcome === 'blocked') return park(REASON.BLOCKED);
      if (verdict.outcome === 'no_change_needed') {
        return { stage: STAGE.HARVEST, disposition: DISPOSITION.NO_CHANGE };
      }
      return { stage: STAGE.GATE };
    }

    case STAGE.GATE: {
      if (!result.passed) {
        const attempt = ctx.attempt ?? 1;
        const maxRepairs = ctx.maxRepairs ?? 0;
        if (attempt <= maxRepairs) return { stage: STAGE.BUILD, repair: true };
        return park(REASON.GATE_FAILED);
      }
      // --dry-run runs SELECT..GATE and reports. Nothing is committed, pushed,
      // opened or written to bd past this point.
      if (ctx.dryRun) return { stage: STAGE.DONE, disposition: DISPOSITION.DRY_RUN };
      return { stage: STAGE.PUBLISH };
    }

    case STAGE.PUBLISH:
      // A lockfile change is a hard park: CI runs `git diff --exit-code
      // package-lock.json` and would fail every time.
      if (result.lockfileDrift) return park(REASON.LOCKFILE_DRIFT);
      // A push that failed is not a build that failed: the remedy is a stale
      // remote branch or the network, never the diff. Recorded as
      // `build_failed` the two were indistinguishable in the ledger.
      if (result.pushFailed) return park(REASON.PUSH_FAILED);
      if (result.ok === false) return park(REASON.BUILD_FAILED);
      // A guard breach does NOT abort. The PR is opened and labelled; only
      // LAND is suppressed, which ctx.guardPassed carries to the LAND gate.
      return { stage: STAGE.WATCH };

    case STAGE.WATCH: {
      if (result.outcome === 'red') {
        const attempt = ctx.attempt ?? 1;
        const maxRepairs = ctx.maxRepairs ?? 0;
        if (attempt <= maxRepairs) return { stage: STAGE.BUILD, repair: true };
        return park(REASON.CI_RED);
      }
      // No check with the required name ever appeared. Usually the repo or the
      // runner, not this bead — so it parks AND counts toward the breaker.
      if (result.outcome === 'absent') return park(REASON.CI_NEVER_STARTED);
      // A check that appeared and never finished is a DIFFERENT fact, and the
      // remedies are opposites: raise `ci.completeTimeoutMs` versus go and look
      // at the runner. Reported as `ci_never_started` — which it plainly was
      // not — the ledger sent the morning triage to the wrong place.
      if (result.outcome === 'timeout') return park(REASON.CI_TIMEOUT);

      if (!ctx.merge) {
        return {
          stage: STAGE.HARVEST,
          disposition: DISPOSITION.GUARD_WITHHELD,
          reason: REASON.MERGE_DISABLED,
        };
      }
      if (ctx.guardPassed === false) {
        return {
          stage: STAGE.HARVEST,
          disposition: DISPOSITION.GUARD_WITHHELD,
          reason: REASON.GUARD_BREACH,
        };
      }
      return { stage: STAGE.LAND };
    }

    case STAGE.LAND:
      // `merged` is now a VERIFIED state read back from the forge, never the
      // exit code of the command that asked for it. See forge.mjs.
      if (result.merged) return { stage: STAGE.HARVEST, disposition: DISPOSITION.MERGED };
      if (result.queued) {
        return {
          stage: STAGE.HARVEST,
          disposition: DISPOSITION.MERGE_QUEUED,
          reason: REASON.MERGE_QUEUED,
        };
      }
      return park(REASON.MERGE_FAILED);

    case STAGE.HARVEST:
      return { stage: STAGE.DONE, disposition: result.disposition };

    default:
      throw new Error(`loop machine: unknown stage ${stage}`);
  }
}

/**
 * §8.3. `consecutiveParks` increments on every park regardless of reason and
 * resets on a merged or no_change_needed bead. A withheld or dry-run iteration
 * does neither: nothing failed, and nothing proved the systemic cause is gone.
 */
export function countsTowardBreaker(disposition) {
  return disposition === DISPOSITION.PARKED;
}

export function resetsBreaker(disposition, { ciGreen = false } = {}) {
  if (disposition === DISPOSITION.MERGED || disposition === DISPOSITION.NO_CHANGE) return true;
  // A WITHHELD ITERATION THAT REACHED CI-GREEN IS EVIDENCE, and `merge: false`
  // is the default, so this is the ordinary success shape rather than an edge
  // case. Neither counting nor resetting meant park/withheld/park/withheld/park
  // halted a run reporting "3 consecutive parks" while half the iterations had
  // built, gated, opened a PR and gone green — every component the breaker
  // exists to watch (bd, claude, gate, git, gh, CI) demonstrably working.
  //
  // A withheld iteration that did NOT get there proves nothing and resets
  // nothing, which is why this takes the CI result rather than the disposition
  // alone.
  return disposition === DISPOSITION.GUARD_WITHHELD && ciGreen === true;
}

/**
 * Did something LAND and `main` then fail to move?
 *
 * Extracted from the driver's `finally` so it can be pinned on every platform:
 * the end-to-end proof of this lives in the rehearsal harness, which is
 * POSIX-only, and a rule that only one runner checks is a rule that rots.
 *
 * The `landed` half is what keeps it quiet: before anything merges, a failed
 * pull just means `main` is where it was, which is harmless. After a merge it
 * means every later bead of an `--until 8` would branch from a base missing
 * what just landed.
 */
export function landedOnStaleMain(disposition, restore) {
  const landed = disposition === DISPOSITION.MERGED || disposition === DISPOSITION.MERGE_QUEUED;
  return landed && restore?.pulled === false;
}

/**
 * A BUILD that ran out of turns: resume once, and only on evidence of progress.
 *
 * `--resume` is already wired (the driver threads the session id through every
 * repair), so the mechanism costs nothing. The question was whether to use it,
 * and the argument against is real: the one cap ever observed was an agent
 * LOOPING — four consecutive identical `npm run typecheck` calls — where
 * resuming buys another full turn budget for the same wedge.
 *
 * `treeChanged` is what separates the two, and it is the signal the loop
 * already has: a capped agent that edited files was working, a capped agent
 * that left the tree untouched was spinning. Gated on `attempt === 1` so the
 * worst case is 2x the cap and never 3x, and on a session id, since there is
 * nothing to resume without one.
 */
function cappedBuild(result, ctx) {
  const attempt = ctx.attempt ?? 1;
  const maxRepairs = ctx.maxRepairs ?? 0;
  if (attempt === 1 && maxRepairs >= 1 && ctx.treeChanged === true && result.sessionId) {
    return { stage: STAGE.BUILD, repair: true, capped: true };
  }
  return park(REASON.MAX_TURNS);
}
