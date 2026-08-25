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
  BLOCKED: 'blocked',
  GATE_FAILED: 'gate_failed',
  LOCKFILE_DRIFT: 'lockfile_drift',
  CI_RED: 'ci_red',
  CI_NEVER_STARTED: 'ci_never_started',
  MERGE_FAILED: 'merge_failed',
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
      if (result.ok === false) return park(REASON.BUILD_FAILED);

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
      if (result.merged) return { stage: STAGE.HARVEST, disposition: DISPOSITION.MERGED };
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

export function resetsBreaker(disposition) {
  return disposition === DISPOSITION.MERGED || disposition === DISPOSITION.NO_CHANGE;
}
