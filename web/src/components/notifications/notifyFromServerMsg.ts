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
 * The dispatcher fans each into a matching `notification` envelope, which
 * is what this table consumes (via the existing `'notification'` pass-through
 * case). The typed events also ship on the wire for future non-toast
 * consumers (Cluster B routing-trail counter, E1 inspector, D B2 banner,
 * D session-recovery surface) — if you find yourself adding more cases
 * here for Phase 3/4 sources, you're probably double-toasting; route via
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
      ctx.push(msg);
      return;

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
