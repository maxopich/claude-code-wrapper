// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { BannerStack, type BannerStackItem } from './BannerStack';

// Cluster D Phase 3 (spec §8.2): BannerStack contract.
//
// Tests cover:
//   - empty: renders nothing (returns null)
//   - single landmark: one role="region" aria-label="Session notices"
//   - priority sort: danger > error > warn > progress > info > invariant
//     regardless of arrival order
//   - tiebreaker within tier: newest arrivedAt first
//   - max 3 visible by default; overflow into <details> "+N more"
//   - overflow summary is singular vs plural based on count
//   - explicit maxVisible respects the override

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

function makeBanner(id: string, tier: BannerStackItem['tier'], arrivedAt = 0): BannerStackItem {
  return { id, tier, title: id, stealsFocus: false, arrivedAt };
}

describe('BannerStack — empty + landmark', () => {
  test('empty list renders nothing', () => {
    act(() => {
      root.render(<BannerStack banners={[]} />);
    });
    expect(container.querySelector('.session-banner-stack')).toBeNull();
  });

  test('non-empty renders single region landmark', () => {
    act(() => {
      root.render(<BannerStack banners={[makeBanner('a', 'info')]} />);
    });
    const region = container.querySelector('.session-banner-stack') as HTMLElement;
    expect(region.tagName).toBe('SECTION');
    expect(region.getAttribute('role')).toBe('region');
    expect(region.getAttribute('aria-label')).toBe('Session notices');
  });

  test('passes className through to the root', () => {
    act(() => {
      root.render(<BannerStack banners={[makeBanner('a', 'info')]} className="extra-cls" />);
    });
    const region = container.querySelector('.session-banner-stack') as HTMLElement;
    expect(region.className).toBe('session-banner-stack extra-cls');
  });
});

describe('BannerStack — priority sort (spec §8.2)', () => {
  test('sorts danger > error > warn > progress > info > invariant regardless of input order', () => {
    // Insert in REVERSE priority order to confirm the stack re-sorts.
    const banners = [
      makeBanner('invariant', 'invariant'),
      makeBanner('info', 'info'),
      makeBanner('progress', 'progress'),
      makeBanner('warn', 'warn'),
      makeBanner('error', 'error'),
      makeBanner('danger', 'danger'),
    ];
    act(() => {
      root.render(<BannerStack banners={banners} maxVisible={10} />);
    });
    const ids = Array.from(container.querySelectorAll('.session-banner')).map((b) => b.id);
    expect(ids).toEqual(['danger', 'error', 'warn', 'progress', 'info', 'invariant']);
  });

  test('within-tier tiebreaker: newest arrivedAt first', () => {
    const banners = [
      makeBanner('warn-old', 'warn', 1000),
      makeBanner('warn-mid', 'warn', 2000),
      makeBanner('warn-new', 'warn', 3000),
    ];
    act(() => {
      root.render(<BannerStack banners={banners} maxVisible={10} />);
    });
    const ids = Array.from(container.querySelectorAll('.session-banner')).map((b) => b.id);
    expect(ids).toEqual(['warn-new', 'warn-mid', 'warn-old']);
  });

  test('cross-tier + within-tier ordering combined', () => {
    const banners = [
      makeBanner('w-old', 'warn', 1000),
      makeBanner('d-old', 'danger', 500),
      makeBanner('w-new', 'warn', 2000),
      makeBanner('d-new', 'danger', 1500),
    ];
    act(() => {
      root.render(<BannerStack banners={banners} maxVisible={10} />);
    });
    const ids = Array.from(container.querySelectorAll('.session-banner')).map((b) => b.id);
    expect(ids).toEqual(['d-new', 'd-old', 'w-new', 'w-old']);
  });
});

describe('BannerStack — max-3 cap (spec §8.2)', () => {
  test('exactly 3 banners → no overflow', () => {
    act(() => {
      root.render(
        <BannerStack
          banners={[makeBanner('a', 'info'), makeBanner('b', 'info'), makeBanner('c', 'info')]}
        />,
      );
    });
    expect(container.querySelectorAll('.session-banner-stack > .session-banner')).toHaveLength(3);
    expect(container.querySelector('.session-banner-stack-overflow')).toBeNull();
  });

  test('4 banners → 3 visible + overflow with 1', () => {
    act(() => {
      root.render(
        <BannerStack
          banners={[
            makeBanner('d', 'danger', 4),
            makeBanner('e', 'error', 3),
            makeBanner('w', 'warn', 2),
            makeBanner('i', 'info', 1),
          ]}
        />,
      );
    });
    const top = container.querySelectorAll('.session-banner-stack > .session-banner');
    expect(top).toHaveLength(3);
    expect(Array.from(top).map((b) => b.id)).toEqual(['d', 'e', 'w']);
    const overflow = container.querySelector('.session-banner-stack-overflow') as HTMLElement;
    expect(overflow).not.toBeNull();
    expect(overflow.querySelector('summary')?.textContent).toBe('+1 more notice');
    const overflowBanners = overflow.querySelectorAll('.session-banner');
    expect(overflowBanners).toHaveLength(1);
    expect(overflowBanners[0].id).toBe('i');
  });

  test('5+ banners → overflow summary plural', () => {
    act(() => {
      root.render(
        <BannerStack
          banners={[
            makeBanner('d', 'danger', 5),
            makeBanner('e', 'error', 4),
            makeBanner('w', 'warn', 3),
            makeBanner('i1', 'info', 2),
            makeBanner('i2', 'info', 1),
            makeBanner('inv', 'invariant', 0),
          ]}
        />,
      );
    });
    const overflow = container.querySelector('.session-banner-stack-overflow') as HTMLElement;
    expect(overflow.querySelector('summary')?.textContent).toBe('+3 more notices');
    expect(overflow.querySelectorAll('.session-banner')).toHaveLength(3);
  });

  test('explicit maxVisible=2 caps at 2', () => {
    act(() => {
      root.render(
        <BannerStack
          maxVisible={2}
          banners={[
            makeBanner('d', 'danger', 3),
            makeBanner('e', 'error', 2),
            makeBanner('w', 'warn', 1),
          ]}
        />,
      );
    });
    expect(container.querySelectorAll('.session-banner-stack > .session-banner')).toHaveLength(2);
    const overflow = container.querySelector('.session-banner-stack-overflow') as HTMLElement;
    expect(overflow.querySelector('summary')?.textContent).toBe('+1 more notice');
  });
});
