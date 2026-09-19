// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import * as format from '../format';
import { ChatView } from './ChatView';
import type { MessageView, SessionView } from '../store';

/**
 * Cebab-0u8x — the real, memoised MessageBlock must not re-render across a
 * stream_delta, and a permission decision issued after several deltas must still
 * carry the correct requestId AND run App's NEWEST closure.
 *
 * This file uses the REAL MessageBlock (no module mock), so it exercises
 * `memo(MessageBlock)`. Renders of the real component are counted by spying on
 * `messageCopyText` from '../format': MessageBlock.tsx calls it unconditionally,
 * once per render, as its first statement before every early return. `vi.spyOn`
 * on a namespace import is the mechanism; the anti-vacuity control below proves
 * the spy actually intercepts (if it did not, the control's growing-count
 * assertion would fail rather than pass silently).
 *
 * Uses createRoot + act (no @testing-library) per project convention.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

type MaybeScrollTo = { scrollTo?: unknown };

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // jsdom ships no `Element.prototype.scrollTo`; ChatView calls it on mount.
  // Stub on the PROTOTYPE (see ChatView.test.tsx for why).
  (Element.prototype as MaybeScrollTo).scrollTo = () => {};
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  delete (Element.prototype as MaybeScrollTo).scrollTo;
  vi.restoreAllMocks();
});

/** Five plain messages, built ONCE. Callers spread the session and keep this
 *  array (and its objects) identical across renders — memo is correct to
 *  re-render when `message` identity changes, so a render-count assertion built
 *  on a per-render-rebuilt fixture (like ChatView.test.tsx's mkSession) could
 *  never pass. */
function mkFiveMessageSession(): SessionView {
  const messages: MessageView[] = Array.from({ length: 5 }, (_, i) => ({
    kind: 'user' as const,
    id: `m${i}`,
    text: `line ${i}`,
  }));
  return {
    id: 's1',
    projectId: 1,
    status: 'running',
    messages,
    streamingText: '',
    runStartedAt: null,
    heldMessages: [],
  };
}

// The unstable-parent wrapper: a brand-new arrow for each of the FOUR callbacks
// on every render, mirroring AppShell. Required here too — with module-const
// callbacks the render-count test would go green on `memo(MessageBlock)` alone,
// measuring nothing about ChatView's stabilisation.
function render(session: SessionView) {
  act(() => {
    root.render(
      <ChatView
        session={session}
        isLive
        onPermissionDecide={() => {}}
        onAskUserAnswer={() => {}}
        onExtendMaxTurns={() => {}}
        onEndMaxTurnsSession={() => {}}
      />,
    );
  });
}

test('a stream_delta does not re-render already-mounted MessageBlocks', () => {
  const spy = vi.spyOn(format, 'messageCopyText');
  let session = mkFiveMessageSession();
  render(session);
  // Initial mount renders each of the 5 messages once.
  expect(spy.mock.calls.length).toBe(5);

  for (let i = 0; i < 3; i++) {
    session = { ...session, streamingText: session.streamingText + 'x' };
    render(session);
  }
  // Memo bails out for every unchanged message → still 5, not 5 + 5*3 = 20.
  expect(spy.mock.calls.length).toBe(5);
});

test('CONTROL: rebuilt message identities DO re-render, proving the spy intercepts', () => {
  const spy = vi.spyOn(format, 'messageCopyText');
  let session = mkFiveMessageSession();
  render(session);
  expect(spy.mock.calls.length).toBe(5);

  // Same scenario, but each delta gives every message object a new identity.
  // Memo cannot bail, so the count MUST grow. Without this control a spy pointed
  // at the wrong export — or a render swallowed by a mock — reads as a perfect
  // pass at a flat 0/5.
  for (let i = 0; i < 3; i++) {
    session = {
      ...session,
      streamingText: session.streamingText + 'x',
      messages: session.messages.map((m) => ({ ...m })),
    };
    render(session);
  }
  expect(spy.mock.calls.length).toBeGreaterThan(5);
});

// ---------------------------------------------------------------------------
// Staleness: an operator clicking Allow on a permission card AFTER several
// deltas must (a) not have re-rendered that card on any of those deltas — the
// point of the change — and (b) still run App's NEWEST closure with the card's
// own requestId, so the memo bailout never freezes a stale approve-the-wrong-
// tool callback in place.
//
// WHICH HALF EACH ASSERTION REDDENS ON REVERT:
//  - The "rendered exactly once" assertion pins BOTH halves. Revert `memo`
//    (MessageBlock re-renders every delta) OR revert the ChatView stabilisation
//    (the callback props are fresh each render, so memo cannot bail) and the
//    card re-renders per delta → the count is > 1 → this reddens. This is what
//    makes the case fail on unmodified main, where neither half exists.
//  - The requestId + newest-closure assertions are the SAFETY property: they
//    would still pass on main (main passes App's newest closure straight
//    through), but they guard against a BUGGY version of this change — a ref
//    initialised once and never refreshed, which would approve using a stale
//    closure. They are the regression guard the render-count cannot see.
// ---------------------------------------------------------------------------

function permissionMessage(): MessageView {
  return {
    kind: 'permission_request',
    id: 'perm-1',
    requestId: 'req-42',
    toolName: 'Read',
    input: { file_path: 'README.md' },
    category: 'read', // NOT 'dangerous' — that arms a two-click confirm and
    // sends nothing on the first click (PermissionCards.tsx).
    summary: 'Read README.md',
  } as MessageView;
}

test('a permission card is not re-rendered across deltas yet Allow still runs the newest closure', () => {
  const spy = vi.spyOn(format, 'messageCopyText');
  const decideCalls: Array<{ requestId: string; renderIndex: number }> = [];
  let renderIndex = 0;

  // Built ONCE so the permission message keeps its identity across deltas; the
  // spy is filtered by this exact object to count only THIS card's renders.
  const permMsg = permissionMessage();
  const userMsg: MessageView = { kind: 'user', id: 'm0', text: 'hi' };
  let session: SessionView = {
    id: 's1',
    projectId: 1,
    status: 'running',
    messages: [userMsg, permMsg],
    streamingText: '',
    runStartedAt: null,
    heldMessages: [],
  };

  // Each render supplies a fresh onPermissionDecide that closes over ITS OWN
  // render index. If the ref is refreshed correctly, the click runs the last
  // one; if the ref is frozen at first render, it runs index 0.
  function renderPerm(s: SessionView) {
    const myIndex = renderIndex++;
    act(() => {
      root.render(
        <ChatView
          session={s}
          isLive
          onPermissionDecide={(requestId) => decideCalls.push({ requestId, renderIndex: myIndex })}
          onAskUserAnswer={() => {}}
          onExtendMaxTurns={() => {}}
          onEndMaxTurnsSession={() => {}}
        />,
      );
    });
  }

  renderPerm(session); // index 0
  for (let i = 0; i < 3; i++) {
    session = { ...session, streamingText: session.streamingText + 'x' };
    renderPerm(session); // indices 1, 2, 3
  }
  const finalIndex = renderIndex - 1;

  // The card rendered once (at mount) and was memo-bailed on all three deltas.
  // Reverting either half of the change makes it re-render per delta → > 1.
  const permRenders = spy.mock.calls.filter((c) => c[0] === permMsg).length;
  expect(permRenders).toBe(1);

  const allow = container.querySelector<HTMLButtonElement>('button.permission-allow');
  if (!allow) throw new Error('no Allow button rendered');
  act(() => {
    allow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  expect(decideCalls).toHaveLength(1);
  expect(decideCalls[0].requestId).toBe('req-42');
  // The closure that ran was the newest, not a stale one captured at mount.
  expect(decideCalls[0].renderIndex).toBe(finalIndex);
});
