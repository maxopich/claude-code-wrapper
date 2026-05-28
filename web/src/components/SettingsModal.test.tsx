// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { SettingsView } from '../store';
import { SettingsModal } from './SettingsModal';

// Cluster E Phase 3 (A4) — SettingsModal contract additions:
//   - Inline "(default fallback)" tag renders ONLY when workspaceRoot is
//     null AND the input value equals defaultWorkspaceRoot
//   - Tag source attribution flips with defaultWorkspaceRootSource:
//       'env'     → "default — from WORKSPACE_ROOT env"
//       'builtin' → "default — built-in ~/agents"
//       undefined → "default fallback" (older server, no attribution)
//   - Tag disappears as soon as the operator edits the input
//   - Empty-state hint (the "No workspace folder set yet" line) names the
//     resolved default path

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

function settings(over: Partial<SettingsView> = {}): SettingsView {
  return {
    workspaceRoot: null,
    workspaceRootValid: true,
    defaultWorkspaceRoot: '/home/op/agents',
    defaultHopBudget: 30,
    ...over,
  };
}

function render(settingsView: SettingsView, onSave = vi.fn(), onClose = vi.fn()) {
  act(() => {
    root.render(<SettingsModal settings={settingsView} onSave={onSave} onClose={onClose} />);
  });
}

function getFallbackTag(): HTMLElement | null {
  return document.querySelector('[data-testid="fallback-tag"]');
}

function getWorkspaceInput(): HTMLInputElement {
  return document.querySelector('input[type="text"]') as HTMLInputElement;
}

function typeInto(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('no value setter');
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('SettingsModal — fallback tag visibility', () => {
  test('renders tag when workspaceRoot is null AND input equals default', () => {
    render(settings({ workspaceRoot: null }));
    expect(getFallbackTag()).not.toBeNull();
  });

  test('does NOT render tag when workspaceRoot is already saved', () => {
    render(
      settings({
        workspaceRoot: '/some/custom/path',
      }),
    );
    expect(getFallbackTag()).toBeNull();
  });

  test('tag disappears as soon as operator edits the input', () => {
    render(settings({ workspaceRoot: null }));
    expect(getFallbackTag()).not.toBeNull();
    act(() => {
      typeInto(getWorkspaceInput(), '/new/path');
    });
    expect(getFallbackTag()).toBeNull();
  });

  test('tag reappears when operator types the default back in (defensive)', () => {
    render(settings({ workspaceRoot: null, defaultWorkspaceRoot: '/home/op/agents' }));
    expect(getFallbackTag()).not.toBeNull();
    act(() => {
      typeInto(getWorkspaceInput(), '/other');
    });
    expect(getFallbackTag()).toBeNull();
    act(() => {
      typeInto(getWorkspaceInput(), '/home/op/agents');
    });
    expect(getFallbackTag()).not.toBeNull();
  });
});

describe('SettingsModal — fallback tag source attribution', () => {
  test('source=env → "from WORKSPACE_ROOT env"', () => {
    render(settings({ defaultWorkspaceRootSource: 'env' }));
    expect(getFallbackTag()?.textContent).toContain('WORKSPACE_ROOT');
  });

  test('source=builtin → "built-in ~/agents"', () => {
    render(settings({ defaultWorkspaceRootSource: 'builtin' }));
    expect(getFallbackTag()?.textContent).toContain('built-in');
  });

  test('source undefined (older server) → neutral "default fallback"', () => {
    render(settings({ defaultWorkspaceRootSource: undefined }));
    expect(getFallbackTag()?.textContent).toContain('default fallback');
    expect(getFallbackTag()?.textContent).not.toContain('WORKSPACE_ROOT');
    expect(getFallbackTag()?.textContent).not.toContain('built-in');
  });
});

describe('SettingsModal — empty-state hint names the path', () => {
  test('hint includes defaultWorkspaceRoot as a code-styled path', () => {
    render(settings({ workspaceRoot: null, defaultWorkspaceRoot: '/home/op/agents' }));
    // The hint paragraph is the second .hint (first is the always-on "Absolute
    // or ~-prefixed path" copy). The default path renders as a <code> child.
    const paths = Array.from(document.querySelectorAll('.modal .hint code')).map(
      (e) => e.textContent,
    );
    expect(paths).toContain('/home/op/agents');
  });

  test('hint is hidden when workspaceRoot is saved', () => {
    render(settings({ workspaceRoot: '/already/set' }));
    const hintTexts = Array.from(document.querySelectorAll('.modal .hint')).map(
      (e) => e.textContent ?? '',
    );
    // None of the rendered hints mention "No workspace folder set yet".
    expect(hintTexts.some((t) => t.includes('No workspace folder set yet'))).toBe(false);
  });

  test('hint attributes the source when defaultWorkspaceRootSource = env', () => {
    render(settings({ workspaceRoot: null, defaultWorkspaceRootSource: 'env' }));
    const hintTexts = Array.from(document.querySelectorAll('.modal .hint')).map(
      (e) => e.textContent ?? '',
    );
    expect(hintTexts.some((t) => t.includes('WORKSPACE_ROOT'))).toBe(true);
  });
});

// Cluster F Phase A1b (UI-A1) — defaultMaxTurns input + save payload.
describe('SettingsModal — defaultMaxTurns', () => {
  function getMaxTurnsInput(): HTMLInputElement {
    return document.querySelector('[data-testid="default-max-turns-input"]') as HTMLInputElement;
  }

  test('seeds from settings.defaultMaxTurns when present', () => {
    render(settings({ defaultMaxTurns: 200 }));
    expect(getMaxTurnsInput().value).toBe('200');
  });

  test('falls back to built-in 50 when settings.defaultMaxTurns is absent', () => {
    // Older server didn't ship the field; modal still renders a sensible
    // seed value so the operator can save without first probing.
    render(settings({ defaultMaxTurns: undefined }));
    expect(getMaxTurnsInput().value).toBe('50');
  });

  test('onSave payload includes the parsed defaultMaxTurns', () => {
    const onSave = vi.fn();
    render(settings({ workspaceRoot: '/already/set', defaultMaxTurns: 50 }), onSave);
    act(() => {
      typeInto(getMaxTurnsInput(), '150');
    });
    act(() => {
      // Click the Save button (canSave is true because max turns changed)
      (document.querySelector('.primary-btn') as HTMLButtonElement).click();
    });
    expect(onSave).toHaveBeenCalledWith({
      workspaceRoot: '/already/set',
      defaultHopBudget: 30,
      defaultMaxTurns: 150,
    });
  });

  test('changing only defaultMaxTurns enables Save', () => {
    render(settings({ workspaceRoot: '/already/set', defaultMaxTurns: 50 }));
    const saveBtn = document.querySelector('.primary-btn') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true); // nothing changed yet
    act(() => {
      typeInto(getMaxTurnsInput(), '75');
    });
    expect(saveBtn.disabled).toBe(false);
  });

  test('Save stays disabled when max-turns input is invalid', () => {
    render(settings({ workspaceRoot: '/already/set', defaultMaxTurns: 50 }));
    act(() => {
      typeInto(getMaxTurnsInput(), '0');
    });
    const saveBtn = document.querySelector('.primary-btn') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    // Warn hint is shown explaining the failure.
    const hints = Array.from(document.querySelectorAll('.hint.warn')).map(
      (e) => e.textContent ?? '',
    );
    expect(hints.some((t) => t.includes('Max turns must be a positive integer'))).toBe(true);
  });
});
