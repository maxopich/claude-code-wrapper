import { describe, expect, test } from 'vitest';
import type { Project } from '@cebab/shared/protocol';
import { layoutFor } from './layout';

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

describe('layoutFor — invariants across N=1..8', () => {
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
    test(`orchestrator N=${n}: shape, counts, hub present`, () => {
      const layout = layoutFor({ mode: 'orchestrator' }, mkProjects(n));
      expect(layout.nodes).toHaveLength(n);
      expect(layout.nodes.every((node) => node.kind === 'worker')).toBe(true);
      expect(layout.hub).toBeDefined();
      expect(layout.hub?.kind).toBe('hub');
      expect(layout.edges).toHaveLength(n);
      expect(layout.edges.every((e) => e.from === 'hub')).toBe(true);
      expect(layout.flowPaths).toHaveLength(n);
      expect(layout.width).toBeGreaterThan(0);
      expect(layout.height).toBe(150);
      expect(layout.geometry.mode).toBe('orchestrator');
    });

    test(`chain N=${n}: shape, counts, no hub, monotonic x`, () => {
      const layout = layoutFor({ mode: 'chain' }, mkProjects(n));
      expect(layout.nodes).toHaveLength(n);
      expect(layout.nodes.every((node) => node.kind === 'worker')).toBe(true);
      expect(layout.hub).toBeUndefined();
      // Chain edges connect adjacent tiles (n-1 hops).
      expect(layout.edges).toHaveLength(Math.max(0, n - 1));
      // Chain ships one dot path (first→last); empty when no participants.
      expect(layout.flowPaths).toHaveLength(n >= 1 ? 1 : 0);
      expect(layout.width).toBeGreaterThan(0);
      expect(layout.height).toBe(84);
      expect(layout.geometry.mode).toBe('chain');
      // x positions monotonically increase
      for (let i = 1; i < layout.nodes.length; i++) {
        expect(layout.nodes[i]!.x).toBeGreaterThan(layout.nodes[i - 1]!.x);
      }
    });
  }
});

describe('layoutFor — edge structure', () => {
  test('orchestrator: every edge is hub → worker', () => {
    const layout = layoutFor({ mode: 'orchestrator' }, mkProjects(4));
    for (const edge of layout.edges) {
      expect(edge.from).toBe('hub');
      expect(typeof edge.to).toBe('number');
      expect(edge.kind).toBe('orch');
      expect(edge.d.startsWith('M')).toBe(true);
    }
  });

  test('chain: every hop is i → i+1 (strictly increasing participant index)', () => {
    const projects = mkProjects(5);
    const layout = layoutFor({ mode: 'chain' }, projects);
    for (let i = 0; i < layout.edges.length; i++) {
      const edge = layout.edges[i]!;
      expect(edge.from).toBe(projects[i]!.id);
      expect(edge.to).toBe(projects[i + 1]!.id);
      expect(edge.kind).toBe('chain');
    }
  });

  test('orchestrator: flowPaths cover every worker pid exactly once', () => {
    const projects = mkProjects(6);
    const layout = layoutFor({ mode: 'orchestrator' }, projects);
    const flowPids = new Set(layout.flowPaths.map((f) => f.pid));
    const workerPids = new Set(projects.map((p) => p.id));
    expect(flowPids).toEqual(workerPids);
  });
});

describe('layoutFor — degenerate cases', () => {
  test('N=0 returns zero-width layout, no nodes, no flow', () => {
    const orch = layoutFor({ mode: 'orchestrator' }, []);
    expect(orch.nodes).toHaveLength(0);
    expect(orch.edges).toHaveLength(0);
    expect(orch.flowPaths).toHaveLength(0);

    const chain = layoutFor({ mode: 'chain' }, []);
    expect(chain.nodes).toHaveLength(0);
    expect(chain.edges).toHaveLength(0);
    expect(chain.flowPaths).toHaveLength(0);
  });

  test("'custom' mode falls back to orchestrator layout in PR-1 (stub)", () => {
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
  // PR-1 AC: shapes computed by layoutFor must remain stable across the
  // refactor. PR-3 will deliberately change these — bump the snapshots
  // there with intent.
  test('orchestrator N=3 snapshot', () => {
    const layout = layoutFor({ mode: 'orchestrator' }, mkProjects(3));
    expect(layout).toMatchInlineSnapshot(`
      {
        "edges": [
          {
            "d": "M168 52 V70 H62 V88",
            "from": "hub",
            "kind": "orch",
            "to": 1,
          },
          {
            "d": "M168 52 V88",
            "from": "hub",
            "kind": "orch",
            "to": 2,
          },
          {
            "d": "M168 52 V70 H274 V88",
            "from": "hub",
            "kind": "orch",
            "to": 3,
          },
        ],
        "flowPaths": [
          {
            "d": "M168 52 V70 H62 V88",
            "pid": 1,
          },
          {
            "d": "M168 52 V88",
            "pid": 2,
          },
          {
            "d": "M168 52 V70 H274 V88",
            "pid": 3,
          },
        ],
        "fontSizes": {
          "name": 11,
          "role": 10,
        },
        "geometry": {
          "hubH": 30,
          "hubLabel": "orchestrator",
          "hubSlug": "cebab",
          "hubW": 106,
          "hubX": 168,
          "hubY": 20,
          "mode": "orchestrator",
          "roleY1": 118,
          "roleY2": 130,
          "workerH": 56,
          "workerY": 88,
          "workers": [
            {
              "cx": 62,
              "innerW": 76,
              "name": "agent-1",
              "pid": 1,
              "role": "",
              "w": 96,
              "x": 14,
            },
            {
              "cx": 168,
              "innerW": 76,
              "name": "agent-2",
              "pid": 2,
              "role": "",
              "w": 96,
              "x": 120,
            },
            {
              "cx": 274,
              "innerW": 76,
              "name": "agent-3",
              "pid": 3,
              "role": "",
              "w": 96,
              "x": 226,
            },
          ],
        },
        "height": 150,
        "hub": {
          "h": 30,
          "kind": "hub",
          "pid": -1,
          "w": 106,
          "x": 115,
          "y": 20,
        },
        "nodes": [
          {
            "h": 56,
            "kind": "worker",
            "pid": 1,
            "w": 96,
            "x": 14,
            "y": 88,
          },
          {
            "h": 56,
            "kind": "worker",
            "pid": 2,
            "w": 96,
            "x": 120,
            "y": 88,
          },
          {
            "h": 56,
            "kind": "worker",
            "pid": 3,
            "w": 96,
            "x": 226,
            "y": 88,
          },
        ],
        "squarePx": 372,
        "width": 336,
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
          "cy": 42,
          "mode": "chain",
          "nodeH": 56,
          "nodeY": 14,
          "roleY1": 47,
          "roleY2": 60,
          "tiles": [
            {
              "cx": 80,
              "innerW": 112,
              "name": "agent-1",
              "pid": 1,
              "role": "",
              "w": 132,
              "x": 14,
            },
            {
              "cx": 244,
              "innerW": 112,
              "name": "agent-2",
              "pid": 2,
              "role": "",
              "w": 132,
              "x": 178,
            },
            {
              "cx": 408,
              "innerW": 112,
              "name": "agent-3",
              "pid": 3,
              "role": "",
              "w": 132,
              "x": 342,
            },
          ],
        },
        "height": 84,
        "nodes": [
          {
            "h": 56,
            "kind": "worker",
            "pid": 1,
            "w": 132,
            "x": 14,
            "y": 14,
          },
          {
            "h": 56,
            "kind": "worker",
            "pid": 2,
            "w": 132,
            "x": 178,
            "y": 14,
          },
          {
            "h": 56,
            "kind": "worker",
            "pid": 3,
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
});
