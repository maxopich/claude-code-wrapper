import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Project } from '@cebab/shared/protocol';
import {
  FACTOR_BOLD,
  FACTOR_SANS,
  ROLE_PLACEHOLDER,
  fitChars,
  layoutFor,
  truncLabel,
  wrap2,
} from './layout';

/**
 * SVG architecture diagram for a template preview: orchestrator
 * hub-and-spoke or a left→right chain, with one calm "message" dot
 * flowing a representative connector path. Geometry is computed in
 * `layoutFor` (a strategy module shared with future fullscreen + custom
 * modes); this file handles rendering and the click-to-edit role overlay.
 * The dot is a CSS Motion Path animation (not SMIL) so it lives in the
 * same prefers-reduced-motion blocks as every other animation; a JS
 * reduced-motion guard also drops the dot element belt-and-braces.
 * No diagram library — crisp, scalable, dependency-free.
 */
export function AgentDiagram(props: {
  mode: 'chain' | 'orchestrator';
  participants: Project[];
  roles: Record<string, string>;
  onRoleChange: (projectId: number, text: string) => void;
  /** Called only when a cell is committed via the Enter key, with the
   *  committed (projectId, text), so the parent can persist roles right
   *  away (no separate "Save roles" click) and return focus to the pane.
   *  NOT called on blur/scroll close — those stay in-memory only, and
   *  grabbing focus back then is intrusive. */
  onCommitRole?: (projectId: number, text: string) => void;
}) {
  const { participants, mode, roles, onRoleChange } = props;
  const n = participants.length;

  // Click-to-edit overlay. Hooks must precede the n===0 early return
  // (Rules of Hooks). The editor is one absolutely-positioned <textarea>
  // in the (position:relative) .tpl-stage, placed from the clicked node's
  // getBoundingClientRect — scale-proof, so the SVG stays responsive.
  // Live values are mirrored into refs so the scroll/resize listener
  // commits the latest text without re-subscribing per keystroke.
  const stageRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [box, setBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const editingIdRef = useRef<number | null>(null);
  const draftRef = useRef('');
  const onRoleChangeRef = useRef(onRoleChange);
  editingIdRef.current = editingId;
  draftRef.current = draft;
  onRoleChangeRef.current = onRoleChange;
  useLayoutEffect(() => {
    if (editingId != null && taRef.current) {
      taRef.current.focus();
      taRef.current.select();
    }
  }, [editingId]);
  useEffect(() => {
    if (editingId == null) return;
    const stage = stageRef.current;
    // Commit-and-close on scroll/resize: the responsive SVG re-lays-out
    // and .tpl-stage scrolls, so the cached box would drift. Text is
    // never lost (committed); the user re-clicks to keep editing.
    const close = () => {
      const id = editingIdRef.current;
      if (id != null) {
        onRoleChangeRef.current(id, draftRef.current);
        setEditingId(null);
        setBox(null);
      }
    };
    stage?.addEventListener('scroll', close, { passive: true });
    window.addEventListener('resize', close);
    return () => {
      stage?.removeEventListener('scroll', close);
      window.removeEventListener('resize', close);
    };
  }, [editingId]);

  if (n === 0) {
    return <div className="tpl-diagram-empty">(no resolvable participants)</div>;
  }

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const layout = layoutFor({ mode, roles }, participants);
  const { squarePx, width, height, geometry, edges } = layout;
  // PR-1 keeps current behavior: the dot animates the FIRST flow path.
  // PR-2 will round-robin (random anti-repeat) across all of them.
  const firstFlow = layout.flowPaths[0]?.d ?? null;

  function commitIfEditing() {
    if (editingId != null) {
      onRoleChange(editingId, draft);
      setEditingId(null);
      setBox(null);
    }
  }
  function cancelEditing() {
    setEditingId(null);
    setBox(null);
  }
  function openEditor(pid: number, gEl: SVGGElement) {
    // Switching nodes mid-edit commits the current one first.
    commitIfEditing();
    const stage = stageRef.current;
    if (!stage) return;
    const g = gEl.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    setBox({
      left: g.left - s.left + stage.scrollLeft,
      top: g.top - s.top + stage.scrollTop,
      width: g.width,
      height: g.height,
    });
    setDraft(roles[String(pid)] ?? '');
    setEditingId(pid);
  }
  const editor =
    editingId != null && box ? (
      <textarea
        ref={taRef}
        className="tpl-role-edit"
        style={{
          left: box.left,
          top: box.top,
          width: Math.max(box.width, 140),
          minHeight: box.height,
        }}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitIfEditing}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            cancelEditing();
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const pid = editingId;
            const text = draft;
            commitIfEditing();
            if (pid != null) props.onCommitRole?.(pid, text);
          }
          // Shift+Enter falls through → newline (multi-line role)
        }}
        placeholder="Role / goal…"
        aria-label="Edit role"
        spellCheck={false}
      />
    ) : null;

  if (geometry.mode === 'orchestrator') {
    const { workerY, workerH, roleY1, roleY2, hubX, hubY, hubW, hubH, workers, hubLabel, hubSlug } =
      geometry;
    const FS_NAME = layout.fontSizes.name;
    const FS_ROLE = layout.fontSizes.role;
    return (
      <div className="tpl-stage" ref={stageRef} style={{ width: squarePx }}>
        <svg
          className="tpl-svg"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`Orchestrator routing to ${n} worker${n === 1 ? '' : 's'}`}
        >
          {edges.map((e) => (
            <path key={`e${String(e.to)}`} className="tpl-edge" d={e.d} />
          ))}
          <rect
            className="tpl-hub-rect"
            x={hubX - hubW / 2}
            y={hubY}
            width={hubW}
            height={hubH}
            rx={8}
          />
          <text
            className="tpl-hub-text"
            x={hubX}
            y={hubY + 14}
            textAnchor="middle"
            fontSize={11}
            fontWeight={600}
          >
            {hubLabel}
          </text>
          <text className="tpl-node-slug" x={hubX} y={hubY + 24} textAnchor="middle" fontSize={8.5}>
            {hubSlug}
          </text>
          {workers.map((w) => {
            const roleText = w.role || ROLE_PLACEHOLDER;
            return (
              <g
                key={`w${w.pid}`}
                data-pid={w.pid}
                role="button"
                tabIndex={0}
                aria-label={`Edit role for ${w.name}`}
                onClick={(ev) => openEditor(w.pid, ev.currentTarget)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    openEditor(w.pid, ev.currentTarget);
                  }
                }}
              >
                <title>{w.role ? `${w.name} — ${w.role}` : w.name}</title>
                <rect
                  className="tpl-node-rect"
                  x={w.x}
                  y={workerY}
                  width={w.w}
                  height={workerH}
                  rx={8}
                />
                <text
                  className="tpl-node-name"
                  x={w.cx}
                  y={workerY + 16}
                  textAnchor="middle"
                  fontSize={FS_NAME}
                  fontWeight={600}
                >
                  {truncLabel(w.name, fitChars(w.innerW, FS_NAME, FACTOR_BOLD))}
                </text>
                {(() => {
                  const lines = wrap2(roleText, fitChars(w.innerW, FS_ROLE, FACTOR_SANS));
                  const cls = w.role ? 'tpl-node-role' : 'tpl-node-role empty';
                  return lines.length === 2 ? (
                    <>
                      <text
                        className={cls}
                        x={w.cx}
                        y={roleY1}
                        textAnchor="middle"
                        fontSize={FS_ROLE}
                      >
                        {lines[0]}
                      </text>
                      <text
                        className={cls}
                        x={w.cx}
                        y={roleY2}
                        textAnchor="middle"
                        fontSize={FS_ROLE}
                      >
                        {lines[1]}
                      </text>
                    </>
                  ) : (
                    <text
                      className={cls}
                      x={w.cx}
                      y={roleY1}
                      textAnchor="middle"
                      fontSize={FS_ROLE}
                    >
                      {lines[0]}
                    </text>
                  );
                })()}
              </g>
            );
          })}
          {!reduce && firstFlow && (
            <circle
              className="tpl-flow-dot"
              r={3.5}
              style={{ offsetPath: `path('${firstFlow}')` }}
            />
          )}
        </svg>
        {editor}
      </div>
    );
  }

  // Chain — a left→right sequence with arrowed links.
  const { nodeY, nodeH, cy, roleY1, roleY2, tiles } = geometry;
  const FS_NAME = layout.fontSizes.name;
  const FS_ROLE = layout.fontSizes.role;
  return (
    <div className="tpl-stage" ref={stageRef} style={{ width: squarePx }}>
      <svg
        className="tpl-svg"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Chain of ${n} agent${n === 1 ? '' : 's'}`}
      >
        <defs>
          <marker
            id="tpl-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path className="tpl-arrowhead" d="M0 0 L10 5 L0 10 z" />
          </marker>
        </defs>
        {tiles.slice(1).map((t, idx) => {
          const prev = tiles[idx];
          if (!prev) return null;
          return (
            <line
              key={`l${t.pid}`}
              className="tpl-edge"
              x1={prev.x + prev.w}
              y1={cy}
              x2={t.x}
              y2={cy}
              markerEnd="url(#tpl-arrow)"
            />
          );
        })}
        {tiles.map((t) => {
          const roleText = t.role || ROLE_PLACEHOLDER;
          return (
            <g
              key={`n${t.pid}`}
              data-pid={t.pid}
              role="button"
              tabIndex={0}
              aria-label={`Edit role for ${t.name}`}
              onClick={(ev) => openEditor(t.pid, ev.currentTarget)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault();
                  openEditor(t.pid, ev.currentTarget);
                }
              }}
            >
              <title>{t.role ? `${t.name} — ${t.role}` : t.name}</title>
              <rect className="tpl-node-rect" x={t.x} y={nodeY} width={t.w} height={nodeH} rx={8} />
              <text
                className="tpl-node-name"
                x={t.cx}
                y={nodeY + 18}
                textAnchor="middle"
                fontSize={FS_NAME}
                fontWeight={600}
              >
                {truncLabel(t.name, fitChars(t.innerW, FS_NAME, FACTOR_BOLD))}
              </text>
              {(() => {
                const lines = wrap2(roleText, fitChars(t.innerW, FS_ROLE, FACTOR_SANS));
                const cls = t.role ? 'tpl-node-role' : 'tpl-node-role empty';
                return lines.length === 2 ? (
                  <>
                    <text
                      className={cls}
                      x={t.cx}
                      y={roleY1}
                      textAnchor="middle"
                      fontSize={FS_ROLE}
                    >
                      {lines[0]}
                    </text>
                    <text
                      className={cls}
                      x={t.cx}
                      y={roleY2}
                      textAnchor="middle"
                      fontSize={FS_ROLE}
                    >
                      {lines[1]}
                    </text>
                  </>
                ) : (
                  <text className={cls} x={t.cx} y={roleY1} textAnchor="middle" fontSize={FS_ROLE}>
                    {lines[0]}
                  </text>
                );
              })()}
            </g>
          );
        })}
        {!reduce && n >= 2 && firstFlow && (
          <circle className="tpl-flow-dot" r={3.5} style={{ offsetPath: `path('${firstFlow}')` }} />
        )}
      </svg>
      {editor}
    </div>
  );
}
