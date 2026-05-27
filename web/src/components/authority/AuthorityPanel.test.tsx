// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ClientMsg, ProjectAuthority, ServerMsg } from '@cebab/shared/protocol';
import { AuthorityProvider } from './AuthorityContext';
import { AuthorityPanel } from './AuthorityPanel';

// Cluster B Phase 6b — AuthorityPanel host contract (UI-B1).
//
// Tests:
//   - mode-driven header copy ("Authority — preview" / "Project authority" /
//     "Authority — last run")
//   - mode-driven default-open: preflight + post-run open Model & identity
//     by default; Tools always closed
//   - auto-request on mount when slot is idle (issues get_project_authority
//     with mode='cache')
//   - cache-miss empty state renders + Refresh button fires request('probe')
//   - ready state renders ModelIdentityCard + ToolsList sections
//   - status line shows mode + age in seconds

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

function mkAuthority(over: Partial<ProjectAuthority> = {}): ProjectAuthority {
  return {
    projectId: 1,
    capturedAt: Date.now(),
    fromProbe: false,
    model: 'claude-sonnet-4-5',
    apiKeySource: 'none',
    permissionMode: 'default',
    cwd: '/u/p',
    settingSourcesUsed: ['user'],
    tools: [
      {
        name: 'Read',
        source: 'builtin',
        allowed: true,
        denied: false,
        rulingScope: 'default',
      },
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

function mountPanel(props: {
  send?: (m: ClientMsg) => void;
  handlerRef?: { current: ((m: ServerMsg) => void) | null };
  mode: 'preflight' | 'in-session' | 'post-run';
  projectId?: number;
  noAutoRequest?: boolean;
}) {
  const sent: ClientMsg[] = [];
  const send = props.send ?? ((m) => sent.push(m));
  const handlerRef = props.handlerRef ?? {
    current: null as ((m: ServerMsg) => void) | null,
  };
  act(() => {
    root.render(
      <AuthorityProvider send={send} handlerRef={handlerRef}>
        <AuthorityPanel
          projectId={props.projectId ?? 1}
          mode={props.mode}
          noAutoRequest={props.noAutoRequest}
        />
      </AuthorityProvider>,
    );
  });
  return { sent, handlerRef };
}

describe('AuthorityPanel — mode-driven header', () => {
  test('preflight title reads Authority — preview', () => {
    mountPanel({ mode: 'preflight', noAutoRequest: true });
    expect(container.querySelector('.authority-panel-title')?.textContent).toBe(
      'Authority — preview',
    );
  });
  test('in-session title reads Project authority', () => {
    mountPanel({ mode: 'in-session', noAutoRequest: true });
    expect(container.querySelector('.authority-panel-title')?.textContent).toBe(
      'Project authority',
    );
  });
  test('post-run title reads Authority — last run', () => {
    mountPanel({ mode: 'post-run', noAutoRequest: true });
    expect(container.querySelector('.authority-panel-title')?.textContent).toBe(
      'Authority — last run',
    );
  });
});

describe('AuthorityPanel — auto request on mount', () => {
  test('issues get_project_authority { mode: cache } when slot is idle', () => {
    const { sent } = mountPanel({ mode: 'in-session', projectId: 5 });
    expect(sent).toEqual([{ type: 'get_project_authority', projectId: 5, mode: 'cache' }]);
  });

  test('noAutoRequest=true skips the initial request', () => {
    const { sent } = mountPanel({ mode: 'in-session', noAutoRequest: true });
    expect(sent).toEqual([]);
  });

  test('Refresh button fires get_project_authority { mode: probe }', () => {
    const { sent } = mountPanel({ mode: 'in-session', projectId: 3, noAutoRequest: true });
    const refresh = container.querySelector('.authority-panel-refresh') as HTMLButtonElement;
    act(() => {
      refresh.click();
    });
    expect(sent).toEqual([{ type: 'get_project_authority', projectId: 3, mode: 'probe' }]);
  });
});

describe('AuthorityPanel — cache-miss empty state', () => {
  test('renders empty CTA when handler returns null authority', () => {
    const { handlerRef } = mountPanel({ mode: 'in-session', projectId: 1, noAutoRequest: true });
    act(() => {
      handlerRef.current!({ type: 'project_authority', projectId: 1, authority: null });
    });
    expect(container.querySelector('.authority-panel-empty')).not.toBeNull();
    expect(container.textContent).toContain('No authority snapshot cached');
  });
});

describe('AuthorityPanel — ready state', () => {
  test('renders all Phase 6b + 6c + 8 sections', () => {
    const { handlerRef } = mountPanel({ mode: 'in-session', projectId: 1, noAutoRequest: true });
    act(() => {
      handlerRef.current!({
        type: 'project_authority',
        projectId: 1,
        authority: mkAuthority(),
      });
    });
    const titles = Array.from(
      container.querySelectorAll<HTMLElement>('.authority-section-title'),
    ).map((el) => el.textContent);
    expect(titles).toContain('Model & identity');
    expect(titles).toContain('Tools');
    expect(titles).toContain('MCP servers');
    expect(titles).toContain('Allow / deny rules');
    expect(titles).toContain('Env injection scan');
    expect(titles).toContain('Hooks');
    // Phase 8 additions:
    expect(titles).toContain('Slash commands');
    expect(titles).toContain('Skills');
    expect(titles).toContain('Sub-agents');
    // Tools count badge should show 1.
    const toolsSection = Array.from(
      container.querySelectorAll<HTMLElement>('.authority-section'),
    ).find((s) => s.querySelector('.authority-section-title')?.textContent === 'Tools')!;
    expect(toolsSection.querySelector('.authority-section-count')?.textContent).toBe('1');
  });

  test('Phase 8 sections show counts derived from the authority snapshot', () => {
    const { handlerRef } = mountPanel({ mode: 'in-session', projectId: 1, noAutoRequest: true });
    act(() => {
      handlerRef.current!({
        type: 'project_authority',
        projectId: 1,
        authority: mkAuthority({
          slashCommands: ['/help', '/clear', '/compact'],
          skills: ['skill-a', 'skill-b'],
          agents: ['planner', 'explorer', 'reviewer', 'general'],
        }),
      });
    });
    const findSection = (title: string) =>
      Array.from(container.querySelectorAll<HTMLElement>('.authority-section')).find(
        (s) => s.querySelector('.authority-section-title')?.textContent === title,
      )!;
    expect(
      findSection('Slash commands').querySelector('.authority-section-count')?.textContent,
    ).toBe('3');
    expect(findSection('Skills').querySelector('.authority-section-count')?.textContent).toBe('2');
    expect(findSection('Sub-agents').querySelector('.authority-section-count')?.textContent).toBe(
      '4',
    );
  });

  test('Phase 8 sections show "none enumerated/declared" sublabel when empty', () => {
    const { handlerRef } = mountPanel({ mode: 'in-session', projectId: 1, noAutoRequest: true });
    act(() => {
      handlerRef.current!({
        type: 'project_authority',
        projectId: 1,
        authority: mkAuthority(),
      });
    });
    const findSection = (title: string) =>
      Array.from(container.querySelectorAll<HTMLElement>('.authority-section')).find(
        (s) => s.querySelector('.authority-section-title')?.textContent === title,
      )!;
    expect(
      findSection('Slash commands').querySelector('.authority-section-sublabel')?.textContent,
    ).toBe('none enumerated');
    expect(findSection('Skills').querySelector('.authority-section-sublabel')?.textContent).toBe(
      'none enumerated',
    );
    expect(
      findSection('Sub-agents').querySelector('.authority-section-sublabel')?.textContent,
    ).toBe('none declared');
  });

  test('Env injection scan force-opens when any injection is detected', () => {
    const { handlerRef } = mountPanel({ mode: 'in-session', projectId: 1, noAutoRequest: true });
    act(() => {
      handlerRef.current!({
        type: 'project_authority',
        projectId: 1,
        authority: mkAuthority({
          detectedEnvInjections: [
            {
              envKey: 'ANTHROPIC_API_KEY',
              scope: 'project',
              scopePath: '/u/p/.claude/settings.json',
              posture: 'subscription auth bypass',
              isSet: true,
            },
          ],
        }),
      });
    });
    const envSection = Array.from(
      container.querySelectorAll<HTMLDetailsElement>('details.authority-section'),
    ).find(
      (s) => s.querySelector('.authority-section-title')?.textContent === 'Env injection scan',
    )!;
    expect(envSection.open).toBe(true);
    // Accent stripe applied.
    expect(envSection.className).toContain('authority-section-stripe-accent');
  });

  test('Hooks section force-opens with warn stripe when a local hook is present', () => {
    const { handlerRef } = mountPanel({ mode: 'in-session', projectId: 1, noAutoRequest: true });
    act(() => {
      handlerRef.current!({
        type: 'project_authority',
        projectId: 1,
        authority: mkAuthority({
          hooks: [
            {
              hookKind: 'PreToolUse',
              scope: 'local',
              scopePath: '/u/p/.claude/settings.local.json',
              command: '/bin/x',
            },
          ],
        }),
      });
    });
    const hooksSection = Array.from(
      container.querySelectorAll<HTMLDetailsElement>('details.authority-section'),
    ).find((s) => s.querySelector('.authority-section-title')?.textContent === 'Hooks')!;
    expect(hooksSection.open).toBe(true);
    expect(hooksSection.className).toContain('authority-section-stripe-removed');
  });

  test('preflight mode opens Model & identity by default; Tools stays closed', () => {
    const { handlerRef } = mountPanel({ mode: 'preflight', projectId: 1, noAutoRequest: true });
    act(() => {
      handlerRef.current!({
        type: 'project_authority',
        projectId: 1,
        authority: mkAuthority(),
      });
    });
    const sections = Array.from(
      container.querySelectorAll<HTMLDetailsElement>('details.authority-section'),
    );
    const modelSection = sections.find(
      (s) => s.querySelector('.authority-section-title')?.textContent === 'Model & identity',
    )!;
    const toolsSection = sections.find(
      (s) => s.querySelector('.authority-section-title')?.textContent === 'Tools',
    )!;
    expect(modelSection.open).toBe(true);
    expect(toolsSection.open).toBe(false);
  });

  test('preflight mode renders Tools in list mode (no usage-toggle bar)', () => {
    const { handlerRef } = mountPanel({ mode: 'preflight', projectId: 1, noAutoRequest: true });
    act(() => {
      handlerRef.current!({
        type: 'project_authority',
        projectId: 1,
        authority: mkAuthority(),
      });
    });
    // Open the Tools section so the inner ToolsList is in the DOM.
    const toolsSection = Array.from(
      container.querySelectorAll<HTMLDetailsElement>('details.authority-section'),
    ).find((s) => s.querySelector('.authority-section-title')?.textContent === 'Tools')!;
    act(() => {
      toolsSection.open = true;
    });
    // The usage-toggle bar is the marker for usage-diff mode; preflight
    // suppresses it.
    expect(toolsSection.querySelector('.tools-list-usage-toggle')).toBeNull();
  });

  test('in-session mode renders Tools in usage-diff mode with toggle defaulting to All', () => {
    const { handlerRef } = mountPanel({ mode: 'in-session', projectId: 1, noAutoRequest: true });
    act(() => {
      handlerRef.current!({
        type: 'project_authority',
        projectId: 1,
        authority: mkAuthority({
          tools: [
            {
              name: 'Read',
              source: 'builtin',
              allowed: true,
              denied: false,
              rulingScope: 'default',
              calledCount: 3,
            },
          ],
        }),
      });
    });
    const toolsSection = Array.from(
      container.querySelectorAll<HTMLDetailsElement>('details.authority-section'),
    ).find((s) => s.querySelector('.authority-section-title')?.textContent === 'Tools')!;
    act(() => {
      toolsSection.open = true;
    });
    expect(toolsSection.querySelector('.tools-list-usage-toggle')).not.toBeNull();
    // The "All" button is active (aria-pressed=true) by default.
    const buttons = toolsSection.querySelectorAll<HTMLButtonElement>(
      '.tools-list-usage-toggle-btn',
    );
    const all = Array.from(buttons).find((b) => b.textContent?.includes('All'))!;
    expect(all.getAttribute('aria-pressed')).toBe('true');
  });

  test('post-run mode defaults the Tools toggle to Attempted (red signal-of-interest column)', () => {
    const { handlerRef } = mountPanel({ mode: 'post-run', projectId: 1, noAutoRequest: true });
    act(() => {
      handlerRef.current!({
        type: 'project_authority',
        projectId: 1,
        authority: mkAuthority({
          tools: [
            {
              name: 'Bash',
              source: 'builtin',
              allowed: false,
              denied: true,
              rulingScope: 'project',
              deniedCount: 2,
            },
          ],
        }),
      });
    });
    const toolsSection = Array.from(
      container.querySelectorAll<HTMLDetailsElement>('details.authority-section'),
    ).find((s) => s.querySelector('.authority-section-title')?.textContent === 'Tools')!;
    act(() => {
      toolsSection.open = true;
    });
    const buttons = toolsSection.querySelectorAll<HTMLButtonElement>(
      '.tools-list-usage-toggle-btn',
    );
    const attempted = Array.from(buttons).find((b) => b.textContent?.includes('Attempted'))!;
    expect(attempted.getAttribute('aria-pressed')).toBe('true');
  });

  test('in-session mode keeps both sections closed by default', () => {
    const { handlerRef } = mountPanel({ mode: 'in-session', projectId: 1, noAutoRequest: true });
    act(() => {
      handlerRef.current!({
        type: 'project_authority',
        projectId: 1,
        authority: mkAuthority(),
      });
    });
    const sections = Array.from(
      container.querySelectorAll<HTMLDetailsElement>('details.authority-section'),
    );
    expect(sections.every((s) => s.open === false)).toBe(true);
  });
});

describe('AuthorityPanel — status line', () => {
  test('status shows "loading…" when slot is idle (auto-request flips to requesting)', () => {
    mountPanel({ mode: 'in-session', noAutoRequest: true });
    expect(container.querySelector('.authority-panel-status')?.textContent).toBe('loading…');
  });

  test('status shows "requesting (cache)…" after request flips slot', () => {
    mountPanel({ mode: 'in-session', projectId: 1 });
    expect(container.querySelector('.authority-panel-status')?.textContent).toBe(
      'requesting (cache)…',
    );
  });

  test('status shows lastFetchedMode + age once ready', () => {
    const { handlerRef } = mountPanel({ mode: 'in-session', projectId: 1 });
    act(() => {
      handlerRef.current!({
        type: 'project_authority',
        projectId: 1,
        authority: mkAuthority(),
      });
    });
    const status = container.querySelector('.authority-panel-status')?.textContent ?? '';
    expect(status).toMatch(/^cache · \d+s ago$/);
  });
});
