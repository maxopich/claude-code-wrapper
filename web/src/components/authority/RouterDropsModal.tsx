import { useEffect, useRef } from 'react';
import type { RouterDropView } from '../../store';
import { useModalSurface } from '../../useModalSurface';
import { RouterDropsLog } from './RouterDropsLog';

// Cluster B Phase 6d (UI-B25/B27): modal wrapper that hosts the
// RouterDropsLog. Opened by the RouterDropsCounter chip in the activity
// bar.
//
// Reuses useModalSurface (focus trap, body-scroll lock, Esc close, backdrop
// click) — same pattern as McpTofuModal and EnvInjectionGateModal from
// Phase 6a. The Close button gets initial focus so the operator can
// dismiss the modal with a single Enter — no destructive action lives
// inside this modal (read-only inspection).
//
// Why a modal rather than embedding in the activity bar:
//   - Drops include source/dest/reason copy that doesn't fit in the bar
//   - Expanded raw-payload rows can grow tall
//   - Operators reach this view rarely (drops should be zero in healthy
//     ops), so the modal's interruption is appropriate signal
//
// UI-B25 (spec) prefers `logsHashFor + kind=router_drop` opening the
// existing LogsModal pre-filtered. That requires widening LogRowKind in
// shared/server/web (cross-cluster change) and is staged as a follow-up
// PR — Phase 6d's modal gives operators the per-drop detail today without
// that protocol churn.

export function RouterDropsModal(props: {
  drops: RouterDropView[];
  sessionId: string;
  onClose: () => void;
}) {
  const { drops, sessionId, onClose } = props;
  const { overlayRef, onBackdropMouseDown } = useModalSurface({ onClose });
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeBtnRef.current?.focus();
  }, []);
  const titleId = `router-drops-modal-title-${sessionId}`;
  return (
    <div
      ref={overlayRef}
      className="gate-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={onBackdropMouseDown}
    >
      <div className="gate-modal modal-surface router-drops-modal">
        <header className="gate-modal-header">
          <h3 id={titleId} className="gate-modal-title">
            Router drops · {drops.length}
          </h3>
          <span
            className="gate-modal-reason gate-modal-reason-env"
            aria-label="info: read-only inspection"
          >
            read-only
          </span>
        </header>
        <p className="gate-modal-help">
          Every drop already wrote a safety_audit row server-side. This view is operator-facing
          detail; the authoritative trail is the audit table (and a future LogsModal kind-filter
          will let you query it inline).
        </p>
        <RouterDropsLog drops={drops} />
        <div className="gate-modal-buttons">
          <button
            type="button"
            ref={closeBtnRef}
            className="ghost-btn gate-modal-btn gate-modal-btn-primary"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
