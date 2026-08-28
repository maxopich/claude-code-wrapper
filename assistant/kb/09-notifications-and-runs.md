# Notifications and runs

Cebab keeps you informed about what's happening in the background through three
surfaces in the header and top bar: the **notification bell** (with its inbox),
the **runs badge** (a pill showing what's running right now), and **session
banners** that appear when the app needs to tell you something in-line — the
rate-limit banner is the main one. This page covers all three.

## The notification bell and inbox

A **bell** sits in the sidebar header, next to the connection dot. When you have
unread notifications it shows a small count badge; the badge caps its display at
**99+**. Its label reads "Notifications inbox" (or "Notifications inbox, N
unread" when something is waiting). Click the bell to open the inbox popover;
click again, click outside it, or press **Esc** to close it. Closing returns
focus to the bell.

The inbox is a scrollable history of notifications. Each row shows a **tier**
(Info, Success, Warning, Error, or Danger), a timestamp, the title, an optional
message, and — where relevant — a labelled action such as "Open session", "Open
in logs", "Open settings", "Re-authenticate", "Resume", "Archive", "Reopen", or
"Restart agent". A row that offers an action shows that label as a chip so you
can see what the notification is about.

### Operational vs safety notifications

Notifications come in two **classes**:

- **Operational** notifications are routine status updates — things happening in
  the app that you may want to know about but don't have to act on.
- **Safety** notifications concern safety-relevant events and are meant to be
  attended to.

You can tell the two apart in the inbox using the **Class** filter chips ("Op"
and "Safety"). There's also a **Tier** filter (Info through Danger) and an
**Include acknowledged** toggle that controls whether already-read rows stay
visible.

### Acknowledging and the "Clear dismissed" button

Each row has a **Mark read** button that acknowledges that single notification.
To clear the backlog in one go, use **Clear dismissed** at the top of the inbox.
Its tooltip says exactly what it does: "Acknowledge every unacked operational
notification (safety untouched)." In other words, clearing acknowledges all your
outstanding _operational_ notifications while leaving _safety_ ones alone — so
you can't accidentally sweep away a safety notice you haven't dealt with. Safety
notifications must be acknowledged deliberately.

### Muting a notification type for an hour

Some notifications appear as short-lived pop-up toasts as well as in the inbox.
On a toast you may see a **Mute** button; its tooltip reads "Mute this
notification type for 1 hour." Muting silences that _type_ of notification for
the next hour so a chatty source stops interrupting you. Muting is only offered
for the calmer tiers — Info, Success, and Warning. Error and Danger
notifications can't be muted, because they're the ones you're meant to attend to.

Muted types are listed in the inbox under a collapsible **Muted types (N)**
section. Expand it to see each muted type, how much of its mute window is left
(for example "45m left"), and an **Unmute** button to lift the mute early.

## What notifies you

The notifications you receive are driven by things happening in the background,
and the action a row offers hints at what it's about. Broadly, you'll be
notified about operational events (such as a run finishing, or something to open
in the logs or settings), authentication or re-authentication prompts, and
safety-relevant events that warrant your attention. The exact set depends on
what your sessions and agents are doing; treat the tier and the action label on
each row as your guide to how urgent it is and what to do next. For more on
safety-relevant events and how to respond to them, see 08-safety-controls.md.

## The runs badge

When one or more runs are in flight, a **runs badge** appears in the top bar — a
small pill reading, for example, "2 active". It only shows up when there's
something running; with nothing in flight there's no badge at all. Click it to
open a dropdown of the active runs; as with the bell, click outside or press
**Esc** to close.

Each row in the dropdown identifies a run by its project (falling back to a
project id, or "(no project)", when a name isn't available) and shows two things
about it:

- Its **kind** — **single** (a single-agent run), **bus** (a multi-agent
  participant), or **orch** (a multi-agent orchestrator). Hover the kind chip for
  a fuller description. On multi-agent runs the active participant's name may
  appear alongside the project.
- How long it's been running, ticking up live (for example "7s", "3m12s", or
  "2h05m"). Hover it to see the wall-clock **start time**.

Clicking a row jumps you to that run: single-agent runs open in the chat view,
multi-agent runs open in the multi-agent view. The dropdown shows up to 20 runs
at once; if there are more, a "+N more" line tells you how many are hidden. For
background on single vs multi-agent runs, see 05-multi-agent-concepts.md.

## Session banners

Banners are the app's in-line message surface, appearing above the current view
when Cebab needs to tell you something about the session itself. One example is a
banner warning that an **MCP server loaded but didn't connect** — see
04-permissions-trust-and-authority.md for what that means and how to handle it.

### The rate-limit banner

When the API rate-limits your session, a **warn-tier** banner (with an hourglass)
appears. It explains that the session is being rate-limited and, when the reset
time is known, shows a live **countdown** to when the limit resets ("Resets
in…"). By default the held turn will **auto-retry** when the countdown reaches
zero. The banner gives you two controls:

- **Retry now** fires the held turn against the API immediately, without waiting
  for the countdown. If the limit is still hot you'll get a fresh rate-limit and
  the countdown restarts.
- **Pause auto-retry** / **Resume auto-retry** freezes or resumes the countdown.
  While paused, nothing fires automatically — but Retry now still works.

If you sent messages while the session was rate-limited, they're **queued** to
send once the limit clears. The banner shows a count ("N held messages waiting to
send when this clears") and a details panel you can expand to inspect each queued
message. Each one has a **Drop** button ("Drop this queued message") so you can
prune a stale draft without clearing the whole queue.

On multi-agent (bus) runs a similar auto-retry banner can appear, but it's
observe-only: the bus manages its own retries server-side, so there's no Retry,
Pause, or held-message queue — just the countdown to the next attempt.

For what to do when a banner points at a genuine error or a stuck session, see
11-recovery-and-errors.md.
