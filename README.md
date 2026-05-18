# CEBAB

Personal browser-based wrapper around the local `claude` CLI. Spawns the
Claude Code Agent SDK (which itself wraps `claude`), routes its typed message
stream to a React UI over a WebSocket, and persists every event to SQLite.

Single-user, bound to `127.0.0.1`, uses your existing Claude subscription via
`~/.claude/.credentials.json` (no API key, no remote access).

Runs natively on **macOS, Linux, and Windows** (no WSL). The multi-agent bus
is a pure in-process SDK runtime — no tmux, no shell scripts — so the single
codebase behaves the same on all three. CI exercises both `ubuntu-latest` and
`windows-latest`.

## Setup

One command, identical on macOS, Linux and Windows:

```sh
npm run bootstrap        # deps + native better-sqlite3 build + git hooks
cp .env.example .env     # optional — overrides defaults (workspace root, port, mock)
```

**Windows (PowerShell)** — download and install in one go (works in both
Windows PowerShell 5.1 and PowerShell 7+; needs Git and Node.js already
installed, plus the `claude` CLI prerequisite noted below):

```powershell
git clone https://github.com/maxopich/claude-code-wrapper.git
cd claude-code-wrapper
npm run bootstrap
```

`npm run bootstrap` exists because the repo's `.npmrc` sets
`ignore-scripts=true` (a supply-chain guard — bus agents run under
`bypassPermissions`, so a malicious transitive `postinstall` would be direct
RCE), which means a plain `npm install` deliberately does **not** build
`better-sqlite3`. The bootstrap script — pure Node, no shell, runnable on a
fresh clone — does the three required steps in order: `npm install`, then the
one re-enabled native build via `prebuild-install` (a prebuilt binary on
macOS/Linux/Windows x64, no compiler toolchain needed), then git hooks. The
older `npm install` && `npm run setup` two-step still works.

The repo-root `.env` is loaded automatically by both server (`--env-file-if-exists`) and web (Vite `envDir`). If you don't create one, the defaults from `.env.example` apply: `WORKSPACE_ROOT=~/agents`, `PORT=4319`, mock mode off.

Requires `claude` installed and logged in (verify with `claude auth status`).

## Run

One command — starts the server (`:4319`) and the web UI (`:5173`) together:

```sh
npm run dev
```

Then open http://127.0.0.1:5173. **Ctrl+C stops both.** Output is interleaved
and line-tagged `[server]` / `[web]`.

To run or debug one side on its own, the two-terminal form still works —
`npm run dev:server` and `npm run dev:web` in separate terminals.

## Mock mode

Replays `fixtures/*.jsonl` instead of spawning real `claude` — UI iteration with
zero quota burn:

```sh
MOCK=1 npm run dev:server
```

The inline `MOCK=1 …` form is POSIX-shell syntax (macOS/Linux, Git Bash). In
**PowerShell** that won't set the variable — put `MOCK=1` in your `.env`
instead (it's read by the server on every start) and just run
`npm run dev:server`.

`MOCK=1` in `.env` also drives the one-line `npm run dev`: its server child
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

# WS protocol against mock server (start `MOCK=1 npm run dev:server` first)
npm --workspace server exec tsx src/ws_smoke.ts

# Live integration: spawns real claude, exercises permission + resume flows
# (start `MOCK=0 npm run dev:server` first)
PROJECT=Cebab npm --workspace server exec tsx src/live_smoke.ts
```

## Setting the workspace folder

On first run the chat pane shows a **Choose a folder** prompt. Click it (or the
workspace button at the bottom of the sidebar) and enter an absolute or
`~`-prefixed path. The setting is persisted in `~/.cebab/cebab.sqlite` and
survives restarts. `WORKSPACE_ROOT` from the env stays as a fallback for fresh
installs and scripted launches.

## Switching projects

The sidebar lists every subdirectory under the active workspace folder. Each
project's `cwd` is set to its directory when the agent spawns, so the
project's `CLAUDE.md`, `.claude/skills/`, and `.claude/mcp.json` all auto-load.

The "asks" / "trusted" toggle per project flips between `permissionMode:
"default"` (every restricted tool prompts) and `"acceptEdits"` (file edits +
common filesystem commands auto-approve). For a single-session override there's
also an inline pill above the chat that flips the same modes mid-flight.

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
- Original Claude session transcripts (used by `--resume`): `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
