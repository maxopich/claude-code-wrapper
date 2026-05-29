import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActiveRunView } from '../../store';
import { RunsDropdown } from './RunsDropdown';

/**
 * Cluster G Phase 3b (G1 UI): the global "what's running right now" pill
 * in the sidebar header, between brand and connection dot. Mirrors
 * `RecoveryLogButton`'s outside-click / Esc / focus-restore pattern so
 * keyboard navigation through the header chrome stays predictable.
 *
 * Mount predicate is strict — `runs.length > 0`. A 0-count badge would
 * be noise (the operator has nothing to act on), and the dispatcher
 * emits an explicit empty snapshot on every WS attach so a stale chip
 * from a previous connection can't survive. Empty-state in the popover
 * itself is defensive only (handles the "last run ended mid-open" race).
 *
 * Geometry reuses `.ma-hop-budget-chip` per ui-agent §6: same pill
 * shape, same typography ramp, with a `.runs-badge` variant for the
 * active-running accent (purple, mirrors `.run-status-running`). The
 * chip stays visible in `sidebarMode === 'rail'` because the
 * sidebar-header-controls strip stays mounted in rail mode — CSS
 * handles that without code changes here.
 */

export type RunsBadgeProps = {
  /** Current snapshot from `state.activeRuns`. */
  runs: ActiveRunView[];
  /**
   * Called with the row payload when the operator clicks a dropdown
   * row. The host (App.tsx) decides what "jump" means: for
   * `kind: 'single'` it selects the session + switches to chat tab; for
   * bus/orchestrator it switches to the multi-agent tab so the active
   * run becomes visible.
   */
  onJump: (run: ActiveRunView) => void;
};

export function RunsBadge({ runs, onJump }: RunsBadgeProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const closePanel = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  // Outside-click + Esc. Bound only while open so the badge doesn't
  // swallow Esc globally when collapsed. The pattern is verbatim from
  // RecoveryLogButton — keep them in sync if you tweak either.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      if (buttonRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Auto-close when the count drops to 0. The chip will unmount on the
  // next render anyway (mount predicate is `runs.length > 0`), but
  // explicit close ensures focus moves out of a disappearing popover.
  useEffect(() => {
    if (open && runs.length === 0) setOpen(false);
  }, [open, runs.length]);

  if (runs.length === 0) return null;

  const count = runs.length;
  const label = count === 1 ? '1 active' : `${count} active`;
  const ariaLabel = `${count} active ${count === 1 ? 'run' : 'runs'}`;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="ma-hop-budget-chip runs-badge"
        title={ariaLabel}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? closePanel() : setOpen(true))}
      >
        <span aria-hidden="true">▶</span>
        <span>{label}</span>
      </button>
      {open && (
        <div
          ref={popoverRef}
          className="runs-dropdown-popover"
          role="dialog"
          aria-label="Active runs"
        >
          <RunsDropdown runs={runs} onJump={onJump} onRequestClose={closePanel} />
        </div>
      )}
    </>
  );
}
