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
 * - Trusted projects auto-allow everything (the project's Trust toggle is the
 *   user's blanket "I vouch for this directory" gate).
 * - Untrusted + `'acceptEdits'` auto-allows file-edit tools only.
 * - Untrusted + `'default'` always asks.
 *
 * The SDK's built-in `acceptEdits` handling does NOT run when a `canUseTool`
 * callback is provided — the SDK delegates all gating to the callback. So this
 * helper is the only place auto-allow lives for non-trusted projects.
 */
export function shouldAutoAllow(
  trusted: boolean,
  mode: SessionPermissionMode,
  toolName: string,
): boolean {
  if (trusted) return true;
  return mode === 'acceptEdits' && FILE_EDIT_TOOLS.has(toolName);
}
