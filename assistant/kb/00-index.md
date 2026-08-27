# Cebab knowledge base index

This is the routing table for the Cebab help knowledge base. It does **not**
explain any feature — it only tells you which file explains it. Read this to
decide what to open, then open that file for the answer.

## How to read these files

Your working directory **is** this knowledge base directory. Every page lives
here as a flat file — there are no subdirectories. Read a page by its **bare
filename** (for example `04-permissions-trust-and-authority.md`), and when you
Glob or Grep for something, do it with **no path prefix** — a bare pattern
already targets this directory. Do not guess at `./kb/`, `assistant/kb/`, or
any other prefix; there is none to add.

Each row below is `filename → the questions and nouns that page owns`. Match a
user's question against the noun lists, open the one file that fits, and answer
from it. If two rows seem to overlap, prefer the more specific one (for
example, a "how do I start a multi-agent run" question goes to the running
page, not the concepts page). If nothing here matches, say the knowledge base
does not cover it rather than guessing.

## The pages

- [Getting started](01-getting-started.md) — what Cebab is, install and
  bootstrap, prerequisites, `claude` login, first launch, `npm run dev`, ports
  4319/5173, choosing a workspace folder, mock mode, first message, where to
  begin.
- [Projects and sessions](02-projects-and-sessions.md) — the sidebar, the
  workspace scan, why a project does or doesn't appear, agent projects, managed
  agents (an independent copy inside Cebab), sessions, resuming, renaming,
  hiding, downloading, and deleting sessions.
- [Chat and the composer](03-chat-and-composer.md) — sending a message, Enter
  vs Shift+Enter, the growable composer, the slash-command palette, streamed
  assistant text, tool-call approval cards, the per-session permission pill, the
  turn counter and max-turns override, stopping a turn.
- [Permissions, Trust, and authority](04-permissions-trust-and-authority.md) —
  the Trust toggle, `default` vs `acceptEdits`, `settingSources`, what trusting
  a project loads, user-scope MCP servers and TOFU, the Authority panel, tools,
  MCP servers, allow/deny rules, env injection, hooks, skills, sub-agents.
- [Multi-agent concepts](05-multi-agent-concepts.md) — the bus, chain vs
  orchestrator mode, participants and roles, `bus_send`, unspoofable identity,
  the hop trail, the hop budget vs the per-hop turn cap, the runtime trust
  posture, consultant vs execute mode as ideas.
- [Running a multi-agent session](06-multi-agent-running.md) — installing bus
  integration, building a draft, picking participants and order, Persistent vs
  Temp lifecycle, starting, watching the scrollback, adding a worker mid-run,
  sending input to the orchestrator, ending and resuming a run.
- [Templates](07-templates.md) — what a saved multi-agent topology stores,
  applying a template, saving roles back, the template preview and diagram,
  execute vs consultant banners, the per-template hop-budget override, deleting
  a template.
- [Safety controls](08-safety-controls.md) — the headless runtime posture,
  pause-on-dangerous, execute vs consultant mode as a control, muting, pausing,
  and kicking a participant, the forensic bundle, the hash-chained audit log,
  and the honest limits (advisory, not a sandbox).
- [Notifications and runs](09-notifications-and-runs.md) — the notification
  bell and inbox, operational vs safety notifications, acknowledging and muting
  a type, the runs badge and dropdown, session banners, the rate-limit banner.
- [Logs, artifacts, and search](10-logs-artifacts-and-search.md) — the raw-event
  Logs inspector, filters, NDJSON export, copy row/JSON, dangerous-path and
  redacted-field badges, artifacts and working files, cross-session search,
  where logs live on disk, redacted vs raw exports.
- [Recovery and errors](11-recovery-and-errors.md) — a dropped WebSocket
  connection, expired credentials and the auth-refresh flow, reopening a closed
  session, the recovery log, server-restart behavior for multi-agent sessions,
  the resume-after-directory-move gotcha.
- [Settings, storage, and data](12-settings-storage-and-data.md) — the Settings
  modal, workspace root, default hop budget, default max turns, per-project
  model, appearance themes, where Cebab stores its SQLite database and logs,
  `CEBAB_DATA_DIR`, and what is safe to delete.
- [Keyboard shortcuts and slash commands](13-shortcuts-and-commands.md) — the
  cheatsheet, every global and composer-scoped keyboard shortcut, and the
  Cebab-local slash commands you can type into the composer.
- [Troubleshooting](14-troubleshooting.md) — symptom-to-fix entries for the
  common problems: a missing project, a taken port, a 403 token fetch, an MCP
  server with no tools, tools that always or never prompt, a session that won't
  resume, and expired credentials.
