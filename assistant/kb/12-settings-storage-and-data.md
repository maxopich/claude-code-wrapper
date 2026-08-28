# Settings, storage, and data

This page covers the Settings modal, the preferences Cebab remembers, and where
it keeps its data on disk. For the per-project Trust and model choices that live
next to each project rather than in Settings, see
`04-permissions-trust-and-authority.md` and `02-projects-and-sessions.md`.

## Opening Settings

Open the Settings modal from the button at the bottom of the sidebar. It groups
a handful of account-wide preferences; each is saved to Cebab's SQLite database
and survives a restart. Most fields are part of an explicit **Save** — the one
exception is Appearance, which applies instantly (see below).

## Workspace folder

The workspace folder is the directory Cebab scans for projects. Every direct
subdirectory of it becomes a project in the sidebar. Set it in Settings (or from
the first-run **Choose a folder** prompt), using an absolute path or a
`~`-prefixed one. The value is stored in `~/.cebab/cebab.sqlite` and takes
precedence over the `WORKSPACE_ROOT` environment variable, which stays as a
fallback for fresh installs and scripted launches.

If no workspace is set, Settings tells you where runs and logs land in the
meantime, and warns if the path you typed does not resolve. A project that isn't
showing up is almost always a workspace-folder problem — see
`14-troubleshooting.md`.

## Default hop budget

The default hop budget is a hard cap on the number of **hops** (messages routed
between agents) in a multi-agent session. Cebab stops a run when the budget is
reached. It must be a positive integer. A saved template can override this global
value for runs started from that template (see `07-templates.md`). The hop budget
counts messages _between_ agents; it does not count the model turns _inside_ one
hop — that is what "default max turns" bounds.

## Default max turns

The default max turns is the cap on **agent turns** — the model's own turns
inside a single hop or a single-agent send. When it is reached, the underlying
SDK ends the turn with an `error_max_turns` result. The resolver precedence is:
a per-turn override from the composer (single-agent only; see the max-turns input
described in `03-chat-and-composer.md`) beats this saved default, which beats the
`MAX_TURNS` environment variable, which beats the built-in fallback. A multi-agent
session has no per-turn override — it re-reads this default at each session start
or resume. Changes take effect on your next send, or on the next multi-agent
session start.

So the two ceilings are different and both matter: **hop budget** limits how many
times agents hand off to each other, and **max turns** limits how much work an
agent does within one of those hand-offs.

## Appearance (color themes)

The Appearance section picks a color theme — a color gamma painted over the one
fixed layout. It applies **instantly** when you click a card and is a pure client
display preference: it is persisted to your browser's `localStorage` under
`cebab.theme`, never sent to the server, and is not part of the Save payload.
Cancelling the modal restores whatever theme was active when you opened it.

There are four themes, and the default on a fresh install is **Daylight**:

- **Daylight** (`daylight`) — the default: warm light canvas, serif reading
  bodies, coral accent.
- **Aurora** (`aurora`) — airy light canvas, azure accent.
- **Slate** (`slate`) — a muted dark-cool gamma.
- **Phosphor** (`phosphor`) — a dark, high-contrast terminal-style gamma.

Each card previews the theme's page, panel, and accent colors as a small swatch.
The picker is a keyboard radio group: arrow keys move between themes and select
as they move (arrowing away and back safely undoes the change, because the theme
costs nothing to apply).

## Where Cebab stores data

Cebab keeps everything under a single data directory, `~/.cebab` by default. You
can point it elsewhere with the `CEBAB_DATA_DIR` environment variable; Cebab
drops a `.gitignore` inside it so none of this data shows up in `git status` even
if you place it inside a checkout.

- **SQLite database** — `~/.cebab/cebab.sqlite`. This holds your settings
  (workspace folder, hop budget, max turns), the projects list, per-project Trust
  and model choices, sessions, and the persisted event rows behind the Logs
  inspector.
- **Per-session transcripts** — `~/.cebab/logs/<session-id>.jsonl`. One JSONL
  file per session, used both for debugging and as the source for mock-mode
  fixtures. See `10-logs-artifacts-and-search.md`.
- **Multi-agent session artifacts** — `~/.cebab/sessions/<session-id>/`. Per-hop
  prompts and replies, transcripts, and iteration files for a multi-agent run.
  (Sessions created before these moved here stay where they were written, because
  each session records its own absolute path.)
- **Original Claude session transcripts** — `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.
  These belong to the `claude` CLI and are what `--resume` reads. They are keyed
  by the project's absolute working directory, which is why moving a project's
  folder makes its prior sessions unresumable (see `11-recovery-and-errors.md`).

## What is safe to remove

Deleting a session from the UI is a soft-delete (recoverable for 7 days), not a
disk wipe. If you want to reclaim space, the per-session JSONL logs and the
multi-agent session artifact folders are the bulky items and can be removed
without corrupting the database — but doing so removes the raw record behind the
Logs inspector and any mock fixtures you captured from them. The `cebab.sqlite`
database is the one file you should not hand-edit or delete unless you mean to
reset Cebab's entire state.
