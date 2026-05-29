// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ClientMsg, ServerMsg } from '@cebab/shared/protocol';
import { BusTofuModal } from './BusTofuModal';

// Cluster G Phase 4 (D6/D11) BusTofuModal tests pin the spec's UI contract:
//
//   - All three decision buttons render (Trust / Deny once / Deny & remember);
//     deliberately no fourth "Trust & pin hash" — the bus is in-process so
//     there is no binary sha to pin (unlike the MCP modal).
//   - Each click emits a `bus_trust_decision` ClientMsg with the correct
//     pendingId + projectId + decision.
//   - Default focus lands on `[Deny once]` per the destructive-modal pattern
//     (spec D6-4).
//   - `contextSessionId` shows in the body only when present (sidebar-button
//     install passes null).
//   - The role="dialog" + aria-modal="true" + aria-labelledby wiring lets
//     screen readers announce the modal on mount.

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

function mkPending(
  overrides: Partial<Extract<ServerMsg, { type: 'bus_auto_install_pending' }>> = {},
): Extract<ServerMsg, { type: 'bus_auto_install_pending' }> {
  return {
    type: 'bus_auto_install_pending',
    pendingId: 'bus-pending-1',
    projectId: 42,
    projectName: 'Charlie',
    agentName: 'charlie',
    contextSessionId: null,
    ...overrides,
  };
}

describe('BusTofuModal — render + buttons', () => {
  test('renders exactly three decision buttons (no Trust & pin)', () => {
    act(() => {
      root.render(<BusTofuModal pending={mkPending()} send={() => {}} onClose={() => {}} />);
    });
    const buttons = container.querySelectorAll('.gate-modal-buttons button');
    const labels = Array.from(buttons).map((b) => b.textContent?.trim());
    expect(labels).toEqual(['Deny once', 'Deny & remember', 'Trust']);
    expect(labels).not.toContain('Trust & pin hash');
  });

  test('title reads "Trust this bus install?"', () => {
    act(() => {
      root.render(<BusTofuModal pending={mkPending()} send={() => {}} onClose={() => {}} />);
    });
    expect(container.querySelector('.gate-modal-title')?.textContent).toBe(
      'Trust this bus install?',
    );
  });

  test('reason chip reads "first seen"', () => {
    act(() => {
      root.render(<BusTofuModal pending={mkPending()} send={() => {}} onClose={() => {}} />);
    });
    expect(container.querySelector('.gate-modal-reason')?.textContent).toBe('first seen');
  });

  test('project name + agent slug surface in the facts list', () => {
    act(() => {
      root.render(
        <BusTofuModal
          pending={mkPending({ projectName: 'Echo', agentName: 'echo-7' })}
          send={() => {}}
          onClose={() => {}}
        />,
      );
    });
    const dds = Array.from(container.querySelectorAll('.gate-modal-fact dd')).map(
      (n) => n.textContent,
    );
    expect(dds).toContain('Echo');
    expect(dds).toContain('echo-7');
  });

  test('omits contextSessionId fact when null (sidebar-button install)', () => {
    act(() => {
      root.render(
        <BusTofuModal
          pending={mkPending({ contextSessionId: null })}
          send={() => {}}
          onClose={() => {}}
        />,
      );
    });
    const dts = Array.from(container.querySelectorAll('.gate-modal-fact dt')).map(
      (n) => n.textContent,
    );
    expect(dts).not.toContain('Triggered from session');
  });

  test('renders contextSessionId fact when present (add-participant install)', () => {
    act(() => {
      root.render(
        <BusTofuModal
          pending={mkPending({ contextSessionId: 'ma-session-9' })}
          send={() => {}}
          onClose={() => {}}
        />,
      );
    });
    const dts = Array.from(container.querySelectorAll('.gate-modal-fact dt')).map(
      (n) => n.textContent,
    );
    expect(dts).toContain('Triggered from session');
    const dds = Array.from(container.querySelectorAll('.gate-modal-fact dd')).map(
      (n) => n.textContent?.trim(),
    );
    expect(dds).toContain('ma-session-9');
  });
});

describe('BusTofuModal — decision ClientMsg dispatch', () => {
  function clickButton(label: string) {
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.gate-modal-buttons button'),
    );
    const btn = buttons.find((b) => b.textContent?.trim() === label);
    if (!btn) throw new Error(`button "${label}" not found`);
    act(() => {
      btn.click();
    });
  }

  test('Trust → emits decision="trust" + onClose', () => {
    const sent: ClientMsg[] = [];
    const onClose = vi.fn();
    act(() => {
      root.render(
        <BusTofuModal
          pending={mkPending({ pendingId: 'bp-9', projectId: 17 })}
          send={(m) => sent.push(m)}
          onClose={onClose}
        />,
      );
    });
    clickButton('Trust');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'bus_trust_decision',
      pendingId: 'bp-9',
      projectId: 17,
      decision: 'trust',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('Deny once → emits decision="deny_once" + onClose', () => {
    const sent: ClientMsg[] = [];
    const onClose = vi.fn();
    act(() => {
      root.render(
        <BusTofuModal
          pending={mkPending({ pendingId: 'bp-1', projectId: 3 })}
          send={(m) => sent.push(m)}
          onClose={onClose}
        />,
      );
    });
    clickButton('Deny once');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'bus_trust_decision',
      pendingId: 'bp-1',
      projectId: 3,
      decision: 'deny_once',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('Deny & remember → emits decision="deny_remember" + onClose', () => {
    const sent: ClientMsg[] = [];
    const onClose = vi.fn();
    act(() => {
      root.render(
        <BusTofuModal
          pending={mkPending({ pendingId: 'bp-2', projectId: 99 })}
          send={(m) => sent.push(m)}
          onClose={onClose}
        />,
      );
    });
    clickButton('Deny & remember');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'bus_trust_decision',
      pendingId: 'bp-2',
      projectId: 99,
      decision: 'deny_remember',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('BusTofuModal — focus + a11y', () => {
  test('default focus lands on Deny once (destructive-modal pattern)', () => {
    act(() => {
      root.render(<BusTofuModal pending={mkPending()} send={() => {}} onClose={() => {}} />);
    });
    const denyOnce = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.gate-modal-buttons button'),
    ).find((b) => b.textContent?.trim() === 'Deny once');
    expect(document.activeElement).toBe(denyOnce);
  });

  test('dialog has role=dialog + aria-modal + aria-labelledby pointing at title', () => {
    act(() => {
      root.render(
        <BusTofuModal
          pending={mkPending({ pendingId: 'bp-x' })}
          send={() => {}}
          onClose={() => {}}
        />,
      );
    });
    const dialog = container.querySelector('.gate-modal-overlay');
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog?.getAttribute('aria-labelledby');
    expect(labelledBy).toBe('bus-tofu-title-bp-x');
    expect(container.querySelector(`#${labelledBy}`)?.textContent).toBe(
      'Trust this bus install?',
    );
  });
});

describe('BusTofuModal — Esc / backdrop close', () => {
  test('Esc invokes onClose without firing a decision', () => {
    const sent: ClientMsg[] = [];
    const onClose = vi.fn();
    act(() => {
      root.render(
        <BusTofuModal pending={mkPending()} send={(m) => sent.push(m)} onClose={onClose} />,
      );
    });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
  });
});
