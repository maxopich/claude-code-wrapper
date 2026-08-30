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
 * SO ITS ONLY CONSUMER TODAY IS `topology.test.ts`, and that is expected until
 * the editor lands. Register N07 read that as dead code and proposed deleting
 * it; the code is fine, and what was actually wrong was a claim about it —
 * `protocol.ts` called this "the runtime check", which it is not. That claim is
 * corrected there, and `scripts/exportConsumers.test.mjs` records this verdict
 * so the next unused-export sweep does not re-open it. If the custom-mode work
 * is abandoned rather than deferred, delete this module WITH that decision, not
 * because a grep found no callers.
 *
 * **Why no worker→user rule here (register N08):** the F2 worker→user drop is
 * real, but it is a RUNTIME routing rule (`RouterDropReasonCode.worker_to_user`
 * in `orchestrator.ts` / `chain.ts`), not a topology one. A `CustomLayout` edge
 * has two participant `projectId` endpoints and no `'user'` sentinel — so a
 * worker→user edge is inexpressible in this schema and the validator can never
 * see one. A `worker_to_user` variant of `TopologyViolation` therefore had no
 * producing branch; it was declared, never constructed, and is removed. If the
 * future editor ever adds a `'user'` edge endpoint, add the rule AND its variant
 * together, not one without the other. `topology.test.ts` fences this: the
 * declared `code` union must match the set the validator can actually emit.
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
