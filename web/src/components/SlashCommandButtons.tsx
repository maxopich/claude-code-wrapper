import { SLASH_COMMANDS } from '../slashCommands';

/**
 * Quick-access buttons for the Claude Code slash commands the operator
 * uses most while managing a session. Each button dispatches the same
 * `send_message{text: "/command"}` the user would get by typing it — the
 * CLI parses the slash and returns a synthetic `assistant` message which
 * the server translates into a `command_output` ServerMsg.
 *
 * The intent is convenience; everything is also typeable (and as of
 * Cluster E Phase 1, every Cebab-local command + every SDK-discovered
 * command is also reachable via the `/`-triggered `SlashCommandPalette`).
 *
 * The vocabulary is the `'cebab'`-sourced entries of `SLASH_COMMANDS` in
 * `web/src/slashCommands.ts`. Adding a Cebab-local command there auto-
 * adds a button here without further edits.
 */
export function SlashCommandButtons(props: { disabled?: boolean; onSend: (text: string) => void }) {
  const buttonCommands = SLASH_COMMANDS.filter((c) => c.source === 'cebab');
  return (
    <div className="slash-commands" role="group" aria-label="Session commands">
      {buttonCommands.map((c) => (
        <button
          key={c.command}
          className="slash-command-btn"
          disabled={props.disabled}
          title={c.description}
          onClick={() => props.onSend(c.command)}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
