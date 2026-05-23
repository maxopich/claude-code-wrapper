// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { Project, ProjectFacts, ServerMsg } from '@cebab/shared/protocol';
import { SplitViewPanel } from './SplitViewPanel';

// React 18+ requires this flag for `act` in non-RTL setups.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * PR-6 coverage for the per-participant "About this project" disclosure.
 *
 * Focus areas:
 *   - The disclosure starts closed (no body in the DOM).
 *   - First open fires the RPC exactly once; reopen after close does NOT
 *     re-fire (per-panel-instance cache).
 *   - A `project_facts` reply updates the body — including the conditional
 *     CLAUDE.md sub-disclosure when `claudeMdHead` is present.
 *   - Missing fields (`claudeMdHead` absent) silently drop their rows —
 *     no "—" placeholders, no empty divs.
 *   - The panel still renders when the WS callbacks are absent (test
 *     harnesses that don't exercise the disclosure shouldn't need to
 *     stub `subscribeServerMsg`).
 */

function mkProject(id: number, name: string, path = `/tmp/${name}`): Project {
  return {
    id,
    name,
    path,
    trusted: false,
    lastUsedAt: null,
    hasClaudeMd: false,
    busInstalled: true,
    busAgentName: name.toLowerCase(),
  };
}

describe('SplitViewPanel — PR-6 facts disclosure', () => {
  let container: HTMLDivElement;
  let root: Root;
  let serverMsgListener: ((msg: ServerMsg) => void) | null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    serverMsgListener = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    serverMsgListener = null;
  });

  /** Tiny subscribe seam: captures the listener so tests can synthesise
   *  `project_facts` replies. Returns the unsubscribe (matches App.tsx). */
  function fakeSubscribe(cb: (msg: ServerMsg) => void): () => void {
    serverMsgListener = cb;
    return () => {
      if (serverMsgListener === cb) serverMsgListener = null;
    };
  }

  function emitFacts(projectId: number, facts: ProjectFacts) {
    if (!serverMsgListener) throw new Error('no listener subscribed');
    act(() => {
      serverMsgListener!({ type: 'project_facts', projectId, facts });
    });
  }

  function render(opts: {
    participants: Project[];
    onReadProjectFacts?: (id: number) => void;
    subscribeServerMsg?: (cb: (msg: ServerMsg) => void) => () => void;
  }) {
    act(() =>
      root.render(
        <SplitViewPanel
          participants={opts.participants}
          roles={{}}
          onRoleChange={() => {}}
          selectedPid={null}
          onSelect={() => {}}
          onReadProjectFacts={opts.onReadProjectFacts}
          subscribeServerMsg={opts.subscribeServerMsg}
        />,
      ),
    );
  }

  test('disclosure starts closed (no body content rendered)', () => {
    const onRead = vi.fn();
    render({
      participants: [mkProject(1, 'alpha')],
      onReadProjectFacts: onRead,
      subscribeServerMsg: fakeSubscribe,
    });
    const details = container.querySelector<HTMLDetailsElement>('.tpl-panel-facts');
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    // Closed → no RPC fired on mount.
    expect(onRead).not.toHaveBeenCalled();
    // Body content (working dir line) isn't present yet.
    expect(container.querySelector('.tpl-panel-facts-row')).toBeNull();
  });

  test('first open fires the RPC exactly once', () => {
    const onRead = vi.fn();
    render({
      participants: [mkProject(7, 'alpha')],
      onReadProjectFacts: onRead,
      subscribeServerMsg: fakeSubscribe,
    });
    const details = container.querySelector<HTMLDetailsElement>('.tpl-panel-facts')!;
    // Open the disclosure. `details.open = true` + dispatching the toggle
    // event matches what a click on the <summary> does in jsdom.
    act(() => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    expect(onRead).toHaveBeenCalledTimes(1);
    expect(onRead).toHaveBeenCalledWith(7);
    // While loading, the body renders the loading placeholder (not the
    // working-dir line yet — that appears once the reply lands).
    expect(container.querySelector('.tpl-panel-facts-loading')).not.toBeNull();
  });

  test('reopen after close does NOT re-fire the RPC (cached for the panel instance)', () => {
    const onRead = vi.fn();
    render({
      participants: [mkProject(9, 'beta')],
      onReadProjectFacts: onRead,
      subscribeServerMsg: fakeSubscribe,
    });
    const details = container.querySelector<HTMLDetailsElement>('.tpl-panel-facts')!;
    // First open.
    act(() => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    expect(onRead).toHaveBeenCalledTimes(1);
    // Close.
    act(() => {
      details.open = false;
      details.dispatchEvent(new Event('toggle'));
    });
    // Reopen — still 1 (cached).
    act(() => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    expect(onRead).toHaveBeenCalledTimes(1);
  });

  test('project_facts reply renders working dir + CLAUDE.md sub-disclosure', () => {
    const onRead = vi.fn();
    render({
      participants: [mkProject(3, 'gamma', '/projects/gamma-root')],
      onReadProjectFacts: onRead,
      subscribeServerMsg: fakeSubscribe,
    });
    const details = container.querySelector<HTMLDetailsElement>('.tpl-panel-facts')!;
    act(() => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    emitFacts(3, {
      name: 'gamma',
      path: '/projects/gamma-root',
      claudeMdHead: '# Gamma\n\n- rule one\n',
      claudeMdSizeLabel: '0.1 KB',
    });
    // Working-directory line is present with the absolute path.
    const factsRow = container.querySelector('.tpl-panel-facts-row');
    expect(factsRow).not.toBeNull();
    expect(factsRow!.textContent).toContain('/projects/gamma-root');
    // CLAUDE.md inner disclosure exists with the size label.
    const claudeMd = container.querySelector('.tpl-panel-facts-claudemd');
    expect(claudeMd).not.toBeNull();
    expect(claudeMd!.textContent).toContain('CLAUDE.md');
    expect(claudeMd!.textContent).toContain('0.1 KB');
  });

  test('missing claudeMdHead → no CLAUDE.md sub-disclosure (no placeholder)', () => {
    const onRead = vi.fn();
    render({
      participants: [mkProject(5, 'delta', '/projects/delta')],
      onReadProjectFacts: onRead,
      subscribeServerMsg: fakeSubscribe,
    });
    const details = container.querySelector<HTMLDetailsElement>('.tpl-panel-facts')!;
    act(() => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    // Reply has NO claudeMdHead — project just has no CLAUDE.md on disk.
    emitFacts(5, { name: 'delta', path: '/projects/delta' });
    // The working-dir line still renders.
    expect(container.querySelector('.tpl-panel-facts-row')).not.toBeNull();
    // But the inner disclosure does NOT render — no empty "CLAUDE.md ()" row.
    expect(container.querySelector('.tpl-panel-facts-claudemd')).toBeNull();
    // And no monospace head element appears.
    expect(container.querySelector('.tpl-panel-claudemd-head')).toBeNull();
  });

  test('panel renders without WS callbacks (summary stays inert, no crash)', () => {
    // Test-harness path: no onReadProjectFacts / subscribeServerMsg given.
    // The summary should still appear (operators see the affordance), but
    // opening it must not throw.
    render({ participants: [mkProject(11, 'epsilon')] });
    const details = container.querySelector<HTMLDetailsElement>('.tpl-panel-facts');
    expect(details).not.toBeNull();
    // Opening should NOT throw even without the callback wiring.
    expect(() => {
      act(() => {
        details!.open = true;
        details!.dispatchEvent(new Event('toggle'));
      });
    }).not.toThrow();
    // No body content beyond the empty body container — no loading
    // placeholder (nothing fired) and no facts row.
    expect(container.querySelector('.tpl-panel-facts-loading')).toBeNull();
    expect(container.querySelector('.tpl-panel-facts-row')).toBeNull();
  });

  test('a stray reply for a project we never asked about is ignored', () => {
    const onRead = vi.fn();
    render({
      participants: [mkProject(1, 'alpha')],
      onReadProjectFacts: onRead,
      subscribeServerMsg: fakeSubscribe,
    });
    // Listener is captured even though no disclosure has opened.
    expect(serverMsgListener).not.toBeNull();
    // Synthesise a reply for a project we never asked about.
    emitFacts(999, { name: 'rogue', path: '/tmp/rogue' });
    // No facts content appears anywhere.
    expect(container.querySelector('.tpl-panel-facts-row')).toBeNull();
    expect(container.querySelector('.tpl-panel-facts-loading')).toBeNull();
  });
});
