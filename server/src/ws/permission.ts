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
 * is now Cebab's to implement — so this is the ONLY place auto-allow lives for
 * single-agent runs, and `Options.permissionMode` does not grant it by itself.
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
