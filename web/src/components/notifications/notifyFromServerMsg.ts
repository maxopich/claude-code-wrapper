import type { NotificationEnvelope, ServerMsg, WrapperErrorKind } from '@cebab/shared/protocol';

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
  /**
   * Cebab-4zkc: the delete-confirm modal shows its own result inline, but
   * only while it is still open FOR THAT PROJECT. If the operator dismissed
   * it (or replaced it with another agent's delete) before the result
   * landed, the reducer's late-answer guard drops the result and a FAILED
   * delete reports nothing anywhere. This predicate answers "will the modal
   * render this result itself?" — `true` ⇒ suppress the toast (the modal has
   * it), `false`/`undefined` ⇒ toast the failure. Reads the modal state as
   * it was when the result arrived (App.tsx's `stateRef`, pre-reduce).
   */
  isManagedDeleteModalShowing?: (projectId: number) => boolean;
  /**
   * Cebab-7vl4: does this session id belong to a multi-agent run the client
   * knows about — the active bus run, or an iteration listed on the Multi-Agent
   * tab (which is what a pending Resume targets)? Such a session-scoped
   * wrapper_error has no chat transcript to render into, so store.ts treats it
   * as bus-scoped and renders nothing; when this returns `true` the wrapper_error
   * case pushes the run's error surface (transient "Resume cancelled" for
   * `aborted`, sticky "Resume failed" otherwise). Reads live state from App.tsx's
   * `stateRef`. Returns `false`/`undefined` for a single-agent session id, whose
   * error is already a chat banner.
   */
  isKnownMultiAgentSession?: (sessionId: string) => boolean;
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

    case 'bulk_session_op_result': {
      // Cluster I Phase C5 UI: summarize the bulk archive/delete outcome
      // as a single toast (never one-per-session — that would be hostile
      // for a 50-row bulk op). The reducer already dropped the succeeded
      // rows from the sidebar; this toast is the operator's confirmation
      // + the only surface that reports the `failed[]` entries.
      //
      // Severity ladder:
      //   - all succeeded            → success
      //   - some succeeded, some not → success, with a "N couldn't be …"
      //     tail in the message (the failures are the secondary signal)
      //   - none succeeded (all failed) → warn (nothing happened; the
      //     operator needs to know why — e.g. a running session)
      //   - nothing at all (empty)   → no toast
      const okCount = msg.succeededSessionIds.length;
      const failCount = msg.failed.length;
      if (okCount === 0 && failCount === 0) return;

      const verb = msg.op === 'archive' ? 'Archived' : 'Soft-deleted';
      const noun = (n: number) => (n === 1 ? 'session' : 'sessions');

      if (okCount === 0) {
        // Every id was rejected. Lead with the most common failure reason
        // so the operator gets an actionable hint without opening details.
        const runningCount = msg.failed.filter((f) => f.reason === 'running').length;
        const hint =
          runningCount > 0
            ? `${runningCount} still running — Stop or End first.`
            : (msg.failed[0]?.message ?? 'See server logs for details.');
        ctx.push({
          id: mintId(),
          ts: now,
          severity: 'warn',
          class: 'operational',
          dedupeKey: `bulk_session_op:${msg.op}:none`,
          title: `Couldn't ${msg.op} ${failCount} ${noun(failCount)}`,
          message: hint,
          sticky: false,
        });
        return;
      }

      // At least one succeeded.
      const removedTail = msg.op === 'delete' && msg.removedArtifacts ? ' · logs removed' : '';
      const failTail =
        failCount > 0 ? ` · ${failCount} couldn't be processed (e.g. still running)` : '';
      ctx.push({
        id: mintId(),
        ts: now,
        severity: 'success',
        class: 'operational',
        dedupeKey: `bulk_session_op:${msg.op}:ok`,
        title: `${verb} ${okCount} ${noun(okCount)}${removedTail}`,
        message:
          msg.op === 'delete'
            ? `Recoverable for 7 days, then purged.${failTail}`
            : failTail
              ? failTail.replace(/^ · /, '')
              : 'Hidden from the session list.',
        sticky: false,
      });
      return;
    }

    case 'managed_delete_result': {
      // Cebab-4zkc: a failed delete whose modal is gone would otherwise be
      // silent — the reducer's `managed_delete_result` case returns state
      // unchanged when the modal was closed or replaced, and the tree is
      // already half torn down by then. A SUCCESS is self-evident (the agent
      // vanishes from the sidebar), so only the failure needs a surface.
      //
      // When the modal IS still open for this project it renders the error
      // inline (status → 'done'); toasting too would double-show. So we defer
      // to the modal exactly as the rate-limit case defers to its banner.
      if (msg.result.ok) return;
      if (ctx.isManagedDeleteModalShowing?.(msg.projectId)) return;
      ctx.push({
        id: mintId(),
        ts: now,
        severity: 'error',
        class: 'operational',
        dedupeKey: `managed_delete:${msg.projectId}`,
        title: "Couldn't delete the managed agent",
        message: msg.result.error,
        sticky: true,
      });
      return;
    }

    case 'wrapper_error': {
      // UI-14: a wrapper_error not pinned to a chat session pushes an error
      // toast. Session-scoped wrapper_errors are already rendered as a
      // session-status banner by store.ts's own `wrapper_error` branch — we'd
      // double-show if we
      // toasted those too. (`Cebab-6fax.8`: the citation used to be
      // "store.ts:1290+", which by 2026-09 pointed at unrelated code —
      // `project_register_line_numbers_stale`: locate by content, not by line
      // number.)
      const m = msg as { sessionId?: string; kind?: WrapperErrorKind; message?: string };
      if (m.sessionId) {
        // Cebab-7vl4: a session-scoped wrapper_error whose id belongs to a
        // multi-agent run the client knows about (an iteration on the
        // Multi-Agent tab, or the active bus run) has no chat transcript to
        // land in — store.ts treats it as bus-scoped, bumping `failureSeq`
        // (which clears a stuck "Resuming…") but rendering nothing. This toast
        // is its only surface, split the way 7vl4 decided: a cancelled resume
        // (`aborted`) is a brief, self-fading info notice, exactly like the
        // sessionless `aborted` toast below (Cebab-osfq); any other failure is
        // a sticky error the operator must dismiss.
        if (ctx.isKnownMultiAgentSession?.(m.sessionId)) {
          const busMsg = typeof m.message === 'string' ? m.message : 'Wrapper error';
          if (m.kind === 'aborted') {
            ctx.push({
              id: mintId(),
              ts: now,
              severity: 'info',
              class: 'operational',
              dedupeKey: `${PHASE_2_WRAPPER_DEDUPE_KEY_PREFIX}:multi-agent:${m.sessionId}:aborted`,
              title: 'Resume cancelled',
              message: busMsg,
              sticky: false,
            });
          } else {
            ctx.push({
              id: mintId(),
              ts: now,
              severity: 'error',
              class: 'operational',
              dedupeKey: `${PHASE_2_WRAPPER_DEDUPE_KEY_PREFIX}:multi-agent:${m.sessionId}`,
              title: 'Resume failed',
              message: busMsg,
              sticky: true,
            });
          }
        }
        // Any other session-scoped wrapper_error is a single-agent chat error,
        // rendered as a session-status banner by store.ts's own branch —
        // toasting it too would double-show.
        return;
      }
      const messageText = typeof m.message === 'string' ? m.message : 'Wrapper error';

      // Cebab-osfq: a sessionless `aborted` is a deliberate cancellation, not a
      // crash — the operator declining a trust/env prompt during a bus start
      // (which never gets a session, so this toast is its only surface). The
      // server already sets `kind: 'aborted'` for exactly this (see
      // `classifyHandlerFailure` / `classifyBusStartFailure` in
      // `ws/server.ts`); nothing on the client read it. Show it as a transient
      // info toast so a cancel reads as a cancel. This fixes the SESSIONLESS
      // toast only: a session-scoped error of any kind, `aborted` included,
      // still renders as a red error row in its chat.
      //
      // Its OWN dedupeKey on purpose. The dock coalesces a push into the entry
      // already showing under the same key, keeping that entry's severity and
      // stickiness — so on the crash key, a real crash arriving while this
      // notice is up would be folded into a 5 s info toast and lost.
      if (m.kind === 'aborted') {
        ctx.push({
          id: mintId(),
          ts: now,
          severity: 'info',
          class: 'operational',
          dedupeKey: `${PHASE_2_WRAPPER_DEDUPE_KEY_PREFIX}:global:aborted`,
          title: 'Cancelled',
          message: messageText,
          sticky: false,
        });
        return;
      }

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
