/**
 * "+N more" overflow affordance — collapses lanes beyond the visible cap
 * (`LANE_CAP = 4`) into a single pinned button with a popover on hover /
 * focus-within. Each row in the popover is a mini-lane summary so the
 * operator can see *who* is hidden, not just *how many*.
 *
 * No horizontal scroll — this is the only overflow path for v1. A full
 * tab-strip fallback is explicitly deferred to v2.
 *
 * A11y: the trigger is `aria-haspopup="menu"`. The popover itself is just
 * a styled `<ul>` with `role="menu"` and one `role="menuitem"` per row.
 * Each menuitem is keyboard-focusable so a tab visit cycles through the
 * hidden agents.
 */
import type { Lane } from './laneDerivation';
import { agentIdentity } from '../../agentIdentity';

export function LaneOverflowPopover(props: { overflow: Lane[] }) {
  const { overflow } = props;
  if (overflow.length === 0) return null;
  return (
    <aside className="lanes-overflow">
      <button
        type="button"
        className="lanes-overflow-btn"
        aria-haspopup="menu"
        aria-label={`${overflow.length} more agent${overflow.length === 1 ? '' : 's'}`}
        title={`${overflow.length} more agent${overflow.length === 1 ? '' : 's'} are hidden — hover to see them`}
      >
        <span className="lanes-overflow-plus" aria-hidden="true">
          +{overflow.length}
        </span>
        <span className="lanes-overflow-label">more</span>
      </button>
      <ul className="lanes-overflow-menu" role="menu">
        {overflow.map((lane) => {
          const id = agentIdentity(lane.agentName);
          return (
            <li key={lane.agentName} role="menuitem" tabIndex={0} className="lanes-overflow-item">
              <span
                className={`lane-monogram is-mini${id.neutral ? ' is-chrome' : ''}`}
                style={
                  id.hueVar ? ({ '--agent-hue': id.hueVar } as React.CSSProperties) : undefined
                }
                aria-hidden="true"
              >
                {id.glyph}
              </span>
              <span className="lanes-overflow-name" title={lane.agentName}>
                {id.label}
              </span>
              <span className="lanes-overflow-count">{lane.eventCount}</span>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
