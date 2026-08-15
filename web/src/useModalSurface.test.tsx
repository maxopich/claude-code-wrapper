// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { INERT_EXEMPT_ATTR, useModalSurface } from './useModalSurface';

/**
 * The modal focus trap, and its one exemption (register U28).
 *
 * `useModalSurface` walks from the overlay up to `<body>` marking every
 * sibling `inert`, which is what stops Tab from escaping an open dialog into
 * the page behind it. `ConnectionLostOverlay` renders as a sibling of the
 * modals inside `.app` — so opening any dialog while the connection was
 * already down left the one surface saying "Cebab cannot reach the server"
 * not merely dimmed but **non-interactive**: Retry, Copy diagnostic and
 * Dismiss all dead, with no way to reach the thing that explains why the
 * dialog in front of them cannot succeed.
 *
 * Both halves are asserted here on purpose. An exemption that quietly grew to
 * cover everything would "pass" the second test while destroying the trap the
 * first one describes, and the failure mode of a broken focus trap is silent.
 *
 * NOT covered: the z-index half of U28 (a stylesheet question — see
 * `railFocus.test.ts`), scroll lock, or Escape handling (`useModalKeys`).
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

/** A minimal consumer: the overlay div `useModalSurface` anchors its walk on. */
function Modal() {
  const { overlayRef } = useModalSurface({ onClose: () => {} });
  return (
    <div ref={overlayRef} className="test-modal-overlay">
      <button type="button">inside</button>
    </div>
  );
}

/** Same shape, but wired through a ref the hook never sees — used to prove the
 *  walk is what does the inerting, not the mere presence of the component. */
function Inert00() {
  const ref = useRef<HTMLDivElement>(null);
  return <div ref={ref} />;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  // Siblings are created per test on document.body; clear any strays.
  for (const el of Array.from(document.body.children)) {
    if (el !== host) el.remove();
  }
});

/** A sibling of the React host, i.e. a peer of the modal overlay's ancestor. */
function sibling(attrs: Record<string, string> = {}): HTMLElement {
  const el = document.createElement('div');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

describe('[a11y] useModalSurface inert trap', () => {
  test('an ordinary sibling is inerted while the modal is open', () => {
    // The guard against the exemption swallowing the whole feature: if this
    // ever passes trivially, the trap is gone and every test below is moot.
    const other = sibling();
    expect(other.hasAttribute('inert')).toBe(false);
    act(() => root.render(<Modal />));
    expect(other.hasAttribute('inert')).toBe(true);
  });

  test('and is released when the modal unmounts', () => {
    const other = sibling();
    act(() => root.render(<Modal />));
    expect(other.hasAttribute('inert')).toBe(true);
    act(() => root.render(<Inert00 />));
    expect(other.hasAttribute('inert')).toBe(false);
  });

  test('a sibling marked exempt is left alone (U28)', () => {
    const exempt = sibling({ [INERT_EXEMPT_ATTR]: '' });
    act(() => root.render(<Modal />));
    expect(exempt.hasAttribute('inert')).toBe(false);
  });

  test('the exemption is opt-in, not the default', () => {
    // Both in one render, so a walk that inerted nothing at all — the way this
    // could regress without anyone noticing — fails here rather than looking
    // like a working exemption.
    const exempt = sibling({ [INERT_EXEMPT_ATTR]: '' });
    const ordinary = sibling();
    act(() => root.render(<Modal />));
    expect({
      exempt: exempt.hasAttribute('inert'),
      ordinary: ordinary.hasAttribute('inert'),
    }).toEqual({ exempt: false, ordinary: true });
  });

  test('an already-inert sibling is not released by the modal closing', () => {
    // Pre-existing behaviour, pinned because the exemption sits next to it:
    // the walk skips siblings that were already inert, so a nested modal
    // cannot un-inert what its parent inerted.
    const preInert = sibling({ inert: '' });
    act(() => root.render(<Modal />));
    act(() => root.render(<Inert00 />));
    expect(preInert.hasAttribute('inert')).toBe(true);
  });
});
