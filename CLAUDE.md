# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**When this file is actually loaded.** Mostly: a `claude` / Claude Code session run _directly in this checkout_ to develop Cebab — standard project memory (this very session is that path). Also when Cebab runs the Cebab project as a **Trusted** single-agent project (`settingSources` then includes `'project'`, so the SDK auto-loads it). In the **multi-agent bus** it loads two ways for _worker / chain participants_: (a) Cebab reads each agent's project-root `CLAUDE.md` and injects it **verbatim as framed prompt text** on the first turn (`readProjectClaudeMd` in `bus/runtime.ts`) so the bytes show up in the on-disk transcript + operator chat, and (b) the SDK additionally auto-loads it because workers/participants now run with `settingSources: ['user', 'project', 'local']`. The **orchestrator never sees it** — that runs in an empty workspace cwd under `settingSources: ['user']`. Net: this is build/analyze-Cebab guidance, _not_ a product-owner brief — and because the bus feeds it verbatim into worker turns, stale content here misleads agents, not just humans. Keep it accurate.

**Deeper reference lives in `docs/`, and nothing there is auto-loaded.** Both loaders — the SDK's project-memory load and the bus's `readProjectClaudeMd` injection — read `CLAUDE.md` and stop. These pages arrive only when you open them, so treat the list as an instruction, not a table of contents:

- [`docs/bus-architecture.md`](docs/bus-architecture.md) — core bus modules, what "install" does and does not write, per-participant `settingSources`, the `cebab_bus` MCP namespacing, and server-restart resume (R-A/R-B). **Read before touching `server/src/bus/`.**
- [`docs/safety-and-security.md`](docs/safety-and-security.md) — why the consultant guardrail is advisory, the pause-on-dangerous gate, the hash-chained audit log, forensic snapshots, the TOFU install gate, operator mute/pause/kick, the browser Origin gate and the per-launch auth token. **Read before touching `server/src/notifications/`, `bus/pause_gate.ts`, `bus/install_trust_gate.ts`, `auth.ts`, or `origin.ts`.**

The security-critical _claims_ stay here on purpose — the live permission posture, and the consultant constraint with its two limits. Moving them would recreate the exposure #333 closed: a wrong posture sentence is what an agent reads and acts on, so it belongs in the file that always loads. Reference detail can move; the rules cannot.

## What this is

A browser-based wrapper around the local `claude` CLI. The user has many agent projects under some workspace root (e.g. `~/agents/<name>/` — set per-install via the Settings modal, stored in SQLite); this app lists them in a sidebar, runs each as its own `cwd`, and renders the streamed output as a chat UI with inline tool-approval cards. Single-user, bound to `127.0.0.1`. **No Anthropic API** — it uses the user's existing Claude subscription via `~/.claude/.credentials.json`.

**There are TWO kinds of project, and only one comes from the workspace scan** (`Cebab-ws0.9`). The scan is still the only way an _ordinary_ project appears — there is no `add_project` verb. A **managed agent** is the second kind: a full, independent recursive snapshot of a project at `<dataDir>/agents/<slug>/`, registered by `registerManagedProject` as an ordinary `projects` row, so Trust, the authority resolve, sessions and the bus work on it unchanged. Its `cwd` is inside the data dir, which is what makes "nothing lands in the operator's workspace" true for the single-agent path — `Cebab-ws0.8` did the bus half. A second copy of one project makes a SECOND managed agent (disambiguated `slug-2`), never an overwrite.

**"Is this project managed?" is answered by the PATH, never by a column.** `isManagedProjectPath` asks whether `projects.path` is inside `managedAgentsRoot()`; `managed_source_path` / `managed_copied_at` are provenance only. The distinction is load-bearing rather than stylistic: `syncWorkspaceProjects` soft-deletes any row the workspace scan did not see, and a managed row is _never_ in that scan — so managed rows need an exemption from that sweep, and every managed agent would otherwise be marked missing on the next `list_projects` (i.e. on every sidebar refresh). Key that exemption on a column and a hand-edited `managed_source_path` grants an ordinary project permanent immunity, while clearing it on a real managed agent sweeps it out from under a live directory. A managed agent whose directory the operator deleted by hand still _does_ go missing — each managed row answers for itself.

**The copy engine's symlink rule is stricter than "don't follow symlinks"** (`managed_agent.ts`). `fsp.cp({ dereference: false })` satisfies that phrase and is wrong here: it recreates an escaping link faithfully, handing the managed agent a live path out of the space Cebab owns. So does an **absolute** link that resolves _inside_ the source — recreated verbatim it still names the SOURCE after the copy. Only relative links resolving inside-or-at the source root are recreated; everything else is skipped and reported. Directory links are never descended, which is also the loop guard. Measured caps (5 GB / 300k files) are a backstop, not the decision: the operator sees a preflight measured by the _same traversal the copy uses_ and confirms. The copy is `fs.promises` throughout — a synchronous copy of the gigabyte-scale trees this deliberately includes would park the event loop for minutes.

**Cross-platform (macOS, Linux, Windows — no WSL).** Both the single-agent path and the multi-agent bus are pure in-process Agent SDK `query()` calls — no tmux, no shell scripts, no OS-specific IPC — so one codebase behaves identically on all three. CI runs `ubuntu-latest` + `windows-2022` — the Windows image is **pinned, not `-latest`**, because node-gyp does not recognise the newer image's toolchain ([`ci.yml`](.github/workflows/ci.yml) carries the full reason and the revert condition). See `~/.claude/plans/now-it-s-time-to-lazy-castle.md` for the bus re-architecture (tmux → pure SDK) reasoning and decisions.

## Architecture

```
browser ── WS ── Node server ── Agent SDK query() ── claude subprocess
                     │
                     ├── better-sqlite3 (~/.cebab/cebab.sqlite)
                     └── per-session JSONL (~/.cebab/logs/<sid>.jsonl)
```

**Runner: `@anthropic-ai/claude-agent-sdk`, not raw subprocess.** The SDK still spawns the `claude` CLI under the hood and uses the same OAuth credentials, but it gives us:

- typed `SDKMessage` union (`system` / `assistant` / `user` / `result` / `stream_event`)
- in-process `canUseTool` callback (no MCP permission server needed)
- `query.interrupt()` / `query.setPermissionMode()` / `query.close()` mid-flight

This is the most important architectural decision in the repo — see `~/.claude/plans/claude-code-wrapper-twinkly-balloon.md` for the full reasoning.

**One subprocess per user message**, with `--resume <session_id>` for continuity across messages. The `--input-format stream-json` long-running mode is _not_ used in v1.

**Permission flow** (when project isn't trusted):

1. SDK calls `canUseTool(name, input)` in `server/src/ws/server.ts`.
2. Handler emits `permission_request` over WS, parks a `Promise<PermissionResult>` in `Conn.pendingPermissions`.
3. Browser's approval card resolves it via `permission_decision` ClientMsg.
4. Trusted projects skip the round-trip and pre-set `permissionMode: "acceptEdits"`.

**Trust model**. The per-project Trust toggle controls TWO things: the initial `permissionMode` AND the `settingSources` scope passed to the SDK.

- _Trusted_: `permissionMode: "acceptEdits"` and `settingSources: ['user', 'project', 'local']`. The project's own `.claude/settings*.json` (hooks, env injectors, MCP servers) are layered in.
- _Untrusted_: `permissionMode: "default"` and `settingSources: ['user']`. The project's own files don't apply, so a hostile or careless `.claude/settings.local.json` checked into a sibling repo can't auto-load hooks the moment the user clicks that project. **What Trust does NOT stop: MCP servers declared in `~/.claude.json`'s top-level `mcpServers` (`claude mcp add --scope user`) load under `['user']` too** — measured, see `readClaudeJsonServers` in `repo/project_authority.ts`. Trust scopes the _project's_ files; a home-directory declaration is outside its reach. Cebab gates those through TOFU instead, which is the only brake on them.

**The sidebar now shows what Trust is keeping out** (`Cebab-ws0.6`). `repo/project_scan.ts` runs the file-scan half of the authority resolver for EVERY project on the `projects` message — synchronous, file-read-only, zero DB statements, no spawn — and the wire message carries a `ProjectScan` per row alongside the rows themselves. It reads declarations at every scope and marks each with whether the project's current scope set actually loads it, which is the fact that was previously unobservable anywhere: `readMcpJsonServers` returns `[]` outright when the scope set excludes `'project'`, so an untrusted project's `.mcp.json` server was not merely inactive, it was invisible, and the panel's best sentence was "project scope not read" — _we did not look_, never _there is one here and it will not load_. Measured cost for 21 projects: 3.98 ms, ~6.2 file opens each, which is why the obvious per-pass caching of `~/.claude.json` was **not** built. Three things the resolver does are deliberately excluded and the exclusions are what keep it cheap: `tallyToolUsage` (walks every event row of every session), `enrichWithTrustState` (a bounded read + sha256 per server binary, so MCP TOFU state is absent from this tier — `Cebab-8g3`), and `resolveToolAuthority` (needs an SDK snapshot). The single emit point is `sendProjects` in `ws/server.ts`; `ws/projects_emit_site.test.ts` is what stops a ninth site appearing, because the scan is derived from `trusted` and a hand-built re-emit after a trust toggle would ship a summary that contradicts the pill beside it.

The chat UI also exposes a per-session toggle that flips between `default` and `acceptEdits` mid-flight via `query.setPermissionMode()`. This is independent of the project Trust setting; it doesn't alter `settingSources` (already locked in when the run started).

**`default` binds on trusted projects too** (`Cebab-ws0.14`). `shouldAutoAllow` (`ws/permission.ts`) is the ONLY gate for single-agent runs — supplying `canUseTool` makes the SDK delegate everything to it, so `Options.permissionMode` gates nothing by itself. It used to open with `if (trusted) return true`, which meant the toggle above was **inert on trusted projects**: the operator could press `ask`, watch the pill move and the server persist `default`, and every tool still auto-allowed. Now `default` asks everywhere. Nothing changed by default, because `seedPermissionMode` still seeds `acceptEdits` for a fresh trusted session — Trust means "auto-allow everything _by default_", not "and you may not ask me to stop". The change only ever adds permission cards, so it cannot widen privilege.

**The starting mode is a third input** (`Cebab-ws0.4`). `projects.start_permission_mode` holds the mode a project's NEW sessions begin in, or NULL for "derive from Trust" — which is what every project did before the column existed. `seedPermissionMode` resolves in this order, and the order is the design: **a resumed session's own stored mode > the project's starting mode > the trust-derived value**. Promoting the project setting above the stored one reads as more correct and is the destructive option — it would silently re-point every in-progress conversation the operator had already steered, on their next message. The column is unconstrained `TEXT`, so it is filtered through `resolveStartPermissionMode` at the READ site; a hand-edited value outside the two-mode union never reaches a spawn. Setting it is **audited** (`project.start_mode_decided`, audit-before-write, refused if the append fails) because it sets an initial permission posture, unlike the silent `set_project_model`. Single-agent only — the bus runs its own gate.

**Model selection is per project, and absence is load-bearing** (`Cebab-ws0.3`). `projects.model` holds the model a project's runs ask for, or NULL. NULL means Cebab omits `Options.model` from the SDK call **entirely** — not that it sends some default string — which is what keeps every unconfigured project spawning byte-identically to Cebab before this existed. One helper, `projectModelSpec(projectId)` in `repo/projects.ts`, returns a spreadable `{ model? }` and is the only thing any call site uses: the single-agent turn (`ws/server.ts`) and all three bus `runner.register` sites. It returns an object rather than a `string | undefined` precisely so nobody writes `model: x` and ships `undefined` to the SDK while looking correct.

The picker's list is **never hardcoded**. `Query.supportedModels()` — measured, and not streaming-input-only despite its neighbours `setModel`/`setPermissionMode` being so — returns the CLI's own catalogue, and it resolves in ~0ms because the list rides the initialize handshake. `probeSessionStarted` captures it as a free side effect of the authority probe (a process spawn, no model turn) into the account-wide `settings` key `model_catalogue`. A failed capture leaves the previous cache alone; mock mode serves a fixture and never writes. Note the CLI's catalogue includes a row whose value is the literal string `'default'`: the UI renders its label but stores NULL for it, so "chose Default" and "never chose" converge on the same spawn.

**The bus chooses a model but still cannot report one.** Participants pick up their project's model, but the bus emits no `session_started`, so nothing on the wire says what a participant actually ran on (Register W13; `Cebab-ut7` tracks the signal). Until that lands the setting is write-only for multi-agent runs. The orchestrator's own spec has no project and so no model — correct, since routing is not the work.

**Multi-agent bus = pure in-process SDK.** The bus (chain + orchestrator modes) is a generalization of the single-agent runner from 1→N: each participant is its own SDK `query()` (via the same `pickRunner` seam, so it inherits mock-mode parity), one `query()` per hop with `--resume` to carry context. Agents exchange messages by calling an injected in-process `bus_send` MCP tool — there is **no tmux, no bash scripts, no Stop hook, no file IPC, no bus.log**. The tool's `source` is pinned per-agent in a Cebab-owned closure (`server/src/bus/runner.ts`), so a worker cannot spoof its identity — the security win over the old env/file model.

**Every production bus turn runs `permissionMode: 'default'` with a live `canUseTool`** (`server/src/bus/runner.ts`). Both routers wire an `onAskUserQuestion` hook — `orchestrator.ts` and `chain.ts` — and that hook is what selects the posture. The gate **auto-allows every tool _except_ `AskUserQuestion`** on any agent without `toolPolicy: 'delegate-only'`, which today means every worker and every chain participant; `AskUserQuestion` is parked for the operator, whose answer is handed back to the model as the tool result. The `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions` branch also in `runner.ts` is reached **only by callers that skip the hook — i.e. tests**; it is not the chain path, and `bus/guardrail.ts` carries the authoritative explanation of why. So a deny seam exists and is live — it just returns `allow` for everything but `AskUserQuestion`. No posture puts a human in the loop for a `Bash`/`Edit`/`MCP` call, and now that workers also load project hooks, **a participant's `SessionStart`/`PreToolUse`/`PostToolUse`/`Stop` hooks will auto-execute on every bus hop for that participant with no human gate**.

The **consultant-mode guardrail** (in `runtime.ts`'s prompts) is therefore the _prompt-level_ brake between a vaguely-routed task and a silent repo mutation: the participant acts as a **consultant** (read, analyze, advise; scratch/notes inside its own project folder are fine) and must **not** modify/create/delete files in other directories or produce deliverable changes _unless the user's relayed request explicitly directs that specific change_. Two limits on that sentence, both easy to over-read:

- **It reaches the orchestrator and its workers, not chain participants.** `renderRosterPrompt` and `renderWorkerBriefing` render the constraint; `renderChainBriefing` renders **neither** it nor its execute-mode counterpart, so a chain participant receives no prompt-level mutation constraint at all. It still gets the mechanical pause-on-dangerous brake ([`docs/safety-and-security.md`](docs/safety-and-security.md)). One of the two, not neither.
- **It is per-session and the operator can turn it off.** `executeMode` (a session-start opt-in, threaded through all three prompt renderers) **replaces** the consultant text with explicit permission to create, modify and delete files _within the worker's own project folder_. Consultant is the default, not a guarantee.

**Env-precedence caveat, and it is live.** `subscriptionOnlyEnv()` strips paid-billing vars from `process.env`, but the SDK separately layers in `env:` injection from project `settings.json` — a worker project that defines `env: { ANTHROPIC_API_KEY: "..." }` could silently route its turns through paid billing; not filtered today, accepted as part of the "use everything per local configs" trade. (The mechanical pause-on-dangerous brake this used to sit beside now lives in [`docs/safety-and-security.md`](docs/safety-and-security.md).)

**Persistence**: every SDKMessage hits `persistMessage()` → DB row in `events` (raw + denormalized type/subtype) AND a line in `~/.cebab/logs/<session_id>.jsonl`. The JSONL files are the source for mock-mode fixtures.

**Mock mode** (`MOCK=1`): `pickRunner()` routes to `runner/mock.ts` which replays `fixtures/*.jsonl` through the same persistence path. Required infrastructure, not optional — UI iteration on real claude burns quota.

**Lifecycle**: `runner/lifecycle.ts` tracks every in-flight `Query` object globally (single-agent turns AND every bus agent's per-hop `query()`). The server's SIGINT/SIGTERM/SIGBREAK handlers call `closeAllQueries()` before exiting (SIGBREAK is the Windows path — SIGTERM is never delivered there), and the per-turn `finally` block calls `query.close()`. Without this, SDK-spawned `claude` processes outlive the server and silently consume subscription quota.

**Auth precedence gotcha**: the CLI prefers `ANTHROPIC_API_KEY` over OAuth subscription. `runner/claude.ts` strips that var (and `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`) from the spawn env so a stray export in `.zshrc` can't silently route to paid billing.

## Commands

```sh
npm install                                       # install all workspaces
npm run setup                                     # rebuild better-sqlite3 (.npmrc ignore-scripts=true) + git hooks — REQUIRED on every OS
npm run dev:server                                # start server (real claude, port 4319)
MOCK=1 npm run dev:server                         # mock mode (POSIX shells; on Windows/PowerShell set MOCK=1 in .env instead)
npm run dev:web                                   # start vite dev server (port 5173)
npm run build                                     # build everything
npm run smoke                                     # DB migration smoke (server only)
npm run typecheck                                 # tsc --noEmit across shared/server/web
npm run lint                                      # eslint, --max-warnings 0
npm test                                          # vitest, whole repo
npm run test:security                             # [security]-tagged vitest cases

# NOTE: do NOT use `npm --workspace server exec tsc --noEmit` — npm consumes
# `--noEmit` as its own (unknown) config and tsc then EMITS into server/dist/,
# which vitest will then pick up and run stale compiled tests. Use the scripts.

# Integration smokes (require a running server)
npm --workspace server exec tsx src/ws_smoke.ts          # WS protocol via mock
npm --workspace server exec tsx src/ci_smoke.ts          # cross-platform: spawn mock server + ws_smoke + teardown (no shell)
PROJECT=Cebab npm --workspace server exec tsx src/live_smoke.ts   # live: permission + resume
npm --workspace server exec tsx src/mcp_scope_smoke.ts            # live: which settingSources load a project's .mcp.json
```

**A project's own `.mcp.json` loads iff `settingSources` includes `'project'`** — i.e. iff the project is Trusted. Re-measured 2026-08-19 on SDK 0.3.220 (`mcp_scope_smoke.ts`, which exists so the next person re-runs it rather than trusting this sentence). The consequence is the one operators hit: an **untrusted** project does not merely miss its project-scoped servers, and a server that IS loaded can still contribute zero tools because it started and **failed** — a state that looks identical, from inside a session, to a server that was never declared. `claude mcp list` run from a Bash tool call does NOT disambiguate: it is a separate CLI process reporting on config files, not on the session it runs inside. The authority panel's probe (`runner/probe.ts`) is what answers the question, by reading `system/init.mcp_servers` from a real spawn.

**Stale dev:server orphans.** `tsx watch` is a supervisor that doesn't exit when its child Node crashes — it polls for file changes forever, intending to respawn on edit. When a Claude Code session calls `Bash(run_in_background: true)` to spawn `dev:server`, the `npm → npm → tsx watch → node` subtree gets reparented to launchd once the launching session exits and lives indefinitely; across sessions and worktrees these accumulate and silently squat on port 4319. Cleanup is automatic on the next launch: both `npm run dev:server` (`server.predev`) and `npm run dev` (inline in `scripts/dev.mjs`) invoke [`scripts/predev-server.mjs`](scripts/predev-server.mjs), which kills any prior `tsx watch ... --env-file-if-exists=../.env src/index.ts` before starting. Agents that spawn `dev:server` in the background should still `kill` it explicitly before ending — the predev hook only fires at the next _start_, not at session teardown.

## v1 scope (don't expand without asking)

In: project sidebar, send a message, see streamed text + tool calls + approvals, persist, follow-up message resumes correctly, per-project Trust toggle, per-project model selection, mock mode, multi-agent bus (chain + orchestrator, pure-SDK) with a Templates browser and server-restart resume (R-B), the design-token-based web UI, native macOS/Linux/Windows.

Out: file/git/cost panels, multi-session UI, hooks/plugins/skills UI, user-facing theme switching / appearance settings, web/remote/auth, WSL. (Design tokens shipped; a theming _panel_ did not — the recolor is a fixed palette, not a feature.) This "Out" list is a brake on _further_ creep, not a snapshot of current state — resist scope creep aggressively.

## Stream-json oddities (verified live, undocumented)

The captured fixture surfaced two event types missing from the docs:

- top-level `rate_limit_event` (with `rate_limit_info: { status, resetsAt, rateLimitType, ... }`)
- `system/status` (e.g. `{ status: "requesting" }`)

`translate()` now gives `rate_limit_event` its own typed case (→ `{ type: 'rate_limit_event', … }`, feeding the live rate-limit banner) — it no longer falls through. `system/status` still falls through to a generic `system_event`, and unknown future types render as `system_event { subtype: "unknown:<type>" }`. Don't add hard-typed handling for the fall-through types unless something starts rendering badly.

## Resume gotcha

`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` is keyed by the absolute `cwd` with every non-alphanumeric char replaced by `-`. If a project's directory ever moves, prior sessions become unresumable. Don't surface a "rename project path" UI without writing a migration first.
