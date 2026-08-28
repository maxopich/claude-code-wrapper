# Troubleshooting

Symptom, then cause, then fix. Each entry is a common problem you hit while driving Cebab in the browser. If a fix belongs to another page, that page is named by its bare filename.

## My project isn't in the sidebar

The sidebar lists **every subdirectory directly under your active workspace folder** — nothing more. If a project is missing, one of two things is true:

- **The workspace root is wrong.** You are pointed at a different folder than the one that contains your project. Click the **workspace button at the bottom of the sidebar** (on first run it appears as the **Choose a folder** prompt in the chat pane) and confirm the path. It accepts an absolute path or a `~`-prefixed one, and it is remembered across restarts.
- **Your project isn't a _direct_ subdirectory.** The scan looks one level down only. A project nested two folders deep, or the workspace root itself, won't appear. Move it directly under the workspace folder, or point the workspace at the parent that contains it.

There is no "add project" button — the workspace scan is the only way an ordinary project shows up. **Managed agents are a separate kind of project** and don't come from this scan; see 02-projects-and-sessions.md.

## `npm run dev` fails on port 5173

When `:5173` is already taken — usually another Vite project — the launch **fails on purpose instead of quietly moving to the next port**. This is a security choice: the server trusts the web origin only because `npm run dev` is what started it, so silently landing on `:5174` would leave `:5173` trusted and owned by whatever else grabbed it.

Fix: **free port 5173** (stop the other project), then re-run `npm run dev`. If you genuinely need another port, serve there and declare it explicitly with `CEBAB_ALLOWED_ORIGINS` — see the next entry.

## The app 403s or can't fetch its token

You are almost certainly running the **two-terminal form** — `npm run dev:server` in one terminal and `npm run dev:web` in another — instead of the single `npm run dev`.

The one-command `npm run dev` declares the web origin for you. The two-terminal path makes no such declaration (nothing there started Vite), so the server doesn't trust the browser and **403s the app's own token fetch**. Fix: set the allowed origins in your `.env` before starting, then restart both sides:

```
CEBAB_ALLOWED_ORIGINS=http://127.0.0.1:5173,http://localhost:5173
```

If you don't need to debug the two sides separately, just use `npm run dev` and the problem disappears.

## My MCP server has no tools, or isn't loading

Three different causes look almost identical from inside a session. Work through them in order.

1. **The project is Untrusted, so its `.mcp.json` never loads.** A project's own project-root `.mcp.json` (and its `CLAUDE.md`, `.claude/` hooks and skills) is loaded **only when the project is Trusted**. While it's untrusted, a project-scoped server isn't just inactive — it's invisible. Fix: flip the project's Trust toggle to **trusted**. See 04-permissions-trust-and-authority.md for what else Trust changes.

2. **It loaded but failed to connect.** A server can be declared and loaded and still **fail to come up** — a state that, from inside a chat, looks exactly like a server that was never declared. Cebab surfaces this: the session banner names any server that loaded and did **not** report `connected`, and the **Authority panel** shows each server's status from a real probe. Check there. The status is printed verbatim, not diagnosed — if it names a connection or auth problem, that's the server's own message to act on.

3. **You checked `claude mcp list` in a shell and it looked fine.** That command reports your **config files**, not the live session — it's a separate CLI process and does not tell you whether the running agent actually loaded or connected the server. Trust the Authority panel and the session banner instead; they read what the real spawn loaded.

Note: servers declared in your home `~/.claude.json` (added with `claude mcp add --scope user`) load regardless of Trust and are gated on first use, so those are governed differently — again see 04-permissions-trust-and-authority.md.

## Tools always prompt, or never prompt

Two controls decide whether a tool asks for approval, and they stack:

- The **project Trust toggle** sets the _starting_ posture — trusted projects begin auto-approving edits and common filesystem commands; untrusted projects prompt on every restricted tool.
- The **per-session pill** above the chat flips the current session between "ask" and "auto-approve" mid-run, without changing what the project loaded.

If tools prompt when you don't want them to, or auto-run when you'd rather review, adjust these. Full behavior — including what each does and doesn't scope — is in 04-permissions-trust-and-authority.md.

## A session won't resume

Sessions are keyed by the project's **absolute working directory**. Prior session transcripts live in a location derived from that exact path. If you **moved or renamed the project's directory**, earlier sessions can no longer be found and become unresumable.

Fix: move the directory back to its original path to recover the old sessions, or start a fresh session at the new location. There is intentionally no "rename project path" UI, because moving a path silently breaks resume.

## Credentials or auth expired

Cebab uses your existing Claude subscription credentials, and those expire. When they do, turns stop working until they're refreshed. This has its own recovery flow — see 11-recovery-and-errors.md. You can confirm the underlying login from a shell with `claude auth status`.

## Nothing streams, or I'm not sure if it's mock or real

Cebab has a **mock mode** that replays recorded fixtures instead of spawning the real `claude` CLI — useful for UI work with zero quota use, but it means you are **not talking to a real model**. If responses look canned or identical every time, check whether mock mode is on.

- Mock mode is controlled by the `MOCK` setting. `MOCK=1` before `npm run dev:server` turns it on for POSIX shells (macOS, Linux, Git Bash).
- **On PowerShell that inline form does nothing** — the variable isn't set. Put `MOCK=1` in your `.env` instead (the server reads it on every start). To run _real_ claude, make sure `MOCK` is not set to `1` anywhere, including `.env`.

If you _want_ real responses and nothing streams at all, confirm `claude` is **installed and logged in** — Cebab requires it. Check with `claude auth status`; if it reports expired or logged-out credentials, follow 11-recovery-and-errors.md.
