import type { MessageView } from '../store';

/**
 * Cluster F Phase A1b (UI-A1) — specialized rendering for the
 * `result.subtype === 'error_max_turns'` message.
 *
 * The default result card (in MessageBlock) just says "error_max_turns
 * · $0.xxxx" — that's accurate but useless. The operator needs to
 * decide between continuing with a higher cap or ending the session,
 * and the model's last partial output is right above. This card
 * surfaces both decisions inline.
 *
 * **The Extend +N model.** The SDK has no mid-conversation "raise the
 * cap" verb — the only way to continue is to re-issue `send_message`
 * with `--resume <sessionId>` and a higher `maxTurns`. We send a
 * minimal continuation prompt (`Continue.`) so the model picks up
 * where it left off; the bumped cap rides as `send_message.maxTurns`.
 *
 * **Soft extension limit.** This card doesn't track "how many times
 * have I already extended this session". The spec calls for a 3-extension
 * soft cap with a tooltip warning; that lives in the parent component
 * (App.tsx tracks per-session extensions) and is passed down via the
 * `extensionsUsed` prop. The card itself just renders what it's told
 * about + the operator's options.
 *
 * **Why both +25 and +50.** Quick discrimination: +25 for "almost done,
 * just need a bit more breathing room"; +50 for "this is a longer task
 * than I thought". A single button would be ambiguous; three or more
 * would clutter without informational benefit (the operator can always
 * edit the global default in Settings for sessions that consistently
 * need more turns).
 */

/** Bumps offered by the Extend buttons. Kept narrow on purpose. */
const EXTEND_OPTIONS: readonly number[] = [25, 50];

/** Soft cap on extensions per session — past this, surface a tooltip warning. */
export const EXTENSION_SOFT_CAP = 3;

export type MaxTurnsResultCardProps = {
  /** The result message itself; carries numTurns + effectiveMaxTurns. */
  message: Extract<MessageView, { kind: 'result' }>;
  /**
   * Number of times the operator has already clicked Extend in this
   * session. Drives the soft-cap warning tooltip. App.tsx maintains
   * this counter per-session and resets on each fresh user send.
   */
  extensionsUsed: number;
  /**
   * Called when the operator clicks an Extend button. `bumpBy` is the
   * +N offset; the parent computes the new cap (current + bumpBy) and
   * re-issues send_message with maxTurns set to that value.
   */
  onExtend: (bumpBy: number) => void;
  /**
   * Called when the operator clicks "End session". Default behavior is
   * to dismiss the card visually (the session is already done — the
   * SDK ended the turn with error_max_turns). App.tsx can hook this
   * to additional teardown (e.g. clear local "extensionsUsed" counter)
   * if useful, but no further server roundtrip is needed.
   */
  onEnd: () => void;
};

export function MaxTurnsResultCard({
  message,
  extensionsUsed,
  onExtend,
  onEnd,
}: MaxTurnsResultCardProps) {
  const numTurns = message.numTurns;
  const effectiveMaxTurns = message.effectiveMaxTurns;
  const atSoftCap = extensionsUsed >= EXTENSION_SOFT_CAP;

  // Body copy. Falls back to a generic message when the server didn't
  // ship numTurns/effectiveMaxTurns (older payload pre-A1b) — the
  // Extend buttons would still work because the parent knows the
  // current cap via settings.
  const bodyText =
    numTurns !== undefined && effectiveMaxTurns !== undefined
      ? `The turn ended at ${numTurns} of ${effectiveMaxTurns} max turns.`
      : 'The turn ended because the max-turns cap was reached.';

  return (
    <div className="msg result msg-group err max-turns-card" data-testid="max-turns-result-card">
      <div className="avatar tool" aria-hidden="true">
        ⚠
      </div>
      <div className="msg-body">
        <div className="role">error_max_turns · ${message.cost.toFixed(4)}</div>
        <p className="max-turns-card-body">{bodyText}</p>
        {message.errors && message.errors.length > 0 && (
          <pre className="max-turns-card-errors">{message.errors.join('\n')}</pre>
        )}
        <div className="max-turns-card-actions">
          {EXTEND_OPTIONS.map((bump) => {
            const target = effectiveMaxTurns !== undefined ? effectiveMaxTurns + bump : undefined;
            return (
              <button
                key={bump}
                type="button"
                className="primary-btn max-turns-card-extend"
                onClick={() => onExtend(bump)}
                data-testid={`max-turns-extend-${bump}`}
                title={
                  target !== undefined
                    ? `Continue with cap raised to ${target}`
                    : `Continue with cap raised by ${bump}`
                }
              >
                Extend +{bump}
                {target !== undefined && <span className="max-turns-card-target"> → {target}</span>}
              </button>
            );
          })}
          <button
            type="button"
            className="ghost-btn"
            onClick={onEnd}
            data-testid="max-turns-end-session"
          >
            End session
          </button>
        </div>
        {atSoftCap && (
          <p
            className="max-turns-card-soft-cap"
            data-testid="max-turns-soft-cap-warning"
            role="status"
          >
            Already extended {extensionsUsed}× this session — consider raising the default in
            Settings instead.
          </p>
        )}
      </div>
    </div>
  );
}
