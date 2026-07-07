import { Icon, type IconName } from './Icon';
import type { MultiAgentState } from '../store';

/**
 * Right-hand inspector rail (redesign Phase 2 shell).
 *
 * Mirrors the left nav-rail's mechanics: an absolute overlay card that
 * hover-expands, pins (grid reflow), and becomes an off-canvas drawer at the
 * narrow tier — all driven by CSS off `.app`'s data-attributes. A fixed-width
 * `.insp-inner` is clipped when collapsed so content doesn't reflow as the
 * rail animates; the glyph stays visible at rail width, the title/body fade in
 * on expand.
 *
 * Phase 2 renders only the frame + a per-view heading. The three real variants
 * (chat = active-run stats/authority/activity, multi = session settings,
 * artifacts = workspace diff) are populated in Phases 3–5.
 */
const VIEW_META: Record<MultiAgentState['view'], { glyph: IconName; title: string }> = {
  chat: { glyph: 'chat', title: 'Run' },
  'multi-agent': { glyph: 'agents', title: 'Session' },
  'chained-chat': { glyph: 'chain', title: 'Chain' },
};

export function Inspector(props: {
  view: MultiAgentState['view'];
  pinned: boolean;
  onTogglePin: () => void;
}) {
  const meta = VIEW_META[props.view];
  return (
    <aside className="inspector" id="app-inspector" aria-label="Inspector">
      <button
        className="pin-btn"
        aria-pressed={props.pinned}
        onClick={props.onTogglePin}
        title={props.pinned ? 'Unpin inspector' : 'Pin inspector open'}
        aria-label={props.pinned ? 'Unpin inspector' : 'Pin inspector open'}
      >
        {props.pinned ? '⇤' : '⇥'}
      </button>
      <div className="insp-inner">
        <div className="insp-head">
          <span className="insp-glyph" aria-hidden="true">
            <Icon name={meta.glyph} />
          </span>
          <span className="insp-title">{meta.title}</span>
        </div>
        <div className="insp-body">
          <p className="insp-empty">
            Run stats, session settings, and workspace changes move here in the next steps of the
            redesign.
          </p>
        </div>
      </div>
    </aside>
  );
}
