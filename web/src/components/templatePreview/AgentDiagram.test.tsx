// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { Project } from '@cebab/shared/protocol';
import { AgentDiagram } from './AgentDiagram';

/**
 * PR-3 coverage. The directional-edges work has three observable
 * contracts in the DOM, one per mode:
 *
 *  - **orchestrator**: every edge has BOTH `markerStart` (tail dot at
 *    hub) AND `markerEnd` (arrowhead at worker), referencing the
 *    namespaced `#tpl-tail-in` / `#tpl-arrow-out` markers. The
 *    `<figcaption>` describes the no-peer-to-peer contract.
 *  - **chain**: every edge has only `markerEnd`, referencing the
 *    renamed `#tpl-arrow-chain` marker (was `#tpl-arrow`). The
 *    `<figcaption>` describes the receive-from-prior contract.
 *  - **custom**: every edge has NEITHER marker (the renderer falls
 *    back to orchestrator layout via `layoutCustomGrid`, but the
 *    visual must match the banner's "approximation" disclaimer). The
 *    `<figcaption>` says routing isn't visualized.
 *
 * Uses raw createRoot + act to match the existing PR-5 modal tests.
 */

// React 18+ requires this flag for `act` in non-RTL setups.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  // jsdom doesn't ship matchMedia; AgentDiagram reads it once for the
  // reduced-motion check. Stub as "no preference" (motion allowed) so
  // the trip-animation code path is exercised the same way as a real
  // browser at the time of render.
  Object.defineProperty(window, 'matchMedia', {
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
    configurable: true,
  });
});

function mkProject(id: number, name: string): Project {
  return {
    id,
    name,
    path: `/tmp/${name}`,
    trusted: true,
    lastUsedAt: null,
    hasClaudeMd: true,
    busInstalled: true,
    busAgentName: name.toLowerCase(),
  };
}

describe('AgentDiagram — directional edges (PR-3)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(mode: 'chain' | 'orchestrator' | 'custom', participants: Project[]) {
    act(() => {
      root.render(
        <AgentDiagram mode={mode} participants={participants} roles={{}} onRoleChange={() => {}} />,
      );
    });
  }

  test('orchestrator: each edge carries markerStart (tail) AND markerEnd (arrow)', () => {
    render('orchestrator', [mkProject(1, 'Alpha'), mkProject(2, 'Beta')]);
    const edges = container.querySelectorAll('.tpl-edge');
    expect(edges.length).toBeGreaterThan(0);
    edges.forEach((e) => {
      expect(e.getAttribute('marker-start')).toBe('url(#tpl-tail-in)');
      expect(e.getAttribute('marker-end')).toBe('url(#tpl-arrow-out)');
    });
    // The <defs> block must declare both marker IDs the edges reference.
    expect(container.querySelector('#tpl-arrow-out')).not.toBeNull();
    expect(container.querySelector('#tpl-tail-in')).not.toBeNull();
  });

  test('custom: edges have NO markers (no arrowheads, no tail dot)', () => {
    render('custom', [mkProject(1, 'Alpha'), mkProject(2, 'Beta')]);
    const edges = container.querySelectorAll('.tpl-edge');
    expect(edges.length).toBeGreaterThan(0);
    edges.forEach((e) => {
      expect(e.getAttribute('marker-start')).toBeNull();
      expect(e.getAttribute('marker-end')).toBeNull();
    });
    // The <defs> block is also gated — no markers in the DOM at all.
    expect(container.querySelector('#tpl-arrow-out')).toBeNull();
    expect(container.querySelector('#tpl-tail-in')).toBeNull();
  });

  test('chain: edges use the renamed #tpl-arrow-chain marker', () => {
    render('chain', [mkProject(1, 'Alpha'), mkProject(2, 'Beta'), mkProject(3, 'Gamma')]);
    const edges = container.querySelectorAll('.tpl-edge');
    expect(edges.length).toBeGreaterThan(0);
    edges.forEach((e) => {
      expect(e.getAttribute('marker-end')).toBe('url(#tpl-arrow-chain)');
      // Chain edges are uni-directional; no tail dot at the source side.
      expect(e.getAttribute('marker-start')).toBeNull();
    });
    expect(container.querySelector('#tpl-arrow-chain')).not.toBeNull();
    // The pre-PR-3 marker id must be fully gone — no callers should
    // reference `#tpl-arrow` (without the `-chain` suffix).
    expect(container.querySelector('#tpl-arrow')).toBeNull();
  });
});

describe('AgentDiagram — protocol <figcaption> (PR-3)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(mode: 'chain' | 'orchestrator' | 'custom', participants: Project[]) {
    act(() => {
      root.render(
        <AgentDiagram mode={mode} participants={participants} roles={{}} onRoleChange={() => {}} />,
      );
    });
  }

  test('outer element is a <figure>, not a <div>', () => {
    render('orchestrator', [mkProject(1, 'Alpha')]);
    const fig = container.querySelector('figure.tpl-stage');
    expect(fig).not.toBeNull();
    // The figure replaces the <div className="tpl-stage"> — no leftover.
    expect(container.querySelector('div.tpl-stage')).toBeNull();
  });

  test('orchestrator caption describes no-peer-to-peer routing', () => {
    render('orchestrator', [mkProject(1, 'Alpha'), mkProject(2, 'Beta')]);
    const cap = container.querySelector('.tpl-figcaption');
    expect(cap?.textContent).toMatch(/peer-to-peer/i);
    expect(cap?.tagName).toBe('FIGCAPTION');
  });

  test('chain caption describes receive-from-prior routing', () => {
    render('chain', [mkProject(1, 'Alpha'), mkProject(2, 'Beta')]);
    const cap = container.querySelector('.tpl-figcaption');
    expect(cap?.textContent).toMatch(/receives from the prior/i);
  });

  test('custom caption disclaims that routing is not visualized', () => {
    render('custom', [mkProject(1, 'Alpha'), mkProject(2, 'Beta')]);
    const cap = container.querySelector('.tpl-figcaption');
    expect(cap?.textContent).toMatch(/not yet visualized/i);
  });
});

describe('AgentDiagram — density=full multi-line names (PR-4)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('arc tier (N=6) with fullWidth=true renders <tspan> rows for long names', () => {
    // 6 agents puts orchestrator into the arc tier. Full density tile
    // is 130×40 px → fitChars ≈ 16 at FS=11. Names longer than ~16
    // chars force a 2-line wrap (`<tspan>`); shorter names stay
    // single-line via truncLabel and emit zero tspans.
    const participants = Array.from({ length: 6 }, (_, i) =>
      mkProject(i + 1, `much-longer-agent-name-${i + 1}`),
    );
    act(() => {
      root.render(
        <AgentDiagram
          mode="orchestrator"
          participants={participants}
          roles={{}}
          onRoleChange={() => {}}
          fullWidth
        />,
      );
    });
    const tspans = container.querySelectorAll('.tpl-node-name tspan');
    // Six agents × 2 tspans each = 12 lines.
    expect(tspans.length).toBe(12);
  });

  test('compact arc tier (no fullWidth) renders single-line names', () => {
    const participants = Array.from({ length: 6 }, (_, i) =>
      mkProject(i + 1, `agent-name-${i + 1}`),
    );
    act(() => {
      root.render(
        <AgentDiagram
          mode="orchestrator"
          participants={participants}
          roles={{}}
          onRoleChange={() => {}}
        />,
      );
    });
    // Compact: no tspans in .tpl-node-name (single-line text content).
    const tspans = container.querySelectorAll('.tpl-node-name tspan');
    expect(tspans.length).toBe(0);
  });

  test('ring tier (N=10) with fullWidth=true renders under-badge labels', () => {
    const participants = Array.from({ length: 10 }, (_, i) =>
      mkProject(i + 1, `agent-name-${i + 1}`),
    );
    act(() => {
      root.render(
        <AgentDiagram
          mode="orchestrator"
          participants={participants}
          roles={{}}
          onRoleChange={() => {}}
          fullWidth
        />,
      );
    });
    const labels = container.querySelectorAll('.tpl-node-badge-label');
    // One <text> per badge at full density at ring tier.
    expect(labels.length).toBe(10);
  });

  test('ring tier compact: NO under-badge labels (glyph-only)', () => {
    const participants = Array.from({ length: 10 }, (_, i) =>
      mkProject(i + 1, `agent-name-${i + 1}`),
    );
    act(() => {
      root.render(
        <AgentDiagram
          mode="orchestrator"
          participants={participants}
          roles={{}}
          onRoleChange={() => {}}
        />,
      );
    });
    const labels = container.querySelectorAll('.tpl-node-badge-label');
    expect(labels.length).toBe(0);
  });

  test('concentric (N=30) with fullWidth=true labels ONLY inner ring badges', () => {
    const participants = Array.from({ length: 30 }, (_, i) =>
      mkProject(i + 1, `agent-name-${i + 1}`),
    );
    act(() => {
      root.render(
        <AgentDiagram
          mode="orchestrator"
          participants={participants}
          roles={{}}
          onRoleChange={() => {}}
          fullWidth
        />,
      );
    });
    // Inner ring at N=30 holds 6+6 = 12 slots; outer ring carries the
    // remaining 18 unlabeled. The test asserts the EXACT 12 — proving
    // the outer-ring suppression isn't accidental.
    const labels = container.querySelectorAll('.tpl-node-badge-label');
    expect(labels.length).toBe(12);
  });
});

describe('AgentDiagram — per-edge <title> (PR-3 SR linearization)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('orchestrator edges name "orchestrator → <worker>"', () => {
    act(() => {
      root.render(
        <AgentDiagram
          mode="orchestrator"
          participants={[mkProject(1, 'Alpha'), mkProject(2, 'Beta')]}
          roles={{}}
          onRoleChange={() => {}}
        />,
      );
    });
    const titles = Array.from(container.querySelectorAll('.tpl-edge > title')).map(
      (t) => t.textContent ?? '',
    );
    expect(titles).toEqual(expect.arrayContaining(['orchestrator → Alpha', 'orchestrator → Beta']));
  });

  test('chain edges name "<from> → <to>" using participant names', () => {
    act(() => {
      root.render(
        <AgentDiagram
          mode="chain"
          participants={[mkProject(1, 'Alpha'), mkProject(2, 'Beta'), mkProject(3, 'Gamma')]}
          roles={{}}
          onRoleChange={() => {}}
        />,
      );
    });
    const titles = Array.from(container.querySelectorAll('.tpl-edge > title')).map(
      (t) => t.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    );
    expect(titles).toEqual(expect.arrayContaining(['Alpha → Beta', 'Beta → Gamma']));
  });
});
