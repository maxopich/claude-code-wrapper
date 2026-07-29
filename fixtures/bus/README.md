# Bus fixtures

Deterministic replay scripts for a **multi-agent** session under `MOCK=1`.

Before these existed, `MOCK=1` could start a chain or an orchestrator run but
could not advance one. Agents move a bus session forward by calling the
injected `bus_send` MCP tool, and the mock runner replayed fixture lines
without executing tool calls — so the first participant said its piece, nothing
ever reached the router, and no second participant was ever woken. Mock mode
covered the single-agent path only, which is the smaller half of the UI.

`runMock` now executes a replayed `tool_use` against the in-process MCP servers
the run was given, and consults `canUseTool` first. A fixture's `bus_send`
therefore reaches the real `handleBusSend` — identity pinning, zod validation,
byte cap and all — and the router receives a real `BusEvent`.

## Choosing a scenario

`MOCK_SCENARIO=<dir>` selects a directory here. Unset, chain runs replay
`chain/` and orchestrated runs replay `orchestrator/`.

`MOCK_INTERVAL_MS` (default 50) is the pause between replayed events. A bus
session pays it once per event per hop, so lower it when a scenario is long.

## How a file is chosen

For each turn, `resolveBusFixture(scenario, agent, turn)` takes the first that
exists:

1. `<agent>.<turn>.jsonl` — this agent, this hop
2. `<agent>.jsonl` — this agent, every hop
3. `_default.<turn>.jsonl` — any agent, this hop
4. `_default.jsonl` — any agent, every hop

Nothing matching is a hard error naming all four candidates. It does not fall
back to `hello.jsonl`: a replay that looks alive and routes nothing is the
exact failure this directory exists to remove.

A **shipped** scenario can only use forms 3 and 4 for participants, because
their agent slugs are the operator's own project names. The orchestrator is the
exception — its slug is always `orchestrator`, so `orchestrator/` addresses it
by name (turn 0 delegates, every later turn answers the operator). A test picks
its own participant names and can therefore script an individual agent.

## Placeholders

A shipped fixture cannot hardcode a recipient, so it writes `${NAME}` and the
router fills it in. Substitution happens on the raw text before it is parsed,
and values are escaped for the JSON string they land in. An unknown `${...}` is
left alone, so fixture prose containing `${HOME}` still replays.

| Variable          | Chain                                   | Orchestrator                                  |
| ----------------- | --------------------------------------- | --------------------------------------------- |
| `${SELF}`         | this participant                        | this agent                                    |
| `${NEXT}`         | next participant, or `_sink` at the end | orchestrator → its first worker; worker → n/a |
| `${KIND}`         | `reply`, or `final` on the last hop     | —                                             |
| `${ORCHESTRATOR}` | —                                       | `orchestrator`                                |
| `${USER}`         | —                                       | `user`                                        |

## Writing a new scenario

Copy a file here and edit the `bus_send` input. The format is ordinary
transcript JSONL — one `SDKMessage` per line — so a script captured from a real
run works too, as long as its `tool_use` blocks name
`mcp__cebab_bus__bus_send`.

Two rules the replay enforces:

- A `bus_send` whose input fails the tool's schema comes back as an error
  `tool_result`, exactly as the real MCP server would answer. An empty `text`
  or a missing `recipient` shows up as a failed call, not as silence.
- The mock writes the follow-up `tool_result` only for calls it executed or
  denied. A fixture that replays an allowed built-in — `Read`, `Bash` — still
  supplies its own `tool_result` line, which is what captured transcripts
  already contain.
- Every replayed `tool_use` goes through `canUseTool` first, including on the
  single-agent path. A fixture with a `Read` in it now raises a real approval
  card against an untrusted project — useful, and the reason mock mode can
  finally exercise that UI — but it means such a fixture needs a browser
  attached to answer. A headless replay (`ci_smoke`) should stick to fixtures
  whose tool calls the runtime decides on its own.
