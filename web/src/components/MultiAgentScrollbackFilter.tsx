/**
 * Cluster H D8: client-only filter chips for the multi-agent scrollback.
 *
 * Every `multi_agent_event` ServerMsg carries a `kind: MultiAgentEventKind`
 * discriminant (`'intro' | 'prompt' | 'reply' | 'final' | 'error'`); the
 * scrollback can get noisy on long runs and the operator commonly wants to
 * focus on `final` + `error` rows after the fact. This component is the toggle
 * surface — five chips, one per kind, each carrying its KIND_MARK icon and
 * a live count.
 *
 * **Semantic** (matches `useLogFilters` in sessionLog/): the filter set holds
 * the *hidden* kinds — an empty set means "show everything". Toggling a chip
 * adds/removes its kind from the hidden set; Clear empties the set.
 *
 * Rendering: an active chip (kind currently visible) reads as enabled; an
 * inactive chip (kind currently hidden) is dimmed so the filter posture is
 * obvious at a glance. Counts use `tabular-nums` so the column edges line up.
 *
 * Stateless on purpose — the state (and the reset-on-session-change effect)
 * lives in the parent ActiveRunView so the filter survives re-renders of the
 * scrollback below it but resets when the run flips.
 */
import type { MultiAgentEventKind } from '@cebab/shared/protocol';

/**
 * Display order for the chips. Matches the canonical `MULTI_AGENT_EVENT_KINDS`
 * set's insertion order in shared/src/protocol.ts so the chip rail mirrors the
 * scrollback's hop progression (intro → prompt → reply → final → error).
 */
export const SCROLLBACK_FILTER_KINDS: readonly MultiAgentEventKind[] = [
  'intro',
  'prompt',
  'reply',
  'final',
  'error',
];

/**
 * Glyph for each kind. Identical to the `KIND_MARK` table in MultiAgentTab.tsx
 * so the chip's mark and the event-row's mark always match — keeping the chip
 * legible without color in `prefers-contrast: more` and matching the existing
 * no-color-only rule.
 */
const KIND_MARK: Record<MultiAgentEventKind, string> = {
  intro: '↪',
  prompt: '›',
  reply: '↩',
  final: '◼',
  error: '✕',
};

const KIND_LABEL: Record<MultiAgentEventKind, string> = {
  intro: 'intro',
  prompt: 'prompt',
  reply: 'reply',
  final: 'final',
  error: 'error',
};

export function MultiAgentScrollbackFilter(props: {
  /** The set of currently *hidden* kinds. Empty = everything visible. */
  hiddenKinds: ReadonlySet<MultiAgentEventKind>;
  /**
   * Per-kind hop counts in the current run (unfiltered). Used to label each
   * chip with "(N)" so the operator sees the volume each toggle controls.
   * Missing entries are treated as 0 — safe for runs that haven't seen a
   * given kind yet.
   */
  counts: ReadonlyMap<MultiAgentEventKind, number>;
  /** Add/remove the kind from the hidden set. */
  onToggle: (kind: MultiAgentEventKind) => void;
  /** Empty the hidden set — restore the unfiltered view. */
  onReset: () => void;
}) {
  const { hiddenKinds, counts, onToggle, onReset } = props;
  const isFiltering = hiddenKinds.size > 0;

  return (
    <div className="ma-scrollback-filter" role="group" aria-label="Filter scrollback by event kind">
      <span className="ma-scrollback-filter-label">Show:</span>
      {SCROLLBACK_FILTER_KINDS.map((kind) => {
        const isVisible = !hiddenKinds.has(kind);
        const count = counts.get(kind) ?? 0;
        const label = KIND_LABEL[kind];
        return (
          <button
            key={kind}
            type="button"
            className={`ma-scrollback-filter-chip ma-scrollback-filter-chip--${kind}${
              isVisible ? ' is-visible' : ' is-hidden'
            }`}
            aria-pressed={isVisible}
            aria-label={`${label}, ${count} event${count === 1 ? '' : 's'}, ${
              isVisible ? 'visible' : 'hidden'
            }`}
            onClick={() => onToggle(kind)}
            title={
              isVisible ? `Hide ${label} events (${count})` : `Show ${label} events (${count})`
            }
          >
            <span className="ma-scrollback-filter-mark" aria-hidden="true">
              {KIND_MARK[kind]}
            </span>
            <span className="ma-scrollback-filter-kind">{label}</span>
            <span className="ma-scrollback-filter-count" aria-hidden="true">
              {count}
            </span>
          </button>
        );
      })}
      {isFiltering && (
        <button
          type="button"
          className="ghost-btn ma-scrollback-filter-clear"
          onClick={onReset}
          title="Clear scrollback filter — show all event kinds"
        >
          Clear
        </button>
      )}
    </div>
  );
}

/**
 * Aggregate per-kind hop counts over a run's events. Pure helper so the
 * parent can memoize it (`useMemo(() => countByKind(run.events), [run.events])`).
 *
 * O(n) over events; every `multi_agent_event` carries a valid `MultiAgentEventKind`
 * by construction at the server boundary, so an unknown kind cannot reach here
 * — we still default-fall-through with `?? 0` for paranoia.
 */
export function countByKind(
  events: ReadonlyArray<{ kind: MultiAgentEventKind }>,
): Map<MultiAgentEventKind, number> {
  const out = new Map<MultiAgentEventKind, number>();
  for (const k of SCROLLBACK_FILTER_KINDS) out.set(k, 0);
  for (const ev of events) {
    out.set(ev.kind, (out.get(ev.kind) ?? 0) + 1);
  }
  return out;
}
