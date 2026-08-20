/**
 * Cebab-ws0.9 — agents Cebab has copied into its own data dir.
 *
 * A managed agent is a full, independent SNAPSHOT of a workspace project at
 * `<dataDir>/agents/<slug>/`, registered as an ordinary `projects` row so
 * Trust, the authority resolve, sessions and the bus all work on it unchanged.
 * The original is never touched and there is no live link. Because the `cwd`
 * then sits inside the data dir, this is also what makes "nothing lands in the
 * operator's workspace" true for the single-agent path — `Cebab-ws0.8` did the
 * bus half.
 *
 * ONE TRAVERSAL SHAPE, USED TWICE. `walkTree` is the only thing in this file
 * that reads a directory, and both the preflight survey and the copy consume
 * it. That is structural rather than tidy: a preflight that measured a tree
 * differently from the way the copy writes it would report a number the
 * operator then does not get, and the two would drift apart at the first edit
 * to either. A test asserts the counts agree, but the shared generator is what
 * makes them agree.
 *
 * SYMLINKS ARE THE SECURITY-SHAPED PART. `fsp.cp({ dereference: false })`
 * satisfies "do not follow symlinks" literally — it recreates each link as a
 * link — and that is the wrong answer here. A link pointing out of the source
 * would be reproduced faithfully inside the managed tree, handing the agent a
 * live path back out of the space Cebab is supposed to own: not followed, but
 * not independent either. So links resolving INSIDE the source are recreated,
 * links resolving outside are skipped and REPORTED, and directory links are
 * never descended (which is also the loop guard — a link to an ancestor cannot
 * spin the walk).
 *
 * ASYNC, NOT `cpSync`. The operator chose to copy everything, `.git` and
 * `node_modules` included, so a gigabyte is the ordinary case rather than the
 * exotic one. A synchronous copy of that parks the event loop for minutes:
 * no heartbeat, no WebSocket, an app that looks crashed.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { config } from './config.js';
import { DIR_MODE, secureMkdir } from './data_perms.js';
import { canonical, isInside } from './path_containment.js';
import { slugifyAgentName } from './bus/paths.js';

/** Where every managed agent lives. Mirrors `sessionsRoot()` in `bus/paths.ts`. */
export function managedAgentsRoot(): string {
  return path.join(config.dataDir, 'agents');
}

/**
 * Is this project a managed agent?
 *
 * STRUCTURAL, and deliberately not a column read. `syncWorkspaceProjects`
 * soft-deletes any row the workspace scan did not see, and a managed row is
 * never in that scan, so managed rows need an exemption from that sweep. Key
 * the exemption on a column and a hand-edited `managed_source_path` on an
 * ordinary project buys it permanent immunity, while clearing the column on a
 * real managed agent gets it swept out from under a directory that is still
 * there. A path cannot be edited into lying about where it is.
 */
export function isManagedProjectPath(projectPath: string): boolean {
  // BOTH forms, and the reason is a bug this shipped with for an afternoon.
  //
  // `canonical` falls back to its input when realpath fails, which is what a
  // DELETED directory does — and on macOS the root then resolves through
  // `/private/var/...` while the vanished child stays at `/var/...`, so the two
  // no longer share a prefix and a real managed agent reads as unmanaged the
  // moment its directory goes away. Worse, it read the other way on Linux,
  // where there is no such symlink: the same call returns true there. A
  // predicate about WHERE A PATH IS must not depend on whether the path
  // currently exists, and must not answer differently per platform.
  //
  // Comparing the resolved pair and the raw pair covers both: the first handles
  // a symlinked ancestor, the second handles anything that cannot be resolved.
  const rootRaw = path.resolve(managedAgentsRoot());
  const childRaw = path.resolve(projectPath);
  return isInside(canonical(rootRaw), canonical(childRaw)) || isInside(rootRaw, childRaw);
}

// ---- the traversal ----

export type WalkEntry =
  | { kind: 'dir'; abs: string; rel: string }
  | { kind: 'file'; abs: string; rel: string; size: number; mode: number }
  | { kind: 'symlink'; abs: string; rel: string; target: string; escapes: boolean }
  | { kind: 'other'; abs: string; rel: string };

/**
 * Depth-first walk of `root`, yielding one entry per filesystem object.
 *
 * `readdir(withFileTypes)` reports link semantics (`isSymbolicLink()` wins over
 * `isDirectory()` for a link to a directory), so nothing here follows a link by
 * accident. Recursion happens only for entries that are really directories.
 *
 * Entries arrive parent-before-child, which is what lets the copy create a
 * directory before writing into it without a second pass.
 */
export async function* walkTree(
  root: string,
  rootReal = canonical(root),
): AsyncGenerator<WalkEntry> {
  async function* visit(dirAbs: string, dirRel: string): AsyncGenerator<WalkEntry> {
    let dirents;
    try {
      dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
    } catch {
      // An unreadable subdirectory is not a reason to abandon the whole tree.
      // It contributes nothing to the survey and nothing to the copy, which is
      // the same answer the operator gets from an empty directory — the copy
      // result reports what was skipped so it is not silent.
      return;
    }
    // Stable order so a survey and the copy that follows it agree entry for
    // entry, and so a test can assert on the sequence at all.
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of dirents) {
      const abs = path.join(dirAbs, d.name);
      const rel = dirRel === '' ? d.name : `${dirRel}/${d.name}`;
      if (d.isSymbolicLink()) {
        let target: string;
        try {
          target = await fsp.readlink(abs);
        } catch {
          yield { kind: 'other', abs, rel };
          continue;
        }
        // "Escapes" means WOULD NOT POINT INSIDE THE COPY, which is a stricter
        // question than whether it points inside the source — and the two come
        // apart in a way that is easy to get wrong.
        //
        // A link is recreated verbatim, so only a RELATIVE one lands somewhere
        // equivalent in the copy. An ABSOLUTE link resolving inside the source
        // still names the SOURCE after the copy, which hands the managed agent
        // a live path back into the project it was snapshotted from — the exact
        // thing this policy exists to prevent, arriving through a link that
        // looks perfectly contained. So absolute is always an escape.
        //
        // For a relative link, resolve against the LINK'S directory rather than
        // the root (that is what relative means) and allow the root itself:
        // a `../..` that lands on the top of the tree resolves to the top of
        // the COPY once recreated, which is correct.
        const resolved = canonical(path.resolve(dirAbs, target));
        const escapes =
          path.isAbsolute(target) || !(resolved === rootReal || isInside(rootReal, resolved));
        yield { kind: 'symlink', abs, rel, target, escapes };
        continue;
      }
      if (d.isDirectory()) {
        yield { kind: 'dir', abs, rel };
        yield* visit(abs, rel);
        continue;
      }
      if (!d.isFile()) {
        // FIFOs, sockets, devices. Copying one is either meaningless or a way
        // to block on open forever.
        yield { kind: 'other', abs, rel };
        continue;
      }
      try {
        const st = await fsp.lstat(abs);
        yield { kind: 'file', abs, rel, size: st.size, mode: st.mode };
      } catch {
        yield { kind: 'other', abs, rel };
      }
    }
  }
  yield* visit(root, '');
}

// ---- the preflight ----

/** Why an entry will not be copied. Reported, never silent. */
export type SkipReason = 'symlink_escapes' | 'not_regular' | 'symlink_unsupported';

export type Skip = { rel: string; reason: SkipReason };

export type TreeSurvey = {
  bytes: number;
  files: number;
  dirs: number;
  symlinks: number;
  skips: Skip[];
  /** Top-level children by size, largest first — where the weight actually is. */
  largest: { name: string; bytes: number }[];
  /**
   * True when the walk stopped early because the tree exceeded a cap. `bytes`
   * and `files` are then lower bounds, and the operator is told so rather than
   * shown a number that is quietly wrong.
   */
  overCap: boolean;
};

/**
 * Caps. A backstop, not the operator's decision — they see the measured size
 * and confirm before anything is written. This is what stops a mis-aimed copy
 * (a workspace root, a home directory) from filling the disk or wedging the
 * server for an hour.
 */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 300_000;

export type Caps = { maxBytes: number; maxFiles: number };

export const DEFAULT_CAPS: Caps = { maxBytes: DEFAULT_MAX_BYTES, maxFiles: DEFAULT_MAX_FILES };

/** How many top-level children to name in `largest`. */
const LARGEST_N = 5;

/**
 * Measure what a copy of `source` would write, without writing anything.
 *
 * Stops as soon as a cap is exceeded — the point of the cap is to bound the
 * work, so a survey that dutifully walked a 500 GB tree to report that it is
 * too big would defeat it.
 */
export async function surveyTree(source: string, caps: Caps = DEFAULT_CAPS): Promise<TreeSurvey> {
  const rootReal = canonical(source);
  const byTopLevel = new Map<string, number>();
  const survey: TreeSurvey = {
    bytes: 0,
    files: 0,
    dirs: 0,
    symlinks: 0,
    skips: [],
    largest: [],
    overCap: false,
  };

  for await (const entry of walkTree(source, rootReal)) {
    switch (entry.kind) {
      case 'dir':
        survey.dirs += 1;
        break;
      case 'file': {
        survey.files += 1;
        survey.bytes += entry.size;
        const top = entry.rel.split('/')[0];
        byTopLevel.set(top, (byTopLevel.get(top) ?? 0) + entry.size);
        break;
      }
      case 'symlink':
        if (entry.escapes) survey.skips.push({ rel: entry.rel, reason: 'symlink_escapes' });
        else survey.symlinks += 1;
        break;
      case 'other':
        survey.skips.push({ rel: entry.rel, reason: 'not_regular' });
        break;
    }
    if (survey.bytes > caps.maxBytes || survey.files > caps.maxFiles) {
      survey.overCap = true;
      break;
    }
  }

  survey.largest = [...byTopLevel.entries()]
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, LARGEST_N);
  return survey;
}

/**
 * Remove a managed agent's directory tree, refusing anything that is not
 * strictly inside the managed root.
 *
 * Used to clean up after a copy that failed partway. A recursive delete is the
 * most dangerous thing in this file, so the containment check is not a
 * formality: `isInside` is `path.relative`-based (a prefix test would accept a
 * sibling `agents-old/`), the path is canonicalised first, and equality with
 * the root itself is refused separately by `isInside`'s strictness — deleting
 * `<dataDir>/agents` would take every OTHER managed agent with it.
 *
 * `fsp.rm` unlinks symlinks rather than following them, so a copied intra-tree
 * link cannot be used to reach outside.
 */
export async function removeManagedDir(target: string): Promise<void> {
  const root = canonical(managedAgentsRoot());
  if (!isInside(root, canonical(target))) {
    throw new Error(
      `managed_agent: refusing to remove ${JSON.stringify(target)} — not inside ${root}`,
    );
  }
  await fsp.rm(target, { recursive: true, force: true });
}

// ---- the copy ----

export type CopyProgress = { files: number; bytes: number };

export type CopyResult = {
  target: string;
  files: number;
  bytes: number;
  dirs: number;
  symlinks: number;
  skips: Skip[];
};

/** POSIX modes carry no guarantee on Windows; one gate so no call site repeats it. */
function modesApply(): boolean {
  return process.platform !== 'win32';
}

/**
 * Claim a fresh directory under the managed root for `projectName`.
 *
 * Non-recursive `mkdir` in a loop is the race-free way to do this: it throws
 * `EEXIST` for a taken name rather than silently succeeding the way
 * `recursive: true` does, so two callers cannot both believe they own the same
 * directory.
 *
 * Disambiguation is a PRIMARY path here, not an edge case: a second copy of the
 * same project is defined to produce a second managed agent (operator
 * decision), so `slug-2` is what the ordinary repeat looks like.
 */
export async function claimManagedDir(projectName: string): Promise<string> {
  const root = managedAgentsRoot();
  secureMkdir(root);
  const base = slugifyAgentName(projectName) || 'agent';
  for (let n = 1; n <= 200; n++) {
    const candidate = path.join(root, n === 1 ? base : `${base}-${n}`);
    try {
      await fsp.mkdir(candidate, { mode: DIR_MODE });
      return candidate;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`managed_agent: no free directory for ${JSON.stringify(base)} after 200 tries`);
}

/**
 * Copy `source` into `target`, which must already exist and be empty.
 *
 * Never writes to `source`: every operation here reads from it and writes under
 * `target`. That is asserted rather than assumed — a test hashes the source
 * tree before and after.
 */
export async function copyTree(
  source: string,
  target: string,
  onProgress?: (p: CopyProgress) => void,
): Promise<CopyResult> {
  const rootReal = canonical(source);
  const result: CopyResult = {
    target,
    files: 0,
    bytes: 0,
    dirs: 0,
    symlinks: 0,
    skips: [],
  };

  for await (const entry of walkTree(source, rootReal)) {
    const dest = path.join(target, ...entry.rel.split('/'));
    switch (entry.kind) {
      case 'dir':
        await fsp.mkdir(dest, { recursive: true, mode: DIR_MODE });
        result.dirs += 1;
        break;
      case 'file': {
        await fsp.copyFile(entry.abs, dest);
        if (modesApply()) {
          // Owner bits only. Preserves the executable bit so a project's
          // scripts still run, and cannot GRANT group or other access that the
          // source did not have — a copy into Cebab's own data dir must never
          // widen who can read an agent's credentials.
          await fsp.chmod(dest, entry.mode & 0o700).catch(() => {});
        }
        result.files += 1;
        result.bytes += entry.size;
        onProgress?.({ files: result.files, bytes: result.bytes });
        break;
      }
      case 'symlink':
        if (entry.escapes) {
          result.skips.push({ rel: entry.rel, reason: 'symlink_escapes' });
          break;
        }
        try {
          await fsp.symlink(entry.target, dest);
          result.symlinks += 1;
        } catch {
          // Windows needs a privilege for this. Reporting it is the whole
          // point: a link that silently did not arrive is a copy that quietly
          // is not the snapshot it claims to be.
          result.skips.push({ rel: entry.rel, reason: 'symlink_unsupported' });
        }
        break;
      case 'other':
        result.skips.push({ rel: entry.rel, reason: 'not_regular' });
        break;
    }
  }
  return result;
}
