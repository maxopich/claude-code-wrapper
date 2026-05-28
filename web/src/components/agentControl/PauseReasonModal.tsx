import { useEffect, useRef, useState } from 'react';
import type { ControlReasonCode, PauseExpiryAction } from '@cebab/shared/protocol';
import { useModalSurface } from '../../useModalSurface';

// Cluster C Phase 4g5: pause-specific reason picker. Extends the
// MuteReasonModal shape with two pause-only controls:
//   - **Duration**: how long the gate stays closed. Quick presets
//     (5m / 15m / 60m) cover the operator-comfort range without typing;
//     a "Custom…" radio reveals a minutes input for the long tail
//     (e.g. "pause for 4h while I review the diff manually").
//   - **On expiry**: what the server does when the timer fires.
//     `auto_resume` (default) drains the queued deliverTurn calls in
//     order — the same as the operator clicking Resume manually.
//     `auto_kick` carries this pause's reasonCode forward into a kick
//     and runs the same kick-forensics capture chain — for cases where
//     the operator wants "give it 5 more minutes, then it's out."
//
// The reason picker mirrors MuteReasonModal verbatim. We deliberately
// don't share the radio list as a sub-component yet — the lists are
// short, identical strings show up in one place per file (and grep-able
// for code review), and the inlining keeps each modal a single-file
// read.
//
// Default selections:
//   - reasonCode: 'topology_repair' (matches the C4g2 placeholder)
//   - duration:   15 minutes (matches the C4g2 "Pause for 15m" preset
//     which we replace with this modal)
//   - expiry:     auto_resume (safer default — auto_kick is destructive)

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

type DurationPreset = '5m' | '15m' | '60m' | 'custom';

const PRESETS: Array<{ key: DurationPreset; label: string; minutes: number | null }> = [
  { key: '5m', label: '5 minutes', minutes: 5 },
  { key: '15m', label: '15 minutes', minutes: 15 },
  { key: '60m', label: '1 hour', minutes: 60 },
  { key: 'custom', label: 'Custom…', minutes: null },
];

// Server-side pause_timeout validator rejects non-positive values; the
// upper bound is a UI sanity cap (24h). Past that, kick is the right
// verb.
const CUSTOM_MIN_MINUTES = 1;
const CUSTOM_MAX_MINUTES = 24 * 60;

const EXPIRY_OPTIONS: Array<{ value: PauseExpiryAction; label: string; help: string }> = [
  {
    value: 'auto_resume',
    label: 'Auto-resume',
    help: 'On expiry, drain the queued deliverTurn calls (same effect as clicking Resume).',
  },
  {
    value: 'auto_kick',
    label: 'Auto-kick',
    help: 'On expiry, kick this participant with the pause’s reasonCode carried forward. Captures a forensic bundle.',
  },
];

export type PauseReasonModalProps = {
  projectId: number;
  agentLabel: string;
  onClose: () => void;
  onSubmit: (
    projectId: number,
    reasonCode: ControlReasonCode,
    reasonText: string | undefined,
    timeoutMs: number,
    expiryAction: PauseExpiryAction,
  ) => void;
};

export function PauseReasonModal({
  projectId,
  agentLabel,
  onClose,
  onSubmit,
}: PauseReasonModalProps) {
  const [reasonCode, setReasonCode] = useState<ControlReasonCode>('topology_repair');
  const [reasonText, setReasonText] = useState('');
  const [durationPreset, setDurationPreset] = useState<DurationPreset>('15m');
  const [customMinutes, setCustomMinutes] = useState<string>('30');
  const [expiryAction, setExpiryAction] = useState<PauseExpiryAction>('auto_resume');

  const { overlayRef, onBackdropMouseDown } = useModalSurface({ onClose });
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelBtnRef.current?.focus();
  }, []);

  const titleId = `pause-reason-modal-title-${projectId}`;
  const otherRequiresText = reasonCode === 'other' && reasonText.trim().length === 0;

  // Resolve the effective duration to a positive integer in ms or null
  // for "invalid input" (which disables submit).
  function resolveMinutes(): number | null {
    if (durationPreset !== 'custom') {
      const preset = PRESETS.find((p) => p.key === durationPreset);
      return preset?.minutes ?? null;
    }
    const parsed = Number.parseInt(customMinutes, 10);
    if (!Number.isFinite(parsed)) return null;
    if (parsed < CUSTOM_MIN_MINUTES || parsed > CUSTOM_MAX_MINUTES) return null;
    return parsed;
  }
  const resolvedMinutes = resolveMinutes();
  const durationValid = resolvedMinutes !== null;
  const canSubmit = !otherRequiresText && durationValid;

  function handleSubmit() {
    if (!canSubmit || resolvedMinutes === null) return;
    const trimmed = reasonText.trim();
    onSubmit(
      projectId,
      reasonCode,
      trimmed.length > 0 ? trimmed : undefined,
      resolvedMinutes * 60_000,
      expiryAction,
    );
    onClose();
  }

  const customInputId = `${titleId}-custom-input`;

  return (
    <div
      ref={overlayRef}
      className="gate-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={onBackdropMouseDown}
    >
      <div className="gate-modal modal-surface pause-reason-modal">
        <header className="gate-modal-header">
          <h3 id={titleId} className="gate-modal-title">
            Pause <code>{agentLabel}</code>?
          </h3>
        </header>
        <p className="gate-modal-help">
          Hold incoming deliverTurn calls for this participant behind a pause gate. The agent is
          NOT told — its bus_send still echoes success, but the orchestrator stops scheduling new
          turns. Queued deliveries fire on Resume (manually or auto-).
        </p>
        <fieldset className="pause-reason-modal-fieldset">
          <legend className="pause-reason-modal-legend">Reason</legend>
          <ul className="pause-reason-modal-reason-list">
            {REASON_OPTIONS.map((opt) => (
              <li key={opt.code} className="pause-reason-modal-reason-row">
                <label className="pause-reason-modal-reason-label">
                  <input
                    type="radio"
                    name={`${titleId}-reason`}
                    value={opt.code}
                    checked={reasonCode === opt.code}
                    onChange={() => setReasonCode(opt.code)}
                    className="pause-reason-modal-reason-input"
                  />
                  <span className="pause-reason-modal-reason-text">
                    <span className="pause-reason-modal-reason-label-text">{opt.label}</span>
                    <span className="pause-reason-modal-reason-help">{opt.help}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <fieldset className="pause-reason-modal-fieldset">
          <legend className="pause-reason-modal-legend">Duration</legend>
          <ul className="pause-reason-modal-duration-list">
            {PRESETS.map((p) => (
              <li key={p.key} className="pause-reason-modal-duration-row">
                <label className="pause-reason-modal-duration-label">
                  <input
                    type="radio"
                    name={`${titleId}-duration`}
                    value={p.key}
                    checked={durationPreset === p.key}
                    onChange={() => setDurationPreset(p.key)}
                    className="pause-reason-modal-duration-input"
                  />
                  <span className="pause-reason-modal-duration-text">{p.label}</span>
                </label>
              </li>
            ))}
          </ul>
          {durationPreset === 'custom' && (
            <div className="pause-reason-modal-custom-wrap">
              <label htmlFor={customInputId} className="pause-reason-modal-custom-label">
                Minutes
              </label>
              <input
                id={customInputId}
                type="number"
                className="pause-reason-modal-custom-input"
                min={CUSTOM_MIN_MINUTES}
                max={CUSTOM_MAX_MINUTES}
                value={customMinutes}
                onChange={(e) => setCustomMinutes(e.target.value)}
                aria-invalid={!durationValid}
              />
              {!durationValid && (
                <span className="pause-reason-modal-custom-error" role="alert">
                  Enter a whole number between {CUSTOM_MIN_MINUTES} and {CUSTOM_MAX_MINUTES}.
                </span>
              )}
            </div>
          )}
        </fieldset>
        <fieldset className="pause-reason-modal-fieldset">
          <legend className="pause-reason-modal-legend">On expiry</legend>
          <ul className="pause-reason-modal-expiry-list">
            {EXPIRY_OPTIONS.map((opt) => (
              <li key={opt.value} className="pause-reason-modal-expiry-row">
                <label className="pause-reason-modal-expiry-label">
                  <input
                    type="radio"
                    name={`${titleId}-expiry`}
                    value={opt.value}
                    checked={expiryAction === opt.value}
                    onChange={() => setExpiryAction(opt.value)}
                    className="pause-reason-modal-expiry-input"
                  />
                  <span className="pause-reason-modal-expiry-text">
                    <span className="pause-reason-modal-expiry-label-text">{opt.label}</span>
                    <span className="pause-reason-modal-expiry-help">{opt.help}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <label className="pause-reason-modal-text-label">
          <span className="pause-reason-modal-text-label-text">
            Notes {reasonCode === 'other' ? <em>(required)</em> : <em>(optional)</em>}
          </span>
          <textarea
            className="pause-reason-modal-text-input"
            value={reasonText}
            onChange={(e) => setReasonText(e.target.value)}
            placeholder={
              reasonCode === 'other'
                ? 'Explain why this pause is necessary…'
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
                ? `Pause ${agentLabel} for ${resolvedMinutes} minute${resolvedMinutes === 1 ? '' : 's'}.`
                : otherRequiresText
                  ? 'Provide a free-text explanation when the reason is "Other".'
                  : 'Enter a valid duration in minutes.'
            }
          >
            Pause {agentLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
