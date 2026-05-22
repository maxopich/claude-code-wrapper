import type { Project } from '@cebab/shared/protocol';
import { agentIdentity } from '../../agentIdentity';

/**
 * Layout strategy module for the template preview diagram.
 *
 * `layoutFor` picks a geometry strategy based on N (participant count)
 * and mode. The renderer in `AgentDiagram.tsx` is layout-agnostic by
 * tile kind: it iterates `geometry.workers` / `geometry.tiles` and
 * branches on `tile.kind` (`'rect' | 'badge'`).
 *
 * PR-3 introduces six orchestrator tiers and three chain tiers:
 *
 *   orchestrator
 *     center        N=1          rect, role shown, hub+slug above
 *     row           N=2..4       rect row, role shown, hub+slug above
 *     arc           N=5..8       rect tiles on a 180° arc below hub
 *     ring          N=9..14      badges around a centered hub chip
 *     twoRing       N=15..24     inner 8 + outer N−8, badges
 *     concentric    N=25+        ring k holds 6+6k slots
 *   chain
 *     row           N=1..10      linear left→right
 *     wrap2         N=11..20     snake-pattern wrap, 2 rows
 *     wrap3         N=21+        snake-pattern wrap, 3 rows
 *
 * The tier function picks viewBox H, tile kind (rect vs badge), text
 * visibility (role hidden at arc+, name hidden at ring+), and edge
 * geometry (rectilinear for row, straight radial for arc+ring,
 * elbow-jointed for chain wrap).
 *
 * Text-fitting helpers (truncLabel/wrap2/fitChars/etc.) stay here —
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
 * hairline-thin. Caller decides whether to weigh role into the budget
 * (passing role='' skips it — used by tiers that hide roles). */
function tileWidth(
  name: string,
  role: string,
  fsizes: { name: number; role: number },
  minW: number,
  maxW: number,
): number {
  const nameW = estTextW(name, fsizes.name, FACTOR_BOLD);
  const roleForSize = role || (role === '' ? '' : ROLE_PLACEHOLDER);
  const roleHalfW = roleForSize ? estTextW(roleForSize, fsizes.role, FACTOR_SANS) / 2 : 0;
  const content = Math.max(nameW, roleHalfW);
  return Math.round(Math.min(Math.max(minW, content + 2 * TILE_PAD_X), maxW));
}

/** Where a ray from `cx, cy` toward `fromX, fromY` exits the rect
 *  centered at `cx, cy` with size `w × h`. Returns the boundary point on
 *  the rect side closest to the source. Used to anchor edges at the
 *  shape edge rather than the center, so the line doesn't visually pierce
 *  the rect. */
function rectBoundary(
  cx: number,
  cy: number,
  w: number,
  h: number,
  fromX: number,
  fromY: number,
): { x: number; y: number } {
  const dx = fromX - cx;
  const dy = fromY - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const halfW = w / 2;
  const halfH = h / 2;
  const tX = dx !== 0 ? halfW / Math.abs(dx) : Infinity;
  const tY = dy !== 0 ? halfH / Math.abs(dy) : Infinity;
  const t = Math.min(tX, tY);
  return { x: cx + t * dx, y: cy + t * dy };
}

/** Where the boundary of a circle of radius `r` at `cx, cy` meets the
 *  ray heading toward `fromX, fromY`. (Symmetric — circle has no
 *  corners.) */
function circleBoundary(
  cx: number,
  cy: number,
  r: number,
  fromX: number,
  fromY: number,
): { x: number; y: number } {
  const dx = fromX - cx;
  const dy = fromY - cy;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: cx, y: cy };
  return { x: cx + (dx / len) * r, y: cy + (dy / len) * r };
}

// === Tile types ===
export type TileKind = 'rect' | 'badge';

export type LaidRectTile = {
  pid: number;
  name: string;
  role: string;
  kind: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  innerW: number;
  /** Baseline y for the name text. */
  nameY: number;
  /** Baseline y for role line 1. `null` ⇒ hide role entirely. */
  roleY1: number | null;
  /** Baseline y for role line 2 (only used if roleY1 is non-null). */
  roleY2: number | null;
};

export type LaidBadgeTile = {
  pid: number;
  name: string;
  role: string;
  kind: 'badge';
  cx: number;
  cy: number;
  r: number;
  glyph: string;
  hueVar: string | null;
};

export type LaidTile = LaidRectTile | LaidBadgeTile;

// === Public Layout types ===
export type LayoutNode = {
  pid: number;
  kind: 'worker' | 'hub';
  /** Top-left bounding box. Badges report cx-r, cy-r, 2r, 2r. */
  x: number;
  y: number;
  w: number;
  h: number;
  tileKind?: TileKind;
};

export type LayoutEdge = {
  from: number | 'hub';
  to: number | 'hub';
  d: string;
  kind?: 'orch' | 'chain' | 'custom';
};

export type OrchestratorTier = 'center' | 'row' | 'arc' | 'ring' | 'twoRing' | 'concentric';
export type ChainTier = 'row' | 'wrap2' | 'wrap3';

export type OrchestratorGeometry = {
  mode: 'orchestrator';
  tier: OrchestratorTier;
  /** Hub center x (use `hubX - hubW/2` for top-left). */
  hubX: number;
  /** Hub top-left y. */
  hubY: number;
  hubW: number;
  hubH: number;
  hubLabel: string;
  /** `null` ⇒ hide slug (compact hub chip used at ring+ tiers). */
  hubSlug: string | null;
  workers: LaidTile[];
};

export type ChainGeometry = {
  mode: 'chain';
  tier: ChainTier;
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

// === Tier classifiers ===
export function tierForOrchestrator(n: number): OrchestratorTier {
  if (n <= 1) return 'center';
  if (n <= 4) return 'row';
  if (n <= 8) return 'arc';
  if (n <= 14) return 'ring';
  if (n <= 24) return 'twoRing';
  return 'concentric';
}

export function tierForChain(n: number): ChainTier {
  if (n <= 10) return 'row';
  if (n <= 20) return 'wrap2';
  return 'wrap3';
}

// === Public API ===
export function layoutFor(input: LayoutInput, participants: Project[]): Layout {
  const roles = input.roles ?? {};
  const n = participants.length;
  const squarePx = Math.min(SQ_CAP, SQ_BASE + Math.max(0, n - 1) * SQ_STEP);

  // 'custom' is a stub in PR-1/3; PR-6 will read input.layout. For now it
  // falls back to orchestrator (the safer default — chain demands a
  // strict left→right order that custom does not).
  const mode = input.mode === 'custom' ? 'orchestrator' : input.mode;

  if (mode === 'orchestrator') {
    const tier = tierForOrchestrator(n);
    if (tier === 'center' || tier === 'row') {
      return layoutOrchestratorRow(participants, roles, squarePx, tier);
    }
    if (tier === 'arc') return layoutOrchestratorArc(participants, roles, squarePx);
    if (tier === 'ring') return layoutOrchestratorRing(participants, roles, squarePx);
    if (tier === 'twoRing') return layoutOrchestratorTwoRing(participants, roles, squarePx);
    return layoutOrchestratorConcentric(participants, roles, squarePx);
  }

  const tier = tierForChain(n);
  if (tier === 'row') return layoutChainRow(participants, roles, squarePx);
  if (tier === 'wrap2') return layoutChainWrap(participants, roles, squarePx, 2);
  return layoutChainWrap(participants, roles, squarePx, 3);
}

// =====================================================================
// Orchestrator: row (N=1..4)
// =====================================================================
function layoutOrchestratorRow(
  participants: Project[],
  roles: Record<string, string>,
  squarePx: number,
  tier: OrchestratorTier,
): Layout {
  // PR-3 bump: MIN_W 96 → 110 (per plan: tiles read fuller at low N).
  // At N=1 (center), share the row code path with a 1-tile row.
  const GAP = 10;
  const SIDE_PAD = 14;
  const HUB_H = 30;
  const HUB_Y = 20;
  const HY = HUB_Y + HUB_H + 2; // edge start (hub bottom + 2px breathing)
  const midY = 70;
  const WORKER_Y = 88;
  const WORKER_H = 56;
  const HEIGHT = 150;
  // N=1 reads slightly bigger (per plan table); N=2..4 settles to 12/11.
  const FS_NAME = tier === 'center' ? 13 : 12;
  const FS_ROLE = 10;
  const MIN_W = 110;
  const MAX_W = 168;
  const ROLE_Y1 = WORKER_Y + 30;
  const ROLE_Y2 = WORKER_Y + 42;
  const fsizes = { name: FS_NAME, role: FS_ROLE };

  let acc = SIDE_PAD;
  const workers: LaidRectTile[] = participants.map((p) => {
    const role = roleOf(roles, p.id);
    const tw = tileWidth(p.name, role, fsizes, MIN_W, MAX_W);
    const cx = acc + tw / 2;
    const cy = WORKER_Y + WORKER_H / 2;
    const tile: LaidRectTile = {
      pid: p.id,
      name: p.name,
      role,
      kind: 'rect',
      x: acc,
      y: WORKER_Y,
      w: tw,
      h: WORKER_H,
      cx,
      cy,
      innerW: tw - 2 * TILE_PAD_X,
      nameY: WORKER_Y + 16,
      roleY1: ROLE_Y1,
      roleY2: ROLE_Y2,
    };
    acc += tw + GAP;
    return tile;
  });

  const n = participants.length;
  const rowW = n === 0 ? 0 : acc - GAP - SIDE_PAD;
  const width = Math.max(rowW + 2 * SIDE_PAD, 2 * SIDE_PAD);
  const HX = SIDE_PAD + rowW / 2;
  const HUB_W = Math.round(Math.max(96, estTextW('orchestrator', 11, FACTOR_BOLD) + 24));

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
    kind: 'worker',
    x: w.x,
    y: w.y,
    w: w.w,
    h: w.h,
    tileKind: 'rect',
  }));

  const hub: LayoutNode = {
    pid: -1,
    kind: 'hub',
    x: HX - HUB_W / 2,
    y: HUB_Y,
    w: HUB_W,
    h: HUB_H,
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
      tier,
      hubX: HX,
      hubY: HUB_Y,
      hubW: HUB_W,
      hubH: HUB_H,
      hubLabel: 'orchestrator',
      hubSlug: 'cebab',
      workers,
    },
  };
}

// =====================================================================
// Orchestrator: half-arc (N=5..8)
// =====================================================================
function layoutOrchestratorArc(
  participants: Project[],
  roles: Record<string, string>,
  squarePx: number,
): Layout {
  // Hub above; workers along the lower half of a circle centered on the
  // hub. Roles hidden — they live in <title> only (plan table: arc tier
  // hides role text). Names stay visible at FS=11.
  const VBOX_W = 280;
  const VBOX_H = 220;
  const HUB_Y = 14;
  const HUB_H = 26;
  const HUB_W = 100;
  const HX = VBOX_W / 2; // 140
  const HUB_BOT = HUB_Y + HUB_H; // 40
  // Arc center sits BELOW the hub (not at hub center) so the endpoint
  // workers at angle 0/π don't sit at the same vertical band as the hub.
  // All workers end up cleanly below the hub bottom edge.
  const ARC_CY = HUB_BOT + 30; // 70
  const R = Math.round(VBOX_H * 0.42); // 92
  const TILE_W = 70;
  const TILE_H = 26;
  const FS_NAME = 11;
  const FS_ROLE = 10;
  const fsizes = { name: FS_NAME, role: FS_ROLE };

  const n = participants.length;
  const workers: LaidRectTile[] = participants.map((p, i) => {
    // Parameter t ∈ [0, 1]: 0 = leftmost, 1 = rightmost on the half-arc.
    // For n=1 (unused here — tier='center' handles it), default to mid.
    const t = n === 1 ? 0.5 : i / (n - 1);
    const angle = Math.PI * t; // 0..π
    const cx = HX - R * Math.cos(angle);
    const cy = ARC_CY + R * Math.sin(angle);
    return {
      pid: p.id,
      name: p.name,
      role: roleOf(roles, p.id),
      kind: 'rect',
      x: cx - TILE_W / 2,
      y: cy - TILE_H / 2,
      w: TILE_W,
      h: TILE_H,
      cx,
      cy,
      innerW: TILE_W - 2 * TILE_PAD_X,
      // Centered name baseline (no role rendered).
      nameY: cy + 4,
      roleY1: null,
      roleY2: null,
    };
  });

  // Edges: hub bottom-center → worker boundary in the direction of the
  // hub. Straight diagonal lines radiating outward.
  const edges: LayoutEdge[] = workers.map((w) => {
    const end = rectBoundary(w.cx, w.cy, w.w, w.h, HX, HUB_BOT);
    return {
      from: 'hub',
      to: w.pid,
      d: `M${HX} ${HUB_BOT} L${end.x.toFixed(2)} ${end.y.toFixed(2)}`,
      kind: 'orch',
    };
  });

  const nodes: LayoutNode[] = workers.map((w) => ({
    pid: w.pid,
    kind: 'worker',
    x: w.x,
    y: w.y,
    w: w.w,
    h: w.h,
    tileKind: 'rect',
  }));

  const hub: LayoutNode = {
    pid: -1,
    kind: 'hub',
    x: HX - HUB_W / 2,
    y: HUB_Y,
    w: HUB_W,
    h: HUB_H,
  };

  const flowPaths = workers.map((w) => {
    const end = rectBoundary(w.cx, w.cy, w.w, w.h, HX, HUB_BOT);
    return {
      pid: w.pid,
      d: `M${HX} ${HUB_BOT} L${end.x.toFixed(2)} ${end.y.toFixed(2)}`,
    };
  });

  return {
    width: VBOX_W,
    height: VBOX_H,
    squarePx,
    nodes,
    edges,
    hub,
    flowPaths,
    fontSizes: fsizes,
    geometry: {
      mode: 'orchestrator',
      tier: 'arc',
      hubX: HX,
      hubY: HUB_Y,
      hubW: HUB_W,
      hubH: HUB_H,
      hubLabel: 'orchestrator',
      hubSlug: 'cebab',
      workers,
    },
  };
}

// =====================================================================
// Orchestrator: ring (N=9..14)
// =====================================================================
function layoutOrchestratorRing(
  participants: Project[],
  roles: Record<string, string>,
  squarePx: number,
): Layout {
  // Workers as badges around a centered hub chip. Hub label "orchestrator"
  // only (no slug at this density — plan: chrome chip).
  const VBOX_W = 240;
  const VBOX_H = 240;
  const HUB_W = 90;
  const HUB_H = 22;
  const HCX = VBOX_W / 2; // 120
  const HCY = VBOX_H / 2; // 120
  const HUB_Y = HCY - HUB_H / 2; // 109
  const R = 92;
  const BADGE_R = 15;
  // Names hidden on badges (glyph + <title> carry identity); fontSizes
  // still need a value for the typing contract.
  const FS_NAME = 10;
  const FS_ROLE = 10;
  const fsizes = { name: FS_NAME, role: FS_ROLE };

  const n = participants.length;
  const workers: LaidBadgeTile[] = participants.map((p, i) => {
    // Start at top (angle = -π/2) and walk clockwise.
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
    const cx = HCX + R * Math.cos(angle);
    const cy = HCY + R * Math.sin(angle);
    const ident = agentIdentity(p.name);
    return {
      pid: p.id,
      name: p.name,
      role: roleOf(roles, p.id),
      kind: 'badge',
      cx,
      cy,
      r: BADGE_R,
      glyph: ident.glyph,
      hueVar: ident.hueVar,
    };
  });

  // Edge: hub rect boundary → badge boundary in the direction of the hub.
  const edges: LayoutEdge[] = workers.map((w) => {
    const start = rectBoundary(HCX, HCY, HUB_W, HUB_H, w.cx, w.cy);
    const end = circleBoundary(w.cx, w.cy, w.r, HCX, HCY);
    return {
      from: 'hub',
      to: w.pid,
      d: `M${start.x.toFixed(2)} ${start.y.toFixed(2)} L${end.x.toFixed(2)} ${end.y.toFixed(2)}`,
      kind: 'orch',
    };
  });

  const flowPaths = edges.map((e, i) => ({ pid: workers[i]!.pid, d: e.d }));

  const nodes: LayoutNode[] = workers.map((w) => ({
    pid: w.pid,
    kind: 'worker',
    x: w.cx - w.r,
    y: w.cy - w.r,
    w: 2 * w.r,
    h: 2 * w.r,
    tileKind: 'badge',
  }));

  const hub: LayoutNode = {
    pid: -1,
    kind: 'hub',
    x: HCX - HUB_W / 2,
    y: HUB_Y,
    w: HUB_W,
    h: HUB_H,
  };

  return {
    width: VBOX_W,
    height: VBOX_H,
    squarePx,
    nodes,
    edges,
    hub,
    flowPaths,
    fontSizes: fsizes,
    geometry: {
      mode: 'orchestrator',
      tier: 'ring',
      hubX: HCX,
      hubY: HUB_Y,
      hubW: HUB_W,
      hubH: HUB_H,
      hubLabel: 'orchestrator',
      hubSlug: null,
      workers,
    },
  };
}

// =====================================================================
// Orchestrator: two-ring (N=15..24)
// =====================================================================
function layoutOrchestratorTwoRing(
  participants: Project[],
  roles: Record<string, string>,
  squarePx: number,
): Layout {
  const VBOX_W = 280;
  const VBOX_H = 280;
  const HUB_W = 90;
  const HUB_H = 22;
  const HCX = VBOX_W / 2; // 140
  const HCY = VBOX_H / 2; // 140
  const HUB_Y = HCY - HUB_H / 2; // 129
  const R_INNER = 70;
  const R_OUTER = 118;
  const BADGE_R = 13;
  const FS_NAME = 10;
  const FS_ROLE = 10;
  const fsizes = { name: FS_NAME, role: FS_ROLE };

  const n = participants.length;
  const innerN = Math.min(8, n);
  const outerN = n - innerN;
  // Outer rotated half-step (360°/(2·outerN)) for staggered visual.
  const outerRot = outerN > 0 ? Math.PI / outerN : 0;

  const workers: LaidBadgeTile[] = participants.map((p, i) => {
    const ident = agentIdentity(p.name);
    let cx: number;
    let cy: number;
    if (i < innerN) {
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / innerN;
      cx = HCX + R_INNER * Math.cos(angle);
      cy = HCY + R_INNER * Math.sin(angle);
    } else {
      const oi = i - innerN;
      const angle = -Math.PI / 2 + outerRot + (2 * Math.PI * oi) / outerN;
      cx = HCX + R_OUTER * Math.cos(angle);
      cy = HCY + R_OUTER * Math.sin(angle);
    }
    return {
      pid: p.id,
      name: p.name,
      role: roleOf(roles, p.id),
      kind: 'badge',
      cx,
      cy,
      r: BADGE_R,
      glyph: ident.glyph,
      hueVar: ident.hueVar,
    };
  });

  const edges: LayoutEdge[] = workers.map((w) => {
    const start = rectBoundary(HCX, HCY, HUB_W, HUB_H, w.cx, w.cy);
    const end = circleBoundary(w.cx, w.cy, w.r, HCX, HCY);
    return {
      from: 'hub',
      to: w.pid,
      d: `M${start.x.toFixed(2)} ${start.y.toFixed(2)} L${end.x.toFixed(2)} ${end.y.toFixed(2)}`,
      kind: 'orch',
    };
  });

  const flowPaths = edges.map((e, i) => ({ pid: workers[i]!.pid, d: e.d }));

  const nodes: LayoutNode[] = workers.map((w) => ({
    pid: w.pid,
    kind: 'worker',
    x: w.cx - w.r,
    y: w.cy - w.r,
    w: 2 * w.r,
    h: 2 * w.r,
    tileKind: 'badge',
  }));

  const hub: LayoutNode = {
    pid: -1,
    kind: 'hub',
    x: HCX - HUB_W / 2,
    y: HUB_Y,
    w: HUB_W,
    h: HUB_H,
  };

  return {
    width: VBOX_W,
    height: VBOX_H,
    squarePx,
    nodes,
    edges,
    hub,
    flowPaths,
    fontSizes: fsizes,
    geometry: {
      mode: 'orchestrator',
      tier: 'twoRing',
      hubX: HCX,
      hubY: HUB_Y,
      hubW: HUB_W,
      hubH: HUB_H,
      hubLabel: 'orchestrator',
      hubSlug: null,
      workers,
    },
  };
}

// =====================================================================
// Orchestrator: concentric rings (N=25+)
// =====================================================================
function layoutOrchestratorConcentric(
  participants: Project[],
  roles: Record<string, string>,
  squarePx: number,
): Layout {
  const VBOX_W = 320;
  const VBOX_H = 320;
  const HUB_W = 80;
  const HUB_H = 20;
  const HCX = VBOX_W / 2; // 160
  const HCY = VBOX_H / 2; // 160
  const HUB_Y = HCY - HUB_H / 2;
  // Ring k holds 6+6k slots (k starts at 1). Distribute participants
  // into rings in order, filling each ring before opening the next.
  // Radii: ring 1 = 54, growing by 38 per ring. Floor badge_r at 10.
  const RING_R_BASE = 54;
  const RING_R_STEP = 38;
  const BADGE_R = 11;
  const FS_NAME = 10;
  const FS_ROLE = 10;
  const fsizes = { name: FS_NAME, role: FS_ROLE };

  type RingAssignment = { ring: number; slotsInRing: number; slotIdx: number };
  const assignments: RingAssignment[] = [];
  let remaining = participants.length;
  let ringIdx = 1;
  while (remaining > 0) {
    const slots = Math.min(remaining, 6 + 6 * ringIdx);
    for (let s = 0; s < slots; s++) {
      assignments.push({ ring: ringIdx, slotsInRing: slots, slotIdx: s });
    }
    remaining -= slots;
    ringIdx++;
  }

  const workers: LaidBadgeTile[] = participants.map((p, i) => {
    const a = assignments[i]!;
    const R = RING_R_BASE + (a.ring - 1) * RING_R_STEP;
    // Half-step rotation per ring keeps adjacent rings staggered.
    const phase = ((a.ring - 1) * Math.PI) / Math.max(1, a.slotsInRing);
    const angle = -Math.PI / 2 + phase + (2 * Math.PI * a.slotIdx) / a.slotsInRing;
    const cx = HCX + R * Math.cos(angle);
    const cy = HCY + R * Math.sin(angle);
    const ident = agentIdentity(p.name);
    return {
      pid: p.id,
      name: p.name,
      role: roleOf(roles, p.id),
      kind: 'badge',
      cx,
      cy,
      r: BADGE_R,
      glyph: ident.glyph,
      hueVar: ident.hueVar,
    };
  });

  const edges: LayoutEdge[] = workers.map((w) => {
    const start = rectBoundary(HCX, HCY, HUB_W, HUB_H, w.cx, w.cy);
    const end = circleBoundary(w.cx, w.cy, w.r, HCX, HCY);
    return {
      from: 'hub',
      to: w.pid,
      d: `M${start.x.toFixed(2)} ${start.y.toFixed(2)} L${end.x.toFixed(2)} ${end.y.toFixed(2)}`,
      kind: 'orch',
    };
  });

  const flowPaths = edges.map((e, i) => ({ pid: workers[i]!.pid, d: e.d }));

  const nodes: LayoutNode[] = workers.map((w) => ({
    pid: w.pid,
    kind: 'worker',
    x: w.cx - w.r,
    y: w.cy - w.r,
    w: 2 * w.r,
    h: 2 * w.r,
    tileKind: 'badge',
  }));

  const hub: LayoutNode = {
    pid: -1,
    kind: 'hub',
    x: HCX - HUB_W / 2,
    y: HUB_Y,
    w: HUB_W,
    h: HUB_H,
  };

  return {
    width: VBOX_W,
    height: VBOX_H,
    squarePx,
    nodes,
    edges,
    hub,
    flowPaths,
    fontSizes: fsizes,
    geometry: {
      mode: 'orchestrator',
      tier: 'concentric',
      hubX: HCX,
      hubY: HUB_Y,
      hubW: HUB_W,
      hubH: HUB_H,
      hubLabel: 'orchestrator',
      hubSlug: null,
      workers,
    },
  };
}

// =====================================================================
// Chain: row (N=1..10)
// =====================================================================
function layoutChainRow(
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
  const tiles: LaidRectTile[] = participants.map((p) => {
    const role = roleOf(roles, p.id);
    const tw = tileWidth(p.name, role, fsizes, MIN_W, MAX_W);
    const tCx = acc + tw / 2;
    const tile: LaidRectTile = {
      pid: p.id,
      name: p.name,
      role,
      kind: 'rect',
      x: acc,
      y: NODE_Y,
      w: tw,
      h: NODE_H,
      cx: tCx,
      cy,
      innerW: tw - 2 * TILE_PAD_X,
      nameY: NODE_Y + 18,
      roleY1: ROLE_Y1,
      roleY2: ROLE_Y2,
    };
    acc += tw + GAP;
    return tile;
  });
  const n = tiles.length;
  const width = n === 0 ? 2 * SIDE_PAD : acc - GAP - SIDE_PAD + 2 * SIDE_PAD;

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
    kind: 'worker',
    x: t.x,
    y: t.y,
    w: t.w,
    h: t.h,
    tileKind: 'rect',
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
      tier: 'row',
      tiles,
    },
  };
}

// =====================================================================
// Chain: wrap (N=11+) — snake pattern, rows of variable length
// =====================================================================
function layoutChainWrap(
  participants: Project[],
  roles: Record<string, string>,
  squarePx: number,
  rowsCount: 2 | 3,
): Layout {
  const n = participants.length;
  const TILE_W = rowsCount === 2 ? 116 : 102;
  const TILE_H = 50;
  const GAP_X = 24;
  const GAP_Y = 28;
  const SIDE_PAD = 14;
  const TOP_PAD = 14;
  const FS_NAME = rowsCount === 2 ? 11 : 10.5;
  const FS_ROLE = 10;
  const fsizes = { name: FS_NAME, role: FS_ROLE };

  // Distribute n into rowsCount rows; first rows get any remainder so
  // wrap2 with N=11 yields [6, 5] and wrap3 with N=22 yields [8, 7, 7].
  const rowSizes: number[] = balanceRows(n, rowsCount);
  const maxRowSize = Math.max(...rowSizes, 1);

  // Snake placement: row 0 L→R, row 1 R→L (starting at row 0's last col),
  // row 2 L→R (starting at row 1's last col).
  const colWidth = TILE_W + GAP_X;
  const rowStartCol: number[] = [0];
  for (let r = 1; r < rowsCount; r++) {
    const prevStart = rowStartCol[r - 1]!;
    const prevSize = rowSizes[r - 1]!;
    const prevDir = (r - 1) % 2 === 0 ? 1 : -1;
    rowStartCol.push(prevStart + prevDir * (prevSize - 1));
  }

  let pIdx = 0;
  const tiles: LaidRectTile[] = [];
  for (let r = 0; r < rowsCount; r++) {
    const rowSize = rowSizes[r]!;
    const startCol = rowStartCol[r]!;
    const dir = r % 2 === 0 ? 1 : -1;
    const y = TOP_PAD + r * (TILE_H + GAP_Y);
    for (let c = 0; c < rowSize; c++) {
      const col = startCol + dir * c;
      const x = SIDE_PAD + col * colWidth;
      const cx = x + TILE_W / 2;
      const cy = y + TILE_H / 2;
      const p = participants[pIdx]!;
      tiles.push({
        pid: p.id,
        name: p.name,
        role: roleOf(roles, p.id),
        kind: 'rect',
        x,
        y,
        w: TILE_W,
        h: TILE_H,
        cx,
        cy,
        innerW: TILE_W - 2 * TILE_PAD_X,
        nameY: y + 17,
        // Hide role at wrap densities — names alone read cleaner.
        roleY1: null,
        roleY2: null,
      });
      pIdx++;
    }
  }

  const width = maxRowSize * TILE_W + (maxRowSize - 1) * GAP_X + 2 * SIDE_PAD;
  const height = rowsCount * TILE_H + (rowsCount - 1) * GAP_Y + 2 * TOP_PAD;

  // Edges follow participant order (snake), connecting tiles by their
  // bounding-box edges. Same-row hops are horizontal; row-boundary hops
  // are vertical (because the snake aligns wrap points).
  const edges: LayoutEdge[] = [];
  for (let i = 1; i < tiles.length; i++) {
    const prev = tiles[i - 1]!;
    const curr = tiles[i]!;
    if (prev.y === curr.y) {
      const startX = prev.cx < curr.cx ? prev.x + prev.w : prev.x;
      const endX = prev.cx < curr.cx ? curr.x : curr.x + curr.w;
      edges.push({
        from: prev.pid,
        to: curr.pid,
        d: `M${startX} ${prev.cy} L${endX} ${prev.cy}`,
        kind: 'chain',
      });
    } else {
      // Wrap point: a short vertical segment at the shared column.
      const startY = prev.y + prev.h;
      const endY = curr.y;
      edges.push({
        from: prev.pid,
        to: curr.pid,
        d: `M${prev.cx} ${startY} L${prev.cx} ${endY}`,
        kind: 'chain',
      });
    }
  }

  // Flow path: a polyline that traces the snake through every tile.
  // Single dot drifts from start to end (chain semantics preserved).
  let flowD = '';
  if (tiles.length > 0) {
    flowD = `M${tiles[0]!.cx} ${tiles[0]!.cy}`;
    for (let i = 1; i < tiles.length; i++) {
      flowD += ` L${tiles[i]!.cx} ${tiles[i]!.cy}`;
    }
  }
  const flowPaths = tiles.length > 0 ? [{ pid: tiles[tiles.length - 1]!.pid, d: flowD }] : [];

  const nodes: LayoutNode[] = tiles.map((t) => ({
    pid: t.pid,
    kind: 'worker',
    x: t.x,
    y: t.y,
    w: t.w,
    h: t.h,
    tileKind: 'rect',
  }));

  return {
    width,
    height,
    squarePx,
    nodes,
    edges,
    flowPaths,
    fontSizes: fsizes,
    geometry: {
      mode: 'chain',
      tier: rowsCount === 2 ? 'wrap2' : 'wrap3',
      tiles,
    },
  };
}

/** Split `n` into `rows` row-sizes, biggest first. e.g.,
 *  balanceRows(11, 2) → [6, 5]; balanceRows(25, 3) → [9, 8, 8]. */
function balanceRows(n: number, rows: number): number[] {
  const base = Math.floor(n / rows);
  const extra = n % rows;
  return Array.from({ length: rows }, (_, i) => base + (i < extra ? 1 : 0));
}
