/**
 * Cluster E Phase 1 (E1): single source of truth for the Cebab-local
 * slash commands. The quick-row buttons (`SlashCommandButtons.tsx`) and
 * the discovery palette (`SlashCommandPalette.tsx`) both read from this
 * registry — adding a Cebab-local command here makes it visible in both
 * surfaces with no other edits.
 *
 * "Cebab-local" means: a command Cebab knows the operator can usefully
 * invoke (covered by Claude Code's CLI today). The SDK additionally
 * exposes the full per-project list via `session_started.slashCommands[]`
 * (Cluster B Phase 2 forwarded that field). The palette merges that
 * SDK-discovered list as a separate source group at render time.
 *
 * **Adding a command:** append a `SlashCommand` to `SLASH_COMMANDS`. Use
 * a stable `command` literal (leading slash, no whitespace); pick a
 * concise `label` for buttons; write a one-line `description` for the
 * palette tooltip / search match. The `source` is always 'cebab' here.
 *
 * **Auditing note (per spec §7):** context-mutating commands
 * (`/compact`, `/init`, `/update-config`, `/loop`) MUST write
 * `safety_audit` rows on dispatch. The server-side detection lives in
 * `ws/server.ts` send_message handler; the audit emission is part of a
 * later phase (E1.x). The registry here is the source of truth for the
 * vocabulary; the audit side reads the same list to decide which
 * commands trigger the dual-write.
 */

export type SlashCommandSource = 'cebab' | 'sdk';

export type SlashCommand = {
  /** Wire payload — the exact text sent on `send_message` (e.g. `/compact`). */
  command: string;
  /** Display label for the quick-row buttons (usually identical to `command`). */
  label: string;
  /** One-line description shown in the palette + as a button title attribute. */
  description: string;
  /** Where this command came from. Cebab-local has buttons; SDK-discovered is palette-only. */
  source: SlashCommandSource;
};

/**
 * The Cebab-local list — the commands the operator can reach via the
 * always-visible quick-row buttons. The palette renders these in a "Cebab
 * quick commands" section and the SDK-discovered list in a "Discovered from
 * session" section underneath.
 *
 * `Cebab-6bny`: MEASURED LIVE, 2026-09-15, one turn per command against a real
 * session. Four of the five worked and `/skills` did not:
 *
 *   /context  → the context-usage table
 *   /compact  → subscription usage summary
 *   /mcp      → "No MCP servers are configured…" + its usage line
 *   /cost     → session and weekly usage
 *   /skills   → "/skills isn't available in this environment."
 *
 * The CLI's headless dispatcher refuses `local-jsx` commands — the interactive
 * ones that render their own UI — and every Cebab turn is non-interactive. So
 * the button could never do what it said, and it was shipped in the row that is
 * always on screen.
 *
 * BEFORE ADDING ONE HERE, SPEND THE TURN. The list is a hand-maintained copy of
 * someone else's command table, and this is the failure mode that copy has:
 * reading the CLI bundle is not enough (an attempt to settle these five from
 * the shipped binary returned a type for `/context` that the live run
 * contradicts, because the declarations sit close enough together to straddle
 * any fixed-size window). One real turn per command is cheap and decisive.
 */
export const SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
  {
    command: '/context',
    label: '/context',
    description: 'Show context-window usage breakdown',
    source: 'cebab',
  },
  {
    command: '/compact',
    label: '/compact',
    description: 'Compact the conversation to free context',
    source: 'cebab',
  },
  {
    command: '/mcp',
    label: '/mcp',
    description: 'MCP server connection status',
    source: 'cebab',
  },
  {
    command: '/cost',
    label: '/cost',
    description: 'Show session cost and usage',
    source: 'cebab',
  },
];

/**
 * Build the SDK-discovered set as `SlashCommand[]`. Filters out anything
 * already in the Cebab-local registry (the palette renders each command
 * once; a Cebab-local also exposed by the SDK shouldn't duplicate). The
 * SDK payload is plain string names today (per `session_started`); the
 * description is left empty pending E2 / a future `/help` probe.
 */
export function buildSdkSlashCommands(sdkNames: readonly string[] | undefined): SlashCommand[] {
  if (!sdkNames || sdkNames.length === 0) return [];
  const cebabSet = new Set(SLASH_COMMANDS.map((c) => c.command));
  const out: SlashCommand[] = [];
  for (const raw of sdkNames) {
    const command = raw.startsWith('/') ? raw : `/${raw}`;
    if (cebabSet.has(command)) continue;
    out.push({
      command,
      label: command,
      description: '',
      source: 'sdk',
    });
  }
  // Stable alphabetical order so consecutive renders don't shuffle.
  out.sort((a, b) => a.command.localeCompare(b.command));
  return out;
}

/**
 * Plain-substring filter (case-insensitive) over command + description.
 * Matches the §6 ui-agent contract: "Filter is plain substring on
 * command + description, debounced ≤50ms" — debouncing is the caller's
 * responsibility; this function is pure.
 */
export function filterSlashCommands(list: readonly SlashCommand[], query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...list];
  return list.filter((c) => {
    const hay = `${c.command} ${c.description}`.toLowerCase();
    return hay.includes(q);
  });
}
