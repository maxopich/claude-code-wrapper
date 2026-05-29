import type { MessageView } from '../store';

/**
 * Cluster F Phase A1b (UI-A1) — turn-counter chip with 80% warn
 * threshold.
 *
 * The SDK doesn't stream a live "turn N of M" counter — `num_turns`
 * lands only on the terminal `result` SDKMessage. So this chip is
 * post-hoc: it shows the last turn's count vs the effective cap as
 * a header chip, warn-coloured when ≥80%.
 *
 * The point isn't real-time progress (no SDK to stream it from) — it's
 * giving the operator a quick "your last turn used 42/50 turns; you're
 * pushing the cap" signal so they can raise the default before the
 * next one runs out. When `num_turns / effectiveMaxTurns ≥ 0.8`, the
 * chip styling shifts to warn; at the cap (which produces
 * `error_max_turns`) the MaxTurnsResultCard takes over the
 * operator-facing decision.
 *
 * Renders null when either field is missing — pre-A1b servers omit
 * both, so the chip simply doesn't appear in legacy mode. Once an
 * `error_max_turns` result lands the chip stays visible (showing
 * `numTurns === effectiveMaxTurns`) — the MaxTurnsResultCard handles
 * the operator's "what now" decision, but the chip is a useful
 * persistent reminder while they're deciding.
 */

const WARN_THRESHOLD = 0.8;

export type TurnCounterChipProps = {
  /**
   * The session's messages array. We scan for the most recent `result`
   * message and read its `numTurns` / `effectiveMaxTurns`. Passing
   * the array directly (not pre-extracted fields) keeps the component
   * self-contained — no extra reducer slice needed just for "last turn
   * counts".
   */
  messages: ReadonlyArray<MessageView>;
};

/**
 * Find the most recent `result` message with both `numTurns` and
 * `effectiveMaxTurns` populated. Older messages (or pre-A1b results
 * that lack these fields) are skipped — the chip should reflect the
 * latest known cap, not an out-of-date snapshot.
 */
export function selectLastTurnCounts(
  messages: ReadonlyArray<MessageView>,
): { numTurns: number; effectiveMaxTurns: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.kind !== 'result') continue;
    if (m.numTurns === undefined || m.effectiveMaxTurns === undefined) continue;
    if (!Number.isFinite(m.numTurns) || !Number.isFinite(m.effectiveMaxTurns)) continue;
    if (m.effectiveMaxTurns <= 0) continue;
    return { numTurns: m.numTurns, effectiveMaxTurns: m.effectiveMaxTurns };
  }
  return null;
}

export function TurnCounterChip({ messages }: TurnCounterChipProps) {
  const last = selectLastTurnCounts(messages);
  if (!last) return null;
  const ratio = last.numTurns / last.effectiveMaxTurns;
  const isWarn = ratio >= WARN_THRESHOLD;
  return (
    <span
      className={`turn-counter-chip${isWarn ? ' is-warn' : ''}`}
      data-testid="turn-counter-chip"
      data-warn={isWarn ? 'true' : 'false'}
      title={
        isWarn
          ? `Last turn used ${last.numTurns} of ${last.effectiveMaxTurns} max turns — at or above 80% of the cap.`
          : `Last turn used ${last.numTurns} of ${last.effectiveMaxTurns} max turns.`
      }
    >
      <span className="turn-counter-chip-label">Turns</span>
      <span className="turn-counter-chip-value">
        {last.numTurns}
        <span className="turn-counter-chip-sep">/</span>
        {last.effectiveMaxTurns}
      </span>
    </span>
  );
}
