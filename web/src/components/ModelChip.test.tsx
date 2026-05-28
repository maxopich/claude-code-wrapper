// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { ModelChip, shortModelLabel, summarizeBusModel } from './ModelChip';

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
      root.render(
        <ModelChip model="claude-sonnet-4-5-20250929" selectedModel="claude-opus-4-1" />,
      );
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

// Cluster E Phase 2.x — summarizeBusModel + 'various' rendering:
//   - undefined map → undefined (chip falls back to "default")
//   - empty map → undefined
//   - all entries equal → that string
//   - multiple distinct → 'various'
//   - empty-string entries ignored (treated as "not reported")
//   - ModelChip renders 'various' verbatim (no claude-* trimming)

describe('summarizeBusModel', () => {
  test('undefined → undefined', () => {
    expect(summarizeBusModel(undefined)).toBeUndefined();
  });

  test('empty map → undefined', () => {
    expect(summarizeBusModel({})).toBeUndefined();
  });

  test('single entry → that model', () => {
    expect(summarizeBusModel({ 1: 'claude-sonnet-4-5-20250929' })).toBe(
      'claude-sonnet-4-5-20250929',
    );
  });

  test('all entries identical → that model', () => {
    expect(
      summarizeBusModel({
        1: 'claude-sonnet-4-5-20250929',
        2: 'claude-sonnet-4-5-20250929',
        3: 'claude-sonnet-4-5-20250929',
      }),
    ).toBe('claude-sonnet-4-5-20250929');
  });

  test('mixed entries → "various"', () => {
    expect(
      summarizeBusModel({
        1: 'claude-sonnet-4-5-20250929',
        2: 'claude-opus-4-1',
      }),
    ).toBe('various');
  });

  test('empty-string values ignored', () => {
    // Only "" entries → undefined; same-model entries with stray "" → that model.
    expect(summarizeBusModel({ 1: '' })).toBeUndefined();
    expect(summarizeBusModel({ 1: 'claude-sonnet-4-5', 2: '' })).toBe('claude-sonnet-4-5');
  });
});

describe('ModelChip — multi-agent "various"', () => {
  test('renders "various" label verbatim (no claude-* trimming)', () => {
    act(() => {
      root.render(<ModelChip model="various" />);
    });
    const chip = container.querySelector('.model-chip');
    expect(chip?.textContent).toContain('various');
    // No "claude-" or date suffix would survive trimming anyway, but
    // this asserts the literal sentinel survives the shortModelLabel path.
  });

  test('tooltip carries the literal "various" + tooltipExtra explanation', () => {
    act(() => {
      root.render(
        <ModelChip
          model="various"
          tooltipExtra="Participants reported different models — open Authority to inspect per-agent."
        />,
      );
    });
    const title = container.querySelector('.model-chip')?.getAttribute('title');
    expect(title).toContain('various');
    expect(title).toContain('Authority');
  });
});
