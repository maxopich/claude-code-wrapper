import { useEffect, useRef } from 'react';
import { useModalSurface } from '../../useModalSurface';
import { AuthorityPanel } from './AuthorityPanel';

// Cluster B Phase 6e (UI-B3 / spec §6.2): "review authority before you
// start" modal.
//
// Reachable from four places (spec §6.2):
//   - ProjectList "+ new chat" row's trailing ⓘ button — `projectIds=[p.id]`
//   - ChatHeaderChip's [See full authority…] link — `projectIds=[active.id]`
//   - DraftView per-participant ⓘ button — `projectIds=[participant.projectId]`
//   - DraftView composer [Inspect authority] ghost-btn — `projectIds=[all participants]`
//
// The single-vs-multi case is encoded in the array length: one panel per
// projectId, stacked vertically. A true "intersection / union" view across
// heterogeneous projects is OQ-B10 (deferred to v1.1) — for now the
// stacked-panel render gives the operator the same data in a slightly less
// digested form, which is honest about the resolver's per-project shape.
//
// UI-B3: default focus on `[Start session]`. The modal is opt-in
// inspection BEFORE starting — the operator's primary action is to confirm
// and proceed. Cancel is reachable via Esc / backdrop click / explicit
// button.
//
// `onStart` is optional: when omitted, the modal is read-only review-only
// (the chip-link callsites pass nothing because they're already inside a
// running session). When provided (e.g. from the +new-chat ⓘ button or the
// DraftView composer button), clicking [Start session] invokes it after
// dismissing the modal — the parent owns the actual start logic.

export type AuthorityPreflightModalProps = {
  projectIds: number[];
  /** Optional: hook fired when the operator clicks [Start session]. When
   *  omitted, the [Start session] button hides — modal is review-only. */
  onStart?: () => void;
  onClose: () => void;
};

export function AuthorityPreflightModal(props: AuthorityPreflightModalProps) {
  const { projectIds, onStart, onClose } = props;
  const { overlayRef, onBackdropMouseDown } = useModalSurface({ onClose });
  const startBtnRef = useRef<HTMLButtonElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Default focus per UI-B3. Falls back to Close when there's no Start
  // affordance (review-only mode).
  useEffect(() => {
    if (onStart && startBtnRef.current) startBtnRef.current.focus();
    else closeBtnRef.current?.focus();
  }, [onStart]);

  const isAggregate = projectIds.length > 1;
  const titleId = `authority-preflight-title-${projectIds.join('-')}`;

  function handleStart() {
    if (!onStart) return;
    onStart();
    onClose();
  }

  return (
    <div
      ref={overlayRef}
      className="gate-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={onBackdropMouseDown}
    >
      <div className="gate-modal modal-surface authority-preflight-modal">
        <header className="gate-modal-header">
          <h3 id={titleId} className="gate-modal-title">
            {isAggregate
              ? `Authority preview · ${projectIds.length} projects`
              : 'Authority preview'}
          </h3>
          <span
            className="gate-modal-reason gate-modal-reason-env"
            aria-label="info: read-only preview"
          >
            preview
          </span>
        </header>
        <p className="gate-modal-help">
          {isAggregate
            ? 'Resolved authority for each participant project — the SDK will load these settings layers when each agent spawns. Review per-project before starting the run.'
            : 'Resolved authority for this project — the SDK will load these settings layers when the session spawns. Review before starting.'}
        </p>
        <div className="authority-preflight-panels">
          {projectIds.map((id) => (
            <AuthorityPanel key={id} projectId={id} mode="preflight" />
          ))}
        </div>
        <div className="gate-modal-buttons">
          <button
            type="button"
            ref={closeBtnRef}
            className="ghost-btn gate-modal-btn"
            onClick={onClose}
          >
            Close
          </button>
          {onStart && (
            <button
              type="button"
              ref={startBtnRef}
              className="ghost-btn gate-modal-btn gate-modal-btn-primary"
              onClick={handleStart}
            >
              Start session
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
