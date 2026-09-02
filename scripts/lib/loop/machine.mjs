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
  PR_MISSING: 'pr_missing',
  CRASHED: 'crashed',
  NO_CHANGE_CONTRADICTED: 'no_change_contradicted',
  CI_RED: 'ci_red',
  CI_NEVER_STARTED: 'ci_never_started',
  CI_TIMEOUT: 'ci_timeout',
  // A check OUTSIDE the required context completed red, so the PR cannot merge
  // however green the loop's own signal is. Separate from CI_RED because the
  // remedies share no step: there is nothing wrong with the diff and a repair
  // attempt cannot clear, say, a review label.
  CI_BLOCKED: 'ci_blocked',
  // CI was KILLED, not failed — a runner timeout or a cancelled leg. Separate
  // from CI_RED because a repair cannot help and a re-run can.
  CI_INFRA: 'ci_infra',
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
 * @param {object} ctx      { halt, merge, dryRun, attempt, maxRepairs, guardPassed,
 *                          treeChanged, capResumed }
 * @returns {{stage: string, disposition?: string, reason?: string}}
 */
export function next(stage, result = {}, ctx = {}) {
  // NOT AT THE HARVEST BOUNDARY. HARVEST is the last stage; by the time it
  // returns, the bead has been closed or parked, the PR is open or merged, and
  // there is nothing left for a halt to prevent. Firing here only REWRITES the
  // label on work that already happened: measured, `next(HARVEST, {disposition:
  // 'merged'}, {halt: true})` returned `halted`, so an iteration that merged to
  // main and closed its bead was recorded as halted in the ledger.
  //
  // Worse once a halt does bead bookkeeping (Cebab-qd2.22): the driver would
  // then hand back a bead HARVEST had just correctly closed. A terminal that has
  // already acted on the world is preserved — the same rule the crash handler
  // follows for `merged`/`merge_queued`.
  //
  // The run still stops: `main`'s own loop checks HALT before the next
  // iteration. `Cebab-qd2.32`.
  if (ctx.halt && stage !== STAGE.HARVEST) return halted(result.haltReason);

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
        // THE ONE OUTCOME THAT CLOSES A BEAD PERMANENTLY IS THE ONE THAT NEVER
        // REACHED GATE. Every other route to a closed bead runs ten checks,
        // opens a PR and waits for CI first; this one ran nothing, which is
        // rule 2 — "the agent's report is not evidence" — violated at the least
        // recoverable point, since a closed bead leaves the backlog for good.
        //
        // Reachable rather than theoretical: a stale backlog produces genuine
        // no-change verdicts constantly, and a bead already fixed in an open PR
        // is exactly that case.
        //
        // A full GATE would cost ten checks to prove a no-op. This is the ONE
        // check that can FALSIFY the claim, and the driver already holds the
        // answer: the branch is fresh from main, so any dirt is this agent's
        // work. Either it changed something (so "no change" is false) or it left
        // debris (so the verdict is untrustworthy) — and the iteration's own
        // teardown is about to `reset --hard` that work away. `Cebab-qd2.33`.
        if (ctx.treeChanged === true) return park(REASON.NO_CHANGE_CONTRADICTED);
        return { stage: STAGE.HARVEST, disposition: DISPOSITION.NO_CHANGE };
      }
      return { stage: STAGE.GATE };
    }

    case STAGE.GATE: {
      // BEFORE the repair branch, and the order is the fix. A live smoke is
      // the only gate step that spawns `claude`, so it is the only one that
      // can fail because the subscription ran out rather than because the diff
      // is wrong. Falling through to `repair` spends a full second `claude -p`
      // invocation against the same wall, and then parks a healthy bead
      // `loop-stuck` — excluding it from every future SELECT. `Cebab-weqo`.
      //
      // Same reason and same disposition as STAGE.BUILD's limit branch above:
      // halting leaves the bead open and unlabelled, and every later bead in
      // the run would hit the identical wall anyway.
      if (result.usageLimit) return halted(REASON.USAGE_LIMIT);
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
      // BEFORE the `red` branch, and the order is load-bearing: both of these
      // are non-green outcomes that a repair attempt cannot fix, so falling
      // through to `red` would spend the repair budget on them.
      //
      // `blocked` — the required context is green but another required check is
      // red. Measured 2026-08-30 on PR #432, where `Fixture review gate` was
      // red by design pending a CODEOWNER: the loop merged nothing (branch
      // protection refused), but recorded `merge_queued`, which reads as "will
      // land shortly" for a PR that needed a human. Parks so the morning triage
      // sees it, and NEVER repairs — the diff is not what is wrong.
      if (result.outcome === 'blocked') return park(REASON.CI_BLOCKED);
      // `infra` — CI was killed rather than failing. The driver has already
      // spent its one re-run by the time this is reached (see `watchCi`),
      // so there is nothing left to try automatically.
      if (result.outcome === 'infra') return park(REASON.CI_INFRA);
      if (result.outcome === 'red') {
        const attempt = ctx.attempt ?? 1;
        const maxRepairs = ctx.maxRepairs ?? 0;
        if (attempt <= maxRepairs) return { stage: STAGE.BUILD, repair: true };
        return park(REASON.CI_RED);
      }
      // NOTHING COULD EVER REPORT. Checks belong to a pull request, so with no
      // PR there is nothing to wait for and `absent` would be true forever.
      // Reported separately because the remedies share no step: `pr_missing` is
      // a PUBLISH failure and the branch is already on the remote, while
      // `ci_never_started` is a repo or runner problem with a PR sitting open.
      // Measured 2026-08-26: two beads spent 916 s each polling a SHA that no
      // PR referenced, then blamed the runner (Cebab-qd2.18, Cebab-qd2.19).
      if (result.outcome === 'no_pr') return park(REASON.PR_MISSING);
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
export function countsTowardBreaker(disposition, { reason } = {}) {
  if (disposition !== DISPOSITION.PARKED) return false;
  // A DECLINE IS NOT A FAILURE, AND THE BREAKER ONLY WATCHES FAILURES.
  //
  // `needs_human` is the agent reading the brief and saying this one is not
  // mine — the bail-out Cebab-qd2.16 added precisely so an unsuitable bead
  // costs eight turns instead of a full budget. Measured 2026-08-26: it cost
  // $0.66 against the $9.06 the same lesson cost without it.
  //
  // Counting it halted a run on `3 consecutive parks` of which one was the
  // loop working exactly as designed. The breaker exists to catch a
  // SYSTEMICALLY broken run — a dead credential, a repo that will not build —
  // and a bead correctly declined is evidence of the opposite: bd answered,
  // the agent spawned, read the brief and made a judgement.
  //
  // Declines are not free, though, and are counted separately below: a queue
  // of two hundred unsuitable beads must not look like a healthy run forever.
  return reason !== REASON.NEEDS_HUMAN;
}

/**
 * A decline is its own kind of evidence, with its own limit.
 *
 * Without this the fix above trades one bad halt for a worse one: a run that
 * declines every bead would spin through the whole queue reporting nothing
 * wrong. Separate counter, separate limit, and a DIFFERENT message — "the
 * queue is unsuitable" and "the loop is broken" send the operator to opposite
 * places.
 */
export function countsTowardDeclines(disposition, { reason } = {}) {
  return disposition === DISPOSITION.PARKED && reason === REASON.NEEDS_HUMAN;
}

/**
 * THE ONE GATE FAILURE THE DRIVER REPAIRS ITSELF.
 *
 * A predicate rather than an `if` inside the driver, for the reason every other
 * predicate in this file is one: `runIteration` is not exported, so a branch
 * written inline there is unreachable from a test, and the fix most in need of
 * one is the fix nobody can observe.
 *
 * `format:check` is the ONLY step named. It is the only gate failure whose
 * remedy is a command rather than a judgement, and it is the only one the loop
 * has ever hit: 6 `gate: FAILED at format:check` lines in the console log and
 * nothing else, 5 of 8 builds on 2026-08-27, with no lint, typecheck, test,
 * build, smoke or ci_smoke failure in that entire run. Each cost a full
 * `claude -p` repair to re-establish the bead's whole context and run
 * `npm run format`.
 *
 * THE EVIDENCE IS THE CONSOLE LOG, NOT THE LEDGER, and the difference is itself
 * a defect. All 32 ledger rows carry ZERO non-zero gate steps and zero
 * `reason: gate_failed`, because `parts.gate` is reassigned on each attempt and
 * the row keeps the PASSING retry — the same overwrite `Cebab-qd2.39` found in
 * `parts.build`. So a gate failure that reaches a repair is invisible in the
 * durable record. `Cebab-qd2.43` tracks it; the autofix path above is exempted by
 * hand, since it keeps the failing steps rather than replacing them.
 *
 * ONCE PER ITERATION. A SECOND format:check failure after prettier has already
 * run means prettier could not fix it — an unparseable file — and that is a
 * real defect that must reach the repair path exactly as it does today. The
 * bound is what stops the driver looping on prettier instead of parking.
 *
 * NOT GENERALISABLE, and the narrowness is the design. `Cebab-oit` proposed
 * running `npm run format` as a step BEFORE `format:check`, which would make
 * that check green by construction — `prettier --write` then `prettier --check`
 * can only disagree about a file prettier cannot parse — and a gate step that
 * can no longer fail is a gate step measuring nothing. Firing only AFTER a real
 * failure keeps the step live and keeps the failure in `gate.steps`.
 */
export function shouldAutofixFormat(gated, { alreadyAutofixed = false } = {}) {
  if (alreadyAutofixed) return false;
  if (!gated || gated.passed !== false) return false;
  return gated.failedStep === 'format:check';
}

/**
 * The steps a ledger row carries when the gate ran TWICE for one attempt.
 *
 * Both runs, failed one first. `gate.autofixFormat`'s entire justification for
 * firing after the check rather than before it is that the failure stays real
 * and stays in `gate.steps` — and the driver's first version assigned the
 * re-gate's steps over the first run's, so the row showed a clean ten-step gate
 * and a boolean was the only trace that anything had reddened. That made the
 * justification false as wired.
 *
 * A function rather than an inline spread for the reason `shouldAutofixFormat`
 * is one: `runIteration` is not exported, so the property would otherwise be
 * unreachable from a test — and this property was already violated once.
 *
 * `verdictVsGate` must be computed from THIS, not from the repaired run alone,
 * or it reports agreement between the agent's claimed commands and a gate
 * result the agent never caused.
 */
export function stepsAcrossAutofix(failedRun, repairedRun) {
  return [...(failedRun ?? []), ...(repairedRun ?? [])];
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
 * that left the tree untouched was spinning. Gated on a session id, since
 * there is nothing to resume without one.
 *
 * A RESUME IS A CONTINUATION, NOT A REPAIR, AND NO LONGER SPENDS AN ATTEMPT.
 *
 * It used to return `repair: true`, which the driver reads as "bump `attempt`",
 * so the resume consumed one of `maxRepairs`. Measured across every iteration
 * that has ever reached PUBLISH: the only two FEATURE beads (Cebab-2t9.1,
 * Cebab-2t9.2) both took all three allowed attempts, in the same shape —
 * attempt 1 capped at 61 turns, attempt 2 resumed and did the work but failed
 * `format:check`, attempt 3 ran Prettier and passed. Both therefore merged with
 * ZERO repairs left, and had CI then gone red — which it did on Cebab-7r8 —
 * a complete, gate-passing change would have parked under `ci_red`.
 *
 * `maxRepairs` bounds how many times the loop may FIX something. A turn cap is
 * not something the change got wrong; it is the driver interrupting a working
 * agent. Charging the interruption to the repair budget spent the headroom
 * before the first real failure. `Cebab-qd2.37`.
 *
 * THE BOUND MOVES TO ITS OWN FLAG rather than disappearing. `ctx.capResumed` is
 * set by the driver the first time this fires and is per-ITERATION, so a second
 * cap parks exactly as before — the old `attempt === 1` guard cannot be reused,
 * because with the attempt no longer bumping it would read `1` forever and
 * resume without limit. Worst case is now four `claude` invocations per bead
 * (one capped, one resume, two repairs) against three, and that is the trade
 * this makes deliberately: one extra capped-agent continuation against a
 * finished change parking for want of a repair.
 */
function cappedBuild(result, ctx) {
  const maxRepairs = ctx.maxRepairs ?? 0;
  if (!ctx.capResumed && maxRepairs >= 1 && ctx.treeChanged === true && result.sessionId) {
    // NO `repair: true`. That flag means "this costs an attempt" and is read by
    // exactly one line in the driver; the two are separate facts and were only
    // ever one because nothing needed them apart.
    return { stage: STAGE.BUILD, capped: true };
  }
  return park(REASON.MAX_TURNS);
}
