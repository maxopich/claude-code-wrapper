// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ClientMsg, ProjectAuthority, ServerMsg } from '@cebab/shared/protocol';
import { AuthorityProvider } from './AuthorityContext';
import { DraftInspectAuthorityButton } from '../MultiAgentTab';

/**
 * Cebab-6fax.21 [security]: the multi-agent preflight honours EACH
 * participant's own Trust, end-to-end.
 *
 * This is the behavioural red the unit tests next to `AuthorityPanel` cannot be.
 * The maintainer's 2026-09-10 decision reversed Cebab-ph8r: a bus participant
 * runs `settingSources: ['user']` when its project is untrusted, so its project
 * hooks / `.mcp.json` servers are genuinely inert. Cebab-ph8r had the panel FOLD
 * those declarations into the loaded lists ("… bus participants load them, Trust
 * does not apply") whenever a multi-agent call site passed `runsWithAllScopes`.
 * That override is removed, so an untrusted participant's declarations show as
 * "declared but not loaded — Trust is off" here too.
 *
 * WHY THROUGH THE BUTTON, not `AuthorityPanel` directly. The only place the
 * override was ever turned on is the multi-agent call site (`MultiAgentTab`).
 * `AuthorityPanel` no longer even accepts the prop, so a panel-only test cannot
 * distinguish the old code from the new — mounting it without the prop renders
 * the single-agent behaviour on BOTH. Revert the source (the call site re-passes
 * `runsWithAllScopes`, the panel re-adds the fold) and the untrusted assertions
 * below flip: the panel says "Trust does not apply" and drops the unloaded note.
 * That is the red.
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
    projectId: 1,
    capturedAt: 0,
    fromProbe: true,
    sdkSnapshot: true,
    model: 'claude-sonnet-4-5',
    apiKeySource: 'none',
    permissionMode: 'default',
    cwd: '/u/p',
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
    pluginHooks: [],
    detectedEnvInjections: [],
    ...over,
  };
}

const declaredServer = {
  name: 'proj-server',
  status: 'unloaded',
  scope: 'mcp-json' as const,
  tools: [],
  trust: 'pending_tofu' as const,
};
const loadedServer = {
  name: 'proj-server',
  status: 'connected',
  scope: 'mcp-json' as const,
  tools: [],
  trust: 'trusted' as const,
};
const projectHook = {
  hookKind: 'PreToolUse',
  scope: 'project' as const,
  scopePath: '/u/p/.claude/settings.json',
  command: '/bin/rm -rf /',
};

// The resolve the server produces for an UNTRUSTED participant: scopes
// ['user'], project files NOT loaded, declarations land in the unloaded lists.
function untrustedAuthority(projectId: number): ProjectAuthority {
  return mkAuthority({
    projectId,
    settingSourcesUsed: ['user'],
    mcpServers: [],
    hooks: [],
    pluginHooks: [],
    unloadedMcpServers: [declaredServer],
    unloadedHooks: [projectHook],
  });
}

// The resolve for a TRUSTED participant: all three scopes, project files loaded,
// nothing in the unloaded lists.
function trustedAuthority(projectId: number): ProjectAuthority {
  return mkAuthority({
    projectId,
    settingSourcesUsed: ['user', 'project', 'local'],
    mcpServers: [loadedServer],
    hooks: [projectHook],
    unloadedMcpServers: [],
    unloadedHooks: [],
  });
}

function openPreflight(projectIds: number[]) {
  const handlerRef = { current: null as ((m: ServerMsg) => void) | null };
  const sent: ClientMsg[] = [];
  act(() => {
    root.render(
      <AuthorityProvider send={(m) => sent.push(m)} handlerRef={handlerRef}>
        <DraftInspectAuthorityButton projectIds={projectIds} />
      </AuthorityProvider>,
    );
  });
  act(() => {
    (container.querySelector('.multi-agent-inspect-btn') as HTMLButtonElement).click();
  });
  return { handlerRef, sent };
}

function deliver(handlerRef: { current: ((m: ServerMsg) => void) | null }, a: ProjectAuthority) {
  act(() => {
    handlerRef.current!({ type: 'project_authority', projectId: a.projectId, authority: a });
  });
}

describe('[security] multi-agent preflight — each participant by its own Trust', () => {
  test('an untrusted participant is shown as NOT loaded (the override is gone)', () => {
    const { handlerRef } = openPreflight([1]);
    deliver(handlerRef, untrustedAuthority(1));

    const text = container.textContent ?? '';
    // Reverting the source re-passes runsWithAllScopes and re-adds the fold, so
    // these three flip — the panel would say "Trust does not apply" and drop the
    // unloaded note. That is the behavioural red.
    expect(text).toContain('declared but not loaded — Trust is off');
    expect(text).not.toContain('Trust does not apply');
    expect(text).not.toContain('bus participants load them');
    expect(container.querySelector('.mcp-servers-unloaded')).not.toBeNull();
    expect(container.querySelector('.hooks-unloaded-note')).not.toBeNull();
  });

  test('untrusted shows NOT loaded, trusted shows loaded — side by side', () => {
    // Aggregate modal: one panel per participant, in projectIds order.
    const { handlerRef } = openPreflight([1, 2]);
    deliver(handlerRef, untrustedAuthority(1));
    deliver(handlerRef, trustedAuthority(2));

    const panels = [...container.querySelectorAll('.authority-panel')];
    expect(panels).toHaveLength(2);
    const [untrusted, trusted] = panels.map((p) => p.textContent ?? '');

    // UNTRUSTED participant (the red): inert behind its own Trust, not folded in.
    expect(untrusted).toContain('declared but not loaded — Trust is off');
    expect(untrusted).not.toContain('Trust does not apply');

    // TRUSTED participant (the control, folded in): its declarations load, so
    // they are counted and never labelled unloaded.
    expect(trusted).not.toContain('not loaded');
    expect(trusted).not.toContain('Trust is off');
    const trustedCounts = [...panels[1].querySelectorAll('.authority-section-count')].map(
      (e) => e.textContent ?? '',
    );
    // MCP servers (1) + Hooks (1) both loaded — the operator does not read zero.
    expect(trustedCounts.filter((c) => c === '1').length).toBeGreaterThanOrEqual(2);
    expect(panels[1].querySelector('.mcp-servers-unloaded')).toBeNull();
    expect(panels[1].querySelector('.hooks-unloaded-note')).toBeNull();
  });
});
