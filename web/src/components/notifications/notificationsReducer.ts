import type { NotificationEnvelope, NotificationSeverity } from '@cebab/shared/protocol';

/**
 * Cluster A Phase 2: pure reducer for the notification dock.
 *
 * The dock is a separate slice from `store.ts` (spec §6: "isolates
 * cross-cutting presentation from session/run state"). The shape stays
 * intentionally small — visible toasts up to MAX_VISIBLE, overflow queued
 * FIFO. No timers, no DOM, no WS — just data transitions. The Notification
 * component drives auto-dismiss timers; the dispatch table fans wire events
 * here.
 */

export type DisplayNotification = NotificationEnvelope & {
  /** UI-9: ×N badge when the same `dedupeKey` arrives while visible. */
  count: number;
  /** Wall-clock ms at the most recent push (initial or coalesced). Drives
   * the eviction tiebreak: oldest evictable wins. */
  receivedAt: number;
};

export type NotificationsState = {
  /** Currently rendered toasts. Length never exceeds MAX_VISIBLE. */
  visible: DisplayNotification[];
  /** FIFO overflow when all visible slots are non-evictable (sticky or
   * severity in NON_EVICTABLE). Promoted on dismiss. Length never exceeds
   * MAX_QUEUED; past that the oldest falls off (W12). */
  queued: DisplayNotification[];
};

export type NotificationsAction =
  | { type: 'push'; n: NotificationEnvelope; now: number }
  | { type: 'dismiss'; id: string }
  | { type: 'reset' };

/**
 * Cap visible toasts (UI-3). 5th push tries to evict the oldest
 * evictable visible; if all 4 are non-evictable, the incoming joins
 * the queue.
 */
export const MAX_VISIBLE = 4;

/**
 * W12: cap the overflow queue. It used to grow without limit — every push past
 * a full, entirely non-evictable visible list appended forever — so a burst of
 * distinct-`dedupeKey` errors left an array that nothing trimmed and a backlog
 * the operator cleared one dismissal at a time, each promotion surfacing an
 * older toast than the last.
 *
 * OVERFLOW DROPS THE OLDEST QUEUED ENTRY, and that loses less than it sounds.
 * The queue is only reachable when all four visible slots hold non-evictable
 * toasts, and they hold them BECAUSE they cannot be evicted — so in a cascade
 * the earliest failures are already pinned on screen and the queue behind them
 * is the consequences. Dropping the newest instead would hide the arrival the
 * operator is reacting to right now.
 *
 * Nor is the dock the record: the server persists every sticky-operational and
 * every safety notification to the inbox (`dispatcher.ts` §4), which is the
 * surface that keeps history. Non-sticky operational toasts are transient by
 * design and were already unreachable at this depth.
 *
 * The number is a judgement call, not a derived quantity: two screenfuls of
 * backlog past what is showing. The tests assert the invariant — bounded, and
 * the newest kept — not the value.
 */
export const MAX_QUEUED = 8;

/**
 * Severities that can never be auto-evicted to make room for a newer
 * notification (UI-3). They can still be dismissed by user action — they
 * just don't lose their slot just because a newer notification arrives.
 * Sticky=true also pins regardless of severity.
 */
const NON_EVICTABLE: ReadonlySet<NotificationSeverity> = new Set(['error', 'danger']);

function isEvictable(n: DisplayNotification): boolean {
  if (n.sticky) return false;
  if (NON_EVICTABLE.has(n.severity)) return false;
  return true;
}

export const initialNotificationsState: NotificationsState = { visible: [], queued: [] };

export function notificationsReducer(
  state: NotificationsState,
  action: NotificationsAction,
): NotificationsState {
  switch (action.type) {
    case 'push': {
      const incoming = action.n;
      // UI-9 dedupe pass — first visible, then queued. ID stays the same as
      // the existing entry (kept stable across coalesces for sticky-replay
      // dedupe per BE-5).
      const visIdx = state.visible.findIndex((v) => v.dedupeKey === incoming.dedupeKey);
      if (visIdx !== -1) {
        const existing = state.visible[visIdx];
        const updated: DisplayNotification = {
          ...existing,
          count: existing.count + 1,
          receivedAt: action.now,
        };
        const visible = state.visible.slice();
        visible[visIdx] = updated;
        return { ...state, visible };
      }
      const queueIdx = state.queued.findIndex((q) => q.dedupeKey === incoming.dedupeKey);
      if (queueIdx !== -1) {
        const existing = state.queued[queueIdx];
        const updated: DisplayNotification = {
          ...existing,
          count: existing.count + 1,
          receivedAt: action.now,
        };
        const queued = state.queued.slice();
        queued[queueIdx] = updated;
        return { ...state, queued };
      }

      const display: DisplayNotification = { ...incoming, count: 1, receivedAt: action.now };
      if (state.visible.length < MAX_VISIBLE) {
        return { ...state, visible: [...state.visible, display] };
      }
      // Try to evict the oldest evictable visible toast.
      let evictIdx = -1;
      let evictReceivedAt = Number.POSITIVE_INFINITY;
      for (let i = 0; i < state.visible.length; i++) {
        const v = state.visible[i];
        if (isEvictable(v) && v.receivedAt < evictReceivedAt) {
          evictIdx = i;
          evictReceivedAt = v.receivedAt;
        }
      }
      if (evictIdx !== -1) {
        const visible = state.visible.slice();
        visible.splice(evictIdx, 1);
        visible.push(display);
        return { ...state, visible };
      }
      // W12: `slice(-MAX_QUEUED)` after the append, so the oldest falls off
      // the head — the end the promotion in `dismiss` reads from.
      return { ...state, queued: [...state.queued, display].slice(-MAX_QUEUED) };
    }
    case 'dismiss': {
      const visIdx = state.visible.findIndex((v) => v.id === action.id);
      if (visIdx !== -1) {
        const visible = state.visible.slice();
        visible.splice(visIdx, 1);
        if (state.queued.length > 0) {
          const [promoted, ...rest] = state.queued;
          visible.push(promoted);
          return { visible, queued: rest };
        }
        return { ...state, visible };
      }
      const qIdx = state.queued.findIndex((q) => q.id === action.id);
      if (qIdx !== -1) {
        const queued = state.queued.slice();
        queued.splice(qIdx, 1);
        return { ...state, queued };
      }
      return state;
    }
    case 'reset':
      return initialNotificationsState;
  }
}
