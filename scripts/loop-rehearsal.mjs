#!/usr/bin/env node
/**
 * A REHEARSAL OF THE LOOP'S GREEN PATH, WHICH HAD NEVER RUN.
 *
 * Measured on `.loop/runs.jsonl` after ten real iterations of the autonomous
 * loop:
 *
 *     WATCH ever returned green : False
 *     LAND ever merged          : False
 *
 * Every recorded iteration ended `parked` or `dry_run`. So CI-green -> LAND ->
 * merge -> close the bead -> next bead from an advanced `main` was unexercised
 * code, and `Cebab-qd2.12` — a queued auto-merge recorded as a completed one —
 * was sitting inside it. That is the shape this whole loop keeps producing:
 * code that succeeds, reports success, and measures nothing.
 *
 * WHAT THIS RUNS: the REAL `scripts/loop.mjs`, the real stage machine, the real
 * git. `scripts/loop.mjs` and `scripts/lib/loop/` are COPIED into a scratch
 * repo, because the driver derives its repo root from its own path — running
 * the installed copy would drive this checkout.
 *
 * WHAT IT FAKES, and why each is honest:
 *
 *   gh      — a PATH shim. It is the whole point: nothing may touch GitHub.
 *   bd      — a PATH shim. The real one would write the operator's bead DB.
 *   npm     — a PATH shim. GATE has run for real ten times; the unproven
 *             stages are the target, and ten real `npm` steps per scenario
 *             would make this too slow to keep.
 *   claude  — a PATH shim emitting the CLI's own result-envelope shape. BUILD
 *             is likewise already proven against the real CLI.
 *
 * THE MERGE IS A FAST-FORWARD PUSH, NOT A SQUASH. `main` has not moved, so the
 * branch is a fast-forward of it and pushing `HEAD:main` into the bare origin
 * advances it exactly as a merge would. What this therefore proves is THE
 * DRIVER'S green path — not GitHub's merge semantics. Branch protection, a real
 * merge queue, and `gh pr merge --delete-branch` switching the operator's local
 * branch are explicitly NOT covered here and need one supervised real run.
 *
 * `scripts/predev-server.mjs` IS DELIBERATELY STUBBED. The real one kills any
 * `tsx watch … src/index.ts` process on the machine, and the driver's teardown
 * invokes it every iteration — so copying it in would let a rehearsal kill the
 * operator's live dev server. The stub keeps the call path exercised and the
 * side effect out.
 *
 * Usage:  node scripts/loop-rehearsal.mjs [scenario ...]     (default: all)
 *         KEEP=1 node scripts/loop-rehearsal.mjs green-merge  (keep the scratch)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

// ─── scenarios ─────────────────────────────────────────────────────────────
//
// `plan` is read by every shim. `build` is one entry per `claude` invocation.

const SCENARIOS = {
  'green-merge': {
    why: 'CI green, LAND merges, the bead closes, and bead 2 branches off the advanced main',
    args: ['--merge', '--until', '2'],
    plan: { beads: 2, ci: 'green', merge: 'direct', build: [{ kind: 'verdict', edit: true }] },
    check: (ctx) => {
      const [one, two] = ctx.records;
      ctx.eq(ctx.records.length, 2, 'two iterations');
      ctx.eq(one.disposition, 'merged', 'iteration 1 merged');
      ctx.eq(one.land.merged, true, 'land.merged');
      ctx.eq(one.land.queued, false, 'land.queued is false');
      ctx.ok(one.land.sha, 'land.sha is a real commit, not null');
      ctx.eq(one.harvest.beadClosed, true, 'the bead was closed');
      ctx.eq(one.restore.pulled, true, 'the teardown pull advanced main');
      // THE END-OF-RUN REPORT, on the happy path. It runs after teardown and
      // checks each row against git, gh and bd — so a clean run has to SAY it
      // checked, or a report that prints nothing is indistinguishable from one
      // that never ran.
      ctx.ok(ctx.stdout.includes('loop run —'), 'the run printed a report');
      ctx.ok(ctx.stdout.includes('MERGED'), 'naming what merged');
      ctx.ok(ctx.stdout.includes('no discrepancies'), 'and saying the rows were verified');
      ctx.ok(!ctx.stdout.includes('NEEDS YOU'), 'with nothing owed to a human');
      ctx.ok(
        ctx.calls.bd.some((c) => c[0] === 'close'),
        'bd close ran',
      );
      // The compounding failure qd2.12 describes: bead 2 must branch from a
      // main that CONTAINS bead 1, not from the main bead 1 started at.
      ctx.eq(two.disposition, 'merged', 'iteration 2 merged too');
      ctx.ok(ctx.mainContains(one.land.sha), 'origin/main contains iteration 1');
      ctx.ok(ctx.mainContains(two.land.sha), 'origin/main contains iteration 2');
      ctx.eq(ctx.parentOf(two.land.sha), one.land.sha, 'bead 2 branched off bead 1, not main@0');
      ctx.eq(two.land.sha, ctx.originSha(), 'and the last merge IS what origin/main now points at');
      // WHAT THE RUN REPORTS IT CONSUMED (Cebab-qd2.38). The operator is on a
      // subscription, so a dollar figure prices a transaction that never
      // happens. This is the only place the whole reporting path — envelope ->
      // ledger -> state.json -> console — runs end to end.
      ctx.ok(one.build.tokens, 'the ledger row carries the token classes');
      ctx.eq(one.build.tokens?.cacheRead, 900000, 'read out of the envelope, not invented');
      ctx.ok(ctx.state()?.tokens, 'and the run total reaches state.json');
      ctx.eq(ctx.state()?.spentUsd, undefined, 'which no longer carries a dollar figure at all');
      ctx.ok(ctx.stdout.includes('cache read'), 'the console says what was consumed');
      // The assertion the operator actually asked for, stated directly.
      ctx.ok(!ctx.stdout.includes('$'), 'and never prints a price');
      // Both directions: the number is still RECORDED, it is only never shown.
      ctx.eq(one.build.costUsd, 0.2, 'the CLI cost is still on the row');
    },
  },

  queued: {
    why: 'a merge that only got QUEUED must not close the bead (Cebab-qd2.12)',
    args: ['--merge', '--until', '1'],
    plan: { beads: 1, ci: 'green', merge: 'queued', build: [{ kind: 'verdict', edit: true }] },
    check: (ctx) => {
      const [row] = ctx.records;
      ctx.eq(row.disposition, 'merge_queued', 'disposition is merge_queued, not merged');
      ctx.eq(row.land.merged, false, 'land.merged is FALSE');
      ctx.eq(row.land.queued, true, 'land.queued is true');
      ctx.eq(row.land.sha, null, 'no merge commit exists to record');
      // The consequence the bead is actually about.
      ctx.eq(row.harvest.beadClosed, false, 'the bead was NOT closed on a prediction');
      ctx.eq(ctx.calls.bd.filter((c) => c[0] === 'close').length, 0, 'bd close never ran');
      ctx.ok(
        ctx.calls.bd.some((c) => c.includes('--append-notes') && c.join(' ').includes('/pull/')),
        'the bead carries a note naming the PR',
      );
      ctx.eq(ctx.originSha(), ctx.baseSha, 'origin/main did NOT move');
    },
  },

  withheld: {
    why: 'the DEFAULT mode: no --merge, so each PR is left for a human — with a note',
    // TWO beads deliberately. With `--merge` the per-iteration restore is
    // unobservable — bead 1 is merged, so bead 2 branching off it looks
    // identical to branching off main. Nothing merges here, so a dropped
    // restore shows up immediately as bead 2's branch sitting on top of
    // bead 1: "bead 2's PR carried bead 1's commits", the defect git.mjs's
    // header describes.
    args: ['--until', '2'],
    plan: { beads: 2, ci: 'green', merge: 'direct', build: [{ kind: 'verdict', edit: true }] },
    check: (ctx) => {
      const [row] = ctx.records;
      ctx.eq(ctx.records.length, 2, 'two iterations');
      ctx.eq(ctx.originSha(), ctx.baseSha, 'and main never moved');
      ctx.eq(
        ctx.parentOf(ctx.refSha('refs/heads/loop/Reh-2')),
        ctx.baseSha,
        'bead 2 branched from MAIN, not from bead 1',
      );
      ctx.eq(row.disposition, 'guard_withheld', 'guard_withheld');
      ctx.eq(row.reason, 'merge_disabled', 'because --merge was absent');
      ctx.eq(row.ci.conclusion, 'success', 'CI still went green');
      ctx.eq(ctx.calls.gh.filter((c) => c[1] === 'merge').length, 0, 'no merge was attempted');
      const note = ctx.calls.bd.find((c) => c.includes('--append-notes'));
      ctx.ok(note, 'the bead got a note (Cebab-qd2.10)');
      ctx.ok(note.join(' ').includes('/pull/'), 'and the note names the PR');
      ctx.eq(ctx.calls.bd.filter((c) => c[0] === 'close').length, 0, 'and was not closed');
    },
  },

  'stale-main': {
    why: 'something landed and main did not move — the run must STOP, not build on it',
    args: ['--merge', '--until', '2'],
    plan: {
      beads: 2,
      ci: 'green',
      merge: 'direct',
      breakRemoteAfterMerge: true,
      build: [{ kind: 'verdict', edit: true }],
    },
    check: (ctx) => {
      ctx.eq(ctx.records.length, 1, 'the run stopped after ONE iteration');
      ctx.eq(ctx.records[0].restore.pulled, false, 'the teardown pull failed');
      ctx.ok(ctx.stdout.includes('stale_main'), 'and it said stale_main out loud');
      ctx.eq(ctx.exitCode, 1, 'exiting HALTED, not OK');
      // Cebab-qd2.27. `loop:night` pipes through `tee`, so the process exit
      // code an operator or a cron job can observe is always tee's. The
      // driver's own answer has to be durable to be worth anything.
      ctx.eq(ctx.state()?.exitCode, 1, 'and the code is recorded in state.json');
      ctx.eq(ctx.state()?.stoppedBecause, 'stale_main', 'with the reason beside it');
    },
  },

  'capped-then-resume': {
    why: 'a turn cap that made progress is resumed once (Cebab-qd2.11)',
    args: ['--until', '1'],
    plan: {
      beads: 1,
      ci: 'green',
      merge: 'direct',
      build: [
        { kind: 'max_turns', edit: true },
        { kind: 'verdict', edit: true },
      ],
    },
    check: (ctx) => {
      const [row] = ctx.records;
      ctx.eq(ctx.calls.claude.length, 2, 'claude ran twice');
      ctx.ok(!ctx.calls.claude[0].includes('--resume'), 'the first attempt was fresh');
      ctx.ok(ctx.calls.claude[1].includes('--resume'), 'the second RESUMED the session');
      // REWRITTEN, NOT RELAXED (Cebab-qd2.37). This asserted `attempts: 2`,
      // which encoded the accounting the bead is about: a resume charged to
      // `maxRepairs`, so a feature bead spent two of its three attempts before
      // the first real failure. The invocation is still counted — it moved to
      // its own field, and `attempts + capResumes` is what the two `claude`
      // calls now add up to. `capped-keeps-repair` is the scenario that shows
      // why it matters.
      ctx.eq(row.build.attempts, 1, 'still attempt ONE — a resume is not a repair');
      ctx.eq(row.build.capResumes, 1, 'and the resume is counted in its own field');
      ctx.eq(row.disposition, 'guard_withheld', 'and it got all the way to a green PR');
      // Cebab-qd2.18. Attempt 1 died inside BUILD, so attempt 2 is the FIRST to
      // reach PUBLISH and MUST open the PR. This assertion is the whole reason
      // the gh shim now refuses to report checks without one: before that, this
      // scenario passed while opening no PR at all.
      ctx.eq(ctx.prCreates(), 1, 'the PR was created on attempt 2 (Cebab-qd2.18)');
      ctx.ok(row.pr.number, 'and the ledger carries its number, not null');
    },
  },

  'gate-fail-then-publish': {
    why: 'attempt 1 dies at the GATE, so attempt 2 is the first to PUBLISH and must open a PR (Cebab-qd2.18)',
    // The shape that broke the first unattended night. GATE failing is not a
    // BUILD failure, so it takes a different route to the same place: attempt 2
    // reaching PUBLISH with no PR behind it.
    args: ['--until', '1'],
    plan: {
      beads: 1,
      ci: 'green',
      merge: 'direct',
      gateFailOnAttempt: 1,
      gateFailStep: 'format:check',
      // THE AGENT CLAIMS THE STEP THE GATE IS ABOUT TO REDDEN ON. This is the
      // 2026-08-27 shape — five of eight builds skipped formatting and said
      // otherwise — and it is the only configuration in which `disagree` is
      // reachable at all. (Cebab-qd2.43)
      claimedCommands: ['npm run format:check', 'npm run lint'],
      build: [
        { kind: 'verdict', edit: true },
        { kind: 'verdict', edit: true },
      ],
    },
    check: (ctx) => {
      const [row] = ctx.records;
      ctx.eq(ctx.calls.claude.length, 2, 'the gate failure bought a second attempt');
      // WHAT THE DURABLE RECORD SAYS ABOUT THE FAILURE (Cebab-qd2.43). Across
      // the 32 rows written before this, rows carrying a non-zero gate step
      // numbered ZERO — the repaired run's steps were assigned over the failing
      // one's, so the only evidence a gate had ever reddened was scrollback.
      ctx.eq(row.gate.attempts?.length, 2, 'both gate runs are on the row');
      ctx.eq(row.gate.attempts?.[0]?.passed, false, 'and the first one FAILED');
      ctx.eq(row.gate.attempts?.[0]?.failedStep, 'format:check', 'naming the step');
      ctx.ok(
        (row.gate.attempts?.[0]?.steps ?? []).some((st) => st.exitCode !== 0),
        'and keeping the failing step itself, not just its name',
      );
      ctx.eq(row.gate.attempts?.[1]?.passed, true, 'the second run passed');
      ctx.ok(
        (row.gate.steps ?? []).every((st) => st.exitCode === 0),
        'while `gate.steps` still means the LAST run, as 32 existing rows do',
      );
      // The consequence the field exists for: the agent claimed format:check
      // and the gate found it red. Last-write-wins made this unreachable.
      ctx.eq(row.verdictVsGate, 'disagree', 'the row records the disagreement');
      ctx.eq(row.gate.attempts?.[1]?.verdictVsGate, 'agree', 'though the repair itself agreed');
      ctx.ok(ctx.prBody(1).includes('Gate reddened'), 'and the PR body says the gate reddened');
      ctx.eq(ctx.prCreates(), 1, 'and attempt 2 opened the PR');
      ctx.ok(row.pr.number, 'the ledger carries the PR number');
      ctx.ok(row.pr.url, 'and its url');
      // The consequence, stated from the other end: without the PR this run
      // spent 916 s polling and then parked blaming CI.
      ctx.eq(row.ci.conclusion, 'success', 'CI reported on it');
      ctx.eq(row.disposition, 'guard_withheld', 'and the iteration succeeded');
      ctx.ok(!ctx.stdout.includes('ci_never_started'), 'nothing blamed the runner');
    },
  },

  // ── Cebab-qd2.45 / Cebab-qd2.46 ────────────────────────────────────────
  //
  // Both from the unattended run of 2026-08-30, and both are cases where CI
  // said something other than yes or no while the driver could only hear two
  // answers.
  'ci-blocked': {
    why: 'the required context is green but ANOTHER required check is red — merging is impossible',
    // PR #432: the fixture-review gate is red by design until a CODEOWNER
    // clears a label. The driver reported green, tried to merge, was refused by
    // branch protection, fell back to --auto and recorded `merge_queued` — a
    // disposition that reads as "will land shortly" for a PR needing a human.
    args: ['--merge', '--until', '1'],
    plan: { beads: 1, ci: 'blocked', merge: 'direct', build: [{ kind: 'verdict', edit: true }] },
    check: (ctx) => {
      const [row] = ctx.records;
      ctx.eq(row.disposition, 'parked', 'a blocked PR parks');
      ctx.eq(row.reason, 'ci_blocked', 'under its OWN reason, not ci_red');
      ctx.eq(row.ci.outcome, 'blocked', 'and the row says which');
      ctx.eq(row.ci.failedChecks[0].name, 'Fixture review gate', 'naming the check that blocks');
      ctx.eq(ctx.calls.gh.filter((c) => c[1] === 'merge').length, 0, 'no merge was attempted');
      ctx.eq(row.land.queued, false, 'and nothing was queued');
      // THE REPAIR BUDGET IS NOT SPENT. A repair cannot clear a review label,
      // so a driver that fell through to the `red` branch would burn an
      // attempt and force-push an identical tree.
      ctx.eq(ctx.calls.claude.length, 1, 'no repair attempt was bought');
      ctx.eq(
        ctx.calls.gh.filter((c) => c[0] === 'run' && c[1] === 'rerun').length,
        0,
        'and no CI re-run either — the diff is not what is wrong',
      );
      // And the report has to SURFACE it. A park whose only trace is a ledger
      // row is the silence this whole report exists to end.
      ctx.ok(ctx.stdout.includes('PARKED'), 'the report names the park');
      ctx.ok(ctx.stdout.includes('ci_blocked'), 'with the reason attached');
    },
  },

  'ci-infra-recovers': {
    why: 'CI was KILLED, not failed — one re-run recovers it and the bead lands',
    // PR #434: the windows leg hit `timeout-minutes: 15` at 902s with no
    // assertion having failed. A plain re-run of the identical commit went
    // green. Before this the driver had no re-run path at all, so its only
    // available response was a code repair, which cannot help by construction.
    args: ['--merge', '--until', '1'],
    plan: {
      beads: 1,
      ci: 'infra',
      ciAfterRerun: 'green',
      merge: 'direct',
      build: [{ kind: 'verdict', edit: true }],
    },
    check: (ctx) => {
      const [row] = ctx.records;
      const reruns = ctx.calls.gh.filter((c) => c[0] === 'run' && c[1] === 'rerun');
      ctx.eq(reruns.length, 1, 'exactly one re-run');
      ctx.ok(reruns[0].includes('--failed'), 'of only the failed jobs');
      ctx.eq(row.disposition, 'merged', 'and the bead then merged');
      ctx.eq(row.ci.rerun, true, 'the row records that a re-run happened');
      ctx.eq(row.ci.conclusion, 'success', 'ending green');
      // The whole point: no repair was bought for a cause that did not exist.
      ctx.eq(ctx.calls.claude.length, 1, 'no repair attempt was spent on a runner timeout');
    },
  },

  'ci-infra-persists': {
    why: 'a second cancellation after the re-run parks under ci_infra, and never re-runs twice',
    args: ['--merge', '--until', '1'],
    plan: { beads: 1, ci: 'infra', merge: 'direct', build: [{ kind: 'verdict', edit: true }] },
    check: (ctx) => {
      const [row] = ctx.records;
      ctx.eq(
        ctx.calls.gh.filter((c) => c[0] === 'run' && c[1] === 'rerun').length,
        1,
        'ONE re-run, not one per poll',
      );
      ctx.eq(row.disposition, 'parked', 'it parks');
      ctx.eq(row.reason, 'ci_infra', 'as infrastructure, not as a build failure');
      ctx.eq(row.ci.outcome, 'infra', 'and the row keeps the distinction');
      ctx.eq(ctx.calls.claude.length, 1, 'still no repair attempt');
    },
  },

  'ci-red-repair': {
    why: 'the ONE path where attempt 2 must NOT open a PR — the repair force-pushes to the open one',
    // The negative control for `gate-fail-then-publish`. Without it, "create a
    // PR on attempt 2" is satisfied by a driver that opens a second PR on every
    // repair, which is the bug the `attempt === 1` guard was written to prevent.
    args: ['--until', '1'],
    plan: {
      beads: 1,
      ci: ['red', 'green'],
      merge: 'direct',
      build: [
        { kind: 'verdict', edit: true },
        { kind: 'verdict', edit: true },
      ],
    },
    check: (ctx) => {
      const [row] = ctx.records;
      ctx.eq(ctx.calls.claude.length, 2, 'CI red bought a repair');
      ctx.eq(ctx.prCreates(), 1, 'EXACTLY ONE PR across both attempts');
      ctx.eq(row.build.attempts, 2, 'recorded as two attempts');
      ctx.eq(row.ci.conclusion, 'success', 'and the repair went green');
      ctx.eq(row.disposition, 'guard_withheld', 'reaching the normal terminal');
      // THE ONLY PATH ON WHICH A PR CAN SEE ITSELF (Cebab-qd2.44). The second
      // PUBLISH runs with this branch's PR already open and 100% of its files
      // in common, so an overlap report without an exclusion warns the operator
      // that a PR conflicts with itself. `file-overlap` cannot show this: there
      // the PR is created AFTER the check, so nothing is there to match.
      ctx.eq(row.fileOverlaps, undefined, 'and the PR never reported overlapping ITSELF');
      ctx.ok(!ctx.stdout.includes('file overlap'), 'nothing was said about an overlap');
    },
  },

  'halted-mid-run': {
    why: 'a HALT skips HARVEST, so the bead must be handed back or it leaves the queue forever',
    // Never executed before this scenario existed: 16 ledger rows, zero
    // `halted`. Six independent audit lenses found the same stranding, and it
    // had already happened for real to Cebab-vie.30.
    args: ['--until', '2'],
    plan: {
      beads: 2,
      ci: 'green',
      merge: 'direct',
      haltDuringBuild: true,
      build: [{ kind: 'verdict', edit: true }],
    },
    check: (ctx) => {
      const [row] = ctx.records;
      ctx.eq(ctx.records.length, 1, 'the run stopped after the halt, not after two beads');
      ctx.eq(row.disposition, 'halted', 'the iteration is recorded as halted');
      const release = ctx.calls.bd.find(
        (c) => c[0] === 'update' && c.includes('--status') && c.includes('open'),
      );
      ctx.ok(release, 'the claimed bead was handed back to the queue');
      ctx.ok(release && release[1] === 'Reh-1', 'and it was THIS bead');
      // The other direction, and the reason `release` is not `park`: a bead
      // that was merely interrupted must not be labelled for human debugging,
      // because that label excludes it from every future selection.
      ctx.ok(
        !ctx.calls.bd.some((c) => c.includes('loop-stuck')),
        'and NOT labelled loop-stuck — it did not fail at anything',
      );
      ctx.eq(ctx.exitCode, 1, 'exiting HALTED');
    },
  },

  'branch-exists': {
    why: 'CLAIM must not proceed when `git checkout -b` fails — every later stage would run on main',
    args: ['--until', '1'],
    plan: {
      beads: 1,
      ci: 'green',
      merge: 'direct',
      preexistingBranch: 'Reh-1',
      build: [{ kind: 'verdict', edit: true }],
    },
    check: (ctx) => {
      const [row] = ctx.records;
      ctx.eq(row.disposition, 'parked', 'parked rather than proceeding');
      ctx.eq(row.reason, 'claim_failed', 'under claim_failed');
      // The consequence the check exists to prevent, asserted directly: with
      // the exit code dropped, BUILD ran anyway — on main, since the checkout
      // never happened.
      ctx.eq(ctx.calls.claude.length, 0, 'and BUILD never ran on the wrong branch');
      ctx.eq(ctx.originSha(), ctx.baseSha, 'nothing was pushed');
    },
  },

  'bd-broken': {
    why: 'a crash BEFORE a bead is selected must not end the night reporting success',
    // `if (!outcome.bead)` cannot tell a crash from a drained queue, and that
    // branch stops the run with exit 0 — so one transient bd failure ended an
    // --until 8 night after zero iterations, silently, with no ledger row
    // (the append is also gated on `bead`).
    args: ['--merge', '--until', '8'],
    plan: { beads: 2, ci: 'green', merge: 'direct', bdFail: 'ready', build: [] },
    check: (ctx) => {
      ctx.eq(ctx.records.length, 0, 'no iteration ran');
      ctx.eq(ctx.exitCode, 1, 'and the run exits NON-ZERO — this is the whole finding');
      ctx.ok(ctx.stdout.includes('crashed before'), 'saying it crashed before selecting');
      ctx.ok(!ctx.stdout.includes('nothing ready to work'), 'and NOT claiming the queue was empty');
    },
  },

  'json-stream': {
    why: '--json promises stdout is one ledger record per line INSTEAD of human output',
    // It only ever ADDED: `log` wrote to stdout unconditionally, so a consumer
    // reading the documented stream hit `[loop] select: ...` on line one.
    args: ['--json', '--until', '1'],
    plan: { beads: 1, ci: 'green', merge: 'direct', build: [{ kind: 'verdict', edit: true }] },
    check: (ctx) => {
      ctx.ok(!ctx.rawStdout.includes('[loop]'), 'stdout carries no human lines');
      const lines = ctx.rawStdout.split('\n').filter(Boolean);
      ctx.ok(lines.length > 0, 'and it is not simply empty');
      let parsed = 0;
      for (const line of lines) {
        try {
          JSON.parse(line);
          parsed += 1;
        } catch {
          /* counted by the assertion below */
        }
      }
      ctx.eq(parsed, lines.length, 'every stdout line parses as JSON');
      // The other direction: the human stream must still EXIST, or this trades
      // an unparseable stdout for a silent run.
      ctx.ok(ctx.rawStderr.includes('[loop]'), 'and the human lines moved to stderr');
    },
  },

  'driver-stale': {
    why: 'preflight pulls main UNDER the running driver — it must restart on what it pulled (Cebab-qd2.35)',
    // The first defect where the loop's own fixes were present on disk and did
    // not take effect. Node imports the driver at process start; preflight's
    // `git pull --ff-only` is REQUIRED (it is what stops beads being built on a
    // stale base) and rewrites those exact files a second later. Measured on a
    // real run: two beads under the loop's own epic were selected by an
    // `excludeParents` that had been merged that morning and was not in memory.
    args: ['--until', '1'],
    plan: {
      beads: 1,
      ci: 'green',
      merge: 'direct',
      originAhead: true,
      build: [{ kind: 'verdict', edit: true }],
    },
    check: (ctx) => {
      const [row] = ctx.records;
      // THE ASSERTION THAT CANNOT BE SATISFIED BY A LOG LINE. The marker is a
      // top-level statement in the PULLED `loop.mjs`, so it runs at import and
      // only in a process that loaded the new copy.
      const markers = ctx.stdout.split('REHEARSED-NEW-DRIVER').length - 1;
      ctx.eq(markers, 1, 'the pulled driver ran, exactly once');
      ctx.ok(ctx.stdout.includes('Restarting on the pulled one'), 'and said why');
      // And the WORK happened in the child, not in the stale parent.
      const builds = ctx.callRows.filter((r) => r.tool === 'claude');
      ctx.eq(builds.length, 1, 'one build');
      ctx.eq(builds[0].reexec, '1', 'and it ran in the restarted process');
      // The parent got as far as preflight and no further — `gh auth status`
      // is the last thing preflight does, so it appears from both processes.
      ctx.ok(
        ctx.callRows.some((r) => r.tool === 'gh' && r.reexec === null),
        'the parent did run preflight',
      );
      // The run still completes: this must not trade a stale driver for a
      // refusal, which is candidate (b) and the option that trains people to
      // ignore it.
      ctx.eq(ctx.records.length, 1, 'the iteration ran');
      ctx.eq(row.disposition, 'guard_withheld', 'and reached its normal terminal');
      ctx.eq(ctx.exitCode, 0, 'exiting OK');
      // Candidate (d), which composes with the restart rather than replacing it.
      ctx.eq(row.driver?.restarted, true, 'the row says it came from a restarted driver');
      ctx.eq(row.driver?.revision, ctx.originSha(), 'and names the revision it ran');
    },
  },

  'capped-keeps-repair': {
    why: 'a resumed turn cap must not spend a repair — the headroom is for a CI red (Cebab-qd2.37)',
    // The shape both feature beads ever merged actually took: attempt 1 capped,
    // attempt 2 does the work and fails `format:check`, attempt 3 runs Prettier.
    // Both landed with ZERO repairs left, so a CI red would have parked a
    // complete, gate-passing change. Here CI DOES go red, and the run must
    // still have an attempt for it.
    args: ['--until', '1'],
    plan: {
      beads: 1,
      merge: 'direct',
      gateFailOnAttempt: 2,
      gateFailStep: 'format:check',
      ci: ['green', 'green', 'red', 'green'],
      build: [
        { kind: 'max_turns', edit: true },
        { kind: 'verdict', edit: true },
        { kind: 'verdict', edit: true },
        { kind: 'verdict', edit: true },
      ],
    },
    check: (ctx) => {
      const [row] = ctx.records;
      // FOUR invocations: capped, resume, format repair, CI repair. Under the
      // old accounting the resume consumed a repair, so the third invocation
      // was the last and the CI red parked the finished work.
      ctx.eq(ctx.calls.claude.length, 4, 'four claude invocations');
      ctx.ok(ctx.calls.claude[1].includes('--resume'), 'the second RESUMED the capped session');
      ctx.eq(row.build.capResumes, 1, 'recorded as one cap resume');
      ctx.eq(row.build.attempts, 3, 'and three attempts — the resume is not one of them');
      // The consequence, from the other end.
      ctx.eq(row.ci.conclusion, 'success', 'the CI repair went green');
      ctx.eq(row.disposition, 'guard_withheld', 'and the bead reached its normal terminal');
      ctx.ok(row.reason !== 'ci_red', 'rather than parking with the work complete');
      ctx.eq(ctx.prCreates(), 1, 'still exactly one PR across all four');
    },
  },

  declined: {
    why: 'a bead the agent DECLINES must carry the reasoning and say it was a judgement (Cebab-qd2.36)',
    // Measured on Cebab-4ey.2: 5 turns of judgement, and the durable record was
    // 43 characters reading `Parked by the autonomous loop: needs_human.` on a
    // bead the label then excluded from every future selection.
    args: ['--until', '1'],
    plan: { beads: 1, ci: 'green', merge: 'direct', build: [{ kind: 'decline' }] },
    check: (ctx) => {
      const [row] = ctx.records;
      ctx.eq(ctx.calls.claude.length, 1, 'one build, and it succeeded');
      ctx.eq(row.disposition, 'parked', 'parked');
      ctx.eq(row.reason, 'needs_human', 'under needs_human');
      ctx.eq(ctx.prCreates(), 0, 'nothing was published');
      const update = ctx.calls.bd.find((c) => c.includes('--append-notes'));
      ctx.ok(update, 'the bead got a note');
      const note = update ? update[update.indexOf('--append-notes') + 1] : '';
      ctx.ok(note.includes('Declined by the autonomous loop'), 'reading as a judgement');
      ctx.ok(note.includes('deny hook blocks gh'), "quoting the agent's own account");
      ctx.ok(note.includes('claude --resume sess-'), 'and offering the session to inspect');
      ctx.ok(update.includes('loop-declined'), 'labelled loop-declined');
      ctx.ok(!update.includes('loop-stuck'), 'and NOT loop-stuck — nothing failed');
      // The reasoning is in the ledger too, so a morning triage needs one file.
      ctx.ok(row.build.summary, 'the ledger carries the summary');
      // Cebab-qd2.20, live: a decline is neutral evidence about the loop.
      ctx.eq(ctx.state()?.consecutiveParks, 0, 'the breaker did not count it');
      ctx.eq(ctx.state()?.consecutiveDeclines, 1, 'the decline counter did');
    },
  },

  'rollup-withheld-child': {
    why: 'a child left in_progress behind an unmerged PR still blocks its parent (Cebab-cak)',
    // THE 2026-08-27 INCIDENT, REHEARSED. Iteration 5 built Cebab-8x8.2.1, the
    // guard withheld the merge, PR #422 stayed open and HARVEST left the bead
    // in_progress — which takes it out of `bd ready`. Iteration 6 then selected
    // its DIRECT PARENT Cebab-8x8.2 and built it from a main without #422; both
    // create assistant/kb/00-index.md and the second to merge conflicted.
    //
    // `rollup-skipped` cannot catch this: it needs BOTH parent and child in the
    // ready batch, and the whole point here is that the child is not in it. So
    // this is the scenario that exercises `ancestorsOfActive` rather than the
    // older batch rule — and until the bd shim learned `list`, the graph was
    // empty in every scenario and this could not have been written at all.
    args: ['--until', '1'],
    plan: {
      beads: 3,
      ci: 'green',
      merge: 'direct',
      withheldChild: true,
      build: [{ kind: 'verdict', edit: true }],
    },
    check: (ctx) => {
      const [row] = ctx.records;
      ctx.eq(ctx.records.length, 1, 'one iteration');
      // Reh-2 is in_progress and is Reh-1's child, so Reh-1 contains unfinished
      // work and Reh-3 is the only real leaf.
      ctx.eq(row.bead, 'Reh-3', 'the unrelated leaf was selected, not the container');
      ctx.ok(
        !ctx.calls.bd.some((c) => c[0] === 'update' && c[1] === 'Reh-1' && c.includes('--claim')),
        'and the parent was never claimed',
      );
      // THE BELT AGAINST THIS GOING QUIET AGAIN. The driver logs the graph size
      // for exactly this reason: an empty graph is how the rule dies, and it
      // died that way here for the whole of its first day.
      ctx.ok(
        /select: [1-9]\d* beads in the graph, [1-9]\d* contain other work/.test(ctx.stdout),
        'the driver reports a NON-EMPTY containment graph',
      );
    },
  },

  'select-window': {
    why: 'the ready window is filtered downstream, so a cap on it hides eligible work (Cebab-qd2.48)',
    // THE 2026-09-01 HALT, REHEARSED. The overnight run finished four beads and
    // then stopped at second nine reporting `nothing ready to work`. It was not
    // drained: 201 rows survived bd's own exclusions, 71 were within
    // `maxPriority`, and the hybrid ordering put only nine of those 71 inside
    // the 50-row window the driver asked for — all nine excluded by a rule bd
    // never saw. The first eligible bead sat at position 63.
    //
    // Self-reinforcing, which is why four good iterations preceded it: the
    // beads a run completes are the eligible ones near the top, so every
    // success empties the window further.
    //
    // 59 excluded rows ahead of one eligible one is the same shape at rehearsal
    // scale. Reddens the moment SELECT asks bd for a page again — the shim
    // truncates now, so the driver would see 50 denied rows and stop.
    args: ['--until', '1'],
    plan: {
      beads: 60,
      excludedBeads: 59,
      ci: 'green',
      merge: 'direct',
      build: [{ kind: 'verdict', edit: true }],
    },
    check: (ctx) => {
      ctx.eq(ctx.records.length, 1, 'one iteration ran');
      ctx.eq(ctx.records[0]?.bead, 'Reh-60', 'the one eligible bead was found, at position 60');
      // THE ARGV, not just the outcome, and the split is MEASURED rather than
      // belt-and-braces. Reverting the driver's `0` alone reddens the two
      // assertions above — 'one iteration ran (got 0)'. Reverting the shim's
      // `-n` handling as well turns them GREEN again, because a fake that never
      // truncates cannot express the defect: only this argv check survives.
      // So each half guards a distinct failure — the behavioural pair catches
      // the driver, this catches a harness that has stopped being able to look.
      // It also refuses a driver that merely moved the cliff to a bigger page.
      const ready = ctx.calls.bd.filter((c) => c[0] === 'ready');
      ctx.ok(ready.length > 0, 'SELECT called bd ready');
      ctx.ok(
        ready.every((c) => c[c.indexOf('-n') + 1] === '0'),
        'and every call asked for no window at all',
      );
      // BOTH NUMBERS, because one of them cannot tell the two failures apart.
      // A falsy pick used to mean either "bd had nothing" or "bd had 60 and the
      // filters took all of them", and the run stopped identically on each.
      ctx.ok(
        /select: 60 ready, 1 eligible after filters/.test(ctx.stdout),
        'and the driver reports the pair, so an empty window is not an empty queue',
      );
    },
  },

  'file-overlap': {
    why: 'two beads that write ONE file must warn the human choosing the merge order (Cebab-qd2.44)',
    // NO `--merge`, which is the point rather than a convenience. `merge:false`
    // is the default, so `guard_withheld` is how an ordinary successful
    // iteration ends: PR 1 stays open, iteration 2 branches from an
    // `origin/main` that does not contain it, and neither agent can see the
    // collision coming. This is the 2026-08-27 shape — #422 and #423 both
    // created `assistant/kb/00-index.md`.
    args: ['--until', '2'],
    plan: {
      beads: 2,
      ci: 'green',
      merge: 'direct',
      // One entry, so BOTH iterations take it and write the same path.
      build: [{ kind: 'verdict', edit: true, file: 'src/shared.js' }],
    },
    check: (ctx) => {
      const [one, two] = ctx.records;
      ctx.eq(ctx.records.length, 2, 'two iterations');
      ctx.eq(ctx.originSha(), ctx.baseSha, 'and nothing merged, so main never moved');
      // BOTH DIRECTIONS. The first PR has nothing open to collide with, so an
      // implementation that reported an overlap for every PR would pass the
      // second assertion alone.
      ctx.eq(one.fileOverlaps, undefined, 'the first PR has nothing to overlap yet');
      ctx.eq(two.fileOverlaps?.length, 1, 'the second names exactly one');
      ctx.eq(two.fileOverlaps?.[0]?.number, 1, 'and it is PR #1');
      ctx.eq(two.fileOverlaps?.[0]?.branch, 'loop/Reh-1', 'named by its branch too');
      ctx.eq(
        (two.fileOverlaps?.[0]?.files ?? []).join(','),
        'src/shared.js',
        'and the shared file is named',
      );
      // NOT ASSERTED HERE that a PR never matches itself: PR 2 is created
      // AFTER this check runs, so nothing could match and the assertion would
      // pass against an implementation with no exclusion at all. It lives in
      // `ci-red-repair`, the one path where the PR already exists.
      const body = ctx.prBody(2);
      ctx.ok(body.includes('Overlapping open loop PRs'), 'the PR body carries the section');
      ctx.ok(body.includes('#1'), 'naming the other PR');
      ctx.ok(body.includes('src/shared.js'), 'and the file they share');
      ctx.ok(!ctx.prBody(1).includes('Overlapping'), 'while PR 1 has no such section');
      ctx.ok(ctx.stdout.includes('file overlap'), 'and the run said so out loud');
    },
  },

  'overlap-cleared': {
    why: 'a rival PR that lands mid-iteration must CLEAR the finding, not leave it on the row',
    // The staleness half of Cebab-qd2.44, and it is only reachable across two
    // PUBLISHes of one iteration: a CI red republishes, and by then the PR that
    // was going to conflict has merged. Recording the overlap only when there
    // is one leaves attempt 1's finding standing after attempt 2 established it
    // was no longer true.
    args: ['--until', '2'],
    plan: {
      beads: 2,
      // Per-build: iteration 1 green, iteration 2 red, its repair green.
      ci: ['green', 'red', 'green'],
      merge: 'direct',
      hidePr: 1,
      hidePrAfterBuild: 3,
      build: [{ kind: 'verdict', edit: true, file: 'src/shared.js' }],
    },
    check: (ctx) => {
      ctx.eq(ctx.records.length, 2, 'two iterations');
      ctx.eq(ctx.calls.claude.length, 3, 'iteration 2 needed a repair');
      // It WAS found, at the moment it was true — otherwise the assertion below
      // passes against a loop that never looks.
      ctx.ok(ctx.stdout.includes('file overlap'), 'the overlap was found and reported');
      ctx.eq(ctx.prCreates(), 2, 'and only two PRs were opened');
      // And then unfound. This is the whole case.
      ctx.eq(ctx.records[1].fileOverlaps, undefined, 'a later clean check CLEARED it');
    },
  },

  'overlap-check-broken': {
    why: 'a `gh pr list` that fails must SAY so, not report a clean sheet (Cebab-qd2.44)',
    args: ['--until', '2'],
    plan: {
      beads: 2,
      ci: 'green',
      merge: 'direct',
      prListFail: true,
      build: [{ kind: 'verdict', edit: true, file: 'src/shared.js' }],
    },
    check: (ctx) => {
      ctx.eq(ctx.records.length, 2, 'the run finished anyway — the report is advisory');
      ctx.eq(ctx.records[1].disposition, 'guard_withheld', 'and iteration 2 still succeeded');
      ctx.eq(ctx.records[1].fileOverlaps, undefined, 'nothing was recorded');
      // The whole difference between this and `file-overlap`'s first row: one
      // is "no overlap", the other is "could not tell", and a bare [] renders
      // them identical.
      ctx.ok(ctx.stdout.includes('overlap check skipped'), 'but the run said it could not tell');
    },
  },

  'rollup-skipped': {
    why: 'a bead that CONTAINS another ready bead is a rollup — take the child (Cebab-qd2.40)',
    // Measured on the live queue: the loop's next three picks were feature-typed
    // parents of ready task beads, and pick four was a SUBSET of pick one. Here
    // Reh-1 is the parent of Reh-2 and bd offers both.
    args: ['--until', '1'],
    plan: {
      beads: 2,
      ci: 'green',
      merge: 'direct',
      containerFirst: true,
      build: [{ kind: 'verdict', edit: true }],
    },
    check: (ctx) => {
      const [row] = ctx.records;
      ctx.eq(ctx.records.length, 1, 'one iteration');
      ctx.eq(row.bead, 'Reh-2', 'the CHILD was selected, not its parent');
      // The other half of the finding, asserted where it actually bites: the
      // parent must never be claimed, because doing it AND its child is the
      // duplicate work this exists to prevent.
      ctx.ok(
        !ctx.calls.bd.some((c) => c[0] === 'update' && c[1] === 'Reh-1' && c.includes('--claim')),
        'and the parent was never claimed',
      );
      ctx.eq(row.disposition, 'guard_withheld', 'the iteration still succeeded');
    },
  },

  'capped-no-progress': {
    why: 'a turn cap that edited nothing was spinning — park it, do not buy it more turns',
    args: ['--until', '1'],
    plan: { beads: 1, ci: 'green', merge: 'direct', build: [{ kind: 'max_turns', edit: false }] },
    check: (ctx) => {
      const [row] = ctx.records;
      ctx.eq(ctx.calls.claude.length, 1, 'claude ran ONCE — no resume');
      ctx.eq(row.disposition, 'parked', 'parked');
      ctx.eq(row.reason, 'max_turns', 'under its own reason');
      ctx.ok(
        ctx.calls.bd.some((c) => c.includes('loop-stuck')),
        'and the bead was labelled so the next run skips it',
      );
    },
  },
};

// ─── the scratch repo ──────────────────────────────────────────────────────

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function shim(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}`);
  fs.chmodSync(file, 0o755);
}

const SHIM_PREAMBLE = `
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const DIR = process.env.REHEARSAL_DIR;
const argv = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(path.join(DIR, 'plan.json'), 'utf8'));
const statePath = path.join(DIR, 'shim-state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
// \`reexec\` is what proves WHICH process made the call. The parent's preflight
// probes run before any restart and carry null; everything the child does
// carries '1'. Without it, "the driver restarted" and "the driver printed a
// line about restarting" are the same assertion. (Cebab-qd2.35)
const record = (tool) =>
  fs.appendFileSync(
    path.join(DIR, 'calls.jsonl'),
    JSON.stringify({ tool, argv, reexec: process.env.CEBAB_LOOP_REEXEC ?? null }) + '\\n',
  );
// PREFLIGHT PROBES EVERY BINARY WITH \`--version\` (Cebab-qd2.34), and a shim must
// answer that the way the real tool does: instantly, and WITHOUT side effects.
// Answering it in the body instead cost real assertions — the probe consumed a
// \`plan.build\` entry and was recorded in \`calls.claude\`, so "claude ran twice"
// read 1 and every downstream scenario failed. Before \`record\`, deliberately.
if (argv.length === 1 && argv[0] === '--version') {
  process.stdout.write('0.0.0-rehearsal\\n');
  process.exit(0);
}
`;

function writeShims(dir) {
  shim(
    dir,
    'bd',
    `${SHIM_PREAMBLE}
record('bd');
// A transient bd failure — a lock, a corrupt index, a bad build. It exits
// non-zero and prints nothing, which is what makes parseJson throw.
if (plan.bdFail && argv[0] === plan.bdFail) {
  process.stderr.write('rehearsed bd failure: ' + argv[0] + '\\n');
  process.exit(1);
}
if (argv[0] === 'ready') {
  // STATUS IS HONOURED, and it has to be: the whole of Cebab-cak is that an
  // in_progress bead is ABSENT from \`bd ready\` while still containing work.
  // A shim that returned it anyway could not express the bug.
  const open = plan.beadRows.filter(
    (b) => b.status === 'open' && !state.claimed.includes(b.id),
  );
  // \`-n\` IS HONOURED FOR THE SAME REASON, and its absence was the harness
  // hiding Cebab-qd2.48 from itself. bd truncates AFTER its own sort and
  // exclusions and BEFORE the driver's client-side filters run, so a fake that
  // never truncates cannot express a window that is full and entirely
  // excluded — the exact state that stopped the run of 2026-09-01 with
  // \`nothing ready to work\` and 61 eligible beads waiting. Model what the real
  // tool REFUSES to return, not just the shape of what it does.
  //
  // \`0\` is bd's no-limit and \`100\` its default when the flag is absent; both
  // are measured off \`bd ready --help\`, and the default matters because a
  // caller that forgets \`-n\` gets a page rather than everything.
  const at = argv.indexOf('-n');
  const limit = at === -1 ? 100 : Number(argv[at + 1]);
  process.stdout.write(JSON.stringify(limit > 0 ? open.slice(0, limit) : open));
} else if (argv[0] === 'list') {
  // \`--all\` is every bead of every status — the containment graph's input.
  // Without this branch the shim exited 0 with EMPTY stdout, \`parseJson\` threw,
  // \`beads.list\` caught and returned [], and \`ancestorsOfActive\` was handed
  // nothing: the graph rule ran, reported success and measured NOTHING in every
  // scenario. \`rollup-skipped\` still passed, on the older batch rule alone.
  const rows = plan.beadRows.map((b) =>
    state.claimed.includes(b.id) ? { ...b, status: 'in_progress' } : b,
  );
  process.stdout.write(JSON.stringify(rows));
} else if (argv[0] === 'show') {
  const hit = plan.beadRows.find((b) => b.id === argv[1]);
  // THE FAKE HAS TO MODEL WHAT THE WRITES DID, not just the shape of a row.
  // It did not, so every bead looked permanently open, with no labels — and
  // the end-of-run verifier, whose whole job is asking bd whether a claimed
  // close really happened, reported two false discrepancies on a run where
  // nothing was wrong. A fake that cannot represent success makes any check
  // against it useless in the direction that matters.
  const live = hit
    ? {
        ...hit,
        status: (state.closed || []).includes(argv[1]) ? 'closed' : hit.status,
        labels: [...(hit.labels || []), ...((state.labels || {})[argv[1]] || [])],
      }
    : null;
  // The real bd exits 0 on a miss and prints an OBJECT where a hit is an array.
  process.stdout.write(JSON.stringify(live ? [live] : { error: 'no issues found' }));
} else if (argv[0] === 'update' && argv.includes('--claim')) {
  state.claimed.push(argv[1]);
  save();
} else if (argv[0] === 'update' && argv.includes('--add-label')) {
  const label = argv[argv.indexOf('--add-label') + 1];
  state.labels = state.labels || {};
  (state.labels[argv[1]] = state.labels[argv[1]] || []).push(label);
  save();
} else if (argv[0] === 'close') {
  state.claimed.push(argv[1]);
  (state.closed = state.closed || []).push(argv[1]);
  save();
}
process.exit(0);
`,
  );

  shim(
    dir,
    'npm',
    `${SHIM_PREAMBLE}
record('npm');
// A REHEARSED GATE FAILURE. \`state.builds\` is incremented by the claude shim,
// so during attempt N's gate it reads N — which is how one attempt's gate is
// failed without touching the next one's.
if (
  plan.gateFailOnAttempt &&
  state.builds === plan.gateFailOnAttempt &&
  argv[0] === 'run' &&
  argv[1] === plan.gateFailStep
) {
  process.stderr.write('rehearsed gate failure: ' + argv[1] + '\\n');
  process.exit(1);
}
process.exit(0);
`,
  );

  shim(
    dir,
    'claude',
    `${SHIM_PREAMBLE}
record('claude');
const step = plan.build[Math.min(state.builds, plan.build.length - 1)];
state.builds += 1;
save();
// The operator running \`npm run loop:stop\` while a BUILD is in flight. The
// file is what the driver polls at every stage boundary.
if (plan.haltDuringBuild) {
  fs.writeFileSync(path.join(process.cwd(), '.loop', 'HALT'), '');
}
if (step.edit) {
  // NAMED BY THE STEP when a scenario needs two iterations to collide on ONE
  // file (Cebab-qd2.44); otherwise per-build, so every other scenario keeps a
  // diff that cannot conflict with its neighbour by accident.
  const rel = step.file || ('src/feature-' + state.builds + '.js');
  const abs = path.join(process.cwd(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'export const answer = ' + (40 + state.builds) + ';\\n');
}
const sessionId = 'sess-' + (state.session ||= 'a1b2c3');
// THE FOUR TOKEN CLASSES, IN A REALISTIC RATIO. Cache reads dominate an agent
// loop by 10-40x, which is exactly why \`meteredTokens\` excludes them — a
// fixture with four similar numbers would let a summed total pass every
// assertion here. (Cebab-qd2.38)
const usage = {
  input_tokens: 1200, output_tokens: 340,
  cache_read_input_tokens: 900000, cache_creation_input_tokens: 5600,
};
if (step.kind === 'max_turns') {
  process.stdout.write(JSON.stringify({
    type: 'result', session_id: sessionId, num_turns: 60, total_cost_usd: 0.5,
    usage, duration_ms: 432000,
    terminal_reason: 'max_turns', errors: ['Reached maximum number of turns (60)'],
  }));
  process.exit(1);
}
// A DECLINE: the build SUCCEEDS and the verdict is a refusal. Every other
// evidence line the harvest note is built from is empty for this shape, which
// is the whole of Cebab-qd2.36.
if (step.kind === 'decline') {
  process.stdout.write(JSON.stringify({
    type: 'result', session_id: sessionId, num_turns: 5, total_cost_usd: 0.5, is_error: false,
    usage, duration_ms: 61000,
    structured_output: {
      outcome: 'blocked',
      summary: 'The deny hook blocks gh outright, so this bead is not reachable by the loop.',
      commit_type: 'fix', commit_scope: 'rehearsal', commit_subject: 'nothing was done',
      files_changed: [],
      tests: { added: [], commands_run: [] },
      risk: 'low', needs_human: true, follow_ups: [],
    },
  }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  type: 'result', session_id: sessionId, num_turns: 7, total_cost_usd: 0.2, is_error: false,
  usage, duration_ms: 61000,
  structured_output: {
    outcome: 'implemented',
    summary: 'rehearsal change',
    commit_type: 'fix', commit_scope: 'rehearsal', commit_subject: 'a rehearsed change',
    files_changed: ['src/feature.js'],
    // WHAT THE AGENT CLAIMS IT RAN. Per-scenario because verdictVsGate is a
    // comparison between this list and the gate's own result, and with a list
    // that never names the step the gate reddens on, 'disagree' is unreachable
    // and the field is untested in both directions. (Cebab-qd2.43)
    tests: { added: [], commands_run: plan.claimedCommands || ['npm run lint', 'npm test'] },
    risk: 'low', needs_human: false, follow_ups: [],
  },
}));
process.exit(0);
`,
  );

  shim(
    dir,
    'gh',
    `${SHIM_PREAMBLE}
record('gh');
const cwd = process.cwd();
const out = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o));
const runGit = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

if (argv[0] === 'auth') process.exit(0);

if (argv[0] === 'pr' && argv[1] === 'create') {
  state.pr += 1;
  // The body arrives on stdin (\`--body-file -\`). Read rather than ignored:
  // the note Cebab-qd2.44 asks for is IN it, and an unread pipe is also the
  // only thing between the driver and an EPIPE.
  let body = '';
  try { body = fs.readFileSync(0, 'utf8'); } catch { body = ''; }
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const files = runGit(['diff', '--name-only', 'main...HEAD'])
    .split('\\n').map((l) => l.trim()).filter(Boolean);
  const url = 'https://github.invalid/o/r/pull/' + state.pr;
  state.prs.push({
    number: state.pr, url, headRefName: branch, files: files.map((f) => ({ path: f })),
  });
  state.bodies[String(state.pr)] = body;
  save();
  out(url + '\\n');
  process.exit(0);
}

if (argv[0] === 'pr' && argv[1] === 'list') {
  // A \`gh\` that answers, versus one that cannot — the overlap report has to
  // tell those apart, and a shim that only ever succeeds cannot show it does.
  if (plan.prListFail) { process.stderr.write('rehearsed gh pr list failure\\n'); process.exit(1); }
  // A RIVAL PR THAT LANDS MID-ITERATION. From build N onward the named PR is
  // gone from the open list — the only way to ask whether a later clean check
  // CLEARS an earlier finding, rather than leaving a stale one on the row.
  const hide = plan.hidePr && state.builds >= plan.hidePrAfterBuild ? plan.hidePr : null;
  // Only the ones still OPEN: a merged PR cannot conflict with anything.
  out(
    state.prs.filter((p) => !(state.mergedPrs || []).includes(p.number) && p.number !== hide),
  );
  process.exit(0);
}

if (argv[0] === 'pr' && argv[1] === 'edit') process.exit(0);

if (argv[0] === 'api') {
  // CHECKS BELONG TO A PULL REQUEST, AND THIS SHIM USED TO FORGET IT.
  //
  // Cebab's CI triggers on \`pull_request\` only, so a pushed branch with no PR
  // gets no check runs at all. The shim answered every poll regardless, which
  // made the harness VACUOUS for exactly the bug that broke the first
  // unattended night: \`capped-then-resume\` traverses the path where attempt 2
  // reaches PUBLISH having never created a PR (Cebab-qd2.18), and it passed,
  // because the fake GitHub reported green checks for a pull request that did
  // not exist.
  //
  // Modelling the dependency is what turns that scenario into a real
  // revert-check: restore \`attempt === 1\` in PUBLISH and it reddens.
  if (!state.pr) { out({ check_runs: [] }); process.exit(0); }
  // The required check is gated behind the matrix, so the FIRST poll shows a
  // pending sibling and no required check at all — the exact shape that used
  // to be misread as "CI never started".
  state.polls += 1; save();
  const required = 'Lint, Typecheck, Test';
  const url = 'https://github.invalid/o/r/runs/900' + state.polls;
  if (state.polls < 2) {
    out({ check_runs: [{ name: 'quality', status: 'in_progress', conclusion: null, html_url: url }] });
    process.exit(0);
  }
  // An ARRAY is per-attempt: index by the build count so a repair can see a
  // different answer from the attempt that provoked it.
  const want = plan.ciAfterRerun && (state.reruns || 0) > 0
    ? plan.ciAfterRerun
    : Array.isArray(plan.ci)
      ? plan.ci[Math.min(Math.max(state.builds - 1, 0), plan.ci.length - 1)]
      : plan.ci;
  // FOUR SHAPES, because the driver now distinguishes four. A shim that could
  // only say success-or-failure made the harness unable to see the blocked and
  // infra paths at all, which is the same vacuity the no-PR case above records.
  if (want === 'blocked') {
    // The required context passes and a DIFFERENT required check does not.
    // Modelled on PR #432, where a fixture-review gate is red by design until a
    // human clears a label.
    out({ check_runs: [
      { name: 'quality', status: 'completed', conclusion: 'success', html_url: url },
      { name: required, status: 'completed', conclusion: 'success', html_url: url },
      { name: 'Fixture review gate', status: 'completed', conclusion: 'failure', html_url: url },
    ] });
    process.exit(0);
  }
  if (want === 'infra') {
    // A matrix leg KILLED by a job timeout. The aggregator reports plain
    // failure either way, so the cancelled sibling is the only evidence.
    out({ check_runs: [
      { name: 'quality (windows-2022)', status: 'completed', conclusion: 'cancelled', html_url: url },
      { name: required, status: 'completed', conclusion: 'failure', html_url: url },
    ] });
    process.exit(0);
  }
  const conclusion = want === 'green' ? 'success' : 'failure';
  out({ check_runs: [
    { name: 'quality', status: 'completed', conclusion, html_url: url },
    { name: required, status: 'completed', conclusion, html_url: url },
  ] });
  process.exit(0);
}

if (argv[0] === 'run' && argv[1] === 'rerun') {
  state.reruns = (state.reruns || 0) + 1;
  // The driver's grace window after a re-run is counted in POLLS, so the poll
  // counter has to move too or the next answer served is the stale one.
  state.polls = 1;
  save();
  process.exit(0);
}

if (argv[0] === 'run' && argv[1] === 'view') { out('a failing log\\n'); process.exit(0); }

if (argv[0] === 'pr' && argv[1] === 'merge') {
  const auto = argv.includes('--auto');
  if (plan.merge === 'refused') process.exit(1);
  if (plan.merge === 'queued' && !auto) process.exit(1);
  if (plan.merge === 'queued' && auto) { state.queued = true; save(); process.exit(0); }
  // A fast-forward push IS the merge here — main has not moved. See the header.
  runGit(['push', 'origin', 'HEAD:main']);
  state.merged = runGit(['rev-parse', 'HEAD']);
  // \`gh pr list --state open\` must stop serving what has been merged, or the
  // overlap report would warn about a PR that is already on main.
  (state.mergedPrs = state.mergedPrs || []).push(state.pr);
  save();
  if (plan.breakRemoteAfterMerge) {
    fs.renameSync(path.join(DIR, 'origin.git'), path.join(DIR, 'origin.git.gone'));
  }
  process.exit(0);
}

if (argv[0] === 'pr' && argv[1] === 'view') {
  if (state.merged) out({ state: 'MERGED', mergeCommit: { oid: state.merged }, mergedAt: 'now' });
  else out({ state: 'OPEN', mergeCommit: null, mergedAt: null });
  process.exit(0);
}
process.exit(0);
`,
  );
}

function buildScratch(name, scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loop-rehearse-${name}-`));
  const repo = path.join(dir, 'repo');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });

  // A bare origin, and a working clone of it.
  execFileSync('git', ['init', '--bare', '--quiet', path.join(dir, 'origin.git')]);
  git(path.join(dir, 'origin.git'), ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  execFileSync('git', ['init', '--quiet', repo]);
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  for (const [k, v] of [
    ['user.email', 'rehearsal@example.invalid'],
    ['user.name', 'Loop Rehearsal'],
    ['commit.gpgsign', 'false'],
  ]) {
    git(repo, ['config', k, v]);
  }

  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'seed.js'), 'export const seed = 1;\n');
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    `${JSON.stringify({ name: 'rehearsal', private: true, version: '0.0.0' }, null, 2)}\n`,
  );
  // `.loop/` holds the lock, the config and the ledger, and preflight refuses a
  // dirty tree — so without this the run stops before SELECT. The real repo
  // gitignores it for the same reason; `clean -fd` also spares it, which is
  // what keeps the ledger alive across the per-iteration restore.
  fs.writeFileSync(path.join(repo, '.gitignore'), '.loop/\n');
  // GATE step 1 is `git diff --exit-code package-lock.json`, which exits 128 —
  // not 1 — when the path does not exist at all. The real repo always has one;
  // a scratch repo without it fails the very first gate step for a reason that
  // has nothing to do with the diff under test.
  fs.writeFileSync(
    path.join(repo, 'package-lock.json'),
    `${JSON.stringify({ name: 'rehearsal', lockfileVersion: 3, packages: {} }, null, 2)}\n`,
  );

  // The driver, verbatim. Its repo root is its own directory's parent, which is
  // why it has to be copied rather than invoked in place.
  fs.mkdirSync(path.join(repo, 'scripts', 'lib'), { recursive: true });
  fs.cpSync(path.join(REPO, 'scripts', 'lib', 'loop'), path.join(repo, 'scripts', 'lib', 'loop'), {
    recursive: true,
  });
  fs.copyFileSync(path.join(REPO, 'scripts', 'loop.mjs'), path.join(repo, 'scripts', 'loop.mjs'));
  // See the header: the real one kills tsx watch processes on this machine.
  fs.writeFileSync(
    path.join(repo, 'scripts', 'predev-server.mjs'),
    '// rehearsal stub — the real sweep would kill the operator’s dev server\n',
  );

  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'seed']);
  git(repo, ['remote', 'add', 'origin', path.join(dir, 'origin.git')]);
  git(repo, ['push', '-q', '-u', 'origin', 'main']);

  // A DRIVER FIX THAT LANDED AFTER THIS RUN'S PROCESS WOULD HAVE STARTED.
  //
  // The commit is pushed and then reset away locally, so the working clone is
  // exactly one behind origin — the state preflight's `git pull --ff-only`
  // exists to correct, and the state that rewrites `scripts/loop.mjs` under a
  // process that already imported it.
  //
  // The marker goes in the DRIVER rather than in a new file on purpose: a new
  // file would only prove the pull happened, which was never in doubt. A line
  // at the top level of `loop.mjs` runs at import, so it appears exactly once
  // and only in a process that loaded the PULLED copy. (Cebab-qd2.35)
  if (scenario.plan.originAhead) {
    fs.appendFileSync(
      path.join(repo, 'scripts', 'loop.mjs'),
      `\nprocess.stderr.write('REHEARSED-NEW-DRIVER\\n');\n`,
    );
    git(repo, ['add', 'scripts/loop.mjs']);
    git(repo, ['commit', '-qm', 'a driver fix that landed after this run started']);
    git(repo, ['push', '-q', 'origin', 'main']);
    git(repo, ['reset', '--hard', '-q', 'HEAD~1']);
  }

  const beadRows = Array.from({ length: scenario.plan.beads }, (_, i) => ({
    id: `Reh-${i + 1}`,
    title: `rehearsal bead ${i + 1}`,
    description: 'A bead the rehearsal invents so the driver has something to work.',
    status: 'open',
    priority: 2,
    issue_type: 'task',
  }));
  // A ROLLUP AT THE HEAD OF THE QUEUE: Reh-1 is the parent of Reh-2, and bd
  // returns both as ready. `issue_type` says nothing about it — measured live,
  // the real ones were typed `feature` — so the only signal is `parent`, which
  // is why the shim rows carry it. (Cebab-qd2.40)
  // The 2026-08-27 incident, expressible: Reh-2 is Reh-1's child AND is already
  // in_progress, so `bd ready` never mentions it and only the GRAPH says Reh-1
  // contains unfinished work.
  if (scenario.plan.withheldChild && beadRows.length > 1) {
    beadRows[1].parent = beadRows[0].id;
    beadRows[1].status = 'in_progress';
  }
  if (scenario.plan.containerFirst && beadRows.length > 1) {
    beadRows[1].parent = beadRows[0].id;
  }
  // ROWS bd RETURNS AND THE DRIVER THROWS AWAY — the asymmetry Cebab-qd2.48 is
  // about. The deny-path text scan is the cheapest real exclusion to express
  // here: `.github/` is a stem of the default `guard.denyPaths`, so these rows
  // are filtered by `eligibleBeads` and never by bd. Put enough of them at the
  // head of the queue and a capped window contains nothing else.
  for (let i = 0; i < Math.min(scenario.plan.excludedBeads ?? 0, beadRows.length); i += 1) {
    beadRows[i].description = 'This bead edits .github/workflows/ci.yml, a denied path.';
  }
  fs.writeFileSync(
    path.join(dir, 'plan.json'),
    JSON.stringify({ ...scenario.plan, beadRows }, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, 'shim-state.json'),
    JSON.stringify({
      claimed: [],
      closed: [],
      labels: {},
      builds: 0,
      polls: 0,
      reruns: 0,
      pr: 0,
      merged: null,
      queued: false,
      // Every PR the run opened, with the file list read off the REAL diff at
      // create time — so `gh pr list` answers with what this run actually did
      // rather than with a fixture. That is what makes the overlap report's
      // input the driver's own behaviour. `Cebab-qd2.44`.
      prs: [],
      // Keyed by PR number. `--body-file -` means the body arrives on stdin and
      // is otherwise unobservable, and the note the bead asks for lives there.
      bodies: {},
    }),
  );
  fs.writeFileSync(path.join(dir, 'calls.jsonl'), '');
  writeShims(bin);

  fs.mkdirSync(path.join(repo, '.loop'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.loop', 'config.json'),
    JSON.stringify(
      {
        gate: { playgroundTier: 'never', auditGate: false, stepTimeoutMs: 60000 },
        ci: { pollIntervalMs: 10, appearTimeoutMs: 60000, completeTimeoutMs: 60000 },
        build: { timeoutMs: 60000 },
      },
      null,
      2,
    ),
  );
  // A branch left behind by a run that was killed before its teardown could
  // delete it — the state CLAIM has to survive. Created here rather than by a
  // shim because it is repo state, not a tool's answer.
  if (scenario.plan.preexistingBranch) {
    git(repo, ['branch', `loop/${scenario.plan.preexistingBranch}`]);
  }

  return { dir, repo, bin, baseSha: git(repo, ['rev-parse', 'HEAD']) };
}

// ─── running one scenario ──────────────────────────────────────────────────

function runScenario(name, scenario) {
  const scratch = buildScratch(name, scenario);
  const result = spawnSync(process.execPath, ['scripts/loop.mjs', ...scenario.args], {
    cwd: scratch.repo,
    encoding: 'utf8',
    timeout: 180000,
    env: {
      ...process.env,
      PATH: `${scratch.bin}${path.delimiter}${process.env.PATH}`,
      REHEARSAL_DIR: scratch.dir,
    },
  });

  const ledger = path.join(scratch.repo, '.loop', 'runs.jsonl');
  const records = fs.existsSync(ledger)
    ? fs
        .readFileSync(ledger, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  const calls = { bd: [], gh: [], npm: [], claude: [] };
  const callRows = [];
  for (const line of fs.readFileSync(path.join(scratch.dir, 'calls.jsonl'), 'utf8').split('\n')) {
    if (!line) continue;
    const row = JSON.parse(line);
    calls[row.tool]?.push(row.argv);
    callRows.push(row);
  }

  const failures = [];
  const ctx = {
    records,
    calls,
    // The same calls with the process they came from attached — see `record`
    // in the shim preamble.
    callRows,
    scratch,
    baseSha: scratch.baseSha,
    stdout: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    // Kept APART as well as combined: `--json` promises stdout is a clean JSONL
    // stream, and a combined buffer cannot tell you whether it is.
    rawStdout: result.stdout ?? '',
    rawStderr: result.stderr ?? '',
    exitCode: result.status,
    // The durable exit code (Cebab-qd2.27). `loop:night` pipes through `tee`,
    // so `exitCode` above is the PIPELINE's — this is the driver's own answer.
    state: () => {
      const p = path.join(scratch.repo, '.loop', 'state.json');
      return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
    },
    ok: (value, what) => {
      if (!value) failures.push(what);
    },
    eq: (actual, expected, what) => {
      if (actual !== expected) failures.push(`${what} (got ${JSON.stringify(actual)})`);
    },
    // How many pull requests this run actually opened. The count matters in
    // BOTH directions: zero is Cebab-qd2.18, and two is the double-PR the
    // `attempt === 1` guard existed to prevent.
    prCreates: () => calls.gh.filter((c) => c[0] === 'pr' && c[1] === 'create').length,
    // What the driver actually WROTE into a PR. `--body-file -` puts it on
    // stdin, so `calls.gh` — which records argv only — cannot see it, and an
    // assertion about a note in the body has nowhere else to look.
    prBody: (number) => {
      const p = path.join(scratch.dir, 'shim-state.json');
      if (!fs.existsSync(p)) return '';
      return JSON.parse(fs.readFileSync(p, 'utf8')).bodies?.[String(number)] ?? '';
    },
    originSha: () => {
      const bare = path.join(scratch.dir, 'origin.git');
      if (!fs.existsSync(bare)) return null;
      return git(bare, ['rev-parse', 'main']);
    },
    mainContains: (sha) => {
      const bare = path.join(scratch.dir, 'origin.git');
      if (!fs.existsSync(bare) || !sha) return false;
      return (
        spawnSync('git', ['merge-base', '--is-ancestor', sha, 'main'], { cwd: bare }).status === 0
      );
    },
    refSha: (ref) => {
      const bare = path.join(scratch.dir, 'origin.git');
      if (!fs.existsSync(bare)) return null;
      const r = spawnSync('git', ['rev-parse', ref], { cwd: bare, encoding: 'utf8' });
      return r.status === 0 ? r.stdout.trim() : null;
    },
    parentOf: (sha) => {
      const bare = path.join(scratch.dir, 'origin.git');
      if (!fs.existsSync(bare) || !sha) return null;
      return git(bare, ['rev-parse', `${sha}^`]);
    },
  };

  try {
    scenario.check(ctx);
  } catch (error) {
    failures.push(`check threw: ${error?.message ?? error}`);
  }

  if (!process.env.KEEP) fs.rmSync(scratch.dir, { recursive: true, force: true });
  else process.stdout.write(`  kept: ${scratch.dir}\n`);
  return { failures, ctx, result };
}

export function rehearse(names = Object.keys(SCENARIOS)) {
  const results = [];
  for (const name of names) {
    const scenario = SCENARIOS[name];
    if (!scenario) throw new Error(`unknown scenario ${name}`);
    results.push({ name, why: scenario.why, ...runScenario(name, scenario) });
  }
  return results;
}

export const SCENARIO_NAMES = Object.keys(SCENARIOS);

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const results = rehearse(wanted.length > 0 ? wanted : undefined);
  let bad = 0;
  for (const r of results) {
    const mark = r.failures.length === 0 ? 'PASS' : 'FAIL';
    process.stdout.write(`${mark}  ${r.name.padEnd(20)} ${r.why}\n`);
    for (const f of r.failures) process.stdout.write(`        - ${f}\n`);
    if (r.failures.length > 0) {
      bad += 1;
      process.stdout.write(`${r.ctx.stdout.split('\n').slice(-25).join('\n        | ')}\n`);
    }
  }
  process.exit(bad === 0 ? 0 : 1);
}
