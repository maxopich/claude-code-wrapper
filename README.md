# CEBAB

Personal browser-based wrapper around the local `claude` CLI. Spawns the
Claude Code Agent SDK (which itself wraps `claude`), routes its typed message
stream to a React UI over a WebSocket, and persists every event to SQLite.

Single-user, bound to `127.0.0.1`, uses your existing Claude subscription via
`~/.claude/.credentials.json` (no API key, no remote access).

Runs natively on **macOS, Linux, and Windows** (no WSL). The multi-agent bus
is a pure in-process SDK runtime — no tmux, no shell scripts — so the single
codebase behaves the same on all three. CI exercises both `ubuntu-latest` and
`windows-2022` — the Windows image is pinned rather than rolling, for a reason
[`ci.yml`](.github/workflows/ci.yml) states along with the revert condition.

## Setup

One command, identical on macOS, Linux and Windows:

```sh
npm run bootstrap        # deps + native better-sqlite3 build + git hooks
cp .env.example .env     # optional — overrides defaults (workspace root, port, mock)
```

**Windows (PowerShell)** — one command, no prerequisites assumed (works in
Windows PowerShell 5.1 and PowerShell 7+):

```powershell
irm https://raw.githubusercontent.com/maxopich/claude-code-wrapper/main/install.ps1 | iex
```

This auto-installs Git and Node.js LTS via `winget` if they're missing
(Windows prompts for elevation on those), clones the repo into
`.\claude-code-wrapper`, then runs `npm run bootstrap`. It checks for the
`claude` CLI (the hard prerequisite noted below) and, if absent, prints how to
install + log in and stops — it never touches your global npm. `irm | iex`
runs the script as a string, so no `Set-ExecutionPolicy` is needed, and it's
idempotent (safe to re-run; the clone becomes a fast-forward pull). It does
fetch and run code — read it first at the raw URL, or pin `main` to a
tag/commit, if you prefer. Preview with zero changes:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/maxopich/claude-code-wrapper/main/install.ps1))) -DryRun
```

Already have Git and Node? The manual three-liner still works:

```powershell
git clone https://github.com/maxopich/claude-code-wrapper.git
cd claude-code-wrapper
npm run bootstrap
```

`npm run bootstrap` exists because the repo's `.npmrc` sets
`ignore-scripts=true` (a supply-chain guard — no bus tool call is ever gated on
a human, so auto-approve is bypass in effect and a malicious transitive
`postinstall` would be direct RCE), which means a plain `npm install`
deliberately does **not** build
`better-sqlite3`. The bootstrap script — pure Node, no shell, runnable on a
fresh clone — does the three required steps in order: `npm install`, then the
one re-enabled native build via `prebuild-install` (a prebuilt binary on
macOS/Linux/Windows x64, no compiler toolchain needed), then git hooks. The
older `npm install` && `npm run setup` two-step still works.

The repo-root `.env` is loaded automatically by both server (`--env-file-if-exists`) and web (Vite `envDir`). If you don't create one, the defaults from `.env.example` apply: `CEBAB_WORKSPACE_ROOT=~/agents`, `CEBAB_PORT=4319`, mock mode off. (Cebab's own knobs carry the `CEBAB_` prefix; the older bare names — `WORKSPACE_ROOT`, `PORT`, `MOCK`, `MOCK_SCENARIO`, `MOCK_INTERVAL_MS`, `MAX_TURNS` — still work but are deprecated and warn once at startup.)

Requires `claude` installed and logged in (verify with `claude auth status`).

## Run

One command — starts the server (`:4319`) and the web UI (`:5173`) together:

```sh
npm run dev
```

Then open http://127.0.0.1:5173. **Ctrl+C stops both.** Output is interleaved
and line-tagged `[server]` / `[web]`.

If `:5173` is already taken — another Vite project, most likely — the launch
**fails instead of moving to the next port**. That is deliberate: the server
trusts the web origin only because `npm run dev` is the thing that started it,
so silently landing on `:5174` would leave `:5173` trusted and owned by
somebody else. Free the port, or serve on another one and declare it via
`CEBAB_ALLOWED_ORIGINS`.

To run or debug one side on its own, the two-terminal form still works —
`npm run dev:server` and `npm run dev:web` in separate terminals. That path
makes no declaration (nothing there started Vite), so set
`CEBAB_ALLOWED_ORIGINS=http://127.0.0.1:5173,http://localhost:5173` in your
`.env` first, or the app will 403 its own token fetch. See `.env.example`.

## Mock mode

Replays `fixtures/*.jsonl` instead of spawning real `claude` — UI iteration with
zero quota burn:

```sh
CEBAB_MOCK=1 npm run dev:server
```

The inline `CEBAB_MOCK=1 …` form is POSIX-shell syntax (macOS/Linux, Git Bash).
In **PowerShell** that won't set the variable — put `CEBAB_MOCK=1` in your `.env`
instead (it's read by the server on every start) and just run
`npm run dev:server`. (The bare `MOCK=1` still works but is deprecated.)

`CEBAB_MOCK=1` in `.env` also drives the one-line `npm run dev`: its server child
reads the repo-root `.env` exactly like `npm run dev:server`, so the whole
stack runs mock on every OS with no shell-specific syntax.

`fixtures/hello.jsonl` is a real captured `claude -p` run. Capture more with:

```sh
claude -p "<prompt>" --output-format stream-json --verbose --include-partial-messages \
  > fixtures/<name>.jsonl
```

## Smoke tests (without a browser)

```sh
# DB migration
npm run smoke

# WS protocol against mock server (start `CEBAB_MOCK=1 npm run dev:server` first)
npm --workspace server exec tsx src/ws_smoke.ts

# Live integration: spawns real claude, exercises permission + resume flows
# (start `CEBAB_MOCK=0 npm run dev:server` first)
PROJECT=Cebab npm --workspace server exec tsx src/live_smoke.ts
```

## Setting the workspace folder

On first run the chat pane shows a **Choose a folder** prompt. Click it (or the
workspace button at the bottom of the sidebar) and enter an absolute or
`~`-prefixed path. The setting is persisted in `~/.cebab/cebab.sqlite` and
survives restarts. `CEBAB_WORKSPACE_ROOT` from the env (or the deprecated bare
`WORKSPACE_ROOT`) stays as a fallback for fresh installs and scripted launches.

## Switching projects

The sidebar lists every subdirectory under the active workspace folder. Each
project's `cwd` is set to its directory when the agent spawns. Whether the
project's own configuration is _loaded_ from that directory depends on the
Trust toggle below — it is not automatic.

The "asks" / "trusted" toggle per project controls **two** things, and the
second one is the security-relevant half:

- **`permissionMode`** — `"default"` (every restricted tool prompts) or
  `"acceptEdits"` (file edits + common filesystem commands auto-approve).
- **`settingSources`** — `['user']` when untrusted, and all three scopes when
  trusted. Only a trusted project loads its own `CLAUDE.md`, `.claude/skills/`,
  `.claude/settings*.json` (hooks, env injectors, MCP servers) and project-root
  `.mcp.json`. Flipping a project to trusted authorises all of that to run.

What Trust does **not** scope: MCP servers declared in `~/.claude.json`'s
top-level `mcpServers` (`claude mcp add --scope user`) load under `['user']`
too. Cebab gates those on first use instead. See
[`server/src/repo/project_authority.ts`](server/src/repo/project_authority.ts),
which reads exactly what the spawn will load and records what was measured.

For a single-session override there's also an inline pill above the chat. It
flips `permissionMode` only — `settingSources` is fixed when the run starts.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contributor flow — pre-PR checks
and the security-critical paths to be aware of.

## Layout

- `server/` — Node + Express + ws + better-sqlite3, owns the SDK runner and persistence
- `web/` — Vite + React, talks to the server over a single WS connection
- `shared/` — protocol types imported by both sides
- `fixtures/` — captured stream-json transcripts for mock mode

## Local data

- SQLite: `~/.cebab/cebab.sqlite`
- Per-session JSONL transcripts (debug + mock fixtures): `~/.cebab/logs/<session-id>.jsonl`
- Multi-agent session artifacts (per-hop prompts/replies, transcripts, iteration
  files): `~/.cebab/sessions/<session-id>/`. These lived in your workspace as
  `.cebab-session-<id>/` until they were moved here; folders created before that
  stay where they were written, because each session records its own absolute
  path. Cebab drops a `.gitignore` in `~/.cebab` so none of this shows up in
  `git status` if you point `CEBAB_DATA_DIR` inside a checkout.
- Original Claude session transcripts (used by `--resume`): `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
