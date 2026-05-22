import { describe, expect, test } from 'vitest';
import type { CustomLayout, MultiAgentTemplate } from './protocol.js';
import { validateCustomTopology, validateTemplateTopology } from './topology.js';

/**
 * PR-6 — `validateCustomTopology` AC coverage. The validator pins the
 * F2/F3 invariants (see `server/src/bus/orchestrator.ts`) at the
 * presentation layer so a future custom-mode editor can refuse-to-save
 * topologies the bus would silently drop. The renderer does NOT call
 * this — invalid layouts still render (they just look wrong).
 */

function mkTemplate(participants: number[]): Pick<MultiAgentTemplate, 'participants'> {
  return { participants };
}

function customLayout(edges: Array<[number, number]>): CustomLayout {
  return {
    kind: 'custom',
    positions: {},
    edges: edges.map(([from, to]) => ({ from, to })),
  };
}

describe('validateCustomTopology', () => {
  test('empty edges → valid (default orchestrator star — every worker is hub-anchored implicitly)', () => {
    const layout: CustomLayout = { kind: 'custom', positions: {} };
    const r = validateCustomTopology(mkTemplate([1, 2, 3]), layout);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  test('self-loop → flagged (worker addressing itself is meaningless)', () => {
    const r = validateCustomTopology(mkTemplate([1, 2]), customLayout([[1, 1]]));
    expect(r.ok).toBe(false);
    expect(r.violations).toContainEqual({ code: 'self_loop', from: 1, to: 1 });
  });

  test('worker → worker → flagged (F2 drops these at runtime)', () => {
    const r = validateCustomTopology(mkTemplate([1, 2, 3]), customLayout([[1, 2]]));
    expect(r.ok).toBe(false);
    expect(r.violations).toContainEqual({ code: 'worker_to_worker', from: 1, to: 2 });
  });

  test('unknown endpoint → flagged (edge references non-participant)', () => {
    const r = validateCustomTopology(mkTemplate([1, 2]), customLayout([[1, 99]]));
    expect(r.ok).toBe(false);
    expect(r.violations).toContainEqual({ code: 'unknown_endpoint', from: 1, to: 99 });
  });

  test('unreachable participant → flagged when other edges exist but pid has none', () => {
    // Edge 1↔2 (still worker-to-worker so already flagged), pid=3 has no edge
    // → also unreachable. Both violations appear.
    const r = validateCustomTopology(mkTemplate([1, 2, 3]), customLayout([[1, 2]]));
    expect(r.ok).toBe(false);
    expect(r.violations).toContainEqual({ code: 'unreachable_participant', pid: 3 });
  });

  test('positions are not validated (visual only)', () => {
    // Wildly out-of-range / negative coords + stale key for pid=99 → still ok.
    const layout: CustomLayout = {
      kind: 'custom',
      positions: { '1': { x: -10000, y: 99999 }, '99': { x: 0, y: 0 } },
      edges: [],
    };
    expect(validateCustomTopology(mkTemplate([1, 2]), layout).ok).toBe(true);
  });

  test('multiple violations collected, not short-circuited', () => {
    const r = validateCustomTopology(
      mkTemplate([1, 2, 3]),
      customLayout([
        [1, 1], // self-loop
        [2, 99], // unknown endpoint
      ]),
    );
    // self-loop + unknown + (pid=3 unreachable since edges exist)
    expect(r.violations.length).toBeGreaterThanOrEqual(3);
    expect(r.violations).toContainEqual({ code: 'self_loop', from: 1, to: 1 });
    expect(r.violations).toContainEqual({ code: 'unknown_endpoint', from: 2, to: 99 });
  });
});

describe('validateTemplateTopology', () => {
  test('templates without layout pass trivially (chain/orchestrator have no freeform topology)', () => {
    const tpl: MultiAgentTemplate = {
      id: 't1',
      name: 'Orchestrator template',
      mode: 'orchestrator',
      lifecycle: 'persistent',
      participants: [1, 2, 3],
    };
    const r = validateTemplateTopology(tpl);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  test('custom template with invalid layout → flagged', () => {
    const tpl: MultiAgentTemplate = {
      id: 't2',
      name: 'Bad custom',
      mode: 'custom',
      lifecycle: 'persistent',
      participants: [1, 2],
      layout: customLayout([[1, 1]]),
    };
    expect(validateTemplateTopology(tpl).ok).toBe(false);
  });

  test('custom template with empty edges → valid', () => {
    const tpl: MultiAgentTemplate = {
      id: 't3',
      name: 'Implicit star',
      mode: 'custom',
      lifecycle: 'persistent',
      participants: [1, 2, 3],
      layout: { kind: 'custom', positions: { '1': { x: 0, y: 0 } } },
    };
    expect(validateTemplateTopology(tpl).ok).toBe(true);
  });
});
