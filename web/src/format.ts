import type { ContentBlock } from '@cebab/shared/protocol';
import type { MessageView } from './store';

/**
 * Relative time ("how long ago"), the ONLY implementation — register N14.
 *
 * There were SEVEN. `ProjectList` and `SessionSearchModal` each had a
 * `formatRelative`; `MultiAgentTab` had `formatAgo` AND `formatRelativeTime`
 * 182 lines apart, disagreeing with each other; `AuthExpiredBanner` and
 * `RecoveryLogInspector` each had a `formatRelativeMs`; and `AuthorityPanel`
 * built one inline. They disagreed on every axis that exists here:
 *
 *   - ROUNDING. Three floored, three rounded. So 90 seconds after an event the
 *     sidebar said `1m` while the multi-agent tab said `2m ago`, at the same
 *     moment, about the same timestamp. That is the defect; the rest is tidying.
 *   - SUB-MINUTE. Three said `45s`, two said `just now`, one had no seconds
 *     band at all.
 *   - CLOCK SKEW. Three leaked negatives (`-5s`, `-0m ago`), three clamped.
 *
 * THE RULES, and why each is the one it is:
 *
 *   - FLOOR, never round. Rounding OVERSTATES elapsed time — 31 seconds is not
 *     "1m ago" — and `formatElapsed` below already floors, so this is the
 *     house convention rather than a new opinion.
 *   - CLAMP negatives (and non-finite) to zero. Stated twice already in this
 *     file: a clock skew must not render `-1:-3`.
 *   - KEEP the seconds band. Collapsing it to "just now" would DISCARD
 *     information on the auth banner, where how stale the session is *is* the
 *     message.
 *
 * `now` is injectable rather than closed over `Date.now()` so callers can pin
 * it — `buildAuthExpiredBannerItem` already threads its own `now` for exactly
 * this reason, and that is worth keeping over module-level mocking.
 *
 * The compact/prose split below is the one difference that was legitimately
 * contextual: a dense sidebar row wants `3m`, a banner sentence wants `3m ago`.
 * Two exports over one core, not two bodies.
 */
function timeAgoParts(ts: number, now: number): { value: number; unit: string } {
  const safeNow = Number.isFinite(now) ? now : 0;
  const diffMs = Number.isFinite(ts) ? Math.max(0, safeNow - ts) : 0;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return { value: sec, unit: 's' };
  const min = Math.floor(sec / 60);
  if (min < 60) return { value: min, unit: 'm' };
  const hr = Math.floor(min / 60);
  if (hr < 24) return { value: hr, unit: 'h' };
  return { value: Math.floor(hr / 24), unit: 'd' };
}

/** Past-tense relative time for prose contexts: `45s ago` … `2d ago`. */
export function timeAgo(ts: number, now: number = Date.now()): string {
  const { value, unit } = timeAgoParts(ts, now);
  return `${value}${unit} ago`;
}

/**
 * Bare relative time for dense contexts (sidebar rows, search results): `45s`
 * … `2d`. Same instant renders the same magnitude as `timeAgo` — only the
 * suffix differs, which is the whole point of sharing the core.
 */
export function timeAgoCompact(ts: number, now: number = Date.now()): string {
  const { value, unit } = timeAgoParts(ts, now);
  return `${value}${unit}`;
}

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
