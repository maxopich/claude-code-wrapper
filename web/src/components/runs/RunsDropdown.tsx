import { useEffect, useState } from 'react';
import type { ActiveRunView } from '../../store';

/**
 * Cluster G Phase 3b (G1 UI): the popover content for {@link RunsBadge}.
 * Renders the active-runs snapshot as a vertical list of clickable rows,
 * one per in-flight `query()`.
 *
 * Architectural notes:
 *
 * - **State source.** The `runs` prop is the slice from `state.activeRuns`,
 *   which the reducer replaces verbatim on each server `active_runs`
 *   ServerMsg. The dropdown never holds its own copy or attempts to
 *   reconcile — a stale snapshot from a prior connection can't survive
 *   because the disconnect handler resets the slice to `[]` and the
 *   dispatcher re-emits on the next attach.
 *
 * - **Elapsed clock.** The wire's `elapsedMs` is server-computed at emit
 *   time so the initial render shows the right number even when the
 *   server clock and the browser clock disagree. Once mounted we tick
 *   from `Date.now() - run.startedAt` every second so the operator sees
 *   the number advance without waiting for the next snapshot. The floor
 *   at 0 defends the same NTP-slew condition as the server projector.
 *
 * - **Row interaction.** Each row is a button (not a div) so keyboard
 *   focus works without `tabIndex` gymnastics; the `onJump` callback
 *   gets the full `ActiveRunView` so the host (App.tsx) can decide
 *   whether to switch into the chat tab (single-agent) or the
 *   multi-agent tab (bus/orchestrator). The dropdown doesn't know
 *   anything about the host's tab state — that decoupling matches the
 *   ProjectList ↔ App.tsx contract.
 *
 * - **Cap at 20 rows.** Per spec R-G3, a dropdown of 50+ runs gets
 *   unwieldy; we cap at 20 visible and surface "+N more" as a passive
 *   footer line. The v1.x "Manage all runs" link is deferred because
 *   the filtered session list it would jump to doesn't exist yet — a
 *   bare line is honest about the gap without inviting clicks into
 *   nowhere.
 */

export const RUNS_DROPDOWN_VISIBLE_CAP = 20;

export type RunsDropdownProps = {
  runs: ActiveRunView[];
  /**
   * Per-row click handler. The host decides what "jump" means for this
   * run (select session + switch tab); the dropdown just hands over the
   * row payload and closes itself via {@link onRequestClose}.
   */
  onJump: (run: ActiveRunView) => void;
  /**
   * Called after `onJump` (and via the empty-state link, when present).
   * Lets the host close the popover without the dropdown reaching into
   * the parent's open state.
   */
  onRequestClose: () => void;
};

export function RunsDropdown({ runs, onJump, onRequestClose }: RunsDropdownProps) {
  // 1Hz wall clock so the "Ns" / "Nm Xs" labels advance without waiting
  // for the next server snapshot. We tick from `startedAt` rather than
  // mutating `elapsedMs` so the wire snapshot stays the canonical
  // initial value when state changes (a snapshot arriving mid-tick
  // re-anchors the row at the server's number).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (runs.length === 0) {
    // Defensive empty-state. Normally RunsBadge unmounts the dropdown
    // when the count is 0, but a transient empty snapshot could land
    // mid-render (e.g. last run ended while the dropdown was open) —
    // we show a placeholder + close hint rather than a blank rectangle.
    return (
      <div className="runs-dropdown" role="presentation">
        <p className="runs-dropdown-empty">No runs in flight right now.</p>
      </div>
    );
  }

  const visible = runs.slice(0, RUNS_DROPDOWN_VISIBLE_CAP);
  const overflow = runs.length - visible.length;

  return (
    <div className="runs-dropdown" role="presentation">
      <ul className="runs-dropdown-list" role="list">
        {visible.map((run) => (
          <li key={`${run.kind}:${run.sessionId}`} className="runs-dropdown-row">
            <button
              type="button"
              className="runs-dropdown-row-btn"
              onClick={() => {
                onJump(run);
                onRequestClose();
              }}
            >
              <span className="runs-dropdown-row-label">
                <span className="runs-dropdown-row-project">
                  {/*
                    Three-step fallback so the row always has *some*
                    identifying text: project name (cached server-side
                    at emit time) → "project N" (raw id) → "(no project)"
                    (defensive — the wire shape allows projectId absence
                    during teardown / rename races, so the row stays
                    visible rather than rendering an empty cell).
                  */}
                  {run.projectName
                    ? run.projectName
                    : run.projectId !== undefined
                      ? `project ${run.projectId}`
                      : '(no project)'}
                </span>
                {/*
                  Active-agent suffix only for bus/orchestrator rows that
                  have resolved a participant. Single-agent runs never
                  carry `activeAgentName`; bus runs between hops drop the
                  field — both cases render the bare project line.
                */}
                {run.activeAgentName ? (
                  <span className="runs-dropdown-row-agent">{run.activeAgentName}</span>
                ) : null}
              </span>
              <span className="runs-dropdown-row-meta">
                <span
                  className="run-status run-status-running runs-dropdown-row-kind"
                  title={kindTitle(run.kind)}
                >
                  {kindGlyph(run.kind)} {kindLabel(run.kind)}
                </span>
                <span
                  className="runs-dropdown-row-elapsed"
                  title={`Started ${new Date(run.startedAt).toLocaleTimeString()}`}
                >
                  {formatElapsed(Math.max(0, now - run.startedAt))}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {overflow > 0 ? (
        // R-G3 mitigation: cap visible at 20, surface overflow count so
        // the operator knows there's more rather than silently truncating.
        // No "Manage all runs" link yet — the filtered session list it
        // would point at doesn't exist (deferred to v1.x dashboard).
        <p className="runs-dropdown-overflow">+{overflow} more</p>
      ) : null}
    </div>
  );
}

// ---------- helpers ----------

function kindGlyph(kind: ActiveRunView['kind']): string {
  // Inline plain-text glyphs so the dropdown stays SVG-free; these read
  // fine in the chip without an icon system and survive copy-paste in
  // case the operator screenshots the dropdown for a bug report.
  switch (kind) {
    case 'single':
      return '●';
    case 'bus-worker':
      return '⇄';
    case 'orchestrator':
      return '◆';
  }
}

function kindLabel(kind: ActiveRunView['kind']): string {
  switch (kind) {
    case 'single':
      return 'single';
    case 'bus-worker':
      return 'bus';
    case 'orchestrator':
      return 'orch';
  }
}

function kindTitle(kind: ActiveRunView['kind']): string {
  // Title-text expansion of the chip glyph + label. Tooltips so the
  // operator can hover to disambiguate "orch" vs "single" without
  // memorising the abbreviations.
  switch (kind) {
    case 'single':
      return 'Single-agent run';
    case 'bus-worker':
      return 'Multi-agent participant (bus worker)';
    case 'orchestrator':
      return 'Multi-agent orchestrator';
  }
}

/**
 * Compact wall-clock format mirroring CountdownChip's vocabulary. < 60s
 * shows whole seconds (`"7s"`); ≥ 1m switches to "MmSs" (`"3m12s"`); ≥ 1h
 * to "HhMm" (`"2h05m"`). Anything north of an hour for a single in-flight
 * query is already an outlier the operator should be looking at — we
 * sacrifice precision past that point for compactness.
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return `${hours}h${rem.toString().padStart(2, '0')}m`;
}
