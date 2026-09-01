import type { SessionPermissionMode } from '@cebab/shared/protocol';

/**
 * Tools auto-allowed when the session's `permissionMode` is `'acceptEdits'`.
 *
 * Mirrors the Claude CLI's "acceptEdits" semantics: file-edit operations run
 * without a card; everything else (Bash, WebFetch, etc.) still asks.
 *
 * Names are the runtime tool identifiers passed to `canUseTool` — the standard
 * Claude Code tool names, not the SDK's TS interface names (`FileEdit`, etc.).
 */
export const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'NotebookEdit']);

/**
 * Decide whether a tool call should auto-allow without a permission card.
 *
 *   mode `'default'`               → always asks, trusted or not.
 *   trusted + `'acceptEdits'`      → auto-allows everything.
 *   untrusted + `'acceptEdits'`    → auto-allows file-edit tools only.
 *
 * The SDK's built-in `acceptEdits` auto-approval does NOT fire when a
 * `canUseTool` callback is supplied — a tool the SDK has not already settled by
 * its own rules is routed to the callback instead. That is NOT "the SDK
 * delegates all gating to the callback": `allowedTools`/`disallowedTools` still
 * strip tools before the callback ever sees them, and a full-bypass permission
 * mode skips the callback entirely (a branch single-agent runs never take).
 * What IS true, and all this function relies on, is that acceptEdits' auto-allow
 * is now Cebab's to implement — so this is the only place *Cebab* auto-allows
 * for single-agent runs, and `Options.permissionMode` does not grant it by
 * itself.
 *
 * But do NOT read that as "a `false` return guarantees a permission card". The
 * CLI still settles some tool calls before `canUseTool` is ever consulted, and
 * those paths are not gated here:
 *   • `permissions.allow` rules in any LOADED settings file. The SDK ships this
 *     warning verbatim (builder `XEe` in `sdk.mjs`): "Allow rules from settings
 *     files can also shadow the callback but are not visible here." This is NOT
 *     Trust-gated — an untrusted project still loads `~/.claude/settings.json`
 *     under `settingSources: ['user']`, so a user-scope `"allow": ["Bash(*)"]`
 *     shadows the callback on every project, trusted or not.
 *   • The CLI's in-cwd read heuristic — measured in this repo: 83 `tool_use`
 *     Reads produced only 78 `permission_request` records across 25 real
 *     transcripts at `permissionMode: 'default'`, the 5 missing being exactly
 *     the reads inside the run's `cwd`.
 * On both paths the `tool_use` block still renders (the intended signal), but no
 * card is issued and no `permission_auto_allowed` wrapper event is persisted, so
 * the replay carries no record of the bypass. See `project_canusetool_not_universal`.
 *
 * WHY `'default'` IS CHECKED FIRST (Cebab-ws0.14). This used to open with
 * `if (trusted) return true`, so Trust short-circuited the mode entirely and a
 * trusted project auto-allowed everything no matter what the operator chose.
 * That was a deliberate design — Trust as a blanket "I vouch for this
 * directory" gate — and it had one consequence nobody had looked at: the
 * permissions pill is disabled only while a session is not live, never by
 * trust. So on a live trusted session the operator could press `ask`, watch the
 * pill move, watch the server persist and echo `default` — and every tool
 * still auto-allowed. The control moved and changed nothing.
 *
 * Trust now means "auto-allow everything **by default**" rather than "and you
 * may not ask me to stop". Nothing changes for anyone who leaves the pill
 * alone, because `seedPermissionMode` still seeds `acceptEdits` for a fresh
 * trusted session — the row that moved is only reachable by explicitly asking
 * for it. And it moves in the direction that adds permission cards, so it
 * cannot widen privilege; that is what made it safe to change rather than
 * merely disabling the control and calling the affordance honest.
 */
export function shouldAutoAllow(
  trusted: boolean,
  mode: SessionPermissionMode,
  toolName: string,
): boolean {
  if (mode === 'default') return false;
  if (trusted) return true;
  return FILE_EDIT_TOOLS.has(toolName);
}
