import { useEffect, useRef, useState } from 'react';
import type { ClientMsg, ServerMsg } from '@cebab/shared/protocol';
import { useModalSurface } from '../../useModalSurface';

// Cluster B Phase 6a (§4.5, UI/UX spec §5.4): typed-acknowledgment modal
// for `session_start_gated`. When the resolver detects credential-class
// env keys declared in `.claude/settings*.json`, the server parks the
// spawn and the operator must type the exact word "inject" into a confirm
// field before the run proceeds. Anything else: the gate stays parked.
//
// UI contract:
//   - List of detected EnvInjections (key + posture + scope, NEVER values)
//   - Optional reason text field (free-form, persisted into the audit row)
//   - Confirm-input field that must equal "inject" exactly (case-sensitive,
//     matches the server-side ACKNOWLEDGMENT_TRIGGER)
//   - Two buttons: "Refuse & edit" (default focus, closes modal, gate
//     stays parked; operator handles via settings.json edit + reconnect)
//     and "Submit override" (disabled until typed string matches)
//
// BE-B12 [security] preserved: the modal never receives or displays env
// VALUES — only keys + posture + isSet — same shape as the wire envelope.
// A screenshot of this modal leaks nothing the operator hasn't already
// chosen to put in settings.json.

type Pending = Extract<ServerMsg, { type: 'session_start_gated' }>;

const REQUIRED_ACK = 'inject';

export function EnvInjectionGateModal(props: {
  pending: Pending;
  send: (msg: ClientMsg) => void;
  onClose: () => void;
}) {
  const { pending, send, onClose } = props;
  const { overlayRef, onBackdropMouseDown } = useModalSurface({ onClose });

  const [typedAck, setTypedAck] = useState('');
  const [reasonText, setReasonText] = useState('');
  // Default focus: the Refuse button per spec §5.4 — the safer default.
  // Operator must consciously tab over and click Submit to proceed.
  const refuseRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    refuseRef.current?.focus();
  }, []);

  const canSubmit = typedAck === REQUIRED_ACK;

  function onSubmit(): void {
    if (!canSubmit) return;
    const msg: ClientMsg = {
      type: 'acknowledge_and_start',
      pendingStartId: pending.pendingStartId,
      typedAcknowledgment: typedAck,
      ...(reasonText.trim() ? { reasonText: reasonText.trim() } : {}),
    };
    send(msg);
    onClose();
  }

  const titleId = `env-gate-title-${pending.pendingStartId}`;

  return (
    <div
      ref={overlayRef}
      className="gate-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={onBackdropMouseDown}
    >
      <div className="gate-modal modal-surface">
        <header className="gate-modal-header">
          <h3 id={titleId} className="gate-modal-title">
            Confirm environment variable injection
          </h3>
          <span
            className="gate-modal-reason gate-modal-reason-env"
            aria-label="reason: env injection detected"
          >
            env injection
          </span>
        </header>
        <p className="gate-modal-help">
          This project&apos;s <code>.claude/settings*.json</code> declares credential-class
          environment variables that will be injected into the session, bypassing Cebab&apos;s
          subscription-only scrub. Review the keys below and type the confirmation word to proceed.
        </p>
        <ul className="gate-modal-injection-list" aria-label="Detected credential-class env vars">
          {pending.detectedInjections.map((inj) => (
            <li key={`${inj.scope}:${inj.envKey}`} className="gate-modal-injection-row">
              <code className="gate-modal-injection-key">{inj.envKey}</code>
              <span className="gate-modal-injection-posture">{inj.posture}</span>
              <span
                className={`gate-modal-injection-scope gate-modal-injection-scope-${inj.scope}`}
              >
                {inj.scope}
              </span>
              <span
                className={`gate-modal-injection-set ${
                  inj.isSet ? 'gate-modal-injection-set-yes' : 'gate-modal-injection-set-no'
                }`}
                aria-label={inj.isSet ? 'env value currently set' : 'env value currently unset'}
              >
                {inj.isSet ? 'set' : 'unset'}
              </span>
            </li>
          ))}
        </ul>
        <div className="gate-modal-input-row">
          <label htmlFor={`env-gate-reason-${pending.pendingStartId}`} className="gate-modal-label">
            Reason (optional — persisted to the audit log)
          </label>
          <input
            id={`env-gate-reason-${pending.pendingStartId}`}
            type="text"
            className="gate-modal-input"
            value={reasonText}
            onChange={(e) => setReasonText(e.target.value)}
            placeholder="e.g. CI deploy, expected"
            maxLength={200}
          />
        </div>
        <div className="gate-modal-input-row">
          <label htmlFor={`env-gate-ack-${pending.pendingStartId}`} className="gate-modal-label">
            Type <code>{REQUIRED_ACK}</code> to confirm the override
          </label>
          <input
            id={`env-gate-ack-${pending.pendingStartId}`}
            type="text"
            className="gate-modal-input gate-modal-input-ack"
            value={typedAck}
            onChange={(e) => setTypedAck(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`env-gate-ack-help-${pending.pendingStartId}`}
          />
          <span
            id={`env-gate-ack-help-${pending.pendingStartId}`}
            className="gate-modal-input-help"
          >
            Case-sensitive exact match required.
          </span>
        </div>
        <div className="gate-modal-buttons">
          <button
            type="button"
            ref={refuseRef}
            className="ghost-btn gate-modal-btn gate-modal-btn-primary"
            onClick={onClose}
          >
            Refuse &amp; edit
          </button>
          <button
            type="button"
            className="ghost-btn gate-modal-btn gate-modal-btn-danger"
            onClick={onSubmit}
            disabled={!canSubmit}
            aria-disabled={!canSubmit}
          >
            Submit override
          </button>
        </div>
      </div>
    </div>
  );
}
