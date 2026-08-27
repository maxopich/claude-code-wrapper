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
      build: [
        { kind: 'verdict', edit: true },
        { kind: 'verdict', edit: true },
      ],
    },
    check: (ctx) => {
      const [row] = ctx.records;
      ctx.eq(ctx.calls.claude.length, 2, 'the gate failure bought a second attempt');
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
  const open = plan.beadRows.filter((b) => !state.claimed.includes(b.id));
  process.stdout.write(JSON.stringify(open));
} else if (argv[0] === 'show') {
  const hit = plan.beadRows.find((b) => b.id === argv[1]);
  // The real bd exits 0 on a miss and prints an OBJECT where a hit is an array.
  process.stdout.write(JSON.stringify(hit ? [hit] : { error: 'no issues found' }));
} else if (argv[0] === 'update' && argv.includes('--claim')) {
  state.claimed.push(argv[1]);
  save();
} else if (argv[0] === 'close') {
  state.claimed.push(argv[1]);
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
  fs.writeFileSync(path.join(process.cwd(), 'src', 'feature-' + state.builds + '.js'),
    'export const answer = ' + (40 + state.builds) + ';\\n');
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
    tests: { added: [], commands_run: ['npm run lint', 'npm test'] },
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
  state.pr += 1; save();
  out('https://github.invalid/o/r/pull/' + state.pr + '\\n');
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
  const want = Array.isArray(plan.ci)
    ? plan.ci[Math.min(Math.max(state.builds - 1, 0), plan.ci.length - 1)]
    : plan.ci;
  const conclusion = want === 'green' ? 'success' : 'failure';
  out({ check_runs: [
    { name: 'quality', status: 'completed', conclusion, html_url: url },
    { name: required, status: 'completed', conclusion, html_url: url },
  ] });
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
  state.merged = runGit(['rev-parse', 'HEAD']); save();
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
  fs.writeFileSync(
    path.join(dir, 'plan.json'),
    JSON.stringify({ ...scenario.plan, beadRows }, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, 'shim-state.json'),
    JSON.stringify({ claimed: [], builds: 0, polls: 0, pr: 0, merged: null, queued: false }),
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
