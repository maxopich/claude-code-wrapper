# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser-based wrapper around the local `claude` CLI on macOS. The user has many agent projects under some workspace root (e.g. `~/agents/<name>/` — set per-install via the Settings modal, stored in SQLite); this app lists them in a sidebar, runs each as its own `cwd`, and renders the streamed output as a chat UI with inline tool-approval cards. macOS-only, single-user, bound to `127.0.0.1`. **No Anthropic API** — it uses the user's existing Claude subscription via `~/.claude/.credentials.json`.

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

**Browser threat model**. The WS upgrade is gated on `Origin` and `Host`: the browser must come from `http://127.0.0.1:5173` (Vite dev) / `http://localhost:5173` / `http://127.0.0.1:$PORT`. Extra origins via `CEBAB_ALLOWED_ORIGINS` (comma-separated). Empty `Origin` is allowed — browsers always set it on WS upgrades, so an absent header means a non-browser client (smoke tests, curl), and the server is bound to 127.0.0.1 anyway. Without the Origin check, any tab the user has open could connect to the local server (Cross-Site WebSocket Hijacking). Per-launch tokens are deliberately out of scope for v1.

**Persistence**: every SDKMessage hits `persistMessage()` → DB row in `events` (raw + denormalized type/subtype) AND a line in `~/.cebab/logs/<session_id>.jsonl`. The JSONL files are the source for mock-mode fixtures.

**Mock mode** (`MOCK=1`): `pickRunner()` routes to `runner/mock.ts` which replays `fixtures/*.jsonl` through the same persistence path. Required infrastructure, not optional — UI iteration on real claude burns quota.

**Lifecycle**: `runner/lifecycle.ts` tracks every in-flight `Query` object globally. The server's SIGINT handler calls `closeAllQueries()` before exiting, and the per-turn `finally` block calls `query.close()`. Without this, SDK-spawned `claude` processes outlive the server and silently consume subscription quota.

**Auth precedence gotcha**: the CLI prefers `ANTHROPIC_API_KEY` over OAuth subscription. `runner/claude.ts` strips that var (and `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`) from the spawn env so a stray export in `.zshrc` can't silently route to paid billing.

## Commands

```sh
npm install                                       # install all workspaces
npm run dev:server                                # start server (real claude, port 4319)
MOCK=1 npm run dev:server                         # start server in mock mode
npm run dev:web                                   # start vite dev server (port 5173)
npm run build                                     # build everything
npm run smoke                                     # DB migration smoke (server only)
npm --workspace server exec tsc --noEmit          # typecheck server
npm --workspace web exec tsc --noEmit             # typecheck web

# Integration smokes (require a running server)
npm --workspace server exec tsx src/ws_smoke.ts          # WS protocol via mock
PROJECT=Cebab npm --workspace server exec tsx src/live_smoke.ts   # live: permission + resume
```

## v1 scope (don't expand without asking)

In: project sidebar, send a message, see streamed text + tool calls + approvals, persist, follow-up message resumes correctly, per-project Trust toggle, mock mode.

Out: file/git/cost panels, multi-session UI, hooks/plugins/skills UI, theming, web/remote/auth, Linux/Windows. Resist scope creep aggressively.

## Stream-json oddities (verified live, undocumented)

The captured fixture surfaced two event types missing from the docs:

- top-level `rate_limit_event` (with `rate_limit_info: { status, resetsAt, rateLimitType, ... }`)
- `system/status` (e.g. `{ status: "requesting" }`)

The `translate()` and reducer fall through to a generic `system_event` for these, and unknown future types render as `system_event { subtype: "unknown:<type>" }`. Don't add hard-typed handling for them unless something starts rendering badly.

## Resume gotcha

`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` is keyed by the absolute `cwd` with every non-alphanumeric char replaced by `-`. If a project's directory ever moves, prior sessions become unresumable. Don't surface a "rename project path" UI without writing a migration first.
