// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ProjectAuthority } from '@cebab/shared/protocol';
import { ModelIdentityCard } from './ModelIdentityCard';

// Cluster B Phase 6b — UI-B44 ModelIdentityCard.
//
// Tests:
//   - happy path renders model + apiKeySource + permissionMode + cwd
//   - apiKeySource=none → "OAuth subscription" + ok class
//   - apiKeySource=something else → warn class (BE-B10 friend — operator
//     posture signal that token is in play)
//   - permissionMode=bypassPermissions → danger class
//   - permissionMode=acceptEdits → warn class
//   - missing model / cwd → graceful fallbacks (NEVER blank)
//   - settingSourcesUsed chips render alphabetically

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

function mkAuthority(overrides: Partial<ProjectAuthority> = {}): ProjectAuthority {
  return {
    projectId: 1,
    capturedAt: Date.now(),
    fromProbe: false,
    model: 'claude-sonnet-4-5',
    apiKeySource: 'none',
    permissionMode: 'default',
    cwd: '/u/proj',
    settingSourcesUsed: ['user', 'project', 'local'],
    tools: [],
    mcpServers: [],
    slashCommands: [],
    skills: [],
    agents: [],
    plugins: [],
    hooks: [],
    detectedEnvInjections: [],
    ...overrides,
  };
}

describe('ModelIdentityCard', () => {
  test('happy path renders model, apiKeySource, permissionMode, cwd', () => {
    act(() => {
      root.render(<ModelIdentityCard authority={mkAuthority()} />);
    });
    const text = container.textContent ?? '';
    expect(text).toContain('claude-sonnet-4-5');
    expect(text).toContain('OAuth subscription'); // apiKeySource=none label
    expect(text).toContain('default'); // permissionMode
    expect(text).toContain('/u/proj'); // cwd
  });

  test('apiKeySource=none uses ok posture class', () => {
    act(() => {
      root.render(<ModelIdentityCard authority={mkAuthority({ apiKeySource: 'none' })} />);
    });
    const dd = container.querySelector('.model-identity-key-ok');
    expect(dd).not.toBeNull();
    expect(dd?.textContent).toContain('OAuth');
  });

  test('apiKeySource=ANTHROPIC_API_KEY uses warn posture class', () => {
    act(() => {
      root.render(
        <ModelIdentityCard authority={mkAuthority({ apiKeySource: 'ANTHROPIC_API_KEY' })} />,
      );
    });
    const dd = container.querySelector('.model-identity-key-warn');
    expect(dd).not.toBeNull();
    expect(dd?.textContent).toContain('ANTHROPIC_API_KEY');
    // Posture-only — NEVER renders a value.
    expect(container.textContent).not.toMatch(/sk-/);
  });

  test('permissionMode=bypassPermissions uses danger class', () => {
    act(() => {
      root.render(
        <ModelIdentityCard authority={mkAuthority({ permissionMode: 'bypassPermissions' })} />,
      );
    });
    expect(container.querySelector('.model-identity-perm-danger')).not.toBeNull();
    expect(container.textContent).toContain('bypass — auto-allow ALL');
  });

  test('permissionMode=acceptEdits uses warn class', () => {
    act(() => {
      root.render(<ModelIdentityCard authority={mkAuthority({ permissionMode: 'acceptEdits' })} />);
    });
    expect(container.querySelector('.model-identity-perm-warn')).not.toBeNull();
  });

  test('missing model and cwd render graceful fallback copy', () => {
    act(() => {
      root.render(
        <ModelIdentityCard authority={mkAuthority({ model: undefined, cwd: undefined })} />,
      );
    });
    expect(container.textContent).toContain('(unknown — init not received yet)');
    expect(container.textContent).toContain('(not reported)');
  });

  test('settingSourcesUsed renders one chip per source', () => {
    act(() => {
      root.render(
        <ModelIdentityCard
          authority={mkAuthority({ settingSourcesUsed: ['user', 'project', 'local'] })}
        />,
      );
    });
    const chips = container.querySelectorAll('.model-identity-source-chip');
    expect(chips).toHaveLength(3);
    const labels = Array.from(chips).map((c) => c.textContent?.trim().replace(/\s+$/, ''));
    expect(labels).toContain('user');
    expect(labels).toContain('project');
    expect(labels).toContain('local');
  });

  test('empty settingSourcesUsed renders explicit (none)', () => {
    act(() => {
      root.render(<ModelIdentityCard authority={mkAuthority({ settingSourcesUsed: [] })} />);
    });
    expect(container.textContent).toContain('(none)');
  });
});
