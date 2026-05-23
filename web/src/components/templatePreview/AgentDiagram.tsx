import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';
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

/** PR-3: protocol description rendered under the diagram as
 *  `<figcaption>`. Distinct from the SVG <desc>: the desc is the
 *  *what's animating* explainer (read by SR via aria-label fallback);
 *  the figcaption is the *static protocol* description (always visible
 *  text under the figure). Both compact card AND modal show this. */
function figcaptionTextFor(mode: 'chain' | 'orchestrator' | 'custom'): string {
  if (mode === 'orchestrator') {
    return 'Workers reply only to the orchestrator — no peer-to-peer messages.';
  }
  if (mode === 'chain') {
    return 'Each agent receives from the prior and forwards to the next — no branching, no replies upstream.';
  }
  // custom — paired with the PR-1 banner + PR-2 notice on the card; the
  // figcaption reinforces the disclaimer at the bottom of the figure.
  return 'Routing is custom and not yet visualized — actual delivery may differ from this preview.';
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
  /** PR-6: widened to include 'custom' for hand-authored topologies.
   *  Today the layout module's `layoutCustomGrid` stub still produces an
   *  orchestrator-shaped fallback — when the editor lands, that one
   *  function gets the new implementation, no prop changes needed. */
  mode: 'chain' | 'orchestrator' | 'custom';
  participants: Project[];
  roles: Record<string, string>;
  onRoleChange: (projectId: number, text: string) => void;
  /** Called only when a cell is committed via the Enter key, with the
   *  committed (projectId, text), so the parent can persist roles right
   *  away (no separate "Save roles" click) and return focus to the pane.
   *  NOT called on blur/scroll close — those stay in-memory only, and
   *  grabbing focus back then is intrusive. */
  onCommitRole?: (projectId: number, text: string) => void;
  /** PR-5: when true, halts trip animation and commits-and-closes any
   *  active overlay editor. Used by the compact diagram when the
   *  fullscreen modal is open — the modal's own AgentDiagram runs
   *  independently and stays interactive. */
  paused?: boolean;
  /** PR-5: when true, tile clicks fire `onSelect` instead of opening
   *  the floating overlay editor. Used by the modal's AgentDiagram
   *  when the split-view side panel is visible — role editing happens
   *  in the panel's textareas, not in the floating overlay. */
  disableOverlayEditor?: boolean;
  /** PR-5 bidi sync: tile with this pid gets `.is-selected` outline.
   *  Set by the split-view panel when a row is focused. */
  selectedPid?: number | null;
  /** PR-5 bidi sync: fired on tile click/Enter/Space so the panel
   *  can scroll the matching row into view + focus its textarea. */
  onSelect?: (projectId: number) => void;
  /** PR-5: when set, renders the `⛶` expand button overlay at the
   *  top-right of `.tpl-stage`. Caller is responsible for opening the
   *  fullscreen modal and capturing the originating button's bounding
   *  rect for the open-animation `transform-origin`. */
  onExpand?: (origin: { x: number; y: number }) => void;
  /** PR-5: shows the non-color-only nudge dot on the expand button —
   *  caller sets this at N≥9, where split-view is auto-on in fullscreen
   *  and the modal is a meaningful upgrade over the compact card. */
  expandNudge?: boolean;
  /** PR-5: when true, stretch the stage to fill its container width
   *  (the modal body). Drops the squarePx-driven width and the
   *  `aspect-ratio: 1/1` square shape so the SVG meet-scales into the
   *  available rectangle. The CSS `.tpl-stage--full` modifier carries
   *  the layout changes. */
  fullWidth?: boolean;
}) {
  const { participants, mode, roles, onRoleChange } = props;
  const n = participants.length;
  const paused = !!props.paused;
  const disableOverlayEditor = !!props.disableOverlayEditor;
  const fullWidth = !!props.fullWidth;

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
    // PR-5: ResizeObserver on the stage covers the fullscreen modal
    // case — there the stage isn't bound to window resize, so the
    // window listener wouldn't fire. (Risk #3.)
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
    const ro = stage && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(close) : null;
    if (ro && stage) ro.observe(stage);
    return () => {
      stage?.removeEventListener('scroll', close);
      window.removeEventListener('resize', close);
      ro?.disconnect();
    };
  }, [editingId]);

  // PR-5: when the modal opens (paused→true) or split-view turns on
  // (disableOverlayEditor→true), commit-and-close the floating overlay
  // editor. The text persists into `roles` via the same path as
  // scroll/resize, so AC-19 (data survives toggle) holds.
  useEffect(() => {
    if (!paused && !disableOverlayEditor) return;
    const id = editingIdRef.current;
    if (id != null) {
      onRoleChangeRef.current(id, draftRef.current);
      setEditingId(null);
      setBox(null);
    }
  }, [paused, disableOverlayEditor]);

  const reduce =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // PR-4: `fullWidth` (modal) flips density to 'full' so layoutFor
  // picks the wider tiles + multi-line names + under-badge labels.
  const layout = layoutFor({ mode, roles, density: fullWidth ? 'full' : 'compact' }, participants);
  const { squarePx, width, height, geometry, edges } = layout;

  // Stable shape key for the trip-animation effect: re-init when the
  // cycle's "shape" changes (mode, worker set, reduce-motion, the
  // edit-pause, or PR-5's pause-while-modal-open). `participants`/`roles`
  // references churn on parent re-renders without content change, so we
  // hash to a string.
  const orchPids =
    geometry.mode === 'orchestrator' ? geometry.workers.map((w) => w.pid).join(',') : '';
  const orchNames =
    geometry.mode === 'orchestrator' ? geometry.workers.map((w) => w.name).join('|') : '';
  const animKey = `${geometry.mode}|${orchPids}|${orchNames}|${reduce ? 1 : 0}|${editingId ?? 'idle'}|${paused ? 'p' : 'r'}`;

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
      editingId != null ||
      paused
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
      // PR-4: both tile kinds carry hueVar (rect tiles got it for the
      // identity chip), so the trip animation reads from one source.
      const hueVar = dest.hueVar;

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

  // PR-5: tile click/key handler. Two responsibilities split by mode:
  //   - bidi sync (always): call `onSelect` so split-view scrolls the
  //     matching row into view + focuses its textarea.
  //   - floating overlay (compact / modal-without-split-view): call
  //     `openEditor`. Suppressed when `disableOverlayEditor` is true —
  //     in that case editing happens in the panel's textarea.
  function onTileActivate(pid: number, gEl: SVGGElement) {
    props.onSelect?.(pid);
    if (!disableOverlayEditor) openEditor(pid, gEl);
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
  //
  // PR-4: rect tiles carry a top-left identity chip (8×8 hue swatch +
  // glyph in agent hue) on tiles tall enough to afford it (h≥30 — i.e.,
  // row/chain-row/chain-wrap, not the 26px arc tile). Identity remains
  // 4-channel (hue + glyph + name + position); any one alone is enough.
  const renderRectTile = (t: LaidRectTile, fsNames: { name: number; role: number }) => {
    const isArrival = arrivalPid === t.pid;
    const isSelected = props.selectedPid === t.pid;
    const arrivalHueVar = isArrival ? t.hueVar : null;
    const rectStyle: CSSProperties | undefined = isArrival
      ? ({
          ['--tpl-trip-hue']: arrivalHueVar ?? 'var(--accent)',
        } as CSSProperties)
      : undefined;
    const roleText = t.role || ROLE_PLACEHOLDER;
    const lines = wrap2(roleText, fitChars(t.innerW, fsNames.role, FACTOR_SANS));
    const cls = t.role ? 'tpl-node-role' : 'tpl-node-role empty';
    const showRole = t.roleY1 != null;
    // Identity chip: only on tiles tall enough to host an 8×8 swatch
    // without crowding the centered name. Arc tier (h=26) skips it.
    const showIdentity = t.h >= 30 && t.hueVar != null;
    const identityStyle: CSSProperties = {
      ['--identity-hue']: t.hueVar ?? 'var(--fg-3)',
    } as CSSProperties;
    const ariaLabel = disableOverlayEditor ? `Select ${t.name}` : `Edit role for ${t.name}`;
    return (
      <g
        key={`w${t.pid}`}
        data-pid={t.pid}
        role="button"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-pressed={isSelected || undefined}
        onClick={(ev) => onTileActivate(t.pid, ev.currentTarget)}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            onTileActivate(t.pid, ev.currentTarget);
          }
        }}
      >
        <title>{t.role ? `${t.name} — ${t.role}` : t.name}</title>
        <rect
          className={`tpl-node-rect${isArrival ? ' is-trip-arrived' : ''}${isSelected ? ' is-selected' : ''}`}
          x={t.x}
          y={t.y}
          width={t.w}
          height={t.h}
          rx={8}
          style={rectStyle}
        />
        {showIdentity && (
          // PR-4 rect identity: an 8×8 hue swatch at top-left (6 px
          // inset) per plan. Small enough that even with a long
          // centered name reaching toward the left edge, the
          // letterform sits over a tiny color block, not a full chip
          // — overlap is visually negligible at 8 px. A standalone
          // glyph (the plan's other carrier) lands in PR-5's
          // fullscreen view where there's room without truncating
          // names further. Hue + name + position still gives a
          // 3-channel identity here.
          <rect
            className="tpl-node-swatch"
            x={t.x + 6}
            y={t.y + 6}
            width={8}
            height={8}
            rx={2}
            style={identityStyle}
          />
        )}
        {/* PR-4: multi-line name when the layout pre-wrapped it
            (`nameLines`). Compact density leaves `nameLines` null/empty
            and falls back to the single-line truncLabel path so the
            existing visual is unchanged. Tspan dy compounds across
            siblings, so each subsequent line shifts down by font size +
            2 px line gap. */}
        {t.nameLines && t.nameLines.length > 1 ? (
          <text
            className="tpl-node-name"
            x={t.cx}
            y={t.nameY}
            textAnchor="middle"
            fontSize={fsNames.name}
            fontWeight={600}
            aria-hidden="true"
          >
            {t.nameLines.map((ln, i) => (
              <tspan key={i} x={t.cx} dy={i === 0 ? 0 : fsNames.name + 2}>
                {ln}
              </tspan>
            ))}
          </text>
        ) : (
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
        )}
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
    const isSelected = props.selectedPid === t.pid;
    const badgeStyle: CSSProperties = {
      ['--badge-hue']: t.hueVar ?? 'var(--line-3)',
    } as CSSProperties;
    const ariaLabel = disableOverlayEditor ? `Select ${t.name}` : `Edit role for ${t.name}`;
    return (
      <g
        key={`w${t.pid}`}
        data-pid={t.pid}
        role="button"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-pressed={isSelected || undefined}
        onClick={(ev) => onTileActivate(t.pid, ev.currentTarget)}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            onTileActivate(t.pid, ev.currentTarget);
          }
        }}
      >
        <title>{t.role ? `${t.name} — ${t.role}` : t.name}</title>
        <circle
          className={`tpl-node-badge${isArrival ? ' is-trip-arrived' : ''}${isSelected ? ' is-selected' : ''}`}
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
          // PR-4: 0.8× radius lands 12px at ring tier (r=15) per plan;
          // smaller for twoRing (r=13 → 10) and concentric (r=11 → 9).
          // Floor at 8 so concentric stays legible.
          fontSize={Math.max(8, Math.round(t.r * 0.8))}
          fontWeight={600}
          style={badgeStyle}
        >
          {t.glyph}
        </text>
        {/* PR-4: under-badge label, full density only (layout sets
            `underLabel` to null in compact). The badge title still
            carries the full name + role for screen readers — this is
            the visual label that lets sighted users name-match without
            reaching for the panel row. */}
        {t.underLabel && t.underLabel.lines.length > 0 && (
          <text
            className="tpl-node-badge-label"
            x={t.cx}
            y={t.underLabel.y}
            textAnchor="middle"
            fontSize={t.underLabel.fontSize}
            fontWeight={600}
            aria-hidden="true"
          >
            {t.underLabel.lines.map((ln, i) => (
              <tspan key={i} x={t.cx} dy={i === 0 ? 0 : (t.underLabel?.fontSize ?? 0) + 2}>
                {ln}
              </tspan>
            ))}
          </text>
        )}
      </g>
    );
  };

  const renderTile = (t: LaidTile, fsizes: { name: number; role: number }) =>
    t.kind === 'rect' ? renderRectTile(t, fsizes) : renderBadgeTile(t);

  // PR-5: shared stage shell (style + keydown + expand overlay) used by
  // both orchestrator and chain branches so the modal-related affordances
  // don't have to be duplicated. `fullWidth` drops the squarePx-driven
  // width AND the `aspect-ratio: 1/1` square (via .tpl-stage--full) so
  // the SVG meet-scales into whatever rectangle the modal body offers.
  const stageStyle: CSSProperties = fullWidth ? {} : { width: squarePx };
  const stageClass = fullWidth ? 'tpl-stage tpl-stage--full' : 'tpl-stage';
  function onStageKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    // PR-5 AC-17: `E` opens the modal when the stage has focus. Ignored
    // in textareas (the role-editor) and inputs, and when a modifier
    // key is held (so cmd+E / ctrl+E browser shortcuts aren't stolen).
    if (!props.onExpand) return;
    if (e.key !== 'e' && e.key !== 'E') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return;
    e.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const r = stage.getBoundingClientRect();
    props.onExpand({ x: r.right - 20, y: r.top + 20 });
  }
  const expandBtn = props.onExpand ? (
    <button
      type="button"
      className={`tpl-expand-btn${props.expandNudge ? ' has-nudge' : ''}`}
      aria-haspopup="dialog"
      aria-label={
        props.expandNudge
          ? `Expand template preview (${n} agents, split view available)`
          : `Expand template preview`
      }
      title="Expand to full screen (E)"
      onClick={(ev) => {
        const rect = ev.currentTarget.getBoundingClientRect();
        props.onExpand?.({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      }}
    >
      <span className="tpl-expand-glyph" aria-hidden="true">
        ⛶
      </span>
      {props.expandNudge && <span className="tpl-expand-nudge" aria-hidden="true" />}
    </button>
  ) : null;

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
    // PR-3: gate arrowheads/tails on protocol mode, not geometry. Custom
    // templates render via the orchestrator branch (layoutCustomGrid stub)
    // but must NOT pretend to be honest orchestrator routing — banner +
    // notice + naked-line edges all reinforce the disclaimer.
    const showMarkers = mode !== 'custom';
    return (
      <figure className={stageClass} ref={stageRef} style={stageStyle} onKeyDown={onStageKeyDown}>
        <svg
          className="tpl-svg"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={ariaLabel}
        >
          <desc>{SVG_DESC}</desc>
          {showMarkers && (
            // PR-3: two markers per edge — small dot at the hub side
            // (`tpl-tail-in`) + arrowhead at the worker side
            // (`tpl-arrow-out`). The combination communicates "hub
            // delivers, worker replies only via the hub" without
            // requiring color contrast (shape carries the meaning).
            // `orient="auto-start-reverse"` so the arrowhead at refX=9
            // points along the path direction; the tail marker is
            // circular so orientation is moot.
            <defs>
              <marker
                id="tpl-arrow-out"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path className="tpl-arrowhead tpl-arrowhead--out" d="M0 0 L10 5 L0 10 z" />
              </marker>
              <marker
                id="tpl-tail-in"
                viewBox="0 0 10 10"
                refX="5"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                orient="auto"
              >
                <circle className="tpl-arrowtail tpl-arrowtail--in" cx="5" cy="5" r="2.5" />
              </marker>
            </defs>
          )}
          {edges.map((e) => {
            // PR-3: SR linearization. The figure's <desc> already says
            // "orchestrator delivers", but per-edge titles let SR users
            // read each routing pair on demand. workerName lookup tolerates
            // the (impossible-in-practice) case of a stale edge ref.
            const workerName =
              typeof e.to === 'number' ? (workers.find((w) => w.pid === e.to)?.name ?? '') : '';
            return (
              <path
                key={`e${String(e.to)}`}
                className="tpl-edge"
                d={e.d}
                markerStart={showMarkers ? 'url(#tpl-tail-in)' : undefined}
                markerEnd={showMarkers ? 'url(#tpl-arrow-out)' : undefined}
              >
                <title>orchestrator → {workerName || String(e.to)}</title>
              </path>
            );
          })}
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
            fontSize={12}
            fontWeight={600}
          >
            {hubLabel}
          </text>
          {hubSlug != null && (
            <text className="tpl-node-slug" x={hubX} y={hubY + 25} textAnchor="middle" fontSize={9}>
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
        {expandBtn}
        <figcaption className="tpl-figcaption">{figcaptionTextFor(mode)}</figcaption>
      </figure>
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
    <figure className={stageClass} ref={stageRef} style={stageStyle} onKeyDown={onStageKeyDown}>
      <svg
        className="tpl-svg"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={ariaLabel}
      >
        <desc>{SVG_DESC}</desc>
        <defs>
          {/* PR-3: chain marker renamed `tpl-arrow` → `tpl-arrow-chain`
              so the orchestrator's two new markers (`tpl-arrow-out`,
              `tpl-tail-in`) live in a non-colliding namespace. Visual
              behavior unchanged. */}
          <marker
            id="tpl-arrow-chain"
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
        {edges.map((e) => {
          // PR-3: per-edge <title> for SR linearization. `from` and `to`
          // are both numbers in chain mode (they index tiles, never the
          // 'hub' sentinel used by orchestrator).
          const fromName =
            typeof e.from === 'number' ? (tiles.find((t) => t.pid === e.from)?.name ?? '') : '';
          const toName =
            typeof e.to === 'number' ? (tiles.find((t) => t.pid === e.to)?.name ?? '') : '';
          return (
            <path
              key={`l${String(e.to)}`}
              className="tpl-edge"
              d={e.d}
              markerEnd="url(#tpl-arrow-chain)"
            >
              <title>
                {fromName || String(e.from)} → {toName || String(e.to)}
              </title>
            </path>
          );
        })}
        {tiles.map((t) => renderTile(t, fsizes))}
        {!reduce && !paused && n >= 2 && chainFlow && (
          <circle
            className="tpl-flow-dot tpl-flow-dot--chain"
            r={3.5}
            style={{ offsetPath: `path('${chainFlow}')` }}
          />
        )}
      </svg>
      {editor}
      {expandBtn}
      <figcaption className="tpl-figcaption">{figcaptionTextFor(mode)}</figcaption>
    </figure>
  );
}
