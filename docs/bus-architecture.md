# Bus architecture

Reference detail behind the bus, kept out of the always-loaded surfaces so those stay
small enough to load into every session. **Nothing under `docs/` is auto-loaded
by anything** — neither the SDK's project-memory load nor the bus's
`readProjectClaudeMd` injection reads past `CLAUDE.md` — so this page arrives
only when you open it. Read it before touching `server/src/bus/`.

The security-critical claims about this subject matter — the live permission
posture, the consultant constraint and its two limits — deliberately stayed in
`CLAUDE.md`. What is here is mechanism, not policy.

## Core modules

`server/src/bus/{runner,chain,orchestrator,session_registry}.ts` are the core, with `runtime.ts` the single source of truth for every agent-facing prompt (roster, briefings, the consultant-mode guardrail) and `reconstruct.ts` the server-restart recovery path; F2/F3 source-allowlist drop filters are kept verbatim as defense-in-depth.

## A dropped chain event parks the run

Chain mode advances only when the router wakes the next agent, so each of the
six drop filters in `chain.ts`'s `handleEvent` (`forged_source`,
`worker_to_user`, `unknown_source`, `self_addressed`, `unauthorized_sink`,
`unknown_destination`) ends a hop with **nobody woken** — and the sending agent
has already been told `"delivered"`. Nothing retries: the per-turn stall
watchdog only arms while a turn is in flight, and this is the state where none
is. The run used to sit at status `running` indefinitely, and because
`multi_agent_user_prompt` refuses chain sessions outright, the operator's only
move was Stop.

A drop now **parks** the session in its pending-retry slot — the same slot
`onWorkerFailed` uses, so it already renders as a banner with Retry + Abandon,
survives a detach, and is restored by R-A re-attach and R-B reconstruction.
Three details are load-bearing:

- **Parked on turn end, not at drop time.** `bus_send` runs inside the sender's
  turn, so that turn resolves moments later and `onTurnSucceeded` nulls the
  slot the sender owns. A slot written at drop time is erased by the sender's
  own success. `handleEvent` only records the drop; `onTurnSucceeded` parks,
  after its clear branch.
- **A wake counter, not a flag.** The same turn may still make a legal
  `bus_send` after a rejected one, which makes the drop moot — but a legal send
  _before_ the drop does not, because the dropped message is still missing. The
  router compares its wake count at the drop against the count at turn end.
- **The retry prompt is a correction, not a replay.** It names the agent's one
  real destination (successor-or-`_sink`, the rule `renderChainBriefing`
  renders) rather than re-running the turn that just misfired. Cebab does not
  re-route on the agent's behalf — the drop's safety notification and audit row
  are still what surfaces the violation, and the operator decides.

## Custom topology layouts, and why the validator refuses every one

`shared/src/topology.ts` checks that a template plus a custom layout describes a
topology the bus would actually execute. Its four rules mirror the F2/F3
source-allowlist drops in `bus/orchestrator.ts`: no worker→worker edges, no
self-loops, no edges to or from non-participants, and no disconnected
components.

**It cannot approve any non-empty layout, and that is a property of the SCHEMA
rather than a bug.** Work the branches through and `ok` reduces to exactly
`edges.length === 0`: every edge `CustomLayout` can express has two participant
`projectId` endpoints, so every edge is a worker→worker edge, so every edge is a
violation. `topology.test.ts` pins that reduction directly rather than leaving it
to be rediscovered.

### Two repairs, both measured and both rejected

Recorded here so whoever ships the custom-mode editor starts from the numbers
instead of re-deriving them.

1. **Add a `'hub'` edge endpoint** so a layout can say worker↔hub. Then the only
   approvable non-empty layout is the one where every participant is
   hub-incident — the star that `participants` alone already describes.
   Enumerated over four participants: exactly **1** approvable non-empty layout.
   The field would be able to express one thing, and that thing is already
   derivable without it.
2. **Reread an edge as hub-anchored** (`from → hub → to`), which the connectivity
   check half-assumes and the renderer stub appears to support. Then
   `worker_to_worker` becomes unconstructible and many layouts approve —
   enumerated over four participants: **3861**. But under orchestrator routing
   every worker already reaches every other worker via the hub, so all 3861
   depict a constraint the bus does not enforce.

So the honest statement is that `CustomLayout.edges` cannot currently express a
topology that is both LEGAL and INFORMATIVE. Fixing that is a decision about what
custom mode is FOR, not a patch, and it belongs with the editor's owner.
`protocol.ts` says `'custom'` is presentation-only and that the runtime follows
orchestrator routing; while that holds, a hand-authored edge set has nothing to
say that `participants` does not.

What was done instead, deliberately: leave the code alone, make the claims above
it true, and pin the tautology. A validator that silently refuses everything
while advertising four rules is worse than one that says so.

### Two rules that deliberately do not exist

**No worker→user rule** (register N08). The F2 worker→user drop is real, but it
is a RUNTIME routing rule (`RouterDropReasonCode.worker_to_user`), not a topology
one. A `CustomLayout` edge has two participant `projectId` endpoints and no
`'user'` sentinel, so a worker→user edge is inexpressible and the validator can
never see one. The `worker_to_user` variant of `TopologyViolation` was declared,
never constructed, and removed. If a future editor adds a `'user'` endpoint, add
the rule AND the variant together — `topology.test.ts` fences this by requiring
the declared `code` union to match the set the validator can actually emit.

**No `broadcast` edge kind.** Broadcast is a runtime policy — the orchestrator
decides addressees per turn from capabilities and prompt content — not a
topology fact. Putting it in the schema would invite UIs that draw a routing
decision as a fixed edge, the same misleading mental model repair 2 above
arrives at from the other direction.

## Bus install is pure DB metadata

Clicking "Install bus integration" only assigns a stable agent slug + flips a row flag — Cebab writes **nothing** into the operator's project (no `.claude/settings.json` merge, no CLAUDE.md `@import`, no copied scripts, no Stop hook). Workers and chain participants run with `settingSources: ['user', 'project', 'local']` — so each participant's own `.claude/settings.json` and `.claude/settings.local.json` (MCP servers, allowed/disallowed tools, env injectors, hooks) load exactly as a standalone `claude` session in that cwd would. The "Cebab writes nothing into the project" guarantee is about _Cebab-side_ mutations; the SDK reads what the user already wrote. The orchestrator stays at `settingSources: ['user']` because its cwd is the empty Cebab-owned `<sessionFolder>/orchestrator/` — nothing to load. Since Cebab-ws0.8 that folder is `~/.cebab/sessions/<id>/orchestrator/` rather than `<workspaceRoot>/.cebab-session-<id>/orchestrator/`; note this is a live agent **cwd**, so pre-existing session folders are deliberately never relocated — the CLI keys its transcript store on the absolute cwd, and moving one would orphan that session's resume lineage. The bus protocol reaches each agent via a per-turn briefing Cebab prepends — `renderChainBriefing` for chain participants, `renderWorkerBriefing` for orchestrator workers, `renderRosterPrompt` for the orchestrator (its **only** prompt: no generated `CLAUDE.md`/`comm.md` — those were dead under `['user']` and were removed). Each agent's own project-root `CLAUDE.md` is also explicitly read and injected as framed prompt **text** on its first turn (`readProjectClaudeMd`) so it appears in the on-disk transcript and the operator's chat; the SDK now _additionally_ auto-loads it via the widened settingSources (small token cost, intentional). The in-process bus MCP server is registered under the namespaced key **`cebab_bus`** (not `bus`) so a participant's own `mcpServers.bus` in their `.claude/settings*.json` cannot collide with — or clobber — the identity-pinned `bus_send` injection in the merged config; agents see the tool as `mcp__cebab_bus__bus_send`. Since Cebab-ws0.3 each participant's spec also carries the **model** its own project selected (`projectModelSpec(projectId)`, spread at all three `runner.register` sites); a project that has chosen nothing contributes no `model` key at all, so its turns are byte-identical to before that existed, and the orchestrator — which has no project — always runs the CLI default. The gap to know about: the bus emits no `session_started`, so nothing on the wire reports which model a participant _actually_ ran on (`Cebab-ut7`), which makes this setting write-only for multi-agent runs today.

## Bus resume (R-A + R-B)

Live sessions live in an in-process registry (`session_registry.ts`), the analogue of "tmux survived". A browser close/refresh/second window re-attaches by swapping the WS sink — the run keeps going (R-A). A Cebab **server** restart empties the registry; an **orchestrated** session is then rebuilt from durable state (`reconstruct.ts`, R-B) and re-attached **read-only** — it sets `awaiting_continue`, replays a recovery banner, and runs nothing until the operator explicitly continues (an interrupted turn's side effects are _not_ rolled back). **Chain** mode is not reconstructed yet and still falls back to `crashed`. Persisted transcripts/events always survive; single-agent resume is a separate path and is unaffected.
