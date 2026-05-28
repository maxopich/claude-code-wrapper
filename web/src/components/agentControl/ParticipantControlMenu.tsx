import { useEffect, useRef, useState } from 'react';
import type { ParticipantControlView } from '../../store';
import type { ControlReasonCode, PauseExpiryAction } from '@cebab/shared/protocol';

// Cluster C Phase 4g2: ⋮ menu on each participant row in the active-run
// Session info panel. First *interactive* slice for the control verbs —
// surfaces Mute / Unmute / Pause (5m + 15m, auto-resume default) / Resume
// as direct actions. Kick lands in Phase 4g3 with the reason-code modal.
//
// Reason-code policy for Phase 4g2: every dispatch uses `'topology_repair'`
// as a placeholder reasonCode — the safest neutral default in the
// ControlReasonCode enum that doesn't imply misbehavior on the part of
// the agent. Phase 4g3 introduces a proper reason picker for both mute
// and kick; this PR's job is making the verbs accessible at all.
//
// Conditional rendering:
//   - kicked → render only a disabled stub note ("kicked"); no actions.
//   - paused (alive) → show Resume (primary); hide Pause variants.
//   - muted → show Unmute; hide Mute.
//   - chain mode → hide Mute/Unmute entirely (server returns
//     `chain_mute_unsupported`; ship-side guard saves the round-trip).
//
// Closing: click-outside the panel closes via document mousedown handler;
// Escape closes via keydown. Pattern mirrors how the ProjectList kebab
// (and similar dropdowns elsewhere) would behave when they land.

const DEFAULT_REASON_CODE: ControlReasonCode = 'topology_repair';
const PAUSE_5M_MS = 5 * 60 * 1000;
const PAUSE_15M_MS = 15 * 60 * 1000;
const DEFAULT_EXPIRY_ACTION: PauseExpiryAction = 'auto_resume';

export type ParticipantControlMenuProps = {
  projectId: number;
  /** Display label (typically the agent slug) used for aria + tooltips. */
  agentLabel: string;
  /** Active mode of the bus session; gates mute/unmute visibility. */
  sessionMode: 'chain' | 'orchestrator';
  /** Current control row for this participant (or undefined if untouched). */
  control: ParticipantControlView | undefined;
  /**
   * Operator-driven dispatchers. Each is a thin wrapper around
   * `wsRef.current?.send({type: '...', ...})` in App.tsx; supplying the
   * reason picker is C4g3's job, so for v1 we pin reasonCode to
   * `'topology_repair'` and skip reasonText.
   */
  onMute: (projectId: number, reasonCode: ControlReasonCode) => void;
  onUnmute: (projectId: number, reasonCode: ControlReasonCode) => void;
  onPause: (
    projectId: number,
    reasonCode: ControlReasonCode,
    timeoutMs: number,
    expiryAction: PauseExpiryAction,
  ) => void;
  onResume: (projectId: number, reasonCode: ControlReasonCode) => void;
};

export function ParticipantControlMenu({
  projectId,
  agentLabel,
  sessionMode,
  control,
  onMute,
  onUnmute,
  onPause,
  onResume,
}: ParticipantControlMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Click-outside + Escape dismissal. Both attached only while open to
  // avoid the always-on listener footprint when no menu is on screen.
  useEffect(() => {
    if (!open) return;
    function onMouseDown(ev: MouseEvent) {
      const root = containerRef.current;
      if (!root) return;
      const target = ev.target as Node | null;
      if (target && !root.contains(target)) setOpen(false);
    }
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const isKicked = control?.kickedAt !== null && control?.kickedAt !== undefined;
  const isMuted = control?.muted === true;
  const isPaused =
    control?.pausedUntil !== null &&
    control?.pausedUntil !== undefined &&
    control.pausedUntil > Date.now();
  const muteAvailable = sessionMode === 'orchestrator';

  function close() {
    setOpen(false);
  }
  function handleMute() {
    onMute(projectId, DEFAULT_REASON_CODE);
    close();
  }
  function handleUnmute() {
    onUnmute(projectId, DEFAULT_REASON_CODE);
    close();
  }
  function handlePause(timeoutMs: number) {
    onPause(projectId, DEFAULT_REASON_CODE, timeoutMs, DEFAULT_EXPIRY_ACTION);
    close();
  }
  function handleResume() {
    onResume(projectId, DEFAULT_REASON_CODE);
    close();
  }

  return (
    <div className="ma-control-menu" ref={containerRef}>
      <button
        type="button"
        className="ma-control-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Controls for ${agentLabel}`}
        title={`Mute / pause / resume controls for ${agentLabel}`}
        onClick={() => setOpen((cur) => !cur)}
        disabled={isKicked}
      >
        ⋮
      </button>
      {open && !isKicked && (
        <div role="menu" className="ma-control-menu-panel" aria-label={`${agentLabel} controls`}>
          {muteAvailable && !isMuted && (
            <button
              type="button"
              role="menuitem"
              className="ma-control-menu-item"
              onClick={handleMute}
              title="Drop all outbound bus events from this participant at the router. The agent isn't told — its bus_send returns success regardless."
            >
              <span aria-hidden="true">⊘</span> Mute
            </button>
          )}
          {muteAvailable && isMuted && (
            <button
              type="button"
              role="menuitem"
              className="ma-control-menu-item"
              onClick={handleUnmute}
              title="Stop dropping this participant's outbound bus events. Routing resumes immediately."
            >
              <span aria-hidden="true">⊙</span> Unmute
            </button>
          )}
          {!isPaused && (
            <>
              <button
                type="button"
                role="menuitem"
                className="ma-control-menu-item"
                onClick={() => handlePause(PAUSE_5M_MS)}
                title="Hold incoming deliverTurn calls behind a pause gate for 5 minutes. On expiry: auto-resume."
              >
                <span aria-hidden="true">⏸</span> Pause for 5m
              </button>
              <button
                type="button"
                role="menuitem"
                className="ma-control-menu-item"
                onClick={() => handlePause(PAUSE_15M_MS)}
                title="Hold incoming deliverTurn calls behind a pause gate for 15 minutes. On expiry: auto-resume."
              >
                <span aria-hidden="true">⏸</span> Pause for 15m
              </button>
            </>
          )}
          {isPaused && (
            <button
              type="button"
              role="menuitem"
              className="ma-control-menu-item is-primary"
              onClick={handleResume}
              title="Drain the pause gate; queued deliverTurn calls fire in order."
            >
              <span aria-hidden="true">▶</span> Resume
            </button>
          )}
          {!muteAvailable && (
            <p className="ma-control-menu-hint">
              Mute disabled in chain mode (would break the topology).
            </p>
          )}
        </div>
      )}
    </div>
  );
}
