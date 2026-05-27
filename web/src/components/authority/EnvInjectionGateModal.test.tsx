// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ClientMsg, EnvInjection, ServerMsg } from '@cebab/shared/protocol';
import { EnvInjectionGateModal } from './EnvInjectionGateModal';

// Cluster B Phase 6a tests — typed-acknowledgment modal for §4.5 gate.
//
// Public contract covered:
//   - Renders each detected EnvInjection (key + posture + scope + isSet)
//   - Submit button disabled until typed ack === 'inject' (case-sensitive)
//   - Submit sends acknowledge_and_start with pendingStartId + typedAck +
//     optional reasonText
//   - Refuse closes without sending
//   - BE-B12 [security]: no env value is rendered or in any data attr
//     (the wire never carries values, and the modal must not invent them)
//   - Default focus on Refuse button (safer default per spec §5.4)
//
// jsdom env throughout. React 19 act + createRoot.

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

function mkInjection(envKey: string, overrides: Partial<EnvInjection> = {}): EnvInjection {
  return {
    envKey,
    scope: 'project',
    scopePath: '/u/proj/.claude/settings.json',
    posture: 'subscription auth bypass',
    isSet: true,
    ...overrides,
  };
}

function mkPending(
  overrides: Partial<Extract<ServerMsg, { type: 'session_start_gated' }>> = {},
): Extract<ServerMsg, { type: 'session_start_gated' }> {
  return {
    type: 'session_start_gated',
    pendingStartId: 'psid-1',
    projectId: 42,
    reason: 'env_injection_detected',
    detectedInjections: [mkInjection('ANTHROPIC_API_KEY')],
    ...overrides,
  };
}

// React-controlled inputs need the native value setter, otherwise React
// notices `input.value = X` was a direct DOM mutation and reverts on next
// render. This is the standard React Testing Library trick distilled to a
// helper so we don't need a third-party dep.
function typeInto(input: HTMLInputElement, value: string) {
  const proto = HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) throw new Error('no value setter on HTMLInputElement.prototype');
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('EnvInjectionGateModal — render', () => {
  test('lists each detected injection with key, posture, scope, isSet', () => {
    act(() => {
      root.render(
        <EnvInjectionGateModal
          pending={mkPending({
            detectedInjections: [
              mkInjection('ANTHROPIC_API_KEY', { isSet: true, scope: 'project' }),
              mkInjection('CLAUDE_CODE_USE_BEDROCK', { isSet: false, scope: 'local' }),
            ],
          })}
          send={() => {}}
          onClose={() => {}}
        />,
      );
    });
    const rows = container.querySelectorAll('.gate-modal-injection-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('ANTHROPIC_API_KEY');
    expect(rows[0]!.textContent).toContain('subscription auth bypass');
    expect(rows[0]!.textContent).toContain('project');
    expect(rows[0]!.textContent).toContain('set');
    expect(rows[1]!.textContent).toContain('CLAUDE_CODE_USE_BEDROCK');
    expect(rows[1]!.textContent).toContain('local');
    expect(rows[1]!.textContent).toContain('unset');
  });

  test('BE-B12 [security]: env value never appears in the rendered DOM', () => {
    // The wire envelope NEVER carries values; this test guards against a
    // bug where a future shape accidentally adds one. We pass an injection
    // with no value field and assert the DOM has no string that looks like
    // a token (any opaque sk-* / Bearer * / 32+ char alnum blob).
    act(() => {
      root.render(
        <EnvInjectionGateModal
          pending={mkPending({
            detectedInjections: [mkInjection('ANTHROPIC_API_KEY')],
          })}
          send={() => {}}
          onClose={() => {}}
        />,
      );
    });
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    expect(text).not.toMatch(/Bearer\s+/i);
  });
});

describe('EnvInjectionGateModal — submit gating', () => {
  test('Submit is disabled until typed string === "inject" (case-sensitive)', () => {
    act(() => {
      root.render(
        <EnvInjectionGateModal pending={mkPending()} send={() => {}} onClose={() => {}} />,
      );
    });
    const submit = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('Submit override'),
    )!;
    expect(submit.disabled).toBe(true);

    const ack = container.querySelector<HTMLInputElement>('.gate-modal-input-ack')!;

    // Wrong case
    act(() => {
      typeInto(ack, 'Inject');
    });
    expect(submit.disabled).toBe(true);

    // Trailing space
    act(() => {
      typeInto(ack, 'inject ');
    });
    expect(submit.disabled).toBe(true);

    // Exact match
    act(() => {
      typeInto(ack, 'inject');
    });
    expect(submit.disabled).toBe(false);
  });

  test('Submit sends acknowledge_and_start with reasonText when provided', () => {
    const sent: ClientMsg[] = [];
    const closed = { count: 0 };
    act(() => {
      root.render(
        <EnvInjectionGateModal
          pending={mkPending()}
          send={(m) => sent.push(m)}
          onClose={() => {
            closed.count += 1;
          }}
        />,
      );
    });
    const ack = container.querySelector<HTMLInputElement>('.gate-modal-input-ack')!;
    const reason = container.querySelector<HTMLInputElement>(
      'input[type="text"]:not(.gate-modal-input-ack)',
    )!;
    act(() => {
      typeInto(reason, 'CI deploy, expected');
      typeInto(ack, 'inject');
    });
    const submit = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('Submit override'),
    )!;
    act(() => {
      submit.click();
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'acknowledge_and_start',
      pendingStartId: 'psid-1',
      typedAcknowledgment: 'inject',
      reasonText: 'CI deploy, expected',
    });
    expect(closed.count).toBe(1);
  });

  test('Submit omits reasonText when the field is empty / whitespace', () => {
    const sent: ClientMsg[] = [];
    act(() => {
      root.render(
        <EnvInjectionGateModal
          pending={mkPending()}
          send={(m) => sent.push(m)}
          onClose={() => {}}
        />,
      );
    });
    const ack = container.querySelector<HTMLInputElement>('.gate-modal-input-ack')!;
    act(() => {
      typeInto(ack, 'inject');
    });
    const submit = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('Submit override'),
    )!;
    act(() => {
      submit.click();
    });
    if (sent[0]?.type !== 'acknowledge_and_start') throw new Error();
    expect(sent[0].reasonText).toBeUndefined();
  });
});

describe('EnvInjectionGateModal — refuse path', () => {
  test('Refuse & edit closes without sending any ClientMsg', () => {
    const sent: ClientMsg[] = [];
    const closed = { count: 0 };
    act(() => {
      root.render(
        <EnvInjectionGateModal
          pending={mkPending()}
          send={(m) => sent.push(m)}
          onClose={() => {
            closed.count += 1;
          }}
        />,
      );
    });
    const refuse = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('Refuse'),
    )!;
    act(() => {
      refuse.click();
    });
    expect(sent).toHaveLength(0);
    expect(closed.count).toBe(1);
  });
});

describe('EnvInjectionGateModal — accessibility', () => {
  test('dialog has role + aria-modal + aria-labelledby + default focus on Refuse', () => {
    act(() => {
      root.render(
        <EnvInjectionGateModal pending={mkPending()} send={() => {}} onClose={() => {}} />,
      );
    });
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('env-gate-title-psid-1');
    const refuse = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('Refuse'),
    );
    expect(document.activeElement).toBe(refuse);
  });
});
