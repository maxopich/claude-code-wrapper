/**
 * `Cebab-vie.8`: who, if anyone, a bus run's durable event tail says is
 * computing.
 *
 * Bus routing is turn-based: a `bus_send` that survives the router's checks is
 * persisted and then wakes exactly one recipient, so the last persisted event's
 * `destination` — when it is a real agent — is the agent now running. The web
 * activity bar has inferred the working agent that way since the bar existed,
 * and it is the correct inference right up to the moment a delivery is made and
 * the reply never comes back.
 *
 * That moment is `Cebab-vie.8`. Mute a worker mid-delegation and its reply is
 * dropped at the router BEFORE the persist, so the tail keeps naming the worker
 * the orchestrator delivered to; nothing is running, nothing ever will be, and
 * the bar counts a timer past seven minutes. The server now detects that state
 * and writes an operator-facing note (`server/src/bus/quiescence.ts`), and the
 * note's own row is what makes the tail stop pointing at an agent.
 *
 * WHICH IS WHY THE RULE IS SHARED RATHER THAN RESTATED. The detector must fire
 * on exactly the tails the bar would otherwise call "working" — one condition,
 * evaluated by one function, on the server before the note and in the browser
 * after it. Two spellings of it could disagree about a single event kind, and
 * the disagreement would be invisible: either the run is labelled stranded
 * while the bar still says working, or the note never comes and the bar lies
 * exactly as before. Nothing downstream would say which copy was right.
 */

/**
 * Destinations that are not agents. `user` is the operator (only the
 * orchestrator may address it), `_sink` is the chain terminator, and `cebab`
 * appears as a SOURCE on Cebab-authored rows — it is listed because a
 * destination is compared against this set and a future Cebab-to-Cebab row
 * must not read as a wake.
 *
 * `orchestrator` is deliberately absent: it is a real participant that runs
 * real turns, so a tail pointing at it means the orchestrator is working.
 *
 * Server-side these three live as the individual constants `USER_RECIPIENT` /
 * `SINK_RECIPIENT` / `CEBAB_SOURCE` in `server/src/bus/runtime.ts`, which is
 * where the routers need them one at a time; `shared/src/bus_tail.test.ts`
 * pins the two against each other so a fourth spelling cannot appear quietly.
 */
export const BUS_SENTINEL_RECIPIENTS: ReadonlySet<string> = new Set(['_sink', 'user', 'cebab']);

/** The shape both readers have: the last persisted `multi_agent_events` row. */
export type BusTailEvent = { destination: string; kind: string };

/**
 * Whether this tail means "an agent was woken and has not answered yet".
 *
 * `null` (no events at all) is false — a run that has not started cannot be
 * waiting on anybody.
 *
 * `kind === 'error'` is false even for an agent destination, and that arm is
 * load-bearing in both directions. Cebab's own stop-reason rows are written
 * `cebab → user kind=error` and would be excluded by the sentinel check
 * anyway; what this arm actually catches is a participant-emitted `error`
 * addressed to a peer, which the router persists and delivers. Treating it as
 * a live delivery would be defensible — but the bar has excluded it since
 * `activeAgent` was written, and the detector exists to match the bar, not to
 * quietly re-decide a case nobody asked about.
 */
export function tailAwaitsAgent(tail: BusTailEvent | null | undefined): boolean {
  if (!tail) return false;
  if (tail.kind === 'error') return false;
  return !BUS_SENTINEL_RECIPIENTS.has(tail.destination);
}
