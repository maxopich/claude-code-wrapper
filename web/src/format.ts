import type { ContentBlock } from '@cebab/shared/protocol';
import type { MessageView } from './store';

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

/**
 * Cluster H B5: past-tense, single-token duration formatter for the per-turn
 * result footer in `MessageBlock`. Three bands per the UX spec:
 *
 *   - `< 1s`     → `Nms`         (e.g. `42ms`)
 *   - `< 60s`    → `N.Ns`        (e.g. `2.4s`)
 *   - `≥ 60s`    → `Nm Ns`       (e.g. `1m 12s`)
 *
 * Distinct from `formatElapsed` (live `M:SS` ticker for the thinking
 * indicator) and from MultiAgentTab's coarse single-unit `formatDuration`
 * ("47s"/"2m") — those round differently and lose the sub-second resolution
 * we want for `2.4s` vs `2.6s` discrimination on the per-turn footer.
 *
 * Negative/NaN inputs clamp to `0ms` so a clock skew can't render `-42ms`.
 */
export function formatResultDuration(ms: number): string {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (safe < 1000) return `${Math.round(safe)}ms`;
  if (safe < 60_000) return `${(safe / 1000).toFixed(1)}s`;
  const totalSec = Math.round(safe / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

/**
 * Extract the copyable text for a chat message, or `null` when there's nothing
 * worth a copy button (system separators, the per-turn result footer, the
 * interactive permission card). Assistant turns return their joined rendered
 * text blocks — tool_use / tool_result / thinking blocks are dropped so the
 * operator copies the prose, not the JSON scaffolding. Drives the hover copy
 * button in `MessageBlock`.
 */
export function messageCopyText(m: MessageView): string | null {
  switch (m.kind) {
    case 'user':
    case 'command_output':
      return m.text || null;
    case 'error':
      return m.message || null;
    case 'assistant': {
      const text = m.blocks
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n\n')
        .trim();
      return text || null;
    }
    default:
      return null;
  }
}
