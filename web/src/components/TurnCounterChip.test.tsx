// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { MessageView } from '../store';
import { TurnCounterChip, selectLastTurnCounts } from './TurnCounterChip';

// Cluster F Phase A1b — covers the chip's render + the helper that scans
// for the most recent annotated result.

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

function resultMsg(partial: Partial<Extract<MessageView, { kind: 'result' }>>): MessageView {
  return {
    kind: 'result',
    id: 'm1',
    subtype: 'success',
    cost: 0,
    ...partial,
  };
}

function renderChip(messages: MessageView[]) {
  act(() => {
    root.render(<TurnCounterChip messages={messages} />);
  });
}

function getChip(): HTMLElement | null {
  return container.querySelector('[data-testid="turn-counter-chip"]');
}

describe('selectLastTurnCounts', () => {
  test('returns null on empty messages', () => {
    expect(selectLastTurnCounts([])).toBe(null);
  });

  test('returns null when no result message has both fields', () => {
    const messages: MessageView[] = [
      { kind: 'user', id: 'u', text: 'hi' },
      resultMsg({ numTurns: 5 }), // missing effectiveMaxTurns
      resultMsg({ effectiveMaxTurns: 50 }), // missing numTurns
    ];
    expect(selectLastTurnCounts(messages)).toBe(null);
  });

  test('returns the most recent fully-annotated result', () => {
    const messages: MessageView[] = [
      resultMsg({ id: 'r1', numTurns: 10, effectiveMaxTurns: 50 }),
      { kind: 'user', id: 'u', text: 'hi' },
      resultMsg({ id: 'r2', numTurns: 42, effectiveMaxTurns: 50 }),
    ];
    expect(selectLastTurnCounts(messages)).toEqual({ numTurns: 42, effectiveMaxTurns: 50 });
  });

  test('skips zero-cap results to avoid division-by-zero', () => {
    const messages: MessageView[] = [
      resultMsg({ id: 'r1', numTurns: 10, effectiveMaxTurns: 50 }),
      resultMsg({ id: 'r2', numTurns: 0, effectiveMaxTurns: 0 }),
    ];
    expect(selectLastTurnCounts(messages)).toEqual({ numTurns: 10, effectiveMaxTurns: 50 });
  });

  test('ignores non-result messages', () => {
    const messages: MessageView[] = [
      { kind: 'user', id: 'u', text: 'hi' },
      { kind: 'assistant', id: 'a', blocks: [] },
    ];
    expect(selectLastTurnCounts(messages)).toBe(null);
  });
});

describe('TurnCounterChip render', () => {
  test('renders nothing when no annotated result is present', () => {
    renderChip([]);
    expect(getChip()).toBe(null);
  });

  test('renders "N / M" for a normal turn', () => {
    renderChip([resultMsg({ numTurns: 10, effectiveMaxTurns: 50 })]);
    const chip = getChip();
    expect(chip).not.toBe(null);
    expect(chip!.textContent).toMatch(/10\s*\/\s*50/);
    expect(chip!.getAttribute('data-warn')).toBe('false');
    expect(chip!.className).not.toContain('is-warn');
  });

  test('renders with warn styling at exactly 80% of the cap', () => {
    renderChip([resultMsg({ numTurns: 40, effectiveMaxTurns: 50 })]);
    const chip = getChip();
    expect(chip!.getAttribute('data-warn')).toBe('true');
    expect(chip!.className).toContain('is-warn');
  });

  test('renders with warn styling above 80%', () => {
    renderChip([resultMsg({ numTurns: 45, effectiveMaxTurns: 50 })]);
    expect(getChip()!.getAttribute('data-warn')).toBe('true');
  });

  test('stays non-warn below 80%', () => {
    renderChip([resultMsg({ numTurns: 39, effectiveMaxTurns: 50 })]);
    expect(getChip()!.getAttribute('data-warn')).toBe('false');
  });

  test('warn tooltip mentions the 80% threshold', () => {
    renderChip([resultMsg({ numTurns: 40, effectiveMaxTurns: 50 })]);
    expect(getChip()!.getAttribute('title')).toContain('80%');
  });
});
