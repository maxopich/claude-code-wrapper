// @vitest-environment jsdom
//
// The trust-dependence is the point. `acceptEdits` means "auto-allow
// everything" on a trusted project and "auto-allow file edits, Bash still
// asks" on an untrusted one — that is `shouldAutoAllow`'s actual table, and a
// single fixed label would be wrong on one of the two. Describing a permission
// posture inaccurately is exactly the defect Cebab-ws0.14 fixed one layer down;
// re-introducing it in the label would undo that in the place the operator
// actually reads.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { PermissionModePicker, permissionModeOptions } from './PermissionModePicker';

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

const radios = () => [...container.querySelectorAll<HTMLElement>('[role="radio"]')];

describe('permissionModeOptions', () => {
  test('always offers exactly three, with "follow Trust" first and valued null', () => {
    for (const trusted of [true, false]) {
      const opts = permissionModeOptions(trusted);
      expect(opts.map((o) => o.value)).toEqual([null, 'default', 'acceptEdits']);
    }
  });

  test('the auto-allow option describes a DIFFERENT scope per trust', () => {
    const t = permissionModeOptions(true).find((o) => o.value === 'acceptEdits')!;
    const u = permissionModeOptions(false).find((o) => o.value === 'acceptEdits')!;
    // Trusted: everything. Untrusted: edits only, and Bash keeps asking.
    expect(t.label).toContain('every tool');
    expect(u.label).toContain('file edits');
    expect(u.description).toMatch(/Bash/);
    expect(t.label).not.toBe(u.label);
  });

  test('the inherit option says what Trust currently resolves to', () => {
    expect(permissionModeOptions(true)[0]!.description).toMatch(/auto-allow/i);
    expect(permissionModeOptions(false)[0]!.description).toMatch(/ask/i);
  });

  test('"ask" reads the same on both — it genuinely is the same', () => {
    // The counterweight: not every label is trust-dependent, and making them
    // all vary would be its own inaccuracy.
    const t = permissionModeOptions(true).find((o) => o.value === 'default')!;
    const u = permissionModeOptions(false).find((o) => o.value === 'default')!;
    expect(t.label).toBe(u.label);
    expect(t.description).toBe(u.description);
  });
});

describe('PermissionModePicker', () => {
  function render(value: 'default' | 'acceptEdits' | null, trusted = false) {
    const onChange = vi.fn();
    act(() => {
      root.render(<PermissionModePicker value={value} trusted={trusted} onChange={onChange} />);
    });
    return { onChange };
  }

  test('renders three radios with the stored one checked', () => {
    render('acceptEdits');
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true']);
  });

  test('choosing "follow Trust" emits null, not a mode string', () => {
    const { onChange } = render('default');
    act(() => {
      container.querySelector<HTMLElement>('[data-testid="start-mode-option-inherit"]')!.click();
    });
    // Storing 'default' here would make "chose to follow Trust" and "never
    // chose" produce different spawns on an untrusted project — and on a
    // trusted one it would silently switch the project to asking.
    expect(onChange).toHaveBeenCalledWith(null);
  });

  test('choosing a mode emits that mode', () => {
    const { onChange } = render(null);
    act(() => {
      container.querySelector<HTMLElement>('[data-testid="start-mode-option-default"]')!.click();
    });
    expect(onChange).toHaveBeenCalledWith('default');
  });

  test('a null value checks the inherit row', () => {
    render(null);
    expect(radios()[0]!.getAttribute('aria-checked')).toBe('true');
  });

  test('[a11y] the hint says what this does NOT change', () => {
    // #364 removed a tooltip claiming the permission control changes scope. A
    // new surface describing the same control is precisely where that claim
    // gets re-introduced.
    render(null);
    const text = container.textContent ?? '';
    expect(text).toContain('what asks, not what the project loads');
    expect(text).toMatch(/Trust alone decides/);
  });
});
