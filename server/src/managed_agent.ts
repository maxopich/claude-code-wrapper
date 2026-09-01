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
 * WHY THE COPIED CREDENTIALS ARE NOT ENCRYPTED (Cebab-ws0.11). A managed agent
 * carries whatever its source carried — an API key in `.mcp.json`, a token in
 * `.env`, a deploy key. Encrypting them at rest here would be theatre: Cebab is
 * a single-user localhost app that has to hand those values to a subprocess on
 * demand, so the key would have to live on the same disk as the ciphertext and
 * be readable by the same account. That stops a casual grep and nothing else,
 * while adding a key-management surface that can go wrong in ways plaintext
 * cannot. What actually earns its keep is cheaper and checkable:
 *
 *   - the tree is 0700 and credential-bearing files are 0600, so no other
 *     account on the machine can reach them;
 *   - names, never values — nothing here opens a file to decide anything, and
 *     the preflight reports paths only;
 *   - `.git` is excluded, so the copy is not a repository and the data dir's
 *     `.gitignore` covers it: the secrets cannot be committed from it.
 *
 * The threat this does NOT address, stated rather than implied: anything
 * running as the operator's own account can read the copy, exactly as it can
 * read the original. Encryption would not have changed that either.
 *
 * ASYNC, NOT `cpSync`. The operator chose to copy everything — `node_modules`
 * included, `.git` since excluded (see `EXCLUDED_NAMES`) — so a gigabyte is the
 * ordinary case rather than the exotic one. A synchronous copy of that parks the event loop for minutes:
 * no heartbeat, no WebSocket, an app that looks crashed.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { config } from './config.js';
import { DIR_MODE, FILE_MODE, ensureDataDir, secureMkdir } from './data_perms.js';
import { pathLooksSensitive } from '@cebab/shared';
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
  | { kind: 'excluded'; abs: string; rel: string }
  | { kind: 'unreadable'; abs: string; rel: string }
  | { kind: 'other'; abs: string; rel: string };

/**
 * Names never copied into a managed agent, matched at ANY depth (Cebab-ws0.11).
 *
 * `.git`, and the reason is what the operator asked for: they never want to
 * push from a copy. Leaving it in gives the managed agent the source's remotes,
 * so an agent running there can commit and push straight into the operator's
 * real repository.
 *
 * It also restores a guarantee the copy had quietly broken. `gitignore(5)`
 * consults parent ignore files only up to the top of the working tree — so once
 * `<dataDir>/agents/<slug>/.git` exists, that directory IS a working tree and
 * `<dataDir>/.gitignore` (a bare `*`, written by `ensureDataDir`) never reaches
 * inside it. Without `.git`, the managed tree is an ordinary directory again and
 * the data dir's ignore covers it, which is what makes "a managed agent's
 * secrets can never be committed" a property rather than a hope.
 *
 * Matched by NAME and irrespective of kind. `.git` is a regular FILE in a git
 * worktree or a submodule, holding a `gitdir:` pointer to a directory somewhere
 * else entirely — copying that would hand the managed agent a live reference to
 * the original's git directory, which is worse than copying the directory. Any
 * depth, because submodules and vendored checkouts have their own.
 */
const EXCLUDED_NAMES: ReadonlySet<string> = new Set(['.git']);

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
      // An unreadable directory (a root-owned bind mount, a 0o000 dir) is not a
      // reason to abandon the whole tree — but it is NOT the same answer as an
      // empty directory, and treating it as one was the bug this path used to
      // ship. Its contents cannot be surveyed or copied, so it must arrive as an
      // entry the survey and copy can turn into a REPORTED skip; returning here
      // yielded nothing, so `copyTree` still created the destination directory
      // (the parent's readdir already yielded the `dir`), left it empty, and
      // reported `{ ok: true, skips: [] }` — a silently incomplete snapshot.
      yield { kind: 'unreadable', abs: dirAbs, rel: dirRel };
      return;
    }
    // Stable order so a survey and the copy that follows it agree entry for
    // entry, and so a test can assert on the sequence at all.
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of dirents) {
      const abs = path.join(dirAbs, d.name);
      const rel = dirRel === '' ? d.name : `${dirRel}/${d.name}`;
      // Before every other branch, and before the symlink check: a `.git` that
      // is itself a symlink is still a `.git`, and nothing about it should be
      // reproduced.
      if (EXCLUDED_NAMES.has(d.name)) {
        yield { kind: 'excluded', abs, rel };
        continue;
      }
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

/**
 * Why an entry will not be copied. Reported, never silent.
 *
 * `excluded_vcs` is deliberately its OWN reason rather than another skip
 * (Cebab-ws0.11). "We chose not to copy this" and "we wanted to and could not"
 * are different facts, and folding them together would have the copy dialog
 * explain `.git` to the operator as a link out of the project.
 *
 * `permissions_unenforced` likewise: a file that arrived but could not be
 * tightened is copied, so calling it a skip would be wrong — but staying silent
 * about it is worse, which is what the code did before this bead.
 *
 * `unreadable_dir` is a directory whose entries `readdir` refused (EACCES on a
 * 0o000 dir, a root-owned bind mount). The directory itself is copied — the
 * parent's readdir yielded it — but its CONTENTS are omitted from both the
 * survey and the copy, so it must be reported. Without it, an unreadable
 * subtree left the destination directory empty while the copy claimed success
 * with no skip, and the operator pointed a worker at a snapshot missing state
 * it believed complete.
 */
export type SkipReason =
  | 'symlink_escapes'
  | 'not_regular'
  | 'symlink_unsupported'
  | 'excluded_vcs'
  | 'permissions_unenforced'
  | 'unreadable_dir';

export type Skip = { rel: string; reason: SkipReason };

export type TreeSurvey = {
  bytes: number;
  files: number;
  dirs: number;
  symlinks: number;
  skips: Skip[];
  /**
   * Relative paths of files whose NAME says they carry credentials — `.env`,
   * `.mcp.json`, `id_rsa`, `.claude/settings.local.json` and the rest of
   * `pathLooksSensitive`'s list (Cebab-ws0.11).
   *
   * PATHS ONLY. Nothing here opens a file, so no value can leave with it; the
   * predicate is name-based by construction. These are what the copy is about
   * to duplicate into a second location, which is the thing worth seeing before
   * clicking Copy.
   */
  credentialFiles: string[];
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
    credentialFiles: [],
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
      case 'excluded':
        survey.skips.push({ rel: entry.rel, reason: 'excluded_vcs' });
        break;
      case 'unreadable':
        survey.skips.push({ rel: entry.rel, reason: 'unreadable_dir' });
        break;
      case 'other':
        survey.skips.push({ rel: entry.rel, reason: 'not_regular' });
        break;
    }
    if (entry.kind === 'file' && pathLooksSensitive(entry.rel)) {
      survey.credentialFiles.push(entry.rel);
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
 * `mkdir` with the right mode, made umask-proof — the async twin of
 * `secureMkdir` (Cebab-ws0.11).
 *
 * `mkdir(mode)` applies the process umask, and a bare `mkdir(0o700)` was
 * relying on no sane umask having owner bits set. That happens to hold, and
 * "happens to hold" is not what the tree mode should rest on: it is the thing
 * that keeps other accounts out of a managed agent's credentials, and every
 * per-file mode below is only defence in depth behind it.
 */
async function secureMkdirAsync(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true, mode: DIR_MODE });
  if (!modesApply()) return;
  try {
    await fsp.chmod(dir, DIR_MODE);
  } catch {
    // Best-effort, exactly as `secureMkdir` is; `hardenDataDir` reports what is
    // still loose on the next boot.
  }
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
  // Cebab-ws0.11: the data dir's bare-`*` `.gitignore` is what makes a managed
  // agent uncommittable, and this module now depends on it. Creating it here
  // rather than inheriting it from whichever boot path happened to run first
  // keeps the guarantee local to the code that relies on it. Idempotent and
  // cheap — one failed `open(O_EXCL)` on the common path.
  ensureDataDir();
  const root = managedAgentsRoot();
  secureMkdir(root);
  const base = slugifyAgentName(projectName) || 'agent';
  for (let n = 1; n <= 200; n++) {
    const candidate = path.join(root, n === 1 ? base : `${base}-${n}`);
    try {
      // Non-recursive on purpose: it throws EEXIST for a taken name, which is
      // what makes the claim race-free. The chmod after is what makes the mode
      // umask-proof.
      await fsp.mkdir(candidate, { mode: DIR_MODE });
      if (modesApply()) await fsp.chmod(candidate, DIR_MODE).catch(() => {});
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
        await secureMkdirAsync(dest);
        result.dirs += 1;
        break;
      case 'file': {
        await fsp.copyFile(entry.abs, dest);
        if (modesApply()) {
          // Two modes, and the difference is the point (Cebab-ws0.11).
          //
          // An ordinary file keeps its OWNER bits: the executable bit survives
          // so a project's scripts still run, and group/other are stripped so
          // the copy can never GRANT access the source did not have.
          //
          // A file whose NAME says it carries credentials gets exactly
          // `FILE_MODE`. That also strips a stray exec bit off a `.env`, which
          // `& 0o700` would have kept.
          //
          // What actually carries the security here is the 0700 TREE — no other
          // account can traverse in regardless of what a file inside is set to.
          // These modes are defence in depth, and worth having for exactly that
          // reason: the tree's mode is one chmod away from being wrong.
          const wanted = pathLooksSensitive(entry.rel) ? FILE_MODE : entry.mode & 0o700;
          try {
            await fsp.chmod(dest, wanted);
          } catch {
            // Previously swallowed with no record anywhere, so a copy that left
            // group/other bits on a credential file still returned ok with an
            // empty skip list. The file IS copied — this is not a skip in the
            // "did not arrive" sense — but silence about it is the worse error.
            result.skips.push({ rel: entry.rel, reason: 'permissions_unenforced' });
          }
        }
        result.files += 1;
        result.bytes += entry.size;
        onProgress?.({ files: result.files, bytes: result.bytes });
        break;
      }
      case 'excluded':
        result.skips.push({ rel: entry.rel, reason: 'excluded_vcs' });
        break;
      case 'unreadable':
        // The directory itself was created by its own `dir` entry (or already
        // exists, for the root); its unreadable contents are what we report.
        result.skips.push({ rel: entry.rel, reason: 'unreadable_dir' });
        break;
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
