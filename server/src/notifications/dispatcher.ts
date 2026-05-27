import { randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import type {
  NotificationAction,
  NotificationClass,
  NotificationEnvelope,
  NotificationSeverity,
  ServerMsg,
} from '@cebab/shared';
import { appendSafetyAudit } from './safety_audit.js';

/**
 * Cluster A Phase 1: single fan-out point for all WS notifications.
 *
 * Domain runtime (router drops, env scrubs, rate-limit replies, etc.) NEVER
 * emits `type: 'notification'` ServerMsgs directly — it calls `dispatcher.emit`.
 * That funnel is where the load-bearing invariants live:
 *
 *   1. Safety class dual-writes safety_audit BEFORE sending the WS envelope
 *      (spec BE-1). If the audit write throws, `emit` returns failure and
 *      the caller MUST refuse to proceed — propagating the failure all the
 *      way up to a top-level "safety log unavailable" banner.
 *   2. Operational class coalesces by `dedupeKey` within tier-specific
 *      windows (spec BE-2). Subsequent emits within the window suppress
 *      the envelope but bump the in-memory count, recorded so a Phase 5
 *      inbox panel can render historical bursts.
 *   3. Safety class is NEVER coalesced at the recording layer (BE-2). A
 *      burst of 200 router drops produces 200 audit rows + 200 envelopes;
 *      the UI is responsible for display coalescing (UI-9 ×N badge).
 *   4. Sticky operational + ALL safety persist to the notifications table
 *      for WS-attach replay (BE-4 + BE-5).
 *
 * The `send` callback is the only WS coupling — the dispatcher itself has
 * no knowledge of `Conn`. This makes it test-friendly (pass a spy callback)
 * and decouples ack-replay (per-Conn fan-out at attach time) from emission
 * (application-driven, ws-agnostic).
 */

type CoalesceWindow = {
  /** Most recent envelope's id, in case future telemetry wants to correlate. */
  envelopeId: string;
  /** Wall-clock ms of the most recent send. */
  lastSentAt: number;
  /** Total emits in the current window (including suppressed ones). */
  count: number;
  /** Wall-clock ms at which the window expires. */
  expiry: number;
};

/**
 * Per-tier coalesce window. The dispatcher suppresses additional sends for
 * the same `dedupeKey` until the window expires; safety class is excluded
 * entirely (it never coalesces).
 *
 * `progress` is a UI-side rendering of `info` with an indeterminate-spinner
 * action — at the wire level it's a normal `info` envelope, so it inherits
 * the info window. The spec's "progress: never" coalesce applies to the
 * client's animation behaviour, not the server's emit suppression.
 */
const COALESCE_WINDOWS_MS: Record<NotificationSeverity, number> = {
  info: 10_000,
  success: 5_000,
  warn: 5_000,
  error: 2_000,
  // `danger` is on this map for type completeness; the safety class
  // codepath never consults it (no coalesce at the recording layer).
  danger: 0,
};

/**
 * Module-scoped LRU for in-window dedupe. Keyed by `dedupeKey`. Bounded
 * implicitly by the coalesce window — entries past `expiry` are skipped
 * over by `emit` itself (no GC daemon needed for v1).
 *
 * Single-process: there is one WS server per Cebab process; the dispatcher
 * fans envelopes to whichever `send` callback the caller passes. Cross-tab
 * sharing of coalesce state is out of scope per OQ-10 (per-connection v1).
 */
const coalesceState = new Map<string, CoalesceWindow>();

export type DispatcherEmitInput = {
  class: NotificationClass;
  severity: NotificationSeverity;
  dedupeKey: string;
  title: string;
  message?: string;
  details?: unknown;
  sessionId?: string;
  projectId?: number;
  action?: NotificationAction;
  /** Defaults: sticky=true for safety; sticky=false for operational. */
  sticky?: boolean;
  /** Safety class only; required. Enumerated sub-code per the §7 floor. */
  reasonCode?: string;
  /** Safety class only. Wall-clock ms — defaults to Date.now() at emit. */
  auditTs?: number;
  /** Safety class only. Kind for the safety_audit row (e.g. 'router.drop'). */
  auditKind?: string;
  /** Safety class only. Free-form audit payload (JSON-serialised at append). */
  auditPayload?: unknown;
  /** Safety class only. Forensic agent attribution (bus slug). */
  auditAgentId?: string;
  /** Safety class only. Session lineage pointer (XCT-1). */
  auditParentSessionId?: string;
};

export type DispatcherEmitResult =
  | { ok: true; id: string; sent: boolean; coalescedInto?: string }
  | {
      ok: false;
      error: 'audit_write_failed' | 'safety_missing_reason_code' | 'safety_missing_audit_kind';
    };

/** Test-only: clear the coalesce LRU between test cases. */
export function _resetCoalesceState(): void {
  coalesceState.clear();
}

/**
 * Persist a notification row (sticky operational or any safety event).
 * Non-sticky operational notifications are transient — they exist on the
 * wire only and do not land here.
 */
function persistNotification(env: NotificationEnvelope): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO notifications
      (id, ts, severity, class, dedupe_key, title, message, details_json,
       session_id, project_id, action_json, sticky, audit_row_id, reason_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    env.id,
    env.ts,
    env.severity,
    env.class,
    env.dedupeKey,
    env.title,
    env.message ?? null,
    env.details === undefined ? null : JSON.stringify(env.details),
    env.sessionId ?? null,
    env.projectId ?? null,
    env.action ? JSON.stringify(env.action) : null,
    env.sticky ? 1 : 0,
    env.auditRowId ?? null,
    env.reasonCode ?? null,
  );
}

export function emit(
  input: DispatcherEmitInput,
  send: (msg: ServerMsg) => void,
): DispatcherEmitResult {
  const now = Date.now();

  if (input.class === 'safety') {
    if (!input.reasonCode) return { ok: false, error: 'safety_missing_reason_code' };
    if (!input.auditKind) return { ok: false, error: 'safety_missing_audit_kind' };

    let auditId: string;
    try {
      const ts = input.auditTs ?? now;
      const result = appendSafetyAudit({
        ts,
        sessionId: input.sessionId ?? null,
        parentSessionId: input.auditParentSessionId ?? null,
        agentId: input.auditAgentId ?? null,
        kind: input.auditKind,
        reasonCode: input.reasonCode,
        payload: input.auditPayload ?? null,
      });
      auditId = result.id;
    } catch (err) {
      // BE-1: caller MUST refuse to proceed. Log so operators can correlate.
      console.error('[notifications] safety_audit append failed', err);
      return { ok: false, error: 'audit_write_failed' };
    }

    const env: NotificationEnvelope = {
      id: randomUUID(),
      ts: now,
      severity: input.severity,
      class: 'safety',
      dedupeKey: input.dedupeKey,
      title: input.title,
      message: input.message,
      details: input.details,
      sessionId: input.sessionId,
      projectId: input.projectId,
      action: input.action,
      // Safety defaults to sticky so the operator sees it across reload;
      // explicit `sticky: false` is honoured but discouraged.
      sticky: input.sticky ?? true,
      auditRowId: auditId,
      reasonCode: input.reasonCode,
    };
    persistNotification(env);
    send({ type: 'notification', ...env });
    return { ok: true, id: env.id, sent: true };
  }

  // Operational class — LRU coalesce by dedupeKey within tier window.
  const window = COALESCE_WINDOWS_MS[input.severity];
  const existing = coalesceState.get(input.dedupeKey);
  if (existing && existing.expiry > now) {
    existing.count += 1;
    return { ok: true, id: existing.envelopeId, sent: false, coalescedInto: existing.envelopeId };
  }

  const env: NotificationEnvelope = {
    id: randomUUID(),
    ts: now,
    severity: input.severity,
    class: 'operational',
    dedupeKey: input.dedupeKey,
    title: input.title,
    message: input.message,
    details: input.details,
    sessionId: input.sessionId,
    projectId: input.projectId,
    action: input.action,
    sticky: input.sticky ?? false,
  };
  if (env.sticky) persistNotification(env);
  send({ type: 'notification', ...env });
  coalesceState.set(input.dedupeKey, {
    envelopeId: env.id,
    lastSentAt: now,
    count: 1,
    expiry: now + window,
  });
  return { ok: true, id: env.id, sent: true };
}

/**
 * Persisted notification row — shape mirrors the table columns (014). Used
 * by the WS ack handler to look up the row and decide whether ackReason is
 * required (HIGHEST_SUBCODES check against `reason_code`).
 */
export type NotificationRow = {
  id: string;
  class: NotificationClass;
  reason_code: string | null;
  audit_row_id: string | null;
  acked_at: number | null;
};

export function getNotification(id: string): NotificationRow | undefined {
  return getDb()
    .prepare<
      [string],
      NotificationRow
    >(`SELECT id, class, reason_code, audit_row_id, acked_at FROM notifications WHERE id = ?`)
    .get(id);
}

export function markNotificationAcked(
  id: string,
  ackedAt: number,
  ackedBy: string,
  ackedReason: string | null,
): void {
  getDb()
    .prepare(
      `UPDATE notifications SET acked_at = ?, acked_by = ?, acked_reason = ?
       WHERE id = ? AND acked_at IS NULL`,
    )
    .run(ackedAt, ackedBy, ackedReason, id);
}
