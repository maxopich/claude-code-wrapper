// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionLogScope } from '@cebab/shared/protocol';
import { LogsButton } from './LogsButton';

// Cluster H C3 UI — pins LogsButton's scope plumbing:
//
//   1. Default mount (no `scope` prop) renders the trigger and, on click,
//      issues a `load_session_log` request without a scope field (multi-
//      agent default on the server).
//   2. `scope='single'` mount renders the same trigger and forwards the
//      scope verbatim to onLoadSessionLog.
//   3. The trigger button stays the visible affordance regardless of scope.

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  // Reset URL hash so the modal-open hash listener doesn't pre-open from a
  // prior test's leftover.
  if (window.location.hash) {
    window.history.replaceState(null, '', window.location.pathname);
  }
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
  scope?: SessionLogScope;
};

function renderButton(scope?: SessionLogScope) {
  const loadCalls: LoadCall[] = [];
  act(() => {
    root.render(
      <LogsButton
        sessionId="sess-1"
        scope={scope}
        onLoadSessionLog={(sid, _offset, _limit, _reveal, sc) => {
          loadCalls.push({ sessionId: sid, scope: sc });
        }}
        subscribeServerMsg={() => {
          return () => {};
        }}
      />,
    );
  });
  return { loadCalls };
}

function clickTrigger() {
  const btn = container.querySelector<HTMLButtonElement>('button.logs-button');
  if (!btn) throw new Error('logs-button not found');
  act(() => {
    btn.click();
  });
}

describe('LogsButton — trigger renders for both scopes', () => {
  test('default (no scope) renders the "Logs" trigger', () => {
    renderButton();
    const btn = container.querySelector('button.logs-button');
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toContain('Logs');
  });

  test('single-agent scope still renders the same trigger', () => {
    renderButton('single');
    const btn = container.querySelector('button.logs-button');
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toContain('Logs');
  });
});

describe('LogsButton — scope forwarded to onLoadSessionLog when modal opens', () => {
  test('default mount fires onLoadSessionLog without a scope', () => {
    const { loadCalls } = renderButton();
    clickTrigger();
    // useLogStream's mount effect runs synchronously after the modal opens.
    expect(loadCalls.length).toBeGreaterThanOrEqual(1);
    const fired = loadCalls[loadCalls.length - 1]!;
    expect(fired.sessionId).toBe('sess-1');
    expect(fired.scope).toBeUndefined();
  });

  test('scope="single" mount fires onLoadSessionLog with scope="single"', () => {
    const { loadCalls } = renderButton('single');
    clickTrigger();
    expect(loadCalls.length).toBeGreaterThanOrEqual(1);
    expect(loadCalls[loadCalls.length - 1]?.scope).toBe('single');
  });
});
