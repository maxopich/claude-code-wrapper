/**
 * Format an elapsed duration as a live `M:SS` (or `H:MM:SS`) counter for the
 * thinking indicator's timer. Distinct from MultiAgentTab's coarse, past-tense
 * `formatDuration` ("47s"/"2m") — this ticks once a second and never rounds.
 *
 * Negative/NaN inputs clamp to 0 so a clock skew can't render "-1:-3".
 */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const sec = totalSec % 60;
  const min = Math.floor(totalSec / 60) % 60;
  const hr = Math.floor(totalSec / 3600);
  const ss = String(sec).padStart(2, '0');
  if (hr > 0) return `${hr}:${String(min).padStart(2, '0')}:${ss}`;
  return `${min}:${ss}`;
}
