import type { Project } from '@cebab/shared/protocol';

/**
 * Layout strategy module for the template preview diagram.
 *
 * `layoutFor` is the single seam where the orchestrator-star, chain, and
 * (future) custom-grid layouts produce the geometric data the renderer
 * consumes. The renderer in `AgentDiagram.tsx` is layout-agnostic in
 * principle: it iterates `nodes`, `edges`, `flowPaths`. Today the two
 * shipping modes (orchestrator + chain) still have small mode-specific
 * render branches because their non-geometric chrome differs (chain
 * uses `<line>` with an arrow marker; orchestrator uses `<path>` and a
 * hub element). PR-3 will collapse those branches once badge layouts
 * arrive.
 *
 * Text-fitting helpers (truncLabel/wrap2/fitChars/etc.) live here too —
 * they're paired with the geometry math that produces tile widths, so
 * keeping them co-located prevents drift.
 */

export const FACTOR_SANS = 0.58;
export const FACTOR_BOLD = 0.62;
export const TILE_PAD_X = 10;
export const ROLE_PLACEHOLDER = 'Role / goal…';

// Stage square side as a function of agent count: small (the diagram
// meet-scales up to fill it, so tiles read big) for a few agents, growing
// per agent up to a hard cap — past the cap more agents meet-scale the
// text down rather than growing the square unbounded.
const SQ_BASE = 320;
const SQ_STEP = 26;
const SQ_CAP = 460;

/** Clip an SVG text label (SVG text has no auto-ellipsis); full name
 * still shows in the role list and the node's <title> tooltip. */
export function truncLabel(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Wrap `text` into ≤2 lines of ~`perLine` chars for an SVG role label
 * (SVG <text> has no wrapping). Roles can be one long space-less token, so
 * this is char-based; if a space sits within the last BREAK_SLACK chars
 * before the cut we break there for a nicer wrap. Line 2 is ellipsised
 * (truncLabel) only when text still remains past the 2-line budget. Full
 * text always stays in the node <title> + the click-to-edit overlay. */
export function wrap2(text: string, perLine: number): [string] | [string, string] {
  const per = Math.max(1, perLine);
  if (text.length <= per) return [text];
  const BREAK_SLACK = 8;
  let cut = per;
  const sp = text.lastIndexOf(' ', per);
  if (sp >= per - BREAK_SLACK && sp > 0) cut = sp;
  const rest = text.slice(cut === sp ? cut + 1 : cut);
  return [text.slice(0, cut), truncLabel(rest, per)];
}

/** The trimmed role text for an agent (whitespace-only ⇒ empty). */
export function roleOf(roles: Record<string, string>, id: number): string {
  return (roles[String(id)] ?? '').trim();
}

// Estimate-only text sizing (no DOM measurement / reflow / font-load
// wait): chars × fontSize × a per-font factor. Mild imprecision is fine —
// tiles are clamped and each line is ellipsised to the final width.
export function estTextW(text: string, fontSize: number, factor: number): number {
  return text.length * fontSize * factor;
}

/** Inverse of estTextW: max chars that fit in `maxPx`. Floors and guards
 * ≥1 so truncLabel (which slices max-1) always gets a sane positive max. */
export function fitChars(maxPx: number, fontSize: number, factor: number): number {
  return Math.max(1, Math.floor(maxPx / (fontSize * factor)));
}

/** Tile width sized so the name fits one line and the role fits in ≤2
 * lines (≈half the single-line role estimate, since it wraps), clamped to
 * [minW, maxW]. Empty role uses the placeholder so empty tiles aren't
 * hairline-thin. */
function tileWidth(
  name: string,
  role: string,
  fsizes: { name: number; role: number },
  minW: number,
  maxW: number,
): number {
  const roleForSize = role || ROLE_PLACEHOLDER;
  const roleHalfW = estTextW(roleForSize, fsizes.role, FACTOR_SANS) / 2;
  const content = Math.max(estTextW(name, fsizes.name, FACTOR_BOLD), roleHalfW);
  return Math.round(Math.min(Math.max(minW, content + 2 * TILE_PAD_X), maxW));
}

export type LayoutNode = {
  pid: number;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: 'worker' | 'hub';
};

export type LayoutEdge = {
  from: number | 'hub';
  to: number | 'hub';
  d: string;
  kind?: 'orch' | 'chain' | 'custom';
};

/** Per-tile rendering payload (extends the geometric LayoutNode with
 *  the values the SVG render loop needs without re-deriving). */
export type LaidTile = {
  pid: number;
  name: string;
  role: string;
  x: number;
  w: number;
  cx: number;
  innerW: number;
};

/** Mode-specific extras the current renderer still needs. PR-3 will
 *  subsume these into a uniform layout-agnostic render path. */
export type OrchestratorGeometry = {
  mode: 'orchestrator';
  workerY: number;
  workerH: number;
  roleY1: number;
  roleY2: number;
  hubX: number;
  hubY: number;
  hubW: number;
  hubH: number;
  workers: LaidTile[];
  hubLabel: string;
  hubSlug: string;
};

export type ChainGeometry = {
  mode: 'chain';
  nodeY: number;
  nodeH: number;
  cy: number;
  roleY1: number;
  roleY2: number;
  tiles: LaidTile[];
};

export type Layout = {
  width: number;
  height: number;
  squarePx: number;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  hub?: LayoutNode;
  flowPaths: Array<{ pid: number; d: string }>;
  fontSizes: { name: number; role: number };
  geometry: OrchestratorGeometry | ChainGeometry;
};

export type LayoutInput = {
  mode: 'chain' | 'orchestrator' | 'custom';
  roles?: Record<string, string>;
  // Future (PR-6): layout?: CustomLayout — overrides node positions and
  // edges when present, falling back to mode rules otherwise.
};

export function layoutFor(input: LayoutInput, participants: Project[]): Layout {
  const roles = input.roles ?? {};
  const n = participants.length;
  const squarePx = Math.min(SQ_CAP, SQ_BASE + (n - 1) * SQ_STEP);

  // 'custom' is a stub in PR-1; PR-6 will read input.layout. For now it
  // falls back to orchestrator (the safer default — chain demands a
  // strict left→right order that custom does not).
  const mode = input.mode === 'custom' ? 'orchestrator' : input.mode;

  if (mode === 'orchestrator') {
    return layoutOrchestratorStar(participants, roles, squarePx);
  }
  return layoutChain(participants, roles, squarePx);
}

function layoutOrchestratorStar(
  participants: Project[],
  roles: Record<string, string>,
  squarePx: number,
): Layout {
  const GAP = 10;
  const SIDE_PAD = 14;
  const HUB_H = 30;
  const HUB_Y = 20;
  const HY = 52;
  const midY = 70;
  const WORKER_Y = 88;
  const WORKER_H = 56;
  const HEIGHT = 150;
  const FS_NAME = 11;
  const FS_ROLE = 10;
  const MIN_W = 96;
  const MAX_W = 168;
  const ROLE_Y1 = WORKER_Y + 30;
  const ROLE_Y2 = WORKER_Y + 42;
  const fsizes = { name: FS_NAME, role: FS_ROLE };

  let acc = SIDE_PAD;
  const workers: LaidTile[] = participants.map((p) => {
    const role = roleOf(roles, p.id);
    const tw = tileWidth(p.name, role, fsizes, MIN_W, MAX_W);
    const t: LaidTile = { pid: p.id, name: p.name, role, x: acc, w: tw, cx: 0, innerW: 0 };
    acc += tw + GAP;
    return t;
  });
  const rowW = acc - GAP - SIDE_PAD;
  const width = rowW + 2 * SIDE_PAD;
  const HX = SIDE_PAD + rowW / 2;
  const HUB_W = Math.round(Math.max(96, estTextW('orchestrator', 11, FACTOR_BOLD) + 24));

  for (const t of workers) {
    t.cx = t.x + t.w / 2;
    t.innerW = t.w - 2 * TILE_PAD_X;
  }

  const edgePath = (cx: number): string =>
    Math.abs(cx - HX) < 0.5
      ? `M${HX} ${HY} V${WORKER_Y}`
      : `M${HX} ${HY} V${midY} H${cx} V${WORKER_Y}`;

  const edges: LayoutEdge[] = workers.map((w) => ({
    from: 'hub',
    to: w.pid,
    d: edgePath(w.cx),
    kind: 'orch',
  }));

  const nodes: LayoutNode[] = workers.map((w) => ({
    pid: w.pid,
    x: w.x,
    y: WORKER_Y,
    w: w.w,
    h: WORKER_H,
    kind: 'worker',
  }));

  const hub: LayoutNode = {
    pid: -1,
    x: HX - HUB_W / 2,
    y: HUB_Y,
    w: HUB_W,
    h: HUB_H,
    kind: 'hub',
  };

  const flowPaths = workers.map((w) => ({ pid: w.pid, d: edgePath(w.cx) }));

  return {
    width,
    height: HEIGHT,
    squarePx,
    nodes,
    edges,
    hub,
    flowPaths,
    fontSizes: fsizes,
    geometry: {
      mode: 'orchestrator',
      workerY: WORKER_Y,
      workerH: WORKER_H,
      roleY1: ROLE_Y1,
      roleY2: ROLE_Y2,
      hubX: HX,
      hubY: HUB_Y,
      hubW: HUB_W,
      hubH: HUB_H,
      workers,
      hubLabel: 'orchestrator',
      hubSlug: 'cebab',
    },
  };
}

function layoutChain(
  participants: Project[],
  roles: Record<string, string>,
  squarePx: number,
): Layout {
  const GAP = 32;
  const SIDE_PAD = 14;
  const NODE_H = 56;
  const NODE_Y = 14;
  const HEIGHT = 84;
  const FS_NAME = 11.5;
  const FS_ROLE = 10;
  const MIN_W = 132;
  const MAX_W = 248;
  const cy = NODE_Y + NODE_H / 2;
  const ROLE_Y1 = NODE_Y + 33;
  const ROLE_Y2 = NODE_Y + 46;
  const fsizes = { name: FS_NAME, role: FS_ROLE };

  let acc = SIDE_PAD;
  const tiles: LaidTile[] = participants.map((p) => {
    const role = roleOf(roles, p.id);
    const tw = tileWidth(p.name, role, fsizes, MIN_W, MAX_W);
    const t: LaidTile = { pid: p.id, name: p.name, role, x: acc, w: tw, cx: 0, innerW: 0 };
    acc += tw + GAP;
    return t;
  });
  const width = acc - GAP - SIDE_PAD + 2 * SIDE_PAD;

  for (const t of tiles) {
    t.cx = t.x + t.w / 2;
    t.innerW = t.w - 2 * TILE_PAD_X;
  }

  const n = tiles.length;
  const first = tiles[0];
  const last = tiles[n - 1];
  const dotPath = first && last ? `M${first.cx} ${cy} L ${last.cx} ${cy}` : null;

  const edges: LayoutEdge[] = tiles.slice(1).map((t, idx) => {
    const prev = tiles[idx]!;
    return {
      from: prev.pid,
      to: t.pid,
      d: `M${prev.x + prev.w} ${cy} L${t.x} ${cy}`,
      kind: 'chain',
    };
  });

  const nodes: LayoutNode[] = tiles.map((t) => ({
    pid: t.pid,
    x: t.x,
    y: NODE_Y,
    w: t.w,
    h: NODE_H,
    kind: 'worker',
  }));

  const flowPaths = dotPath && last ? [{ pid: last.pid, d: dotPath }] : [];

  return {
    width,
    height: HEIGHT,
    squarePx,
    nodes,
    edges,
    flowPaths,
    fontSizes: fsizes,
    geometry: {
      mode: 'chain',
      nodeY: NODE_Y,
      nodeH: NODE_H,
      cy,
      roleY1: ROLE_Y1,
      roleY2: ROLE_Y2,
      tiles,
    },
  };
}
