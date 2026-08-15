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

## Bus install is pure DB metadata

Clicking "Install bus integration" only assigns a stable agent slug + flips a row flag — Cebab writes **nothing** into the operator's project (no `.claude/settings.json` merge, no CLAUDE.md `@import`, no copied scripts, no Stop hook). Workers and chain participants run with `settingSources: ['user', 'project', 'local']` — so each participant's own `.claude/settings.json` and `.claude/settings.local.json` (MCP servers, allowed/disallowed tools, env injectors, hooks) load exactly as a standalone `claude` session in that cwd would. The "Cebab writes nothing into the project" guarantee is about _Cebab-side_ mutations; the SDK reads what the user already wrote. The orchestrator stays at `settingSources: ['user']` because its cwd is the empty Cebab-owned `<sessionFolder>/orchestrator/` — nothing to load. The bus protocol reaches each agent via a per-turn briefing Cebab prepends — `renderChainBriefing` for chain participants, `renderWorkerBriefing` for orchestrator workers, `renderRosterPrompt` for the orchestrator (its **only** prompt: no generated `CLAUDE.md`/`comm.md` — those were dead under `['user']` and were removed). Each agent's own project-root `CLAUDE.md` is also explicitly read and injected as framed prompt **text** on its first turn (`readProjectClaudeMd`) so it appears in the on-disk transcript and the operator's chat; the SDK now _additionally_ auto-loads it via the widened settingSources (small token cost, intentional). The in-process bus MCP server is registered under the namespaced key **`cebab_bus`** (not `bus`) so a participant's own `mcpServers.bus` in their `.claude/settings*.json` cannot collide with — or clobber — the identity-pinned `bus_send` injection in the merged config; agents see the tool as `mcp__cebab_bus__bus_send`.

## Bus resume (R-A + R-B)

Live sessions live in an in-process registry (`session_registry.ts`), the analogue of "tmux survived". A browser close/refresh/second window re-attaches by swapping the WS sink — the run keeps going (R-A). A Cebab **server** restart empties the registry; an **orchestrated** session is then rebuilt from durable state (`reconstruct.ts`, R-B) and re-attached **read-only** — it sets `awaiting_continue`, replays a recovery banner, and runs nothing until the operator explicitly continues (an interrupted turn's side effects are _not_ rolled back). **Chain** mode is not reconstructed yet and still falls back to `crashed`. Persisted transcripts/events always survive; single-agent resume is a separate path and is unaffected.
