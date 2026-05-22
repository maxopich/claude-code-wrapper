import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Project } from '@cebab/shared/protocol';
import { agentIdentity } from '../../agentIdentity';
import {
  FACTOR_BOLD,
  FACTOR_SANS,
  ROLE_PLACEHOLDER,
  fitChars,
  layoutFor,
  truncLabel,
  wrap2,
} from './layout';
import type { LaidBadgeTile, LaidRectTile, LaidTile } from './layout';
import { chooseNextTrip } from './scheduler';

/** Per-trip animation phases (PR-2). The dot makes one hub→agent→hub
 *  trip at a time (mirrors the orchestrator's single sequential
 *  `deliver()` wake). The state carries the SVG offset-path, the leg
 *  direction, the destination's hue var, and a key bumped per trip so
 *  React remounts the <circle> and the CSS animation restarts cleanly
 *  (avoids Firefox's spotty offset-path keyframe chaining). */
type TripState = {
  key: number;
  pid: number;
  pathD: string;
  leg: 'forward' | 'return';
  hueVar: string | null;
  durationMs: number;
};

const TRIP_FORWARD_MS = 700;
const TRIP_PULSE_MS = 200;
const TRIP_RETURN_MS = 700;
const TRIP_DWELL_BASE_MS = 420;
const TRIP_DWELL_JITTER_MS = 60;

const HUB_TOOLTIP =
  'Illustrative order — actual routing is decided by agent capabilities and prompt content.';
const SVG_DESC =
  'Animation shows one message in flight at a time between the orchestrator and each agent. Order is illustrative; at runtime the orchestrator picks recipients based on their capabilities and the prompt.';

/** AC-10: aria-label caps at 5 names + "and N more" in compact view.
 *  Fullscreen (PR-5) will list all. */
function nameRollupForAria(participants: Project[]): string {
  const n = participants.length;
  if (n === 0) return '';
  const prefix = participants
    .slice(0, 5)
    .map((p) => p.name)
    .join(', ');
  return n > 5 ? `${prefix} and ${n - 5} more` : prefix;
}

/**
 * SVG architecture diagram for a template preview: orchestrator
 * hub-and-spoke (six tiers by N — row, arc, ring, twoRing, concentric)
 * or a left→right chain (row, wrap2, wrap3). Geometry is computed in
 * `layoutFor` (a strategy module shared with future fullscreen + custom
 * modes); this file handles rendering, the click-to-edit role overlay,
 * and the per-trip animation state machine. The dot is a CSS Motion
 * Path animation (not SMIL) so it lives in the same
 * prefers-reduced-motion blocks as every other animation; a JS
 * reduced-motion guard also drops the dot element belt-and-braces.
 * No diagram library — crisp, scalable, dependency-free.
 *
 * Tile kinds: PR-3 adds `'badge'` (a circle with a stable per-agent
 * hue ring + glyph) for ring/twoRing/concentric tiers — names/roles
 * live in <title> only at those densities. The trip animation works
 * identically for either tile kind: arrival pulse is a stroke-width
 * bump on the destination's rect or circle.
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
  // Trip animation state (orchestrator only). `trip` is the active leg
  // currently being drawn; `arrivalPid` is set during the 200ms pulse on
  // the destination node between forward and return.
  const [trip, setTrip] = useState<TripState | null>(null);
  const [arrivalPid, setArrivalPid] = useState<number | null>(null);
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

  const reduce =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const layout = layoutFor({ mode, roles }, participants);
  const { squarePx, width, height, geometry, edges } = layout;

  // Stable shape key for the trip-animation effect: re-init when the
  // cycle's "shape" changes (mode, worker set, reduce-motion, or the
  // edit-pause). `participants`/`roles` references churn on parent
  // re-renders without content change, so we hash to a string.
  const orchPids =
    geometry.mode === 'orchestrator' ? geometry.workers.map((w) => w.pid).join(',') : '';
  const orchNames =
    geometry.mode === 'orchestrator' ? geometry.workers.map((w) => w.name).join('|') : '';
  const animKey = `${geometry.mode}|${orchPids}|${orchNames}|${reduce ? 1 : 0}|${editingId ?? 'idle'}`;

  // Effect captures `geometry.workers` and `layout.flowPaths` at run
  // time. They're stable when `animKey` doesn't change (same content
  // even if new array references), so closure capture is safe.
  const workersForTrip = geometry.mode === 'orchestrator' ? geometry.workers : [];
  const flowPaths = layout.flowPaths;
  useEffect(() => {
    if (
      geometry.mode !== 'orchestrator' ||
      workersForTrip.length === 0 ||
      reduce ||
      editingId != null
    ) {
      setTrip(null);
      setArrivalPid(null);
      return;
    }

    let cancelled = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let prevDests: number[] = [];
    let tripKey = 0;
    const sched = (fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      timers.push(t);
    };

    const startTrip = () => {
      if (cancelled) return;
      const destIdx = chooseNextTrip(prevDests, workersForTrip.length);
      prevDests = [...prevDests, destIdx].slice(-3);

      const dest = workersForTrip[destIdx]!;
      const flow = flowPaths.find((f) => f.pid === dest.pid);
      if (!flow) return;
      // Badge tiles already carry their hueVar (always-on identity);
      // rect tiles look it up at trip time so the arrival pulse colors
      // the rect's stroke with the same hue as the dot during transit.
      const hueVar = dest.kind === 'badge' ? dest.hueVar : agentIdentity(dest.name).hueVar;

      tripKey++;
      setTrip({
        key: tripKey,
        pid: dest.pid,
        pathD: flow.d,
        leg: 'forward',
        hueVar,
        durationMs: TRIP_FORWARD_MS,
      });

      sched(() => {
        if (cancelled) return;
        // Arrival pulse on the destination node. Overlaps with the start
        // of the return leg — that's intentional: pulse feedback should
        // land at arrival, not 200ms after.
        setArrivalPid(dest.pid);
        sched(() => {
          if (!cancelled) setArrivalPid(null);
        }, TRIP_PULSE_MS);

        tripKey++;
        setTrip({
          key: tripKey,
          pid: dest.pid,
          pathD: flow.d,
          leg: 'return',
          hueVar,
          durationMs: TRIP_RETURN_MS,
        });

        sched(() => {
          if (cancelled) return;
          // Hub dwell, then next trip. Jitter avoids a metronome look
          // that would imply pipelined real-time RPC.
          const dwell = TRIP_DWELL_BASE_MS + (Math.random() - 0.5) * 2 * TRIP_DWELL_JITTER_MS;
          sched(startTrip, dwell);
        }, TRIP_RETURN_MS);
      }, TRIP_FORWARD_MS);
    };

    startTrip();

    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
    };
    // Deps intentionally limited to animKey: workersForTrip + flowPaths
    // are captured at effect-run time and stay content-stable when
    // animKey is stable (it covers pids, names, mode, reduce, editing).
    // Adding the array refs to deps would cause spurious re-runs on
    // every parent render and reset the cycle.
  }, [animKey]);

  if (n === 0) {
    return <div className="tpl-diagram-empty">(no resolvable participants)</div>;
  }

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

  // Tile renderers. Both branches return a <g data-pid={pid}> with a
  // <title> for screen readers / hover, a clickable shape, and label
  // text (or just a glyph for badges).
  const renderRectTile = (t: LaidRectTile, fsNames: { name: number; role: number }) => {
    const isArrival = arrivalPid === t.pid;
    const arrivalHueVar = isArrival ? agentIdentity(t.name).hueVar : null;
    const rectStyle: CSSProperties | undefined = isArrival
      ? ({
          ['--tpl-trip-hue']: arrivalHueVar ?? 'var(--accent)',
        } as CSSProperties)
      : undefined;
    const roleText = t.role || ROLE_PLACEHOLDER;
    const lines = wrap2(roleText, fitChars(t.innerW, fsNames.role, FACTOR_SANS));
    const cls = t.role ? 'tpl-node-role' : 'tpl-node-role empty';
    const showRole = t.roleY1 != null;
    return (
      <g
        key={`w${t.pid}`}
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
        <rect
          className={`tpl-node-rect${isArrival ? ' is-trip-arrived' : ''}`}
          x={t.x}
          y={t.y}
          width={t.w}
          height={t.h}
          rx={8}
          style={rectStyle}
        />
        <text
          className="tpl-node-name"
          x={t.cx}
          y={t.nameY}
          textAnchor="middle"
          fontSize={fsNames.name}
          fontWeight={600}
        >
          {truncLabel(t.name, fitChars(t.innerW, fsNames.name, FACTOR_BOLD))}
        </text>
        {showRole && t.roleY1 != null && lines.length === 2 && t.roleY2 != null ? (
          <>
            <text className={cls} x={t.cx} y={t.roleY1} textAnchor="middle" fontSize={fsNames.role}>
              {lines[0]}
            </text>
            <text className={cls} x={t.cx} y={t.roleY2} textAnchor="middle" fontSize={fsNames.role}>
              {lines[1]}
            </text>
          </>
        ) : showRole && t.roleY1 != null ? (
          <text className={cls} x={t.cx} y={t.roleY1} textAnchor="middle" fontSize={fsNames.role}>
            {lines[0]}
          </text>
        ) : null}
      </g>
    );
  };

  const renderBadgeTile = (t: LaidBadgeTile) => {
    const isArrival = arrivalPid === t.pid;
    const badgeStyle: CSSProperties = {
      ['--badge-hue']: t.hueVar ?? 'var(--line-3)',
    } as CSSProperties;
    return (
      <g
        key={`w${t.pid}`}
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
        <circle
          className={`tpl-node-badge${isArrival ? ' is-trip-arrived' : ''}`}
          cx={t.cx}
          cy={t.cy}
          r={t.r}
          style={badgeStyle}
        />
        <text
          className="tpl-node-badge-glyph"
          x={t.cx}
          y={t.cy + 4}
          textAnchor="middle"
          fontSize={Math.max(10, Math.round(t.r * 0.85))}
          fontWeight={600}
          style={badgeStyle}
        >
          {t.glyph}
        </text>
      </g>
    );
  };

  const renderTile = (t: LaidTile, fsizes: { name: number; role: number }) =>
    t.kind === 'rect' ? renderRectTile(t, fsizes) : renderBadgeTile(t);

  if (geometry.mode === 'orchestrator') {
    const { hubX, hubY, hubW, hubH, workers, hubLabel, hubSlug } = geometry;
    const fsizes = layout.fontSizes;
    const ariaSuffix = nameRollupForAria(participants);
    const ariaLabel =
      `Orchestrator routing to ${n} worker${n === 1 ? '' : 's'}` +
      (ariaSuffix ? `: ${ariaSuffix}` : '');
    const infoCx = hubX + hubW / 2 - 8;
    const infoCy = hubY + 8;
    // Hub label baseline: with-slug pushes label up so slug fits below;
    // without-slug centers the label vertically.
    const hubLabelY = hubSlug ? hubY + 14 : hubY + hubH / 2 + 4;
    return (
      <div className="tpl-stage" ref={stageRef} style={{ width: squarePx }}>
        <svg
          className="tpl-svg"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={ariaLabel}
        >
          <desc>{SVG_DESC}</desc>
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
            y={hubLabelY}
            textAnchor="middle"
            fontSize={11}
            fontWeight={600}
          >
            {hubLabel}
          </text>
          {hubSlug != null && (
            <text
              className="tpl-node-slug"
              x={hubX}
              y={hubY + 24}
              textAnchor="middle"
              fontSize={8.5}
            >
              {hubSlug}
            </text>
          )}
          {/* Hub info tooltip: a small (i) inside the hub rect's top-right.
             Uses native SVG <title> so the tooltip works without JS. */}
          <g className="tpl-hub-info" transform={`translate(${infoCx}, ${infoCy})`}>
            <title>{HUB_TOOLTIP}</title>
            <circle r={5} className="tpl-hub-info-bg" />
            <text
              className="tpl-hub-info-glyph"
              textAnchor="middle"
              y={3}
              fontSize={8.5}
              fontWeight={600}
            >
              i
            </text>
          </g>
          {workers.map((t) => renderTile(t, fsizes))}
          {!reduce && trip && (
            <circle
              key={trip.key}
              className={`tpl-flow-dot tpl-flow-dot--${trip.leg}`}
              r={3.5}
              style={
                {
                  offsetPath: `path('${trip.pathD}')`,
                  ['--tpl-trip-hue']: trip.hueVar ?? 'var(--accent)',
                  ['--tpl-trip-dur']: `${trip.durationMs}ms`,
                } as CSSProperties
              }
            />
          )}
        </svg>
        {editor}
      </div>
    );
  }

  // Chain — a left→right sequence (or snake-wrapped at N≥11) with
  // arrowed links. AC-5: the dot keeps the prior linear loop (via the
  // `--chain` modifier so the new orchestrator-only animation classes
  // don't accidentally apply here).
  const { tiles } = geometry;
  const fsizes = layout.fontSizes;
  const chainFlow = layout.flowPaths[0]?.d ?? null;
  const ariaSuffix = nameRollupForAria(participants);
  const ariaLabel =
    `Chain of ${n} agent${n === 1 ? '' : 's'}` + (ariaSuffix ? `: ${ariaSuffix}` : '');
  return (
    <div className="tpl-stage" ref={stageRef} style={{ width: squarePx }}>
      <svg
        className="tpl-svg"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={ariaLabel}
      >
        <desc>{SVG_DESC}</desc>
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
        {edges.map((e) => (
          <path key={`l${String(e.to)}`} className="tpl-edge" d={e.d} markerEnd="url(#tpl-arrow)" />
        ))}
        {tiles.map((t) => renderTile(t, fsizes))}
        {!reduce && n >= 2 && chainFlow && (
          <circle
            className="tpl-flow-dot tpl-flow-dot--chain"
            r={3.5}
            style={{ offsetPath: `path('${chainFlow}')` }}
          />
        )}
      </svg>
      {editor}
    </div>
  );
}
