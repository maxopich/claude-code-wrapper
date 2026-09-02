# Contributing to Cebab

Thanks for poking at the code. Cebab is a small personal tool that runs natively
on macOS, Linux and Windows (no WSL), so this guide is short — it documents the
bits that aren't obvious from the README: what to run before opening a PR, and
where the security-critical paths live.

**All three platforms are in scope for your change.** CI runs a `ubuntu-latest` +
`windows-2022` matrix and both are required, so a POSIX-only assumption fails the
build rather than shipping. Windows is the one that bites: `.cmd` shims need
`shell: true` to spawn, POSIX file modes are a no-op, `SIGTERM` is never
delivered (`SIGBREAK` is), and paths are separator- and case-insensitive.

## Dev setup

```sh
git clone https://github.com/maxopich/claude-code-wrapper.git
cd claude-code-wrapper
npm run bootstrap        # deps + better-sqlite3 native build + husky hooks, in one step
cp .env.example .env     # then point CEBAB_WORKSPACE_ROOT at your agent projects
```

The `setup` script is the dev-side counterpart to CI's two-stage install. Cebab
ships an `.npmrc` with `ignore-scripts=true` to block transitive npm postinstall
scripts (no bus tool call is ever gated on a human — production turns run
`permissionMode: 'default'` with a callback that auto-approves everything except
`AskUserQuestion`, which is bypass in effect — so an attacker-controlled
postinstall is direct RCE on your machine). `setup`
explicitly re-enables scripts for the one place we need them — rebuilding the
native `better-sqlite3` binding — and installs the husky pre-commit hook.

If your `prepare` script hasn't run, husky won't be wired up, so the gitleaks +
lint-staged hook won't fire. `npm run setup` covers both.

### Optional: gitleaks

The pre-commit hook runs [gitleaks](https://github.com/gitleaks/gitleaks) over
your staged changes. It is not an npm dependency — it's a standalone binary:

```sh
brew install gitleaks          # macOS; see the project's releases for Linux/Windows
```

If it isn't installed the hook says so and continues, so you can commit
without it. CI runs gitleaks over every PR and every push to `main` regardless,
so nothing reaches the repo unscanned — but you'll find out from a failed build
rather than from a blocked commit. Installing it is the faster feedback loop.

## Before opening a PR

Run these locally:

```sh
npm run lint            # eslint with security + no-unsanitized plugins, --max-warnings 0
npm run typecheck       # tsc --noEmit across shared / server / web
npm run format:check    # prettier; a required CI step, and easy to miss locally
npm test                # vitest
npm run test:security   # F-invariant regression suite ([security]-tagged vitest cases)
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
`[security]`-tagged tests, most of them under `*.security.test.ts`. (The old
F6 / R3 bats suite went away with the bus shell scripts in the pure-SDK
rewrite; those invariants are vitest cases now.)

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
