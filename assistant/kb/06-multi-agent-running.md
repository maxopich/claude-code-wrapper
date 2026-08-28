# Running a multi-agent session

This is the hands-on page: how to set up participants, start a run, watch it, steer it mid-flight, and end it cleanly. For what a chain, an orchestrator, the bus, and hops actually _are_, read `05-multi-agent-concepts.md` first — this page assumes those ideas and walks the workflow.

## Step 1 — Install bus integration on the projects you want as participants

Only **bus-eligible** projects can join a multi-agent session. A project that hasn't been set up shows the note **"This project has no bus integration installed yet."** Use its **Install bus integration** action to make it eligible.

What install does — and doesn't — do matters, so it's worth quoting the app: installing is **pure DB metadata**. Cebab assigns the project a stable agent slug and marks it bus-eligible. **Nothing is written into the project** — no `CLAUDE.md`, no `.claude/settings.json`, no scripts. Your project folder is left exactly as it was.

There is one behaviour to understand up front, because it's a real change to how the project runs during these sessions: **during multi-agent sessions this project's agent runs headless. Every tool call is auto-approved with no human in the loop — bypass is in effect. The only thing ever surfaced to you is AskUserQuestion.** So a bus participant will not stop to ask permission before editing files or running commands the way an ordinary trusted session might. Read `08-safety-controls.md` before running anything with real side effects — that page covers the pause-on-dangerous-command gate and orchestrator consultant-mode, which are your guardrails here.

**Uninstall bus integration** is the mirror image: also pure DB metadata. Since Cebab wrote nothing into the project, nothing in it is touched — the project simply stops being eligible for multi-agent sessions.

## Step 2 — Build a draft

A **draft** is the setup you assemble before starting. On the Multi-Agent (orchestrator) or Chained Chat (chain) tab, drag bus-eligible projects in from the sidebar to add them as **participants**.

Decisions to make in the draft:

- **Chain vs orchestrator.** These are two different tabs, and the active tab _is_ the mode. In a **chain**, each turn flows through the participants in order, top to bottom, and the last one writes the final reply Cebab archives. In an **orchestrator** session, Cebab starts the orchestrator plus one worker per participant; the orchestrator routes each prompt to whichever worker fits, then replies when done.
- **Order (chain only).** For a chain, order is the pipeline — use the **Move up / Move down** controls so participants run in the sequence you want. In an orchestrator run the roster is unordered; the orchestrator decides who does what.
- **Persistent vs Temp lifecycle.** **Persistent**: the session folder survives End so the conversation can be resumed later, and bus install on participants stays in place — pick this for ongoing work. **Temp**: on End, Cebab deletes the session folder _and_ removes bus integration from each participant — pick this for a one-off task you don't want to leave residue from.

Before you start, you can preview exactly what each participant will load (tools, MCP servers, env, hooks) with the authority inspector — see `04-permissions-trust-and-authority.md`. If you assemble the same roster often, save it as a template; see `07-templates.md`.

## Step 3 — Type a prompt and Start

The prompt box takes your opening instruction. In a **chain**, this is the task sent to the first participant; each reply forwards down the chain. In an **orchestrator** run, it's the first prompt the orchestrator hears, and it routes from there. Press **Start** (Enter to start, Shift+Enter for a newline). Cebab spins up one in-process agent per participant (plus the orchestrator, in orchestrator mode).

## Step 4 — Watch the scrollback

The live view streams every agent's messages as they happen. Things to look at:

- **The hop trail.** Collapsed by default, this is the **full ordered hop trail** — who routed to whom — and it's verified by construction. Expand it to inspect each hop or to jump straight to that hop in the scrollback. Each hop's sender is trustworthy: the **source is Cebab-pinned and unspoofable** — it's stamped server-side, not set by the agent — so you can rely on the trail to see what actually routed where.
- **Per-agent messages.** Each participant's turns appear inline. You can collapse a message to metadata only, copy its text, or open it in a larger window.
- **Working files / mutations.** A dedicated list shows **files written, edits, and Bash commands that mutated the filesystem during this session** (read-only tool calls are not listed). A companion view groups the promoted mutations by path, collapsing repeated edits to one file into an edit count. This is your at-a-glance record of what the session actually changed on disk.
- **The scrollback filter.** When the stream gets busy, use the filter to narrow what's shown so you can follow one thread.

## Step 5 — Interact mid-run

You don't have to sit and watch. Two live controls:

- **Send input to the orchestrator** (orchestrator mode). Whatever you type is **delivered as a `prompt` from `cebab` on the orchestrator's next turn**, and the orchestrator then routes it to a participant. So you're nudging the orchestrator, not talking to a worker directly.
- **Add a worker.** You can bring another participant into a running orchestrator session — **bus integration is auto-installed if missing**, so you don't have to prep the project first.

## Step 6 — End a run, and what gets cleaned up

Ending a run is where the lifecycle choice from Step 2 pays out:

- **Persistent** — the session folder and the bus installs survive End. The run can be resumed later (see below), and participants stay bus-eligible.
- **Temp** — on End, Cebab removes the session folder _and_ uninstalls the bus from each participant. Nothing is left behind. If you want the transcripts, grab them before ending, or copy the iteration path (below).

Clearing the scrollback just returns you to the draft view; iteration artifacts on disk are unaffected.

## Resuming a session

A finished-looking run in the past-runs list may still be **live** in the server process. **Resume** re-attaches to it: no agents are respawned — Cebab swaps the live view back onto the running in-process router and resumes streaming.

The important limit: **Resume is only available while the session is still live in the running server process. After a Cebab server restart, that live attachment is gone** and Resume can't reconnect. If a run that was live suddenly shows under past runs, Cebab lost its attachment; Resume reconnects only within the same server process.

There's a partial exception for orchestrator runs. After a server restart, such a run can come back **re-attached read-only — nothing is running.** File writes or commands from the interrupted step are _not_ rolled back. From that state, **Continue session** delivers a "continue where you left off" nudge and is the only action that re-runs agents after a restart.

To inspect a run outside the app, use **Copy path** to copy the iteration directory to your clipboard, then `cd` into it in a terminal to read the transcripts and per-agent prompt/reply files. For where these artifacts live and how to search across them, see `10-logs-artifacts-and-search.md`.

## Related pages

- `05-multi-agent-concepts.md` — chains, orchestrators, the bus, and hops explained.
- `07-templates.md` — save and reuse a participant roster.
- `08-safety-controls.md` — the pause-on-dangerous gate, consultant vs execute mode, and headless auto-approval.
- `10-logs-artifacts-and-search.md` — where transcripts and mutations are stored and how to search them.
