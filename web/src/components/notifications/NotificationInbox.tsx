import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  NotificationAction,
  NotificationClass,
  NotificationEnvelope,
  NotificationSeverity,
} from '@cebab/shared/protocol';
import { useInboxActions, useInboxState, type InboxFilters } from './InboxContext';
import { isMuteAllowed, muteKeyFor, readMutes, removeMute, type MuteEntry } from './muteStore';

/**
 * Cluster A Phase 5: the inbox popover.
 *
 * Surfaces the persisted `notifications` table (sticky-operational + all
 * safety) as a scrollable list with filter chips, a "Clear all dismissed"
 * action that bulk-acks operational rows (safety untouched per BE-7),
 * and a collapsible "Muted types" section the operator can use to
 * unmute previously-silenced sources.
 *
 * Data flow:
 *   - `useInboxState`: rows + per-session counts (read).
 *   - `useInboxActions`: `requestSnapshot(filters)` re-fetches on filter
 *     change; `clearDismissed()` fires the bulk-ack.
 *   - Mutes: read from `localStorage` directly via `readMutes()` so the
 *     panel doesn't need a separate context — mutes change rarely and
 *     the panel re-reads on every open + after each unmute.
 *
 * Per-row "Mark read" sends an `ack_notification` ClientMsg via the
 * dock's existing onAck callback. The server's reply is a fresh
 * `inbox_snapshot` that updates the panel automatically.
 */

const TIER_LABEL: Record<NotificationSeverity, string> = {
  info: 'Info',
  success: 'Success',
  warn: 'Warn',
  error: 'Error',
  danger: 'Danger',
};

const ALL_CLASSES: readonly NotificationClass[] = ['operational', 'safety'];
const ALL_SEVERITIES: readonly NotificationSeverity[] = [
  'info',
  'success',
  'warn',
  'error',
  'danger',
];

export type NotificationInboxProps = {
  onClose: () => void;
  /**
   * Send an ack for a single row. App.tsx wires this to the same WS
   * `ack_notification` path the dock uses, so the typed-reason policy
   * (BE-7) is enforced server-side identically regardless of where the
   * ack originates. Optional in tests.
   */
  onAck?: (id: string) => void;
};

export function NotificationInbox({ onClose, onAck }: NotificationInboxProps) {
  const { rows, loaded } = useInboxState();
  const { requestSnapshot, clearDismissed } = useInboxActions();

  // Filter state — local to the panel. Each toggle re-requests the
  // snapshot server-side so the panel and badges always reflect the
  // same authoritative state.
  const [classFilter, setClassFilter] = useState<NotificationClass | null>(null);
  const [severityFilter, setSeverityFilter] = useState<NotificationSeverity | null>(null);
  const [includeAcked, setIncludeAcked] = useState(true);

  const filters: InboxFilters = useMemo(
    () => ({
      classes: classFilter ? [classFilter] : undefined,
      severities: severityFilter ? [severityFilter] : undefined,
      includeAcked,
    }),
    [classFilter, severityFilter, includeAcked],
  );

  useEffect(() => {
    requestSnapshot(filters);
  }, [requestSnapshot, filters]);

  // Mutes are display-side state in localStorage. We snapshot at mount
  // and after each unmute action — toggling a mute elsewhere (a toast's
  // mute button) won't reflect here without a re-open, which is fine
  // for v1 (the inbox is a stop-by-it surface, not an always-open dock).
  const [muteMap, setMuteMap] = useState<Record<string, MuteEntry>>(() => readMutes());
  const refreshMutes = useCallback(() => setMuteMap(readMutes()), []);
  const [mutesExpanded, setMutesExpanded] = useState(false);

  const mutedKeys = useMemo(() => Object.keys(muteMap).sort(), [muteMap]);

  const handleUnmute = useCallback(
    (key: string) => {
      removeMute(key);
      refreshMutes();
    },
    [refreshMutes],
  );

  return (
    <div className="notif-inbox">
      <header className="notif-inbox-head">
        <h2 className="notif-inbox-title">Notifications</h2>
        <button
          type="button"
          className="icon-btn notif-inbox-close"
          aria-label="Close notifications inbox"
          onClick={onClose}
        >
          ×
        </button>
      </header>

      <div className="notif-inbox-filters" role="group" aria-label="Filter notifications">
        <FilterChipRow
          label="Tier"
          options={ALL_SEVERITIES.map((s) => ({ value: s, label: TIER_LABEL[s] }))}
          selected={severityFilter}
          onSelect={setSeverityFilter}
        />
        <FilterChipRow
          label="Class"
          options={ALL_CLASSES.map((c) => ({ value: c, label: c === 'safety' ? 'Safety' : 'Op' }))}
          selected={classFilter}
          onSelect={setClassFilter}
        />
        <label className="notif-inbox-toggle">
          <input
            type="checkbox"
            checked={includeAcked}
            onChange={(e) => setIncludeAcked(e.target.checked)}
          />
          Include acknowledged
        </label>
      </div>

      <div className="notif-inbox-actions">
        <button
          type="button"
          className="secondary-btn"
          onClick={() => clearDismissed()}
          title="Acknowledge every unacked operational notification (safety untouched)"
        >
          Clear dismissed
        </button>
        <button
          type="button"
          className="secondary-btn"
          aria-expanded={mutesExpanded}
          aria-controls="notif-inbox-mutes"
          onClick={() => setMutesExpanded((v) => !v)}
        >
          {mutesExpanded ? '▾' : '▸'} Muted types ({mutedKeys.length})
        </button>
      </div>

      {mutesExpanded && (
        <ul
          className="notif-inbox-mutes"
          id="notif-inbox-mutes"
          aria-label="Muted notification types"
        >
          {mutedKeys.length === 0 ? (
            <li className="notif-inbox-mute-empty">No muted types.</li>
          ) : (
            mutedKeys.map((key) => (
              <li key={key} className="notif-inbox-mute-row">
                <span className="notif-inbox-mute-key">{key}</span>
                <MuteUntilLabel entry={muteMap[key]} />
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => handleUnmute(key)}
                  aria-label={`Unmute ${key}`}
                >
                  Unmute
                </button>
              </li>
            ))
          )}
        </ul>
      )}

      <ul className="notif-inbox-list" aria-label="Notification history">
        {!loaded ? (
          <li className="notif-inbox-empty">Loading…</li>
        ) : rows.length === 0 ? (
          <li className="notif-inbox-empty">No notifications.</li>
        ) : (
          rows.map((row) => (
            <InboxRow key={row.id} row={row} onAck={onAck} isMuted={muteKeyFor(row) in muteMap} />
          ))
        )}
      </ul>
    </div>
  );
}

type FilterChipRowProps<T extends string> = {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  selected: T | null;
  onSelect: (next: T | null) => void;
};

function FilterChipRow<T extends string>({
  label,
  options,
  selected,
  onSelect,
}: FilterChipRowProps<T>) {
  return (
    <div className="notif-inbox-chip-row">
      <span className="notif-inbox-chip-label">{label}:</span>
      <button
        type="button"
        className="notif-inbox-chip"
        data-active={selected === null ? 'true' : 'false'}
        onClick={() => onSelect(null)}
      >
        All
      </button>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className="notif-inbox-chip"
          data-active={selected === opt.value ? 'true' : 'false'}
          data-tier={opt.value}
          onClick={() => onSelect(selected === opt.value ? null : opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function MuteUntilLabel({ entry }: { entry: MuteEntry }) {
  if (entry.until === 'forever') {
    return <span className="notif-inbox-mute-until">until unmuted</span>;
  }
  const remainingMs = entry.until - Date.now();
  if (remainingMs <= 0) return <span className="notif-inbox-mute-until">expired</span>;
  const mins = Math.round(remainingMs / 60_000);
  if (mins < 60) return <span className="notif-inbox-mute-until">{mins}m left</span>;
  const hours = Math.round(mins / 60);
  return <span className="notif-inbox-mute-until">{hours}h left</span>;
}

type InboxRowProps = {
  row: NotificationEnvelope;
  onAck?: (id: string) => void;
  isMuted: boolean;
};

function InboxRow({ row, onAck, isMuted }: InboxRowProps) {
  const time = formatTime(row.ts);
  const muteEligible = isMuteAllowed(row.severity);
  return (
    <li className="notif-inbox-row" data-severity={row.severity} data-class={row.class}>
      <div className="notif-inbox-row-head">
        <span className="notif-inbox-row-tier" data-tier={row.severity}>
          {TIER_LABEL[row.severity]}
        </span>
        <span className="notif-inbox-row-ts" title={new Date(row.ts).toISOString()}>
          {time}
        </span>
        {isMuted && muteEligible && (
          <span className="notif-inbox-row-muted" aria-label="this type is muted">
            muted
          </span>
        )}
      </div>
      <div className="notif-inbox-row-title">{row.title}</div>
      {row.message && <div className="notif-inbox-row-msg">{row.message}</div>}
      <div className="notif-inbox-row-foot">
        {row.action && <ActionLabel action={row.action} />}
        {onAck && (
          <button
            type="button"
            className="notif-inbox-row-ack"
            onClick={() => onAck(row.id)}
            aria-label={`Mark notification ${row.title} as read`}
          >
            Mark read
          </button>
        )}
      </div>
    </li>
  );
}

function ActionLabel({ action }: { action: NotificationAction }) {
  // Inbox shows the action label as a chip — wiring the actual navigation
  // is deferred (Phase 5 doesn't route; the toast does). This lets the
  // operator SEE what affordance the row offers without making the inbox
  // a navigation source (one fewer place for stale links to live).
  switch (action.kind) {
    case 'open_session':
      return <span className="notif-inbox-row-action">Open session</span>;
    case 'open_logs':
      return <span className="notif-inbox-row-action">Open in logs</span>;
    case 'open_settings':
      return <span className="notif-inbox-row-action">Open settings</span>;
    case 'reauth':
      return <span className="notif-inbox-row-action">Re-authenticate</span>;
    case 'resume':
      return <span className="notif-inbox-row-action">Resume</span>;
    case 'archive':
      return <span className="notif-inbox-row-action">Archive</span>;
    case 'reopen':
      return <span className="notif-inbox-row-action">Reopen</span>;
    case 'restart_agent':
      return (
        <span className="notif-inbox-row-action">
          {action.agentName ? `Restart ${action.agentName}` : 'Restart agent'}
        </span>
      );
  }
}

function formatTime(ts: number): string {
  // HH:MM — same convention as MessageBlock / LogsTable timestamps.
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}
