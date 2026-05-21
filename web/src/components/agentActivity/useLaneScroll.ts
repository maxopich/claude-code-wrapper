/**
 * Per-lane sticky-bottom scroll behavior.
 *
 * Two states:
 *   - **Following**: the lane auto-scrolls to the bottom on every new row.
 *     The "↓ N new" pill is hidden.
 *   - **Paused**: the operator scrolled up to read older rows. The lane
 *     STOPS auto-scrolling. New rows that arrive while paused are counted
 *     against the visible "↓ N new" pill — clicking the pill jumps to the
 *     bottom and resumes following.
 *
 * Detection rule: we consider the lane "at bottom" when
 * `scrollTop + clientHeight >= scrollHeight - BOTTOM_THRESHOLD_PX`. The
 * threshold absorbs sub-pixel rounding (where the browser stops a pixel or
 * two short on layout shifts) so a single new row doesn't get counted as
 * "new" the instant after the operator finished scrolling to the bottom.
 *
 * The hook returns:
 *   - `containerRef`: attach to the scroll container element.
 *   - `bottomSentinelRef`: attach to a 0-px element at the very bottom of
 *     the scroll content. Used as the auto-scroll target so we don't have
 *     to read `scrollHeight` and risk reading mid-layout.
 *   - `paused`: true when the operator scrolled up (controls "↓ N new" pill
 *     visibility).
 *   - `newCount`: number of rows that arrived while paused (the pill label).
 *   - `resume()`: imperatively jump to the bottom and reset the counter.
 *     Call this from the pill's onClick.
 *
 * Auto-scroll on row growth: we observe `rowCount`. When it changes:
 *   - If `paused` → bump `newCount` by the delta.
 *   - Else → scroll the sentinel into view (instant under reduced-motion,
 *     smooth otherwise).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const BOTTOM_THRESHOLD_PX = 8;

export function useLaneScroll(rowCount: number) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const lastRowCountRef = useRef(rowCount);
  const [paused, setPaused] = useState(false);
  const [newCount, setNewCount] = useState(0);

  /** Returns `true` iff the container is scrolled within `BOTTOM_THRESHOLD_PX`
   *  of the bottom. Returns `true` for an empty / unmounted container too,
   *  so we don't accidentally count the very first row as "new". */
  const isAtBottom = useCallback((): boolean => {
    const el = containerRef.current;
    if (!el) return true;
    return el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_THRESHOLD_PX;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const sentinel = bottomSentinelRef.current;
    if (!sentinel) return;
    sentinel.scrollIntoView({ behavior, block: 'end' });
  }, []);

  const resume = useCallback(() => {
    setPaused(false);
    setNewCount(0);
    scrollToBottom('auto');
  }, [scrollToBottom]);

  // Track scroll position to set / clear `paused`. We don't throttle —
  // React batches state writes and `setPaused(true)` is idempotent.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = isAtBottom();
      if (atBottom) {
        // Returned to the bottom on their own — clear the counter, drop the pill.
        setPaused(false);
        setNewCount(0);
      } else {
        setPaused(true);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [isAtBottom]);

  // On row-count change: auto-scroll (if following) or bump newCount (if paused).
  useEffect(() => {
    const prev = lastRowCountRef.current;
    const delta = rowCount - prev;
    lastRowCountRef.current = rowCount;
    if (delta <= 0) return;
    if (paused) {
      setNewCount((n) => n + delta);
    } else {
      // 'auto' (not 'smooth') under prefers-reduced-motion. CSS handles the
      // visual; scrollIntoView's `behavior` field doesn't auto-respect the
      // media query, so we read it manually.
      const reduceMotion =
        typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
      scrollToBottom(reduceMotion ? 'auto' : 'smooth');
    }
  }, [rowCount, paused, scrollToBottom]);

  return { containerRef, bottomSentinelRef, paused, newCount, resume };
}
