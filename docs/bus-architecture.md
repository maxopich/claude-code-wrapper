# Bus architecture

Reference detail lifted out of [`CLAUDE.md`](../CLAUDE.md) so that file stays
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

## Bus install is pure DB metadata

Clicking "Install bus integration" only assigns a stable agent slug + flips a row flag — Cebab writes **nothing** into the operator's project (no `.claude/settings.json` merge, no CLAUDE.md `@import`, no copied scripts, no Stop hook). Workers and chain participants run with `settingSources: ['user', 'project', 'local']` — so each participant's own `.claude/settings.json` and `.claude/settings.local.json` (MCP servers, allowed/disallowed tools, env injectors, hooks) load exactly as a standalone `claude` session in that cwd would. The "Cebab writes nothing into the project" guarantee is about _Cebab-side_ mutations; the SDK reads what the user already wrote. The orchestrator stays at `settingSources: ['user']` because its cwd is the empty Cebab-owned `<sessionFolder>/orchestrator/` — nothing to load. Since Cebab-ws0.8 that folder is `~/.cebab/sessions/<id>/orchestrator/` rather than `<workspaceRoot>/.cebab-session-<id>/orchestrator/`; note this is a live agent **cwd**, so pre-existing session folders are deliberately never relocated — the CLI keys its transcript store on the absolute cwd, and moving one would orphan that session's resume lineage. The bus protocol reaches each agent via a per-turn briefing Cebab prepends — `renderChainBriefing` for chain participants, `renderWorkerBriefing` for orchestrator workers, `renderRosterPrompt` for the orchestrator (its **only** prompt: no generated `CLAUDE.md`/`comm.md` — those were dead under `['user']` and were removed). Each agent's own project-root `CLAUDE.md` is also explicitly read and injected as framed prompt **text** on its first turn (`readProjectClaudeMd`) so it appears in the on-disk transcript and the operator's chat; the SDK now _additionally_ auto-loads it via the widened settingSources (small token cost, intentional). The in-process bus MCP server is registered under the namespaced key **`cebab_bus`** (not `bus`) so a participant's own `mcpServers.bus` in their `.claude/settings*.json` cannot collide with — or clobber — the identity-pinned `bus_send` injection in the merged config; agents see the tool as `mcp__cebab_bus__bus_send`.

## Bus resume (R-A + R-B)

Live sessions live in an in-process registry (`session_registry.ts`), the analogue of "tmux survived". A browser close/refresh/second window re-attaches by swapping the WS sink — the run keeps going (R-A). A Cebab **server** restart empties the registry; an **orchestrated** session is then rebuilt from durable state (`reconstruct.ts`, R-B) and re-attached **read-only** — it sets `awaiting_continue`, replays a recovery banner, and runs nothing until the operator explicitly continues (an interrupted turn's side effects are _not_ rolled back). **Chain** mode is not reconstructed yet and still falls back to `crashed`. Persisted transcripts/events always survive; single-agent resume is a separate path and is unaffected.
