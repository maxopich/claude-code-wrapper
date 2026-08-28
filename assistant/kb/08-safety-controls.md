# Safety controls

This page explains the brakes and the audit trail Cebab gives you over a
multi-agent run, and — just as importantly — what they do **not** promise. Read
it honestly: these are advisory brakes and after-the-fact detection, not a
sandbox. If you want the concepts behind the bus first, see
05-multi-agent-concepts.md; for how to drive a run, 06-multi-agent-running.md.

## The runtime trust posture, in plain terms

When you start a multi-agent run, every worker and every chain participant runs
**headless**. Their tool calls — file edits, `Bash` commands, MCP tools — are
**auto-approved**: there is no human-in-the-loop prompt the way a normal
single-agent session can pause for permission. The one exception is
`AskUserQuestion`: if a worker explicitly asks you something, that reaches you.
Nothing else does by default.

What this means for you: a worker you launch runs with your own user account and
your own permissions. It can read and write files, run shell commands, and open
network connections — the same things you could do at a terminal. The bus is a
force multiplier for trusted work, not a containment boundary. **Only start
runs whose projects and prompts you trust**, the same way you would trust a
script you were about to run yourself.

The orchestrator itself is the one structural exception: it is _delegate-only_.
It cannot touch files or a shell at all — it can only route messages to workers.
But the workers it delegates to run the auto-approve posture above, which is
where the real capability lives.

## The pause-on-dangerous toggle

This is your **mechanical brake**, and it is opt-in per session. Turn it on in
the run setup and Cebab classifies every worker tool call as read, mutate, or
**dangerous**. When a dangerous command comes up, the worker halts and waits for
your approval.

What counts as dangerous: `rm`, `sudo`, force-push, `curl | sh`, writes to
system or secret paths, and destructive infrastructure, cluster or database
operations (across Unix shells and Windows `cmd`/PowerShell). Ordinary file
edits and MCP tool calls classify as _mutate_ and run **without** a prompt —
their safeguards are the MCP server's own permissions plus the audit log, not
this pause.

How it behaves:

- **Every dangerous command needs its own Continue.** Approving one does not
  disarm the toggle, and workers are gated independently, so releasing one
  worker does not let another through.
- **A halted worker runs nothing further** until you decide. This is enforced,
  not just recorded: the worker's queued deliveries are held too, so a peer
  message or a retry cannot quietly start it on a fresh turn while it sits at an
  unapproved command.
- **It survives a Cebab server restart.** The hold is reinstalled when the
  session is reconstructed.

The honest caveat, because it is a race Cebab cannot always win: the command
that _triggered_ the halt may already have been dispatched to the CLI by the
time the halt lands. So treat the pause as reliably **stopping the worker** —
everything after the trigger is held — rather than as a guarantee that the very
first dangerous command never ran. It is a brake, not a pre-flight veto.

## Execute vs consultant mode

An orchestrator session is **consultant-only by default**: workers analyze and
advise, but they are told not to change files. Enabling **execute mode** lets
each worker create, modify, or delete files **within its own project folder** to
actually do the work.

Treat this as a safety control, but understand its limit clearly: the
consultant constraint, and the "own folder only" rule in execute mode, are
**advisory**. They are relayed to the worker in its prompt and interpreted by
the model — nothing in Cebab denies a tool call that writes outside a worker's
folder. Such out-of-scope writes are **classified and surfaced to you after the
fact**, not blocked. Keep execute mode off unless you want workers making
changes, and even with it on, expect discipline from the prompt rather than a
hard wall.

## Per-participant operator controls

While a run is live you can act on any one participant from its controls menu.
These are routing and scheduling filters at the bus. Important: **none of the
three stops an agent from _acting_** — none reaches a turn that is already
running. Each shapes what happens next, not what is in flight.

- **Mute** drops all outbound bus events from that participant at the router.
  The agent is _not_ told — its `bus_send` returns success regardless (a
  deliberate white lie so it cannot detect the drop). A muted agent keeps
  receiving messages, keeps being woken, and keeps running tools; it just can no
  longer talk to the others. Chain participants **cannot** be muted — that would
  break the pipeline topology, and the server rejects it.

- **Pause** holds the participant's incoming turns behind a gate. You choose a
  **duration** (a preset such as 15 minutes, or a custom value) and an
  **on-expiry** behavior: `auto_resume` (default) drains the queued turns in
  order, exactly as if you had clicked Resume; or `auto_kick`, which kicks the
  participant when the timer fires and captures a forensic bundle. Pause gates
  the _next_ turn — an in-flight turn is not cancelled. You can Resume manually
  at any time before expiry.

- **Kick** removes the participant. It is **terminal — there is no unkick in
  v1.** A kicked participant sends and receives nothing further, and no new turn
  will start for it; a turn already running finishes and then it is gone. Use it
  when you want an agent out of the run for good.

A note on mute and spend: because none of these stops an agent acting, muting a
runaway worker does not reduce its cost or halt its commands — for that you need
pause-on-dangerous, or **Stop** the whole session (see 09-notifications-and-runs.md).

## The forensic bundle

On a kick (manual or the `auto_kick` expiry), and on a single-agent Stop, Cebab
captures a **forensic bundle** for that participant: recent bus events,
attributed file mutations, and the audit lineage tying it together. You open it
from the participant's controls. It is best-effort context to help you
understand what an agent did before you removed it — the durable obligation is
the audit row, the bundle is the bonus detail.

## The hash-chained safety audit log

Behind all of the above sits an append-only **safety audit log**. Every trust
decision, every mute / pause / kick, every dangerous-mutation halt, and every
out-of-scope-write guardrail verdict writes a row. Each row is hash-chained to
the one before it, so tampering with any row breaks the chain, and Cebab
verifies the chain on startup and flags the first mismatch.

Two properties worth trusting: a **safety** event's audit row is written
**before** the corresponding notification is sent — if the record cannot be
written, Cebab refuses to proceed rather than acting silently. And an operator
control only takes effect if its audit row was written first, so you will not be
told "muted" for an agent that is actually still talking. The log is your
durable, ordered account of what was restrained and why.

## The honest limits

Keep these in mind so you do not over-trust the controls:

- **It is advisory containment, not a sandbox.** Workers run as you, with your
  permissions. Nothing prevents a determined or misbehaving worker from doing
  what you could do at a terminal.
- **The dangerous-command classifier is imperfect by design.** It does not
  resolve symlinks, and it cannot infer the real target paths from inside a
  `Bash` command line. A dangerous write dressed up as an ordinary-looking
  shell command can slip its notice.
- **Out-of-scope writes are detected, not blocked.** Execute mode's folder
  boundary is a prompt instruction, surfaced after the fact.
- **The first dangerous command can race the halt** (see above).

The takeaway: these controls make a run **observable and interruptible**, which
is genuinely valuable — but the real safety decision is upstream, in choosing
which projects and prompts you let onto the bus. For notifications, run history,
and the Stop control, see 09-notifications-and-runs.md.
