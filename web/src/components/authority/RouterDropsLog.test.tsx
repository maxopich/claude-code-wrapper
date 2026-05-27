// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { RouterDropView } from '../../store';
import { RouterDropsLog } from './RouterDropsLog';

// Cluster B Phase 6d — UI-B27: RouterDropsLog contract.
//
// Tests:
//   - empty state copy
//   - row has ts + source → dest + reason chip + expand glyph
//   - reason chip tint: forged_source → danger; others → warn
//   - newest-first ordering
//   - clicking summary toggles aria-expanded + reveals detail dl
//   - detail dl shows kind + reasonCode + auditRowId + source/dest

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

function mk(over: Partial<RouterDropView> = {}): RouterDropView {
  return {
    auditRowId: 'audit-1',
    reasonCode: 'forged_source',
    source: 'workerA',
    destination: 'orchestrator',
    kind: 'reply',
    receivedAt: Date.now(),
    ...over,
  };
}

describe('RouterDropsLog', () => {
  test('empty state copy', () => {
    act(() => {
      root.render(<RouterDropsLog drops={[]} />);
    });
    expect(container.querySelector('.router-drops-log-empty')).not.toBeNull();
  });

  test('row carries ts + source → dest + reason chip', () => {
    act(() => {
      root.render(
        <RouterDropsLog
          drops={[mk({ source: 'wA', destination: 'orch', reasonCode: 'worker_to_user' })]}
        />,
      );
    });
    const row = container.querySelector('.router-drops-row')!;
    expect(row.querySelector('.router-drops-row-ts')).not.toBeNull();
    expect(row.querySelector('.router-drops-row-source')?.textContent).toBe('wA');
    expect(row.querySelector('.router-drops-row-dest')?.textContent).toBe('orch');
    const chip = row.querySelector('.router-drops-reason-chip');
    expect(chip?.textContent).toContain('worker → user');
    expect(chip?.className).toContain('router-drops-reason-warn');
  });

  test('forged_source gets danger reason tint', () => {
    act(() => {
      root.render(<RouterDropsLog drops={[mk({ reasonCode: 'forged_source' })]} />);
    });
    const chip = container.querySelector('.router-drops-reason-chip');
    expect(chip?.className).toContain('router-drops-reason-danger');
    expect(chip?.textContent).toContain('forged source');
  });

  test('newest-first ordering', () => {
    const t = Date.now();
    act(() => {
      root.render(
        <RouterDropsLog
          drops={[
            mk({ auditRowId: 'old', receivedAt: t - 10_000, source: 'old' }),
            mk({ auditRowId: 'new', receivedAt: t, source: 'new' }),
          ]}
        />,
      );
    });
    const sources = Array.from(
      container.querySelectorAll<HTMLElement>('.router-drops-row-source'),
    ).map((el) => el.textContent);
    expect(sources).toEqual(['new', 'old']);
  });

  test('clicking summary toggles aria-expanded + reveals detail dl', () => {
    act(() => {
      root.render(<RouterDropsLog drops={[mk()]} />);
    });
    const summary = container.querySelector('.router-drops-row-summary') as HTMLButtonElement;
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.router-drops-row-detail')).toBeNull();
    act(() => {
      summary.click();
    });
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.router-drops-row-detail')).not.toBeNull();
  });

  test('detail dl shows kind + reasonCode + auditRowId + source/dest', () => {
    act(() => {
      root.render(
        <RouterDropsLog
          drops={[
            mk({
              kind: 'reply',
              reasonCode: 'unknown_source',
              auditRowId: 'audit-xyz',
              source: 'workerZ',
              destination: 'orchestrator',
            }),
          ]}
        />,
      );
    });
    const summary = container.querySelector('.router-drops-row-summary') as HTMLButtonElement;
    act(() => {
      summary.click();
    });
    const detail = container.querySelector('.router-drops-row-detail')!;
    expect(detail.textContent).toContain('reply');
    expect(detail.textContent).toContain('unknown_source');
    expect(detail.textContent).toContain('audit-xyz');
    expect(detail.textContent).toContain('workerZ');
    expect(detail.textContent).toContain('orchestrator');
  });
});
