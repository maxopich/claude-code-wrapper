// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ClientMsg, ProjectAuthority, ServerMsg } from '@cebab/shared/protocol';
import { AuthorityProvider } from './authority/AuthorityContext';
import { NewChatPreview } from './NewChatPreview';

/**
 * Cebab-ws0.5: the empty chat area is now the agent's authority.
 *
 * What these pin is the difference between this and the ⓘ button it replaces:
 * it appears without being asked for, it asks for a MEASURED snapshot, and it
 * never stands between the operator and the composer.
 */

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

function mkAuthority(over: Partial<ProjectAuthority> = {}): ProjectAuthority {
  return {
    projectId: 5,
    capturedAt: Date.now(),
    fromProbe: true,
    sdkSnapshot: true,
    model: 'claude-opus-5',
    settingSourcesUsed: ['user'],
    tools: [
      { name: 'Read', source: 'builtin', allowed: true, denied: false, rulingScope: 'default' },
    ],
    mcpServers: [],
    slashCommands: [],
    skills: [],
    agents: [],
    plugins: [],
    hooks: [],
    detectedEnvInjections: [],
    ...over,
  };
}

function mount(over: { model?: boolean; startMode?: boolean } = {}) {
  const sent: ClientMsg[] = [];
  const handlerRef = { current: null as ((m: ServerMsg) => void) | null };
  act(() => {
    root.render(
      <AuthorityProvider send={(m) => sent.push(m)} handlerRef={handlerRef}>
        <NewChatPreview
          projectId={5}
          projectName="ledger-agent"
          {...(over.model === false
            ? {}
            : {
                model: {
                  entries: [],
                  value: null,
                  onChange: () => {},
                  onRefresh: () => {},
                  refreshing: false,
                  capturedAt: null,
                },
              })}
          {...(over.startMode === false
            ? {}
            : { startMode: { value: null, trusted: false, onChange: () => {} } })}
        />
      </AuthorityProvider>,
    );
  });
  return { sent, handlerRef };
}

describe('NewChatPreview', () => {
  test('names the project and renders both pre-session controls', () => {
    mount();
    expect(container.textContent).toContain('ledger-agent');
    expect(container.querySelector('[data-testid="preflight-model"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="preflight-start-mode"]')).not.toBeNull();
  });

  test('asks for a MEASURED snapshot on mount, not a cache read', () => {
    // The bead's second half. A preview that opens on the not-measured state
    // is the thing it exists to replace, so `mode: 'cache'` here reddens.
    const { sent } = mount();
    expect(sent).toEqual([{ type: 'get_project_authority', projectId: 5, mode: 'probe' }]);
  });

  test('a probe that finds nothing still renders, and blocks nothing', () => {
    // "A probe failure degrades to the file-scan half rather than blocking the
    // start." Nothing here is a gate — there is no button to press and no
    // acknowledgment to give, so the composer below stays reachable whatever
    // the server answered.
    const { handlerRef } = mount();
    act(() => {
      handlerRef.current!({ type: 'project_authority', projectId: 5, authority: null });
    });
    expect(container.textContent).toContain('ledger-agent');
    expect(container.querySelector('[data-testid="preflight-model"]')).not.toBeNull();
  });

  test('renders the resolved snapshot once it lands', () => {
    const { handlerRef } = mount();
    act(() => {
      handlerRef.current!({
        type: 'project_authority',
        projectId: 5,
        authority: mkAuthority(),
      });
    });
    expect(container.textContent).toContain('claude-opus-5');
  });

  test('the copy tells the operator they can just type', () => {
    // It surfaces rather than blocks, and saying so is what keeps a full-height
    // panel from reading as a form to fill in.
    mount();
    expect(container.textContent).toContain('Type below to start');
  });
});
