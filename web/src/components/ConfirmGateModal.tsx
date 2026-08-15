import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useModalSurface } from '../useModalSurface';

/**
 * The one way this app asks "are you sure?" (register U16).
 *
 * Before this, ten consequential actions were gated in four different ways:
 * four native `window.confirm` dialogs that ignore the theme entirely, two
 * in-app typed gates done properly, two more that printed the required token
 * inside the very field asking you to type it, and two actions with no gate at
 * all — one of them sitting in the same row slot as a gated one. An operator
 * cannot learn a rule from that.
 *
 * The shell here is LIFTED from `authority/EnvInjectionGateModal`, which was
 * already the reference implementation, rather than invented: `useModalSurface`
 * for the focus trap / backdrop / Esc, `role="dialog"` + `aria-modal`, default
 * focus on the SAFE button, a typed field with a real `<label>` naming the
 * token, and the `.gate-modal-*` CSS family that already existed. That modal
 * and `reopen/ReopenSessionModal` keep their bespoke bodies (injection lists,
 * workspace diffs) and are deliberately NOT rewritten on top of this — they
 * already behave correctly, and churning two working security gates to prove a
 * point buys the operator nothing.
 *
 * Two frictions, one component:
 *   - plain confirm (`requireTyped` absent) — consequential but reversible;
 *   - typed acknowledgment (`requireTyped: 'delete'`) — irreversible or
 *     security-relevant. The token is named in the `<label>`, never in the
 *     `placeholder`: the friction a typed gate creates is deliberate typing,
 *     not secrecy, but greyed text INSIDE the input puts the answer where the
 *     operator's eye and cursor already are. That distinction is exactly what
 *     U29 was about, and `confirmationStyle.test.ts` holds it.
 *
 * Severity is the CALLER's decision. This component makes the mechanism
 * uniform; it does not decide which actions deserve typing.
 */

export type ConfirmGateModalProps = {
  /** Dialog heading. Phrase it as the question being asked. */
  title: string;
  /** The explanation. A node, not a string, so callers can mark up the target
   *  they are about to act on — naming *what* is half of a confirmation. */
  body: ReactNode;
  /** Label for the destructive action. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Label for the safe action. Defaults to "Cancel". */
  cancelLabel?: string;
  /** When set, the confirm button stays disabled until the operator types this
   *  string exactly (case-sensitive). Absent = a plain confirm. */
  requireTyped?: string;
  /** Styles the confirm button as destructive. Off by default — a gate whose
   *  copy and colour both shout at the operator for a cheap, reversible action
   *  teaches them to click through the ones that matter. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmGateModal(props: ConfirmGateModalProps) {
  const { requireTyped, onConfirm, onCancel } = props;
  const { overlayRef, onBackdropMouseDown } = useModalSurface({ onClose: onCancel });

  const [typed, setTyped] = useState('');
  // Default focus on the SAFE button — the operator has to reach for the other
  // one deliberately. Same posture as EnvInjectionGateModal and
  // ReopenSessionModal; Enter-on-open therefore cancels, never confirms.
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const uid = useId();
  const titleId = `confirm-gate-title-${uid}`;
  const ackId = `confirm-gate-ack-${uid}`;
  const ackHelpId = `confirm-gate-ack-help-${uid}`;

  const canConfirm = requireTyped === undefined || typed === requireTyped;

  function handleConfirm(): void {
    if (!canConfirm) return;
    onConfirm();
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
      <div className="gate-modal modal-surface">
        <header className="gate-modal-header">
          <h3 id={titleId} className="gate-modal-title">
            {props.title}
          </h3>
        </header>
        <div className="gate-modal-help">{props.body}</div>
        {requireTyped !== undefined && (
          <div className="gate-modal-input-row">
            <label htmlFor={ackId} className="gate-modal-label">
              Type <code>{requireTyped}</code> to confirm
            </label>
            <input
              id={ackId}
              type="text"
              className="gate-modal-input gate-modal-input-ack"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canConfirm) {
                  e.preventDefault();
                  handleConfirm();
                }
              }}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={ackHelpId}
              /* No `placeholder`. See the header note — this is the U29 fix,
               * and `confirmationStyle.test.ts` fails if one comes back. */
            />
            <span id={ackHelpId} className="gate-modal-input-help">
              Case-sensitive exact match required.
            </span>
          </div>
        )}
        <div className="gate-modal-buttons">
          <button
            type="button"
            ref={cancelRef}
            className="ghost-btn gate-modal-btn gate-modal-btn-primary"
            onClick={onCancel}
          >
            {props.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            className={`ghost-btn gate-modal-btn${props.danger ? ' gate-modal-btn-danger' : ''}`}
            onClick={handleConfirm}
            disabled={!canConfirm}
            aria-disabled={!canConfirm}
          >
            {props.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
