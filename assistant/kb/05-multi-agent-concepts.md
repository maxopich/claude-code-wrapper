# Multi-agent concepts

## What the bus is, and why

Most of Cebab runs one project at a time: you type, one `claude` session
answers. The **multi-agent bus** is the mode where several of your agent
projects work on the same task together, passing messages between each other
until the job is done and the result comes back to you.

It is worth knowing what it is _not_. The bus is a pure in-process runtime: every
participant is an ordinary `claude` SDK session, exactly like the single-agent
chat, and Cebab wires their messages together in memory. There is no tmux, no
shell scripts, no hidden log files, no inter-process plumbing. That is why it
behaves identically on macOS, Linux and Windows, and why a multi-agent run is
really just several normal sessions that can talk to each other.

You would reach for the bus when one task genuinely spans more than one project
— for example, a "backend" agent and a "docs" agent looking at the same change,
or a pipeline where one agent's output becomes the next one's input. If a single
project can do the whole thing, you do not need the bus.

## The two modes: chain and orchestrator

The bus runs in one of two shapes, chosen when you start the run.

**Chain** is a fixed pipeline. You line up participants in order; each one does
its part and hands off to the next. The last hop lands at a special
destination called `_sink`, which ends the run. A chain is the right fit when
the work has a natural sequence — draft, then review, then summarise — and you
already know the order the agents should run in.

**Orchestrator** is a router. One lead agent (the orchestrator) receives your
task, decides which worker to delegate each piece to, collects the replies, and
relays a final answer back to you. Nothing is fixed in advance: the orchestrator
picks who works next based on what it has learned. This fits open-ended tasks
where you do not know up front which agents are needed or in what order — you
describe the goal and let the router coordinate.

A quick way to choose: if you can write the steps down as a list, use a chain;
if the task needs a coordinator to figure the steps out, use an orchestrator.

## Participants and roles

The agents in a run are its **participants**, and each has a role.

- In a **chain**, every participant is a pipeline stage. Each one's only job is
  to do its part and pass along the trail.
- In an **orchestrator** run, there is one **orchestrator** and one or more
  **workers**. The orchestrator never does the task work itself — it routes.
  Workers are the ones that actually read, analyse and produce.

Each participant is a real project of yours, running in its own working
directory with its own settings, tools and `CLAUDE.md`. They do not share a
brain; they only share the messages they send each other.

## How agents talk to each other

Agents do not have some private back-channel. They communicate by calling a
single tool Cebab injects into each session, `bus_send`, which delivers a
message to another participant (or, at the end of a chain, to `_sink`; the
orchestrator relays to you). Every message they exchange goes through it.

The important property is that **an agent cannot lie about who it is**. The
`source` — the "from" on each message — is pinned by Cebab on the server side,
per agent, in a place the agent cannot reach. A worker cannot forge a message
that looks like it came from the orchestrator or from you. This unspoofable
identity is what lets Cebab trust the routing, and messages that arrive with a
mismatched or unexpected source are dropped rather than delivered.

As the run proceeds, the messages form a **hop trail** — the ordered record of
who sent what to whom. This is what you watch in the UI to follow the
conversation, and what the activity indicator reads to tell you which agent is
currently working.

## Two different ceilings: hop budget vs per-hop turns

The bus has two separate limits, and they are easy to confuse because both sound
like "how much work." They measure different things, and a run can bump into
either one.

- The **hop budget** counts the _messages between agents_ — every `bus_send`
  handoff. It bounds how long the overall conversation can run: how many times
  agents are allowed to pass the task around before the run stops.
- The **per-hop turn cap** (`max_turns`) bounds the _work inside a single hop_ —
  how many turns one agent may take while it holds the task, before it has to
  hand off.

The distinction matters. The hop budget only ticks when an agent sends a
message; an agent that works quietly without calling `bus_send` spends no hop
budget at all, no matter how much it does. That is exactly the gap the per-hop
turn cap closes — it stops one agent from working forever within a single hop.
Think of the hop budget as "how many exchanges" and the turn cap as "how much
each turn of the conversation is allowed to do." Both come from your Settings,
and both are enforced per run.

## The runtime trust posture

This is the part to understand before you start a run, because it is more
permissive than the single-agent chat.

In a normal Cebab session, tool calls surface approval cards you click. **On the
bus, that is not how workers behave.** Workers and chain participants
**auto-approve every tool** — Bash, Edit, file writes, MCP calls — with no human
gate. The one exception is `AskUserQuestion`: when an agent explicitly asks _you_
a question, that reaches you and your answer is handed back to it. Everything
else runs on its own. Because participants also load their own project settings,
any hooks a project defines will fire on every hop too, again without a prompt.

The **orchestrator is the deliberate opposite**. It runs a locked-down policy
(`delegate-only`, default-deny): it is allowed to do essentially two things —
send messages (`bus_send`) and ask you a question (`AskUserQuestion`) — and
nothing else. It routes; it does not touch files or run commands. That keeps the
coordinator from quietly doing work it was only meant to delegate.

The practical takeaway: on the bus you are trusting the participants to act
without per-tool confirmation. The brakes that do exist — pausing, muting,
kicking an agent, and the automatic pause on dangerous actions — are covered in
08-safety-controls.md. Treat them as brakes, not walls.

## Consultant mode vs execute mode

By default, workers run as **consultants**: they read, analyse and advise, and
they are told not to create, modify or delete files outside their own project
folder. **Execute mode** is an opt-in you choose when starting a session; it
lifts that restriction for a worker so it can create, modify and delete files
_within its own project folder_.

Be clear about what this is. Consultant mode is a **prompt-level instruction** —
Cebab tells the agent to behave that way — not an enforced sandbox. A determined
or confused agent could still stray, which is why the mechanical safety brakes in
08-safety-controls.md exist alongside it. Consultant is the safer default;
execute mode is the deliberate choice when you actually want the agents to change
files. (Note that the consultant instruction is rendered for the orchestrator and
its workers; chain participants rely on the mechanical brakes instead.)

## Where to go next

- **06-multi-agent-running.md** — the step-by-step how-to: picking a mode,
  choosing participants, starting a run, and reading the trail.
- **07-templates.md** — saving and reusing a topology so you do not rebuild the
  same set of agents each time.
- **08-safety-controls.md** — pause, mute and kick, the pause-on-dangerous gate,
  and the other safety brakes.
