## Summary

<!--
1-3 bullets describing what this PR does and why. Keep it tight — details
go in the file-level comments or below.
-->

-

## Test plan

<!--
Bulleted checklist for the reviewer. Mention which existing test files
cover the change, plus any manual verification you ran (UI smoke,
typecheck, mock-mode WS smoke, etc.). If the change is hard to test,
say so explicitly.
-->

- [ ]

## Security checklist

<!--
Tick everything that applies. If you tick one of these, mention which
test or Semgrep rule was added or updated. See SECURITY.md for the
threat-model summary.
-->

- [ ] Touches auth / origin / WS handshake (F4 / F5)? Regression test added or updated.
- [ ] Adds a `writeInboxMessage` call site (F1 / F3)? Return forwarded via `forwardCebabEvent` (or captured + passed to a forwarder).
- [ ] Adds or modifies bus router `handleEvent` logic (F2 / F3)? Source-allowlist branch covered by a test in `*.security.test.ts`.
- [ ] Adds or modifies a bus shell script (F6 / R3)? Bats case added in [server/src/bus/scripts/](../tree/main/server/src/bus/scripts/).
- [ ] Adds a fixture under [fixtures/](../tree/main/fixtures/)? Manually verified no real OAuth tokens or API keys; CODEOWNER review enforced by `awaiting-fixture-review` label.
- [ ] Adds a runtime dependency? `postinstall` script reviewed; OSV-Scanner + `dependency-review` checks pass.
- [ ] Modifies CI / GitHub Actions workflows? actionlint + zizmor green; SHA-pinning per [.github/CODEOWNERS](.github/CODEOWNERS) policy.

## Notes for the reviewer

<!-- Optional. Anything subtle, anything you weren't sure about, anything
you decided NOT to do and why. -->
