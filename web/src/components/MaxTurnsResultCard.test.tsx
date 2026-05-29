// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { MessageView } from '../store';
import { EXTENSION_SOFT_CAP, MaxTurnsResultCard } from './MaxTurnsResultCard';

// Cluster F Phase A1b — covers the dedicated result card for error_max_turns.
// Validates render + Extend button targets + onEnd + soft-cap warning.

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
});

function maxTurnsMsg(
  partial: Partial<Extract<MessageView, { kind: 'result' }>> = {},
): Extract<MessageView, { kind: 'result' }> {
  return {
    kind: 'result',
    id: 'r1',
    subtype: 'error_max_turns',
    cost: 0.0123,
    numTurns: 50,
    effectiveMaxTurns: 50,
    ...partial,
  };
}

type CardProps = React.ComponentProps<typeof MaxTurnsResultCard>;
function renderCard(over: Partial<CardProps> = {}) {
  const onExtend = (over.onExtend ?? vi.fn()) as CardProps['onExtend'];
  const onEnd = (over.onEnd ?? vi.fn()) as CardProps['onEnd'];
  const { onExtend: _e, onEnd: _o, message, extensionsUsed, ...rest } = over;
  void _e;
  void _o;
  void rest;
  act(() => {
    root.render(
      <MaxTurnsResultCard
        message={message ?? maxTurnsMsg()}
        extensionsUsed={extensionsUsed ?? 0}
        onExtend={onExtend}
        onEnd={onEnd}
      />,
    );
  });
  return { onExtend, onEnd };
}

function $(selector: string): HTMLElement | null {
  return container.querySelector(selector);
}

describe('MaxTurnsResultCard', () => {
  test('renders the body copy naming numTurns + effectiveMaxTurns', () => {
    renderCard();
    expect($('[data-testid="max-turns-result-card"]')).not.toBe(null);
    expect(container.textContent).toMatch(/50 of 50 max turns/);
  });

  test('falls back to generic copy when annotations are missing', () => {
    renderCard({
      message: maxTurnsMsg({ numTurns: undefined, effectiveMaxTurns: undefined }),
    });
    expect(container.textContent).toMatch(/max-turns cap was reached/);
  });

  test('Extend +25 / +50 buttons render with computed targets', () => {
    renderCard({ message: maxTurnsMsg({ effectiveMaxTurns: 50 }) });
    const ext25 = $('[data-testid="max-turns-extend-25"]') as HTMLButtonElement;
    const ext50 = $('[data-testid="max-turns-extend-50"]') as HTMLButtonElement;
    expect(ext25.textContent).toContain('Extend +25');
    expect(ext25.textContent).toMatch(/→\s*75/);
    expect(ext50.textContent).toContain('Extend +50');
    expect(ext50.textContent).toMatch(/→\s*100/);
  });

  test('Extend button click fires onExtend with the bump value', () => {
    const { onExtend } = renderCard();
    act(() => {
      ($('[data-testid="max-turns-extend-25"]') as HTMLButtonElement).click();
    });
    expect(onExtend).toHaveBeenCalledWith(25);
    act(() => {
      ($('[data-testid="max-turns-extend-50"]') as HTMLButtonElement).click();
    });
    expect(onExtend).toHaveBeenCalledWith(50);
  });

  test('End session button fires onEnd', () => {
    const { onEnd } = renderCard();
    act(() => {
      ($('[data-testid="max-turns-end-session"]') as HTMLButtonElement).click();
    });
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  test('hides the soft-cap warning when below the threshold', () => {
    renderCard({ extensionsUsed: EXTENSION_SOFT_CAP - 1 });
    expect($('[data-testid="max-turns-soft-cap-warning"]')).toBe(null);
  });

  test('shows the soft-cap warning at the threshold', () => {
    renderCard({ extensionsUsed: EXTENSION_SOFT_CAP });
    const warning = $('[data-testid="max-turns-soft-cap-warning"]');
    expect(warning).not.toBe(null);
    expect(warning!.textContent).toContain(`${EXTENSION_SOFT_CAP}×`);
  });

  test('renders errors[] when present', () => {
    renderCard({ message: maxTurnsMsg({ errors: ['halt: out of turns'] }) });
    expect(container.textContent).toContain('halt: out of turns');
  });
});
