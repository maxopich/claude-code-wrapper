# Autonomous Loop — Build Specification

**Status:** approved for implementation · **Drafted:** 2026-08-25 · **Target:** `scripts/loop.mjs`
**Companion design note:** [The Bead Loop](https://claude.ai/code/artifact/fdf939e1-6b5d-49c2-ab0d-aa014c28b808) — read it for _why_; this document is _what_.

---

## 0. How to use this document

You are implementing a driver that runs the maintainer's development loop unattended: take one
ready bead, implement it, gate it, open a PR, wait for CI, merge on green, close the bead, file
what it discovered, repeat.

Three rules govern every decision below, and they are not stylistic:

1. **The driver owns control flow. The agent owns one stage.** Stage `BUILD` is a sub-invocation
   of Claude Code. Every other stage is deterministic code in `loop.mjs`. Do not move work from
   the driver into the agent to "simplify" — that is the change that breaks this design.
2. **The agent's report is not evidence.** Stage `GATE` re-runs what the agent claims it ran, and
   records the disagreement when they differ. Never gate on a field of the agent's verdict.
3. **Fail loud, park quietly.** A bead the loop cannot land is parked with its evidence attached
   and the loop continues. A condition the loop cannot reason about halts it.

Section 12 is the acceptance checklist. Work against it.

> `bd` CLI flags in this document are written from the maintainer's usage and the beads MCP
> surface. **Verify each one with `bd <subcommand> --help` before wiring it in** rather than
> trusting this document; correct any divergence here in the same PR. Known trap (from project
> memory): the beads _MCP_ `list` tool omits the `dependencies` array — use
> `bd list --json --all` when the graph matters.

---

## 1. Scope

**In scope — build this:**

- A serial, one-bead-at-a-time driver, run from the main checkout on a feature branch.
- Eight stages: `SELECT → CLAIM → BUILD → GATE → PUBLISH → WATCH → LAND → HARVEST`.
- Auto-merge on green CI, behind a guard.
- A run ledger, a `HALT` kill switch, and a consecutive-failure circuit breaker.
- Unit tests for all pure logic.

**Explicitly out of scope — do not build, do not design for:**

- Parallelism, worktrees, worktree pools, port allocation, merge queues. _Serial only._
- Any GitHub Actions component.
- Any integration with Cebab's own multi-agent bus.
- Kanban board syncing per iteration (see **R1** — it happens once, at the end of a run).

---

## 2. Decisions already made

Do not re-litigate these. They were settled with the maintainer.

| Decision               | Value                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Concurrency            | Serial, one bead at a time                                                                                                         |
| Workspace              | Main checkout, feature branch per bead. **No worktrees.**                                                                          |
| Merge policy           | Auto-merge on green CI, subject to the guard (§8)                                                                                  |
| Gate depth             | Deterministic always; Playground tier when the bead touches `server/**` or `shared/**` (§6.4)                                      |
| CI failure disposition | Park and continue, with a 3-strike circuit breaker (§6.6, §8.3)                                                                    |
| Follow-up beads        | Filed at priority 3, no label gate, no exclusion from selection                                                                    |
| Repair attempts        | 2 per bead, then park                                                                                                              |
| Usage limits           | `--max-budget-usd` per BUILD + react to the limit message on stderr (§8.4). Remaining quota still cannot be queried from a script. |

---

## 3. Deliverables

```
scripts/loop.mjs                    # entry point + stage orchestration
scripts/lib/loop/config.mjs         # defaults, file load, CLI merge, validation
scripts/lib/loop/machine.mjs        # PURE: stage transitions. No I/O.
scripts/lib/loop/guard.mjs          # PURE: deny-list, caps, diff analysis
scripts/lib/loop/select.mjs         # bead selection + per-run exclusions
scripts/lib/loop/gate.mjs           # deterministic + playground tiers
scripts/lib/loop/build.mjs          # the claude -p sub-invocation
scripts/lib/loop/git.mjs            # branch/commit/push/reset
scripts/lib/loop/forge.mjs          # gh: pr create, pr checks, pr merge
scripts/lib/loop/beads.mjs          # bd: ready, update, create, close, dep
scripts/lib/loop/ledger.mjs         # .loop/runs.jsonl append + read
scripts/lib/loop/run.mjs            # THE ONLY execFile/spawn seam (injectable)
scripts/lib/loop/verdict.schema.json
scripts/lib/loop/build-prompt.md    # the BUILD prompt template
scripts/lib/loop/build-system.md    # appended to the BUILD agent's system prompt
scripts/loop.test.mjs               # vitest, colocated with the other scripts/*.test.mjs
.claude/loop-settings.json          # settings override for BUILD sessions (see R1)
.claude/hooks/loop-guard.sh         # PreToolUse deny hook for BUILD sessions (see §7.3)
```

**Also change:**

- `package.json` → add the `loop`, `loop:night`, `loop:stop`, `loop:watch`, `loop:status` and
  `loop:recover` scripts (§5.2).
- `.gitignore` → add `.loop/` (runtime state; never committed).

**Tracked vs ignored — a deliberate call.** `scripts/loop.mjs`, its library and its test are
**tracked**, so `npm test` in CI gates them. `scripts/kanban-sync.mjs` was gitignored and CI
therefore never ran its 20 tests; that is `Cebab-8fa`, still open. Do not repeat it. Only `.loop/`
(runtime) and `.claude/loop-settings.json` (machine-local) stay out of git.

Every module except `run.mjs`, `gate.mjs`, `git.mjs`, `forge.mjs` and `beads.mjs` must be free of
I/O so it can be unit-tested directly. Those five take an injected `run` function.

---

## 4. Configuration

Resolution order: built-in defaults → `.loop/config.json` if present → CLI flags. Validate the
merged object and **exit 2 with a named error on any unknown key** — a typo in a deny-list path
must not silently widen the guard.

```jsonc
{
  "select": {
    "maxPriority": 2, // ignore beads with priority > this (0 = highest)
    "excludeLabels": ["loop-stuck", "needs-human", "epic"],
    "excludeTypes": ["epic", "decision"],
    "excludeIdPrefixes": [],
    "sortPolicy": "hybrid", // passed through to `bd ready`
  },
  "build": {
    "model": "opus", // default tier
    "effort": "high",
    "maxTurns": 60, // the single biggest consumption lever
    "permissionMode": "acceptEdits",
    "timeoutMs": 2400000, // 40 min

    // Model/effort tiering. DEFAULT OFF — an empty array means every bead gets the
    // model and effort above. Implement the matching, ship it disabled; the maintainer
    // turns it on once there is ledger data showing where the consumption actually goes.
    // Shape, when enabled (first match wins):
    //   [{ "when": { "pathPrefix": ["server/","shared/"] }, "model": "opus",   "effort": "high"   },
    //    { "when": { "maxPriority": 1 },                    "model": "opus",   "effort": "high"   },
    //    { "when": { "type": ["docs","chore"] },            "model": "sonnet", "effort": "medium" }]
    "tiers": [],
  },
  "gate": {
    "playgroundTier": "auto", // "auto" | "always" | "never"
    "playgroundTriggerPaths": ["server/", "shared/"],
    // Sibling of the checkout, not a subdirectory of it. The `.env` written per
    // Playground/README.md must point CEBAB_DATA_DIR and WORKSPACE_ROOT inside
    // this root; preflight refuses to start otherwise (§6.4, R2).
    "playgroundRoot": "../Playground",
    "liveSmokes": false, // see §6.4 — these spawn real `claude` sessions
    "auditGate": true, // network-dependent; a network error is a skip, not a fail
    "stepTimeoutMs": 900000,
  },
  "guard": {
    "denyPaths": [
      ".github/**",
      ".husky/**",
      ".semgrep/**",
      ".npmrc",
      ".gitleaks.toml",
      "osv-scanner.toml",
      "eslint.config.js",
      "vitest.config.ts",
      "vitest.setup.mjs",
      "scripts/audit-gate.mjs",
      "scripts/security-test-gate.mjs",
      "scripts/kanban-sync.mjs",
      "scripts/kanban-sync.test.mjs",
      "package-lock.json",
    ],
    "maxFilesChanged": 25,
    "maxNetLinesAdded": 600,
    "allowTestDeletions": false,
    "forbidInDiff": ["--no-verify"],
  },
  "ci": {
    "requiredContext": "Lint, Typecheck, Test",
    "pollIntervalMs": 30000,
    "appearTimeoutMs": 300000, // no such check after 5 min → infra problem, park
    "completeTimeoutMs": 1800000, // 30 min
  },
  "loop": {
    "until": "1", // stop condition(s) — see §5.1. Default: one bead.
    "maxRepairs": 2,
    "consecutiveParkLimit": 3,
    "merge": false, // DEFAULT OFF. Merging requires an explicit --merge.
  },

  // ── Budget limits. EVERY ONE OF THESE DEFAULTS TO OFF. ──────────────────────
  // Build them all, wire them all, ship them all inert. The maintainer wants to
  // observe real runs before constraining them, and a limit that fires unasked
  // during the first week is indistinguishable from a bug. `reserveMs` is the one
  // exception and it is inert on its own: it only applies once a time-based
  // `until` exists to reserve against. See §8.4.
  "limits": {
    "costCeilingUsd": null, // whole-run; a token proxy, NOT a bill (§8.4)
    "beadCostCeilingUsd": null, // abandon a single runaway bead
    "cooldownMsBetweenBeads": 0, // paces the rolling usage window
    "reserveMs": 2700000, // 45 min — don't START a bead this close to a time deadline
    "onSessionLimit": "halt", // "halt" | "sleep_until_reset" — reactive, not a budget
    "onWeeklyLimit": "halt", // ALWAYS halt; a weekly reset can be days away
  },
  "harvest": {
    "followUpPriority": 3,
    "followUpLabel": "loop-found", // informational only; NOT a selection filter
    "syncBoardAtEnd": true,
  },
}
```

`loop.merge` defaults to **false**. The first runs must be observable before anything merges
itself; the maintainer opts in with `--merge`.

---

## 5. CLI and exit codes

```
node scripts/loop.mjs [options]

  --bead <id>          Work this specific bead, skip SELECT entirely
  --until <value>      Stop condition. Repeatable; first to trip wins. See §5.1.
  --merge              Enable LAND. Without it the loop stops after WATCH.
  --dry-run            Run SELECT..GATE, then report. No commit, no push, no PR, no bd writes.
  --no-playground      Force gate.playgroundTier = "never"
  --config <path>      Alternate config file
  --status             Print .loop/state.json + the last 10 ledger records, then exit
  --json               Emit one ledger record per line on stdout instead of human output
  -v, --verbose        Stream sub-process output
```

| Code | Meaning                                                                                 |
| ---- | --------------------------------------------------------------------------------------- |
| 0    | Ran to a clean stop. Zero or more beads landed; zero or more parked.                    |
| 1    | Halted by the circuit breaker, a budget ceiling, or an unrecoverable stage error.       |
| 2    | Refused to start: failed preflight, invalid config, dirty working tree, `HALT` present. |
| 130  | SIGINT. Finish the current stage, write the ledger record, then exit.                   |

**Signal handling is a requirement, not a nicety.** On SIGINT/SIGTERM the driver must never leave
the repo on a feature branch with a spawned `dev:server` still running. Trap both, run the same
teardown as a parked iteration, then exit.

### 5.1 `--until` — one flag, four forms

A single polymorphic stop condition, because bead-count, clock-time and wall-clock budget are the
same decision. Parse by shape; **any unrecognised value is exit 2 with a named error**, never a
silent fallback to the default.

| Form        | Matches             | Means                                                                              |
| ----------- | ------------------- | ---------------------------------------------------------------------------------- |
| `8`         | `/^\d+$/`           | Stop after 8 completed iterations (merged, parked or no-change all count)          |
| `07:00`     | `/^\d{1,2}:\d{2}$/` | Stop at the next occurrence of that **local** time. Already past today → tomorrow. |
| `2h`, `90m` | `/^\d+[hm]$/`       | Stop that long from now                                                            |
| `drain`     | literal             | Stop when `bd ready` returns nothing selectable                                    |

**Repeatable — first condition to trip wins.** `--until 8 --until 07:00` is the overnight shape:
eight beads, or 7am, whichever arrives first.

Default when omitted: `1`. Conservative on purpose.

`limits.reserveMs` applies to the time-based forms only: with less than that remaining, the loop
stops before SELECT rather than starting a bead that will be cut off half-built. A count-based or
`drain` condition has no deadline to reserve against, so `reserveMs` is inert.

Evaluate conditions at the top of each iteration, and record which one tripped in the final
`--status` line and the run's last ledger record.

### 5.2 Operating the loop

The driver must behave correctly under all of the following. These are requirements, not
suggestions — §12 tests them.

**The one-liners.** Ship these as npm scripts in `package.json` so they travel with the repo and
need no shell configuration:

```jsonc
"loop":         "node scripts/loop.mjs",
"loop:night":   "mkdir -p .loop && tmux new -d -s cebab-loop 'caffeinate -is node scripts/loop.mjs --merge --until 8 --until 07:00 2>&1 | tee -a .loop/console.log' && echo 'started — npm run loop:watch'",
"loop:stop":    "mkdir -p .loop && touch .loop/HALT && echo 'HALT set — stops at the next stage boundary'",
"loop:watch":   "tmux attach -t cebab-loop",
"loop:status":  "node scripts/loop.mjs --status",
"loop:recover": "git checkout main && git reset --hard && (pkill -f 'tsx watch' || true) && rm -f .loop/HALT && echo recovered"
```

`loop:recover` deliberately does **not** run `git clean` — untracked files here include
`.claude/settings.local.json` and the maintainer's `.env`, and `git reset --hard` already discards
everything the loop could have written to tracked files.

**Starting.** Foreground, watched:

```sh
npm run loop -- --bead Cebab-vie.15            # one bead, no merge, you watch
npm run loop -- --dry-run --bead Cebab-vie.15  # no writes at all
npm run loop -- --merge --until 3              # three beads, merging
```

Detached, overnight — `npm run loop:night`, which expands to:

```sh
tmux new -d -s cebab-loop \
  'caffeinate -is node scripts/loop.mjs --merge --until 8 --until 07:00 2>&1 | tee -a .loop/console.log'
```

`caffeinate -is` is load-bearing: a Mac that sleeps stops the loop mid-bead, and the teardown in
§6.8 never runs. `-i` blocks idle sleep, `-s` blocks system sleep on AC power. A closed lid on
battery still sleeps — that is a property of macOS, not something the driver can fix, so an
overnight run belongs on AC.

`claude -p` needs no TTY, so a pipeline like the above is fine. Its behaviour on **SIGHUP** is
undocumented, which is the reason for `tmux` rather than `nohup`.

**Stopping.** In order of preference:

| Method                                     | Effect                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `npm run loop:stop` (= `touch .loop/HALT`) | **Primary.** Stops at the next stage boundary — never mid-merge. Works from any shell, including over SSH. Exit 0. |
| `Ctrl-C` (SIGINT)                          | Current stage finishes, teardown runs, exit 130.                                                                   |
| `kill <pid>` (SIGTERM)                     | Same teardown path, exit 143.                                                                                      |
| `kill -9`                                  | **Last resort.** No teardown: expect a feature branch checked out and a live `dev:server`.                         |

The driver refuses to start while `.loop/HALT` exists (exit 2), so remove it before the next run.

**Recovering from a hard kill:**

```sh
npm run loop:recover
# = git checkout main && git reset --hard && (pkill -f 'tsx watch' || true) && rm -f .loop/HALT
```

No `git clean` — untracked files in this checkout include `.env` and
`.claude/settings.local.json`, and the loop never writes untracked files outside gitignored
`.loop/`.

**Watching and triage:**

```sh
npm run loop -- --status
tail -f .loop/console.log
jq -r '[.bead, .disposition, .build.costUsd, .pr.url] | @tsv' .loop/runs.jsonl
jq -r 'select(.verdictVsGate == "disagree") | .bead' .loop/runs.jsonl   # read these first
bd list --label loop-stuck                                             # morning queue
```

---

## 6. The state machine

Implement transitions as a pure function in `machine.mjs`:
`next(stage, result, ctx) → { stage, disposition? }`. `loop.mjs` executes the effects. This
separation is what makes the loop testable without a repo, a network, or a model.

Check for `.loop/HALT` **at every stage boundary**. If present: finish nothing further, write the
ledger record with `disposition: "halted"`, run teardown, exit 0.

### 6.1 SELECT — _driver_

1. Refuse to start unless `git status --porcelain` is empty and HEAD is `main`. Exit 2 otherwise.
2. `git checkout main && git pull --ff-only`.
3. `bd ready --json -n 50 -s <sortPolicy> --exclude-label <excludeLabels> --exclude-type
<excludeTypes>`. **The label and type exclusions MUST be passed to `bd`, not applied to the
   result.** Measured 2026-08-25: no bd JSON output — `ready`, `list` or `show` — carries a
   `labels` field, so a driver-side `bead.labels` filter reads `undefined`, treats it as "no
   labels", and excludes nothing. It would run on every bead, report success and measure nothing,
   while silently disabling the loop's own memory: HARVEST labels a parked bead `loop-stuck`
   exactly so SELECT skips it next run. Positive controls: `--exclude-type epic` 223 → 207 (16
   epics), `--exclude-label security` 223 → 211 (`security` is on exactly 12 beads).
   Then filter the returned rows on the fields bd DOES return: priority > `maxPriority`, any type
   in `excludeTypes`, any id matching `excludeIdPrefixes`, any bead in this run's in-memory
   `parked` set, any bead whose title or body names a path in `guard.denyPaths`.
4. Take the first survivor. None → clean stop, exit 0.

`--bead <id>` skips 3–4 but **not** 1–2, and still applies the deny-path check.

### 6.2 CLAIM — _driver_

1. `bd update <id> --status in_progress`.
2. `git checkout -b loop/<id>` — always `loop/` prefixed, so the maintainer can identify and bulk
   delete the loop's branches. Never work on `main`.

### 6.3 BUILD — _agent_ — see §7 for the full invocation

The single stage the model owns. Returns a schema-validated verdict. Any non-zero exit, schema
violation, or timeout → park.

`outcome: "no_change_needed"` is a legitimate result: skip to HARVEST, close the bead with the
agent's summary as the reason, do not open a PR.

`needs_human: true` → park immediately with reason `needs_human`, no gate, no PR.

### 6.4 GATE — _driver_

Run in this order, stopping at the first failure. These mirror `.github/workflows/ci.yml`;
catching a failure here saves a full CI round trip.

**Deterministic tier — always:**

| #   | Command                                           | Note                                                                         |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | `git diff --exit-code package-lock.json`          | Fail fast; CI runs the same check                                            |
| 2   | `npm run lint`                                    |                                                                              |
| 3   | `npm run format:check`                            |                                                                              |
| 4   | `npm run typecheck`                               | Use the script, never `npm --workspace server exec tsc --noEmit` (CLAUDE.md) |
| 5   | `node scripts/audit-gate.mjs`                     | Skip (not fail) on a network error; record `"skipped"`                       |
| 6   | `npm test`                                        |                                                                              |
| 7   | `npm run test:security`                           |                                                                              |
| 8   | `npm run smoke`                                   |                                                                              |
| 9   | `npm run build`                                   |                                                                              |
| 10  | `npm --workspace server exec tsx src/ci_smoke.ts` | Hermetic mock WS smoke                                                       |

**Playground tier — when `playgroundTier` is `"always"`, or `"auto"` and the diff touches
`playgroundTriggerPaths`:**

Preconditions, checked before anything is spawned — **fail the stage rather than proceeding** if
any is unmet:

- `.env` exists at the repo root.
- Its `CEBAB_DATA_DIR` and `WORKSPACE_ROOT` both resolve inside `gate.playgroundRoot`, which is a
  **sibling of the checkout** (`<repo>/../Playground`), not a directory inside it. **If either
  resolves to the real `~/.cebab` or `~/agents`, abort the run entirely with exit 2.** Testing
  against the maintainer's live data is the worst outcome this spec exists to prevent, and it
  fails silently by default (see **R2**).

**Both conditions are checked in PREFLIGHT (§13), not here.** `.env` is gitignored and is often
absent. Checked only at this point, a missing `.env` fails the stage for the first `server/**`
bead, parks it, and does the same for the next two — halting the run on the circuit breaker with
three per-bead failures that all misdescribe one setup problem. In preflight it is a single exit 2
at second zero, naming `Playground/README.md`, which already documents the exact file to write.

Then: start `npm run dev:server` detached, poll `GET /health` until ready or 60 s, run
`npm --workspace server exec tsx src/ws_smoke.ts`, and — only when `gate.liveSmokes` is true —
`live_smoke.ts`, `mcp_scope_smoke.ts`, `managed_file_smoke.ts`, `bus_max_turns_smoke.ts`.

Live smokes spawn real `claude` sessions against the maintainer's subscription. Default off.

**Teardown is mandatory and belongs in a `finally`** (see **R3**): kill the spawned process group,
then sweep any surviving `tsx watch ... --env-file-if-exists=../.env src/index.ts`.

**Recording:** every step contributes `{ name, exitCode, ms }` to the ledger. Compare the agent's
`tests.commands_run` against what actually ran and set `verdict_vs_gate` to `"agree"` or
`"disagree"`. **Never branch on that field** — record it and move on. It is a signal for the
maintainer, not a control input.

**On failure:** re-enter BUILD with the failing step name and the last 80 lines of its output,
up to `maxRepairs`. Exhausted → park.

### 6.5 PUBLISH — _driver_

1. Run the guard (§8) over `git diff main...HEAD`. A breach does **not** abort: continue, but set
   `guard.passed = false`, which suppresses LAND.
2. `git add -A && git commit` with:
   `<type>(<scope>): <verdict.commit_subject> (<bead-id>)` — matching the existing history, e.g.
   `fix(security): a worker cannot write the string that unpauses it (Cebab-vie.14)`.
   Never `--no-verify`: husky's `lint-staged` + `gitleaks protect` is a free extra gate.
3. **Compute the diffstat _after_ the commit**, from `git show --stat HEAD` — `lint-staged` runs
   `eslint --fix` and `prettier --write` on staged files, so a pre-commit diffstat is stale.
4. Re-check the lockfile: if `package-lock.json` changed, hard-park with reason `lockfile_drift`.
5. `git push -u origin loop/<id>`.
6. `gh pr create --fill --base main`. Body must carry: the bead id and title, the agent's summary,
   the gate result table, and the guard verdict. On a guard breach, add the label `loop-guard`.

### 6.6 WATCH — _driver_

Poll `gh pr checks <pr> --json name,state,bucket,link` every `pollIntervalMs`, looking for the entry named
exactly `ci.requiredContext`. Three distinct outcomes — do not collapse them:

| Outcome  | Condition                                        | Action                                                                                                                                                            |
| -------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `green`  | bucket `pass`                                    | → LAND                                                                                                                                                            |
| `red`    | bucket `fail`                                    | Fetch the failing job log, re-enter BUILD with it, up to `maxRepairs`. Exhausted → park.                                                                          |
| `absent` | no check with that name within `appearTimeoutMs` | Park with reason `ci_never_started`. **Counts toward the circuit breaker** — it usually means something is wrong with the repo or the runner, not with this bead. |

A repair after a red CI branches back to BUILD, then GATE, then amends and force-pushes the same
branch (`git push --force-with-lease`). Do not open a second PR.

### 6.7 LAND — _driver_

Requires **all** of: `loop.merge` is true, CI green, the final GATE run green, `guard.passed`, and
no `HALT`. Any one missing → skip to HARVEST with `disposition: "guard_withheld"` or `"parked"`.

`gh pr merge <pr> --squash --delete-branch`. If it fails on branch protection, retry once with
`--auto` and treat a queued auto-merge as success. Record the merge sha.

### 6.8 HARVEST — _driver_

1. Merged → `bd close <id> --reason "<pr url>"`. Parked → `bd update <id> --status open
--add-label loop-stuck` (**`--add-label`**, not `--label` — the latter is a _filter_ flag on
   `ready`/`list` and is rejected by `update`; `--set-labels` would replace every existing label),
   and append the failure evidence to the bead body: failing step, CI run URL, last 40 lines.
2. For each `verdict.follow_ups[]`, ONE call:
   `bd create --type <type> --priority 3 --labels loop-found --deps discovered-from:<source>`
   with a body carrying `why` + `evidence` + the source bead id. `--deps` creates the issue and
   wires the edge together, so there is no window in which a filed follow-up is missing its link.
   Retried once on failure; a follow-up that cannot be filed is a **hard park of the whole run** —
   losing a finding is the failure mode this loop exists to fix. Fall back to a separate
   `bd dep add <new> <source> -t discovered-from` only if `--deps` is rejected.
3. Append the ledger record.
4. Teardown: `git checkout main && git pull --ff-only`. If the tree is dirty, `git reset --hard`
   and record it — a dirty tree after teardown means a stage leaked.
5. Circuit breaker: 3 consecutive parks → halt, exit 1. A merged or `no_change_needed` bead
   resets the counter.

---

## 7. The BUILD invocation

### 7.1 Command

```sh
claude -p "$(cat .loop/current-prompt.md)" \
  --output-format json \
  --json-schema "$(cat scripts/lib/loop/verdict.schema.json)" \
  --model "$model" \
  --effort "$effort" \
  --max-turns "$maxTurns" \
  --permission-mode acceptEdits \
  --append-system-prompt-file scripts/lib/loop/build-system.md \
  --settings .claude/loop-settings.json \
  --disallowedTools "WebSearch,WebFetch"
```

**`--json-schema` requires `--output-format json`; it does not work with `stream-json`.** That is a
hard constraint, and it costs the loop live event visibility during BUILD: the `system/api_retry`
events and the (undocumented but real — see `CLAUDE.md`, "Stream-json oddities") top-level
`rate_limit_event` carrying `rate_limit_info.resetsAt` are only observable in a `stream-json` run.
The trade was taken deliberately: a schema-validated verdict is worth more to this loop than live
telemetry, and usage limits are detectable after the fact from stderr (§8.4). Do not switch to
`stream-json` to recover the events without replacing the verdict contract.

Parse `structured_output` from the JSON envelope for the verdict, and record `session_id`,
`num_turns`, `total_cost_usd` and `is_error` from the same envelope. The session id matters: the
transcript at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` is otherwise unfindable a week
later.

A repair invocation reuses the session: `--resume <session_id>` with the failure as the prompt.
This is also the cheap path — on a subscription the prompt cache holds for about an hour, so a
repair issued soon after its BUILD reprocesses very little. A repair that starts more than an hour
later pays full reprocessing, which is one reason `ci.completeTimeoutMs` is not set higher.

### 7.2 Verdict schema — `verdict.schema.json`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "outcome",
    "summary",
    "commit_type",
    "commit_scope",
    "commit_subject",
    "files_changed",
    "tests",
    "risk",
    "needs_human",
    "follow_ups"
  ],
  "properties": {
    "outcome": { "enum": ["implemented", "no_change_needed", "blocked"] },
    "summary": { "type": "string", "maxLength": 600 },
    "commit_type": { "enum": ["fix", "feat", "chore", "docs", "refactor", "test"] },
    "commit_scope": { "type": "string", "maxLength": 20 },
    "commit_subject": { "type": "string", "maxLength": 72 },
    "files_changed": { "type": "array", "items": { "type": "string" } },
    "tests": {
      "type": "object",
      "additionalProperties": false,
      "required": ["added", "modified", "deleted", "commands_run"],
      "properties": {
        "added": { "type": "array", "items": { "type": "string" } },
        "modified": { "type": "array", "items": { "type": "string" } },
        "deleted": { "type": "array", "items": { "type": "string" } },
        "commands_run": { "type": "array", "items": { "type": "string" } }
      }
    },
    "risk": { "enum": ["low", "medium", "high"] },
    "needs_human": { "type": "boolean" },
    "needs_human_reason": { "type": "string" },
    "follow_ups": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["title", "type", "why", "evidence"],
        "properties": {
          "title": { "type": "string", "maxLength": 120 },
          "type": { "enum": ["bug", "task", "chore", "feature", "decision"] },
          "why": { "type": "string", "maxLength": 400 },
          "evidence": { "type": "string", "maxLength": 600 }
        }
      }
    }
  }
}
```

### 7.3 Tool policy

`--permission-mode acceptEdits` plus a **`PreToolUse` deny hook** in `.claude/loop-settings.json`
pointing at `.claude/hooks/loop-guard.sh`. The hook is the hard boundary; an `--allowedTools`
pattern list is too easy to get subtly wrong.

The hook reads the tool call on stdin and returns
`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`
for any `Bash` command matching:

```
npm install | npm i | npm ci | yarn | pnpm      # lockfile drift — CI fails on it
git commit | git push | git merge | git rebase   # the driver owns publication
git checkout | git switch | git reset            # the driver owns branch state
gh                                               # the driver owns the forge
--no-verify                                      # bypasses the pre-commit gate
rm -rf                                           # blast radius
```

The agent _may_ run `npm test`, `npm run lint`, `npm run typecheck`, `npx vitest`, `git diff`,
`git status`, `git log`, and read/write files.

### 7.4 Prompt template — `build-prompt.md`

Interpolate `{{...}}`. Keep it this short; a long prompt invites the agent to narrate.

```markdown
Implement exactly one tracked issue in this repository.

**{{bead_id}} — {{bead_title}}**

{{bead_body}}

{{#if repair}}
A previous attempt failed the gate. This is attempt {{attempt}} of {{max}}.
Failing step: `{{failed_step}}`
```

{{failure_output}}

```

Fix the cause. Do not weaken the check that caught it.
{{/if}}

## What done means

- The behaviour the issue describes is actually changed. A test edited so it stops
  failing is not a fix.
- There is a test that fails before your change and passes after it. If the issue is
  a documentation defect, the doc change is the deliverable and no test is required.
- Security-relevant behaviour keeps its `[security]` tag. Never remove one.
- `npm run lint`, `npm run typecheck` and `npm test` pass locally before you finish.

## What you must not do

- Do not commit, push, or open a pull request. The harness does that.
- Do not run `npm install`. The lockfile must not change; CI fails on drift.
- Do not edit CI config, gate scripts, lint or test configuration, or `osv-scanner.toml`.
- Do not expand scope. Anything else you notice goes in `follow_ups`, not in this diff.

## follow_ups

This is the part that outlives the session. If you noticed a defect, a missing test, a
wrong claim in a doc, or a hazard adjacent to this work — record it. `evidence` must
name a file and what you actually observed, not a hunch. An empty array is a valid and
common answer; do not invent findings to fill it.

Return only the structured verdict.
```

`build-system.md` carries the repo's non-obvious invariants — the `tsc --noEmit` trap, the
`dev:server` orphan rule, `settingSources`/Trust. Keep it under 40 lines; `CLAUDE.md` already
auto-loads and this is only for what the harness needs the agent to weight more heavily.

---

## 8. Guard

### 8.1 Rules

Evaluated over `git diff --numstat main...HEAD` plus `git diff main...HEAD` for pattern matching.
Pure, in `guard.mjs`, fully unit-tested.

| Rule                        | Breach when                                                                   |
| --------------------------- | ----------------------------------------------------------------------------- |
| `denyPaths`                 | any changed path matches any glob                                             |
| `maxFilesChanged`           | changed file count exceeds it                                                 |
| `maxNetLinesAdded`          | (insertions − deletions) exceeds it                                           |
| `allowTestDeletions: false` | any `*.test.*` / `*_test.*` file deleted, **or** any `[security]` tag removed |
| `forbidInDiff`              | any added line contains a forbidden string                                    |

Return `{ passed, breaches: [{ rule, detail }] }`. Every breach is reported — do not stop at
the first, the maintainer wants the whole list in the PR body.

### 8.2 What a breach does

Never blocks the work. PUBLISH still commits, pushes and opens the PR, labelled `loop-guard`, with
the breach list in the body. LAND is skipped. The maintainer decides in the morning.

### 8.3 Circuit breaker

`consecutiveParks` increments on every park regardless of reason, resets on a merged or
`no_change_needed` bead. At `consecutiveParkLimit` (3) the driver halts with exit 1 and a message
naming all three parked beads and their reasons. The common cause is systemic — broken `main`,
expired `gh` auth, CI outage — and continuing would produce a dozen identical failures.

### 8.4 Usage limits

Three facts set the shape of this, and none of them is negotiable:

1. **Claude Code DOES have a per-invocation spend ceiling** — `--max-budget-usd <amount>`,
   documented as working with `--print`, which is the loop's mode. (An earlier draft of this spec
   asserted the opposite as a non-negotiable fact; measured false on CLI 2.1.212.) It is enforced
   by the CLI mid-turn, so `limits.beadCostCeilingUsd` is passed straight through rather than
   detected afterwards. There is still no ceiling spanning a whole RUN, so `limits.costCeilingUsd`
   remains a driver-side sum over each BUILD's `total_cost_usd`.
2. **Remaining quota cannot be queried from a script.** `/usage` is interactive-only. The loop
   cannot look before it leaps; it can only budget in advance and react on impact.
3. **On a subscription limit the CLI does not back off — it fails.** It writes a line of the form
   `You've hit your session limit · resets 3:45pm` (also `weekly limit`, and per-model, e.g.
   `Opus limit`) and exits non-zero.

**Layer 1 — budget the driver imposes. All of it ships OFF.** `limits.costCeilingUsd`,
`limits.beadCostCeilingUsd` and `limits.cooldownMsBetweenBeads` default to null/0, and
`build.tiers` defaults to empty. Implement every one of them properly — the maintainer wants the
knobs to exist and to be tested — but the first weeks run unconstrained so the ledger can show
where consumption actually goes before anything is capped. The stop condition (`--until`, §5.1)
and the two runaway guards that are not budgets — `build.maxTurns: 60` and `loop.maxRepairs: 2` —
are the only things bounding a run out of the box.

`beadCostCeilingUsd`, when set, becomes `--max-budget-usd` on the BUILD invocation — the CLI stops
the turn instead of the driver noticing an overrun it has already paid for.
`costCeilingUsd` sums `total_cost_usd` from each BUILD envelope. On a subscription that number is
**not a bill** — it is a local estimate computed from token counts at list rates. Treat it as a
_proxy for tokens consumed_, which is what the usage window actually meters. Say so in `--status`
output; do not print it as money spent.

`limits.reserveMs` is the rule that matters most in practice: **do not start a bead you cannot
finish.** Before SELECT, if less than `reserveMs` remains against the wall-clock budget or
`stopAfterLocalTime`, stop cleanly instead of beginning an iteration that will be cut off
half-built.

**Layer 2 — tier the work.** `build.tiers` (§4) puts opus/high on `server/`, `shared/` and p0–p1
beads, and sonnet/medium on docs and p2+. Note that `gate.liveSmokes` spawns _additional real
`claude` sessions_ against the same quota — that, more than their runtime, is why they default off.

**Layer 3 — react on impact.** On a non-zero BUILD exit, match stderr against
`/hit your (session|weekly|[A-Za-z]+) limit.*resets (.+?)$/i` before anything else — a usage limit
is not a bead failure and must never be recorded as one, nor count toward the circuit breaker.

| Kind                      | Action                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Session / per-model limit | `limits.onSessionLimit`: `halt` (default), or `sleep_until_reset` — parse the reset time, sleep past it, resume the same bead via `--resume`. |
| Weekly limit              | Always halt. A weekly reset can be days away.                                                                                                 |
| Reset time unparseable    | Halt. Never guess a wake time.                                                                                                                |

**In every case the current bead is parked cleanly first** — repo back to `main`, `dev:server`
killed, bead status restored, ledger record written with `disposition: "halted"` and
`haltReason: "usage_limit"`. A limit hit mid-BUILD must not leave a branch checked out. This is the
one path most likely to be reached at 3am and least likely to be exercised in testing; test it
directly with an injected `run` that returns the limit message.

---

## 9. Data formats

### 9.1 `.loop/runs.jsonl` — append-only, one object per iteration

```jsonc
{
  "ts": "2026-08-25T23:14:02Z",
  "bead": "Cebab-vie.15",
  "beadTitle": "The gate is a race against the SDK, not a block",
  "branch": "loop/Cebab-vie.15",
  "build": {
    "sessionId": "…",
    "numTurns": 23,
    "costUsd": 1.84,
    "exitCode": 0,
    "outcome": "implemented",
    "risk": "medium",
    "attempts": 1,
  },
  "gate": {
    "steps": [{ "name": "lint", "exitCode": 0, "ms": 8210 }],
    "playgroundRan": true,
    "liveSmokesRan": false,
  },
  "verdictVsGate": "agree",
  "diffstat": { "files": 4, "insertions": 118, "deletions": 12 },
  "guard": { "passed": true, "breaches": [] },
  "pr": { "number": 393, "url": "https://github.com/…/393" },
  "ci": { "conclusion": "success", "waitedMs": 512000, "runUrl": "…" },
  "land": { "merged": true, "sha": "a91298b" },
  "harvest": { "beadClosed": true, "followUps": ["Cebab-p2x"] },
  "disposition": "merged",
}
```

`disposition` ∈ `merged | parked | guard_withheld | no_change_needed | halted | dry_run`.
Write the record even on a crash — wrap the iteration so the `finally` always appends.

### 9.2 `.loop/state.json`

`{ "consecutiveParks": 0, "parkedThisRun": [], "spentUsd": 0, "startedAt": "…" }` — rewritten at
each boundary so a crashed run can be diagnosed and the breaker survives a restart.

### 9.3 `.loop/HALT`

Presence is the whole signal; contents are ignored but echoed into the stop message if non-empty.
`touch .loop/HALT` stops the loop at the next stage boundary — never mid-merge.

---

## 10. Repo constraints — mandatory

Each of these fails silently if ignored. None produces an error naming its cause.

**R1 — the SessionEnd hook must not fire per iteration.** `.claude/settings.json` runs
`kanban-sync-on-end.sh` at `SessionEnd`, and hooks execute in `-p` mode too. Left alone, every
BUILD pushes the Kanban board. `.claude/loop-settings.json` must define `hooks` **without** the
`SessionEnd` entry (and without the `Stop` bus-inbox entry), and BUILD must be invoked with
`--settings` pointing at it. The board syncs once, at the end of a whole run, when
`harvest.syncBoardAtEnd` is true.

**R2 — `.env` resolution is a hard gate, not a warning.** `.env` is gitignored and was absent
from the checkout when this spec was written. Absent, the Playground fixtures fall back to the
real `~/.cebab` and `~/agents`. See §6.4: abort the run rather than test against live data.

**R3 — kill `dev:server` in a `finally`.** `tsx watch` does not exit when its child dies; it
reparents to launchd and squats port 4319. `predev-server.mjs` only sweeps at the _next start_.
A loop that spawns the server twenty times a night leaves twenty unless the driver kills its own.

**R4 — the lockfile must not change.** CI runs `git diff --exit-code package-lock.json`. Enforced
three ways: the PreToolUse hook denies `npm install`, the guard denies the path, and PUBLISH
re-checks before pushing.

**R5 — never touch `scripts/kanban-sync.mjs` or its test.** Both are gitignored, so CI does not
run their 20 tests (`Cebab-8fa`, open). There is no gate that could be green for a change there.

**R6 — branch discipline.** Always `loop/<bead-id>`. Never commit to `main`. Never leave the repo
on a feature branch — not on success, park, halt, crash, or signal.

**R7 — diffstat after commit.** `lint-staged` rewrites staged files during the pre-commit hook.

**R8 — `bd` from a non-login shell.** If this is ever run from launchd or cron, `/opt/homebrew/bin`
is not on `PATH`. Resolve `bd` once at startup (config key or `which`) and fail preflight with a
clear message rather than a mid-run `command not found`.

---

## 11. Testing requirements

`scripts/loop.test.mjs`, vitest, alongside the existing `scripts/*.test.mjs`. It runs in CI via
`npm test`, which is the point of keeping these files tracked.

Required coverage — pure logic, no network, no repo, no model:

- **guard.mjs** — each deny path glob matches and non-matches; each cap at boundary and over;
  a deleted test file; a removed `[security]` tag; a `--no-verify` line; multiple simultaneous
  breaches all reported.
- **machine.mjs** — every transition including: gate red → BUILD; gate red twice → park;
  CI absent → park; guard breach → PR opened but LAND skipped; `no_change_needed` → HARVEST;
  `needs_human` → park before gate; HALT at each of the eight boundaries.
- **select.mjs** — priority, type and prefix filters; a bead parked earlier in the run is not
  re-selected; a p3 `loop-found` bead is below the p2 ceiling; the `bd ready` argv carries
  `--exclude-label`/`--exclude-type`, and a conformance check that fails when one is stripped.
  **Do not test a client-side label filter.** A fixture with a `labels` array describes an object
  bd cannot produce, so it would pass while the real path stayed broken.
- **circuit breaker** — 3 parks halts; a merge between parks resets the counter.
- **ledger.mjs** — record shape validates against §9.1; append-only; a thrown iteration still
  writes its record.
- **config.mjs** — unknown key rejected; CLI overrides file overrides defaults.

Integration behaviour (`gate`, `git`, `forge`, `beads`) is tested through the injected `run`
seam with recorded fixtures. Do not shell out in tests.

---

## 12. Acceptance criteria

- [ ] `npm run loop -- --dry-run --bead <id>` selects, builds, gates, prints a report, and leaves
      the repo on `main` with a clean tree and no PR, no branch, no `bd` writes.
- [ ] `npm run loop -- --bead <id>` (no `--merge`) produces a PR and stops after WATCH.
- [ ] `npm run loop -- --merge --until 3` lands up to three beads and closes each.
- [ ] Every run appends exactly one ledger record per iteration, including crashed ones.
- [ ] `touch .loop/HALT` mid-run stops at the next boundary, never mid-merge, exit 0.
- [ ] A bead whose diff touches `.github/workflows/` gets a PR labelled `loop-guard` and is
      **not** merged, with the breach named in the PR body.
- [ ] Three consecutive parks halt the loop with exit 1 and all three reasons printed.
- [ ] Follow-ups land at p3 with a `discovered-from` edge to their source bead.
- [ ] After every terminating path — success, park, halt, SIGINT, thrown error — the repo is on
      `main`, the tree is clean, and no `tsx watch` process survives.
- [ ] Playground tier aborts the run if `.env` resolves outside `Playground/`.
- [ ] A simulated `You've hit your session limit · resets 3:45pm` on stderr parks the bead cleanly,
      halts with `haltReason: "usage_limit"`, does **not** increment the circuit breaker, and leaves
      the repo on `main`.
- [ ] A simulated weekly limit halts regardless of `limits.onSessionLimit`.
- [ ] `--until` accepts `8`, `07:00`, `2h`, `90m` and `drain`; anything else exits 2 with a named
      error. Repeated flags stop at whichever trips first, and the tripped condition is reported.
- [ ] With a time-based `--until` less than `limits.reserveMs` away, the loop stops before SELECT
      rather than starting a bead it cannot finish. With a count-based `--until`, `reserveMs` is
      inert.
- [ ] A default-config run applies no cost ceiling, no cooldown and no model tiering.
- [ ] `npm run loop:stop` halts a detached run; `npm run loop:recover` restores a hard-killed one
      without deleting untracked files.
- [ ] `--status` prints the cost figure labelled as a token-usage estimate, never as money spent.
- [ ] `npm run lint && npm run typecheck && npm test` pass with the new files.

---

## 13. Preflight

Run once, at startup, before SELECT. Any failure → exit 2 with the specific missing item named.

```sh
gh auth status
gh api repos/maxopich/claude-code-wrapper --jq '.allow_auto_merge, .allow_squash_merge'
gh pr checks <recent-pr> | grep -F 'Lint, Typecheck, Test'   # required context name is real
claude --version                                             # --json-schema support
command -v bd                                                # and note the absolute path
test -z "$(git status --porcelain)"                          # clean tree
git rev-parse --abbrev-ref HEAD                              # == main
test -f .env                                                 # iff the Playground tier can run
```

The last line is conditional on `gate.playgroundTier` resolving to anything but `"never"`: parse
`.env`, resolve `CEBAB_DATA_DIR` and `WORKSPACE_ROOT`, and refuse to start unless both sit inside
`gate.playgroundRoot`. Point the operator at `Playground/README.md`, which carries the exact
four lines to write.

---

## 14. Deferred — do not implement

Parallel beads, worktree pools, port allocation, merge queues; the GitHub Action CI-responder;
migration onto Cebab's own bus (blocked on `Cebab-vie`, `vie.2`, `vie.15` — the operator controls
do not yet restrain a worker, so unattended auto-merge must not depend on them); cost dashboards;
board sync per iteration.
