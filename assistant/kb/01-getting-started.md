# Getting started

## What Cebab is

Cebab is a personal, browser-based front end for the `claude` CLI already
installed on your machine. It lists the agent projects under a workspace folder
in a sidebar, runs each one in its own working directory, and renders the
streamed output as a chat, complete with inline tool-approval cards you click to
allow or deny. It talks to a small local server that spawns `claude` for you and
saves every message. Cebab is single-user and bound to `127.0.0.1` — nothing is
exposed to the network. It uses your existing Claude subscription (the login the
`claude` CLI already has), so there is no API key to enter and no separate
billing.

## Before you start

Cebab drives the `claude` CLI, so you need it installed and logged in first.

- Install the `claude` CLI (Claude Code) on your machine.
- Log in so it can use your Claude subscription.
- Confirm it is ready by running `claude auth status`. If that reports you are
  logged in, Cebab has everything it needs.

If `claude` is not installed or not logged in, Cebab has nothing to run and
messages will fail. Sort this out first. See 14-troubleshooting.md if launches
or messages do not behave.

## First launch

From the Cebab project folder, start everything with one command:

```sh
npm run dev
```

This starts the local server (on port 4319) and the web UI (on port 5173)
together, with their output interleaved and tagged `[server]` / `[web]`. Then
open:

```
http://127.0.0.1:5173
```

To stop, press **Ctrl+C** in that terminal — it stops both the server and the
web UI at once.

One thing to know about the port: if `5173` is already in use (another Vite
project is the usual culprit), the launch deliberately fails rather than quietly
moving to a different port. Free port 5173 and run `npm run dev` again. See
14-troubleshooting.md if you hit this.

## Choosing your workspace folder

The workspace folder is the directory whose subdirectories become your projects
in the sidebar. On the very first run the chat pane shows a **Choose a folder**
prompt.

- Click it (or use the workspace button at the bottom of the sidebar at any
  time) and enter a path.
- The path can be absolute (for example `/Users/you/agents`) or start with `~`
  (for example `~/agents`).

Your choice is saved and survives restarts, so you only do this once. It is
stored in Cebab's own data folder at `~/.cebab` — you do not need to touch that
file yourself; it is just where the setting lives.

Once a workspace is set, every subdirectory under it appears in the sidebar as a
project. There is no separate "add project" step — creating a folder under your
workspace is how a project shows up. For more on how projects and their chat
sessions work, see 02-projects-and-sessions.md.

## Sending your first message

1. Pick a project from the sidebar. Cebab runs that project in its own
   directory, so the agent works in the right place.
2. The chat area opens onto that project. Type your message in the composer at
   the bottom and send it.
3. Cebab spawns `claude` for that project and streams the reply back into the
   chat as it arrives — text, tool calls, and results all appear live.

When the agent wants to use a tool that is not pre-approved, an inline
tool-approval card appears in the chat. You click to allow or deny it, and the
run continues based on your choice. Whether a project prompts you for these, or
runs more freely, depends on its trust setting — that is worth understanding
before you let an agent make changes on its own. See
04-permissions-trust-and-authority.md.

## Mock mode (trying the UI without using your quota)

Real `claude` runs consume your subscription quota. If you just want to click
around the interface or iterate on how things look, Cebab has a **mock mode**
that replays pre-recorded transcripts instead of calling `claude` for real, so
it burns no quota.

The simplest cross-platform way to turn it on is to set `MOCK=1` in a `.env`
file at the project root, then start Cebab as usual. On macOS and Linux you can
also run it inline for a single launch:

```sh
MOCK=1 npm run dev:server
```

On Windows PowerShell the inline form does not set the variable — put `MOCK=1`
in your `.env` instead. Mock mode is meant for exploring the UI, not for getting
real work done, since the replies are canned recordings.

## Where to go next

You are now set up: the CLI is logged in, Cebab is running, a workspace is
chosen, and you can send messages. From here:

- 02-projects-and-sessions.md — how projects appear, and how chat sessions and
  follow-up messages work.
- 04-permissions-trust-and-authority.md — the per-project trust toggle, what it
  loads, and how tool approvals behave.
- 14-troubleshooting.md — what to do when a launch, a port, or a message does
  not work as expected.
