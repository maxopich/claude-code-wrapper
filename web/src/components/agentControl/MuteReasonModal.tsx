import { useEffect, useRef, useState } from 'react';
import type { ControlReasonCode } from '@cebab/shared/protocol';
import { useModalSurface } from '../../useModalSurface';

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

const REASON_OPTIONS: Array<{ code: ControlReasonCode; label: string; help: string }> = [
  {
    code: 'runaway_loop',
    label: 'Runaway loop',
    help: 'Agent stuck retrying or oscillating without progress.',
  },
  {
    code: 'off_task',
    label: 'Off-task',
    help: "Agent drifted from the relayed request and isn't coming back.",
  },
  {
    code: 'cost_ceiling',
    label: 'Cost ceiling',
    help: 'Cumulative spend or token use is climbing past acceptable bounds.',
  },
  {
    code: 'tool_misuse',
    label: 'Tool misuse',
    help: 'Agent invoked a tool in a way that risks harm or violates policy.',
  },
  {
    code: 'incorrect_output',
    label: 'Incorrect output',
    help: "Agent's most recent answer is wrong and can't be salvaged.",
  },
  {
    code: 'forensics',
    label: 'Forensics',
    help: 'Need to freeze this agent to inspect its state without further mutation.',
  },
  {
    code: 'topology_repair',
    label: 'Topology repair',
    help: 'Operator-driven reshape of the participant set — neutral default.',
  },
  {
    code: 'other',
    label: 'Other',
    help: 'Requires a free-text explanation in the field below.',
  },
];

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
    help: 'Drop every outbound bus event this participant produces at the orchestrator router. The agent is NOT told — its bus_send returns success regardless. Reversible via Unmute.',
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
  onSubmit: (
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
  ) => void;
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
    onSubmit(projectId, reasonCode, trimmed.length > 0 ? trimmed : undefined);
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
            {REASON_OPTIONS.map((opt) => (
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
