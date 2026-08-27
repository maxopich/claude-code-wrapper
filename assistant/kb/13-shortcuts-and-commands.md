# Keyboard shortcuts and slash commands

Cebab has a small set of cross-cutting keyboard shortcuts and a handful of
Cebab-local slash commands you can type into the composer. This page lists all
of them. The in-app cheatsheet shows the same shortcuts — open it any time with
`?` (or `Cmd/Ctrl` + `/`).

## Opening the cheatsheet

- Press `?` when no text input is focused to open the keyboard cheatsheet.
- Press `Cmd/Ctrl` + `/` to toggle the cheatsheet — this one works even from
  inside the composer, so you can summon it without leaving what you were typing.

On macOS the modifier is Command; on Windows and Linux it is Ctrl. The
cheatsheet groups shortcuts into the same sections used below.

## Session shortcuts

| Keys                       | Action                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `Esc`                      | Stop the running turn (from inside the composer).                                                   |
| `Cmd/Ctrl` + `.`           | Stop the running turn — works globally, even when focus is outside the composer.                    |
| `Cmd/Ctrl` + `Shift` + `L` | Open the raw-event Logs inspector for the active session (see `10-logs-artifacts-and-search.md`).   |
| `Cmd/Ctrl` + `P`           | Search across all sessions by content (cross-session search). Overrides the browser's Print dialog. |

## Composer shortcuts

| Keys                 | Action                                                                             |
| -------------------- | ---------------------------------------------------------------------------------- |
| `Enter`              | Send the current draft.                                                            |
| `Cmd/Ctrl` + `Enter` | Send the current draft — an explicit alias for muscle memory from other chat apps. |
| `Shift` + `Enter`    | Insert a newline without sending.                                                  |
| `/`                  | Open the slash-command palette (only at the start of an empty composer).           |
| `Cmd/Ctrl` + `K`     | Open the slash-command palette from any caret position.                            |

Stopping a turn, sending, and the slash palette are covered in more depth in
`03-chat-and-composer.md`.

## Slash commands

Type a slash command into the composer and send it. Cebab ships five
**Cebab-local** commands that also appear as quick-row buttons above the
composer and in the slash-command palette:

| Command    | What it does                              |
| ---------- | ----------------------------------------- |
| `/context` | Show the context-window usage breakdown.  |
| `/compact` | Compact the conversation to free context. |
| `/skills`  | List the available skills.                |
| `/mcp`     | Show MCP server connection status.        |
| `/cost`    | Show session cost and usage.              |

Beyond these five, the palette also lists any commands the current session
discovered from the underlying `claude` CLI, shown under a separate
"Discovered from session" group. Those vary by project and are not part of
Cebab's own list.

## Binding and command reference

This section mirrors the machine-readable registries in the Cebab source so the
build fails if a shortcut or command is added without documenting it here. Each
identifier below corresponds to one entry in `web/src/shortcutRegistry.ts` or
`web/src/slashCommands.ts`.

Keyboard binding ids:

- `help.openCheatsheet.questionMark`
- `help.openCheatsheet.slash`
- `session.stop.escape`
- `session.stop.cmdPeriod`
- `session.logs.cmdShiftL`
- `session.search.cmdP`
- `composer.send.cmdEnter`
- `composer.palette.cmdK`
- `composer.palette.slash`
- `composer.newline.shiftEnter`

Slash commands: `/context`, `/compact`, `/skills`, `/mcp`, `/cost`.
