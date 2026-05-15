# Contributing to Cebab

Thanks for poking at the code. Cebab is a small macOS-only personal tool, so this
guide is short — it documents the bits that aren't obvious from the README:
what to run before opening a PR, and where the security-critical paths live.

## Dev setup

```sh
git clone https://github.com/maxopich/claude-code-wrapper.git
cd claude-code-wrapper
npm install
npm run setup            # rebuilds better-sqlite3 native binding + installs husky hooks
cp .env.example .env     # then point WORKSPACE_ROOT at your agent projects
```

The `setup` script is the dev-side counterpart to CI's two-stage install. Cebab
ships an `.npmrc` with `ignore-scripts=true` to block transitive npm postinstall
scripts (the bus / orchestrator launch under `--permission-mode bypassPermissions`,
so an attacker-controlled postinstall is direct RCE on your machine). `setup`
explicitly re-enables scripts for the one place we need them — rebuilding the
native `better-sqlite3` binding — and installs the husky pre-commit hook.

If your `prepare` script hasn't run, husky won't be wired up, so the gitleaks +
lint-staged hook won't fire. `npm run setup` covers both.

## Before opening a PR

Run these locally:

```sh
npm run lint            # eslint with security + no-unsanitized plugins, --max-warnings 0
npm run typecheck       # tsc --noEmit across shared / server / web
npm test                # vitest
npm run test:security   # F-invariant regression suite + bats for F6 / R3
```

The pre-commit hook (`set -e; npx lint-staged; gitleaks protect --staged
--redact --no-banner`) already runs lint-staged + gitleaks on staged files, but
running the full suite catches type errors and unrelated test regressions
before CI does.

If you're touching one of the security-critical paths called out in
[CODEOWNERS](.github/CODEOWNERS) (auth / origin / WS server / bus / migrations
/ workflows), the PR template's security checklist will prompt you for the
relevant regression test. Don't skip those boxes — the F-invariants
(F1–F6 / R3 / F12) are summarised in [SECURITY.md](SECURITY.md) and pinned by
tests under `*.security.test.ts` and `bus-send-msg.bats`.

## PR mechanics

- Open against `main`. Branch naming is loose; `security/...`, `feat/...`,
  `fix/...` are the patterns currently in use.
- The PR template auto-populates the description; fill in the Summary and
  Test plan, tick the relevant Security checklist boxes.
- We squash-merge (the auto-merge workflow uses `gh pr merge --auto --squash`
  for dependabot patch PRs; manual merges follow the same convention). Keep
  the PR title clean — it becomes the squashed commit subject.
- Dependabot patch PRs auto-merge once required checks pass, _unless_ they
  touch a CODEOWNERS-tagged path (see
  [.github/workflows/dependabot-auto-merge.yml](.github/workflows/dependabot-auto-merge.yml)).
  Minor and major bumps always require manual review.

## Reporting a security issue

Please don't open a public issue. Email **maxopich@gmail.com** with the subject
prefix `[cebab-security]` — see [SECURITY.md](SECURITY.md) for the full
disclosure policy, scope, and threat-model summary.
