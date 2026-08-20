// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { ChatView } from './ChatView';
import type { SessionView } from '../store';
import { SCROLL_STICK_THRESHOLD_PX } from '../scrollAnchor';

/**
 * Register W14 — the chat pane follows the tail, and stops following once the
 * operator scrolls up to read.
 *
 * FIRST TEST THIS COMPONENT HAS EVER HAD, and the reason it had none is worth
 * writing down: jsdom does not implement `Element.prototype.scrollTo` at all,
 * so `ChatView`'s own effect throws the moment the component renders here. The
 * stub below is what makes the component testable, and it doubles as the spy.
 *
 * THE SECOND TRAP IS SHARPER, and it was measured rather than assumed. jsdom
 * runs no layout, so `scrollTop`, `scrollHeight` and `clientHeight` all read
 * `0` — and `0 - 0 - 0 <= 32` is "pinned", no matter what `scrollTop` is
 * assigned. Run the naive version of this file (assign `scrollTop`, stage
 * nothing) against both implementations and you get:
 *
 *   - "a delta scrolls to the bottom"  → PASSES against the fix AND against the
 *     unguarded original. It cannot tell them apart.
 *   - "scrolled up, so no scroll"      → FAILS against both, because the pane
 *     reads as pinned either way. The bug's own state is unrepresentable.
 *
 * So the failure mode is not a green test hiding a red one; it is that the only
 * assertion you can write without staging is the one the bug also satisfies.
 * Every case below stages the three metrics explicitly, and each "does not
 * scroll" assertion is paired with a positive control in the same shape.
 *
 * The `scroll` events are dispatched with `bubbles: false`, which is what a
 * browser actually emits — `scroll` on an element does not bubble. React
 * attaches this one directly to the node rather than delegating it at the root
 * (unlike `onBlur`/`onMouseEnter`, which ride `focusout`/`mouseover`), so the
 * handler fires either way; dispatching it bubbling would pass here and prove
 * less. Checked both ways.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

type MaybeScrollTo = { scrollTo?: unknown };

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // jsdom ships no `Element.prototype.scrollTo`. Every real browser has one,
  // so the polyfill belongs on the prototype rather than on each element: the
  // component's mount effect runs before any per-element staging can happen,
  // and without this the very first render throws.
  (Element.prototype as MaybeScrollTo).scrollTo = () => {};
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  delete (Element.prototype as MaybeScrollTo).scrollTo;
});

function mkSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1',
    projectId: 1,
    status: 'running',
    messages: [{ kind: 'user', id: 'm1', text: 'hello' }],
    streamingText: '',
    runStartedAt: null,
    heldMessages: [],
    ...overrides,
  };
}

function render(session: SessionView) {
  act(() => {
    root.render(<ChatView session={session} isLive onPermissionDecide={() => {}} />);
  });
}

/** The `.chat` div — `ChatView`'s scroll container (`styles.css`: `overflow-y: auto`). */
function pane(): HTMLElement {
  const el = container.querySelector('.chat');
  if (!el) throw new Error('no .chat container rendered');
  return el as HTMLElement;
}

/**
 * Stage the three metrics jsdom cannot produce, and install the `scrollTo` spy.
 *
 * `scrollHeight`/`clientHeight` come from prototype getters with no setter, so
 * they need `defineProperty`. `scrollTop` is a real writable property that jsdom
 * does NOT clamp — plain assignment sticks, and it MUST stay writable so the
 * component's own scroll can be observed.
 */
function stage(el: HTMLElement, opts: { scrollTop: number; scrollHeight: number }) {
  Object.defineProperty(el, 'scrollHeight', { value: opts.scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true });
  el.scrollTop = opts.scrollTop;
  const scrollTo = vi.fn();
  (el as unknown as { scrollTo: unknown }).scrollTo = scrollTo;
  return scrollTo;
}

/** A 3000px transcript in a 600px viewport → the bottom is `scrollTop === 2400`. */
const AT_BOTTOM = { scrollTop: 2400, scrollHeight: 3000 };
const SCROLLED_UP = { scrollTop: 400, scrollHeight: 3000 };

describe('ChatView — the sessionless empty state (Cebab-ws0.5)', () => {
  test('with no session it still tells the operator to select a project', () => {
    // This sentence used to render for BOTH sessionless cases and was wrong in
    // the commoner one — a selected project with no conversation had a project
    // selected. That case moved to `NewChatPreview`; this one is what the
    // sentence actually describes, and deleting it rather than narrowing it
    // would leave nothing at all on a fresh launch.
    act(() => {
      root.render(<ChatView session={null} isLive={false} onPermissionDecide={() => {}} />);
    });
    expect(container.textContent).toContain('Select a project to start a conversation');
  });
});

describe('ChatView auto-scroll (W14)', () => {
  test('a streamed delta scrolls to the bottom when the operator is already there', () => {
    const session = mkSession();
    render(session);
    const scrollTo = stage(pane(), AT_BOTTOM);
    act(() => {
      pane().dispatchEvent(new Event('scroll', { bubbles: false }));
    });

    render(mkSession({ streamingText: 'token' }));

    expect(scrollTo).toHaveBeenCalledWith({ top: 3000 });
  });

  test('a streamed delta does NOT scroll once the operator has scrolled up', () => {
    render(mkSession());
    const scrollTo = stage(pane(), SCROLLED_UP);
    act(() => {
      pane().dispatchEvent(new Event('scroll', { bubbles: false }));
    });

    render(mkSession({ streamingText: 'token' }));

    expect(scrollTo).not.toHaveBeenCalled();
  });

  test('a new message does NOT scroll once the operator has scrolled up', () => {
    render(mkSession());
    const scrollTo = stage(pane(), SCROLLED_UP);
    act(() => {
      pane().dispatchEvent(new Event('scroll', { bubbles: false }));
    });

    render(
      mkSession({
        messages: [
          { kind: 'user', id: 'm1', text: 'hello' },
          { kind: 'user', id: 'm2', text: 'second' },
        ],
      }),
    );

    expect(scrollTo).not.toHaveBeenCalled();
  });

  test('a nudge inside the threshold keeps following; one pixel past it does not', () => {
    render(mkSession());
    const near = stage(pane(), { scrollTop: 2400 - SCROLL_STICK_THRESHOLD_PX, scrollHeight: 3000 });
    act(() => {
      pane().dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    render(mkSession({ streamingText: 'a' }));
    expect(near).toHaveBeenCalledTimes(1);

    const past = stage(pane(), {
      scrollTop: 2400 - (SCROLL_STICK_THRESHOLD_PX + 1),
      scrollHeight: 3000,
    });
    act(() => {
      pane().dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    render(mkSession({ streamingText: 'ab' }));
    expect(past).not.toHaveBeenCalled();
  });

  test('scrolling back down re-arms the pin — it is a live flag, not a one-way latch', () => {
    render(mkSession());
    const scrollTo = stage(pane(), SCROLLED_UP);
    act(() => {
      pane().dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    render(mkSession({ streamingText: 'a' }));
    expect(scrollTo).not.toHaveBeenCalled();

    // Operator scrolls back to the bottom.
    pane().scrollTop = 2400;
    act(() => {
      pane().dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    render(mkSession({ streamingText: 'ab' }));

    expect(scrollTo).toHaveBeenCalledWith({ top: 3000 });
  });

  test('switching sessions re-pins and lands at the bottom', () => {
    render(mkSession());
    const scrollTo = stage(pane(), SCROLLED_UP);
    act(() => {
      pane().dispatchEvent(new Event('scroll', { bubbles: false }));
    });
    render(mkSession({ streamingText: 'a' }));
    expect(scrollTo).not.toHaveBeenCalled();

    render(mkSession({ id: 's2', messages: [{ kind: 'user', id: 'm9', text: 'other' }] }));

    expect(scrollTo).toHaveBeenCalledWith({ top: 3000 });
  });

  test('a fresh pane opens at the bottom with no scroll event to prime it', () => {
    // The pin starts `true`, so the very first content effect follows. Staging
    // happens after the initial render, so this asserts the *next* update.
    render(mkSession());
    const scrollTo = stage(pane(), AT_BOTTOM);
    render(mkSession({ streamingText: 'first token' }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 3000 });
  });
});
