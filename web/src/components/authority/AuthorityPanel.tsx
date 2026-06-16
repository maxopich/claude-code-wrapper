import { useEffect, useState } from 'react';
import { readStored, writeStored } from '../../prefs';
import { useAuthorityActions, useAuthoritySlot, type AuthoritySlot } from './AuthorityContext';
import { AuthoritySection } from './AuthoritySection';
import { ModelIdentityCard } from './ModelIdentityCard';
import { ToolsList, type UsageToggle } from './ToolsList';
import { McpServersList } from './McpServersList';
import { AllowDenyView } from './AllowDenyView';
import { EnvScrubInspector } from './EnvScrubInspector';
import { HooksList } from './HooksList';
import { SlashCommandsList } from './SlashCommandsList';
import { SkillsList } from './SkillsList';
import { SubAgentsList } from './SubAgentsList';

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
//   - 'post-run'   — opened after a session ends. UI-B31 + spec §6.6:
//                    Tools section flips to mode='usage-diff' with the
//                    default toggle on "Attempted" (operator's first
//                    triage question is "what bounced?"). In-session
//                    also uses usage-diff but defaults the toggle to
//                    "All". Header reads "Authority — last run".
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
  /**
   * When true the whole panel can collapse to its header bar via a chevron
   * toggle, and the choice persists across reloads (key `cebab.authorityCollapsed`,
   * default collapsed). Only the inline in-session mount opts in — the preflight
   * modal and post-run review leave it off, so their DOM is unchanged.
   */
  collapsible?: boolean;
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

/**
 * Cluster B Phase 10 (UI-B31 / spec §6.6): map the panel's lifecycle
 * mode to the per-Tools usage-diff behaviour.
 *   - preflight  — list mode (no run; counts are all zero; the usage
 *                  toggle would be misleading clutter).
 *   - in-session — usage-diff mode, toggle defaults to 'all' (operator
 *                  is watching the session; survey view is most useful).
 *   - post-run   — usage-diff mode, toggle defaults to 'attempted' (the
 *                  red signal-of-interest column is the first triage
 *                  question after a session ends).
 */
function toolsModeForPanel(mode: AuthorityPanelMode): {
  mode: 'list' | 'usage-diff';
  defaultToggle: UsageToggle;
} {
  if (mode === 'preflight') return { mode: 'list', defaultToggle: 'all' };
  if (mode === 'post-run') return { mode: 'usage-diff', defaultToggle: 'attempted' };
  return { mode: 'usage-diff', defaultToggle: 'all' };
}

export function AuthorityPanel(props: AuthorityPanelProps) {
  const { projectId, mode, noAutoRequest = false, collapsible = false } = props;
  const slot = useAuthoritySlot(projectId);
  const { request } = useAuthorityActions();

  // Whole-panel collapse — opt-in. Default-collapsed so the operator's chat
  // scrollback owns the viewport on small displays; the choice persists. The
  // body stays mounted (hidden, not unmounted) so the cache + each section's
  // open/closed state survive a toggle, and the status line keeps ticking.
  const [collapsed, setCollapsed] = useState(() =>
    collapsible ? readStored('cebab.authorityCollapsed', true, (r) => r === 'true') : false,
  );
  useEffect(() => {
    if (collapsible) writeStored('cebab.authorityCollapsed', String(collapsed));
  }, [collapsible, collapsed]);

  // Auto-fire cache request on mount for any panel that hasn't loaded yet.
  // The reducer dedupes — if a previous mount already requested, it stays
  // in 'requesting' and this call is a no-op on the server (a re-request is
  // cheap; the WS handler returns the cached snapshot synchronously).
  useEffect(() => {
    if (noAutoRequest) return;
    if (slot.status === 'idle') request(projectId, 'cache');
  }, [projectId, slot.status, request, noAutoRequest]);

  const bodyId = `authority-body-${projectId}`;

  return (
    <section className={`authority-panel authority-panel-${mode}`} aria-label={headerForMode(mode)}>
      <header className="authority-panel-header">
        {collapsible && (
          <button
            type="button"
            className="icon-btn authority-panel-toggle"
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            aria-label={collapsed ? 'Expand project authority' : 'Collapse project authority'}
            onClick={() => setCollapsed((c) => !c)}
          >
            <span className="chev" aria-hidden="true">
              ▸
            </span>
          </button>
        )}
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
      {collapsible ? (
        <div id={bodyId} hidden={collapsed}>
          {renderBody(slot, mode)}
        </div>
      ) : (
        renderBody(slot, mode)
      )}
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
        <ToolsList
          tools={authority.tools}
          mcpServers={authority.mcpServers}
          mode={toolsModeForPanel(mode).mode}
          defaultUsageToggle={toolsModeForPanel(mode).defaultToggle}
        />
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
      {/* Phase 8 — UI-B41 / B42 / B43: the three name-only enumerations
       *  from the SDK init payload. All collapsed-by-default since their
       *  contents are read-only enumerations and the operator only digs
       *  in when triaging a specific question ("did /foo land?", "is
       *  this skill loaded?", "is sub-agent X declared?"). */}
      <AuthoritySection
        title="Slash commands"
        count={authority.slashCommands.length}
        sublabel={authority.slashCommands.length === 0 ? 'none enumerated' : undefined}
        defaultOpen={false}
      >
        <SlashCommandsList commands={authority.slashCommands} />
      </AuthoritySection>
      <AuthoritySection
        title="Skills"
        count={authority.skills.length}
        sublabel={authority.skills.length === 0 ? 'none enumerated' : undefined}
        defaultOpen={false}
      >
        <SkillsList skills={authority.skills} />
      </AuthoritySection>
      <AuthoritySection
        title="Sub-agents"
        count={authority.agents.length}
        sublabel={authority.agents.length === 0 ? 'none declared' : undefined}
        defaultOpen={false}
      >
        <SubAgentsList agents={authority.agents} />
      </AuthoritySection>
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
