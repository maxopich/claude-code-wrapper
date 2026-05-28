import { useEffect } from 'react';
import type {
  RecoveryFailureClass,
  RecoveryLogEntry,
  RecoveryOperatorAction,
  RecoveryOutcomeStatus,
} from '@cebab/shared/protocol';
import { useRecoveryLogActions, useRecoveryLogState } from './RecoveryLogContext';

/**
 * Cluster D Phase 8b (spec §8.5): the recovery_log inspector popover.
 *
 * Surfaces the persisted `recovery_log` table (every recovery action
 * since Phase 4a + D1) so the operator can audit how the wrapper has
 * been auto-retrying, sweeping, archiving, and reopening. Three
 * sections, in operator-priority order:
 *
 *   1. Per-failure-class aggregates — count + reachedFinalRate + median
 *      time-to-recovery. The at-a-glance "is rate-limit retry
 *      effective today" line.
 *   2. Named gauges — `sweepReopenRate` ("what fraction of swept
 *      iterations did the operator reopen") + `authResumeChoiceRatio`
 *      ("in-session-resume vs new-session after auth refresh"). Both
 *      may be null when the denominator is empty; the inspector
 *      renders an explicit "no data yet" rather than a misleading 0%.
 *   3. Recent activity — newest-first table of the last N rows for
 *      cross-referencing with specific sessions.
 *
 * Data flow:
 *   - `useRecoveryLogState`: snapshot + loaded flag (read).
 *   - `useRecoveryLogActions`: `requestSnapshot()` re-fetches on mount
 *     so reopening the popover always shows fresh data.
 *
 * Like NotificationInbox, the panel is purely presentational; the
 * Provider does the WS round-trip.
 */

const FAILURE_CLASS_LABEL: Record<RecoveryFailureClass, string> = {
  rate_limit: 'Rate limit',
  auth_expired: 'Auth expired',
  sweep: 'Sweep',
  chain_crash: 'Chain crash',
  other: 'Other',
};

const OPERATOR_ACTION_LABEL: Record<RecoveryOperatorAction, string> = {
  auto_retry: 'auto-retry',
  manual_retry: 'manual retry',
  new_session: 'new session',
  in_session_resume: 'in-session resume',
  archive: 'archive',
  reopen: 'reopen',
  resume_from_hop: 'resume from hop',
  abort: 'abort',
};

const OUTCOME_LABEL: Record<RecoveryOutcomeStatus, string> = {
  reached_final: 'reached final',
  failed_again: 'failed again',
  still_running: 'still running',
};

export type RecoveryLogInspectorProps = {
  onClose: () => void;
};

export function RecoveryLogInspector({ onClose }: RecoveryLogInspectorProps) {
  const state = useRecoveryLogState();
  const { requestSnapshot } = useRecoveryLogActions();

  // Refresh-on-mount: opening the popover is a deliberate operator
  // action so a stale snapshot from the boot push would be confusing.
  // Server default of 100 is plenty for the panel.
  useEffect(() => {
    requestSnapshot();
  }, [requestSnapshot]);

  return (
    <div className="recovery-log-inspector">
      <header className="recovery-log-inspector-head">
        <h2 className="recovery-log-inspector-title">Recovery activity</h2>
        <button
          type="button"
          className="icon-btn recovery-log-inspector-close"
          aria-label="Close recovery activity"
          onClick={onClose}
        >
          ×
        </button>
      </header>

      {!state.loaded ? (
        <div className="recovery-log-inspector-empty">Loading…</div>
      ) : (
        <>
          <RecoveryLogAggregatesSection state={state} />
          <RecoveryLogGaugesSection state={state} />
          <RecoveryLogRecentSection rows={state.recent} />
        </>
      )}
    </div>
  );
}

function RecoveryLogAggregatesSection({
  state,
}: {
  state: { aggregates: ReturnType<typeof useRecoveryLogState>['aggregates'] };
}) {
  if (state.aggregates.length === 0) {
    return (
      <section className="recovery-log-inspector-section">
        <h3 className="recovery-log-inspector-section-title">By class</h3>
        <p className="recovery-log-inspector-empty">
          No recovery actions recorded yet. The log will populate as auto-retries,
          sweeps, and archive actions fire.
        </p>
      </section>
    );
  }
  return (
    <section className="recovery-log-inspector-section">
      <h3 className="recovery-log-inspector-section-title">By class</h3>
      <table className="recovery-log-table" aria-label="Recovery aggregates by failure class">
        <thead>
          <tr>
            <th scope="col">Class</th>
            <th scope="col" className="recovery-log-table-num">Count</th>
            <th scope="col" className="recovery-log-table-num">Reached final</th>
            <th scope="col" className="recovery-log-table-num">Median time</th>
          </tr>
        </thead>
        <tbody>
          {state.aggregates.map((agg) => (
            <tr key={agg.failureClass}>
              <td>
                <span className={`recovery-log-class-chip recovery-log-class-${agg.failureClass}`}>
                  {FAILURE_CLASS_LABEL[agg.failureClass]}
                </span>
              </td>
              <td className="recovery-log-table-num">{agg.count}</td>
              <td className="recovery-log-table-num">
                {agg.reachedFinalRate === null ? '—' : formatPct(agg.reachedFinalRate)}
              </td>
              <td className="recovery-log-table-num">
                {agg.medianTimeToRecoveryMs === null
                  ? '—'
                  : formatDurationMs(agg.medianTimeToRecoveryMs)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function RecoveryLogGaugesSection({
  state,
}: {
  state: {
    sweepReopenRate: ReturnType<typeof useRecoveryLogState>['sweepReopenRate'];
    authResumeChoiceRatio: ReturnType<typeof useRecoveryLogState>['authResumeChoiceRatio'];
  };
}) {
  return (
    <section className="recovery-log-inspector-section">
      <h3 className="recovery-log-inspector-section-title">Gauges</h3>
      <ul className="recovery-log-gauges">
        <li className="recovery-log-gauge">
          <div className="recovery-log-gauge-label">Sweep reopen rate</div>
          {state.sweepReopenRate === null ? (
            <div className="recovery-log-gauge-value recovery-log-gauge-empty">
              No sweeps recorded yet
            </div>
          ) : (
            <div className="recovery-log-gauge-value">
              {formatPct(state.sweepReopenRate.rate)}{' '}
              <span className="recovery-log-gauge-detail">
                ({Math.round(state.sweepReopenRate.rate * state.sweepReopenRate.sweeps)} of{' '}
                {state.sweepReopenRate.sweeps})
              </span>
            </div>
          )}
        </li>
        <li className="recovery-log-gauge">
          <div className="recovery-log-gauge-label">Auth resume choice</div>
          {state.authResumeChoiceRatio === null ? (
            <div className="recovery-log-gauge-value recovery-log-gauge-empty">
              No auth recoveries recorded yet
            </div>
          ) : (
            <div className="recovery-log-gauge-value">
              {formatPct(state.authResumeChoiceRatio.inSessionRate)} in-session{' '}
              <span className="recovery-log-gauge-detail">
                ({state.authResumeChoiceRatio.inSession} of{' '}
                {state.authResumeChoiceRatio.inSession + state.authResumeChoiceRatio.newSession})
              </span>
            </div>
          )}
        </li>
      </ul>
    </section>
  );
}

function RecoveryLogRecentSection({ rows }: { rows: RecoveryLogEntry[] }) {
  if (rows.length === 0) {
    return (
      <section className="recovery-log-inspector-section">
        <h3 className="recovery-log-inspector-section-title">Recent activity</h3>
        <p className="recovery-log-inspector-empty">No recent rows.</p>
      </section>
    );
  }
  return (
    <section className="recovery-log-inspector-section">
      <h3 className="recovery-log-inspector-section-title">
        Recent activity ({rows.length})
      </h3>
      <ul className="recovery-log-recent-list" aria-label="Recent recovery activity">
        {rows.map((row) => (
          <li key={row.id} className="recovery-log-recent-row">
            <div className="recovery-log-recent-row-head">
              <span
                className={`recovery-log-class-chip recovery-log-class-${row.failureClass}`}
              >
                {FAILURE_CLASS_LABEL[row.failureClass]}
              </span>
              <span className="recovery-log-recent-row-action">
                {OPERATOR_ACTION_LABEL[row.operatorAction]}
              </span>
              <span className="recovery-log-recent-row-ts" title={new Date(row.ts).toISOString()}>
                {formatRelativeMs(row.ts)}
              </span>
            </div>
            <div className="recovery-log-recent-row-meta">
              <span
                className="recovery-log-recent-row-session"
                title={row.sessionId ?? 'process-level event (no session)'}
              >
                {row.sessionId ? `session ${row.sessionId.slice(0, 8)}` : 'process-level'}
              </span>
              {row.timeToRecoveryMs !== null && (
                <span className="recovery-log-recent-row-detail">
                  · time-to-recovery {formatDurationMs(row.timeToRecoveryMs)}
                </span>
              )}
              {row.outcome !== null && (
                <span className="recovery-log-recent-row-detail">
                  · {OUTCOME_LABEL[row.outcome]}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- helpers ----

function formatPct(ratio: number): string {
  // Round to 1 decimal place; trim trailing .0 so common values
  // ("50%" not "50.0%") read naturally.
  const pct = ratio * 100;
  const rounded = Math.round(pct * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

function formatRelativeMs(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}
