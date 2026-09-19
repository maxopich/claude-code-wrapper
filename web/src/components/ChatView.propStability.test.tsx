// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { SessionView } from '../store';

/**
 * Cebab-0u8x — ChatView must hand `MessageBlock` referentially STABLE callback
 * props across a stream_delta, or `memo(MessageBlock)` never bails out and the
 * whole transcript re-renders per token.
 *
 * This file mocks `./MessageBlock` to a stub that records the props object it
 * was given on each render, so it measures ChatView's prop stability in
 * isolation. It pins the CHATVIEW stabilisation half of the change only —
 * MessageBlock is mocked away, so `memo` is not exercised here (that is
 * `ChatView.memo.test.tsx`). Reverting the ChatView ref/useCallback work
 * reddens this; reverting the `memo` wrapper does not.
 *
 * The mock MUST export `StreamingPlaceholder` too: ChatView imports both from
 * this module, and a mock supplying only `MessageBlock` would make ChatView
 * render nothing and every assertion below pass vacuously.
 *
 * Uses createRoot + act (no @testing-library) per project convention. The
 * `mock`-prefixed name is required — vitest hoists `vi.mock` above the imports
 * and only lets its factory reference outer bindings whose name starts with
 * `mock`.
 */

const mockRecordedProps: Array<Record<string, unknown>> = [];
vi.mock('./MessageBlock', () => ({
  MessageBlock: (props: Record<string, unknown>) => {
    mockRecordedProps.push(props);
    return null;
  },
  StreamingPlaceholder: () => null,
}));

import { ChatView } from './ChatView';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

type MaybeScrollTo = { scrollTo?: unknown };

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // jsdom ships no `Element.prototype.scrollTo`; ChatView's mount effect calls
  // it on the first render. Stub it on the PROTOTYPE — the effect runs before
  // any per-element staging could happen (see ChatView.test.tsx).
  (Element.prototype as MaybeScrollTo).scrollTo = () => {};
  mockRecordedProps.length = 0;
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  delete (Element.prototype as MaybeScrollTo).scrollTo;
});

/** One message, built ONCE so its identity is preserved across renders — a
 *  render-count/identity assertion cannot pass if the fixture rebuilds the
 *  message array per render (memo is correct to re-render then). */
function mkSession(): SessionView {
  return {
    id: 's1',
    projectId: 1,
    status: 'running',
    messages: [{ kind: 'user', id: 'm1', text: 'hello' }],
    streamingText: '',
    runStartedAt: null,
    heldMessages: [],
  };
}

// A brand-new arrow for each of the FOUR callback props on every render,
// mirroring AppShell where all four are plain `function` declarations recreated
// per render. This is the unstable parent the change has to absorb.
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

test('the four callback props and message stay referentially stable across deltas', () => {
  let session = mkSession();
  render(session);

  // Drive three stream_delta-shaped renders: spread the previous session and
  // append to streamingText, exactly as the reducer does. The message array and
  // every message object keep their identity.
  for (let i = 0; i < 3; i++) {
    session = { ...session, streamingText: session.streamingText + 'x' };
    render(session);
  }

  // At least the initial mount plus the three deltas were recorded. (ChatView's
  // mount effect also calls setState once, so the exact count is not pinned.)
  expect(mockRecordedProps.length).toBeGreaterThanOrEqual(4);
  const first = mockRecordedProps[0];
  const last = mockRecordedProps[mockRecordedProps.length - 1];

  expect(last.onPermissionDecide).toBe(first.onPermissionDecide);
  expect(last.onAskUserAnswer).toBe(first.onAskUserAnswer);
  expect(last.onExtendMaxTurns).toBe(first.onExtendMaxTurns);
  expect(last.onEndMaxTurnsSession).toBe(first.onEndMaxTurnsSession);
  expect(last.message).toBe(first.message);

  // Anti-vacuity: the wrappers are real functions, not `undefined`.
  expect(typeof first.onPermissionDecide).toBe('function');
  expect(typeof first.onExtendMaxTurns).toBe('function');
});
