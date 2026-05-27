// Cluster B Phase 8 (UI-B41): the SlashCommandsList section of the
// AuthorityPanel.
//
// Data shape: `slashCommands: string[]` lands in `ProjectAuthority` straight
// from the SDK init payload (subtype `init`), forwarded verbatim by
// `server/src/ws/translate.ts` (Phase 2 BE-B1) and cached in the
// per-Conn `session_started` snapshot (Phase 3 BE-B3). The SDK ships the
// command names without the leading `/` in some shapes and with it in
// others — we normalise to always-prefixed at the render layer so the
// operator's mental model ("a slash command starts with /") matches the
// glyph they see.
//
// Why this matters: the operator's slash-command set is influenced by
//   - bundled CLI commands (`/help`, `/clear`, `/compact`, `/context`,
//     `/skills`, ...)
//   - per-project `.claude/commands/*.md` (when settingSources includes
//     'project') — a teammate or autocomplete-happy editor can land a
//     command file that silently extends the CLI's vocabulary
//   - plugin-contributed commands when plugins are loaded
//
// The init payload merges all of these into one flat array — the SDK
// doesn't expose origin per-command today. Origin-tier surfacing
// (which would let us flag project-local commands the same way HooksList
// flags `scope === 'local'` hooks) is deferred until the SDK ships
// per-command metadata or Cebab scans `.claude/commands/` directly.
//
// Render contract:
//   - Empty state: explicit copy explaining the (rare) zero-command case.
//   - Non-empty: alphabetical list, monospace `/name`, no per-item action.
//   - List is read-only — there's no "run this command" affordance here.
//     That belongs in the chat composer, not the authority surface.

export function SlashCommandsList(props: { commands: string[] }) {
  const { commands } = props;
  if (commands.length === 0) {
    return (
      <div className="auth-name-list-empty">
        No slash commands resolved by the SDK for this project.
      </div>
    );
  }
  // Alphabetical; stable across renders. Compare the normalised (always
  // slash-prefixed) form so `/foo` and `foo` sort consistently when the
  // SDK occasionally ships one without the leading slash.
  const sorted = [...commands].sort((a, b) => withSlash(a).localeCompare(withSlash(b)));
  return (
    <ul className="auth-name-list">
      {sorted.map((name) => (
        <li key={name} className="auth-name-list-item">
          <code className="auth-name-list-item-name">{withSlash(name)}</code>
        </li>
      ))}
    </ul>
  );
}

function withSlash(name: string): string {
  return name.startsWith('/') ? name : `/${name}`;
}
