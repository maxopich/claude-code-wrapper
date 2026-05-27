import { useMemo } from 'react';
import type { ToolView } from '@cebab/shared/protocol';

// Cluster B Phase 6c (UI-B16 / B17 / B19 / spec §4.3 + §6.4 F2): allow/deny
// rule inspector.
//
// The shape we render is derived from the per-tool ToolView's resolver
// attribution rather than from raw allow/deny rules — Phase 3's resolver
// already merges all three scopes (user / project / local) per-tool and
// reports the `rulingScope` of whichever layer's rule actually won. So:
//
//   - Allow pane = tools with `allowed === true && rulingScope !== 'default'`
//     (the tool is explicitly allowed by SOME layer, not just the SDK's
//     fallback rule).
//   - Deny pane  = tools with `denied === true`. Default-deny (rulingScope
//     === 'default') is rendered with the explicit "SDK default deny" tag —
//     §6.4's load-bearing divergence #1, surfacing the agentic-reviewer's
//     "denied by SDK not in any visible deny list" anti-pattern.
//
// Per UI-B19, an empty pane renders explicit copy ("(none configured)")
// rather than blank space — operators need to know "no rules exist" vs
// "rules might exist but we didn't get them".
//
// Per UI-B17, rule provenance is communicated by the scope chip on each
// row — no row-background coloring (the spec calls this out explicitly:
// chips, never row tint).
//
// Per UI-B16, render two side-by-side panes; the consumer mounts the view
// inside an <AuthoritySection> wrapper. CSS handles the responsive flip to
// stacked tabs below the `sm` breakpoint via media query.
//
// We do NOT render an "Open settings.json" deep-link button here (UI-B18) —
// that affordance lives in the McpServersList card per the spec's split,
// and the per-scope path isn't on ToolView anyway. Phase 6e's placement
// integration may revisit.

const SCOPE_LABEL: Record<ToolView['rulingScope'], string> = {
  user: 'user',
  project: 'project',
  local: 'local',
  default: 'sdk default',
};

const SCOPE_CHIP_CLASS: Record<ToolView['rulingScope'], string> = {
  user: 'allow-deny-scope-user',
  project: 'allow-deny-scope-project',
  local: 'allow-deny-scope-local',
  default: 'allow-deny-scope-default',
};

export function AllowDenyView(props: { tools: ToolView[] }) {
  const { tools } = props;
  const { allowRows, denyRows, defaultDenyCount } = useMemo(() => {
    const allow: ToolView[] = [];
    const deny: ToolView[] = [];
    let dflt = 0;
    for (const t of tools) {
      if (t.denied) {
        deny.push(t);
        if (t.rulingScope === 'default') dflt += 1;
      } else if (t.allowed && t.rulingScope !== 'default') {
        // Only explicit allows — implicit/default allows aren't a "rule" the
        // operator configured.
        allow.push(t);
      }
    }
    // Stable alpha sort for both panes.
    allow.sort((a, b) => a.name.localeCompare(b.name));
    deny.sort((a, b) => a.name.localeCompare(b.name));
    return { allowRows: allow, denyRows: deny, defaultDenyCount: dflt };
  }, [tools]);

  return (
    <div className="allow-deny-view">
      <Pane title="Allowed (explicit)" rows={allowRows} variant="allow" />
      <Pane
        title="Denied"
        rows={denyRows}
        variant="deny"
        footerHint={
          defaultDenyCount > 0
            ? `${defaultDenyCount} denied via SDK default (no visible rule matched) — see Tools section for per-tool detail.`
            : undefined
        }
      />
    </div>
  );
}

function Pane(props: {
  title: string;
  rows: ToolView[];
  variant: 'allow' | 'deny';
  footerHint?: string;
}) {
  const { title, rows, variant, footerHint } = props;
  return (
    <div className={`allow-deny-pane allow-deny-pane-${variant}`}>
      <header className="allow-deny-pane-header">
        <span className="allow-deny-pane-title">{title}</span>
        <span className="allow-deny-pane-count">{rows.length}</span>
      </header>
      {rows.length === 0 ? (
        <div className="allow-deny-pane-empty">
          {variant === 'allow' ? 'Allow: (none configured)' : 'Deny: (none configured)'}
        </div>
      ) : (
        <ul className="allow-deny-pane-list">
          {rows.map((t) => (
            <li key={`${variant}:${t.name}`} className="allow-deny-row">
              <code className="allow-deny-name">{t.name}</code>
              <span
                className={`allow-deny-scope-chip ${SCOPE_CHIP_CLASS[t.rulingScope]}`}
                aria-label={`ruling scope: ${SCOPE_LABEL[t.rulingScope]}`}
              >
                {SCOPE_LABEL[t.rulingScope]}
              </span>
            </li>
          ))}
        </ul>
      )}
      {footerHint && <div className="allow-deny-pane-hint">{footerHint}</div>}
    </div>
  );
}
