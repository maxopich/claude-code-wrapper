/**
 * Is one path inside another? Two helpers, one home.
 *
 * These lived in `workspace.ts` and moved here when `managed_agent.ts`
 * (Cebab-ws0.9) needed the same two functions. The alternative — importing them
 * from `workspace.ts`, which imports `managed_agent.ts` for the missing-sweep —
 * is an import cycle, and a cycle around a containment check is a bad place to
 * discover ESM's evaluation order. `workspace.ts` re-exports `isInside` so its
 * existing callers and tests are unchanged.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Canonical form of a path that is known to exist: symlinks followed, and on
 * a case-insensitive filesystem the on-disk casing restored. Both matter —
 * `/tmp` is a symlink to `/private/tmp` on macOS, and `/users/me` and
 * `/Users/me` are the same directory there.
 *
 * Falls back to the input when realpath fails (a race, or a path that does not
 * exist yet). For an EQUALITY check that fallback only makes the comparison
 * stricter about matching. For a CONTAINMENT check it makes it LOOSER — an
 * unresolved `/tmp/x/.cebab` compared against a resolved
 * `/private/tmp/x/.cebab/agents` reads as "not inside" and gets waved through.
 * Callers doing containment must make the directory exist first; see
 * `setWorkspaceRoot`, which calls `ensureDataDir()` for exactly this reason.
 */
export function canonical(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Is `child` strictly inside `parent`? Both must already be canonical.
 *
 * `path.relative`, never `startsWith` — this is the whole reason the helper
 * exists. `~/.cebabX` shares a string prefix with `~/.cebab` and is not inside
 * it; appending a separator fixes that one case and still gets trailing slashes
 * and mixed `/` vs `\` wrong on Windows, which `relative` normalises.
 *
 * The escape predicate names `path.sep` explicitly rather than testing
 * `startsWith('..')`, because a bare prefix test also rejects a legitimately
 * named `..foo` directory.
 *
 * Strict: a path is not inside itself (`rel === ''`). Callers that also want to
 * refuse the parent itself compare for equality separately, so the two
 * conditions stay legible at the call site.
 *
 * Exported for its own tests — the Windows behaviour is asserted by driving
 * `path.win32` directly, which is the only way to cover it from a POSIX runner.
 */
export function isInside(parent: string, child: string, impl: typeof path = path): boolean {
  const rel = impl.relative(parent, child);
  if (rel === '' || rel === '..' || rel.startsWith(`..${impl.sep}`)) return false;
  return !impl.isAbsolute(rel);
}
