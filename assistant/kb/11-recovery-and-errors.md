# Recovery and errors

This page explains how Cebab recovers from interruptions and what its error
surfaces mean: the connection-lost overlay, expired-credential re-login,
reopening a closed session, the recovery activity log, and what a server
restart does to your runs. For a symptom-then-fix checklist, see
14-troubleshooting.md. For plain error banners and run failures, see
09-notifications-and-runs.md.

## When the connection drops

Cebab runs in your browser and talks to the local Cebab server over a
WebSocket. If that link breaks, a full-pane overlay appears over the main
area. The sidebar stays usable underneath, and you can dismiss the overlay
(click Dismiss or press Esc) to get at it; the overlay also clears on its own
the moment the connection comes back.

The overlay shows one of a few messages depending on why the link failed:

- **Cebab server unreachable** — the server isn't responding. Make sure it's
  running, then click **Retry now**. Cebab also retries on its own in the
  background on a widening schedule (roughly 2s, 4s, 8s, 15s, 30s), and the
  Retry button shows a countdown to the next automatic attempt.
- **Authentication failed** — the browser session's launch token was rejected
  or expired. Open Cebab from a fresh launch URL.
- **Session revoked** — the server ended this browser session. Re-open Cebab
  from a launch URL.
- **Origin not allowed** / **Host not allowed** — the server refused this page
  because of where it was opened from or which host/port it used. Confirm you
  reached Cebab at the correct URL (127.0.0.1 or localhost on the configured
  port); each of these carries a link to the allowed-origins/hosts docs.
- **Connection to Cebab failed** — a catch-all for anything not otherwise
  recognized; the message includes a close code so you can tell it apart.

Every variant offers **Copy diagnostic**, which puts a short, safe block on
your clipboard (timestamp, reason, URL, and close code — no credentials or
tokens) that's meant to be pasted into a bug report. Only the
server-unreachable case shows a Retry button and auto-retries; the others need
a specific action (usually a fresh launch URL) instead.

## When your Claude credentials expire

Cebab uses your existing Claude subscription, not an API key. When those
credentials expire, runs start failing with an "auth expired" condition. The
fix is the auth-refresh flow, which drives a `claude login` subprocess for you
in a modal:

1. Cebab spawns the login subprocess (you'll see a brief "Spawning claude
   login…" step, then the subprocess PID in the header).
2. `claude login` prints an OAuth URL in the modal's output area. **Follow that
   URL in your browser** to complete sign-in. The output pane follows new lines
   automatically, but stops following once you scroll up so the URL you need to
   read doesn't get dragged off screen.
3. When the subprocess exits, the modal closes itself and your subscription
   credentials refresh automatically.

Important: **the credentials file is only updated if OAuth completed before you
cancelled.** The modal's Cancel button kills the login subprocess; if you
cancel (or it times out) before finishing OAuth, credentials may not have been
updated. On a clean exit the modal reports "Re-authenticated" with the exit
code, and the auth-expired banner clears the next time a session starts — that
start is the proof the new credentials actually work.

If Cebab can't even start the subprocess, you'll see "Failed to spawn claude
login." The usual cause is the `claude` binary not being on the server's PATH;
you can always run `claude login` yourself in a terminal instead. If another
browser tab is already running a refresh, Cebab tells you so — wait for it to
finish or cancel it from that tab.

## Reopening a closed session

Sessions that were ended or swept aside can be brought back with the reopen
flow. When you reopen, Cebab first **checks the workspace**: it compares the
project directory now against how it was when that session ran, so you can see
what changed before committing. The confirmation dialog reports whether the
workspace is clean, how many files changed (added/deleted), and a sample of the
changed paths. If the directory isn't a git repo (or git is missing), Cebab
can't enumerate changes and treats the workspace as modified.

Reopening **sets your current active session aside** and reactivates the older
one; you can archive or reopen either side later. You must tick the
acknowledgement checkbox to proceed. When files have changed (or the diff
couldn't be read), Cebab adds a second guard: you also type `reopen` to
confirm. The dialog defaults focus to Cancel, so reopening is always a
deliberate choice.

Reopen can fail with a named reason, e.g. the session was not found, is already
running, has no participant project, or — for multi-agent chains — "Cannot
reopen chain session" (chain sessions can't be reconstructed this way).

## The recovery activity log

The clock icon in the sidebar header opens **Recovery activity**, an
append-only record of how Cebab has been recovering: auto-retries, sweeps,
archives, and reopens. It's a forensic log, not an inbox — there's no unread
badge. It has three parts:

- **By class** — counts per failure class (rate limit, auth expired, sweep,
  chain crash, other), with how often recovery reached its final state and the
  median time to recover.
- **Gauges** — the sweep reopen rate (how often you reopen a swept iteration)
  and the auth resume choice (in-session resume vs. starting fresh after an
  auth refresh). These read "no data yet" rather than a misleading 0% when
  nothing's happened.
- **Recent activity** — newest-first rows with a timestamp and, where it
  applies, the session id. Rows not tied to a session are marked
  **process-level** ("process-level event (no session)").

## Server restart and multi-agent sessions

Closing or refreshing your browser doesn't stop a run: a live multi-agent
session keeps going on the server, and the new tab simply re-attaches to it.

A **server** restart is different — it empties the in-memory registry of live
runs. **Orchestrated** multi-agent sessions are rebuilt from saved state and
re-attached **read-only**: the session comes back in an awaiting-continue state
with a recovery banner and runs nothing until you explicitly continue. Live
re-attachment to a still-executing turn is not available after a restart, and
Cebab does not roll back filesystem changes from an interrupted turn — review
each worker's project with `git status` before continuing. The
awaiting-continue banner includes a "Recovery details" disclosure listing which
workers may have unfinished turns, their last activity, and their last clean
checkpoint. **Chain** sessions are not reconstructed and fall back to a crashed
state. Persisted transcripts and events always survive either way. See
06-multi-agent-running.md.

## The resume-after-directory-move gotcha

Cebab keys each session's history by the project's **absolute directory path**.
If you move or rename a project's folder, its earlier sessions become
unresumable — the history is still on disk but Cebab can no longer match it to
the project at its new location. Avoid moving project directories you still
want to resume. Where projects live and how session data is stored is covered
in 12-settings-storage-and-data.md.
