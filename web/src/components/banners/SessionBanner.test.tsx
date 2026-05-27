// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { SessionBanner, type BannerTier } from './SessionBanner';

// Cluster D Phase 3 (spec §8.1, §8.4): SessionBanner contract.
//
// Tests cover:
//   - tier → role + aria-live mapping (info / warn / progress / error /
//     danger / invariant)
//   - explicit role / ariaLive override the tier default
//   - dismiss button renders only when `dismiss` prop is supplied
//   - actions render with variant classes; primary > ghost > default
//   - href action renders <a>, click action renders <button>
//   - detail renders inside <details><summary>
//   - danger tier steals focus on first mount; sessionStorage prevents
//     re-steal on remount of same id
//   - non-danger tiers do not steal focus
//   - explicit `stealsFocus={false}` on danger suppresses the steal
//   - classStem swap (`tpl-banner` / `multi-agent-warning`) produces
//     legacy-class DOM with no `is-${tier}` injection (migration parity)
//   - layout="flat" hoists children out of the -text wrapper
//   - compatClass appears in the root className

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // Wipe per-id focus-steal memory so each test starts clean.
  sessionStorage.clear();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('SessionBanner — a11y tier mapping (spec §8.4)', () => {
  // Per spec §8.4: tier drives role + aria-live by default.
  const cases: Array<{
    tier: BannerTier;
    role: string;
    ariaLive: string | null;
  }> = [
    { tier: 'info', role: 'region', ariaLive: null },
    { tier: 'warn', role: 'region', ariaLive: 'polite' },
    { tier: 'progress', role: 'region', ariaLive: 'polite' },
    { tier: 'error', role: 'region', ariaLive: 'assertive' },
    { tier: 'danger', role: 'region', ariaLive: 'assertive' },
    { tier: 'invariant', role: 'region', ariaLive: null },
  ];

  for (const c of cases) {
    test(`tier='${c.tier}' → role='${c.role}' aria-live=${c.ariaLive ?? '(unset)'}`, () => {
      act(() => {
        root.render(
          <SessionBanner
            id={`t-${c.tier}`}
            tier={c.tier}
            title="x"
            // Danger steals focus by default; turn it off so the test
            // doesn't race against the setTimeout(0) focus call.
            stealsFocus={false}
          />,
        );
      });
      const el = container.querySelector('.session-banner') as HTMLElement;
      expect(el.getAttribute('role')).toBe(c.role);
      expect(el.getAttribute('aria-live')).toBe(c.ariaLive);
    });
  }

  test('explicit role + ariaLive override tier defaults', () => {
    act(() => {
      root.render(
        <SessionBanner
          id="override"
          tier="warn"
          title="x"
          role="alert"
          ariaLive="assertive"
          stealsFocus={false}
        />,
      );
    });
    const el = container.querySelector('.session-banner') as HTMLElement;
    expect(el.getAttribute('role')).toBe('alert');
    expect(el.getAttribute('aria-live')).toBe('assertive');
  });

  test('ariaLive="off" results in no aria-live attribute', () => {
    act(() => {
      root.render(
        <SessionBanner id="off" tier="warn" title="x" ariaLive="off" stealsFocus={false} />,
      );
    });
    const el = container.querySelector('.session-banner') as HTMLElement;
    expect(el.hasAttribute('aria-live')).toBe(false);
  });
});

describe('SessionBanner — dismiss + actions + detail', () => {
  test('dismiss button absent when no dismiss prop', () => {
    act(() => {
      root.render(<SessionBanner id="a" tier="info" title="x" stealsFocus={false} />);
    });
    expect(container.querySelector('.session-banner-dismiss')).toBeNull();
  });

  test('dismiss button renders and calls handler', () => {
    let called = 0;
    act(() => {
      root.render(
        <SessionBanner
          id="a"
          tier="info"
          title="x"
          stealsFocus={false}
          dismiss={() => {
            called++;
          }}
        />,
      );
    });
    const btn = container.querySelector('.session-banner-dismiss') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-label')).toBe('Dismiss');
    act(() => {
      btn.click();
    });
    expect(called).toBe(1);
  });

  test('actions render with primary / ghost / default classes', () => {
    act(() => {
      root.render(
        <SessionBanner
          id="a"
          tier="info"
          title="x"
          stealsFocus={false}
          actions={[
            { label: 'Primary', variant: 'primary', onClick: () => {} },
            { label: 'Ghost', variant: 'ghost', onClick: () => {} },
            { label: 'Plain', onClick: () => {} },
          ]}
        />,
      );
    });
    const btns = container.querySelectorAll('.session-banner-actions button');
    expect(btns).toHaveLength(3);
    expect(btns[0].className).toBe('primary-btn');
    expect(btns[1].className).toBe('ghost-btn');
    // No-variant button: className attribute omitted entirely.
    expect(btns[2].className).toBe('');
  });

  test('action with href renders <a> not <button>', () => {
    act(() => {
      root.render(
        <SessionBanner
          id="a"
          tier="info"
          title="x"
          stealsFocus={false}
          actions={[{ label: 'Docs', href: 'https://example.com', variant: 'ghost' }]}
        />,
      );
    });
    const anchor = container.querySelector('.session-banner-actions a') as HTMLAnchorElement;
    expect(anchor).not.toBeNull();
    expect(anchor.getAttribute('href')).toBe('https://example.com');
    expect(anchor.className).toBe('ghost-btn');
  });

  test('pending action shows spinner + is disabled', () => {
    act(() => {
      root.render(
        <SessionBanner
          id="a"
          tier="info"
          title="x"
          stealsFocus={false}
          actions={[{ label: 'Working', variant: 'primary', onClick: () => {}, pending: true }]}
        />,
      );
    });
    const btn = container.querySelector('.session-banner-actions button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.querySelector('.btn-spinner')).not.toBeNull();
  });

  test('detail renders inside collapsed <details> with detailLabel', () => {
    act(() => {
      root.render(
        <SessionBanner
          id="a"
          tier="info"
          title="x"
          stealsFocus={false}
          detailLabel="More info"
          detail={<p>extra</p>}
        />,
      );
    });
    const det = container.querySelector('.session-banner-detail') as HTMLDetailsElement;
    expect(det.tagName).toBe('DETAILS');
    expect(det.open).toBe(false);
    expect(det.querySelector('summary')?.textContent).toBe('More info');
    expect(det.textContent).toContain('extra');
  });

  test('detail uses "Details" as default summary label', () => {
    act(() => {
      root.render(
        <SessionBanner id="a" tier="info" title="x" stealsFocus={false} detail={<p>x</p>} />,
      );
    });
    expect(container.querySelector('.session-banner-detail summary')?.textContent).toBe('Details');
  });
});

describe('SessionBanner — focus-steal contract (spec §8.4)', () => {
  test('danger tier focuses primary action on first mount', async () => {
    act(() => {
      root.render(
        <SessionBanner
          id="d1"
          tier="danger"
          title="x"
          actions={[
            { label: 'Cancel', variant: 'ghost', onClick: () => {} },
            { label: 'Primary', variant: 'primary', onClick: () => {} },
          ]}
        />,
      );
    });
    // The setTimeout(0) inside the effect needs the next microtask.
    await new Promise((r) => setTimeout(r, 5));
    const primaryBtn = container.querySelectorAll('.session-banner-actions button')[1];
    expect(document.activeElement).toBe(primaryBtn);
  });

  test('danger second mount of same id does NOT steal focus', async () => {
    // First mount → steals.
    act(() => {
      root.render(
        <SessionBanner
          id="d-same"
          tier="danger"
          title="x"
          actions={[{ label: 'Go', variant: 'primary', onClick: () => {} }]}
        />,
      );
    });
    await new Promise((r) => setTimeout(r, 5));
    act(() => {
      root.unmount();
    });
    // Reset focus to a baseline.
    const other = document.createElement('button');
    other.textContent = 'baseline';
    document.body.appendChild(other);
    other.focus();
    expect(document.activeElement).toBe(other);

    // Second mount of same id → does NOT steal (sessionStorage flag set).
    const newContainer = document.createElement('div');
    document.body.appendChild(newContainer);
    const newRoot = createRoot(newContainer);
    act(() => {
      newRoot.render(
        <SessionBanner
          id="d-same"
          tier="danger"
          title="x"
          actions={[{ label: 'Go', variant: 'primary', onClick: () => {} }]}
        />,
      );
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(document.activeElement).toBe(other);
    act(() => {
      newRoot.unmount();
    });
    newContainer.remove();
    other.remove();
  });

  test('two different danger banners each steal once', async () => {
    act(() => {
      root.render(
        <>
          <SessionBanner
            id="d-A"
            tier="danger"
            title="x"
            actions={[{ label: 'A', variant: 'primary', onClick: () => {} }]}
          />
          <SessionBanner
            id="d-B"
            tier="danger"
            title="x"
            actions={[{ label: 'B', variant: 'primary', onClick: () => {} }]}
          />
        </>,
      );
    });
    await new Promise((r) => setTimeout(r, 5));
    // Both stole at mount; the later-mounted one wins activeElement.
    // (React commits in order; both setTimeouts fire; last one to focus wins.)
    // Confirm the SECOND banner stole focus by checking activeElement
    // label.
    expect((document.activeElement as HTMLElement)?.textContent).toBe('B');
  });

  test('non-danger tier does NOT steal focus by default', async () => {
    const baseline = document.createElement('button');
    document.body.appendChild(baseline);
    baseline.focus();
    act(() => {
      root.render(
        <SessionBanner
          id="warn-noselect"
          tier="warn"
          title="x"
          actions={[{ label: 'Go', variant: 'primary', onClick: () => {} }]}
        />,
      );
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(document.activeElement).toBe(baseline);
    baseline.remove();
  });

  test('explicit stealsFocus=true on warn tier DOES steal', async () => {
    act(() => {
      root.render(
        <SessionBanner
          id="warn-yes"
          tier="warn"
          title="x"
          stealsFocus={true}
          actions={[{ label: 'Go', variant: 'primary', onClick: () => {} }]}
        />,
      );
    });
    await new Promise((r) => setTimeout(r, 5));
    expect((document.activeElement as HTMLElement)?.textContent).toBe('Go');
  });

  test('explicit stealsFocus=false on danger SUPPRESSES the steal', async () => {
    const baseline = document.createElement('button');
    document.body.appendChild(baseline);
    baseline.focus();
    act(() => {
      root.render(
        <SessionBanner
          id="danger-no"
          tier="danger"
          title="x"
          stealsFocus={false}
          actions={[{ label: 'Go', variant: 'primary', onClick: () => {} }]}
        />,
      );
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(document.activeElement).toBe(baseline);
    baseline.remove();
  });

  test('danger with no actions focuses the root (tabIndex=-1)', async () => {
    act(() => {
      root.render(<SessionBanner id="d-noaction" tier="danger" title="x" />);
    });
    await new Promise((r) => setTimeout(r, 5));
    const root_ = container.querySelector('.session-banner') as HTMLElement;
    expect(root_.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(root_);
  });
});

describe('SessionBanner — migration mode (spec §8.1)', () => {
  test('default classStem emits `session-banner is-${tier}`', () => {
    act(() => {
      root.render(<SessionBanner id="a" tier="warn" title="x" stealsFocus={false} />);
    });
    const el = container.querySelector('.session-banner') as HTMLElement;
    expect(el.className).toBe('session-banner is-warn');
  });

  test('classStem="tpl-banner" + compatClass="is-warn" suppresses is-${tier}', () => {
    // The legacy DOM is `<div class="tpl-banner is-warn">`; the new code
    // must produce that exact className (no extra `is-invariant` leak).
    act(() => {
      root.render(
        <SessionBanner
          id="bypass"
          tier="invariant"
          title="x"
          glyph="⚠"
          classStem="tpl-banner"
          compatClass="is-warn"
          stealsFocus={false}
        />,
      );
    });
    const el = container.querySelector('.tpl-banner') as HTMLElement;
    expect(el.className).toBe('tpl-banner is-warn');
    expect(el.className).not.toContain('is-invariant');
  });

  test('classStem="multi-agent-warning" with no compatClass — root has only the stem class', () => {
    act(() => {
      root.render(
        <SessionBanner
          id="maw"
          tier="warn"
          classStem="multi-agent-warning"
          layout="flat"
          stealsFocus={false}
          body={<p>x</p>}
        />,
      );
    });
    const el = container.querySelector('.multi-agent-warning') as HTMLElement;
    expect(el.className).toBe('multi-agent-warning');
    expect(el.className).not.toContain('is-warn');
  });

  test('classStem swap propagates to inner element classes', () => {
    act(() => {
      root.render(
        <SessionBanner
          id="bypass"
          tier="invariant"
          title="Title"
          body={<>body</>}
          glyph="⚠"
          classStem="tpl-banner"
          compatClass="is-warn"
          stealsFocus={false}
        />,
      );
    });
    expect(container.querySelector('.tpl-banner-glyph')).not.toBeNull();
    expect(container.querySelector('.tpl-banner-text')).not.toBeNull();
    expect(container.querySelector('.tpl-banner-title')).not.toBeNull();
    expect(container.querySelector('.tpl-banner-body')).not.toBeNull();
    // No leak of the default session-banner-* class family.
    expect(container.querySelector('.session-banner-glyph')).toBeNull();
    expect(container.querySelector('.session-banner-text')).toBeNull();
  });

  test('layout="flat" omits glyph cell and -text wrapper', () => {
    act(() => {
      root.render(
        <SessionBanner
          id="maw"
          tier="warn"
          classStem="multi-agent-warning"
          layout="flat"
          stealsFocus={false}
          glyph="⚠"
          body={<p>prose</p>}
          actions={[{ label: 'Go', variant: 'primary', onClick: () => {} }]}
        />,
      );
    });
    // No glyph element even though glyph was passed (flat layout).
    expect(container.querySelector('.multi-agent-warning-glyph')).toBeNull();
    // No -text wrapper.
    expect(container.querySelector('.multi-agent-warning-text')).toBeNull();
    // Body + actions are still produced.
    expect(container.querySelector('.multi-agent-warning-body')).not.toBeNull();
    expect(container.querySelector('.multi-agent-warning-actions')).not.toBeNull();
  });

  test('layout="grid" (default) DOES emit -text wrapper + glyph cell', () => {
    act(() => {
      root.render(
        <SessionBanner id="g" tier="warn" glyph="⚠" title="t" body="b" stealsFocus={false} />,
      );
    });
    expect(container.querySelector('.session-banner-glyph')).not.toBeNull();
    expect(container.querySelector('.session-banner-text')).not.toBeNull();
  });
});
