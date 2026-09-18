// @vitest-environment jsdom
/**
 * `Cebab-ormv`: the live MCP slice and the rule that decides which actions a
 * server is offered.
 *
 * THE CASE THAT MATTERS IS `never offers Reconnect for needs-auth`. It is the
 * one measured fact that a reasonable implementer would get wrong: `reconnect`
 * reads like the universal repair, and against a `needs-auth` server the CLI
 * refuses it outright (`Server status: needs-auth`). Offering it there would
 * rebuild exactly the "Retry button that quietly does nothing" the MCP banner
 * refused to ship — which is why that case is paired here with a positive
 * control proving the function DOES offer Reconnect where it works.
 */
import { describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ClientMsg, ServerMsg } from '@cebab/shared/protocol';
import { McpControlProvider, mcpActionsFor, useMcpActions, useMcpSlot } from './McpControlContext';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('mcpActionsFor', () => {
  test('THE RULE: never offers Reconnect for needs-auth', () => {
    // Measured: the CLI throws `Server status: needs-auth` rather than
    // re-authenticating. A Reconnect button there cannot work.
    expect(mcpActionsFor('needs-auth')).not.toContain('reconnect');
    expect(mcpActionsFor('needs-auth')).toEqual(['authenticate']);
  });

  test('CONTROL: it does offer Reconnect where reconnect is the remedy', () => {
    // Without this, the case above passes for a function that returns [] for
    // everything — the anti-vacuity pair, not a duplicate.
    expect(mcpActionsFor('failed')).toContain('reconnect');
    expect(mcpActionsFor('pending')).toContain('reconnect');
  });

  test('a connected server is offered sign-out, not a repair', () => {
    expect(mcpActionsFor('connected')).toEqual(['clear_auth']);
  });

  test('an unmeasured status gets the action that cannot mislead', () => {
    // The SDK's status set is not frozen. A value Cebab has never seen must
    // not silently map onto a repair that assumes a cause.
    expect(mcpActionsFor('some-future-status')).toEqual(['reconnect']);
    expect(mcpActionsFor('')).toEqual(['reconnect']);
  });

  test('every offered action is a real protocol op', () => {
    const OPS = new Set(['status', 'reconnect', 'authenticate', 'clear_auth', 'toggle']);
    for (const s of ['connected', 'needs-auth', 'failed', 'pending', 'disabled', 'weird']) {
      for (const op of mcpActionsFor(s)) expect(OPS.has(op)).toBe(true);
    }
  });
});

/** Mount the provider with a probe child that exposes the slice to the test. */
function mountHarness() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  const sent: ClientMsg[] = [];
  const handlerRef: { current: ((m: ServerMsg) => void) | null } = { current: null };
  const seen: {
    slot: ReturnType<typeof useMcpSlot> | null;
    act: ReturnType<typeof useMcpActions> | null;
  } = { slot: null, act: null };

  function Probe() {
    seen.slot = useMcpSlot(7);
    seen.act = useMcpActions();
    return null;
  }

  act(() => {
    root.render(
      <McpControlProvider send={(m) => sent.push(m)} handlerRef={handlerRef}>
        <Probe />
      </McpControlProvider>,
    );
  });
  return { root, host, sent, handlerRef, seen };
}

describe('McpControlProvider', () => {
  test('an unqueried project is idle, not empty', () => {
    const h = mountHarness();
    expect(h.seen.slot).toEqual({ status: 'idle' });
    act(() => h.root.unmount());
  });

  test('refresh ships mcp_control and marks the slot loading', () => {
    const h = mountHarness();
    act(() => h.seen.act?.refresh(7));
    expect(h.sent).toEqual([{ type: 'mcp_control', projectId: 7, op: 'status' }]);
    expect(h.seen.slot?.status).toBe('loading');
    act(() => h.root.unmount());
  });

  test('servers: null becomes FAILED, and [] becomes ready-and-empty', () => {
    // The distinction the protocol insists on. Collapsing them tells an
    // operator with no servers that Cebab is broken.
    const h = mountHarness();
    act(() =>
      h.handlerRef.current?.({
        type: 'mcp_control_result',
        projectId: 7,
        op: 'status',
        servers: null,
        error: 'spawn failed',
      } as ServerMsg),
    );
    expect(h.seen.slot?.status).toBe('failed');

    act(() =>
      h.handlerRef.current?.({
        type: 'mcp_control_result',
        projectId: 7,
        op: 'status',
        servers: [],
      } as ServerMsg),
    );
    expect(h.seen.slot?.status).toBe('ready');
    if (h.seen.slot?.status === 'ready') expect(h.seen.slot.servers).toEqual([]);
    act(() => h.root.unmount());
  });

  test('a refresh over ready data keeps the rows and marks refreshing', () => {
    // Same property `AuthoritySlot.refreshing` exists for: a request must be
    // observable, and the panel must not flash empty.
    const h = mountHarness();
    act(() =>
      h.handlerRef.current?.({
        type: 'mcp_control_result',
        projectId: 7,
        op: 'status',
        servers: [{ name: 'a', status: 'connected', toolNames: [] }],
      } as ServerMsg),
    );
    act(() => h.seen.act?.refresh(7));
    expect(h.seen.slot?.status).toBe('ready');
    if (h.seen.slot?.status === 'ready') {
      expect(h.seen.slot.refreshing).toBe(true);
      expect(h.seen.slot.servers).toHaveLength(1);
    }
    act(() => h.root.unmount());
  });

  test('an action marks only its own row busy', () => {
    const h = mountHarness();
    act(() =>
      h.handlerRef.current?.({
        type: 'mcp_control_result',
        projectId: 7,
        op: 'status',
        servers: [
          { name: 'a', status: 'failed', toolNames: [] },
          { name: 'b', status: 'connected', toolNames: [] },
        ],
      } as ServerMsg),
    );
    act(() => h.seen.act?.act(7, 'reconnect', 'a'));
    if (h.seen.slot?.status === 'ready') {
      expect(h.seen.slot.busy).toEqual({ serverName: 'a', op: 'reconnect' });
    }
    expect(h.sent.at(-1)).toEqual({
      type: 'mcp_control',
      projectId: 7,
      op: 'reconnect',
      serverName: 'a',
    });
    act(() => h.root.unmount());
  });

  test("a previous op's error does not survive the next request", () => {
    const h = mountHarness();
    act(() =>
      h.handlerRef.current?.({
        type: 'mcp_control_result',
        projectId: 7,
        op: 'reconnect',
        serverName: 'a',
        servers: [{ name: 'a', status: 'needs-auth', toolNames: [] }],
        error: 'Server status: needs-auth',
      } as ServerMsg),
    );
    if (h.seen.slot?.status === 'ready')
      expect(h.seen.slot.error).toBe('Server status: needs-auth');
    act(() => h.seen.act?.act(7, 'authenticate', 'a'));
    // A stale error sitting under a spinner reads as this action's failure.
    if (h.seen.slot?.status === 'ready') expect(h.seen.slot.error).toBeUndefined();
    act(() => h.root.unmount());
  });

  test('an authUrl lands on pendingAuth and nowhere else', () => {
    const h = mountHarness();
    act(() =>
      h.handlerRef.current?.({
        type: 'mcp_control_result',
        projectId: 7,
        op: 'authenticate',
        serverName: 'a',
        servers: [{ name: 'a', status: 'needs-auth', toolNames: [] }],
        authUrl: 'https://example.invalid/x',
      } as ServerMsg),
    );
    if (h.seen.slot?.status === 'ready') {
      expect(h.seen.slot.pendingAuth).toEqual({
        serverName: 'a',
        authUrl: 'https://example.invalid/x',
      });
    }
    act(() => h.root.unmount());
  });

  test('a result for another project does not touch this slot', () => {
    const h = mountHarness();
    act(() =>
      h.handlerRef.current?.({
        type: 'mcp_control_result',
        projectId: 99,
        op: 'status',
        servers: [{ name: 'other', status: 'connected', toolNames: [] }],
      } as ServerMsg),
    );
    expect(h.seen.slot).toEqual({ status: 'idle' });
    act(() => h.root.unmount());
  });

  test('the bridge ignores every other ServerMsg', () => {
    const h = mountHarness();
    act(() => h.handlerRef.current?.({ type: 'project_authority' } as unknown as ServerMsg));
    expect(h.seen.slot).toEqual({ status: 'idle' });
    act(() => h.root.unmount());
  });
});
