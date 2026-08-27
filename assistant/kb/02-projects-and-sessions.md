# Projects and sessions

Cebab organizes your work into **projects** (the things you run Claude against) and **sessions** (the individual conversations you have inside a project). This page explains where projects come from, the difference between an ordinary project and a managed agent, and how to manage the sessions that pile up under each one.

## How projects appear in the sidebar

There is **no "add project" button**. Cebab discovers projects by scanning your **workspace folder**: the sidebar lists every subdirectory found directly under that folder, one row per directory. To add a project, you put a folder under your workspace folder; to remove one, you take it away. That is the whole model.

So the two-step way to get a new project into Cebab is:

1. Make sure your workspace folder is set (there's a **Choose a folder** prompt on first run, and a workspace button at the bottom of the sidebar). See `12-settings-storage-and-data.md` for where that setting lives and how it persists.
2. Drop a project folder under that workspace folder. It appears on the next sidebar refresh.

When you run a project, Cebab sets the agent's working directory (`cwd`) to that project's own directory, so the agent operates inside the files you'd expect.

If a folder you created isn't showing up in the sidebar, see `14-troubleshooting.md` — the usual causes are the workspace folder pointing somewhere else, or the folder not being a direct child of it.

### The "Agent project" marker

Some rows show a small Claude mark with the tooltip **"Agent project (CLAUDE.md present)"**. That badge simply means the project directory contains a `CLAUDE.md` file. It's an at-a-glance signal that the folder is set up as a Claude agent project with its own instructions — nothing more. Whether that `CLAUDE.md` actually gets loaded when you run the project depends on the project's Trust setting, which is covered in `04-permissions-trust-and-authority.md`.

### Trust, at a glance

Each project row has an **"asks" / "trusted"** toggle, with tooltips **"Trusted (auto-approve tools)"** versus **"Asks before tool use"**, plus an **"Inspect resolved authority…"** action to preview what a session would load before you start one. This controls whether tools auto-approve and whether the project's own configuration is loaded. It's important enough to have its own page: read `04-permissions-trust-and-authority.md` before flipping anything to trusted.

## Two kinds of project: ordinary vs. managed agent

Everything above describes an **ordinary project** — a folder in your workspace that Cebab reads and runs in place. There is a second kind, the **managed agent**, and the difference matters for safety and for what you're allowed to edit.

A **managed agent** is an independent copy of a project that Cebab makes and stores inside its own data directory (under `agents/<slug>/`). You create one with the per-project action whose tooltip reads: **"Make an independent copy of `<name>` inside Cebab and run it from there. The original is not touched."**

Why you'd want this:

- **Your original workspace is never touched.** The managed agent runs entirely out of Cebab's own copy, so anything the agent does — edits, deletes, new files — happens to the copy, not to your real project.
- **You can edit its configuration from inside the app.** Only managed agents expose the settings-editing action, tooltip **"Edit `<name>`'s settings.json, .mcp.json and CLAUDE.md. Cebab owns this copy, so nothing in your own workspace is touched."** Ordinary projects offer no such affordance — Cebab only writes inside copies it owns. This lets you tweak a managed agent's `.claude/settings.json`, its `.mcp.json`, and its `CLAUDE.md` without ever touching the original.
- **It can't be committed back by accident.** When Cebab makes the copy, it leaves out the project's `.git` folder and any git remotes. That means the copy isn't a git repository and has nowhere to push, so an agent running inside it can't commit or push into your real repository.
- **Credentials come along, but the copy is locked down.** Any credentials in the source are copied so the agent still works, but the copied tree is created with tight owner-only permissions.

Making a **second copy** of the same project doesn't overwrite the first — it creates a _new_ managed agent with a distinct name (for example `slug-2`). You can keep several independent copies of one project side by side, each with its own configuration and its own sessions.

A managed agent shows up in the sidebar as a normal project row, so Trust, the authority inspector, sessions, and everything else work on it exactly as they do on an ordinary project. The difference is only in where it lives and what you're allowed to edit.

## Sessions: conversations inside a project

A **session** is a single conversation with a project. When you select a project and send your first message, Cebab starts a session; each follow-up message you send **resumes that same session**, so the agent keeps the context of everything said so far. Starting a fresh conversation gives you a new, separate session — the two don't share history.

A project can accumulate many sessions over time. They're listed so you can return to an earlier conversation, review what happened, or clean up.

## Managing your sessions

Cebab gives you a handful of actions on sessions, both individually and on a selection of several at once. From the tooltips in the app:

- **Rename** a session ("Rename session") — give a conversation a memorable name instead of a default one.
- **Download the log** as a `.jsonl` file — either for one session ("Download session log (.jsonl)") or for each session in a selection ("Download a .jsonl log for each selected session"). This is a transcript of the conversation you can keep or inspect outside the app.
- **Hide** selected sessions ("Hide selected sessions from the list (recoverable)") — this just removes them from the list to reduce clutter. It's recoverable, so nothing is destroyed.
- **Soft-delete** selected sessions ("Soft-delete selected sessions (recoverable for 7 days)") — a stronger removal that's still reversible for **7 days**, after which it becomes permanent.

The distinction is worth remembering: **hiding** is purely cosmetic and always recoverable, while **soft-delete** is a real removal with a 7-day grace period before it's gone for good.

For where session transcripts and other data actually live on disk, and how downloads relate to Cebab's stored logs, see `12-settings-storage-and-data.md`.

## Quick reference

- Projects come from the **workspace scan** — drop a folder under your workspace folder; there's no add button.
- The **Claude mark** on a row means the folder has a `CLAUDE.md`.
- **Managed agents** are Cebab-owned copies you can run and reconfigure safely; the original is never touched, and a second copy makes a new one rather than overwriting.
- A **session** is one conversation; follow-up messages resume it.
- Sessions can be **renamed, downloaded (.jsonl), hidden (recoverable), or soft-deleted (recoverable for 7 days)**.
- Project not showing up? See `14-troubleshooting.md`. Trust and permissions? See `04-permissions-trust-and-authority.md`. Storage details? See `12-settings-storage-and-data.md`.
