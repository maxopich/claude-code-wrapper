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
- Bus runtime: orchestrator routing, chain pipeline, the in-process `bus_send` tool ([server/src/bus/](server/src/bus/)).
- Multi-agent install / bootstrap path ([server/src/bus/install.ts](server/src/bus/install.ts)).
- SQLite migrations and schema ([server/src/migrations/](server/src/migrations/)).
- Recorded SDK fixtures used in mock mode ([fixtures/](fixtures/)) — credential leakage in committed JSONL is a real concern.
- CI workflows ([.github/workflows/](.github/workflows/)) and supply-chain config (`.npmrc`, `.gitleaks.toml`, `osv-scanner.toml`, `.semgrep/`).

### Out of scope

Items below are known limitations under Cebab's current architecture; reports for these will be acknowledged but typically closed as "won't fix at this scope":

- **Same-uid agent → operator** privilege escalation. Bus agents run under the operator's own uid, and a worker's tool calls are auto-approved (the runner's `canUseTool` allows everything except `AskUserQuestion`). A worker can therefore read `~/.cebab/auth-token` off disk and open its own WS connection. (The orchestrator is the exception and does not change this: it runs `toolPolicy: 'delegate-only'`, so it cannot reach a file or a shell at all — but the workers it delegates to can, which is what makes the escalation reachable.) **There is no same-uid boundary to build**: Origin/Host are not one either, since a Node client sets any header it likes. So the per-launch WS token defends against other local users and cross-browser-tab CSWSH — never against the agents Cebab itself runs. Fixing this properly requires runtime sandboxing (v2 architectural work). What is done instead is to harden the control-plane verbs where an ungated call was never legitimate, and to make the rest detectable: `mcp_trust_decision` persists `trust`/`trust_pinned` only against a live parked gate entry (so trust rows cannot be pre-seeded to pass a later session-start gate), and `set_trusted` writes a `project.trust_decided` row to the hash-chained audit log before it flips anything. See [server/src/auth.ts](server/src/auth.ts).
- **OAuth credential hygiene on `~/.claude/.credentials.json`.** Cebab uses the user's existing `claude` CLI subscription via the file's OAuth artifacts. Compromise of that file is a local user-account concern outside Cebab's threat model.
- **Auth-token file permissions on Windows.** The token is written mode 0600 on POSIX. On Windows that mode is meaningless without an ACL call, so it is deliberately not passed — on a multi-user Windows machine the token file is readable by other users of that machine. Cebab is a single-user local tool and Windows is a supported platform (see the README), so this is a stated residual, not an out-of-scope platform.
- **Advisory-only consultant mode.** The prompt-level constraint telling bus participants not to mutate files outside their own project folder is interpreted by the model; nothing denies the tool call. Out-of-scope writes are classified and surfaced post-hoc (`server/src/bus/guardrail.ts`) and dangerous commands can halt the session via the opt-in pause-on-dangerous toggle, but neither is a sandbox. The classifier also does not resolve symlinks and cannot infer paths from `Bash` commands.

## Threat model summary

The mechanism behind everything in this section — what gates a single-agent tool
call, why the bus gates nothing, the consultant constraint and its two limits,
and the credential-env scrub — is in
[docs/safety-and-security.md](docs/safety-and-security.md).

The interesting property of Cebab is **runtime trust posture**: no bus tool call is ever gated on a human. Bus turns run `permissionMode: 'default'` with a `canUseTool` that auto-approves every tool except `AskUserQuestion`, and participants load their project's own `.claude/settings*.json` — so a participant's hooks execute on every hop. Under that posture, a malicious transitive npm `postinstall` script is direct RCE on an operator's machine. So the supply-chain surface (anything that lets attacker-controlled code land in `node_modules/` or in a CI workflow) carries higher severity than for a typical dev tool.

There is one structural exception, and its narrowness is the point: the **orchestrator** runs `toolPolicy: 'delegate-only'`, which is not an auto-approval at all but a default-deny. The 14 built-in file/shell/analysis tools are stripped from its context via `disallowedTools`, and `canUseTool` independently denies anything that is not `bus_send` or `AskUserQuestion` — so a future built-in that nobody remembered to list is denied too. It applies to the orchestrator alone: every worker and every chain participant runs the auto-approve posture described above, which is why the paragraph above stands as the summary of Cebab's posture rather than this one.

The defended invariants (F1–F6, R3, F12) are documented inline in code and pinned by:

| Layer                                               | Where                                                                                                                                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bus recipient validation (F1)                       | [server/src/bus/paths.ts](server/src/bus/paths.ts) (`isValidBusRecipient`), enforced in `handleBusSend`; tests at [paths.test.ts](server/src/bus/paths.test.ts)                                |
| Source allowlist on bus events (F2)                 | [server/src/bus/orchestrator.ts](server/src/bus/orchestrator.ts), [server/src/bus/chain.ts](server/src/bus/chain.ts); tests at `*.security.test.ts`                                            |
| Cebab-source forgery drop (F3)                      | Same files as F2                                                                                                                                                                               |
| Per-launch WS auth token, mode 0600 on POSIX (F4)   | [server/src/auth.ts](server/src/auth.ts), [server/src/ws/server.ts](server/src/ws/server.ts); tests at [auth.test.ts](server/src/auth.test.ts)                                                 |
| Origin + Host allowlist on WS upgrade (F5)          | [server/src/origin.ts](server/src/origin.ts), [server/src/ws/server.ts](server/src/ws/server.ts); tests at [origin.security.test.ts](server/src/origin.security.test.ts)                       |
| Origin required on `GET /auth-token`                | [server/src/auth_token_route.ts](server/src/auth_token_route.ts); tests at [auth_token_route.security.test.ts](server/src/auth_token_route.security.test.ts)                                   |
| Unspoofable bus identity (F6, R3)                   | `source` is pinned per-agent in a Cebab-owned closure in [server/src/bus/runner.ts](server/src/bus/runner.ts) (`makeBusToolServer`), not read from agent-controlled env                        |
| Escalating MCP trust requires a live gate           | [server/src/ws/server.ts](server/src/ws/server.ts) `mcp_trust_decision`; tests at [mcp_trust_gate_path.security.test.ts](server/src/ws/mcp_trust_gate_path.security.test.ts)                   |
| Hash-chained safety audit, fail-closed verification | [server/src/notifications/safety_audit.ts](server/src/notifications/safety_audit.ts); tests at [safety_audit.test.ts](server/src/notifications/safety_audit.test.ts)                           |
| Permission-map cleanup on interrupt (F12)           | [server/src/ws/server.ts](server/src/ws/server.ts); tests at [server.security.test.ts](server/src/ws/server.security.test.ts)                                                                  |
| Orchestrator default-deny tool lock                 | `DELEGATE_ONLY_DISALLOWED` + `isDelegationAllowedTool` in [server/src/bus/runner.ts](server/src/bus/runner.ts); tests at [runner.delegation.test.ts](server/src/bus/runner.delegation.test.ts) |

CI gates (Tier 1 + Tier 2): least-privilege workflow permissions, SHA-pinned actions, actionlint + zizmor lint, OSV-Scanner, dependency-review, CodeQL, Semgrep with three Cebab-specific custom rules (F4/F5 verifyClient, F2 spawn-non-literal, win32 spawn shell guard), gitleaks with Cebab-specific rules, fixture-review gate on `fixtures/*.jsonl`, npm postinstall blocked via `.npmrc`.

Those three Semgrep rules each carry a fixture in `.semgrep/cebab-bus.ts` that `semgrep --test` runs in CI, so a rule whose target is deleted fails the build instead of silently matching nothing. A third rule was removed for exactly that reason — it had been dead since the bus rewrite while still being counted here.

## Acknowledgements

Past security-related work is tracked in commit messages tagged `security(...)` and in the pull requests they reference. (This used to point at a CHANGELOG; the repo has never had one.)
