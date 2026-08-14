// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { MuteReasonModal } from './MuteReasonModal';

// Cluster C Phase 4g5 — MuteReasonModal contract:
//   - Single shared modal for the non-destructive verbs (mute, unmute, resume)
//   - Renders dialog scaffold (role=dialog, aria-modal=true)
//   - Reason picker exposes all 8 ControlReasonCode options
//   - Default selection is 'topology_repair' (matches C4g2 placeholder)
//   - Cancel initially focused (symmetry with KickModal)
//   - 'other' selection requires reasonText (submit disabled until non-empty)
//   - Non-'other' selections allow submit without reasonText
//   - Submit invokes onSubmit with (projectId, reasonCode, reasonText|undefined)
//     then closes the modal
//   - Title and submit button label flip with the `action` prop
//   - Cancel + Escape invoke onClose without onSubmit

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

type Props = React.ComponentProps<typeof MuteReasonModal>;

function render(over: Partial<Props> = {}): { onClose: () => void; onSubmit: Props['onSubmit'] } {
  const onClose = over.onClose ?? vi.fn();
  // Cebab-u0s: `onSubmit` reports whether the verb reached the server, and the
  // modal now closes only when it did. The default returns `true` (delivered),
  // which is the pre-existing behaviour — so every case using this default is
  // the CONTROL for the dropped-send cases that pass `() => false`.
  const onSubmit = (over.onSubmit ?? vi.fn(() => true)) as Props['onSubmit'];
  const { onClose: _o, onSubmit: _s, ...rest } = over;
  void _o;
  void _s;
  const props: Props = {
    action: 'mute',
    projectId: 7,
    agentLabel: 'worker-a',
    ...rest,
    onClose,
    onSubmit,
  };
  act(() => {
    root.render(<MuteReasonModal {...props} />);
  });
  return { onClose, onSubmit };
}

function findReasonInput(code: string): HTMLInputElement {
  return document.querySelector(
    `.mute-reason-modal .mute-reason-modal-reason-input[value="${code}"]`,
  ) as HTMLInputElement;
}

function findCancelBtn(): HTMLButtonElement {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.mute-reason-modal button')).find(
    (b) => b.textContent?.trim() === 'Cancel',
  )!;
}

function findSubmitBtn(): HTMLButtonElement {
  return document.querySelector('.mute-reason-modal .gate-modal-btn-primary') as HTMLButtonElement;
}

// Mirrors KickModal.test.tsx — React tracks the previous value internally;
// the prototype setter invalidates the cache.
function typeIntoTextarea(el: HTMLTextAreaElement, value: string) {
  const proto = HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) throw new Error('no value setter on HTMLTextAreaElement.prototype');
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('MuteReasonModal — render', () => {
  test('renders as a dialog with aria-modal=true', () => {
    render();
    const dialog = document.querySelector('.mute-reason-modal');
    expect(dialog).not.toBeNull();
    const overlay = document.querySelector('[role="dialog"]');
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
      expect(findReasonInput(code), `radio for ${code}`).not.toBeNull();
    }
  });

  test('default reason is topology_repair', () => {
    render();
    expect(findReasonInput('topology_repair').checked).toBe(true);
  });
});

describe('MuteReasonModal — action prop changes copy', () => {
  test('action=mute: title and button say Mute', () => {
    render({ action: 'mute', agentLabel: 'beta' });
    const title = document.querySelector('.gate-modal-title');
    expect(title?.textContent?.toLowerCase()).toContain('mute');
    expect(title?.textContent).toContain('beta');
    expect(findSubmitBtn().textContent).toContain('Mute');
    expect(findSubmitBtn().textContent).toContain('beta');
  });

  test('action=unmute: title and button say Unmute', () => {
    render({ action: 'unmute', agentLabel: 'gamma' });
    const title = document.querySelector('.gate-modal-title');
    expect(title?.textContent?.toLowerCase()).toContain('unmute');
    expect(findSubmitBtn().textContent).toContain('Unmute');
  });

  test('action=resume: title and button say Resume', () => {
    render({ action: 'resume', agentLabel: 'delta' });
    const title = document.querySelector('.gate-modal-title');
    expect(title?.textContent?.toLowerCase()).toContain('resume');
    expect(findSubmitBtn().textContent).toContain('Resume');
  });
});

describe('MuteReasonModal — initial focus', () => {
  test('Cancel button is initially focused', () => {
    render();
    expect(document.activeElement).toBe(findCancelBtn());
  });
});

describe('MuteReasonModal — other requires text', () => {
  test('"other" with empty notes disables submit', () => {
    render();
    act(() => {
      findReasonInput('other').click();
    });
    expect(findSubmitBtn().disabled).toBe(true);
  });

  test('typing notes enables submit when "other" is selected', () => {
    render();
    act(() => {
      findReasonInput('other').click();
    });
    expect(findSubmitBtn().disabled).toBe(true);
    const textarea = document.querySelector('.mute-reason-modal-text-input') as HTMLTextAreaElement;
    act(() => {
      typeIntoTextarea(textarea, 'lost context');
    });
    expect(findSubmitBtn().disabled).toBe(false);
  });

  test('non-"other" reasons allow submit with empty notes', () => {
    render();
    expect(findSubmitBtn().disabled).toBe(false);
    act(() => {
      findReasonInput('forensics').click();
    });
    expect(findSubmitBtn().disabled).toBe(false);
  });
});

describe('MuteReasonModal — dispatch', () => {
  test('submit calls onSubmit(projectId, reasonCode, undefined) then closes', () => {
    const onSubmit = vi.fn(() => true);
    const onClose = vi.fn();
    render({ projectId: 42, onSubmit, onClose, action: 'mute' });
    act(() => {
      findSubmitBtn().click();
    });
    expect(onSubmit).toHaveBeenCalledWith(42, 'topology_repair', undefined);
    expect(onClose).toHaveBeenCalled();
  });

  test('submit with custom reason + notes passes trimmed text', () => {
    const onSubmit = vi.fn(() => true);
    render({ projectId: 9, onSubmit, action: 'unmute' });
    act(() => {
      findReasonInput('cost_ceiling').click();
    });
    const textarea = document.querySelector('.mute-reason-modal-text-input') as HTMLTextAreaElement;
    act(() => {
      typeIntoTextarea(textarea, '  burn rate cleared  ');
    });
    act(() => {
      findSubmitBtn().click();
    });
    expect(onSubmit).toHaveBeenCalledWith(9, 'cost_ceiling', 'burn rate cleared');
  });

  test('submit with "other" + text passes the text', () => {
    const onSubmit = vi.fn(() => true);
    render({ projectId: 5, onSubmit, action: 'resume' });
    act(() => {
      findReasonInput('other').click();
    });
    const textarea = document.querySelector('.mute-reason-modal-text-input') as HTMLTextAreaElement;
    act(() => {
      typeIntoTextarea(textarea, 'operator manually verified');
    });
    act(() => {
      findSubmitBtn().click();
    });
    expect(onSubmit).toHaveBeenCalledWith(5, 'other', 'operator manually verified');
  });
});

describe('MuteReasonModal — an undelivered verb keeps the dialog (Cebab-u0s)', () => {
  test('onSubmit returning false leaves the modal open with the typed reason intact', () => {
    // The reason text is deliberately NON-EMPTY. On an empty textarea "the
    // text survived" is true however the code behaves, so the assertion would
    // pass on the broken version too — the fixture is where this kind of gate
    // usually goes vacuous.
    const onSubmit = vi.fn(() => false);
    const onClose = vi.fn();
    render({ projectId: 42, onSubmit, onClose, action: 'mute' });
    const textarea = document.querySelector('.mute-reason-modal-text-input') as HTMLTextAreaElement;
    act(() => {
      typeIntoTextarea(textarea, 'router loop, muting while I look');
    });
    act(() => {
      findSubmitBtn().click();
    });
    expect(onSubmit).toHaveBeenCalledWith(
      42,
      'topology_repair',
      'router loop, muting while I look',
    );
    // The whole point: the operator keeps the dialog and everything in it.
    expect(onClose).not.toHaveBeenCalled();
    const after = document.querySelector('.mute-reason-modal-text-input') as HTMLTextAreaElement;
    expect(after).not.toBeNull();
    expect(after.value).toBe('router loop, muting while I look');
  });

  test('a second attempt still submits — the dialog is not left inert', () => {
    // Guards the lazy fix: an early `return` that also disabled the button
    // would satisfy the case above while making the retry impossible.
    const onSubmit = vi.fn(() => false);
    render({ projectId: 7, action: 'mute', onSubmit });
    act(() => {
      findSubmitBtn().click();
    });
    act(() => {
      findSubmitBtn().click();
    });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
});

describe('MuteReasonModal — dismissal without dispatch', () => {
  test('Cancel calls onClose, not onSubmit', () => {
    const onSubmit = vi.fn(() => true);
    const onClose = vi.fn();
    render({ onSubmit, onClose });
    act(() => {
      findCancelBtn().click();
    });
    expect(onClose).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('Escape closes the modal', () => {
    const onSubmit = vi.fn(() => true);
    const onClose = vi.fn();
    render({ onSubmit, onClose });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
