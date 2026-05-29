import type { WsCloseInfo } from '../../ws';

/**
 * Cluster G E3 UI: union of distinct failure modes the overlay copies
 * disambiguate. The reason determines:
 *
 *   1. Which copy variant to render (per spec §5 E3).
 *   2. Whether auto-retry is appropriate (only `server_unreachable`).
 *   3. Whether the operator should re-fetch a new launch URL
 *      (`auth_token_invalid`).
 *
 * The `unknown` arm is the fall-through for close codes we haven't
 * explicitly modeled — kept so a future server-side close code doesn't
 * crash the overlay; the operator still sees "Connection failed (code:
 * 4007)" rather than a blank pane.
 */
export type ConnectionLostReason =
  | 'origin_not_allowed'
  | 'host_not_allowed'
  | 'auth_token_invalid'
  | 'session_revoked'
  | 'server_unreachable'
  | 'unknown';

/**
 * Per-attempt diagnostic for the overlay's "Copy diagnostic" button.
 * Strictly metadata — no credentials, no headers — so it's safe to
 * paste into a bug report. The shape is stable so the copy text is
 * deterministic across versions (one line per field).
 */
export type ConnectionLostDiagnostic = {
  /** Wall-clock ms at the failure. */
  ts: number;
  /** The URL the client tried to reach. Helps an operator notice they
   *  ended up on the wrong port / host. Optional because the auth-token
   *  fetch failure path stores the HTTP URL rather than the WS URL. */
  url?: string;
  /** The `X-Cebab-Reject-Reason` HTTP header value, when present. Lets
   *  the operator see the server's structured reason in addition to
   *  the close code (the WS upgrade path puts the reason on the 403
   *  response, the close code on the socket close). */
  rejectReason?: string;
  /** Numeric close code from the WS layer when the failure was a
   *  post-upgrade close (Channel B). Absent for pre-upgrade HTTP
   *  failures (Channel A). */
  closeCode?: number;
  /** Whether the close was clean (`true`) or transport-dropped
   *  (`false`). Mirrors `WsCloseInfo.wasClean`. */
  wasClean?: boolean;
};

/**
 * Build a human-readable diagnostic block for the clipboard. Keeps
 * field order stable across renders so a paste comparison reveals
 * what changed between two failures. No credentials/secrets are
 * included by construction — the input shape doesn't carry any.
 */
export function formatDiagnostic(
  reason: ConnectionLostReason,
  d: ConnectionLostDiagnostic,
): string {
  const lines: string[] = [];
  lines.push(`reason: ${reason}`);
  lines.push(`ts: ${new Date(d.ts).toISOString()}`);
  if (d.url !== undefined) lines.push(`url: ${d.url}`);
  if (d.rejectReason !== undefined) lines.push(`reject_reason: ${d.rejectReason}`);
  if (d.closeCode !== undefined) lines.push(`close_code: ${d.closeCode}`);
  if (d.wasClean !== undefined) lines.push(`was_clean: ${d.wasClean}`);
  return lines.join('\n');
}

/**
 * Resolve the overlay variant for a WS-close failure. Spec §4.3
 * Channel B + the structured close codes:
 *
 *   - **4001 auth_token_invalid** — the per-launch token isn't
 *     accepted. Operator needs a new launch URL.
 *   - **4002 session_revoked** — server explicitly revoked the
 *     session (future feature; reserved slot).
 *   - **1011 server_error** — server hit an internal error during
 *     the handshake. Mapped to `unknown` rather than `server_unreachable`
 *     because the socket DID open; this isn't a network failure.
 *   - **1006 abnormal close (no frame)** — transport disappeared.
 *     This is the "server unreachable" UX case (auto-retry
 *     appropriate).
 *   - **1000 normal closure / 1001 going away** — typically a page
 *     unload race. We surface them as `unknown` rather than try to
 *     guess; the overlay's "Retry" button is still available.
 *   - **anything else** — `unknown` with code in the diagnostic.
 *
 * Origin/Host rejections never reach this path — the WS never opens
 * (the 403 response interrupts before close-event semantics apply),
 * so the resolver for that case is on the HTTP fetch side
 * (`resolveFromAuthTokenResponse`).
 */
export function resolveFromCloseInfo(info: WsCloseInfo): ConnectionLostReason {
  switch (info.code) {
    case 4001:
      return 'auth_token_invalid';
    case 4002:
      return 'session_revoked';
    case 1006:
      // Abnormal close: server disappeared mid-flight (or never
      // accepted; for pre-WS rejections the upstream caller resolves
      // via the HTTP path before this). UX-wise the operator wants
      // "check the server is running."
      return 'server_unreachable';
    case 1011:
    case 1000:
    case 1001:
      // Wrapped into the catch-all `unknown` so the overlay surfaces
      // the close code without assuming a specific cause. 1011 is
      // particularly ambiguous (could be a server panic, a permission
      // bug, anything) — better to show the code than to mislead.
      return 'unknown';
    default:
      return 'unknown';
  }
}

/**
 * Resolve the overlay variant for an HTTP `/auth-token` failure.
 * Channel A in spec §4.3 — the WS never even opens because the
 * HTTP layer rejected the precursor request.
 *
 * The server (Cluster G E3 server-side, PR #175) sets
 * `X-Cebab-Reject-Reason: origin_not_allowed | host_not_allowed`
 * on every 403. If the response is unreachable entirely (TypeError
 * from `fetch`), we fall through to `server_unreachable` — there's
 * no header to inspect because the request didn't complete.
 */
export function resolveFromAuthTokenResponse(
  res: { status: number; headers: { get(name: string): string | null } } | null,
): ConnectionLostReason {
  if (res === null) {
    // `fetch` threw — no response object. The most likely cause is
    // the server not running; even if it's a DNS misconfig, the
    // "Retry" affordance still makes sense for the operator.
    return 'server_unreachable';
  }
  if (res.status === 403) {
    const reason = res.headers.get('X-Cebab-Reject-Reason');
    if (reason === 'origin_not_allowed') return 'origin_not_allowed';
    if (reason === 'host_not_allowed') return 'host_not_allowed';
    // 403 without the structured header: pre-E3 server, or a
    // generic proxy 403 between us and Cebab. Treat as unknown
    // and surface the response status in the diagnostic.
    return 'unknown';
  }
  // Any non-OK status that isn't 403 (502/504 from a stale proxy,
  // anything else). The operator's action is the same as the
  // unreachable case: check the server.
  return 'server_unreachable';
}
