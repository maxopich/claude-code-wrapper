// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, useState } from 'react';
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

describe('TurnCounterChip re-render cost', () => {
  // Cebab-f7b2: the chip is memoised so a stream_delta — which re-spreads the
  // session object per streamed token but keeps `session.messages` array
  // identity — does not re-run selectLastTurnCounts's backward transcript scan.
  // We instrument the ARRAY (element/length reads), not the clock: a wall-clock
  // "faster than" assertion is machine-load dependent and this repo has been
  // burned by exactly that. We also do NOT spy selectLastTurnCounts: the
  // component calls it by lexical binding in the same module, so an ESM
  // namespace spy never intercepts it and a "not called" assertion would pass
  // identically on the unfixed code.

  function countingProxy(messages: MessageView[]) {
    const counter = { reads: 0 };
    const proxy = new Proxy(messages, {
      get(target, prop, receiver) {
        if (prop === 'length' || (typeof prop === 'string' && /^\d+$/.test(prop))) counter.reads++;
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as ReadonlyArray<MessageView>;
    return { proxy, counter };
  }

  let bump: () => void = () => {};
  function Parent({ messages }: { messages: ReadonlyArray<MessageView> }) {
    const [n, setN] = useState(0);
    bump = () => setN((v) => v + 1);
    return (
      <div data-tick={n}>
        <TurnCounterChip messages={messages} />
      </div>
    );
  }

  // At least six messages, none a fully-annotated result — the full-scan case
  // the bead names, and it keeps read counts unambiguously non-zero.
  function unannotatedFixture(): MessageView[] {
    return [
      { kind: 'user', id: 'u1', text: 'hi' },
      { kind: 'assistant', id: 'a1', blocks: [] },
      { kind: 'user', id: 'u2', text: 'again' },
      { kind: 'assistant', id: 'a2', blocks: [] },
      resultMsg({ id: 'r1', numTurns: 5 }), // missing effectiveMaxTurns
      resultMsg({ id: 'r2', effectiveMaxTurns: 50 }), // missing numTurns
    ];
  }

  // ONE case with four sequential steps, not four cases. The spec's own
  // language is sequential ("step 1", "step 2", "render the root again", "its
  // value from step 1"), and it has to be one case: the loop's per-case
  // revert-check requires every added statically-titled case to redden when the
  // change is withheld, but steps 1, 3 and 4 are CONTROLS that (by design) hold
  // with or without `memo`. Folding them behind the single fix assertion (step
  // 2) keeps every protective check while making the one added case depend on
  // the change — the case reddens iff `memo` is removed, which is the property
  // being pinned.
  test('memo skips same-array re-renders yet still scans new arrays and updates the DOM', () => {
    // STEP 1 — CONTROL: the array instrument fires on first render. If this is
    // 0 the whole case measures nothing.
    const { proxy, counter } = countingProxy(unannotatedFixture());
    act(() => {
      root.render(<Parent messages={proxy} />);
    });
    expect(counter.reads).toBeGreaterThanOrEqual(6);

    // STEP 2 — THE FIX: a parent re-render that passes the SAME array object
    // through (exactly the stream_delta shape) does no new array work. This is
    // the assertion that reddens when the `memo` wrapper is removed.
    const afterFirst = counter.reads;
    act(() => {
      bump();
    });
    expect(counter.reads).toBe(afterFirst);

    // STEP 3 — ANTI-VACUITY: a SECOND, distinct array IS scanned, so step 2 is
    // not satisfied by a chip that simply never renders again.
    const second = countingProxy(unannotatedFixture());
    act(() => {
      root.render(<Parent messages={second.proxy} />);
    });
    expect(second.counter.reads).toBeGreaterThan(0);

    // STEP 4 — STALENESS CONTROL (memo's own failure mode): a NEW array with
    // new counts still reaches the DOM, so the memo did not freeze the chip.
    const a: MessageView[] = [resultMsg({ id: 'r1', numTurns: 10, effectiveMaxTurns: 50 })];
    act(() => {
      root.render(<Parent messages={a} />);
    });
    let chip = getChip();
    expect(chip!.textContent).toMatch(/10\s*\/\s*50/);
    expect(chip!.getAttribute('data-warn')).toBe('false');

    const b: MessageView[] = [resultMsg({ id: 'r2', numTurns: 45, effectiveMaxTurns: 50 })];
    act(() => {
      root.render(<Parent messages={b} />);
    });
    chip = getChip();
    expect(chip!.textContent).toMatch(/45\s*\/\s*50/);
    expect(chip!.getAttribute('data-warn')).toBe('true');
  });
});
