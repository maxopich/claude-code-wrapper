/**
 * Cluster I Phase C4 (UI_Findings spec §4.2): the WS-facing delegate for the
 * `search_sessions` ClientMsg. Mirrors `bulk_session_op.ts`'s "thin executor"
 * pattern so the handler in `ws/server.ts` is a one-liner and the audit-
 * authorization logic stays unit-testable without standing up a Conn.
 *
 * Split of concerns:
 *   - `repo/search.ts` owns the LIKE scan + the containment-preserving
 *     redaction (pure DB+redaction; same DB → same output).
 *   - THIS module owns the privilege gate: a `raw` (unredacted) search is an
 *     operator opt-in that MUST leave a forensic trail before any unredacted
 *     byte ships.
 *
 * Raw-search audit (privacy invariant, spec §3 C4 / C4-3). On `raw: true` we
 * write a `session.searched` / `searched_raw` safety_audit row BEFORE running
 * the (raw) scan — the BE-1 posture from the C2 raw-export endpoint: if we
 * can't record the operator's intent to read unredacted content, we don't ship
 * it. A failed audit write DOWNGRADES the request to a normal redacted search
 * (which needs no audit) rather than erroring — the operator still gets
 * results, just masked, and the reply's `raw: false` tells the UI so.
 *
 * The audit payload deliberately OMITS the literal query string. A raw search
 * is often FOR a secret (an operator hunting a leaked token), and safety_audit
 * rows are append-only + survive session deletion (spec §7) — persisting the
 * query verbatim would immortalize the very secret the search was chasing. We
 * record the forensically-useful shape (`scope`, `includeArchived`,
 * `queryLength`) without the content.
 */
import type { ClientMsg, ServerMsg } from '@cebab/shared';
import { appendSafetyAudit } from './notifications/safety_audit.js';
import { searchSessions } from './repo/search.js';

export type SearchSessionsInput = Extract<ClientMsg, { type: 'search_sessions' }>;

export function executeSearchSessions(args: {
  msg: SearchSessionsInput;
  send: (msg: ServerMsg) => void;
  /** Injection seam for tests — defaults to the real append. */
  appendAudit?: typeof appendSafetyAudit;
}): void {
  const { msg, send } = args;
  const append = args.appendAudit ?? appendSafetyAudit;

  // Resolve whether this turn is allowed to return unredacted snippets. A raw
  // request must be audit-backed; if the audit write throws we fall back to a
  // redacted scan (single scan in all paths — we decide BEFORE scanning).
  let useRaw = msg.raw === true;
  if (useRaw) {
    try {
      append({
        ts: Date.now(),
        kind: 'session.searched',
        reasonCode: 'searched_raw',
        payload: {
          scope: msg.scope,
          includeArchived: msg.includeArchived === true,
          // Length only — never the literal query (see module header).
          queryLength: msg.query.length,
        },
      });
    } catch (err) {
      console.error(
        '[search_sessions] raw-search audit append failed; downgrading to redacted',
        err,
      );
      useRaw = false;
    }
  }

  const { results, truncated } = searchSessions({
    query: msg.query,
    scope: msg.scope,
    projectId: msg.projectId,
    includeArchived: msg.includeArchived,
    raw: useRaw,
    limit: msg.limit,
  });

  send({
    type: 'search_results',
    query: msg.query,
    scope: msg.scope,
    results,
    raw: useRaw,
    truncated,
  });
}
