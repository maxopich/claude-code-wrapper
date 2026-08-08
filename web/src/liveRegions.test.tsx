// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { NotificationEnvelope } from '@cebab/shared/protocol';
import type { ConnectionLostView } from './store';
import { ConnectionLostOverlay } from './components/connectionLost/ConnectionLostOverlay';
import { StoppedMarker } from './components/StoppedMarker';
import { NotificationStack } from './components/notifications/NotificationStack';
import {
  NotificationsProvider,
  useNotificationsActions,
} from './components/notifications/NotificationsContext';

/**
 * A live region announces once, and announces the thing that changed
 * (registers U27, U31, and the double-announced toast).
 *
 * `role="alert"` / `role="status"` / `aria-live` are not decoration: an
 * element marked that way is re-read by a screen reader every time its
 * contents change. Wrap too much and every unrelated re-render becomes an
 * interruption. Two sites did:
 *
 *   - The disconnect card was `role="alert" aria-live="assertive"` around
 *     everything, including a Retry button whose label counts down once a
 *     second. `alert` carries an implicit `aria-atomic="true"`, so the region
 *     is re-read IN FULL on any change — title, body, docs link and all three
 *     buttons, assertively, once a second, until the operator acts.
 *   - The stopped marker was `role="status"` around the marker line AND the
 *     whole reason-for-stop form, so expanding "Other…" inserted a text input
 *     into a live region (insertions are announced by default) and its
 *     `autoFocus` landed inside the region being announced.
 *
 * And one site announced the right thing twice: the visible toast carries a
 * live-region role while `NotificationStack` renders sr-only mirrors of the
 * same string.
 *
 * THE RULE THIS GATE HOLDS is deliberately narrower than "no controls inside
 * a live region". `SessionBanner`'s warn tier is `role="region"
 * aria-live="polite"` with action buttons inside, and that is a legitimate,
 * quiet pattern — it announces once and never changes. What makes U27 and U31
 * defects is that the region's contents change *after* it has announced. So
 * the assertion is: **announced text is stable across a tick of the clock and
 * across interacting with the surface.** That keeps the honest patterns out of
 * scope without needing an exemption list for them.
 *
 * NOT covered: whether the announcement's wording is good, `aria-atomic`
 * choices, or announcement ORDER between regions.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

/**
 * Every element in `scope` that assistive tech will treat as a live region:
 * an explicit `aria-live` other than `off`, or a role that implies one.
 *
 * `aria-live="off"` is excluded on purpose — it is how an element keeps a role
 * for semantics while handing announcement duty to somewhere else, which is
 * exactly what the visible toast now does.
 */
function liveRegions(scope: ParentNode): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of Array.from(scope.querySelectorAll<HTMLElement>('*'))) {
    const explicit = el.getAttribute('aria-live');
    if (explicit === 'off') continue;
    const role = el.getAttribute('role');
    if (explicit !== null || role === 'alert' || role === 'status' || role === 'log') out.push(el);
  }
  return out;
}

/** Collapsed text of a region, as the announcement would read it. */
function announced(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

// ------------------------------------------------- U27: the disconnect card

const view = (over: Partial<ConnectionLostView> = {}): ConnectionLostView => ({
  reason: 'server_unreachable',
  diagnostic: { ts: 1_700_000_000_000 },
  ...over,
});

describe('[a11y] the disconnect card announces once, not once a second (U27)', () => {
  function renderOverlay() {
    act(() => {
      root.render(<ConnectionLostOverlay view={view()} onDismiss={() => {}} onRetry={() => {}} />);
    });
  }

  test('the announced text does not change as the countdown ticks', () => {
    vi.useFakeTimers();
    renderOverlay();
    const regions = liveRegions(container);
    // Anti-vacuity: if the scan found nothing, "unchanged" is trivially true.
    expect(regions).toHaveLength(1);

    const before = announced(regions[0]!);
    expect(before.length).toBeGreaterThan(20);

    // Three ticks — the countdown's own interval is 1s, and the visible
    // "(auto in Ns)" label demonstrably changes across them.
    act(() => vi.advanceTimersByTime(3000));

    const after = announced(liveRegions(container)[0]!);
    expect(after).toBe(before);
  });

  test('the thing that ticks is outside the region', () => {
    vi.useFakeTimers();
    renderOverlay();
    // Positive control for the test above: prove the countdown really is
    // re-rendering, so "text unchanged" means "scoped correctly" and not
    // "the timer never ran".
    const countdown = () => container.querySelector('.connection-lost-countdown')?.textContent;
    const first = countdown();
    expect(first).toMatch(/auto in \d+s/);
    act(() => vi.advanceTimersByTime(1000));
    expect(countdown()).not.toBe(first);

    const region = liveRegions(container)[0]!;
    expect(region.querySelector('.connection-lost-countdown')).toBeNull();
  });
});

// -------------------------------------------------- U31: the stopped marker

describe('[a11y] the stopped marker announces the marker, not the form (U31)', () => {
  function renderMarker() {
    act(() => {
      root.render(
        <StoppedMarker
          ts={1_700_000_000_000}
          ackLatencyMs={42}
          reasonSubmitted={false}
          onSubmit={() => {}}
          onSkip={() => {}}
        />,
      );
    });
  }

  test('expanding "Other…" does not change the announced text', () => {
    renderMarker();
    const regions = liveRegions(container);
    expect(regions).toHaveLength(1);
    const before = announced(regions[0]!);
    expect(before).toContain('Stopped by you');

    const other = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('Other'),
    );
    expect(other, 'the Other… button').toBeDefined();
    act(() => other!.click());

    // Positive control: the expansion really happened.
    expect(container.querySelector('.stopped-marker-other-input')).not.toBeNull();
    expect(announced(liveRegions(container)[0]!)).toBe(before);
  });

  test('no control lives inside the region', () => {
    renderMarker();
    const region = liveRegions(container)[0]!;
    expect(region.querySelectorAll('button, input, select, textarea')).toHaveLength(0);
    // ...and the controls are still rendered, i.e. they moved out of the
    // region rather than being deleted to satisfy the line above.
    expect(container.querySelectorAll('button').length).toBeGreaterThan(5);
  });
});

// ------------------------------------------- the toast, announced only once

describe('[a11y] one toast produces one announcement', () => {
  function Capture({ ref }: { ref: { push?: (n: NotificationEnvelope) => void } }) {
    ref.push = useNotificationsActions().push;
    return null;
  }

  function pushOne(severity: NotificationEnvelope['severity'], title: string) {
    const ref: { push?: (n: NotificationEnvelope) => void } = {};
    act(() => {
      root.render(
        <NotificationsProvider>
          <Capture ref={ref} />
          <NotificationStack />
        </NotificationsProvider>,
      );
    });
    act(() => {
      ref.push!({
        id: `n-${title}`,
        ts: 1_700_000_000_000,
        severity,
        class: 'operational',
        // `muteStore` keys the mute check on the prefix before ':'.
        dedupeKey: `test:${title}`,
        title,
        sticky: false,
      });
    });
  }

  test.each([
    ['info' as const, 'Bus session started'],
    ['error' as const, 'Worker crashed'],
  ])('%s: exactly one live region carries the text', (severity, title) => {
    pushOne(severity, title);
    // The visible strip keeps its role (it tells a browsing user what the
    // strip is) but hands announcement to the sr-only mirror via
    // `aria-live="off"`. Two regions carrying the same string means a screen
    // reader reads it twice.
    const carrying = liveRegions(container).filter((el) => announced(el).includes(title));
    expect(carrying).toHaveLength(1);
    // ...and the announcement did happen — a count of 1 would also be
    // satisfied by silencing both channels.
    expect(carrying[0]!.classList.contains('sr-only')).toBe(true);
  });

  test('the visible toast still renders the text and keeps a role', () => {
    pushOne('error', 'Worker crashed');
    const strip = container.querySelector('.notif');
    expect(strip?.textContent).toContain('Worker crashed');
    expect(strip?.getAttribute('role')).toBe('alert');
    expect(strip?.getAttribute('aria-live')).toBe('off');
  });
});
