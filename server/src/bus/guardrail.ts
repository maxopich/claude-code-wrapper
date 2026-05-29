/**
 * Cluster F Phase D5+: per-mutation guardrail-violation classifier.
 *
 * Pure function over (agentCwd, filePath). Used by the bus runner's
 * stream tap (see `runner.ts`'s `runOneAttempt` mutation-classification
 * loop) to decide whether a worker's Write/Edit/MultiEdit/NotebookEdit
 * targets a path inside the agent's own project folder.
 *
 * The consultant-mode prompt baked into `runtime.ts`'s
 * `renderRosterPrompt` / `renderWorkerBriefing` tells every bus
 * participant to read/analyze/advise and NOT mutate files outside its
 * own project folder unless the operator's relayed request explicitly
 * directs that change. The constraint is purely advisory — the model
 * interprets the prompt, and Cebab can't deny tool calls in the bus
 * (workers run with `bypassPermissions`). This classifier surfaces
 * violations post-hoc so the operator sees them.
 *
 * Why server-side and not in `shared/`: path resolution depends on
 * `node:path` (`resolve`, `sep`) and `~` expansion depends on
 * `node:os` (`homedir`). The web doesn't need to run this — the wire
 * envelope (`MultiAgentMutationView.guardrailViolation`) carries the
 * already-classified verdict; the client just renders the badge.
 *
 * The classifier is intentionally conservative — it only flags as
 * out-of-scope when the resolved path is definitively outside the
 * agent's cwd. Edge cases it does NOT try to handle:
 *   - Symlinks: it does NOT follow links (cheap to do, but
 *     `realpathSync` would block on the read and isn't a sandbox
 *     property — if the link points back inside the cwd it's still
 *     reading another file outside, so the symlink situation is
 *     murky regardless). The path-as-given is what's compared.
 *   - Bash commands: callers pass `filePath: undefined` when the tool
 *     has no canonical file argument; the classifier returns `inScope:
 *     true` (no signal). Bash commands that touch arbitrary files
 *     aren't auto-classified — `classifyBashCommand` is for severity
 *     (read/mutate/dangerous) only, not for path scoping. A future
 *     slice could add Bash-command path inference (parse first arg of
 *     `mv`/`cp`/`rm`), but the current scope keeps the classifier
 *     pure-function and avoids the parsing rabbit hole.
 */

import { resolve, sep } from 'node:path';
import { homedir } from 'node:os';

/**
 * Stable reason-code enum for guardrail violations. Wire-visible — used
 * as the `reasonCode` on the safety_audit row and as the `reason` field
 * on the persisted `multi_agent_mutations.guardrail_reason` column.
 * Open-ended `string` at the persistence layer so future sub-cases
 * (system paths, dotfiles, cross-participant) extend without a
 * migration; this enum names the cases currently emitted.
 */
export type GuardrailReasonCode =
  /** Resolved file path falls outside the agent's project folder. */
  'path_outside_cwd';

export type GuardrailScopeResult =
  /** In-scope: either the tool has no file-path argument (Bash/Task) OR
   *  the resolved target lives inside the agent's cwd. No signal. */
  | { inScope: true }
  /** Out-of-scope: violation. Carries the resolved absolute path and the
   *  reason code so the dispatcher + UI can name what was targeted. */
  | { inScope: false; resolvedPath: string; reasonCode: GuardrailReasonCode };

/**
 * Classify a tool call's path scope against the agent's cwd.
 *
 * Returns `{ inScope: true }` for:
 *   - Missing/empty `filePath` (tool has no file-target — Bash, bus_send, etc.)
 *   - Resolved path equal to `agentCwd`
 *   - Resolved path strictly inside `agentCwd` (with separator boundary)
 *
 * Returns `{ inScope: false, resolvedPath, reasonCode }` when the
 * resolved path is anywhere else (sibling project, /etc, /tmp, the
 * orchestrator's Cebab-owned session folder, etc.).
 *
 * The `~` shorthand in the input filePath is expanded to the server
 * process's `os.homedir()` before resolution. Relative paths are
 * resolved against `agentCwd` (mirroring the SDK / shell convention
 * that paths are relative to the agent's working directory).
 */
export function classifyMutationScope(opts: {
  agentCwd: string;
  filePath: string | null | undefined;
}): GuardrailScopeResult {
  // Tool calls with no canonical file-target (Bash, bus_send, Task) get
  // a free pass at this layer. Bash path inference is intentionally out
  // of scope (see header comment).
  if (!opts.filePath) return { inScope: true };

  // The agent cwd is the trust anchor. If it's empty or non-absolute
  // (defensive — should never happen in production; specs set cwd to the
  // project's absolute path), fail open: classify as in-scope. A
  // misconfigured cwd shouldn't fire false positives across every
  // mutation.
  const cwd = opts.agentCwd;
  if (!cwd) return { inScope: true };

  const expanded = expandHome(opts.filePath);
  const resolved = resolve(cwd, expanded);
  const resolvedCwd = resolve(cwd);

  // Equality check first — the agent writing into its cwd root counts as
  // in-scope. Then the prefix check uses the platform's separator to
  // avoid the classic `/foo` matching `/foobar` substring bug
  // (`/foo` + sep = `/foo/`, which doesn't prefix-match `/foobar`).
  if (resolved === resolvedCwd) return { inScope: true };
  const prefix = resolvedCwd.endsWith(sep) ? resolvedCwd : resolvedCwd + sep;
  if (resolved.startsWith(prefix)) return { inScope: true };

  return {
    inScope: false,
    resolvedPath: resolved,
    reasonCode: 'path_outside_cwd',
  };
}

/**
 * Expand a leading `~` to the server process's home directory. Mirrors
 * the shell convention. `~user` (other-user home expansion) is NOT
 * supported — that's a glibc-ism and we only need to handle the
 * Claude-CLI-shaped paths agents typically pass.
 */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return homedir() + p.slice(1);
  }
  return p;
}
