// Cluster B Phase 8 (UI-B42): the SkillsList section of the AuthorityPanel.
//
// Data shape: `skills: string[]` is forwarded straight from the SDK init
// payload (Phase 2 BE-B1 extended `session_started`). Each entry is the
// Skill's name; the SDK does not currently expose origin tier
// (user vs project vs plugin) on a per-skill basis.
//
// UI-B42's full intent ("per-skill click expands to show origin tier when
// resolvable") is therefore partially deferred — we render the names today
// and reserve room for an expand affordance once Cebab observes a richer
// per-skill payload. The list still answers the most-asked operator
// question — "what does this Claude know how to do beyond Read/Edit?" —
// without waiting on that enrichment.
//
// Why surfacing skills matters even without origin tier:
//   - A Skill bundle declared at `.claude/skills/<name>/SKILL.md` in a
//     project's settings tree loads on every turn for trusted runs. It
//     can include hook + MCP configuration that auto-installs. The
//     operator wants to know which skill names made it past the trust
//     gate without scanning the skill files manually.
//   - Plugin-supplied skills (e.g. cebab-bundled adapters or a third-party
//     plugin) also appear here — they're a vector for behaviour change
//     between plugin versions.
//
// Render contract:
//   - Empty state: explicit copy noting the SDK didn't enumerate any.
//   - Non-empty: alphabetical, monospace; no per-item action today.

export function SkillsList(props: { skills: string[] }) {
  const { skills } = props;
  if (skills.length === 0) {
    return (
      <div className="auth-name-list-empty">
        No skills enumerated in the SDK init payload for this project.
      </div>
    );
  }
  const sorted = [...skills].sort((a, b) => a.localeCompare(b));
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
