# Loop Development Standard

What a change produced by the autonomous loop has to be, and how each requirement is
checked. This is the counterpart to [`AUTONOMOUS_LOOP_SPEC.md`](AUTONOMOUS_LOOP_SPEC.md),
which specifies the **driver** — the state machine, the stages, the ledger. This page
specifies the **change**.

**Nothing under `docs/` is auto-loaded.** Neither the SDK's project-memory load nor the
bus's `readProjectClaudeMd` injection reads past `CLAUDE.md`, so this page arrives only
when someone opens it. The rules a BUILD agent must see on every turn live in
`scripts/lib/loop/build-prompt.md` and `build-system.md`; what is here is the reasoning
behind them and the evidence each one rests on.

## 0. Why this document exists

The run of 2026-09-01 merged 36 pull requests into `main` unattended, with 13 green CI
checks each and no human review. A follow-up audit filed 23 beads for defects that run
introduced.

The gate did not catch one of them. That is not an inference — across all 85 iterations
recorded in `.loop/runs.jsonl`, every one of the ten deterministic gate steps has exit
code 0. Six hundred and sixty step executions, zero failures. On the 2026-09-01 run
specifically, all 41 builds passed the gate on their first attempt.

So the loop's quality apparatus was, measurably, not measuring the thing that was going
wrong. The four sections below name what actually went wrong, in the order of how often
it happened.

## 1. The four defect classes

Each class is stated with the finding that established it, because a rule whose evidence
is not recorded is the first thing a later reader talks themselves out of.

### Class A — prose that describes the code was not updated with the code

The largest class, and the one with the cleanest causal story.

PR #459 shipped the in-app managed-agent delete — `server/src/managed_delete.ts`, the
`delete_managed_agent` WS verb, `ManagedDeleteModal.tsx`, the store state — and merged at
16:47. PR #489 merged at **18:04, seventy-seven minutes later**, and _added_ two sentences
to `README.md`:

> only deleting their directory by hand removes them (there is no in-app delete)

> Copies accumulate with no in-app delete path

Both were false when written. The bead body was authored before the run; the agent
implemented it faithfully and never checked whether the tree still matched.

`Cebab-h552` is the same class with a sharper edge: #469 widened a delete from four
tables to seven — including `notifications`, `controllability_forensics` and
`recovery_log` — and corrected the repo-layer docstring, while leaving all three
human-facing consent texts describing the old blast radius. That is the text a person
reads to authorise an irreversible deletion, and the rows it fails to mention are the
safety ones.

**The rule.** A change to behaviour must carry the change to every text that describes
that behaviour: `README.md`, `CLAUDE.md`, `SECURITY.md`, `CONTRIBUTING.md`,
`assistant/kb/`, `docs/`, and any consent or confirmation string in the UI. The bead body
is a starting point, not a source of truth — **verify its premises against the current
tree before acting on them.**

### Class B — one side of a seam moved and the other did not

`Cebab-4igs`. `drainPendingPermissionsForEndedTurn` resolves the parked promise, deletes
the entry, and persists `permission_decided {decision:'deny', reason:'turn_ended'}` — and
sends no `permission_decided` message to the client. The premise of the fix is that the
socket is still open. Nothing client-side closes the card.

The operator sees an open permission card with live buttons, clicks Allow, and the client
optimistically renders "Allowed". The server finds no pending entry and returns without
echoing a correction. The database holds `deny / turn_ended`. **The live UI asserted the
opposite of the audit record for a human-in-the-loop permission decision.**

Also in this class: `Cebab-4qc6` (a map that never re-fills after a reconnect, contrary
to three copies of prose saying it does) and `Cebab-bxi0` (deleting a managed agent
silently strips it from live and past bus runs).

**The rule.** A change to a wire message, a protocol type, or a server-side send site
must state what the other side does with it. If the answer is "nothing", that has to be
deliberate and written down, not discovered later.

### Class C — the non-resolving path was never considered

`Cebab-1jm3`. The fix holds a modal open across a copy so a failure is not discarded —
correct for success and correct for failure, and there is no path out when the copy
neither succeeds nor fails. A socket drop mid-copy, a server restart, a copy that hangs
on a large tree: the operator is left with a modal that ignores Escape and has no working
dismiss.

**The rule.** For any operation that can be waited on, three outcomes exist: it
succeeded, it failed, and it never answered. The third is not a hypothetical — a
subprocess dies, a socket drops, a recursive copy of a gigabyte tree takes longer than
anyone budgeted.

### Class D — the test that shipped with the fix is vacuous

`Cebab-dwcq`. Three tests in the run pass with their own fix reverted, established by
revert-check in isolated worktrees rather than by reading.

The distribution matters more than the count. **Twenty of twenty server-side reverts went
RED** — the server test discipline is genuinely good and is not the problem. All three
vacuous tests are web-side, and the shapes repeat:

- the test covers a pure helper while the guard's **call site** can be deleted with
  everything still green;
- a React `useEffect` can be surgically removed and its test still passes;
- one of four new cases in a file is vacuous while the other three redden correctly.

**The rule.** A test that does not fail before the change is not evidence of the change.
This was already stated in `build-prompt.md` — _"There is a test that fails before your
change and passes after it"_ — and was asserted, never enforced. An unenforced rule is a
statement of intent.

## 2. What the tiers can and cannot see

| Tier                   | Cost                | Sees                                               | Cannot see     |
| ---------------------- | ------------------- | -------------------------------------------------- | -------------- |
| 10 deterministic steps | ~80 s               | compile errors, lint, format, existing regressions | any of A–D     |
| Playground live smokes | minutes, real quota | runtime behaviour of the assembled system          | prose, vacuity |
| Revert-check           | seconds, no quota   | class D                                            | A, B, C        |
| Human review           | —                   | all of them                                        | —              |

The deterministic tier is an exact duplicate of CI's two jobs, so it runs three times per
bead: once locally, twice more in CI's ubuntu + windows matrix. `npm test` alone is 62% of
local gate wall time. Its value is failing before a push, not correctness — it has never
once failed.

**`web/` is exempt from the Playground tier by operator decision** (the rule is: anything
that is not UI must go through it). That exemption is only safe if `web/` has a
substitute, because `web/` is exactly where class D lives. The revert-check is that
substitute.

## 3. Requirements

1. **Verify the bead's premises against the tree before acting.** A bead body written
   before the run may describe a state that no longer exists. This is the direct cause of
   the #489 regression.
2. **A test that fails before the change and passes after it**, unless the deliverable is
   documentation.
3. **Every text that describes the changed behaviour changes with it** (class A).
4. **Both sides of a seam, or a written reason why not** (class B).
5. **The never-answered path is handled or explicitly out of scope** (class C).
6. **Security-relevant behaviour keeps its `[security]` tag.** Never remove one.
7. **Follow-ups are recorded, not acted on.** Anything noticed outside the bead's scope
   goes in `follow_ups` with evidence naming a file and an observation, never a hunch —
   and `already_tracked` when it is already filed.

## 4. Notes for whoever extends the gate

- **A new gate step must be revert-checked in both directions.** A step that cannot fail
  is a step that measures nothing, which is the defect class this repo is least willing
  to add. Prove it reddens on the defect it targets _and_ stays green on a clean diff.
- **Scope a scan to the steps that can produce the signal.** The usage-limit detector is
  wired at the live-smoke step and nowhere else, because `loop.test.mjs` and `build.mjs`'s
  own tests carry real CLI limit strings as fixtures — scanning `npm test` output would
  halt an overnight run on one red test.
- **A skip must never read as a pass.** `audit-gate` records `{ skipped: 'network' }`
  rather than exit 0, and the ledger keeps the distinction.
- **Prefer a signal the driver already reacts to.** The loop parks on any completed red
  check, not only on the required context, so making a check visible on the PR is often
  enough — no branch-protection change needed.

## 5. The revert-check, specified

Requirement 2 — _a test that fails before the change_ — has been in the BUILD prompt
since the loop was written and has never been checked. This is the design for checking
it. It costs no subscription quota, which is why it is the first of the three proposed
steps rather than the last.

**Shape.** For each test file the staged diff adds or changes, run that file against a
tree where the change is **not** present, and require it to fail.

**Do not mutate the live tree.** The obvious implementation — reverse-apply the non-test
hunks in place, run, re-apply — puts the loop's working tree into a broken intermediate
state, and a failure to restore corrupts a run mid-flight. Instead build a scratch
worktree at the merge base, apply only the test-file hunks there, and run. The live tree
is never touched, and teardown failing costs a directory rather than a run.

**A non-zero exit is NOT the pass condition, and this is the trap.** A test file for a
module the change ADDS cannot even be collected against the base — the import does not
resolve. Vitest exits non-zero, and a naive check reads that as "the test failed without
the fix, good". It is the opposite: the test never ran, and a genuinely vacuous test in
the same file would be certified as sound.

So the discriminator is `numFailedTests > 0` from the JSON reporter — tests were
collected, ran, and failed — never the process exit code. Three outcomes, all recorded
distinctly:

| Base-tree result                         | Meaning                                  | Gate                    |
| ---------------------------------------- | ---------------------------------------- | ----------------------- |
| `numFailedTests > 0`                     | the test genuinely depends on the change | pass                    |
| ran, all green                           | **the test does not test the change**    | **fail**                |
| collection error on a path the diff adds | new module; the check cannot apply       | `skipped: 'new-module'` |

The third row must be recorded as a skip and never as a pass, for the same reason
`audit-gate` records `{ skipped: 'network' }`: a step that reports success without
measuring anything is worse than a step that is absent, because it is counted.

**Verify it against a known answer before trusting it.** `Cebab-dwcq` names three tests
in the 2026-09-01 run that pass with their fix reverted, and twenty server-side reverts
that correctly went red. That is a ready-made positive and negative control with the
answer already known — a revert-check implementation that does not reproduce those
results is wrong, whatever it does on synthetic fixtures.
