/**
 * Multi-agent topology validator (PR-6 seam).
 *
 * Pure, runtime-aware check that a candidate template + custom layout
 * describes a topology the bus will actually execute. The constraints
 * mirror the F2/F3 source-allowlist drops in
 * [server/src/bus/orchestrator.ts](../../server/src/bus/orchestrator.ts):
 *
 *   - **No worker → worker edges.** Orchestrator workers can only send
 *     to the orchestrator; F2 drops worker→worker silently. NOTE, and see
 *     the block below: every edge this schema can express has two
 *     participant endpoints, so this rule fires on ALL of them. It is not
 *     one constraint among four — it is the one that makes the validator
 *     total.
 *   - **No self-loops.** A worker addressing itself is meaningless under
 *     the orchestrator routing model.
 *   - **No edges to/from non-participants.** F2 round-2 drops any source
 *     that isn't a known participant.
 *   - **No disconnected components.** Every participant must be
 *     reachable from the orchestrator (treated as the implicit hub),
 *     otherwise the diagram depicts a worker the bus will never wake.
 *     Checked only when `edges` is non-empty: a zero-edge layout is the
 *     default star, where every participant is hub-connected by
 *     construction.
 *
 * The custom-mode editor (NOT shipped in PR-6) MUST call this before
 * persisting. The renderer does NOT call it — invalid layouts still
 * render (they just look wrong), so the failure surface is "the editor
 * refuses to save," not "the modal crashes." Tests pin the rules.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE SHIPPING THE EDITOR (`Cebab-x1n.1.12`, register D12).
 *
 * **This validator cannot approve any non-empty layout, and that is a
 * property of the SCHEMA rather than a bug in the code below.** Work the
 * branches through: `ok` reduces to exactly `edges.length === 0`. Every edge
 * `CustomLayout` can express has two participant `projectId` endpoints, so it
 * is a worker→worker edge, so it is a violation. `topology.test.ts` pins the
 * reduction directly rather than leaving it to be rediscovered.
 *
 * TWO REPAIRS SUGGEST THEMSELVES AND BOTH WERE MEASURED AND REJECTED. Neither
 * is written here, so that whoever ships the editor starts from the numbers
 * instead of re-deriving them.
 *
 *   1. ADD A `'hub'` EDGE ENDPOINT so a layout can say worker↔hub. Then the
 *      only approvable non-empty layout is the one where every participant is
 *      hub-incident — i.e. the star that `participants` alone already
 *      describes. Enumerated over 4 participants: exactly **1** approvable
 *      non-empty layout. The field would be able to express one thing, and
 *      that thing is already derivable without it.
 *
 *   2. REREAD AN EDGE AS HUB-ANCHORED (`from → hub → to`), which the
 *      connectivity comment below already half-assumes and which the
 *      renderer stub's "derive flowPaths per hub-anchored edge" appears to
 *      support. Then `worker_to_worker` becomes unconstructible and many
 *      layouts approve — enumerated over 4 participants: **3861**. But under
 *      orchestrator routing every worker reaches every other worker via the
 *      hub, so all 3861 depict a constraint the bus does not enforce. That is
 *      the same "misleading mental model" the `broadcast` paragraph below
 *      refuses the schema for, arrived at from the other direction.
 *
 * So the honest statement is: `CustomLayout.edges` cannot currently express a
 * topology that is both LEGAL and INFORMATIVE. Fixing that is a decision about
 * what custom mode is FOR — not a patch — and it belongs with the editor's
 * owner. `protocol.ts` says `'custom'` is presentation-only and that the
 * runtime follows orchestrator routing; if that stays true, a hand-authored
 * edge set has nothing to say that `participants` does not.
 *
 * What was done instead, deliberately: the code is left alone, the claims
 * above it are made true, and the tautology is pinned. A validator that
 * silently refuses everything while its header advertises four rules is worse
 * than one that says so.
 * ─────────────────────────────────────────────────────────────────────────
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
