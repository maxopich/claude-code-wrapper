/**
 * Per-mutation guardrail-violation classifier: a pure function over
 * (agentCwd, filePath) deciding whether a worker's Write/Edit/MultiEdit/
 * NotebookEdit targets a path inside the agent's own project folder. Called
 * from the bus runner's stream tap (`runner.ts`, `runOneAttempt`).
 *
 * WHY IT IS ADVISORY, since the obvious reading is wrong: it is NOT that the
 * bus runs headless. Both routers wire `onAskUserQuestion` (`orchestrator.ts` /
 * `chain.ts`), so every production bus turn runs `permissionMode: 'default'`
 * with a live `canUseTool` — the `bypassPermissions` branch in `runner.ts` is
 * reached only by callers that skip the hook, i.e. tests. The gate exists; it
 * just returns `allow` for every tool except `AskUserQuestion` on any agent
 * without `toolPolicy: 'delegate-only'`, which today means every worker and
 * every chain participant.
 *
 * So a deny seam IS available if enforcement is ever wanted. Wiring THIS
 * classifier into it would cover Write/Edit/MultiEdit/NotebookEdit only, while
 * `Bash` and symlink races still escape — and enforcing a guarantee with those
 * holes open is worse than not claiming one. That is the decision to re-open if
 * you are here to add enforcement.
 *
 * Bash gets a free pass at this layer BY CONSTRUCTION: callers pass
 * `filePath: undefined` when the tool has no canonical file argument, and the
 * classifier returns `inScope: true` — no signal, not a clean verdict.
 * `classifyBashCommand` is for severity (read/mutate/dangerous) only, never for
 * path scoping.
 *
 * Server-side rather than `shared/` because resolution needs `node:path` and
 * `node:os`; the web never runs it, since the wire envelope
 * (`MultiAgentMutationView.guardrailViolation`) carries the settled verdict and
 * the client only renders the badge.
 *
 * The symlink handling below (`resolveThroughLinks`, `Cebab-2t9.3`) — what it
 * buys, why BOTH sides must resolve or neither, and the 0.87 µs vs 31.85 µs
 * measurement that settled the cost question: `docs/safety-and-security.md`,
 * "The consultant constraint, and its two limits".
 */

import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
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
  const lexicalTarget = resolve(cwd, expanded);
  const lexicalCwd = resolve(cwd);

  // `Cebab-2t9.3`: compare through symlinks, not lexically.
  //
  // BOTH SIDES OR NEITHER, and that is the whole trick. Resolving only the
  // target would make every agent whose project sits under a symlinked root
  // look out-of-scope forever — `/tmp` is a link to `/private/tmp` on macOS,
  // so `realpath(target)` = `/private/tmp/proj/x` would be compared against a
  // literal `/tmp/proj` and never match. That is not a hypothetical: the
  // repo's own tests build fixtures under `os.tmpdir()`.
  //
  // FALL BACK TO THE LEXICAL PAIR, not to a verdict. If either side cannot be
  // resolved (a permission error, a race, a platform quirk), the comparison
  // uses exactly the two values the old code used, so the answer is exactly
  // the old answer. This change can therefore only ever ADD detections or
  // remove a false positive — it cannot invent one, which is what makes it
  // safe to turn on for every mutation with no opt-in.
  const realTarget = resolveThroughLinks(lexicalTarget);
  const realCwd = resolveThroughLinks(lexicalCwd);
  const usingLinks = realTarget !== null && realCwd !== null;
  const target = usingLinks ? realTarget : lexicalTarget;
  const cwdForCompare = usingLinks ? realCwd : lexicalCwd;

  // Equality check first — the agent writing into its cwd root counts as
  // in-scope. Then the prefix check uses the platform's separator to
  // avoid the classic `/foo` matching `/foobar` substring bug
  // (`/foo` + sep = `/foo/`, which doesn't prefix-match `/foobar`).
  if (target === cwdForCompare) return { inScope: true };
  const prefix = cwdForCompare.endsWith(sep) ? cwdForCompare : cwdForCompare + sep;
  if (target.startsWith(prefix)) return { inScope: true };

  return {
    inScope: false,
    // The path actually written, not the path typed. When a link is in play
    // those differ, and the resolved one is the answer to the operator's
    // question ("what did it touch?"). Nothing is lost: the row also carries
    // `filePath` and the full `toolInput`, so the typed path is still there.
    resolvedPath: target,
    reasonCode: 'path_outside_cwd',
  };
}

/**
 * Resolve `p` through symlinks, tolerating a path that does not exist yet.
 * Returns `null` if it cannot be resolved at all.
 *
 * WHY NOT PLAIN `realpathSync`. A `Write` routinely names a file that is
 * about to be created, and `realpathSync` throws ENOENT on those — which
 * would mean the common case falls back to the lexical answer and the
 * check does nothing where it matters most. Worse, the escape does not
 * have to be the leaf: a symlinked PARENT directory redirects a
 * brand-new file just as effectively, and a leaf-only check would miss
 * it entirely. So this walks up to the deepest ancestor that exists,
 * resolves THAT, and re-appends the tail it skipped.
 *
 * BOUNDED, and the bound is not decoration. It is what makes a symlink CYCLE
 * safe: `realpathSync` throws ELOOP, the dangling-link branch below then
 * readlinks it, and the two hops would ping-pong forever. The cap stops that
 * at `MAX_ANCESTOR_WALK` iterations and returns `null`, i.e. "fall back to
 * lexical" — the same conservative answer as any other failure. It also caps
 * the syscalls one classification can issue on the turn path.
 *
 * WHAT THIS DOES NOT BUY, stated plainly because the header used to argue
 * it was not worth buying at all:
 *   - It is NOT a sandbox. The link can be swapped between this call and
 *     the write (TOCTOU). This module reports; it does not gate.
 *   - It does not help `Bash`, which reaches this function with
 *     `filePath: undefined` and returns in-scope before any of this runs.
 *   - It does not address case-insensitive filesystems, where
 *     `/Users/x/proj` and `/users/x/proj` are the same directory and
 *     `startsWith` says otherwise. That hole predates this change and is
 *     untouched by it.
 */
const MAX_ANCESTOR_WALK = 64;

function resolveThroughLinks(p: string): string | null {
  let tail: string[] = [];
  let cur = p;
  for (let i = 0; i <= MAX_ANCESTOR_WALK; i++) {
    try {
      const real = realpathSync(cur);
      return tail.length === 0 ? real : resolve(real, ...tail);
    } catch {
      // A DANGLING link: `realpathSync` throws on it exactly as it does on a
      // path that was never there, but the two are not the same question. The
      // link itself still says where a write would land, and creating the
      // target through it is precisely how an escape gets staged for a file
      // that does not exist yet. So ask the link before walking past it —
      // otherwise the walk reaches the containing directory, which IS inside
      // the cwd, and the answer comes back in-scope.
      let linkTarget: string | null = null;
      try {
        if (lstatSync(cur).isSymbolicLink()) linkTarget = readlinkSync(cur);
      } catch {
        /* not a link, or it vanished between the two calls — walk up */
      }
      if (linkTarget !== null) {
        // `readlink` may be relative, and it is relative to the link's own
        // directory, not to the process cwd. `tail` is deliberately kept: the
        // segments below the link still hang off wherever it points.
        cur = resolve(dirname(cur), linkTarget);
        continue;
      }
      const parent = dirname(cur);
      // `dirname` is idempotent at a filesystem root, so this is the
      // termination condition for "walked to the top and found nothing
      // resolvable" — without it the loop would spin on '/' until the cap.
      if (parent === cur) return null;
      // `basename`, NOT `cur.slice(parent.length + 1)`. The arithmetic form
      // is right for every parent except the one that always gets walked to:
      // at the root, `dirname` returns '/' whose length is 1 AND whose last
      // character is the separator, so the +1 eats the first real character
      // and '/workspace' becomes '/orkspace'. The repo's existing
      // out-of-scope test caught exactly that.
      tail = [basename(cur), ...tail];
      cur = parent;
    }
  }
  return null;
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
