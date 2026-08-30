#!/usr/bin/env node
/**
 * The autonomous loop: take one ready bead, implement it, gate it, publish it,
 * wait for CI, merge on green, close the bead, file what it found. Repeat.
 *
 * Full specification in `docs/AUTONOMOUS_LOOP_SPEC.md`. Three rules govern
 * every decision here and they are not stylistic:
 *
 *   1. THE DRIVER OWNS CONTROL FLOW; THE AGENT OWNS ONE STAGE. BUILD is a
 *      sub-invocation of Claude Code. Everything else is deterministic code.
 *      Moving work into the agent to "simplify" is the change that breaks this.
 *   2. THE AGENT'S REPORT IS NOT EVIDENCE. GATE re-runs what the agent claims
 *      it ran and records the disagreement. Nothing branches on the verdict's
 *      own account of itself.
 *   3. FAIL LOUD, PARK QUIETLY. A bead the loop cannot land is parked with its
 *      evidence attached and the loop continues. A condition it cannot reason
 *      about halts it.
 *
 * THE LEDGER APPEND IS IN A `finally`, AND THAT IS WHY `buildRecord` DEFAULTS
 * EVERY FIELD: a thrown stage must still leave a row, and the crash is the
 * case the maintainer most needs one for.
 *
 * TEARDOWN RUNS ON EVERY TERMINATING PATH — success, park, halt, SIGINT,
 * SIGTERM, thrown error. The invariant it protects is "repo on main, tree
 * clean, no surviving tsx watch"; a run that ends on a feature branch with a
 * live dev:server is the state that costs the next session an hour.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ConfigError,
  firstTripped,
  parseUntil,
  reserveBlocks,
  resolveConfig,
} from './lib/loop/config.mjs';
import {
  DISPOSITION,
  REASON,
  STAGE,
  countsTowardBreaker,
  countsTowardDeclines,
  landedOnStaleMain,
  next,
  resetsBreaker,
  shouldAutofixFormat,
  stepsAcrossAutofix,
} from './lib/loop/machine.mjs';
import { evaluateGuard } from './lib/loop/guard.mjs';
import { REEXEC_ENV, reexecArgv, reexecEnv, reexecPlan } from './lib/loop/self_update.mjs';
import {
  ZERO_TOKENS,
  accumulateBuild,
  addTokens,
  formatUsage,
  meteredTokens,
  withoutLegacyCost,
} from './lib/loop/usage.mjs';
import { scrubbedFrom, subscriptionOnlyEnv } from './lib/loop/env.mjs';
import { ancestorsOfActive, chooseBead, denyPathStems } from './lib/loop/select.mjs';
import {
  appendRecord,
  buildRecord,
  compareVerdictToGate,
  mergeVerdictVsGate,
} from './lib/loop/ledger.mjs';
import { makeRunner } from './lib/loop/run.mjs';
import { LockHeldError, acquireLock, releaseLock } from './lib/loop/lock.mjs';
import { reconcile } from './lib/loop/reconcile.mjs';
import { renderReport, rowsSince, verifyRun } from './lib/loop/report.mjs';
import { DECLINE_LABEL, PARK_LABEL, makeBeads } from './lib/loop/beads.mjs';
import { branchNameFor, commitSubject, makeGit } from './lib/loop/git.mjs';
import { makeForge, overlappingPrs } from './lib/loop/forge.mjs';
import { assertPlaygroundEnv, makeGate } from './lib/loop/gate.mjs';
import { makeBuild } from './lib/loop/build.mjs';

const LIB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'loop');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOP_DIR = path.join(REPO_ROOT, '.loop');
const HALT_FILE = path.join(LOOP_DIR, 'HALT');

/**
 * A SIGNAL IS IN-PROCESS, SO IT WRITES NO FILE.
 *
 * The handler used to write the HALT file itself, with the body `signal`, so the
 * stage-boundary checks would see it — and nothing ever removed it. `.loop/HALT` is a PREFLIGHT
 * REFUSAL, so one Ctrl-C left every subsequent run refusing to start with
 * `.loop/HALT exists — signal. Remove it to start.` until someone deleted the
 * file by hand. Measured 2026-08-26: the operator stopped a run, and the next
 * night's `loop:night` refused before SELECT. `Cebab-qd2.21`.
 *
 * The file is for CROSS-process signalling (`loop:stop` is `touch .loop/HALT`,
 * and it stays deliberate and durable). A signal delivered to this process needs
 * no file to reach this process. Module-scoped because `runIteration`'s
 * boundary check and `main`'s loop check both read it.
 */
let signalled = false;
const LEDGER_FILE = path.join(LOOP_DIR, 'runs.jsonl');
const STATE_FILE = path.join(LOOP_DIR, 'state.json');

const EXIT = { OK: 0, HALTED: 1, REFUSED: 2, SIGINT: 130 };

// ─── CLI ───────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = { until: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => argv[(i += 1)];
    switch (arg) {
      case '--bead':
        out.bead = take();
        break;
      case '--until':
        out.until.push(take());
        break;
      case '--merge':
        out.flags.merge = true;
        break;
      case '--dry-run':
        out.dryRun = true;
        break;
      case '--no-playground':
        out.noPlayground = true;
        break;
      case '--config':
        out.configPath = take();
        break;
      case '--status':
        out.status = true;
        break;
      case '--json':
        out.json = true;
        break;
      case '-v':
      case '--verbose':
        out.verbose = true;
        break;
      default:
        throw new ConfigError(`unknown option ${arg}`);
    }
  }
  return out;
}

/**
 * The ledger, parsed, or `[]`. A malformed LINE is skipped rather than throwing
 * the whole file away: `runs.jsonl` is append-only and a run killed mid-write
 * can leave a partial last line, which must not cost the reader the good rows
 * above it.
 */
const readLedger = (file = LEDGER_FILE) => {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A partial line from a killed run. Skipped, not fatal.
    }
  }
  return rows;
};

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

/**
 * The config file, or a loud refusal. NOT `readJson`.
 *
 * `readJson(args.configPath ?? …, {})` swallowed both a missing file and a
 * syntax error and returned `{}`, so `--config .loop/typo.json` ran on the
 * DEFAULTS while the operator believed they had configured something else —
 * a different model, a different turn cap, a different deny list. Nothing
 * anywhere said otherwise.
 *
 * That is the same shape as the guard measuring an empty diff and `--bead`
 * building from an empty description: it succeeds, and measures nothing. It
 * also contradicts this module's own philosophy — `resolveConfig` refuses an
 * unknown KEY by name and exits 2, so a file it cannot parse at all deserves
 * at least as much.
 *
 * An ABSENT default path is fine; running with no config is the normal case.
 * An absent EXPLICIT path never is.
 */
function readConfigFile(explicitPath) {
  const file = explicitPath ?? path.join(LOOP_DIR, 'config.json');
  if (!fs.existsSync(file)) {
    if (explicitPath) throw new ConfigError(`--config ${explicitPath} does not exist.`);
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError(`${file} is not valid JSON — ${error?.message ?? error}`);
  }
}

// ─── preflight (§13) ───────────────────────────────────────────────────────

async function preflight({ run, config, git, dryRun }) {
  const fail = (message) => {
    throw new ConfigError(`preflight: ${message}`);
  };

  // R8: resolve `bd` once. Under launchd/cron /opt/homebrew/bin is not on
  // PATH, and the alternative is a mid-run `command not found`.
  const which = await run(process.platform === 'win32' ? 'where' : 'which', ['bd']);
  if (which.code !== 0) fail('`bd` is not on PATH. Set it in config or add /opt/homebrew/bin.');
  const bd = which.stdout.trim().split('\n')[0].trim();

  // THE OTHER TWO BINARIES EVERY ITERATION DEPENDS ON, and neither was checked.
  // `claude` IS the BUILD stage; `npm` is nine of the ten deterministic gate
  // steps. Under a launchd or cron PATH — the exact reason `bd` earned its
  // check above — preflight passed, SELECT picked a bead, CLAIM claimed it and
  // cut a branch, and only THEN did BUILD fail. The bead parked under
  // `build_failed`, which blames the agent for an environment problem, and
  // three of those halt the run having claimed three beads for a cause none of
  // their notes name. Preflight's contract is one exit 2 at second zero
  // instead. `Cebab-qd2.34`.
  //
  // `--version` rather than `which`: it proves the thing RUNS. A broken symlink
  // resolves fine and spawns not at all, and for `npm` this goes through the
  // same runner — so the win32 shell decision (`needsWin32Shell`) is exercised
  // here rather than discovered at the first gate step.
  for (const [file, hint] of [
    ['claude', 'BUILD cannot spawn without it'],
    ['npm', 'nine of the ten gate steps are `npm run`'],
  ]) {
    const probe = await run(file, ['--version'], { timeoutMs: 30000 }).catch((error) => ({
      code: 1,
      stderr: String(error?.message ?? error),
    }));
    if (probe.code !== 0) {
      fail(
        `\`${file} --version\` failed — ${hint}. Check PATH: a launchd or cron PATH is not your shell's.`,
      );
    }
  }

  if (fs.existsSync(HALT_FILE)) {
    const note = fs.readFileSync(HALT_FILE, 'utf8').trim();
    fail(`.loop/HALT exists${note ? ` — ${note}` : ''}. Remove it to start.`);
  }

  if (!(await git.isClean())) fail('working tree is dirty. Commit or stash first.');
  const branch = await git.currentBranch();
  if (branch !== 'main') fail(`on branch '${branch}'; the loop starts from main.`);

  // CLEAN AND ON MAIN IS NOT THE SAME AS CURRENT, and both directions bite.
  // A main that is BEHIND means every bead is built, gated and merged against
  // stale code. A main that is AHEAD — unpushed local work, which is the normal
  // state of a checkout someone has been developing in — is worse: `newBranch`
  // branches from it, so that unpushed work is carried into the bead's branch
  // and pushed into the bead's PR.
  //
  // Checked here rather than left to the per-iteration restore, because the
  // restore's pull runs at the END of an iteration: the first bead of every run
  // would already have been built on whatever was lying around.
  if (!dryRun) {
    await git.fetchMain();
    const synced = await git.restoreToMain();
    if (!synced.pulled) {
      fail(
        `local main is not current with origin and cannot fast-forward — ${synced.detail}. ` +
          `Push or reset it first; the loop branches every bead from main.`,
      );
    }
  }

  if (!dryRun) {
    const auth = await run('gh', ['auth', 'status']);
    if (auth.code !== 0) fail('`gh auth status` failed — the forge is unreachable.');
  }

  // R2. Checked HERE rather than at GATE: a missing .env would otherwise fail
  // the first server/** bead, park it, and do the same twice more, halting on
  // the breaker with three failures that all misdescribe one setup problem.
  if (config.gate.playgroundTier !== 'never') {
    assertPlaygroundEnv({ repoRoot: REPO_ROOT, gate: config.gate });
  }

  return { bd };
}

// ─── one iteration ─────────────────────────────────────────────────────────

async function runIteration({ ctx, deps, log }) {
  const { config, beads, git, forge, gate, build, dryRun } = deps;
  // `harvest.followUps` is an ARRAY on purpose: HARVEST pushes into it, and
  // an absent one threw `Cannot read properties of undefined (reading 'push')`
  // on the first follow-up any verdict carried — which is most of them,
  // `follow_ups` being a required key of the schema.
  const parts = {
    build: {},
    gate: {},
    guard: {},
    harvest: { beadClosed: false, followUps: [] },
    // Set here rather than at the append, so the row a CRASHED iteration
    // salvages still says which driver produced it — which is the case the
    // revision matters most for. `Cebab-qd2.35`.
    driverRevision: deps.driverRevision ?? null,
    driverRestarted: Boolean(deps.driverRestarted),
  };
  let stage = STAGE.SELECT;
  let bead = null;
  let attempt = 1;
  // How many times a turn-capped BUILD was RESUMED. Counted apart from
  // `attempt` because a resume is a continuation, not a repair, and no longer
  // spends one of `maxRepairs` (Cebab-qd2.37) — this is what still bounds it to
  // one per iteration, and what keeps the ledger able to say how many `claude`
  // invocations an iteration actually cost.
  let capResumes = 0;
  let disposition = null;
  let reason = null;
  // Did HARVEST run to completion? The crash handler needs to tell "harvest
  // never ran" from "harvest is what threw", and re-running the thing that just
  // threw is the defect below.
  let harvested = false;
  let crashed = false;
  let prNumber = null;
  let guardResult = { passed: true, breaches: [] };
  let sessionId = null;
  let drained = false;
  let repairContext = null;
  let treeChanged = null;
  // Has the gate's one mechanical autofix already been spent this iteration?
  // Per-ITERATION rather than per-attempt: a repair that reintroduces a
  // formatting error should reach the operator, not loop on prettier.
  let formatAutofixed = false;
  // One entry per pass through STAGE.GATE, in order. The gate runs again after
  // every repair, and `parts.gate` was ASSIGNED each time — so the row a
  // repaired iteration wrote showed a clean ten-step gate and kept no trace
  // that anything had reddened. Accumulated here, above the single assignment
  // below, for the same reason `buildTotals` is. `Cebab-qd2.43`.
  const gateAttempts = [];
  // Accumulated across every `claude` invocation of this iteration — a capped
  // build, its resume, and any repair. See `accumulateBuild`.
  let buildTotals = null;
  // Assigned in the `finally`, which every path reaches — an initializer here
  // is dead, and eslint's no-useless-assignment says so.
  let staleMain;

  const halted = () => signalled || fs.existsSync(HALT_FILE);

  try {
    for (;;) {
      let result;
      switch (stage) {
        case STAGE.SELECT: {
          if (ctx.forcedBead) {
            // Fetched DIRECTLY, never looked up in the ready list. That lookup
            // asked for 200 rows against 210 ready beads and fell back to a
            // stub `{ id, title: id, description: '' }` on a miss — so the
            // agent got a prompt reading `**Cebab-ouy — Cebab-ouy**` with no
            // body and spent a full turn budget on it. Refusing is the only
            // honest answer: building from an empty description is worse than
            // not starting.
            bead = await beads.show(ctx.forcedBead);
            if (!bead) {
              throw new ConfigError(
                `no bead ${ctx.forcedBead} — \`bd show\` found nothing. Refusing rather ` +
                  `than building from an empty description.`,
              );
            }
            // --bead skips the queue but NOT the deny-path check.
            const stems = denyPathStems(config.guard.denyPaths);
            const text = `${bead.title}\n${bead.description ?? ''}`;
            if (stems.some((s) => text.includes(s))) {
              throw new ConfigError(
                `${bead.id} names a denied path; refusing to work it unattended.`,
              );
            }
          } else {
            const rows = await beads.ready(config.select, 50);
            // CONTAINMENT IS COMPUTED FRESH EVERY ITERATION, and it has to be:
            // the state it reads is one the RUN ITSELF creates. Iteration 5
            // leaves a guard-withheld bead `in_progress`, and iteration 6 is
            // the one that must see it. A set gathered once at startup would
            // be correct for the first bead and stale for every bead after.
            //
            // ONE call, ~0.37s against a multi-minute iteration. `--all` is
            // what makes it one: the closed rows hold 311 of the 457 parent
            // edges and without them the walk stops at the first closed
            // ancestor. See `ancestorsOfActive`.
            const graph = await beads.list();
            const contains = ancestorsOfActive(graph);
            // COUNTED OUT LOUD, because the way this fails is by being empty.
            // Every field it reads (`id`, `parent`, `status`) comes off a bd
            // row, and a bd that stopped returning one of them would leave the
            // rule running, reporting nothing, and measuring nothing — the
            // exact failure the header of `select.mjs` describes for `labels`.
            // A zero here on a repo with parents is the tell.
            log(`select: ${graph.length} beads in the graph, ${contains.size} contain other work`);
            bead = chooseBead(rows, {
              select: config.select,
              denyStems: denyPathStems(config.guard.denyPaths),
              parked: ctx.parked,
              contains,
            });
          }
          if (bead) {
            parts.bead = bead.id;
            parts.beadTitle = bead.title;
            parts.branch = branchNameFor(bead.id);
            log(`select: ${bead.id} — ${bead.title}`);
          } else {
            drained = true;
          }
          result = { bead };
          break;
        }

        case STAGE.CLAIM: {
          if (!(await beads.claim(bead.id))) {
            result = { ok: false };
            break;
          }
          // THE BRANCH RESULT IS CHECKED. `newBranch` is `git checkout -b`,
          // which FAILS if the branch already exists — and it exists whenever a
          // previous run on this bead was killed before its teardown deleted
          // it, which is exactly the state a halted or crashed run leaves
          // behind. Dropped, the failure was silent and every later stage ran
          // on whatever was checked out: BUILD edited main, the guard diffed
          // main against itself, and PUBLISH pushed main to a branch name.
          // `Cebab-qd2.25`.
          const branched = await git.newBranch(bead.id);
          if (branched.code !== 0) {
            const detail = (branched.stderr || branched.stdout || '').trim().split('\n')[0];
            log(`claim: could not create branch loop/${bead.id} — ${detail}`);
            result = { ok: false };
            break;
          }
          result = { ok: true };
          break;
        }

        case STAGE.BUILD: {
          const built = await build.run({
            bead,
            attempt,
            maxRepairs: config.loop.maxRepairs,
            failedStep: repairContext?.failedStep,
            failureOutput: repairContext?.output,
            resumeSessionId: sessionId,
            capped: repairContext?.capped === true,
            priorFollowUps: ctx.followUpsThisRun,
          });
          // ONE SITE, ABOVE BOTH ASSIGNMENTS, and that placement IS the fix.
          // There are two `parts.build = { ... }` literals below — the usage
          // limit branch and the ordinary one — and each overwrote the previous
          // attempt's telemetry wholesale. Accumulating here, before either can
          // run, is what makes a three-invocation bead impossible to record as
          // a one-invocation bead. `Cebab-qd2.39`.
          buildTotals = accumulateBuild(buildTotals, built);
          if (built.usageLimit) {
            // A limited attempt still SPENT. Breaking out before accounting for
            // it let the run ceiling under-report exactly the case the operator
            // most wants a number for.
            sessionId = built.sessionId ?? sessionId;
            account(ctx, built);
            parts.build = {
              sessionId,
              numTurns: built.numTurns ?? null,
              costUsd: built.costUsd ?? null,
              tokens: built.tokens ?? null,
              durationMs: built.durationMs ?? null,
              exitCode: built.exitCode ?? null,
              attempts: attempt,
              capResumes,
              totals: buildTotals,
            };
            logUsage(log, bead, attempt, built);
            result = { usageLimit: true, haltReason: REASON.USAGE_LIMIT };
            parts.haltReason = REASON.USAGE_LIMIT;
            log(
              `build: usage limit (${built.usageLimit.kind}), resets ${built.usageLimit.resetsAt ?? 'unknown'}`,
            );
            break;
          }
          sessionId = built.sessionId ?? sessionId;
          parts.build = {
            sessionId,
            numTurns: built.numTurns,
            costUsd: built.costUsd,
            tokens: built.tokens ?? null,
            durationMs: built.durationMs ?? null,
            exitCode: built.exitCode ?? null,
            outcome: built.verdict?.outcome ?? null,
            risk: built.verdict?.risk ?? null,
            // THE AGENT'S OWN ACCOUNT, CARRIED INTO THE LEDGER. For a decline
            // this is the entire content of the iteration — the build
            // SUCCEEDED, so `detail` is empty, and no gate, CI or PR ever ran,
            // so every other evidence line is empty too. Measured on
            // Cebab-4ey.2: 5 turns spent reaching a judgement, and the durable
            // record of it was the 43 characters `Parked by the autonomous
            // loop: needs_human.` `Cebab-qd2.36`.
            summary: built.verdict?.summary ? String(built.verdict.summary).slice(0, 600) : null,
            attempts: attempt,
            // Separate from `attempts` on purpose: a resumed turn cap no longer
            // costs an attempt (Cebab-qd2.37), so without this the ledger could
            // no longer tell one `claude` invocation from two.
            capResumes,
            // EVERY invocation this iteration made, not just this one. The
            // fields above stay last-invocation so 32 existing rows keep their
            // meaning. `Cebab-qd2.39`.
            totals: buildTotals,
          };
          // Accounted whatever happened. A failed build still SPENT, and
          // counting only successes let the run ceiling under-report by exactly
          // the runs the operator most wants to know about.
          account(ctx, built);
          logUsage(log, bead, attempt, built);
          if (built.ok) {
            parts.verdict = built.verdict;
            parts.commandsRun = built.verdict?.tests?.commands_run ?? [];
          } else {
            // An unattended run has to diagnose itself. Without this the ledger
            // said `build_failed exit 1` three times and nothing more, and the
            // cause had to be reproduced by hand the next morning.
            parts.build.failure = built.failure ?? null;
            parts.build.detail = built.detail ?? null;
            log(
              `build: FAILED (${built.failure ?? 'unknown'}) ${(built.detail ?? '').split('\n')[0]}`,
            );
          }
          // DID THE CAPPED AGENT ACTUALLY DO ANYTHING? This is the whole input
          // to the resume decision (`cappedBuild` in machine.mjs), and the
          // branch is fresh from main, so any dirt in the tree is this agent's
          // work. A capped agent that edited nothing was spinning — the one cap
          // ever observed was four identical `npm run typecheck` calls — and
          // resuming it buys a second full turn budget for the same wedge.
          //
          // The SAME fact answers a second question (Cebab-qd2.33): a verdict of
          // `no_change_needed` closes the bead permanently without ever reaching
          // GATE, and a dirty tree falsifies it outright. One `git status` covers
          // both, so it is computed whenever either asks.
          treeChanged =
            built.failure === 'max_turns' || built.verdict?.outcome === 'no_change_needed'
              ? !(await git.isClean())
              : null;
          result = built;
          break;
        }

        case STAGE.GATE: {
          const changedPaths = await git.changedPaths();
          let gated = await gate.run({ changedPaths });
          // A FORMATTING FAILURE COSTS A WHOLE INVOCATION, AND IT NEED NOT.
          //
          // The repair path re-spawns `claude` to re-read the bead, the diff
          // and the failure, so that it can run one deterministic command. This
          // runs the command instead and re-gates, spending no attempt: the
          // driver owns control flow, and `npm run format` requires none of the
          // judgement a repair exists to buy.
          //
          // ONCE PER ITERATION, and the flag is what bounds it. A second
          // format:check failure after prettier has already run means prettier
          // could not fix it — an unparseable file — which is a real defect and
          // must reach the repair path exactly as it does today.
          //
          // The re-gate is a FULL one, from step 1. format:check is step 3 of
          // 10, so steps 4-10 never ran and there is nothing to resume from;
          // re-running is what a repair would have done anyway, minus the
          // model turn.
          // KEPT, BECAUSE THE RE-GATE'S STEPS ALL PASS AND WOULD ERASE THE
          // FAILURE. `gate.autofixFormat`'s whole justification for firing
          // AFTER the check rather than before it is that the failure stays
          // real and stays in `gate.steps` — and assigning the second run's
          // steps over the first made that claim false, leaving a boolean as
          // the only trace of a ten-step gate that had reddened.
          let preAutofixSteps = [];
          if (shouldAutofixFormat(gated, { alreadyAutofixed: formatAutofixed })) {
            formatAutofixed = true;
            log('gate: format:check failed — running `npm run format`, then re-gating');
            const fixed = await gate.autofixFormat();
            if (fixed.code === 0) {
              preAutofixSteps = gated.steps ?? [];
              gated = await gate.run({ changedPaths });
            } else {
              log('gate: `npm run format` itself failed — falling through to the repair path');
            }
          }
          const attemptSteps = stepsAcrossAutofix(preAutofixSteps, gated.steps);
          // Against the SAME steps this attempt produced, failure included.
          // Computing it from the repaired run alone would report agreement
          // between the agent's claimed commands and a gate result the agent
          // never caused — and `parts.commandsRun` is the claim of the build
          // that immediately preceded THIS gate run, so the pairing is only
          // correct while it is made here, before the next build replaces it.
          const attemptVerdict = compareVerdictToGate(parts.commandsRun ?? [], attemptSteps);
          gateAttempts.push({
            attempt,
            passed: gated.passed === true,
            failedStep: gated.failedStep ?? null,
            verdictVsGate: attemptVerdict,
            steps: attemptSteps,
          });
          parts.gate = {
            steps: attemptSteps,
            attempts: gateAttempts,
            playgroundRan: gated.playgroundRan,
            liveSmokesRan: gated.liveSmokesRan,
            // Recorded so a run that never needed the autofix and a run that
            // needed it every time are distinguishable the next morning. This
            // is the number that says whether the prompt change is working.
            ...(formatAutofixed ? { formatAutofixed: true } : {}),
          };
          // STICKY, not last-write-wins. See `mergeVerdictVsGate`.
          parts.verdictVsGate = mergeVerdictVsGate(parts.verdictVsGate, attemptVerdict);
          if (!gated.passed) {
            log(`gate: FAILED at ${gated.failedStep}`);
            repairContext = { failedStep: gated.failedStep, output: gated.output };
          }
          result = gated;
          break;
        }

        case STAGE.PUBLISH: {
          const diff = await git.diffForGuard();
          guardResult = evaluateGuard(diff, config.guard);
          parts.guard = guardResult;
          if (!guardResult.passed) {
            log(`guard: ${guardResult.breaches.length} breach(es) — LAND will be withheld`);
          }
          const message = buildCommitMessage(parts.verdict, bead, guardResult);
          const committed = await git.commit(message);
          if (committed.code !== 0) {
            result = { ok: false };
            break;
          }
          // R7: AFTER the commit — lint-staged rewrote the staged bytes.
          parts.diffstat = await git.statOfHead();
          if (await git.lockfileChanged()) {
            result = { lockfileDrift: true };
            break;
          }
          // The result is CHECKED, unlike before: `commit` two lines up was
          // checked and this was not, so a rejected push (a stale remote
          // branch, a dropped network) fell through to `createPr`, which
          // throws — and that throw escaped the run entirely, losing every
          // remaining bead of an overnight `--until 8` to one transient error.
          const pushed = await git.push(bead.id, { force: attempt > 1 });
          if (pushed.code !== 0) {
            log(`publish: push FAILED — ${(pushed.stderr || pushed.stdout).trim().split('\n')[0]}`);
            result = { pushFailed: true };
            break;
          }
          // Captured AFTER the push: this is the commit CI will report on, and
          // asking about the PR instead is what made a repair read the previous
          // attempt's verdict 1.2 seconds later.
          parts.headSha = await git.headSha();
          // WHICH OTHER OPEN LOOP PRs THIS ONE WILL FIGHT — see
          // `overlappingPrs`. Advisory: a `gh` failure here says so and the
          // PUBLISH continues, because an overlap warning is worth strictly
          // less than the PR it decorates.
          //
          // AFTER THE COMMIT, deliberately. `changedPaths` diffs the INDEX
          // against the merge base, which is correct both before a commit and
          // after one (the index equals HEAD then) — and running it here rather
          // than reusing GATE's copy is what makes it the files this PR
          // actually carries, lint-staged's rewrites included.
          //
          // COMPUTED ON EVERY PUBLISH, but only the PR body of the FIRST one
          // carries it: `createPr` runs once per iteration. So a PR opened
          // before its rival existed is warned about on the LATER PR only,
          // which is the direction that matters — the second one to merge is
          // the one that has to rebase, and it is the one still being written.
          const listed = await forge.openLoopPrs();
          if (listed.error) {
            log(`publish: overlap check skipped — ${listed.error}`);
          } else {
            const overlaps = overlappingPrs(listed.prs, await git.changedPaths(), {
              excludeNumber: prNumber,
              excludeBranch: branchNameFor(bead.id),
            });
            // ASSIGNED UNCONDITIONALLY, and only inside this branch. A
            // repair republishes, and the rival PR may have MERGED in between
            // — assigning only when `overlaps.length` would leave attempt 1's
            // finding on the row after attempt 2 established it was no longer
            // true. An empty array is dropped by `buildRecord`, so clearing it
            // costs nothing; a `gh` that could not answer leaves the previous
            // reading alone, because "I could not tell" is not "there is none".
            parts.fileOverlaps = overlaps;
            if (overlaps.length) {
              for (const o of overlaps) {
                log(
                  `publish: file overlap — #${o.number} (${o.branch}) also touches ${o.files.join(', ')}`,
                );
              }
            }
          }
          // EXISTENCE, NOT ATTEMPT NUMBER. This read `attempt === 1`, which is
          // right for the repair it was written for — a CI-red retry force-
          // pushes to a branch whose PR is already open and must not open a
          // second. But `attempt` is bumped by ANY step returning `repair`, and
          // two of those never reach PUBLISH at all: a failed GATE
          // (machine.mjs `case STAGE.GATE`) and a turn-capped BUILD
          // (`cappedBuild`, Cebab-qd2.11). On both, attempt 2 is the FIRST
          // attempt to get here, so the branch was pushed and no PR was ever
          // opened — `prNumber` stayed null, WATCH then polled a SHA no PR
          // referenced, and the bead parked blaming CI.
          //
          // Measured on the overnight run of 2026-08-26: two of three beads,
          // $6.80 of completed gate-passing work stranded on the remote
          // (Cebab-qd2.18).
          if (!prNumber) {
            const pr = await forge.createPr({
              base: 'main',
              title: commitSubject(parts.verdict, bead.id),
              body: prBody(parts, bead, guardResult),
            });
            prNumber = pr.number;
            parts.pr = pr;
            if (!guardResult.passed && prNumber) await forge.addLabel(prNumber, 'loop-guard');
            log(`publish: ${pr.url}`);
          }
          result = { ok: true };
          break;
        }

        case STAGE.WATCH:
          result = await watchCi({
            forge,
            config,
            sha: parts.headSha,
            parts,
            log,
            halted,
            prNumber,
          });
          if (result.outcome === 'red') {
            const output = await forge.failingLog(parts.headSha, config.ci.requiredContext);
            // An empty log is not nothing to report: the repair is about to run
            // knowing only that "CI" failed, which is the same empty-brief
            // shape as a bead with no description. Say so rather than let the
            // attempt look informed.
            if (!output) log('watch: no failing job log found — the repair goes in blind');
            repairContext = { failedStep: 'CI', output };
          }
          break;

        case STAGE.LAND: {
          // `headSha` is the commit WATCH actually watched go green, and the
          // forge is told to refuse anything else — see `prMergeArgv`. `queued`
          // and `state` are carried through rather than dropped: a queued
          // auto-merge used to arrive here as `merged: true` and close the bead
          // on a prediction.
          const merged = await forge.merge(prNumber, { headSha: parts.headSha });
          parts.land = {
            merged: merged.merged,
            queued: Boolean(merged.queued),
            sha: merged.sha,
            state: merged.state ?? null,
          };
          if (merged.merged) log(`land: merged ${merged.sha ?? ''}`.trim());
          else if (merged.queued) log(`land: QUEUED — auto-merge is on, nothing has merged yet`);
          else log(`land: FAILED ${merged.error ?? ''}`);
          result = merged;
          break;
        }

        case STAGE.HARVEST:
          await harvest({ beads, bead, parts, disposition, reason, config, log });
          harvested = true;
          result = { disposition };
          break;

        default:
          throw new Error(`unreachable stage ${stage}`);
      }

      const step = next(stage, result, {
        halt: halted(),
        merge: config.loop.merge,
        dryRun,
        attempt,
        maxRepairs: config.loop.maxRepairs,
        guardPassed: guardResult.passed,
        treeChanged,
        capResumed: capResumes > 0,
      });
      // `repair` and `capped` are now separate facts and are handled apart. A
      // repair costs an attempt; a cap resume costs a `claude` invocation and
      // nothing else. `cappedBuild` no longer returns both.
      if (step.repair) attempt += 1;
      // A resumed turn cap carries no failing step; it must not inherit the
      // previous GATE failure's brief, and it must not be told "a previous
      // attempt failed the gate" when none did.
      if (step.capped) {
        capResumes += 1;
        repairContext = { capped: true };
      }
      if (step.disposition) disposition = step.disposition;
      if (step.reason) reason = step.reason;
      if (step.stage === STAGE.DONE) break;
      stage = step.stage;
    }
  } catch (error) {
    // ONE ITERATION MUST NOT END THE RUN. Everything above is a stage that can
    // throw — a forge call, a `gh` that could not authenticate, a bug here —
    // and an unattended `--until 8` that loses seven good beads to the first
    // transient failure is worse than one parked bead. The circuit breaker is
    // what stops this becoming an infinite loop of crashes: a crash parks, and
    // three parks halt.
    crashed = true;
    parts.crash = String(error?.stack ?? error).slice(-600);
    log(`iteration CRASHED — ${error?.message ?? error}`);

    // A CRASH AFTER SOMETHING LANDED MUST NOT REWRITE WHAT LANDED.
    //
    // This used to set `disposition = PARKED` unconditionally and then call
    // `harvest` again. HARVEST runs INSIDE the try, so the throw it is most
    // likely to catch is harvest's own — an unfileable follow-up throws by
    // design. The result was that a bead whose PR had merged seconds earlier
    // got re-harvested as a park: reopened, labelled `loop-stuck`, and excluded
    // from every future selection, with the ledger recording `parked` for an
    // iteration that had in fact merged to main.
    //
    // So a terminal that already ACTED on the world is preserved, and the crash
    // is recorded beside it rather than on top of it. The ledger then says
    // `merged` with a crash and `beadClosed: false`, which is both true and
    // actionable; `parked` was neither. `Cebab-qd2.23`.
    const landed = disposition === DISPOSITION.MERGED || disposition === DISPOSITION.MERGE_QUEUED;
    if (!landed) {
      disposition = DISPOSITION.PARKED;
      reason = REASON.CRASHED;
    }

    // And harvest is NOT re-run when harvest is what threw. Retrying it means
    // repeating whichever bd write failed, against a bead the first pass may
    // have already half-written.
    if (bead && !harvested && !landed) {
      try {
        await harvest({ beads, bead, parts, disposition, reason, config, log });
        harvested = true;
      } catch (harvestError) {
        log(`harvest after crash also failed — ${harvestError?.message ?? harvestError}`);
      }
    } else if (bead && harvested) {
      log('harvest had already run before the crash — not repeating it');
    }
  } finally {
    parts.disposition = disposition;
    if (reason) parts.reason = reason;

    // A HALTED BEAD IS HANDED BACK. HARVEST is the only stage that writes a
    // bead's status, and a halt routes straight to DONE without entering it —
    // so the bead the loop was holding kept `in_progress` with the loop as
    // assignee. `bd ready` excludes in_progress, so it did not merely get
    // skipped next run: it left the queue permanently, silently, while the
    // restore below deleted the branch its work was on.
    //
    // Measured 2026-08-26 on Cebab-vie.30: stopped mid-BUILD, and it has been
    // absent from `bd ready` ever since with nothing on the bead saying why.
    // Six independent audit lenses found this same path. `Cebab-qd2.22`.
    //
    // Release rather than park: `loop-stuck` means "a human must debug this",
    // and an interrupted bead has not failed at anything.
    // `!harvested` is load-bearing, not defensive. If HARVEST ran, the bead's
    // state is already whatever HARVEST decided — closed for a merge, parked
    // for a failure — and handing it back would UNDO that. The machine no
    // longer rewrites a post-HARVEST disposition to `halted`, so this cannot
    // fire today; it is the belt to that braces, because the two live in
    // different files and only one of them is obviously about the other.
    if (bead && !dryRun && !harvested && disposition === DISPOSITION.HALTED) {
      try {
        const released = await beads.release(
          bead.id,
          `Released by the autonomous loop: the run stopped (${reason ?? 'halt'}) while this ` +
            `bead was claimed. No work was published. Nothing is wrong with the bead itself.`,
        );
        parts.harvest = { ...(parts.harvest ?? {}), released };
        if (!released) log(`halt: could not hand ${bead.id} back — it is still in_progress`);
      } catch (error) {
        log(`halt: could not hand ${bead.id} back — ${error?.message ?? error}`);
      }
    }

    // Restoring per ITERATION, not only at teardown, is what stops the next
    // bead branching off this one — `newBranch` branches from whatever is
    // checked out, so bead 2's PR carried bead 1's commits and its diff
    // against main showed both. `restoreToMain` also CLEANS, because
    // `reset --hard` leaves untracked files behind and a file the agent
    // created otherwise survived onto main and made the next run's preflight
    // refuse to start.
    //
    // THIS RUNS BEFORE THE LEDGER APPEND, and it is wrapped so it cannot throw
    // past this point. The append is the evidence and a git failure must never
    // swallow it — the reason the two used to be in the other order. But the
    // restore's PULL is itself evidence: after a merged or queued iteration it
    // is the only thing that advances `main`, so `pulled: false` is the fact
    // that says every later bead of an `--until 8` would have branched from a
    // base missing what just landed. A record written before it could not carry
    // that, which is how a discarded return value stayed invisible.
    try {
      const restored = await git.restoreToMain();
      parts.restore = restored;
      if (!restored.pulled) {
        log(`iteration teardown: git pull --ff-only failed — ${restored.detail}`);
      }
      if (bead && !dryRun) await git.deleteBranch(bead.id);
    } catch (error) {
      parts.restore = { pulled: false, detail: String(error?.message ?? error).slice(0, 200) };
      log(`iteration teardown: could not return to main — ${error?.message ?? error}`);
    }

    // Only after something LANDED does a failed pull mean the next bead would
    // build on the wrong base. Before that, main is simply where it was.
    staleMain = landedOnStaleMain(disposition, parts.restore);

    if (bead) {
      const record = buildRecord(parts, Date.now());
      appendRecord(record, { appendLine: (line) => fs.appendFileSync(LEDGER_FILE, line) });
      if (deps.emitJson) process.stdout.write(`${JSON.stringify(record)}\n`);
    }
  }

  return {
    bead,
    disposition,
    reason,
    drained,
    staleMain,
    // A crash BEFORE SELECT assigned a bead is indistinguishable from a drained
    // queue in the caller's `if (!outcome.bead)` — and that branch stops the run
    // with exit 0. One transient `bd` failure therefore ended an --until 8 night
    // after zero iterations, reporting success and writing no ledger row (the
    // append below is also gated on `bead`). The caller needs to tell them
    // apart, so it is told. `Cebab-qd2.24`.
    crashed: crashed && !bead,
    ciGreen: parts.ci?.conclusion === 'success',
    // What THIS iteration filed, for the next one's prompt. `Cebab-7t6`.
    filed: parts.harvest?.filed ?? [],
  };
}

// ─── stage helpers ─────────────────────────────────────────────────────────

/**
 * WATCH outcomes that END the poll. `pending` is the only one that does not,
 * and `absent`/`timeout` are decided by the give-up branches further down.
 *
 * A SET rather than a chain of `||`, because it is the list the next outcome
 * has to be added to — the previous form named two of them inline and a third
 * (`blocked`) would have looked like an unrelated `if` several lines away.
 */
const TERMINAL_CI_OUTCOMES = new Set(['green', 'red', 'blocked', 'infra']);

/**
 * How many further polls an `infra` verdict is ignored for after the one
 * re-run. GitHub keeps serving the superseded check runs briefly, so without
 * this the loop reads its own stale payload as a second cancellation and parks
 * on the run it just asked for.
 */
const RERUN_GRACE_POLLS = 2;

async function watchCi({ forge, config, sha, parts, log, halted, prNumber }) {
  // REFUSE BEFORE THE FIRST POLL. Check runs belong to a pull request, so with
  // no PR there is nothing that could ever report and `absent` is true from the
  // first second to the last. Waiting the full window produced two 916-second
  // silences on 2026-08-26 and then named the runner as the suspect, which is
  // the wrong place entirely — the branch was on the remote and only
  // `gh pr create` had not run.
  //
  // Independent of the PUBLISH fix above and must stay independent: any future
  // way of reaching WATCH without a PR — a network blip, a branch-protection
  // rule, a rate limit — lands here too. `fail loud, park quietly`, and this is
  // the loud half.
  if (!prNumber) {
    log('watch: no pull request for this branch — refusing to wait for checks that cannot exist');
    return { outcome: 'no_pr' };
  }
  const startedAt = Date.now();
  let everFound = false;
  // ONE re-run per iteration, for an infrastructure cancellation only. The flag
  // lives here rather than in `forge` because the budget it protects is the
  // ITERATION's; a stateless helper would have to invent state to hold it.
  let rerunTried = false;
  let pollsSinceRerun = 0;
  for (;;) {
    if (halted()) return { outcome: 'pending', halted: true };
    const status = await forge.pollChecks(sha, config.ci.requiredContext);
    if (status.found) everFound = true;
    if (rerunTried) pollsSinceRerun += 1;

    if (status.outcome === 'infra') {
      const named = (status.failedSiblings ?? [])
        .map((f) => `${f.name} (${f.conclusion})`)
        .join(', ');
      if (!rerunTried) {
        rerunTried = true;
        pollsSinceRerun = 0;
        log(
          `watch: CI was killed rather than failed${named ? ` — ${named}` : ''}; re-running once`,
        );
        const again = await forge.rerunFailedChecks(sha, config.ci.requiredContext);
        if (again.ok) {
          await sleep(config.ci.pollIntervalMs);
          continue;
        }
        // Falls through to the terminal branch below: a re-run that could not
        // be started is reported, not retried.
        log(`watch: could not start a re-run — ${again.error}`);
      } else if (pollsSinceRerun <= RERUN_GRACE_POLLS) {
        // GitHub keeps serving the OLD completed check runs for a few seconds
        // after a re-run is queued, so an immediate second `infra` is the stale
        // payload rather than a second timeout. Counted in POLLS, not wall
        // clock, so the behaviour is the same under a test's scripted sequence
        // as it is against the live endpoint.
        await sleep(config.ci.pollIntervalMs);
        continue;
      }
    }

    if (TERMINAL_CI_OUTCOMES.has(status.outcome)) {
      parts.ci = {
        // UNCHANGED VOCABULARY. `conclusion` stays success/failure because 32
        // ledger rows already carry it; the finer answer is added ALONGSIDE, the
        // same call `build.totals` made rather than re-pointing what was there.
        conclusion: status.outcome === 'green' ? 'success' : 'failure',
        waitedMs: Date.now() - startedAt,
        runUrl: status.link ?? null,
        // Absent on an ordinary green or red, so `jq 'select(.ci.outcome)'` is
        // the query for "CI said something other than yes or no".
        ...(status.outcome === 'blocked' || status.outcome === 'infra'
          ? { outcome: status.outcome }
          : {}),
        ...(status.failedSiblings?.length ? { failedChecks: status.failedSiblings } : {}),
        ...(rerunTried ? { rerun: true } : {}),
      };
      if (status.outcome === 'blocked') {
        const named = (status.failedSiblings ?? [])
          .map((f) => `${f.name} (${f.conclusion})`)
          .join(', ');
        log(`watch: required context green, but another check is red — ${named}`);
      } else {
        log(`watch: ${status.outcome}`);
      }
      return { outcome: status.outcome };
    }
    const waited = Date.now() - startedAt;
    // Three outcomes, not two: a check that NEVER appeared is a repo or runner
    // problem, not this diff, so it is never repaired.
    //
    // But "not appeared YET" is not that. Cebab's required check `needs:` the
    // ubuntu+windows matrix, and GitHub creates no check run for a gated job
    // until its dependencies finish — measured at 11m23s on PR #402 against a
    // five-minute timeout, so this branch used to fire on every real run. A
    // pending sibling is proof CI is alive, so absence is only declared once
    // nothing at all is still moving.
    if (!everFound && !status.anyPending && waited > config.ci.appearTimeoutMs) {
      log(
        `watch: no '${config.ci.requiredContext}' check after ${Math.round(waited / 1000)}s ` +
          `and nothing else pending (${status.total ?? 0} check(s) seen)`,
      );
      return { outcome: 'absent' };
    }
    // NOT `absent`. A check that appeared and is still running has plainly
    // started, and reporting it as `ci_never_started` sent the morning triage
    // to look at the runner when the answer was `completeTimeoutMs`.
    if (waited > config.ci.completeTimeoutMs) {
      log(`watch: still pending after ${Math.round(waited / 1000)}s — giving up on this run`);
      return { outcome: 'timeout' };
    }
    await sleep(config.ci.pollIntervalMs);
  }
}

/**
 * FOUR TERMINAL STATES REACH A BEAD, NOT TWO.
 *
 * `merged` and `no_change_needed` close it. `parked` labels it. The other two
 * used to do NOTHING AT ALL, and one of them is the DEFAULT: `loop.merge` is
 * false, so `guard_withheld` is how an ordinary successful iteration ends. The
 * bead was left claimed with an open, green PR and nothing on the bead side
 * connecting the two — discoverable only from the PR inward, which after an
 * `--until 8` night is eight beads to correlate by hand.
 *
 * `merge_queued` is the same shape arriving from the opposite direction: the
 * merge is real but has not happened, so closing the bead would be closing it
 * on a prediction.
 *
 * BEAD WRITES ARE CHECKED NOW. `park` and `close` have always returned a
 * boolean and every caller dropped it. A failed park is the expensive one:
 * `loop-stuck` is the loop's ONLY cross-run memory, so without it the same
 * failing bead is selected again tomorrow night and fails again.
 */
async function harvest({ beads, bead, parts, disposition, reason, config, log }) {
  const noteFor = (headline) =>
    [
      headline,
      parts.pr?.url ? `PR: ${parts.pr.url}` : '',
      parts.ci?.runUrl ? `CI: ${parts.ci.runUrl}` : '',
      `Left claimed deliberately — the loop has no remaining work on this one.`,
    ]
      .filter(Boolean)
      .join('\n');

  if (disposition === DISPOSITION.MERGED) {
    parts.harvest.beadClosed = await beads.close(bead.id, parts.pr?.url ?? 'merged by the loop');
    if (!parts.harvest.beadClosed) {
      log(`harvest: bd close FAILED for ${bead.id} — the change IS merged; close it by hand`);
    }
  } else if (disposition === DISPOSITION.MERGE_QUEUED) {
    // Deliberately NOT closed. Auto-merge is enabled and the requirements are
    // not met yet; if it never lands, a closed bead would be the only record.
    parts.harvest.noted = await beads.note(
      bead.id,
      noteFor('Autonomous loop: auto-merge is ENABLED but nothing has merged yet.'),
    );
  } else if (disposition === DISPOSITION.GUARD_WITHHELD) {
    const why =
      reason === REASON.GUARD_BREACH
        ? 'the guard flagged the diff, so merging is a human decision'
        : 'merging is disabled for this run (--merge was not passed)';
    parts.harvest.noted = await beads.note(
      bead.id,
      noteFor(`Autonomous loop: PR opened and CI green — ${why}.`),
    );
  } else if (disposition === DISPOSITION.PARKED) {
    // A DECLINE IS NOT A FAILURE AND MUST NOT READ AS ONE.
    //
    // The predicate is the BREAKER'S OWN (`countsTowardDeclines`), shared so
    // the label and the counter cannot disagree about what a decline is —
    // Cebab-qd2.20 split the counters and left the labels conflated, which is
    // how an operator scanning `loop-stuck` could not tell a bead the loop
    // failed at from one it correctly judged out of scope.
    const declined = countsTowardDeclines(disposition, { reason });
    const evidence = [
      declined
        ? `Declined by the autonomous loop: the agent read this bead and judged it ` +
          `unsuitable for an unattended run. Nothing failed — no branch was published ` +
          `and no gate ran.`
        : `Parked by the autonomous loop: ${reason ?? 'unknown'}.`,
      // THE AGENT'S OWN REASONING, WHICH USED TO BE DROPPED HERE.
      //
      // Every other line below is empty for a decline: the build SUCCEEDED (it
      // returned a verdict whose outcome is a refusal), so `detail` is empty,
      // and no gate, CI or PR ever ran. So the note was the header and nothing
      // else — 43 characters standing for 5 to 24 turns of judgement, on a bead
      // the label then excludes from every future selection. `Cebab-qd2.36`.
      parts.verdict?.summary
        ? `The agent's account: ${String(parts.verdict.summary).slice(0, 600)}`
        : '',
      // `build.detail` is the ONLY evidence a park that never reached GATE
      // has. Measured on the first real max_turns park: the ledger carried
      // `inspect with \`claude --resume <session-id>\`` and the bead said
      // `Parked by the autonomous loop: max_turns.` and nothing else — the one
      // actionable fact was in the file nobody opens first. The three lines
      // below are all empty for a cap, because it never got that far.
      parts.build?.detail ? String(parts.build.detail).slice(0, 600) : '',
      // Cebab-qd2.14 put this on a max_turns park, where it lives inside
      // `detail`. A decline has no detail, so it got no way in — and a decline
      // is the park a human is most likely to want to argue with, which is
      // exactly what resuming the session lets them do. Suppressed when
      // `detail` already carries it rather than printed twice.
      resumeHint(parts),
      parts.gate?.steps?.length ? `Last gate step: ${parts.gate.steps.at(-1)?.name}` : '',
      parts.ci?.runUrl ? `CI: ${parts.ci.runUrl}` : '',
      parts.pr?.url ? `PR: ${parts.pr.url}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const label = declined ? DECLINE_LABEL : PARK_LABEL;
    const parked = await beads.park(bead.id, evidence, label);
    if (!parked) {
      parts.harvest.parkFailed = true;
      log(
        `harvest: bd park FAILED for ${bead.id} — it has no ${label} label, so the next ` +
          `run will select it again`,
      );
    }
  } else if (disposition === DISPOSITION.NO_CHANGE) {
    parts.harvest.beadClosed = await beads.close(
      bead.id,
      parts.verdict?.summary ?? 'no change needed',
    );
  }

  // Losing a finding is the failure mode this loop exists to fix, so a
  // follow-up that cannot be filed stops the whole run rather than being
  // dropped with a warning.
  //
  // `??=` rather than trusting the caller's literal: this threw
  // `Cannot read properties of undefined (reading 'push')` because `parts` was
  // built with `harvest: {}` two hundred lines away, and the crash landed on
  // the first follow-up any verdict carried. The initializer is fixed too, but
  // the coupling is what made one typo reach this far.
  parts.harvest.followUps ??= [];
  for (const followUp of parts.verdict?.follow_ups ?? []) {
    // ALREADY TRACKED IS AN OUTCOME, NOT A FAILURE TO SEARCH.
    //
    // The run of 2026-08-27 filed ten follow-ups, two PAIRS of which are the
    // same finding written twice. `Cebab-2pm` is the one that decides the fix:
    // its own title reads "Wire assistantSystemPrompt into runOneTurn (already
    // tracked as Cebab-03a)". The agent searched, FOUND the existing bead, and
    // filed anyway — so the gap was never that agents cannot see prior beads,
    // it is that HARVEST gave them no way to say so. It had to force the fact
    // into a title, where it becomes queue noise a later SELECT hands back as
    // work.
    //
    // Recorded rather than dropped: the ledger still says the agent noticed
    // something, and says which bead already covers it.
    const claimed = followUp.already_tracked?.trim?.() ?? '';
    if (claimed) {
      // THE ID IS VERIFIED, AND AN UNRESOLVABLE ONE FILES ANYWAY.
      //
      // Taking the string on trust would let the agent DISCARD a finding by
      // naming a bead that does not exist — a transposed character, or an id
      // half-remembered from the body it just read — three lines above a call
      // that THROWS rather than lose one. The whole reason this loop exists is
      // that findings get lost, so the safe direction is a duplicate bead, never
      // a silent drop. `beads.show` already returns null on a miss (bd exits 0
      // and prints an error OBJECT, which `show` handles by shape).
      const existing = await beads.show(claimed);
      if (existing) {
        // Title alongside the id: the ledger has to keep the claim, not just
        // the pointer, or a morning `jq` cannot recover what was noticed.
        (parts.harvest.alreadyTracked ??= []).push({ id: claimed, title: followUp.title });
        log(`harvest: "${followUp.title}" is already tracked as ${claimed} — not filed`);
        continue;
      }
      log(
        `harvest: "${followUp.title}" claims to be tracked as ${claimed}, which does not ` +
          `exist — filing it rather than losing it`,
      );
    }
    const id = await beads.fileFollowUp(followUp, bead.id, config.harvest);
    if (!id) throw new Error(`could not file follow-up "${followUp.title}" — refusing to lose it`);
    parts.harvest.followUps.push(id);
    // Title alongside the id: the next iteration's agent is a fresh process
    // that has never seen this bead, and `Cebab-8x8.4.1` on its own is not
    // something it can compare a finding against.
    (parts.harvest.filed ??= []).push({ id, title: followUp.title });
    log(`harvest: filed ${id}`);
  }
}

function buildCommitMessage(verdict, bead, guardResult) {
  const lines = [commitSubject(verdict, bead.id), '', verdict.summary];
  if (!guardResult.passed) {
    lines.push('', 'Guard breaches (LAND withheld):');
    for (const b of guardResult.breaches) lines.push(`  ${b.rule}: ${b.detail}`);
  }
  lines.push('', 'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>');
  return lines.join('\n');
}

/**
 * The one section of the PR body that is about a DIFFERENT pull request.
 *
 * Empty for the overwhelming majority of iterations, which is why it is a
 * spread rather than a conditional line: an empty heading with nothing under it
 * reads as "checked, none" only to someone who knows the check exists.
 *
 * Written for the human doing the merging, so it names the ORDER problem rather
 * than the file list alone — whichever of the two lands second is the one that
 * conflicts, and that is the decision this note exists to inform.
 */
function overlapSection(parts) {
  const overlaps = parts.fileOverlaps ?? [];
  if (overlaps.length === 0) return [];
  return [
    '## Overlapping open loop PRs',
    '',
    'Other open `loop/*` pull requests touch files this branch also touches.',
    'Whichever merges second will have to be rebased — merge order matters here.',
    '',
    ...overlaps.map(
      (o) => `- #${o.number} (\`${o.branch}\`) — ${o.files.map((f) => `\`${f}\``).join(', ')}`,
    ),
    '',
  ];
}

function prBody(parts, bead, guardResult) {
  const reddened = (parts.gate?.attempts ?? []).filter((a) => a.passed === false);
  const steps = (parts.gate?.steps ?? [])
    .map((s) => `| ${s.name} | ${s.exitCode === 0 ? '✅' : '❌'} | ${s.ms ?? 0} ms |`)
    .join('\n');
  return [
    `**${bead.id} — ${bead.title}**`,
    '',
    parts.verdict?.summary ?? '',
    '',
    '## Gate',
    '',
    '| step | | |',
    '|---|---|---|',
    steps,
    '',
    // THE TABLE ABOVE IS THE LAST RUN, and without this line a reader has no
    // way to tell a gate that passed first time from one that was repaired —
    // which is also the only thing that explains a `disagree` verdict sitting
    // under ten green rows. `Cebab-qd2.43`.
    reddened.length
      ? `Gate reddened on ${reddened
          .map((a) => `attempt ${a.attempt} at \`${a.failedStep}\``)
          .join(', ')}, and passed on a later run.`
      : '',
    '',
    ...overlapSection(parts),
    '## Guard',
    '',
    guardResult.passed
      ? 'No breaches.'
      : guardResult.breaches.map((b) => `- **${b.rule}** — ${b.detail}`).join('\n'),
    '',
    guardResult.passed ? '' : '**LAND withheld.** Merge is a human decision for this diff.',
    '',
    `Agent verdict vs re-run gate: \`${parts.verdictVsGate}\`.`,
    '',
    '🤖 Opened by the autonomous loop (`scripts/loop.mjs`)',
  ].join('\n');
}

/**
 * `claude --resume <id>`, unless the evidence already carries it.
 *
 * The duplicate is not hypothetical: `build.mjs` puts this exact command inside
 * a max_turns `detail`, and that detail is the line above this one in the same
 * note. Keyed on the SESSION ID rather than on the flag, so a future wording
 * change to either side cannot make them both print.
 */
function resumeHint(parts) {
  const sessionId = parts.build?.sessionId;
  if (!sessionId) return '';
  if (String(parts.build?.detail ?? '').includes(sessionId)) return '';
  return `Inspect or continue the agent's session: claude --resume ${sessionId}`;
}

/**
 * What a BUILD consumed, added to the run's totals.
 *
 * TOKENS AND TURNS, NOT DOLLARS. The loop runs on a subscription: a price for a
 * transaction that never happens says nothing about the usage window an
 * overnight run actually spends. `costUsd` is still recorded per row in the
 * ledger — it is the CLI's own number — and is printed nowhere.
 *
 * `addTokens` treats a null addend as zero, which is what keeps an unparseable
 * envelope from poisoning the run total while still recording `null` on that
 * bead's own row: unknown and free are different facts and the ledger keeps
 * them apart.
 */
function account(ctx, built) {
  ctx.tokens = addTokens(ctx.tokens, built.tokens);
  ctx.turns += built.numTurns ?? 0;
}

/** One line per `claude` invocation, in the units the operator actually has. */
function logUsage(log, bead, attempt, built) {
  log(
    `usage: ${bead.id} attempt ${attempt} — ` +
      formatUsage({
        turns: built.numTurns ?? null,
        ms: built.durationMs ?? null,
        tokens: built.tokens ?? null,
      }),
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(LOOP_DIR, { recursive: true });

  if (args.status) return printStatus();

  const fileConfig = readConfigFile(args.configPath);
  const cliConfig = {};
  if (args.flags.merge) cliConfig.loop = { merge: true };
  if (args.noPlayground) cliConfig.gate = { playgroundTier: 'never' };
  const config = resolveConfig({ file: fileConfig, cli: cliConfig });

  const now = Date.now();
  const untilRaw = args.until.length > 0 ? args.until : config.loop.until;
  const conditions = untilRaw.map((value) => parseUntil(value, now));

  // Spec §5: "--json  Emit one ledger record per line on stdout INSTEAD of human
  // output". It only ever ADDED, so a consumer reading stdout as JSONL hit
  // `[loop] select: ...` on line one. Sending the human stream to STDERR keeps
  // both useful: stdout becomes the clean JSONL the spec promises, and the
  // lines stay visible in a terminal and in `2>&1 | tee`. `Cebab-qd2.28`.
  const sink = args.json ? process.stderr : process.stdout;
  const log = (message) => sink.write(`[loop] ${message}\n`);
  // ONE application point for the whole run — see `env.mjs`. Every subprocess
  // the loop spawns goes through this runner, so the `claude` turns cannot be
  // routed to paid billing by a stray shell export. `Cebab-qd2.29`.
  const scrubbed = scrubbedFrom(process.env);
  if (scrubbed.length > 0) {
    // NAMES only, never values.
    log(`env: stripped ${scrubbed.join(', ')} — agent turns use the OAuth subscription`);
  }
  const run = makeRunner({
    cwd: REPO_ROOT,
    env: subscriptionOnlyEnv(process.env),
    onLine: args.verbose ? (c) => process.stdout.write(c) : undefined,
  });
  const git = makeGit({ run, cwd: REPO_ROOT, dryRun: args.dryRun });

  // READ BEFORE PREFLIGHT, WHICH IS THE THING THAT MOVES IT. Preflight's
  // `git pull --ff-only` is required — it is what stops beads being built on a
  // stale base — and it rewrites the very files this process imported at
  // startup. See `self_update.mjs` for the measurement.
  const headBefore = await git.headSha();

  const { bd } = await preflight({ run, config, git, dryRun: args.dryRun });

  const restarted = process.env[REEXEC_ENV] === '1';
  const plan = reexecPlan({
    headBefore,
    headAfter: await git.headSha(),
    alreadyReexeced: restarted,
  });
  if (plan.headUnknown) {
    log('preflight: could not read HEAD — this run cannot record which driver revision it is');
  }
  if (plan.action === 'refuse') {
    // Two moves inside two consecutive preflights is not "someone merged while
    // I was starting"; a third process would be an unbounded restart loop.
    throw new ConfigError(
      `main moved again during preflight (${short(plan.from)} -> ${short(plan.to)}) after this ` +
        `driver had already restarted once. Re-run the loop.`,
    );
  }
  if (plan.action === 'reexec') {
    log(
      `preflight pulled main ${short(plan.from)} -> ${short(plan.to)}, so this process is ` +
        `running the OLD driver. Restarting on the pulled one — no bead has been claimed and ` +
        `no lock is held yet.`,
    );
    return await reexecSelf({ log });
  }
  const driverRevision = plan.headUnknown ? null : headBefore;

  // One run per checkout. Taken AFTER preflight (so a refusal costs nothing)
  // and BEFORE any spawn, because the thing being protected is the working
  // tree that BUILD is about to edit.
  acquireLock(LOOP_DIR, { log });

  const deps = {
    config,
    dryRun: Boolean(args.dryRun),
    emitJson: Boolean(args.json),
    // Onto every ledger row, so "the fix did not fire" and "the fix does not
    // work" stop looking identical the next morning. `Cebab-qd2.35`.
    driverRevision,
    driverRestarted: restarted,
    beads: makeBeads({ run, bd, cwd: REPO_ROOT, dryRun: args.dryRun }),
    git,
    forge: makeForge({ run, cwd: REPO_ROOT, dryRun: args.dryRun }),
    gate: makeGate({ run, cwd: REPO_ROOT, config, log }),
    build: makeBuild({ run, cwd: REPO_ROOT, config, libDir: LIB_DIR, loopDir: LOOP_DIR, log }),
  };

  // WHAT THE LAST RUN LEFT BEHIND, before this one reads the queue.
  //
  // Here rather than inside `preflight` for a mechanical reason: preflight runs
  // before `acquireLock` and before `deps` exists, and it must — a refusal has
  // to cost nothing and take no lock. This needs `beads` and `forge`, so it is
  // the first thing after both, and after the lock, because it WRITES.
  //
  // Failure is swallowed on purpose. Reconciling is housekeeping about previous
  // runs; a bd or gh hiccup here must not stop this run doing its actual work,
  // and everything it would have done stays true for the next attempt.
  try {
    await reconcile({
      beads: deps.beads,
      forge: deps.forge,
      rows: readLedger(),
      // `0` IS bd's NO-LIMIT, and 200 made this whole half report nothing.
      // Measured 2026-08-28 with the real DEFAULTS.select: `-n 200` returns
      // exactly 200 of 207 ready rows and drops `Cebab-vie.28` and
      // `Cebab-vie.29` — which are this module's own documented positive
      // controls, the two beads that parked without their label landing. bd
      // prints `Showing 200 of 207 ready issues` to STDERR and leaves stdout
      // valid JSON, so nothing threw and the pass reported a clean empty set.
      // Worse than a constant wrong answer: `hybrid` mixes priority and age, so
      // whether a parked bead falls inside the cap changes run to run.
      readySet: async () =>
        new Set((await deps.beads.ready(config.select, 0)).map((row) => row.id)),
      remoteLoopBeads: () => git.remoteLoopBeads(),
      log,
      dryRun: Boolean(args.dryRun),
    });
  } catch (error) {
    log(`reconcile: skipped — ${error?.message ?? error}`);
  }

  const ctx = {
    parked: new Set(),
    // WHAT THE RUN CONSUMED, IN THE UNITS THE OPERATOR HAS. This was
    // `spentUsd`, which prices a transaction that never happens on a
    // subscription. `usage.mjs` carries the full reasoning, including why plan
    // rate-limit utilization — the number that would actually answer "how much
    // of my week did this eat" — is not reachable from `claude -p`.
    tokens: { ...ZERO_TOKENS },
    turns: 0,
    // PER-RUN, deliberately. This used to be seeded from state.json, and a
    // checkout that once had three parks could then never run again — a fresh,
    // fully successful run halted on its first iteration against a counter
    // left by a previous one. §9.2 wanted the breaker to survive a *restart*;
    // it survived forever, with no reset path but hand-editing the file.
    //
    // Restarting the loop is itself an operator intervention, and the
    // cross-run memory already exists elsewhere: HARVEST labels a parked bead
    // `loop-stuck` and SELECT excludes that label. Persisting the counter as
    // well double-counted the same evidence.
    consecutiveParks: 0,
    // Counted apart from parks — see `countsTowardDeclines`. Per-run for the
    // same reason the park counter is: restarting the loop is itself an
    // operator intervention.
    consecutiveDeclines: 0,
    declinedThisRun: new Set(),
    // WHAT THIS RUN HAS ALREADY FILED. Each iteration is a fresh `claude -p`
    // with no memory of its siblings, so a bead a sibling filed minutes earlier
    // is in the DB and nothing prompts a search against it. Carried into the
    // BUILD prompt so the agent can see them. `Cebab-7t6`.
    followUpsThisRun: [],
    forcedBead: args.bead,
    startedAt: now,
  };

  let exitCode = EXIT.OK;
  let iterations = 0;
  let stopBecause;

  const teardown = async () => {
    // Every terminating path lands here, and the order matters: discard
    // first, THEN checkout. `git checkout main` with uncommitted changes
    // either refuses or carries them across, so resetting afterwards is one
    // step too late — and under `--dry-run` there are always such changes,
    // since BUILD runs but branch creation does not.
    if (!(await git.isClean())) log('teardown: discarding uncommitted changes');
    await git.restoreToMain();
    if (!(await git.isClean())) {
      log('teardown: tree still dirty after checkout — resetting (a stage leaked)');
      await git.restoreToMain();
    }
    await run('node', ['scripts/predev-server.mjs'], { cwd: REPO_ROOT, timeoutMs: 30000 }).catch(
      () => {},
    );
    // `exitCode` and `stopBecause` are closed over from `main` and are final by
    // the time this runs — teardown is in main's `finally`, after every break.
    writeState(ctx, iterations, { code: exitCode, because: stopBecause });
    releaseLock(LOOP_DIR);
  };

  // A BROKEN STDOUT MUST NOT KILL THE RUN, AND IT DID.
  //
  // `loop:night` pipes the driver into `tee`. A signal delivered to the tmux
  // pane goes to the whole foreground PROCESS GROUP, so `tee` — which handles
  // nothing — dies first, and the driver's next log write lands on a closed
  // pipe. An unhandled EPIPE on `process.stdout` surfaces as an
  // uncaughtException while `main()` is still pending, so the process exits
  // WITHOUT unwinding, and the teardown in the `finally` below never runs.
  //
  // Measured 2026-08-26: a killed run left the lock held, the tree dirty on a
  // loop branch, no ledger row for the in-flight bead, and the
  // `signal received` line itself lost in the dead pipe (Cebab-qd2.17).
  //
  // Swallowing is right here because there is nothing to report to: the sink
  // is gone. The run continues and its durable records — the ledger, the bead,
  // the PR — are unaffected by having no console.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error) => {
      if (error?.code !== 'EPIPE') throw error;
    });
  }

  const onSignal = (code) => () => {
    if (signalled) process.exit(code);
    signalled = true;
    log('signal received — finishing the current stage, then stopping');
    exitCode = code;
  };
  process.on('SIGINT', onSignal(EXIT.SIGINT));
  process.on('SIGTERM', onSignal(143));

  try {
    for (;;) {
      if (signalled) {
        stopBecause = 'signal';
        break;
      }
      if (fs.existsSync(HALT_FILE)) {
        stopBecause = 'HALT';
        break;
      }
      const tripped = firstTripped(conditions, { iterations, now: Date.now(), drained: false });
      if (tripped) {
        stopBecause = `--until ${tripped.raw}`;
        break;
      }
      const blocked = reserveBlocks(conditions, { now: Date.now() }, config.limits.reserveMs);
      if (blocked) {
        stopBecause = `less than ${Math.round(config.limits.reserveMs / 60000)} min before --until ${blocked.raw}`;
        break;
      }
      // Input + output + cache WRITES — `meteredTokens` owns that definition and
      // the reason cache reads are excluded from it.
      if (config.limits.tokenCeiling && meteredTokens(ctx.tokens) >= config.limits.tokenCeiling) {
        stopBecause = `token ceiling ${config.limits.tokenCeiling}`;
        exitCode = EXIT.HALTED;
        break;
      }

      const outcome = await runIteration({ ctx, deps, log });
      if (!outcome.bead) {
        // `fail loud, park quietly` — and a run that ends before it ever picked
        // up work has nothing to park, so this is the loud half.
        if (outcome.crashed) {
          log('crashed before a bead was selected — see the stack above. Nothing was attempted.');
          stopBecause = 'crashed before SELECT';
          exitCode = EXIT.HALTED;
          break;
        }
        stopBecause = outcome.drained ? 'nothing ready to work' : 'no bead';
        break;
      }
      iterations += 1;
      // Accumulated across the run so each later BUILD prompt can name what its
      // siblings already filed. Bounded below at render time, not here — the
      // whole list is worth keeping for the ledger's sake.
      ctx.followUpsThisRun.push(...(outcome.filed ?? []));

      if (outcome.disposition === DISPOSITION.PARKED) ctx.parked.add(outcome.bead.id);
      // `ciGreen` is what makes a WITHHELD iteration count as evidence. With
      // `merge: false` — the default — every fully successful iteration ends
      // withheld, and a breaker that neither counted nor reset those halted
      // runs reporting "3 consecutive parks" for parks that were interleaved
      // with three complete successes.
      if (resetsBreaker(outcome.disposition, { ciGreen: outcome.ciGreen })) {
        ctx.consecutiveParks = 0;
      } else if (countsTowardBreaker(outcome.disposition, { reason: outcome.reason })) {
        ctx.consecutiveParks += 1;
      }
      // A decline neither counts toward the breaker nor resets it — it is
      // neutral evidence about the LOOP and direct evidence about the QUEUE.
      if (countsTowardDeclines(outcome.disposition, { reason: outcome.reason })) {
        ctx.consecutiveDeclines += 1;
        ctx.declinedThisRun.add(outcome.bead.id);
      } else {
        ctx.consecutiveDeclines = 0;
        ctx.declinedThisRun.clear();
      }
      writeState(ctx, iterations);

      if (outcome.disposition === DISPOSITION.HALTED) {
        stopBecause = 'halted mid-iteration';
        exitCode = EXIT.HALTED;
        break;
      }
      // Something landed and `main` did not move. Every later bead would branch
      // from a base that is missing it, so the run stops rather than compounding
      // that seven more times.
      if (outcome.staleMain) {
        log(
          `${REASON.STALE_MAIN}: ${outcome.bead.id} landed but git pull --ff-only failed, so ` +
            `main does not contain it. Stopping rather than building the next bead on a ` +
            `stale base.`,
        );
        stopBecause = REASON.STALE_MAIN;
        exitCode = EXIT.HALTED;
        break;
      }
      // The queue, not the loop. Everything downstream of SELECT is provably
      // working — bd answered, the agent spawned, read each brief and judged it
      // — so the message must not read as a malfunction, and the remedy is to
      // label or reshape beads rather than to go looking at the runner.
      if (ctx.consecutiveDeclines >= config.loop.consecutiveDeclineLimit) {
        const named = [...ctx.declinedThisRun];
        log(
          `queue: ${ctx.consecutiveDeclines} consecutive beads declined as needs_human` +
            (named.length > 0 ? ` — ${named.join(', ')}` : '') +
            `. The loop is working; the ready queue is not suitable for it. ` +
            `Label these \`needs-human\` so SELECT skips them, or give them the ` +
            `detail an agent would need.`,
        );
        stopBecause = 'queue unsuitable';
        exitCode = EXIT.HALTED;
        break;
      }
      if (ctx.consecutiveParks >= config.loop.consecutiveParkLimit) {
        // Naming the beads is the whole point of the message — the common
        // cause is systemic and the operator needs to see which three.
        const named = [...ctx.parked];
        log(
          `circuit breaker: ${ctx.consecutiveParks} consecutive parks` +
            (named.length > 0 ? ` — ${named.join(', ')}` : ' (see .loop/runs.jsonl)'),
        );
        stopBecause = 'circuit breaker';
        exitCode = EXIT.HALTED;
        break;
      }
      if (args.dryRun) {
        stopBecause = 'dry run';
        break;
      }
      if (config.limits.cooldownMsBetweenBeads > 0)
        await sleep(config.limits.cooldownMsBetweenBeads);
    }
  } finally {
    await teardown();
  }

  log(
    `stopped: ${stopBecause ?? 'done'} — ${iterations} iteration(s), ` +
      `${formatUsage({ turns: ctx.turns, tokens: ctx.tokens })}`,
  );

  // ── the run's own report, and the verification behind it ────────────────
  //
  // AFTER teardown, deliberately. Two of the sweeps ask whether the repository
  // was left on main with a clean tree, and running before teardown would
  // measure the state teardown exists to fix — a check that reports the
  // problem it is about to not have.
  //
  // WRAPPED WHOLE. This is the last thing a run does and it is a REPORT: a
  // throw here would turn eight merged beads into a non-zero exit and a stack
  // trace, which is worse than the silence it replaces. `report.mjs` already
  // guards every individual lookup; this is the backstop for the rest.
  try {
    const runRows = rowsSince(readLedger(), new Date(ctx.startedAt).toISOString());
    const { findings, blocked } = await verifyRun({
      rows: runRows,
      git,
      forge: deps.forge,
      beads: deps.beads,
      log,
    });
    sink.write(
      `${renderReport({
        rows: runRows,
        findings,
        usageLine: formatUsage({ turns: ctx.turns, tokens: ctx.tokens }),
        stopBecause: stopBecause ?? 'done',
        elapsedMs: Date.now() - ctx.startedAt,
      })}\n`,
    );
    // THE ONE ESCALATION. A row claiming a merge whose commit is not in main
    // means the loop's picture of the codebase is wrong, and every later bead
    // branches from main — so the NEXT run must not start until a human looks.
    // Reuses `.loop/HALT`, which preflight already refuses to start on and
    // `npm run loop:recover` already clears; a second mechanism would be a
    // second thing to remember.
    if (blocked && !fs.existsSync(HALT_FILE)) {
      fs.writeFileSync(
        HALT_FILE,
        'the end-of-run check found a merge recorded in the ledger that is NOT in ' +
          'origin/main. See the report above. Remove this file to start again.\n',
      );
      log('verify: wrote .loop/HALT — the next run will refuse to start until you clear it');
    }
  } catch (error) {
    log(`report: could not be produced — ${error?.message ?? error}`);
  }

  return exitCode;
}

/** First seven of a sha, or the value itself when it is not one. */
const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 7) : String(sha));

/**
 * Restart this driver on the revision preflight just pulled, and hand back its
 * exit code. `self_update.mjs` has the measurement and the reasoning.
 *
 * Node cannot replace its own image, so this is spawn-and-wait rather than
 * `execve`. The parent becomes a thin shell that owns nothing: no lock, no
 * claimed bead, no open PR — the whole reason the decision is made here, in the
 * window between preflight and `acquireLock`.
 */
function reexecSelf({ log }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, reexecArgv(process.argv), {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: reexecEnv(process.env),
    });
    // FORWARDED RATHER THAN ASSUMED. With `stdio: 'inherit'` a Ctrl-C in a
    // terminal already reaches the whole foreground process group, so the child
    // would see it anyway — but `loop:night` runs under tmux and a `kill <pid>`
    // aimed at this process alone would otherwise leave the child running a
    // bead with nothing watching it.
    const forward = (signal) => () => {
      try {
        child.kill(signal);
      } catch {
        // Already gone; the exit handler below is what resolves either way.
      }
    };
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, forward(signal));
    child.on('error', (error) => {
      log(`restart failed — ${error?.message ?? error}. Nothing was attempted.`);
      resolve(EXIT.HALTED);
    });
    child.on('exit', (code, signal) => {
      if (signal) resolve(signal === 'SIGINT' ? EXIT.SIGINT : 143);
      else resolve(code ?? EXIT.HALTED);
    });
  });
}

/**
 * @param {object} exit  `{ code, because }` on the way out, or null mid-run.
 *
 * THE EXIT CODE IS RECORDED HERE BECAUSE NOTHING ELSE CAN SEE IT. `loop:night`
 * is `... node scripts/loop.mjs ... | tee -a .loop/console.log`, and a shell
 * pipeline exits with the status of its LAST command — always `tee`'s,
 * effectively always 0. Measured 2026-08-26: a run stopped by `loop:stop` took
 * the halted branch, which sets EXIT.HALTED, and the pipeline reported 0.
 *
 * That matters more than it looks, because exit codes are one of the loop's two
 * fail-loud channels and recent work kept ADDING to them — the circuit breaker,
 * the stale-main halt, the queue-unsuitable halt, and a crash before SELECT,
 * which was changed FROM a silent exit 0 precisely because a silent exit 0 was
 * the bug. All of it was invisible to anything invoking `loop:night`.
 *
 * Writing it to state.json rather than fixing the shell composes with what is
 * already durable, survives the pane closing, and needs no `pipefail` (which
 * `sh -c` does not guarantee). `--status` reads it back. `Cebab-qd2.27`.
 */
function writeState(ctx, iterations, exit = null) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        consecutiveParks: ctx.consecutiveParks,
        consecutiveDeclines: ctx.consecutiveDeclines,
        parkedThisRun: [...ctx.parked],
        // NOT `spentUsd`. See `usage.mjs`: on a subscription a dollar figure is
        // a price for a transaction that never happens, and the operator's real
        // constraint is a usage window measured in tokens.
        tokens: ctx.tokens,
        turns: ctx.turns,
        iterations,
        startedAt: new Date(ctx.startedAt).toISOString(),
        exitCode: exit ? exit.code : null,
        stoppedBecause: exit ? (exit.because ?? null) : null,
      },
      null,
      2,
    ),
  );
}

function printStatus() {
  const state = readJson(STATE_FILE, null);
  if (!state) process.stdout.write('no .loop/state.json — the loop has not run here yet\n');
  else {
    process.stdout.write(`${JSON.stringify(withoutLegacyCost(state), null, 2)}\n`);
    // The four token classes are printed apart, never summed. A cache read is
    // roughly an order of magnitude cheaper than fresh input and dominates the
    // raw total by 10-40x on this workload, so one number here would mostly
    // measure the discount. `usage.mjs` owns that reasoning.
    process.stdout.write(
      `\nconsumed this run: ${formatUsage({ turns: state.turns ?? 0, tokens: state.tokens })}\n`,
    );
  }
  // `readLedger`, not a second bare `JSON.parse` loop: a run killed mid-append
  // leaves a partial last line, and `--status` is the first thing an operator
  // reaches for after exactly that. It used to throw a SyntaxError into the
  // top-level catch and exit HALTED instead of printing the last ten rows.
  const rows = readLedger().slice(-10);
  if (rows.length > 0) process.stdout.write('\nlast iterations:\n');
  for (const r of rows) {
    process.stdout.write(
      `  ${r.ts}  ${r.bead ?? '-'}  ${r.disposition ?? '-'}  ${r.pr?.url ?? ''}\n`,
    );
  }
  return EXIT.OK;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      if (error instanceof ConfigError || error instanceof LockHeldError) {
        process.stderr.write(`loop: ${error.message}\n`);
        process.exit(EXIT.REFUSED);
      }
      process.stderr.write(`loop: ${error?.stack ?? error}\n`);
      process.exit(EXIT.HALTED);
    });
}

export { EXIT, harvest, main, prBody, preflight, readLedger, watchCi };
