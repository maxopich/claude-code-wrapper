// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { PauseReasonModal } from './PauseReasonModal';

// Cluster C Phase 4g5 — PauseReasonModal contract:
//   - Reason picker (8 options, default topology_repair)
//   - Duration picker with presets (5m / 15m / 60m / custom)
//     default '15m', emits 15 * 60 * 1000 = 900000ms on submit
//   - Custom radio reveals minutes input; invalid value disables submit
//   - Expiry picker (auto_resume default, auto_kick alt)
//   - 'other' requires reasonText (submit disabled until non-empty)
//   - Cancel initially focused
//   - Submit calls onSubmit(projectId, reasonCode, reasonText|undefined,
//     timeoutMs, expiryAction) then closes

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

type Props = React.ComponentProps<typeof PauseReasonModal>;

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
    root.render(<PauseReasonModal {...props} />);
  });
  return { onClose, onSubmit };
}

function findReasonInput(code: string): HTMLInputElement {
  return document.querySelector(
    `.pause-reason-modal-reason-input[value="${code}"]`,
  ) as HTMLInputElement;
}
function findDurationInput(key: string): HTMLInputElement {
  return document.querySelector(
    `.pause-reason-modal-duration-input[value="${key}"]`,
  ) as HTMLInputElement;
}
function findExpiryInput(value: string): HTMLInputElement {
  return document.querySelector(
    `.pause-reason-modal-expiry-input[value="${value}"]`,
  ) as HTMLInputElement;
}
function findSubmitBtn(): HTMLButtonElement {
  return document.querySelector(
    '.pause-reason-modal .gate-modal-btn-primary',
  ) as HTMLButtonElement;
}
function findCancelBtn(): HTMLButtonElement {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('.pause-reason-modal button'),
  ).find((b) => b.textContent?.trim() === 'Cancel')!;
}
function findCustomInput(): HTMLInputElement {
  return document.querySelector(
    '.pause-reason-modal-custom-input',
  ) as HTMLInputElement;
}
function typeIntoInput(el: HTMLInputElement, value: string) {
  const proto = HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) throw new Error('no value setter on HTMLInputElement.prototype');
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function typeIntoTextarea(el: HTMLTextAreaElement, value: string) {
  const proto = HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) throw new Error('no value setter on HTMLTextAreaElement.prototype');
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('PauseReasonModal — render', () => {
  test('renders as a dialog with aria-modal=true', () => {
    render();
    expect(document.querySelector('.pause-reason-modal')).not.toBeNull();
    const overlay = document.querySelector('[role="dialog"]');
    expect(overlay?.getAttribute('aria-modal')).toBe('true');
  });

  test('exposes all 8 ControlReasonCode options and 4 duration presets', () => {
    render();
    for (const code of [
      'runaway_loop',
      'off_task',
      'cost_ceiling',
      'tool_misuse',
      'incorrect_output',
      'forensics',
      'topology_repair',
      'other',
    ]) {
      expect(findReasonInput(code), `reason ${code}`).not.toBeNull();
    }
    for (const key of ['5m', '15m', '60m', 'custom']) {
      expect(findDurationInput(key), `duration ${key}`).not.toBeNull();
    }
  });

  test('exposes both expiry options', () => {
    render();
    expect(findExpiryInput('auto_resume')).not.toBeNull();
    expect(findExpiryInput('auto_kick')).not.toBeNull();
  });

  test('defaults: reason=topology_repair, duration=15m, expiry=auto_resume', () => {
    render();
    expect(findReasonInput('topology_repair').checked).toBe(true);
    expect(findDurationInput('15m').checked).toBe(true);
    expect(findExpiryInput('auto_resume').checked).toBe(true);
  });

  test('custom-minutes input is hidden until Custom… is selected', () => {
    render();
    expect(findCustomInput()).toBeNull();
    act(() => {
      findDurationInput('custom').click();
    });
    expect(findCustomInput()).not.toBeNull();
  });
});

describe('PauseReasonModal — initial focus', () => {
  test('Cancel button is initially focused', () => {
    render();
    expect(document.activeElement).toBe(findCancelBtn());
  });
});

describe('PauseReasonModal — custom-duration validation', () => {
  test('custom out-of-range disables submit', () => {
    render();
    act(() => {
      findDurationInput('custom').click();
    });
    act(() => {
      typeIntoInput(findCustomInput(), '0');
    });
    expect(findSubmitBtn().disabled).toBe(true);
    expect(findCustomInput().getAttribute('aria-invalid')).toBe('true');
  });

  test('custom in-range enables submit and emits the right ms', () => {
    const onSubmit = vi.fn();
    render({ onSubmit });
    act(() => {
      findDurationInput('custom').click();
    });
    act(() => {
      typeIntoInput(findCustomInput(), '45');
    });
    expect(findSubmitBtn().disabled).toBe(false);
    act(() => {
      findSubmitBtn().click();
    });
    // 45 minutes * 60_000 ms/minute = 2_700_000
    expect(onSubmit).toHaveBeenCalledWith(7, 'topology_repair', undefined, 2_700_000, 'auto_resume');
  });

  test('custom > 1440 minutes (24h cap) disables submit', () => {
    render();
    act(() => {
      findDurationInput('custom').click();
    });
    act(() => {
      typeIntoInput(findCustomInput(), '1441');
    });
    expect(findSubmitBtn().disabled).toBe(true);
  });
});

describe('PauseReasonModal — other requires text', () => {
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
    const textarea = document.querySelector(
      '.pause-reason-modal-text-input',
    ) as HTMLTextAreaElement;
    act(() => {
      typeIntoTextarea(textarea, 'mid-review pause');
    });
    expect(findSubmitBtn().disabled).toBe(false);
  });
});

describe('PauseReasonModal — dispatch', () => {
  test('default submit: 15m / topology_repair / auto_resume', () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render({ projectId: 42, onSubmit, onClose });
    act(() => {
      findSubmitBtn().click();
    });
    expect(onSubmit).toHaveBeenCalledWith(
      42,
      'topology_repair',
      undefined,
      15 * 60 * 1000,
      'auto_resume',
    );
    expect(onClose).toHaveBeenCalled();
  });

  test('switching duration to 5m emits 300000ms', () => {
    const onSubmit = vi.fn();
    render({ onSubmit });
    act(() => {
      findDurationInput('5m').click();
    });
    act(() => {
      findSubmitBtn().click();
    });
    expect(onSubmit).toHaveBeenCalledWith(7, 'topology_repair', undefined, 300_000, 'auto_resume');
  });

  test('switching expiry to auto_kick is reflected in dispatch', () => {
    const onSubmit = vi.fn();
    render({ onSubmit });
    act(() => {
      findExpiryInput('auto_kick').click();
    });
    act(() => {
      findReasonInput('tool_misuse').click();
    });
    act(() => {
      findSubmitBtn().click();
    });
    expect(onSubmit).toHaveBeenCalledWith(
      7,
      'tool_misuse',
      undefined,
      15 * 60 * 1000,
      'auto_kick',
    );
  });

  test('trims notes and forwards text', () => {
    const onSubmit = vi.fn();
    render({ onSubmit });
    act(() => {
      findReasonInput('forensics').click();
    });
    const textarea = document.querySelector(
      '.pause-reason-modal-text-input',
    ) as HTMLTextAreaElement;
    act(() => {
      typeIntoTextarea(textarea, '  freezing for diff review  ');
    });
    act(() => {
      findSubmitBtn().click();
    });
    expect(onSubmit).toHaveBeenCalledWith(
      7,
      'forensics',
      'freezing for diff review',
      15 * 60 * 1000,
      'auto_resume',
    );
  });
});

describe('PauseReasonModal — dismissal', () => {
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

  test('Escape closes the modal', () => {
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
