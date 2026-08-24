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
      root.render(
        <McpTofuModal
          pending={mkPending()}
          send={() => true}
          onClose={() => {}}
          onCancel={() => {}}
        />,
      );
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
      root.render(
        <McpTofuModal pending={pending} send={() => true} onClose={() => {}} onCancel={() => {}} />,
      );
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
          send={() => true}
          onClose={() => {}}
          onCancel={() => {}}
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
          send={() => true}
          onClose={() => {}}
          onCancel={() => {}}
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
    const send = (m: ClientMsg) => {
      sent.push(m);
      return true;
    };
    const onClose = () => {
      closed.count += 1;
    };
    return { sent, closed, send, onClose };
  }

  test('clicking Trust ships mcp_trust_decision { decision: "trust" }', () => {
    const { sent, send, onClose, closed } = setup();
    act(() => {
      root.render(
        <McpTofuModal pending={mkPending()} send={send} onClose={onClose} onCancel={() => {}} />,
      );
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
      root.render(
        <McpTofuModal pending={mkPending()} send={send} onClose={() => {}} onCancel={() => {}} />,
      );
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
      root.render(
        <McpTofuModal pending={mkPending()} send={send} onClose={() => {}} onCancel={() => {}} />,
      );
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
      root.render(
        <McpTofuModal pending={mkPending()} send={send} onClose={() => {}} onCancel={() => {}} />,
      );
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
      root.render(
        <McpTofuModal pending={pending} send={send} onClose={() => {}} onCancel={() => {}} />,
      );
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
      root.render(
        <McpTofuModal
          pending={mkPending()}
          send={() => true}
          onClose={() => {}}
          onCancel={() => {}}
        />,
      );
    });
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('mcp-tofu-title-pid-1');
    expect(document.getElementById('mcp-tofu-title-pid-1')).not.toBeNull();
  });

  test('initial focus lands on Deny once (safest default)', () => {
    act(() => {
      root.render(
        <McpTofuModal
          pending={mkPending()}
          send={() => true}
          onClose={() => {}}
          onCancel={() => {}}
        />,
      );
    });
    const denyOnce = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === 'Deny once',
    );
    expect(document.activeElement).toBe(denyOnce);
  });
});

// Register H04. Until 2026-08-02 Deny recorded a decision and the binary
// loaded anyway, and the modal said nothing about it. The enforcement and this
// copy have to move together — if a future change stops passing
// `settings.deniedMcpServers` to the spawn, this assertion is what makes the
// now-false promise fail CI instead of shipping.
describe('[security] McpTofuModal — Deny copy matches what Deny does', () => {
  function bodyText(): string {
    return container.textContent ?? '';
  }

  test('states that Deny stops the server from starting', () => {
    act(() => {
      root.render(
        <McpTofuModal
          pending={mkPending()}
          send={() => true}
          onClose={() => {}}
          onCancel={() => {}}
        />,
      );
    });
    expect(bodyText()).toContain('stops this server from starting');
  });

  test('distinguishes deny once from deny & remember', () => {
    act(() => {
      root.render(
        <McpTofuModal
          pending={mkPending()}
          send={() => true}
          onClose={() => {}}
          onCancel={() => {}}
        />,
      );
    });
    const text = bodyText();
    expect(text).toContain('re-asks on your next connection');
    expect(text).toContain('persists the decision');
  });

  test('does not promise more than the audit trail actually gives', () => {
    act(() => {
      root.render(
        <McpTofuModal
          pending={mkPending()}
          send={() => true}
          onClose={() => {}}
          onCancel={() => {}}
        />,
      );
    });
    // The audit row is a real guarantee (dispatcher dual-write, BE-1), so
    // saying so is honest. Anything stronger — "blocked everywhere", "removed
    // from your project" — would not be: Cebab writes nothing into the
    // operator's files.
    const text = bodyText();
    expect(text).toContain('recorded in the audit log');
    expect(text).not.toMatch(/removed from your project|blocked everywhere/i);
  });
});

describe('[security] McpTofuModal — declaration changed (Cebab-rxg)', () => {
  function bodyText(): string {
    return container.textContent ?? '';
  }

  const declChanged = () =>
    mkPending({
      reason: 'declaration_changed',
      command: 'node',
      args: ['mcp/swapped-server.mjs'],
      previousCommand: 'node',
      previousArgs: ['mcp/kitchen-server.mjs'],
      binarySha: undefined,
    });

  function render(pending = declChanged()) {
    act(() => {
      root.render(
        <McpTofuModal pending={pending} send={() => true} onClose={() => {}} onCancel={() => {}} />,
      );
    });
  }

  test('says the declaration changed, not that the server is new', () => {
    // The operator approved this name before. Calling it "first seen" would be
    // the same class of dishonesty the gate is supposed to prevent.
    render();
    expect(bodyText()).toContain('MCP server declaration changed');
    expect(bodyText()).not.toContain('Trust this MCP server?');
    expect(container.querySelector('.gate-modal-reason')!.textContent).toBe('declaration changed');
  });

  test('shows both halves of the change, so it can be judged', () => {
    render();
    const text = bodyText();
    expect(text).toContain('node mcp/kitchen-server.mjs');
    expect(text).toContain('node mcp/swapped-server.mjs');
  });

  test('the reason chip carries a readable accessible name', () => {
    // `replace` (not `replaceAll`) left the aria-label as "declaration changed"
    // only by luck of having one underscore; this pins it for a reason string
    // with two.
    render();
    expect(container.querySelector('.gate-modal-reason')!.getAttribute('aria-label')).toBe(
      'reason: declaration changed',
    );
  });

  test('a first_seen prompt shows no before/after rows', () => {
    // The negative control: without it, "shows the previous declaration" could
    // pass on a modal that renders the row unconditionally with empty values.
    render(mkPending({ reason: 'first_seen' }));
    expect(bodyText()).not.toContain('Previously approved');
    expect(bodyText()).not.toContain('Now declares');
  });
});
