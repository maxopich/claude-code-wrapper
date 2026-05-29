// Cluster G Phase 3 (G1): builds the `active_runs` ServerMsg from the
// in-process lifecycle registry. Pure projection — no side effects, no DB
// writes, no notifications. The WS layer wires this with a per-Conn
// debounce + heartbeat and pushes the result over the socket.
//
// The split keeps the wire shape testable in isolation: we feed
// `buildActiveRunsMsg` a fixture snapshot + a project-name resolver and
// assert the envelope. The debouncer/heartbeat live in `ws/server.ts`
// where the Conn lifecycle already lives, so this module stays free of
// timer state.

import type { ServerMsg } from '@cebab/shared/protocol';
import type { InFlightMeta } from '../runner/lifecycle.js';

/**
 * Resolver hook the caller injects so we can look up project names without
 * binding this module to a specific DB API. In production it's a thin
 * `getProject(id)?.name` wrapper from `repo/projects.ts`; tests inject an
 * in-memory Map for isolation.
 */
export type ProjectNameResolver = (projectId: number) => string | undefined;

export type ActiveRunsMsg = Extract<ServerMsg, { type: 'active_runs' }>;
export type ActiveRunEntry = ActiveRunsMsg['runs'][number];

/**
 * Project a registry snapshot into the wire envelope. `now` is injected so
 * tests can pin `elapsedMs` without relying on `Date.now()`; production
 * callers pass `Date.now()` at emit time.
 *
 * The envelope is built deterministically: rows are emitted in the order
 * the registry returns them (insertion / Map order), and projectName is
 * resolved best-effort — a missing project (deleted mid-session, possible
 * during rename / unmount) drops the field rather than failing the whole
 * snapshot.
 */
export function buildActiveRunsMsg(
  snapshot: InFlightMeta[],
  resolveProjectName: ProjectNameResolver,
  now: number,
): ActiveRunsMsg {
  const runs: ActiveRunEntry[] = snapshot.map((m): ActiveRunEntry => {
    const projectName = m.projectId !== undefined ? resolveProjectName(m.projectId) : undefined;
    return {
      sessionId: m.sessionId,
      ...(m.projectId !== undefined ? { projectId: m.projectId } : {}),
      ...(projectName !== undefined ? { projectName } : {}),
      kind: m.kind,
      startedAt: m.startedAt,
      // Floor at 0 so a system-clock walk-back between register and emit
      // (e.g. an NTP slew) doesn't surface a negative duration to the UI.
      // The unit-test-injected `now` parameter makes this deterministic.
      elapsedMs: Math.max(0, now - m.startedAt),
    };
  });
  return { type: 'active_runs', runs };
}
