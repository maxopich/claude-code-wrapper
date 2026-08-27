# Chat and the composer

The composer is the box at the bottom of the chat where you type to the agent.
This page covers sending messages, the growable input, the slash-command
palette, how replies and tool cards render, approving tool calls, the
per-session permission pill, stopping a turn, and the turn counter.

## Sending a message

Type in the composer and press **Enter** to send. To add a newline instead of
sending, use **Shift+Enter**. **Cmd/Ctrl+Enter** also sends, as an alias for
Enter.

While a turn is running the composer stays enabled, so you can draft your next
message while the agent is still replying. It won't send mid-turn, though:
sending is blocked until the current turn finishes. The placeholder changes to
remind you — it reads "Claude is responding. Esc to stop — Enter sends once it
finishes." while a reply is in flight, and "Message Claude. Enter to send,
Shift+Enter for newline." when idle. An empty message never sends.

If the composer is greyed out entirely (not just running), it means something
structural is wrong — usually no project is selected or the workspace isn't
configured. A one-line reason appears just above the box telling you what to
fix.

## The growable composer

The input grows to fit what you type, up to a ceiling, after which it scrolls
internally. You can also resize it by hand using the drag handle on its **top**
edge — because the composer is pinned to the bottom of the window, dragging the
handle up makes the box taller. Its tooltip reads "Drag to resize, or focus and
use the arrow keys."

You can resize from the keyboard too: focus the handle and use the arrow keys.
**Arrow Up** grows the box, **Arrow Down** shrinks it, **Home** snaps to the
shortest height the text allows, and **End** goes to the tallest. The box can
never be shorter than the text currently in it.

## The slash-command palette

Cebab has a searchable palette of slash commands. Open it two ways:

- Type **/** in an empty composer (with the cursor at the very start). The `/`
  is captured to open the palette instead of being typed into the box.
- Press **Cmd/Ctrl+K** from anywhere in the composer, regardless of what you've
  already typed.

Once open, the palette has a filter that matches your text against each
command's name and description as a plain substring. Picking a command drops it
into the composer followed by a space — it does **not** send automatically, so
you can add context (for example a topic after the command) and press Send when
you're ready. Press **Esc** to close the palette without choosing anything.

### The five Cebab quick commands

Cebab ships five built-in commands, shown as a "Cebab quick commands" group in
the palette and also as always-visible quick buttons above the composer (each
button's tooltip is its description):

- **/context** — Show context-window usage breakdown
- **/compact** — Compact the conversation to free context
- **/skills** — List available skills
- **/mcp** — MCP server connection status
- **/cost** — Show session cost and usage

Clicking a quick button sends that command immediately; typing it (or picking it
from the palette) works exactly the same. The command's reply comes back as a
"command output" card in the chat.

### Commands discovered from your session

Beyond the five built-ins, the palette also lists any slash commands the
`claude` session reports for the current project, under a separate "Discovered
from session" group, sorted alphabetically. These vary by project — they're
whatever the CLI exposes for that session — and they're reachable only from the
palette, not the quick-button row. Anything already covered by a Cebab built-in
isn't duplicated.

## How replies and tool cards render

The agent's reply streams in live. While text is still arriving you'll see it
filling in under a "claude…" label with a blinking caret; once the turn's
message is complete it's replaced by the fully formatted (Markdown) version.

Within a reply you may see several kinds of block:

- **Text** — the agent's prose, rendered as Markdown.
- **Tool calls** — when the agent decides to use a tool, a small card shows the
  tool name and its inputs.
- **Thinking** — collapsed by default under a "thinking" toggle you can expand.
- **Tool output** — the result of a tool, shown in its own card. Long output is
  previewed (first several lines) with a "show all" toggle; a Copy button on
  the card always copies the complete output even when the display is truncated.

Every message has a hover-revealed Copy button. After a turn finishes, a small
footer line shows the outcome, the turn's cost, and how long it took.

## Approving or denying tool calls

When a project is **untrusted**, tool calls don't run on their own — each one
appears as an inline **permission card** in the chat with the tool name, a short
summary, and **Allow** / **Deny** buttons. The run pauses until you decide.
Riskier calls are flagged with a badge. When a project is **trusted**, edits are
auto-approved and no card appears.

If a card was decided without you — for example the turn was interrupted, or you
had disconnected — the card says so, noting the decision was automatic.

Trust is a per-project setting and it's the big lever over what asks versus what
runs freely (and what project files and MCP servers load). It's covered in full
in 04-permissions-trust-and-authority.md.

## The per-session permission pill

Above the chat is a **permissions** pill with two options, **ask** and
**auto-edits**. This controls the posture for the current session only:

- **ask** — every tool use asks first (you get a permission card).
- **auto-edits** — file edits and common shell commands are auto-allowed; the
  setting persists across turns until you toggle back.

You can flip it mid-session and it takes effect on the running session. It is
**independent of the project Trust setting**: it changes what gets asked, not
what the project loads. Switching it never loads or unloads a project's own
settings, MCP servers, or CLAUDE.md — only Trust does that. Because it's
per-session, it doesn't affect other projects or persist as a project default.
For how the pill interacts with Trust, and to inspect the fully resolved
settings, use the **Authority** link on the chip in the chat header
(its tooltip: "Click [Authority…] to inspect resolved settings.") and see
04-permissions-trust-and-authority.md.

## Stopping a running turn

To stop a turn in progress, click the **Stop** button (it replaces Send while
running; its tooltip is "Stop (Esc)"), or press **Esc** while the composer has
focus. **Cmd/Ctrl+.** also stops. Note that Esc first closes the slash palette
if it's open, and only stops the turn on a second press. The full list of keys
is in 13-shortcuts-and-commands.md.

## The turn counter and max-turns override

Each turn runs up to a maximum number of internal steps ("turns"). After a turn
finishes, a **Turns** chip in the header shows how many that last turn used
against the cap (for example 42/50), turning amber at or above 80% so you can
raise the cap before the next run hits it. It's a look-back at the last turn,
not a live meter.

Next to it is a small **Turns** number input — a per-send override, tooltip
"Per-turn max turns override (empty = default)". Type a number to raise or lower
the cap for just your next message; leave it empty to use the default (shown as
the placeholder). It clears itself after each send. If a turn does hit the cap,
the result card offers **Extend** buttons to bump the limit and continue.
