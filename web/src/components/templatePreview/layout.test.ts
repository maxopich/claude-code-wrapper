import { describe, expect, test } from 'vitest';
import type { CustomLayout, Project } from '@cebab/shared/protocol';
import {
  layoutCustomGrid,
  layoutFor,
  tierForChain,
  tierForOrchestrator,
  wrap2,
  wrapN,
  type LaidBadgeTile,
  type LaidRectTile,
} from './layout';

function mkProjects(n: number): Project[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: `agent-${i + 1}`,
    path: `/tmp/agent-${i + 1}`,
    trusted: true,
    lastUsedAt: null,
    hasClaudeMd: true,
    busInstalled: false,
    busAgentName: null,
  }));
}

/** Per-tier expected viewBox height (orchestrator). */
const ORCH_HEIGHT: Record<string, number> = {
  center: 150,
  row: 150,
  arc: 220,
  ring: 240,
  twoRing: 280,
  concentric: 320,
};

/** Per-tier expected viewBox height (chain). wrap tiers are computed
 *  from the geometry; row is fixed. */
const CHAIN_ROW_HEIGHT = 84;

describe('tier classification', () => {
  test('orchestrator tiers map by N', () => {
    expect(tierForOrchestrator(1)).toBe('center');
    expect(tierForOrchestrator(2)).toBe('row');
    expect(tierForOrchestrator(4)).toBe('row');
    expect(tierForOrchestrator(5)).toBe('arc');
    expect(tierForOrchestrator(8)).toBe('arc');
    expect(tierForOrchestrator(9)).toBe('ring');
    expect(tierForOrchestrator(14)).toBe('ring');
    expect(tierForOrchestrator(15)).toBe('twoRing');
    expect(tierForOrchestrator(24)).toBe('twoRing');
    expect(tierForOrchestrator(25)).toBe('concentric');
    expect(tierForOrchestrator(100)).toBe('concentric');
  });

  test('chain tiers map by N', () => {
    expect(tierForChain(1)).toBe('row');
    expect(tierForChain(10)).toBe('row');
    expect(tierForChain(11)).toBe('wrap2');
    expect(tierForChain(20)).toBe('wrap2');
    expect(tierForChain(21)).toBe('wrap3');
    expect(tierForChain(50)).toBe('wrap3');
  });
});

describe('layoutFor — invariants across orchestrator tiers', () => {
  // One representative N per tier (center+row are covered together).
  for (const n of [1, 2, 3, 4, 5, 6, 8, 9, 12, 14, 15, 20, 24, 25, 30]) {
    test(`orchestrator N=${n}: shape, counts, hub, viewBox H per tier`, () => {
      const layout = layoutFor({ mode: 'orchestrator' }, mkProjects(n));
      expect(layout.nodes).toHaveLength(n);
      expect(layout.nodes.every((node) => node.kind === 'worker')).toBe(true);
      expect(layout.hub).toBeDefined();
      expect(layout.hub?.kind).toBe('hub');
      expect(layout.edges).toHaveLength(n);
      expect(layout.edges.every((e) => e.from === 'hub')).toBe(true);
      expect(layout.flowPaths).toHaveLength(n);
      expect(layout.width).toBeGreaterThan(0);
      expect(layout.geometry.mode).toBe('orchestrator');
      if (layout.geometry.mode === 'orchestrator') {
        expect(layout.height).toBe(ORCH_HEIGHT[layout.geometry.tier]);
      }
    });
  }
});

describe('layoutFor — tile kind by tier', () => {
  test('center+row+arc use rect tiles', () => {
    for (const n of [1, 2, 4, 5, 8]) {
      const layout = layoutFor({ mode: 'orchestrator' }, mkProjects(n));
      if (layout.geometry.mode !== 'orchestrator') throw new Error('expected orchestrator');
      for (const w of layout.geometry.workers) {
        expect(w.kind).toBe('rect');
      }
    }
  });

  test('ring+twoRing+concentric use badge tiles', () => {
    for (const n of [9, 14, 15, 24, 25, 40]) {
      const layout = layoutFor({ mode: 'orchestrator' }, mkProjects(n));
      if (layout.geometry.mode !== 'orchestrator') throw new Error('expected orchestrator');
      for (const w of layout.geometry.workers) {
        expect(w.kind).toBe('badge');
      }
    }
  });

  test('badge tiles carry glyph + hueVar from agentIdentity', () => {
    const layout = layoutFor({ mode: 'orchestrator' }, mkProjects(10));
    if (layout.geometry.mode !== 'orchestrator') throw new Error('expected orchestrator');
    for (const w of layout.geometry.workers) {
      if (w.kind !== 'badge') throw new Error('expected badge');
      expect(w.glyph).toBeTruthy();
      // agentIdentity never returns hueVar=null for non-sentinel slugs.
      expect(w.hueVar).toMatch(/^var\(--agent-\d\)$/);
      expect(w.r).toBeGreaterThan(0);
    }
  });
});

describe('layoutFor — hub slug visibility per N (PR-4)', () => {
  // PR-4 rule: "Hub: collapse to 'orchestrator' only at N≥6 in compact"
  // — so N=1..5 show the slug, N≥6 drop it. This spans the arc-tier
  // boundary (arc=5..8): N=5 keeps slug, N=6..8 hide it.
  test('N=1..5 (center / row / arc lo) keep the slug', () => {
    for (const n of [1, 2, 4, 5]) {
      const layout = layoutFor({ mode: 'orchestrator' }, mkProjects(n));
      if (layout.geometry.mode !== 'orchestrator') throw new Error('expected orchestrator');
      expect(layout.geometry.hubSlug).toBe('cebab');
    }
  });

  test('N≥6 (arc hi / ring / twoRing / concentric) drop the slug', () => {
    for (const n of [6, 8, 9, 14, 15, 25]) {
      const layout = layoutFor({ mode: 'orchestrator' }, mkProjects(n));
      if (layout.geometry.mode !== 'orchestrator') throw new Error('expected orchestrator');
      expect(layout.geometry.hubSlug).toBeNull();
    }
  });
});

describe('layoutFor — rect tile identity (PR-4)', () => {
  test('rect tiles carry glyph + hueVar from agentIdentity', () => {
    // Cover every tier that produces rect tiles (center / row / arc /
    // chain-row / chain-wrap).
    const cases: Array<{ mode: 'orchestrator' | 'chain'; n: number }> = [
      { mode: 'orchestrator', n: 1 },
      { mode: 'orchestrator', n: 3 },
      { mode: 'orchestrator', n: 5 },
      { mode: 'orchestrator', n: 8 },
      { mode: 'chain', n: 5 },
      { mode: 'chain', n: 13 },
    ];
    for (const { mode, n } of cases) {
      const layout = layoutFor({ mode }, mkProjects(n));
      const tiles =
        layout.geometry.mode === 'orchestrator' ? layout.geometry.workers : layout.geometry.tiles;
      for (const tile of tiles) {
        if (tile.kind !== 'rect') throw new Error(`expected rect tile for ${mode} N=${n}`);
        expect(tile.glyph).toBeTruthy();
        expect(tile.glyph.length).toBeGreaterThanOrEqual(1);
        // agentIdentity returns var(--agent-N) for non-sentinel slugs.
        expect(tile.hueVar).toMatch(/^var\(--agent-\d\)$/);
      }
    }
  });
});

describe('layoutFor — typography floors (AC-7, PR-4)', () => {
  // Plan: "Names ≥12px compact / ≥14px fullscreen; roles ≥11/≥12".
  // PR-4 ships compact only; AC-7 fullscreen leg lands with PR-5.
  test('orchestrator name fontSize ≥ floor per tier', () => {
    // ≤4 (center/row): name 12; 5..8 (arc): name 11; 9+ (badge tiers
    // render glyph only, fontSizes.name is just a typing carrier and
    // not displayed — exclude from the floor check).
    for (const n of [1, 2, 3, 4]) {
      expect(layoutFor({ mode: 'orchestrator' }, mkProjects(n)).fontSizes.name).toBe(12);
    }
    for (const n of [5, 6, 7, 8]) {
      expect(layoutFor({ mode: 'orchestrator' }, mkProjects(n)).fontSizes.name).toBe(11);
    }
  });

  test('orchestrator role fontSize ≥ 10 where role is shown', () => {
    // Roles render only at the row tier (≤4); arc+ hide them via
    // roleY1=null. The font carrier remains 10 so PR-5 fullscreen can
    // bump it without re-plumbing.
    for (const n of [1, 2, 4]) {
      expect(layoutFor({ mode: 'orchestrator' }, mkProjects(n)).fontSizes.role).toBe(10);
    }
  });
});

describe('layoutFor — chain invariants', () => {
  // chain N coverage: row (≤10), wrap2 (11–20), wrap3 (21+)
  for (const n of [1, 2, 3, 5, 10, 11, 15, 20, 21, 30]) {
    test(`chain N=${n}: shape, counts, no hub`, () => {
      const layout = layoutFor({ mode: 'chain' }, mkProjects(n));
      expect(layout.nodes).toHaveLength(n);
      expect(layout.nodes.every((node) => node.kind === 'worker')).toBe(true);
      expect(layout.hub).toBeUndefined();
      expect(layout.edges).toHaveLength(Math.max(0, n - 1));
      // Chain ships one dot path (snake polyline covers every tile).
      expect(layout.flowPaths).toHaveLength(n >= 1 ? 1 : 0);
      expect(layout.width).toBeGreaterThan(0);
      expect(layout.geometry.mode).toBe('chain');
    });
  }

  test('chain row mode (N≤10): height=84', () => {
    expect(layoutFor({ mode: 'chain' }, mkProjects(5)).height).toBe(CHAIN_ROW_HEIGHT);
    expect(layoutFor({ mode: 'chain' }, mkProjects(10)).height).toBe(CHAIN_ROW_HEIGHT);
  });

  test('chain wrap mode (N≥11): height grows with row count', () => {
    const wrap2 = layoutFor({ mode: 'chain' }, mkProjects(15));
    const wrap3 = layoutFor({ mode: 'chain' }, mkProjects(25));
    expect(wrap2.height).toBeGreaterThan(CHAIN_ROW_HEIGHT);
    expect(wrap3.height).toBeGreaterThan(wrap2.height);
  });
});

describe('wrapN (PR-4)', () => {
  test('returns single line when text fits in perLine', () => {
    expect(wrapN('abc', 5, 2)).toEqual(['abc']);
    expect(wrapN('exactly5', 8, 2)).toEqual(['exactly5']);
  });

  test('two-line wrap breaks at space when within BREAK_SLACK', () => {
    // "alpha bravo charlie" with perLine=10: space at idx 5 is within
    // last-8-chars of cut=10, so break there. Line 2 ellipsises.
    const out = wrapN('alpha bravo charlie', 10, 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe('alpha');
    // Line 2: "bravo charlie" → truncLabel(_, 10) = "bravo cha…"
    expect(out[1]).toBe('bravo cha…');
  });

  test('falls back to char cut when no space inside the break-slack', () => {
    // "abcdefghijklmnop" — no spaces; cut at perLine=8 exactly. Both
    // 8-char halves fit cleanly, so the second line isn't ellipsised.
    const out = wrapN('abcdefghijklmnop', 8, 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe('abcdefgh');
    expect(out[1]).toBe('ijklmnop');
  });

  test('truncates the final line when remaining text still overflows', () => {
    // "abcdefghijklmnopqrstuvwxyz" — 26 chars, perLine=8, maxLines=2.
    // Line 1 takes 8, line 2 has 18 chars left → truncLabel to 8 → "abcdefg…".
    const out = wrapN('abcdefghijklmnopqrstuvwxyz', 8, 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe('abcdefgh');
    expect(out[1]).toBe('ijklmno…');
  });

  test('three-line wrap walks through the rest', () => {
    // "first second third fourth" with perLine=8, maxLines=3:
    //   line 1 break at space idx 5 ("first")
    //   line 2 break at space idx 6 in remaining "second third fourth"
    //     ("second")
    //   line 3 = "third fo…" (truncLabel cap)
    const out = wrapN('first second third fourth', 8, 3);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe('first');
    expect(out[1]).toBe('second');
    expect(out[2]).toMatch(/^third/);
  });

  test('respects maxLines=2 boundary: never returns 3 lines', () => {
    const out = wrapN('a b c d e f g h i j k', 4, 2);
    expect(out.length).toBeLessThanOrEqual(2);
  });

  test('wrap2 alias matches wrapN(..., 2)', () => {
    const cases = ['short', 'medium text', 'a very long agent name'];
    for (const s of cases) {
      expect(Array.from(wrap2(s, 8))).toEqual(wrapN(s, 8, 2));
    }
  });

  test('handles empty + edge cases without throwing', () => {
    // Empty input: the `length <= per` early-return falls through and
    // returns a single empty line. The renderer's `length > 1` check
    // treats that as "no wrap" and falls back to the truncLabel path
    // (which renders nothing visible for an empty name).
    expect(wrapN('', 10, 2)).toEqual(['']);
    expect(wrapN('a', 0, 2)).toEqual(['a']); // per=1 floor
  });
});

describe("layoutFor — density:'full' (PR-4)", () => {
  // Plan dimensions:
  //   orch row  — MIN_W/MAX_W 110/168 → 140/264; tile H 56 → 64
  //   orch arc  — TILE_W/TILE_H 70/26 → 130/40; viewBox H 220 → 260
  //   chain row — MIN_W/MAX_W 132/248 → 160/280; tile H 56 → 64
  //   chain wrap2 — TILE_W/TILE_H 116/50 → 120/64
  //   chain wrap3 — TILE_W/TILE_H 102/50 → 108/60
  test('orch row: full bumps WORKER_H from 56 to 64', () => {
    const compact = layoutFor({ mode: 'orchestrator', density: 'compact' }, mkProjects(3));
    const full = layoutFor({ mode: 'orchestrator', density: 'full' }, mkProjects(3));
    if (compact.geometry.mode !== 'orchestrator') throw new Error('expected orchestrator');
    if (full.geometry.mode !== 'orchestrator') throw new Error('expected orchestrator');
    const compactWorker = compact.geometry.workers[0]! as LaidRectTile;
    const fullWorker = full.geometry.workers[0]! as LaidRectTile;
    expect(compactWorker.h).toBe(56);
    expect(fullWorker.h).toBe(64);
  });

  test('orch arc: full bumps viewBox H 220 → 260 and tile to 130×40', () => {
    const compact = layoutFor({ mode: 'orchestrator', density: 'compact' }, mkProjects(6));
    const full = layoutFor({ mode: 'orchestrator', density: 'full' }, mkProjects(6));
    expect(compact.height).toBe(220);
    expect(full.height).toBe(260);
    if (full.geometry.mode !== 'orchestrator') throw new Error('expected orchestrator');
    const fullTile = full.geometry.workers[0]! as LaidRectTile;
    expect(fullTile.w).toBe(130);
    expect(fullTile.h).toBe(40);
  });

  test('orch arc: full pre-wraps name into 1-2 lines', () => {
    const full = layoutFor({ mode: 'orchestrator', density: 'full' }, mkProjects(6));
    if (full.geometry.mode !== 'orchestrator') throw new Error('expected orchestrator');
    for (const w of full.geometry.workers) {
      if (w.kind !== 'rect') throw new Error('expected rect tile');
      expect(w.nameLines).not.toBeNull();
      expect(w.nameLines!.length).toBeGreaterThan(0);
      expect(w.nameLines!.length).toBeLessThanOrEqual(2);
    }
  });

  test('orch ring (N=10): full sets under-badge labels; compact leaves them null', () => {
    const compact = layoutFor({ mode: 'orchestrator', density: 'compact' }, mkProjects(10));
    const full = layoutFor({ mode: 'orchestrator', density: 'full' }, mkProjects(10));
    if (compact.geometry.mode !== 'orchestrator') throw new Error('expected orchestrator');
    if (full.geometry.mode !== 'orchestrator') throw new Error('expected orchestrator');
    for (const w of compact.geometry.workers) {
      if (w.kind !== 'badge') throw new Error('expected badge');
      expect(w.underLabel ?? null).toBeNull();
    }
    for (const w of full.geometry.workers) {
      if (w.kind !== 'badge') throw new Error('expected badge');
      expect(w.underLabel).toBeTruthy();
      expect(w.underLabel!.fontSize).toBe(11);
      expect(w.underLabel!.lines.length).toBeGreaterThan(0);
    }
  });

  test('orch twoRing (N=18): full sets under-badge labels at FS=10', () => {
    const full = layoutFor({ mode: 'orchestrator', density: 'full' }, mkProjects(18));
    if (full.geometry.mode !== 'orchestrator') throw new Error('expected orchestrator');
    for (const w of full.geometry.workers) {
      if (w.kind !== 'badge') throw new Error('expected badge');
      expect(w.underLabel?.fontSize).toBe(10);
    }
  });

  test('orch concentric (N=30): full labels ONLY inner ring; outer rings stay glyph-only', () => {
    const full = layoutFor({ mode: 'orchestrator', density: 'full' }, mkProjects(30));
    if (full.geometry.mode !== 'orchestrator') throw new Error('expected orchestrator');
    // Inner ring holds 6+6·1 = 12 slots; outer ring holds the remaining 18.
    // First 12 should be labeled, last 18 should not.
    const workers = full.geometry.workers as LaidBadgeTile[];
    const inner = workers.slice(0, 12);
    const outer = workers.slice(12);
    for (const w of inner) {
      expect(w.underLabel).toBeTruthy();
      expect(w.underLabel!.fontSize).toBe(9);
    }
    for (const w of outer) {
      expect(w.underLabel ?? null).toBeNull();
    }
  });

  test('chain row: full bumps NODE_H 56 → 64, MIN/MAX 132/248 → 160/280', () => {
    const full = layoutFor({ mode: 'chain', density: 'full' }, mkProjects(3));
    if (full.geometry.mode !== 'chain') throw new Error('expected chain');
    const tile = full.geometry.tiles[0]! as LaidRectTile;
    expect(tile.h).toBe(64);
    expect(tile.w).toBeGreaterThanOrEqual(160);
    expect(tile.w).toBeLessThanOrEqual(280);
  });

  test('chain wrap2 (N=15): full bumps TILE_W/H 116/50 → 120/64 + pre-wraps names', () => {
    const full = layoutFor({ mode: 'chain', density: 'full' }, mkProjects(15));
    if (full.geometry.mode !== 'chain') throw new Error('expected chain');
    const tile = full.geometry.tiles[0]! as LaidRectTile;
    expect(tile.w).toBe(120);
    expect(tile.h).toBe(64);
    expect(tile.nameLines).not.toBeNull();
  });

  test('chain wrap3 (N=22): full bumps TILE_W/H 102/50 → 108/60 + pre-wraps names', () => {
    const full = layoutFor({ mode: 'chain', density: 'full' }, mkProjects(22));
    if (full.geometry.mode !== 'chain') throw new Error('expected chain');
    const tile = full.geometry.tiles[0]! as LaidRectTile;
    expect(tile.w).toBe(108);
    expect(tile.h).toBe(60);
    expect(tile.nameLines).not.toBeNull();
  });

  test("density default ('compact' when unset) matches explicit compact", () => {
    // The whole point of `density?: ...` is that callers who don't pass
    // it get the today behavior. Snapshot equivalence on a key field per
    // mode is enough to prove the default is wired through.
    const cases: Array<{ mode: 'orchestrator' | 'chain'; n: number }> = [
      { mode: 'orchestrator', n: 3 },
      { mode: 'orchestrator', n: 6 },
      { mode: 'orchestrator', n: 10 },
      { mode: 'chain', n: 5 },
      { mode: 'chain', n: 15 },
    ];
    for (const { mode, n } of cases) {
      const defaulted = layoutFor({ mode }, mkProjects(n));
      const explicit = layoutFor({ mode, density: 'compact' }, mkProjects(n));
      expect(defaulted.width).toBe(explicit.width);
      expect(defaulted.height).toBe(explicit.height);
    }
  });
});

describe('layoutFor — edge structure', () => {
  test('orchestrator: every edge is hub → worker, path starts with M', () => {
    const layout = layoutFor({ mode: 'orchestrator' }, mkProjects(4));
    for (const edge of layout.edges) {
      expect(edge.from).toBe('hub');
      expect(typeof edge.to).toBe('number');
      expect(edge.kind).toBe('orch');
      expect(edge.d.startsWith('M')).toBe(true);
    }
  });

  test('chain row: every hop is i → i+1 (strict chain order)', () => {
    const projects = mkProjects(5);
    const layout = layoutFor({ mode: 'chain' }, projects);
    for (let i = 0; i < layout.edges.length; i++) {
      const edge = layout.edges[i]!;
      expect(edge.from).toBe(projects[i]!.id);
      expect(edge.to).toBe(projects[i + 1]!.id);
      expect(edge.kind).toBe('chain');
    }
  });

  test('chain wrap: edges still follow strict participant order', () => {
    const projects = mkProjects(13);
    const layout = layoutFor({ mode: 'chain' }, projects);
    expect(layout.edges).toHaveLength(12);
    for (let i = 0; i < layout.edges.length; i++) {
      const edge = layout.edges[i]!;
      expect(edge.from).toBe(projects[i]!.id);
      expect(edge.to).toBe(projects[i + 1]!.id);
    }
  });

  test('orchestrator: flowPaths cover every worker pid exactly once', () => {
    const projects = mkProjects(6);
    const layout = layoutFor({ mode: 'orchestrator' }, projects);
    const flowPids = new Set(layout.flowPaths.map((f) => f.pid));
    const workerPids = new Set(projects.map((p) => p.id));
    expect(flowPids).toEqual(workerPids);
  });

  test('orchestrator radial tiers: each flow path is "M x y L x y" (straight segment)', () => {
    // Ring/twoRing/concentric edges are straight radial lines.
    for (const n of [9, 15, 25]) {
      const layout = layoutFor({ mode: 'orchestrator' }, mkProjects(n));
      for (const fp of layout.flowPaths) {
        expect(fp.d).toMatch(/^M[\d.\s-]+L[\d.\s-]+$/);
      }
    }
  });

  test('every worker tile is within the viewBox', () => {
    for (const n of [1, 5, 9, 15, 25]) {
      const layout = layoutFor({ mode: 'orchestrator' }, mkProjects(n));
      if (layout.geometry.mode !== 'orchestrator') throw new Error('expected orchestrator');
      for (const w of layout.geometry.workers) {
        if (w.kind === 'rect') {
          expect(w.x).toBeGreaterThanOrEqual(0);
          expect(w.x + w.w).toBeLessThanOrEqual(layout.width + 0.5);
          expect(w.y).toBeGreaterThanOrEqual(0);
          expect(w.y + w.h).toBeLessThanOrEqual(layout.height + 0.5);
        } else {
          expect(w.cx - w.r).toBeGreaterThanOrEqual(0);
          expect(w.cx + w.r).toBeLessThanOrEqual(layout.width + 0.5);
          expect(w.cy - w.r).toBeGreaterThanOrEqual(0);
          expect(w.cy + w.r).toBeLessThanOrEqual(layout.height + 0.5);
        }
      }
    }
  });
});

describe('layoutFor — degenerate cases', () => {
  test('N=0 returns layout with no nodes, no edges, no flow', () => {
    const orch = layoutFor({ mode: 'orchestrator' }, []);
    expect(orch.nodes).toHaveLength(0);
    expect(orch.edges).toHaveLength(0);
    expect(orch.flowPaths).toHaveLength(0);

    const chain = layoutFor({ mode: 'chain' }, []);
    expect(chain.nodes).toHaveLength(0);
    expect(chain.edges).toHaveLength(0);
    expect(chain.flowPaths).toHaveLength(0);
  });

  test("'custom' mode falls back to orchestrator layout in PR-3 (stub)", () => {
    const layout = layoutFor({ mode: 'custom' }, mkProjects(3));
    expect(layout.geometry.mode).toBe('orchestrator');
    expect(layout.hub).toBeDefined();
  });
});

describe('layoutFor — determinism', () => {
  test('same input produces identical output', () => {
    const projects = mkProjects(5);
    const roles = { '1': 'planner', '3': 'reviewer' };
    const a = layoutFor({ mode: 'orchestrator', roles }, projects);
    const b = layoutFor({ mode: 'orchestrator', roles }, projects);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('layoutFor — snapshot of returned Layout JSON', () => {
  // PR-3: re-snapshotted from PR-1 baseline. Each snapshot covers one
  // tier boundary; if a tier's geometry changes, bump just that one.
  test('orchestrator N=3 (row tier)', () => {
    const layout = layoutFor({ mode: 'orchestrator' }, mkProjects(3));
    expect(layout).toMatchInlineSnapshot(`
      {
        "edges": [
          {
            "d": "M189 52 V70 H69 V88",
            "from": "hub",
            "kind": "orch",
            "to": 1,
          },
          {
            "d": "M189 52 V88",
            "from": "hub",
            "kind": "orch",
            "to": 2,
          },
          {
            "d": "M189 52 V70 H309 V88",
            "from": "hub",
            "kind": "orch",
            "to": 3,
          },
        ],
        "flowPaths": [
          {
            "d": "M189 52 V70 H69 V88",
            "pid": 1,
          },
          {
            "d": "M189 52 V88",
            "pid": 2,
          },
          {
            "d": "M189 52 V70 H309 V88",
            "pid": 3,
          },
        ],
        "fontSizes": {
          "name": 12,
          "role": 10,
        },
        "geometry": {
          "hubH": 30,
          "hubLabel": "orchestrator",
          "hubSlug": "cebab",
          "hubW": 113,
          "hubX": 189,
          "hubY": 20,
          "mode": "orchestrator",
          "tier": "row",
          "workers": [
            {
              "cx": 69,
              "cy": 116,
              "glyph": "■",
              "h": 56,
              "hueVar": "var(--agent-2)",
              "innerW": 90,
              "kind": "rect",
              "name": "agent-1",
              "nameY": 104,
              "pid": 1,
              "role": "",
              "roleY1": 118,
              "roleY2": 130,
              "w": 110,
              "x": 14,
              "y": 88,
            },
            {
              "cx": 189,
              "cy": 116,
              "glyph": "◆",
              "h": 56,
              "hueVar": "var(--agent-3)",
              "innerW": 90,
              "kind": "rect",
              "name": "agent-2",
              "nameY": 104,
              "pid": 2,
              "role": "",
              "roleY1": 118,
              "roleY2": 130,
              "w": 110,
              "x": 134,
              "y": 88,
            },
            {
              "cx": 309,
              "cy": 116,
              "glyph": "▼",
              "h": 56,
              "hueVar": "var(--agent-0)",
              "innerW": 90,
              "kind": "rect",
              "name": "agent-3",
              "nameY": 104,
              "pid": 3,
              "role": "",
              "roleY1": 118,
              "roleY2": 130,
              "w": 110,
              "x": 254,
              "y": 88,
            },
          ],
        },
        "height": 150,
        "hub": {
          "h": 30,
          "kind": "hub",
          "pid": -1,
          "w": 113,
          "x": 132.5,
          "y": 20,
        },
        "nodes": [
          {
            "h": 56,
            "kind": "worker",
            "pid": 1,
            "tileKind": "rect",
            "w": 110,
            "x": 14,
            "y": 88,
          },
          {
            "h": 56,
            "kind": "worker",
            "pid": 2,
            "tileKind": "rect",
            "w": 110,
            "x": 134,
            "y": 88,
          },
          {
            "h": 56,
            "kind": "worker",
            "pid": 3,
            "tileKind": "rect",
            "w": 110,
            "x": 254,
            "y": 88,
          },
        ],
        "squarePx": 372,
        "width": 378,
      }
    `);
  });

  test('orchestrator N=5 (arc tier)', () => {
    const layout = layoutFor({ mode: 'orchestrator' }, mkProjects(5));
    expect(layout).toMatchInlineSnapshot(`
      {
        "edges": [
          {
            "d": "M140 40 L83.00 58.59",
            "from": "hub",
            "kind": "orch",
            "to": 1,
          },
          {
            "d": "M140 40 L83.84 122.05",
            "from": "hub",
            "kind": "orch",
            "to": 2,
          },
          {
            "d": "M140 40 L140.00 149.00",
            "from": "hub",
            "kind": "orch",
            "to": 3,
          },
          {
            "d": "M140 40 L196.16 122.05",
            "from": "hub",
            "kind": "orch",
            "to": 4,
          },
          {
            "d": "M140 40 L197.00 58.59",
            "from": "hub",
            "kind": "orch",
            "to": 5,
          },
        ],
        "flowPaths": [
          {
            "d": "M140 40 L83.00 58.59",
            "pid": 1,
          },
          {
            "d": "M140 40 L83.84 122.05",
            "pid": 2,
          },
          {
            "d": "M140 40 L140.00 149.00",
            "pid": 3,
          },
          {
            "d": "M140 40 L196.16 122.05",
            "pid": 4,
          },
          {
            "d": "M140 40 L197.00 58.59",
            "pid": 5,
          },
        ],
        "fontSizes": {
          "name": 11,
          "role": 10,
        },
        "geometry": {
          "hubH": 26,
          "hubLabel": "orchestrator",
          "hubSlug": "cebab",
          "hubW": 116,
          "hubX": 140,
          "hubY": 14,
          "mode": "orchestrator",
          "tier": "arc",
          "workers": [
            {
              "cx": 48,
              "cy": 70,
              "glyph": "■",
              "h": 26,
              "hueVar": "var(--agent-2)",
              "innerW": 50,
              "kind": "rect",
              "name": "agent-1",
              "nameLines": null,
              "nameY": 74,
              "pid": 1,
              "role": "",
              "roleY1": null,
              "roleY2": null,
              "w": 70,
              "x": 13,
              "y": 57,
            },
            {
              "cx": 74.94617613083763,
              "cy": 135.0538238691624,
              "glyph": "◆",
              "h": 26,
              "hueVar": "var(--agent-3)",
              "innerW": 50,
              "kind": "rect",
              "name": "agent-2",
              "nameLines": null,
              "nameY": 139.0538238691624,
              "pid": 2,
              "role": "",
              "roleY1": null,
              "roleY2": null,
              "w": 70,
              "x": 39.94617613083763,
              "y": 122.05382386916239,
            },
            {
              "cx": 140,
              "cy": 162,
              "glyph": "▼",
              "h": 26,
              "hueVar": "var(--agent-0)",
              "innerW": 50,
              "kind": "rect",
              "name": "agent-3",
              "nameLines": null,
              "nameY": 166,
              "pid": 3,
              "role": "",
              "roleY1": null,
              "roleY2": null,
              "w": 70,
              "x": 105,
              "y": 149,
            },
            {
              "cx": 205.0538238691624,
              "cy": 135.0538238691624,
              "glyph": "★",
              "h": 26,
              "hueVar": "var(--agent-1)",
              "innerW": 50,
              "kind": "rect",
              "name": "agent-4",
              "nameLines": null,
              "nameY": 139.0538238691624,
              "pid": 4,
              "role": "",
              "roleY1": null,
              "roleY2": null,
              "w": 70,
              "x": 170.0538238691624,
              "y": 122.05382386916239,
            },
            {
              "cx": 232,
              "cy": 70.00000000000001,
              "glyph": "⬟",
              "h": 26,
              "hueVar": "var(--agent-2)",
              "innerW": 50,
              "kind": "rect",
              "name": "agent-5",
              "nameLines": null,
              "nameY": 74.00000000000001,
              "pid": 5,
              "role": "",
              "roleY1": null,
              "roleY2": null,
              "w": 70,
              "x": 197,
              "y": 57.000000000000014,
            },
          ],
        },
        "height": 220,
        "hub": {
          "h": 26,
          "kind": "hub",
          "pid": -1,
          "w": 116,
          "x": 82,
          "y": 14,
        },
        "nodes": [
          {
            "h": 26,
            "kind": "worker",
            "pid": 1,
            "tileKind": "rect",
            "w": 70,
            "x": 13,
            "y": 57,
          },
          {
            "h": 26,
            "kind": "worker",
            "pid": 2,
            "tileKind": "rect",
            "w": 70,
            "x": 39.94617613083763,
            "y": 122.05382386916239,
          },
          {
            "h": 26,
            "kind": "worker",
            "pid": 3,
            "tileKind": "rect",
            "w": 70,
            "x": 105,
            "y": 149,
          },
          {
            "h": 26,
            "kind": "worker",
            "pid": 4,
            "tileKind": "rect",
            "w": 70,
            "x": 170.0538238691624,
            "y": 122.05382386916239,
          },
          {
            "h": 26,
            "kind": "worker",
            "pid": 5,
            "tileKind": "rect",
            "w": 70,
            "x": 197,
            "y": 57.000000000000014,
          },
        ],
        "squarePx": 424,
        "width": 280,
      }
    `);
  });

  test('orchestrator N=9 (ring tier)', () => {
    const layout = layoutFor({ mode: 'orchestrator' }, mkProjects(9));
    // Pin only the high-level shape to avoid massive snapshots with
    // floating-point goo. Specific positions/glyphs are covered above.
    expect({
      tier: layout.geometry.mode === 'orchestrator' ? layout.geometry.tier : null,
      hubSlug: layout.geometry.mode === 'orchestrator' ? layout.geometry.hubSlug : undefined,
      width: layout.width,
      height: layout.height,
      tileKinds:
        layout.geometry.mode === 'orchestrator' ? layout.geometry.workers.map((w) => w.kind) : [],
      edgeCount: layout.edges.length,
    }).toMatchInlineSnapshot(`
      {
        "edgeCount": 9,
        "height": 240,
        "hubSlug": null,
        "tier": "ring",
        "tileKinds": [
          "badge",
          "badge",
          "badge",
          "badge",
          "badge",
          "badge",
          "badge",
          "badge",
          "badge",
        ],
        "width": 240,
      }
    `);
  });

  test('chain N=3 snapshot', () => {
    const layout = layoutFor({ mode: 'chain' }, mkProjects(3));
    expect(layout).toMatchInlineSnapshot(`
      {
        "edges": [
          {
            "d": "M146 42 L178 42",
            "from": 1,
            "kind": "chain",
            "to": 2,
          },
          {
            "d": "M310 42 L342 42",
            "from": 2,
            "kind": "chain",
            "to": 3,
          },
        ],
        "flowPaths": [
          {
            "d": "M80 42 L 408 42",
            "pid": 3,
          },
        ],
        "fontSizes": {
          "name": 11.5,
          "role": 10,
        },
        "geometry": {
          "mode": "chain",
          "tier": "row",
          "tiles": [
            {
              "cx": 80,
              "cy": 42,
              "glyph": "■",
              "h": 56,
              "hueVar": "var(--agent-2)",
              "innerW": 112,
              "kind": "rect",
              "name": "agent-1",
              "nameY": 32,
              "pid": 1,
              "role": "",
              "roleY1": 47,
              "roleY2": 60,
              "w": 132,
              "x": 14,
              "y": 14,
            },
            {
              "cx": 244,
              "cy": 42,
              "glyph": "◆",
              "h": 56,
              "hueVar": "var(--agent-3)",
              "innerW": 112,
              "kind": "rect",
              "name": "agent-2",
              "nameY": 32,
              "pid": 2,
              "role": "",
              "roleY1": 47,
              "roleY2": 60,
              "w": 132,
              "x": 178,
              "y": 14,
            },
            {
              "cx": 408,
              "cy": 42,
              "glyph": "▼",
              "h": 56,
              "hueVar": "var(--agent-0)",
              "innerW": 112,
              "kind": "rect",
              "name": "agent-3",
              "nameY": 32,
              "pid": 3,
              "role": "",
              "roleY1": 47,
              "roleY2": 60,
              "w": 132,
              "x": 342,
              "y": 14,
            },
          ],
        },
        "height": 84,
        "nodes": [
          {
            "h": 56,
            "kind": "worker",
            "pid": 1,
            "tileKind": "rect",
            "w": 132,
            "x": 14,
            "y": 14,
          },
          {
            "h": 56,
            "kind": "worker",
            "pid": 2,
            "tileKind": "rect",
            "w": 132,
            "x": 178,
            "y": 14,
          },
          {
            "h": 56,
            "kind": "worker",
            "pid": 3,
            "tileKind": "rect",
            "w": 132,
            "x": 342,
            "y": 14,
          },
        ],
        "squarePx": 372,
        "width": 488,
      }
    `);
  });

  test('chain N=11 (wrap2 tier): row counts + snake direction', () => {
    const layout = layoutFor({ mode: 'chain' }, mkProjects(11));
    if (layout.geometry.mode !== 'chain') throw new Error('expected chain');
    const rows = new Map<number, LaidRectTile[]>();
    for (const t of layout.geometry.tiles) {
      if (t.kind !== 'rect') throw new Error('chain tiles should be rect');
      const arr = rows.get(t.y) ?? [];
      arr.push(t);
      rows.set(t.y, arr);
    }
    const rowSizes = [...rows.values()].map((r) => r.length);
    expect(rowSizes).toEqual([6, 5]);
    // Row 0 ascending cx (L→R); row 1 descending cx (R→L) — snake pattern.
    const rowKeys = [...rows.keys()].sort((a, b) => a - b);
    const row0 = rows.get(rowKeys[0]!)!;
    const row1 = rows.get(rowKeys[1]!)!;
    for (let i = 1; i < row0.length; i++) {
      expect(row0[i]!.cx).toBeGreaterThan(row0[i - 1]!.cx);
    }
    for (let i = 1; i < row1.length; i++) {
      expect(row1[i]!.cx).toBeLessThan(row1[i - 1]!.cx);
    }
  });

  test('chain N=21 (wrap3 tier): 3 balanced rows in snake order', () => {
    const layout = layoutFor({ mode: 'chain' }, mkProjects(21));
    if (layout.geometry.mode !== 'chain') throw new Error('expected chain');
    expect(layout.geometry.tier).toBe('wrap3');
    const rows = new Map<number, LaidRectTile[]>();
    for (const t of layout.geometry.tiles) {
      if (t.kind !== 'rect') throw new Error('chain tiles should be rect');
      const arr = rows.get(t.y) ?? [];
      arr.push(t);
      rows.set(t.y, arr);
    }
    const rowSizes = [...rows.values()].map((r) => r.length);
    expect(rowSizes).toEqual([7, 7, 7]);
  });
});

describe('layoutFor — orchestrator N=1 (center)', () => {
  test('single tile centered under hub', () => {
    const layout = layoutFor({ mode: 'orchestrator' }, mkProjects(1));
    if (layout.geometry.mode !== 'orchestrator') throw new Error('expected orchestrator');
    expect(layout.geometry.tier).toBe('center');
    expect(layout.geometry.workers).toHaveLength(1);
    const t = layout.geometry.workers[0]!;
    if (t.kind !== 'rect') throw new Error('center tile should be rect');
    // Center tile cx aligns roughly with hub cx.
    expect(Math.abs(t.cx - layout.geometry.hubX)).toBeLessThan(1);
  });
});

describe('layoutFor — orchestrator N=25 (concentric)', () => {
  test('rings hold up to 6+6k slots; tile count matches N', () => {
    const n = 25;
    const layout = layoutFor({ mode: 'orchestrator' }, mkProjects(n));
    if (layout.geometry.mode !== 'orchestrator') throw new Error('expected orchestrator');
    expect(layout.geometry.tier).toBe('concentric');
    expect(layout.geometry.workers).toHaveLength(n);

    // Ring assignment: ring 1 holds 12, ring 2 holds 13 (the remainder).
    // Verify by counting distinct radii from hub.
    const radiiRounded = new Set<number>();
    const hcx = layout.width / 2;
    const hcy = layout.height / 2;
    for (const w of layout.geometry.workers) {
      if (w.kind !== 'badge') throw new Error('concentric tiles should be badge');
      const r = Math.round(Math.hypot(w.cx - hcx, w.cy - hcy));
      radiiRounded.add(r);
    }
    // Expect 2 distinct radii (ring 1 = 12 slots filled, ring 2 = 13 slots).
    expect(radiiRounded.size).toBe(2);
  });
});

describe('layoutFor — twoRing N=15 inner/outer split', () => {
  test('inner ring holds 8, outer holds 7 (rotated half-step)', () => {
    const layout = layoutFor({ mode: 'orchestrator' }, mkProjects(15));
    if (layout.geometry.mode !== 'orchestrator') throw new Error('expected orchestrator');
    const hcx = layout.width / 2;
    const hcy = layout.height / 2;
    const radii: number[] = [];
    for (const w of layout.geometry.workers as LaidBadgeTile[]) {
      radii.push(Math.round(Math.hypot(w.cx - hcx, w.cy - hcy)));
    }
    // First 8 share inner radius; next 7 share outer radius.
    const innerR = radii[0];
    const outerR = radii[8];
    expect(innerR).toBeLessThan(outerR);
    for (let i = 0; i < 8; i++) expect(radii[i]).toBe(innerR);
    for (let i = 8; i < 15; i++) expect(radii[i]).toBe(outerR);
  });
});

describe('layoutCustomGrid — PR-6 stub fallback to orchestrator', () => {
  test("mode:'custom' via layoutFor returns the same shape as orchestrator at same N", () => {
    const ps = mkProjects(4);
    const custom = layoutFor({ mode: 'custom' }, ps);
    const orch = layoutFor({ mode: 'orchestrator' }, ps);
    // Geometry is identical at the structural level — stub delegates.
    expect(custom.geometry.mode).toBe('orchestrator');
    expect(custom.height).toBe(orch.height);
    expect(custom.nodes.length).toBe(orch.nodes.length);
    expect(custom.edges.length).toBe(orch.edges.length);
    expect(custom.flowPaths.length).toBe(orch.flowPaths.length);
  });

  test('layoutCustomGrid accepts a CustomLayout but does not yet use it (forward-compat seam)', () => {
    const ps = mkProjects(3);
    const layout: CustomLayout = {
      kind: 'custom',
      positions: { '1': { x: 999, y: 999 } },
      edges: [],
    };
    const out = layoutCustomGrid(ps, {}, 320, layout);
    // PR-6 stub: positions are ignored — tiles come from the orchestrator
    // fallback. When the editor lands, the test gets stricter; until then
    // this pins the seam without asserting un-shipped behavior.
    expect(out.geometry.mode).toBe('orchestrator');
    expect(out.nodes.length).toBe(3);
    // Sanity: the stub didn't try to honor the bogus position (999, 999
    // would put a tile way outside any reasonable viewBox).
    expect(out.nodes[0]!.x).toBeLessThan(out.width);
    expect(out.nodes[0]!.y).toBeLessThan(out.height);
  });

  test("layoutFor without a layout still works for mode:'custom' (layout is optional)", () => {
    const ps = mkProjects(2);
    const out = layoutFor({ mode: 'custom' }, ps);
    expect(out.nodes.length).toBe(2);
  });
});
