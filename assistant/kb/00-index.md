# Knowledge-base router

This file is a **router, not a summary**. It does not explain any feature; it
only tells you which file explains it. Find the row whose keywords best match
the operator's question, then `Read` that file by its **bare filename** and
answer from there.

**Read contract.** Your working directory is this knowledge-base directory, so
every file here is reachable by bare filename — `Read 08-safety-controls.md`,
never `./kb/08-safety-controls.md`, never an absolute path. A `Glob` (e.g.
`Glob 0*.md`) or a `Grep` with no path argument already searches this directory;
do not add a `kb/` prefix or search for the directory first. If two rows look
plausible, `Grep` the keyword across the files and open the closest hit.

Match against the keyword lists below — they are written to be searched, not
read as prose. Each row is `filename — questions, nouns, synonyms it owns`.

---

**01-getting-started.md** — first run, install, setup, `npm run setup`, rebuild
better-sqlite3, start the server, dev:server, port 4319, dev:web, open in
browser, what is Cebab, what does this app do, quick tour, mock mode intro, how
do I begin, nothing shows up on first launch, prerequisites, Claude
subscription, credentials, no API key.

**02-projects-and-sessions.md** — projects, sidebar, workspace folder scan, how
projects appear, why is my project missing / not showing up, add a project,
there is no add-project button, managed agents, snapshot a project, project
name, project path moved, sessions, start a conversation, new chat, resume a
session, session history, one subprocess per message, `--resume`, switch
project, last used, touch.

**03-chat-and-composer.md** — chat area, send a message, composer, typing,
streamed output, assistant text, tool-call cards, tool use, interrupt, stop a
turn, empty chat / "select a project", new-chat preview, permission cards
inline, per-session permission toggle (ask vs accept), scroll, message bubbles.

**04-permissions-trust-and-authority.md** — Trust toggle, trusted vs untrusted,
permission mode, default vs acceptEdits, acceptEdits, bypassPermissions,
permission request, approve / deny a tool, canUseTool, settingSources, does the
project's `.claude/settings.json` load, `.mcp.json` not loading, MCP servers,
why is a tool auto-allowed, authority panel, what an agent can do, starting
permission mode, per-project model, model picker, TOFU, MCP trust prompt.

**05-multi-agent-concepts.md** — multi-agent, the bus, what is the bus, chain
mode, orchestrator mode, roster, workers, participants, consultant mode,
execute mode, hops, hop budget, maxTurns per hop, `bus_send`, how agents talk to
each other, why is there no tmux, in-process SDK, orchestrator vs worker,
delegate-only, AskUserQuestion to the operator.

**06-multi-agent-running.md** — start a multi-agent session, install bus
integration, run a chain, run an orchestrator, add a participant / worker mid
run, mute a worker, pause, kick, stopped / stranded run, "nobody working",
activity bar, quiescence note, single active session, server restart resume
(R-B), templates browser to launch.

**07-templates.md** — templates, template browser, template preview, saved
multi-agent setups, roster template, per-participant facts, preview modal,
CLAUDE.md head shown in preview, launch from a template, edit a template.

**08-safety-controls.md** — safety, security, pause-on-dangerous, dangerous tool
gate, consultant guardrail, audit log, hash chain, forensic snapshot, install
trust gate, TOFU, operator mute / pause / kick, Origin gate, browser origin,
per-launch auth token, 127.0.0.1 bound, subscription-only env, is this safe,
what stops an agent editing my files.

**09-notifications-and-runs.md** — notifications, dock / OS notification, sound,
runs badge, active runs, RunsBadge, run dropdown, jump to session, what's
running now, rate-limit banner, rate limited, resets at, background turn done.

**10-logs-artifacts-and-search.md** — logs, session log, JSONL, transcript,
export a session, session-log endpoint, redacted vs raw export, download a
transcript, artifacts, search sessions, search across history, find a past
conversation, event history, replay.

**11-recovery-and-errors.md** — recovery, recovery log, error, process crashed,
turn failed, error_during_execution, max turns reached, connection lost,
reconnect, reopen a session, retry after rate limit, what went wrong, wrapper
error, stale server / orphaned dev:server on port 4319.

**12-settings-storage-and-data.md** — settings, settings modal, workspace root
folder, change workspace, max turns setting, where is my data, SQLite database,
`~/.cebab`, cebab.sqlite, logs directory, data dir, mock mode toggle, theme /
appearance, delete data, reset, storage location, back up.

**13-shortcuts-and-commands.md** — keyboard shortcuts, hotkeys, key bindings,
shortcut for X, slash commands, `/` commands, command palette, what can I type,
send shortcut, navigate projects with keyboard, focus composer.

**14-troubleshooting.md** — troubleshooting, it's broken, X isn't working,
project won't appear, tool never runs, MCP server won't connect / loaded but not
connected, permission card stuck, can't resume, blank screen, server won't
start, port in use, mock mode not replaying, common problems, diagnostics, what
to check first.

---

If no row matches, say you don't have anything on that topic in the Cebab
knowledge base rather than guessing.
