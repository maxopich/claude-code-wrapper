// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { ModelChip, shortModelLabel } from './ModelChip';

// Cluster E Phase 2 (B4) — ModelChip contract:
//   - Renders the model identifier in chip form
//   - Shows "default" when model is undefined/null/empty (B4-3: never blank)
//   - shortModelLabel collapses common claude-* shapes into friendly labels
//   - tooltip title carries the full model id (for hover discovery)
//   - is-warn variant + warn icon when selectedModel differs from model
//   - aria-label communicates the model name (and anomaly when present)

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

describe('shortModelLabel', () => {
  test('undefined → "default"', () => {
    expect(shortModelLabel(undefined)).toBe('default');
  });

  test('empty string → "default"', () => {
    expect(shortModelLabel('')).toBe('default');
  });

  test('claude-sonnet-4-5-20250929 → "sonnet 4-5"', () => {
    expect(shortModelLabel('claude-sonnet-4-5-20250929')).toBe('sonnet 4-5');
  });

  test('claude-opus-4-1-20251001 → "opus 4-1"', () => {
    expect(shortModelLabel('claude-opus-4-1-20251001')).toBe('opus 4-1');
  });

  test('claude-haiku-4-5 (no date) → "haiku 4-5"', () => {
    expect(shortModelLabel('claude-haiku-4-5')).toBe('haiku 4-5');
  });

  test('unrecognized shape splits on first dash', () => {
    // No `claude-` prefix, no trailing date — first dash becomes a
    // space (family-vs-rest split), remaining dashes stay.
    expect(shortModelLabel('some-other-id')).toBe('some other-id');
  });

  test('alias-style without prefix', () => {
    expect(shortModelLabel('sonnet-latest')).toBe('sonnet latest');
  });

  test('single-token model passes through', () => {
    expect(shortModelLabel('custom')).toBe('custom');
  });
});

describe('ModelChip — render', () => {
  test('renders chip with model: <short>', () => {
    act(() => {
      root.render(<ModelChip model="claude-sonnet-4-5-20250929" />);
    });
    const chip = container.querySelector('.model-chip');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('model:');
    expect(chip?.textContent).toContain('sonnet 4-5');
  });

  test('B4-3: renders "model: default" when model is undefined', () => {
    act(() => {
      root.render(<ModelChip />);
    });
    const chip = container.querySelector('.model-chip');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('default');
  });

  test('tooltip title carries the full model id', () => {
    act(() => {
      root.render(<ModelChip model="claude-opus-4-1-20251001" />);
    });
    const title = container.querySelector('.model-chip')?.getAttribute('title');
    expect(title).toContain('claude-opus-4-1-20251001');
  });

  test('tooltip indicates "not yet reported" when undefined', () => {
    act(() => {
      root.render(<ModelChip />);
    });
    const title = container.querySelector('.model-chip')?.getAttribute('title');
    expect(title).toContain('not yet reported');
  });

  test('aria-label includes the model name', () => {
    act(() => {
      root.render(<ModelChip model="claude-sonnet-4-5-20250929" />);
    });
    const label = container.querySelector('.model-chip')?.getAttribute('aria-label');
    expect(label).toContain('claude-sonnet-4-5-20250929');
  });
});

describe('ModelChip — anomaly variant (B4-5)', () => {
  test('selectedModel matches model: no warn variant', () => {
    act(() => {
      root.render(
        <ModelChip model="claude-sonnet-4-5-20250929" selectedModel="claude-sonnet-4-5-20250929" />,
      );
    });
    const chip = container.querySelector('.model-chip');
    expect(chip?.classList.contains('is-warn')).toBe(false);
    expect(container.querySelector('.model-chip-warn-icon')).toBeNull();
  });

  test('selectedModel differs from model: warn variant + icon + anomaly tooltip', () => {
    act(() => {
      root.render(<ModelChip model="claude-sonnet-4-5-20250929" selectedModel="claude-opus-4-1" />);
    });
    const chip = container.querySelector('.model-chip');
    expect(chip?.classList.contains('is-warn')).toBe(true);
    expect(container.querySelector('.model-chip-warn-icon')).not.toBeNull();
    const title = chip?.getAttribute('title');
    expect(title).toContain('claude-opus-4-1');
    expect(title).toContain('Selected');
  });

  test('selectedModel without model: no warn (need both to compare)', () => {
    act(() => {
      root.render(<ModelChip selectedModel="claude-opus-4-1" />);
    });
    const chip = container.querySelector('.model-chip');
    expect(chip?.classList.contains('is-warn')).toBe(false);
  });
});

describe('ModelChip — tooltipExtra', () => {
  test('tooltipExtra appended to title', () => {
    act(() => {
      root.render(
        <ModelChip model="claude-sonnet-4-5-20250929" tooltipExtra="Provider: subscription" />,
      );
    });
    const title = container.querySelector('.model-chip')?.getAttribute('title');
    expect(title).toContain('Provider: subscription');
  });
});

// Register W13 — what used to be here, and why it isn't.
//
// This block tested `summarizeBusModel`, which folded a bus run's
// per-participant models into one label for the `TopRunBar` chip, plus the
// `'various'` sentinel it returned when participants disagreed. Every case
// passed. None could happen: the map it summarized was filled only from
// `session_started`, and `translate()` — the sole producer of that message —
// is called only on the single-agent turn path, never by `server/src/bus/`.
// So the map was always `{}`, the summary always `undefined`, and the chip
// always read `model: default`.
//
// Kept as a note rather than deleted outright: a green suite for a function
// that could not fire is the useful part of the record, and the next person
// to wire a bus model signal should know these cases existed and were right
// about everything except whether the input arrives.
//
// The one behaviour worth keeping is below. `shortModelLabel` had an explicit
// `'various'` special case, and it was redundant — the general path returns
// any dash-free, prefix-free string unchanged. That is asserted directly now,
// so removing the guard cannot quietly change what an unrecognised short
// alias renders as.

describe('shortModelLabel — unrecognised short aliases pass through', () => {
  test.each(['various', 'sonnet', 'my-local-alias', 'gpt5'])('%s renders verbatim', (alias) => {
    expect(shortModelLabel(alias)).toBe(alias.replace(/-/, ' '));
  });

  test('the removed "various" guard was a no-op', () => {
    // Pins the specific equivalence W13 relied on when deleting the branch:
    // no `claude-` prefix, no trailing -YYYYMMDD, no dash to split on.
    expect(shortModelLabel('various')).toBe('various');
  });

  test('ModelChip still renders such a label verbatim', () => {
    act(() => {
      root.render(<ModelChip model="various" />);
    });
    expect(container.querySelector('.model-chip')?.textContent).toContain('various');
  });

  test('tooltipExtra still reaches the title attribute', () => {
    // W13 removed this prop's only production caller (the TopRunBar chip's
    // "participants reported different models" tooltip). The prop stays, so
    // its behaviour stays asserted.
    act(() => {
      root.render(<ModelChip model="various" tooltipExtra="Extra context here." />);
    });
    const title = container.querySelector('.model-chip')?.getAttribute('title');
    expect(title).toContain('various');
    expect(title).toContain('Extra context here.');
  });
});
