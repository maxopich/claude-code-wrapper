import { useEffect, useMemo, useRef, useState } from 'react';
import type { McpServerView, ToolView } from '@cebab/shared/protocol';

// Cluster B Phase 6b + Phase 10 (UI-B4 / B10 / B11 / B12 / B31 / B33 / B34):
// the inspector's Tools section.
//
// Two modes:
//   - `mode: 'list'` (default; Phase 6b) — flat catalog of every tool on
//     the SDK surface, sorted alphabetically, with provenance + risk
//     badges. Used for the pre-flight inspector where nothing has run yet.
//   - `mode: 'usage-diff'` (Phase 10 / UI-B31) — same row chrome plus
//     per-tool Used / Attempted-but-denied count chips, and a filter
//     toggle (All / Used / Unused / Attempted). Populated from
//     `ToolView.calledCount` / `deniedCount` which the server tallies
//     in `tallyToolUsage()` (server/src/repo/project_authority.ts) by
//     aggregating tool_use blocks + permission_decided rows in the
//     project's persisted events.
//
// Why one row + chips rather than three physical columns (UI-B31 literal
// reading): scanning three parallel lists for the same tool is operator-
// hostile — they want "what did Bash do?" answered in one place. The chips
// + toggle deliver the same Available/Used/Attempted information at higher
// density without forcing a triple lookup. The "Attempted" chip is the red
// signal-of-interest per UI-B31; the "Used" chip is accent-tinted.
//
// Default toggle by panel mode (per spec §6.6): preflight = 'all',
// in-session = 'all', post-run = 'attempted' (operator's first triage
// question is "what did we try that bounced?").
//
// Rendering rules:
//   - UI-B10: alphabetical (no source-grouping that hides effectively-
//     unavailable tools at the bottom).
//   - UI-B10: each row carries a source chip (builtin / mcp / cebab-injected)
//     AND a risk badge (read / mutate / dangerous) — icon+text, never color-
//     only (a11y per UI-B10's explicit requirement).
//   - UI-B11: search filters name + source + mcpServer. Debounced ≤100ms.
//   - UI-B12: per-tool `<details>` lazy body — provenance + scope + reasons
//     are only mounted when expanded. Cheap on first paint with 100+ tools.
//   - UI-B6 (BE-B6): tools whose owning MCP server status is needs-auth get
//     a small effectively-unavailable hint inline (the resolver also flips
//     `ToolView.allowed = false` for them, but the per-row label lets the
//     operator understand WHY rather than just THAT).
//   - UI-B33: ArrowUp/Down navigate rows; Home/End jump to first/last;
//     Enter expands the focused row's <details>.
//
// Effective vs Configured (spec §6.4 — agentic-reviewer's load-bearing
// invariant): the rendered "effective" axis is `allowed && !denied` after
// the resolver's full merge. The expanded body shows `rulingScope` so the
// operator can trace WHY (e.g. "denied at scope=project — see
// project's settings.json").

type Risk = 'read' | 'mutate' | 'dangerous';

const MUTATE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Patch', 'WriteFile']);
const DANGEROUS_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell', 'KillBash']);

function classifyRisk(t: ToolView): Risk {
  if (DANGEROUS_TOOLS.has(t.name)) return 'dangerous';
  if (MUTATE_TOOLS.has(t.name)) return 'mutate';
  // MCP tools are conservatively 'read' unless we know better — the SDK
  // doesn't ship a schema, so we can't infer side-effects. Phase 3
  // resolver's denied/allowed flags still apply; this is just the badge.
  // A future v1.1 may add an explicit `t.risk` field.
  return 'read';
}

const RISK_LABEL: Record<Risk, string> = {
  read: 'read',
  mutate: 'mutate',
  dangerous: 'dangerous',
};

function riskGlyph(r: Risk): string {
  if (r === 'dangerous') return '!';
  if (r === 'mutate') return '✎';
  return '👁';
}

// Filter that powers UI-B11. Match against tool name, source name, owning
// MCP server name. Case-insensitive.
function makeMatcher(query: string): (t: ToolView) => boolean {
  const q = query.trim().toLowerCase();
  if (!q) return () => true;
  return (t) => {
    if (t.name.toLowerCase().includes(q)) return true;
    if (t.source.toLowerCase().includes(q)) return true;
    if (t.mcpServer && t.mcpServer.toLowerCase().includes(q)) return true;
    return false;
  };
}

export type UsageToggle = 'all' | 'used' | 'unused' | 'attempted';

export type ToolsListProps = {
  tools: ToolView[];
  mcpServers: McpServerView[];
  /** 'list' = Phase 6b shape. 'usage-diff' = Phase 10 (UI-B31). */
  mode?: 'list' | 'usage-diff';
  /**
   * Initial toggle state when `mode === 'usage-diff'`. AuthorityPanel
   * picks this per its own mode (preflight=all, in-session=all,
   * post-run=attempted). Ignored when `mode === 'list'`.
   */
  defaultUsageToggle?: UsageToggle;
};

function passesUsageToggle(t: ToolView, toggle: UsageToggle): boolean {
  const used = (t.calledCount ?? 0) > 0;
  const denied = (t.deniedCount ?? 0) > 0;
  switch (toggle) {
    case 'all':
      return true;
    case 'used':
      return used;
    case 'unused':
      // Unused = surfaced but never called AND never explicitly denied.
      // A tool the operator denied isn't "unused" — it was tried.
      return !used && !denied;
    case 'attempted':
      // The red-signal column: operator tried it, was bounced. ZERO is
      // healthy (per spec §6.6).
      return denied;
  }
}

export function ToolsList(props: ToolsListProps) {
  const { tools, mcpServers, mode = 'list', defaultUsageToggle = 'all' } = props;
  const [rawQuery, setRawQuery] = useState('');
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState<number>(-1);
  const [usageToggle, setUsageToggle] = useState<UsageToggle>(defaultUsageToggle);
  const listRef = useRef<HTMLDivElement>(null);

  // UI-B11: debounce ≤100ms. Avoids re-running the alphabetize+filter on
  // every keystroke for long lists.
  useEffect(() => {
    const handle = window.setTimeout(() => setQuery(rawQuery), 80);
    return () => window.clearTimeout(handle);
  }, [rawQuery]);

  // BE-B6: needs-auth servers cascade unavailable into their tools.
  const needsAuthServers = useMemo(
    () => new Set(mcpServers.filter((m) => m.status === 'needs-auth').map((m) => m.name)),
    [mcpServers],
  );

  const filtered = useMemo(() => {
    const matcher = makeMatcher(query);
    const out = tools.filter(matcher).slice();
    out.sort((a, b) => a.name.localeCompare(b.name));
    if (mode === 'usage-diff') {
      return out.filter((t) => passesUsageToggle(t, usageToggle));
    }
    return out;
  }, [tools, query, mode, usageToggle]);

  // Cluster B Phase 10: aggregate counts feed the toggle button labels so
  // the operator sees "Used (4)" not just "Used" before clicking. The
  // numbers stay stable across the filter (we count against unfiltered
  // tools, not the post-toggle subset).
  const usageCounts = useMemo(() => {
    if (mode !== 'usage-diff') return null;
    let used = 0;
    let unused = 0;
    let attempted = 0;
    for (const t of tools) {
      const u = (t.calledCount ?? 0) > 0;
      const d = (t.deniedCount ?? 0) > 0;
      if (u) used += 1;
      else if (!d) unused += 1;
      if (d) attempted += 1;
    }
    return { all: tools.length, used, unused, attempted };
  }, [tools, mode]);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (filtered.length === 0) return;
    const last = filtered.length - 1;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => (i < 0 ? 0 : Math.min(last, i + 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => (i <= 0 ? 0 : i - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIdx(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIdx(last);
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      // Toggle the active row's <details>.
      const el = listRef.current?.querySelectorAll('details.tool-row')[activeIdx];
      if (el instanceof HTMLDetailsElement) {
        el.open = !el.open;
        e.preventDefault();
      }
    }
  }

  return (
    <div className="tools-list-root">
      <div className="tools-list-controls">
        <input
          type="text"
          // Native role for a free-text search input — paired with aria-controls
          // so screen readers know the list below is what's being narrowed.
          role="searchbox"
          aria-controls="authority-tools-results"
          aria-label="Filter tools by name, source, or MCP server"
          placeholder="Filter tools…"
          className="tools-list-search"
          value={rawQuery}
          onChange={(e) => setRawQuery(e.target.value)}
        />
        <span className="tools-list-counts">
          {filtered.length} of {tools.length}
        </span>
      </div>
      {mode === 'usage-diff' && usageCounts && (
        <div className="tools-list-usage-toggle" role="group" aria-label="Filter by usage state">
          {(['all', 'used', 'unused', 'attempted'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`tools-list-usage-toggle-btn ${
                usageToggle === t ? 'tools-list-usage-toggle-btn-active' : ''
              } ${t === 'attempted' ? 'tools-list-usage-toggle-btn-attempted' : ''}`}
              aria-pressed={usageToggle === t}
              onClick={() => setUsageToggle(t)}
            >
              {t === 'all'
                ? 'All'
                : t === 'used'
                  ? 'Used'
                  : t === 'unused'
                    ? 'Unused'
                    : 'Attempted'}
              <span className="tools-list-usage-toggle-count" aria-hidden="true">
                {usageCounts[t]}
              </span>
            </button>
          ))}
        </div>
      )}
      <div
        ref={listRef}
        id="authority-tools-results"
        className="tools-list"
        role="list"
        tabIndex={0}
        onKeyDown={onKeyDown}
        aria-activedescendant={activeIdx >= 0 ? `tool-row-${activeIdx}` : undefined}
      >
        {filtered.length === 0 ? (
          <div className="tools-list-empty">No tools match this filter.</div>
        ) : (
          filtered.map((t, idx) => {
            const risk = classifyRisk(t);
            const isEffectivelyUnavailable =
              !t.allowed ||
              t.denied ||
              (t.source === 'mcp' && t.mcpServer ? needsAuthServers.has(t.mcpServer) : false);
            const reason =
              t.denied && t.rulingScope !== 'default'
                ? `denied (scope: ${t.rulingScope})`
                : t.denied
                  ? 'denied (no visible rule — SDK default deny)'
                  : !t.allowed
                    ? 'not allowed'
                    : t.source === 'mcp' && t.mcpServer && needsAuthServers.has(t.mcpServer)
                      ? `mcp server needs-auth: ${t.mcpServer}`
                      : null;
            // Phase 10: usage-diff per-row chrome. The chips render in
            // both modes (when counts are present), but the toggle UI and
            // stripe accent only apply to usage-diff. A `used` row gets
            // an `--ok-soft` left stripe (UI-B30 alignment); an
            // `attempted` row gets `--err-soft` — the red signal-of-
            // interest column.
            const used = (t.calledCount ?? 0) > 0;
            const attempted = (t.deniedCount ?? 0) > 0;
            const stripeClass =
              mode === 'usage-diff'
                ? attempted
                  ? 'tool-row-stripe-attempted'
                  : used
                    ? 'tool-row-stripe-used'
                    : ''
                : '';
            return (
              <details
                key={t.name}
                id={`tool-row-${idx}`}
                className={`tool-row ${isEffectivelyUnavailable ? 'tool-row-unavailable' : ''} ${
                  idx === activeIdx ? 'tool-row-active' : ''
                } ${stripeClass}`}
                role="listitem"
              >
                <summary className="tool-row-summary">
                  <span className="tool-row-name">{t.name}</span>
                  <span
                    className={`mutation-badge mutation-badge-${risk}`}
                    aria-label={`risk: ${RISK_LABEL[risk]}`}
                    title={`Risk class: ${RISK_LABEL[risk]}`}
                  >
                    <span aria-hidden="true">{riskGlyph(risk)}</span>
                    {RISK_LABEL[risk]}
                  </span>
                  <span
                    className={`tool-row-source tool-row-source-${t.source}`}
                    aria-label={`source: ${t.source}`}
                    title={t.mcpServer ? `MCP server: ${t.mcpServer}` : `Source: ${t.source}`}
                  >
                    {t.source}
                    {t.mcpServer && <span className="tool-row-mcp-server">·{t.mcpServer}</span>}
                  </span>
                  {/* Chips only render in usage-diff mode; preflight stays
                   *  a pure catalog view even if counts happen to be
                   *  populated (e.g. a Refresh after a previous run). */}
                  {mode === 'usage-diff' && used && (
                    <span
                      className="tool-row-usage-chip tool-row-usage-chip-used"
                      aria-label={`used ${t.calledCount} times`}
                      title={`Called ${t.calledCount} time${t.calledCount === 1 ? '' : 's'}`}
                    >
                      used ×{t.calledCount}
                    </span>
                  )}
                  {mode === 'usage-diff' && attempted && (
                    <span
                      className="tool-row-usage-chip tool-row-usage-chip-attempted"
                      aria-label={`denied ${t.deniedCount} times`}
                      title={`Operator denied ${t.deniedCount} request${t.deniedCount === 1 ? '' : 's'}`}
                    >
                      denied ×{t.deniedCount}
                    </span>
                  )}
                  {isEffectivelyUnavailable && (
                    <span
                      className="tool-row-unavailable-badge"
                      aria-label="effectively unavailable"
                    >
                      unavailable
                    </span>
                  )}
                </summary>
                <dl className="tool-row-body">
                  <div className="tool-row-fact">
                    <dt>Allowed</dt>
                    <dd>{t.allowed ? 'yes' : 'no'}</dd>
                  </div>
                  <div className="tool-row-fact">
                    <dt>Denied</dt>
                    <dd>{t.denied ? 'yes' : 'no'}</dd>
                  </div>
                  <div className="tool-row-fact">
                    <dt>Ruling scope</dt>
                    <dd>
                      <code>{t.rulingScope}</code>
                      {t.rulingScope === 'default' && (
                        <span className="tool-row-hint">
                          {' '}
                          (SDK default — no visible rule matched)
                        </span>
                      )}
                    </dd>
                  </div>
                  {reason && (
                    <div className="tool-row-fact">
                      <dt>Reason</dt>
                      <dd className="tool-row-reason">{reason}</dd>
                    </div>
                  )}
                  {/* Phase 10: Used / Denied counts in the expandable
                   *  body so a screen reader user can navigate to the
                   *  facts without the chip clutter, and so the operator
                   *  drilling into a denied row can see the exact tally. */}
                  {typeof t.calledCount === 'number' && (
                    <div className="tool-row-fact">
                      <dt>Used</dt>
                      <dd>{t.calledCount}</dd>
                    </div>
                  )}
                  {typeof t.deniedCount === 'number' && (
                    <div className="tool-row-fact">
                      <dt>Denied by operator</dt>
                      <dd>{t.deniedCount}</dd>
                    </div>
                  )}
                </dl>
              </details>
            );
          })
        )}
      </div>
    </div>
  );
}
