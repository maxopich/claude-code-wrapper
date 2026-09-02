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
{{#if capped}}
The previous attempt used all {{max_turns}} of its turns without returning a verdict. This
session has been resumed, so your earlier work and your edits are still here. This is
attempt {{attempt}} of {{max}}.

Continue from where you stopped. Do not start over, and do not re-run checks that already
passed — running out of turns a second time parks this issue for a human. If the work is
larger than the remaining budget, return a verdict now with `needs_human: true` and say
what is left.
{{/if}}

## When this issue is not yours to finish

Read the body before you start, and stop early if either of these is true. A verdict costs a
few turns; running out of turns costs all {{max_turns}} of them and produces nothing.

- **It is a DECISION, not a defect.** The body defers the fix pending a choice, names two
  defensible answers and picks neither, or says the fix was deliberately not made because the
  right approach is unsettled. Return `needs_human: true` now, with `needs_human_reason`
  naming the choice that has to be made.
- **The change it describes plainly cannot fit in {{max_turns}} turns** — for example it needs
  a protocol change across several packages before anything observable moves. Say so the same
  way rather than getting half-way.

Judge this from what the ISSUE says, not from how hard the work looks to you. A hard but
well-specified fix is exactly what you are here for.

## Before you start: check the issue against the tree

The body below was written before this run. **Verify its premises before acting on
them** — read the code it names. A run merges many changes in sequence, and an issue
that was accurate when filed may describe a state that no longer exists.

This is not hypothetical. In the run of 2026-09-01 a documentation issue was implemented
faithfully and added the sentence "there is no in-app delete" to the README, seventy-seven
minutes after an earlier issue in the same run shipped that exact feature. Nothing in the
gate reads prose, so it merged.

If the premise is already false, say so in the verdict and fix what is actually wrong, or
return `needs_human: true` if the right change is no longer clear.

## What done means

- The behaviour the issue describes is actually changed. A test edited so it stops
  failing is not a fix.
- There is a test that fails before your change and passes after it. If the issue is
  a documentation defect, the doc change is the deliverable and no test is required.
- Security-relevant behaviour keeps its `[security]` tag. Never remove one.
- `npm run lint`, `npm run typecheck` and `npm test` pass locally before you finish.
- **`npm run format` has been run, after your last edit.** The gate also enforces Prettier
  (`npm run format:check` is step 3 of its 10), and this is the one step you cannot reason
  your way past: every gate failure this loop has ever hit was that step and nothing else
  — 5 of 8 builds in the run of 2026-08-27 — and each one spent a whole extra invocation
  re-establishing your entire context to run one command. It is allowed; run it.

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

**If a finding is already tracked, say so instead of filing it again.** Set
`already_tracked` to the existing bead's id and keep the rest of the entry as you would
have written it. The harness records the finding and creates nothing. This is the right
answer, not a failure to find something new — writing the same defect twice puts noise in
a queue that a later run will hand back as work. Do not encode it in the title.
{{#if prior_follow_ups}}

Earlier iterations of THIS run already filed the beads below. You are a fresh session and
cannot otherwise see them, and the pairs this list exists to prevent were filed minutes
apart:

{{prior_follow_up_list}}
{{/if}}

Return only the structured verdict.
