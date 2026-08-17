import { useCallback, useEffect, useRef, useState } from 'react';
import type { NotificationAction } from '@cebab/shared/protocol';
import { useNotificationsActions, useNotificationsState } from './NotificationsContext';
import { Notification } from './Notification';
import type { DisplayNotification } from './notificationsReducer';
import { addMute } from './muteStore';

/**
 * Cluster A Phase 2: bottom-right toast dock host.
 *
 * Layout (UI-4): bottom-right anchored 16px from viewport edges; width
 * 320px on >sm screens; below sm, full-width minus 16px and anchored at
 * the bottom-center. Both layouts collapse to the `.notif-stack` rules in
 * styles.css — this component owns only the React tree, the sr-only live
 * regions, and the dedupe-aware live-region announcements.
 *
 * Empty state (UI-2): renders only the live-region scaffolding so AT users
 * are kept in sync without any visible DOM. The stack region is also
 * always rendered to keep `role="region"` mount-stable for screen
 * reader topology.
 *
 * Live regions (UI-10): a polite region announces info/success/warn pushes;
 * an assertive region announces error/danger. Mirror text is appended on
 * push and cleared one rAF later, so a follow-up push with identical text
 * still re-announces (generalizes `useDangerousArrivalAnnouncements` from
 * the Logs modal).
 */

export type NotificationStackProps = {
  /**
   * Action router. Phase 2 ships with this optional — host can leave it
   * undefined and the only effect is that action buttons become noop (the
   * toast still dismisses). Phase 3+ pipes it into App.tsx's existing
   * `selectSession` / navigation functions.
   */
  onAction?: (action: NotificationAction, notification: DisplayNotification) => void;
};

export function NotificationStack({ onAction }: NotificationStackProps) {
  const state = useNotificationsState();
  const { dismiss } = useNotificationsActions();

  /**
   * Cluster A Phase 5 mute hook: when the operator clicks "Mute" on a
   * non-error/non-danger toast, register a 1-hour mute keyed by the
   * notification's dedupeKey prefix (`source` in the spec's vocabulary,
   * e.g. `bus_auto_installed`, `chain_not_reconstructed`). 1 hour is
   * the spec's default scope; the manage-mutes UI can convert to
   * "forever" or unmute. Dismissal is handled by Notification's own
   * `handleMuteClick` after this callback returns, so the toast goes
   * away immediately.
   */
  const handleMute = useCallback((n: DisplayNotification) => {
    addMute(n, 'hour');
  }, []);

  // Live-region mirror text. Cleared one rAF later so repeated pushes of
  // the same string still re-announce. The two refs let the assertive
  // region update independently of the polite one (per-tier wiring below).
  const [politeText, setPoliteText] = useState('');
  const [assertiveText, setAssertiveText] = useState('');
  const announcedIds = useRef<Set<string>>(new Set());

  // Cebab-mbu: the clear-frames live in a ref, and are cancelled on UNMOUNT
  // only — see the effect below and the one after it. Each callback removes its
  // own id, so this does not grow across a long session.
  const clearFrames = useRef<Set<number>>(new Set());

  useEffect(() => {
    const idsThisRender = new Set<string>();
    let polite: string | null = null;
    let assertive: string | null = null;
    for (const v of state.visible) {
      idsThisRender.add(v.id);
      if (announcedIds.current.has(v.id)) continue;
      // Announce the newest one for each region; if multiple new arrivals
      // share a tier, the last in iteration wins — the most recent push.
      const text = `${v.title}${v.message ? `. ${v.message}` : ''}`;
      if (v.severity === 'error' || v.severity === 'danger') {
        assertive = text;
      } else {
        polite = text;
      }
      announcedIds.current.add(v.id);
    }
    // Garbage-collect ids no longer visible/queued so the set doesn't grow
    // unbounded across a long session.
    for (const id of announcedIds.current) {
      if (!idsThisRender.has(id) && !state.queued.some((q) => q.id === id)) {
        announcedIds.current.delete(id);
      }
    }
    // W06: both regions are written, then a single cleanup cancels whichever
    // frames were scheduled. The previous shape set the polite region and
    // RETURNED, so an assertive arrival in the same commit never reached its
    // region — and because the loop above had already added its id to
    // `announcedIds`, it was marked announced and no later render retried it.
    // The urgent tier was the one silently dropped, which is backwards.
    //
    // Cebab-mbu: the frames are NOT cancelled when this effect re-runs. Its
    // deps change on every push, and the cleanup that used to sit here fired
    // then — so under any push stream faster than one animation frame the
    // clear never happened. The mirror kept the previous string, and the next
    // notification rendering to the SAME text was a no-op `setState`: React
    // bailed out, the DOM did not change, and a screen reader announced
    // nothing. Two distinct notifications with identical text is the exact case
    // the rAF above exists for, so the cleanup was cancelling the mechanism it
    // sat beside.
    //
    // Same disease as `NotificationsContext.tsx:55-71` one layer down: a
    // cleanup that is correct for UNMOUNT, running on every re-render. Unmount
    // is handled by the `[]`-deps effect below; letting a stale frame clear a
    // string that is about to be overwritten is harmless, because the write
    // above happens in the same commit as the next announcement.
    const schedule = (clear: () => void) => {
      const id = requestAnimationFrame(() => {
        clearFrames.current.delete(id);
        clear();
      });
      clearFrames.current.add(id);
    };
    if (polite !== null) {
      setPoliteText(polite);
      schedule(() => setPoliteText(''));
    }
    if (assertive !== null) {
      setAssertiveText(assertive);
      schedule(() => setAssertiveText(''));
    }
  }, [state.visible, state.queued]);

  // Unmount only. `[]` deps are load-bearing: this is the cleanup the effect
  // above used to carry, and moving it here is the whole of Cebab-mbu.
  useEffect(() => {
    const pending = clearFrames.current;
    return () => {
      for (const frame of pending) cancelAnimationFrame(frame);
      pending.clear();
    };
  }, []);

  return (
    <div
      className="notif-stack"
      role="region"
      aria-label="Notifications"
      data-empty={state.visible.length === 0 ? 'true' : 'false'}
    >
      {state.visible.map((n) => (
        <Notification
          key={n.id}
          notification={n}
          onDismiss={dismiss}
          onAction={onAction}
          onMute={handleMute}
        />
      ))}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {politeText}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {assertiveText}
      </div>
    </div>
  );
}
