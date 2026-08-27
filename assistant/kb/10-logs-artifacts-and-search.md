# Logs, artifacts, and search

Cebab keeps a full record of everything an agent does in a session: every tool call, every message, every file touched. This page covers the three surfaces you use to inspect that record — the Logs inspector, the Artifacts and Working files lists, and cross-session search — plus where the data lives on disk.

## The Logs inspector

Open it with the **Logs** button in the session's top bar, or with the keyboard shortcut (see below). It shows the raw session log: the underlying tool inputs and outputs, one row per event. The button's tooltip warns you what you're opening — it contains raw tool inputs and outputs, with sensitive fields redacted by default.

If the run recorded any dangerous mutations, the button shows a `⚠ N` chip and the tooltip prompts you to review before granting further permissions.

### Reading the rows

Each row is one event, showing its timestamp (to the millisecond), its **kind**, the agent that produced it, and a one-line summary. Kinds are:

- `tool` — a tool call and its result
- `llm` — a model message
- `error` — a failure
- `bus` and `artifact` — multi-agent-run events (these two only appear for multi-agent runs)

Click a row (or focus it and press Enter/Space) to expand an inline detail drawer.

Two badges can appear on a row:

- **⚠ DANGEROUS** — "This row writes to a path the artifact classifier flagged as dangerous (e.g. .env, secrets)." See `08-safety-controls.md` for how the classifier and dangerous-path handling work.
- **redacted** — sensitive fields in this row were masked. Hovering it lists how many and which: e.g. "2 field(s) masked: ...".

### The row detail drawer

Expanding a row shows its full metadata (id, timestamp, agent, kind, and — when present — status and duration), the pretty-printed JSON payload, and, for tool rows, dedicated **Tool input** and **Tool output** sections. Very large captured values are truncated (the first 8 KB is shown, with a note of the full byte size).

Two copy actions sit in the drawer header:

- **Copy line** — "Copy this row as a single tab-separated line" (timestamp, kind, agent, status, summary), handy for pasting into a spreadsheet or a note.
- **Copy raw** — "Copy the pretty-printed JSON payload", the full JSON for that event.

If the row masked any fields, the drawer names them and tells you to use the toolbar's **Reveal sensitive** button to un-mask.

**Jump to a hop.** When a log row corresponds to an event in the conversation scrollback, the drawer shows a `↗ event #N` link — "Jump to this hop in the scrollback" — so you can move from the raw log back to the readable transcript.

### Filtering, refreshing, and exporting

The toolbar across the top of the inspector gives you:

- **Search** — a text box that matches across the summary, agent, and raw payload of each row.
- **Kinds** — a dropdown to show only the kinds you care about (`tool`, `llm`, `error`, and for multi-agent runs `bus` and `artifact`).
- **Agents** — a dropdown to filter by agent (shown only for multi-agent runs; single-agent runs have just one agent, so it's hidden).
- **Clear** — appears when any filter is active; "Clear all filters" resets them at once.
- **Refresh** — "Re-fetch the log from offset 0", reloading the log from the beginning to pick up new rows.
- **Download .ndjson** — "Download the filtered view as NDJSON (one JSON object per line)". This exports exactly what your current filters show, one JSON object per line, ready to grep or feed to another tool.
- **Reveal sensitive** — "Un-mask sensitive fields. You will be asked to confirm." This un-masks the redacted fields; you confirm first, and the log re-fetches. Press it again to **Re-mask** (also a re-fetch).

If nothing matches, the list reads "No log entries match the current filters." Long logs load in chunks — a **Load more** button appears at the bottom when there's more to fetch.

### Opening logs with a shortcut

You can open the Logs inspector for the active run with **Cmd/Ctrl+Shift+L** instead of clicking the button. See `13-shortcuts-and-commands.md` for the full shortcut list.

## Artifacts and working files

For multi-agent runs, files the agents write are split into two lists depending on whether they look like deliverables.

### The Artifacts view

The **Artifacts** surface lists every promoted file an agent produced — the ones the classifier recognized as deliverables (plans and similar). Files are grouped by path: repeated edits to the same file collapse into one row with an edit count, and each row shows the file name, type, authoring agent, and when it was last updated. If nothing has been produced yet it reads "No artifacts yet."

Select a file to open a preview pane. Its header carries two actions:

- **Copy path** — "Copy the file path to the clipboard". The button briefly reads "Copied" so you know it worked.
- **↗ open in logs** — "Open this artifact's production event in the Logs surface", jumping you straight to the log row that created the file.

The file body is never loaded automatically. Expand **▸ View latest content** to fetch the current on-disk content on demand. That content is server-redacted; if anything was masked you'll see a **redacted** marker whose tooltip reads "Sensitive content was masked before display", and files larger than 1 MB show only the first 1 MB. (A "Diff against previous edit" button is present but not yet enabled.)

### Working files

Files an agent touched that _weren't_ promoted as deliverables — source edits, configs, scratch — show up separately under a **Working files** disclosure in the Session info panel. It reads as a count (e.g. "3 files"); expand it to see each file, the agent that touched it, and an edit count. The split is privacy-by-default: things like an `.env` write don't bubble up as a deliverable.

## Cross-session search

Press **Cmd/Ctrl+P** to open cross-session search — a plain content search across your sessions. Type at least a few characters and it matches against the text stored in your session records, returning snippets you can click (or arrow to and press Enter) to jump to the hit.

Scope chips let you choose **This project** or **All projects**, with an **Include archived** checkbox that composes with either. When no project is open, the "This project" chip is disabled and its tooltip reads "No project is open" — search falls back to all projects.

Snippets are redacted by default. A result whose source contained masked content carries a **redacted** badge ("This entry contained redacted content"), so you know some of that entry is hidden. You can opt into an unredacted search via **Search unredacted content…**, but it's a deliberate speed bump: you must type `I understand` to arm it, and the search is recorded to the safety audit. If the audit can't be written, the search quietly falls back to redacted results and tells you so.

If there are more matches than fit, you'll see a note to narrow your scope or refine the query.

## Where logs live, and redacted vs raw

Every SDK message in a session is persisted twice: to a row in a SQLite `events` table, and as a line in a per-session JSONL file at `~/.cebab/logs/<session-id>.jsonl`. The JSONL file is the complete on-disk trace.

Session-log exports come in two forms:

- **redacted** (the default) — a share-safe export. It carries only the durable message classes and masks sensitive fields, so a secret can't leak through a partial fragment.
- **raw** — the only complete trace, and gated behind an explicit acknowledgment because it's unredacted.

For how this data is stored, where the data directory lives, and how to manage or delete it, see `12-settings-storage-and-data.md`. For the classifier, dangerous-path handling, and the redaction rules themselves, see `08-safety-controls.md`.
