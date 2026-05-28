// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { KickModal } from './KickModal';

// Cluster C Phase 4g3 — KickModal contract:
//   - Renders dialog scaffold (role=dialog, aria-modal=true)
//   - Reason picker exposes all 8 ControlReasonCode options
//   - Default selection is 'topology_repair'
//   - Cancel button is initially focused (no destructive default-Enter)
//   - 'other' selection requires reasonText (Kick button disabled until non-empty)
//   - Non-'other' selections allow submit without reasonText
//   - Submit invokes onSubmit with (projectId, reasonCode, reasonText|undefined, 'drain')
//     then closes the modal
//   - Cancel + Escape + backdrop click invoke onClose without onSubmit

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

type Props = React.ComponentProps<typeof KickModal>;

function render(over: Partial<Props> = {}): { onClose: () => void; onSubmit: Props['onSubmit'] } {
  const onClose = over.onClose ?? vi.fn();
  const onSubmit = (over.onSubmit ?? vi.fn()) as Props['onSubmit'];
  const { onClose: _o, onSubmit: _s, ...rest } = over;
  void _o;
  void _s;
  const props: Props = {
    projectId: 7,
    agentLabel: 'worker-a',
    ...rest,
    onClose,
    onSubmit,
  };
  act(() => {
    root.render(<KickModal {...props} />);
  });
  return { onClose, onSubmit };
}

function findReasonInput(code: string): HTMLInputElement {
  return document.querySelector(
    `.kick-modal .kick-modal-reason-input[value="${code}"]`,
  ) as HTMLInputElement;
}

function findCancelBtn(): HTMLButtonElement {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.kick-modal button')).find(
    (b) => b.textContent?.trim() === 'Cancel',
  )!;
}

function findKickBtn(): HTMLButtonElement {
  return document.querySelector('.kick-modal .gate-modal-btn-danger') as HTMLButtonElement;
}

// React tracks the previous value internally; setting `.value` directly
// then dispatching `input` no longer fires onChange. Use the prototype
// setter to invalidate the cached tracker. Pattern lifted verbatim from
// EnvInjectionGateModal.test.tsx.
function typeIntoTextarea(el: HTMLTextAreaElement, value: string) {
  const proto = HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) throw new Error('no value setter on HTMLTextAreaElement.prototype');
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('KickModal — render', () => {
  test('renders as a dialog with aria-modal=true', () => {
    render();
    const dialog = document.querySelector('.kick-modal');
    expect(dialog).not.toBeNull();
    const overlay = document.querySelector('[role="dialog"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.getAttribute('aria-modal')).toBe('true');
  });

  test('exposes all 8 ControlReasonCode options', () => {
    render();
    const codes = [
      'runaway_loop',
      'off_task',
      'cost_ceiling',
      'tool_misuse',
      'incorrect_output',
      'forensics',
      'topology_repair',
      'other',
    ];
    for (const code of codes) {
      const input = findReasonInput(code);
      expect(input, `radio for ${code}`).not.toBeNull();
    }
  });

  test('default reason is topology_repair', () => {
    render();
    const radio = findReasonInput('topology_repair');
    expect(radio.checked).toBe(true);
  });

  test('shows agent label in title and button', () => {
    render({ agentLabel: 'beta' });
    const title = document.querySelector('.gate-modal-title');
    expect(title?.textContent).toContain('beta');
    expect(findKickBtn().textContent).toContain('beta');
  });
});

describe('KickModal — initial focus', () => {
  test('Cancel button is initially focused (no destructive default-Enter)', () => {
    render();
    const cancel = findCancelBtn();
    expect(document.activeElement).toBe(cancel);
  });
});

describe('KickModal — other requires text', () => {
  test('selecting "other" with no text disables Kick button', () => {
    render();
    const otherRadio = findReasonInput('other');
    act(() => {
      otherRadio.click();
    });
    const kick = findKickBtn();
    expect(kick.disabled).toBe(true);
  });

  test('typing into the notes field enables Kick when "other" is selected', () => {
    render();
    act(() => {
      findReasonInput('other').click();
    });
    expect(findKickBtn().disabled).toBe(true);
    const textarea = document.querySelector('.kick-modal-text-input') as HTMLTextAreaElement;
    act(() => {
      typeIntoTextarea(textarea, 'leaked credential');
    });
    expect(findKickBtn().disabled).toBe(false);
  });

  test('non-"other" reasons allow submit with empty notes', () => {
    render();
    expect(findKickBtn().disabled).toBe(false);
    act(() => {
      findReasonInput('forensics').click();
    });
    expect(findKickBtn().disabled).toBe(false);
  });
});

describe('KickModal — dispatch', () => {
  test('Kick click calls onSubmit(projectId, reasonCode, undefined, "drain") then closes', () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render({ projectId: 42, onSubmit, onClose });
    // Default reason topology_repair, no notes
    act(() => {
      findKickBtn().click();
    });
    expect(onSubmit).toHaveBeenCalledWith(42, 'topology_repair', undefined, 'drain');
    expect(onClose).toHaveBeenCalled();
  });

  test('Kick with custom reason + notes passes trimmed text', () => {
    const onSubmit = vi.fn();
    render({ projectId: 9, onSubmit });
    act(() => {
      findReasonInput('tool_misuse').click();
    });
    const textarea = document.querySelector('.kick-modal-text-input') as HTMLTextAreaElement;
    act(() => {
      typeIntoTextarea(textarea, '  bypassed gate  ');
    });
    act(() => {
      findKickBtn().click();
    });
    expect(onSubmit).toHaveBeenCalledWith(9, 'tool_misuse', 'bypassed gate', 'drain');
  });

  test('Kick with "other" + text passes the text', () => {
    const onSubmit = vi.fn();
    render({ projectId: 5, onSubmit });
    act(() => {
      findReasonInput('other').click();
    });
    const textarea = document.querySelector('.kick-modal-text-input') as HTMLTextAreaElement;
    act(() => {
      typeIntoTextarea(textarea, 'specific repro');
    });
    act(() => {
      findKickBtn().click();
    });
    expect(onSubmit).toHaveBeenCalledWith(5, 'other', 'specific repro', 'drain');
  });
});

describe('KickModal — dismissal without dispatch', () => {
  test('Cancel calls onClose, not onSubmit', () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render({ onSubmit, onClose });
    act(() => {
      findCancelBtn().click();
    });
    expect(onClose).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('Escape closes the modal (via useModalKeys)', () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render({ onSubmit, onClose });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
