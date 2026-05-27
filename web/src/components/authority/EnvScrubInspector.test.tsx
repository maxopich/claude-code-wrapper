// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { EnvInjection } from '@cebab/shared/protocol';
import { EnvScrubInspector } from './EnvScrubInspector';

// Cluster B Phase 6c — UI-B14 / B20 / B21 + BE-B12 [security]:
// EnvScrubInspector contract.
//
// Tests:
//   - empty: shows the explainer about what subscriptionOnlyEnv() strips
//   - non-empty: inline warn banner + per-scope group rendering
//   - injection rows show key + posture + isSet (NEVER values)
//   - isSet=true gets the err-tinted badge; isSet=false gets muted
//   - groups sort project → local → user (project-tier prominent first)
//   - BE-B12: no env values in DOM even with hostile posture text

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

function mk(over: Partial<EnvInjection> = {}): EnvInjection {
  return {
    envKey: 'ANTHROPIC_API_KEY',
    scope: 'project',
    scopePath: '/u/p/.claude/settings.json',
    posture: 'subscription auth bypass',
    isSet: true,
    ...over,
  };
}

describe('EnvScrubInspector', () => {
  test('empty state shows the subscription-only explainer', () => {
    act(() => {
      root.render(<EnvScrubInspector injections={[]} />);
    });
    expect(container.querySelector('.env-scrub-empty')).not.toBeNull();
    const text = container.textContent ?? '';
    expect(text).toContain('No credential-class');
    expect(text).toContain('ANTHROPIC_API_KEY');
    expect(text).toContain('subscription');
  });

  test('non-empty: inline warn banner shows the count', () => {
    act(() => {
      root.render(<EnvScrubInspector injections={[mk(), mk({ envKey: 'OTHER_KEY' })]} />);
    });
    const banner = container.querySelector('.env-scrub-banner');
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute('role')).toBe('alert');
    expect(banner?.textContent).toContain('2');
    expect(banner?.textContent).toContain('credential-class env var');
  });

  test('per-scope group with path + count + rows', () => {
    act(() => {
      root.render(
        <EnvScrubInspector
          injections={[
            mk({ envKey: 'A', scope: 'project', scopePath: '/p1.json' }),
            mk({ envKey: 'B', scope: 'project', scopePath: '/p1.json' }),
            mk({ envKey: 'C', scope: 'local', scopePath: '/p2.json' }),
          ]}
        />,
      );
    });
    const groups = container.querySelectorAll('.env-scrub-scope');
    // Project + local = 2 groups.
    expect(groups.length).toBe(2);
    const projectGroup = container.querySelector('.env-scrub-scope-project')!;
    expect(projectGroup.querySelector('.env-scrub-scope-path')?.textContent).toContain('/p1.json');
    expect(projectGroup.querySelector('.env-scrub-scope-count')?.textContent).toContain('2 keys');
  });

  test('row: key + posture + isSet badge', () => {
    act(() => {
      root.render(
        <EnvScrubInspector
          injections={[mk({ envKey: 'GIT_TOKEN', posture: 'paid billing route', isSet: true })]}
        />,
      );
    });
    const row = container.querySelector('.env-injection-row')!;
    expect(row.querySelector('.env-injection-key')?.textContent).toBe('GIT_TOKEN');
    expect(row.querySelector('.env-injection-posture')?.textContent).toBe('paid billing route');
    const setBadge = row.querySelector('.env-injection-set');
    expect(setBadge?.className).toContain('env-injection-set-yes');
    expect(setBadge?.textContent).toBe('set');
  });

  test('isSet=false shows muted "unset" badge', () => {
    act(() => {
      root.render(<EnvScrubInspector injections={[mk({ isSet: false })]} />);
    });
    const setBadge = container.querySelector('.env-injection-set');
    expect(setBadge?.className).toContain('env-injection-set-no');
    expect(setBadge?.textContent).toBe('unset');
  });

  test('scope order: project → local → user', () => {
    act(() => {
      root.render(
        <EnvScrubInspector
          injections={[
            mk({ envKey: 'U1', scope: 'user' }),
            mk({ envKey: 'L1', scope: 'local' }),
            mk({ envKey: 'P1', scope: 'project' }),
          ]}
        />,
      );
    });
    const chips = Array.from(container.querySelectorAll('.env-injection-scope-chip')).map(
      (c) => c.textContent,
    );
    expect(chips).toEqual(['project', 'local', 'user']);
  });

  test('[security] BE-B12: NEVER renders an env value', () => {
    act(() => {
      root.render(
        <EnvScrubInspector
          injections={[
            mk({
              envKey: 'ANTHROPIC_API_KEY',
              posture: 'subscription auth bypass',
              isSet: true,
            }),
          ]}
        />,
      );
    });
    // Defensive: even if a future contributor added a value to the wire
    // shape, no value-looking pattern should ever show in the DOM here.
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
    expect(text).not.toMatch(/[A-Za-z0-9]{32,}/);
  });
});
