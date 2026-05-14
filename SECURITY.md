# Security policy

## Reporting a vulnerability

Please **do not** open public GitHub issues for security reports.

Email security reports to **maxopich@gmail.com** with the subject prefix `[cebab-security]`.

If you can, include:

- A reproducer or PoC (or the smallest code change that demonstrates the issue).
- Affected files / functions / commits.
- Your assessment of impact (RCE, info disclosure, denial of service, etc.).
- Your name or handle for credit (or "anonymous" if you prefer).

**Response SLA:**

- Acknowledgement within **48 hours**.
- Initial triage + severity assessment within **14 days**.
- Fix timeline communicated after triage.

## Scope

### In scope

- WebSocket server, HTTP handlers, and the `/auth-token` endpoint ([server/src/ws/](server/src/ws/), [server/src/index.ts](server/src/index.ts), [server/src/auth.ts](server/src/auth.ts), [server/src/origin.ts](server/src/origin.ts)).
- Bus runtime: orchestrator routing, chain pipeline, bus shell scripts ([server/src/bus/](server/src/bus/)).
- Multi-agent install / bootstrap path ([server/src/bus/install.ts](server/src/bus/install.ts)).
- SQLite migrations and schema ([server/src/migrations/](server/src/migrations/)).
- Recorded SDK fixtures used in mock mode ([fixtures/](fixtures/)) — credential leakage in committed JSONL is a real concern.
- CI workflows ([.github/workflows/](.github/workflows/)) and supply-chain config (`.npmrc`, `.gitleaks.toml`, `osv-scanner.toml`, `.semgrep/`).

### Out of scope

Items below are known limitations under Cebab's current architecture; reports for these will be acknowledged but typically closed as "won't fix at this scope":

- **Same-uid worker → operator** privilege escalation. Bus workers and the orchestrator run with `--permission-mode bypassPermissions` under the operator's uid (documented at [server/src/auth.ts:14-23](server/src/auth.ts) and in [CLAUDE.md](CLAUDE.md)). A worker can read `~/.cebab/auth-token` directly, so the per-launch WS auth token does not defend against a malicious-worker scenario — it defends against cross-browser-tab CSWSH. Fixing this requires runtime sandboxing (v2 architectural work).
- **Cross-worker BUS_AGENT_NAME impersonation.** Two workers on the same bus can claim each other's slug via env-var manipulation. The F2 source allowlist closes the cross-mode (chain vs orchestrator) case but not same-mode peer impersonation. Closing this needs Cebab-as-arbiter (Unix socket + `SO_PEERCRED` or similar) — not in v1.
- **OAuth credential hygiene on `~/.claude/.credentials.json`.** Cebab uses the user's existing `claude` CLI subscription via the file's OAuth artifacts. Compromise of that file is a local user-account concern outside Cebab's threat model.
- **macOS-only.** Linux / Windows are not supported v1 targets; bugs that exist only on those platforms aren't security issues in scope.

## Threat model summary

The interesting property of Cebab is **runtime trust posture**: bus workers and the orchestrator both launch with `--permission-mode bypassPermissions`. Under that posture, a malicious transitive npm `postinstall` script is direct RCE on an operator's machine. So the supply-chain surface (anything that lets attacker-controlled code land in `node_modules/` or in a CI workflow) carries higher severity than for a typical dev tool.

The defended invariants (F1–F6, R3, F12) are documented inline in code and pinned by:

| Layer                                                | Where                                                                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Path-traversal rejection in `writeInboxMessage` (F1) | [server/src/bus/runtime.ts](server/src/bus/runtime.ts); tests at [runtime.test.ts](server/src/bus/runtime.test.ts)                                                       |
| Source allowlist on bus events (F2)                  | [server/src/bus/orchestrator.ts](server/src/bus/orchestrator.ts), [server/src/bus/chain.ts](server/src/bus/chain.ts); tests at `*.security.test.ts`                      |
| Cebab-source forgery drop (F3)                       | Same files as F2                                                                                                                                                         |
| Per-launch WS auth token, mode 0600 (F4)             | [server/src/auth.ts](server/src/auth.ts), [server/src/ws/server.ts](server/src/ws/server.ts); tests at [auth.test.ts](server/src/auth.test.ts)                           |
| Origin + Host allowlist on WS upgrade (F5)           | [server/src/origin.ts](server/src/origin.ts), [server/src/ws/server.ts](server/src/ws/server.ts); tests at [origin.security.test.ts](server/src/origin.security.test.ts) |
| BUS_AGENT_NAME shape + sentinel deny-list (F6, R3)   | [server/src/bus/scripts/bus-send-msg.sh](server/src/bus/scripts/bus-send-msg.sh); tests at [bus-send-msg.bats](server/src/bus/scripts/bus-send-msg.bats)                 |
| Permission-map cleanup on interrupt (F12)            | [server/src/ws/server.ts](server/src/ws/server.ts); tests at [server.security.test.ts](server/src/ws/server.security.test.ts)                                            |

CI gates (Tier 1 + Tier 2): least-privilege workflow permissions, SHA-pinned actions, actionlint + zizmor lint, OSV-Scanner, dependency-review, CodeQL, Semgrep with three Cebab-specific custom rules (F1 silent-bug, F4 verifyClient, F2 spawn-non-literal), gitleaks with Cebab-specific rules, fixture-review gate on `fixtures/*.jsonl`, npm postinstall blocked via `.npmrc`. Commits to `main` are signed via [gitsign](https://github.com/sigstore/gitsign) (Sigstore keyless OIDC) — setup is documented in [CONTRIBUTING.md](CONTRIBUTING.md#signed-commits).

## Acknowledgements

Past security-related work is tracked in the [CHANGELOG](https://github.com/maxopich/claude-code-wrapper/blob/main/CHANGELOG.md) where applicable and in commit messages tagged `security(...)`.
