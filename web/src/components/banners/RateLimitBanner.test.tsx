// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { SessionBanner } from './SessionBanner.js';
import {
  buildBusAutoRetryBannerItem,
  buildRateLimitBannerItem,
  busAutoRetryBannerTitle,
  rateLimitBannerTitle,
  type RateLimitBannerCallbacks,
} from './RateLimitBanner.js';
import type { MultiAgentAutoRetry, RateLimitState } from '../../store.js';

// Cluster D Phase 4c: RateLimitBanner is a factory producing
// BannerStackItem props. The tests exercise:
//   1. title shape (manual-retry mode vs auto-retry mode)
//   2. body composition (countdown + overage + held-queue summary)
//   3. action set (retry / pause toggle / disabled-while-in-flight)
//   4. held-queue detail with per-item drop buttons (UI-D7)
//   5. wiring into a real <SessionBanner> renders without throwing
//   6. callback wiring fires retry / pause / drop with the right args

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
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
  vi.useRealTimers();
});

function mkCallbacks(over: Partial<RateLimitBannerCallbacks> = {}): RateLimitBannerCallbacks {
  return {
    onManualRetry: vi.fn(),
    onAutoRetry: vi.fn(),
    onPauseToggle: vi.fn(),
    onDropHeld: vi.fn(),
    ...over,
  };
}

const baseState: RateLimitState = {
  paused: false,
  retryInFlight: false,
  resetsAtMs: 1_700_000_060_000, // 60s from "now"
};
const NOW = 1_700_000_000_000;
const stableNow = () => NOW;

describe('rateLimitBannerTitle', () => {
  test('plain rate-limit returns "Rate limit reached"', () => {
    expect(rateLimitBannerTitle(baseState)).toBe('Rate limit reached');
  });

  test('with autoRetry, embeds attempt n of m', () => {
    expect(
      rateLimitBannerTitle({
        ...baseState,
        autoRetry: {
          attempt: 3,
          maxAttempts: 5,
          backoffMs: 30_000,
          retryAt: NOW + 30_000,
          reason: 'transient_overload',
        },
      }),
    ).toBe('Rate limit — auto-retry attempt 3 of 5');
  });
});

describe('buildRateLimitBannerItem — shape', () => {
  test('id derives from sessionId; tier=warn; glyph=hourglass', () => {
    const item = buildRateLimitBannerItem({
      sessionId: 'sess-abc',
      state: baseState,
      heldMessages: [],
      callbacks: mkCallbacks(),
      now: stableNow,
    });
    expect(item.id).toBe('rate-limit-sess-abc');
    expect(item.tier).toBe('warn');
    expect(item.glyph).toBe('⏳');
  });

  test('two actions: primary Retry + ghost Pause; both enabled by default', () => {
    const item = buildRateLimitBannerItem({
      sessionId: 'sess-1',
      state: baseState,
      heldMessages: [],
      callbacks: mkCallbacks(),
      now: stableNow,
    });
    const actions = item.actions ?? [];
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({
      label: 'Retry now',
      variant: 'primary',
      disabled: false,
      pending: false,
    });
    expect(actions[1]).toMatchObject({
      label: 'Pause auto-retry',
      variant: 'ghost',
    });
  });

  test('retryInFlight switches Retry label/state to "Retrying…" + disabled + pending', () => {
    const item = buildRateLimitBannerItem({
      sessionId: 'sess-1',
      state: { ...baseState, retryInFlight: true },
      heldMessages: [],
      callbacks: mkCallbacks(),
      now: stableNow,
    });
    expect(item.actions?.[0]).toMatchObject({
      label: 'Retrying…',
      disabled: true,
      pending: true,
    });
  });

  test('paused state flips Pause action label to "Resume auto-retry"', () => {
    const item = buildRateLimitBannerItem({
      sessionId: 'sess-1',
      state: { ...baseState, paused: true },
      heldMessages: [],
      callbacks: mkCallbacks(),
      now: stableNow,
    });
    expect(item.actions?.[1]?.label).toBe('Resume auto-retry');
  });

  test('no held messages → no detail panel (detail + detailLabel undefined)', () => {
    const item = buildRateLimitBannerItem({
      sessionId: 'sess-1',
      state: baseState,
      heldMessages: [],
      callbacks: mkCallbacks(),
      now: stableNow,
    });
    expect(item.detail).toBeUndefined();
    expect(item.detailLabel).toBeUndefined();
  });

  test('held messages → detailLabel reflects count + plural form', () => {
    const one = buildRateLimitBannerItem({
      sessionId: 's',
      state: baseState,
      heldMessages: ['hi'],
      callbacks: mkCallbacks(),
      now: stableNow,
    });
    expect(one.detailLabel).toBe('1 held message');

    const two = buildRateLimitBannerItem({
      sessionId: 's',
      state: baseState,
      heldMessages: ['hi', 'there'],
      callbacks: mkCallbacks(),
      now: stableNow,
    });
    expect(two.detailLabel).toBe('2 held messages');
  });

  test('arrivedAt prop passes through verbatim for BannerStack tiebreak', () => {
    const item = buildRateLimitBannerItem({
      sessionId: 's',
      state: baseState,
      heldMessages: [],
      callbacks: mkCallbacks(),
      now: stableNow,
      arrivedAt: 1234,
    });
    expect(item.arrivedAt).toBe(1234);
  });
});

describe('buildRateLimitBannerItem — render integration', () => {
  function renderItem(args: Parameters<typeof buildRateLimitBannerItem>[0]) {
    const item = buildRateLimitBannerItem(args);
    act(() => {
      root.render(<SessionBanner {...item} />);
    });
    return item;
  }

  test('mounts inside SessionBanner without throwing; visible countdown shows m:ss', () => {
    renderItem({
      sessionId: 'sess-1',
      state: baseState,
      heldMessages: [],
      callbacks: mkCallbacks(),
      now: stableNow,
    });
    // The chip text "1:00" appears in the body prose.
    expect(container.textContent).toContain('1:00');
    expect(container.textContent).toContain('Rate limit reached');
  });

  test('shows held-message count in body prose when queue is non-empty', () => {
    renderItem({
      sessionId: 'sess-1',
      state: baseState,
      heldMessages: ['draft 1', 'draft 2'],
      callbacks: mkCallbacks(),
      now: stableNow,
    });
    expect(container.textContent).toContain('2 held');
    // The <details> summary collapsed by default — open it.
    const summary = container.querySelector('summary');
    expect(summary).not.toBeNull();
    expect(summary!.textContent).toContain('2 held');
  });

  test('manual retry click invokes onManualRetry exactly once', () => {
    const onManualRetry = vi.fn();
    renderItem({
      sessionId: 'sess-1',
      state: baseState,
      heldMessages: [],
      callbacks: mkCallbacks({ onManualRetry }),
      now: stableNow,
    });
    const retryBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Retry now',
    );
    expect(retryBtn).toBeTruthy();
    act(() => {
      retryBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onManualRetry).toHaveBeenCalledTimes(1);
  });

  test('pause toggle click invokes onPauseToggle(!paused)', () => {
    const onPauseToggle = vi.fn();
    renderItem({
      sessionId: 'sess-1',
      state: baseState,
      heldMessages: [],
      callbacks: mkCallbacks({ onPauseToggle }),
      now: stableNow,
    });
    const pauseBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Pause auto-retry',
    );
    act(() => {
      pauseBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onPauseToggle).toHaveBeenCalledTimes(1);
    expect(onPauseToggle).toHaveBeenCalledWith(true); // !paused = !false = true
  });

  test('drop button on a held-message row fires onDropHeld(index)', () => {
    const onDropHeld = vi.fn();
    renderItem({
      sessionId: 'sess-1',
      state: baseState,
      heldMessages: ['first', 'second', 'third'],
      callbacks: mkCallbacks({ onDropHeld }),
      now: stableNow,
    });
    const dropBtns = container.querySelectorAll('button.rate-limit-banner-held-drop');
    expect(dropBtns.length).toBe(3);
    act(() => {
      (dropBtns[1] as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onDropHeld).toHaveBeenCalledWith(1);
  });

  test('autoRetry block: banner shows "auto-retry attempt n of m" and a next-attempt countdown', () => {
    renderItem({
      sessionId: 'sess-1',
      state: {
        ...baseState,
        autoRetry: {
          attempt: 2,
          maxAttempts: 5,
          backoffMs: 30_000,
          retryAt: NOW + 30_000,
          reason: 'transient_overload',
        },
      },
      heldMessages: [],
      callbacks: mkCallbacks(),
      now: stableNow,
    });
    expect(container.textContent).toContain('auto-retry attempt 2 of 5');
    expect(container.textContent).toContain('0:30'); // 30s countdown
  });

  test('countdown elapse fires onAutoRetry callback (not onManualRetry)', () => {
    const onManualRetry = vi.fn();
    const onAutoRetry = vi.fn();
    let n = NOW;
    const now = () => n;
    renderItem({
      sessionId: 'sess-1',
      state: { ...baseState, resetsAtMs: n + 2_000 },
      heldMessages: [],
      callbacks: mkCallbacks({ onManualRetry, onAutoRetry }),
      now,
    });
    // Advance to elapse.
    n += 2000;
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(onAutoRetry).toHaveBeenCalledTimes(1);
    expect(onManualRetry).not.toHaveBeenCalled();
  });

  test('paused chip does NOT fire onAutoRetry even after target elapses', () => {
    const onAutoRetry = vi.fn();
    let n = NOW;
    const now = () => n;
    renderItem({
      sessionId: 'sess-1',
      state: { ...baseState, paused: true, resetsAtMs: n + 2_000 },
      heldMessages: [],
      callbacks: mkCallbacks({ onAutoRetry }),
      now,
    });
    n += 10_000;
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onAutoRetry).not.toHaveBeenCalled();
  });

  test('overage block renders only when any overage field is present', () => {
    // No overage fields → no overage prose
    renderItem({
      sessionId: 'sess-1',
      state: baseState,
      heldMessages: [],
      callbacks: mkCallbacks(),
      now: stableNow,
    });
    expect(container.textContent).not.toContain('Overage');

    act(() => {
      root.unmount();
    });
    root = createRoot(container);

    renderItem({
      sessionId: 'sess-1',
      state: {
        ...baseState,
        overageStatus: 'allowed',
        isUsingOverage: true,
        overageResetsAtMs: NOW + 90_000,
      },
      heldMessages: [],
      callbacks: mkCallbacks(),
      now: stableNow,
    });
    expect(container.textContent).toContain('Overage budget');
    expect(container.textContent).toContain('in use');
    expect(container.textContent).toContain('1:30'); // overage refill countdown
  });
});

// Cluster D Phase 4d: observe-only multi-agent bus auto-retry banner.
// The bus owns the retry loop server-side; no Retry/Pause/heldQueue.
const NOW_4D = 1_700_000_000_000;
const stableNow4d = () => NOW_4D;

describe('busAutoRetryBannerTitle', () => {
  test('embeds attempt n of m, no rate-limit phrasing (it is bus-specific)', () => {
    expect(
      busAutoRetryBannerTitle({
        attempt: 2,
        maxAttempts: 5,
        backoffMs: 30_000,
        retryAt: NOW_4D + 30_000,
        reason: 'transient_overload',
      }),
    ).toBe('Bus auto-retry — attempt 2 of 5');
  });
});

describe('buildBusAutoRetryBannerItem — shape', () => {
  const baseAutoRetry: MultiAgentAutoRetry = {
    attempt: 1,
    maxAttempts: 5,
    backoffMs: 30_000,
    retryAt: NOW_4D + 30_000,
    reason: 'transient_overload',
  };

  test('id derives from sessionId; tier=warn; glyph=hourglass', () => {
    const item = buildBusAutoRetryBannerItem({
      sessionId: 'bus-sess-1',
      state: baseAutoRetry,
      callbacks: { onClear: vi.fn() },
      now: stableNow4d,
    });
    expect(item.id).toBe('bus-auto-retry-bus-sess-1');
    expect(item.tier).toBe('warn');
    expect(item.glyph).toBe('⏳');
  });

  test('NO actions (observe-only — bus owns the retry loop)', () => {
    const item = buildBusAutoRetryBannerItem({
      sessionId: 'bus-sess-1',
      state: baseAutoRetry,
      callbacks: { onClear: vi.fn() },
      now: stableNow4d,
    });
    expect(item.actions).toBeUndefined();
  });

  test('arrivedAt prop passes through verbatim for BannerStack tiebreak', () => {
    const item = buildBusAutoRetryBannerItem({
      sessionId: 'bus-sess-1',
      state: baseAutoRetry,
      callbacks: { onClear: vi.fn() },
      now: stableNow4d,
      arrivedAt: 9999,
    });
    expect(item.arrivedAt).toBe(9999);
  });
});

describe('buildBusAutoRetryBannerItem — render integration', () => {
  const baseAutoRetry: MultiAgentAutoRetry = {
    attempt: 1,
    maxAttempts: 5,
    backoffMs: 30_000,
    retryAt: NOW_4D + 30_000,
    reason: 'transient_overload',
  };

  function renderItem(args: Parameters<typeof buildBusAutoRetryBannerItem>[0]) {
    const item = buildBusAutoRetryBannerItem(args);
    act(() => {
      root.render(<SessionBanner {...item} />);
    });
    return item;
  }

  test('body prose names the reason (transient overload 529)', () => {
    renderItem({
      sessionId: 'bus-1',
      state: baseAutoRetry,
      callbacks: { onClear: vi.fn() },
      now: stableNow4d,
    });
    expect(container.textContent).toContain('transient overload (529)');
    expect(container.textContent).toContain('0:30');
  });

  test('rate_limit_hard reason renders distinct phrasing', () => {
    renderItem({
      sessionId: 'bus-1',
      state: { ...baseAutoRetry, reason: 'rate_limit_hard' },
      callbacks: { onClear: vi.fn() },
      now: stableNow4d,
    });
    expect(container.textContent).toContain('hard rate-limit');
    expect(container.textContent).not.toContain('transient overload');
  });

  test('agentName renders inline as <code> when present', () => {
    renderItem({
      sessionId: 'bus-1',
      state: { ...baseAutoRetry, agentName: 'reviewer' },
      callbacks: { onClear: vi.fn() },
      now: stableNow4d,
    });
    const codeEl = container.querySelector('code');
    expect(codeEl?.textContent).toBe('reviewer');
  });

  test('agentName omitted → no <code> agent chip', () => {
    renderItem({
      sessionId: 'bus-1',
      state: baseAutoRetry,
      callbacks: { onClear: vi.fn() },
      now: stableNow4d,
    });
    expect(container.querySelector('code')).toBeNull();
  });

  test('countdown elapse fires onClear (the chip-driven banner self-clear)', () => {
    let n = NOW_4D;
    const now = () => n;
    const onClear = vi.fn();
    renderItem({
      sessionId: 'bus-1',
      state: { ...baseAutoRetry, retryAt: n + 2_000 },
      callbacks: { onClear },
      now,
    });
    n += 2000;
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  test('explanation prose makes clear no operator action is needed', () => {
    renderItem({
      sessionId: 'bus-1',
      state: baseAutoRetry,
      callbacks: { onClear: vi.fn() },
      now: stableNow4d,
    });
    // The "no operator action needed" framing is what distinguishes
    // this banner from the single-agent one — it's the cue that the
    // absence of buttons is intentional, not a missing feature.
    expect(container.textContent).toContain('no operator action');
  });
});
