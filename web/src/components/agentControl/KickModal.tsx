import { useEffect, useRef, useState } from 'react';
import type { ControlReasonCode, KickMode } from '@cebab/shared/protocol';
import { useModalSurface } from '../../useModalSurface';

// Cluster C Phase 4g3: kick confirmation modal with reason-code picker.
// Mounted by ParticipantControlMenu's Kick… item; first surface that
// exposes the full ControlReasonCode vocabulary to the operator (mute /
// pause / resume in 4g2 are pinned to 'topology_repair' as a placeholder
// until 4g4 widens those flows with a similar picker).
//
// Why a modal vs an inline confirm:
//   - Kick is terminal (no unkick verb in v1) — the operator should pause
//     to pick the reason that future forensic readers will see.
//   - The reasonText input is optional EXCEPT for 'other', where it's
//     required by social convention (the dropdown choice doesn't say
//     anything; the freeform text is the only payload that explains the
//     decision).
//   - The body copy can carry the "this will drain the in-flight turn
//     and capture a forensic bundle" warning that's too long for a chip
//     tooltip.
//
// Mode pinned to 'drain': v1 server rejects mode='hard' with
// `hard_kill_unsupported_v1`. The wire shape accepts both for forward-
// compat; this modal does not surface the toggle until the
// AbortController refactor lands (spec §5.2). The pinned 'drain' keeps
// the client honest about server capability.
//
// Failure handling: the server's executor dual-writes per_agent_control
// + safety_audit before echoing `participant_kicked`. Topology guards
// (`chain_topology_broken`, `orchestrator_cannot_kick`,
// `participant_already_kicked`, `participant_not_found`) come back as
// `wrapper_error` ServerMsg that the dispatcher already converts into
// a notification toast — no modal-specific failure UI needed in 4g3.
// The 4g2 menu already disables Kick in chain mode and on
// already-kicked participants, so the user-visible paths to a
// `wrapper_error` are narrow.

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
    help: "Reshuffling the participant set; this agent isn't needed for the current task.",
  },
  {
    code: 'other',
    label: 'Other',
    help: 'Requires a free-text explanation in the field below.',
  },
];

const KICK_MODE: KickMode = 'drain';

export type KickModalProps = {
  projectId: number;
  agentLabel: string;
  onClose: () => void;
  onSubmit: (
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
    mode: KickMode,
  ) => void;
};

export function KickModal({ projectId, agentLabel, onClose, onSubmit }: KickModalProps) {
  // Default selection: 'topology_repair' matches the C4g2 placeholder so
  // operators who just want the same thing as Mute/Pause can submit without
  // touching the radio. Operators with a real reason rarely default-fire;
  // they always pick the right one.
  const [reasonCode, setReasonCode] = useState<ControlReasonCode>('topology_repair');
  const [reasonText, setReasonText] = useState('');

  const { overlayRef, onBackdropMouseDown } = useModalSurface({ onClose });
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Default focus on Cancel, not Kick — operator should not be able to
    // fire a terminal action with a single Enter from no-context.
    cancelBtnRef.current?.focus();
  }, []);

  const titleId = `kick-modal-title-${projectId}`;
  const otherRequiresText = reasonCode === 'other' && reasonText.trim().length === 0;
  const canSubmit = !otherRequiresText;

  function handleSubmit() {
    if (!canSubmit) return;
    const trimmed = reasonText.trim();
    onSubmit(projectId, reasonCode, trimmed.length > 0 ? trimmed : undefined, KICK_MODE);
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
      <div className="gate-modal modal-surface kick-modal">
        <header className="gate-modal-header">
          <h3 id={titleId} className="gate-modal-title">
            Kick <code>{agentLabel}</code>?
          </h3>
          <span className="gate-modal-reason gate-modal-reason-err" aria-label="danger: terminal">
            terminal
          </span>
        </header>
        <p className="gate-modal-help">
          Kick drops this participant from the routing set. The in-flight turn (if any) drains in
          the background; further bus_send calls from this agent are dropped at the router. There
          is no <em>unkick</em> verb — the participant is out for the rest of this session.
        </p>
        <p className="gate-modal-help">
          A multi-agent forensic bundle (recent bus events, mutations attributed to this agent) is
          captured alongside the <code>agent_control.kicked</code> safety_audit row at the moment
          of kick.
        </p>
        <fieldset className="kick-modal-fieldset">
          <legend className="kick-modal-legend">Reason</legend>
          <ul className="kick-modal-reason-list">
            {REASON_OPTIONS.map((opt) => (
              <li key={opt.code} className="kick-modal-reason-row">
                <label className="kick-modal-reason-label">
                  <input
                    type="radio"
                    name={titleId}
                    value={opt.code}
                    checked={reasonCode === opt.code}
                    onChange={() => setReasonCode(opt.code)}
                    className="kick-modal-reason-input"
                  />
                  <span className="kick-modal-reason-text">
                    <span className="kick-modal-reason-label-text">{opt.label}</span>
                    <span className="kick-modal-reason-help">{opt.help}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <label className="kick-modal-text-label">
          <span className="kick-modal-text-label-text">
            Notes {reasonCode === 'other' ? <em>(required)</em> : <em>(optional)</em>}
          </span>
          <textarea
            className="kick-modal-text-input"
            value={reasonText}
            onChange={(e) => setReasonText(e.target.value)}
            placeholder={
              reasonCode === 'other'
                ? 'Explain why this kick is necessary…'
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
            className="ghost-btn gate-modal-btn gate-modal-btn-danger"
            onClick={handleSubmit}
            disabled={!canSubmit}
            title={
              canSubmit
                ? `Kick ${agentLabel} from the session.`
                : 'Provide a free-text explanation when the reason is "Other".'
            }
          >
            Kick {agentLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
