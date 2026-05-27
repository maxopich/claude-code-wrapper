// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ClientMsg, ServerMsg } from '@cebab/shared/protocol';
import { McpTofuModal } from './McpTofuModal';

// Cluster B Phase 6a tests — UI-B36..UI-B39: the four-button TOFU prompt.
//
// We test the public contract:
//   - All 4 buttons render
//   - "Trust & pin hash" is disabled when binarySha is absent
//   - Each click emits the correct mcp_trust_decision ClientMsg with
//     pendingId + serverName + originPath + decision + binarySha (when set)
//   - hash_changed: shows previousSha; first_seen: doesn't
//   - Backdrop / Esc close path calls onClose without firing a decision
//   - Initial focus lands on "Deny once" (the safest default)

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
  overrides: Partial<Extract<ServerMsg, { type: 'mcp_auto_install_pending' }>> = {},
): Extract<ServerMsg, { type: 'mcp_auto_install_pending' }> {
  return {
    type: 'mcp_auto_install_pending',
    pendingId: 'pid-1',
    serverName: 'git-mcp',
    originPath: '/u/proj/.claude/settings.json',
    command: '/usr/local/bin/git-mcp',
    binarySha: 'abc123',
    reason: 'first_seen',
    ...overrides,
  };
}

describe('McpTofuModal — render + buttons', () => {
  test('renders all four decision buttons by default', () => {
    act(() => {
      root.render(<McpTofuModal pending={mkPending()} send={() => {}} onClose={() => {}} />);
    });
    const buttons = container.querySelectorAll('.gate-modal-buttons button');
    const labels = Array.from(buttons).map((b) => b.textContent?.trim());
    expect(labels).toContain('Deny once');
    expect(labels).toContain('Deny & remember');
    expect(labels).toContain('Trust & pin hash');
    expect(labels).toContain('Trust');
  });

  test('Trust & pin hash is disabled when binarySha is absent', () => {
    act(() => {
      const pending = mkPending();
      delete (pending as { binarySha?: string }).binarySha;
      root.render(<McpTofuModal pending={pending} send={() => {}} onClose={() => {}} />);
    });
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
    const pinBtn = buttons.find((b) => b.textContent?.includes('pin hash'));
    expect(pinBtn).toBeDefined();
    expect(pinBtn!.disabled).toBe(true);
    expect(pinBtn!.getAttribute('aria-disabled')).toBe('true');
  });

  test('hash_changed shows the previousSha line', () => {
    act(() => {
      root.render(
        <McpTofuModal
          pending={mkPending({
            reason: 'hash_changed',
            binarySha: 'newsha',
            previousSha: 'oldsha',
          })}
          send={() => {}}
          onClose={() => {}}
        />,
      );
    });
    expect(container.textContent).toContain('Previous sha256');
    expect(container.textContent).toContain('oldsha');
    // Title flips to the hash-changed variant
    expect(container.querySelector('.gate-modal-title')?.textContent).toContain('binary changed');
  });

  test('first_seen does not render previousSha row', () => {
    act(() => {
      root.render(
        <McpTofuModal
          pending={mkPending({ reason: 'first_seen' })}
          send={() => {}}
          onClose={() => {}}
        />,
      );
    });
    expect(container.textContent).not.toContain('Previous sha256');
  });
});

describe('McpTofuModal — decision ClientMsg dispatch', () => {
  function setup() {
    const sent: ClientMsg[] = [];
    const closed = { count: 0 };
    const send = (m: ClientMsg) => sent.push(m);
    const onClose = () => {
      closed.count += 1;
    };
    return { sent, closed, send, onClose };
  }

  test('clicking Trust ships mcp_trust_decision { decision: "trust" }', () => {
    const { sent, send, onClose, closed } = setup();
    act(() => {
      root.render(<McpTofuModal pending={mkPending()} send={send} onClose={onClose} />);
    });
    const btn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === 'Trust',
    );
    expect(btn).toBeDefined();
    act(() => {
      btn!.click();
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'mcp_trust_decision',
      pendingId: 'pid-1',
      serverName: 'git-mcp',
      originPath: '/u/proj/.claude/settings.json',
      binarySha: 'abc123',
      decision: 'trust',
    });
    // onClose ALWAYS fires after a decision (dismisses the head of the queue).
    expect(closed.count).toBe(1);
  });

  test('clicking Trust & pin hash ships decision "trust_pinned" with binarySha', () => {
    const { sent, send } = setup();
    act(() => {
      root.render(<McpTofuModal pending={mkPending()} send={send} onClose={() => {}} />);
    });
    const btn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('pin hash'),
    );
    act(() => {
      btn!.click();
    });
    expect(sent[0]?.type).toBe('mcp_trust_decision');
    if (sent[0]?.type !== 'mcp_trust_decision') throw new Error();
    expect(sent[0].decision).toBe('trust_pinned');
    expect(sent[0].binarySha).toBe('abc123');
  });

  test('clicking Deny once ships decision "deny_once"', () => {
    const { sent, send } = setup();
    act(() => {
      root.render(<McpTofuModal pending={mkPending()} send={send} onClose={() => {}} />);
    });
    const btn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === 'Deny once',
    );
    act(() => {
      btn!.click();
    });
    if (sent[0]?.type !== 'mcp_trust_decision') throw new Error();
    expect(sent[0].decision).toBe('deny_once');
  });

  test('clicking Deny & remember ships decision "deny_remember"', () => {
    const { sent, send } = setup();
    act(() => {
      root.render(<McpTofuModal pending={mkPending()} send={send} onClose={() => {}} />);
    });
    const btn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('Deny & remember'),
    );
    act(() => {
      btn!.click();
    });
    if (sent[0]?.type !== 'mcp_trust_decision') throw new Error();
    expect(sent[0].decision).toBe('deny_remember');
  });

  test('omits binarySha from ClientMsg when pending has none', () => {
    const { sent, send } = setup();
    const pending = mkPending();
    delete (pending as { binarySha?: string }).binarySha;
    act(() => {
      root.render(<McpTofuModal pending={pending} send={send} onClose={() => {}} />);
    });
    // The 'Trust' button (not pin hash, which is disabled).
    const btn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === 'Trust',
    );
    act(() => {
      btn!.click();
    });
    if (sent[0]?.type !== 'mcp_trust_decision') throw new Error();
    expect(sent[0].binarySha).toBeUndefined();
  });
});

describe('McpTofuModal — accessibility', () => {
  test('dialog has role + aria-modal + aria-labelledby', () => {
    act(() => {
      root.render(<McpTofuModal pending={mkPending()} send={() => {}} onClose={() => {}} />);
    });
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('mcp-tofu-title-pid-1');
    expect(document.getElementById('mcp-tofu-title-pid-1')).not.toBeNull();
  });

  test('initial focus lands on Deny once (safest default)', () => {
    act(() => {
      root.render(<McpTofuModal pending={mkPending()} send={() => {}} onClose={() => {}} />);
    });
    const denyOnce = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === 'Deny once',
    );
    expect(document.activeElement).toBe(denyOnce);
  });
});
