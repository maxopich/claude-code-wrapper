import type { RouterDropSnapshot } from '@cebab/shared/protocol';
import { isRouterDropReasonCode } from '@cebab/shared/protocol';
import { getDb } from '../db.js';

/**
 * `Cebab-vie.33` — the router-drop history a re-attaching browser is told
 * about, so the `RouterDropsCounter` chip is not silently emptied on refresh.
 *
 * Drops were client-accumulated: `MultiAgentRun.routerDrops` filled only from
 * the live `router_drop` ServerMsg and was reset to `[]` on every attach, so a
 * browser refresh discarded the chip's history while the router kept dropping.
 * `Cebab-vie.6` then made a restored mute VISIBLE, which turned the empty chip
 * beside a visible mute into an active lie — the operator could see alpha was
 * muted and still not see that eleven of its replies had been discarded since.
 *
 * The data was already durable. `dispatchRouterDrop` (both routers) writes a
 * `safety_audit` row per drop — `kind='router.drop'`, `payload_json` holding
 * `{ source, destination, kind }`, `reason_code` the `RouterDropReasonCode` —
 * BEFORE it emits the live envelope. So a session-scoped query reconstructs the
 * exact list the client would have accumulated.
 *
 * MIND THE ID. The live wire's `router_drop.auditRowId` is NOT the safety_audit
 * row id, despite the field name and the protocol comment: `dispatchRouterDrop`
 * sends `result.id` from the dispatcher, which is the NOTIFICATION envelope id
 * (`emit` returns `env.id`, a fresh uuid, while `notifications.audit_row_id`
 * carries the safety_audit id). The client dedupes and deep-links by that value,
 * so the rehydrated snapshot MUST carry the same one — otherwise the same drop
 * would show two different ids across a reload, and a future re-emit-on-attach
 * would fail to dedupe. Hence the join: the audit row holds the payload, the
 * notification row holds the id the wire used. (The wire field's name and the
 * protocol comment both still say "safety_audit.id" — a stale-doc defect noted
 * for a separate follow-up, not fixed here.)
 *
 * This is the ONE place that list is built. All three `multi_agent_started`
 * sites in `ws/server.ts` call it, including the two fresh-start ones where it
 * necessarily returns `[]` — same reasoning as `buildParticipantControlSnapshots`
 * (Cebab-vie.6): a site free to hand-write `[]` is a site that can be wrong
 * while looking right, and here "wrong" is invisible, because an empty array is
 * exactly what a session with no drops sends.
 *
 * Its own module rather than a helper inside `ws/server.ts` so it can be tested
 * against a scratch DB without importing the server — the same reason
 * `participant_control_snapshot.ts` is its own file.
 *
 * NOT capped. Unlike the control snapshot the drop list is unbounded in a long
 * session, but the chip's count IS the signal and a cap would understate it
 * without a second "total" field; the `multi_agent_event` replay ordered right
 * after this on the same envelope is deliberately uncapped (`Cebab-3nt`), and
 * drops are a subset of the events it already ships. Ordered by `rowid` so the
 * rehydrated list matches the append order the client accumulated live.
 */

type Row = {
  /** `notifications.id` — the value the live `router_drop` wire carried as
   *  `auditRowId`, so a rehydrated drop keeps the id the operator already saw. */
  wire_id: string;
  ts: number;
  reason_code: string;
  payload_json: string;
};

export function buildRouterDropSnapshots(sessionId: string): RouterDropSnapshot[] {
  // INNER JOIN: a safety-class emit always persists its notification row (the
  // dispatcher does so unconditionally), so the 1:1 link holds for every
  // router.drop. A row that somehow lacks its notification is dropped rather
  // than shipped with a mismatched id — count off by one beats a wrong id.
  const rows = getDb()
    .prepare<[string], Row>(
      `SELECT n.id AS wire_id, sa.ts AS ts, sa.reason_code AS reason_code,
              sa.payload_json AS payload_json
       FROM safety_audit sa
       JOIN notifications n ON n.audit_row_id = sa.id
       WHERE sa.session_id = ?
         AND sa.kind = 'router.drop'
       ORDER BY sa.rowid ASC`,
    )
    .all(sessionId);

  const out: RouterDropSnapshot[] = [];
  for (const row of rows) {
    // A drop row is always written from a typed `RouterDropReasonCode`, so a
    // miss here is a corrupt or future-vocabulary row. Bail on it rather than
    // ship an unvalidated string the client's typed reducer can't render —
    // same posture `findLatestControlReason` takes. Understating the count by
    // one unreadable row is the lesser harm.
    if (!isRouterDropReasonCode(row.reason_code)) continue;

    // The per-drop context (source / destination / kind) lives in the audit
    // payload, exactly as `dispatchRouterDrop` wrote it. A row that fails to
    // parse or is missing a field is skipped for the same reason as an
    // unreadable reason code.
    let payload: { source?: unknown; destination?: unknown; kind?: unknown };
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      continue;
    }
    if (
      typeof payload.source !== 'string' ||
      typeof payload.destination !== 'string' ||
      typeof payload.kind !== 'string'
    ) {
      continue;
    }

    out.push({
      auditRowId: row.wire_id,
      reasonCode: row.reason_code,
      source: payload.source,
      destination: payload.destination,
      kind: payload.kind,
      ts: row.ts,
    });
  }
  return out;
}
