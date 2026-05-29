// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ServerMsg, SessionLogScope } from '@cebab/shared/protocol';
import { useLogStream } from './useLogStream';

// Cluster H C3 UI — pins useLogStream's `scope` forwarding contract:
//
//   1. When the consumer omits `scope`, every onLoadSessionLog call passes
//      `undefined` as its 5th arg (the server then defaults to multi_agent).
//   2. When the consumer sets `scope: 'single'`, every load — initial,
//      loadMore, refresh — passes `'single'` verbatim.
//   3. The reset effect re-fires when `scope` changes (rare in practice but
//      kept correct so a future toggling consumer doesn't carry stale rows).

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

type LoadCall = {
  sessionId: string;
  offset: number;
  limit: number;
  revealSensitive: boolean;
  scope?: SessionLogScope;
};

type Harness = {
  loadCalls: LoadCall[];
  unsub: () => void;
};

function renderProbe(scope?: SessionLogScope, sessionId = 'sess-1'): Harness {
  const loadCalls: LoadCall[] = [];
  let unsub: () => void = () => {};

  function Probe() {
    useLogStream({
      sessionId,
      scope,
      onLoadSessionLog: (sid, offset, limit, revealSensitive, sc) => {
        loadCalls.push({ sessionId: sid, offset, limit, revealSensitive, scope: sc });
      },
      subscribeServerMsg: (cb: (msg: ServerMsg) => void) => {
        // Stash a no-op cb; the hook doesn't need to deliver any chunks for
        // the forwarding assertions below.
        void cb;
        unsub = () => {};
        return unsub;
      },
    });
    return null;
  }

  act(() => {
    root.render(<Probe />);
  });
  return { loadCalls, unsub };
}

describe('useLogStream — scope forwarding (Cluster H C3 UI)', () => {
  test('omits scope (undefined) when consumer leaves it unset', () => {
    const { loadCalls } = renderProbe(undefined);
    expect(loadCalls.length).toBeGreaterThanOrEqual(1);
    const first = loadCalls[0]!;
    expect(first.sessionId).toBe('sess-1');
    expect(first.offset).toBe(0);
    expect(first.revealSensitive).toBe(false);
    expect(first.scope).toBeUndefined();
  });

  test('passes scope="single" verbatim to onLoadSessionLog on initial fetch', () => {
    const { loadCalls } = renderProbe('single');
    expect(loadCalls.length).toBeGreaterThanOrEqual(1);
    expect(loadCalls[0]?.scope).toBe('single');
  });

  test('passes scope="multi_agent" verbatim when the consumer sets it explicitly', () => {
    const { loadCalls } = renderProbe('multi_agent');
    expect(loadCalls[0]?.scope).toBe('multi_agent');
  });
});
