// Cluster B Phase 8 (UI-B43): the SubAgentsList section of the
// AuthorityPanel.
//
// Data shape: `agents: string[]` from the SDK init payload — the names
// of sub-agents declared at `~/.claude/agents/<name>.md` and / or the
// project's `.claude/agents/<name>.md` (when settingSources includes
// 'project'). The SDK does not currently emit per-sub-agent metadata
// beyond the name (no description, no tools list, no model override).
//
// UI-B43's full intent ("click jumps to that sub-agent's AuthorityPanel
// scope") is therefore deferred — Cebab doesn't model per-sub-agent
// authority today. A sub-agent inherits the parent project's authority
// at SDK level; only the per-agent prompt + tool subset differ, and
// that's invisible to Cebab. When per-agent metadata arrives on the
// wire we can extend this list to a navigation surface; for now it's
// pure enumeration.
//
// Why surfacing sub-agents matters even without per-agent navigation:
//   - The Task tool's `subagent_type` parameter is opaque to the
//     operator otherwise — they only see "the assistant invoked Task
//     with subagent_type=foo" and have no way to confirm `foo` is
//     actually declared in this project's scope.
//   - A sub-agent file checked into `.claude/agents/` by a teammate
//     auto-loads when the project is Trusted — same trust-tier risk as
//     hooks. The operator wants the list visible before they invoke
//     Task on an untrusted hunch.
//
// Render contract:
//   - Empty state: explicit copy noting none declared.
//   - Non-empty: alphabetical, monospace; no per-item action today.

export function SubAgentsList(props: { agents: string[] }) {
  const { agents } = props;
  if (agents.length === 0) {
    return (
      <div className="auth-name-list-empty">
        No sub-agents declared in this project&apos;s settings tree.
      </div>
    );
  }
  const sorted = [...agents].sort((a, b) => a.localeCompare(b));
  return (
    <ul className="auth-name-list">
      {sorted.map((name) => (
        <li key={name} className="auth-name-list-item">
          <code className="auth-name-list-item-name">{name}</code>
        </li>
      ))}
    </ul>
  );
}
