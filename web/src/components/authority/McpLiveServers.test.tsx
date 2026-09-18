// @vitest-environment jsdom
/**
 * `Cebab-ormv`: what the live MCP section actually puts in front of an
 * operator.
 *
 * The context test pins the action RULE; this pins that the rule reaches the
 * DOM — a correct `mcpActionsFor` wired to a row that renders a hardcoded
 * button list would pass there and fail here. The two are not duplicates.
 */
import { describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ClientMsg, ServerMsg } from '@cebab/shared/protocol';
import { McpControlProvider } from './McpControlContext';
import { McpLiveServers } from './McpLiveServers';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  const sent: ClientMsg[] = [];
  const handlerRef: { current: ((m: ServerMsg) => void) | null } = { current: null };
  act(() => {
    root.render(
      <McpControlProvider send={(m) => sent.push(m)} handlerRef={handlerRef}>
        <McpLiveServers projectId={7} now={1_000_000} />
      </McpControlProvider>,
    );
  });
  const deliver = (servers: unknown, extra: Record<string, unknown> = {}) =>
    act(() => {
      handlerRef.current?.({
        type: 'mcp_control_result',
        projectId: 7,
        op: 'status',
        servers,
        ...extra,
      } as ServerMsg);
    });
  const buttons = () => Array.from(host.querySelectorAll('button')).map((b) => b.textContent ?? '');
  const click = (label: string) => {
    const b = Array.from(host.querySelectorAll('button')).find((x) => x.textContent === label);
    if (!b) throw new Error(`no button "${label}" in: ${buttons().join(' | ')}`);
    act(() => b.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  };
  const open = () => {
    // The section is a <details>; force it open so the body renders.
    host.querySelectorAll('details').forEach((d) => {
      d.open = true;
    });
  };
  return { root, host, sent, deliver, buttons, click, open, text: () => host.textContent ?? '' };
}

describe('McpLiveServers', () => {
  test('a needs-auth row offers Authenticate and NOT Reconnect', () => {
    const h = mount();
    h.open();
    h.deliver([{ name: 'locked', status: 'needs-auth', toolNames: [] }]);
    h.open();
    expect(h.buttons()).toContain('Authenticate');
    expect(h.buttons()).not.toContain('Reconnect');
    act(() => h.root.unmount());
  });

  test('CONTROL: a failed row DOES offer Reconnect, and clicking it ships the op', () => {
    const h = mount();
    h.open();
    h.deliver([{ name: 'broken', status: 'failed', toolNames: [] }]);
    h.open();
    expect(h.buttons()).toContain('Reconnect');
    h.click('Reconnect');
    expect(h.sent.at(-1)).toEqual({
      type: 'mcp_control',
      projectId: 7,
      op: 'reconnect',
      serverName: 'broken',
    });
    act(() => h.root.unmount());
  });

  test('a refused reconnect shows the error AND keeps the rows', () => {
    // The server-side ordering rule, seen from the operator's side.
    const h = mount();
    h.open();
    h.deliver([{ name: 'locked', status: 'needs-auth', toolNames: [] }], {
      op: 'reconnect',
      serverName: 'locked',
      error: 'Server status: needs-auth',
    });
    h.open();
    expect(h.text()).toContain('Server status: needs-auth');
    expect(h.text()).toContain('locked');
    act(() => h.root.unmount());
  });

  test('the SDK status string is printed verbatim, not translated', () => {
    const h = mount();
    h.open();
    h.deliver([{ name: 'x', status: 'some-unmeasured-status', toolNames: [] }]);
    h.open();
    expect(h.text()).toContain('some-unmeasured-status');
    act(() => h.root.unmount());
  });

  test('tool counts are rendered, which the init snapshot never carried', () => {
    const h = mount();
    h.open();
    h.deliver([
      { name: 'gmail', status: 'connected', toolNames: ['a', 'b', 'c'] },
      { name: 'one', status: 'connected', toolNames: ['a'] },
    ]);
    h.open();
    expect(h.text()).toContain('3 tools');
    expect(h.text()).toContain('1 tool');
    act(() => h.root.unmount());
  });

  test('an empty read reads as an answer, not as a failure', () => {
    const h = mount();
    h.open();
    h.deliver([]);
    h.open();
    expect(h.text()).toMatch(/loads no MCP servers/i);
    expect(h.text()).not.toMatch(/could not read/i);
    act(() => h.root.unmount());
  });

  test('a failed READ says so, and is distinguishable from an empty one', () => {
    const h = mount();
    h.open();
    h.deliver(null, { error: 'spawn failed' });
    h.open();
    expect(h.text()).toMatch(/could not read/i);
    expect(h.text()).toContain('spawn failed');
    act(() => h.root.unmount());
  });

  test('an authenticate reply renders a real link to the auth URL', () => {
    const h = mount();
    h.open();
    h.deliver([{ name: 'locked', status: 'needs-auth', toolNames: [] }], {
      op: 'authenticate',
      serverName: 'locked',
      authUrl: 'https://example.invalid/authorize',
    });
    h.open();
    const a = h.host.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://example.invalid/authorize');
    // A new tab, and no referrer leakage to the identity provider.
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toContain('noopener');
    act(() => h.root.unmount());
  });

  test('the unsupported-callback arm refuses in words, with no link to follow', () => {
    const h = mount();
    h.open();
    h.deliver([{ name: 'weird', status: 'needs-auth', toolNames: [] }], {
      op: 'authenticate',
      serverName: 'weird',
      callbackUnsupported: true,
    });
    h.open();
    expect(h.text()).toMatch(/will not pretend to support it/i);
    expect(h.host.querySelector('a')).toBeNull();
    act(() => h.root.unmount());
  });

  test('nothing is read until the operator asks', () => {
    // A spawn runs the project's SessionStart hooks. Mounting must not.
    const h = mount();
    expect(h.sent).toEqual([]);
    expect(h.text()).toMatch(/not read yet/i);
    act(() => h.root.unmount());
  });

  test('Read live ships a status op', () => {
    const h = mount();
    h.open();
    h.click('Read live');
    expect(h.sent).toEqual([{ type: 'mcp_control', projectId: 7, op: 'status' }]);
    act(() => h.root.unmount());
  });
});
