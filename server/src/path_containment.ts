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
 * Like `canonical`, but a resolution failure is a REFUSAL, never a fallback to
 * the raw input.
 *
 * For a containment check the fallback in `canonical` is the escape hatch
 * `project_containment_fallback_is_an_escape_hatch` warns about: an unresolved
 * path compared against a resolved root reads as inside-or-outside on the
 * strength of a string that never touched the filesystem, defeating the check
 * it is part of. So a caller doing containment resolves with THIS and lets a
 * path that cannot be resolved be refused.
 *
 * Uses the SAME `fs.realpathSync` as `canonical` on purpose. That call follows
 * symlinks but does NOT restore on-disk letter case (macOS) or 8.3 short names
 * (Windows) — the native `fs.realpathSync.native` does — so a containment check
 * and a walk that later resolves each link with `canonical` must both go
 * through this one primitive, or they disagree about the same path and an
 * in-tree link is wrongly judged an escape.
 */
export function canonicalOrThrow(p: string, what: string): string {
  try {
    return fs.realpathSync(p);
  } catch (err: unknown) {
    throw new Error(
      `path_containment: cannot resolve ${what} ${JSON.stringify(p)} (${String(err)})`,
      { cause: err },
    );
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
