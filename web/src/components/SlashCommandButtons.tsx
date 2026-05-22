/**
 * Quick-access buttons for the Claude Code slash commands the operator
 * uses most while managing a session. Each button dispatches the same
 * `send_message{text: "/command"}` the user would get by typing it — the
 * CLI parses the slash and returns a synthetic `assistant` message which
 * the server translates into a `command_output` ServerMsg.
 *
 * The intent is convenience; everything is also typeable. We pick the
 * commands the operator can't do from elsewhere in the Cebab UI:
 *   /context — context-window usage card
 *   /compact — compact conversation (emits a `compact_boundary`)
 *   /skills  — list available skills with token costs
 *   /mcp     — MCP server connect status
 *   /cost    — running session cost + usage breakdown
 */
const COMMANDS: { label: string; command: string; title: string }[] = [
  { label: '/context', command: '/context', title: 'Show context-window usage breakdown' },
  { label: '/compact', command: '/compact', title: 'Compact the conversation to free context' },
  { label: '/skills', command: '/skills', title: 'List available skills' },
  { label: '/mcp', command: '/mcp', title: 'MCP server connection status' },
  { label: '/cost', command: '/cost', title: 'Show session cost and usage' },
];

export function SlashCommandButtons(props: { disabled?: boolean; onSend: (text: string) => void }) {
  return (
    <div className="slash-commands" role="group" aria-label="Session commands">
      {COMMANDS.map((c) => (
        <button
          key={c.command}
          className="slash-command-btn"
          disabled={props.disabled}
          title={c.title}
          onClick={() => props.onSend(c.command)}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
