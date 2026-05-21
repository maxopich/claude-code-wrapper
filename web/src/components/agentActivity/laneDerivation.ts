/**
 * Pure helpers that derive the per-agent lane view from a `MultiAgentRun`.
 *
 * No React, no DOM, no store reads — everything is parameterized so the
 * lane-derivation logic can be unit-tested in isolation. The components
 * (`AgentLanes`, `AgentLane`) consume the output directly.
 *
 * Three concepts:
 *   - **Participants**: agents Cebab knows about (from
 *     `run.participantAgentNames`). Always rendered as a lane even if they
 *     have zero activity yet (e.g. workers added but never delivered to).
 *   - **Chrome sentinels** (`user`, `_sink`, `cebab`): NOT participants,
 *     never get their own lane. `user`/`_sink` may appear as event source or
 *     destination; we route those hops to the corresponding real-agent lane
 *     instead (see `relatesToAgent`).
 *   - **Ordering**: lanes are sorted by `lastActivityTs` descending so the
 *     most-recently-active agent is leftmost. Lanes with no activity sort
 *     to the right (stable order = participant order).
 *
 * Bidirectional hop convention (per CLAUDE.md): each event row is shown
 * **once** per relevant lane — outgoing in the sender's lane, incoming
 * (muted) in the destination's lane. Never both, never neither.
 *
 * Chain-mode `_sink`: a hop with `destination: '_sink'` does NOT spawn a
 * phantom lane; we render it only in the sender's lane (outgoing) as the
 * terminal hop. Similarly, `destination: 'user'` only renders outgoing on
 * the sender side — the operator IS the user, no "incoming-from-X" row is
 * meaningful.
 */
import type { MultiAgentEventView, MultiAgentRun } from '../../store';

/** Chrome sentinels that are never real participants and never get a lane. */
export const CHROME_SENTINELS: ReadonlySet<string> = new Set(['user', '_sink', 'cebab']);

/** Whether a name is a real agent (a candidate lane). */
export function isRealAgent(name: string): boolean {
  return name.length > 0 && !CHROME_SENTINELS.has(name);
}

/** One row in a lane's activity feed. */
export type LaneRow = {
  /** The originating event. */
  event: MultiAgentEventView;
  /**
   * `outgoing` — this lane's agent IS the source.
   * `incoming` — this lane's agent IS the destination (muted render).
   * `terminal` — this lane's agent is the source AND the destination is a
   *   chrome sentinel (`user` / `_sink`). Rendered outgoing-style but with
   *   a "to user" / "→ end of chain" badge instead of a peer destination.
   */
  direction: 'outgoing' | 'incoming' | 'terminal';
};

/** One agent's lane summary — header data + the rows we'll render. */
export type Lane = {
  agentName: string;
  /** When this lane last saw activity (max event ts across rows). 0 if none. */
  lastActivityTs: number;
  /** Total event count for the header counter. */
  eventCount: number;
  rows: LaneRow[];
};

/** Maximum lanes the operator sees side-by-side. The rest collapse into the
 *  `+N more` overflow popover. Locked at 4 for v1. */
export const LANE_CAP = 4;

/**
 * Build the lane list for a run. Returns lanes in display order
 * (most-recent-activity first; participants with no activity preserve their
 * roster order, after the active ones).
 *
 * The classification rule for each event:
 *   - Real-source → put `outgoing` (or `terminal` if dest is chrome) in
 *     the source's lane.
 *   - Real-destination AND real-source AND src !== dest → put `incoming`
 *     in the destination's lane.
 *   - Chrome-source (e.g. `cebab → orchestrator kind=prompt`): no
 *     "outgoing" row (cebab has no lane). Render as `incoming` in the
 *     destination's lane.
 *
 * The same event can therefore appear once OR twice across all lanes; never
 * zero times (unless it's chrome→chrome, which the bus doesn't emit).
 */
export function deriveLanes(run: MultiAgentRun): Lane[] {
  // Seed with every declared participant (preserves order for the no-activity
  // case). A Set dedupes if a participant appears in events too.
  const names = new Set<string>();
  for (const n of run.participantAgentNames) {
    if (isRealAgent(n)) names.add(n);
  }
  // Defensive: a runaway sender/destination not in the roster still gets a
  // lane so the UI never silently drops events.
  for (const ev of run.events) {
    if (isRealAgent(ev.source)) names.add(ev.source);
    if (isRealAgent(ev.destination)) names.add(ev.destination);
  }

  const lanes = new Map<string, Lane>();
  for (const name of names) {
    lanes.set(name, { agentName: name, lastActivityTs: 0, eventCount: 0, rows: [] });
  }

  for (const ev of run.events) {
    const srcReal = isRealAgent(ev.source);
    const dstReal = isRealAgent(ev.destination);
    const dstIsChromeSentinel =
      !dstReal && (ev.destination === 'user' || ev.destination === '_sink');

    if (srcReal) {
      const lane = lanes.get(ev.source)!;
      const direction: LaneRow['direction'] = dstIsChromeSentinel ? 'terminal' : 'outgoing';
      lane.rows.push({ event: ev, direction });
      lane.eventCount += 1;
      if (ev.ts > lane.lastActivityTs) lane.lastActivityTs = ev.ts;
    }

    if (dstReal && ev.source !== ev.destination) {
      const lane = lanes.get(ev.destination)!;
      lane.rows.push({ event: ev, direction: 'incoming' });
      lane.eventCount += 1;
      if (ev.ts > lane.lastActivityTs) lane.lastActivityTs = ev.ts;
    }
  }

  // Sort: most-recently-active first; idle lanes preserve participant-roster
  // order. We rely on Map iteration order being insertion order and stable
  // sort to keep idle lanes in roster order behind active ones.
  const result = [...lanes.values()];
  result.sort((a, b) => b.lastActivityTs - a.lastActivityTs);
  return result;
}

/** Split lanes into the visible set + the overflow set, capped at `LANE_CAP`. */
export function splitVisibleAndOverflow(lanes: Lane[]): { visible: Lane[]; overflow: Lane[] } {
  if (lanes.length <= LANE_CAP) return { visible: lanes, overflow: [] };
  return { visible: lanes.slice(0, LANE_CAP), overflow: lanes.slice(LANE_CAP) };
}
