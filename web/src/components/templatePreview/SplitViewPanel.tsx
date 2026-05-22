/**
 * PR-5: Split-view role-editor panel for the fullscreen modal.
 *
 * Rendered to the right of the diagram canvas at ≥1024 px (and stacked
 * below at <768 px via CSS grid). Each row carries the agent's identity
 * chip (8×8 hue swatch + glyph mirrors the canvas) and a plain textarea
 * for the role/goal. Reads/writes roles via the parent's callbacks so
 * `roles` stays the single source of truth across modal toggle (AC-19).
 *
 * Bidi sync (AC-23):
 *  - Canvas tile activation → parent updates `selectedPid` → this panel
 *    scrolls the matching row into view and focuses its textarea.
 *  - Textarea focus → fire `onSelect(pid)` → the canvas tile gets the
 *    `.is-selected` outline.
 *
 * No add/remove of agents here — template authoring is elsewhere.
 */
import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { Project } from '@cebab/shared/protocol';
import { agentIdentity } from '../../agentIdentity';

export function SplitViewPanel(props: {
  participants: Project[];
  roles: Record<string, string>;
  onRoleChange: (projectId: number, text: string) => void;
  onCommitRole?: (projectId: number, text: string) => void;
  selectedPid: number | null;
  onSelect: (projectId: number | null) => void;
}) {
  const { participants, roles, selectedPid } = props;
  const taRefs = useRef(new Map<number, HTMLTextAreaElement>());

  // Bidi sync: scroll + focus the matching textarea when the canvas
  // selects a tile. The previous-pid ref guards against re-focusing
  // on every parent render — we only react when selectedPid changes.
  const prevSelected = useRef<number | null>(null);
  useEffect(() => {
    if (selectedPid === null) {
      prevSelected.current = null;
      return;
    }
    if (selectedPid === prevSelected.current) return;
    prevSelected.current = selectedPid;
    const ta = taRefs.current.get(selectedPid);
    if (!ta) return;
    // Defer one frame so the row's bounding box is settled (newly-mounted
    // panel + selection in the same tick).
    requestAnimationFrame(() => {
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      ta.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' });
      ta.focus({ preventScroll: true });
    });
  }, [selectedPid]);

  return (
    <div className="tpl-panel-inner">
      <header className="tpl-panel-header">
        <h4 className="tpl-panel-heading">
          {participants.length} agent{participants.length === 1 ? '' : 's'}
        </h4>
        <p className="tpl-panel-sub">
          Edit each agent's role. Changes persist on Enter or when you close.
        </p>
      </header>
      <ul className="tpl-panel-list" role="list">
        {participants.map((p) => {
          const ident = agentIdentity(p.name);
          const isSelected = selectedPid === p.id;
          const swatchStyle: CSSProperties = {
            ['--identity-hue']: ident.hueVar ?? 'var(--fg-3)',
          } as CSSProperties;
          const role = roles[String(p.id)] ?? '';
          return (
            <li
              key={p.id}
              className={`tpl-panel-row${isSelected ? ' is-selected' : ''}`}
              data-pid={p.id}
            >
              {/* Avatar-style ident chip: the hue is a translucent
               *  background tint and the glyph sits inside it. Stacking
               *  swatch + glyph stacked vertically looked like duplicate
               *  chips for the ■ glyph case where both shapes are filled
               *  squares — collapsing to one element keeps the carrier
               *  unambiguous. */}
              <div className="tpl-panel-ident" style={swatchStyle} aria-hidden="true">
                <span className="tpl-panel-glyph">{ident.glyph}</span>
              </div>
              <div className="tpl-panel-body">
                <label className="tpl-panel-label" htmlFor={`tpl-panel-ta-${p.id}`}>
                  {p.name}
                </label>
                <textarea
                  id={`tpl-panel-ta-${p.id}`}
                  ref={(el) => {
                    if (el) taRefs.current.set(p.id, el);
                    else taRefs.current.delete(p.id);
                  }}
                  className="tpl-panel-textarea"
                  value={role}
                  placeholder="Role / goal…"
                  spellCheck={false}
                  rows={2}
                  onChange={(e) => props.onRoleChange(p.id, e.target.value)}
                  onFocus={() => props.onSelect(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      e.stopPropagation();
                      props.onCommitRole?.(p.id, role);
                    }
                    // Esc bubbles up to useModalKeys → closes the modal.
                    // The committed value lives in `roles` already (controlled
                    // via onChange), so closing isn't data-lossy.
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
