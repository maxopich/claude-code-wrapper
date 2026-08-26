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
