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
