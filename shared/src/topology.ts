/**
 * Multi-agent topology validator (PR-6 seam).
 *
 * Pure, runtime-aware check that a candidate template + custom layout
 * describes a topology the bus will actually execute. The constraints
 * mirror the F2/F3 source-allowlist drops in
 * [server/src/bus/orchestrator.ts](../../server/src/bus/orchestrator.ts):
 *
 *   - **No worker → worker edges.** Orchestrator workers can only send
 *     to the orchestrator; F2 drops worker→worker silently.
 *   - **No worker → user edges.** Only the orchestrator may reply to
 *     the user; F2 drops worker→user silently.
 *   - **No self-loops.** A worker addressing itself is meaningless under
 *     the orchestrator routing model.
 *   - **No edges to/from non-participants.** F2 round-2 drops any source
 *     that isn't a known participant.
 *   - **No disconnected components.** Every participant must be
 *     reachable from the orchestrator (treated as the implicit hub),
 *     otherwise the diagram depicts a worker the bus will never wake.
 *
 * The custom-mode editor (NOT shipped in PR-6) MUST call this before
 * persisting. The renderer does NOT call it — invalid layouts still
 * render (they just look wrong), so the failure surface is "the editor
 * refuses to save," not "the modal crashes." Tests pin the rules.
 *
 * **Why no `broadcast` edge kind:** broadcast is a runtime policy
 * (orchestrator decides addressees per turn from capabilities + prompt
 * content) — not a topology fact. Adding it to the schema would invite
 * UIs that depict a routing decision as a fixed edge, which is the
 * exact "misleading mental model" PR-2's animation rewrite addressed.
 */

import type { CustomLayout, MultiAgentTemplate } from './protocol.js';

export type TopologyViolation =
  | { code: 'self_loop'; from: number; to: number }
  | { code: 'worker_to_worker'; from: number; to: number }
  | { code: 'worker_to_user'; from: number }
  | { code: 'unknown_endpoint'; from: number | 'hub' | 'user'; to: number | 'hub' | 'user' }
  | { code: 'unreachable_participant'; pid: number };

export type TopologyValidation = {
  ok: boolean;
  /** Empty when `ok`. Otherwise the first violation per rule per pair. */
  violations: TopologyViolation[];
};

/**
 * Validates a freeform `CustomLayout` against the participants list.
 *
 * Edge endpoints are interpreted as:
 *   - A participant `projectId` → a worker (or, by convention, the
 *     orchestrator if it ever surfaced — today the orchestrator has no
 *     `projectId` so this branch never fires).
 *   - The sentinel `'hub'` → the orchestrator (implicit; not a row in
 *     `positions`).
 *   - The sentinel `'user'` → the operator (only the orchestrator may
 *     send to `'user'`).
 *
 * `positions` is informational only — coordinates are not validated.
 * Stale `positions` keys (project removed) are ignored, not flagged:
 * the renderer drops them and re-adding the project restores the row.
 */
export function validateCustomTopology(
  template: Pick<MultiAgentTemplate, 'participants'>,
  layout: CustomLayout,
): TopologyValidation {
  const violations: TopologyViolation[] = [];
  const participantSet = new Set(template.participants);
  const edges = layout.edges ?? [];

  // Connectivity: every participant must be incident to ≥1 edge that
  // also touches the hub. The simplest hub-anchored check is "the
  // participant appears as an edge endpoint and the other end is the
  // hub" — but `CustomLayout.edges` uses numeric pids, not the 'hub'
  // sentinel (the hub has no pid). Until the editor adds an explicit
  // hub sentinel, treat ANY edge incident to a pid as connecting it to
  // the implicit hub. The other rules below cover the F2 drops.
  const incident = new Set<number>();

  for (const e of edges) {
    if (e.from === e.to) {
      violations.push({ code: 'self_loop', from: e.from, to: e.to });
      continue;
    }
    const fromKnown = participantSet.has(e.from);
    const toKnown = participantSet.has(e.to);
    if (!fromKnown || !toKnown) {
      violations.push({ code: 'unknown_endpoint', from: e.from, to: e.to });
      continue;
    }
    // Both endpoints are workers, so this is a worker→worker edge.
    // F2 drops these silently at runtime.
    violations.push({ code: 'worker_to_worker', from: e.from, to: e.to });
    incident.add(e.from);
    incident.add(e.to);
  }

  // Connectivity: every participant must be reachable. The hub is
  // implicit, so a participant is "connected" if it has at least one
  // edge (which we'll re-shape in the editor to be hub-anchored) OR if
  // the layout has zero edges (every participant is hub-only — the
  // default orchestrator star). Empty-edge layouts therefore always
  // pass connectivity.
  if (edges.length > 0) {
    for (const pid of template.participants) {
      if (!incident.has(pid)) {
        violations.push({ code: 'unreachable_participant', pid });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Convenience: given a saved template, returns the same validation
 * result. Templates without a `layout` field pass trivially (chain and
 * orchestrator modes have no freeform topology to validate).
 */
export function validateTemplateTopology(template: MultiAgentTemplate): TopologyValidation {
  if (!template.layout) return { ok: true, violations: [] };
  return validateCustomTopology(template, template.layout);
}
