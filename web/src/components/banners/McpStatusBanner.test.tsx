// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { SessionBanner } from './SessionBanner.js';
import {
  buildMcpStatusBannerItem,
  mcpStatusBannerTitle,
  mcpStillConnectingTitle,
  partitionMcpStatus,
} from './McpStatusBanner.js';

// Cebab-ws0.2: the banner that names a session's MCP servers which loaded but
// never reported as connected.
//
// What these pin, in order of how badly a regression would hurt:
//   1. the status is PRINTED, never interpreted — an unrecognised one renders
//      verbatim rather than being dressed up as a failure we did not measure;
//   2. no ACTIONS, because Cebab cannot reconnect a server mid-session and an
//      inert button is the invented remedy all over again — but dismissal is
//      offered when the caller wires it (`Cebab-9fta`): hiding a reading the
//      operator has already read is not the same as pretending to fix it;
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

  test('offers no actions, ever', () => {
    // NOT because Cebab cannot reconnect a server — since `Cebab-ormv` it can,
    // and the authority panel's live MCP section does. The reason survived its
    // premise: this banner reports a FROZEN startup reading, so a button here
    // would act on a possibly-stale fact and report into a banner that cannot
    // refresh. The live section owns the actions because it owns a current
    // read. This is the half `Cebab-9fta` did NOT change: dismissal hides a
    // reading, it does not claim to act on it.
    mount([{ name: 'ledger-tools', status: 'failed' }]);
    const item = buildMcpStatusBannerItem({
      sessionId: 'sess-abcdef12',
      servers: [{ name: 'ledger-tools', status: 'failed' }],
    });
    expect(item.actions).toBeUndefined();
  });

  test('no dismiss unless the caller wires one — absent, not a dead button', () => {
    // `SessionBanner` decides "dismissible" by the prop being present, so a
    // caller that passes nothing must produce an item with no key at all.
    mount([{ name: 'ledger-tools', status: 'failed' }]);
    const item = buildMcpStatusBannerItem({
      sessionId: 'sess-abcdef12',
      servers: [{ name: 'ledger-tools', status: 'failed' }],
    });
    expect(item.dismiss).toBeUndefined();
    expect('dismiss' in item).toBe(false);
    expect(container.querySelectorAll('button').length).toBe(0);
  });

  test('THE FIX: a wired dismiss renders a labelled button that calls back', () => {
    let calls = 0;
    const item = buildMcpStatusBannerItem({
      sessionId: 'sess-abcdef12',
      servers: [{ name: 'ledger-tools', status: 'failed' }],
      dismiss: () => {
        calls += 1;
      },
    });
    act(() => {
      root.render(<SessionBanner {...item} />);
    });
    const btn = container.querySelector('button');
    expect(btn).not.toBeNull();
    // Reachable without sight: the glyph is an x, so the accessible name has to
    // come from the label rather than the text content.
    expect(btn!.getAttribute('aria-label')).toBe('Dismiss');
    act(() => {
      btn!.click();
    });
    expect(calls).toBe(1);
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

  // ---- Cebab-z9bh: `pending` is an unfinished handshake, not a verdict ----
  //
  // Measured on SDK 0.3.251: the same claude.ai server read `pending` at init
  // in one probe and `connected` in the next. The banner used to announce that
  // as "did not come up". Every case below that asserts the banner STOPS
  // saying something is paired with a control proving it can still say it —
  // otherwise a build that simply deleted the sentence would pass.

  test('THE FIX: a pending-only reading is not announced as a failure', () => {
    const item = buildMcpStatusBannerItem({
      sessionId: 'sess-abcdef12',
      servers: [{ name: 'remote-calendar', status: 'pending' }],
    });
    expect(item.title).toBe('One MCP server was still connecting when this session started');
    expect(item.title).not.toContain('did not come up');
    // Not a warning: an unfinished handshake usually resolves itself, and a
    // warn tier for that is how an operator learns to ignore the tier.
    expect(item.tier).toBe('info');
  });

  test('CONTROL: a definite bad status still warns and still says "did not come up"', () => {
    // The anti-vacuity pair for the case above. If the fix were implemented by
    // softening the copy for everything, this reddens.
    const item = buildMcpStatusBannerItem({
      sessionId: 'sess-abcdef12',
      servers: [{ name: 'ledger-tools', status: 'failed' }],
    });
    expect(item.title).toBe('One MCP server did not come up for this session');
    expect(item.tier).toBe('warn');
  });

  test('a mixed reading counts only the definite ones in the title, and forgets neither', () => {
    // The count is the operator-visible claim, so a pending server inflating it
    // is the same false statement in a smaller font.
    const item = buildMcpStatusBannerItem({
      sessionId: 'sess-abcdef12',
      servers: [
        { name: 'ledger-tools', status: 'failed' },
        { name: 'remote-calendar', status: 'pending' },
      ],
    });
    expect(item.title).toBe('One MCP server did not come up for this session');
    expect(item.tier).toBe('warn');
    act(() => {
      root.render(<SessionBanner {...item} />);
    });
    const text = container.textContent ?? '';
    // Nothing is dropped: both servers and both verbatim statuses survive.
    expect(text).toContain('ledger-tools');
    expect(text).toContain('failed');
    expect(text).toContain('remote-calendar');
    expect(text).toContain('pending');
  });

  test('pending is a LITERAL, not a category — an unknown status is still a failure', () => {
    // The guard against this fix reopening the blind spot `notConnected` closes.
    // If someone widens the pending check to "anything that looks transient",
    // this reddens.
    const { stillConnecting, didNotComeUp } = partitionMcpStatus([
      { name: 'a', status: 'pending' },
      { name: 'b', status: 'connecting' },
      { name: 'c', status: 'some-future-status' },
      { name: 'd', status: 'needs-auth' },
    ]);
    expect(stillConnecting.map((s) => s.name)).toEqual(['a']);
    expect(didNotComeUp.map((s) => s.name)).toEqual(['b', 'c', 'd']);
  });

  test('the still-connecting title counts too', () => {
    expect(mcpStillConnectingTitle(1)).toBe(
      'One MCP server was still connecting when this session started',
    );
    expect(mcpStillConnectingTitle(2)).toBe(
      '2 MCP servers were still connecting when this session started',
    );
  });
});
