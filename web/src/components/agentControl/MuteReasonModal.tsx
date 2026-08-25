import { useEffect, useRef, useState } from 'react';
import type { ControlReasonCode } from '@cebab/shared/protocol';
import { useModalSurface } from '../../useModalSurface';
import { reasonOptionsFor } from './controlReasons';

// Cluster C Phase 4g5: reason-code picker shared by the non-destructive
// participant control verbs — Mute, Unmute, and Resume. Phase 4g2 pinned
// these to `'topology_repair'` from the menu; 4g3 widened Kick to a full
// picker (KickModal); 4g5 brings the other three in line so every operator
// action lands an explicit ControlReasonCode in the safety_audit row.
//
// Why one component for three actions:
//   - The shape is identical: reason picker + optional notes + submit.
//     The only thing that varies is the title / button label / aria copy.
//   - A shared component keeps the radio list, the 'other'-requires-text
//     rule, and the focus discipline consistent across actions. If we
//     ever change the picker (e.g. add a code), it changes everywhere at
//     once.
//
// Why a modal at all (vs an inline confirm):
//   - The reason picker has 8 options + an optional notes box; that
//     doesn't fit inline in a 200px-wide dropdown.
//   - The notes field needs textarea sizing the dropdown can't offer.
//   - The whole point of the picker is to slow the operator down enough
//     to pick the right reason — a modal hop is the right friction.
//
// Pause is intentionally separate (PauseReasonModal) — its extra
// duration + expiryAction controls would bloat this component beyond
// its non-destructive single-verb shape.
//
// Focus discipline matches KickModal: Cancel button takes initial focus
// so a stray Enter from an unrelated context cannot trip an action. The
// actions here are non-destructive (mute / unmute / resume are all
// reversible), but the symmetry with KickModal helps muscle memory.

export type MuteAction = 'mute' | 'unmute' | 'resume';

type ActionCopy = {
  /** Title and button verb (sentence-cased: "Mute", "Unmute", "Resume") */
  verb: string;
  /** Short help paragraph above the reason picker */
  help: string;
};

const COPY: Record<MuteAction, ActionCopy> = {
  mute: {
    verb: 'Mute',
    // `Cebab-vie.8`: the second sentence about Unmute is the bead's residual.
    // "Reversible via Unmute" was true and read as more than it said — an
    // operator reasonably heard "nothing is lost". What is reversible is the
    // dropping; the messages dropped meanwhile are gone, and Unmute does not
    // replay them (pinned at `server/src/bus/orchestrator.mute.test.ts`). The
    // case that costs the most is muting a participant the orchestrator is
    // waiting on: its reply is discarded and the run is left with nobody
    // working. Cebab now posts a note when that happens, and saying so here is
    // what turns the note from a surprise into the thing they were warned of.
    help: 'Drop every outbound bus event this participant produces at the orchestrator router. The agent is NOT told — its bus_send returns success regardless. Unmute stops the dropping, but does not replay what was dropped: mute a participant the orchestrator is waiting on and its reply is discarded, leaving the run with nobody working until you send a prompt or Stop. Cebab posts a note in the transcript when that happens.',
  },
  unmute: {
    verb: 'Unmute',
    help: 'Stop dropping this participant’s outbound bus events. Routing resumes immediately on subsequent bus_send calls.',
  },
  resume: {
    verb: 'Resume',
    help: 'Drain the pause gate; queued deliverTurn calls fire in order. Any auto-expiry timer for this pause is cancelled.',
  },
};

export type MuteReasonModalProps = {
  action: MuteAction;
  projectId: number;
  agentLabel: string;
  onClose: () => void;
  /**
   * Cebab-u0s: returns whether the verb actually reached the server. On
   * `false` this modal stays open with everything the operator typed still
   * in it, so they can submit again rather than lose the reason to a socket
   * that was not connected.
   */
  onSubmit: (
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
  ) => boolean;
};

export function MuteReasonModal({
  action,
  projectId,
  agentLabel,
  onClose,
  onSubmit,
}: MuteReasonModalProps) {
  // Default 'topology_repair' matches the C4g2 placeholder behavior so
  // an operator who just wants the same default click-path as before
  // can submit without touching the radio.
  const [reasonCode, setReasonCode] = useState<ControlReasonCode>('topology_repair');
  const [reasonText, setReasonText] = useState('');

  const { overlayRef, onBackdropMouseDown } = useModalSurface({ onClose });
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Initial focus on Cancel — matches KickModal even though these
    // verbs are reversible. Symmetry > destructive-only carve-out.
    cancelBtnRef.current?.focus();
  }, []);

  const copy = COPY[action];
  const titleId = `mute-reason-modal-title-${action}-${projectId}`;
  const otherRequiresText = reasonCode === 'other' && reasonText.trim().length === 0;
  const canSubmit = !otherRequiresText;

  function handleSubmit() {
    if (!canSubmit) return;
    const trimmed = reasonText.trim();
    // Cebab-u0s: close only once the verb has gone out. Returning early keeps
    // this component mounted, which is what preserves `reasonText` — the
    // state lives here, so an unmount is what used to destroy it.
    if (!onSubmit(projectId, reasonCode, trimmed.length > 0 ? trimmed : undefined)) return;
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
      <div className={`gate-modal modal-surface mute-reason-modal mute-reason-modal-${action}`}>
        <header className="gate-modal-header">
          <h3 id={titleId} className="gate-modal-title">
            {copy.verb} <code>{agentLabel}</code>?
          </h3>
        </header>
        <p className="gate-modal-help">{copy.help}</p>
        <fieldset className="mute-reason-modal-fieldset">
          <legend className="mute-reason-modal-legend">Reason</legend>
          <ul className="mute-reason-modal-reason-list">
            {reasonOptionsFor(action).map((opt) => (
              <li key={opt.code} className="mute-reason-modal-reason-row">
                <label className="mute-reason-modal-reason-label">
                  <input
                    type="radio"
                    name={titleId}
                    value={opt.code}
                    checked={reasonCode === opt.code}
                    onChange={() => setReasonCode(opt.code)}
                    className="mute-reason-modal-reason-input"
                  />
                  <span className="mute-reason-modal-reason-text">
                    <span className="mute-reason-modal-reason-label-text">{opt.label}</span>
                    <span className="mute-reason-modal-reason-help">{opt.help}</span>
                    {opt.caveat ? (
                      <span className="control-reason-caveat">{opt.caveat}</span>
                    ) : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <label className="mute-reason-modal-text-label">
          <span className="mute-reason-modal-text-label-text">
            Notes {reasonCode === 'other' ? <em>(required)</em> : <em>(optional)</em>}
          </span>
          <textarea
            className="mute-reason-modal-text-input"
            value={reasonText}
            onChange={(e) => setReasonText(e.target.value)}
            placeholder={
              reasonCode === 'other'
                ? `Explain why this ${action} is necessary…`
                : 'Optional context for the audit row…'
            }
            rows={3}
            aria-required={reasonCode === 'other'}
          />
        </label>
        <div className="gate-modal-buttons">
          <button
            type="button"
            ref={cancelBtnRef}
            className="ghost-btn gate-modal-btn"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="ghost-btn gate-modal-btn gate-modal-btn-primary"
            onClick={handleSubmit}
            disabled={!canSubmit}
            title={
              canSubmit
                ? `${copy.verb} ${agentLabel}.`
                : 'Provide a free-text explanation when the reason is "Other".'
            }
          >
            {copy.verb} {agentLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
