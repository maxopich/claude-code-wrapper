# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**When this file is actually loaded.** Mostly: a `claude` / Claude Code session run _directly in this checkout_ to develop Cebab — standard project memory (this very session is that path). Also when Cebab runs the Cebab project as a **Trusted** single-agent project (`settingSources` then includes `'project'`, so the SDK auto-loads it). In the **multi-agent bus** it loads only when Cebab is a _worker / chain participant_: Cebab reads each agent's project-root `CLAUDE.md` and injects it **verbatim as framed prompt text** (`readProjectClaudeMd` in `bus/runtime.ts`). The **orchestrator never sees it** — that runs in an empty workspace cwd under `settingSources: ['user']`. Net: this is build/analyze-Cebab guidance, _not_ a product-owner brief — and because the bus feeds it verbatim into worker turns, stale content here misleads agents, not just humans. Keep it accurate.

## What this is

A browser-based wrapper around the local `claude` CLI. The user has many agent projects under some workspace root (e.g. `~/agents/<name>/` — set per-install via the Settings modal, stored in SQLite); this app lists them in a sidebar, runs each as its own `cwd`, and renders the streamed output as a chat UI with inline tool-approval cards. Single-user, bound to `127.0.0.1`. **No Anthropic API** — it uses the user's existing Claude subscription via `~/.claude/.credentials.json`.

**Cross-platform (macOS, Linux, Windows — no WSL).** Both the single-agent path and the multi-agent bus are pure in-process Agent SDK `query()` calls — no tmux, no shell scripts, no OS-specific IPC — so one codebase behaves identically on all three. CI runs `ubuntu-latest` + `windows-latest`. See `~/.claude/plans/now-it-s-time-to-lazy-castle.md` for the bus re-architecture (tmux → pure SDK) reasoning and decisions.

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
- _Untrusted_: `permissionMode: "default"` and `settingSources: ['user']`. Only `~/.claude/settings.json` applies. A hostile or careless `.claude/settings.local.json` checked into a sibling repo can't auto-load hooks the moment the user clicks that project.

The chat UI also exposes a per-session toggle that flips between `default` and `acceptEdits` mid-flight via `query.setPermissionMode()`. This is independent of the project Trust setting; it doesn't alter `settingSources` (already locked in when the run started).

**Multi-agent bus = pure in-process SDK.** The bus (chain + orchestrator modes) is a generalization of the single-agent runner from 1→N: each participant is its own SDK `query()` (via the same `pickRunner` seam, so it inherits mock-mode parity), one `query()` per hop with `--resume` to carry context. Agents exchange messages by calling an injected in-process `bus_send` MCP tool — there is **no tmux, no bash scripts, no Stop hook, no file IPC, no bus.log**. The tool's `source` is pinned per-agent in a Cebab-owned closure (`server/src/bus/runner.ts`), so a worker cannot spoof its identity — the security win over the old env/file model. `server/src/bus/{runner,chain,orchestrator,session_registry}.ts` are the core, with `runtime.ts` the single source of truth for every agent-facing prompt (roster, briefings, the consultant-mode guardrail) and `reconstruct.ts` the server-restart recovery path; F2/F3 source-allowlist drop filters are kept verbatim as defense-in-depth.

**Bus install is pure DB metadata.** Clicking "Install bus integration" only assigns a stable agent slug + flips a row flag — Cebab writes **nothing** into the operator's project (no `.claude/settings.json` merge, no CLAUDE.md `@import`, no copied scripts, no Stop hook). Workers and the orchestrator run with `settingSources: ['user']`. The bus protocol reaches each agent via a per-turn briefing Cebab prepends — `renderChainBriefing` for chain participants, `renderWorkerBriefing` for orchestrator workers, `renderRosterPrompt` for the orchestrator (its **only** prompt: its workspace is an empty Cebab-owned cwd, no generated `CLAUDE.md`/`comm.md` — those were dead under `['user']` and were removed). Each agent's own project-root `CLAUDE.md` is _additionally_ read and injected as framed prompt **text** on its first turn (`readProjectClaudeMd`) — read-only, executes nothing, so "writes nothing to the project" still holds. Both workers and the orchestrator run headless `query()` with `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions` (no human to answer a per-tool prompt) — so the **consultant-mode guardrail** (in `runtime.ts`'s prompts) is the only thing standing between a vaguely-routed task and a silent repo mutation: in a bus session every participant — orchestrator and workers — acts as a **consultant** (read, analyze, advise; scratch/notes inside its own project folder are fine) and must **not** modify/create/delete files in other directories or produce deliverable changes _unless the user's relayed request explicitly directs that specific change_. Trust gates unchanged in spirit: workers = the operator's per-project bus-install click; orchestrator = Cebab owns its `<sessionFolder>/orchestrator/` workspace cwd.

**Bus resume (R-A + R-B).** Live sessions live in an in-process registry (`session_registry.ts`), the analogue of "tmux survived". A browser close/refresh/second window re-attaches by swapping the WS sink — the run keeps going (R-A). A Cebab **server** restart empties the registry; an **orchestrated** session is then rebuilt from durable state (`reconstruct.ts`, R-B) and re-attached **read-only** — it sets `awaiting_continue`, replays a recovery banner, and runs nothing until the operator explicitly continues (an interrupted turn's side effects are _not_ rolled back). **Chain** mode is not reconstructed yet and still falls back to `crashed`. Persisted transcripts/events always survive; single-agent resume is a separate path and is unaffected.

**Browser threat model**. The WS upgrade is gated on `Origin` and `Host`: the browser must come from `http://127.0.0.1:5173` (Vite dev) / `http://localhost:5173` / `http://127.0.0.1:$PORT`. Extra origins via `CEBAB_ALLOWED_ORIGINS` (comma-separated). Empty `Origin` is allowed — browsers always set it on WS upgrades, so an absent header means a non-browser client (smoke tests, curl), and the server is bound to 127.0.0.1 anyway. Without the Origin check, any tab the user has open could connect to the local server (Cross-Site WebSocket Hijacking). Per-launch tokens are deliberately out of scope for v1.

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
```

**Stale dev:server orphans.** `tsx watch` is a supervisor that doesn't exit when its child Node crashes — it polls for file changes forever, intending to respawn on edit. When a Claude Code session calls `Bash(run_in_background: true)` to spawn `dev:server`, the `npm → npm → tsx watch → node` subtree gets reparented to launchd once the launching session exits and lives indefinitely; across sessions and worktrees these accumulate and silently squat on port 4319. Cleanup is automatic on the next launch: both `npm run dev:server` (`server.predev`) and `npm run dev` (inline in `scripts/dev.mjs`) invoke [`scripts/predev-server.mjs`](scripts/predev-server.mjs), which kills any prior `tsx watch ... --env-file-if-exists=../.env src/index.ts` before starting. Agents that spawn `dev:server` in the background should still `kill` it explicitly before ending — the predev hook only fires at the next _start_, not at session teardown.

## v1 scope (don't expand without asking)

In: project sidebar, send a message, see streamed text + tool calls + approvals, persist, follow-up message resumes correctly, per-project Trust toggle, mock mode, multi-agent bus (chain + orchestrator, pure-SDK) with a Templates browser and server-restart resume (R-B), the design-token-based web UI, native macOS/Linux/Windows.

Out: file/git/cost panels, multi-session UI, hooks/plugins/skills UI, user-facing theme switching / appearance settings, web/remote/auth, WSL. (Design tokens shipped; a theming _panel_ did not — the recolor is a fixed palette, not a feature.) This "Out" list is a brake on _further_ creep, not a snapshot of current state — resist scope creep aggressively.

## Stream-json oddities (verified live, undocumented)

The captured fixture surfaced two event types missing from the docs:

- top-level `rate_limit_event` (with `rate_limit_info: { status, resetsAt, rateLimitType, ... }`)
- `system/status` (e.g. `{ status: "requesting" }`)

The `translate()` and reducer fall through to a generic `system_event` for these, and unknown future types render as `system_event { subtype: "unknown:<type>" }`. Don't add hard-typed handling for them unless something starts rendering badly.

## Resume gotcha

`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` is keyed by the absolute `cwd` with every non-alphanumeric char replaced by `-`. If a project's directory ever moves, prior sessions become unresumable. Don't surface a "rename project path" UI without writing a migration first.
