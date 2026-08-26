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
  landedOnStaleMain,
  next,
  resetsBreaker,
} from './lib/loop/machine.mjs';
import { evaluateGuard } from './lib/loop/guard.mjs';
import { chooseBead, denyPathStems } from './lib/loop/select.mjs';
import { appendRecord, buildRecord, compareVerdictToGate } from './lib/loop/ledger.mjs';
import { makeRunner } from './lib/loop/run.mjs';
import { LockHeldError, acquireLock, releaseLock } from './lib/loop/lock.mjs';
import { makeBeads } from './lib/loop/beads.mjs';
import { branchNameFor, commitSubject, makeGit } from './lib/loop/git.mjs';
import { makeForge } from './lib/loop/forge.mjs';
import { assertPlaygroundEnv, makeGate } from './lib/loop/gate.mjs';
import { makeBuild } from './lib/loop/build.mjs';

const LIB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'loop');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOP_DIR = path.join(REPO_ROOT, '.loop');
const HALT_FILE = path.join(LOOP_DIR, 'HALT');
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
  const parts = { build: {}, gate: {}, guard: {}, harvest: { beadClosed: false, followUps: [] } };
  let stage = STAGE.SELECT;
  let bead = null;
  let attempt = 1;
  let disposition = null;
  let reason = null;
  let prNumber = null;
  let guardResult = { passed: true, breaches: [] };
  let sessionId = null;
  let drained = false;
  let repairContext = null;
  let treeChanged = null;
  // Assigned in the `finally`, which every path reaches — an initializer here
  // is dead, and eslint's no-useless-assignment says so.
  let staleMain;

  const halted = () => fs.existsSync(HALT_FILE);

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
            bead = chooseBead(rows, {
              select: config.select,
              denyStems: denyPathStems(config.guard.denyPaths),
              parked: ctx.parked,
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

        case STAGE.CLAIM:
          result = { ok: await beads.claim(bead.id) };
          if (result.ok) await git.newBranch(bead.id);
          break;

        case STAGE.BUILD: {
          const built = await build.run({
            bead,
            attempt,
            maxRepairs: config.loop.maxRepairs,
            failedStep: repairContext?.failedStep,
            failureOutput: repairContext?.output,
            resumeSessionId: sessionId,
            capped: repairContext?.capped === true,
          });
          if (built.usageLimit) {
            // A limited attempt still SPENT. Breaking out before accounting for
            // it let `costCeilingUsd` under-report exactly the case the
            // operator most wants a number for.
            sessionId = built.sessionId ?? sessionId;
            ctx.spentUsd += built.costUsd ?? 0;
            parts.build = {
              sessionId,
              numTurns: built.numTurns ?? null,
              costUsd: built.costUsd ?? null,
              exitCode: built.exitCode ?? null,
              attempts: attempt,
            };
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
            exitCode: built.exitCode ?? null,
            outcome: built.verdict?.outcome ?? null,
            risk: built.verdict?.risk ?? null,
            attempts: attempt,
          };
          // Accounted whatever happened. A failed build still SPENT, and
          // counting only successes let `costCeilingUsd` under-report by
          // exactly the runs the operator most wants to know about.
          ctx.spentUsd += built.costUsd ?? 0;
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
          treeChanged = built.failure === 'max_turns' ? !(await git.isClean()) : null;
          result = built;
          break;
        }

        case STAGE.GATE: {
          const changedPaths = await git.changedPaths();
          const gated = await gate.run({ changedPaths });
          parts.gate = {
            steps: gated.steps,
            playgroundRan: gated.playgroundRan,
            liveSmokesRan: gated.liveSmokesRan,
          };
          parts.verdictVsGate = compareVerdictToGate(parts.commandsRun ?? [], gated.steps);
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
          if (attempt === 1) {
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
          result = await watchCi({ forge, config, sha: parts.headSha, parts, log, halted });
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
      });
      if (step.repair) attempt += 1;
      // A resumed turn cap carries no failing step; it must not inherit the
      // previous GATE failure's brief, and it must not be told "a previous
      // attempt failed the gate" when none did.
      if (step.capped) repairContext = { capped: true };
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
    disposition = DISPOSITION.PARKED;
    reason = REASON.CRASHED;
    parts.crash = String(error?.stack ?? error).slice(-600);
    log(`iteration CRASHED — ${error?.message ?? error}`);
    if (bead) {
      // Park the bead too, so SELECT skips it next time. Its own failure must
      // not replace the crash we are already reporting.
      try {
        await harvest({ beads, bead, parts, disposition, reason, config, log });
      } catch (harvestError) {
        log(`harvest after crash also failed — ${harvestError?.message ?? harvestError}`);
      }
    }
  } finally {
    parts.disposition = disposition;
    if (reason) parts.reason = reason;

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

  return { bead, disposition, drained, staleMain, ciGreen: parts.ci?.conclusion === 'success' };
}

// ─── stage helpers ─────────────────────────────────────────────────────────

async function watchCi({ forge, config, sha, parts, log, halted }) {
  const startedAt = Date.now();
  let everFound = false;
  for (;;) {
    if (halted()) return { outcome: 'pending', halted: true };
    const status = await forge.pollChecks(sha, config.ci.requiredContext);
    if (status.found) everFound = true;
    if (status.outcome === 'green' || status.outcome === 'red') {
      parts.ci = {
        conclusion: status.outcome === 'green' ? 'success' : 'failure',
        waitedMs: Date.now() - startedAt,
        runUrl: status.link ?? null,
      };
      log(`watch: ${status.outcome}`);
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
    const evidence = [
      `Parked by the autonomous loop: ${reason ?? 'unknown'}.`,
      parts.gate?.steps?.length ? `Last gate step: ${parts.gate.steps.at(-1)?.name}` : '',
      parts.ci?.runUrl ? `CI: ${parts.ci.runUrl}` : '',
      parts.pr?.url ? `PR: ${parts.pr.url}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const parked = await beads.park(bead.id, evidence);
    if (!parked) {
      parts.harvest.parkFailed = true;
      log(
        `harvest: bd park FAILED for ${bead.id} — it has no loop-stuck label, so the next ` +
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
    const id = await beads.fileFollowUp(followUp, bead.id, config.harvest);
    if (!id) throw new Error(`could not file follow-up "${followUp.title}" — refusing to lose it`);
    parts.harvest.followUps.push(id);
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

function prBody(parts, bead, guardResult) {
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

  const log = (message) => process.stdout.write(`[loop] ${message}\n`);
  const run = makeRunner({
    cwd: REPO_ROOT,
    onLine: args.verbose ? (c) => process.stdout.write(c) : undefined,
  });
  const git = makeGit({ run, cwd: REPO_ROOT, dryRun: args.dryRun });

  const { bd } = await preflight({ run, config, git, dryRun: args.dryRun });

  // One run per checkout. Taken AFTER preflight (so a refusal costs nothing)
  // and BEFORE any spawn, because the thing being protected is the working
  // tree that BUILD is about to edit.
  acquireLock(LOOP_DIR, { log });

  const deps = {
    config,
    dryRun: Boolean(args.dryRun),
    emitJson: Boolean(args.json),
    beads: makeBeads({ run, bd, cwd: REPO_ROOT, dryRun: args.dryRun }),
    git,
    forge: makeForge({ run, cwd: REPO_ROOT, dryRun: args.dryRun }),
    gate: makeGate({ run, cwd: REPO_ROOT, config, log }),
    build: makeBuild({ run, cwd: REPO_ROOT, config, libDir: LIB_DIR, loopDir: LOOP_DIR, log }),
  };

  const ctx = {
    parked: new Set(),
    spentUsd: 0,
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
    writeState(ctx, iterations);
    releaseLock(LOOP_DIR);
  };

  let signalled = false;
  const onSignal = (code) => () => {
    if (signalled) process.exit(code);
    signalled = true;
    log('signal received — finishing the current stage, then stopping');
    fs.writeFileSync(HALT_FILE, 'signal');
    exitCode = code;
  };
  process.on('SIGINT', onSignal(EXIT.SIGINT));
  process.on('SIGTERM', onSignal(143));

  try {
    for (;;) {
      if (fs.existsSync(HALT_FILE) && !signalled) {
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
      if (config.limits.costCeilingUsd && ctx.spentUsd >= config.limits.costCeilingUsd) {
        stopBecause = `cost ceiling ${config.limits.costCeilingUsd}`;
        exitCode = EXIT.HALTED;
        break;
      }

      const outcome = await runIteration({ ctx, deps, log });
      if (!outcome.bead) {
        stopBecause = outcome.drained ? 'nothing ready to work' : 'no bead';
        break;
      }
      iterations += 1;

      if (outcome.disposition === DISPOSITION.PARKED) ctx.parked.add(outcome.bead.id);
      // `ciGreen` is what makes a WITHHELD iteration count as evidence. With
      // `merge: false` — the default — every fully successful iteration ends
      // withheld, and a breaker that neither counted nor reset those halted
      // runs reporting "3 consecutive parks" for parks that were interleaved
      // with three complete successes.
      if (resetsBreaker(outcome.disposition, { ciGreen: outcome.ciGreen })) {
        ctx.consecutiveParks = 0;
      } else if (countsTowardBreaker(outcome.disposition)) ctx.consecutiveParks += 1;
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

  log(`stopped: ${stopBecause ?? 'done'} — ${iterations} iteration(s)`);
  return exitCode;
}

function writeState(ctx, iterations) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        consecutiveParks: ctx.consecutiveParks,
        parkedThisRun: [...ctx.parked],
        spentUsd: ctx.spentUsd,
        iterations,
        startedAt: new Date(ctx.startedAt).toISOString(),
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
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    // NOT money. On a subscription this is a local estimate from token counts
    // at list rates — a proxy for tokens consumed, which is what the usage
    // window actually meters.
    process.stdout.write(
      `\ntoken-usage estimate this run: ~$${(state.spentUsd ?? 0).toFixed(2)} equivalent ` +
        `(a proxy for tokens consumed, NOT a bill)\n`,
    );
  }
  const lines = fs.existsSync(LEDGER_FILE)
    ? fs.readFileSync(LEDGER_FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-10)
    : [];
  if (lines.length > 0) process.stdout.write('\nlast iterations:\n');
  for (const line of lines) {
    const r = JSON.parse(line);
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

export { EXIT, harvest, main, prBody, watchCi };
