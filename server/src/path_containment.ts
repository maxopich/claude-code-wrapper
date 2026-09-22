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
 * Resolve `p` through symlinks, tolerating a path that does not exist yet.
 * Returns `null` if it cannot be resolved at all.
 *
 * A containment caller must treat `null` as a REFUSAL, never a lexical
 * fallback: an unresolved path compared against a resolved root would decide
 * inside-or-outside on a string that never touched the filesystem, defeating
 * the check it is part of (`project_containment_fallback_is_an_escape_hatch`).
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

export function canonicalAllowingMissing(p: string): string | null {
  let tail: string[] = [];
  let cur = p;
  for (let i = 0; i <= MAX_ANCESTOR_WALK; i++) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length === 0 ? real : path.resolve(real, ...tail);
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
        if (fs.lstatSync(cur).isSymbolicLink()) linkTarget = fs.readlinkSync(cur);
      } catch {
        /* not a link, or it vanished between the two calls — walk up */
      }
      if (linkTarget !== null) {
        // `readlink` may be relative, and it is relative to the link's own
        // directory, not to the process cwd. `tail` is deliberately kept: the
        // segments below the link still hang off wherever it points.
        cur = path.resolve(path.dirname(cur), linkTarget);
        continue;
      }
      const parent = path.dirname(cur);
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
      tail = [path.basename(cur), ...tail];
      cur = parent;
    }
  }
  return null;
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
