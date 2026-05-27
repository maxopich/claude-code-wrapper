import { useEffect } from 'react';
import { useAuthorityActions, useAuthoritySlot, type AuthoritySlot } from './AuthorityContext';
import { AuthoritySection } from './AuthoritySection';
import { ModelIdentityCard } from './ModelIdentityCard';
import { ToolsList } from './ToolsList';
import { McpServersList } from './McpServersList';
import { AllowDenyView } from './AllowDenyView';
import { EnvScrubInspector } from './EnvScrubInspector';
import { HooksList } from './HooksList';

// Cluster B Phase 6b (UI-B1): host that composes the authority sections.
//
// Mode contract (spec §6.1):
//   - 'preflight'  — opened from the +new-chat button / DraftView. Used to
//                    review before kicking off a session. Default-open the
//                    HIGH-risk sections (model identity is the at-a-glance
//                    answer); Tools collapsed (operator can dig in if
//                    they want). Header reads "Authority — preview".
//   - 'in-session' — embedded in the SessionSettingsPanel. Default-collapsed
//                    so the operator's existing focus on the session isn't
//                    disrupted; sections still expandable. Header reads
//                    "Project authority".
//   - 'post-run'   — opened after a session ends. UI-B32 says toggle
//                    defaults to "Attempted" (usage-diff) for the Tools
//                    section, but that mode is Phase 10; Phase 6b's
//                    post-run is identical to in-session in render. Header
//                    reads "Authority — last run".
//
// Mode-driven behavioural diffs are intentionally narrow (UI-B1): the
// underlying widgets don't branch on mode at all — the panel just sets
// `defaultOpen` and `header` text differently. That keeps every list / card
// uniformly testable across modes.
//
// Loading / empty states:
//   - 'idle'        — first mount before any request; panel auto-fires a
//                     cache request via `useAuthorityActions().request` to
//                     populate the slot. Renders a thin loading row.
//   - 'requesting'  — show a spinner; if the slot ALREADY has data (re-probe
//                     from 'ready' state), the reducer keeps the previous
//                     ready slot — the panel renders the stale data with a
//                     "refreshing…" hint.
//   - 'cache-miss'  — explicit "no snapshot cached yet" empty state with a
//                     `[Refresh]` button (calls request('probe')). This is
//                     the BE-B3 null path: no session has started in this
//                     WS connection.
//   - 'ready'       — the full panel.

export type AuthorityPanelMode = 'preflight' | 'in-session' | 'post-run';

export type AuthorityPanelProps = {
  projectId: number;
  mode: AuthorityPanelMode;
  /**
   * When true the panel skips the auto-request on mount. Useful for tests
   * and for the preflight modal which fires the request itself with a
   * `mode: 'probe'` so the operator sees fresh state.
   */
  noAutoRequest?: boolean;
};

function headerForMode(mode: AuthorityPanelMode): string {
  if (mode === 'preflight') return 'Authority — preview';
  if (mode === 'post-run') return 'Authority — last run';
  return 'Project authority';
}

function defaultOpenForSection(section: 'model' | 'tools', mode: AuthorityPanelMode): boolean {
  if (section === 'model') return mode === 'preflight' || mode === 'post-run';
  // Tools collapsed by default in every mode — long list, default-expanded
  // would bury the model/auth posture chips.
  return false;
}

export function AuthorityPanel(props: AuthorityPanelProps) {
  const { projectId, mode, noAutoRequest = false } = props;
  const slot = useAuthoritySlot(projectId);
  const { request } = useAuthorityActions();

  // Auto-fire cache request on mount for any panel that hasn't loaded yet.
  // The reducer dedupes — if a previous mount already requested, it stays
  // in 'requesting' and this call is a no-op on the server (a re-request is
  // cheap; the WS handler returns the cached snapshot synchronously).
  useEffect(() => {
    if (noAutoRequest) return;
    if (slot.status === 'idle') request(projectId, 'cache');
  }, [projectId, slot.status, request, noAutoRequest]);

  return (
    <section className={`authority-panel authority-panel-${mode}`} aria-label={headerForMode(mode)}>
      <header className="authority-panel-header">
        <h3 className="authority-panel-title">{headerForMode(mode)}</h3>
        <span className="authority-panel-status" aria-live="polite">
          {renderStatus(slot)}
        </span>
        <button
          type="button"
          className="ghost-btn authority-panel-refresh"
          onClick={() => request(projectId, 'probe')}
          aria-label="Refresh authority snapshot"
        >
          ↻ Refresh
        </button>
      </header>
      {renderBody(slot, mode)}
    </section>
  );
}

function renderStatus(slot: AuthoritySlot): string {
  if (slot.status === 'idle') return 'loading…';
  if (slot.status === 'requesting') return `requesting (${slot.mode})…`;
  if (slot.status === 'cache-miss') return 'no snapshot — click Refresh';
  // ready
  const ageSec = Math.max(0, Math.round((Date.now() - slot.receivedAt) / 1000));
  return `${slot.lastFetchedMode} · ${ageSec}s ago`;
}

function renderBody(slot: AuthoritySlot, mode: AuthorityPanelMode) {
  if (slot.status === 'idle' || slot.status === 'requesting') {
    return <div className="authority-panel-loading">Loading authority…</div>;
  }
  if (slot.status === 'cache-miss') {
    return (
      <div className="authority-panel-empty">
        No authority snapshot cached for this project. Click <strong>Refresh</strong> above to
        request one (Phase 3b will spawn a <code>maxTurns:0</code> probe; Phase 6b returns the empty
        cache for now).
      </div>
    );
  }
  const { authority } = slot;
  return (
    <div className="authority-panel-body">
      <AuthoritySection title="Model & identity" defaultOpen={defaultOpenForSection('model', mode)}>
        <ModelIdentityCard authority={authority} />
      </AuthoritySection>
      <AuthoritySection
        title="Tools"
        count={authority.tools.length}
        sublabel={authority.tools.length === 0 ? 'no tools resolved' : undefined}
        defaultOpen={defaultOpenForSection('tools', mode)}
      >
        <ToolsList tools={authority.tools} mcpServers={authority.mcpServers} mode="list" />
      </AuthoritySection>
      <AuthoritySection
        title="MCP servers"
        count={authority.mcpServers.length}
        sublabel={authority.mcpServers.length === 0 ? 'none declared' : undefined}
        defaultOpen={false}
      >
        <McpServersList servers={authority.mcpServers} />
      </AuthoritySection>
      <AuthoritySection
        title="Allow / deny rules"
        // Count derived from the same per-tool attribution AllowDenyView
        // groups on — explicit allows + denied (any rulingScope). Default-
        // deny rows count too because the operator should see "20 tools
        // denied" even if the rules are implicit.
        count={countAllowDenyRules(authority.tools)}
        defaultOpen={false}
      >
        <AllowDenyView tools={authority.tools} />
      </AuthoritySection>
      <AuthoritySection
        title="Env injection scan"
        count={authority.detectedEnvInjections.length}
        sublabel={
          authority.detectedEnvInjections.length === 0
            ? 'no credential-class keys detected'
            : `${authority.detectedEnvInjections.length} would inject — review before starting`
        }
        // Force-open when ANY injection is detected — this is the highest-
        // signal posture row the operator can look at before kicking off a
        // session.
        defaultOpen={authority.detectedEnvInjections.length > 0}
        stripe={authority.detectedEnvInjections.length > 0 ? 'accent' : 'none'}
      >
        <EnvScrubInspector injections={authority.detectedEnvInjections} />
      </AuthoritySection>
      <AuthoritySection
        title="Hooks"
        count={authority.hooks.length}
        sublabel={
          authority.hooks.length === 0
            ? 'none declared'
            : hasLocalHook(authority.hooks)
              ? 'project-local hook present — review'
              : undefined
        }
        // Force-open when a project-local hook exists — UI-B40's force-
        // expand intent.
        defaultOpen={hasLocalHook(authority.hooks)}
        stripe={hasLocalHook(authority.hooks) ? 'removed' : 'none'}
      >
        <HooksList hooks={authority.hooks} />
      </AuthoritySection>
      {/* Phase 6d adds RouterDropsCounter/Log. Phase 8 adds the
       *  SlashCommandsList / SkillsList / SubAgentsList cards. */}
    </div>
  );
}

/**
 * Count of allow/deny "rules" derived from per-tool attribution. Mirrors
 * AllowDenyView's grouping logic — explicit allows + every deny (including
 * the SDK-default-deny tail, which the operator still wants to know about).
 */
function countAllowDenyRules(tools: { allowed: boolean; denied: boolean; rulingScope: string }[]) {
  let n = 0;
  for (const t of tools) {
    if (t.denied) n += 1;
    else if (t.allowed && t.rulingScope !== 'default') n += 1;
  }
  return n;
}

function hasLocalHook(hooks: { scope: 'user' | 'project' | 'local' }[]): boolean {
  return hooks.some((h) => h.scope === 'local');
}
