import { useState } from 'react';
import type { StopReasonCode } from '@cebab/shared/protocol';

/**
 * Cluster C Phase 2 (spec §4.2, §4.7 UI-10): inline scrollback marker
 * for an operator-initiated Stop, followed by a non-blocking
 * reason-for-stop prompt.
 *
 * Layout:
 *   ■ Stopped by you · 14:32:05 · ack 42 ms
 *   ┌─ Why did you stop?
 *   │ [Incorrect output] [Runaway loop] [Off task] [Cost] [Done early] [Other] [Skip]
 *   └─ (if Other selected) [text input] [Submit]
 *
 * "Skip" dismisses the prompt without shipping any `stop_reason`
 * message — the audit row simply doesn't exist for that Stop. That's
 * the spec's "skipping is fine; row records reason=unspecified" path
 * (the absence of an event IS the unspecified outcome).
 *
 * "Other" expands an inline text input; Submit is disabled until the
 * text is non-empty. The client guard mirrors the server's drop guard.
 */

const REASON_OPTIONS: ReadonlyArray<{ code: StopReasonCode; label: string }> = [
  { code: 'incorrect_output', label: 'Incorrect output' },
  { code: 'runaway_loop', label: 'Runaway loop' },
  { code: 'off_task', label: 'Off task' },
  { code: 'cost', label: 'Cost' },
  { code: 'done_early', label: 'Done early' },
  { code: 'other', label: 'Other…' },
];

export type StoppedMarkerProps = {
  ts: number;
  ackLatencyMs: number;
  /** True iff the prompt should be hidden (already submitted/skipped). */
  reasonSubmitted: boolean;
  onSubmit: (reasonCode: StopReasonCode, reasonText?: string) => void;
  onSkip: () => void;
};

export function StoppedMarker({
  ts,
  ackLatencyMs,
  reasonSubmitted,
  onSubmit,
  onSkip,
}: StoppedMarkerProps) {
  const [otherText, setOtherText] = useState('');
  const [otherActive, setOtherActive] = useState(false);

  function pickReason(code: StopReasonCode) {
    if (code === 'other') {
      // Toggle the inline text input; don't ship yet.
      setOtherActive(true);
      return;
    }
    onSubmit(code);
  }

  function submitOther() {
    const text = otherText.trim();
    if (!text) return;
    onSubmit('other', text);
  }

  return (
    <div className="stopped-marker" role="status">
      <div className="stopped-marker-line">
        <span className="stopped-marker-glyph" aria-hidden="true">
          ■
        </span>
        <span className="stopped-marker-text">
          Stopped by you · <time dateTime={new Date(ts).toISOString()}>{formatTime(ts)}</time> ·
          ack {formatMs(ackLatencyMs)}
        </span>
      </div>
      {!reasonSubmitted && (
        <div className="stopped-marker-prompt">
          <span className="stopped-marker-prompt-label">Why did you stop?</span>
          <div className="stopped-marker-buttons" role="group" aria-label="Reason for stop">
            {REASON_OPTIONS.map((opt) => (
              <button
                key={opt.code}
                type="button"
                className={
                  opt.code === 'other' && otherActive
                    ? 'secondary-btn stopped-marker-btn is-active'
                    : 'secondary-btn stopped-marker-btn'
                }
                onClick={() => pickReason(opt.code)}
              >
                {opt.label}
              </button>
            ))}
            <button
              type="button"
              className="secondary-btn stopped-marker-btn stopped-marker-skip"
              onClick={onSkip}
            >
              Skip
            </button>
          </div>
          {otherActive && (
            <div className="stopped-marker-other">
              <input
                type="text"
                className="stopped-marker-other-input"
                placeholder="One line — what was wrong?"
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    submitOther();
                  }
                }}
                autoFocus
                maxLength={200}
                aria-label="Other reason text"
              />
              <button
                type="button"
                className="secondary-btn stopped-marker-btn"
                onClick={submitOther}
                disabled={!otherText.trim()}
              >
                Submit
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatTime(ts: number): string {
  // HH:MM:SS in local TZ — matches the spec's "■ Stopped by you · HH:MM:SS"
  // marker. Always two digits per field.
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatMs(ms: number): string {
  // Sub-second → "42 ms"; over 1s → "1.2 s" (rare for runner.interrupt
  // but possible if the SDK held a tool call).
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
