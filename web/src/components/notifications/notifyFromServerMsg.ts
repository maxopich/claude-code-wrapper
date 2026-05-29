import type { NotificationEnvelope, ServerMsg } from '@cebab/shared/protocol';

/**
 * Cluster A Phase 2: ServerMsg → notification dispatch table.
 *
 * Single entry point called from App.tsx's onMessage after the main
 * reducer dispatch. Each case either pushes a freshly-shaped envelope
 * or returns silently (no fallthrough = no toast). Adding a new wired
 * source is a new case here — the rest of the dock is data.
 *
 * Phase 2 scope: pass-through for the server-dispatcher's typed
 * `notification` envelope (Phase 1 BE-1..BE-5 invariants), plus a
 * narrow fallback for `wrapper_error` messages that aren't session-scoped
 * (UI-14).
 *
 * Phase 3 wires three new typed sources server-side:
 *   - `rate_limit_event` (translate.ts → live-stream loop calls dispatcher.emit)
 *   - `router_drop` (orchestrator + chain F2/F3 drop sites → dispatcher.emit safety)
 *   - `env_scrubbed` (every WS attach → dispatcher.emit safety)
 *
 * Phase 4 wires four more sources server-side:
 *   - `session_superseded` (bus/resume.ts → dispatcher.emit warn)
 *   - `chain_not_reconstructed` (bus/resume.ts → dispatcher.emit warn)
 *   - `bus_auto_installed` (add_multi_agent_participant → dispatcher.emit info)
 *   - dangerous-mutation safety toast (onMutation closure → dispatcher.emit danger)
 *
 * Phase 6 wires the §7-floor remainder: each pairs a typed wire event
 * with a dispatcher fan-out, identical to the Phase 3/4 pattern. New
 * envelopes ride through the `notification` pass-through:
 *   - `tool_denied` (ws/server.ts permission_decision deny → dispatcher.emit warn)
 *   - `session_reconstructed` (bus/reconstruct.ts success → dispatcher.emit success)
 *   - rate_limit hit vs cleared split (ws/server.ts SDK stream → dispatcher.emit
 *     warn vs info, dedupeKey carries the sub-code)
 *   - wrapper_error sub-code routing (auth_expired / process_crash /
 *     parse_error → dispatcher.emit error with NotificationAction)
 *
 * The dispatcher fans each into a matching `notification` envelope, which
 * is what this table consumes (via the existing `'notification'` pass-through
 * case). The typed events also ship on the wire for future non-toast
 * consumers (Cluster B routing-trail counter, E1 inspector, D B2 banner,
 * D session-recovery surface) — if you find yourself adding more cases
 * here for Phase 3/4/6 sources, you're probably double-toasting; route via
 * the dispatcher instead.
 */

const PHASE_2_WRAPPER_DEDUPE_KEY_PREFIX = 'wrap';

export type NotifyContext = {
  /** Push a freshly-shaped envelope into the dock. */
  push: (n: NotificationEnvelope) => void;
  /**
   * For uuid generation in client-minted envelopes. Tests can inject a
   * deterministic stub; production uses `crypto.randomUUID()`.
   */
  mintId?: () => string;
  /** For deterministic test timestamps; production uses Date.now(). */
  now?: () => number;
  /**
   * Cluster D Phase 4c (UI-D6): banner ↔ toast dedup. When a banner is
   * already mounted for a session and `kind` is the matching banner kind,
   * the dispatcher's parallel `notification` fan-out should be
   * suppressed — the operator would otherwise see the same event twice
   * (the banner + the toast). Today only `'rate_limit'` plumbs through;
   * extend the union as later phases mount more banners
   * (`'auth_expired'`, `'swept_session'`, …) and their dispatcher emits
   * keyed dedupeKeys.
   *
   * Returns `true` ⇔ "banner is visible for this session/kind, skip the
   * toast." Returns `false`/`undefined` ⇔ no banner → fall through to
   * the normal `push`. Implementations read from whatever live state
   * holds the banner mounting decision (typically `state.sessionsByProject
   * [pid][sid].rateLimit !== undefined` for the rate-limit kind).
   */
  isBannerVisibleFor?: (sessionId: string, kind: 'rate_limit') => boolean;
};

/**
 * Crypto.randomUUID is available in all evergreen browsers and Node ≥ 19.
 * Local-bound to keep tests easy to stub.
 */
function defaultMintId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  // Fallback: timestamp + random — sufficient for client-side display IDs
  // (no security significance; this is not used as the audit row id).
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function notifyFromServerMsg(msg: ServerMsg, ctx: NotifyContext): void {
  const mintId = ctx.mintId ?? defaultMintId;
  const now = (ctx.now ?? Date.now)();

  switch (msg.type) {
    case 'notification':
      // Pass-through. The dispatcher (server/src/notifications/dispatcher.ts)
      // already shaped this envelope and wrote any audit row before sending.
      //
      // Cluster D Phase 4c (UI-D6) banner ↔ toast dedup: when a banner is
      // visible for the same session/kind, the toast is the second of two
      // operator-facing surfaces showing the same event — suppress it.
      //
      // We match the rate-limit dispatcher's stable dedupeKey prefix
      // (`rate_limit:hit:<sessionId>` / `rate_limit:cleared:<sessionId>` —
      // see `server/src/ws/server.ts:rateLimitDispatch`). The check is
      // narrow: a custom dedupeKey that just happens to start with the
      // same prefix would also be deduped, but the prefix is server-
      // controlled and not a legitimate collision surface.
      if (
        msg.sessionId &&
        msg.dedupeKey.startsWith('rate_limit:') &&
        ctx.isBannerVisibleFor?.(msg.sessionId, 'rate_limit')
      ) {
        return;
      }
      ctx.push(msg);
      return;

    case 'recent_rejections': {
      // Cluster G E3 UI: server emits this on every WS attach when the
      // in-process Origin/Host rejection ring has at least one entry
      // within the 5-min visible window. The fan-out here is the
      // operator-facing warning toast — spec §5 E3:
      //   "3 origin-rejected WS attempts in the last 5 min —
      //    possible misconfigured client."
      // The ConnectionLostOverlay handles the cross-cutting case (this
      // tab is the one being rejected); this toast handles the
      // diagnostic case (THIS tab is connected but OTHER browser tabs
      // (or a misconfigured proxy) are getting rejected).
      //
      // dedupeKey is per-attach (no second dimension) so a fresh
      // attach with the same ring contents replaces the toast rather
      // than stacking duplicates. Sticky=false because the diagnostic
      // is a moment-in-time read; if the next attach still has
      // entries, a fresh toast will replace it.
      if (msg.count <= 0) return;
      const noun = msg.count === 1 ? 'attempt' : 'attempts';
      ctx.push({
        id: mintId(),
        ts: now,
        severity: 'warn',
        class: 'operational',
        dedupeKey: 'origin_rejections:attach',
        title: `${msg.count} origin-rejected ${noun} in the last 5 min`,
        message: 'A browser or proxy may be misconfigured. See server logs for details.',
        sticky: false,
      });
      return;
    }

    case 'wrapper_error': {
      // UI-14: a wrapper_error not pinned to a chat session pushes an error
      // toast. Session-scoped wrapper_errors are already rendered as a
      // session-status banner by store.ts:1290+ — we'd double-show if we
      // toasted those too. Phase 3 introduces a `kind` discriminant on the
      // wire and the dispatch becomes more precise; for Phase 2 we only
      // intervene when there's no sessionId.
      const m = msg as { sessionId?: string; message?: string };
      if (m.sessionId) return;
      const messageText = typeof m.message === 'string' ? m.message : 'Wrapper error';
      ctx.push({
        id: mintId(),
        ts: now,
        severity: 'error',
        class: 'operational',
        dedupeKey: `${PHASE_2_WRAPPER_DEDUPE_KEY_PREFIX}:global`,
        title: 'Server error',
        message: messageText,
        sticky: true,
      });
      return;
    }

    default:
      return;
  }
}
