/**
 * The WS connection indicator in the sidebar header.
 *
 * Register U11: this was a bare 6×6 `<span>` inline in `App.tsx` whose only
 * content was a `title` — green when connected, red when not, and nothing
 * else. Red/green is the classic colour-blind failure pair, a `title` on an
 * empty span is unreliable for assistive tech (an empty span may not reach the
 * accessibility tree at all), and six pixels is not a glance-legible signal in
 * either state.
 *
 * Three channels now carry the state instead of one:
 *   - **text** — visible when disconnected, `sr-only` when connected. The
 *     header stays uncluttered in the state it is in almost always, and the
 *     state worth noticing is readable without decoding a colour.
 *   - **shape** — a filled disc when connected, a hollow ring when not
 *     (`.dot.on` / `.dot.off`), which survives a monochrome display.
 *   - **colour** — as before, now redundant reinforcement rather than the
 *     whole signal.
 *
 * Deliberately NOT a live region, though the finding asks for a status role.
 * Both transitions are already announced elsewhere: disconnect by
 * `ConnectionLostOverlay`'s assertive alert, reconnect by the "Reconnected"
 * toast App pushes from the WS `onOpen` handler. A third announcer for the
 * same two events is the double-announce defect fixed in `Notification.tsx`
 * in this same change. The finding's real complaint is that the state is
 * *imperceptible*; label and shape are what fix that.
 *
 * Extracted from `App.tsx` so the contract above is testable — and so it sits
 * where its three neighbours in `sidebar-header-controls` already do
 * (`MockBadge`, `NotificationBell`, `RecoveryLogButton`).
 */
export function ConnectionStatus({ connected }: { connected: boolean }) {
  return (
    <span className="conn-status" data-connected={connected ? 'true' : 'false'}>
      <span className={connected ? 'dot on' : 'dot off'} aria-hidden="true" />
      <span className="conn-status-label">{connected ? 'Connected' : 'Offline'}</span>
    </span>
  );
}
