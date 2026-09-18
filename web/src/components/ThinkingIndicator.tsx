import { useEffect, useState } from 'react';
import { ClaudeMark } from './ClaudeMark';
import { formatElapsed } from '../format';
import { toolActivity, toolActivityText } from '../toolActivity';

/**
 * Animated "the agent is computing" indicator. One component, two shapes:
 *
 *  - `block`  — single-agent chat. Reuses the StreamingPlaceholder chrome
 *    (avatar + msg-body + "claude…" role) so when the first token arrives
 *    and the parent swaps to StreamingPlaceholder it's a seamless body
 *    change, not a component pop. The Claude mark "breathes" a violet glow.
 *  - `inline` — multi-agent roster. A small breathing orb (+ optional timer)
 *    that sits next to the active participant's slug.
 *
 * Escalates over time (the user's pain is minute-long waits): pure animation
 * for the first 10s, then a live M:SS timer fades in and the motion
 * intensifies; at 45s+ a faint reassurance line appears. All escalation is
 * CSS, keyed off the `ti-tier-*` class — this component only picks the tier.
 */

const TIER_ACTIVE_MS = 10_000;
const TIER_LONG_MS = 45_000;

type Tier = 'calm' | 'active' | 'long';

function tierFor(elapsedMs: number): Tier {
  if (elapsedMs >= TIER_LONG_MS) return 'long';
  if (elapsedMs >= TIER_ACTIVE_MS) return 'active';
  return 'calm';
}

/** Ticks once a second while a turn is in flight. A changing number is not a
 *  CSS animation, so it stays informative even under prefers-reduced-motion.
 *  Exported for the multi-agent activity bar, which reuses this tick for the
 *  working/stalled elapsed readout. */
export function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return startedAt == null ? 0 : Math.max(0, now - startedAt);
}

export function ThinkingIndicator(props: {
  variant: 'block' | 'inline';
  phase: 'thinking' | 'tool-running';
  startedAt: number | null;
  /** Tool name for the `tool-running` label (block variant). */
  toolName?: string;
  /**
   * `Cebab-ibb4`: the tool's INPUT, which is where the label's information is.
   * Optional and additive on purpose — the inline variant renders no label at
   * all, so the roster and activity-bar call sites pass a name with no input
   * and are unaffected.
   */
  toolInput?: unknown;
  /** Participant slug — used only for the inline screen-reader label. */
  label?: string;
}) {
  const elapsedMs = useElapsed(props.startedAt);
  const tier = tierFor(elapsedMs);
  const showTimer = props.startedAt != null && tier !== 'calm';
  const phaseTier = `ti-phase-${props.phase} ti-tier-${tier}`;

  if (props.variant === 'inline') {
    return (
      <span
        className={`thinking-indicator ti-inline ${phaseTier}`}
        role="status"
        aria-label={`${props.label ?? 'agent'} working${showTimer ? `, ${formatElapsed(elapsedMs)}` : ''}`}
      >
        <span className="ti-orb" aria-hidden="true" />
        {showTimer && <span className="ti-elapsed">{formatElapsed(elapsedMs)}</span>}
      </span>
    );
  }

  // `Cebab-ibb4`: "running Bash…" was true of nearly every moment of nearly
  // every turn. The subject is the part worth reading, and it is the whole
  // reason the quiet view can put the finished steps away.
  const labelText =
    props.phase === 'tool-running'
      ? `${toolActivityText(toolActivity(props.toolName ?? '', props.toolInput))}…`
      : 'thinking…';

  // Reuse the StreamingPlaceholder chrome (avatar + msg-body + "claude…")
  // verbatim so the swap to streaming text is a seamless body change. The
  // avatar itself ("orb host") breathes a violet glow.
  return (
    <div className={`msg assistant thinking msg-group ti-block ${phaseTier}`}>
      <div className="avatar assistant ti-orb-host" aria-hidden="true">
        <ClaudeMark />
      </div>
      <div className="msg-body">
        <div className="role">claude…</div>
        <div className="thinking-indicator" role="status" aria-live="polite">
          <span className="ti-label">{labelText}</span>
          {showTimer && <span className="ti-elapsed">{formatElapsed(elapsedMs)}</span>}
          {tier === 'long' && (
            <span className="ti-reassure">long tasks can take a few minutes</span>
          )}
        </div>
      </div>
    </div>
  );
}
