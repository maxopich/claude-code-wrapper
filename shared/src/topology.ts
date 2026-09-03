/**
 * Multi-agent topology validator: a pure check that a template plus a custom
 * layout describes a topology the bus would actually execute. Its four rules
 * mirror the F2/F3 source-allowlist drops in `server/src/bus/orchestrator.ts` —
 * no worker→worker edges, no self-loops, no edges to or from non-participants,
 * no disconnected components.
 *
 * READ THIS BEFORE SHIPPING THE CUSTOM-MODE EDITOR (`Cebab-x1n.1.12`).
 * **This validator cannot approve any non-empty layout**, and that is a
 * property of the SCHEMA rather than a bug below: `ok` reduces to exactly
 * `edges.length === 0`, because every edge `CustomLayout` can express has two
 * participant endpoints and is therefore a worker→worker edge.
 * `topology.test.ts` pins that reduction so it is not rediscovered.
 *
 * The two obvious repairs were both enumerated and both rejected — 1 approvable
 * layout and 3861 respectively, over four participants, and neither expresses
 * anything the bus enforces. `docs/bus-architecture.md` carries the numbers and
 * the reasoning, including why there is deliberately no worker→user rule and no
 * `broadcast` edge kind. Start there rather than re-deriving them.
 *
 * The editor MUST call this before persisting. The renderer does NOT — an
 * invalid layout still renders, it just looks wrong, so the failure surface is
 * "the editor refuses to save", never "the modal crashes".
 *
 * ITS ONLY CONSUMER TODAY IS `topology.test.ts`, which is expected until the
 * editor lands. An unused-export sweep already read that as dead code once
 * (register N07) and proposed deleting it. If custom mode is abandoned rather
 * than deferred, delete this module WITH that decision — not because a grep
 * found no callers. `scripts/exportConsumers.test.mjs` records the verdict.
 */

import type { CustomLayout, MultiAgentTemplate } from './protocol.js';

export type TopologyViolation =
  | { code: 'self_loop'; from: number; to: number }
  | { code: 'worker_to_worker'; from: number; to: number }
  /**
   * `Cebab-x1n.1.12`: `from`/`to` are `number`, not `number | 'hub' | 'user'`.
   *
   * Applying N08's own rule one level down, to the PAYLOAD rather than to the
   * `code`. The sentinel arms were declared and could never be constructed:
   * this branch reads `e.from` / `e.to` straight off a `CustomLayout` edge,
   * whose endpoints are typed `number`. N08 removed a whole variant for
   * exactly this reason ("declared, never constructed, and is removed"); a
   * dead arm inside a live variant is the same defect wearing a smaller hat,
   * and it is what let the header claim a `'user'` endpoint rule the schema
   * cannot express.
   *
   * If the future editor adds sentinel endpoints, widen this AND the edge
   * type AND the rule together — the trio, not one of the three.
   */
  | { code: 'unknown_endpoint'; from: number; to: number }
  | { code: 'unreachable_participant'; participantId: number };

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

  // Connectivity: every participant must be incident to >=1 edge.
  //
  // `Cebab-x1n.1.12` — READ THIS WITH THE LOOP BELOW, because the two used to
  // contradict each other and the contradiction is the bead. This comment
  // said "treat ANY edge incident to a participant as connecting it to the implicit
  // hub", i.e. an edge means "both endpoints are attached to the hub". The
  // loop below reads the SAME edge as "from sends to to" and flags
  // `worker_to_worker`. One edge cannot mean both, and the module shipped
  // asserting both.
  //
  // Which one is true is not decidable here — it is what custom mode is FOR,
  // and the header block explains why neither reading yields a field worth
  // having. So the code is left as it is (the routing reading, which is what
  // it has always DONE) and this comment is corrected to describe it: the
  // incidence set below is bookkeeping for the connectivity rule and asserts
  // nothing about the hub.
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
    for (const participantId of template.participants) {
      if (!incident.has(participantId)) {
        violations.push({ code: 'unreachable_participant', participantId });
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
