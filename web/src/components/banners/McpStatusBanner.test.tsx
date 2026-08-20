// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { SessionBanner } from './SessionBanner.js';
import { buildMcpStatusBannerItem, mcpStatusBannerTitle } from './McpStatusBanner.js';

// Cebab-ws0.2: the banner that names a session's MCP servers which loaded but
// never reported as connected.
//
// What these pin, in order of how badly a regression would hurt:
//   1. the status is PRINTED, never interpreted — an unrecognised one renders
//      verbatim rather than being dressed up as a failure we did not measure;
//   2. no actions and no dismiss, because Cebab cannot reconnect a server
//      mid-session and an inert button is the invented remedy all over again;
//   3. the copy says the never-loaded case is a different thing, so the
//      operator is not sent looking in the wrong place.

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  sessionStorage.clear();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function mount(servers: { name: string; status: string }[]) {
  const item = buildMcpStatusBannerItem({ sessionId: 'sess-abcdef12', servers });
  act(() => {
    root.render(<SessionBanner {...item} />);
  });
  return item;
}

describe('McpStatusBanner', () => {
  test('names each server and renders its status verbatim, including an unknown one', () => {
    mount([
      { name: 'ledger-tools', status: 'failed' },
      { name: 'calendar', status: 'some-future-status' },
    ]);
    const text = container.textContent ?? '';
    expect(text).toContain('ledger-tools');
    expect(text).toContain('failed');
    expect(text).toContain('calendar');
    // The load-bearing one: mapping unknown statuses onto a known label
    // reddens here. Cebab may not report a cause the SDK did not give it.
    expect(text).toContain('some-future-status');
  });

  test('offers no actions and no dismiss', () => {
    // Every button in this banner would be inert — the SDK connects servers at
    // spawn and there is no mid-session retry. An affordance that does nothing
    // is worse than none, which is the whole reason this bead exists.
    mount([{ name: 'ledger-tools', status: 'failed' }]);
    const item = buildMcpStatusBannerItem({
      sessionId: 'sess-abcdef12',
      servers: [{ name: 'ledger-tools', status: 'failed' }],
    });
    expect(item.actions).toBeUndefined();
    expect(item.dismiss).toBeUndefined();
    expect(container.querySelectorAll('button').length).toBe(0);
  });

  test('warn tier, and an id derived from the session', () => {
    // Not danger: danger steals focus and is for states that block progress.
    // The id must be per-session so two sessions do not share one banner slot.
    const item = buildMcpStatusBannerItem({
      sessionId: 'sess-abcdef12',
      servers: [{ name: 'ledger-tools', status: 'failed' }],
    });
    expect(item.tier).toBe('warn');
    expect(item.id).toBe('mcp-status-sess-abcdef12');
  });

  test('says the never-loaded case is a different situation', () => {
    // Without this sentence the banner reads as covering every way a server can
    // be missing, and an operator whose server is out of scope goes hunting for
    // a connection fault that does not exist.
    mount([{ name: 'ledger-tools', status: 'failed' }]);
    const text = container.textContent ?? '';
    expect(text).toContain('does not appear here');
    expect(text.toLowerCase()).toContain('sidebar');
  });

  test('the title counts, and reads correctly for one server', () => {
    expect(mcpStatusBannerTitle(1)).toBe('One MCP server did not come up for this session');
    expect(mcpStatusBannerTitle(3)).toBe('3 MCP servers did not come up for this session');
  });
});
